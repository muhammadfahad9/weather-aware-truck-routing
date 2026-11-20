"""Plan a trip: route options, checkpoints, weather risk and a recommendation."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from planner.domain.analysis import (
    RouteAnalysis,
    RoutePlan,
    TripSettings,
    assess_route,
    place_checkpoints,
)
from planner.domain.geo import LatLon
from planner.domain.recommend import Recommendation, RouteScore, recommend
from planner.domain.risk import RiskLevel, WindBasis

from .container import Services
from .errors import ForecastUnavailableError
from .routing.base import Truck
from .routing.options import RouteOptions, find_route_options
from .weather.base import WeatherProvider, WeatherService
from .weather.simulated import Scenario, SimulatedWeatherProvider

WeatherSource = Literal["live", "simulated"]

ROUTE_CACHE_TTL_S = 30 * 60
# Open-Meteo serves 16 days; leave room for the 6-hour window rounding.
FORECAST_HORIZON_S = 15 * 24 * 3600
RELIABLE_FORECAST_S = 7 * 24 * 3600
ROUTE_IDS = "ABCDE"


@dataclass(frozen=True)
class PlanRequest:
    origin: LatLon
    destination: LatLon
    departure: datetime
    load_lb: float
    interval_mi: int
    origin_label: str = ""
    destination_label: str = ""
    hos_enabled: bool = True
    wind_basis: WindBasis = "sustained"
    weather_source: WeatherSource = "live"


@dataclass(frozen=True)
class Notice:
    code: str
    message: str
    severity: Literal["info", "warning", "danger"] = "info"


@dataclass
class PlanResult:
    request: PlanRequest
    analyses: list[RouteAnalysis]
    recommendation: Recommendation
    routing_provider: str
    weather_provider: str
    scenario: Scenario | None
    generated_at: datetime
    notices: list[Notice] = field(default_factory=list)


def plan_trip(req: PlanRequest, services: Services, now: float | None = None) -> PlanResult:
    now = time.time() if now is None else now
    truck = Truck(
        load_lb=req.load_lb,
        tare_lb=services.truck_tare_lb,
        max_speed_mph=services.truck_max_speed_mph,
    )
    options = _route_options(req, truck, services)
    settings = TripSettings(
        departure_ts=req.departure.timestamp(),
        interval_mi=req.interval_mi,
        load_lb=req.load_lb,
        wind_basis=req.wind_basis,
        hos_enabled=req.hos_enabled,
    )
    plans = [
        place_checkpoints(ROUTE_IDS[i], candidate, settings)
        for i, candidate in enumerate(options.routes)
    ]
    latest_arrival = max(p.arrival_ts for p in plans)
    if latest_arrival > now + FORECAST_HORIZON_S:
        raise ForecastUnavailableError(
            "This trip ends beyond the 15-day forecast horizon. Choose an earlier departure."
        )

    provider, scenario = _weather_provider(req, plans, services)
    lookup = WeatherService(provider, services.cache).lookup(
        [cp.point for plan in plans for cp in plan.checkpoints],
        settings.departure_ts,
        latest_arrival,
    )
    analyses = [assess_route(plan, lookup) for plan in plans]
    recommendation = recommend(
        [RouteScore.from_summary(a.plan.route_id, a.summary, a.plan.total_s) for a in analyses]
    )
    notices = [Notice("routing", w, "info") for w in options.warnings]
    notices += _risk_notices(analyses, recommendation, latest_arrival, now)
    return PlanResult(
        request=req,
        analyses=analyses,
        recommendation=recommendation,
        routing_provider=options.provider,
        weather_provider=provider.name,
        scenario=scenario,
        generated_at=datetime.fromtimestamp(now, tz=timezone.utc),
        notices=notices,
    )


def _route_options(req: PlanRequest, truck: Truck, services: Services) -> RouteOptions:
    key = "routes:{}:{:.4f},{:.4f}:{:.4f},{:.4f}:{}".format(
        services.routing.name, *req.origin, *req.destination, round(truck.gross_lb / 1000)
    )
    cached = services.cache.get(key)
    if isinstance(cached, RouteOptions):
        return cached
    options = find_route_options(
        services.routing, services.routing_fallback, req.origin, req.destination, truck
    )
    services.cache.set(key, options, ROUTE_CACHE_TTL_S)
    return options


def _weather_provider(
    req: PlanRequest, plans: list[RoutePlan], services: Services
) -> tuple[WeatherProvider, Scenario | None]:
    if req.weather_source != "simulated" and services.weather.name != "simulated":
        return services.weather, None
    # Park the storm ~55% along the fastest route at the truck's ETA, so the recommendation
    # has to trade risk against time.
    fastest = plans[0]
    target = 0.55 * fastest.candidate.path.total_mi
    cp = min(fastest.checkpoints, key=lambda c: abs(c.span.mile - target))
    scenario = Scenario.on_route(cp.point, cp.eta_ts, fastest.candidate.path.total_mi)
    return SimulatedWeatherProvider(scenario), scenario


def _risk_notices(
    analyses: list[RouteAnalysis], rec: Recommendation, latest_arrival: float, now: float
) -> list[Notice]:
    notices: list[Notice] = []
    best = next(a for a in analyses if a.plan.route_id == rec.route_id)
    if all(a.summary.miles(RiskLevel.NO_TRAVEL) > 0 for a in analyses):
        notices.append(
            Notice(
                "no_travel_all_routes",
                "Every route crosses No Travel conditions at the planned time. "
                "Delaying departure is strongly advised.",
                "danger",
            )
        )
    elif best.summary.miles(RiskLevel.SEVERE) > 0:
        notices.append(
            Notice(
                "severe_on_recommended",
                f"Even the recommended route has {best.summary.miles(RiskLevel.SEVERE):.0f} mi "
                "of Severe conditions. Consider a later departure.",
                "warning",
            )
        )
    if latest_arrival > now + RELIABLE_FORECAST_S:
        notices.append(
            Notice(
                "forecast_confidence",
                "Part of this trip is more than 7 days out; forecast confidence is lower.",
                "info",
            )
        )
    return notices
