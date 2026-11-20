import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '../App';
import { useAppStore } from '../state/store';
import { heatmapFixture, jsonResponse, mockFetch, planFixture } from '../test/utils';

// MapLibre needs WebGL (covered by the Playwright e2e suite); stub the map pane here.
vi.mock('../map/MapView', () => ({ MapView: () => <div data-testid="map" /> }));

const rulesPayload = planFixture.rules;

function setupFetch(overrides: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    '/api/plan': () => jsonResponse(planFixture),
    '/api/heatmap': () => jsonResponse(heatmapFixture),
    '/api/rules': () => jsonResponse(rulesPayload),
    '/api/geocode': () =>
      jsonResponse({
        results: [
          {
            label: 'Dallas, Texas, USA',
            name: 'Dallas',
            context: 'Texas, USA',
            lat: 32.78,
            lon: -96.8,
            kind: 'city',
          },
          {
            label: 'Dallas, Iowa, USA',
            name: 'Dallas',
            context: 'Iowa, USA',
            lat: 41.7,
            lon: -94.0,
            kind: 'city',
          },
        ],
      }),
    ...overrides,
  });
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().setForm({
    origin: { label: '', lat: null, lon: null },
    destination: { label: '', lat: null, lon: null },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function planExampleTrip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Dallas → Chicago' }));
  await user.click(screen.getByRole('button', { name: 'Find safest route' }));
  await screen.findByRole('heading', { name: /^Route B via/ });
}

describe('trip form', () => {
  it('validates before calling the API', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Find safest route' }));
    expect(screen.getByText('Enter an origin.')).toBeInTheDocument();
    expect(screen.getByText('Enter a destination.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/plan', expect.anything());
  });

  it('fills an example, swaps, and sends the chosen options', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Dallas → Chicago' }));
    const origin = screen.getByRole('combobox', { name: 'Origin' });
    expect(origin).toHaveValue('Dallas, Texas, USA');
    await user.click(screen.getByRole('button', { name: 'Swap origin and destination' }));
    expect(origin).toHaveValue('Chicago, Illinois, USA');

    await user.click(screen.getByRole('radio', { name: '50 miles' }));
    expect(screen.getByRole('radio', { name: '50 miles' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByText('Options'));
    await user.click(screen.getByRole('radio', { name: 'Wind gusts' }));
    await user.click(screen.getByRole('radio', { name: 'Simulated storm' }));
    await user.clear(screen.getByLabelText('Load weight'));
    await user.type(screen.getByLabelText('Load weight'), '45000');
    await user.click(screen.getByRole('button', { name: 'Find safest route' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/plan', expect.anything()));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/plan')!;
    expect(JSON.parse(String(call[1]!.body))).toMatchObject({
      origin: { label: 'Chicago, Illinois, USA' },
      interval_miles: 50,
      wind_basis: 'gust',
      weather_source: 'simulated',
      load_weight_lb: 45000,
      hos_breaks: true,
    });
  });

  it('autocompletes places with the keyboard', async () => {
    setupFetch();
    const user = userEvent.setup();
    render(<App />);
    const origin = screen.getByRole('combobox', { name: 'Origin' });
    await user.type(origin, 'Dall');
    const list = await screen.findByRole('listbox', { name: 'Origin suggestions' });
    expect(await within(list).findAllByRole('option')).toHaveLength(2);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(origin).toHaveValue('Dallas, Iowa, USA');
    expect(useAppStore.getState().form.origin).toMatchObject({ lat: 41.7, lon: -94.0 });
  });

  it('asks the user to pick a suggestion for free text', async () => {
    setupFetch({ '/api/geocode': () => jsonResponse({ results: [] }) });
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole('combobox', { name: 'Origin' }), 'Nowhere');
    expect(await screen.findByText('No matching places.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Find safest route' }));
    expect(screen.getByText('Pick a place from the suggestions.')).toBeInTheDocument();
  });
});

describe('results', () => {
  it('shows the recommendation, reasons, route cards and checkpoints', async () => {
    setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await planExampleTrip(user);

    // Form collapses into a summary with an edit affordance.
    expect(screen.getByRole('region', { name: 'Planned trip' })).toHaveTextContent('Dallas, Texas');
    for (const reason of planFixture.recommendation.reasons) {
      expect(screen.getByText(reason)).toBeInTheDocument();
    }
    const cards = screen.getAllByRole('button', { name: /^Route [ABC] via/ });
    expect(cards).toHaveLength(3);
    const recommended = planFixture.routes.find((r) => r.recommended)!;
    expect(
      screen.getByRole('button', { name: new RegExp(`^Route ${recommended.id} via`) }),
    ).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table', { name: `Checkpoints on ${recommended.name}` });
    expect(within(table).getAllByRole('row')).toHaveLength(recommended.checkpoints.length + 1);
  });

  it('selects routes and focuses checkpoints', async () => {
    setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await planExampleTrip(user);
    await user.click(screen.getByRole('button', { name: /^Route A via/ }));
    expect(useAppStore.getState().selectedRouteId).toBe('A');
    const table = screen.getByRole('table', { name: 'Checkpoints on Route A' });

    await user.click(screen.getByLabelText('Only Moderate+'));
    const risky = planFixture.routes[0]!.checkpoints.filter((c) => c.risk.level > 0);
    expect(within(table).getAllByRole('row')).toHaveLength(risky.length + 1);

    await user.click(within(table).getAllByRole('row')[1]!);
    expect(useAppStore.getState().focusedCheckpoint).toMatchObject({
      routeId: 'A',
      index: risky[0]!.index,
    });
  });

  it('explains the decision funnel', async () => {
    setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await planExampleTrip(user);
    await user.click(screen.getByRole('button', { name: 'Show how routes were compared' }));
    const funnel = screen.getByRole('table', { name: /compared criterion by criterion/ });
    const rows = within(funnel).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('1. No Travel miles');
    // Route A (50 mi of No Travel) is struck out at the first criterion.
    expect(within(rows[1]!).getByText('50.0')).toHaveClass('is-out');
  });

  it('shows API errors', async () => {
    setupFetch({
      '/api/plan': () =>
        jsonResponse({ error: { code: 'no_route', message: 'No truck route was found.' } }, 422),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Dallas → Chicago' }));
    await user.click(screen.getByRole('button', { name: 'Find safest route' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No truck route was found.');
  });

  it('opens the risk rules from the API', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'View risk rules' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/rules'));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await waitFor(() => expect(within(dialog).getByText('25 – 35')).toBeInTheDocument());
    expect(within(dialog).getByText('> 1')).toBeInTheDocument(); // rain No Travel is exclusive
  });
});

describe('timeline', () => {
  it('scrubs, switches layers and plays', async () => {
    setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await planExampleTrip(user);
    const slider = screen.getByRole('slider', { name: 'Forecast hour after departure' });
    act(() => useAppStore.getState().setTime(6.5));
    expect(screen.getByText('T+6h30 after departure')).toBeInTheDocument();
    expect(slider).toHaveValue('6.5');

    await user.click(screen.getByRole('radio', { name: 'Snow' }));
    expect(useAppStore.getState().metric).toBe('snow');
    expect(screen.getByLabelText('Snow scale')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide heatmap' }));
    expect(useAppStore.getState().heatmapVisible).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Play forecast' }));
    expect(useAppStore.getState().playing).toBe(true);
    await waitFor(() => expect(useAppStore.getState().timeHours).toBeGreaterThan(6.5));
    await user.click(screen.getByRole('button', { name: 'Pause forecast playback' }));
    expect(useAppStore.getState().playing).toBe(false);
  });

  it('reads conditions under the selected truck from the heatmap', async () => {
    setupFetch();
    const user = userEvent.setup();
    render(<App />);
    await planExampleTrip(user);
    await waitFor(() => expect(useAppStore.getState().heatmapStatus).toBe('success'));
    expect(screen.getByText(/^Truck B$/)).toBeInTheDocument();
    expect(screen.getByText(/Wind \d+\.\d mph \(gusts \d+\.\d\)/)).toBeInTheDocument();
  });

  it('offers a retry when the heatmap fails', async () => {
    setupFetch({
      '/api/heatmap': () =>
        jsonResponse({ error: { code: 'upstream_unavailable', message: 'down' } }, 502),
    });
    const user = userEvent.setup();
    render(<App />);
    await planExampleTrip(user);
    expect(await screen.findByText(/Heatmap unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
