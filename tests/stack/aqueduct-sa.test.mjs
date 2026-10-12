// The aqueduct-sa dashboard: WRI Aqueduct 4.0 water risk over South America,
// read live by Infinity from a public ArcGIS Feature Service, with DuckDB
// turning the polygon drawn on the map into Esri rings. Every query is run as a
// visitor runs it, with the dashboard's variables filled in as Grafana fills
// them; the service is public, so these tests need the internet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'aqueduct-sa';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const COUNTRIES = variable('pais').options.map((o) => o.value).filter((v) => v !== '$__all');

// Grafana's interpolation for the formats this dashboard uses.
const fill = (spec, vars) =>
  JSON.parse(
    JSON.stringify(spec).replace(/\$\{(\w+)(?::(\w+))?\}|\$(\w+)/g, (match, braced, format, bare) => {
      const value = vars[braced ?? bare];
      if (value === undefined) return match;
      const text = format === 'sqlstring' ? [value].flat().map((v) => `'${v.replaceAll("'", "''")}'`).join(',') : [value].flat().join(',');
      return JSON.stringify(text).slice(1, -1); // spliced into JSON text
    }),
  );

async function infinity(title, refId, vars) {
  const query = panelTitled(dashboard, title).data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec;
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    anonymous: true,
    body: { from: 'now-6h', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'infinity', type: 'yesoreyeram-infinity-datasource' }, ...fill(query, vars) }] },
  });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  return rowsOf(res.json);
}

const DEFAULTS = { indicador: 'bws', pais: COUNTRIES, detalle: '0.02', areaRings: '' };
const MAP = '$indicador — basins of South America';

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['infinity', 'duckdb', 'kepler', 'water', 'business-charts']);
  const uids = new Set(JSON.stringify(dashboard).match(/"datasource":\{"name":"[^"]+"/g).map((s) => s.split('"').at(-2)));
  for (const uid of uids) assert.ok(['infinity', 'duckdb', '-- Grafana --'].includes(uid), uid);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map pages through every basin unit the service counts', { timeout: 120_000 }, async () => {
  const [{ Unidades: total }] = await infinity('Units', 'D', DEFAULTS);
  const rows = await infinity(MAP, 'A', DEFAULTS);
  assert.ok(total > 6000 && total < 6750, `service counts ${total}`);
  assert.equal(rows.length, total);
  // A page served twice would repeat its first row at the next page's offset.
  assert.notDeepEqual(rows[0], rows[750], 'the second page repeats the first');
  assert.ok(rows.every((r) => r.score >= 0 && r.score <= 5 && JSON.parse(r.geojson).type.endsWith('Polygon')));
});

test('the country ranking and the worst-20 table answer for every indicator', { timeout: 120_000 }, async () => {
  for (const indicador of variable('indicador').options.map((o) => o.value)) {
    const vars = { ...DEFAULTS, indicador };
    const countries = await infinity('Mean score by country', 'B', vars);
    assert.ok(countries.length >= 10 && countries.every((r) => r.mean >= 0 && r.mean <= 5 && COUNTRIES.includes(r.country)), indicador);
    const worst = await infinity('The 20 units with the worst $indicador', 'C', vars);
    assert.equal(worst.length, 20, indicador);
    assert.ok(worst.every((r, i) => i === 0 || worst[i - 1].Score >= r.Score), `${indicador} not sorted`);
  }
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
});
