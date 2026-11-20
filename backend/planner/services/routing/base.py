"""Routing provider protocol and shared helpers."""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

from planner.domain.geo import LatLon
from planner.domain.route import RouteCandidate


@dataclass(frozen=True)
class Truck:
    load_lb: float
    tare_lb: float = 35_000.0
    max_speed_mph: float = 65.0

    @property
    def gross_lb(self) -> float:
        return self.tare_lb + self.load_lb


class RoutingProvider(Protocol):
    name: str

    def routes(
        self, origin: LatLon, destination: LatLon, truck: Truck, alternates: int
    ) -> list[RouteCandidate]:
        """Best route first, then up to ``alternates`` alternatives (may return fewer)."""
        ...

    def via_route(
        self, origin: LatLon, via: LatLon, destination: LatLon, truck: Truck
    ) -> RouteCandidate:
        """A route forced through ``via``, used to build detours."""
        ...


_DIRECTION_SUFFIX = re.compile(r"\s+(north|south|east|west|n|s|e|w|nb|sb|eb|wb)$", re.IGNORECASE)
_HIGHWAY = re.compile(r"^(I|US|SR|[A-Z]{2})[\s-]?(\d+[A-Z]?)\b", re.IGNORECASE)


def normalize_road_name(name: str) -> str:
    """``"I 57 North"`` -> ``"I-57"``; other names are returned trimmed."""
    cleaned = _DIRECTION_SUFFIX.sub("", name.strip())
    match = _HIGHWAY.match(cleaned)
    if match:
        return f"{match.group(1).upper()}-{match.group(2).upper()}"
    return cleaned


def principal_roads(weighted_names: Iterable[tuple[str, float]], limit: int = 2) -> list[str]:
    """Names of the roads carrying the most miles (highways preferred)."""
    totals: defaultdict[str, float] = defaultdict(float)
    for name, miles in weighted_names:
        if name:
            totals[normalize_road_name(name)] += miles
    ranked = sorted(totals.items(), key=lambda kv: (not _HIGHWAY.match(kv[0]), -kv[1]))
    return [name for name, _ in ranked[:limit]]
