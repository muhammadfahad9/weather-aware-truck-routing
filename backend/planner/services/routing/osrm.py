"""OSRM fallback routing. The public server is car-only, so speeds are capped for the truck."""

from __future__ import annotations

from typing import Any

from planner.domain.geo import LatLon, decode_polyline
from planner.domain.route import RouteCandidate, RoutePath, cap_speed, distribute_durations

from ..errors import RouteNotFoundError, UpstreamError
from ..http import HttpClient, MinIntervalLimiter
from .base import Truck, principal_roads


class OsrmProvider:
    name = "osrm"

    def __init__(self, http: HttpClient, base_url: str, limiter: MinIntervalLimiter) -> None:
        self.http = http
        self.base_url = base_url.rstrip("/")
        self.limiter = limiter

    def routes(
        self, origin: LatLon, destination: LatLon, truck: Truck, alternates: int
    ) -> list[RouteCandidate]:
        data = self._get([origin, destination], alternatives=alternates)
        return [self._parse(r, truck) for r in data["routes"][: alternates + 1]]

    def via_route(
        self, origin: LatLon, via: LatLon, destination: LatLon, truck: Truck
    ) -> RouteCandidate:
        data = self._get([origin, via, destination], alternatives=0, continue_straight=True)
        candidate = self._parse(data["routes"][0], truck)
        candidate.note = "synthesized"
        return candidate

    def _get(
        self, points: list[LatLon], *, alternatives: int, continue_straight: bool = False
    ) -> dict[str, Any]:
        coords = ";".join(f"{p[1]:.6f},{p[0]:.6f}" for p in points)
        params = {
            "alternatives": str(alternatives) if alternatives else "false",
            "overview": "full",
            "geometries": "polyline6",
            "annotations": "duration",
            "steps": "false",
        }
        if continue_straight:
            params["continue_straight"] = "true"
        self.limiter.wait()
        try:
            data = self.http.get_json(
                f"{self.base_url}/route/v1/driving/{coords}", provider=self.name, params=params
            )
        except UpstreamError as exc:
            if exc.status == 400:
                raise RouteNotFoundError("No route was found.", provider=self.name) from exc
            raise
        if data.get("code") == "NoRoute" or not data.get("routes"):
            raise RouteNotFoundError("No route was found.", provider=self.name)
        if data.get("code") != "Ok":
            raise UpstreamError(f"OSRM error: {data.get('code')}", provider=self.name)
        return dict(data)

    def _parse(self, route: dict[str, Any], truck: Truck) -> RouteCandidate:
        points = decode_polyline(route["geometry"], precision=6)
        durations = [
            d
            for leg in route.get("legs", [])
            for d in leg.get("annotation", {}).get("duration", [])
        ]
        if len(durations) == len(points) - 1:
            cum = [0.0]
            for d in durations:
                cum.append(cum[-1] + float(d))
        else:  # no annotations: spread the total duration by distance
            cum = distribute_durations(points, [(0, len(points) - 1, float(route["duration"]))])
        cum = cap_speed(points, cum, truck.max_speed_mph)
        summaries = [leg.get("summary", "") for leg in route.get("legs", [])]
        names = [(name.strip(), 1.0) for s in summaries for name in s.split(",") if name.strip()]
        return RouteCandidate(
            path=RoutePath.from_points(points, cum),
            provider=self.name,
            via=principal_roads(names),
        )
