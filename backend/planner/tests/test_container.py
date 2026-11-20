from __future__ import annotations

from typing import Any

from planner.services.container import get_services


def test_default_wiring_uses_real_providers() -> None:
    services = get_services()
    assert services.routing.name == "valhalla"
    assert services.routing_fallback is not None
    assert services.routing_fallback.name == "osrm"
    assert services.weather.name == "open-meteo"
    assert services.geocoder.name == "photon"
    assert services.truck_max_speed_mph == 65
    assert get_services() is services  # built once per process


def test_offline_wiring(settings: Any) -> None:
    settings.PLANNER = {
        **settings.PLANNER,
        "ROUTING_PROVIDER": "simulated",
        "ROUTING_FALLBACK": "",
        "WEATHER_PROVIDER": "simulated",
        "GEOCODER": "gazetteer",
    }
    get_services.cache_clear()
    services = get_services()
    assert services.routing.name == "simulated"
    assert services.routing_fallback is None
    assert services.weather.name == "simulated"
    assert services.geocoder.name == "gazetteer"
