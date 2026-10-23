// The ancestry-esda dashboard: the spatial weights datasets/ancestry/build.sh
// adds to the ancestry files, the server datasets as Grafana runs them for the
// state and group the dashboard opens on (Illinois, Polish), and the page: no
// panel in error, and the global Moran's I the browser computes is PySAL's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('dashboards/gallery/ancestry-esda.json');
const FILES = 'http://feeds/datasets/ancestry/';
const DATASETS = ['shapes', 'tractvals', 'links', 'lisa', 'clusters'];
const VARS = { state: 'IL', grupo: 'Polish', weights: 'queen' };
// What the DuckDB datasource does to a panel's or a dataset's `$var`: quote it.
const fill = (sql) => sql.replace(/\$(state|grupo|weights)\b/g, (_, name) => `'${VARS[name]}'`);
const serverSql = (name) => {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name);
  return fill(query.source.query.rawSql);
};

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'ancestry-esda');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'business-charts', 'demographics']);
  const text = JSON.stringify(dashboard);
  for (const url of text.match(/read_parquet\('[^']+'\)/g)) assert.ok(url.includes(FILES), url);
  // p-values the same on every visit: permutations come from hash(), not random().
  const [lisa] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'lisa');
  const code = lisa.source.sql.replace(/--.*$/gm, '');
  assert.match(code, /hash\(/);
  assert.doesNotMatch(code, /random\(/);
  // Both maps frame the new state's tracts when the state changes, and nothing else moves them.
  const maps = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplergl-panel');
  assert.equal(maps.length, 2);
  for (const map of maps) assert.deepEqual(map.vizConfig.spec.options.fitOnVariables, ['state'], map.title);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/ancestry-esda');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the weights cover every tract of 100 residents or more, six nearest each, queen both ways', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `WITH w AS (SELECT * FROM read_parquet('${FILES}weights.parquet'))
     SELECT (SELECT count(DISTINCT i) FROM w WHERE kind = 'knn6') AS tracts,
            (SELECT count(*) FROM read_parquet('${FILES}tracts.parquet') WHERE total_pop >= 100) AS populated,
            (SELECT count(*) FROM (SELECT i FROM w WHERE kind = 'knn6' GROUP BY i HAVING count(*) <> 6)) AS not_six,
            (SELECT count(*) FROM w a WHERE kind = 'queen'
               AND NOT EXISTS (SELECT 1 FROM w b WHERE b.kind = 'queen' AND b.i = a.j AND b.j = a.i)) AS one_way,
            (SELECT count(*) FROM w WHERE kind = 'queen') AS queen_links`,
  );
  assert.equal(row.tracts, row.populated);
  assert.equal(row.not_six, 0);
  assert.equal(row.one_way, 0);
  // about six neighbours per tract, as for any planar partition
  assert.ok(row.queen_links / row.tracts > 5.5 && row.queen_links / row.tracts < 6.5, JSON.stringify(row));
});

test('the server datasets answer for Illinois: 3,258 tracts, the Polish share about 6 %', async () => {
  const shapes = await duckdb(STACK_URL, serverSql('shapes'));
  const vals = await duckdb(STACK_URL, serverSql('tractvals'));
  const links = await duckdb(STACK_URL, serverSql('links'));
  assert.equal(shapes.length, 3258);
  assert.equal(vals.length, 3258);
  assert.ok(shapes.every((s) => s.geojson.startsWith('{"type":')), 'a shape without GeoJSON');
  assert.ok(vals.every((v) => v.share >= 0 && v.share <= 100), 'a share outside 0-100 %');
  assert.ok(links.length > 18_000 && links.length < 22_000, `${links.length} queen links`);
  const pop = new Map(shapes.map((s) => [s.geoid, s.total_pop]));
  const people = vals.reduce((sum, v) => sum + v.people, 0);
  const residents = vals.reduce((sum, v) => sum + pop.get(v.geoid), 0);
  assert.ok(people / residents > 0.05 && people / residents < 0.08, `${people} of ${residents}`);
});

test("opens with no panel in error, and Moran's I is PySAL's", { timeout: 300_000 }, async () => {
  const view = await openDashboard('/d/ancestry-esda', { datasets: DATASETS, timeoutMs: 120_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    // esda.Moran on the same shares and queen weights: 0.70092180
    assert.equal(await view.statNumber("Global Moran's I"), 0.701);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
