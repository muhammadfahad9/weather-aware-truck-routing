from __future__ import annotations

import pytest

from planner.domain.hos import HosPolicy, Stop, elapsed_at, plan_stops, total_stop_seconds

H = 3600


def test_short_trip_needs_no_stops() -> None:
    assert plan_stops(7.5 * H) == []


def test_exactly_eight_hours_needs_no_break() -> None:
    assert plan_stops(8 * H) == []


def test_break_after_eight_hours_of_driving() -> None:
    assert plan_stops(9 * H) == [Stop("break", 8 * H, 0.5 * H)]


def test_rest_after_eleven_hours_only_if_driving_continues() -> None:
    assert plan_stops(11 * H) == [Stop("break", 8 * H, 0.5 * H)]
    assert plan_stops(12 * H) == [Stop("break", 8 * H, 0.5 * H), Stop("rest", 11 * H, 10 * H)]


def test_multi_day_pattern() -> None:
    stops = plan_stops(30 * H)
    # The third shift's break would land on arrival at 30 h, so it is skipped.
    assert [(s.kind, s.at_driving_s / H) for s in stops] == [
        ("break", 8),
        ("rest", 11),
        ("break", 19),
        ("rest", 22),
    ]
    assert total_stop_seconds(stops) == pytest.approx((0.5 + 10 + 0.5 + 10) * H)


def test_elapsed_time_includes_completed_stops_only() -> None:
    stops = plan_stops(12 * H)
    assert elapsed_at(4 * H, stops) == 4 * H
    # Arriving at the break point comes before the break.
    assert elapsed_at(8 * H, stops) == 8 * H
    assert elapsed_at(8 * H + 1, stops) == 8.5 * H + 1
    assert elapsed_at(12 * H, stops) == (12 + 0.5 + 10) * H


def test_custom_policy() -> None:
    policy = HosPolicy(break_after_driving_s=2 * H, max_driving_s=3 * H, rest_duration_s=1 * H)
    stops = plan_stops(7 * H, policy)
    assert [(s.kind, s.at_driving_s / H) for s in stops] == [
        ("break", 2),
        ("rest", 3),
        ("break", 5),
        ("rest", 6),
    ]


def test_policy_without_break_before_rest() -> None:
    policy = HosPolicy(break_after_driving_s=12 * H)  # break would come after the 11 h limit
    assert [s.kind for s in plan_stops(15 * H, policy)] == ["rest"]
