// The hsl-live dashboard: Helsinki's public transport from HSL's MQTT broker,
// streamed through Grafana Live to a Kepler Plus Fleet map. Live data, so the
// checks are about shape: the broker answers, the page streams, nothing errs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/hsl-live.json');
const queries = findAll(dashboard, (n) => n.kind === 'DataQuery' && n.group === 'grafana-mqtt-datasource');

let current;
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/hsl-live');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'hsl-live');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['mqtt', 'kepler', 'plus', 'transit', 'live']);
});

test('every query streams one kind of vehicle from the provisioned broker', () => {
  assert.equal(queries.length, 4);
  for (const query of queries) {
    assert.equal(query.datasource.name, 'hsl-mqtt');
    // One kind at a time: the whole broker is thousands of messages a second.
    assert.equal(query.spec.topic, '/hfp/v2/journey/ongoing/vp/${mode}/#');
  }
  const [mode] = dashboard.spec.variables;
  assert.equal(mode.spec.name, 'mode');
  assert.deepEqual(mode.spec.query.split(','), ['tram', 'metro', 'train', 'ferry', 'bus']);
});

test("the map's Fleet layer reads the columns the panel names", () => {
  const [layer] = findAll(dashboard, (n) => n.type === 'fleet');
  // Extract fields drops the refId, so the dataset is the first frame's; the
  // panel renames lat/long and Time to its roles.
  assert.equal(layer.config.dataId, 'grafana-0');
  assert.deepEqual(layer.config.columns, { lat: 'latitude', lng: 'longitude' });
  assert.equal(layer.config.visConfig.fleetAssetField, 'vehicle');
  assert.equal(layer.config.visConfig.fleetTimeField, 'time');
});

test('the broker answers', async () => {
  const { json } = await api(STACK_URL, '/api/datasources/uid/hsl-mqtt/health');
  assert.equal(json.status, 'OK', JSON.stringify(json));
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('streams buses to an anonymous visitor, with no panel in error', { skip }, async () => {
  // Buses: some run all night, where trams and the metro do not.
  current = await openDashboard('/d/hsl-live?var-mode=bus', { chaski: false, timeoutMs: 60_000 });
  await current.page.waitForTimeout(20_000);
  assert.equal(await current.panelErrors(), 0);
  assert.ok((await current.statNumber('Vehicles')) > 0);
});
