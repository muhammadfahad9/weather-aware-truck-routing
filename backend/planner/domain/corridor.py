"""Heatmap sampling grid: a regular lat/lon lattice clipped to the route corridor.

The lattice is regular so the client can interpolate it bilinearly. Spacing grows with the
corridor area to keep the cell count within ``max_cells``.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .geo import LatLon, bbox_of, cumulative_miles, haversine_mi, resample

MI_PER_DEG_LAT = 69.0
MI_PER_DEG_LON_EQUATOR = 69.172


@dataclass(frozen=True)
class CorridorGrid:
    lat0: float
    lon0: float
    dlat: float
    dlon: float
    nx: int
    ny: int
    cells: tuple[int, ...]
    spacing_mi: float
    half_width_mi: float

    def node(self, index: int) -> LatLon:
        row, col = divmod(index, self.nx)
        return (self.lat0 + row * self.dlat, self.lon0 + col * self.dlon)

    def cell_points(self) -> list[LatLon]:
        return [self.node(i) for i in self.cells]


def default_half_width(longest_route_mi: float) -> float:
    """Corridor half-width: ~6% of the trip, between 12 and 40 miles."""
    return min(max(0.06 * longest_route_mi, 12.0), 40.0)


def build_corridor(
    routes: Sequence[Sequence[LatLon]],
    *,
    max_cells: int = 400,
    half_width_mi: float | None = None,
    min_spacing_mi: float = 4.0,
) -> CorridorGrid:
    routes = [r for r in routes if len(r) >= 2]
    if not routes:
        raise ValueError("At least one route with two points is required")
    cums = [cumulative_miles(r) for r in routes]
    longest = max(c[-1] for c in cums)
    half_width = half_width_mi if half_width_mi is not None else default_half_width(longest)

    # Start from an area-based estimate and widen until under budget.
    area = sum(c[-1] for c in cums) * 2 * half_width + math.pi * half_width**2
    spacing = max(min_spacing_mi, math.sqrt(area / max_cells), half_width / 3)
    for _ in range(30):
        grid = _rasterize(routes, cums, spacing, half_width)
        if len(grid.cells) <= max_cells:
            return grid
        spacing *= 1.12
    return grid  # pragma: no cover - spacing growth converges long before this


def _rasterize(
    routes: Sequence[Sequence[LatLon]],
    cums: Sequence[Sequence[float]],
    spacing_mi: float,
    half_width_mi: float,
) -> CorridorGrid:
    box = bbox_of([p for r in routes for p in r]).expanded(half_width_mi + spacing_mi)
    mid_lat = (box.min_lat + box.max_lat) / 2
    dlat = spacing_mi / MI_PER_DEG_LAT
    dlon = spacing_mi / (MI_PER_DEG_LON_EQUATOR * max(math.cos(math.radians(mid_lat)), 0.05))
    ny = max(2, math.ceil((box.max_lat - box.min_lat) / dlat) + 1)
    nx = max(2, math.ceil((box.max_lon - box.min_lon) / dlon) + 1)

    inside: set[int] = set()
    reach_rows = math.ceil(half_width_mi / spacing_mi) + 1
    for route, cum in zip(routes, cums, strict=False):
        for lat, lon in resample(route, cum, spacing_mi / 2):
            row_f = (lat - box.min_lat) / dlat
            col_f = (lon - box.min_lon) / dlon
            cos_lat = max(math.cos(math.radians(lat)), 0.05)
            reach_cols = math.ceil(half_width_mi / (dlon * MI_PER_DEG_LON_EQUATOR * cos_lat)) + 1
            r0, c0 = round(row_f), round(col_f)
            for row in range(max(0, r0 - reach_rows), min(ny, r0 + reach_rows + 1)):
                node_lat = box.min_lat + row * dlat
                for col in range(max(0, c0 - reach_cols), min(nx, c0 + reach_cols + 1)):
                    idx = row * nx + col
                    if idx in inside:
                        continue
                    node = (node_lat, box.min_lon + col * dlon)
                    if haversine_mi((lat, lon), node) <= half_width_mi:
                        inside.add(idx)
    return CorridorGrid(
        lat0=box.min_lat,
        lon0=box.min_lon,
        dlat=dlat,
        dlon=dlon,
        nx=nx,
        ny=ny,
        cells=tuple(sorted(inside)),
        spacing_mi=spacing_mi,
        half_width_mi=half_width_mi,
    )
