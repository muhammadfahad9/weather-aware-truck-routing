"""Weather risk rules from the assessment brief.

Band lower bounds are inclusive (35.0 mph wind is High, 0.25 in/hr rain is High). The brief's
No Travel cells for rain (> 1.00) and snow (> 3.0) are exclusive, so 1.00 in/hr rain is still
Severe. Values are classified at display precision (0.1 mph, 0.01 in/hr). A checkpoint's
level is the worst factor after the load rules have escalated wind.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Any, Literal

from .units import round_half_up

WindBasis = Literal["sustained", "gust"]


class RiskLevel(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def label(self) -> str:
        return _LABELS[self]

    @property
    def key(self) -> str:
        return self.name.lower()


_LABELS = {
    RiskLevel.LOW: "Low",
    RiskLevel.MODERATE: "Moderate",
    RiskLevel.HIGH: "High",
    RiskLevel.SEVERE: "Severe",
    RiskLevel.NO_TRAVEL: "No Travel",
}


@dataclass(frozen=True)
class Threshold:
    level: RiskLevel
    value: float
    inclusive: bool

    def matches(self, x: float) -> bool:
        return x >= self.value if self.inclusive else x > self.value


@dataclass(frozen=True)
class ConditionRule:
    factor: str
    unit: str
    precision: int
    thresholds: tuple[Threshold, ...]

    def normalize(self, value: float) -> float:
        return round_half_up(max(value, 0.0), self.precision)

    def classify(self, value: float) -> RiskLevel:
        v = self.normalize(value)
        level = RiskLevel.LOW
        for threshold in self.thresholds:
            if threshold.matches(v):
                level = threshold.level
        return level


@dataclass(frozen=True)
class LoadRule:
    """Escalate wind risk to ``level`` when ``wind_min <= wind < wind_max`` and load > limit."""

    wind_min_mph: float
    wind_max_mph: float
    load_over_lb: float
    level: RiskLevel

    def applies(self, wind_mph: float, load_lb: float) -> bool:
        return self.wind_min_mph <= wind_mph < self.wind_max_mph and load_lb > self.load_over_lb


WIND_RULE = ConditionRule(
    factor="wind",
    unit="mph",
    precision=1,
    thresholds=(
        Threshold(RiskLevel.MODERATE, 25.0, inclusive=True),
        Threshold(RiskLevel.HIGH, 35.0, inclusive=True),
        Threshold(RiskLevel.SEVERE, 45.0, inclusive=True),
        Threshold(RiskLevel.NO_TRAVEL, 55.0, inclusive=True),
    ),
)

RAIN_RULE = ConditionRule(
    factor="rain",
    unit="in/hr",
    precision=2,
    thresholds=(
        Threshold(RiskLevel.MODERATE, 0.10, inclusive=True),
        Threshold(RiskLevel.HIGH, 0.25, inclusive=True),
        Threshold(RiskLevel.SEVERE, 0.50, inclusive=True),
        Threshold(RiskLevel.NO_TRAVEL, 1.00, inclusive=False),
    ),
)

SNOW_RULE = ConditionRule(
    factor="snow",
    unit="in/hr",
    precision=2,
    thresholds=(
        Threshold(RiskLevel.MODERATE, 0.5, inclusive=True),
        Threshold(RiskLevel.HIGH, 1.0, inclusive=True),
        Threshold(RiskLevel.SEVERE, 2.0, inclusive=True),
        Threshold(RiskLevel.NO_TRAVEL, 3.0, inclusive=False),
    ),
)

# >= 55 mph is No Travel for any load via WIND_RULE.
LOAD_RULES = (
    LoadRule(wind_min_mph=45.0, wind_max_mph=55.0, load_over_lb=30_000, level=RiskLevel.NO_TRAVEL),
    LoadRule(wind_min_mph=35.0, wind_max_mph=45.0, load_over_lb=40_000, level=RiskLevel.SEVERE),
)


@dataclass(frozen=True)
class Conditions:
    """Weather at one place and time; precipitation is in inches per hour."""

    wind_mph: float
    gust_mph: float
    rain_in_hr: float
    snow_in_hr: float
    temperature_f: float | None = None
    weather_code: int | None = None


@dataclass(frozen=True)
class FactorAssessment:
    factor: str
    value: float
    unit: str
    base_level: RiskLevel
    level: RiskLevel

    @property
    def load_escalated(self) -> bool:
        return self.level > self.base_level


@dataclass(frozen=True)
class RiskAssessment:
    level: RiskLevel
    factors: tuple[FactorAssessment, ...]

    @property
    def drivers(self) -> tuple[FactorAssessment, ...]:
        """Factors responsible for the overall level (empty when everything is Low)."""
        if self.level == RiskLevel.LOW:
            return ()
        return tuple(f for f in self.factors if f.level == self.level)


def classify_wind(wind_mph: float, load_lb: float) -> tuple[RiskLevel, RiskLevel]:
    """Return ``(base_level, load_adjusted_level)`` for a wind speed and load weight."""
    wind = WIND_RULE.normalize(wind_mph)
    base = WIND_RULE.classify(wind)
    adjusted = base
    for rule in LOAD_RULES:
        if rule.applies(wind, load_lb):
            adjusted = max(adjusted, rule.level)
    return base, adjusted


def assess(
    conditions: Conditions, load_lb: float, wind_basis: WindBasis = "sustained"
) -> RiskAssessment:
    wind_value = conditions.gust_mph if wind_basis == "gust" else conditions.wind_mph
    wind_base, wind_level = classify_wind(wind_value, load_lb)
    factors = (
        FactorAssessment(
            factor="wind",
            value=WIND_RULE.normalize(wind_value),
            unit=WIND_RULE.unit,
            base_level=wind_base,
            level=wind_level,
        ),
        _simple_factor(RAIN_RULE, conditions.rain_in_hr),
        _simple_factor(SNOW_RULE, conditions.snow_in_hr),
    )
    return RiskAssessment(level=max(f.level for f in factors), factors=factors)


def _simple_factor(rule: ConditionRule, value: float) -> FactorAssessment:
    level = rule.classify(value)
    return FactorAssessment(
        factor=rule.factor,
        value=rule.normalize(value),
        unit=rule.unit,
        base_level=level,
        level=level,
    )


def rules_payload() -> dict[str, Any]:
    """The rules as JSON, so the frontend heatmap classifies the same way."""

    def rule(r: ConditionRule) -> dict[str, Any]:
        return {
            "unit": r.unit,
            "precision": r.precision,
            "thresholds": [
                {"level": t.level.value, "value": t.value, "inclusive": t.inclusive}
                for t in r.thresholds
            ],
        }

    return {
        "levels": [{"level": lvl.value, "key": lvl.key, "label": lvl.label} for lvl in RiskLevel],
        "conditions": {"wind": rule(WIND_RULE), "rain": rule(RAIN_RULE), "snow": rule(SNOW_RULE)},
        "load_rules": [
            {
                "wind_min_mph": r.wind_min_mph,
                "wind_max_mph": r.wind_max_mph,
                "load_over_lb": r.load_over_lb,
                "level": r.level.value,
            }
            for r in LOAD_RULES
        ],
    }
