"""Route risk summaries and the recommendation funnel.

Strictly lexicographic, in the brief's order: fewest Severe miles, fewest High miles, lowest
average risk, shortest travel time. No Travel miles come first (not in the brief's list) so an
impassable route can't win on Severe miles. Values compare at display precision: 0.1 mi,
average risk to 2 decimals, time to the minute.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from .risk import RiskLevel
from .units import round_half_up


@dataclass(frozen=True)
class RiskSummary:
    miles_by_level: dict[RiskLevel, float]
    avg_risk: float
    max_level: RiskLevel

    @property
    def total_mi(self) -> float:
        return sum(self.miles_by_level.values())

    def miles(self, level: RiskLevel) -> float:
        return self.miles_by_level.get(level, 0.0)


def summarize_risk(spans: Sequence[tuple[float, RiskLevel]]) -> RiskSummary:
    """Summarize ``(miles, level)`` pairs, one per checkpoint span."""
    if not spans:
        raise ValueError("Cannot summarize a route without checkpoints")
    miles_by_level = dict.fromkeys(RiskLevel, 0.0)
    for miles, level in spans:
        miles_by_level[level] += miles
    total = sum(miles_by_level.values())
    max_level = max(level for _, level in spans)
    if total > 0:
        avg = sum(level.value * mi for level, mi in miles_by_level.items()) / total
    else:  # zero-length route
        avg = float(max_level.value)
    return RiskSummary(miles_by_level=miles_by_level, avg_risk=avg, max_level=max_level)


@dataclass(frozen=True)
class Criterion:
    key: str
    label: str


CRITERIA: tuple[Criterion, ...] = (
    Criterion("no_travel_mi", "No Travel miles"),
    Criterion("severe_mi", "Severe miles"),
    Criterion("high_mi", "High miles"),
    Criterion("avg_risk", "Average risk"),
    Criterion("travel_time_s", "Travel time"),
)


@dataclass(frozen=True)
class RouteScore:
    route_id: str
    no_travel_mi: float
    severe_mi: float
    high_mi: float
    avg_risk: float
    travel_time_s: float

    @classmethod
    def from_summary(cls, route_id: str, summary: RiskSummary, travel_time_s: float) -> RouteScore:
        return cls(
            route_id=route_id,
            no_travel_mi=summary.miles(RiskLevel.NO_TRAVEL),
            severe_mi=summary.miles(RiskLevel.SEVERE),
            high_mi=summary.miles(RiskLevel.HIGH),
            avg_risk=summary.avg_risk,
            travel_time_s=travel_time_s,
        )

    def value(self, key: str) -> float:
        """Criterion value at comparison precision."""
        if key == "avg_risk":
            return round_half_up(self.avg_risk, 2)
        if key == "travel_time_s":
            return round_half_up(self.travel_time_s / 60.0) * 60.0
        raw: float = getattr(self, key)
        return round_half_up(raw, 1)


@dataclass(frozen=True)
class Stage:
    criterion: Criterion
    values: dict[str, float]
    best: float
    kept: tuple[str, ...]
    eliminated: tuple[str, ...]


@dataclass(frozen=True)
class Recommendation:
    route_id: str
    ranking: tuple[str, ...]
    stages: tuple[Stage, ...]
    reasons: tuple[str, ...] = field(default_factory=tuple)

    @property
    def deciding_stage(self) -> Stage | None:
        """The stage that eliminated the last competitor; None if routes tied all the way."""
        if self.stages and len(self.stages[-1].kept) > 1:
            return None
        for stage in reversed(self.stages):
            if stage.eliminated:
                return stage
        return None


def _funnel(candidates: Sequence[RouteScore]) -> tuple[RouteScore, list[Stage]]:
    pool = list(candidates)
    stages: list[Stage] = []
    for criterion in CRITERIA:
        if len(pool) == 1:
            break
        values = {c.route_id: c.value(criterion.key) for c in pool}
        best = min(values.values())
        kept = [c for c in pool if values[c.route_id] <= best + 1e-9]
        stages.append(
            Stage(
                criterion=criterion,
                values=values,
                best=best,
                kept=tuple(c.route_id for c in kept),
                eliminated=tuple(c.route_id for c in pool if c not in kept),
            )
        )
        pool = kept
    # Tied on everything: input order (fastest first) decides.
    return pool[0], stages


def recommend(scores: Sequence[RouteScore]) -> Recommendation:
    if not scores:
        raise ValueError("No routes to rank")
    winner, stages = _funnel(scores)
    # Stable sort: complete ties keep input order (fastest first), same as the funnel.
    ordered = sorted(scores, key=lambda s: tuple(s.value(c.key) for c in CRITERIA))
    ranking = [s.route_id for s in ordered]
    by_id = {s.route_id: s for s in scores}
    reasons = tuple(_pairwise_reason(winner, by_id[other]) for other in ranking[1:])
    return Recommendation(
        route_id=winner.route_id, ranking=tuple(ranking), stages=tuple(stages), reasons=reasons
    )


def _pairwise_reason(winner: RouteScore, other: RouteScore) -> str:
    """Why ``winner`` beats ``other``, based on the first criterion that separates them."""
    w, o = winner.route_id, other.route_id
    for criterion in CRITERIA:
        wv, ov = winner.value(criterion.key), other.value(criterion.key)
        if ov - wv > 1e-9:
            return _describe(criterion, w, o, wv, ov)
    return f"Route {w} and Route {o} are effectively tied; Route {w} is listed first."


_MILES_LEVEL = {"no_travel_mi": "No Travel", "severe_mi": "Severe", "high_mi": "High"}
_TIED_BEFORE = {
    "no_travel_mi": "",
    "severe_mi": "Same No Travel exposure; ",
    "high_mi": "Same No Travel and Severe exposure; ",
}


def _describe(criterion: Criterion, w: str, o: str, wv: float, ov: float) -> str:
    if criterion.key == "travel_time_s":
        return f"Equivalent weather risk to Route {o}, and {format_duration(ov - wv)} faster."
    if criterion.key == "avg_risk":
        return (
            f"Same Severe/High mileage as Route {o}, with lower average risk "
            f"({wv:.2f} vs {ov:.2f})."
        )
    level = _MILES_LEVEL[criterion.key]
    return (
        f"{_TIED_BEFORE[criterion.key]}{_mi(ov - wv)} fewer {level} miles than Route {o} "
        f"({_mi(wv)} vs {_mi(ov)} mi)."
    )


def _mi(miles: float) -> str:
    """``125.0 -> "125"``, ``12.5 -> "12.5"``."""
    return f"{miles:.1f}".removesuffix(".0")


def format_duration(seconds: float) -> str:
    minutes = int(round_half_up(abs(seconds) / 60.0))
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f"{hours}h {mins:02d}m"
    if hours:
        return f"{hours}h"
    return f"{mins}m"
