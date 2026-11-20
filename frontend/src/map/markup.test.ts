import { planFixture } from '../test/utils';
import {
  checkpointPopupHtml,
  escapeHtml,
  riskPill,
  routeChipHtml,
  stopMarkerHtml,
  stopTitle,
} from './markup';

describe('map markup', () => {
  it('escapes HTML', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
  });

  it('renders a checkpoint popup with conditions, ETA offset and drivers', () => {
    const route = planFixture.routes.find((r) => r.checkpoints.some((c) => c.risk.level > 0))!;
    const cp = route.checkpoints.find((c) => c.risk.level > 0)!;
    const html = checkpointPopupHtml(route, cp, planFixture.inputs.departure_time);
    expect(html).toContain(`${route.name} · Mile ${Math.round(cp.mile)}`);
    expect(html).toContain(`${cp.conditions.wind_mph.toFixed(1)} mph`);
    expect(html).toContain(cp.risk.label);
    expect(html).toMatch(/T\+\d+h/);
    expect(html).toContain('from ');
  });

  it('never injects untrusted text into popups', () => {
    const route = { ...planFixture.routes[0]!, name: '<script>x</script>' };
    const cp = {
      ...route.checkpoints[0]!,
      conditions: { ...route.checkpoints[0]!.conditions, summary: '<b>bold</b>' },
    };
    const html = checkpointPopupHtml(route, cp, planFixture.inputs.departure_time);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('flags load-rule escalation', () => {
    const route = planFixture.routes[0]!;
    const base = route.checkpoints[0]!;
    const cp = {
      ...base,
      risk: {
        ...base.risk,
        level: 3 as const,
        factors: base.risk.factors.map((f) =>
          f.factor === 'wind' ? { ...f, load_escalated: true } : f,
        ),
      },
    };
    expect(checkpointPopupHtml(route, cp, planFixture.inputs.departure_time)).toContain(
      'Load rule applied',
    );
  });

  it('renders pills, chips and stop markers', () => {
    expect(riskPill(4)).toContain('No Travel');
    expect(riskPill(9)).toContain('No Travel'); // clamped
    const route = planFixture.routes.find((r) => r.recommended)!;
    const chip = routeChipHtml(route, true);
    expect(chip).toContain('Recommended');
    expect(chip).toContain('(selected)');
    const stop = {
      kind: 'rest' as const,
      mile: 551.2,
      lat: 35,
      lon: -97,
      arrive_time: '2026-11-21T01:00:00Z',
      depart_time: '2026-11-21T11:00:00Z',
      duration_s: 36000,
    };
    expect(stopTitle(stop)).toMatch(/^10-hour rest \(HOS\) near mile 551/);
    expect(stopMarkerHtml(stop)).toContain('<svg');
  });
});
