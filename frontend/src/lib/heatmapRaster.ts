// Turns the corridor weather lattice into an image for a MapLibre canvas source. Pixel ->
// lattice mapping (through Web Mercator) is computed once per dataset; each frame then just
// interpolates the weather per pixel and classifies it with the real risk rules.
import type { Grid } from '../api/types';
import { RISK_ALPHA, RISK_RGB } from './colors';
import type { LevelTables } from './risk';
import type { CellValues } from './sampling';

export type Metric = 'risk' | 'wind' | 'rain' | 'snow';

export interface RasterGeometry {
  width: number;
  height: number;
  /** [top-left, top-right, bottom-right, bottom-left] as [lon, lat] (canvas source order). */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  /** Pixel indices that receive any corridor data: interior pixels first, then edge pixels. */
  active: Int32Array;
  /** Number of leading `active` pixels whose four corners are all inside the corridor. */
  interiorCount: number;
  /** 4 cell indices per active pixel (-1 = node outside the corridor). */
  corners: Int32Array;
  /** 4 bilinear weights per active pixel. */
  weights: Float32Array;
  /** Lattice node -> cell index (-1 outside the corridor). */
  nodeToCell: Int32Array;
}

const toRad = Math.PI / 180;
export const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * toRad) / 2));
export const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / toRad;

export function nodeToCellIndex(grid: Grid, cells: number[]): Int32Array {
  const map = new Int32Array(grid.nx * grid.ny).fill(-1);
  cells.forEach((node, i) => {
    map[node] = i;
  });
  return map;
}

interface Bilinear {
  corners: [number, number, number, number];
  weights: [number, number, number, number];
}

function bilinear(grid: Grid, nodeToCell: Int32Array, lat: number, lon: number): Bilinear | null {
  const colF = (lon - grid.lon0) / grid.dlon;
  const rowF = (lat - grid.lat0) / grid.dlat;
  if (colF < 0 || rowF < 0 || colF > grid.nx - 1 || rowF > grid.ny - 1) return null;
  const c0 = Math.min(Math.floor(colF), grid.nx - 2);
  const r0 = Math.min(Math.floor(rowF), grid.ny - 2);
  const fx = colF - c0;
  const fy = rowF - r0;
  const base = r0 * grid.nx + c0;
  return {
    corners: [
      nodeToCell[base]!,
      nodeToCell[base + 1]!,
      nodeToCell[base + grid.nx]!,
      nodeToCell[base + grid.nx + 1]!,
    ],
    weights: [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy],
  };
}

export function buildRasterGeometry(grid: Grid, cells: number[], maxDim = 360): RasterGeometry {
  const nodeToCell = nodeToCellIndex(grid, cells);
  const west = grid.lon0;
  const east = grid.lon0 + (grid.nx - 1) * grid.dlon;
  const south = grid.lat0;
  const north = grid.lat0 + (grid.ny - 1) * grid.dlat;
  const yTop = mercY(north);
  const ySpan = yTop - mercY(south);
  const xSpan = (east - west) * toRad;
  const aspect = xSpan / ySpan;
  const width = Math.max(2, Math.round(aspect >= 1 ? maxDim : maxDim * aspect));
  const height = Math.max(2, Math.round(aspect >= 1 ? maxDim / aspect : maxDim));

  const rowLat = new Float64Array(height);
  for (let py = 0; py < height; py++) rowLat[py] = invMercY(yTop - ((py + 0.5) / height) * ySpan);

  // Interior pixels (all four corners in the corridor) go first and skip the edge handling.
  const interior: number[] = [];
  const interiorCorners: number[] = [];
  const interiorWeights: number[] = [];
  const edge: number[] = [];
  const edgeCorners: number[] = [];
  const edgeWeights: number[] = [];
  for (let py = 0; py < height; py++) {
    const lat = rowLat[py]!;
    for (let px = 0; px < width; px++) {
      const lon = west + ((px + 0.5) / width) * (east - west);
      const b = bilinear(grid, nodeToCell, lat, lon);
      if (!b) continue;
      let coverage = 0;
      let valid = 0;
      for (let k = 0; k < 4; k++) {
        if (b.corners[k]! >= 0) {
          coverage += b.weights[k]!;
          valid++;
        }
      }
      if (coverage < 1e-3) continue;
      const isInterior = valid === 4;
      (isInterior ? interior : edge).push(py * width + px);
      const cs = isInterior ? interiorCorners : edgeCorners;
      const ws = isInterior ? interiorWeights : edgeWeights;
      for (let k = 0; k < 4; k++) {
        const ok = b.corners[k]! >= 0;
        cs.push(ok ? b.corners[k]! : -1);
        ws.push(ok ? b.weights[k]! : 0);
      }
    }
  }
  return {
    width,
    height,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    active: Int32Array.from([...interior, ...edge]),
    interiorCount: interior.length,
    corners: Int32Array.from([...interiorCorners, ...edgeCorners]),
    weights: Float32Array.from([...interiorWeights, ...edgeWeights]),
    nodeToCell,
  };
}

