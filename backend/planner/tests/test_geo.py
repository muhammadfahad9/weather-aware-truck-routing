from __future__ import annotations

import pytest

from planner.domain.geo import (
    BBox,
    bbox_of,
    cumulative_miles,
    decode_polyline,
    destination_point,
    haversine_mi,
    initial_bearing_deg,
    interpolate_index,
    point_at,
    resample,
    simplify_indices,
)


def test_haversine_known_distance() -> None:
    # Dallas -> Chicago great-circle distance is ~802 statute miles.
    assert haversine_mi((32.7767, -96.7970), (41.8781, -87.6298)) == pytest.approx(802, abs=3)
    assert haversine_mi((10, 10), (10, 10)) == 0


def test_one_degree_of_latitude_is_about_69_miles() -> None:
    assert haversine_mi((40, -100), (41, -100)) == pytest.approx(69.09, abs=0.05)


def test_decode_google_reference_polyline() -> None:
    # Example from Google's encoded polyline algorithm documentation.
    points = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision=5)
    assert points == [
        pytest.approx((38.5, -120.2)),
        pytest.approx((40.7, -120.95)),
        pytest.approx((43.252, -126.453)),
    ]


def test_decode_precision_six() -> None:
    # Same deltas, interpreted at 1e-6 instead of 1e-5.
    points = decode_polyline("_p~iF~ps|U", precision=6)
    assert points[0] == pytest.approx((3.85, -12.02))


def test_decode_truncated_polyline_raises() -> None:
    with pytest.raises(ValueError, match="Truncated"):
        decode_polyline("_p~iF~ps|", precision=5)


def test_destination_point_round_trip() -> None:
    start = (35.0, -97.0)
    end = destination_point(start, 45.0, 100.0)
    assert haversine_mi(start, end) == pytest.approx(100.0, rel=1e-6)
    assert initial_bearing_deg(start, end) == pytest.approx(45.0, abs=0.01)


def test_destination_point_wraps_longitude() -> None:
    _lat, lon = destination_point((0.0, 179.9), 90.0, 50.0)
    assert -180 <= lon <= 180
    assert lon < 0


def test_bearing_cardinal_directions() -> None:
    assert initial_bearing_deg((0, 0), (1, 0)) == pytest.approx(0.0)
    assert initial_bearing_deg((0, 0), (0, 1)) == pytest.approx(90.0)
    assert initial_bearing_deg((0, 0), (-1, 0)) == pytest.approx(180.0)
    assert initial_bearing_deg((0, 0), (0, -1)) == pytest.approx(270.0)


def test_interpolate_index_clamps_and_interpolates() -> None:
    cum = [0.0, 10.0, 10.0, 30.0]
    assert interpolate_index(cum, -5) == (0, 0.0)
    assert interpolate_index(cum, 35) == (2, 1.0)
    i, t = interpolate_index(cum, 20.0)
    assert (i, t) == (2, pytest.approx(0.5))
    assert interpolate_index([5.0], 3.0) == (0, 0.0)
    with pytest.raises(ValueError):
        interpolate_index([], 1.0)


def test_point_at_mile_and_cumulative() -> None:
    pts = [(0.0, 0.0), (0.0, 1.0), (0.0, 2.0)]
    cum = cumulative_miles(pts)
    assert cum[0] == 0 and cum[1] == pytest.approx(cum[2] / 2)
    mid = point_at(pts, cum, cum[-1] * 0.75)
    assert mid == pytest.approx((0.0, 1.5))
    assert point_at(pts[:1], [0.0], 3.0) == (0.0, 0.0)


def test_simplify_keeps_corners_and_drops_collinear() -> None:
    line = [(0.0, x / 100) for x in range(101)] + [(y / 100, 1.0) for y in range(1, 101)]
    kept = simplify_indices(line, tolerance_mi=0.01)
    assert kept == [0, 100, len(line) - 1]
    assert simplify_indices(line[:2], 0.01) == [0, 1]


def test_simplify_respects_tolerance() -> None:
    zigzag = [(0.001 * (i % 2), i * 0.01) for i in range(50)]  # ~0.07 mi wiggle
    assert len(simplify_indices(zigzag, tolerance_mi=0.5)) == 2
    assert len(simplify_indices(zigzag, tolerance_mi=0.01)) == 50


def test_simplify_handles_duplicate_points() -> None:
    pts = [(1.0, 1.0), (1.0, 1.0), (1.0, 1.0)]
    assert simplify_indices(pts, 0.01) == [0, 2]


def test_resample_spacing() -> None:
    pts = [(0.0, 0.0), (0.0, 1.0)]
    cum = cumulative_miles(pts)
    samples = resample(pts, cum, 10.0)
    assert samples[0] == (0.0, 0.0) and samples[-1] == pytest.approx((0.0, 1.0))
    assert len(samples) == 8  # 69.17 mi / 10 -> 7 steps -> 8 points
    assert resample([], [], 1.0) == []
    assert resample([(1.0, 1.0), (1.0, 1.0)], [0.0, 0.0], 1.0) == [(1.0, 1.0)]


def test_bbox_and_expansion() -> None:
    box = bbox_of([(30.0, -100.0), (35.0, -90.0)])
    assert box == BBox(30.0, -100.0, 35.0, -90.0)
    grown = box.expanded(69.0)
    assert grown.min_lat == pytest.approx(29.0)
    assert grown.max_lat == pytest.approx(36.0)
    assert grown.min_lon < -101.0 and grown.max_lon > -89.0
    with pytest.raises(ValueError):
        bbox_of([])
