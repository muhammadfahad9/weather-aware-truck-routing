"""Provider adapters against recorded real responses (no network)."""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urlparse

import pytest
import requests
import responses

from planner.services.errors import RouteNotFoundError, UpstreamError, UpstreamRateLimitedError
from planner.services.geocoding import GazetteerGeocoder, PhotonGeocoder
from planner.services.http import HttpClient, MinIntervalLimiter
from planner.services.routing.base import Truck, normalize_road_name, principal_roads
from planner.services.routing.osrm import OsrmProvider
from planner.services.routing.valhalla import ValhallaProvider
from planner.services.weather.open_meteo import OpenMeteoProvider, parse_hourly

from .conftest import load_fixture

DALLAS = (32.7767, -96.7970)
FORT_WORTH = (32.7555, -97.3308)
TRUCK = Truck(load_lb=35_000)
OSRM_ANY = re.compile(r"https://osrm\.test/.*")


@pytest.fixture
def http() -> HttpClient:
    return HttpClient(user_agent="test-agent", timeout_s=5, retries=0)


def _no_wait() -> MinIntervalLimiter:
    return MinIntervalLimiter(0)


# --- Valhalla -------------------------------------------------------------------------


@responses.activate
def test_valhalla_parses_main_and_alternates(http: HttpClient) -> None:
    responses.post(
        "https://valhalla.test/route", json=load_fixture("valhalla_dallas_fortworth.json")
    )
    routes = ValhallaProvider(http, "https://valhalla.test", _no_wait()).routes(
        DALLAS, FORT_WORTH, TRUCK, alternates=2
    )
    assert len(routes) == 3
    for r in routes:
        assert r.provider == "valhalla"
        assert 28 < r.path.total_mi < 40
        assert r.path.points[0] == pytest.approx(DALLAS, abs=0.01)
        assert r.path.points[-1] == pytest.approx(FORT_WORTH, abs=0.01)
        # Never faster than the 65 mph governor.
        assert r.path.total_drive_s >= r.path.total_mi / 65 * 3600 - 1
        assert r.via
    sent = json.loads(responses.calls[0].request.body)
    assert sent["costing"] == "truck"
    assert sent["alternates"] == 2
    assert sent["costing_options"]["truck"]["weight"] == pytest.approx(
        70_000 / 2204.62262, abs=0.01
    )
    assert sent["costing_options"]["truck"]["top_speed"] == 105
    assert "date_time" not in sent  # time-dependent requests cannot return alternates


@responses.activate
def test_valhalla_via_route_uses_through_location(http: HttpClient) -> None:
    fixture = load_fixture("valhalla_dallas_fortworth.json")
    responses.post("https://valhalla.test/route", json={"trip": fixture["trip"]})
    route = ValhallaProvider(http, "https://valhalla.test", _no_wait()).via_route(
        DALLAS, (33.0, -97.0), FORT_WORTH, TRUCK
    )
    assert route.note == "synthesized"
    via = json.loads(responses.calls[0].request.body)["locations"][1]
    assert via["type"] == "through"
    assert via["search_filter"] == {"min_road_class": "primary"}


@pytest.mark.parametrize("fixture", ["valhalla_no_route.json"])
@responses.activate
def test_valhalla_no_route_codes(http: HttpClient, fixture: str) -> None:
    responses.post("https://valhalla.test/route", json=load_fixture(fixture), status=400)
    with pytest.raises(RouteNotFoundError):
        ValhallaProvider(http, "https://valhalla.test", _no_wait()).routes(
            DALLAS, FORT_WORTH, TRUCK, 2
        )


@responses.activate
def test_valhalla_distance_limit_is_upstream_error_not_no_route(http: HttpClient) -> None:
    responses.post(
        "https://valhalla.test/route", json=load_fixture("valhalla_distance_limit.json"), status=400
    )
    with pytest.raises(UpstreamError) as info:
        ValhallaProvider(http, "https://valhalla.test", _no_wait()).routes(
            DALLAS, FORT_WORTH, TRUCK, 2
        )
    assert not isinstance(info.value, RouteNotFoundError)
    assert "max distance" in info.value.message


@responses.activate
def test_valhalla_unexpected_payload(http: HttpClient) -> None:
    responses.post("https://valhalla.test/route", json={"hello": "world"})
    with pytest.raises(UpstreamError, match="Unexpected"):
        ValhallaProvider(http, "https://valhalla.test", _no_wait()).routes(
            DALLAS, FORT_WORTH, TRUCK, 2
        )


@responses.activate
def test_valhalla_without_maneuvers_uses_summary_time(http: HttpClient) -> None:
    trip = load_fixture("valhalla_dallas_fortworth.json")["trip"]
    for leg in trip["legs"]:
        leg.pop("maneuvers", None)
    responses.post("https://valhalla.test/route", json={"trip": trip})
    route = ValhallaProvider(http, "https://valhalla.test", _no_wait()).routes(
        DALLAS, FORT_WORTH, TRUCK, 0
    )[0]
    assert route.path.total_drive_s >= trip["summary"]["time"] - 1


