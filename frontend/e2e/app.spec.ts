import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

interface ControllerProbe {
  ready: boolean;
  lastRasterMs: number;
  truckPositions(): Record<string, [number, number]>;
  map: {
    getSource(id: string): { _data?: unknown; serialize?: () => { data: unknown } } | undefined;
    getLayer(id: string): unknown;
    project(lngLat: [number, number]): { x: number; y: number };
    loaded(): boolean;
    triggerRepaint?: () => void;
  };
}

declare global {
  interface Window {
    __mapController?: ControllerProbe;
  }
}

async function planTrip(page: Page, options: { simulated?: boolean } = {}) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dallas → Chicago' }).click();
  if (options.simulated) {
    await page.getByText('Options').click();
    await page.getByRole('radio', { name: 'Simulated storm' }).click();
  }
  await page.getByRole('button', { name: 'Find safest route' }).click();
  await expect(page.getByText('Recommended', { exact: true }).first()).toBeVisible();
  // Heatmap finished loading and the map has drawn it.
  await expect(page.getByText('Loading 48-hour corridor forecast')).toHaveCount(0);
  await page.waitForFunction(() => !!window.__mapController?.map.getLayer('wx-raster'));
}

/** GeoJSON currently held by a map source. */
async function sourceData<T>(page: Page, id: string): Promise<T> {
  return page.evaluate((sourceId) => {
    const src = window.__mapController!.map.getSource(sourceId)!;
    return (src.serialize ? src.serialize().data : src._data) as never;
  }, id) as Promise<T>;
}

interface FC {
  features: { properties: Record<string, unknown>; geometry: { coordinates: unknown } }[];
}

