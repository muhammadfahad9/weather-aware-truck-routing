/** HTML snippets for map popups and markers (escaped; kept pure so they are unit-testable). */
import type { Checkpoint, Route, Stop } from '../api/types';
import { formatDuration, formatMiles, formatOffset, formatTime } from '../lib/format';
import { RISK_COLORS, RISK_LABELS } from '../lib/risk';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FACTOR_LABEL = { wind: 'Wind', rain: 'Rain', snow: 'Snow' } as const;

export function riskPill(level: number): string {
  const l = Math.max(0, Math.min(4, level)) as 0 | 1 | 2 | 3 | 4;
  return `<span class="risk-pill risk-${l}"><i style="background:${RISK_COLORS[l]}"></i>${RISK_LABELS[l]}</span>`;
}

export function checkpointPopupHtml(route: Route, cp: Checkpoint, departureIso: string): string {
  const c = cp.conditions;
  const hours = (new Date(cp.eta).getTime() - new Date(departureIso).getTime()) / 3_600_000;
  const drivers = cp.risk.drivers.map((d) => FACTOR_LABEL[d]).join(' + ');
  const escalated = cp.risk.factors.some((f) => f.load_escalated);
  const rows = [
    [
      'Wind',
      `${c.wind_mph.toFixed(1)} mph <span class="muted">gusts ${c.gust_mph.toFixed(1)}</span>`,
    ],
    ['Rain', `${c.rain_in_hr.toFixed(2)} in/hr`],
    ['Snow', `${c.snow_in_hr.toFixed(2)} in/hr`],
  ];
  if (c.temperature_f !== null) rows.push(['Temp', `${c.temperature_f}°F`]);
  return `
    <div class="popup">
      <div class="popup-title">${escapeHtml(route.name)} · Mile ${Math.round(cp.mile)}</div>
      <div class="popup-sub">ETA ${escapeHtml(formatTime(cp.eta, true))} <span class="muted">${formatOffset(hours)}</span></div>
      <div class="popup-risk">${riskPill(cp.risk.level)}${
        drivers ? `<span class="muted">from ${escapeHtml(drivers)}</span>` : ''
      }</div>
      ${escalated ? '<div class="popup-note">Load rule applied: wind risk raised for this load weight.</div>' : ''}
      <table class="popup-table">${rows
        .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
        .join('')}</table>
      ${c.summary ? `<div class="popup-foot">${escapeHtml(c.summary)}</div>` : ''}
    </div>`;
}

export function stopTitle(stop: Stop): string {
  const what = stop.kind === 'rest' ? '10-hour rest (HOS)' : '30-minute break (HOS)';
  return `${what} near mile ${Math.round(stop.mile)} · ${formatTime(stop.arrive_time)} – ${formatTime(stop.depart_time)}`;
}

const ICONS = {
  break:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8zm12 1h1.5a2.5 2.5 0 0 1 0 5H16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  rest: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18V7m0 7h18v4m0-4v-2a3 3 0 0 0-3-3h-7v5M7.5 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export function stopMarkerHtml(stop: Stop): string {
  return ICONS[stop.kind];
}

export function routeChipHtml(route: Route, selected: boolean): string {
  const lvl = route.risk.max_level;
  return `
    <span class="chip-letter">${escapeHtml(route.id)}</span>
    <span class="chip-body">
      <span class="chip-main">${formatDuration(route.total_time_s)} · ${formatMiles(route.distance_mi)}</span>
      <span class="chip-risk"><i style="background:${RISK_COLORS[lvl]}"></i>${
        lvl === 0 ? 'Low risk' : `${RISK_LABELS[lvl]} max`
      }${route.recommended ? ' · <b>Recommended</b>' : ''}</span>
    </span>
    ${selected ? '<span class="sr-only">(selected)</span>' : ''}`;
}
