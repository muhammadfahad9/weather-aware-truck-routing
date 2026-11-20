"""Up to N distinct route options, sorted by driving time.

Starts from the provider's alternates (the fallback provider on an outage), drops routes that
overlap by >= 90%, then fills any gap with detours via points offset to either side of the
main route. Detours more than 1.5x longer or slower are discarded.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from planner.domain.geo import (
    LatLon,
    destination_point,
    haversine_mi,
    initial_bearing_deg,
    resample,
)
from planner.domain.route import RouteCandidate

from ..errors import RouteNotFoundError, UpstreamError
from .base import RoutingProvider, Truck

logger = logging.getLogger(__name__)

DUPLICATE_OVERLAP = 0.9
MAX_DETOUR_FACTOR = 1.5
_MATCH_RADIUS_MI = 0.35
_HASH_CELL_DEG = 0.01


@dataclass
class RouteOptions:
    routes: list[RouteCandidate]
    provider: str
    warnings: list[str] = field(default_factory=list)


def find_route_options(
    primary: RoutingProvider,
    fallback: RoutingProvider | None,
    origin: LatLon,
    destination: LatLon,
    truck: Truck,
    count: int = 3,
    max_detour_attempts: int = 4,
) -> RouteOptions:
    warnings: list[str] = []
    provider = primary
    try:
        candidates = primary.routes(origin, destination, truck, alternates=count - 1)
    except UpstreamError as exc:
        if fallback is None:
            raise
        logger.warning("Primary routing failed (%s); using %s", exc, fallback.name)
        provider = fallback
        candidates = fallback.routes(origin, destination, truck, alternates=count - 1)
        warnings.append(
            f"Truck routing ({primary.name}) could not serve this trip ({exc.message}). "
            f"Routes come from {fallback.name}'s road network with truck speed limits applied; "
            "truck-specific restrictions may not be reflected."
        )

    distinct: list[RouteCandidate] = []
    for cand in candidates:
        if not any(is_duplicate(cand, kept) for kept in distinct):
            distinct.append(cand)

    if len(distinct) < count:
        for via in detour_points(origin, destination, distinct[0], max_detour_attempts):
            if len(distinct) >= count:
                break
            try:
                cand = provider.via_route(origin, via, destination, truck)
            except (UpstreamError, RouteNotFoundError) as exc:
                logger.info("Detour via %s failed: %s", via, exc)
                continue
            if _reasonable(cand, distinct) and not any(is_duplicate(cand, k) for k in distinct):
                distinct.append(cand)

    if len(distinct) < count:
        warnings.append(
            f"Only {len(distinct)} distinct route{'s' if len(distinct) != 1 else ''} exist "
            "between these points."
        )
    distinct.sort(key=lambda c: c.path.total_drive_s)
    return RouteOptions(routes=distinct[:count], provider=provider.name, warnings=warnings)


def detour_points(
    origin: LatLon, destination: LatLon, base: RouteCandidate, attempts: int
) -> list[LatLon]:
    """Via points left and right of the main route, in order of preference."""
    straight = haversine_mi(origin, destination)
    offset = min(max(0.2 * straight, 3.0), 150.0)
    bearing = initial_bearing_deg(origin, destination)
    path = base.path
    plan = [(0.5, -90), (0.5, 90), (0.35, -90), (0.65, 90), (0.35, 90), (0.65, -90)]
    return [
        destination_point(path.point_at_mile(path.total_mi * frac), bearing + turn, offset)
        for frac, turn in plan[:attempts]
    ]


def _reasonable(candidate: RouteCandidate, existing: Sequence[RouteCandidate]) -> bool:
    shortest = min(c.path.total_mi for c in existing)
    fastest = min(c.path.total_drive_s for c in existing)
    return (
        candidate.path.total_mi <= shortest * MAX_DETOUR_FACTOR
        and candidate.path.total_drive_s <= fastest * MAX_DETOUR_FACTOR
    )


def is_duplicate(a: RouteCandidate, b: RouteCandidate) -> bool:
    return min(overlap_ratio(a, b), overlap_ratio(b, a)) >= DUPLICATE_OVERLAP


def overlap_ratio(a: RouteCandidate, b: RouteCandidate) -> float:
    """Share of route ``a`` (by distance) that runs within ~0.35 mi of route ``b``."""
    b_samples = resample(b.path.points, b.path.cum_mi, 0.2)
    index: dict[tuple[int, int], list[LatLon]] = {}
    for p in b_samples:
        index.setdefault(_cell(p), []).append(p)
    a_samples = resample(a.path.points, a.path.cum_mi, 1.0)
    hits = 0
    for p in a_samples:
        cx, cy = _cell(p)
        reach = 1 + math.ceil(
            _MATCH_RADIUS_MI / (69.0 * _HASH_CELL_DEG * max(math.cos(math.radians(p[0])), 0.1))
        )
        found = False
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                for q in index.get((cx + dx, cy + dy), ()):
                    if haversine_mi(p, q) <= _MATCH_RADIUS_MI:
                        found = True
                        break
                if found:
                    break
            if found:
                break
        hits += found
    return hits / len(a_samples) if a_samples else 0.0


def _cell(p: LatLon) -> tuple[int, int]:
    return (math.floor(p[0] / _HASH_CELL_DEG), math.floor(p[1] / _HASH_CELL_DEG))
