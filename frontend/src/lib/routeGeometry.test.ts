import type { PlanResponse, Route } from '../api/types';
import planFixture from '../test/fixtures/plan.json';
import {
  boundsOf,
  bracket,
  checkpointAtMile,
  decimate,
  haversineMi,
  labelAnchors,
  pointAtMile,
  riskRuns,
  sliceByMiles,
  truckPosition,
} from './routeGeometry';

const plan = planFixture as unknown as PlanResponse;

/** 20 mi straight east-west route driven at 60 mph with a 10-minute stop at mile 10. */
function stopRoute(): Route {
  const base = plan.routes[0]!;
  const lonPerMile = 1 / 69.17 / Math.cos((35 * Math.PI) / 180);
  return {
    ...base,
    id: 'S',
    path: {
      coordinates: [
        [-100, 35],
        [-100 + 10 * lonPerMile, 35],
        [-100 + 10 * lonPerMile, 35],
        [-100 + 20 * lonPerMile, 35],
      ],
      miles: [0, 10, 10, 20],
      elapsed_s: [0, 600, 1200, 1800],
    },
  };
}

describe('bracket', () => {
  const arr = [0, 10, 10, 30];
  it('finds the segment and clamps', () => {
    expect(bracket(arr, -1)).toBe(0);
    expect(bracket(arr, 5)).toBe(0);
    expect(bracket(arr, 20)).toBe(2);
    expect(bracket(arr, 99)).toBe(2);
  });
});

describe('truckPosition', () => {
  const route = stopRoute();
  it('drives, parks during stops and arrives', () => {
    expect(truckPosition(route, 300)).toMatchObject({ state: 'driving', mile: 5 });
    expect(truckPosition(route, 900)).toMatchObject({ state: 'stopped', mile: 10 });
    expect(truckPosition(route, 1500)).toMatchObject({ state: 'driving', mile: 15 });
    expect(truckPosition(route, 99_999)).toMatchObject({ state: 'arrived', mile: 20 });
    expect(truckPosition(route, -50)).toMatchObject({ state: 'driving', mile: 0 });
  });
  it('interpolates coordinates', () => {
    const p = truckPosition(route, 300).coord;
    expect(haversineMi(route.path.coordinates[0]!, p)).toBeCloseTo(5, 1);
  });
});

describe('risk runs', () => {
  it('cover each route continuously with one run per level change', () => {
    for (const route of plan.routes) {
      const runs = riskRuns(route);
      expect(runs[0]!.from).toBe(0);
      expect(runs.at(-1)!.to).toBeCloseTo(route.checkpoints.at(-1)!.span[1]);
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i]!.from).toBeCloseTo(runs[i - 1]!.to);
        expect(runs[i]!.level).not.toBe(runs[i - 1]!.level);
      }
      for (const run of runs) expect(run.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('slices exactly at the requested mileposts', () => {
    const route = plan.routes[0]!;
    const slice = sliceByMiles(route, 10, 40);
    expect(slice[0]).toEqual(pointAtMile(route, 10));
    expect(slice.at(-1)).toEqual(pointAtMile(route, 40));
    expect(sliceByMiles(route, 40, 10)).toEqual([]);
  });
});

describe('labelAnchors', () => {
  it('places one anchor per route, apart from each other', () => {
    const anchors = labelAnchors(plan.routes);
    expect(Object.keys(anchors).sort()).toEqual(plan.routes.map((r) => r.id).sort());
    const pts = Object.values(anchors);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++)
        expect(haversineMi(pts[i]!, pts[j]!)).toBeGreaterThan(20);
    }
  });
});

describe('utilities', () => {
  it('decimates keeping both ends', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const d = decimate(pts, 10);
    expect(d).toHaveLength(10);
    expect(d[0]).toBe(0);
    expect(d.at(-1)).toBe(999);
    expect(decimate([1, 2], 10)).toEqual([1, 2]);
  });

  it('computes bounds of all routes', () => {
    const [[w, s], [e, n]] = boundsOf(plan.routes);
    for (const r of plan.routes) {
      for (const [lon, lat] of r.path.coordinates) {
        expect(lon).toBeGreaterThanOrEqual(w);
        expect(lon).toBeLessThanOrEqual(e);
        expect(lat).toBeGreaterThanOrEqual(s);
        expect(lat).toBeLessThanOrEqual(n);
      }
    }
  });

  it('finds the checkpoint covering a mile', () => {
    const route = plan.routes[0]!;
    expect(checkpointAtMile(route, 0)?.index).toBe(0);
    expect(checkpointAtMile(route, 60)?.index).toBe(1);
    expect(checkpointAtMile(route, 99_999)).toBeUndefined();
  });

  it('haversine matches a known distance', () => {
    expect(haversineMi([-96.797, 32.7767], [-87.6298, 41.8781])).toBeCloseTo(802, -1);
  });
});
