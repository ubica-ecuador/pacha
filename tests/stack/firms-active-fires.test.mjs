// firms-active-fires: FIRMS detections in Chaski, plus CAMS smoke (omaod550)
// as an hourly Zarr catalogue on the map (each hour reuses the latest daily
// analysis), sharing t0/t1 with the time brush.
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

test('CAMS smoke is stamped hourly and a short daytime brush still hits a scene', { skip }, async () => {
  const rows = await duckdb(smokeSql);
  assert.ok(rows.length >= 24 * 5, `got ${rows.length} hours`);
  assert.ok(rows.every((r) => r.zarr_variable === 'omaod550' && r.zarr_sel === 'time_step=0'));
  assert.ok(rows.every((r) => String(r.zarr_url).includes('cams_global_atmospheric_composition')));

  const t0 = Date.parse('2026-10-13T02:00:00.000Z');
  const t1 = Date.parse('2026-10-13T08:00:00.000Z');
  const inWin = rows.filter((r) => r.time >= t0 && r.time <= t1);
  assert.ok(inWin.length >= 3, `brush window hours: ${inWin.length}`);
  assert.equal(inWin.at(-1).zarr_time_label.slice(0, 10), '2026-10-13');

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const todayRows = rows.filter((r) => new Date(r.time).toISOString().slice(0, 10) === today);
  assert.ok(todayRows.length > 0);
  assert.ok(todayRows.every((r) => r.zarr_time_label.slice(0, 10) === yesterday));
});
