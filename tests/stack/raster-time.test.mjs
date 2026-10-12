// The raster-time dashboard: every Sentinel-2 pass over Cuenca in the last four
// months, searched by DuckDB in the Earth Search STAC catalogue, with the map's
// time bar choosing which scene the stack's TiTiler draws. Every query is run
// as a visitor runs it, with the dashboard's variables filled in as Grafana
// fills them; the catalogue is public and live, so these tests need the
// internet and check shapes, not exact scenes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'raster-time';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const { from, to } = dashboard.spec.timeSettings;
const MAP = 'Sentinel-2 over Cuenca · drag the time bar';
const sqlOf = (title) => panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec.rawSql;
// In a panel query the DuckDB datasource receives a bare variable quoted.
const withCloud = (sql, cloud) => sql.replaceAll('$cloud', `'${cloud}'`);

async function duckdb(rawSql) {
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    body: { from, to, queries: [{ refId: 'A', datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql, rawQuery: true, format: 1 }] },
  });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  return rowsOf(res.json);
}

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['business-charts', 'duckdb', 'kepler', 'satellite']);
  const text = JSON.stringify(dashboard);
  const uids = new Set(text.match(/"datasource":\{"name":"[^"]+"/g).map((s) => s.split('"').at(-2)));
  for (const uid of uids) assert.ok(['duckdb', '-- Grafana --', '-- Dashboard --'].includes(uid), uid);
  assert.equal(panelTitled(dashboard, MAP).vizConfig.spec.options.rasterServerUrl, '/titiler');
  assert.doesNotMatch(text, /titiler\.ubica|pacha-titiler/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the calendar has a pass every few days, each with its COG', { timeout: 60_000 }, async () => {
  const rows = await duckdb(withCloud(sqlOf(MAP), '100'));
  // Four months at one pass every five days is about 24; two satellites, more.
  assert.ok(rows.length >= 15 && rows.length <= 80, `${rows.length} passes`);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].time <= r.time), 'not in time order');
  assert.ok(rows.every((r) => r.cloud_cover >= 0 && r.cloud_cover <= 100 && /^https:\/\/.+\.tif$/.test(r.raster_url)));
  // The table and the map are the same query.
  assert.equal(sqlOf('The full calendar'), sqlOf(MAP));
});

test('loads for an anonymous visitor, with the scene from /titiler and no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
  // The map asks for tiles once its datasets are in, which can be after the panels settle.
  await view.page.waitForFunction(
    (prefix) => performance.getEntriesByType('resource').some((e) => new URL(e.name).pathname.startsWith(prefix)),
    '/titiler/cog/',
    { timeout: 60_000, polling: 500 },
  );
  await view.page.waitForTimeout(2_000);
  const tiles = await view.page.evaluate(() =>
    performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname.startsWith('/titiler/cog/')).map((e) => e.responseStatus),
  );
  assert.ok(tiles.includes(200), JSON.stringify(tiles));
});
