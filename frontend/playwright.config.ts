import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8020);
const python = process.env.E2E_PYTHON ?? '../backend/.venv/bin/python';

/**
 * End-to-end tests run the real Django server (serving the production build) with fully
 * offline providers — deterministic routes, synthetic storm weather and a local gazetteer —
 * in a real Chromium with WebGL, so the map, heatmap and interactions are exercised for real.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Software WebGL so the suite also runs on GPU-less CI machines.
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, channel: process.env.E2E_CHANNEL },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], channel: process.env.E2E_CHANNEL },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: {
    command: `"${python}" ../backend/manage.py runserver 127.0.0.1:${PORT} --noreload`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      DJANGO_DEBUG: '1',
      ROUTING_PROVIDER: 'simulated',
      ROUTING_FALLBACK: '',
      WEATHER_PROVIDER: 'simulated',
      GEOCODER: 'gazetteer',
      ROUTING_MIN_INTERVAL_S: '0',
      THROTTLE_PLAN: '1000/min',
      THROTTLE_HEATMAP: '1000/min',
      THROTTLE_GEOCODE: '1000/min',
    },
  },
});
