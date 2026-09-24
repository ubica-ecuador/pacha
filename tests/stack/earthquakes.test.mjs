// The earthquakes dashboard, opened as an anonymous visitor.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';
import { brushHistogramBody, withConstants } from '../lib/templates.mjs';

const dashboard = () => loadDashboard('dashboards/start-here/earthquakes.json');

const AREA = encodeURIComponent('POLYGON((-85 -45, -65 -45, -65 5, -85 5, -85 -45))');

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

test('is provisioned in Start here under its old uid', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/earthquakes');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'start-here');
});

test('loads for an anonymous visitor within 45 s, with no panel in error', async () => {
  const view = await open();
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  assert.ok((await view.statNumber('Earthquakes')) > 1000);
});

test('rows without PAGER fields load and render', async () => {
  const view = await open();
  const [row] = await view.chaski('SELECT count(*) FILTER (WHERE alert IS NULL) AS without, count(*) AS total FROM datasets.quakes');
  assert.ok(Number(row.without) > 0 && Number(row.without) < Number(row.total));
  assert.equal(await view.panelErrors(), 0);
});

test('exposure covers the strong quakes and finds people near some of them', async () => {
  const view = await open();
  const [row] = await view.chaski(
    'SELECT (SELECT count(*) FROM datasets.quakes WHERE mag >= 4.5) AS strong, count(*) AS exposed, sum(people_100km) AS people FROM datasets.exposure',
  );
  assert.equal(Number(row.exposed), Number(row.strong));
  assert.ok(Number(row.people) > 0);
});

test('the map publishes its time window, its drawn area and the clicked quake', () => {
  const [map] = panelsByType(dashboard(), 'ubica-keplergl-panel');
  const options = JSON.stringify(map);
  assert.match(options, /"timeSync":"variables"/);
  assert.match(options, /"from":"quakeFrom"/);
  assert.match(options, /"to":"quakeTo"/);
  assert.match(options, /"areaVariable":"quakeArea"/);
  assert.match(options, /"source":"click"[^}]*"variable":"quake"|"variable":"quake"[^}]*"source":"click"/);
  assert.match(options, /"source":"center"/);
});

test('the map never filters on what it publishes itself', () => {
  const [map] = panelsByType(dashboard(), 'ubica-keplergl-panel');
  const queries = JSON.stringify(map).match(/"rawSql":"[^"]*"/g) ?? [];
  assert.ok(queries.length >= 2, 'expected a quakes query and a places query');
  for (const sql of queries) {
    assert.doesNotMatch(sql, /\$quakeArea|\$quakeFrom|\$quakeTo/, sql);
  }
});

test('the map draws', async () => {
  const view = await open();
  // kepler's own WebGL canvas mounts after Grafana's panel-loaded signal, so
  // give it a few extra seconds rather than the single frame `openDashboard`
  // already waited.
  const CANVAS = '[data-viz-panel-key] canvas';
  await view.page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, CANVAS, { timeout: 20_000 });
  const canvases = await view.page.locator(CANVAS).count();
  assert.ok(canvases > 0);
  assert.equal(await view.panelErrors(), 0);
});

test('URL filters narrow the count, and clearing them restores it', async () => {
  // A fixed, wholly-in-the-past range (an hour behind "now", so no quake
  // arriving during the test can land in it) carried on every URL below, and
  // a baseline computed against each page's own already-loaded `quakes`
  // dataset over that same range — comparing a page against itself, not
  // against a separate page's independently-refetched copy of the live USGS
  // feed, which is what made this test drift by a quake or two before.
  const to = Math.floor((Date.now() - 60 * 60 * 1000) / 60_000) * 60_000;
  const from = to - 29 * 24 * 60 * 60 * 1000;
  const range = `from=${from}&to=${to}`;
  const baselineSql = `SELECT count(*) AS n FROM datasets.quakes WHERE time >= to_timestamp(${from} / 1000) AND time <= to_timestamp(${to} / 1000)`;
  const baselineOf = async (view) => Number((await view.chaski(baselineSql))[0].n);

  const strongView = await open(`?${range}&var-mag_lo=5&var-mag_hi=10`);
  const strong = await strongView.statNumber('Earthquakes');
  const strongBaseline = await baselineOf(strongView);
  assert.ok(strong < strongBaseline, `${strong} !< ${strongBaseline}`);

  const inAreaView = await open(`?${range}&var-quakeArea=${AREA}`);
  const inArea = await inAreaView.statNumber('Earthquakes');
  const inAreaBaseline = await baselineOf(inAreaView);
  assert.ok(inArea < inAreaBaseline, `${inArea} !< ${inAreaBaseline}`);

  const clearedView = await open(`?${range}&var-mag_lo=&var-mag_hi=&var-depth_lo=&var-depth_hi=&var-quakeArea=`);
  const cleared = await clearedView.statNumber('Earthquakes');
  const clearedBaseline = await baselineOf(clearedView);
  assert.equal(cleared, clearedBaseline);
});

