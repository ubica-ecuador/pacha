// The gfs-wind-barbs dashboard: NOAA GFS 10 m wind over South America for the
// next two days, as wind barbs and as arrows over the flow field. One DuckDB
// query reads u and v from ERDDAP through the gateway's cache; the second map
// reuses its rows through the Dashboard datasource.
//
// ERDDAP builds each answer on the spot: on a miss in the gateway's cache that
// can take longer than Grafana's query timeout. The gateway keeps fetching, so
// the test asks again, as a next visitor would, until the answer is cached.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, panelTitled, findAll } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'gfs-wind-barbs';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const sql = panelTitled(dashboard, 'Wind barbs on the data cells').data.spec.queries[0].spec.query.spec.rawSql;

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
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'weather']);
  assert.match(sql, /http:\/\/feeds\/erddap\/griddap\/ncep_global\.csv0/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets 17 forecast steps on a one-degree lattice of u and v', { timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(sql);
  assert.equal(rows.length, 17 * 53 * 51);
  assert.equal(new Set(rows.map((row) => row.time)).size, 17);
  for (const row of rows) {
    assert.ok(row.latitude >= -40 && row.latitude <= 12 && row.longitude >= -100 && row.longitude <= -50, JSON.stringify(row));
    assert.ok(Math.hypot(row.u, row.v) < 60, JSON.stringify(row)); // m/s
  }
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 10 * 60_000 }, async () => {
  await patiently(sql); // cached first, so the page's query answers in time
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  // Grafana runs a panel's query once it is on screen: visit each one.
  for (const { title } of findAll(dashboard, (n) => n.vizConfig && n.title && !n.title.includes('$'))) await view.panel(title);
  assert.equal(await view.panelErrors(), 0);
});
