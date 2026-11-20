"""Open-Meteo hourly forecasts (no key needed; a commercial key is optional).

Locations are batched into multi-coordinate requests that run in parallel. Only the needed
variables and hours are requested, since quota is weighted by locations x days x variables.
"""

from __future__ import annotations

import itertools
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from planner.domain.geo import LatLon
from planner.domain.weather import HourlySeries, clean_series

from ..errors import UpstreamError
from ..http import HttpClient

HOURLY_VARIABLES = (
    "wind_speed_10m",
    "wind_gusts_10m",
    "rain",
    "showers",
    "snowfall",
    "temperature_2m",
    "weather_code",
)


class OpenMeteoProvider:
    name = "open-meteo"
    cacheable = True

    def __init__(
        self,
        http: HttpClient,
        base_url: str,
        api_key: str | None = None,
        batch_size: int = 100,
        max_workers: int = 4,
    ) -> None:
        self.http = http
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.batch_size = batch_size
        self.max_workers = max_workers

    def hourly(self, points: Sequence[LatLon], start_ts: int, end_ts: int) -> list[HourlySeries]:
        if not points:
            return []
        batches = [
            list(points[i : i + self.batch_size]) for i in range(0, len(points), self.batch_size)
        ]
        if len(batches) == 1:
            return self._fetch(batches[0], start_ts, end_ts)
        with ThreadPoolExecutor(max_workers=min(self.max_workers, len(batches))) as pool:
            results = pool.map(lambda b: self._fetch(b, start_ts, end_ts), batches)
            return [series for batch in results for series in batch]

    def _fetch(self, points: list[LatLon], start_ts: int, end_ts: int) -> list[HourlySeries]:
        params: dict[str, str] = {
            "latitude": ",".join(f"{p[0]:.4f}" for p in points),
            "longitude": ",".join(f"{p[1]:.4f}" for p in points),
            "hourly": ",".join(HOURLY_VARIABLES),
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
            "temperature_unit": "fahrenheit",
            "timeformat": "unixtime",
            "timezone": "GMT",
            "start_hour": _iso_hour(start_ts),
            "end_hour": _iso_hour(end_ts),
        }
        if self.api_key:
            params["apikey"] = self.api_key
        payload = self.http.get_json(
            f"{self.base_url}/v1/forecast", provider=self.name, params=params
        )
        items = payload if isinstance(payload, list) else [payload]
        if len(items) != len(points):
            raise UpstreamError(
                f"Expected {len(points)} forecasts, received {len(items)}", provider=self.name
            )
        return [parse_hourly(item, start_ts, end_ts) for item in items]


def _iso_hour(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M")


def parse_hourly(item: dict[str, Any], start_ts: int, end_ts: int) -> HourlySeries:
    try:
        hourly = item["hourly"]
        times = [int(t) for t in hourly["time"]]
        n = len(times)
        if n == 0 or times[0] > start_ts or times[-1] < end_ts:
            raise UpstreamError(
                "Forecast does not cover the requested window", provider="open-meteo"
            )
        if any(b - a != 3600 for a, b in itertools.pairwise(times)):
            raise UpstreamError("Forecast is not hourly", provider="open-meteo")
        rain = clean_series(hourly["rain"])
        showers = clean_series(hourly.get("showers") or [0.0] * n)
        return HourlySeries(
            start_ts=times[0],
            wind_mph=clean_series(hourly["wind_speed_10m"]),
            gust_mph=clean_series(hourly["wind_gusts_10m"]),
            rain_in=tuple(r + s for r, s in zip(rain, showers, strict=False)),
            snow_in=clean_series(hourly["snowfall"]),
            temperature_f=tuple(
                float(v) if v is not None else None
                for v in hourly.get("temperature_2m", [None] * n)
            ),
            weather_code=tuple(
                int(v) if v is not None else None for v in hourly.get("weather_code", [None] * n)
            ),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise UpstreamError("Malformed forecast response", provider="open-meteo") from exc
