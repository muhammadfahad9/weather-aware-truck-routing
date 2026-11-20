import type { Grid, HeatmapResponse, RiskRules } from '../api/types';
import heatmapFixture from '../test/fixtures/heatmap.json';
import planFixture from '../test/fixtures/plan.json';
import { buildLut, METRIC_SCALES, RISK_ALPHA, RISK_RGB } from './colors';
import {
  buildRasterGeometry,
  invMercY,
  mercY,
  nodeToCellIndex,
  renderRaster,
  sampleAt,
  type RenderOptions,
} from './heatmapRaster';
import { makeLevelTables } from './risk';
import { allocCellValues, type CellValues } from './sampling';

const rules = (planFixture as unknown as { rules: RiskRules }).rules;

// 4 x 3 lattice, every node inside the corridor except the top-right one.
const grid: Grid = {
  lat0: 35,
  lon0: -100,
  dlat: 1,
  dlon: 1,
  nx: 4,
  ny: 3,
  spacing_mi: 69,
  half_width_mi: 40,
};
const cells = Array.from({ length: 11 }, (_, i) => i); // node 11 (top-right) excluded

function uniform(n: number, wind: number, rain = 0, snow = 0): CellValues {
  const v = allocCellValues(n);
  v.wind.fill(wind);
  v.gust.fill(wind * 1.5);
  v.rain.fill(rain);
  v.snow.fill(snow);
  return v;
}

function options(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    metric: 'risk',
    useGusts: false,
    tables: makeLevelTables(rules, 20_000),
    luts: {
      wind: buildLut(METRIC_SCALES.wind.ramp),
      rain: buildLut(METRIC_SCALES.rain.ramp),
      snow: buildLut(METRIC_SCALES.snow.ramp),
    },
    maxima: { wind: 60, rain: 1.2, snow: 3.5 },
    opacity: 1,
    ...overrides,
  };
}

describe('mercator helpers', () => {
  it('are inverses', () => {
    for (const lat of [-60, -10, 0, 33.3, 47.9]) expect(invMercY(mercY(lat))).toBeCloseTo(lat, 9);
  });
});

describe('buildRasterGeometry', () => {
  const geo = buildRasterGeometry(grid, cells, 64);

  it('spans the lattice and keeps the map aspect ratio', () => {
    expect(geo.coordinates).toEqual([
      [-100, 37],
      [-97, 37],
      [-97, 35],
      [-100, 35],
    ]);
    expect(geo.width).toBe(64);
    const aspect = (3 * Math.PI) / 180 / (mercY(37) - mercY(35));
    expect(geo.height).toBe(Math.round(64 / aspect));
  });

  it('maps nodes to cells', () => {
    const map = nodeToCellIndex(grid, cells);
    expect(Array.from(map)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1]);
  });

  it('puts interior pixels first with weights summing to one', () => {
    expect(geo.interiorCount).toBeGreaterThan(0);
    expect(geo.interiorCount).toBeLessThan(geo.active.length);
    for (let i = 0; i < geo.active.length; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += geo.weights[i * 4 + k]!;
      if (i < geo.interiorCount) {
        expect(sum).toBeCloseTo(1, 5);
        for (let k = 0; k < 4; k++) expect(geo.corners[i * 4 + k]).toBeGreaterThanOrEqual(0);
      } else {
        expect(sum).toBeLessThan(1);
      }
    }
  });

  it('skips pixels with no corridor data at all', () => {
    // Only the two left columns are in the corridor: the right-most lattice square has no
    // valid corner, so its pixels never enter the work list.
    const left = buildRasterGeometry(grid, [0, 1, 4, 5, 8, 9], 64);
    const active = new Set(left.active);
    expect(active.has(left.width - 1)).toBe(false); // top-right pixel
    expect(active.has(0)).toBe(true); // top-left pixel
  });
});

