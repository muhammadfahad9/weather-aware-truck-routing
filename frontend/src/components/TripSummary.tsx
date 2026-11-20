import type { PlanResponse } from '../api/types';
import { formatLoad, formatTime } from '../lib/format';

/** Compact read-only view of the planned trip (the form collapses into this after planning). */
export function TripSummary({ plan, onEdit }: { plan: PlanResponse; onEdit: () => void }) {
  const i = plan.inputs;
  const short = (label: string) => label.split(',').slice(0, 2).join(',') || 'Pinned location';
  const facts = [
    `Departs ${formatTime(i.departure_time, true)}`,
    formatLoad(i.load_weight_lb),
    `checkpoint every ${i.interval_miles} mi`,
    i.hos_breaks ? 'HOS rest stops' : 'no rest stops',
    i.wind_basis === 'gust' ? 'gust-based wind risk' : null,
  ].filter(Boolean);
  return (
    <section className="card trip-summary" aria-label="Planned trip">
      <div className="trip-summary-route">
        <span className="place-dot is-origin" aria-hidden="true" />
        <span>{short(i.origin.label)}</span>
        <span className="muted" aria-hidden="true">
          →
        </span>
        <span className="place-dot is-destination" aria-hidden="true" />
        <span>{short(i.destination.label)}</span>
      </div>
      <div className="trip-summary-facts">{facts.join(' · ')}</div>
      <button type="button" className="btn btn-ghost" onClick={onEdit}>
        Edit trip
      </button>
    </section>
  );
}
