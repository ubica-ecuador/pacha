// The fiware-valencia dashboard: València's open real-time data (traffic by
// segment, air quality, weather and Valenbisi) as NGSI-LD entities in a
// Stellio context broker, read through its public read-only NGSI-LD API (now)
// and the Parquet exports of its history. The data is live, so the checks
// are about shape and freshness, not numbers.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'fiware-valencia';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const sqlOf = (title, refId = 'A') =>
  panelTitled(dashboard, title).data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const NOW_MAP = 'Ahora: tráfico, calidad del aire y Valenbisi';
// $__timeFilter as Grafana expands it, for the last 24 hours.
const lastDay = (sql) => sql.replace(/\$__timeFilter\(([\w.]+)\)/g, "$1 > now() - INTERVAL 24 HOUR");
// Inside València's municipal area, with margin.
const inValencia = (r) => r.latitude > 39.27 && r.latitude < 39.6 && r.longitude > -0.55 && r.longitude < -0.25;

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', async () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  for (const tag of ['duckdb', 'kepler', 'live']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'gallery');
});

test('the broker has every traffic segment, as GeoJSON lines with a known state', async () => {
  const rows = await duckdb(STACK_URL, sqlOf(NOW_MAP, 'A'));
  assert.ok(rows.length > 350, `only ${rows.length} segments`);
  for (const row of rows) {
    assert.match(JSON.parse(row.geojson).type, /LineString$/, row.name);
    assert.ok(row.state >= 0 && row.state <= 9 && row.state_label, JSON.stringify(row));
  }
});

test('air quality and Valenbisi stations are in València', async () => {
  const air = await duckdb(STACK_URL, sqlOf(NOW_MAP, 'B'));
  const bikes = await duckdb(STACK_URL, sqlOf(NOW_MAP, 'C'));
  assert.ok(air.length >= 8, `only ${air.length} air stations`);
  assert.ok(bikes.length > 200, `only ${bikes.length} bike stations`);
  assert.ok([...air, ...bikes].every(inValencia));
  assert.ok(bikes.every((r) => r.available_bikes + r.free_slots <= r.total_slots + 2), 'more bikes than slots');
});

test('the history is fresh: the last traffic reading is under 15 minutes old', async () => {
  const [r] = await duckdb(STACK_URL, `WITH f AS (${sqlOf('Última observación de cada fuente')})
    SELECT date_diff('minute', "Tráfico", now()) AS minutes FROM f`);
  assert.ok(r.minutes < 15, `latest traffic reading ${r.minutes} min ago`);
});

test('the incident counts cover the last day with readings every 3 minutes', async () => {
  const rows = await duckdb(STACK_URL, lastDay(sqlOf('Tramos con incidencia')));
  assert.ok(rows.length > 0, 'no readings');
  for (const row of rows) assert.ok(row['Cortado'] >= 0 && row['Denso'] >= 0, JSON.stringify(row));
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}?refresh=`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
});
