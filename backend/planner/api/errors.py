"""Every failure uses one envelope: ``{"error": {"code", "message", ...}}``."""

from __future__ import annotations

import logging
from typing import Any

from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from planner.services.errors import ServiceError

logger = logging.getLogger(__name__)


def exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    if isinstance(exc, ServiceError):
        logger.warning("Service error (%s): %s", exc.provider, exc.message)
        body: dict[str, Any] = {"code": exc.code, "message": exc.message}
        if exc.provider:
            body["provider"] = exc.provider
        return Response({"error": body}, status=exc.http_status)

    if isinstance(exc, exceptions.ValidationError):
        return Response(
            {
                "error": {
                    "code": "invalid_request",
                    "message": _first_message(exc.detail),
                    "fields": exc.detail,
                }
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    response = drf_exception_handler(exc, context)
    if response is not None:
        detail = response.data.get("detail") if isinstance(response.data, dict) else None
        code = getattr(detail, "code", None) or "error"
        response.data = {"error": {"code": code, "message": str(detail or exc)}}
        return response

    logger.exception("Unhandled error", exc_info=exc)
    return Response(
        {"error": {"code": "internal_error", "message": "Something went wrong. Please retry."}},
        status=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )


def _first_message(detail: Any, prefix: str = "") -> str:
    """First validation message with its field path, e.g. ``"origin.lat: Ensure ..."``."""
    if isinstance(detail, dict):
        for key, value in detail.items():
            name = "" if key == "non_field_errors" else f"{prefix}{key}"
            return _first_message(value, f"{name}." if name else "")
    if isinstance(detail, list) and detail:
        return _first_message(detail[0], prefix)
    label = prefix.rstrip(".")
    return f"{label}: {detail}" if label else str(detail)
