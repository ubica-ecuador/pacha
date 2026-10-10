// The melbourne-city-sensors dashboard: the City of Melbourne's parking bay
// sensors as they are now, its pedestrian counters hour by hour and its
// microclimate stations, read from its open data portal through the gateway.
// The data is live, so the checks are about shape, not numbers. It needs Kepler
// Plus (compose.plus.yaml): without it, the browser tests are skipped.
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
  for (const tag of ['chaski', 'duckdb', 'kepler', 'live', 'plus']) {
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
           count(*) FILTER (WHERE people <> dir_1 + dir_2) AS mismatched FROM p`);
  const [r] = rows;
  assert.ok(r.sensors > 50, `only ${r.sensors} counters`);
  assert.ok(r.days >= 5 && r.days <= 8, `${r.days} days`);
  assert.deepEqual([r.h0, r.h1], [0, 23]);
  assert.equal(Number(r.mismatched), 0, 'a count is not the sum of its two ways');
});

test('some microclimate station reported in the last few hours', async () => {
  const [r] = await duckdb(STACK_URL, `WITH c AS (${lastWeek(serverSql('climate'))})
    SELECT count(DISTINCT station) AS stations, date_diff('minute', max(time), now()) AS minutes FROM c`);
  assert.ok(r.stations >= 1, 'no station reporting');
  assert.ok(r.minutes < 6 * 60, `latest reading ${r.minutes} min ago`);
});

test('a click on a counter picks it', () => {
  const { variableMappings } = map.vizConfig.spec.options;
  assert.deepEqual(variableMappings[0], { field: 'sensor', source: 'click', variable: 'sensor' });
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => l.type).sort(), ['point', 'point', 'sparkline']);
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
  const [{ bays, peds }] = await view.chaski('SELECT (SELECT count(*) FROM datasets.bays) AS bays, (SELECT count(*) FROM datasets.peds) AS peds');
  assert.ok(Number(bays) > 4000 && Number(peds) > 1000, `${bays} bays, ${peds} counts`);
  const free = await view.statNumber('Bays free now');
  const taken = await view.statNumber('Bays occupied now');
  assert.ok(free > 0 && taken > 0, `${free} free, ${taken} taken`);
});
