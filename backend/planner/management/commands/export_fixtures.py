"""Export plan/heatmap responses from the offline pipeline as frontend test fixtures.

Usage: python manage.py export_fixtures ../frontend/src/test/fixtures
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from django.core.cache import cache
from django.core.management.base import BaseCommand

from planner.api.presenters import present_heatmap, present_plan
from planner.services.container import Services
from planner.services.geocoding import GazetteerGeocoder
from planner.services.heatmap import HeatmapRequest, build_heatmap
from planner.services.routing.simulated import SimulatedRoutingProvider
from planner.services.trip_planner import PlanRequest, plan_trip
from planner.services.weather.simulated import SimulatedWeatherProvider

NOW = 1_800_000_000  # fixed clock for reproducible output


class Command(BaseCommand):
    help = "Export plan/heatmap responses generated with the offline providers."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("out_dir")

    def handle(self, *args: Any, **options: Any) -> None:
        out = Path(options["out_dir"])
        out.mkdir(parents=True, exist_ok=True)
        services = Services(
            routing=SimulatedRoutingProvider(),
            routing_fallback=None,
            weather=SimulatedWeatherProvider(),
            geocoder=GazetteerGeocoder(),
            cache=cache,
            truck_tare_lb=35_000,
            truck_max_speed_mph=65,
            heatmap_max_cells=120,
        )
        departure = datetime.fromtimestamp(NOW + 900, tz=timezone.utc)
        result = plan_trip(
            PlanRequest(
                origin=(32.7767, -96.7970),
                destination=(37.6872, -97.3301),  # Dallas -> Wichita (~350 mi)
                origin_label="Dallas, Texas, USA",
                destination_label="Wichita, Kansas, USA",
                departure=departure,
                load_lb=42_000,
                interval_mi=50,
                weather_source="simulated",
            ),
            services,
            now=NOW,
        )
        plan = present_plan(result)
        heatmap = present_heatmap(
            build_heatmap(
                HeatmapRequest(
                    routes=[list(a.plan.candidate.path.points[::4]) for a in result.analyses],
                    departure=departure,
                    hours=12,
                    scenario=result.scenario,
                ),
                services,
            )
        )
        for name, payload in (("plan.json", plan), ("heatmap.json", heatmap)):
            (out / name).write_text(json.dumps(payload, separators=(",", ":")))
        self.stdout.write(self.style.SUCCESS(f"Wrote fixtures to {out}"))
