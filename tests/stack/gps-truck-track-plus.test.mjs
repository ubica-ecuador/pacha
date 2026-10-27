// The gps-truck-track-plus dashboard: the inline track it carries, loaded once
// into Chaski, a Time Brush and Mosaic views in one selection, truckFilters; a
// Kepler Plus map that drives the truck (Fleet) at the end of the brushed window
// and another that raises the fixes the filters keep as a 3D curtain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = process.env.GPS_TRUCK_PLUS_UID ?? 'gps-truck-track-plus';
const dashboard = loadDashboard('plus/dashboards/gps-truck-track-plus.json');
const [track] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'track');
const chase = panelTitled(dashboard, 'Behind the wheel');
const curtain = panelTitled(dashboard, 'The whole road, speed as a curtain');

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'gps-truck-track-plus');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'infinity', 'kepler', 'mosaic', 'plus', 'gps']);
  assert.equal(track.source.type, 'datasource');
  assert.equal(track.source.datasource.uid, 'infinity');
  // The brushes write these; a dataset reading one would reload on every
  // brush, and a reload clears them all.
  const written = ['t0', 't1', 'km_lo', 'km_hi', 'spd_lo', 'spd_hi', 'acc_lo', 'acc_hi'];
  for (const dataset of findAll(dashboard, (n) => n.kind === 'dataset')) {
    const sql = dataset.source.sql ?? '';
    for (const name of written) assert.doesNotMatch(sql, new RegExp(`\\$${name}\\b`), `${dataset.name} reads ${name}`);
  }
  // Chaski reads a quote in a comment as the start of a string and then
  // leaves the macros after it unexpanded.
  for (const q of findAll(dashboard, (n) => typeof n.rawSql === 'string')) {
    for (const line of q.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) {
      assert.doesNotMatch(line, /['"]/, line);
    }
  }
  // The curtain filters on the GPU from the Selection; the chase map takes
  // only the time window, through the variables the Time Brush writes.
  assert.equal(curtain.vizConfig.spec.options.mosaicSelection, 'truckFilters');
  for (const q of curtain.data.spec.queries) assert.doesNotMatch(q.spec.query.spec.rawSql, /\$__crossfilter/);
  const chaseOpts = chase.vizConfig.spec.options;
  assert.equal(chaseOpts.mosaicSelection, '');
  assert.equal(chaseOpts.timeSync, 'variables');
  assert.deepEqual(chaseOpts.timeVariables, { from: 't0', to: 't1' });
  const fleet = chaseOpts.mapConfig.config.visState.layers.find((l) => l.type === 'fleet');
  assert.equal(fleet.config.visConfig.fleetTimeRef, 'history');
  assert.equal(fleet.config.visConfig.fleetTimeField, 'time');
  const [brush] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-timebrush-panel');
  assert.equal(brush.vizConfig.spec.options.mosaicSelection, 'truckFilters');
  assert.deepEqual(brush.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  if (UID === 'gps-truck-track-plus') assert.equal(provisioned.json.meta.folderUid, 'plus');
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

test('opens with every panel drawn and the totals of the whole trip', { skip }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['track', 'truck'], timeoutMs: 120_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    const [t] = await view.chaski(
      `SELECT count(*)::INT AS n, sum(step_km) AS km, count(DISTINCT band)::INT AS bands,
              count(DISTINCT stop_id) FILTER (WHERE at_stop)::INT AS stops FROM datasets.truck`,
    );
    assert.equal(t.n, 1812);
    assert.ok(Math.abs(t.km - 27.486) < 1e-6, JSON.stringify(t));
    assert.equal(t.bands, 6);
    assert.equal(t.stops, 5);
    // The Time Brush writes the whole range at load: the totals are the whole trip's.
    assert.match(await (await view.panel('Distance')).innerText(), /27\.5\s*km/);
    assert.equal(await view.statNumber('Stops'), 5);
    const marks = { 'The road, coloured by speed': 'svg circle', 'Time at each speed': 'svg rect', 'Braking and accelerating': 'svg rect' };
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
