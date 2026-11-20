"""Request validation. Responses are built in ``presenters``."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.utils import timezone
from rest_framework import serializers

from planner.domain.checkpoints import ALLOWED_INTERVALS_MI
from planner.domain.geo import haversine_mi
from planner.services.weather.simulated import Scenario

MAX_LOAD_LB = 80_000
DEPARTURE_PAST_GRACE = timedelta(hours=1)
DEPARTURE_MAX_AHEAD = timedelta(days=7)
HEATMAP_PAST_LIMIT = timedelta(days=2)
MAX_HEATMAP_ROUTES = 5
MAX_HEATMAP_POINTS = 2_000


class PlaceSerializer(serializers.Serializer[dict[str, Any]]):
    lat = serializers.FloatField(min_value=-90, max_value=90)
    lon = serializers.FloatField(min_value=-180, max_value=180)
    label = serializers.CharField(max_length=200, required=False, allow_blank=True, default="")


class DepartureMixin:
    def validate_departure_time(self, value: Any) -> Any:
        now = timezone.now()
        if value < now - DEPARTURE_PAST_GRACE:
            raise serializers.ValidationError("Departure time cannot be in the past.")
        if value > now + DEPARTURE_MAX_AHEAD:
            raise serializers.ValidationError("Departure must be within the next 7 days.")
        return value


class PlanRequestSerializer(DepartureMixin, serializers.Serializer[dict[str, Any]]):
    origin = PlaceSerializer()
    destination = PlaceSerializer()
    departure_time = serializers.DateTimeField()
    load_weight_lb = serializers.FloatField(min_value=0, max_value=MAX_LOAD_LB)
    interval_miles = serializers.ChoiceField(choices=list(ALLOWED_INTERVALS_MI))
    hos_breaks = serializers.BooleanField(default=True)
    wind_basis = serializers.ChoiceField(choices=["sustained", "gust"], default="sustained")
    weather_source = serializers.ChoiceField(choices=["live", "simulated"], default="live")

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        o, d = attrs["origin"], attrs["destination"]
        if haversine_mi((o["lat"], o["lon"]), (d["lat"], d["lon"])) < 1.0:
            raise serializers.ValidationError(
                {"destination": "Destination must be at least a mile from the origin."}
            )
        return attrs


class CoordinateListField(serializers.Field):  # type: ignore[type-arg]
    """``[[lon, lat], ...]`` validated in one pass (routes can have thousands of points)."""

    default_error_messages = {
        "invalid": "Expected a list of [lon, lat] pairs.",
        "length": "Each route needs between 2 and {max} points.",
        "range": "Coordinates out of range.",
    }

    def to_internal_value(self, data: Any) -> list[tuple[float, float]]:
        if not isinstance(data, list):
            self.fail("invalid")
        if not 2 <= len(data) <= MAX_HEATMAP_POINTS:
            self.fail("length", max=MAX_HEATMAP_POINTS)
        out = []
        for item in data:
            if (
                not isinstance(item, (list, tuple))
                or len(item) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in item)
            ):
                self.fail("invalid")
            lon, lat = float(item[0]), float(item[1])
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                self.fail("range")
            out.append((lat, lon))
        return out

    def to_representation(self, value: Any) -> Any:  # pragma: no cover - input only
        return value


class HeatmapRequestSerializer(serializers.Serializer[dict[str, Any]]):
    routes = serializers.ListField(
        child=CoordinateListField(), min_length=1, max_length=MAX_HEATMAP_ROUTES
    )
    departure_time = serializers.DateTimeField()
    hours = serializers.IntegerField(min_value=1, max_value=48, default=48)
    scenario = serializers.JSONField(required=False, allow_null=True, default=None)

    def validate_departure_time(self, value: Any) -> Any:
        # Looser than /plan: a retry may come a while after a just-departed trip was planned.
        now = timezone.now()
        if not now - HEATMAP_PAST_LIMIT <= value <= now + DEPARTURE_MAX_AHEAD:
            raise serializers.ValidationError("Departure is outside the forecast window.")
        return value

    def validate_scenario(self, value: Any) -> Scenario | None:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise serializers.ValidationError("Scenario must be an object.")
        try:
            return Scenario.from_dict(value)
        except (KeyError, TypeError, ValueError) as exc:
            raise serializers.ValidationError(f"Invalid scenario: {exc}") from exc


class GeocodeQuerySerializer(serializers.Serializer[dict[str, Any]]):
    q = serializers.CharField(min_length=2, max_length=200, trim_whitespace=True)
    limit = serializers.IntegerField(min_value=1, max_value=10, default=6)
    lat = serializers.FloatField(min_value=-90, max_value=90, required=False)
    lon = serializers.FloatField(min_value=-180, max_value=180, required=False)
