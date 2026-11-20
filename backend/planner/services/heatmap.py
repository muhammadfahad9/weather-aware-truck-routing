"""Hourly weather fields over the trip corridor for the heatmap."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from planner.domain.corridor import CorridorGrid, build_corridor
from planner.domain.geo import LatLon
from planner.domain.weather import ceil_hour, floor_hour

from .container import Services
from .weather.base import WeatherProvider, WeatherService
from .weather.simulated import Scenario, SimulatedWeatherProvider


@dataclass(frozen=True)
class HeatmapRequest:
    routes: list[list[LatLon]]
    departure: datetime
    hours: int = 48
    scenario: Scenario | None = None


@dataclass(frozen=True)
class HeatmapResult:
    grid: CorridorGrid
    start_ts: int
    frames: int
    # Frame-major: (frame f, cell c) is at index f * len(cells) + c.
    wind: list[float]
    gust: list[float]
    rain: list[float]
    snow: list[float]
    provider: str


def build_heatmap(req: HeatmapRequest, services: Services) -> HeatmapResult:
    grid = build_corridor(req.routes, max_cells=services.heatmap_max_cells)
    departure_ts = req.departure.timestamp()
    start = floor_hour(departure_ts)
    end = ceil_hour(departure_ts + req.hours * 3600)
    frames = (end - start) // 3600 + 1

    provider: WeatherProvider = (
        SimulatedWeatherProvider(req.scenario) if req.scenario is not None else services.weather
    )
    points = grid.cell_points()
    lookup = WeatherService(provider, services.cache).lookup(points, start, end)

    series = [lookup(p) for p in points]
    wind: list[float] = []
    gust: list[float] = []
    rain: list[float] = []
    snow: list[float] = []
    for f in range(frames):
        ts = start + f * 3600
        for s in series:
            i = (ts - s.start_ts) // s.step_s
            wind.append(round(s.wind_mph[i], 1))
            gust.append(round(s.gust_mph[i], 1))
            rain.append(round(s.rain_in[i], 3))
            snow.append(round(s.snow_in[i], 3))
    return HeatmapResult(
        grid=grid,
        start_ts=start,
        frames=frames,
        wind=wind,
        gust=gust,
        rain=rain,
        snow=snow,
        provider=provider.name,
    )
