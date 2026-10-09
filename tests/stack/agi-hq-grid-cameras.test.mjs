// The agi-hq-grid-cameras dashboard: provisioned in Plus, and its three DuckDB
// queries, as the file holds them, answering through Grafana. The data is
// simulated in the SQL itself, so the checks are about shape. It needs Kepler
// Plus (compose.plus.yaml): without it, the tests are skipped.
//
// Not opened in a browser: the mesh behind the map takes some 300 MB of GPU
// memory and comes from a public bucket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';

const dashboard = loadDashboard('plus/dashboards/agi-hq-grid-cameras.json');
const map = panelTitled(dashboard, 'AGI HQ, Exton · simulated lines and security cameras');
const sqlOf = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;

const provisioned = await api(STACK_URL, '/api/dashboards/uid/agi-hq-grid-cameras');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('the lines are 3D LineStrings that sag between their poles, with a load under the rating', { skip }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf('A'));
  assert.equal(rows.length, 6);
  for (const row of rows) {
    const heights = JSON.parse(row.geometry).coordinates.map((c) => c[2]);
    assert.ok(Math.min(...heights) < Math.max(...heights), row.circuit);
    assert.ok(row.load_a > 0 && row.load_pct < 100, JSON.stringify(row));
  }
});

test('every camera has a field of view, and offline ones read -1', { skip }, async () => {
  for (const refId of ['B', 'C']) {
    const rows = await duckdb(STACK_URL, sqlOf(refId));
    assert.ok(rows.length >= 10, `${refId}: ${rows.length}`);
    for (const row of rows) {
      assert.ok(row.azimuth >= 0 && row.azimuth < 360 && row.beamwidth > 0 && row.range_m > 0, JSON.stringify(row));
      assert.equal(row.status === 'offline', row.events_1h === -1, JSON.stringify(row));
    }
  }
});
