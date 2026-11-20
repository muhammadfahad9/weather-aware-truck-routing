"""Clickjacking protection that can let specific sites embed the app."""

from __future__ import annotations

from collections.abc import Callable

from django.conf import settings
from django.http import HttpRequest, HttpResponse


class FrameAncestorsMiddleware:
    """Sends CSP ``frame-ancestors`` instead of ``X-Frame-Options: DENY``.

    Used when ``DJANGO_FRAME_ANCESTORS`` is set, e.g. on Hugging Face Spaces, whose page shows
    the app in an iframe.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        self.policy = " ".join(["frame-ancestors 'self'", *settings.FRAME_ANCESTORS])

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        response.headers.setdefault("Content-Security-Policy", self.policy)
        return response
