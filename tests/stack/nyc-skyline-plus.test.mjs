// The nyc-skyline-plus dashboard: Manhattan's buildings by height, with the
// subway as Kepler Plus pipelines raised over them. Its data is a public
// GeoLens catalogue, read by DuckDB on the server through the gateway's
// cache. It needs Kepler Plus (compose.plus.yaml): without it, the stack
// tests are skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/nyc-skyline-plus.json');
const sqls = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
const pipeline = layers.find((l) => l.type === 'pipeline');
const linesSql = sqls.find((sql) => sql.includes('fd3a8635-1f38-4b51-a18f-784ea84abbbf'));

let current;
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/nyc-skyline-plus');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'nyc-skyline-plus');
  assert.ok(dashboard.spec.description);
  for (const tag of ['duckdb', 'kepler', 'transit', 'plus']) assert.ok(dashboard.spec.tags.includes(tag), tag);
});

test('reads every parquet through the gateway, none from the bench', () => {
  assert.ok(sqls.length >= 6);
  for (const sql of sqls) {
    assert.doesNotMatch(sql, /sources-data/);
    for (const [, url] of sql.matchAll(/read_parquet\('([^']+)'\)/g)) assert.match(url, /^http:\/\/feeds\/geolens\/datasets\//);
  }
});

test('draws the subway as an animated pipeline, raised by its altitude column', () => {
  assert.ok(pipeline, 'no pipeline layer');
  assert.equal(pipeline.visualChannels.altitudeField?.name, 'altitude');
  assert.equal(pipeline.config.visConfig.trafficAnimate, true);
  assert.equal(pipeline.config.visConfig.elevationScale, 1);
});

test('puts every service on a floor of its own, over the chosen height', async () => {
  const rows = await duckdb(STACK_URL, linesSql.replaceAll('$lineBase', '500'));
  const floors = new Map(rows.map((r) => [r.service, Number(r.altitude)]));
  assert.equal(floors.size, 27);
  assert.equal(new Set(floors.values()).size, floors.size);
  assert.ok([...floors.values()].every((a) => a >= 500 && a < 800), JSON.stringify([...floors]));
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor, with no panel in error', { skip }, async () => {
  current = await openDashboard('/d/nyc-skyline-plus', { chaski: false, timeoutMs: 90_000 });
  assert.equal(await current.panelErrors(), 0);
  assert.ok((await current.statNumber('Within ${radius:text} of a station'.replace('${radius:text}', '400 m'))) > 0);
});
