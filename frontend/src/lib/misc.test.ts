import type { PlanResponse } from '../api/types';
import { initialForm } from '../state/store';
import planFixture from '../test/fixtures/plan.json';
import { buildLut, cssGradient, hexToRgb, METRIC_SCALES } from './colors';
import {
  fixed,
  formatDuration,
  formatMiles,
  formatOffset,
  fromLocalInputValue,
  nextQuarterHour,
  toLocalInputValue,
} from './format';
import { buildPlanRequest, EXAMPLE_TRIPS } from './planRequest';
import { elapsedAtMile, trackMarks } from './timeline';

const plan = planFixture as unknown as PlanResponse;

describe('format', () => {
  it.each([
    [59, '1m'],
    [3600, '1h'],
    [3600 + 5 * 60, '1h 05m'],
    [25 * 3600 + 33 * 60, '25h 33m'],
  ])('formatDuration(%i) = %s', (s, text) => expect(formatDuration(s)).toBe(text));

  it('formats miles and offsets', () => {
    expect(formatMiles(1234.4)).toBe('1,234 mi');
    expect(formatOffset(0)).toBe('T+0h');
    expect(formatOffset(5.25)).toBe('T+5h15');
    expect(formatOffset(2.9958)).toBe('T+3h'); // never "T+2h60"
  });

  it('round-trips datetime-local values', () => {
    const d = new Date(2026, 10, 20, 14, 45);
    expect(toLocalInputValue(d)).toBe('2026-11-20T14:45');
    expect(fromLocalInputValue('2026-11-20T14:45')?.getTime()).toBe(d.getTime());
    expect(fromLocalInputValue('nope')).toBeNull();
  });

  it('fixes decimals with the classifier rounding', () => {
    expect(fixed(24.96, 1)).toBe('25.0');
    expect(fixed(0.095, 2)).toBe('0.10');
    expect(fixed(3, 2)).toBe('3.00');
  });

  it('rounds up to the next quarter hour', () => {
    expect(nextQuarterHour(new Date(2026, 0, 1, 10, 7, 30)).getMinutes()).toBe(15);
    expect(nextQuarterHour(new Date(2026, 0, 1, 10, 59)).getHours()).toBe(11);
  });
});

describe('colors', () => {
  it('parses hex and builds a monotone LUT', () => {
    expect(hexToRgb('#1f9e89')).toEqual([31, 158, 137]);
    const lut = buildLut(METRIC_SCALES.wind.ramp);
    expect(lut.length).toBe(1024);
    expect(lut[3]).toBeLessThan(lut[255 * 4 + 3]!); // alpha grows with magnitude
    expect(cssGradient(METRIC_SCALES.rain.ramp)).toMatch(/^linear-gradient\(90deg, rgba/);
  });
});

describe('buildPlanRequest', () => {
  const now = new Date(2026, 10, 20, 12, 0);
  const valid = () => ({
    ...initialForm(),
    origin: { ...EXAMPLE_TRIPS[0]!.origin },
    destination: { ...EXAMPLE_TRIPS[0]!.destination },
    departureLocal: '2026-11-20T13:00',
    loadLb: 42000,
  });

  it('builds the API body', () => {
    const r = buildPlanRequest(valid(), now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toMatchObject({
      origin: { lat: 32.7767, lon: -96.797, label: 'Dallas, Texas, USA' },
      load_weight_lb: 42000,
      interval_miles: 25,
      hos_breaks: true,
      wind_basis: 'sustained',
      weather_source: 'live',
    });
    expect(new Date(r.body.departure_time).getTime()).toBe(new Date(2026, 10, 20, 13, 0).getTime());
  });

  it.each([
    [{ origin: { label: '', lat: null, lon: null } }, 'origin', 'Enter an origin.'],
    [
      { origin: { label: 'Dal', lat: null, lon: null } },
      'origin',
      'Pick a place from the suggestions.',
    ],
    [
      { destination: { ...EXAMPLE_TRIPS[0]!.origin } },
      'destination',
      'Destination must differ from the origin.',
    ],
    [{ departureLocal: '2026-11-20T09:00' }, 'departure', 'Departure cannot be in the past.'],
    [
      { departureLocal: '2026-12-01T09:00' },
      'departure',
      'Forecasts are available for departures within the next 7 days.',
    ],
    [{ departureLocal: '' }, 'departure', 'Enter a valid date and time.'],
    [{ loadLb: 90_000 }, 'load', 'Load must be between 0 and 80,000 lb.'],
    [{ loadLb: Number.NaN }, 'load', 'Load must be between 0 and 80,000 lb.'],
  ])('rejects %j', (patch, field, message) => {
    const r = buildPlanRequest({ ...valid(), ...patch }, now);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[field as keyof typeof r.errors]).toBe(message);
  });
});

describe('timeline', () => {
  it('maps miles to elapsed time along a route', () => {
    const r = plan.routes[0]!;
    expect(elapsedAtMile(r, 0)).toBe(0);
    // total_time_s is presented in whole minutes.
    expect(Math.abs(elapsedAtMile(r, r.distance_mi) - r.total_time_s)).toBeLessThanOrEqual(30);
  });

  it('groups close arrivals into one label and drops colliding day labels', () => {
    const marks = trackMarks(plan);
    const arrivals = marks.filter((m) => m.arrival);
    // All three routes arrive within minutes of each other in the fixture.
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.label).toMatch(/^A · B · C arrive$/);
    for (const m of marks.filter((x) => !x.arrival)) {
      expect(Math.abs(m.hours - arrivals[0]!.hours)).toBeGreaterThan(48 * 0.12);
    }
  });
});