test('plans a trip and renders routes, checkpoints, heatmap and summaries on the map', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await planTrip(page);

  // Three route summary chips on the map, one marked recommended.
  const chips = page.locator('.route-chip');
  await expect(chips).toHaveCount(3);
  await expect(page.locator('.route-chip.is-recommended')).toHaveCount(1);

  const routes = await sourceData<FC>(page, 'routes');
  expect(new Set(routes.features.map((f) => f.properties.routeId))).toEqual(
    new Set(['A', 'B', 'C']),
  );
  const checkpoints = await sourceData<FC>(page, 'checkpoints');
  expect(checkpoints.features.length).toBeGreaterThan(30);
  await expect(page.locator('.truck-marker')).toHaveCount(3);
  await expect(page.locator('.truck-marker.is-selected')).toHaveCount(1);

  // The storm sits on the fastest route, so the recommendation avoids it.
  await expect(page.getByRole('heading', { name: /^Route A via/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('map and sidebar selection stay in sync', async ({ page }) => {
  await planTrip(page);
  await page.locator('.route-chip[data-route-id="A"]').click();
  await expect(page.getByRole('button', { name: /^Route A via/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.route-chip[data-route-id="A"]')).toHaveClass(/is-selected/);
  await expect(page.getByRole('table', { name: 'Checkpoints on Route A' })).toBeVisible();

  await page.getByRole('button', { name: /^Route C via/ }).click();
  await expect(page.locator('.route-chip[data-route-id="C"]')).toHaveClass(/is-selected/);
});

test('checkpoint rows open a popup on the map, and hovering a checkpoint shows details', async ({
  page,
}) => {
  await planTrip(page);
  const table = page.getByRole('table', { name: /Checkpoints on Route/ });
  await table.getByRole('row').nth(3).click();
  const popup = page.locator('.maplibregl-popup');
  await expect(popup).toContainText('Mile');
  await expect(popup).toContainText('ETA');
  await popup.getByRole('button', { name: /close/i }).click();
  await expect(popup).toHaveCount(0);

  // Hover a checkpoint marker directly on the canvas.
  await page.waitForTimeout(900); // let the fly-to settle
  const cp = (await sourceData<FC>(page, 'checkpoints')).features[5]!;
  const point = await page.evaluate(
    (c) => window.__mapController!.map.project(c as [number, number]),
    cp.geometry.coordinates,
  );
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!;
  await page.mouse.move(box.x + point.x, box.y + point.y);
  await expect(page.locator('.maplibregl-popup')).toContainText('Mile');
});

test('hovering a checkpoint row rings it on the map', async ({ page }) => {
  await planTrip(page);
  const table = page.getByRole('table', { name: /Checkpoints on Route/ });
  await table.getByRole('row').nth(2).hover();
  await expect
    .poll(async () => (await sourceData<FC>(page, 'hover-checkpoint')).features.length)
    .toBe(1);
  await page.locator('.sidebar .header').hover();
  await expect
    .poll(async () => (await sourceData<FC>(page, 'hover-checkpoint')).features.length)
    .toBe(0);
});

test('the forecast slider moves trucks and re-renders the heatmap quickly', async ({ page }) => {
  await planTrip(page, { simulated: true });
  const trucks = () => page.evaluate(() => window.__mapController!.truckPositions());
  const before = await trucks();
  const slider = page.getByRole('slider', { name: 'Forecast hour after departure' });
  await slider.fill('6');
  await expect(page.getByText('T+6h after departure')).toBeVisible();
  await page.waitForTimeout(300);
  const after = await trucks();
  expect(Object.keys(after).sort()).toEqual(['A', 'B', 'C']);
  expect(after).not.toEqual(before);

  // Raster pass budget (software WebGL here, so the bound is generous).
  const ms = await page.evaluate(() => window.__mapController!.lastRasterMs);
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThan(60);

  await page.getByRole('radio', { name: 'Wind' }).click();
  await expect(page.getByLabel('Wind scale')).toBeVisible();
  await page.getByRole('button', { name: 'Hide heatmap' }).click();
  await page.getByRole('button', { name: 'Show heatmap' }).click();
});

/** Frames per second the page achieves over `ms`. */
async function measureFps(page: Page, ms = 2000): Promise<number> {
  return page.evaluate(
    (duration) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames += 1;
          if (performance.now() - start < duration) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (performance.now() - start));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

test('playback animates without adding frame cost beyond the map itself', async ({ page }) => {
  await planTrip(page, { simulated: true });
  // Baseline: the map repainting every frame with no app work. On GPU-less CI (software WebGL)
  // this is the hard ceiling; on real hardware it is the display rate.
  await page.evaluate(() => {
    const w = window as unknown as { __spin: boolean };
    w.__spin = true;
    const loop = () => {
      if (!w.__spin) return;
      window.__mapController!.map.triggerRepaint?.();
      requestAnimationFrame(loop);
    };
    loop();
  });
  const baseline = await measureFps(page);
  await page.evaluate(() => ((window as unknown as { __spin: boolean }).__spin = false));

  await page.getByRole('button', { name: 'Play forecast' }).click();
  const playing = await measureFps(page);
  await page.getByRole('button', { name: 'Pause forecast playback' }).click();
  const value = Number(
    await page.getByRole('slider', { name: 'Forecast hour after departure' }).inputValue(),
  );
  expect(value).toBeGreaterThan(2); // ~3 forecast hours per second
  // Heatmap re-rendering, truck updates and React work must not slow the map down noticeably.
  expect(playing).toBeGreaterThan(baseline * 0.7);
  expect(await page.evaluate(() => window.__mapController!.lastRasterMs)).toBeLessThan(40);
});

test('validation and recommendation explanation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Find safest route' }).click();
  await expect(page.getByText('Enter an origin.')).toBeVisible();

  await page.getByRole('combobox', { name: 'Origin' }).fill('Den');
  await page.getByRole('option', { name: /Denver/ }).click();
  await page.getByRole('combobox', { name: 'Destination' }).fill('Salt');
  await page.getByRole('option', { name: /Salt Lake City/ }).click();
  await page.getByRole('button', { name: 'Find safest route' }).click();
  await expect(page.getByText('Recommended', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Show how routes were compared' }).click();
  await expect(page.getByRole('table', { name: /compared criterion by criterion/ })).toBeVisible();
  await page.getByRole('button', { name: 'Edit trip' }).click();
  await expect(page.getByRole('combobox', { name: 'Origin' })).toHaveValue(/Denver/);
});

test('has no serious accessibility violations', async ({ page }) => {
  await planTrip(page);
  const results = await new AxeBuilder({ page })
    .exclude('.maplibregl-canvas') // the WebGL canvas; its content is mirrored in the sidebar table
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
});
