// The nyc-skyline dashboard (Gallery, free Kepler panel): Manhattan's buildings
// by height against the subway. Its data is a public GeoLens catalogue, read by
// DuckDB on the server through the gateway's cache; the Plus version is
// plus/dashboards/nyc-skyline-plus.json.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('dashboards/gallery/nyc-skyline.json');
const sqls = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
const map = panelTitled(dashboard, 'Every building, raised to its own height');
const sqlOf = (panel, refId = 'A') => panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const ERAS = ['Pre-1900', '1900-1929', '1930-1949', '1950-1979', '1980-1999', '2000-2014', '2015+', 'Unknown'];
// The variables at their defaults: 400 m, any height, every era.
const fill = (sql) =>
  sql.replaceAll('$radius', '400').replaceAll('$minHeight', '0').replaceAll('${era:singlequote}', ERAS.map((e) => `'${e}'`).join(','));

let current;
after(async () => current && current.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'nyc-skyline');
  assert.ok(dashboard.spec.description);
  for (const tag of ['duckdb', 'kepler', 'transit']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  assert.ok(!dashboard.spec.tags.includes('plus'));
});

test('reads every parquet through the gateway, none from the bench', () => {
  assert.ok(sqls.length >= 6);
  assert.doesNotMatch(JSON.stringify(dashboard), /sources-data|testdata/);
  for (const sql of sqls) {
    for (const [, url] of sql.matchAll(/read_parquet\('([^']+)'\)/g)) assert.match(url, /^http:\/\/feeds\/geolens\/datasets\/[0-9a-f-]{36}\.parquet$/);
  }
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/nyc-skyline');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets every building, 29 services and 496 stations, all in New York', async () => {
  const buildings = await duckdb(STACK_URL, fill(sqlOf(map, 'A')));
  assert.equal(buildings.length, 22324);
  assert.ok(buildings.every((b) => b.height_m >= 0 && b.height_m < 600 && b.geom.startsWith('MULTIPOLYGON')));
  assert.equal((await duckdb(STACK_URL, fill(sqlOf(map, 'B')))).length, 29);
  const stations = await duckdb(STACK_URL, fill(sqlOf(map, 'C')));
  assert.equal(stations.length, 496);
  assert.ok(stations.every((s) => s.latitude > 40.4 && s.latitude < 41 && s.longitude > -74.3 && s.longitude < -73.6));
});

test('most of Manhattan is within 400 m of a station', async () => {
  const [row] = await duckdb(STACK_URL, fill(sqlOf(panelTitled(dashboard, 'Within ${radius:text} of a station'))));
  assert.ok(row['Within reach'] > 50 && row['Within reach'] < 100, JSON.stringify(row));
  const eras = await duckdb(STACK_URL, fill(sqlOf(panelTitled(dashboard, 'What each era left behind'))));
  assert.equal(eras.reduce((n, r) => n + Number(r.buildings), 0), 22324);
});

test('loads for an anonymous visitor, with no panel in error', async () => {
  current = await openDashboard('/d/nyc-skyline', { chaski: false, timeoutMs: 90_000 });
  assert.equal(await current.panelErrors(), 0);
  assert.ok((await current.statNumber('Within 400 m of a station')) > 0);
});
