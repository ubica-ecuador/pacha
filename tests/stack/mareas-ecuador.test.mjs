// The mareas-ecuador dashboard: INOCAR's tide gauges on the coast of Ecuador,
// minute by minute over the last 24 hours, read live from INOCAR's public JSON.
// These tests need the internet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, panelTitled, findAll } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'mareas-ecuador';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const sqlOf = (title) => panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec.rawSql;
// The DuckDB datasource quotes a bare variable itself; empty, it is ''.
const empty = (sql) => sql.replaceAll('$estacion', "''").replaceAll('$tramo', "''");

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'infinity', 'kepler', 'maritime', 'live']);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets a day of minutes from the ports, on the coast, with a tide range', { timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf('Mareógrafos — altura sobre la bajamar'));
  const ports = new Map();
  for (const row of rows) {
    assert.ok(row.latitude > -4 && row.latitude < 2 && row.longitude > -82 && row.longitude < -78, JSON.stringify(row));
    assert.ok(row.sobre_bajamar >= 0, JSON.stringify(row));
    ports.set(row.estacion, [...(ports.get(row.estacion) ?? []), row]);
  }
  assert.ok(ports.size >= 5, [...ports.keys()].join(', '));
  for (const [port, readings] of ports) {
    assert.ok(readings.length > 1000, `${port}: ${readings.length} minutes`);
    const range = Math.max(...readings.map((r) => r.altura)) - Math.min(...readings.map((r) => r.altura));
    assert.ok(range > 0.5 && range < 6, `${port}: a tide of ${range} m`);
  }
  // The newest reading is recent: the feed is live.
  assert.ok(Date.now() - Math.max(...rows.map((r) => r.time)) < 12 * 3600_000);
});

test('the series without a selection has every port', { timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, empty(sqlOf('Altura al minuto — ${estacion:text} ${tramo:text}')));
  assert.ok(new Set(rows.map((r) => r.estacion)).size >= 5);
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  // Grafana runs a panel's query once it is on screen: visit each one.
  for (const { title } of findAll(dashboard, (n) => n.vizConfig && n.title && !n.title.includes('$'))) await view.panel(title);
  assert.equal(await view.panelErrors(), 0);
});
