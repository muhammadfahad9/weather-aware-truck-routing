from __future__ import annotations

import pytest

from planner.domain.analysis import (
    TripSettings,
    assess_route,
    place_checkpoints,
    timeline_vertices,
)
from planner.domain.risk import RiskLevel
from planner.domain.weather import HourlySeries

from .conftest import flat_series, straight_route

DEPART = 1_800_000_000  # top of an hour


def _settings(**kw: object) -> TripSettings:
    base = {"departure_ts": DEPART, "interval_mi": 25, "load_lb": 20_000}
    base.update(kw)
    return TripSettings(**base)  # type: ignore[arg-type]


def test_checkpoints_every_interval_with_etas() -> None:
    route = straight_route((35.0, -100.0), (35.0, -98.0), mph=60)  # ~113 mi
    plan = place_checkpoints("A", route, _settings(interval_mi=25))
    miles = [c.span.mile for c in plan.checkpoints]
    assert miles[:5] == [0, 25, 50, 75, 100]
    assert miles[-1] == pytest.approx(route.path.total_mi)
    for c in plan.checkpoints:
        assert c.eta_ts == pytest.approx(DEPART + c.span.mile / 60 * 3600, abs=1)
    assert plan.stops == ()  # under 8 h of driving


def test_hos_rest_shifts_later_etas() -> None:
    # ~760 mi at 50 mph = ~15.2 h of driving -> break at 8 h, rest at 11 h.
    route = straight_route((35.0, -110.0), (35.0, -96.2), n=200, mph=50)
    with_hos = place_checkpoints("A", route, _settings(interval_mi=50))
    without = place_checkpoints("A", route, _settings(interval_mi=50, hos_enabled=False))
    assert [s.kind for s in with_hos.stops] == ["break", "rest"]
    assert with_hos.total_s == pytest.approx(without.total_s + 10.5 * 3600)
    last_with, last_without = with_hos.checkpoints[-1], without.checkpoints[-1]
    assert last_with.eta_ts - last_without.eta_ts == pytest.approx(10.5 * 3600)
    # Checkpoints before the first break are unaffected.
    assert with_hos.checkpoints[1].eta_ts == without.checkpoints[1].eta_ts
    rest = with_hos.planned_stops[1]
    assert rest.mile == pytest.approx(50 * 11, rel=1e-3)
    assert rest.depart_ts - rest.arrive_ts == 10 * 3600
    assert rest.arrive_ts == pytest.approx(DEPART + (11 + 0.5) * 3600)


def test_assessment_uses_weather_at_each_eta() -> None:
    route = straight_route(mph=60)
    plan = place_checkpoints("A", route, _settings(interval_mi=10, load_lb=45_000))
    # Calm for the first hour, then a 40 mph wind (High, escalated to Severe by the load).
    hours = 4
    wind = (5.0, 40.0, 40.0, 40.0, 40.0)
    series = HourlySeries(
        start_ts=DEPART,
        wind_mph=wind,
        gust_mph=(10.0,) * (hours + 1),
        rain_in=(0.0,) * (hours + 1),
        snow_in=(0.0,) * (hours + 1),
        temperature_f=(50.0,) * (hours + 1),
        weather_code=(3,) * (hours + 1),
    )
    analysis = assess_route(plan, lambda _p: series)
    first, last = analysis.checkpoints[0], analysis.checkpoints[-1]
    assert first.assessment.level is RiskLevel.LOW
    assert last.assessment.level is RiskLevel.SEVERE
    assert last.assessment.factors[0].load_escalated
    assert analysis.summary.total_mi == pytest.approx(route.path.total_mi)


def test_summary_mileage_independent_of_interval() -> None:
    route = straight_route(mph=60)
    series = flat_series(DEPART, 6, rain=0.3)  # High everywhere
    for interval in (10, 25, 50):
        a = assess_route(
            place_checkpoints("A", route, _settings(interval_mi=interval)), lambda _p: series
        )
        assert a.summary.miles(RiskLevel.HIGH) == pytest.approx(route.path.total_mi)
        assert a.summary.avg_risk == pytest.approx(2.0)


def test_timeline_parks_truck_during_stops() -> None:
    route = straight_route((35.0, -110.0), (35.0, -96.2), n=200, mph=50)
    plan = place_checkpoints("A", route, _settings(interval_mi=50))
    verts = timeline_vertices(plan, tolerance_mi=0.01)
    elapsed = [v.elapsed_s for v in verts]
    miles = [v.mile for v in verts]
    assert elapsed == sorted(elapsed)
    assert miles == sorted(miles)
    assert elapsed[-1] == pytest.approx(plan.total_s)
    for stop in plan.planned_stops:
        pair = [v for v in verts if v.mile == pytest.approx(stop.mile) and v.point == stop.point]
        assert len(pair) == 2
        assert pair[1].elapsed_s - pair[0].elapsed_s == pytest.approx(stop.duration_s)


def test_timeline_without_stops_matches_geometry() -> None:
    route = straight_route(mph=60)
    plan = place_checkpoints("A", route, _settings(hos_enabled=False))
    verts = timeline_vertices(plan, tolerance_mi=0.001)
    assert verts[0].elapsed_s == 0
    assert verts[-1].mile == pytest.approx(route.path.total_mi)
