// The gfs-forecast dashboard: one variable of the newest NOAA GFS run, which the
// stack's TiTiler reads from dynamical.org's Icechunk archive, drawn as tiles
// and measured over a polygon. Every query is run as a visitor runs it, with the
// dashboard's variables filled in as Grafana fills them; the archive is public,
// so these tests need the internet.
//
// The first statistics request after the tiler starts can take longer than
// DuckDB's 10 s http_client limit; the tests ask again, as a visitor would.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'gfs-forecast';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const queryOf = (title) => panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec;
const { from, to } = dashboard.spec.timeSettings;

// Grafana's interpolation as the DuckDB datasource receives it: in a panel
// query a bare variable arrives quoted, with a format it arrives as is.
const fill = (text, vars, quote) =>
  text.replace(/\$\{(\w+)(?::(\w+))?\}|\$(?!__)(\w+)/g, (match, braced, format, bare) => {
    const value = vars[braced ?? bare];
    if (value === undefined) return match;
    if (format === 'percentencode') return encodeURIComponent(value);
    return format || !quote ? value : `'${value.replaceAll("'", "''")}'`;
  });

async function query(target) {
  for (let attempt = 1; ; attempt++) {
    const res = await api(STACK_URL, '/api/ds/query', { method: 'POST', body: { from, to, queries: [{ refId: 'A', ...target }] } });
    try {
      assert.equal(res.status, 200, res.text.slice(0, 500));
      return rowsOf(res.json);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}
const duckdb = (rawSql) => query({ datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql, rawQuery: true, format: 1 });

// The hidden variables, in the order Grafana resolves them.
const vars = { variable: 'temperature_2m', store: variable('store').query, area: '' };
async function resolve(name) {
  const [row] = await duckdb(fill(variable(name).query.spec.__legacyStringValue, vars, false));
  vars[name] = String(row.__value ?? Object.values(row)[0]);
}
const ready = (async () => {
  for (const name of ['hora', 'mapFrom', 'mapTo', 'zona', 'pasada', 'lead']) await resolve(name);
})();

const MAP = "${variable:text} · newest GFS run · walk it with the map's own time bar";
const TABLE = 'The request · every statistic of ${variable:text}';

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'infinity', 'kepler', 'business-charts', 'weather']);
  const text = JSON.stringify(dashboard);
  const uids = new Set(text.match(/"datasource":\{"name":"[^"]+"/g).map((s) => s.split('"').at(-2)));
  for (const uid of uids) assert.ok(['infinity', 'duckdb', '-- Dashboard --', '-- Grafana --'].includes(uid), uid);
  // Tiles from the stack's own tiler, wherever it is served; the server side by its compose alias.
  assert.equal(panelTitled(dashboard, MAP).vizConfig.spec.options.rasterServerUrl, '/titiler');
  assert.doesNotMatch(text, /titiler\.ubica|pacha-titiler/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets every published forecast step of the newest run', async () => {
  await ready;
  const rows = await duckdb(fill(queryOf(MAP).rawSql, vars, true));
  assert.equal(rows.length, 121 + 88); // hourly to 120 h, then every 3 h to 384 h
  assert.ok(rows.every((r) => r.zarr_url === vars.store && r.zarr_variable === 'temperature_2m'));
  assert.ok(rows.every((r) => r.zarr_sel === `init_time=${vars.pasada}`));
  assert.equal(rows.at(-1).zarr_time_label, String(384 * 3600 * 1e9));
});

test('the area statistics come back from the tiler, in degrees Celsius', { timeout: 120_000 }, async () => {
  await ready;
  const spec = queryOf(TABLE);
  const target = JSON.parse(JSON.stringify(spec, (k, v) => (typeof v === 'string' ? fill(v, vars, false) : v)));
  const [row] = await query({ ...target, datasource: { uid: 'infinity', type: 'yesoreyeram-infinity-datasource' } });
  assert.ok(row.cells > 0, JSON.stringify(row));
  assert.ok(row.min <= row.mean && row.mean <= row.max && row.min > -30 && row.max < 45, JSON.stringify(row));
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
