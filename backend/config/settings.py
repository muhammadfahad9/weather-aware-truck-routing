"""Django settings. Everything deploy-specific comes from environment variables."""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", BASE_DIR.parent / "frontend" / "dist"))


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


DEBUG = env_bool("DJANGO_DEBUG", default=False)
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or (
    "dev-only-insecure-key" if DEBUG or os.environ.get("CI") else ""
)
if not SECRET_KEY:
    raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],testserver")
# Loopback stays allowed so the container's own health check works with any host list.
ALLOWED_HOSTS += [h for h in ("localhost", "127.0.0.1") if h not in ALLOWED_HOSTS]
if render_host := os.environ.get("RENDER_EXTERNAL_HOSTNAME"):
    ALLOWED_HOSTS.append(render_host)
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS")

INSTALLED_APPS = [
    "rest_framework",
    "planner",
]

# Sites allowed to embed the app in an iframe (e.g. https://huggingface.co). Empty = none.
FRAME_ANCESTORS = env_list("DJANGO_FRAME_ANCESTORS")

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.gzip.GZipMiddleware",
    "django.middleware.common.CommonMiddleware",
    "planner.middleware.FrameAncestorsMiddleware"
    if FRAME_ANCESTORS
    else "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": False,
        "OPTIONS": {"context_processors": []},
    }
]

# Stateless API, no database.
DATABASES: dict[str, dict[str, str]] = {}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "planner",
        "OPTIONS": {"MAX_ENTRIES": 20_000},
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

STATIC_URL = "/static/"
# The built React app is served from the site root by WhiteNoise.
WHITENOISE_ROOT = FRONTEND_DIST if FRONTEND_DIST.exists() else None
WHITENOISE_INDEX_FILE = True
WHITENOISE_MAX_AGE = 300


def _immutable_vite_asset(path: str, url: str) -> bool:
    # Vite emits content-hashed files under /assets/, safe to cache forever.
    return url.startswith("/assets/")


WHITENOISE_IMMUTABLE_FILE_TEST = _immutable_vite_asset

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
X_FRAME_OPTIONS = "DENY"
if not DEBUG:
    SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", default=False)
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS", "0"))

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "EXCEPTION_HANDLER": "planner.api.errors.exception_handler",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "plan": os.environ.get("THROTTLE_PLAN", "30/min"),
        "heatmap": os.environ.get("THROTTLE_HEATMAP", "40/min"),
        "geocode": os.environ.get("THROTTLE_GEOCODE", "240/min"),
    },
    "NUM_PROXIES": int(os.environ.get("NUM_PROXIES", "1")) if not DEBUG else None,
}

PLANNER = {
    "ROUTING_PROVIDER": os.environ.get("ROUTING_PROVIDER", "valhalla"),
    "ROUTING_FALLBACK": os.environ.get("ROUTING_FALLBACK", "osrm"),
    "WEATHER_PROVIDER": os.environ.get("WEATHER_PROVIDER", "open-meteo"),
    "GEOCODER": os.environ.get("GEOCODER", "photon"),
    "VALHALLA_URL": os.environ.get("VALHALLA_URL", "https://valhalla1.openstreetmap.de"),
    "OSRM_URL": os.environ.get("OSRM_URL", "https://router.project-osrm.org"),
    "OPEN_METEO_URL": os.environ.get("OPEN_METEO_URL", "https://api.open-meteo.com"),
    "OPEN_METEO_API_KEY": os.environ.get("OPEN_METEO_API_KEY") or None,
    "PHOTON_URL": os.environ.get("PHOTON_URL", "https://photon.komoot.io"),
    "USER_AGENT": os.environ.get(
        "HTTP_USER_AGENT", "weather-aware-truck-routing/1.0 (+https://github.com/)"
    ),
    "HTTP_TIMEOUT_S": float(os.environ.get("HTTP_TIMEOUT_S", "25")),
    "ROUTING_MIN_INTERVAL_S": float(os.environ.get("ROUTING_MIN_INTERVAL_S", "1.0")),
    "TRUCK_TARE_LB": float(os.environ.get("TRUCK_TARE_LB", "35000")),
    "TRUCK_MAX_SPEED_MPH": float(os.environ.get("TRUCK_MAX_SPEED_MPH", "65")),
    "HEATMAP_MAX_CELLS": int(os.environ.get("HEATMAP_MAX_CELLS", "400")),
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s: %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "INFO")},
}
