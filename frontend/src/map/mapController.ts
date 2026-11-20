// Imperative MapLibre wrapper; time-driven updates are batched into one animation frame.
import maplibregl, {
  type CanvasSource,
  type GeoJSONSource,
  type Map as MLMap,
  type MapLayerMouseEvent,
  type Marker,
} from 'maplibre-gl';

import type { FeatureCollection } from 'geojson';

import type { PlanResponse, Route, RiskRules, WindBasis } from '../api/types';
import { buildLut, METRIC_SCALES } from '../lib/colors';
import type { HeatmapModel } from '../lib/heatmapModel';
import { renderRaster, type Metric } from '../lib/heatmapRaster';
import { makeLevelTables, RISK_COLORS, type LevelTables } from '../lib/risk';
import { boundsOf, labelAnchors, riskRuns, truckPosition } from '../lib/routeGeometry';
import { allocCellValues, sampleCells, type CellValues } from '../lib/sampling';
import { checkpointPopupHtml, routeChipHtml, stopMarkerHtml, stopTitle } from './markup';

export const MAP_STYLE_URL =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/positron';

const SRC = {
  routes: 'routes',
  checkpoints: 'checkpoints',
  focus: 'focus',
  hover: 'hover-checkpoint',
  wx: 'wx',
};
const LYR = {
  wx: 'wx-raster',
  casingOther: 'route-casing-other',
  lineOther: 'route-line-other',
  hover: 'route-hover',
  casingSel: 'route-casing-selected',
  lineSel: 'route-line-selected',
  cpOther: 'cp-other',
  cpSel: 'cp-selected',
  cpFocus: 'cp-focus',
  cpHover: 'cp-hover',
};
const ACCENT = '#1f9e89';
const BRAND = '#0b3c49';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const NONE = ['==', ['get', 'routeId'], '__none__'] as maplibregl.FilterSpecification;

const levelColor = [
  'match',
  ['get', 'level'],
  0,
  RISK_COLORS[0],
  1,
  RISK_COLORS[1],
  2,
  RISK_COLORS[2],
  3,
  RISK_COLORS[3],
  4,
  RISK_COLORS[4],
  '#888888',
] as unknown as maplibregl.ExpressionSpecification;

export interface MapCallbacks {
  onSelectRoute: (id: string) => void;
  onHoverRoute: (id: string | null) => void;
  onFocusCheckpoint: (routeId: string, index: number) => void;
}

export interface HeatmapStyle {
  metric: Metric;
  windBasis: WindBasis;
  visible: boolean;
  opacity: number;
}

