import { RISK_COLORS } from './risk';

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const RISK_RGB: Rgb[] = RISK_COLORS.map(hexToRgb);

/** Heatmap fill opacity per level: calm air stays light so the basemap reads through. */
export const RISK_ALPHA = [0.2, 0.5, 0.6, 0.68, 0.78] as const;

export interface RampStop {
  at: number; // 0..1
  color: string;
  alpha: number; // 0..1
}

export interface MetricScale {
  label: string;
  unit: string;
  max: number;
  /** Values marked on the legend (the risk thresholds for that condition). */
  ticks: number[];
  ramp: RampStop[];
}

/** One hue per metric, light -> dark; near-zero values fade toward transparent. */
export const METRIC_SCALES: Record<'wind' | 'rain' | 'snow', MetricScale> = {
  wind: {
    label: 'Wind',
    unit: 'mph',
    max: 60,
    ticks: [25, 35, 45, 55],
    ramp: [
      { at: 0, color: '#cde2fb', alpha: 0.12 },
      { at: 0.4, color: '#6da7ec', alpha: 0.45 },
      { at: 0.75, color: '#256abf', alpha: 0.7 },
      { at: 1, color: '#0d366b', alpha: 0.85 },
    ],
  },
  rain: {
    label: 'Rain',
    unit: 'in/hr',
    max: 1.2,
    ticks: [0.1, 0.25, 0.5, 1.0],
    ramp: [
      { at: 0, color: '#c9f0e3', alpha: 0 },
      { at: 0.02, color: '#a7e6d2', alpha: 0.25 },
      { at: 0.3, color: '#1baf7a', alpha: 0.6 },
      { at: 1, color: '#0b5a40', alpha: 0.88 },
    ],
  },
  snow: {
    label: 'Snow',
    unit: 'in/hr',
    max: 3.5,
    ticks: [0.5, 1, 2, 3],
    ramp: [
      { at: 0, color: '#e3defa', alpha: 0 },
      { at: 0.02, color: '#c9c1f4', alpha: 0.25 },
      { at: 0.35, color: '#7f70e0', alpha: 0.62 },
      { at: 1, color: '#33248f', alpha: 0.9 },
    ],
  },
};

/** 256-entry RGBA lookup table (alpha 0..255) for a ramp. */
export function buildLut(ramp: RampStop[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const stops = ramp.map((s) => ({ ...s, rgb: hexToRgb(s.color) }));
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]!.at) k++;
    const a = stops[k]!;
    const b = stops[Math.min(k + 1, stops.length - 1)]!;
    const span = b.at - a.at;
    const f = span > 0 ? Math.min(Math.max((t - a.at) / span, 0), 1) : 0;
    lut[i * 4] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f;
    lut[i * 4 + 1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f;
    lut[i * 4 + 2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f;
    lut[i * 4 + 3] = (a.alpha + (b.alpha - a.alpha) * f) * 255;
  }
  return lut;
}

export function cssGradient(ramp: RampStop[]): string {
  const parts = ramp.map((s) => {
    const [r, g, b] = hexToRgb(s.color);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(s.alpha, 0.08)}) ${Math.round(s.at * 100)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
