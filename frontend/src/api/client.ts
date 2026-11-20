import type {
  ApiErrorBody,
  GeocodeResult,
  HeatmapRequestBody,
  HeatmapResponse,
  PlanRequestBody,
  PlanResponse,
} from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, unknown>;

  constructor(message: string, code: string, status: number, fields?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

const FRIENDLY: Record<string, string> = {
  upstream_rate_limited: 'A data provider is busy right now. Please try again in a minute.',
  upstream_unavailable: 'A routing or weather provider could not be reached. Please retry.',
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError('Network error — check your connection and retry.', 'network_error', 0);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbort(error)) throw error;
    payload = null;
  }

  if (!response.ok) {
    const body = (payload as ApiErrorBody | null)?.error;
    const code = body?.code ?? 'http_error';
    const message = body?.message ?? `Request failed (HTTP ${response.status}).`;
    const friendly = FRIENDLY[code];
    throw new ApiError(
      friendly ? `${friendly} (${message})` : message,
      code,
      response.status,
      body?.fields,
    );
  }
  if (payload === null) {
    throw new ApiError(
      'The server returned an invalid response.',
      'invalid_response',
      response.status,
    );
  }
  return payload as T;
}

export const api = {
  plan(body: PlanRequestBody, signal?: AbortSignal): Promise<PlanResponse> {
    return request('/api/plan', { method: 'POST', body: JSON.stringify(body), signal });
  },
  heatmap(body: HeatmapRequestBody, signal?: AbortSignal): Promise<HeatmapResponse> {
    return request('/api/heatmap', { method: 'POST', body: JSON.stringify(body), signal });
  },
  geocode(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({ q: query, limit: '6' });
    return request<{ results: GeocodeResult[] }>(`/api/geocode?${params}`, { signal }).then(
      (r) => r.results,
    );
  },
};
