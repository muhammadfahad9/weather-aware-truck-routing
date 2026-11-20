"""Deterministic synthetic weather: moving storm cells over a calm background.

Backs the offline stack and the UI's "Simulated storm" mode (real routes, fake weather).
Scenarios are plain data, so the heatmap request can carry the same storm as the plan.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

from planner.domain.geo import LatLon, destination_point, haversine_mi
from planner.domain.units import SECONDS_PER_HOUR
from planner.domain.weather import HourlySeries

BACKGROUND_WIND_MPH = 9.0
GUST_FACTOR = 1.45


@dataclass(frozen=True)
class Storm:
    lat: float
    lon: float
    t0: int  # unix seconds when the centre is at (lat, lon)
    heading_deg: float
    speed_mph: float
    radius_mi: float
    peak_wind_mph: float
    peak_rain_in_hr: float
    peak_snow_in_hr: float

    def center_at(self, ts: float) -> LatLon:
        travelled = self.speed_mph * (ts - self.t0) / SECONDS_PER_HOUR
        if travelled >= 0:
            return destination_point((self.lat, self.lon), self.heading_deg, travelled)
        return destination_point((self.lat, self.lon), self.heading_deg + 180.0, -travelled)

    def intensity(self, point: LatLon, ts: float) -> float:
        d = haversine_mi(point, self.center_at(ts))
        return math.exp(-((d / self.radius_mi) ** 2))


@dataclass(frozen=True)
class Scenario:
    storms: tuple[Storm, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"storms": [asdict(s) for s in self.storms]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Scenario:
        storms = data.get("storms")
        if not isinstance(storms, list) or not 1 <= len(storms) <= 5:
            raise ValueError("A scenario needs between 1 and 5 storms")
        parsed = []
        for raw in storms:
            storm = Storm(**{f: raw[f] for f in Storm.__dataclass_fields__})
            _validate_storm(storm)
            parsed.append(storm)
        return cls(tuple(parsed))

    @classmethod
    def on_route(cls, point: LatLon, eta_ts: float, route_length_mi: float) -> Scenario:
        """A storm centred on ``point`` at ``eta_ts``, heading east-northeast.

        The windy outer ring exercises the 35-54 mph load rules; north of 39N it snows.
        """
        radius = min(max(route_length_mi * 0.09, 35.0), 110.0)
        cold = point[0] >= 39.0
        return cls(
            (
                Storm(
                    lat=round(point[0], 4),
                    lon=round(point[1], 4),
                    t0=int(eta_ts),
                    heading_deg=70.0,
                    speed_mph=22.0,
                    radius_mi=round(radius, 1),
                    peak_wind_mph=58.0,
                    peak_rain_in_hr=0.0 if cold else 0.9,
                    peak_snow_in_hr=2.6 if cold else 0.0,
                ),
            )
        )


def _validate_storm(s: Storm) -> None:
    checks = (
        -90 <= s.lat <= 90,
        -180 <= s.lon <= 180,
        0 <= s.speed_mph <= 80,
        5 <= s.radius_mi <= 500,
        0 <= s.peak_wind_mph <= 120,
        0 <= s.peak_rain_in_hr <= 5,
        0 <= s.peak_snow_in_hr <= 10,
    )
    if not all(checks):
        raise ValueError("Storm parameters out of range")


class SimulatedWeatherProvider:
    name = "simulated"
    cacheable = False

    def __init__(self, scenario: Scenario | None = None) -> None:
        self.scenario = scenario or Scenario(())

    def conditions(self, point: LatLon, ts: float) -> tuple[float, float, float, float]:
        """(wind, gust, rain, snow) at a point and time."""
        diurnal = 2.5 * math.sin(2 * math.pi * ((ts / SECONDS_PER_HOUR) % 24 - 9) / 24)
        wind = BACKGROUND_WIND_MPH + diurnal
        rain = snow = 0.0
        for storm in self.scenario.storms:
            k = storm.intensity(point, ts)
            wind += (storm.peak_wind_mph - BACKGROUND_WIND_MPH) * k
            rain += storm.peak_rain_in_hr * k**1.5
            snow += storm.peak_snow_in_hr * k**1.5
        return wind, wind * GUST_FACTOR, rain, snow

    def hourly(self, points: Sequence[LatLon], start_ts: int, end_ts: int) -> list[HourlySeries]:
        hours = range(start_ts, end_ts + 1, SECONDS_PER_HOUR)
        out = []
        for p in points:
            # Gusts and precip cover the preceding hour, so sample its midpoint.
            winds = [round(self.conditions(p, t)[0], 1) for t in hours]
            prev = [self.conditions(p, t - SECONDS_PER_HOUR / 2) for t in hours]
            snow = tuple(round(c[3], 3) for c in prev)
            out.append(
                HourlySeries(
                    start_ts=start_ts,
                    wind_mph=tuple(winds),
                    gust_mph=tuple(round(c[1], 1) for c in prev),
                    rain_in=tuple(round(c[2], 3) for c in prev),
                    snow_in=snow,
                    temperature_f=tuple(28.0 if s > 0 else 46.0 for s in snow),
                    weather_code=tuple(_code(c[2], c[3], c[0]) for c in prev),
                )
            )
        return out


def _code(rain: float, snow: float, wind: float) -> int:
    if snow >= 1.0:
        return 75
    if snow >= 0.1:
        return 73
    if rain >= 0.5:
        return 65
    if rain >= 0.1:
        return 63
    if rain > 0.01:
        return 61
    return 3 if wind > 20 else 1
