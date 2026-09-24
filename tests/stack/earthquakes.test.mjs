// The earthquakes dashboard, opened as an anonymous visitor.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';
import { loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const dashboard = () => loadDashboard('dashboards/start-here/earthquakes.json');

const opened = [];
const open = async (query = '') => {
  const view = await openDashboard(`/d/earthquakes${query}`, { datasets: ['quakes', 'places', 'exposure'] });
  opened.push(view);
  return view;
};
after(async () => Promise.all(opened.map((v) => v.browser.close())));

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
  // kepler's own WebGL canvas mounts after Grafana's panel-loaded signal, and
  // by this point in the file three earlier browsers are still open (`after`
  // closes them all at once) competing for the same software-WebGL renderer
  // — so give the canvas a few extra seconds rather than the single frame
  // `openDashboard` already waited.
  const CANVAS = '[data-viz-panel-key] canvas';
  await view.page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, CANVAS, { timeout: 20_000 });
  const canvases = await view.page.locator(CANVAS).count();
  assert.ok(canvases > 0);
  assert.equal(await view.panelErrors(), 0);
});
