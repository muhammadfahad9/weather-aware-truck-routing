"""Hourly forecast series, sampled at arbitrary arrival times.

Wind speed is instantaneous at the top of the hour, so it is interpolated. Gusts, rain and
snow are preceding-hour values (13:00-14:00 is stamped 14:00), so they are read from the
bucket at ceil(t). The frontend heatmap samples the same way.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .risk import Conditions
from .units import SECONDS_PER_HOUR


class ForecastRangeError(ValueError):
    """Requested time falls outside the fetched forecast window."""


@dataclass(frozen=True)
class HourlySeries:
    start_ts: int
    wind_mph: tuple[float, ...]
    gust_mph: tuple[float, ...]
    rain_in: tuple[float, ...]
    snow_in: tuple[float, ...]
    temperature_f: tuple[float | None, ...]
    weather_code: tuple[int | None, ...]
    step_s: int = SECONDS_PER_HOUR

    def __post_init__(self) -> None:
        n = len(self.wind_mph)
        lengths = {
            len(self.gust_mph),
            len(self.rain_in),
            len(self.snow_in),
            len(self.temperature_f),
            len(self.weather_code),
        }
        if n == 0 or lengths != {n}:
            raise ValueError("Hourly series must be non-empty and equally sized")

    @property
    def size(self) -> int:
        return len(self.wind_mph)

    @property
    def end_ts(self) -> int:
        return self.start_ts + (self.size - 1) * self.step_s

    def covers(self, ts: float) -> bool:
        return self.start_ts <= ts <= self.end_ts

    def at(self, ts: float) -> Conditions:
        if not self.covers(ts):
            raise ForecastRangeError(
                f"Time {ts} outside forecast window [{self.start_ts}, {self.end_ts}]"
            )
        f = (ts - self.start_ts) / self.step_s
        i0 = min(math.floor(f), self.size - 1)
        i1 = min(i0 + 1, self.size - 1)
        frac = f - i0
        bucket = min(math.ceil(f - 1e-9), self.size - 1)
        return Conditions(
            wind_mph=_lerp(self.wind_mph[i0], self.wind_mph[i1], frac),
            gust_mph=self.gust_mph[bucket],
            rain_in_hr=self.rain_in[bucket],
            snow_in_hr=self.snow_in[bucket],
            temperature_f=_lerp_optional(self.temperature_f[i0], self.temperature_f[i1], frac),
            weather_code=self.weather_code[bucket],
        )


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _lerp_optional(a: float | None, b: float | None, t: float) -> float | None:
    if a is None or b is None:
        return a if b is None else b
    return _lerp(a, b, t)


def floor_hour(ts: float) -> int:
    return int(ts // SECONDS_PER_HOUR) * SECONDS_PER_HOUR


def ceil_hour(ts: float) -> int:
    return math.ceil(ts / SECONDS_PER_HOUR) * SECONDS_PER_HOUR


def clean_series(values: Sequence[float | None]) -> tuple[float, ...]:
    """Nulls become 0 and negative model noise is clamped to 0."""
    return tuple(max(float(v), 0.0) if v is not None else 0.0 for v in values)


# WMO weather interpretation codes (https://open-meteo.com/en/docs#weathervariables).
WMO_DESCRIPTIONS: dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snowfall",
    73: "Moderate snowfall",
    75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


def describe_weather_code(code: int | None) -> str | None:
    if code is None:
        return None
    return WMO_DESCRIPTIONS.get(code, f"Weather code {code}")
