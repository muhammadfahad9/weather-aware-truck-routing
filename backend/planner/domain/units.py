"""Unit constants and numeric helpers."""

from __future__ import annotations

import math

METERS_PER_MILE = 1609.344
KM_PER_MILE = METERS_PER_MILE / 1000.0
EARTH_RADIUS_MI = 3958.7613
POUNDS_PER_METRIC_TON = 2204.62262
SECONDS_PER_HOUR = 3600


def round_half_up(value: float, ndigits: int = 0) -> float:
    """Round half up, like JavaScript's ``Math.round`` (Python's ``round`` is banker's)."""
    factor = 10.0**ndigits
    return math.floor(value * factor + 0.5) / factor


def mph_to_kph(mph: float) -> float:
    return mph * KM_PER_MILE


def pounds_to_metric_tons(pounds: float) -> float:
    return pounds / POUNDS_PER_METRIC_TON
