// The gtfs-rt-mbta dashboard (Gallery, free Kepler panel): the MBTA's GTFS
// Realtime feeds and its LAMP archive, read by DuckDB on the server through the
// gateway. Live data, so the checks are about shape and plausible ranges.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('dashboards/gallery/gtfs-rt-mbta.json');
const sqls = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
const sqlOf = (title, refId = 'A') =>
  panelTitled(dashboard, title).data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;

// The filters at their defaults ("All"), as Grafana writes them into the SQL.
const ALL = {
  mode: "'Bus','Subway','Commuter rail','Ferry'",
  route: "'__all__'",
  status: "'In transit','Stopped at stop','Arriving at stop','No data'",
  occupancy: "'Many seats','Few seats','Standing room only','Crushed','Full','Not accepting passengers','Empty','No data'",
  vehicle: "''",
  parA: "''",
  parB: "''",
};
const fill = (sql, vars = {}) => sql.replace(/\$(\w+)/g, (m, name) => vars[name] ?? ALL[name] ?? m);
async function query(sql, from = 'now-7d', to = 'now', vars = {}) {
  const body = { queries: [{ refId: 'A', datasource: { uid: 'duckdb' }, rawSql: fill(sql, vars), rawQuery: true, format: 1 }], from, to };
  const { status, json, text } = await api(STACK_URL, '/api/ds/query', { method: 'POST', body });
  if (status !== 200) throw new Error(`/api/ds/query ${status}: ${text.slice(0, 500)}`);
  return rowsOf(json);
}

let current;
after(async () => current && current.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'gtfs-rt-mbta');
  assert.ok(dashboard.spec.description);
  for (const tag of ['duckdb', 'kepler', 'transit', 'live', 'business-charts']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  for (const ds of findAll(dashboard, (n) => n.kind === 'DataQuery' && n.group === 'motherduck-duckdb-datasource')) {
    assert.equal(ds.datasource.name, 'duckdb');
  }
});

test('reads the MBTA only through the gateway', () => {
  assert.ok(sqls.length >= 12);
  assert.doesNotMatch(JSON.stringify(dashboard), /sources-data|testdata|INSTALL/);
  for (const sql of sqls) {
    for (const [url] of sql.matchAll(/'https?:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/mbta\/(realtime|lamp)\//, url);
  }
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/gtfs-rt-mbta');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the fleet is hundreds of vehicles around Boston', async () => {
  const rows = await query(sqlOf('Fleet now — colored by position freshness'));
  assert.ok(rows.length > 100, `${rows.length} vehicles`);
  for (const r of rows) {
    assert.ok(r.latitude > 41 && r.latitude < 43.5 && r.longitude > -72.5 && r.longitude < -70, JSON.stringify(r));
  }
  assert.ok(rows.some((r) => r.mode === 'Bus') && rows.some((r) => r.mode === 'Subway'));
});

test('the feed is fresh and the subway history has every line', async () => {
  const [health] = await query(sqlOf('Is the data arriving, and on time?'));
  assert.ok(health['Feed age'] >= 0 && health['Feed age'] < 600, JSON.stringify(health));
  assert.ok(health['Vehicles reporting'] > 100, JSON.stringify(health));
  const lines = await query(sqlOf('Headways by line'));
  for (const line of ['Red', 'Orange', 'Blue', 'Green']) assert.ok(lines.some((r) => r.Line === line), line);
  for (const r of lines) assert.ok(r.Samples > 100 && r.Actual > 1 && r.Actual < 60, JSON.stringify(r));
});

test('loads for an anonymous visitor, with no panel in error', async () => {
  current = await openDashboard('/d/gtfs-rt-mbta?refresh=', { chaski: false, timeoutMs: 90_000 });
  assert.equal(await current.panelErrors(), 0);
  assert.ok((await current.statNumber('Is the data arriving, and on time?')) >= 0);
});
