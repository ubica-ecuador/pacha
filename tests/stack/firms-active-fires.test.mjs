// firms-active-fires: FIRMS detections in Chaski, plus CAMS smoke (omaod550)
// as a day-by-day Zarr catalogue on the map, sharing t0/t1 with the time brush.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';

const UID = 'firms-active-fires';
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const map = panelTitled(dashboard, 'Where: fire in the window');
const smokeSql = map.data.spec.queries.find((q) => q.spec.refId === 'B').spec.query.spec.rawSql;
const opts = map.vizConfig.spec.options;
const { from, to } = dashboard.spec.timeSettings;

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

async function duckdb(rawSql) {
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    body: {
      from,
      to,
      queries: [
        {
          refId: 'A',
          datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' },
          rawSql,
          rawQuery: true,
          format: 1,
        },
      ],
    },
  });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  return rowsOf(res.json);
}

test('follows the dashboards conventions', { skip }, () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.ok(dashboard.spec.tags.includes('plus') && dashboard.spec.tags.includes('chaski'));
  assert.equal(opts.rasterServerUrl, '/titiler');
  assert.equal(opts.zarrRescale, '0,1');
  assert.equal(opts.timeSync, 'variables');
  assert.deepEqual(opts.timeVariables, { from: 't0', to: 't1' });
  assert.doesNotMatch(JSON.stringify(dashboard), /titiler\.ubica|pacha-titiler/);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('the map gets one CAMS smoke scene per day in the dashboard window', { skip }, async () => {
  const rows = await duckdb(smokeSql);
  assert.ok(rows.length >= 5 && rows.length <= 10, `got ${rows.length} days`);
  assert.ok(rows.every((r) => r.zarr_variable === 'omaod550' && r.zarr_sel === 'time_step=0'));
  assert.ok(rows.every((r) => String(r.zarr_url).includes('cams_global_atmospheric_composition')));
  assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}T00:00:00\.000000000$/.test(r.zarr_time_label)));
});
