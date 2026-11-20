import type { PlanRequestBody } from '../api/types';
import type { FormState } from '../state/store';
import { fromLocalInputValue } from './format';

export const MAX_LOAD_LB = 80_000;
const PAST_GRACE_MS = 60 * 60 * 1000;
const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

export type FormErrors = Partial<Record<'origin' | 'destination' | 'departure' | 'load', string>>;

export type BuildResult = { ok: true; body: PlanRequestBody } | { ok: false; errors: FormErrors };

/** Validate the form the same way the API does, so most mistakes never leave the browser. */
export function buildPlanRequest(form: FormState, now: Date = new Date()): BuildResult {
  const errors: FormErrors = {};
  const { origin, destination } = form;
  if (origin.lat === null || origin.lon === null) {
    errors.origin = origin.label.trim() ? 'Pick a place from the suggestions.' : 'Enter an origin.';
  }
  if (destination.lat === null || destination.lon === null) {
    errors.destination = destination.label.trim()
      ? 'Pick a place from the suggestions.'
      : 'Enter a destination.';
  }
  if (
    !errors.origin &&
    !errors.destination &&
    Math.abs(origin.lat! - destination.lat!) < 0.01 &&
    Math.abs(origin.lon! - destination.lon!) < 0.01
  ) {
    errors.destination = 'Destination must differ from the origin.';
  }

  const departure = fromLocalInputValue(form.departureLocal);
  if (!departure) {
    errors.departure = 'Enter a valid date and time.';
  } else if (departure.getTime() < now.getTime() - PAST_GRACE_MS) {
    errors.departure = 'Departure cannot be in the past.';
  } else if (departure.getTime() > now.getTime() + MAX_AHEAD_MS) {
    errors.departure = 'Forecasts are available for departures within the next 7 days.';
  }

  if (!Number.isFinite(form.loadLb) || form.loadLb < 0 || form.loadLb > MAX_LOAD_LB) {
    errors.load = `Load must be between 0 and ${MAX_LOAD_LB.toLocaleString('en-US')} lb.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      origin: { lat: origin.lat!, lon: origin.lon!, label: origin.label.trim() },
      destination: {
        lat: destination.lat!,
        lon: destination.lon!,
        label: destination.label.trim(),
      },
      departure_time: departure!.toISOString(),
      load_weight_lb: Math.round(form.loadLb),
      interval_miles: form.intervalMi,
      hos_breaks: form.hosBreaks,
      wind_basis: form.windBasis,
      weather_source: form.weatherSource,
    },
  };
}

export interface ExampleTrip {
  label: string;
  origin: { label: string; lat: number; lon: number };
  destination: { label: string; lat: number; lon: number };
}

export const EXAMPLE_TRIPS: ExampleTrip[] = [
  {
    label: 'Dallas → Chicago',
    origin: { label: 'Dallas, Texas, USA', lat: 32.7767, lon: -96.797 },
    destination: { label: 'Chicago, Illinois, USA', lat: 41.8781, lon: -87.6298 },
  },
  {
    label: 'Denver → Salt Lake City',
    origin: { label: 'Denver, Colorado, USA', lat: 39.7392, lon: -104.9903 },
    destination: { label: 'Salt Lake City, Utah, USA', lat: 40.7608, lon: -111.891 },
  },
  {
    label: 'Kansas City → Minneapolis',
    origin: { label: 'Kansas City, Missouri, USA', lat: 39.0997, lon: -94.5786 },
    destination: { label: 'Minneapolis, Minnesota, USA', lat: 44.9778, lon: -93.265 },
  },
  {
    label: 'Amarillo → Oklahoma City',
    origin: { label: 'Amarillo, Texas, USA', lat: 35.222, lon: -101.8313 },
    destination: { label: 'Oklahoma City, Oklahoma, USA', lat: 35.4676, lon: -97.5164 },
  },
];
