import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useRef } from 'react';

import { heatmapModel } from '../lib/heatmapModel';
import { useAppStore, type AppState } from '../state/store';
import { MapController } from './mapController';

function departureTs(state: AppState): number {
  return state.plan ? new Date(state.plan.inputs.departure_time).getTime() / 1000 : 0;
}

function syncHeatmap(controller: MapController, s: AppState) {
  const model = s.heatmap ? heatmapModel(s.heatmap) : null;
  controller.setHeatmap(model, s.plan?.rules ?? null, s.plan?.inputs.load_weight_lb ?? 0);
}

function heatStyle(s: AppState) {
  return {
    metric: s.metric,
    windBasis: s.plan?.inputs.wind_basis ?? 'sustained',
    visible: s.heatmapVisible,
    opacity: s.heatmapOpacity,
  } as const;
}

/** Hosts the map. Store changes reach the controller directly, so scrubbing never re-renders. */
export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { selectRoute, hoverRoute, focusCheckpoint } = useAppStore.getState();
    const controller = new MapController(container, {
      onSelectRoute: selectRoute,
      onHoverRoute: hoverRoute,
      onFocusCheckpoint: focusCheckpoint,
    });
    // Exposed for the e2e suite.
    (window as unknown as { __mapController?: MapController }).__mapController = controller;

    const initial = useAppStore.getState();
    controller.setPlan(initial.plan);
    controller.setSelection(initial.selectedRouteId);
    controller.setHeatmapStyle(heatStyle(initial));
    syncHeatmap(controller, initial);
    controller.setTime(departureTs(initial) + initial.timeHours * 3600);

    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.plan !== prev.plan) controller.setPlan(s.plan);
      if (s.selectedRouteId !== prev.selectedRouteId || s.plan !== prev.plan) {
        controller.setSelection(s.selectedRouteId);
      }
      if (s.hoveredRouteId !== prev.hoveredRouteId) controller.setHover(s.hoveredRouteId);
      if (
        s.metric !== prev.metric ||
        s.heatmapVisible !== prev.heatmapVisible ||
        s.heatmapOpacity !== prev.heatmapOpacity ||
        s.plan !== prev.plan
      ) {
        controller.setHeatmapStyle(heatStyle(s));
      }
      if (s.heatmap !== prev.heatmap) syncHeatmap(controller, s);
      if (s.timeHours !== prev.timeHours || s.plan !== prev.plan || s.heatmap !== prev.heatmap) {
        controller.setTime(departureTs(s) + s.timeHours * 3600);
      }
      if (s.hoveredCheckpoint !== prev.hoveredCheckpoint) {
        controller.setHoveredCheckpoint(s.hoveredCheckpoint);
      }
      if (s.focusedCheckpoint && s.focusedCheckpoint !== prev.focusedCheckpoint) {
        controller.focusCheckpoint(s.focusedCheckpoint.routeId, s.focusedCheckpoint.index);
      }
    });

    const resize = new ResizeObserver(() => controller.map.resize());
    resize.observe(container);

    return () => {
      unsubscribe();
      resize.disconnect();
      controller.destroy();
      delete (window as unknown as { __mapController?: MapController }).__mapController;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="map"
      role="region"
      aria-label="Route map with weather heatmap. The sidebar lists the same routes and checkpoints."
    />
  );
}
