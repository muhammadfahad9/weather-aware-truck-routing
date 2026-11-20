import type { Checkpoint, RiskLevel, Route } from '../api/types';

export type LngLat = [number, number];

const R_MI = 3958.7613;
const toRad = Math.PI / 180;

export function haversineMi(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Largest index i with arr[i] <= v (arr non-decreasing); clamps to [0, len-2]. */
export function bracket(arr: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  if (v <= arr[0]!) return 0;
  if (v >= arr[hi]!) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

function lerpCoord(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export type TruckState = 'driving' | 'stopped' | 'arrived';

export interface TruckPosition {
  coord: LngLat;
  mile: number;
  state: TruckState;
}

/** Where the truck is `elapsedS` seconds after departure (parked during HOS stops). */
export function truckPosition(route: Route, elapsedS: number): TruckPosition {
  const { coordinates, miles, elapsed_s: elapsed } = route.path;
  const last = coordinates.length - 1;
  if (elapsedS >= elapsed[last]!) {
    return { coord: coordinates[last]!, mile: miles[last]!, state: 'arrived' };
  }
  const t = Math.max(elapsedS, 0);
  const i = bracket(elapsed, t);
  const span = elapsed[i + 1]! - elapsed[i]!;
  const f = span > 0 ? (t - elapsed[i]!) / span : 0;
  const parked = miles[i + 1]! === miles[i]! && span > 0;
  return {
    coord: lerpCoord(coordinates[i]!, coordinates[i + 1]!, f),
    mile: miles[i]! + (miles[i + 1]! - miles[i]!) * f,
    state: parked ? 'stopped' : 'driving',
  };
}

/** Coordinates of the route between two mileposts (boundary points interpolated). */
export function sliceByMiles(route: Route, from: number, to: number): LngLat[] {
  const { coordinates, miles } = route.path;
  if (to <= from) return [];
  const at = (m: number): LngLat => {
    const i = bracket(miles, m);
    const span = miles[i + 1]! - miles[i]!;
    return lerpCoord(coordinates[i]!, coordinates[i + 1]!, span > 0 ? (m - miles[i]!) / span : 0);
  };
  const out: LngLat[] = [at(from)];
  for (let i = 0; i < miles.length; i++) {
    if (miles[i]! > from && miles[i]! < to) out.push(coordinates[i]!);
  }
  out.push(at(to));
  return out;
}

export interface RiskRun {
  level: RiskLevel;
  from: number;
  to: number;
  coordinates: LngLat[];
}

/** Merge consecutive checkpoint spans of equal risk and cut the polyline into those runs. */
export function riskRuns(route: Route): RiskRun[] {
  const runs: { level: RiskLevel; from: number; to: number }[] = [];
  for (const cp of route.checkpoints) {
    const [from, to] = cp.span;
    if (to <= from) continue;
    const prev = runs[runs.length - 1];
    if (prev && prev.level === cp.risk.level && Math.abs(prev.to - from) < 1e-6) prev.to = to;
    else runs.push({ level: cp.risk.level, from, to });
  }
  return runs.map((r) => ({ ...r, coordinates: sliceByMiles(route, r.from, r.to) }));
}

/** Greedy chip placement: far from the other routes and from chips already placed. */
export function labelAnchors(routes: Route[]): Record<string, LngLat> {
  const samples = routes.map((r) => sampleEvery(r, Math.max(r.distance_mi / 80, 1)));
  const [sw, ne] = boundsOf(routes);
  const wanted = Math.max(haversineMi(sw, ne) * 0.28, 1);
  const placed: LngLat[] = [];
  const anchors: Record<string, LngLat> = {};
  routes.forEach((route, idx) => {
    const own = samples[idx]!;
    const others = samples.filter((_, j) => j !== idx).flat();
    let best: LngLat = own[Math.floor(own.length / 2)]!;
    let bestScore = -Infinity;
    const lo = Math.floor(own.length * 0.2);
    const hi = Math.max(Math.ceil(own.length * 0.8), lo + 1);
    for (let i = lo; i < hi && i < own.length; i++) {
      const p = own[i]!;
      let nearRoute = Infinity;
      for (const q of others) nearRoute = Math.min(nearRoute, haversineMi(p, q));
      let nearChip = Infinity;
      for (const q of placed) nearChip = Math.min(nearChip, haversineMi(p, q));
      const routeScore = others.length ? Math.min(nearRoute, wanted) / wanted : 1;
      const chipScore = placed.length ? Math.min(nearChip, wanted) / wanted : 1;
      const centrality = 1 - Math.abs(i / own.length - 0.5);
      const score = 2 * chipScore + routeScore + 0.3 * centrality;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    anchors[route.id] = best;
    placed.push(best);
  });
  return anchors;
}

function sampleEvery(route: Route, stepMi: number): LngLat[] {
  const out: LngLat[] = [];
  const total = route.path.miles[route.path.miles.length - 1] ?? 0;
  for (let m = 0; m <= total; m += stepMi) out.push(pointAtMile(route, m));
  return out;
}

export function pointAtMile(route: Route, mile: number): LngLat {
  const { coordinates, miles } = route.path;
  const i = bracket(miles, mile);
  const span = miles[i + 1]! - miles[i]!;
  return lerpCoord(coordinates[i]!, coordinates[i + 1]!, span > 0 ? (mile - miles[i]!) / span : 0);
}

/** Evenly thin a polyline to at most `max` points, always keeping both ends. */
export function decimate<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

export function boundsOf(routes: Route[]): [LngLat, LngLat] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const r of routes) {
    for (const [lon, lat] of r.path.coordinates) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [
    [w, s],
    [e, n],
  ];
}

/** The checkpoint whose span contains `mile`. */
export function checkpointAtMile(route: Route, mile: number): Checkpoint | undefined {
  return route.checkpoints.find((c) => mile >= c.span[0] && mile <= c.span[1]);
}
