// The stac-join dashboard: DuckDB searches the Earth Search STAC catalogue for
// the area drawn on the map, joins the scenes to it with `spatial`, and the
// stack's TiTiler draws the chosen scene and cuts a thumbnail of the area out of
// each one. Every query is run as a visitor runs it, with the dashboard's
// variables filled in as Grafana fills them; the catalogue is public and live,
// so these tests need the internet and check shapes, not exact scenes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'stac-join';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const sqlOf = (title, refId = 'A') =>
  panelTitled(dashboard, title).data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const { from, to } = dashboard.spec.timeSettings;
const MAP = 'The area, the scene that covers it, and what is left out';
const STAT = 'Your area, in the catalogue';

// In a panel query the DuckDB datasource receives a bare variable quoted.
const fill = (sql, vars) =>
  sql.replace(/\$(?!__)(\w+)/g, (match, name) => (name in vars ? `'${vars[name].replaceAll("'", "''")}'` : match));
// Every cloud cover, so a cloudy month still returns scenes.
const VARS = { collection: 'sentinel-2-l2a', cloud: '100', cover: '0', aoiArea: variable('aoiArea').current.value, scene: '' };

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
  for (const uid of uids) assert.ok(['duckdb', '-- Grafana --'].includes(uid), uid);
  assert.equal(panelTitled(dashboard, MAP).vizConfig.spec.options.rasterServerUrl, '/titiler');
  assert.doesNotMatch(text, /titiler\.ubica|pacha-titiler|stac-join-bench/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the catalogue has scenes over the area, and best scene never beats the mosaic', { timeout: 60_000 }, async () => {
  const [stat] = await duckdb(fill(sqlOf(STAT), VARS));
  assert.ok(stat.Scenes >= 3, JSON.stringify(stat)); // Sentinel-2 passes every five days
  assert.ok(stat['Best scene'] <= stat.Coverage && stat.Coverage <= 100, JSON.stringify(stat));
  assert.ok(stat['km²'] > 1500 && stat['km²'] < 2500, JSON.stringify(stat));
  const scenes = await duckdb(fill(sqlOf(MAP, 'B'), VARS));
  assert.equal(scenes.length, stat.Scenes); // the scenes the map can draw, one per row
  assert.ok(scenes.every((s) => /^https:\/\/.+\.tif$/.test(s.raster_url) && s.covers_pct > 0), JSON.stringify(scenes[0]));
});

test('loads for an anonymous visitor, with the scene from /titiler and no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}?var-cloud=100`, { chaski: false, timeoutMs: 120_000 });
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
  // A tile outside the scene's footprint is a 404 from the tiler; some must be 200.
  assert.ok(tiles.includes(200), JSON.stringify(tiles));
});
