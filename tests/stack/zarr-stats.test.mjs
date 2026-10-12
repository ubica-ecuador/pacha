// The zarr-stats dashboard: CarbonPlan's monthly mean temperature, a pyramided
// Zarr drawn as tiles by the stack's TiTiler, and measured over a polygon by
// Infinity asking the same tiler. Every query is run as a visitor runs it, with
// the dashboard's variables filled in as Grafana fills them; the store is
// public, so these tests need the internet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'zarr-stats';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const queryOf = (title) => panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec;
const { from, to } = dashboard.spec.timeSettings;
const MAP = 'Monthly mean temperature · draw an area and drag the time bar';

// Grafana's interpolation for the formats this dashboard uses.
const fill = (text, vars) =>
  text.replace(/\$\{(\w+)(?::(\w+))?\}|\$(?!__)(\w+)/g, (match, braced, format, bare) => {
    const value = vars[braced ?? bare];
    if (value === undefined) return match;
    return format === 'percentencode' ? encodeURIComponent(value) : value;
  });

async function query(target) {
  const res = await api(STACK_URL, '/api/ds/query', { method: 'POST', body: { from, to, queries: [{ refId: 'A', ...target }] } });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  return rowsOf(res.json);
}
const duckdb = (rawSql) => query({ datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql, rawQuery: true, format: 1 });
const sqlOfVariable = (name) => variable(name).query.spec.__legacyStringValue;

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'infinity', 'kepler', 'business-charts', 'weather']);
  const text = JSON.stringify(dashboard);
  const uids = new Set(text.match(/"datasource":\{"name":"[^"]+"/g).map((s) => s.split('"').at(-2)));
  for (const uid of uids) assert.ok(['infinity', 'duckdb', '-- Dashboard --', '-- Grafana --'].includes(uid), uid);
  assert.equal(panelTitled(dashboard, MAP).vizConfig.spec.options.rasterServerUrl, '/titiler');
  assert.doesNotMatch(text, /titiler\.ubica|pacha-titiler/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets twelve months of the same store', async () => {
  const rows = await duckdb(queryOf(MAP).rawSql);
  assert.deepEqual(rows.map((r) => r.zarr_time_label), Array.from({ length: 12 }, (_, i) => String(i + 1)));
  assert.ok(rows.every((r) => r.zarr_url === variable('store').query && r.zarr_levels === 6));
});

test('the drawn area is measured in degrees Celsius, and differs by month', { timeout: 120_000 }, async () => {
  const [{ zona }] = (await duckdb(fill(sqlOfVariable('zona'), { area: '' }))).map((r) => ({ zona: Object.values(r)[0] }));
  assert.equal(JSON.parse(zona).type, 'Polygon');
  const stats = async (mes) => {
    const spec = queryOf('The request · every statistic');
    const target = JSON.parse(JSON.stringify(spec, (k, v) => (typeof v === 'string' ? fill(v, { store: variable('store').query, zona, mes }) : v)));
    const [row] = await query({ ...target, datasource: { uid: 'infinity', type: 'yesoreyeram-infinity-datasource' } });
    return row;
  };
  const [january, july] = [await stats('1'), await stats('7')];
  for (const row of [january, july]) {
    assert.ok(row.celdas > 1000 && row['mín'] <= row.media && row.media <= row['máx'], JSON.stringify(row));
    assert.ok(row.media > 15 && row.media < 35, JSON.stringify(row));
  }
  assert.notEqual(january.media, july.media);
});

test('loads for an anonymous visitor, with tiles from /titiler and no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
  assert.ok((await view.statNumber('Mean temperature in the area')) > 15);
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
