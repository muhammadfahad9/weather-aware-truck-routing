from __future__ import annotations

from typing import Any

from django.http import HttpResponse
from django.test import RequestFactory
from rest_framework.test import APIClient

from planner.middleware import FrameAncestorsMiddleware


def test_framing_denied_by_default() -> None:
    res = APIClient().get("/api/health")
    assert res.headers["X-Frame-Options"] == "DENY"


def test_frame_ancestors_policy(settings: Any) -> None:
    settings.FRAME_ANCESTORS = ["https://huggingface.co"]
    middleware = FrameAncestorsMiddleware(lambda _request: HttpResponse("ok"))
    res = middleware(RequestFactory().get("/"))
    assert res.headers["Content-Security-Policy"] == "frame-ancestors 'self' https://huggingface.co"
    assert "X-Frame-Options" not in res.headers
