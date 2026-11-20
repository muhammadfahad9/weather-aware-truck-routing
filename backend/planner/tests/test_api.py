"""HTTP contract tests (offline providers)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from django.test import RequestFactory
from django.utils import timezone
from rest_framework.test import APIClient

from planner.api.views import spa_index
from planner.services.container import Services
from planner.services.errors import RouteNotFoundError, UpstreamError, UpstreamRateLimitedError


@pytest.fixture
def client(offline_services: Services, monkeypatch: pytest.MonkeyPatch) -> APIClient:
    monkeypatch.setattr("planner.api.views.get_services", lambda: offline_services)
    return APIClient()


def plan_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "origin": {"lat": 32.7767, "lon": -96.797, "label": "Dallas, TX"},
        "destination": {"lat": 41.8781, "lon": -87.6298, "label": "Chicago, IL"},
        "departure_time": (timezone.now() + timedelta(minutes=5)).isoformat(),
        "load_weight_lb": 42000,
        "interval_miles": 25,
    }
    body.update(overrides)
    return body


def test_health_and_rules(client: APIClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}
    rules = client.get("/api/rules").json()
    assert rules["conditions"]["wind"]["thresholds"][-1]["value"] == 55.0


def test_plan_contract(client: APIClient) -> None:
    res = client.post("/api/plan", plan_body(), format="json")
    assert res.status_code == 200, res.content
    data = res.json()
    assert set(data) == {
        "generated_at",
        "inputs",
        "rules",
        "routing",
        "weather",
        "routes",
        "recommendation",
        "notices",
    }
    assert data["inputs"]["origin"]["label"] == "Dallas, TX"
    assert data["inputs"]["hos_breaks"] is True and data["inputs"]["wind_basis"] == "sustained"
    assert len(data["routes"]) == 3
    rec_id = data["recommendation"]["route_id"]
    assert sum(r["recommended"] for r in data["routes"]) == 1
    assert next(r for r in data["routes"] if r["recommended"])["id"] == rec_id
    route = data["routes"][0]
    path = route["path"]
    assert len(path["coordinates"]) == len(path["miles"]) == len(path["elapsed_s"])
    assert route["total_time_s"] % 60 == 0  # whole minutes, the ranking precision
    assert abs(path["elapsed_s"][-1] - route["total_time_s"]) <= 30
    assert route["risk"]["avg_risk"] == round(route["risk"]["avg_risk"], 2)
    assert sum(route["risk"]["miles_by_level"].values()) == pytest.approx(
        route["distance_mi"], abs=0.3
    )
    cp = route["checkpoints"][1]
    assert cp["mile"] == 25
    assert cp["eta"].endswith("Z")
    assert set(cp["conditions"]) >= {"wind_mph", "gust_mph", "rain_in_hr", "snow_in_hr", "summary"}
    assert cp["risk"]["label"] in {"Low", "Moderate", "High", "Severe", "No Travel"}
    assert {f["factor"] for f in cp["risk"]["factors"]} == {"wind", "rain", "snow"}
    assert data["weather"]["simulated"] is True
    assert data["weather"]["scenario"]["storms"]


def test_plan_interval_controls_checkpoint_spacing(client: APIClient) -> None:
    for interval in (10, 25, 50):
        data = client.post("/api/plan", plan_body(interval_miles=interval), format="json").json()
        miles = [c["mile"] for c in data["routes"][0]["checkpoints"]]
        assert miles[1] - miles[0] == interval


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"load_weight_lb": -1}, "load_weight_lb"),
        ({"load_weight_lb": 90000}, "load_weight_lb"),
        ({"interval_miles": 15}, "interval_miles"),
        ({"origin": {"lat": 100, "lon": 0}}, "origin"),
        ({"destination": {"lat": 32.7767, "lon": -96.797}}, "destination"),
        ({"departure_time": "2001-01-01T00:00:00Z"}, "departure_time"),
        ({"departure_time": "not a date"}, "departure_time"),
        ({"wind_basis": "average"}, "wind_basis"),
    ],
)
def test_plan_validation_errors(client: APIClient, overrides: dict[str, Any], field: str) -> None:
    res = client.post("/api/plan", plan_body(**overrides), format="json")
    assert res.status_code == 400
    error = res.json()["error"]
    assert error["code"] == "invalid_request"
    assert field in error["fields"]
    assert error["message"].startswith(field)


def test_departure_too_far_ahead(client: APIClient) -> None:
    body = plan_body(departure_time=(timezone.now() + timedelta(days=8)).isoformat())
    res = client.post("/api/plan", body, format="json")
    assert res.status_code == 400
    assert "7 days" in res.json()["error"]["message"]


def test_missing_body_fields(client: APIClient) -> None:
    res = client.post("/api/plan", {}, format="json")
    assert res.status_code == 400
    assert set(res.json()["error"]["fields"]) >= {"origin", "destination", "departure_time"}


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (RouteNotFoundError("No truck route", provider="valhalla"), 422, "no_route"),
        (UpstreamError("down", provider="open-meteo"), 502, "upstream_unavailable"),
        (
            UpstreamRateLimitedError("slow down", provider="open-meteo"),
            503,
            "upstream_rate_limited",
        ),
    ],
)
def test_service_errors_map_to_envelope(
    client: APIClient, monkeypatch: pytest.MonkeyPatch, exc: Exception, status: int, code: str
) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise exc

    monkeypatch.setattr("planner.api.views.plan_trip", boom)
    res = client.post("/api/plan", plan_body(), format="json")
    assert res.status_code == status
    assert res.json()["error"]["code"] == code


def test_unexpected_error_is_500_envelope(
    client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("bug")

    monkeypatch.setattr("planner.api.views.plan_trip", boom)
    res = client.post("/api/plan", plan_body(), format="json")
    assert res.status_code == 500
    assert res.json()["error"]["code"] == "internal_error"


def test_method_not_allowed_uses_envelope(client: APIClient) -> None:
    res = client.get("/api/plan")
    assert res.status_code == 405
    assert res.json()["error"]["code"] == "method_not_allowed"


def test_heatmap_contract(client: APIClient) -> None:
    plan = client.post("/api/plan", plan_body(), format="json").json()
    body = {
        "routes": [r["path"]["coordinates"][::5] for r in plan["routes"]],
        "departure_time": plan["inputs"]["departure_time"],
        "scenario": plan["weather"]["scenario"],
    }
    res = client.post("/api/heatmap", body, format="json")
    assert res.status_code == 200, res.content
    data = res.json()
    n = len(data["cells"])
    assert data["frames"] in (49, 50)
    for name in ("wind", "gust", "rain", "snow"):
        assert len(data["fields"][name]) == n * data["frames"]
    grid = data["grid"]
    assert all(0 <= c < grid["nx"] * grid["ny"] for c in data["cells"])
    assert data["simulated"] is True


@pytest.mark.parametrize(
    "routes",
    [
        [],
        [[[0, 0]]],
        [[[0, 0], [1]]],
        [[[0, 0], [200, 0]]],
        [[[True, 0], [1, 1]]],
        "x",
        [[[0, 0]] * 2001],
    ],
)
def test_heatmap_rejects_bad_geometry(client: APIClient, routes: Any) -> None:
    body = {"routes": routes, "departure_time": timezone.now().isoformat()}
    res = client.post("/api/heatmap", body, format="json")
    assert res.status_code == 400
    assert "routes" in res.json()["error"]["fields"]


def test_heatmap_rejects_bad_scenario(client: APIClient) -> None:
    for scenario in ("storm", {"storms": []}, {"storms": [{"lat": 1}]}):
        body = {
            "routes": [[[-97, 32], [-96, 33]]],
            "departure_time": timezone.now().isoformat(),
            "scenario": scenario,
        }
        res = client.post("/api/heatmap", body, format="json")
        assert res.status_code == 400
        assert "scenario" in res.json()["error"]["fields"]


def test_geocode(client: APIClient) -> None:
    res = client.get("/api/geocode", {"q": "Dal", "limit": 3})
    assert res.status_code == 200
    results = res.json()["results"]
    assert results[0]["name"] == "Dallas"
    assert {"label", "lat", "lon", "context", "kind"} <= set(results[0])
    assert client.get("/api/geocode", {"q": "Dal", "limit": 3}).json()["results"] == results


def test_geocode_validation(client: APIClient) -> None:
    assert client.get("/api/geocode", {"q": "D"}).status_code == 400
    assert client.get("/api/geocode", {"q": "Dallas", "limit": 50}).status_code == 400


def test_spa_index_fallback(settings: Any, tmp_path: Any) -> None:
    # Called directly: in a built checkout WhiteNoise answers "/" before this view runs.
    request = RequestFactory().get("/")
    settings.FRONTEND_DIST = tmp_path
    res = spa_index(request)
    assert res.status_code == 200
    assert b"Frontend not built" in res.content
    (tmp_path / "index.html").write_text("<html>app</html>")
    res = spa_index(request)
    assert b"".join(res.streaming_content) == b"<html>app</html>"  # type: ignore[attr-defined]


def test_heatmap_retry_allowed_shortly_after_departure(client: APIClient) -> None:
    body = {
        "routes": [[[-97, 32], [-96, 33]]],
        "departure_time": (timezone.now() - timedelta(hours=3)).isoformat(),
    }
    assert client.post("/api/heatmap", body, format="json").status_code == 200
    body["departure_time"] = (timezone.now() - timedelta(days=3)).isoformat()
    res = client.post("/api/heatmap", body, format="json")
    assert res.status_code == 400
    assert "departure_time" in res.json()["error"]["fields"]