# --- OSRM ----------------------------------------------------------------------------


@responses.activate
def test_osrm_parses_routes_and_caps_speed(http: HttpClient) -> None:
    responses.get(
        "https://osrm.test/route/v1/driving/-96.797000,32.776700;-97.330800,32.755500",
        json=load_fixture("osrm_dallas_fortworth.json"),
    )
    routes = OsrmProvider(http, "https://osrm.test", _no_wait()).routes(
        DALLAS, FORT_WORTH, Truck(load_lb=0, max_speed_mph=55), alternates=2
    )
    assert len(routes) == 2
    for r in routes:
        assert r.provider == "osrm"
        assert r.path.total_drive_s >= r.path.total_mi / 55 * 3600 - 1
    query = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert query["geometries"] == ["polyline6"] and query["alternatives"] == ["2"]


@responses.activate
def test_osrm_via_and_errors(http: HttpClient) -> None:
    fixture = load_fixture("osrm_dallas_fortworth.json")
    for leg in fixture["routes"][0]["legs"]:
        leg.pop("annotation", None)  # exercise the distance-based fallback
    responses.get(url=OSRM_ANY, json=fixture)
    provider = OsrmProvider(http, "https://osrm.test", _no_wait())
    route = provider.via_route(DALLAS, (32.9, -97.0), FORT_WORTH, TRUCK)
    assert route.note == "synthesized"
    assert "continue_straight=true" in responses.calls[0].request.url

    responses.replace(responses.GET, OSRM_ANY, json={"code": "NoRoute", "routes": []})
    with pytest.raises(RouteNotFoundError):
        provider.routes(DALLAS, FORT_WORTH, TRUCK, 1)
    responses.replace(responses.GET, OSRM_ANY, json={"code": "InvalidQuery", "routes": [{}]})
    with pytest.raises(UpstreamError, match="InvalidQuery"):
        provider.routes(DALLAS, FORT_WORTH, TRUCK, 1)
    responses.replace(responses.GET, OSRM_ANY, json={"code": "InvalidUrl"}, status=400)
    with pytest.raises(RouteNotFoundError):
        provider.routes(DALLAS, FORT_WORTH, TRUCK, 1)


def test_road_name_normalization() -> None:
    assert normalize_road_name("I 57 North") == "I-57"
    assert normalize_road_name("US 67") == "US-67"
    assert normalize_road_name("TX 121 SB") == "TX-121"
    assert normalize_road_name("Main Street") == "Main Street"
    assert principal_roads(
        [("Main Street", 50), ("I 30 East", 20), ("I 30", 5), ("US 67", 30)]
    ) == [
        "US-67",
        "I-30",
    ]


# --- Open-Meteo --------------------------------------------------------------------------


@responses.activate
def test_open_meteo_batches_parse_and_units(http: HttpClient) -> None:
    fixture = load_fixture("open_meteo_two_points.json")
    responses.get("https://om.test/v1/forecast", json=fixture)
    provider = OpenMeteoProvider(http, "https://om.test")
    start = fixture[0]["hourly"]["time"][0]
    end = fixture[0]["hourly"]["time"][-1]
    series = provider.hourly([(32.78, -96.80), (32.76, -97.34)], start, end)
    assert len(series) == 2
    assert series[0].start_ts == start
    q = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert q["wind_speed_unit"] == ["mph"]
    assert q["precipitation_unit"] == ["inch"]
    assert q["timezone"] == ["GMT"] and q["timeformat"] == ["unixtime"]
    assert q["latitude"] == ["32.7800,32.7600"]
    assert len(q["hourly"][0].split(",")) <= 10  # keep quota weight <= 1 per location
    raw = fixture[0]["hourly"]
    assert series[0].rain_in[3] == pytest.approx(raw["rain"][3] + raw["showers"][3])


@responses.activate
def test_open_meteo_splits_large_requests(http: HttpClient) -> None:
    fixture = load_fixture("open_meteo_two_points.json")
    responses.get("https://om.test/v1/forecast", json=fixture)
    provider = OpenMeteoProvider(http, "https://om.test", batch_size=2, api_key="secret")
    start = fixture[0]["hourly"]["time"][0]
    end = fixture[0]["hourly"]["time"][-1]
    series = provider.hourly([(32.0, -96.0)] * 6, start, end)
    assert len(series) == 6
    assert len(responses.calls) == 3
    assert "apikey=secret" in responses.calls[0].request.url
    assert provider.hourly([], start, end) == []


