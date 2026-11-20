import { useEffect, useRef, useState, type CSSProperties } from 'react';

import type { PlanResponse, RiskRules } from '../api/types';
import { RISK_LABELS } from '../lib/risk';
import { selectSelectedRoute, useAppStore } from '../state/store';
import { CheckpointTable } from './CheckpointTable';
import { RecommendationCard } from './Recommendation';
import { Icon } from './icons';
import { RouteCards } from './RouteCards';
import { TripForm } from './TripForm';
import { TripSummary } from './TripSummary';

function Header({ busy }: { busy: boolean }) {
  return (
    <header className={`header${busy ? ' is-busy' : ''}`}>
      <span className="header-mark" aria-hidden="true">
        {Icon.truck}
      </span>
      <div>
        <h1>Weather-Aware Truck Routing</h1>
        <p>Safest route by forecast at your ETA, load weight and travel time</p>
      </div>
    </header>
  );
}

const STEPS = [
  'Three truck routes are built between your origin and destination.',
  'Weather is read every 10, 25 or 50 miles at the time the truck actually arrives there, rest stops included.',
  'Each checkpoint is rated Low → No Travel from wind, rain, snow and your load weight.',
  'The pick: fewest Severe miles, then fewest High miles, then lowest average risk, then fastest.',
];

