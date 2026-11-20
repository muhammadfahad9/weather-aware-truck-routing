"""JSON responses for the frontend.

Values are rounded to display precision and coordinates to 5 decimals (~1 m).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from planner.domain.analysis import AssessedCheckpoint, RouteAnalysis, timeline_vertices
from planner.domain.recommend import Recommendation
from planner.domain.risk import RiskLevel, rules_payload
from planner.domain.units import round_half_up
from planner.domain.weather import describe_weather_code
from planner.services.heatmap import HeatmapResult
from planner.services.trip_planner import PlanResult


def iso(ts: float) -> str:
    """UTC ISO-8601 to the second, e.g. ``2026-11-20T15:04:05Z``."""
    return datetime.fromtimestamp(round(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _minutes(seconds: float) -> int:
    return int(round_half_up(seconds / 60.0)) * 60


def present_plan(result: PlanResult) -> dict[str, Any]:
    req = result.request
    rec = result.recommendation
    rank = {route_id: i + 1 for i, route_id in enumerate(rec.ranking)}
    return {
        "generated_at": iso(result.generated_at.timestamp()),
        "inputs": {
            "origin": {"lat": req.origin[0], "lon": req.origin[1], "label": req.origin_label},
            "destination": {
                "lat": req.destination[0],
                "lon": req.destination[1],
                "label": req.destination_label,
            },
            "departure_time": iso(req.departure.timestamp()),
            "load_weight_lb": req.load_lb,
            "interval_miles": req.interval_mi,
            "hos_breaks": req.hos_enabled,
            "wind_basis": req.wind_basis,
            "weather_source": req.weather_source,
        },
        "rules": rules_payload(),
        "routing": {"provider": result.routing_provider},
        "weather": {
            "provider": result.weather_provider,
            "simulated": result.scenario is not None,
            "scenario": result.scenario.to_dict() if result.scenario else None,
        },
        "routes": [
            present_route(a, rank[a.plan.route_id], a.plan.route_id == rec.route_id)
            for a in result.analyses
        ],
        "recommendation": present_recommendation(rec),
        "notices": [
            {"code": n.code, "message": n.message, "severity": n.severity} for n in result.notices
        ],
    }


def present_route(analysis: RouteAnalysis, rank: int, recommended: bool) -> dict[str, Any]:
    plan = analysis.plan
    path = plan.candidate.path
    departure = plan.settings.departure_ts
    vertices = timeline_vertices(plan)
    summary = analysis.summary
    return {
        "id": plan.route_id,
        "name": f"Route {plan.route_id}",
        "via": plan.candidate.via,
        "provider": plan.candidate.provider,
        "synthesized": plan.candidate.note == "synthesized",
        "rank": rank,
        "recommended": recommended,
        "distance_mi": round(path.total_mi, 1),
        # Times at whole minutes and risk at 2 decimals: the precision routes are ranked at,
        # so the cards always agree with the recommendation's reasons.
        "drive_time_s": _minutes(plan.drive_s),
        "stop_time_s": _minutes(plan.stop_s),
        "total_time_s": _minutes(plan.total_s),
        "departure_time": iso(departure),
        "arrival_time": iso(plan.arrival_ts),
        "risk": {
            "miles_by_level": {
                level.key: round_half_up(summary.miles(level), 1) for level in RiskLevel
            },
            "avg_risk": round_half_up(summary.avg_risk, 2),
            "max_level": summary.max_level.value,
            "max_label": summary.max_level.label,
        },
        "path": {
            "coordinates": [[round(v.point[1], 5), round(v.point[0], 5)] for v in vertices],
            "miles": [round(v.mile, 3) for v in vertices],
            "elapsed_s": [round(v.elapsed_s) for v in vertices],
        },
        "stops": [
            {
                "kind": s.kind,
                "mile": round(s.mile, 1),
                "lat": round(s.point[0], 5),
                "lon": round(s.point[1], 5),
                "arrive_time": iso(s.arrive_ts),
                "depart_time": iso(s.depart_ts),
                "duration_s": round(s.duration_s),
            }
            for s in plan.planned_stops
        ],
        "checkpoints": [present_checkpoint(c, departure) for c in analysis.checkpoints],
    }


def present_checkpoint(c: AssessedCheckpoint, departure_ts: float) -> dict[str, Any]:
    p = c.planned
    cond = c.conditions
    a = c.assessment
    return {
        "index": p.index,
        "mile": round(p.span.mile, 2),
        "span": [round(p.span.start_mi, 2), round(p.span.end_mi, 2)],
        "lat": round(p.point[0], 5),
        "lon": round(p.point[1], 5),
        "eta": iso(p.eta_ts),
        "elapsed_s": round(p.eta_ts - departure_ts),
        "conditions": {
            # Same rounding as the classifier, so the numbers match the risk pill.
            "wind_mph": round_half_up(cond.wind_mph, 1),
            "gust_mph": round_half_up(cond.gust_mph, 1),
            "rain_in_hr": round_half_up(cond.rain_in_hr, 2),
            "snow_in_hr": round_half_up(cond.snow_in_hr, 2),
            "temperature_f": round(cond.temperature_f) if cond.temperature_f is not None else None,
            "weather_code": cond.weather_code,
            "summary": describe_weather_code(cond.weather_code),
        },
        "risk": {
            "level": a.level.value,
            "label": a.level.label,
            "drivers": [f.factor for f in a.drivers],
            "factors": [
                {
                    "factor": f.factor,
                    "value": f.value,
                    "unit": f.unit,
                    "level": f.level.value,
                    "base_level": f.base_level.value,
                    "load_escalated": f.load_escalated,
                }
                for f in a.factors
            ],
        },
    }


def present_recommendation(rec: Recommendation) -> dict[str, Any]:
    deciding = rec.deciding_stage
    return {
        "route_id": rec.route_id,
        "ranking": list(rec.ranking),
        "reasons": list(rec.reasons),
        "deciding_criterion": deciding.criterion.key if deciding else None,
        "stages": [
            {
                "criterion": s.criterion.key,
                "label": s.criterion.label,
                "values": s.values,
                "best": s.best,
                "kept": list(s.kept),
                "eliminated": list(s.eliminated),
            }
            for s in rec.stages
        ],
    }


def present_heatmap(result: HeatmapResult) -> dict[str, Any]:
    g = result.grid
    return {
        "provider": result.provider,
        "simulated": result.provider == "simulated",
        "grid": {
            # Full precision: the client recomputes node positions from these.
            "lat0": g.lat0,
            "lon0": g.lon0,
            "dlat": g.dlat,
            "dlon": g.dlon,
            "nx": g.nx,
            "ny": g.ny,
            "spacing_mi": round(g.spacing_mi, 2),
            "half_width_mi": round(g.half_width_mi, 1),
        },
        "cells": list(g.cells),
        "start_time": iso(result.start_ts),
        "start_ts": result.start_ts,
        "step_s": 3600,
        "frames": result.frames,
        "fields": {
            "wind": result.wind,
            "gust": result.gust,
            "rain": result.rain,
            "snow": result.snow,
        },
    }
