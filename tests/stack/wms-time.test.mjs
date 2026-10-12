// The wms-time dashboard: PERSIANN satellite rainfall over Ecuador from
// GeoGLOWS' GeoServer, a WMS with a TIME dimension. DuckDB reads the dates the
// service lists in its GetCapabilities; the kepler panel asks the WMS for the
// image of the date under its time bar, and the WCS of the same layer gives
// the numbers for the stat and the seven-day series. These tests need the
// internet, and GeoGLOWS up.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, panelTitled, findAll } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'wms-time';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const sqlOf = (title) => panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec.rawSql;

// Variables as Grafana fills them on load: the DuckDB datasource quotes a bare
// variable itself, and the map has published nothing yet.
const VARS = { capa: 'persiann_pdir_24h', area: '', mapTo: '', mapFrom: '', west: '', south: '', east: '', north: '', lluvia: '' };
const fill = (sql) => sql.replace(/\$(\w+)/g, (match, name) => (name in VARS ? `'${VARS[name]}'` : match));
async function query(sql) {
  const { status, json, text } = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    body: { from: 'now-45d', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql: fill(sql), rawQuery: true, format: 1 }] },
  });
  assert.equal(status, 200, text.slice(0, 500));
  return rowsOf(json);
}

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'weather']);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets the days the service lists in the range, one row a day', { timeout: 120_000 }, async () => {
  const rows = await query(sqlOf('PERSIANN over Ecuador · drag the time, click the map'));
  assert.ok(rows.length >= 30 && rows.length <= 46, `${rows.length} days`);
  assert.ok(rows.every((row) => row.wms_layer === 'persiann_pdir_24h' && row.wms_url.startsWith('https://')));
  assert.ok(Date.now() - rows.at(-1).time < 4 * 86400_000, 'the newest day is recent');
});

test('the WCS gives a day of rain over Ecuador', { timeout: 120_000 }, async () => {
  const [row] = await query(sqlOf('Rain over the area · one day'));
  assert.ok(row['celdas en la zona'] > 0, JSON.stringify(row));
  assert.ok(row['media mm'] >= 0 && row['máximo mm'] < 1000, JSON.stringify(row));
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  // Grafana runs a panel's query once it is on screen: visit each one.
  for (const { title } of findAll(dashboard, (n) => n.vizConfig && n.title && !n.title.includes('$'))) await view.panel(title);
  assert.equal(await view.panelErrors(), 0);
});
