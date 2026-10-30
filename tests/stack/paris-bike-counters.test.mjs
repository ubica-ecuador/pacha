// The paris-bike-counters dashboard: the City of Paris's bike counters over the
// last 28 days, read by the server from Paris Data into Chaski, drawn by Mosaic
// and kepler. These tests need the internet (opendata.paris.fr).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { openDashboard, parseStatNumber } from '../lib/browser.mjs';

const UID = 'paris-bike-counters';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const [bikes] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'bikes');
const datasetSql = bikes.source.query.rawSql;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'mosaic', 'mobility']);
  assert.equal(bikes.source.type, 'datasource');
  assert.equal(bikes.source.datasource.uid, 'duckdb');
  // The timeline, the brushes, the bars and the map write these; the dataset
  // reading one would reload on every brush, and a reload clears them all.
  for (const name of ['bike_from', 'bike_to', 'arrs', 'search', 'bike_area']) {
    assert.doesNotMatch(datasetSql, new RegExp(`\\$${name}\\b`), name);
  }
  // The map filters on the GPU from the Selection, so its query leaves the filters out.
  // Kepler Plus since the save in Grafana of 27 October 2026.
  const [map] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplerplus-panel');
  assert.equal(map.vizConfig.spec.options.mosaicSelection, 'bikeFilters');
  for (const q of map.data.spec.queries) assert.doesNotMatch(q.spec.query.spec.rawSql, /\$__crossfilter/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the dataset is about a hundred counters hour by hour, each in one lane of its arrondissement', { timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, datasetSql);
  const counters = new Map();
  for (const row of rows) {
    // Paris and the edge of Issy-les-Moulineaux.
    assert.ok(row.latitude > 48.8 && row.latitude < 48.91 && row.longitude > 2.22 && row.longitude < 2.47, JSON.stringify(row));
    assert.ok(row.bikes >= 0 && row.bikes <= row.peak && row.share >= 0 && row.share <= 1, JSON.stringify(row));
    const seen = counters.get(row.counter);
    if (seen) assert.equal(seen.lane, row.lane, row.counter);
    counters.set(row.counter, row);
  }
  // 108 in October 2026; the City adds and retires a few each year.
  assert.ok(counters.size >= 80 && counters.size <= 160, `${counters.size} counters`);
  const all = [...counters.values()];
  assert.equal(new Set(all.map((c) => c.lane)).size, counters.size);
  assert.ok(new Set(all.map((c) => c.arrondissement)).size >= 15);
  // Most counters most hours of 28 days: whole days are sometimes missing.
  assert.ok(rows.length > counters.size * 24 * 20, `${rows.length} hours`);
  // The busiest counter's busiest hour: Sébastopol or Rivoli at rush hour, about 1,000 to 2,000.
  const busiest = Math.max(...all.map((c) => c.peak));
  assert.ok(busiest > 600 && busiest < 4000, `${busiest} bikes an hour`);
  // Published daily up to the evening before.
  assert.ok(Date.now() - Math.max(...rows.map((r) => r.latest)) < 3 * 86400_000);
});

test('opens with every panel drawn, and a brush on the heatmap filters the rest', { timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['bikes'], timeoutMs: 120_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    const counted = async () => parseStatNumber((await (await view.panel('Bikes counted')).innerText()).replace('Bikes counted', ''));
    const before = await counted();
    assert.ok(before > 1_000_000, `${before} bikes`);
    const heatmap = await view.panel('Every counter, hour by hour');
    const image = heatmap.getByTestId('mosaic-panel').locator('svg image').last();
    await image.waitFor({ timeout: 60_000 });
    const box = await image.boundingBox();
    // The Kepler Plus map opens a time window, which the heatmap shows as its brush already: a drag
    // inside it would only move it, so its right edge is pulled to a fifth of the hours.
    const edge = await heatmap.locator('rect.handle--e').first().boundingBox();
    await view.page.mouse.move(edge.x + edge.width / 2, box.y + box.height / 2);
    await view.page.mouse.down();
    await view.page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 8 });
    await view.page.mouse.up();
    await view.page.waitForTimeout(3000);
    const after = await counted();
    assert.ok(after > 0 && after < before * 0.4, `${after} of ${before} bikes`);
    for (const { title } of findAll(dashboard, (n) => n.vizConfig && n.title)) await view.panel(title);
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
