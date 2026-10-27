// The melbourne-city-sensors dashboard: the City of Melbourne's parking bay
// sensors as they are now, its pedestrian counters hour by hour and its
// microclimate stations, read from its open data portal through the gateway.
// The data is live, so the checks are about shape, not numbers. The views are
// Chaski and Mosaic panels filtered by three selections (bayFilters, pedFilters,
// climateFilters) and one pinned Time Brush. It needs Kepler Plus
// (compose.plus.yaml): without it, the browser tests are skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const DATASETS = ['bays', 'peds', 'climate'];
const dashboard = loadDashboard('plus/dashboards/melbourne-city-sensors.json');
const serverSql = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;
// The last 7 days, as Grafana writes ${__from} and ${__to} into the query.
const NOW = Date.now();
const lastWeek = (sql) => sql.replaceAll('${__from}', String(NOW - 7 * 86_400_000)).replaceAll('${__to}', String(NOW));
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');

// Auto refresh off: a reload every 5 minutes would keep the panels loading.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/melbourne-city-sensors?refresh=${query}`, { datasets: DATASETS, timeoutMs: 90_000 });
  return current;
};
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/melbourne-city-sensors');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'melbourne-city-sensors');
  assert.ok(dashboard.spec.description);
  for (const tag of ['chaski', 'mosaic', 'duckdb', 'kepler', 'live', 'plus']) {
    assert.ok(dashboard.spec.tags.includes(tag), tag);
  }
});

test('reads the portal through the gateway only', () => {
  for (const name of DATASETS) assert.match(serverSql(name), /http:\/\/feeds\/melbourne\//, name);
  assert.doesNotMatch(JSON.stringify(dashboard), /https:\/\/data\.melbourne\.vic\.gov\.au\/api/);
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  const browserSql = findAll(dashboard, (n) => n.group === 'ubica-chaski-datasource' && typeof n.spec?.rawSql === 'string');
  assert.ok(browserSql.length >= 10);
  for (const { spec } of browserSql) {
    for (const line of spec.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('every bay has a place, a street and a state', async () => {
  const rows = await duckdb(STACK_URL, serverSql('bays'));
  assert.ok(rows.length > 4000, `only ${rows.length} bays`);
  assert.equal(new Set(rows.map((r) => r.bay)).size, rows.length, 'bays are not unique');
  assert.ok(rows.every((r) => r.latitude > -38.0 && r.latitude < -37.7 && r.longitude > 144.8 && r.longitude < 145.1));
  assert.ok(rows.every((r) => ['Free', 'Occupied', 'Silent for a week'].includes(r.status)));
  const live = rows.filter((r) => r.status !== 'Silent for a week');
  assert.ok(live.length > 1000, `only ${live.length} bays reporting`);
  const unknown = rows.filter((r) => r.street === 'Unknown').length;
  assert.ok(unknown < rows.length / 10, `${unknown} bays with no street`);
});

test('the pedestrian counts are hourly, for whole days of the time range', async () => {
  const rows = await duckdb(STACK_URL, `WITH p AS (${lastWeek(serverSql('peds'))})
    SELECT count(DISTINCT sensor) AS sensors, count(DISTINCT day) AS days, min(hour) AS h0, max(hour) AS h1,
           min(dow) AS d0, max(dow) AS d1,
           count(*) FILTER (WHERE people <> dir_1 + dir_2) AS mismatched FROM p`);
  const [r] = rows;
  assert.ok(r.sensors > 50, `only ${r.sensors} counters`);
  assert.ok(r.days >= 5 && r.days <= 8, `${r.days} days`);
  assert.deepEqual([r.h0, r.h1], [0, 23]);
  assert.deepEqual([r.d0, r.d1], [1, 7]);
  assert.equal(Number(r.mismatched), 0, 'a count is not the sum of its two ways');
});

// The portal has stopped updating for days (from 18 October 2026): the window
// then ends at its latest reading, so the stations never go missing.
test('the microclimate window holds stations even when the portal lags', async () => {
  const sql = lastWeek(serverSql('climate'));
  const [head, select] = [sql.slice(0, sql.lastIndexOf(';') + 1), sql.slice(sql.lastIndexOf(';') + 1)];
  const [r] = await duckdb(STACK_URL, `${head}
    WITH c AS (${select})
    SELECT count(DISTINCT station) AS stations, date_diff('hour', min(time), max(time)) AS hours,
           count(*) FILTER (WHERE latitude IS NULL) AS unplaced FROM c`);
  assert.ok(r.stations >= 3, `${r.stations} stations`);
  assert.ok(r.hours >= 24 && r.hours <= 7 * 24 + 2, `${r.hours} h of readings`);
  assert.equal(Number(r.unplaced), 0);
});

test('the Time Brush writes the window that the filters of both networks read', () => {
  const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');
  const o = brush.vizConfig.spec.options;
  assert.deepEqual([o.pinned, o.pinnedPosition, o.domain, o.mosaicSelection], ['always', 'floating', 'data', 'pedFilters']);
  assert.deepEqual(o.variables, { from: 't0', to: 't1' });
  for (const name of ['pedFilters', 'climateFilters']) {
    const [f] = findAll(dashboard, (n) => n.kind === 'filters' && n.refId === name);
    assert.deepEqual([f.filters[0].from, f.filters[0].to], ['$t0', '$t1'], name);
  }
  assert.equal(map.vizConfig.spec.options.mosaicSelection, 'bayFilters');
});

test('a click on a counter picks it', () => {
  const { variableMappings } = map.vizConfig.spec.options;
  assert.deepEqual(variableMappings[0], { field: 'sensor', source: 'click', variable: 'sensor' });
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => l.type).sort(), ['sparkline', 'surface', 'symbol', 'symbol']);
});

test('a second read of the bays comes from the cache, and only the dashboard datasets pass', () => {
  const headers = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds/melbourne/${path}`]);
  headers('on-street-parking-bay-sensors.parquet');
  assert.match(headers('on-street-parking-bay-sensors.parquet'), /X-Cache-Status: HIT/i);
  const status = compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://feeds/melbourne/trees-with-species-and-dimensions-urban-forest.parquet']);
  assert.equal(status, '404', 'feeds passes on other datasets');
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads every dataset for an anonymous visitor, with no panel in error', { skip }, async () => {
  const view = await open();
  assert.equal(await view.panelErrors(), 0);
  assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  const [{ bays, peds }] = await view.chaski('SELECT (SELECT count(*) FROM datasets.bays) AS bays, (SELECT count(*) FROM datasets.peds) AS peds');
  assert.ok(Number(bays) > 4000 && Number(peds) > 1000, `${bays} bays, ${peds} counts`);
  const free = await view.statNumber('Bays free');
  const taken = await view.statNumber('Bays occupied');
  assert.ok(free > 0 && taken > 0, `${free} free, ${taken} taken`);
});

test('a window in the link narrows the pedestrian cards', { skip }, async () => {
  const whole = await (await open()).statNumber('People counted');
  const [{ t }] = await current.chaski('SELECT epoch_ms(max(time)) - 86400000 AS t FROM datasets.peds');
  const t0 = new Date(Number(t)).toISOString(), t1 = new Date(Number(t) + 6 * 3_600_000).toISOString();
  const view = await open(`&var-t0=${t0}&var-t1=${t1}`);
  await view.page.waitForTimeout(5000);
  const part = await view.statNumber('People counted');
  assert.ok(part > 0 && part < whole / 4, `${part} of ${whole}`);
  assert.equal(await view.panelErrors(), 0);
});
