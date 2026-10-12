// The enso-ecuador dashboard: El Niño in Ecuador's sea, rain and rivers. Most
// of it reads Parquet files from the elnino service (enso-ecuador-service),
// which the gateway serves at http://feeds/elnino; the waves tab reads
// WAVEWATCH III from ERDDAP through the gateway's cache.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, panelTitled, findAll } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'enso-ecuador';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const SVC = dashboard.spec.variables.find((v) => v.spec.name === 'svc').spec.query;
const sqlOf = (title, refId = 'A') =>
  panelTitled(dashboard, title).data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql.replaceAll('$svc', `'${SVC}'`);

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'weather', 'maritime']);
  assert.equal(SVC, 'http://feeds/elnino');
  // No INSTALL: the server's extensions are preloaded and its local disk is off.
  assert.equal(findAll(dashboard, (n) => typeof n.rawSql === 'string' && /INSTALL/.test(n.rawSql)).length, 0);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the sea off Ecuador has its monthly and weekly indices, up to recent weeks', async () => {
  const rows = await duckdb(STACK_URL, sqlOf('Qué tan caliente está el mar'));
  assert.ok(rows.length > 2000, `${rows.length} rows`);
  const weekly = rows.filter((r) => r['Frente a Ecuador (semana a semana)'] !== null);
  assert.ok(Date.now() - weekly.at(-1).time < 30 * 86400_000, 'the weekly index is recent');
  assert.ok(rows.every((r) => [r['Frente a Ecuador (mes a mes)'], r['Pacífico central (mes a mes)']].every((v) => v === null || Math.abs(v) < 8)));
});

test('the country map gets eleven regions and the transmitting stations of INAMHI', async () => {
  const regions = await duckdb(STACK_URL, sqlOf('Cómo está el país ahora mismo', 'A'));
  assert.equal(new Set(regions.map((r) => r.zona_id)).size, 11);
  const stations = await duckdb(STACK_URL, sqlOf('Cómo está el país ahora mismo', 'B'));
  assert.ok(stations.length > 100, `${stations.length} stations`);
  for (const s of stations) assert.ok(s.latitude > -6 && s.latitude < 2 && s.longitude > -92 && s.longitude < -75, JSON.stringify(s));
});

test('the sea level at La Libertad goes back to 1949', async () => {
  const rows = await duckdb(STACK_URL, sqlOf('El nivel del mar en La Libertad, desde 1949'));
  assert.equal(new Date(rows[0].time).getUTCFullYear(), 1949);
  const top = await duckdb(STACK_URL, sqlOf('Los meses con el mar más alto en 77 años'));
  assert.equal(top.length, 12);
  assert.ok(top.some((r) => r.mes.startsWith('1997') || r.mes.startsWith('1983')), JSON.stringify(top));
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
});
