from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import pytest
from django.core.cache import cache

from planner.domain.geo import LatLon
from planner.domain.weather import HourlySeries
from planner.services.weather.base import (
    WINDOW_QUANTUM_S,
    WeatherService,
    quantize_window,
    snap,
    snapped_point,
)
from planner.services.weather.simulated import (
    Scenario,
    SimulatedWeatherProvider,
    Storm,
)

from .conftest import flat_series


@dataclass
class CountingProvider:
    name: str = "counting"
    cacheable: bool = True
    calls: list[list[LatLon]] = field(default_factory=list)

    def hourly(self, points: Sequence[LatLon], start_ts: int, end_ts: int) -> list[HourlySeries]:
        self.calls.append(list(points))
        return [flat_series(start_ts, (end_ts - start_ts) // 3600, wind=p[0]) for p in points]


def test_quantize_window_to_six_hours() -> None:
    start, end = quantize_window(WINDOW_QUANTUM_S + 10, 2 * WINDOW_QUANTUM_S + 1)
    assert (start, end) == (WINDOW_QUANTUM_S, 3 * WINDOW_QUANTUM_S)
    assert quantize_window(0, 0) == (0, WINDOW_QUANTUM_S)


def test_snapping_merges_nearby_points() -> None:
    assert snap((35.001, -97.004)) == snap((35.004, -96.999))
    assert snapped_point(snap((35.011, -97.0))) == (35.02, -97.0)


def test_dedupes_and_caches() -> None:
    provider = CountingProvider()
    service = WeatherService(provider, cache)
    points = [(35.0, -97.0), (35.001, -97.001), (36.0, -97.0)]
    lookup = service.lookup(points, 1000, 5000)
    assert len(provider.calls) == 1 and len(provider.calls[0]) == 2
    assert lookup((35.0, -97.0)) is lookup((35.001, -97.001))
    service.lookup(points, 1000, 5000)
    assert len(provider.calls) == 1  # fully cached
    service.lookup([(37.0, -97.0), *points], 1000, 5000)
    assert provider.calls[-1] == [(37.0, -97.0)]  # only the new point is fetched


def test_non_cacheable_provider_bypasses_cache() -> None:
    provider = CountingProvider(cacheable=False)
    service = WeatherService(provider, cache)
    service.lookup([(35.0, -97.0)], 0, 3600)
    service.lookup([(35.0, -97.0)], 0, 3600)
    assert len(provider.calls) == 2


def _storm(**overrides: float) -> Storm:
    base = {
        "lat": 35.0,
        "lon": -97.0,
        "t0": 1_800_000_000,
        "heading_deg": 90.0,
        "speed_mph": 30.0,
        "radius_mi": 50.0,
        "peak_wind_mph": 60.0,
        "peak_rain_in_hr": 1.2,
        "peak_snow_in_hr": 0.0,
    }
    base.update(overrides)
    return Storm(**base)  # type: ignore[arg-type]


def test_storm_moves_and_decays() -> None:
    storm = _storm()
    assert storm.center_at(storm.t0) == pytest.approx((35.0, -97.0))
    east = storm.center_at(storm.t0 + 3600)
    west = storm.center_at(storm.t0 - 3600)
    assert east[1] > -97.0 > west[1]
    assert storm.intensity((35.0, -97.0), storm.t0) == pytest.approx(1.0)
    assert storm.intensity((37.0, -97.0), storm.t0) < 0.01  # ~138 mi = 2.8 radii away


def test_simulated_provider_is_stormy_at_core_and_calm_far_away() -> None:
    storm = _storm()
    provider = SimulatedWeatherProvider(Scenario((storm,)))
    core, far = provider.hourly([(35.0, -97.0), (45.0, -80.0)], storm.t0, storm.t0 + 3600)
    assert core.wind_mph[0] > 55
    assert core.rain_in[1] > 0.5
    assert far.wind_mph[0] < 15 and far.rain_in[0] == 0
    assert core.weather_code[1] in (63, 65)
    assert provider.cacheable is False


def test_scenario_round_trip_and_validation() -> None:
    scenario = Scenario((_storm(),))
    assert Scenario.from_dict(scenario.to_dict()) == scenario
    with pytest.raises(ValueError):
        Scenario.from_dict({"storms": []})
    with pytest.raises(ValueError):
        Scenario.from_dict({"storms": [{**scenario.to_dict()["storms"][0], "radius_mi": 0.1}]})
    with pytest.raises(KeyError):
        Scenario.from_dict({"storms": [{"lat": 1}]})


def test_on_route_scenario_targets_eta_and_uses_snow_when_cold() -> None:
    warm = Scenario.on_route((33.0, -95.0), 1_800_000_000, 600).storms[0]
    cold = Scenario.on_route((42.0, -95.0), 1_800_000_000, 600).storms[0]
    assert warm.t0 == 1_800_000_000 and warm.peak_rain_in_hr > 0 and warm.peak_snow_in_hr == 0
    assert cold.peak_snow_in_hr > 0 and cold.peak_rain_in_hr == 0
    assert 35 <= warm.radius_mi <= 110
