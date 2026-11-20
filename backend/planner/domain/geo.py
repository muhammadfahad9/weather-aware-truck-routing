"""Geodesy and polyline helpers. Points are ``(lat, lon)`` degrees; distances are miles."""

from __future__ import annotations

import bisect
import math
from collections.abc import Sequence
from dataclasses import dataclass

from .units import EARTH_RADIUS_MI

LatLon = tuple[float, float]


@dataclass(frozen=True)
class BBox:
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float

    def expanded(self, miles: float) -> BBox:
        """Grow the box by ``miles`` on every side (longitude scaled at the widest latitude)."""
        dlat = miles / 69.0
        widest_lat = max(abs(self.min_lat), abs(self.max_lat))
        cos_lat = max(math.cos(math.radians(min(widest_lat + dlat, 89.0))), 0.01)
        dlon = miles / (69.172 * cos_lat)
        return BBox(
            max(self.min_lat - dlat, -89.9),
            max(self.min_lon - dlon, -180.0),
            min(self.max_lat + dlat, 89.9),
            min(self.max_lon + dlon, 180.0),
        )


def haversine_mi(a: LatLon, b: LatLon) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(h)))


def initial_bearing_deg(a: LatLon, b: LatLon) -> float:
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def destination_point(origin: LatLon, bearing_deg: float, distance_mi: float) -> LatLon:
    """Point reached travelling ``distance_mi`` from ``origin`` on an initial bearing."""
    lat1 = math.radians(origin[0])
    lon1 = math.radians(origin[1])
    brg = math.radians(bearing_deg)
    ang = distance_mi / EARTH_RADIUS_MI
    lat2 = math.asin(
        math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(brg)
    )
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    lon_deg = (math.degrees(lon2) + 540.0) % 360.0 - 180.0
    return (math.degrees(lat2), lon_deg)


def decode_polyline(encoded: str, precision: int = 6) -> list[LatLon]:
    """Decode a Google encoded polyline (Valhalla uses precision 6, OSRM/Google 5)."""
    coords: list[LatLon] = []
    index = lat = lon = 0
    factor = 10**precision
    length = len(encoded)
    while index < length:
        deltas: list[int] = []
        for _ in range(2):
            result = shift = 0
            while True:
                if index >= length:
                    raise ValueError("Truncated polyline")
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lon += deltas[1]
        coords.append((lat / factor, lon / factor))
    return coords


def cumulative_miles(points: Sequence[LatLon]) -> list[float]:
    cum = [0.0] * len(points)
    for i in range(1, len(points)):
        cum[i] = cum[i - 1] + haversine_mi(points[i - 1], points[i])
    return cum


def interpolate_index(cum: Sequence[float], value: float) -> tuple[int, float]:
    """``(i, t)`` such that ``value`` sits at fraction ``t`` between ``cum[i]`` and ``cum[i+1]``.

    ``cum`` must be non-decreasing; out-of-range values clamp to the ends.
    """
    n = len(cum)
    if n == 0:
        raise ValueError("Empty sequence")
    if n == 1 or value <= cum[0]:
        return 0, 0.0
    if value >= cum[-1]:
        return n - 2, 1.0
    i = bisect.bisect_right(cum, value) - 1
    i = min(max(i, 0), n - 2)
    span = cum[i + 1] - cum[i]
    t = 0.0 if span <= 0 else (value - cum[i]) / span
    return i, t


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def point_at(points: Sequence[LatLon], cum: Sequence[float], mile: float) -> LatLon:
    i, t = interpolate_index(cum, mile)
    if len(points) == 1:
        return points[0]
    a, b = points[i], points[i + 1]
    return (lerp(a[0], b[0], t), lerp(a[1], b[1], t))


def bbox_of(points: Sequence[LatLon]) -> BBox:
    if not points:
        raise ValueError("No points")
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return BBox(min(lats), min(lons), max(lats), max(lons))


def simplify_indices(points: Sequence[LatLon], tolerance_mi: float) -> list[int]:
    """Ramer-Douglas-Peucker; returns the indices of kept vertices (always both ends).

    Projects once to an equirectangular plane at the mean latitude, and uses a stack rather
    than recursion so very long routes are safe.
    """
    n = len(points)
    if n <= 2:
        return list(range(n))
    kx = 69.172 * math.cos(math.radians(sum(p[0] for p in points) / n))
    xs = [p[1] * kx for p in points]
    ys = [p[0] * 69.0 for p in points]
    tol_sq = tolerance_mi * tolerance_mi
    keep = bytearray(n)
    keep[0] = keep[n - 1] = 1
    stack = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        ax, ay = xs[start], ys[start]
        dx, dy = xs[end] - ax, ys[end] - ay
        seg_sq = dx * dx + dy * dy
        max_sq = -1.0
        max_idx = start
        for i in range(start + 1, end):
            px, py = xs[i] - ax, ys[i] - ay
            if seg_sq > 0:
                t = (px * dx + py * dy) / seg_sq
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
                px -= t * dx
                py -= t * dy
            d = px * px + py * py
            if d > max_sq:
                max_sq = d
                max_idx = i
        if max_sq > tol_sq:
            keep[max_idx] = 1
            stack.append((start, max_idx))
            stack.append((max_idx, end))
    return [i for i in range(n) if keep[i]]


def resample(points: Sequence[LatLon], cum: Sequence[float], step_mi: float) -> list[LatLon]:
    """Points every ``step_mi`` along the line, including both ends."""
    if not points:
        return []
    total = cum[-1]
    if total <= 0:
        return [points[0]]
    count = max(1, math.ceil(total / step_mi))
    return [point_at(points, cum, total * k / count) for k in range(count + 1)]
