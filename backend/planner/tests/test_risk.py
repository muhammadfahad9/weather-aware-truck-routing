from __future__ import annotations

from typing import Any

import pytest

from planner.domain.risk import (
    LOAD_RULES,
    RAIN_RULE,
    SNOW_RULE,
    WIND_RULE,
    Conditions,
    RiskLevel,
    assess,
    classify_wind,
    rules_payload,
)
from planner.domain.units import round_half_up

from .conftest import load_shared

VECTORS = load_shared("risk_vectors.json")["cases"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_shared_risk_vectors(case: dict[str, Any]) -> None:
    result = assess(
        Conditions(
            wind_mph=case["wind"],
            gust_mph=case["gust"],
            rain_in_hr=case["rain"],
            snow_in_hr=case["snow"],
        ),
        load_lb=case["load"],
        wind_basis=case.get("basis", "sustained"),
    )
    assert result.level == RiskLevel(case["level"])
    assert [f.factor for f in result.drivers] == case["drivers"]
    wind = next(f for f in result.factors if f.factor == "wind")
    assert wind.load_escalated is case.get("load_escalated", False)


@pytest.mark.parametrize(
    ("rule", "table"),
    [
        (
            WIND_RULE,
            [(24.9, 0), (25, 1), (34.9, 1), (35, 2), (44.9, 2), (45, 3), (54.9, 3), (55, 4)],
        ),
        (RAIN_RULE, [(0.09, 0), (0.1, 1), (0.25, 2), (0.5, 3), (1.0, 3), (1.01, 4)]),
        (SNOW_RULE, [(0.49, 0), (0.5, 1), (1.0, 2), (2.0, 3), (3.0, 3), (3.01, 4)]),
    ],
    ids=["wind", "rain", "snow"],
)
def test_each_condition_table_boundary(rule: Any, table: list[tuple[float, int]]) -> None:
    for value, level in table:
        assert rule.classify(value) == RiskLevel(level), (rule.factor, value)


def test_classification_is_monotonic() -> None:
    for load in (0, 30_000, 30_001, 40_000, 40_001, 80_000):
        previous = RiskLevel.LOW
        for tenth in range(800):
            _, level = classify_wind(tenth / 10, load)
            assert level >= previous
            previous = level
    for rule in (RAIN_RULE, SNOW_RULE):
        previous = RiskLevel.LOW
        for hundredth in range(500):
            level = rule.classify(hundredth / 100)
            assert level >= previous
            previous = level


def test_heavier_load_never_lowers_risk() -> None:
    for tenth in range(700):
        levels = [classify_wind(tenth / 10, load)[1] for load in range(0, 80_001, 2_500)]
        assert levels == sorted(levels)


def test_load_rules_match_brief() -> None:
    assert [(r.wind_min_mph, r.wind_max_mph, r.load_over_lb, r.level) for r in LOAD_RULES] == [
        (45.0, 55.0, 30_000, RiskLevel.NO_TRAVEL),
        (35.0, 45.0, 40_000, RiskLevel.SEVERE),
    ]


def test_drivers_empty_when_low() -> None:
    result = assess(Conditions(5, 8, 0, 0), load_lb=0)
    assert result.level is RiskLevel.LOW
    assert result.drivers == ()


def test_factor_values_are_display_rounded() -> None:
    result = assess(Conditions(24.96, 30, 0.095, 0.004), load_lb=0)
    values = {f.factor: f.value for f in result.factors}
    assert values == {"wind": 25.0, "rain": 0.1, "snow": 0.0}


def test_level_labels_and_keys() -> None:
    assert [lvl.label for lvl in RiskLevel] == ["Low", "Moderate", "High", "Severe", "No Travel"]
    assert RiskLevel.NO_TRAVEL.key == "no_travel"


def test_rules_payload_is_complete_and_serializable() -> None:
    payload = rules_payload()
    assert set(payload["conditions"]) == {"wind", "rain", "snow"}
    rain = payload["conditions"]["rain"]["thresholds"]
    assert rain[-1] == {"level": 4, "value": 1.0, "inclusive": False}
    assert payload["load_rules"][0]["load_over_lb"] == 30_000
    assert len(payload["levels"]) == 5


@pytest.mark.parametrize(
    ("value", "digits", "expected"),
    [(0.125, 2, 0.13), (2.5, 0, 3.0), (24.96, 1, 25.0), (0.095, 2, 0.1), (1.004, 2, 1.0)],
)
def test_round_half_up(value: float, digits: int, expected: float) -> None:
    assert round_half_up(value, digits) == pytest.approx(expected)
