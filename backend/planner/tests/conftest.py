from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from django.core.cache import cache

from planner.domain.route import RouteCandidate, RoutePath
from planner.domain.weather import HourlySeries
from planner.services.container import Services, get_services
from planner.services.geocoding import GazetteerGeocoder
from planner.services.routing.simulated import SimulatedRoutingProvider
from planner.services.weather.simulated import SimulatedWeatherProvider

FIXTURES = Path(__file__).parent / "fixtures"
SHARED = Path(__file__).resolve().parents[3] / "shared"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def load_shared(name: str) -> Any:
    return json.loads((SHARED / name).read_text())


@pytest.fixture(autouse=True)
def _clear_state() -> Iterator[None]:
    cache.clear()
    get_services.cache_clear()
    yield
    cache.clear()
    get_services.cache_clear()


@pytest.fixture
def offline_services() -> Services:
    """Fully offline providers: deterministic routes, weather and geocoding."""
    return Services(
        routing=SimulatedRoutingProvider(),
        routing_fallback=None,
        weather=SimulatedWeatherProvider(),
        geocoder=GazetteerGeocoder(),
        cache=cache,
        truck_tare_lb=35_000,
        truck_max_speed_mph=65,
        heatmap_max_cells=200,
    )


def straight_route(
    start: tuple[float, float] = (35.0, -100.0),
    end: tuple[float, float] = (35.0, -98.0),
    n: int = 41,
    mph: float = 60.0,
    provider: str = "test",
) -> RouteCandidate:
    """East-west route sampled at ``n`` points travelled at a constant speed."""
    points = [
        (start[0] + (end[0] - start[0]) * k / (n - 1), start[1] + (end[1] - start[1]) * k / (n - 1))
        for k in range(n)
    ]
    from planner.domain.geo import cumulative_miles

    cum = cumulative_miles(points)
    return RouteCandidate(
        path=RoutePath.from_points(points, [m / mph * 3600 for m in cum]), provider=provider
    )


def flat_series(
    start_ts: int,
    hours: int,
    *,
    wind: float = 5.0,
    gust: float = 8.0,
    rain: float = 0.0,
    snow: float = 0.0,
) -> HourlySeries:
    n = hours + 1
    return HourlySeries(
        start_ts=start_ts,
        wind_mph=(wind,) * n,
        gust_mph=(gust,) * n,
        rain_in=(rain,) * n,
        snow_in=(snow,) * n,
        temperature_f=(50.0,) * n,
        weather_code=(1,) * n,
    )