export interface RenderOptions {
  metric: Metric;
  /** Wind field used for classification/visualisation (sustained or gusts). */
  useGusts: boolean;
  /** Exact risk lookup tables (see makeLevelTables) for the risk metric. */
  tables: LevelTables;
  /** RGBA lookup tables for continuous metrics. */
  luts: Record<'wind' | 'rain' | 'snow', Uint8ClampedArray>;
  maxima: Record<'wind' | 'rain' | 'snow', number>;
  opacity: number;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** RGBA bytes packed into one little-endian 32-bit word (ImageData byte order R,G,B,A). */
const pack = (r: number, g: number, b: number, a: number) =>
  ((Math.round(a) << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** Paint one frame into an RGBA buffer of size width*height*4 (inactive pixels untouched). */
export function renderRaster(
  geo: RasterGeometry,
  values: CellValues,
  out: Uint8ClampedArray,
  opts: RenderOptions,
): void {
  const { active, corners, weights, interiorCount } = geo;
  const out32 = new Uint32Array(out.buffer, out.byteOffset, out.length >> 2);
  const windField = opts.useGusts ? values.gust : values.wind;
  const { rain, snow } = values;
  const opacity = opts.opacity;

  if (opts.metric !== 'risk') {
    const lut = opts.luts[opts.metric];
    const field = opts.metric === 'wind' ? windField : opts.metric === 'rain' ? rain : snow;
    const scale = 255 / opts.maxima[opts.metric];
    const packed = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      packed[i] = pack(lut[i * 4]!, lut[i * 4 + 1]!, lut[i * 4 + 2]!, lut[i * 4 + 3]! * opacity);
    }
    for (let i = 0; i < active.length; i++) {
      const k = i * 4;
      let wsum = 0;
      let v = 0;
      for (let j = 0; j < 4; j++) {
        const cell = corners[k + j]!;
        if (cell < 0) continue;
        const w = weights[k + j]!;
        wsum += w;
        v += w * field[cell]!;
      }
      let idx = Math.round((v / wsum) * scale);
      idx = idx < 0 ? 0 : idx > 255 ? 255 : idx;
      if (i < interiorCount) {
        out32[active[i]!] = packed[idx]!;
      } else {
        const p = active[i]! * 4;
        out[p] = lut[idx * 4]!;
        out[p + 1] = lut[idx * 4 + 1]!;
        out[p + 2] = lut[idx * 4 + 2]!;
        out[p + 3] = lut[idx * 4 + 3]! * opacity * smoothstep(0.05, 0.95, wsum);
      }
    }
    return;
  }

  const { wind: tw, rain: tr, snow: ts, windScale, rainScale, snowScale } = opts.tables;
  const twMax = tw.length - 1;
  const trMax = tr.length - 1;
  const tsMax = ts.length - 1;
  const levelPacked = RISK_RGB.map(([r, g, b], level) =>
    pack(r, g, b, 255 * RISK_ALPHA[level]! * opacity),
  );
  for (let i = 0; i < active.length; i++) {
    const k = i * 4;
    let wsum = 0;
    let a = 0;
    let b = 0;
    let c = 0;
    for (let j = 0; j < 4; j++) {
      const cell = corners[k + j]!;
      if (cell < 0) continue;
      const w = weights[k + j]!;
      wsum += w;
      a += w * windField[cell]!;
      b += w * rain[cell]!;
      c += w * snow[cell]!;
    }
    // Inlined levelFromTables(): round to display precision, index, take the worst factor.
    const iw = Math.floor((a > 0 ? a / wsum : 0) * windScale + 0.5);
    const ir = Math.floor((b > 0 ? b / wsum : 0) * rainScale + 0.5);
    const is = Math.floor((c > 0 ? c / wsum : 0) * snowScale + 0.5);
    let level = tw[iw < twMax ? iw : twMax]!;
    const lr = tr[ir < trMax ? ir : trMax]!;
    const ls = ts[is < tsMax ? is : tsMax]!;
    if (lr > level) level = lr;
    if (ls > level) level = ls;
    if (i < interiorCount) {
      out32[active[i]!] = levelPacked[level]!;
    } else {
      const p = active[i]! * 4;
      const rgb = RISK_RGB[level]!;
      out[p] = rgb[0];
      out[p + 1] = rgb[1];
      out[p + 2] = rgb[2];
      out[p + 3] = 255 * RISK_ALPHA[level]! * opacity * smoothstep(0.05, 0.95, wsum);
    }
  }
}

export interface PointSample {
  wind: number;
  gust: number;
  rain: number;
  snow: number;
  coverage: number;
}

/** Interpolated conditions at an arbitrary point (e.g. under a truck marker). */
export function sampleAt(
  grid: Grid,
  nodeToCell: Int32Array,
  values: CellValues,
  lat: number,
  lon: number,
): PointSample | null {
  const b = bilinear(grid, nodeToCell, lat, lon);
  if (!b) return null;
  let wsum = 0;
  const acc = { wind: 0, gust: 0, rain: 0, snow: 0 };
  for (let k = 0; k < 4; k++) {
    const cell = b.corners[k]!;
    if (cell < 0) continue;
    const w = b.weights[k]!;
    wsum += w;
    acc.wind += w * values.wind[cell]!;
    acc.gust += w * values.gust[cell]!;
    acc.rain += w * values.rain[cell]!;
    acc.snow += w * values.snow[cell]!;
  }
  if (wsum < 1e-3) return null;
  return {
    wind: acc.wind / wsum,
    gust: acc.gust / wsum,
    rain: acc.rain / wsum,
    snow: acc.snow / wsum,
    coverage: wsum,
  };
}
