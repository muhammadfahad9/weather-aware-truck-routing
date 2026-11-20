import { useState } from 'react';

import type { Route } from '../api/types';
import { formatTime } from '../lib/format';
import { useAppStore } from '../state/store';
import { RiskPill } from './risk';

const DRIVER = { wind: 'wind', rain: 'rain', snow: 'snow' } as const;

/** Every checkpoint on the selected route; doubles as the map's accessible table view. */
export function CheckpointTable({
  route,
  windBasis,
}: {
  route: Route;
  windBasis: 'sustained' | 'gust';
}) {
  const focusCheckpoint = useAppStore((s) => s.focusCheckpoint);
  const hoverCheckpoint = useAppStore((s) => s.hoverCheckpoint);
  const clearCheckpointHover = useAppStore((s) => s.clearCheckpointHover);
  const focused = useAppStore((s) =>
    s.focusedCheckpoint?.routeId === route.id ? s.focusedCheckpoint.index : null,
  );
  const [onlyRisky, setOnlyRisky] = useState(false);
  const rows = onlyRisky ? route.checkpoints.filter((c) => c.risk.level > 0) : route.checkpoints;
  const risky = route.checkpoints.filter((c) => c.risk.level > 0).length;

  return (
    <div>
      <div className="cp-tools">
        <span>
          {route.checkpoints.length} checkpoints · {risky} above Low
        </span>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={onlyRisky}
            onChange={(e) => setOnlyRisky(e.target.checked)}
          />
          Only Moderate+
        </label>
      </div>
      <div className="cp-table-wrap">
        <table className="cp-table" aria-label={`Checkpoints on ${route.name}`}>
          <thead>
            <tr>
              <th scope="col">Mile</th>
              <th scope="col">ETA</th>
              <th
                scope="col"
                title={
                  windBasis === 'gust' ? 'Gusts drive the wind risk' : 'Sustained wind (gusts)'
                }
              >
                Wind
              </th>
              <th scope="col">Rain</th>
              <th scope="col">Snow</th>
              <th scope="col">Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No checkpoints above Low risk.
                </td>
              </tr>
            )}
            {rows.map((c) => {
              const escalated = c.risk.factors.some((f) => f.load_escalated);
              const w = c.conditions;
              return (
                <tr
                  key={c.index}
                  aria-selected={focused === c.index}
                  tabIndex={0}
                  onClick={() => focusCheckpoint(route.id, c.index)}
                  onMouseEnter={() => hoverCheckpoint(route.id, c.index)}
                  onMouseLeave={clearCheckpointHover}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      focusCheckpoint(route.id, c.index);
                    }
                  }}
                >
                  <td>{Math.round(c.mile)}</td>
                  <td>{formatTime(c.eta)}</td>
                  <td>
                    {w.wind_mph.toFixed(1)}
                    <span className="muted"> ({w.gust_mph.toFixed(1)})</span>
                  </td>
                  <td>{w.rain_in_hr.toFixed(2)}</td>
                  <td>{w.snow_in_hr.toFixed(2)}</td>
                  <td>
                    <RiskPill level={c.risk.level} />
                    {escalated && (
                      <span
                        className="cp-escalated"
                        title="Wind risk raised by the load-weight rule"
                      >
                        LOAD
                      </span>
                    )}
                    {c.risk.drivers.length > 0 && (
                      <span className="sr-only">
                        {' '}
                        due to {c.risk.drivers.map((d) => DRIVER[d]).join(' and ')}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="field-hint" style={{ marginTop: 6 }}>
        Wind in mph (gusts in brackets), rain and snow in in/hr — each read at the truck’s ETA.
      </p>
    </div>
  );
}
