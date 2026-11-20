import samplingVectors from '../../../shared/sampling_vectors.json';
import type { HeatmapResponse } from '../api/types';
import heatmapFixture from '../test/fixtures/heatmap.json';
import {
  allocCellValues,
  frameIndex,
  framesFromResponse,
  sampleCells,
  type FieldFrames,
} from './sampling';

function singleCell(): FieldFrames {
  const s = samplingVectors.series;
  return {
    startTs: s.start_ts,
    stepS: 3600,
    frames: s.wind.length,
    cells: 1,
    wind: Float64Array.from(s.wind),
    gust: Float64Array.from(s.gust),
    rain: Float64Array.from(s.rain),
    snow: Float64Array.from(s.snow),
  };
}

describe('shared sampling vectors (parity with HourlySeries.at)', () => {
  it.each(samplingVectors.cases.map((c) => [c.offset_s, c] as const))('t+%is', (_o, c) => {
    const f = singleCell();
    const out = allocCellValues(1);
    sampleCells(f, f.startTs + c.offset_s, out);
    expect(out.wind[0]).toBeCloseTo(c.wind, 9);
    expect(out.gust[0]).toBeCloseTo(c.gust, 9);
    expect(out.rain[0]).toBeCloseTo(c.rain, 9);
    expect(out.snow[0]).toBeCloseTo(c.snow, 9);
  });
});

describe('frameIndex', () => {
  const f = { startTs: 0, stepS: 3600, frames: 3 };
  it('clamps before the window and after it', () => {
    expect(frameIndex(f, -100)).toEqual({ i0: 0, i1: 1, frac: 0, bucket: 0 });
    expect(frameIndex(f, 99_999)).toEqual({ i0: 2, i1: 2, frac: 0, bucket: 2 });
  });
  it('uses the bucket ending at ceil(t)', () => {
    expect(frameIndex(f, 3600).bucket).toBe(1);
    expect(frameIndex(f, 3601).bucket).toBe(2);
  });
});

describe('framesFromResponse', () => {
  it('builds frame-major typed arrays from the API payload', () => {
    const res = heatmapFixture as unknown as HeatmapResponse;
    const f = framesFromResponse(res);
    expect(f.cells).toBe(res.cells.length);
    expect(f.frames).toBe(res.frames);
    expect(f.wind).toBeInstanceOf(Float64Array);
    expect(f.wind.length).toBe(res.frames * res.cells.length);
    const out = allocCellValues(f.cells);
    sampleCells(f, f.startTs + 2 * 3600, out);
    expect(out.wind[5]).toBe(res.fields.wind[2 * f.cells + 5]);
  });
});
