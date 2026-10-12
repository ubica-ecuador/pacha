// The inaturalist-ecuador dashboard: iNaturalist research-grade observations of
// Ecuador and the Galápagos, read live by Infinity from the ArcGIS Living Atlas,
// with DuckDB turning the polygon drawn on the map into Esri rings. Every query
// is run as a visitor runs it, with the dashboard's variables filled in as
// Grafana fills them; the service is public, so these tests need the internet.
// The three charts read a Chaski cube (group x year x month) that one Infinity
// request fills, and write the variables the other panels follow.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'inaturalist-ecuador';
const dashboard = loadDashboard(`dashboards/gallery/${UID}.json`);
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const INFINITY = { uid: 'infinity', type: 'yesoreyeram-infinity-datasource' };

const fill = (spec, vars) =>
  JSON.parse(
    JSON.stringify(spec).replace(/\$\{(\w+)(?::(\w+))?\}|\$(\w+)/g, (match, braced, format, bare) => {
      const value = vars[braced ?? bare];
      if (value === undefined) return match;
      const text = format === 'sqlstring' ? [value].flat().map((v) => `'${v.replaceAll("'", "''")}'`).join(',') : [value].flat().join(',');
      return JSON.stringify(text).slice(1, -1); // spliced into JSON text
    }),
  );

async function infinity(query, vars) {
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    anonymous: true,
    body: { from: 'now-6h', to: 'now', queries: [{ ...fill(query, vars), refId: 'A', datasource: INFINITY }] },
  });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  return rowsOf(res.json);
}
const panelQuery = (title, refId) => panelTitled(dashboard, title).data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec;

// The taxonomic groups, as the "Taxonomic group" variable gets them on load.
const TAXA = (await infinity(variable('taxon').query.spec.infinityQuery, {})).map((r) => r.key);
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const DEFAULTS = { resolucion: '4', capa: 'n_total', muestra: '5000', desdeAnio: '1900', hastaAnio: '9999', taxon: TAXA, mes: MONTHS, areaRings: '' };
const MAP = 'Where things are observed — H3 hexagons and recent observations';

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['infinity', 'duckdb', 'chaski', 'kepler', 'business-charts', 'wildlife']);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the effort counts are those of a well-observed country', { timeout: 120_000 }, async () => {
  assert.ok(TAXA.includes('Aves') && TAXA.includes('Plantae'), TAXA.join(', '));
  const [observations, species, observers] = await Promise.all(['G', 'H', 'I'].map((ref) => infinity(panelQuery('Observation effort', ref), DEFAULTS)));
  assert.ok(observations[0].Observaciones > 700_000, JSON.stringify(observations));
  assert.ok(species[0].Especies > 20_000 && species[0].Especies < observations[0].Observaciones, JSON.stringify(species));
  assert.ok(observers[0].Observadores > 15_000, JSON.stringify(observers));
});

test('the map gets H3 cells at every resolution and a sample of dots inside the extent', { timeout: 120_000 }, async () => {
  for (const resolucion of variable('resolucion').options.map((o) => o.value)) {
    const cells = await infinity(panelQuery(MAP, 'A'), { ...DEFAULTS, resolucion });
    assert.ok(cells.length > 10 && cells.length < 10_000, `${resolucion}: ${cells.length}`);
    assert.ok(cells.every((c) => /^[0-9a-f]{15}$/.test(c.h3) && c.n >= 0), resolucion);
  }
  const dots = await infinity(panelQuery(MAP, 'B'), DEFAULTS);
  assert.equal(dots.length, 5000);
  assert.ok(dots.every((d) => d.latitude >= -5.1 && d.latitude <= 1.7 && d.longitude >= -92 && d.longitude <= -75));
});

// A Chaski panel query with the variables filled as Grafana fills them for Chaski (quoted).
const chaskiSql = (title, refId, vars) =>
  panelQuery(title, refId).rawSql.replace(/\$(\w+)/g, (match, name) =>
    name === 'cubo' ? 'datasets.cubo' : vars[name] === undefined ? match : [vars[name]].flat().map((v) => `'${v}'`).join(','),
  );

test('loads for an anonymous visitor, with no panel in error, and the charts get every group', { timeout: 240_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { datasets: ['cubo'], timeoutMs: 150_000 });
  assert.equal(await view.panelErrors(), 0);
  const groups = await view.chaski(chaskiSql('Taxonomic composition', 'C', DEFAULTS));
  assert.equal(groups.length, TAXA.length);
  assert.equal(groups[0].grupo, 'Aves');
});
