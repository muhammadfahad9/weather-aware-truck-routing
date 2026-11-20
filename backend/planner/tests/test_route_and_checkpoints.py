from __future__ import annotations

import itertools

import pytest

from planner.domain.checkpoints import checkpoint_miles, checkpoint_spans
from planner.domain.geo import cumulative_miles
from planner.domain.route import RoutePath, cap_speed, distribute_durations

from .conftest import straight_route


@pytest.mark.parametrize(
    ("total", "interval", "expected"),
    [
        (100.0, 25, [0, 25, 50, 75, 100]),
        (101.0, 25, [0, 25, 50, 75, 100, 101]),
        (100.03, 25, [0, 25, 50, 75, 100.03]),  # tiny remainder merges into destination
        (9.0, 10, [0, 9.0]),
        (0.0, 10, [0.0]),
        (120.0, 50, [0, 50, 100, 120]),
    ],
)
def test_checkpoint_miles(total: float, interval: int, expected: list[float]) -> None:
    assert checkpoint_miles(total, interval) == pytest.approx(expected)


def test_checkpoint_interval_must_be_positive() -> None:
    with pytest.raises(ValueError):
        checkpoint_miles(10, 0)


@pytest.mark.parametrize("total", [7.3, 99.9, 250.0, 963.4])
@pytest.mark.parametrize("interval", [10, 25, 50])
def test_spans_tile_route_exactly(total: float, interval: int) -> None:
    spans = checkpoint_spans(checkpoint_miles(total, interval))
    assert spans[0].start_mi == 0
    assert spans[-1].end_mi == pytest.approx(total)
    for a, b in itertools.pairwise(spans):
        assert a.end_mi == pytest.approx(b.start_mi)
    assert sum(s.length_mi for s in spans) == pytest.approx(total)


def test_spans_are_midpoint_to_midpoint() -> None:
    spans = checkpoint_spans([0, 10, 20, 25])
    assert [(s.start_mi, s.end_mi) for s in spans] == [(0, 5), (5, 15), (15, 22.5), (22.5, 25)]
    assert checkpoint_spans([]) == []
    assert checkpoint_spans([0.0])[0].length_mi == 0


def test_route_path_validation() -> None:
    with pytest.raises(ValueError, match="two points"):
        RoutePath.from_points([(0, 0)], [0])
    with pytest.raises(ValueError, match="driving time"):
        RoutePath.from_points([(0, 0), (0, 1)], [0])
    with pytest.raises(ValueError, match="non-decreasing"):
        RoutePath.from_points([(0, 0), (0, 1), (0, 2)], [0, 10, 5])


def test_route_path_time_distance_inverses() -> None:
    route = straight_route(mph=60).path
    assert route.total_drive_s == pytest.approx(route.total_mi / 60 * 3600)
    half = route.total_mi / 2
    assert route.drive_s_at_mile(half) == pytest.approx(route.total_drive_s / 2)
    assert route.mile_at_drive_s(route.total_drive_s / 4) == pytest.approx(route.total_mi / 4)
    lat, lon = route.point_at_mile(half)
    assert lat == pytest.approx(35.0) and lon == pytest.approx(-99.0)


def test_distribute_durations_proportional_to_length() -> None:
    pts = [(0.0, 0.0), (0.0, 1.0), (0.0, 3.0), (0.0, 4.0)]
    cum = distribute_durations(pts, [(0, 2, 300.0), (2, 3, 60.0)])
    assert cum == pytest.approx([0, 100, 300, 360])


def test_distribute_durations_edge_cases() -> None:
    pts = [(0.0, 0.0), (0.0, 0.0), (0.0, 1.0)]
    # Zero-length span spreads evenly; point span adds its time to the following segment;
    # out-of-range indices are clamped.
    cum = distribute_durations(pts, [(0, 1, 10.0), (1, 1, 5.0), (1, 99, 20.0)])
    assert cum == pytest.approx([0, 10, 35])


def test_cap_speed_slows_fast_segments_only() -> None:
    pts = [(0.0, 0.0), (0.0, 1.0), (0.0, 2.0)]
    seg = cumulative_miles(pts)[1]  # ~69.17 mi
    cum = [0.0, seg / 80 * 3600, seg / 80 * 3600 + seg / 50 * 3600]  # 80 mph, then 50 mph
    capped = cap_speed(pts, cum, 65)
    assert capped[1] == pytest.approx(seg / 65 * 3600)
    assert capped[2] - capped[1] == pytest.approx(seg / 50 * 3600)
