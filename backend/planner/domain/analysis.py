"""Per-route analysis in two steps.

``place_checkpoints`` fixes checkpoint positions, stops and ETAs without weather, so the
caller can fetch forecasts for all routes in one batch before ``assess_route`` runs.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .checkpoints import CheckpointSpan, checkpoint_miles, checkpoint_spans
from .geo import LatLon, simplify_indices
from .hos import Stop, StopKind, elapsed_at, plan_stops, total_stop_seconds
from .recommend import RiskSummary, summarize_risk
from .risk import Conditions, RiskAssessment, WindBasis, assess
from .route import RouteCandidate
from .weather import HourlySeries

SeriesLookup = Callable[[LatLon], HourlySeries]


@dataclass(frozen=True)
class TripSettings:
    departure_ts: float
    interval_mi: float
    load_lb: float
    wind_basis: WindBasis = "sustained"
    hos_enabled: bool = True


@dataclass(frozen=True)
class PlannedCheckpoint:
    index: int
    span: CheckpointSpan
    point: LatLon
    drive_s: float
    elapsed_s: float
    eta_ts: float


@dataclass(frozen=True)
class PlannedStop:
    kind: StopKind
    mile: float
    point: LatLon
    arrive_ts: float
    duration_s: float

    @property
    def depart_ts(self) -> float:
        return self.arrive_ts + self.duration_s


@dataclass(frozen=True)
class RoutePlan:
    route_id: str
    candidate: RouteCandidate
    settings: TripSettings
    stops: tuple[Stop, ...]
    planned_stops: tuple[PlannedStop, ...]
    checkpoints: tuple[PlannedCheckpoint, ...]

    @property
    def drive_s(self) -> float:
        return self.candidate.path.total_drive_s

    @property
    def stop_s(self) -> float:
        return total_stop_seconds(self.stops)

    @property
    def total_s(self) -> float:
        return self.drive_s + self.stop_s

    @property
    def arrival_ts(self) -> float:
        return self.settings.departure_ts + self.total_s


@dataclass(frozen=True)
class AssessedCheckpoint:
    planned: PlannedCheckpoint
    conditions: Conditions
    assessment: RiskAssessment


@dataclass(frozen=True)
class RouteAnalysis:
    plan: RoutePlan
    checkpoints: tuple[AssessedCheckpoint, ...]
    summary: RiskSummary


def place_checkpoints(
    route_id: str, candidate: RouteCandidate, settings: TripSettings
) -> RoutePlan:
    path = candidate.path
    stops = tuple(plan_stops(path.total_drive_s)) if settings.hos_enabled else ()
    planned_stops = tuple(
        PlannedStop(
            kind=stop.kind,
            mile=(mile := path.mile_at_drive_s(stop.at_driving_s)),
            point=path.point_at_mile(mile),
            arrive_ts=settings.departure_ts + elapsed_at(stop.at_driving_s, stops),
            duration_s=stop.duration_s,
        )
        for stop in stops
    )
    checkpoints = []
    for index, span in enumerate(
        checkpoint_spans(checkpoint_miles(path.total_mi, settings.interval_mi))
    ):
        drive_s = path.drive_s_at_mile(span.mile)
        elapsed = elapsed_at(drive_s, stops)
        checkpoints.append(
            PlannedCheckpoint(
                index=index,
                span=span,
                point=path.point_at_mile(span.mile),
                drive_s=drive_s,
                elapsed_s=elapsed,
                eta_ts=settings.departure_ts + elapsed,
            )
        )
    return RoutePlan(
        route_id=route_id,
        candidate=candidate,
        settings=settings,
        stops=stops,
        planned_stops=planned_stops,
        checkpoints=tuple(checkpoints),
    )


def assess_route(plan: RoutePlan, lookup: SeriesLookup) -> RouteAnalysis:
    assessed = []
    for cp in plan.checkpoints:
        conditions = lookup(cp.point).at(cp.eta_ts)
        assessed.append(
            AssessedCheckpoint(
                planned=cp,
                conditions=conditions,
                assessment=assess(conditions, plan.settings.load_lb, plan.settings.wind_basis),
            )
        )
    summary = summarize_risk([(c.planned.span.length_mi, c.assessment.level) for c in assessed])
    return RouteAnalysis(plan=plan, checkpoints=tuple(assessed), summary=summary)


@dataclass(frozen=True)
class TimelineVertex:
    point: LatLon
    mile: float
    elapsed_s: float


def timeline_vertices(plan: RoutePlan, tolerance_mi: float = 0.01) -> list[TimelineVertex]:
    """Simplified geometry with mile and elapsed time per vertex.

    Each stop is two vertices at the same point (arrive, depart), so interpolating on elapsed
    time keeps the truck parked for the stop.
    """
    path = plan.candidate.path
    out: list[TimelineVertex] = []
    pending = list(plan.stops)
    for i in simplify_indices(path.points, tolerance_mi):
        drive = path.cum_drive_s[i]
        while pending and pending[0].at_driving_s < drive:
            out.extend(_stop_vertices(plan, pending.pop(0)))
        out.append(TimelineVertex(path.points[i], path.cum_mi[i], elapsed_at(drive, plan.stops)))
    for stop in pending:  # pragma: no cover - stops are always strictly inside the route
        out.extend(_stop_vertices(plan, stop))
    return out


def _stop_vertices(plan: RoutePlan, stop: Stop) -> Sequence[TimelineVertex]:
    path = plan.candidate.path
    mile = path.mile_at_drive_s(stop.at_driving_s)
    point = path.point_at_mile(mile)
    arrive = elapsed_at(stop.at_driving_s, plan.stops)
    return (
        TimelineVertex(point, mile, arrive),
        TimelineVertex(point, mile, arrive + stop.duration_s),
    )
