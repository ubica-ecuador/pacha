// The starlink-constellation dashboard: CelesTrak's orbital elements through
// the gateway, propagated in DuckDB on the server. Every query is run as a
// visitor runs it, with the dashboard's macros and variables filled in.
// It needs Kepler Plus (compose.plus.yaml): without it, the browser test is
// skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, rowsOf } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/starlink-constellation.json');
const panelSql = (title) =>
  findAll(dashboard, (n) => n.kind === 'Panel' && n.spec.title === title)[0].spec.data.spec.queries[0].spec.query.spec.rawSql;

async function run(sql) {
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    anonymous: true,
    body: { from: 'now-15m', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql: sql, rawQuery: true, format: 1 }] },
  });
  return rowsOf(res.json);
}
// Cuenca, the variables' default.
const fill = (sql) => sql.replaceAll('${lat}', '-2.9').replaceAll('${lon}', '-79.0');

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/starlink-constellation');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'starlink-constellation');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'plus', 'business-charts', 'space', 'live']);
});

test('reads the elements through the gateway only', () => {
  assert.match(JSON.stringify(dashboard), /http:\/\/feeds\/celestrak\/starlink\.csv/);
  assert.doesNotMatch(JSON.stringify(dashboard), /celestrak\.org/);
});

test('thousands of satellites, each where its orbit allows', async () => {
  const rows = await run(`WITH m AS (${fill(panelSql('Every Starlink satellite'))})
    SELECT count(DISTINCT norad) AS sats,
           count(*) FILTER (WHERE abs(latitude) > 98 OR longitude NOT BETWEEN -540 AND 540) AS impossible,
           count(*) FILTER (WHERE altitude_km NOT BETWEEN 150 AND 2000) AS heights,
           date_diff('minute', max(time), now()) AS minutes
    FROM m`);
  const [r] = rows;
  assert.ok(r.sats > 5000, `only ${r.sats} satellites`);
  assert.equal(Number(r.impossible), 0);
  assert.equal(Number(r.heights), 0);
  assert.ok(r.minutes < 3, `newest position ${r.minutes} min ago`);
});

test('the satellites over the default point are a few dozen', async () => {
  const [r] = await run(fill(panelSql('Overhead the chosen point')));
  assert.ok(r['Overhead now'] > 10 && r['Overhead now'] < 500, `${r['Overhead now']} overhead`);
});

test('CelesTrak is served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', 'http://feeds/celestrak/starlink.csv']);
  headers();
  assert.match(headers(), /X-Cache-Status: (HIT|STALE|UPDATING)/i);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor, with no panel in error', { skip }, async () => {
  view = await openDashboard('/d/starlink-constellation?refresh=', { chaski: false, timeoutMs: 90_000 });
  assert.equal(await view.panelErrors(), 0);
  assert.ok((await view.statNumber('Overhead the chosen point')) > 0);
});
