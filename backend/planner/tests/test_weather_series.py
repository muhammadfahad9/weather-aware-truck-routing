from __future__ import annotations

from typing import Any

import pytest

from planner.domain.weather import (
    ForecastRangeError,
    HourlySeries,
    ceil_hour,
    clean_series,
    describe_weather_code,
    floor_hour,
)

from .conftest import load_shared

SAMPLING = load_shared("sampling_vectors.json")


def _shared_series() -> HourlySeries:
    s = SAMPLING["series"]
    n = len(s["wind"])
    return HourlySeries(
        start_ts=s["start_ts"],
        wind_mph=tuple(s["wind"]),
        gust_mph=tuple(s["gust"]),
        rain_in=tuple(s["rain"]),
        snow_in=tuple(s["snow"]),
        temperature_f=(None,) * n,
        weather_code=(None,) * n,
    )


@pytest.mark.parametrize("case", SAMPLING["cases"], ids=lambda c: f"t+{c['offset_s']}s")
def test_shared_sampling_vectors(case: dict[str, Any]) -> None:
    series = _shared_series()
    c = series.at(series.start_ts + case["offset_s"])
    assert c.wind_mph == pytest.approx(case["wind"])
    assert c.gust_mph == pytest.approx(case["gust"])
    assert c.rain_in_hr == pytest.approx(case["rain"])
    assert c.snow_in_hr == pytest.approx(case["snow"])


@pytest.mark.parametrize("offset", SAMPLING["out_of_range_offsets_s"])
def test_outside_window_raises(offset: int) -> None:
    series = _shared_series()
    assert not series.covers(series.start_ts + offset)
    with pytest.raises(ForecastRangeError):
        series.at(series.start_ts + offset)


def test_temperature_interpolates_and_tolerates_gaps() -> None:
    series = HourlySeries(
        start_ts=0,
        wind_mph=(0.0, 0.0, 0.0),
        gust_mph=(0.0, 0.0, 0.0),
        rain_in=(0.0, 0.0, 0.0),
        snow_in=(0.0, 0.0, 0.0),
        temperature_f=(30.0, 40.0, None),
        weather_code=(1, 2, 3),
    )
    assert series.at(1800).temperature_f == pytest.approx(35.0)
    assert series.at(5400).temperature_f == pytest.approx(40.0)
    assert series.at(1800).weather_code == 2  # bucket semantics
    assert series.end_ts == 7200 and series.size == 3


def test_series_validates_lengths() -> None:
    with pytest.raises(ValueError, match="equally sized"):
        HourlySeries(0, (1.0,), (1.0, 2.0), (0.0,), (0.0,), (None,), (None,))
    with pytest.raises(ValueError):
        HourlySeries(0, (), (), (), (), (), ())


def test_hour_rounding_helpers() -> None:
    assert floor_hour(7199) == 3600
    assert ceil_hour(3601) == 7200
    assert ceil_hour(3600) == 3600


def test_clean_series_handles_nulls_and_noise() -> None:
    assert clean_series([None, -0.001, 0.2, 3]) == (0.0, 0.0, 0.2, 3.0)


def test_weather_code_descriptions() -> None:
    assert describe_weather_code(75) == "Heavy snowfall"
    assert describe_weather_code(None) is None
    assert describe_weather_code(12) == "Weather code 12"
