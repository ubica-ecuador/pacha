// The gps-truck-track dashboard: the inline track it carries, and the page:
// Chaski derives the steps, accelerations and stops from it, the totals add
// up to the whole trip, and every panel draws with no error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'gps-truck-track';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const [track] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'track');

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'infinity', 'kepler', 'mosaic', 'gps']);
  assert.equal(track.source.type, 'datasource');
  assert.equal(track.source.datasource.uid, 'infinity');
  // The Mosaic brushes write these; a dataset reading one would reload on
  // every brush, and a reload clears them all.
  const written = ['km_lo', 'km_hi', 'spd_lo', 'spd_hi', 'acc_lo', 'acc_hi'];
  const writes = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-chaski-mosaic-panel')
    .map((p) => p.vizConfig.spec.options.variables)
    .join('\n');
  for (const name of written) assert.match(writes, new RegExp(`\\b${name}\\b`), name);
  for (const dataset of findAll(dashboard, (n) => n.kind === 'dataset')) {
    const sql = dataset.source.sql ?? '';
    for (const name of written) assert.doesNotMatch(sql, new RegExp(`\\$${name}\\b`), `${dataset.name} reads ${name}`);
  }
  // The map filters on the GPU from the Selection, so its query leaves the filters out.
  const [map] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplergl-panel');
  assert.equal(map.vizConfig.spec.options.mosaicSelection, 'truckFilters');
  for (const q of map.data.spec.queries) assert.doesNotMatch(q.spec.query.spec.rawSql, /\$__crossfilter/);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the track is one fix a second for 30 minutes over 27.5 km', () => {
  const [header, ...lines] = track.source.query.data.trim().split('\n');
  const cols = header.split(',');
  const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], Number(v)])));
  assert.equal(rows.length, 1812);
  rows.forEach((r, i) => assert.equal(r.elapsed_s, i));
  assert.equal(rows.at(-1).distance_km, 27.486);
  // A truck on PA-61 between Hamburg and Reading.
  for (const r of rows) {
    assert.ok(r.latitude > 40.3 && r.latitude < 40.6 && r.longitude > -76 && r.longitude < -75.9, JSON.stringify(r));
    assert.ok(r.speed_kmh >= 0 && r.speed_kmh < 95, JSON.stringify(r));
  }
});

test('opens with every panel drawn and the totals of the whole trip', async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['track', 'truck'], timeoutMs: 120_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    const [t] = await view.chaski(
      `SELECT count(*)::INT AS n, sum(step_km) AS km, min(accel) AS amin, max(accel) AS amax,
              count(DISTINCT stop_id) FILTER (WHERE at_stop)::INT AS stops FROM datasets.truck`,
    );
    assert.equal(t.n, 1812);
    assert.ok(Math.abs(t.km - 27.486) < 1e-6, JSON.stringify(t));
    assert.ok(t.amin > -2 && t.amax < 1, JSON.stringify(t));
    assert.equal(t.stops, 5);
    // "27.5 km": statNumber would read the k as thousands.
    assert.match(await (await view.panel('Distance')).innerText(), /27\.5\s*km/);
    assert.equal(await view.statNumber('Stops'), 5);
    // The profile's dots and the histograms' bars, below the fold too.
    const marks = { 'Elevation and speed along the road': 'svg circle', 'Time at each speed': 'svg rect', 'Braking and accelerating': 'svg rect' };
    for (const [title, mark] of Object.entries(marks)) {
      const panel = await view.panel(title);
      await panel.getByTestId('mosaic-panel').locator(mark).first().waitFor({ timeout: 60_000 });
    }
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
