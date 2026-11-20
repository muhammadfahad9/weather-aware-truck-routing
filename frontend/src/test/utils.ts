import type { HeatmapResponse, PlanResponse } from '../api/types';
import heatmapJson from './fixtures/heatmap.json';
import planJson from './fixtures/plan.json';

export const planFixture = planJson as unknown as PlanResponse;
export const heatmapFixture = heatmapJson as unknown as HeatmapResponse;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Route fetch calls by path; unknown paths fail the test loudly. */
export function mockFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.split('?')[0]!;
    const handler = routes[path];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return handler(init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
