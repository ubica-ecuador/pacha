// The esri-image dashboard: Sentinel-2 10 m land cover of the world, year by
// year, drawn by the kepler panel from a public ArcGIS Image Service. The DuckDB
// query only hands the panel the service URL and the mosaic rule that picks the
// year; the tiles come from the service, so these tests need the internet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'esri-image';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const sql = panelTitled(dashboard, 'Land cover in $anio · Sentinel-2, 10 m').data.spec.queries[0].spec.query.spec.rawSql;
const YEARS = dashboard.spec.variables[0].spec.query.split(',').map((y) => y.trim());

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'satellite']);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('every year in the picker is a year the service holds, and the query picks it', async () => {
  const [{ esri_url: url }] = await duckdb(STACK_URL, sql.replace('$anio', YEARS[0]));
  const held = await (
    await fetch(`${url}/query?where=1%3D1&outFields=Year&returnDistinctValues=true&returnGeometry=false&f=json`)
  ).json();
  const years = new Set(held.features.map((f) => String(f.attributes.Year)));
  for (const year of YEARS) {
    assert.ok(years.has(year), `the service has no ${year}`);
    const [row] = await duckdb(STACK_URL, sql.replace('$anio', year));
    assert.equal(JSON.parse(row.mosaic_rule).where, `Year=${year}`);
  }
});

test('the service draws an image for the chosen year', async () => {
  const [{ esri_url: url, mosaic_rule: rule }] = await duckdb(STACK_URL, sql.replace('$anio', YEARS.at(-1)));
  const res = await fetch(`${url}/exportImage?bbox=-80,-3,-78,-1&bboxSR=4326&size=256,256&format=png&mosaicRule=${encodeURIComponent(rule)}&f=image`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/png/);
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
});
