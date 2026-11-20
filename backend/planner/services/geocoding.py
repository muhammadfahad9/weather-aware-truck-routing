"""Place search for autocomplete, via Photon (Nominatim's usage policy disallows it)."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Protocol

from .http import HttpClient


@dataclass(frozen=True)
class Place:
    label: str
    name: str
    context: str
    lat: float
    lon: float
    kind: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Geocoder(Protocol):
    name: str

    def search(
        self, query: str, limit: int, near: tuple[float, float] | None = None
    ) -> list[Place]: ...


_COUNTRY_SHORT = {"United States": "USA", "United States of America": "USA"}


class PhotonGeocoder:
    name = "photon"

    def __init__(self, http: HttpClient, base_url: str) -> None:
        self.http = http
        self.base_url = base_url.rstrip("/")

    def search(
        self, query: str, limit: int, near: tuple[float, float] | None = None
    ) -> list[Place]:
        params: dict[str, Any] = {"q": query, "limit": limit + 3, "lang": "en"}
        if near:
            params.update({"lat": round(near[0], 3), "lon": round(near[1], 3)})
        data = self.http.get_json(f"{self.base_url}/api/", provider=self.name, params=params)
        places: list[Place] = []
        seen: set[str] = set()
        for feature in data.get("features", []):
            place = _photon_place(feature)
            if place and place.label not in seen:
                seen.add(place.label)
                places.append(place)
        return places[:limit]


def _photon_place(feature: dict[str, Any]) -> Place | None:
    try:
        lon, lat = feature["geometry"]["coordinates"][:2]
    except (KeyError, TypeError, ValueError):
        return None
    props = feature.get("properties", {})
    street = " ".join(str(p) for p in (props.get("housenumber"), props.get("street")) if p)
    name = props.get("name") or street or props.get("city")
    if not name:
        return None
    parts: list[str] = []
    for key in ("city", "county", "state", "country"):
        value = props.get(key)
        if not value or value == name or value in parts:
            continue
        if key == "county" and props.get("city"):
            continue
        parts.append(_COUNTRY_SHORT.get(value, value))
    if street and street != name:
        parts.insert(0, street)
    context = ", ".join(parts)
    return Place(
        label=f"{name}, {context}" if context else str(name),
        name=str(name),
        context=context,
        lat=float(lat),
        lon=float(lon),
        kind=str(props.get("osm_value") or props.get("type") or "place"),
    )


# Offline gazetteer for tests and the demo stack.
_GAZETTEER = [
    ("Dallas", "Texas", 32.7767, -96.7970),
    ("Chicago", "Illinois", 41.8781, -87.6298),
    ("Denver", "Colorado", 39.7392, -104.9903),
    ("Salt Lake City", "Utah", 40.7608, -111.8910),
    ("Kansas City", "Missouri", 39.0997, -94.5786),
    ("Oklahoma City", "Oklahoma", 35.4676, -97.5164),
    ("Amarillo", "Texas", 35.2220, -101.8313),
    ("Albuquerque", "New Mexico", 35.0844, -106.6504),
    ("Atlanta", "Georgia", 33.7490, -84.3880),
    ("Nashville", "Tennessee", 36.1627, -86.7816),
    ("Memphis", "Tennessee", 35.1495, -90.0490),
    ("St. Louis", "Missouri", 38.6270, -90.1994),
    ("Minneapolis", "Minnesota", 44.9778, -93.2650),
    ("Fargo", "North Dakota", 46.8772, -96.7898),
    ("Omaha", "Nebraska", 41.2565, -95.9345),
    ("Houston", "Texas", 29.7604, -95.3698),
    ("Phoenix", "Arizona", 33.4484, -112.0740),
    ("Los Angeles", "California", 34.0522, -118.2437),
    ("Seattle", "Washington", 47.6062, -122.3321),
    ("New York", "New York", 40.7128, -74.0060),
    ("Indianapolis", "Indiana", 39.7684, -86.1581),
    ("Columbus", "Ohio", 39.9612, -82.9988),
    ("Laredo", "Texas", 27.5306, -99.4803),
    ("Cheyenne", "Wyoming", 41.1400, -104.8202),
]


class GazetteerGeocoder:
    name = "gazetteer"

    def search(
        self, query: str, limit: int, near: tuple[float, float] | None = None
    ) -> list[Place]:
        q = query.strip().lower()
        hits = [
            Place(
                label=f"{city}, {state}, USA",
                name=city,
                context=f"{state}, USA",
                lat=lat,
                lon=lon,
                kind="city",
            )
            for city, state, lat, lon in _GAZETTEER
            if city.lower().startswith(q)
            or f"{city}, {state}".lower().startswith(q)
            or q in city.lower()
        ]
        return hits[:limit]
