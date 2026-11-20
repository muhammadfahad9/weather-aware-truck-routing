import type { HeatmapResponse } from '../api/types';
import { buildRasterGeometry, type RasterGeometry } from './heatmapRaster';
import { framesFromResponse, type FieldFrames } from './sampling';

export interface HeatmapModel {
  response: HeatmapResponse;
  frames: FieldFrames;
  geometry: RasterGeometry;
}

const cache = new WeakMap<HeatmapResponse, HeatmapModel>();

/** Typed-array view of a heatmap response, built once and shared by the map and the readout. */
export function heatmapModel(response: HeatmapResponse): HeatmapModel {
  let model = cache.get(response);
  if (!model) {
    model = {
      response,
      frames: framesFromResponse(response),
      geometry: buildRasterGeometry(response.grid, response.cells),
    };
    cache.set(response, model);
  }
  return model;
}