function HeroArt() {
  return (
    <svg
      className="hero-art"
      viewBox="0 0 400 130"
      role="img"
      aria-label="Three routes around a storm"
    >
      <defs>
        <radialGradient id="storm" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6a1b9a" stopOpacity="0.85" />
          <stop offset="45%" stopColor="#c9283e" stopOpacity="0.6" />
          <stop offset="75%" stopColor="#f37021" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#f6c90e" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle
        className="storm-ring"
        cx="214"
        cy="62"
        r="30"
        fill="none"
        stroke="#c9283e"
        strokeWidth="2"
      />
      <circle className="storm" cx="214" cy="62" r="44" fill="url(#storm)" />
      <path
        className="route-b"
        d="M40 98 C 110 96, 150 70, 214 64 S 320 30, 362 30"
        stroke="#c9283e"
        strokeWidth="4"
      />
      <path
        className="route-c"
        d="M40 98 C 100 120, 200 124, 260 108 S 340 60, 362 30"
        stroke="#1f9e89"
        strokeWidth="6"
      />
      <path
        className="route-a"
        d="M40 98 C 90 60, 150 22, 230 22 S 330 28, 362 30"
        stroke="#f6c90e"
        strokeWidth="4"
      />
      {[
        [70, 109, 0],
        [130, 121, 1],
        [200, 121, 2],
        [262, 107, 3],
        [318, 72, 4],
      ].map(([x, y, i]) => (
        <circle
          key={i}
          className="dot"
          cx={x}
          cy={y}
          r="4.5"
          fill="#fff"
          stroke="#1f9e89"
          strokeWidth="2.5"
          style={{ animationDelay: `${0.9 + i! * 0.12}s` }}
        />
      ))}
      <circle cx="40" cy="98" r="7" fill="#c45c12" stroke="#fff" strokeWidth="3" />
      <rect
        x="355"
        y="23"
        width="14"
        height="14"
        rx="2"
        fill="#1c2430"
        stroke="#fff"
        strokeWidth="3"
      />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="card hero rise">
      <HeroArt />
      <div className="empty">
        <b style={{ color: 'var(--ink)' }}>How it works</b>
        <ol className="steps">
          {STEPS.map((text, i) => (
            <li key={text} className="rise" style={{ '--i': i + 2 } as CSSProperties}>
              <span className="step-num">{i + 1}</span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

const LOADING_STEPS = [
  'Finding three truck routes',
  'Estimating arrival at every checkpoint',
  'Fetching forecasts for each ETA',
  'Scoring risk and ranking routes',
];

function LoadingState() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setStep((s) => Math.min(s + 1, LOADING_STEPS.length - 1)),
      1100,
    );
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="section" aria-busy="true">
      <div className="card loading-card rise">
        <svg className="loading-road" viewBox="0 0 360 54" aria-hidden="true">
          <rect x="0" y="30" width="360" height="18" rx="4" fill="#ebe4d8" />
          <line className="lane" x1="0" y1="39" x2="360" y2="39" stroke="#fff" strokeWidth="2.5" />
          <g className="truck" transform="translate(150 6)">
            <rect x="0" y="6" width="40" height="22" rx="2" fill="#1c2430" />
            <path d="M40 12h10l8 8v8H40z" fill="#c45c12" />
            <rect x="44" y="14" width="7" height="5" rx="1" fill="#f6e2d2" />
            <circle cx="10" cy="29" r="4.5" fill="#1f2b30" />
            <circle cx="48" cy="29" r="4.5" fill="#1f2b30" />
          </g>
        </svg>
        <ul className="loading-steps" role="status">
          {LOADING_STEPS.map((label, i) => (
            <li key={label} className={i < step ? 'is-done' : i === step ? 'is-active' : undefined}>
              <span className="tick" aria-hidden="true">
                {i < step ? Icon.check : i === step ? <span className="spinner" /> : '•'}
              </span>
              {label}
            </li>
          ))}
        </ul>
      </div>
      <div className="skeleton" style={{ height: 110, marginTop: 10 }} />
      <div className="skeleton" style={{ height: 110, marginTop: 10 }} />
    </div>
  );
}

function Notices({ plan }: { plan: PlanResponse }) {
  if (!plan.notices.length && !plan.weather.simulated) return null;
  return (
    <div className="section">
      {plan.weather.simulated && (
        <div className="alert alert-info" role="note">
          {Icon.info}
          <span>
            <b>Simulated storm.</b> Routes are real; the weather is a synthetic storm placed on the
            fastest route to demonstrate the risk rules.
          </span>
        </div>
      )}
      {plan.notices.map((n) => (
        <div
          key={n.code}
          className={`alert alert-${n.severity}`}
          role={n.severity === 'danger' ? 'alert' : 'note'}
        >
          {n.severity === 'info' ? Icon.info : Icon.alert}
          <span>{n.message}</span>
        </div>
      ))}
    </div>
  );
}

function Results({ plan }: { plan: PlanResponse }) {
  const route = useAppStore(selectSelectedRoute);
  return (
    <>
      <Notices plan={plan} />
      <div className="section">
        <RecommendationCard plan={plan} />
      </div>
      <div className="section rise" style={{ '--i': 2 } as CSSProperties}>
        <h2 className="section-title">
          <span>Routes</span>
          <span style={{ textTransform: 'none', letterSpacing: 0 }}>Select to inspect</span>
        </h2>
        <RouteCards routes={plan.routes} />
      </div>
      {route && (
        <div className="section rise" style={{ '--i': 5 } as CSSProperties}>
          <h2 className="section-title">{route.name} checkpoints</h2>
          <CheckpointTable route={route} windBasis={plan.inputs.wind_basis} />
        </div>
      )}
    </>
  );
}

function RulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [rules, setRules] = useState<RiskRules | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal?.();
      if (!rules) {
        fetch('/api/rules')
          .then((r) => (r.ok ? r.json() : null))
          .then((r: RiskRules | null) => setRules(r))
          .catch(() => setRules(null));
      }
    } else if (!open && d.open) d.close?.();
  }, [open, rules]);
  const cell = (factor: 'wind' | 'rain' | 'snow', level: number) => {
    if (!rules) return '…';
    const rule = rules.conditions[factor];
    const t = rule.thresholds.find((x) => x.level === level);
    const prev = rule.thresholds.find((x) => x.level === level - 1);
    if (level === 0) return `< ${rule.thresholds[0]!.value}`;
    if (!t) return '—';
    const next = rule.thresholds.find((x) => x.level === level + 1);
    return next
      ? `${t.value} – ${next.value}`
      : `${t.inclusive ? '≥' : '>'} ${t.value}${prev ? '' : ''}`;
  };
  return (
    <dialog ref={ref} className="rules" onClose={onClose} aria-labelledby="rules-title">
      <div className="rules-body">
        <h2 id="rules-title">Risk rules</h2>
        <table className="rules-table">
          <thead>
            <tr>
              <th>Condition</th>
              {RISK_LABELS.map((l) => (
                <th key={l}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['wind', 'rain', 'snow'] as const).map((f) => (
              <tr key={f}>
                <th scope="row">
                  {f[0]!.toUpperCase() + f.slice(1)} ({rules?.conditions[f].unit ?? ''})
                </th>
                {[0, 1, 2, 3, 4].map((lvl) => (
                  <td key={lvl}>{cell(f, lvl)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <b>Load rules</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>≥ 55 mph → No Travel for any load</li>
            <li>45–54 mph and load &gt; 30,000 lb → No Travel</li>
            <li>35–44 mph and load &gt; 40,000 lb → Severe</li>
          </ul>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Lower bounds are inclusive (35.0 mph is High). Rain above 1.00 in/hr and snow above 3.0
          in/hr are No Travel, so exactly 1.00 / 3.0 is Severe. A checkpoint takes the worst of its
          wind, rain and snow levels and represents the road halfway to its neighbours.
        </p>
        <div>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function Sidebar() {
  const plan = useAppStore((s) => s.plan);
  const status = useAppStore((s) => s.planStatus);
  const error = useAppStore((s) => s.planError);
  const [rulesOpen, setRulesOpen] = useState(false);
  // The form collapses to a summary once a plan arrives, keeping results above the fold.
  const [editing, setEditing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!plan) return;
    setEditing(false);
    scrollRef.current?.scrollTo?.({ top: 0 });
    // Stacked layout on phones: bring the map with the new routes back into view.
    if (window.matchMedia?.('(max-width: 900px)')?.matches) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [plan]);

  return (
    <aside className="sidebar" aria-label="Trip planner">
      <Header busy={status === 'loading'} />
      <div className="sidebar-scroll" ref={scrollRef}>
        <div className="section">
          {plan && !editing && status !== 'loading' ? (
            <TripSummary plan={plan} onEdit={() => setEditing(true)} />
          ) : (
            <TripForm />
          )}
        </div>
        <div aria-live="polite">
          {status === 'error' && error && (
            <div className="section">
              <div className="alert alert-danger" role="alert">
                {Icon.alert}
                <span>
                  <b>Could not plan this trip.</b> {error.message}
                </span>
              </div>
            </div>
          )}
          {status === 'loading' && <LoadingState />}
          {status !== 'loading' && plan && <Results plan={plan} />}
          {status === 'idle' && !plan && (
            <div className="section">
              <EmptyState />
            </div>
          )}
        </div>
        <footer className="footer">
          <button type="button" className="btn-link" onClick={() => setRulesOpen(true)}>
            View risk rules
          </button>
          <span>
            Routing: Valhalla truck costing (OSRM fallback) · Weather: Open-Meteo · Places: Photon ·
            Map © OpenStreetMap contributors, OpenFreeMap.
          </span>
        </footer>
      </div>
      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </aside>
  );
}
