// The land-cover-change dashboard: Impact Observatory's 10 m land cover from Esri's public
// ImageServer — the map draws it, Infinity counts it (computeHistograms) and the server's
// DuckDB crosses year A with year B for the from → to matrix. These tests need the
// internet (ic.imagery1.arcgis.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'land-cover-change';
const MATRIX = 'From $yearA (rows) to $yearB (columns), in the current view';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const [matrix] = findAll(dashboard, (n) => n.title === MATRIX);
const matrixSql = matrix.data.spec.queries[0].spec.query.spec.rawSql;
const [yearA] = findAll(dashboard, (n) => n.name === 'yearA' && n.query);
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const withVars = (sql, vars) => sql.replace(/\$\{(\w+):sqlstring\}/g, (_, name) => quote(vars[name] ?? ''));
// Santa Cruz, Bolivia: 4 by 4 degrees, about 189,400 km², where forest turns into farmland.
const SANTA_CRUZ = { mapWest: '-64', mapEast: '-60', mapSouth: '-19', mapNorth: '-15', area: '', yearA: '2017', yearB: '2025' };

test('follows the dashboards conventions, in English', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'infinity', 'kepler', 'satellite']);
  const datasources = new Set(findAll(dashboard, (n) => n.datasource?.name).map((n) => n.datasource.name));
  assert.deepEqual([...datasources].sort(), ['-- Dashboard --', '-- Grafana --', 'duckdb', 'infinity']); // Grafana's: the built-in annotations
  // The years and the matrix's rasters through the gateway's cache.
  assert.match(matrixSql, /http:\/\/feeds\/lulc\/exportImage/);
  assert.match(yearA.query.spec.__legacyStringValue, /http:\/\/feeds\/lulc\/query/);
  assert.doesNotMatch(JSON.stringify(dashboard), /[áéíóúñ¿¡«»]|\b(anio|clase|arboles|cultivos|nubes)\b/i);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the years come from the service catalogue', async () => {
  const years = (await duckdb(STACK_URL, yearA.query.spec.__legacyStringValue)).map((r) => Number(r.year));
  assert.ok(years.includes(2017) && years.includes(2025), years.join());
  assert.ok(years.length >= 9);
});

test('the matrix counts what became what, in real km²', { timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, withVars(matrixSql, SANTA_CRUZ));
  const from = new Map(rows.map((r) => [r['From ↓ · to →'], r]));
  assert.ok(from.has('Trees') && from.has('Crops'), [...from.keys()].join());
  // About 7,700 km² of forest became cropland here between 2017 and 2025.
  const treesToCrops = from.get('Trees').Crops;
  assert.ok(treesToCrops > 5_000 && treesToCrops < 10_000, `${treesToCrops} km²`);
  assert.equal(from.get('Trees').Trees, null); // what stayed is left out
  const lost = rows.reduce((sum, r) => sum + r['Lost (all)'], 0);
  assert.ok(lost > 10_000 && lost < 189_400 / 2, `${lost} km² changed`);
});

test('the rasters are read through the gateway, and kept', () => {
  const path = '/lulc/query?where=1%3D1&outFields=Year&returnDistinctValues=true&returnGeometry=false&orderByFields=Year&f=json';
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${path}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

test('opens with every panel drawn', { timeout: 180_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  try {
    for (const { title } of findAll(dashboard, (n) => n.vizConfig && n.title)) {
      await view.panel(title.replaceAll('$yearA', '2017').replaceAll('$yearB', '2025'));
    }
    const table = await view.panel(MATRIX.replace('$yearA', '2017').replace('$yearB', '2025'));
    assert.match(await table.innerText(), /Trees[\s\S]*km²/);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