@responses.activate
def test_open_meteo_error_reason_is_surfaced(http: HttpClient) -> None:
    responses.get(
        "https://om.test/v1/forecast", json=load_fixture("open_meteo_error.json"), status=400
    )
    with pytest.raises(UpstreamError, match="Latitude must be in range"):
        OpenMeteoProvider(http, "https://om.test").hourly([(1.0, 1.0)], 0, 3600)


@responses.activate
def test_open_meteo_count_mismatch(http: HttpClient) -> None:
    responses.get("https://om.test/v1/forecast", json=load_fixture("open_meteo_two_points.json"))
    with pytest.raises(UpstreamError, match="Expected 3"):
        OpenMeteoProvider(http, "https://om.test").hourly([(1.0, 1.0)] * 3, 0, 3600)


def test_parse_hourly_validates_window_and_shape() -> None:
    item = load_fixture("open_meteo_two_points.json")[0]
    times = item["hourly"]["time"]
    with pytest.raises(UpstreamError, match="cover"):
        parse_hourly(item, times[0] - 3600, times[-1])
    broken = json.loads(json.dumps(item))
    broken["hourly"]["time"][1] += 60
    with pytest.raises(UpstreamError, match="hourly"):
        parse_hourly(broken, times[0], times[-1])
    with pytest.raises(UpstreamError, match="Malformed"):
        parse_hourly({"hourly": {"time": times}}, times[0], times[-1])


def test_parse_hourly_single_location_object_and_nulls() -> None:
    item = load_fixture("open_meteo_two_points.json")[0]
    item["hourly"]["wind_gusts_10m"][0] = None
    item["hourly"].pop("showers")
    times = item["hourly"]["time"]
    series = parse_hourly(item, times[0], times[-1])
    assert series.gust_mph[0] == 0.0
    assert series.rain_in == tuple(max(r, 0.0) for r in item["hourly"]["rain"])


# --- HTTP client ----------------------------------------------------------------------------


@responses.activate
def test_http_rate_limit_and_errors(http: HttpClient) -> None:
    responses.get("https://x.test/a", status=429)
    with pytest.raises(UpstreamRateLimitedError):
        http.get_json("https://x.test/a", provider="x")
    responses.get("https://x.test/b", body="not json")
    with pytest.raises(UpstreamError, match="invalid response"):
        http.get_json("https://x.test/b", provider="x")
    responses.get("https://x.test/c", status=503, body="down")
    with pytest.raises(UpstreamError, match="HTTP 503"):
        http.get_json("https://x.test/c", provider="x")
    responses.get("https://x.test/d", body=requests.ConnectionError("boom"))
    with pytest.raises(UpstreamError, match="unreachable"):
        http.get_json("https://x.test/d", provider="x")
    responses.get("https://x.test/e", body=requests.Timeout("slow"))
    with pytest.raises(UpstreamError, match="timed out"):
        http.get_json("https://x.test/e", provider="x")


def test_min_interval_limiter_spaces_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 100.0}
    slept: list[float] = []
    monkeypatch.setattr("planner.services.http.time.monotonic", lambda: clock["now"])
    monkeypatch.setattr("planner.services.http.time.sleep", slept.append)
    limiter = MinIntervalLimiter(1.0)
    limiter.wait()
    limiter.wait()
    limiter.wait()
    assert slept == [1.0, 2.0]
    MinIntervalLimiter(0).wait()


# --- Geocoding -----------------------------------------------------------------------------


@responses.activate
def test_photon_places(http: HttpClient) -> None:
    responses.get("https://photon.test/api/", json=load_fixture("photon_dallas.json"))
    places = PhotonGeocoder(http, "https://photon.test").search("dallas", 3, near=(32.0, -97.0))
    assert 1 <= len(places) <= 3
    assert places[0].name == "Dallas"
    assert "USA" in places[0].label
    assert len({p.label for p in places}) == len(places)
    q = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert q["lat"] == ["32.0"] and q["lang"] == ["en"]


@responses.activate
def test_photon_skips_unusable_features(http: HttpClient) -> None:
    responses.get(
        "https://photon.test/api/",
        json={
            "features": [
                {"properties": {"name": "No geometry"}},
                {"geometry": {"coordinates": [1, 2]}, "properties": {}},
                {
                    "geometry": {"coordinates": [-96.8, 32.8]},
                    "properties": {"housenumber": "100", "street": "Main St", "city": "Dallas"},
                },
            ]
        },
    )
    places = PhotonGeocoder(http, "https://photon.test").search("main", 5)
    assert [p.label for p in places] == ["100 Main St, Dallas"]


def test_gazetteer_prefix_search() -> None:
    hits = GazetteerGeocoder().search("chi", 5)
    assert [h.name for h in hits] == ["Chicago"]
    assert GazetteerGeocoder().search("zzz", 5) == []