test('the histograms run the shared template, changing only its constants', () => {
  const template = brushHistogramBody();
  const bodies = JSON.stringify(dashboard()).match(/@constants begin[\s\S]*?@constants end/g);
  assert.equal(bodies?.length, 2);
  for (const panel of panelsByType(dashboard(), 'volkovlabs-echarts-panel')) {
    const code = Object.values(JSON.parse(JSON.stringify(panel.vizConfig?.spec?.options ?? panel.options))).find(
      (v) => typeof v === 'string' && v.includes('@constants begin'),
    );
    const constants = code.match(/\/\/ @constants begin\n([\s\S]*?)\/\/ @constants end/)[1];
    assert.equal(code, withConstants(template, constants));
  }
});

test('dragging across the magnitude histogram filters the dashboard without reloading the data', async () => {
  // A real brush, the way a visitor makes one: a page navigation would restart
  // Chaski and reload everything, which is exactly what must not happen.
  const view = await open();

  // The map publishes its own default quakeFrom/quakeTo once, after it settles
  // (software WebGL can take several seconds); since the histogram's own
  // `selected` query depends on that window, its one-time arrival redraws the
  // chart (every redraw wipes an in-progress brush, by brush-histogram.js's
  // own design). Wait for that one-time settle first, so the drag below lands
  // in the steady state rather than racing it.
  await view.page.waitForFunction(() => new URL(location.href).searchParams.get('var-quakeFrom'), null, { timeout: 20_000 });
  await view.page.waitForTimeout(500);

  for (const title of ['Magnitude', 'Depth (km)']) {
    const panel = view.page.locator(`[data-testid="data-testid Panel header ${title}"]`).locator('xpath=ancestor::*[@data-viz-panel-key][1]');
    assert.ok((await panel.locator('canvas').count()) > 0, title);
  }
  assert.equal(await view.panelErrors(), 0);

  const all = await view.statNumber('Earthquakes');
  const loadsBefore = await view.page.evaluate(() => window.__duckdbwasm.stats.loads.length);
  const canvas = view.page
    .locator('[data-testid="data-testid Panel header Magnitude"]')
    .locator('xpath=ancestor::*[@data-viz-panel-key][1]')
    .locator('canvas')
    .first();
  const box = await canvas.boundingBox();
  await view.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await view.page.mouse.down();
  await view.page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, { steps: 10 });
  await view.page.mouse.up();
  await view.page.waitForFunction(() => new URL(location.href).searchParams.get('var-mag_lo'), null, { timeout: 10_000 });
  await view.page.waitForTimeout(2000);
  assert.ok((await view.statNumber('Earthquakes')) < all);
  assert.equal(await view.page.evaluate(() => window.__duckdbwasm.stats.loads.length), loadsBefore);
});

test('stats and the most exposed table show exposure and link to each quake', async () => {
  const view = await open();
  assert.ok((await view.statNumber('People within 100 km')) > 0);

  const table = view.page
    .locator('[data-testid="data-testid Panel header Most exposed"]')
    .locator('xpath=ancestor::*[@data-viz-panel-key][1]');
  const rows = table.locator('[role="row"]');
  const count = await rows.count();
  assert.ok(count >= 2 && count <= 11, `${count} rows including the header`);

  const [link] = await table.locator('a[href*="var-quake="]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  assert.match(link, /var-quake=[^&]+/);
  assert.match(link, /var-lat=-?\d/);
  assert.match(link, /var-mag_lo=/);
});

test('the daily series shows all and filtered', () => {
  const series = panelTitled(dashboard(), 'Earthquakes per day');
  const sql = JSON.stringify(series);
  assert.match(sql, /AS \\"All\\"/);
  assert.match(sql, /AS \\"Filtered\\"/);
  assert.doesNotMatch(sql, /\$quakeFrom|\$quakeTo/, 'the series is the context the slider moves through');
});

test('the selection column follows the quake variable', async () => {
  const visible = async (view, title) => (await view.page.locator(`[data-testid="data-testid Panel header ${title}"]`).count()) > 0;

  // No quake selected: the hint explains the map, the selection panels don't exist.
  const noQuakeView = await open();
  assert.equal(await visible(noQuakeView, 'How to use this map'), true);
  assert.equal(await visible(noQuakeView, 'Selected earthquake'), false);

  // The same page's Chaski data picks the quake Task 6's "Most exposed" table
  // ranks first, so the selected panel's text can be checked against it.
  const [top] = await noQuakeView.chaski(
    'SELECT q.id, q.place FROM datasets.quakes q JOIN datasets.exposure e USING (id) ORDER BY e.people_100km DESC LIMIT 1',
  );

  const selectedView = await open(`?var-quake=${encodeURIComponent(top.id)}`);
  assert.equal(await visible(selectedView, 'How to use this map'), false);
  assert.equal(await visible(selectedView, 'Selected earthquake'), true);
  const text = await selectedView.page
    .locator('[data-testid="data-testid Panel header Selected earthquake"]')
    .locator('xpath=ancestor::*[@data-viz-panel-key][1]')
    .innerText();
  assert.ok(text.includes(top.place), `${top.place} not in: ${text.slice(0, 200)}`);
  assert.equal(await visible(selectedView, 'Places within 100 km'), true);
  assert.equal(await selectedView.panelErrors(), 0);

  // A quake id that matches nothing: hint stays hidden (quake isn't empty), no panel errors.
  const staleView = await open('?var-quake=does-not-exist');
  assert.equal(await visible(staleView, 'How to use this map'), false);
  assert.equal(await staleView.panelErrors(), 0);
});
