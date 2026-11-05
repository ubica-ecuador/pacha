// The paris-metro-old-maps dashboard: the Paris Métro growing from 1900 on old
// maps of Paris. The server reads Île-de-France Mobilités' tracks and stations
// through the gateway into two Chaski datasets; a Chaski timeline grows a window
// over the day each segment opened, Mosaic panels count and chart what it keeps,
// and the free kepler map follows the same selection over an old map from IGN's
// WMS. The figures are checked against the network's known history: line 1
// opened on 19 July 1900, and the network is about 245 km long today.
// These tests need the internet (data.iledefrance-mobilites.fr, data.geopf.fr).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'paris-metro-old-maps';
const DATASETS = ['segments', 'stations', 'calendar'];
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplergl-panel');
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const serverSql = (name) => dataset(name).source.query.rawSql;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'mosaic', 'transit']);
  for (const query of map.data.spec.queries) assert.equal(query.spec.query.datasource.name, 'duckdbwasm');
  for (const name of ['segments', 'stations']) {
    assert.equal(dataset(name).source.type, 'datasource');
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    // Île-de-France Mobilités only through the gateway's cache.
    for (const url of serverSql(name).match(/'[a-z]+:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/idfm\//);
    // The timeline and the line chart write these: a dataset reading one would reload on every step.
    for (const v of ['open_from', 'open_to', 'line']) assert.doesNotMatch(serverSql(name), new RegExp(`\\$${v}\\b`), v);
  }
  // The map filters on the GPU from the selection, so its queries leave the filters out, and its
  // saved filters cover the lines and the stations alike.
  const options = map.vizConfig.spec.options;
  assert.equal(options.mosaicSelection, 'metroFilters');
  assert.equal(options.timeSync, 'off');
  for (const q of map.data.spec.queries) assert.doesNotMatch(q.spec.query.spec.rawSql, /\$__crossfilter|\$metroFilters/);
  for (const filter of options.mapConfig.config.visState.filters) assert.deepEqual(filter.dataId, ['grafana-A', 'grafana-C']);
  const [timeline] = panelsByType(dashboard, 'ubica-chaski-filters-panel');
  assert.equal(timeline.vizConfig.spec.options.layout, 'timeline');
  assert.equal(timeline.vizConfig.spec.options.playMode, 'grow');
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the segments are about 245 km of sixteen lines, from line 1 in 1900, inside Paris and its suburbs', { timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, serverSql('segments'));
  const km = rows.reduce((sum, row) => sum + row.km, 0);
  assert.ok(km > 235 && km < 260, `${km} km`);
  assert.equal(new Set(rows.map((row) => row.line)).size, 16);
  assert.equal(new Date(Math.min(...rows.map((row) => row.time))).toISOString().slice(0, 10), '1900-07-19');
  assert.ok(Math.max(...rows.map((row) => row.time)) <= Date.now());
  for (const row of rows) {
    assert.match(row.color, /^#[0-9A-F]{6}$/, JSON.stringify(row));
    for (const [lng, lat] of JSON.parse(row.geojson).coordinates) {
      assert.ok(lat > 48.7 && lat < 48.96 && lng > 2.2 && lng < 2.5, `${row.line} at ${lat}, ${lng}`);
    }
  }
  const stations = await duckdb(STACK_URL, serverSql('stations'));
  assert.ok(new Set(stations.map((row) => row.station)).size > 300, `${stations.length} stations`);
});

test('a second read of the tracks comes from the gateway cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', 'http://feeds/idfm/traces-du-reseau-ferre-idf.parquet']);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

test('opens with every panel drawn, follows a window to 1937 and asks IGN for the old map', { timeout: 240_000 }, async () => {
  const window1937 = '?var-open_from=1900-01-01T00:00:00.000Z&var-open_to=1937-12-31T23:59:59.000Z';
  const view = await openDashboard(`/d/${UID}${window1937}`, { datasets: DATASETS, timeoutMs: 120_000 });
  try {
    const card = async (title) => (await (await view.panel(title)).innerText()).replace(title, '').trim();
    assert.equal(await card('Up to'), '1937');
    // 154 km, 246 stations and 15 lines at the end of 1937 (line 14 and the 3bis/7bis splits aside).
    const km = Number((await card('Kilometres open')).replace(/\D/g, ''));
    assert.ok(km > 145 && km < 165, `${km} km`);
    assert.equal(await card('Lines'), '15');
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
    // The picture comes after the service's capabilities, about a megabyte.
    await view.page.waitForFunction(
      () => performance.getEntriesByType('resource').some((e) => e.name.includes('REQUEST=GetMap') && e.name.includes('LAYERS=BNF-IGNF_GEOGRAPHICALGRIDSYSTEMS.CASSINI')),
      null,
      { timeout: 60_000, polling: 500 },
    );
  } finally {
    await view.browser.close();
  }
});
