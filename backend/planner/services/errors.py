"""Service errors; the API layer maps them to HTTP responses."""

from __future__ import annotations


class ServiceError(Exception):
    """``code`` is a stable identifier for API clients."""

    code = "service_error"
    http_status = 502

    def __init__(self, message: str, *, provider: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.provider = provider


class UpstreamError(ServiceError):
    """A third-party API failed, timed out or returned something unusable."""

    code = "upstream_unavailable"
    http_status = 502

    def __init__(
        self,
        message: str,
        *,
        provider: str,
        status: int | None = None,
        body: object = None,
    ) -> None:
        super().__init__(message, provider=provider)
        self.status = status
        self.body = body  # parsed error payload, if any


class UpstreamRateLimitedError(UpstreamError):
    code = "upstream_rate_limited"
    http_status = 503


class RouteNotFoundError(ServiceError):
    """The routing engine answered, but there is no truck-legal route."""

    code = "no_route"
    http_status = 422


class ForecastUnavailableError(ServiceError):
    """The trip extends beyond what the forecast covers."""

    code = "forecast_out_of_range"
    http_status = 422
