// The tile3d dashboard: a photogrammetric 3D Tiles mesh of the AGI headquarters
// in Exton, drawn by the kepler panel straight from its URL in a public bucket.
// The panel's DuckDB query is a placeholder that returns no rows: the mesh is
// a dataset saved in the map's config, so the tests check that config and that
// the tileset answers. The tiles are heavy (some 300 MB of GPU memory up close);
// under the tests' software WebGL the page only has to load without errors.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'tile3d';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const map = panelTitled(dashboard, 'AGI HQ, Exton · a 3D Tiles mesh on the ground');
const { mapConfig } = map.vizConfig.spec.options;

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'buildings']);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map holds one tile3d layer, set on the ground, over a tileset that answers', async () => {
  const [layer] = mapConfig.config.visState.layers;
  assert.equal(layer.type, 'tile3d');
  assert.equal(layer.config.visConfig.groundTileset, true);
  const [dataset] = mapConfig.datasets;
  assert.equal(dataset.data.id, layer.config.dataId);
  const tileset = await (await fetch(dataset.data.metadata.tile3dUrl)).json();
  assert.ok(tileset.asset.version && tileset.root.boundingVolume, JSON.stringify(tileset).slice(0, 300));
  // The placeholder query answers, empty.
  assert.equal((await duckdb(STACK_URL, map.data.spec.queries[0].spec.query.spec.rawSql)).length, 0);
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 240_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  assert.equal(await view.panelErrors(), 0);
});
