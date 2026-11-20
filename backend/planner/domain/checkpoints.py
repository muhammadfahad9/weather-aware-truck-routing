"""Checkpoint placement along a route and the stretch of road each checkpoint represents."""

from __future__ import annotations

import math
from dataclasses import dataclass

ALLOWED_INTERVALS_MI = (10, 25, 50)

# A remainder shorter than this is merged into the destination checkpoint.
_MERGE_EPSILON_MI = 0.05


@dataclass(frozen=True)
class CheckpointSpan:
    mile: float
    start_mi: float
    end_mi: float

    @property
    def length_mi(self) -> float:
        return self.end_mi - self.start_mi


def checkpoint_miles(total_mi: float, interval_mi: float) -> list[float]:
    """Origin, every ``interval_mi`` along the route, and the destination."""
    if interval_mi <= 0:
        raise ValueError("Interval must be positive")
    if total_mi <= 0:
        return [0.0]
    count = math.floor(total_mi / interval_mi + 1e-9)
    miles = [k * interval_mi for k in range(count + 1)]
    if total_mi - miles[-1] <= _MERGE_EPSILON_MI:
        miles[-1] = total_mi
    else:
        miles.append(total_mi)
    return miles


def checkpoint_spans(miles: list[float]) -> list[CheckpointSpan]:
    """Midpoint-to-midpoint stretch of road covered by each checkpoint.

    The spans tile the route, so per-level mileage always sums to the route length.
    """
    if not miles:
        return []
    if len(miles) == 1:
        return [CheckpointSpan(miles[0], miles[0], miles[0])]
    spans: list[CheckpointSpan] = []
    for i, mile in enumerate(miles):
        start = miles[0] if i == 0 else (miles[i - 1] + mile) / 2
        end = miles[-1] if i == len(miles) - 1 else (mile + miles[i + 1]) / 2
        spans.append(CheckpointSpan(mile, start, end))
    return spans
