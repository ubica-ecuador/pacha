// The noaa-storm-reports dashboard: the NWS Local Storm Reports of the past
// week, read once from NOAA's public ArcGIS Feature Service into a Chaski
// dataset and cross-filtered in the browser by Mosaic. The dataset's SQL runs
// here on the server DuckDB, the same engine; the service is public, so these
// tests need the internet. A quiet week can hold few reports, so the checks
// are about shape.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { datasetSql, findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'noaa-storm-reports';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const SQL = datasetSql(dashboard, 'reports');
const SERVICE = SQL.match(/read_json\('([^']+)'\)/)[1];

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'kepler', 'mosaic', 'weather']);
  assert.ok(SERVICE.startsWith('https://services9.arcgis.com/'));
  // Every query but the built-in annotations runs on Chaski.
  const sources = findAll(dashboard, (n) => n.kind === 'DataQuery').map((q) => q.datasource?.name).filter((name) => name !== '-- Grafana --');
  assert.ok(sources.every((name) => name === 'duckdbwasm'), sources.join());
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the dataset holds the whole week the service counts, in North America', { timeout: 120_000 }, async () => {
  const count = await fetch(SERVICE.replace(/&outFields=[^&]*|&orderByFields=[^&]*/g, '') + '&returnCountOnly=true');
  const { count: n } = await count.json();
  const rows = await duckdb(STACK_URL, SQL);
  assert.ok(n > 0, 'no report this week');
  assert.equal(rows.length, n);
  const week = Date.now() - 8 * 86400_000;
  assert.ok(rows.every((r) => new Date(r.time).getTime() > week), 'a report older than the week');
  // The States, Alaska, Hawaii and Puerto Rico (Guam lies outside).
  const inside = rows.filter((r) => r.latitude > 15 && r.latitude < 72 && r.longitude > -170 && r.longitude < -60);
  assert.ok(inside.length >= 0.95 * rows.length, `${inside.length} of ${rows.length} inside the extent`);
  assert.ok(rows.every((r) => r.type && r.type_group && r.solar_hour >= 0 && r.solar_hour < 24));
  assert.ok(rows.every((r) => Number(r.casualties) === Number(r.deaths) + Number(r.injuries)));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'a report twice');
});

test('every filtered column reaches the map, so the selection lands on it', () => {
  const declared = variable('stormFilters').query.spec.filters.filter((f) => f.column).map((f) => f.column);
  const map = panelTitled(dashboard, 'Severe weather reports — last 7 days');
  for (const q of map.data.spec.queries) {
    const sql = q.spec.query.spec.rawSql;
    for (const column of declared) assert.match(sql, new RegExp(`\\b${column}\\b`), `${q.spec.refId} lacks ${column}`);
  }
  // Filters over both of the map's datasets, so the casualties layer follows as the reports do.
  const filters = map.vizConfig.spec.options.mapConfig.config.visState.filters;
  for (const column of declared) {
    const filter = filters.find((f) => f.name.includes(column));
    assert.deepEqual(filter?.dataId, ['grafana-A', 'grafana-I'], column);
  }
});

test('loads for an anonymous visitor, with no panel in error, the cards counting the dataset', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { datasets: ['reports'], timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
  await view.page.getByTestId('mosaic-panel').first().locator('svg').waitFor({ timeout: 30_000 });
  assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  const [{ n }] = await view.chaski('SELECT count(*)::INTEGER AS n FROM datasets.reports');
  // The map opens on the lower 48: the cards count what is in its view, almost every report.
  const shown = await view.statNumber('Reports');
  assert.ok(shown > 0.9 * n && shown <= n, `${shown} of ${n}`);
});
