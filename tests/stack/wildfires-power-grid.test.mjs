// The wildfires-power-grid dashboard: NASA FIRMS's VIIRS fires and the
// OpenStreetMap grid of each region, through the gateway, crossed in DuckDB on
// the server. Every query is run as a visitor runs it, with the dashboard's
// variables filled in as Grafana fills them. It needs Kepler Plus
// (compose.plus.yaml): without it, the browser test is skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, rowsOf } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/wildfires-power-grid.json');
const REGIONS = { 'central-brazil': 'South_America', 'southern-africa': 'Southern_Africa', 'eastern-australia': 'Australia_NewZealand', california: 'USA_contiguous_and_Hawaii' };
const queries = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) =>
  p.spec.data.spec.queries.map((q) => ({ title: p.spec.title, ref: q.spec.refId, sql: q.spec.query.spec.rawSql })),
);
const sqlOf = (title, ref = 'A') => queries.find((q) => q.title === title && q.ref === ref).sql;
const fill = (sql, region, km = '5') =>
  sql
    .replaceAll('${region:sqlstring}', `'${region}'`)
    .replaceAll('${region:raw}', region)
    .replaceAll('${firms:raw}', REGIONS[region])
    .replaceAll('${km:raw}', km);

async function run(sql) {
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    anonymous: true,
    body: { from: 'now-48h', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql: sql, rawQuery: true, format: 1 }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 500));
  return rowsOf(res.json);
}

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/wildfires-power-grid');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'wildfires-power-grid');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'plus', 'energy', 'live']);
});

test('reads every source through the gateway only', () => {
  const all = JSON.stringify(dashboard);
  assert.match(all, /http:\/\/feeds\/firms\//);
  assert.match(all, /http:\/\/feeds\/overpass\/power-lines\//);
  assert.doesNotMatch(all, /nasa\.gov|overpass-api\.de/);
});

test('every panel query runs in every region', async () => {
  for (const region of Object.keys(REGIONS)) {
    for (const { title, ref, sql } of queries) await assert.doesNotReject(run(fill(sql, region)), `${title} ${ref} in ${region}`);
  }
});

test('fires, a grid, and the stretches of line near a fire, never more than the grid', async () => {
  const [r] = await run(fill(sqlOf('Fires and the grid'), 'central-brazil'));
  assert.ok(r['Fire detections'] > 100, `${r['Fire detections']} detections`);
  assert.ok(r['Km of line mapped'] > 10000, `${r['Km of line mapped']} km mapped`);
  assert.ok(r['Near a line'] <= r['Fire detections']);
  assert.ok(r['Km of line exposed'] <= r['Km of line mapped']);
});

test('a wider distance reaches more line', async () => {
  const exposed = async (km) => (await run(fill(sqlOf('Fires and the grid'), 'central-brazil', km)))[0]['Km of line exposed'];
  assert.ok((await exposed('10')) > (await exposed('2')));
});

test('the gateway caches FIRMS and Overpass, and asks Overpass for the four regions only', () => {
  const headers = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${path}`]);
  const firms = '/firms/noaa-20-viirs-c2/J1_VIIRS_C2_South_America_7d.csv';
  headers(firms);
  assert.match(headers(firms), /X-Cache-Status: (HIT|STALE|UPDATING)/i);
  assert.match(headers('/overpass/power-lines/central-brazil.json'), /X-Cache-Status: (HIT|STALE|UPDATING)/i);
  const status = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://feeds${path}`]);
  assert.equal(status('/overpass/power-lines/europe.json'), '404');
  assert.equal(status('/firms/noaa-20-viirs-c2/J1_VIIRS_C2_Global_7d.csv'), '404');
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor, with no panel in error', { skip }, async () => {
  view = await openDashboard('/d/wildfires-power-grid?refresh=', { chaski: false, timeoutMs: 90_000 });
  assert.equal(await view.panelErrors(), 0);
  assert.ok((await view.statNumber('Fires and the grid')) > 0);
});
