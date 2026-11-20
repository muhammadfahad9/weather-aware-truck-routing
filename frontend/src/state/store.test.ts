import type { HeatmapRequestBody } from '../api/types';
import { heatmapFixture, jsonResponse, mockFetch, planFixture } from '../test/utils';
import { MAX_HOURS, useAppStore } from './store';

const body = planFixture.inputs as never;

beforeEach(() => useAppStore.getState().reset());
afterEach(() => vi.unstubAllGlobals());

describe('store', () => {
  it('plans, selects the recommended route, then loads the heatmap for those routes', async () => {
    let heatmapBody: HeatmapRequestBody | null = null;
    mockFetch({
      '/api/plan': () => jsonResponse(planFixture),
      '/api/heatmap': (init) => {
        heatmapBody = JSON.parse(String(init?.body)) as HeatmapRequestBody;
        return jsonResponse(heatmapFixture);
      },
    });
    useAppStore.getState().setTime(10);
    await useAppStore.getState().submitPlan(body);
    const s = useAppStore.getState();
    expect(s.planStatus).toBe('success');
    expect(s.selectedRouteId).toBe(planFixture.recommendation.route_id);
    expect(s.timeHours).toBe(0);
    await vi.waitFor(() => expect(useAppStore.getState().heatmapStatus).toBe('success'));
    expect(heatmapBody!.routes).toHaveLength(planFixture.routes.length);
    expect(heatmapBody!.routes[0]!.length).toBeLessThanOrEqual(400);
    expect(heatmapBody!.departure_time).toBe(planFixture.inputs.departure_time);
    expect(heatmapBody!.scenario).toEqual(planFixture.weather.scenario);
    expect(heatmapBody!.hours).toBe(MAX_HOURS);
  });

  it('keeps the plan when only the heatmap fails, and can retry it', async () => {
    let fail = true;
    mockFetch({
      '/api/plan': () => jsonResponse(planFixture),
      '/api/heatmap': () =>
        fail
          ? jsonResponse({ error: { code: 'upstream_unavailable', message: 'down' } }, 502)
          : jsonResponse(heatmapFixture),
    });
    await useAppStore.getState().submitPlan(body);
    await vi.waitFor(() => expect(useAppStore.getState().heatmapStatus).toBe('error'));
    expect(useAppStore.getState().plan).not.toBeNull();
    fail = false;
    useAppStore.getState().retryHeatmap();
    await vi.waitFor(() => expect(useAppStore.getState().heatmapStatus).toBe('success'));
  });

  it('a failed re-plan keeps the previous plan and its heatmap', async () => {
    let planCalls = 0;
    let releaseHeatmap: (r: Response) => void = () => {};
    mockFetch({
      '/api/plan': () => {
        planCalls += 1;
        return planCalls === 1
          ? jsonResponse(planFixture)
          : jsonResponse({ error: { code: 'no_route', message: 'No truck route' } }, 422);
      },
      '/api/heatmap': () => new Promise<Response>((resolve) => (releaseHeatmap = resolve)),
    });
    await useAppStore.getState().submitPlan(body);
    expect(useAppStore.getState().heatmapStatus).toBe('loading');
    await useAppStore.getState().submitPlan(body); // fails
    expect(useAppStore.getState().planStatus).toBe('error');
    releaseHeatmap(jsonResponse(heatmapFixture));
    await vi.waitFor(() => expect(useAppStore.getState().heatmapStatus).toBe('success'));
    expect(useAppStore.getState().plan).not.toBeNull();
  });

  it('reports plan errors', async () => {
    mockFetch({
      '/api/plan': () =>
        jsonResponse({ error: { code: 'no_route', message: 'No truck route' } }, 422),
    });
    await useAppStore.getState().submitPlan(body);
    const s = useAppStore.getState();
    expect(s.planStatus).toBe('error');
    expect(s.planError?.code).toBe('no_route');
  });

  it('a newer request supersedes an in-flight one', async () => {
    let calls = 0;
    mockFetch({
      '/api/plan': (init) =>
        new Promise((resolve, reject) => {
          calls += 1;
          const mine = calls;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
          setTimeout(
            () => resolve(jsonResponse({ ...planFixture, generated_at: `call-${mine}` })),
            20,
          );
        }),
      '/api/heatmap': () => jsonResponse(heatmapFixture),
    });
    const first = useAppStore.getState().submitPlan(body);
    const second = useAppStore.getState().submitPlan(body);
    await Promise.all([first, second]);
    expect(useAppStore.getState().plan?.generated_at).toBe('call-2');
    expect(useAppStore.getState().planStatus).toBe('success');
  });

  it('clamps time and restarts playback from the beginning at the end', () => {
    const s = useAppStore.getState();
    s.setTime(-3);
    expect(useAppStore.getState().timeHours).toBe(0);
    s.setTime(500);
    expect(useAppStore.getState().timeHours).toBe(MAX_HOURS);
    s.setPlaying(true);
    expect(useAppStore.getState()).toMatchObject({ playing: true, timeHours: 0 });
  });

  it('focusing a checkpoint selects its route and bumps the nonce', () => {
    const s = useAppStore.getState();
    s.focusCheckpoint('C', 3);
    const first = useAppStore.getState().focusedCheckpoint!;
    s.focusCheckpoint('C', 3);
    expect(useAppStore.getState().selectedRouteId).toBe('C');
    expect(useAppStore.getState().focusedCheckpoint!.nonce).toBe(first.nonce + 1);
  });
});
