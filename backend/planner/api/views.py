"""API views: validate, run the use case, present."""

from __future__ import annotations

from typing import Any

from django.conf import settings
from django.http import FileResponse, HttpRequest, HttpResponse
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from planner.domain.risk import rules_payload
from planner.services.container import get_services
from planner.services.heatmap import HeatmapRequest, build_heatmap
from planner.services.trip_planner import PlanRequest, plan_trip

from .presenters import present_heatmap, present_plan
from .serializers import GeocodeQuerySerializer, HeatmapRequestSerializer, PlanRequestSerializer

GEOCODE_CACHE_TTL_S = 24 * 3600


class HealthView(APIView):
    def get(self, request: Request) -> Response:
        return Response({"status": "ok"})


class RulesView(APIView):
    def get(self, request: Request) -> Response:
        return Response(rules_payload())


class PlanView(APIView):
    throttle_scope = "plan"

    def post(self, request: Request) -> Response:
        serializer = PlanRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data: dict[str, Any] = serializer.validated_data
        plan_request = PlanRequest(
            origin=(data["origin"]["lat"], data["origin"]["lon"]),
            destination=(data["destination"]["lat"], data["destination"]["lon"]),
            origin_label=data["origin"]["label"],
            destination_label=data["destination"]["label"],
            departure=data["departure_time"],
            load_lb=data["load_weight_lb"],
            interval_mi=int(data["interval_miles"]),
            hos_enabled=data["hos_breaks"],
            wind_basis=data["wind_basis"],
            weather_source=data["weather_source"],
        )
        return Response(present_plan(plan_trip(plan_request, get_services())))


class HeatmapView(APIView):
    throttle_scope = "heatmap"

    def post(self, request: Request) -> Response:
        serializer = HeatmapRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data: dict[str, Any] = serializer.validated_data
        result = build_heatmap(
            HeatmapRequest(
                routes=data["routes"],
                departure=data["departure_time"],
                hours=data["hours"],
                scenario=data["scenario"],
            ),
            get_services(),
        )
        return Response(present_heatmap(result))


class GeocodeView(APIView):
    throttle_scope = "geocode"

    def get(self, request: Request) -> Response:
        serializer = GeocodeQuerySerializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        q: dict[str, Any] = serializer.validated_data
        near = (q["lat"], q["lon"]) if "lat" in q and "lon" in q else None
        services = get_services()
        key = f"geo:{services.geocoder.name}:{q['q'].lower()}:{q['limit']}:{near}"
        results = services.cache.get(key)
        if results is None:
            results = [p.to_dict() for p in services.geocoder.search(q["q"], q["limit"], near)]
            services.cache.set(key, results, GEOCODE_CACHE_TTL_S)
        return Response({"results": results})


def spa_index(request: HttpRequest) -> HttpResponse:
    index = settings.FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index.open("rb"), content_type="text/html")
    return HttpResponse(
        "Frontend not built. Run `npm run build` in /frontend, or use the Vite dev server "
        "(npm run dev) which proxies /api to this backend.",
        content_type="text/plain",
    )
