import { create } from 'zustand';

import { api, ApiError, isAbort } from '../api/client';
import type {
  HeatmapResponse,
  PlanRequestBody,
  PlanResponse,
  WeatherSource,
  WindBasis,
} from '../api/types';
import { nextQuarterHour, toLocalInputValue } from '../lib/format';
import type { Metric } from '../lib/heatmapRaster';
import { decimate } from '../lib/routeGeometry';
import { MAX_HOURS } from './constants';

export interface PlaceValue {
  label: string;
  lat: number | null;
  lon: number | null;
}

export interface FormState {
  origin: PlaceValue;
  destination: PlaceValue;
  departureLocal: string;
  loadLb: number;
  intervalMi: 10 | 25 | 50;
  hosBreaks: boolean;
  windBasis: WindBasis;
  weatherSource: WeatherSource;
}

type Status = 'idle' | 'loading' | 'success' | 'error';

export interface FocusedCheckpoint {
  routeId: string;
  index: number;
  /** Bumped on every request so re-clicking the same row still re-centres the map. */
  nonce: number;
}

export interface AppState {
  form: FormState;
  plan: PlanResponse | null;
  planStatus: Status;
  planError: ApiError | null;
  heatmap: HeatmapResponse | null;
  heatmapStatus: Status;
  heatmapError: ApiError | null;
  selectedRouteId: string | null;
  hoveredRouteId: string | null;
  focusedCheckpoint: FocusedCheckpoint | null;
  hoveredCheckpoint: { routeId: string; index: number } | null;
  /** Hours after departure shown by the heatmap / truck markers (0..48). */
  timeHours: number;
  playing: boolean;
  metric: Metric;
  heatmapVisible: boolean;
  heatmapOpacity: number;

  setForm: (patch: Partial<FormState>) => void;
  submitPlan: (body: PlanRequestBody) => Promise<void>;
  retryHeatmap: () => void;
  selectRoute: (id: string) => void;
  hoverRoute: (id: string | null) => void;
  focusCheckpoint: (routeId: string, index: number) => void;
  hoverCheckpoint: (routeId: string, index: number) => void;
  clearCheckpointHover: () => void;
  setTime: (hours: number) => void;
  setPlaying: (playing: boolean) => void;
  setMetric: (metric: Metric) => void;
  setHeatmapVisible: (visible: boolean) => void;
  setHeatmapOpacity: (opacity: number) => void;
  reset: () => void;
}

export { MAX_HOURS };
const HEATMAP_POINTS_PER_ROUTE = 400;

export function initialForm(): FormState {
  return {
    origin: { label: '', lat: null, lon: null },
    destination: { label: '', lat: null, lon: null },
    departureLocal: toLocalInputValue(nextQuarterHour()),
    loadLb: 38_000,
    intervalMi: 25,
    hosBreaks: true,
    windBasis: 'sustained',
    weatherSource: 'live',
  };
}

let planController: AbortController | null = null;
let heatmapController: AbortController | null = null;

function toApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('Unexpected error. Please retry.', 'client_error', 0);
}

export const useAppStore = create<AppState>()((set, get) => {
  const loadHeatmap = async (plan: PlanResponse) => {
    heatmapController?.abort();
    const controller = new AbortController();
    heatmapController = controller;
    set({ heatmap: null, heatmapStatus: 'loading', heatmapError: null });
    try {
      const heatmap = await api.heatmap(
        {
          routes: plan.routes.map((r) => decimate(r.path.coordinates, HEATMAP_POINTS_PER_ROUTE)),
          departure_time: plan.inputs.departure_time,
          hours: MAX_HOURS,
          scenario: plan.weather.scenario,
        },
        controller.signal,
      );
      if (get().plan === plan) set({ heatmap, heatmapStatus: 'success' });
    } catch (error) {
      if (isAbort(error) || get().plan !== plan) return;
      set({ heatmapStatus: 'error', heatmapError: toApiError(error) });
    }
  };

  return {
    form: initialForm(),
    plan: null,
    planStatus: 'idle',
    planError: null,
    heatmap: null,
    heatmapStatus: 'idle',
    heatmapError: null,
    selectedRouteId: null,
    hoveredRouteId: null,
    focusedCheckpoint: null,
    hoveredCheckpoint: null,
    timeHours: 0,
    playing: false,
    metric: 'risk',
    heatmapVisible: true,
    heatmapOpacity: 0.85,

    setForm: (patch) => set((s) => ({ form: { ...s.form, ...patch } })),

    submitPlan: async (body) => {
      // The previous plan's heatmap keeps loading: if this request fails, that plan stays
      // on screen. loadHeatmap() aborts it once a new plan arrives.
      planController?.abort();
      const controller = new AbortController();
      planController = controller;
      set({ planStatus: 'loading', planError: null, playing: false });
      try {
        const plan = await api.plan(body, controller.signal);
        set({
          plan,
          planStatus: 'success',
          selectedRouteId: plan.recommendation.route_id,
          hoveredRouteId: null,
          focusedCheckpoint: null,
          hoveredCheckpoint: null,
          timeHours: 0,
        });
        void loadHeatmap(plan);
      } catch (error) {
        if (isAbort(error)) return;
        set({ planStatus: 'error', planError: toApiError(error) });
      }
    },

    retryHeatmap: () => {
      const plan = get().plan;
      if (plan) void loadHeatmap(plan);
    },

    selectRoute: (id) => set({ selectedRouteId: id }),
    hoverRoute: (id) => set({ hoveredRouteId: id }),
    focusCheckpoint: (routeId, index) =>
      set((s) => ({
        selectedRouteId: routeId,
        focusedCheckpoint: { routeId, index, nonce: (s.focusedCheckpoint?.nonce ?? 0) + 1 },
      })),
    hoverCheckpoint: (routeId, index) => set({ hoveredCheckpoint: { routeId, index } }),
    clearCheckpointHover: () => set({ hoveredCheckpoint: null }),
    setTime: (hours) => set({ timeHours: Math.min(Math.max(hours, 0), MAX_HOURS) }),
    setPlaying: (playing) =>
      set((s) => ({ playing, timeHours: playing && s.timeHours >= MAX_HOURS ? 0 : s.timeHours })),
    setMetric: (metric) => set({ metric }),
    setHeatmapVisible: (heatmapVisible) => set({ heatmapVisible }),
    setHeatmapOpacity: (heatmapOpacity) => set({ heatmapOpacity }),
    reset: () => {
      planController?.abort();
      heatmapController?.abort();
      set({
        plan: null,
        planStatus: 'idle',
        planError: null,
        heatmap: null,
        heatmapStatus: 'idle',
        heatmapError: null,
        selectedRouteId: null,
        focusedCheckpoint: null,
        hoveredCheckpoint: null,
        timeHours: 0,
        playing: false,
      });
    },
  };
});

export const selectSelectedRoute = (s: AppState) =>
  s.plan?.routes.find((r) => r.id === s.selectedRouteId) ?? null;
