import type { PlanResponse, Route } from '../api/types';
import { MAX_HOURS } from '../state/constants';
import { formatDay } from './format';
import { bracket } from './routeGeometry';

/** Wall-clock seconds after departure when the truck reaches `mile` (arrival side of stops). */
export function elapsedAtMile(route: Route, mile: number): number {
  const { miles, elapsed_s: elapsed } = route.path;
  const i = bracket(miles, mile);
  const span = miles[i + 1]! - miles[i]!;
  const f = span > 0 ? (mile - miles[i]!) / span : 0;
  return elapsed[i]! + (elapsed[i + 1]! - elapsed[i]!) * f;
}

/** Day boundaries and route arrivals above the slider; nearby arrivals share one label. */
export function trackMarks(plan: PlanResponse) {
  const departure = new Date(plan.inputs.departure_time);
  const arrivals = plan.routes
    .map((r) => ({ id: r.id, hours: r.total_time_s / 3600 }))
    .filter((a) => a.hours <= MAX_HOURS)
    .sort((a, b) => a.hours - b.hours);
  const groups: { hours: number; ids: string[] }[] = [];
  for (const a of arrivals) {
    const last = groups[groups.length - 1];
    if (last && a.hours - last.hours < MAX_HOURS * 0.06) last.ids.push(a.id);
    else groups.push({ hours: a.hours, ids: [a.id] });
  }
  const out: { key: string; hours: number; label: string; arrival?: boolean }[] = groups.map(
    (g) => ({
      key: `arr-${g.ids.join('')}`,
      hours: g.hours,
      label: `${g.ids.join(' · ')} ${g.ids.length > 1 ? 'arrive' : 'arrives'}`,
      arrival: true,
    }),
  );
  const midnight = new Date(departure);
  midnight.setHours(24, 0, 0, 0);
  for (let d = midnight; d.getTime() - departure.getTime() <= MAX_HOURS * 3_600_000; ) {
    const hours = (d.getTime() - departure.getTime()) / 3_600_000;
    // Arrival labels win over day labels when they would collide.
    if (!groups.some((g) => Math.abs(g.hours - hours) < MAX_HOURS * 0.12)) {
      out.push({ key: d.toISOString(), hours, label: formatDay(d) });
    }
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}
