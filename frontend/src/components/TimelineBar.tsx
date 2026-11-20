import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';

import type { PlanResponse, Route } from '../api/types';
import { cssGradient, METRIC_SCALES } from '../lib/colors';
import { fixed, formatOffset, formatTime } from '../lib/format';
import { heatmapModel } from '../lib/heatmapModel';
import { sampleAt, type Metric } from '../lib/heatmapRaster';
import { assess, RISK_COLORS, RISK_LABELS } from '../lib/risk';
import { truckPosition } from '../lib/routeGeometry';
import { elapsedAtMile, trackMarks } from '../lib/timeline';
import { allocCellValues, sampleCells } from '../lib/sampling';
import { MAX_HOURS, selectSelectedRoute, useAppStore } from '../state/store';
import { Icon } from './icons';
import { RiskPill } from './risk';

const HOURS_PER_SECOND = 3; // playback speed: 48 h in 16 s
const METRICS: { key: Metric; label: string }[] = [
  { key: 'risk', label: 'Risk' },
  { key: 'wind', label: 'Wind' },
  { key: 'rain', label: 'Rain' },
  { key: 'snow', label: 'Snow' },
];

const pct = (hours: number): string =>
  `${(Math.min(Math.max(hours, 0), MAX_HOURS) / MAX_HOURS) * 100}%`;

/** Risk the selected truck meets over time (checkpoint spans mapped onto the clock). */
function RiskStrip({ route }: { route: Route }) {
  const segments = useMemo(
    () =>
      route.checkpoints.map((c) => ({
        key: c.index,
        from: elapsedAtMile(route, c.span[0]) / 3600,
        to: elapsedAtMile(route, c.span[1]) / 3600,
        level: c.risk.level,
      })),
    [route],
  );
  const departure = new Date(route.departure_time).getTime();
  return (
    <div className="track-strip" aria-hidden="true">
      {segments
        .filter((s) => s.from < MAX_HOURS)
        .map((s) => (
          <span
            key={s.key}
            style={{
              left: pct(s.from),
              width: `calc(${pct(s.to)} - ${pct(s.from)})`,
              background: RISK_COLORS[s.level],
            }}
          />
        ))}
      {route.stops.map((s) => {
        const from = (new Date(s.arrive_time).getTime() - departure) / 3_600_000;
        const to = (new Date(s.depart_time).getTime() - departure) / 3_600_000;
        return from < MAX_HOURS ? (
          <span
            key={s.arrive_time}
            className="rest-band"
            style={{ left: pct(from), width: `calc(${pct(to)} - ${pct(from)})` }}
          />
        ) : null;
      })}
    </div>
  );
}

function TrackMarks({ plan }: { plan: PlanResponse }) {
  const marks = useMemo(() => trackMarks(plan), [plan]);
  return (
    <div className="track-marks" aria-hidden="true">
      {marks.map((m) => (
        <span
          key={m.key}
          className={m.arrival ? 'arrival' : undefined}
          style={{ left: pct(m.hours) }}
        >
          {m.label}
        </span>
      ))}
    </div>
  );
}

