// The spain-daily-mobility dashboard: Spain's open mobility study from mobile
// phones (MITMA), one day of trips between municipalities, read by DuckDB on
// the server through the gateway's month-long cache and handed to the browser
// as Chaski datasets. The datasets' SQL runs here as Grafana runs it, with the
// dashboard's variables filled in. The map needs Kepler Plus
// (compose.plus.yaml): on a stack without it the dashboard is not provisioned
// and the browser test is skipped; the data and gateway tests run either way.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/spain-daily-mobility.json');
const DATASETS = ['zones', 'flows', 'focus', 'monthly'];

const datasetSql = (name) => {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name);
  return query.source.query.rawSql;
};
const fill = (sql, { day = '2025-03-12', zone = '28079' } = {}) =>
  sql.replaceAll('${day:sqlstring}', `'${day}'`).replaceAll('${zone:sqlstring}', `'${zone}'`);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'spain-daily-mobility');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'plus', 'business-charts', 'mobility']);
});

test('every dataset reads its data through the gateway, and nothing else does', () => {
  for (const name of DATASETS) {
    const urls = datasetSql(name).match(/(?:https?:)?\/\/[^'\s)]+/g) ?? [];
    assert.ok(urls.length > 0, `${name} reads nothing`);
    for (const url of urls) assert.match(url, /^(?:http:)?\/\/(?:feeds\/|vsicurl\/http:\/\/feeds\/)/, `${name}: ${url}`);
  }
  const panels = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) => p.spec.data.spec.queries);
  for (const q of panels) assert.equal(q.spec.query.datasource.name, 'duckdbwasm');
});

test('the zones: 2,618 in Spain, and the regions of France and Portugal', async () => {
  const rows = await duckdb(
    STACK_URL,
    `SELECT country, count(*)::INTEGER AS zones, count(name)::INTEGER AS named,
            min(lat) AS south, max(lat) AS north
     FROM (${datasetSql('zones')}) GROUP BY country ORDER BY country`,
  );
  const spain = rows.find((r) => r.country === 'Spain');
  assert.equal(spain.zones, 2618);
  assert.equal(spain.named, 2618);
  assert.ok(spain.south > 27 && spain.south < 28.5, `southernmost ${spain.south}`); // El Hierro
  assert.ok(spain.north > 43 && spain.north < 44, `northernmost ${spain.north}`);
  assert.deepEqual(rows.map((r) => r.country), ['France', 'Portugal', 'Spain']);
});

test('a weekday: the 2,000 busiest links of each hour, between distinct places', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(*)::INTEGER AS links, count(DISTINCT hour)::INTEGER AS hours,
            count(*) FILTER (WHERE origin = destination)::INTEGER AS loops, min(trips) AS fewest
     FROM (${fill(datasetSql('flows'))})`,
  );
  assert.deepEqual([row.links, row.hours, row.loops], [48000, 24, 0]);
  assert.ok(row.fewest > 0);
});

test('Madrid on that day: its trips each way, and all Spain around 150 million', async () => {
  const rows = await duckdb(
    STACK_URL,
    `SELECT scope, sum(trips) AS trips FROM (${fill(datasetSql('focus'))})
     WHERE kind = 'profile' GROUP BY scope ORDER BY scope`,
  );
  const trips = Object.fromEntries(rows.map((r) => [r.scope, Number(r.trips)]));
  assert.deepEqual(Object.keys(trips), ['in', 'out', 'spain', 'within']);
  assert.ok(trips.spain > 100e6 && trips.spain < 200e6, `Spain ${trips.spain}`);
  assert.ok(trips.out > 1e6 && trips.in > 1e6 && trips.within > trips.out, JSON.stringify(trips));
});

test('the monthly totals run from January 2022 to June 2025, but for October and November 2023', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(DISTINCT time)::INTEGER AS months, strftime(min(time), '%Y-%m') AS first,
            strftime(max(time), '%Y-%m') AS last FROM (${datasetSql('monthly')})`,
  );
  assert.deepEqual([row.months, row.first, row.last], [40, '2022-01', '2025-06']);
});

test('the gateway keeps a day: a second read is served from the cache', () => {
  const path = '/mitma/estudios_basicos/por-municipios/viajes/ficheros-diarios/2025-03/20250312_Viajes_municipios.csv.gz';
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${path}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

test('the gateway answers only the study\'s own files', () => {
  const status = (path) =>
    compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://feeds${path}`]);
  assert.equal(status('/mitma/RSS.xml'), '404');
  assert.equal(status('/mitma/estudios_basicos/por-distritos/viajes/ficheros-diarios/2025-03/20250312_Viajes_distritos.csv.gz'), '404');
});

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/spain-daily-mobility', { anonymous: true });
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor within 60 s, with no panel in error', { skip }, async () => {
  view = await openDashboard('/d/spain-daily-mobility', { datasets: DATASETS, timeoutMs: 60_000 });
  assert.ok(view.loadMs <= 60_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
});
