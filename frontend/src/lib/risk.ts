// Risk classifier driven by the `rules` the API returns. Mirrors backend/planner/domain/risk.py
// and is checked against the same vectors in /shared/risk_vectors.json.
import type { ConditionRule, Factor, RiskLevel, RiskRules, WindBasis } from '../api/types';

export const RISK_LEVELS: readonly RiskLevel[] = [0, 1, 2, 3, 4];
export const RISK_LABELS = ['Low', 'Moderate', 'High', 'Severe', 'No Travel'] as const;
export const RISK_KEYS = ['low', 'moderate', 'high', 'severe', 'no_travel'] as const;

// Ordinal palette, CVD-checked (worst ΔE 10.8). Always shown with a text label.
export const RISK_COLORS = ['#1f9e89', '#f6c90e', '#f37021', '#c9283e', '#6a1b9a'] as const;

/** Readable ink on a solid risk fill (WCAG AA). */
export const RISK_INK = ['#0b2622', '#1a1a1a', '#1a1a1a', '#ffffff', '#ffffff'] as const;

export function roundHalfUp(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.floor(value * factor + 0.5) / factor;
}

function normalize(rule: ConditionRule, value: number): number {
  return roundHalfUp(Math.max(value, 0), rule.precision);
}

function classifyNormalized(rule: ConditionRule, v: number): RiskLevel {
  let level: RiskLevel = 0;
  for (const t of rule.thresholds) {
    if (t.inclusive ? v >= t.value : v > t.value) level = t.level;
  }
  return level;
}

export function classifyCondition(rule: ConditionRule, value: number): RiskLevel {
  return classifyNormalized(rule, normalize(rule, value));
}

export interface FactorResult {
  factor: Factor;
  value: number;
  baseLevel: RiskLevel;
  level: RiskLevel;
  loadEscalated: boolean;
}

export interface Assessment {
  level: RiskLevel;
  factors: FactorResult[];
  drivers: Factor[];
}

export interface ConditionsInput {
  wind: number;
  gust: number;
  rain: number;
  snow: number;
}

/** Builds a fast `(wind, rain, snow) => level` function for a given load (heatmap hot path). */
export function makeLevelFn(rules: RiskRules, loadLb: number) {
  const { wind: windRule, rain: rainRule, snow: snowRule } = rules.conditions;
  const loadRules = rules.load_rules.filter((r) => loadLb > r.load_over_lb);
  return (wind: number, rain: number, snow: number): RiskLevel => {
    const w = normalize(windRule, wind);
    let level = classifyNormalized(windRule, w);
    for (const r of loadRules) {
      if (w >= r.wind_min_mph && w < r.wind_max_mph && r.level > level) level = r.level;
    }
    const rl = classifyNormalized(rainRule, normalize(rainRule, rain));
    const sl = classifyNormalized(snowRule, normalize(snowRule, snow));
    return Math.max(level, rl, sl) as RiskLevel;
  };
}

export interface LevelTables {
  wind: Uint8Array;
  rain: Uint8Array;
  snow: Uint8Array;
  windScale: number;
  rainScale: number;
  snowScale: number;
}

/**
 * Per-factor lookup tables indexed by the value at display precision, built with the real
 * classifier, so lookups match `makeLevelFn` exactly. Out-of-range values clamp to the top level.
 */
export function makeLevelTables(rules: RiskRules, loadLb: number): LevelTables {
  const levelFn = makeLevelFn(rules, loadLb);
  const { wind: w, rain: r, snow: s } = rules.conditions;
  const build = (precision: number, maxValue: number, f: (v: number) => RiskLevel) => {
    const scale = 10 ** precision;
    const table = new Uint8Array(Math.ceil(maxValue * scale) + 1);
    for (let k = 0; k < table.length; k++) table[k] = f(k / scale);
    return { table, scale };
  };
  const top = (rule: ConditionRule) => rule.thresholds[rule.thresholds.length - 1]!.value * 1.5 + 1;
  const wt = build(w.precision, top(w), (v) => levelFn(v, 0, 0));
  const rt = build(r.precision, top(r), (v) => levelFn(0, v, 0));
  const st = build(s.precision, top(s), (v) => levelFn(0, 0, v));
  return {
    wind: wt.table,
    rain: rt.table,
    snow: st.table,
    windScale: wt.scale,
    rainScale: rt.scale,
    snowScale: st.scale,
  };
}

export function levelFromTables(
  t: LevelTables,
  wind: number,
  rain: number,
  snow: number,
): RiskLevel {
  const lookup = (table: Uint8Array, scale: number, v: number) => {
    const k = Math.floor(Math.max(v, 0) * scale + 0.5);
    return table[k < table.length ? k : table.length - 1]!;
  };
  return Math.max(
    lookup(t.wind, t.windScale, wind),
    lookup(t.rain, t.rainScale, rain),
    lookup(t.snow, t.snowScale, snow),
  ) as RiskLevel;
}

export function assess(
  rules: RiskRules,
  c: ConditionsInput,
  loadLb: number,
  basis: WindBasis,
): Assessment {
  const windRule = rules.conditions.wind;
  const windValue = normalize(windRule, basis === 'gust' ? c.gust : c.wind);
  const windBase = classifyNormalized(windRule, windValue);
  let windLevel = windBase;
  for (const r of rules.load_rules) {
    if (windValue >= r.wind_min_mph && windValue < r.wind_max_mph && loadLb > r.load_over_lb) {
      windLevel = Math.max(windLevel, r.level) as RiskLevel;
    }
  }
  const simple = (factor: 'rain' | 'snow', raw: number): FactorResult => {
    const rule = rules.conditions[factor];
    const value = normalize(rule, raw);
    const level = classifyNormalized(rule, value);
    return { factor, value, baseLevel: level, level, loadEscalated: false };
  };
  const factors: FactorResult[] = [
    {
      factor: 'wind',
      value: windValue,
      baseLevel: windBase,
      level: windLevel,
      loadEscalated: windLevel > windBase,
    },
    simple('rain', c.rain),
    simple('snow', c.snow),
  ];
  const level = Math.max(...factors.map((f) => f.level)) as RiskLevel;
  const drivers = level === 0 ? [] : factors.filter((f) => f.level === level).map((f) => f.factor);
  return { level, factors, drivers };
}

export function riskLabel(level: RiskLevel): string {
  return RISK_LABELS[level];
}

/** Human summary of the thresholds for a factor, e.g. "Moderate ≥ 25 mph". */
export function thresholdText(rules: RiskRules, factor: Factor): string[] {
  const rule = rules.conditions[factor];
  return rule.thresholds.map(
    (t) => `${RISK_LABELS[t.level]} ${t.inclusive ? '≥' : '>'} ${t.value} ${rule.unit}`,
  );
}
