import type { CSSProperties } from 'react';

import type { MilesByLevel, RiskLevel } from '../api/types';
import { formatNumber } from '../lib/format';
import { RISK_COLORS, RISK_KEYS, RISK_LABELS } from '../lib/risk';

export function RiskPill({ level }: { level: RiskLevel }) {
  return (
    <span className={`risk-pill risk-${level}`}>
      <i style={{ background: RISK_COLORS[level] }} aria-hidden="true" />
      {RISK_LABELS[level]}
    </span>
  );
}

/** Stacked bar of miles per risk level, with direct labels for every non-zero level. */
export function RiskBar({ miles, total }: { miles: MilesByLevel; total: number }) {
  const parts = RISK_KEYS.map((key, level) => ({
    key,
    level: level as RiskLevel,
    mi: miles[key],
  })).filter((p) => p.mi > 0);
  const summary = parts.map((p) => `${RISK_LABELS[p.level]} ${formatNumber(p.mi)} mi`).join(', ');
  return (
    <div>
      <div className="riskbar" role="img" aria-label={`Miles by risk level: ${summary}`}>
        {parts.map((p) => (
          <span
            key={p.key}
            title={`${RISK_LABELS[p.level]}: ${formatNumber(p.mi, 1)} mi (${Math.round((p.mi / total) * 100)}%)`}
            style={
              {
                flexGrow: p.mi,
                flexBasis: 0,
                background: RISK_COLORS[p.level],
                '--i': p.level,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="risk-legend" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key}>
            <i style={{ background: RISK_COLORS[p.level] }} />
            {RISK_LABELS[p.level]} <b className="num">{formatNumber(p.mi)}</b> mi
          </span>
        ))}
      </div>
    </div>
  );
}
