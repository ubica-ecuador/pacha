// The nyc-skyline dashboard (Gallery, free Kepler panel): Manhattan's buildings
// by height against the subway. Its data is a public GeoLens catalogue, read by
// DuckDB on the server through the gateway's cache into Chaski, where the
// filters, Mosaic and the map answer every brush; the Plus version is
// plus/dashboards/nyc-skyline-plus.json.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('dashboards/gallery/nyc-skyline.json');
const sqls = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const map = panelTitled(dashboard, 'Every building, raised to its own height');
const sqlOf = (panel, refId = 'A') => panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;

let current;
after(async () => current && current.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'nyc-skyline');
  assert.ok(dashboard.spec.description);
  for (const tag of ['business-charts', 'chaski', 'duckdb', 'kepler', 'mosaic', 'transit']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  assert.ok(!dashboard.spec.tags.includes('plus'));
  for (const name of ['buildings', 'stations']) {
    const { source } = dataset(name);
    assert.equal(source.type, 'datasource', name);
    assert.equal(source.datasource.uid, 'duckdb', name);
    // The filters write these; a dataset reading one would reload on every brush.
    for (const v of ['bldgFrom', 'bldgTo', 'd_lo', 'd_hi', 'h_lo', 'h_hi', 'era', 'station', 'bldgArea']) {
      assert.doesNotMatch(source.query.rawSql, new RegExp(`\\$\\{?${v}\\b`), `${name} reads $${v}`);
    }
  }
  // The map filters on the GPU from the Selection, so its queries leave the filters out.
  assert.equal(map.vizConfig.spec.options.mosaicSelection, 'bldgFilters');
  for (const q of map.data.spec.queries) assert.doesNotMatch(q.spec.query.spec.rawSql, /\$__crossfilter/);
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

test('every building gets its nearest of 496 stations; 29 services; three in four within 400 m', { timeout: 120_000 }, async () => {
  const buildings = await duckdb(STACK_URL, dataset('buildings').source.query.rawSql);
  assert.equal(buildings.length, 22324);
  assert.ok(buildings.every((b) => b.height_m >= 0 && b.height_m < 600 && b.geom.startsWith('MULTIPOLYGON')));
  assert.ok(buildings.every((b) => b.station && b.dist_m >= 0 && b.dist_m < 3000), 'nearest station');
  const near = buildings.filter((b) => b.dist_m <= 400).length / buildings.length;
  assert.ok(near > 0.7 && near < 0.82, `${(near * 100).toFixed(1)} % within 400 m`);
  assert.equal((await duckdb(STACK_URL, sqlOf(map, 'B'))).length, 29);
  const stations = await duckdb(STACK_URL, dataset('stations').source.query.rawSql);
  assert.equal(stations.length, 496);
  assert.ok(stations.every((s) => s.latitude > 40.4 && s.latitude < 41 && s.longitude > -74.3 && s.longitude < -73.6));
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 240_000 }, async () => {
  current = await openDashboard('/d/nyc-skyline', { datasets: ['buildings', 'stations'], timeoutMs: 120_000 });
  assert.equal(await current.panelErrors(), 0);
  assert.ok((await current.statNumber('Buildings shown')) > 20000);
});
