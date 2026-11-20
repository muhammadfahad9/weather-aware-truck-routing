import type { CSSProperties } from 'react';

import type { Route } from '../api/types';
import { formatDuration, formatMiles, formatTime } from '../lib/format';
import { useAppStore } from '../state/store';
import { Icon } from './icons';
import { RiskBar, RiskPill } from './risk';

export function RouteCard({
  route,
  selected,
  index,
}: {
  route: Route;
  selected: boolean;
  index: number;
}) {
  const selectRoute = useAppStore((s) => s.selectRoute);
  const hoverRoute = useAppStore((s) => s.hoverRoute);
  const via = route.via.length
    ? `via ${route.via.join(' · ')}`
    : route.synthesized
      ? 'alternative corridor'
      : '';
  return (
    <button
      type="button"
      className="route-card rise"
      style={{ '--i': index + 3 } as CSSProperties}
      aria-pressed={selected}
      data-route-id={route.id}
      onClick={() => selectRoute(route.id)}
      onMouseEnter={() => hoverRoute(route.id)}
      onMouseLeave={() => hoverRoute(null)}
      onFocus={() => hoverRoute(route.id)}
      onBlur={() => hoverRoute(null)}
    >
      <div className="route-card-head">
        <span className="route-letter" aria-hidden="true">
          {route.id}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="route-name">{route.name}</div>
          {via && <div className="route-via">{via}</div>}
        </div>
        {route.recommended ? (
          <span className="tag">
            {Icon.star}
            Recommended
          </span>
        ) : (
          <span style={{ marginLeft: 'auto' }}>
            <RiskPill level={route.risk.max_level} />
          </span>
        )}
      </div>
      <div className="route-stats">
        <div className="stat">
          <span className="stat-label">Distance</span>
          <span className="stat-value">{formatMiles(route.distance_mi)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Total time</span>
          <span className="stat-value">{formatDuration(route.total_time_s)}</span>
          <span className="stat-sub">
            {formatDuration(route.drive_time_s)} driving
            {route.stop_time_s > 0 ? ` + ${formatDuration(route.stop_time_s)} rest` : ''}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Arrive</span>
          <span className="stat-value">{formatTime(route.arrival_time)}</span>
          <span className="stat-sub">avg risk {route.risk.avg_risk.toFixed(2)}</span>
        </div>
      </div>
      <RiskBar miles={route.risk.miles_by_level} total={route.distance_mi} />
    </button>
  );
}

export function RouteCards({ routes }: { routes: Route[] }) {
  const selectedId = useAppStore((s) => s.selectedRouteId);
  return (
    <div className="route-list" role="group" aria-label="Route options">
      {routes.map((r, i) => (
        <RouteCard key={r.id} route={r} index={i} selected={r.id === selectedId} />
      ))}
    </div>
  );
}
