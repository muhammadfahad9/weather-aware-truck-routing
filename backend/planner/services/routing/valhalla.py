"""Valhalla routing with truck costing (weight, access and top speed). Default provider."""

from __future__ import annotations

from typing import Any

from planner.domain.geo import LatLon, decode_polyline
from planner.domain.route import RouteCandidate, RoutePath, cap_speed, distribute_durations
from planner.domain.units import mph_to_kph, pounds_to_metric_tons

from ..errors import RouteNotFoundError, UpstreamError
from ..http import HttpClient, MinIntervalLimiter
from .base import Truck, principal_roads

# Error codes for a valid request with no possible route.
_NO_ROUTE_CODES = {170, 171, 442, 443}


class ValhallaProvider:
    name = "valhalla"

    def __init__(self, http: HttpClient, base_url: str, limiter: MinIntervalLimiter) -> None:
        self.http = http
        self.base_url = base_url.rstrip("/")
        self.limiter = limiter

    def routes(
        self, origin: LatLon, destination: LatLon, truck: Truck, alternates: int
    ) -> list[RouteCandidate]:
        body = self._body([_loc(origin), _loc(destination)], truck)
        body["alternates"] = alternates
        data = self._post(body)
        trips = [data["trip"], *(a["trip"] for a in data.get("alternates", []) if "trip" in a)]
        return [self._parse_trip(t, truck) for t in trips]

    def via_route(
        self, origin: LatLon, via: LatLon, destination: LatLon, truck: Truck
    ) -> RouteCandidate:
        via_loc = {
            **_loc(via),
            "type": "through",
            "radius": 20_000,
            # Snap to a highway, not a farm track.
            "search_filter": {"min_road_class": "primary"},
        }
        data = self._post(self._body([_loc(origin), via_loc, _loc(destination)], truck))
        return self._parse_trip(data["trip"], truck, note="synthesized")

    def _body(self, locations: list[dict[str, Any]], truck: Truck) -> dict[str, Any]:
        return {
            "locations": locations,
            "costing": "truck",
            "costing_options": {
                "truck": {
                    "weight": round(pounds_to_metric_tons(truck.gross_lb), 2),
                    "top_speed": round(mph_to_kph(truck.max_speed_mph)),
                }
            },
            "units": "miles",
            "directions_type": "maneuvers",
            "language": "en-US",
        }

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        self.limiter.wait()
        try:
            data = self.http.post_json(f"{self.base_url}/route", provider=self.name, body=body)
        except UpstreamError as exc:
            code = exc.body.get("error_code") if isinstance(exc.body, dict) else None
            if code in _NO_ROUTE_CODES:
                raise RouteNotFoundError(
                    "No truck route was found between these locations.", provider=self.name
                ) from exc
            # Anything else (e.g. 154, the public server's 1,500 km limit) stays an
            # UpstreamError so the OSRM fallback kicks in.
            raise
        if not isinstance(data, dict) or "trip" not in data:
            raise UpstreamError("Unexpected routing response", provider=self.name)
        return data

    def _parse_trip(
        self, trip: dict[str, Any], truck: Truck, note: str | None = None
    ) -> RouteCandidate:
        points: list[LatLon] = []
        spans: list[tuple[int, int, float]] = []
        names: list[tuple[str, float]] = []
        for leg in trip.get("legs", []):
            leg_points = decode_polyline(leg["shape"], precision=6)
            offset = len(points) - 1 if points else 0
            points.extend(leg_points[1:] if points else leg_points)
            for m in leg.get("maneuvers", []):
                spans.append(
                    (
                        offset + m["begin_shape_index"],
                        offset + m["end_shape_index"],
                        float(m["time"]),
                    )
                )
                for street in m.get("street_names", [])[:1]:
                    names.append((street, float(m.get("length", 0.0))))
        if len(points) < 2:
            raise UpstreamError("Route geometry is empty", provider=self.name)
        cum_s = distribute_durations(points, spans)
        if cum_s[-1] <= 0:  # no maneuver timing: fall back to the summary time
            total = float(trip.get("summary", {}).get("time", 0.0))
            cum_s = distribute_durations(points, [(0, len(points) - 1, total)])
        cum_s = cap_speed(points, cum_s, truck.max_speed_mph)
        return RouteCandidate(
            path=RoutePath.from_points(points, cum_s),
            provider=self.name,
            via=principal_roads(names),
            note=note,
        )


def _loc(p: LatLon) -> dict[str, Any]:
    return {"lat": round(p[0], 6), "lon": round(p[1], 6)}
