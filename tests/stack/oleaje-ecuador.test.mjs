// The oleaje-ecuador dashboard: significant wave height and peak direction off
// Ecuador and the Galápagos from NOAA's WAVEWATCH III, read from ERDDAP through
// the gateway's cache. The `paso` variable lists the forecast steps ERDDAP
// holds; the map reads one of them.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, findAll } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'oleaje-ecuador';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const stepsSql = dashboard.spec.variables.find((v) => v.spec.name === 'paso').spec.query.spec.__legacyStringValue;
const [map] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplergl-panel');
const mapSql = map.data.spec.queries[0].spec.query.spec.rawSql;

// ERDDAP builds each answer on the spot; on a miss in the gateway's cache that
// can outlast Grafana's timeout, so ask again, as the next visitor would.
const patiently = async (query) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await duckdb(STACK_URL, query);
    } catch (error) {
      if (attempt === 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
};

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'maritime', 'weather']);
  for (const query of [stepsSql, mapSql]) assert.match(query, /http:\/\/feeds\/erddap\/griddap\/ww3_global\.csv0/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the steps run from now to about six days ahead, every three hours', { timeout: 10 * 60_000 }, async () => {
  const steps = await patiently(stepsSql);
  assert.ok(steps.length > 30, `${steps.length} steps`);
  const first = Date.parse(steps[0].__value);
  assert.ok(Math.abs(first - Date.now()) < 6 * 3600_000, steps[0].__value);
  assert.equal(Date.parse(steps[1].__value) - first, 3 * 3600_000);
});

test('the map gets the sea cells of the box, with heights and directions that make sense', { timeout: 10 * 60_000 }, async () => {
  const [step] = await patiently(stepsSql);
  const rows = await patiently(mapSql.replaceAll('${paso:raw}', step.__value));
  assert.ok(rows.length > 600 && rows.length <= 897, `${rows.length} cells`);
  for (const row of rows) {
    assert.ok(row.speed > 0 && row.speed < 15, JSON.stringify(row)); // metres
    assert.ok(row.direction >= 0 && row.direction <= 360, JSON.stringify(row));
    assert.equal(JSON.parse(row.geojson).type, 'Polygon');
  }
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 10 * 60_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  // Grafana runs a panel's query once it is on screen: visit each one.
  for (const { title } of findAll(dashboard, (n) => n.vizConfig && n.title && !n.title.includes('$'))) await view.panel(title);
  assert.equal(await view.panelErrors(), 0);
});
