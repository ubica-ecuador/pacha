// The fiware-valencia dashboard: València's open real-time data (traffic by
// segment, air quality, weather and Valenbisi) as NGSI-LD entities in a
// Stellio context broker, read on the server through its public NGSI-LD API
// (now) and the Parquet exports of its history, held in the browser by Chaski
// and drawn by a Kepler Plus map and Business Charts that filter each other.
// The data is live, so the checks are about shape and freshness, not numbers.
// It needs Kepler Plus (compose.plus.yaml): without it, the browser tests are
// skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';
import { brushHistogramBody, withConstants } from '../lib/templates.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'fiware-valencia';
const DATASETS = ['segments', 'traffic', 'bikes', 'bikes_hist', 'readings'];
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const serverSql = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;
// The last 24 hours, as Grafana writes ${__from} and ${__to} into the query.
const NOW = Date.now();
const lastDay = (sql) => sql.replaceAll('${__from}', String(NOW - 86_400_000)).replaceAll('${__to}', String(NOW));
// Inside València's municipal area (the Albufera weather station is its south end), with margin.
const inValencia = (r) => r.latitude > 39.27 && r.latitude < 39.6 && r.longitude > -0.55 && r.longitude < -0.25;
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  for (const tag of ['chaski', 'duckdb', 'plus', 'kepler', 'business-charts', 'live']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  assert.deepEqual(findAll(dashboard, (n) => n.kind === 'dataset' && n.source).map((n) => n.name).sort(), [...DATASETS].sort());
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  const browserSql = findAll(dashboard, (n) => n.group === 'ubica-chaski-datasource' && typeof n.spec?.rawSql === 'string');
  assert.ok(browserSql.length >= 20);
  for (const { spec } of browserSql) {
    for (const line of spec.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('the broker has every traffic segment, as a GeoJSON line with a known state', async () => {
  const rows = await duckdb(STACK_URL, serverSql('segments'));
  assert.ok(rows.length > 350, `only ${rows.length} segments`);
  assert.equal(new Set(rows.map((r) => r.segment_id)).size, rows.length, 'segments are not unique');
  for (const row of rows) {
    assert.match(JSON.parse(row.geojson).type, /LineString$/, row.name);
    assert.ok(row.state >= 0 && row.state <= 4, JSON.stringify(row));
    assert.ok(['Fluido', 'Denso', 'Congestionado', 'Cortado', 'Sin datos'].includes(row.state_label), row.state_label);
  }
  const [r] = await duckdb(STACK_URL, `WITH s AS (${serverSql('segments')}) SELECT date_diff('minute', max(observed), now()) AS minutes FROM s`);
  assert.ok(r.minutes < 15, `latest traffic reading ${r.minutes} min ago`);
});

test('the traffic history comes in quarter hours with every segment in each', async () => {
  const [r] = await duckdb(STACK_URL, `WITH t AS (${lastDay(serverSql('traffic'))})
    SELECT count(*) AS n, count(DISTINCT t) AS slots, count(DISTINCT segment_id) AS segments,
           count(*) FILTER (WHERE worst NOT BETWEEN 0 AND 3) AS odd, count(*) FILTER (WHERE incidents > n) AS impossible FROM t`);
  assert.ok(r.slots >= 4, `only ${r.slots} quarter hours`);
  assert.ok(r.segments > 350, `only ${r.segments} segments`);
  assert.ok(r.n >= r.slots * r.segments * 0.9, `${r.n} rows for ${r.slots} slots of ${r.segments} segments`);
  assert.equal(Number(r.odd), 0, 'a worst state outside 0..3');
  assert.equal(Number(r.impossible), 0, 'more incident readings than readings');
});

test('Valenbisi stations are in València, with bikes that fit their docks', async () => {
  const bikes = await duckdb(STACK_URL, serverSql('bikes'));
  assert.ok(bikes.length > 200, `only ${bikes.length} bike stations`);
  assert.ok(bikes.every(inValencia));
  assert.ok(bikes.every((r) => r.bikes + r.free_slots <= r.slots + 2), 'more bikes than slots');
  assert.ok(bikes.every((r) => r.pct === null || (r.pct >= 0 && r.pct <= 100)));
  const hist = await duckdb(STACK_URL, `WITH h AS (${lastDay(serverSql('bikes_hist'))}) SELECT count(DISTINCT bike) AS stations, count(*) AS n FROM h`);
  assert.ok(hist[0].stations > 200, `history for only ${hist[0].stations} stations`);
});

test('the air and weather readings share one table, each kind with its measures', async () => {
  const rows = await duckdb(STACK_URL, `WITH r AS (${lastDay(serverSql('readings'))})
    SELECT kind, count(DISTINCT station) AS stations, count(*) AS n,
           count(*) FILTER (WHERE no2 IS NOT NULL) AS with_no2, count(*) FILTER (WHERE temperature IS NOT NULL) AS with_temp,
           min(latitude) AS lat0, max(latitude) AS lat1, min(longitude) AS lng0, max(longitude) AS lng1
    FROM r GROUP BY kind ORDER BY kind`);
  const air = rows.find((r) => r.kind === 'Aire');
  const meteo = rows.find((r) => r.kind === 'Meteo');
  assert.ok(air && air.stations >= 8, `only ${air?.stations} air stations`);
  assert.ok(meteo && meteo.stations >= 3, `only ${meteo?.stations} weather stations`);
  assert.ok(air.with_no2 > 0 && Number(air.with_temp) === 0, 'an air station with a temperature');
  assert.ok(meteo.with_temp > 0 && Number(meteo.with_no2) === 0, 'a weather station with NO2');
  for (const r of rows) assert.ok(inValencia({ latitude: r.lat0, longitude: r.lng0 }) && inValencia({ latitude: r.lat1, longitude: r.lng1 }), r.kind);
});

test('the map has the four Plus layers and publishes its clicks', () => {
  const { variableMappings, timeSync } = map.vizConfig.spec.options;
  assert.deepEqual(variableMappings.map((m) => [m.field, m.variable]), [['segment_id', 'segment'], ['bike', 'bike'], ['station', 'station']]);
  assert.equal(timeSync, 'toMap');
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => l.type).sort(), ['gauge', 'pipeline', 'sparkline', 'surface']);
});

test('the two histograms carry the brush template, changed only in their constants', () => {
  const code = (title) => panelTitled(dashboard, title).vizConfig.spec.options.getOption;
  const body = brushHistogramBody();
  assert.equal(code('Parte del tiempo con incidencia, por tramo'),
    withConstants(body, "const LO = 'jam_lo';\nconst HI = 'jam_hi';\nconst STEP = 5;\nconst DOMAIN = [0, 100];\nconst UNIT = '% del tiempo con incidencia';\nconst COLOR = 'orange';").trim());
  assert.equal(code('Estaciones por anclajes con bici'),
    withConstants(body, "const LO = 'bikes_lo';\nconst HI = 'bikes_hi';\nconst STEP = 10;\nconst DOMAIN = [0, 100];\nconst UNIT = '% de anclajes con bici';\nconst COLOR = 'green';").trim());
  assert.ok(panelsByType(dashboard, 'volkovlabs-echarts-panel').length >= 5);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads every dataset for an anonymous visitor, with no panel in error', { skip, timeout: 240_000 }, async () => {
  view = await openDashboard(`/d/${UID}?refresh=`, { datasets: DATASETS, timeoutMs: 150_000 });
  assert.equal(await view.panelErrors(), 0);
  const [{ segments, traffic }] = await view.chaski('SELECT (SELECT count(*) FROM datasets.segments) AS segments, (SELECT count(*) FROM datasets.traffic) AS traffic');
  assert.ok(Number(segments) > 350 && Number(traffic) > 1000, `${segments} segments, ${traffic} traffic rows`);
  const bikes = await view.statNumber('Bicis en red');
  assert.ok(bikes > 0 && bikes <= 100, `${bikes} % of docks with a bike`);
});
