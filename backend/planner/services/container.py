"""Provider wiring from settings, built once per process."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from django.conf import settings
from django.core.cache import BaseCache, cache

from .geocoding import GazetteerGeocoder, Geocoder, PhotonGeocoder
from .http import HttpClient, MinIntervalLimiter
from .routing.base import RoutingProvider
from .routing.osrm import OsrmProvider
from .routing.simulated import SimulatedRoutingProvider
from .routing.valhalla import ValhallaProvider
from .weather.base import WeatherProvider
from .weather.open_meteo import OpenMeteoProvider
from .weather.simulated import SimulatedWeatherProvider


@dataclass(frozen=True)
class Services:
    routing: RoutingProvider
    routing_fallback: RoutingProvider | None
    weather: WeatherProvider
    geocoder: Geocoder
    cache: BaseCache
    truck_tare_lb: float
    truck_max_speed_mph: float
    heatmap_max_cells: int


@lru_cache(maxsize=1)
def get_services() -> Services:
    cfg = settings.PLANNER
    http = HttpClient(user_agent=cfg["USER_AGENT"], timeout_s=cfg["HTTP_TIMEOUT_S"])
    osm_limiter = MinIntervalLimiter(cfg["ROUTING_MIN_INTERVAL_S"])

    routers: dict[str, RoutingProvider] = {
        "valhalla": ValhallaProvider(http, cfg["VALHALLA_URL"], osm_limiter),
        "osrm": OsrmProvider(
            http, cfg["OSRM_URL"], MinIntervalLimiter(cfg["ROUTING_MIN_INTERVAL_S"])
        ),
        "simulated": SimulatedRoutingProvider(),
    }
    fallback_name = cfg["ROUTING_FALLBACK"]
    weather: WeatherProvider
    if cfg["WEATHER_PROVIDER"] == "simulated":
        weather = SimulatedWeatherProvider()
    else:
        weather = OpenMeteoProvider(http, cfg["OPEN_METEO_URL"], api_key=cfg["OPEN_METEO_API_KEY"])
    geocoder: Geocoder = (
        GazetteerGeocoder()
        if cfg["GEOCODER"] == "gazetteer"
        else PhotonGeocoder(http, cfg["PHOTON_URL"])
    )
    return Services(
        routing=routers[cfg["ROUTING_PROVIDER"]],
        routing_fallback=routers.get(fallback_name) if fallback_name else None,
        weather=weather,
        geocoder=geocoder,
        cache=cache,
        truck_tare_lb=cfg["TRUCK_TARE_LB"],
        truck_max_speed_mph=cfg["TRUCK_MAX_SPEED_MPH"],
        heatmap_max_cells=cfg["HEATMAP_MAX_CELLS"],
    )
