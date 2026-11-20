from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

import pytest

from planner.domain.risk import RiskLevel
from planner.services.container import Services
from planner.services.errors import ForecastUnavailableError
from planner.services.heatmap import HeatmapRequest, build_heatmap
from planner.services.trip_planner import PlanRequest, plan_trip
from planner.services.weather.simulated import Scenario

NOW = 1_800_000_000.0
DALLAS = (32.7767, -96.7970)
CHICAGO = (41.8781, -87.6298)


def _request(**kw: object) -> PlanRequest:
    base: dict[str, object] = {
        "origin": DALLAS,
        "destination": CHICAGO,
        "departure": datetime.fromtimestamp(NOW + 600, tz=timezone.utc),
        "load_lb": 42_000,
        "interval_mi": 25,
    }
    base.update(kw)
    return PlanRequest(**base)  # type: ignore[arg-type]


def test_plan_has_three_ranked_routes_with_checkpoints(offline_services: Services) -> None:
    result = plan_trip(_request(), offline_services, now=NOW)
    assert [a.plan.route_id for a in result.analyses] == ["A", "B", "C"]
    assert sorted(result.recommendation.ranking) == ["A", "B", "C"]
    for a in result.analyses:
        assert a.checkpoints[0].planned.span.mile == 0
        assert a.checkpoints[-1].planned.span.mile == pytest.approx(a.plan.candidate.path.total_mi)
        assert a.summary.total_mi == pytest.approx(a.plan.candidate.path.total_mi)
        etas = [c.planned.eta_ts for c in a.checkpoints]
        assert etas == sorted(etas)
    assert result.scenario is not None  # offline weather provider is simulated
    assert result.weather_provider == "simulated"


def test_storm_on_fastest_route_shifts_recommendation(offline_services: Services) -> None:
    result = plan_trip(_request(weather_source="simulated"), offline_services, now=NOW)
    by_id = {a.plan.route_id: a for a in result.analyses}
    fastest = by_id["A"]
    assert fastest.summary.max_level >= RiskLevel.SEVERE
    assert result.recommendation.route_id != "A"
    winner = by_id[result.recommendation.route_id]
    assert winner.summary.miles(RiskLevel.NO_TRAVEL) <= fastest.summary.miles(RiskLevel.NO_TRAVEL)


def test_load_weight_changes_risk(offline_services: Services) -> None:
    light = plan_trip(
        _request(load_lb=10_000, weather_source="simulated"), offline_services, now=NOW
    )
    heavy = plan_trip(
        _request(load_lb=45_000, weather_source="simulated"), offline_services, now=NOW
    )
    light_a = next(a for a in light.analyses if a.plan.route_id == "A")
    heavy_a = next(a for a in heavy.analyses if a.plan.route_id == "A")
    assert heavy_a.summary.avg_risk > light_a.summary.avg_risk
    assert heavy_a.summary.miles(RiskLevel.NO_TRAVEL) > light_a.summary.miles(RiskLevel.NO_TRAVEL)


def test_routes_are_cached_between_requests(offline_services: Services) -> None:
    calls = {"n": 0}
    original = offline_services.routing.routes

    def counting(*args: object, **kwargs: object) -> object:
        calls["n"] += 1
        return original(*args, **kwargs)  # type: ignore[arg-type]

    object.__setattr__(offline_services.routing, "routes", counting)
    plan_trip(_request(interval_mi=10), offline_services, now=NOW)
    plan_trip(_request(interval_mi=50), offline_services, now=NOW)
    assert calls["n"] == 1


def test_trip_beyond_forecast_horizon_is_rejected(offline_services: Services) -> None:
    far = datetime.fromtimestamp(NOW + 15 * 24 * 3600, tz=timezone.utc)
    with pytest.raises(ForecastUnavailableError):
        plan_trip(_request(departure=far), offline_services, now=NOW)


def test_notices(offline_services: Services) -> None:
    late = datetime.fromtimestamp(NOW + 6.9 * 24 * 3600, tz=timezone.utc)
    result = plan_trip(
        _request(departure=late, weather_source="simulated"), offline_services, now=NOW
    )
    codes = {n.code for n in result.notices}
    assert "forecast_confidence" in codes


def test_no_travel_everywhere_notice(offline_services: Services) -> None:
    from planner.services.weather.simulated import Storm

    class Everywhere:
        """Storm big enough to cover every route."""

        @staticmethod
        def on_route(point: tuple[float, float], eta: float, length: float) -> Scenario:
            return Scenario((Storm(point[0], point[1], int(eta), 0, 0, 450, 70, 0, 0),))

    import planner.services.trip_planner as tp

    original = tp.Scenario
    tp.Scenario = Everywhere  # type: ignore[misc,assignment]
    try:
        result = plan_trip(_request(weather_source="simulated"), offline_services, now=NOW)
    finally:
        tp.Scenario = original  # type: ignore[misc]
    assert any(n.code == "no_travel_all_routes" and n.severity == "danger" for n in result.notices)


def test_heatmap_frames_cover_48_hours(offline_services: Services) -> None:
    plan = plan_trip(_request(weather_source="simulated"), offline_services, now=NOW)
    routes = [list(a.plan.candidate.path.points) for a in plan.analyses]
    departure = datetime.fromtimestamp(NOW + 600, tz=timezone.utc)
    result = build_heatmap(
        HeatmapRequest(routes=routes, departure=departure, scenario=plan.scenario), offline_services
    )
    cells = len(result.grid.cells)
    assert 0 < cells <= offline_services.heatmap_max_cells
    assert result.start_ts <= departure.timestamp() < result.start_ts + 3600
    assert result.frames == 50  # mid-hour departure: hours 0..49 cover departure..+48 h
    for field in (result.wind, result.gust, result.rain, result.snow):
        assert len(field) == cells * result.frames
    assert max(result.wind) > 45  # the storm is visible in the corridor
    assert result.provider == "simulated"


def test_heatmap_on_the_hour_has_49_frames(offline_services: Services) -> None:
    departure = datetime.fromtimestamp(NOW, tz=timezone.utc)  # NOW is a whole hour
    result = build_heatmap(
        HeatmapRequest(routes=[[DALLAS, (33.5, -96.0)]], departure=departure, hours=48),
        dataclasses.replace(offline_services, heatmap_max_cells=50),
    )
    assert result.frames == 49
    assert len(result.grid.cells) <= 50
