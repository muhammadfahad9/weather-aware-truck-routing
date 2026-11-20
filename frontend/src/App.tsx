import { lazy, Suspense } from 'react';

import { Sidebar } from './components/Sidebar';
import { TimelineBar } from './components/TimelineBar';
import { useAppStore } from './state/store';

// MapLibre is large: load it alongside the first paint instead of blocking it.
const MapView = lazy(() => import('./map/MapView').then((m) => ({ default: m.MapView })));

function MapOverlays() {
  const plan = useAppStore((s) => s.plan);
  const loading = useAppStore((s) => s.planStatus === 'loading');
  return (
    <>
      {plan?.weather.simulated && (
        <div className="map-badge" role="note">
          Simulated storm — demo weather
        </div>
      )}
      {!plan && !loading && (
        <div className="map-empty">
          <i aria-hidden="true" />
          Plan a trip to see routes, checkpoints and the weather heatmap
        </div>
      )}
      <TimelineBar />
    </>
  );
}

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="map-pane">
        <Suspense fallback={<div className="map skeleton" style={{ borderRadius: 0 }} />}>
          <MapView />
        </Suspense>
        <MapOverlays />
      </main>
    </div>
  );
}
