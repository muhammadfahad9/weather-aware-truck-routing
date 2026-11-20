"""Offline routing (ROUTING_PROVIDER=simulated): three distinct arcs between two points."""

from __future__ import annotations

import math

from planner.domain.geo import (
    LatLon,
    cumulative_miles,
    destination_point,
    haversine_mi,
    initial_bearing_deg,
)
from planner.domain.route import RouteCandidate, RoutePath

from ..errors import RouteNotFoundError
from .base import Truck

_VARIANTS = (
    (0.0, 57.0, "I-SIM1"),
    (0.14, 61.0, "US-SIM2"),
    (-0.18, 63.0, "I-SIM3"),
)


class SimulatedRoutingProvider:
    name = "simulated"

    def routes(
        self, origin: LatLon, destination: LatLon, truck: Truck, alternates: int
    ) -> list[RouteCandidate]:
        if haversine_mi(origin, destination) < 0.5:
            raise RouteNotFoundError(
                "Origin and destination are the same place.", provider=self.name
            )
        return [
            _arc(origin, destination, bow, min(mph, truck.max_speed_mph), road)
            for bow, mph, road in _VARIANTS[: alternates + 1]
        ]

    def via_route(
        self, origin: LatLon, via: LatLon, destination: LatLon, truck: Truck
    ) -> RouteCandidate:
        first = _arc(origin, via, 0.0, truck.max_speed_mph, "SIM-VIA")
        second = _arc(via, destination, 0.0, truck.max_speed_mph, "SIM-VIA")
        points = list(first.path.points) + list(second.path.points[1:])
        cum = cumulative_miles(points)
        return RouteCandidate(
            path=RoutePath.from_points(points, [m / truck.max_speed_mph * 3600 for m in cum]),
            provider=self.name,
            via=["SIM-VIA"],
            note="synthesized",
        )


def _arc(origin: LatLon, destination: LatLon, bow: float, mph: float, road: str) -> RouteCandidate:
    straight = haversine_mi(origin, destination)
    n = max(24, int(straight / 2))
    bearing = initial_bearing_deg(origin, destination)
    points: list[LatLon] = []
    for k in range(n + 1):
        f = k / n
        base = (
            origin[0] + (destination[0] - origin[0]) * f,
            origin[1] + (destination[1] - origin[1]) * f,
        )
        offset = bow * straight * math.sin(math.pi * f)
        points.append(destination_point(base, bearing + 90.0, offset) if offset else base)
    cum = cumulative_miles(points)
    return RouteCandidate(
        path=RoutePath.from_points(points, [m / mph * 3600 for m in cum]),
        provider="simulated",
        via=[road],
    )
