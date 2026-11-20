import { useState, type FormEvent } from 'react';

import { localTimeZoneName } from '../lib/format';
import { buildPlanRequest, EXAMPLE_TRIPS, MAX_LOAD_LB, type FormErrors } from '../lib/planRequest';
import { useAppStore } from '../state/store';
import { PlaceInput } from './PlaceInput';
import { Icon } from './icons';

const INTERVALS = [10, 25, 50] as const;

export function TripForm() {
  const form = useAppStore((s) => s.form);
  const setForm = useAppStore((s) => s.setForm);
  const submitPlan = useAppStore((s) => s.submitPlan);
  const loading = useAppStore((s) => s.planStatus === 'loading');
  const [errors, setErrors] = useState<FormErrors>({});

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const result = buildPlanRequest(useAppStore.getState().form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    void submitPlan(result.body);
  };

  const loadPct = (lb: number) => `${(lb / MAX_LOAD_LB) * 100}%`;

  return (
    <form className="card form" onSubmit={submit} noValidate aria-label="Trip details">
      <div className="route-inputs">
        <PlaceInput
          label="Origin"
          kind="origin"
          placeholder="Origin — city or address"
          value={form.origin}
          error={errors.origin}
          onChange={(origin) => setForm({ origin })}
        />
        <PlaceInput
          label="Destination"
          kind="destination"
          placeholder="Destination — city or address"
          value={form.destination}
          error={errors.destination}
          onChange={(destination) => setForm({ destination })}
        />
        <button
          type="button"
          className="swap-btn"
          aria-label="Swap origin and destination"
          title="Swap origin and destination"
          onClick={() => setForm({ origin: form.destination, destination: form.origin })}
        >
          {Icon.swap}
        </button>
      </div>

      <div className="examples" aria-label="Example trips">
        {EXAMPLE_TRIPS.map((trip) => (
          <button
            key={trip.label}
            type="button"
            className="example-chip"
            onClick={() => {
              setErrors({});
              setForm({ origin: trip.origin, destination: trip.destination });
            }}
          >
            {trip.label}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="departure">Departure ({localTimeZoneName()})</label>
        <input
          id="departure"
          className="input"
          type="datetime-local"
          value={form.departureLocal}
          aria-invalid={errors.departure ? true : undefined}
          aria-describedby={errors.departure ? 'departure-error' : undefined}
          onChange={(e) => setForm({ departureLocal: e.target.value })}
        />
        {errors.departure && (
          <span id="departure-error" className="field-error">
            {errors.departure}
          </span>
        )}
      </div>

      <div className="load-row">
        <label htmlFor="load" className="field-label">
          Load weight
        </label>
        <div className="input-group">
          <input
            id="load"
            className="input num"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_LOAD_LB}
            step={500}
            value={Number.isFinite(form.loadLb) ? form.loadLb : ''}
            aria-invalid={errors.load ? true : undefined}
            aria-describedby={errors.load ? 'load-error' : 'load-hint'}
            onChange={(e) =>
              setForm({ loadLb: e.target.value === '' ? NaN : Number(e.target.value) })
            }
          />
          <span className="input-suffix">lb</span>
        </div>
      </div>

      <div className="field">
        <input
          className="load-slider"
          type="range"
          min={0}
          max={MAX_LOAD_LB}
          step={500}
          value={Number.isFinite(form.loadLb) ? form.loadLb : 0}
          aria-label="Load weight slider"
          aria-valuetext={`${form.loadLb.toLocaleString('en-US')} pounds`}
          onChange={(e) => setForm({ loadLb: Number(e.target.value) })}
        />
        <div className="load-marks" aria-hidden="true">
          <span style={{ left: loadPct(0), transform: 'none' }}>0</span>
          <span style={{ left: loadPct(30_000) }}>30k</span>
          <span style={{ left: loadPct(40_000) }}>40k</span>
          <span style={{ left: loadPct(MAX_LOAD_LB), transform: 'translateX(-100%)' }}>80k lb</span>
        </div>
        {errors.load ? (
          <span id="load-error" className="field-error">
            {errors.load}
          </span>
        ) : (
          <span id="load-hint" className="field-hint">
            Over 30,000 lb: 45–54 mph wind is No Travel. Over 40,000 lb: 35–44 mph is Severe.
          </span>
        )}
      </div>

      <div className="field">
        <span className="field-label" id="interval-label">
          Weather checkpoint every
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="interval-label">
          {INTERVALS.map((mi) => (
            <button
              key={mi}
              type="button"
              role="radio"
              aria-checked={form.intervalMi === mi}
              onClick={() => setForm({ intervalMi: mi })}
            >
              {mi} miles
            </button>
          ))}
        </div>
      </div>

      <details className="details">
        <summary>Options</summary>
        <div className="details-body">
          <label className="toggle">
            <input
              type="checkbox"
              checked={form.hosBreaks}
              onChange={(e) => setForm({ hosBreaks: e.target.checked })}
            />
            <span>
              <b>Hours-of-Service rest stops</b>
              <br />
              <span className="muted">
                30-min break after 8 h and 10-h rest after 11 h of driving shift later ETAs — and
                the weather each checkpoint is sampled at.
              </span>
            </span>
          </label>
          <div className="field">
            <span className="field-label" id="wind-label">
              Wind risk uses
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="wind-label">
              {(['sustained', 'gust'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={form.windBasis === b}
                  onClick={() => setForm({ windBasis: b })}
                >
                  {b === 'sustained' ? 'Sustained wind' : 'Wind gusts'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label" id="source-label">
              Weather data
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="source-label">
              {(['live', 'simulated'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={form.weatherSource === s}
                  onClick={() => setForm({ weatherSource: s })}
                >
                  {s === 'live' ? 'Live forecast' : 'Simulated storm'}
                </button>
              ))}
            </div>
            <span className="field-hint">
              Simulated storm puts a moving storm on the fastest route (real roads, synthetic
              weather) to demonstrate every risk level on a calm day.
            </span>
          </div>
        </div>
      </details>

      <button type="submit" className="btn btn-primary" disabled={loading}>
        {loading ? (
          <>
            <span className="spinner" aria-hidden="true" /> Planning routes…
          </>
        ) : (
          'Find safest route'
        )}
      </button>
    </form>
  );
}
