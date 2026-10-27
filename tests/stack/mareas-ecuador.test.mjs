// The mareas-ecuador dashboard: the tide gauges of the Americas on the IOC's Sea
// Level Station Monitoring Facility, the last 24 hours read by the server through
// the gateway into Chaski, drawn by kepler and Mosaic. These tests need the
// internet (the IOC, through the gateway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'mareas-ecuador';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const [tides] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'tides');
const datasetSql = tides.source.query.rawSql;
const seriesSql = panelTitled(dashboard, 'Height minute by minute — ${gauge_name}').data.spec.queries[0].spec.query.spec.rawSql;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'mosaic', 'maritime']);
  assert.equal(tides.source.type, 'datasource');
  assert.equal(tides.source.datasource.uid, 'duckdb');
  // The IOC only through the gateway, which keeps a copy of each station.
  assert.match(datasetSql, /http:\/\/feeds\/ioc\/data\//);
  assert.match(seriesSql, /http:\/\/feeds\/ioc\/data\//);
  assert.doesNotMatch(JSON.stringify(dashboard), /ioc-sealevelmonitoring\.org\/service\.php/);
  // The timeline, the filters and the heatmap's brush write these; the dataset
  // reading one would reload on every brush, and a reload clears them all.
  for (const name of ['tide_from', 'tide_to', 'range_lo', 'range_hi', 'coasts', 'search', 'tide_area']) {
    assert.doesNotMatch(datasetSql, new RegExp(`\\$${name}\\b`), name);
  }
  // The map filters on the GPU from the Selection, so its query leaves the filters out.
  const [map] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplergl-panel');
  assert.equal(map.vizConfig.spec.options.mosaicSelection, 'tideFilters');
  for (const q of map.data.spec.queries) assert.doesNotMatch(q.spec.query.spec.rawSql, /\$__crossfilter/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the dataset is every gauge of the Americas at each of 96 quarter-hours, with a tide', { timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, datasetSql);
  const gauges = new Map();
  for (const row of rows) {
    assert.ok(row.latitude > -60 && row.latitude < 85 && row.longitude >= -180 && row.longitude < -26, JSON.stringify(row));
    assert.ok(row.tide_range >= 0.05 && row.tide_range < 20, JSON.stringify(row));
    if (row.has_reading === 1) assert.ok(row.fraction >= 0 && row.fraction <= 1, JSON.stringify(row));
    gauges.set(row.code, row);
  }
  // About 240 a day; the IOC's real-time network rarely falls under 150 of them.
  assert.ok(gauges.size >= 150, `${gauges.size} gauges`);
  assert.equal(rows.length, gauges.size * 96);
  assert.equal(new Set(rows.map((r) => r.time)).size, 96);
  assert.ok(rows.filter((r) => r.has_reading === 1).length / rows.length > 0.8);
  const all = [...gauges.values()];
  assert.ok(all.filter((g) => g.coast === 'Pacific').length >= 50 && all.filter((g) => g.coast === 'Atlantic').length >= 50);
  assert.ok(all.filter((g) => g.country === 'Ecuador').length >= 3);
  // The largest tide of the day is a few metres: the Gulf of Maine, Patagonia, southern Chile.
  const largest = Math.max(...all.map((g) => g.tide_range));
  assert.ok(largest > 3 && largest < 15, `${largest} m`);
  // The feed is live: the newest reading is from the last few hours.
  assert.ok(Date.now() - Math.max(...all.map((g) => g.latest)) < 6 * 3600_000);
});

test('the series of a clicked gauge is its day minute by minute, over its low water', { timeout: 120_000 }, async () => {
  const [{ code }] = await duckdb(STACK_URL, `${datasetSql.replace(/ORDER BY g\.time, s\.code\s*$/, '')} ORDER BY tide_range DESC LIMIT 1`);
  // The datasource quotes a bare variable itself.
  const rows = await duckdb(STACK_URL, seriesSql.replaceAll('$gauge', `'${code}'`));
  assert.ok(rows.length > 200, `${code}: ${rows.length} readings`);
  for (const row of rows) assert.ok(row['Above low water'] > -1 && row['Above low water'] < 20, JSON.stringify(row));
  // No gauge clicked: no rows, and no error.
  assert.equal((await duckdb(STACK_URL, seriesSql.replaceAll('$gauge', "''"))).length, 0);
});

test('opens with every panel drawn and no error', { timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['tides'], timeoutMs: 120_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    assert.ok((await view.statNumber('Tide gauges')) >= 150);
    // The heatmap is a raster image, below the fold.
    const heatmap = await view.panel('The tide at each port, north to south');
    await heatmap.getByTestId('mosaic-panel').locator('svg image').last().waitFor({ timeout: 60_000 });
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
