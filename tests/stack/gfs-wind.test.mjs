// The gfs-wind dashboard: the 10 m wind of the newest NOAA GFS run around
// Cuenca as a flow field, sampled by DuckDB from the stack's TiTiler (which
// reads dynamical.org's Icechunk archive), over a raster of another variable of
// the same run. Every query is run as a visitor runs it, with the dashboard's
// variables filled in as Grafana fills them; the archive is public, so these
// tests need the internet.
//
// The wind query asks the tiler six times and takes some seconds; a cold tiler
// can push one request past DuckDB's 10 s http_client limit, so the tests ask
// again, as a visitor would.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'gfs-wind';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const MAP = '10 m wind over ${capa:text} · ${hora} · newest GFS run';
const map = panelTitled(dashboard, MAP);
const sqlOf = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const { from, to } = dashboard.spec.timeSettings;
const LAYERS = variable('capa').query.split(',').map((o) => o.split(' : ').at(-1).trim());

// Grafana's interpolation as the DuckDB datasource receives it: in a panel
// query a bare variable arrives quoted, with a format it arrives as is.
const fill = (text, vars, quote) =>
  text.replace(/\$\{(\w+)(?::(\w+))?\}|\$(?!__)(\w+)/g, (match, braced, format, bare) => {
    const value = vars[braced ?? bare];
    if (value === undefined) return match;
    if (format === 'percentencode') return encodeURIComponent(value);
    return format || !quote ? value : `'${value.replaceAll("'", "''")}'`;
  });

async function duckdb(rawSql) {
  for (let attempt = 1; ; attempt++) {
    const res = await api(STACK_URL, '/api/ds/query', {
      method: 'POST',
      body: { from, to, queries: [{ refId: 'A', datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql, rawQuery: true, format: 1 }] },
    });
    try {
      assert.equal(res.status, 200, res.text.slice(0, 500));
      return rowsOf(res.json);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

const vars = { store: variable('store').query, paso: '25', capa: 'total_cloud_cover_atmosphere' };
const ready = (async () => {
  for (const name of ['hora', 'pasada', 'lead']) {
    const [row] = await duckdb(fill(variable(name).query.spec.__legacyStringValue, vars, false));
    vars[name] = String(row.__value ?? Object.values(row)[0]);
  }
})();

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'weather']);
  const text = JSON.stringify(dashboard);
  const uids = new Set(text.match(/"datasource":\{"name":"[^"]+"/g).map((s) => s.split('"').at(-2)));
  for (const uid of uids) assert.ok(['duckdb', '-- Grafana --'].includes(uid), uid);
  assert.equal(map.vizConfig.spec.options.rasterServerUrl, '/titiler');
  assert.doesNotMatch(text, /titiler\.ubica|http:\/\/titiler\//);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the wind is a regular 7 × 7 lattice with both components everywhere', { timeout: 120_000 }, async () => {
  await ready;
  for (const paso of ['25', '50']) {
    const rows = await duckdb(fill(sqlOf('A'), { ...vars, paso }, true));
    assert.equal(rows.length, 49, paso);
    const lats = [...new Set(rows.map((r) => r.latitude))].sort((a, b) => a - b);
    assert.equal(lats.length, 7);
    assert.ok(lats.every((lat, i) => i === 0 || Math.abs(lat - lats[i - 1] - Number(paso) / 100) < 1e-9), lats.join(','));
    assert.ok(rows.every((r) => Number.isFinite(r.u) && Number.isFinite(r.v) && Math.hypot(r.u, r.v) < 40), paso);
  }
});

test('the raster under the wind is one row per variable, and none for Nothing', async () => {
  await ready;
  for (const capa of LAYERS) {
    const rows = await duckdb(fill(sqlOf('B'), { ...vars, capa }, true));
    assert.equal(rows.length, capa === 'none' ? 0 : 1, capa);
    if (capa !== 'none') assert.equal(rows[0].zarr_sel, `init_time=${vars.pasada},lead_time=${vars.lead}`);
  }
});

test('loads for an anonymous visitor, with tiles from /titiler and no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
  // The map asks for tiles once its datasets are in, which can be after the panels settle.
  await view.page.waitForFunction(
    (prefix) => performance.getEntriesByType('resource').some((e) => new URL(e.name).pathname.startsWith(prefix)),
    '/titiler/zarr/tiles/',
    { timeout: 60_000, polling: 500 },
  );
  await view.page.waitForTimeout(2_000);
  const tiles = await view.page.evaluate(() =>
    performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname.startsWith('/titiler/zarr/tiles/')).map((e) => e.responseStatus),
  );
  assert.ok(tiles.length > 0 && tiles.every((s) => s === 200), JSON.stringify(tiles));
});
