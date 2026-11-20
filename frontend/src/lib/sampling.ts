// Hourly frames read at an arbitrary time, same rules as backend/planner/domain/weather.py:
// wind is interpolated, gust/rain/snow come from the hour bucket ending at ceil(t).
// Float64 keeps rounding identical to Python.
import type { HeatmapResponse } from '../api/types';

export interface FieldFrames {
  startTs: number;
  stepS: number;
  frames: number;
  cells: number;
  wind: Float64Array;
  gust: Float64Array;
  rain: Float64Array;
  snow: Float64Array;
}

export interface CellValues {
  wind: Float64Array;
  gust: Float64Array;
  rain: Float64Array;
  snow: Float64Array;
}

export function framesFromResponse(res: HeatmapResponse): FieldFrames {
  return {
    startTs: res.start_ts,
    stepS: res.step_s,
    frames: res.frames,
    cells: res.cells.length,
    wind: Float64Array.from(res.fields.wind),
    gust: Float64Array.from(res.fields.gust),
    rain: Float64Array.from(res.fields.rain),
    snow: Float64Array.from(res.fields.snow),
  };
}

export function allocCellValues(cells: number): CellValues {
  return {
    wind: new Float64Array(cells),
    gust: new Float64Array(cells),
    rain: new Float64Array(cells),
    snow: new Float64Array(cells),
  };
}

export interface FrameIndex {
  i0: number;
  i1: number;
  frac: number;
  bucket: number;
}

/** Frame indices for unix time `ts`, clamped to the available window. */
export function frameIndex(
  f: Pick<FieldFrames, 'startTs' | 'stepS' | 'frames'>,
  ts: number,
): FrameIndex {
  const last = f.frames - 1;
  const pos = Math.min(Math.max((ts - f.startTs) / f.stepS, 0), last);
  const i0 = Math.min(Math.floor(pos), last);
  const i1 = Math.min(i0 + 1, last);
  const bucket = Math.min(Math.max(Math.ceil(pos - 1e-9), 0), last);
  return { i0, i1, frac: pos - i0, bucket };
}

/** Fill `out` with every cell's conditions at time `ts`. */
export function sampleCells(f: FieldFrames, ts: number, out: CellValues): void {
  const { i0, i1, frac, bucket } = frameIndex(f, ts);
  const n = f.cells;
  const o0 = i0 * n;
  const o1 = i1 * n;
  const ob = bucket * n;
  for (let c = 0; c < n; c++) {
    const w0 = f.wind[o0 + c]!;
    out.wind[c] = w0 + (f.wind[o1 + c]! - w0) * frac;
    out.gust[c] = f.gust[ob + c]!;
    out.rain[c] = f.rain[ob + c]!;
    out.snow[c] = f.snow[ob + c]!;
  }
}
