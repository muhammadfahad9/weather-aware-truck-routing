"""FMCSA Hours-of-Service stops (49 CFR 395.3) for ETA estimation.

30-minute break after 8 h of driving, 10-hour rest at the 11-hour driving limit. Assumes a
fresh driver. A shift is at most 11.5 h on duty, so the 14-hour window never binds; weekly
limits, fueling and inspections are ignored.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

StopKind = Literal["break", "rest"]


@dataclass(frozen=True)
class HosPolicy:
    break_after_driving_s: float = 8 * 3600
    break_duration_s: float = 30 * 60
    max_driving_s: float = 11 * 3600
    rest_duration_s: float = 10 * 3600


@dataclass(frozen=True)
class Stop:
    kind: StopKind
    at_driving_s: float
    duration_s: float


def plan_stops(total_driving_s: float, policy: HosPolicy | None = None) -> list[Stop]:
    """Stops needed for ``total_driving_s``; none if the trip ends right at a limit."""
    policy = policy or HosPolicy()
    stops: list[Stop] = []
    shift_start = 0.0
    while True:
        break_at = shift_start + policy.break_after_driving_s
        rest_at = shift_start + policy.max_driving_s
        if break_at < rest_at and break_at < total_driving_s:
            stops.append(Stop("break", break_at, policy.break_duration_s))
        if rest_at >= total_driving_s:
            return stops
        stops.append(Stop("rest", rest_at, policy.rest_duration_s))
        shift_start = rest_at


def elapsed_at(driving_s: float, stops: Sequence[Stop]) -> float:
    """Wall-clock seconds after ``driving_s`` of driving.

    A stop that starts exactly at ``driving_s`` has not been taken yet.
    """
    return driving_s + sum(s.duration_s for s in stops if s.at_driving_s < driving_s)


def total_stop_seconds(stops: Sequence[Stop]) -> float:
    return sum(s.duration_s for s in stops)
