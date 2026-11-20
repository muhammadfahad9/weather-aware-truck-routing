from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from planner.domain.geo import LatLon
from planner.domain.route import RouteCandidate
from planner.services.errors import RouteNotFoundError, UpstreamError
from planner.services.routing.base import Truck
from planner.services.routing.options import (
    detour_points,
    find_route_options,
    is_duplicate,
    overlap_ratio,
)
from planner.services.routing.simulated import SimulatedRoutingProvider

from .conftest import straight_route

A = (35.0, -100.0)
B = (35.0, -98.0)
TRUCK = Truck(load_lb=20_000)


@dataclass
class FakeProvider:
    """Returns pre-baked candidates; synthesises detours by bending through the via point."""

    name: str
    candidates: list[RouteCandidate]
    fail: Exception | None = None
    via_fail_first: int = 0
    via_calls: list[LatLon] = field(default_factory=list)

    def routes(
        self, origin: LatLon, destination: LatLon, truck: Truck, alternates: int
    ) -> list[RouteCandidate]:
        if self.fail:
            raise self.fail
        return list(self.candidates)

    def via_route(
        self, origin: LatLon, via: LatLon, destination: LatLon, truck: Truck
    ) -> RouteCandidate:
        self.via_calls.append(via)
        if len(self.via_calls) <= self.via_fail_first:
            raise UpstreamError("busy", provider=self.name)
        return SimulatedRoutingProvider().via_route(origin, via, destination, truck)


def test_overlap_of_identical_and_parallel_routes() -> None:
    r = straight_route(A, B)
    assert overlap_ratio(r, r) == 1.0
    assert is_duplicate(r, straight_route(A, B, n=97))
    far = straight_route((35.5, -100.0), (35.5, -98.0))
    assert overlap_ratio(r, far) == 0.0
    assert not is_duplicate(r, far)


def test_partial_overlap_is_not_duplicate() -> None:
    main = straight_route(A, B)
    bent = SimulatedRoutingProvider().via_route(A, (35.4, -99.0), B, TRUCK)
    ratio = overlap_ratio(main, bent)
    assert 0 < ratio < 0.9
    assert not is_duplicate(main, bent)


def test_provider_alternates_used_directly() -> None:
    sim = SimulatedRoutingProvider()
    options = find_route_options(sim, None, A, B, TRUCK)
    assert len(options.routes) == 3
    assert options.warnings == []
    times = [r.path.total_drive_s for r in options.routes]
    assert times == sorted(times)


def test_duplicates_dropped_and_detours_synthesised() -> None:
    main = straight_route(A, B)
    provider = FakeProvider("fake", [main, straight_route(A, B, n=81)], via_fail_first=1)
    options = find_route_options(provider, None, A, B, TRUCK)
    assert len(options.routes) == 3
    assert sum(r.note == "synthesized" for r in options.routes) == 2
    assert len(provider.via_calls) == 3  # first detour failed, two succeeded
    for i, r in enumerate(options.routes):
        for other in options.routes[i + 1 :]:
            assert not is_duplicate(r, other)


def test_unreasonable_detours_rejected_and_reported() -> None:
    main = straight_route(A, B)

    class FarDetour(FakeProvider):
        def via_route(
            self, origin: LatLon, via: LatLon, destination: LatLon, truck: Truck
        ) -> RouteCandidate:
            self.via_calls.append(via)
            # A 300-mile excursion: far more than 1.5x the 113-mile trip.
            return SimulatedRoutingProvider().via_route(origin, (38.0, -99.0), destination, truck)

    options = find_route_options(FarDetour("fake", [main]), None, A, B, TRUCK)
    assert len(options.routes) == 1
    assert options.warnings == [
        "Only 1 distinct route exist between these points."
    ] or options.warnings[0].startswith("Only 1 distinct route")


def test_fallback_provider_on_outage() -> None:
    primary = FakeProvider("primary", [], fail=UpstreamError("down", provider="primary"))
    backup = FakeProvider("backup", SimulatedRoutingProvider().routes(A, B, TRUCK, 2))
    options = find_route_options(primary, backup, A, B, TRUCK)
    assert options.provider == "backup"
    assert len(options.routes) == 3
    assert "could not serve this trip (down)" in options.warnings[0]


def test_outage_without_fallback_raises() -> None:
    primary = FakeProvider("primary", [], fail=UpstreamError("down", provider="primary"))
    with pytest.raises(UpstreamError):
        find_route_options(primary, None, A, B, TRUCK)


def test_no_route_is_not_masked_by_fallback() -> None:
    primary = FakeProvider("primary", [], fail=RouteNotFoundError("none"))
    backup = FakeProvider("backup", [straight_route(A, B)])
    with pytest.raises(RouteNotFoundError):
        find_route_options(primary, backup, A, B, TRUCK)


def test_detour_points_alternate_sides() -> None:
    main = straight_route(A, B)
    pts = detour_points(A, B, main, attempts=2)
    assert len(pts) == 2
    assert pts[0][0] > 35.0 > pts[1][0]  # left (north) then right (south) of an eastbound trip
