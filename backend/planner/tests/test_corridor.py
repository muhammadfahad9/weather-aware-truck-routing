from __future__ import annotations

import pytest

from planner.domain.corridor import build_corridor, default_half_width
from planner.domain.geo import cumulative_miles, haversine_mi, resample


def _line(a: tuple[float, float], b: tuple[float, float], n: int = 50) -> list[tuple[float, float]]:
    return [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1)]


def _min_dist(p: tuple[float, float], route: list[tuple[float, float]]) -> float:
    samples = resample(route, cumulative_miles(route), 0.5)
    return min(haversine_mi(p, q) for q in samples)


def test_cells_are_within_corridor_and_cover_route() -> None:
    route = _line((35.0, -101.0), (36.0, -96.0))
    grid = build_corridor([route], max_cells=400)
    assert 0 < len(grid.cells) <= 400
    for p in grid.cell_points():
        assert _min_dist(p, route) <= grid.half_width_mi + 0.6
    # Every point of the route has a grid node nearby.
    for q in resample(route, cumulative_miles(route), 10):
        nearest = min(haversine_mi(q, p) for p in grid.cell_points())
        assert nearest <= grid.spacing_mi


def test_budget_is_respected_for_long_trips() -> None:
    route = _line((34.05, -118.24), (40.71, -74.0), n=400)  # LA -> NYC
    grid = build_corridor([route], max_cells=300)
    assert len(grid.cells) <= 300
    assert grid.spacing_mi > 10


def test_grid_geometry_is_regular() -> None:
    grid = build_corridor([_line((40.0, -105.0), (40.5, -104.0))])
    assert grid.nx >= 2 and grid.ny >= 2
    assert grid.cells == tuple(sorted(grid.cells))
    first = grid.node(0)
    assert first == (grid.lat0, grid.lon0)
    row1 = grid.node(grid.nx)
    assert row1[0] == pytest.approx(grid.lat0 + grid.dlat)


def test_multiple_routes_union() -> None:
    north = _line((37.0, -100.0), (37.0, -96.0))
    south = _line((34.0, -100.0), (34.0, -96.0))
    both = build_corridor([north, south], max_cells=2000, half_width_mi=20)
    only_north = build_corridor([north], max_cells=2000, half_width_mi=20)
    assert len(both.cells) > len(only_north.cells) * 1.7


@pytest.mark.parametrize(("length", "expected"), [(50, 12), (400, 24), (2000, 40)])
def test_default_half_width(length: float, expected: float) -> None:
    assert default_half_width(length) == pytest.approx(expected)


def test_requires_a_route() -> None:
    with pytest.raises(ValueError):
        build_corridor([[(1.0, 1.0)]])
