"""Weather provider protocol and a caching, de-duplicating service in front of it."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Protocol

from django.core.cache import BaseCache

from planner.domain.analysis import SeriesLookup
from planner.domain.geo import LatLon
from planner.domain.weather import HourlySeries

# ~1.4 mi: finer than the model grids (HRRR 3 km, GFS ~13 km), coarse enough to share lookups.
SNAP_DEG = 0.02
# Widen windows to 6-hour boundaries so nearby departure times share cache entries.
WINDOW_QUANTUM_S = 6 * 3600
CACHE_TTL_S = 20 * 60


class WeatherProvider(Protocol):
    name: str
    cacheable: bool

    def hourly(self, points: Sequence[LatLon], start_ts: int, end_ts: int) -> list[HourlySeries]:
        """Hourly series from ``start_ts`` to ``end_ts`` (inclusive, top-of-hour UTC)."""
        ...


def snap(point: LatLon) -> tuple[int, int]:
    return (round(point[0] / SNAP_DEG), round(point[1] / SNAP_DEG))


def snapped_point(key: tuple[int, int]) -> LatLon:
    return (round(key[0] * SNAP_DEG, 4), round(key[1] * SNAP_DEG, 4))


def quantize_window(start_ts: float, end_ts: float) -> tuple[int, int]:
    start = math.floor(start_ts / WINDOW_QUANTUM_S) * WINDOW_QUANTUM_S
    end = math.ceil(end_ts / WINDOW_QUANTUM_S) * WINDOW_QUANTUM_S
    return start, max(end, start + WINDOW_QUANTUM_S)


class WeatherService:
    def __init__(self, provider: WeatherProvider, cache: BaseCache | None = None) -> None:
        self.provider = provider
        self.cache = cache if provider.cacheable else None

    def lookup(self, points: Sequence[LatLon], start_ts: float, end_ts: float) -> SeriesLookup:
        """Fetch (or reuse) forecasts covering ``[start_ts, end_ts]`` for all points."""
        window = quantize_window(start_ts, end_ts)
        keys = list(dict.fromkeys(snap(p) for p in points))
        series: dict[tuple[int, int], HourlySeries] = {}

        cache_keys = {k: self._cache_key(k, window) for k in keys}
        if self.cache is not None:
            hits = self.cache.get_many(list(cache_keys.values()))
            for k, ck in cache_keys.items():
                if ck in hits:
                    series[k] = hits[ck]

        missing = [k for k in keys if k not in series]
        if missing:
            fetched = self.provider.hourly([snapped_point(k) for k in missing], *window)
            new = dict(zip(missing, fetched, strict=True))
            series.update(new)
            if self.cache is not None:
                self.cache.set_many({cache_keys[k]: v for k, v in new.items()}, CACHE_TTL_S)

        def lookup(point: LatLon) -> HourlySeries:
            return series[snap(point)]

        return lookup

    def _cache_key(self, key: tuple[int, int], window: tuple[int, int]) -> str:
        return f"wx:{self.provider.name}:{key[0]}:{key[1]}:{window[0]}:{window[1]}"
