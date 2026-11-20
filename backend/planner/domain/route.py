"""A drivable route: geometry plus how long it takes to reach every vertex."""

from __future__ import annotations

import itertools
from collections.abc import Sequence
from dataclasses import dataclass, field

from .geo import LatLon, cumulative_miles, interpolate_index, lerp, point_at


@dataclass(frozen=True)
class RoutePath:
    points: tuple[LatLon, ...]
    cum_mi: tuple[float, ...]
    cum_drive_s: tuple[float, ...]

    @classmethod
    def from_points(cls, points: Sequence[LatLon], cum_drive_s: Sequence[float]) -> RoutePath:
        if len(points) < 2:
            raise ValueError("A route needs at least two points")
        if len(points) != len(cum_drive_s):
            raise ValueError("Every vertex needs a cumulative driving time")
        if any(b < a for a, b in itertools.pairwise(cum_drive_s)):
            raise ValueError("Cumulative driving time must be non-decreasing")
        return cls(tuple(points), tuple(cumulative_miles(points)), tuple(cum_drive_s))

    @property
    def total_mi(self) -> float:
        return self.cum_mi[-1]

    @property
    def total_drive_s(self) -> float:
        return self.cum_drive_s[-1]

    def point_at_mile(self, mile: float) -> LatLon:
        return point_at(self.points, self.cum_mi, mile)

    def drive_s_at_mile(self, mile: float) -> float:
        i, t = interpolate_index(self.cum_mi, mile)
        return lerp(self.cum_drive_s[i], self.cum_drive_s[i + 1], t)

    def mile_at_drive_s(self, drive_s: float) -> float:
        i, t = interpolate_index(self.cum_drive_s, drive_s)
        return lerp(self.cum_mi[i], self.cum_mi[i + 1], t)


def distribute_durations(
    points: Sequence[LatLon], spans: Sequence[tuple[int, int, float]]
) -> list[float]:
    """Per-vertex cumulative time from ``(begin_idx, end_idx, seconds)`` maneuver spans.

    Time is spread over a span by segment length; uncovered vertices keep the previous time.
    """
    n = len(points)
    seg_time = [0.0] * max(n - 1, 0)
    cum = cumulative_miles(points)
    for begin, end, seconds in spans:
        begin = max(0, min(begin, n - 1))
        end = max(begin, min(end, n - 1))
        if end == begin:
            if begin < n - 1 and seconds > 0:
                seg_time[begin] += seconds
            continue
        length = cum[end] - cum[begin]
        for k in range(begin, end):
            if length > 0:
                seg_time[k] += seconds * (cum[k + 1] - cum[k]) / length
            else:
                seg_time[k] += seconds / (end - begin)
    out = [0.0] * n
    for k in range(1, n):
        out[k] = out[k - 1] + seg_time[k - 1]
    return out


def cap_speed(
    points: Sequence[LatLon], cum_drive_s: Sequence[float], max_mph: float
) -> list[float]:
    """Slow down any segment faster than ``max_mph`` (truck speed governor)."""
    cum = cumulative_miles(points)
    out = [0.0] * len(points)
    for k in range(1, len(points)):
        dt = cum_drive_s[k] - cum_drive_s[k - 1]
        min_dt = (cum[k] - cum[k - 1]) / max_mph * 3600.0
        out[k] = out[k - 1] + max(dt, min_dt)
    return out


@dataclass
class RouteCandidate:
    """A provider's route, before weather analysis."""

    path: RoutePath
    provider: str
    via: list[str] = field(default_factory=list)
    note: str | None = None
