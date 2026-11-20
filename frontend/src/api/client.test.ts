import { jsonResponse, mockFetch, planFixture } from '../test/utils';
import { api, ApiError, isAbort } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('posts JSON and returns the payload', async () => {
    const fetchMock = mockFetch({ '/api/plan': () => jsonResponse(planFixture) });
    const res = await api.plan(planFixture.inputs as never);
    expect(res.recommendation.route_id).toBe(planFixture.recommendation.route_id);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('unwraps the geocode results and encodes the query', async () => {
    const fetchMock = mockFetch({
      '/api/geocode': () => jsonResponse({ results: [{ label: 'Dallas, Texas, USA' }] }),
    });
    const results = await api.geocode('Dallas & co');
    expect(results[0]!.label).toBe('Dallas, Texas, USA');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('q=Dallas+%26+co');
  });

  it('raises ApiError with the server envelope', async () => {
    mockFetch({
      '/api/plan': () =>
        jsonResponse(
          {
            error: {
              code: 'invalid_request',
              message: 'load_weight_lb: too big',
              fields: { load_weight_lb: ['x'] },
            },
          },
          400,
        ),
    });
    const err = await api.plan({} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'invalid_request',
      status: 400,
      message: 'load_weight_lb: too big',
    });
    expect((err as ApiError).fields).toEqual({ load_weight_lb: ['x'] });
  });

  it('adds a friendly prefix for provider outages', async () => {
    mockFetch({
      '/api/plan': () =>
        jsonResponse({ error: { code: 'upstream_rate_limited', message: 'busy' } }, 503),
    });
    const err = (await api.plan({} as never).catch((e: unknown) => e)) as ApiError;
    expect(err.message).toMatch(/^A data provider is busy right now/);
    expect(err.message).toContain('(busy)');
  });

  it('handles non-JSON errors and empty bodies', async () => {
    mockFetch({ '/api/plan': () => new Response('<html>', { status: 502 }) });
    await expect(api.plan({} as never)).rejects.toMatchObject({ code: 'http_error', status: 502 });
    mockFetch({ '/api/plan': () => new Response('', { status: 200 }) });
    await expect(api.plan({} as never)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('treats an abort while reading the body as an abort', async () => {
    const response = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new DOMException('Aborted', 'AbortError')),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const err = await api.heatmap({} as never).catch((e: unknown) => e);
    expect(isAbort(err)).toBe(true);
  });

  it('maps network failures and passes aborts through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.plan({} as never)).rejects.toMatchObject({ code: 'network_error' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    const err = await api.plan({} as never).catch((e: unknown) => e);
    expect(isAbort(err)).toBe(true);
  });
});
