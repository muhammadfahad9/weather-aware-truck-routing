from __future__ import annotations

from planner.api.presenters import _minutes, present_checkpoint
from planner.domain.analysis import AssessedCheckpoint, PlannedCheckpoint
from planner.domain.checkpoints import CheckpointSpan
from planner.domain.risk import Conditions, RiskLevel, assess


def _checkpoint(conditions: Conditions) -> AssessedCheckpoint:
    planned = PlannedCheckpoint(
        index=0,
        span=CheckpointSpan(0, 0, 5),
        point=(35.0, -97.0),
        drive_s=0,
        elapsed_s=0,
        eta_ts=1_800_000_000,
    )
    return AssessedCheckpoint(planned, conditions, assess(conditions, load_lb=0))


def test_displayed_conditions_match_the_classification() -> None:
    # Python's round() would show 0.24 / 0.49 / 24.9 next to High / Moderate / Moderate.
    cases = [
        (Conditions(5, 8, 0.245, 0), "rain_in_hr", 0.25, RiskLevel.HIGH),
        (Conditions(5, 8, 0, 0.495), "snow_in_hr", 0.5, RiskLevel.MODERATE),
        (Conditions(24.96, 30, 0, 0), "wind_mph", 25.0, RiskLevel.MODERATE),
    ]
    for conditions, field, shown, level in cases:
        out = present_checkpoint(_checkpoint(conditions), 1_800_000_000)
        assert out["conditions"][field] == shown
        assert out["risk"]["level"] == level


def test_times_presented_in_whole_minutes() -> None:
    assert _minutes(3629.6) == 3600
    assert _minutes(3630) == 3660
