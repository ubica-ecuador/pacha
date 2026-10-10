// The caltrans-la-cameras dashboard: every Caltrans camera in District 7 (Los
// Angeles and Ventura) as a coverage wedge, its live video in a Business Text
// panel, over the lane closures in force and the message signs. Caltrans'
// feeds are live, so the checks are about shape, not numbers. It needs Kepler
// Plus (compose.plus.yaml): without it, the browser tests are skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const DATASETS = ['cameras', 'closures', 'signs'];
const dashboard = loadDashboard('plus/dashboards/caltrans-la-cameras.json');
const serverSql = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const [player] = panelsByType(dashboard, 'marcusolsson-dynamictext-panel');
const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;

// Auto refresh off: a reload every minute would keep the panels loading.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/caltrans-la-cameras?refresh=${query}`, { datasets: DATASETS, timeoutMs: 90_000 });
  return current;
};
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/caltrans-la-cameras');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'caltrans-la-cameras');
  assert.ok(dashboard.spec.description);
  for (const tag of ['business-text', 'chaski', 'duckdb', 'kepler', 'live', 'plus']) {
    assert.ok(dashboard.spec.tags.includes(tag), tag);
  }
});

test('reads Caltrans through the gateway, and only the JSON', () => {
  for (const [name, path] of [['cameras', 'cctv/cctvStatusD07'], ['closures', 'lcs/lcsStatusD07'], ['signs', 'cms/cmsStatusD07']]) {
    assert.match(serverSql(name), new RegExp(`http://feeds/caltrans/d7/${path}\\.json`), name);
  }
  assert.doesNotMatch(JSON.stringify(dashboard), /https:\/\/cwwp2\.dot\.ca\.gov\/data/);
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  const browserSql = findAll(dashboard, (n) => n.group === 'ubica-chaski-datasource' && typeof n.spec?.rawSql === 'string');
  assert.ok(browserSql.length >= 6);
  for (const { spec } of browserSql) {
    for (const line of spec.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('leaves the quoting of the camera to Chaski', () => {
  // Chaski quotes a variable itself: '$camera' would reach DuckDB doubly quoted.
  for (const sql of findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql)) {
    assert.doesNotMatch(sql, /'\$\{?camera/);
  }
});

test('every camera has a place, a wedge and something to show', async () => {
  const rows = await duckdb(STACK_URL, serverSql('cameras'));
  assert.ok(rows.length > 400, `only ${rows.length} cameras`);
  assert.equal(new Set(rows.map((r) => r.camera)).size, rows.length, 'camera names are not unique');
  assert.ok(rows.every((r) => r.latitude > 32 && r.latitude < 36 && r.longitude > -121 && r.longitude < -116));
  assert.ok(rows.every((r) => [0, 90, 180, 270].includes(r.azimuth) && [60, 360].includes(r.beamwidth)));
  const live = rows.filter((r) => r.status === 'Live video');
  assert.ok(live.length > 200, `only ${live.length} with live video`);
  assert.ok(live.every((r) => /^https:\/\/.+\.m3u8$/.test(r.stream_url)));
});

test('the closures are the ones in force, each a GeoJSON point, pair of ends or line', async () => {
  const rows = await duckdb(STACK_URL, serverSql('closures'));
  assert.ok(rows.length > 0, 'no closure in force');
  const now = Date.now();
  for (const r of rows) {
    assert.ok(new Date(r.starts).getTime() <= now, r.closure_id);
    assert.ok(r.ends === null || new Date(r.ends).getTime() > now, r.closure_id);
    assert.match(JSON.parse(r.geom).type, /^(Point|MultiPoint|LineString)$/);
  }
});

test('the signs say whether they show a message', async () => {
  const rows = await duckdb(STACK_URL, serverSql('signs'));
  assert.ok(rows.length > 50, `only ${rows.length} signs`);
  assert.ok(rows.every((r) => (r.showing === 'Blank') === (r.message === null)));
});

test('a click on a camera picks it, and the player follows', () => {
  const { variableMappings } = map.vizConfig.spec.options;
  assert.deepEqual(variableMappings[0], { field: 'camera', source: 'click', variable: 'camera' });
  assert.deepEqual(layers.map((l) => l.type).sort(), ['coverage', 'geojson', 'point']);
  assert.match(player.data.spec.queries[0].spec.query.spec.rawSql, /WHERE camera = \$camera/);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads every dataset for an anonymous visitor, and plays the camera picked', { skip }, async () => {
  const view = await open();
  assert.equal(await view.panelErrors(), 0);
  // Live video, or the still image when Caltrans lists a stream that is down.
  await view.page.waitForFunction(
    () => {
      const video = document.querySelector('.cam-view video');
      const image = document.querySelector('.cam-view img');
      return (video && video.readyState >= 2) || (image && image.complete && image.naturalWidth > 0);
    },
    null,
    { timeout: 60_000, polling: 500 },
  );
});
