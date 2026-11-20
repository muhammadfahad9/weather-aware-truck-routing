"""Shared HTTP client with pooling, retries and rate limiting."""

from __future__ import annotations

import threading
import time
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .errors import UpstreamError, UpstreamRateLimitedError


class MinIntervalLimiter:
    """Spaces calls ``interval_s`` apart per process (public OSM routers allow 1 req/s)."""

    def __init__(self, interval_s: float) -> None:
        self.interval_s = interval_s
        self._lock = threading.Lock()
        self._next_slot = 0.0

    def wait(self) -> None:
        if self.interval_s <= 0:
            return
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_slot)
            self._next_slot = slot + self.interval_s
        delay = slot - now
        if delay > 0:
            time.sleep(delay)


class HttpClient:
    def __init__(self, *, user_agent: str, timeout_s: float = 20.0, retries: int = 2) -> None:
        self.timeout_s = timeout_s
        self.session = requests.Session()
        retry = Retry(
            total=retries,
            connect=retries,
            read=retries,
            status=retries,
            backoff_factor=0.4,
            # 429 is left out: Retry-After can be a minute, so fail fast.
            status_forcelist=(500, 502, 503, 504),
            allowed_methods=frozenset({"GET", "POST"}),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=16)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self.session.headers.update({"User-Agent": user_agent, "Accept": "application/json"})

    def get_json(self, url: str, *, provider: str, params: Any = None) -> Any:
        return self._request("GET", url, provider=provider, params=params)

    def post_json(self, url: str, *, provider: str, body: Any) -> Any:
        return self._request("POST", url, provider=provider, json=body)

    def _request(self, method: str, url: str, *, provider: str, **kwargs: Any) -> Any:
        try:
            response = self.session.request(method, url, timeout=self.timeout_s, **kwargs)
        except requests.Timeout as exc:
            raise UpstreamError(f"{provider} timed out", provider=provider) from exc
        except requests.RequestException as exc:
            raise UpstreamError(f"{provider} is unreachable", provider=provider) from exc

        if response.status_code == 429:
            raise UpstreamRateLimitedError(
                f"{provider} rate limit reached, please retry in a minute",
                provider=provider,
                status=429,
            )
        payload = _json_or_none(response)
        if response.status_code >= 400:
            raise UpstreamError(
                _error_reason(payload) or f"{provider} returned HTTP {response.status_code}",
                provider=provider,
                status=response.status_code,
                body=payload,
            )
        if payload is None:
            raise UpstreamError(f"{provider} returned an invalid response", provider=provider)
        return payload


def _json_or_none(response: requests.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _error_reason(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in ("reason", "error", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
    return None
