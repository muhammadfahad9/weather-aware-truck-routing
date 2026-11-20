from __future__ import annotations

import pytest

from planner.domain.recommend import (
    RouteScore,
    format_duration,
    recommend,
    summarize_risk,
)
from planner.domain.risk import RiskLevel

H = 3600.0


def score(
    rid: str,
    *,
    no_travel: float = 0,
    severe: float = 0,
    high: float = 0,
    avg: float = 0,
    hours: float = 10,
) -> RouteScore:
    return RouteScore(rid, no_travel, severe, high, avg, hours * H)


def test_summary_is_distance_weighted() -> None:
    s = summarize_risk([(10, RiskLevel.LOW), (20, RiskLevel.HIGH), (10, RiskLevel.NO_TRAVEL)])
    assert s.miles(RiskLevel.HIGH) == 20
    assert s.total_mi == 40
    assert s.avg_risk == pytest.approx((0 * 10 + 2 * 20 + 4 * 10) / 40)
    assert s.max_level is RiskLevel.NO_TRAVEL
    assert s.miles(RiskLevel.SEVERE) == 0


def test_summary_degenerate_and_empty() -> None:
    assert summarize_risk([(0, RiskLevel.SEVERE)]).avg_risk == 3.0
    with pytest.raises(ValueError):
        summarize_risk([])


def test_fewest_severe_miles_beats_faster_route() -> None:
    rec = recommend([score("A", severe=12, hours=9), score("B", severe=0, high=50, hours=12)])
    assert rec.route_id == "B"
    assert rec.deciding_stage is not None
    assert rec.deciding_stage.criterion.key == "severe_mi"
    assert rec.reasons == (
        "Same No Travel exposure; 12 fewer Severe miles than Route A (0 vs 12 mi).",
    )


def test_high_miles_break_severe_tie() -> None:
    rec = recommend([score("A", severe=5, high=30), score("B", severe=5, high=10, hours=14)])
    assert rec.route_id == "B"
    assert rec.deciding_stage.criterion.key == "high_mi"  # type: ignore[union-attr]
    assert "20 fewer High miles" in rec.reasons[0]


def test_average_risk_breaks_mileage_tie() -> None:
    rec = recommend([score("A", avg=0.6), score("B", avg=0.3, hours=11)])
    assert rec.route_id == "B"
    assert rec.deciding_stage.criterion.key == "avg_risk"  # type: ignore[union-attr]
    assert "lower average risk (0.30 vs 0.60)" in rec.reasons[0]


def test_travel_time_is_final_tiebreak() -> None:
    rec = recommend([score("A", hours=12), score("B", hours=10.5)])
    assert rec.route_id == "B"
    assert rec.reasons == ("Equivalent weather risk to Route A, and 1h 30m faster.",)


def test_no_travel_outranks_fewer_severe_miles() -> None:
    rec = recommend([score("A", no_travel=5, severe=0), score("B", no_travel=0, severe=40)])
    assert rec.route_id == "B"
    assert rec.deciding_stage.criterion.key == "no_travel_mi"  # type: ignore[union-attr]


def test_lower_average_risk_wins_even_if_slower() -> None:
    # The brief ranks average risk above travel time, however small the difference.
    rec = recommend([score("A", avg=0.05, hours=8.9), score("B", avg=0.00, hours=9.0)])
    assert rec.route_id == "B"
    assert rec.deciding_stage.criterion.key == "avg_risk"  # type: ignore[union-attr]


def test_average_risk_compared_at_two_decimals() -> None:
    rec = recommend([score("A", avg=0.204, hours=15), score("B", avg=0.196, hours=11)])
    assert rec.route_id == "B"  # both 0.20, so time decides
    stage = next(s for s in rec.stages if s.criterion.key == "avg_risk")
    assert stage.kept == ("A", "B")


def test_ranking_orders_every_route() -> None:
    rec = recommend(
        [
            score("A", avg=0.10, hours=13),
            score("B", avg=0.14, hours=12),
            score("C", avg=0.18, hours=11),
        ]
    )
    assert rec.ranking == ("A", "B", "C")


def test_full_ranking_and_stage_trail() -> None:
    rec = recommend(
        [
            score("A", severe=10, hours=9),
            score("B", severe=0, high=5, hours=10),
            score("C", severe=0, high=5, hours=11),
        ]
    )
    assert rec.ranking == ("B", "C", "A")
    assert [s.criterion.key for s in rec.stages] == [
        "no_travel_mi",
        "severe_mi",
        "high_mi",
        "avg_risk",
        "travel_time_s",
    ]
    assert rec.stages[1].eliminated == ("A",)
    assert rec.stages[-1].kept == ("B",)


def test_miles_compared_at_tenth_of_a_mile() -> None:
    rec = recommend([score("A", severe=10.04, hours=9), score("B", severe=10.0, hours=10)])
    assert rec.route_id == "A"  # 10.04 and 10.0 both compare as 10.0 -> decided by time


def test_complete_tie_keeps_input_order() -> None:
    rec = recommend([score("A"), score("B")])
    assert rec.route_id == "A"
    assert rec.reasons == ("Route A and Route B are effectively tied; Route A is listed first.",)


def test_single_route() -> None:
    rec = recommend([score("A")])
    assert rec.route_id == "A"
    assert rec.stages == ()
    assert rec.deciding_stage is None


def test_empty_input() -> None:
    with pytest.raises(ValueError):
        recommend([])


@pytest.mark.parametrize(
    ("seconds", "text"),
    [(30, "1m"), (59 * 60, "59m"), (3600, "1h"), (3600 + 5 * 60, "1h 05m"), (-7200, "2h")],
)
def test_format_duration(seconds: float, text: str) -> None:
    assert format_duration(seconds) == text


def test_no_deciding_stage_when_winner_only_won_on_order() -> None:
    rec = recommend([score("A"), score("B"), score("C", severe=5)])
    assert rec.route_id == "A"
    assert rec.stages[1].eliminated == ("C",)
    assert rec.deciding_stage is None