describe('renderRaster', () => {
  const geo = buildRasterGeometry(grid, cells, 48);
  const px = (out: Uint8ClampedArray, i: number) => Array.from(out.slice(i * 4, i * 4 + 4));

  it('paints a uniform calm field in the Low colour at the Low alpha', () => {
    const out = new Uint8ClampedArray(geo.width * geo.height * 4);
    renderRaster(geo, uniform(11, 5), out, options());
    const interior = geo.active[0]!;
    const [r, g, b, a] = px(out, interior);
    expect([r, g, b]).toEqual(RISK_RGB[0]);
    expect(a).toBeCloseTo(255 * RISK_ALPHA[0], -1);
  });

  it('classifies interpolated weather with the load rules', () => {
    const out = new Uint8ClampedArray(geo.width * geo.height * 4);
    // 40 mph: High for a light load, Severe above 40,000 lb.
    renderRaster(geo, uniform(11, 40), out, options());
    expect(px(out, geo.active[0]!).slice(0, 3)).toEqual(RISK_RGB[2]);
    renderRaster(geo, uniform(11, 40), out, options({ tables: makeLevelTables(rules, 45_000) }));
    expect(px(out, geo.active[0]!).slice(0, 3)).toEqual(RISK_RGB[3]);
  });

  it('uses gusts when asked', () => {
    const out = new Uint8ClampedArray(geo.width * geo.height * 4);
    renderRaster(geo, uniform(11, 20), out, options({ useGusts: true })); // gust 30 -> Moderate
    expect(px(out, geo.active[0]!).slice(0, 3)).toEqual(RISK_RGB[1]);
  });

  it('feathers the corridor edge', () => {
    const out = new Uint8ClampedArray(geo.width * geo.height * 4);
    renderRaster(geo, uniform(11, 5), out, options());
    const interiorAlpha = px(out, geo.active[0]!)[3]!;
    const edgeAlphas = Array.from(geo.active.slice(geo.interiorCount)).map((p) => px(out, p)[3]!);
    expect(Math.min(...edgeAlphas)).toBeLessThan(interiorAlpha);
    expect(Math.max(...edgeAlphas)).toBeLessThanOrEqual(interiorAlpha);
  });

  it('maps continuous metrics through the LUT and scales opacity', () => {
    const out = new Uint8ClampedArray(geo.width * geo.height * 4);
    const lut = buildLut(METRIC_SCALES.wind.ramp);
    renderRaster(geo, uniform(11, 60), out, options({ metric: 'wind', opacity: 0.5 }));
    const [r, g, b, a] = px(out, geo.active[0]!);
    expect([r, g, b]).toEqual(Array.from(lut.slice(255 * 4, 255 * 4 + 3)));
    expect(a).toBeCloseTo(lut[255 * 4 + 3]! * 0.5, -1);
    renderRaster(geo, uniform(11, 0, 0.6), out, options({ metric: 'rain' }));
    expect(px(out, geo.active[0]!)[3]).toBeGreaterThan(0);
  });

  it('runs fast enough for scrubbing on a real-sized corridor', () => {
    const res = heatmapFixture as unknown as HeatmapResponse;
    const big = buildRasterGeometry(res.grid, res.cells);
    const out = new Uint8ClampedArray(big.width * big.height * 4);
    const v = uniform(res.cells.length, 30, 0.2, 0.1);
    renderRaster(big, v, out, options()); // warm-up
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) renderRaster(big, v, out, options());
    expect((performance.now() - t0) / 10).toBeLessThan(25);
  });
});

describe('sampleAt', () => {
  const map = nodeToCellIndex(grid, cells);
  it('bilinearly interpolates between nodes', () => {
    const v = allocCellValues(11);
    for (let i = 0; i < 11; i++) v.wind[i] = i; // node index as value
    const s = sampleAt(grid, map, v, 35.5, -99.5)!; // centre of nodes 0,1,4,5
    expect(s.wind).toBeCloseTo((0 + 1 + 4 + 5) / 4);
    expect(s.coverage).toBeCloseTo(1);
  });
  it('renormalises around missing nodes and rejects points outside the grid', () => {
    const v = uniform(11, 12);
    const s = sampleAt(grid, map, v, 36.9, -97.1)!; // next to the excluded corner
    expect(s.wind).toBeCloseTo(12);
    expect(s.coverage).toBeLessThan(1);
    expect(sampleAt(grid, map, v, 50, -100)).toBeNull();
  });
});
