/** Wire contract with the Django API (mirrors backend/planner/api/presenters.py). */

export type RiskLevel = 0 | 1 | 2 | 3 | 4;
export type WindBasis = 'sustained' | 'gust';
export type WeatherSource = 'live' | 'simulated';
export type Factor = 'wind' | 'rain' | 'snow';

export interface Place {
  lat: number;
  lon: number;
  label: string;
}

export interface PlanRequestBody {
  origin: Place;
  destination: Place;
  departure_time: string;
  load_weight_lb: number;
  interval_miles: 10 | 25 | 50;
  hos_breaks: boolean;
  wind_basis: WindBasis;
  weather_source: WeatherSource;
}

export interface Threshold {
  level: RiskLevel;
  value: number;
  inclusive: boolean;
}

export interface ConditionRule {
  unit: string;
  precision: number;
  thresholds: Threshold[];
}

export interface LoadRule {
  wind_min_mph: number;
  wind_max_mph: number;
  load_over_lb: number;
  level: RiskLevel;
}

export interface RiskRules {
  levels: { level: RiskLevel; key: string; label: string }[];
  conditions: Record<Factor, ConditionRule>;
  load_rules: LoadRule[];
}

export interface Conditions {
  wind_mph: number;
  gust_mph: number;
  rain_in_hr: number;
  snow_in_hr: number;
  temperature_f: number | null;
  weather_code: number | null;
  summary: string | null;
}

export interface FactorAssessment {
  factor: Factor;
  value: number;
  unit: string;
  level: RiskLevel;
  base_level: RiskLevel;
  load_escalated: boolean;
}

export interface Checkpoint {
  index: number;
  mile: number;
  span: [number, number];
  lat: number;
  lon: number;
  eta: string;
  elapsed_s: number;
  conditions: Conditions;
  risk: {
    level: RiskLevel;
    label: string;
    drivers: Factor[];
    factors: FactorAssessment[];
  };
}

export interface Stop {
  kind: 'break' | 'rest';
  mile: number;
  lat: number;
  lon: number;
  arrive_time: string;
  depart_time: string;
  duration_s: number;
}

export type MilesByLevel = Record<'low' | 'moderate' | 'high' | 'severe' | 'no_travel', number>;

export interface Route {
  id: string;
  name: string;
  via: string[];
  provider: string;
  synthesized: boolean;
  rank: number;
  recommended: boolean;
  distance_mi: number;
  drive_time_s: number;
  stop_time_s: number;
  total_time_s: number;
  departure_time: string;
  arrival_time: string;
  risk: {
    miles_by_level: MilesByLevel;
    avg_risk: number;
    max_level: RiskLevel;
    max_label: string;
  };
  path: {
    coordinates: [number, number][];
    miles: number[];
    elapsed_s: number[];
  };
  stops: Stop[];
  checkpoints: Checkpoint[];
}

export type CriterionKey = 'no_travel_mi' | 'severe_mi' | 'high_mi' | 'avg_risk' | 'travel_time_s';

export interface Stage {
  criterion: CriterionKey;
  label: string;
  values: Record<string, number>;
  best: number;
  kept: string[];
  eliminated: string[];
}

export interface Recommendation {
  route_id: string;
  ranking: string[];
  reasons: string[];
  deciding_criterion: CriterionKey | null;
  stages: Stage[];
}

export interface Notice {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'danger';
}

export interface Storm {
  lat: number;
  lon: number;
  t0: number;
  heading_deg: number;
  speed_mph: number;
  radius_mi: number;
  peak_wind_mph: number;
  peak_rain_in_hr: number;
  peak_snow_in_hr: number;
}

export interface Scenario {
  storms: Storm[];
}

export interface PlanResponse {
  generated_at: string;
  inputs: Omit<PlanRequestBody, 'interval_miles'> & { interval_miles: number };
  rules: RiskRules;
  routing: { provider: string };
  weather: { provider: string; simulated: boolean; scenario: Scenario | null };
  routes: Route[];
  recommendation: Recommendation;
  notices: Notice[];
}

export interface HeatmapRequestBody {
  routes: [number, number][][];
  departure_time: string;
  hours?: number;
  scenario?: Scenario | null;
}

export interface Grid {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nx: number;
  ny: number;
  spacing_mi: number;
  half_width_mi: number;
}

export interface HeatmapResponse {
  provider: string;
  simulated: boolean;
  grid: Grid;
  cells: number[];
  start_time: string;
  start_ts: number;
  step_s: number;
  frames: number;
  fields: Record<'wind' | 'gust' | 'rain' | 'snow', number[]>;
}

export interface GeocodeResult {
  label: string;
  name: string;
  context: string;
  lat: number;
  lon: number;
  kind: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    provider?: string;
    fields?: Record<string, unknown>;
  };
}
