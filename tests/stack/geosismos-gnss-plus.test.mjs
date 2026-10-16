// The geosismos-gnss-plus dashboard: Chilean GNSS station shifts from
// Geo-Sismos on a Kepler Plus map whose arrows measure the time brush. A
// handful of checks: conventions, the brush wiring, the network query, the
// built file of daily positions (skipped without datasets/geosismos/build.sh),
// one station's series, and that it opens without errors (skipped without
// Kepler Plus). The sources are public, so these tests need the internet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'geosismos-gnss-plus';
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const mapConfig = map.vizConfig.spec.options.mapConfig.config;

// The server query that fills a Chaski dataset, for a given window.
const serverSql = (name, from = '2025-01-01', to = '2026-09-20') =>
  dashboard.spec.variables
    .find((v) => v.spec.name === name)
    .spec.query.spec.source.query.rawSql.replaceAll('$__timeFrom()', `TIMESTAMP '${from}'`)
    .replaceAll('$__timeTo()', `TIMESTAMP '${to}'`);

const seriesSql = findAll(dashboard, (n) => typeof n.rawSql === 'string' && n.rawSql.includes('graphs?id_station'))[0]
  .rawSql.replaceAll('${station:raw}', 'ANTC')
  .replaceAll('$__timeFrom()', "TIMESTAMP '2025-01-01'")
  .replaceAll('$__timeTo()', "TIMESTAMP '2026-09-20'");

const FILE = 'http://feeds/datasets/geosismos/positions.parquet';
const status = (url) =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url]).trim();
const unbuilt = status(FILE) !== '200' && 'Geo-Sismos positions are not built on this stack (datasets/geosismos/build.sh)';

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const noPlus = provisioned.status === 404 && 'Kepler Plus is not mounted';

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'chaski', 'kepler', 'plus', 'business-charts', 'gps', 'seismic']);
  // Links that reload the dashboard stay on this one.
  assert.doesNotMatch(JSON.stringify(dashboard), /\/d\/geosismos-gnss[?$]/);
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
  assert.equal(sql.length > 0, true);
  assert.equal(sql.some((q) => /INSTALL/.test(q)), false);
  const names = findAll(dashboard, (n) => n.datasource && n.kind === 'DataQuery').map((n) => n.datasource.name);
  assert.ok(names.every((name) => ['duckdb', 'duckdbwasm', '-- Grafana --'].includes(name)));
});

test('the map arrows measure the time brush', () => {
  const brush = panelsByType(dashboard, 'ubica-timebrush-panel')[0];
  assert.deepEqual(brush.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
  const arrows = mapConfig.visState.layers.filter((l) => l.type === 'symbol');
  assert.deepEqual(arrows.map((l) => l.config.dataId).sort(), ['grafana-F', 'grafana-G', 'grafana-I']);
});

test('the network query returns every station, and the largest 2025–2026 shift is centimetres', async () => {
  const rows = await duckdb(STACK_URL, serverSql('shifts'));
  assert.equal(rows.length, 158);
  assert.ok(rows.every((r) => r.latitude < -17 && r.latitude > -56 && r.longitude < -67 && r.longitude > -110));
  const moved = rows.filter((r) => r.horizontal_m != null);
  // Trying the ends a few days inward is what lifts this above the ~54 that
  // have a position on exactly the first and the last day.
  assert.ok(moved.length > 70, `${moved.length} stations with a shift`);
  const max = Math.max(...moved.map((r) => r.horizontal_m));
  assert.ok(max > 0.05 && max < 0.2, `largest shift ${max} m`);
  assert.ok(moved.every((r) => r.coverage >= 0 && r.coverage <= 1));
  assert.ok(new Date(rows[0].published) >= new Date('2026-09-20'));
});

test('the paths read only the built file, in at most about 120 buckets a station', { skip: unbuilt }, async () => {
  const sql = serverSql('spark');
  assert.deepEqual([...new Set(sql.match(/https?:\/\/[^'"\s]+/g))], [FILE]);
  const rows = await duckdb(STACK_URL, sql);
  const ids = new Set(rows.map((r) => r.id));
  assert.ok(ids.size > 120, `${ids.size} stations`);
  const per = Math.max(...[...ids].map((id) => rows.filter((r) => r.id === id).length));
  assert.ok(per <= 121, `${per} buckets for one station`);
  // The build drops PORT's unflagged run of metres-off days in June 2026.
  const port = rows.filter((r) => r.id === 'PORT' && r.east_mm != null);
  assert.ok(port.length && Math.max(...port.map((r) => Math.abs(r.east_mm))) < 300);
});

test('ANTC has a daily series in millimetres from its first good day', async () => {
  const rows = await duckdb(STACK_URL, seriesSql);
  assert.ok(rows.length > 400, `${rows.length} days`);
  assert.equal(new Date(rows[0].time).toISOString().slice(0, 10), '2025-01-01');
  const good = rows.find((r) => r.out_e === 0 && r.east_mm != null);
  assert.equal(good.east_mm, 0);
  const last = rows.filter((r) => r.out_n === 0 && r.north_mm != null).at(-1);
  assert.ok(Math.abs(last.north_mm) > 5 && Math.abs(last.north_mm) < 100, `north ${last.north_mm} mm`);
});

test('loads for an anonymous visitor with no panel in error', { skip: noPlus }, async () => {
  const datasets = ['shifts', 'quakes', 'plates', 'avail', ...(unbuilt ? [] : ['spark'])];
  view = await openDashboard(`/d/${UID}`, { datasets, timeoutMs: 90_000 });
  assert.ok(view.loadMs <= 90_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  // Over the brush, which opens on the whole window.
  const stations = await view.statNumber('Stations with a shift');
  assert.ok(stations > 70 && stations <= 158, `${stations} stations`);
  // The title carries the station: the chart was drawn for the default one.
  await view.panel('Daily position of ANTC · millimetres from its first day in the window');
  assert.equal(await view.panelErrors(), 0);
});
