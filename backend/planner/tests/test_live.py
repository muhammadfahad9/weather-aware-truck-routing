"""Smoke tests against the real APIs. Deselected by default; run with ``pytest -m live``."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from planner.services.container import get_services
from planner.services.heatmap import HeatmapRequest, build_heatmap
from planner.services.trip_planner import PlanRequest, plan_trip

pytestmark = pytest.mark.live


def test_live_plan_and_heatmap() -> None:
    services = get_services()
    departure = datetime.now(timezone.utc) + timedelta(minutes=15)
    result = plan_trip(
        PlanRequest(
            origin=(32.7767, -96.7970),
            destination=(35.4676, -97.5164),  # Dallas -> Oklahoma City
            departure=departure,
            load_lb=35_000,
            interval_mi=25,
        ),
        services,
    )
    assert len(result.analyses) == 3
    assert result.routing_provider in {"valhalla", "osrm"}
    assert result.weather_provider == "open-meteo"
    heatmap = build_heatmap(
        HeatmapRequest(
            routes=[list(a.plan.candidate.path.points[::10]) for a in result.analyses],
            departure=departure,
        ),
        services,
    )
    assert heatmap.frames >= 49
    assert len(heatmap.wind) == heatmap.frames * len(heatmap.grid.cells)


def test_live_geocode() -> None:
    places = get_services().geocoder.search("Oklahoma City", 3)
    assert places and places[0].lat == pytest.approx(35.47, abs=0.3)