interface HeatState {
  model: HeatmapModel;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  values: CellValues;
  tables: LevelTables;
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export class MapController {
  readonly map: MLMap;
  private ready = false;
  private queue: (() => void)[] = [];
  private plan: PlanResponse | null = null;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private endpointMarkers: Marker[] = [];
  private chipMarkers = new Map<string, Marker>();
  private chipButtons = new Map<string, HTMLButtonElement>();
  private stopMarkers: Marker[] = [];
  private truckMarkers = new Map<string, Marker>();
  private hoverPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
    maxWidth: '280px',
  });
  private pinnedPopup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,
    offset: 12,
    maxWidth: '280px',
  });
  private heat: HeatState | null = null;
  private heatStyle: HeatmapStyle = {
    metric: 'risk',
    windBasis: 'sustained',
    visible: true,
    opacity: 0.85,
  };
  private luts = {
    wind: buildLut(METRIC_SCALES.wind.ramp),
    rain: buildLut(METRIC_SCALES.rain.ramp),
    snow: buildLut(METRIC_SCALES.snow.ramp),
  };
  private maxima = {
    wind: METRIC_SCALES.wind.max,
    rain: METRIC_SCALES.rain.max,
    snow: METRIC_SCALES.snow.max,
  };
  private timeTs = 0;
  private raf: number | null = null;
  private dirtyHeat = false;
  private dirtyTrucks = false;
  /** Duration of the last raster pass in ms (read by the e2e perf checks). */
  lastRasterMs = 0;

  constructor(
    container: HTMLElement,
    private callbacks: MapCallbacks,
  ) {
    this.map = new maplibregl.Map({
      container,
      style: MAP_STYLE_URL,
      center: [-96.5, 38.5],
      zoom: 3.6,
      minZoom: 2,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: true },
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
    this.map.on('load', () => {
      this.installLayers();
      this.ready = true;
      for (const fn of this.queue.splice(0)) fn();
    });
    this.map.on('error', (e) => console.warn('Map error:', e.error?.message ?? e));
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.clearMarkers();
    this.map.remove();
  }

  private whenReady(fn: () => void): void {
    if (this.ready) fn();
    else this.queue.push(fn);
  }

  // ---------------------------------------------------------------- layers

  private firstSymbolLayer(): string | undefined {
    return this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  }

  private installLayers(): void {
    const m = this.map;
    for (const id of [SRC.routes, SRC.checkpoints, SRC.focus, SRC.hover]) {
      m.addSource(id, { type: 'geojson', data: EMPTY });
    }
    const below = this.firstSymbolLayer();
    const none = NONE;
    const lineLayout: maplibregl.LineLayerSpecification['layout'] = {
      'line-cap': 'round',
      'line-join': 'round',
    };

    m.addLayer(
      {
        id: LYR.casingOther,
        type: 'line',
        source: SRC.routes,
        filter: none,
        layout: lineLayout,
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 8],
          'line-opacity': 0.85,
        },
      },
      below,
    );
    m.addLayer(
      {
        id: LYR.lineOther,
        type: 'line',
        source: SRC.routes,
        filter: none,
        layout: lineLayout,
        paint: {
          'line-color': levelColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.2, 10, 5],
          'line-opacity': 0.6,
        },
      },
      below,
    );
    m.addLayer(
      {
        id: LYR.hover,
        type: 'line',
        source: SRC.routes,
        filter: none,
        layout: lineLayout,
        paint: {
          'line-color': levelColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 8],
          'line-opacity': 0.95,
        },
      },
      below,
    );
    m.addLayer(
      {
        id: LYR.casingSel,
        type: 'line',
        source: SRC.routes,
        filter: none,
        layout: lineLayout,
        paint: {
          'line-color': BRAND,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 7, 10, 13],
        },
      },
      below,
    );
    m.addLayer(
      {
        id: LYR.lineSel,
        type: 'line',
        source: SRC.routes,
        filter: none,
        layout: lineLayout,
        paint: {
          'line-color': levelColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 8],
        },
      },
      below,
    );

    m.addLayer({
      id: LYR.cpOther,
      type: 'circle',
      source: SRC.checkpoints,
      filter: none,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 9, 5],
        'circle-color': levelColor,
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
      },
    });
    m.addLayer({
      id: LYR.cpSel,
      type: 'circle',
      source: SRC.checkpoints,
      filter: none,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4.5, 9, 8],
        'circle-color': levelColor,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    m.addLayer({
      id: LYR.cpFocus,
      type: 'circle',
      source: SRC.focus,
      paint: {
        'circle-radius': 13,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': BRAND,
        'circle-stroke-width': 3,
      },
    });
    m.addLayer({
      id: LYR.cpHover,
      type: 'circle',
      source: SRC.hover,
      paint: {
        'circle-radius': 11,
        'circle-color': 'rgba(31,158,137,0.18)',
        'circle-stroke-color': ACCENT,
        'circle-stroke-width': 2.5,
      },
    });

    for (const layer of [LYR.lineOther, LYR.lineSel, LYR.hover]) {
      m.on('mouseenter', layer, this.onRouteEnter);
      m.on('mouseleave', layer, this.onRouteLeave);
      m.on('click', layer, this.onRouteClick);
    }
    for (const layer of [LYR.cpOther, LYR.cpSel]) {
      m.on('mousemove', layer, this.onCheckpointHover);
      m.on('mouseleave', layer, this.onCheckpointLeave);
      m.on('click', layer, this.onCheckpointClick);
    }
  }

  // ---------------------------------------------------------------- interactions

  private onRouteEnter = (e: MapLayerMouseEvent) => {
    this.map.getCanvas().style.cursor = 'pointer';
    const id = e.features?.[0]?.properties?.routeId as string | undefined;
    if (id) this.callbacks.onHoverRoute(id);
  };

  private onRouteLeave = () => {
    this.map.getCanvas().style.cursor = '';
    this.callbacks.onHoverRoute(null);
  };

  private onRouteClick = (e: MapLayerMouseEvent) => {
    // A checkpoint on top of the line takes precedence.
    if (this.map.queryRenderedFeatures(e.point, { layers: [LYR.cpOther, LYR.cpSel] }).length)
      return;
    const id = e.features?.[0]?.properties?.routeId as string | undefined;
    if (id) this.callbacks.onSelectRoute(id);
  };

  private checkpointFromEvent(e: MapLayerMouseEvent) {
    const props = e.features?.[0]?.properties;
    if (!props || !this.plan) return null;
    const route = this.plan.routes.find((r) => r.id === props.routeId);
    const cp = route?.checkpoints[props.index as number];
    return route && cp ? { route, cp } : null;
  }

  private onCheckpointHover = (e: MapLayerMouseEvent) => {
    this.map.getCanvas().style.cursor = 'pointer';
    const hit = this.checkpointFromEvent(e);
    if (!hit || !this.plan) return;
    this.hoverPopup
      .setLngLat([hit.cp.lon, hit.cp.lat])
      .setHTML(checkpointPopupHtml(hit.route, hit.cp, this.plan.inputs.departure_time))
      .addTo(this.map);
  };

  private onCheckpointLeave = () => {
    this.map.getCanvas().style.cursor = '';
    this.hoverPopup.remove();
  };

  private onCheckpointClick = (e: MapLayerMouseEvent) => {
    const hit = this.checkpointFromEvent(e);
    if (hit) this.callbacks.onFocusCheckpoint(hit.route.id, hit.cp.index);
  };

  // ---------------------------------------------------------------- plan

  setPlan(plan: PlanResponse | null): void {
    this.plan = plan;
    this.whenReady(() => {
      this.hoverPopup.remove();
      this.pinnedPopup.remove();
      this.clearMarkers();
      const routes = plan?.routes ?? [];
      this.geo(SRC.routes).setData({
        type: 'FeatureCollection',
        features: routes.flatMap((r) =>
          riskRuns(r).map((run) => ({
            type: 'Feature' as const,
            properties: { routeId: r.id, level: run.level },
            geometry: { type: 'LineString' as const, coordinates: run.coordinates },
          })),
        ),
      });
      this.geo(SRC.checkpoints).setData({
        type: 'FeatureCollection',
        features: routes.flatMap((r) =>
          r.checkpoints.map((c) => ({
            type: 'Feature' as const,
            properties: { routeId: r.id, index: c.index, level: c.risk.level },
            geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
          })),
        ),
      });
      this.geo(SRC.focus).setData(EMPTY);
      this.geo(SRC.hover).setData(EMPTY);
      if (!plan) return;
      this.fadeIn();
      this.addEndpointMarkers(plan);
      this.addRouteChips(plan.routes);
      this.addTruckMarkers(plan.routes);
      const [sw, ne] = boundsOf(plan.routes);
      // Next frame: the timeline bar has rendered and published its height by then.
      requestAnimationFrame(() =>
        this.map.fitBounds([sw, ne], {
          padding: { top: 80, bottom: this.timelineHeight() + 50, left: 70, right: 70 },
          duration: reducedMotion() ? 0 : 900,
          maxZoom: 11,
        }),
      );
      this.applySelection();
      this.dirtyTrucks = true;
      this.schedule();
    });
  }

  /** Routes draw in first, checkpoints follow. */
  private fadeIn(): void {
    const targets: [string, 'line-opacity' | 'circle-opacity', number, number][] = [
      [LYR.casingOther, 'line-opacity', 0.85, 0],
      [LYR.lineOther, 'line-opacity', 0.6, 0],
      [LYR.casingSel, 'line-opacity', 1, 0],
      [LYR.lineSel, 'line-opacity', 1, 0],
      [LYR.cpOther, 'circle-opacity', 0.85, 450],
      [LYR.cpSel, 'circle-opacity', 1, 450],
    ];
    if (reducedMotion()) return;
    for (const [layer, prop] of targets) {
      this.map.setPaintProperty(layer, `${prop}-transition`, { duration: 0, delay: 0 });
      this.map.setPaintProperty(layer, prop, 0);
    }
    requestAnimationFrame(() => {
      for (const [layer, prop, value, delay] of targets) {
        this.map.setPaintProperty(layer, `${prop}-transition`, { duration: 700, delay });
        this.map.setPaintProperty(layer, prop, value);
      }
    });
  }

  /** Height of the floating timeline bar, published as a CSS variable on the map pane. */
  private timelineHeight(): number {
    const pane = this.map.getContainer().parentElement;
    const raw = pane ? getComputedStyle(pane).getPropertyValue('--timeline-h') : '';
    const h = Number.parseFloat(raw);
    return Number.isFinite(h) ? h : 200;
  }

  private geo(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource;
  }

  private clearMarkers(): void {
    const all = [
      ...this.endpointMarkers,
      ...this.chipMarkers.values(),
      ...this.stopMarkers,
      ...this.truckMarkers.values(),
    ];
    for (const m of all) m.remove();
    this.endpointMarkers = [];
    this.chipMarkers.clear();
    this.chipButtons.clear();
    this.stopMarkers = [];
    this.truckMarkers.clear();
  }

  private addEndpointMarkers(plan: PlanResponse): void {
    const make = (cls: string, title: string, lngLat: [number, number]) => {
      const el = document.createElement('div');
      el.className = `endpoint-marker ${cls}`;
      el.innerHTML = '<span class="pin"></span>';
      el.title = title;
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', title);
      return new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat(lngLat)
        .addTo(this.map);
    };
    const { origin, destination } = plan.inputs;
    this.endpointMarkers = [
      make('is-origin', `Origin: ${origin.label || 'start'}`, [origin.lon, origin.lat]),
      make('is-destination', `Destination: ${destination.label || 'end'}`, [
        destination.lon,
        destination.lat,
      ]),
    ];
  }

  private addRouteChips(routes: Route[]): void {
    const anchors = labelAnchors(routes);
    routes.forEach((route, i) => {
      // MapLibre positions markers with `transform` on the root element, so the animated chip
      // lives inside a plain wrapper.
      const anchor = document.createElement('div');
      anchor.className = 'route-chip-anchor';
      // Explicit role, otherwise MapLibre makes the wrapper a button around our button.
      anchor.setAttribute('role', 'group');
      anchor.setAttribute('aria-label', `${route.name} summary`);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'route-chip';
      el.style.setProperty('--i', String(i));
      anchor.appendChild(el);
      el.dataset.routeId = route.id;
      el.setAttribute('aria-label', `Select ${route.name}`);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.callbacks.onSelectRoute(route.id);
      });
      el.addEventListener('mouseenter', () => this.callbacks.onHoverRoute(route.id));
      el.addEventListener('mouseleave', () => this.callbacks.onHoverRoute(null));
      const marker = new maplibregl.Marker({ element: anchor, anchor: 'bottom', offset: [0, -8] })
        .setLngLat(anchors[route.id]!)
        .addTo(this.map);
      this.chipMarkers.set(route.id, marker);
      this.chipButtons.set(route.id, el);
    });
  }

  private addTruckMarkers(routes: Route[]): void {
    for (const route of routes) {
      const el = document.createElement('div');
      el.className = 'truck-marker';
      el.dataset.routeId = route.id;
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('role', 'presentation');
      el.setAttribute('aria-label', `Truck ${route.id}`);
      el.innerHTML = `<span class="truck-pulse"></span><span class="truck-body">${route.id}</span>`;
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(route.path.coordinates[0]!)
        .addTo(this.map);
      this.truckMarkers.set(route.id, marker);
    }
  }

  /** Current truck marker positions keyed by route id (used by the e2e suite). */
  truckPositions(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    for (const [id, m] of this.truckMarkers) out[id] = m.getLngLat().toArray();
    return out;
  }

  /** Light ring under the checkpoint hovered in the sidebar table. */
  setHoveredCheckpoint(target: { routeId: string; index: number } | null): void {
    this.whenReady(() => {
      const cp = target
        ? this.plan?.routes.find((r) => r.id === target.routeId)?.checkpoints[target.index]
        : undefined;
      this.geo(SRC.hover).setData(
        cp
          ? {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'Point', coordinates: [cp.lon, cp.lat] },
                },
              ],
            }
          : EMPTY,
      );
    });
  }

  // ---------------------------------------------------------------- selection

  setSelection(id: string | null): void {
    this.selectedId = id;
    this.whenReady(() => this.applySelection());
  }

  setHover(id: string | null): void {
    this.hoveredId = id;
    this.whenReady(() => this.applyHover());
  }

  private applySelection(): void {
    const id = this.selectedId ?? '__none__';
    const sel = ['==', ['get', 'routeId'], id] as maplibregl.FilterSpecification;
    const other = ['!=', ['get', 'routeId'], id] as maplibregl.FilterSpecification;
    const hasPlan = !!this.plan;
    const m = this.map;
    m.setFilter(LYR.casingSel, hasPlan ? sel : NONE);
    m.setFilter(LYR.lineSel, hasPlan ? sel : NONE);
    m.setFilter(LYR.cpSel, hasPlan ? sel : NONE);
    m.setFilter(LYR.casingOther, hasPlan ? other : NONE);
    m.setFilter(LYR.lineOther, hasPlan ? other : NONE);
    m.setFilter(LYR.cpOther, hasPlan ? other : NONE);
    for (const [routeId, el] of this.chipButtons) {
      const route = this.plan?.routes.find((r) => r.id === routeId);
      const selected = routeId === this.selectedId;
      el.classList.toggle('is-selected', selected);
      el.classList.toggle('is-recommended', !!route?.recommended);
      el.setAttribute('aria-pressed', String(selected));
      if (route) el.innerHTML = routeChipHtml(route, selected);
      this.chipMarkers.get(routeId)!.getElement().style.zIndex = selected
        ? '3'
        : route?.recommended
          ? '2'
          : '1';
    }
    this.renderStopMarkers();
    this.applyHover();
    this.dirtyTrucks = true;
    this.schedule();
  }

  private applyHover(): void {
    const h = this.hoveredId && this.hoveredId !== this.selectedId ? this.hoveredId : '__none__';
    this.map.setFilter(LYR.hover, ['==', ['get', 'routeId'], h]);
    for (const [routeId, el] of this.chipButtons) {
      el.classList.toggle('is-hovered', routeId === this.hoveredId);
    }
  }

  private renderStopMarkers(): void {
    for (const m of this.stopMarkers) m.remove();
    this.stopMarkers = [];
    const route = this.plan?.routes.find((r) => r.id === this.selectedId);
    if (!route) return;
    for (const stop of route.stops) {
      const el = document.createElement('div');
      el.className = 'stop-marker-anchor';
      el.innerHTML = `<span class="stop-marker is-${stop.kind}">${stopMarkerHtml(stop)}</span>`;
      el.title = stopTitle(stop);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', stopTitle(stop));
      this.stopMarkers.push(
        new maplibregl.Marker({ element: el }).setLngLat([stop.lon, stop.lat]).addTo(this.map),
      );
    }
  }

  focusCheckpoint(routeId: string, index: number): void {
    this.whenReady(() => {
      const route = this.plan?.routes.find((r) => r.id === routeId);
      const cp = route?.checkpoints[index];
      if (!route || !cp || !this.plan) return;
      this.geo(SRC.focus).setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [cp.lon, cp.lat] },
          },
        ],
      });
      this.hoverPopup.remove();
      this.pinnedPopup
        .setLngLat([cp.lon, cp.lat])
        .setHTML(checkpointPopupHtml(route, cp, this.plan.inputs.departure_time))
        .addTo(this.map);
      this.map.easeTo({
        center: [cp.lon, cp.lat],
        zoom: Math.max(this.map.getZoom(), 7),
        duration: reducedMotion() ? 0 : 700,
      });
    });
  }

  // ---------------------------------------------------------------- heatmap

  setHeatmap(model: HeatmapModel | null, rules: RiskRules | null, loadLb: number): void {
    this.whenReady(() => {
      if (this.map.getLayer(LYR.wx)) this.map.removeLayer(LYR.wx);
      if (this.map.getSource(SRC.wx)) this.map.removeSource(SRC.wx);
      this.heat = null;
      if (!model || !rules) return;
      const { geometry } = model;
      const canvas = document.createElement('canvas');
      canvas.width = geometry.width;
      canvas.height = geometry.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      this.heat = {
        model,
        canvas,
        ctx,
        image: ctx.createImageData(geometry.width, geometry.height),
        values: allocCellValues(model.frames.cells),
        tables: makeLevelTables(rules, loadLb),
      };
      this.drawHeat(); // paint before the source reads the canvas for the first time
      this.map.addSource(SRC.wx, {
        type: 'canvas',
        canvas,
        coordinates: geometry.coordinates,
        animate: false,
      });
      this.map.addLayer(
        {
          id: LYR.wx,
          type: 'raster',
          source: SRC.wx,
          layout: { visibility: this.heatStyle.visible ? 'visible' : 'none' },
          paint: {
            'raster-opacity': this.heatStyle.opacity,
            'raster-resampling': 'linear',
            'raster-fade-duration': 0,
          },
        },
        LYR.casingOther,
      );
    });
  }

  setHeatmapStyle(style: HeatmapStyle): void {
    const prev = this.heatStyle;
    this.heatStyle = style;
    this.whenReady(() => {
      if (!this.map.getLayer(LYR.wx)) return;
      if (style.visible !== prev.visible) {
        this.map.setLayoutProperty(LYR.wx, 'visibility', style.visible ? 'visible' : 'none');
      }
      if (style.opacity !== prev.opacity)
        this.map.setPaintProperty(LYR.wx, 'raster-opacity', style.opacity);
      if (
        style.metric !== prev.metric ||
        style.windBasis !== prev.windBasis ||
        style.visible !== prev.visible
      ) {
        this.dirtyHeat = true;
        this.schedule();
      }
    });
  }

  /** Absolute unix time (seconds) shown by the heatmap and truck markers. */
  setTime(ts: number): void {
    this.timeTs = ts;
    this.dirtyHeat = true;
    this.dirtyTrucks = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf !== null || !this.ready) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      if (this.dirtyHeat) {
        this.dirtyHeat = false;
        if (this.heat && this.heatStyle.visible) {
          this.drawHeat();
          const src = this.map.getSource(SRC.wx) as CanvasSource | undefined;
          if (src) {
            // play() requests a repaint; pause() re-uploads the canvas texture once.
            src.play();
            src.pause();
          }
        }
      }
      if (this.dirtyTrucks) {
        this.dirtyTrucks = false;
        this.updateTrucks();
      }
    });
  }

  private drawHeat(): void {
    const h = this.heat;
    if (!h) return;
    const t0 = performance.now();
    sampleCells(h.model.frames, this.timeTs || h.model.frames.startTs, h.values);
    renderRaster(h.model.geometry, h.values, h.image.data, {
      metric: this.heatStyle.metric,
      useGusts: this.heatStyle.windBasis === 'gust',
      tables: h.tables,
      luts: this.luts,
      maxima: this.maxima,
      opacity: 1,
    });
    h.ctx.putImageData(h.image, 0, 0);
    this.lastRasterMs = performance.now() - t0;
  }

  private updateTrucks(): void {
    const plan = this.plan;
    if (!plan) return;
    const departure = new Date(plan.inputs.departure_time).getTime() / 1000;
    const elapsed = (this.timeTs || departure) - departure;
    for (const route of plan.routes) {
      const marker = this.truckMarkers.get(route.id);
      if (!marker) continue;
      const pos = truckPosition(route, elapsed);
      marker.setLngLat(pos.coord);
      const el = marker.getElement();
      el.classList.toggle('is-selected', route.id === this.selectedId);
      el.classList.toggle('is-stopped', pos.state === 'stopped');
      el.classList.toggle('is-arrived', pos.state === 'arrived');
    }
  }
}