function Legend({ metric, gusts }: { metric: Metric; gusts: boolean }) {
  if (metric === 'risk') {
    return (
      <div className="legend-risk" aria-label="Risk colours">
        {RISK_LABELS.map((label, i) => (
          <span key={label}>
            <i style={{ background: RISK_COLORS[i] }} />
            {label}
          </span>
        ))}
      </div>
    );
  }
  const scale = METRIC_SCALES[metric];
  return (
    <div className="legend-ramp" aria-label={`${scale.label} scale`}>
      <span className="muted" style={{ fontSize: 11.5 }}>
        {metric === 'wind' && gusts ? 'Wind gusts' : scale.label} ({scale.unit}) — ticks mark risk
        thresholds
      </span>
      <div className="legend-ramp-bar" style={{ background: cssGradient(scale.ramp) }} />
      <div className="legend-ramp-ticks">
        {scale.ticks.map((t) => (
          <span key={t} style={{ left: `${(t / scale.max) * 100}%` }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Conditions under the selected truck at the slider time, read from the heatmap field. */
function Readout({ plan }: { plan: PlanResponse }) {
  const hours = useAppStore((s) => s.timeHours);
  const route = useAppStore(selectSelectedRoute);
  const heatmap = useAppStore((s) => s.heatmap);
  const valuesRef = useRef<ReturnType<typeof allocCellValues> | null>(null);
  if (!route) return null;
  const pos = truckPosition(route, hours * 3600);
  const where =
    pos.state === 'arrived'
      ? 'arrived'
      : `mile ${Math.round(pos.mile)}${pos.state === 'stopped' ? ' · resting (HOS)' : ''}`;
  let conditions: ReactNode = null;
  if (heatmap && pos.state !== 'arrived') {
    const model = heatmapModel(heatmap);
    if (!valuesRef.current || valuesRef.current.wind.length !== model.frames.cells) {
      valuesRef.current = allocCellValues(model.frames.cells);
    }
    const departure = new Date(plan.inputs.departure_time).getTime() / 1000;
    sampleCells(model.frames, departure + hours * 3600, valuesRef.current);
    const s = sampleAt(
      heatmap.grid,
      model.geometry.nodeToCell,
      valuesRef.current,
      pos.coord[1],
      pos.coord[0],
    );
    if (s) {
      const a = assess(
        plan.rules,
        { wind: s.wind, gust: s.gust, rain: s.rain, snow: s.snow },
        plan.inputs.load_weight_lb,
        plan.inputs.wind_basis,
      );
      conditions = (
        <>
          <span className="num">
            Wind {fixed(s.wind, 1)} mph (gusts {fixed(s.gust, 1)}) · Rain {fixed(s.rain, 2)} · Snow{' '}
            {fixed(s.snow, 2)} in/hr
          </span>
          <RiskPill level={a.level} />
        </>
      );
    }
  }
  return (
    <div className="readout" aria-live="off">
      <b>Truck {route.id}</b>
      <span>{where}</span>
      {conditions}
    </div>
  );
}

function HeatmapStatus() {
  const status = useAppStore((s) => s.heatmapStatus);
  const error = useAppStore((s) => s.heatmapError);
  const retry = useAppStore((s) => s.retryHeatmap);
  if (status === 'loading') {
    return (
      <div className="timeline-status" role="status">
        <span className="spinner" aria-hidden="true" /> Loading 48-hour corridor forecast…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="timeline-status" role="alert">
        <span style={{ color: 'var(--danger)' }}>Heatmap unavailable: {error?.message}</span>
        <button type="button" className="btn btn-ghost" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}

export function TimelineBar() {
  const plan = useAppStore((s) => s.plan);
  const hours = useAppStore((s) => s.timeHours);
  const playing = useAppStore((s) => s.playing);
  const metric = useAppStore((s) => s.metric);
  const visible = useAppStore((s) => s.heatmapVisible);
  const route = useAppStore(selectSelectedRoute);
  const { setTime, setPlaying, setMetric, setHeatmapVisible } = useAppStore.getState();

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      // One clock for both ends, and a clamp so a backgrounded tab doesn't jump on resume.
      const now = performance.now();
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.25);
      last = now;
      const next = useAppStore.getState().timeHours + dt * HOURS_PER_SECOND;
      if (next >= MAX_HOURS) {
        setTime(MAX_HOURS);
        setPlaying(false);
        return;
      }
      setTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, setTime, setPlaying]);

  // Publish the bar's height so map controls and fit-to-route padding can clear it.
  const barRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    const pane = el?.parentElement;
    if (!el || !pane) return;
    // Docked (not floating) on phones, so nothing on the map needs to clear it there.
    const update = () => {
      const floating = getComputedStyle(el).position === 'absolute';
      pane.style.setProperty('--timeline-h', `${floating ? el.offsetHeight + 12 : 0}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      pane.style.removeProperty('--timeline-h');
    };
  }, [plan]);

  if (!plan) return null;
  const departure = new Date(plan.inputs.departure_time);
  const at = new Date(departure.getTime() + hours * 3_600_000);
  const gusts = plan.inputs.wind_basis === 'gust';

  return (
    <section ref={barRef} className="timeline" aria-label="Forecast timeline">
      <div className="timeline-top">
        <button
          type="button"
          className={`play-btn${playing ? ' is-playing' : ''}`}
          aria-label={playing ? 'Pause forecast playback' : 'Play forecast'}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? Icon.pause : Icon.play}
        </button>
        <div className="timeline-time">
          <strong>{formatTime(at, true)}</strong>
          <span>{formatOffset(hours)} after departure</span>
        </div>
        <div className="timeline-controls">
          <div className="segmented" role="radiogroup" aria-label="Heatmap layer">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={metric === m.key}
                onClick={() => {
                  setMetric(m.key);
                  setHeatmapVisible(true);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={visible}
            aria-label={visible ? 'Hide heatmap' : 'Show heatmap'}
            title={visible ? 'Hide heatmap' : 'Show heatmap'}
            onClick={() => setHeatmapVisible(!visible)}
          >
            {Icon.eye}
          </button>
        </div>
      </div>

      <div className="track">
        <TrackMarks plan={plan} />
        {route && <RiskStrip route={route} />}
        <input
          className="time-slider"
          style={{ '--pct': `${(hours / MAX_HOURS) * 100}%` } as CSSProperties}
          type="range"
          min={0}
          max={MAX_HOURS}
          step={0.25}
          value={hours}
          aria-label="Forecast hour after departure"
          aria-valuetext={`${formatOffset(hours)}, ${formatTime(at, true)}`}
          onPointerDown={() => setPlaying(false)}
          onChange={(e) => setTime(Number(e.target.value))}
        />
      </div>

      <div className="timeline-bottom">
        <Legend metric={metric} gusts={gusts} />
        <HeatmapStatus />
        <Readout plan={plan} />
      </div>
    </section>
  );
}
