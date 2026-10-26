// The earthquakes dashboard, opened as an anonymous visitor.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

// Only one Chromium alive at a time: several live browsers starve the
// software WebGL renderer the map's canvas needs (found in Task 4). `open`
// closes whatever it previously opened before launching the next one; `after`
// closes the last one still standing.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/earthquakes${query}`, { datasets: ['quakes', 'places', 'exposure'] });
  return current;
};
after(async () => current && current.browser.close());

// Settled: the filters panel has applied the URL's filters (every panel on
// them re-runs when it does) and no panel is still loading because of it.
const settled = async (view) => {
  await view.page.waitForTimeout(500);
  await view.page.waitForFunction(() => document.querySelectorAll('[aria-label="Panel loading bar"]').length === 0, null, {
    timeout: 30_000,
  });
};

test('is provisioned in Gallery under its old uid', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/earthquakes');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('loads for an anonymous visitor within 45 s, with no panel in error', async () => {
  const view = await open();
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  assert.ok((await view.statNumber('Earthquakes')) > 1000);
});

test('a magnitude filter in the URL gives a lower count than the page\'s own unfiltered count', async () => {
  // A fixed, wholly-in-the-past range (an hour behind "now", so no quake
  // arriving during the test can land in it) and a baseline computed against
  // the page's own already-loaded `quakes` dataset over that same range —
  // comparing the page against itself, not against a separate page's
  // independently-refetched copy of the live USGS feed.
  const to = Math.floor((Date.now() - 60 * 60 * 1000) / 60_000) * 60_000;
  const from = to - 29 * 24 * 60 * 60 * 1000;
  const range = `from=${from}&to=${to}`;
  const baselineSql = `SELECT count(*) AS n FROM datasets.quakes WHERE time >= to_timestamp(${from} / 1000) AND time <= to_timestamp(${to} / 1000)`;

  const view = await open(`?${range}&var-mag_lo=5&var-mag_hi=10`);
  await settled(view);
  const filtered = await view.statNumber('Earthquakes');
  const baseline = Number((await view.chaski(baselineSql))[0].n);
  assert.ok(filtered < baseline, `${filtered} !< ${baseline}`);
  // The filters panel shows the filter and its range, with the same count.
  const filters = await (await view.panel('Filters')).innerText();
  assert.match(filters, /Magnitude\s+5 – 10/);
  const counted = await view.page.getByTestId('filters-count').first().innerText();
  assert.ok(counted.startsWith(`${filtered.toLocaleString('en-US')} of`), counted);
});

test('opens on the whole month: the map publishes no time window of its own', async () => {
  const view = await open();
  await settled(view);
  assert.equal(new URL(view.page.url()).searchParams.get('var-quakeFrom') || '', '');
  const counted = await view.page.getByTestId('filters-count').first().innerText();
  // All but the few quakes the feed holds from just before the 30 days (a window would leave about 12 %).
  const [shown, all] = counted.match(/^([\d,]+) of ([\d,]+)/).slice(1).map((n) => Number(n.replace(/,/g, '')));
  assert.ok(shown > 0.95 * all, counted);
});

test('selecting a quake via the URL shows it in "Selected earthquake"', async () => {
  const view = await open();
  const [top] = await view.chaski(
    'SELECT q.id, q.place FROM datasets.quakes q JOIN datasets.exposure e USING (id) ORDER BY e.people_100km DESC LIMIT 1',
  );

  const selectedView = await open(`?var-quake=${encodeURIComponent(top.id)}`);
  const text = await (await selectedView.panel('Selected earthquake')).innerText();
  assert.ok(text.includes(top.place), `${top.place} not in: ${text.slice(0, 200)}`);
});
