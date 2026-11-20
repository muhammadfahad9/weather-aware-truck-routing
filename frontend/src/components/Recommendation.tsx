import { useState } from 'react';

import type { CriterionKey, PlanResponse, Stage } from '../api/types';
import { formatDuration } from '../lib/format';
import { Icon } from './icons';

const CRITERIA: { key: CriterionKey; label: string }[] = [
  { key: 'no_travel_mi', label: 'No Travel miles' },
  { key: 'severe_mi', label: 'Severe miles' },
  { key: 'high_mi', label: 'High miles' },
  { key: 'avg_risk', label: 'Avg risk (0–4)' },
  { key: 'travel_time_s', label: 'Travel time' },
];

function formatValue(key: CriterionKey, v: number): string {
  if (key === 'travel_time_s') return formatDuration(v);
  if (key === 'avg_risk') return v.toFixed(2);
  return v.toFixed(1);
}

function rawValue(plan: PlanResponse, routeId: string, key: CriterionKey): number {
  const r = plan.routes.find((x) => x.id === routeId)!;
  switch (key) {
    case 'no_travel_mi':
      return r.risk.miles_by_level.no_travel;
    case 'severe_mi':
      return r.risk.miles_by_level.severe;
    case 'high_mi':
      return r.risk.miles_by_level.high;
    case 'avg_risk':
      return r.risk.avg_risk;
    case 'travel_time_s':
      return r.total_time_s;
  }
}

/** Recommended route, the reasons, and the criterion-by-criterion comparison. */
export function RecommendationCard({ plan }: { plan: PlanResponse }) {
  const [open, setOpen] = useState(false);
  const rec = plan.recommendation;
  const winner = plan.routes.find((r) => r.id === rec.route_id)!;
  const ids = plan.routes.map((r) => r.id);
  const stageByKey = new Map<CriterionKey, Stage>(rec.stages.map((s) => [s.criterion, s]));
  // Routes still in contention when each criterion was reached.
  const eliminatedAt = new Map<string, CriterionKey>();
  for (const s of rec.stages) for (const id of s.eliminated) eliminatedAt.set(id, s.criterion);
  const order = CRITERIA.map((c) => c.key);

  const viaText = winner.via.length ? ` via ${winner.via.join(' · ')}` : '';
  return (
    <section className="card rec" aria-labelledby="rec-title">
      <div className="rec-head">
        <span className="rec-icon" aria-hidden="true">
          {Icon.check}
        </span>
        <div>
          <div className="rec-badge">Recommended</div>
          <h2 className="rec-title" id="rec-title">
            {winner.name}
            <span className="muted" style={{ fontWeight: 500, fontSize: 14 }}>
              {viaText}
            </span>
          </h2>
        </div>
      </div>
      {rec.reasons.length > 0 ? (
        <ul className="rec-reasons">
          {rec.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="rec-reasons" style={{ listStyle: 'none', paddingLeft: 0 }}>
          Only one distinct route is available for this trip.
        </p>
      )}
      {ids.length > 1 && (
        <>
          <button
            type="button"
            className="btn-link"
            style={{ marginTop: 10 }}
            aria-expanded={open}
            aria-controls="decision-funnel"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide' : 'Show'} how routes were compared
          </button>
          {open && (
            <table className="funnel" id="decision-funnel">
              <caption className="sr-only">
                Routes compared criterion by criterion in priority order
              </caption>
              <thead>
                <tr>
                  <th scope="col">Priority</th>
                  {ids.map((id) => (
                    <th scope="col" key={id}>
                      {id}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CRITERIA.map((c, ci) => {
                  const stage = stageByKey.get(c.key);
                  return (
                    <tr
                      key={c.key}
                      className={rec.deciding_criterion === c.key ? 'is-decider' : undefined}
                    >
                      <th scope="row">
                        {ci + 1}. {c.label}
                      </th>
                      {ids.map((id) => {
                        const out = eliminatedAt.get(id);
                        const gone = out !== undefined && order.indexOf(out) < ci;
                        const cls = gone
                          ? 'is-gone'
                          : stage?.eliminated.includes(id)
                            ? 'is-out'
                            : stage?.kept.includes(id)
                              ? 'is-best'
                              : undefined;
                        return (
                          <td key={id} className={`num ${cls ?? ''}`}>
                            {formatValue(c.key, stage?.values[id] ?? rawValue(plan, id, c.key))}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
