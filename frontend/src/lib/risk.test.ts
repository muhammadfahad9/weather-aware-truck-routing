import riskVectors from '../../../shared/risk_vectors.json';
import type { RiskLevel, RiskRules, WindBasis } from '../api/types';
import planFixture from '../test/fixtures/plan.json';
import {
  assess,
  classifyCondition,
  levelFromTables,
  makeLevelFn,
  makeLevelTables,
  roundHalfUp,
  thresholdText,
} from './risk';

// The rules exactly as the API serves them.
const rules = (planFixture as unknown as { rules: RiskRules }).rules;

interface Vector {
  name: string;
  wind: number;
  gust: number;
  rain: number;
  snow: number;
  load: number;
  basis?: WindBasis;
  level: RiskLevel;
  drivers: string[];
  load_escalated?: boolean;
}

describe('shared risk vectors (parity with the Python classifier)', () => {
  it.each((riskVectors.cases as Vector[]).map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const basis = c.basis ?? 'sustained';
    const result = assess(rules, c, c.load, basis);
    expect(result.level).toBe(c.level);
    expect(result.drivers).toEqual(c.drivers);
    expect(result.factors[0]!.loadEscalated).toBe(c.load_escalated ?? false);

    const windValue = basis === 'gust' ? c.gust : c.wind;
    expect(makeLevelFn(rules, c.load)(windValue, c.rain, c.snow)).toBe(c.level);
    expect(levelFromTables(makeLevelTables(rules, c.load), windValue, c.rain, c.snow)).toBe(
      c.level,
    );
  });
});

describe('lookup tables', () => {
  it.each([0, 30_000, 30_001, 40_001, 80_000])(
    'agree with the classifier everywhere (load %i lb)',
    (load) => {
      const fn = makeLevelFn(rules, load);
      const tables = makeLevelTables(rules, load);
      for (let w = 0; w <= 90; w += 0.07) {
        expect(levelFromTables(tables, w, 0, 0)).toBe(fn(w, 0, 0));
      }
      for (let r = 0; r <= 2; r += 0.0037) {
        expect(levelFromTables(tables, 0, r, 0)).toBe(fn(0, r, 0));
      }
      for (let s = 0; s <= 6; s += 0.011) {
        expect(levelFromTables(tables, 0, 0, s)).toBe(fn(0, 0, s));
      }
    },
  );

  it('clamps values past the end of the table to the top level', () => {
    const tables = makeLevelTables(rules, 0);
    expect(levelFromTables(tables, 500, 0, 0)).toBe(4);
    expect(levelFromTables(tables, 0, 50, 0)).toBe(4);
    expect(levelFromTables(tables, 0, 0, 99)).toBe(4);
    expect(levelFromTables(tables, -5, -1, -1)).toBe(0);
  });
});

describe('helpers', () => {
  it('rounds half up like Python round_half_up', () => {
    expect(roundHalfUp(0.125, 2)).toBeCloseTo(0.13);
    expect(roundHalfUp(24.96, 1)).toBe(25);
    expect(roundHalfUp(0.095, 2)).toBe(0.1);
    expect(roundHalfUp(1.004, 2)).toBe(1);
  });

  it('classifies individual conditions', () => {
    expect(classifyCondition(rules.conditions.rain, 1.0)).toBe(3);
    expect(classifyCondition(rules.conditions.rain, 1.01)).toBe(4);
    expect(classifyCondition(rules.conditions.snow, 0.5)).toBe(1);
  });

  it('describes thresholds', () => {
    expect(thresholdText(rules, 'wind')).toEqual([
      'Moderate ≥ 25 mph',
      'High ≥ 35 mph',
      'Severe ≥ 45 mph',
      'No Travel ≥ 55 mph',
    ]);
    expect(thresholdText(rules, 'rain').at(-1)).toBe('No Travel > 1 in/hr');
  });
});
