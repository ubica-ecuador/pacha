// The animal-movement-tracking dashboard: three open datasets of animal tracks,
// each read by DuckDB on the server through the gateway's month-long cache and
// handed to the browser as a Chaski dataset. The datasets' SQL runs here as
// Grafana runs it, with the dashboard's variables filled in.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('dashboards/gallery/animal-movement-tracking.json');
const DATASETS = ['gulls', 'jaguars', 'ocean_species', 'ocean'];

const datasetSql = (name) => {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name);
  return query.source.query.rawSql;
};
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const fill = (sql, { year = '2023', species = ['Northern Elephant Seal', 'White Shark'] } = {}) =>
  sql.replaceAll('${year:raw}', year).replaceAll('${species:sqlstring}', species.map(quote).join(','));

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'animal-movement-tracking');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'business-charts', 'migration', 'wildlife']);
});

test('every dataset reads its data through the gateway, and nothing else does', () => {
  for (const name of DATASETS) {
    const urls = datasetSql(name).match(/(?:https?:)?\/\/[^'\s)]+/g) ?? [];
    assert.ok(urls.length > 0, `${name} reads nothing`);
    for (const url of urls) assert.match(url, /^(?:http:)?\/\/(?:feeds\/|vsicurl\/http:\/\/feeds\/)/, `${name}: ${url}`);
  }
  const panels = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) => p.spec.data.spec.queries);
  for (const q of panels) assert.equal(q.spec.query.datasource.name, 'duckdbwasm');
});

test('the gulls: every bird of the year, between Mauritania and Belgium', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(DISTINCT bird)::INTEGER AS birds, min(latitude) AS south, max(latitude) AS north,
            max(colony_km) AS far, count(*) FILTER (WHERE fixes < 1)::INTEGER AS empty
     FROM (${fill(datasetSql('gulls'))})`,
  );
  assert.equal(row.birds, 33);
  assert.ok(row.south > 15 && row.south < 30, `southernmost ${row.south}`);
  assert.ok(row.north > 50 && row.north < 60, `northernmost ${row.north}`);
  assert.ok(row.far > 2000, `farthest ${row.far} km`);
  assert.equal(row.empty, 0);
});

test('the jaguars: 117 of them, in the Americas, 1999 to 2016', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(DISTINCT jaguar)::INTEGER AS jaguars, sum(fixes)::INTEGER AS fixes,
            min(year(time))::INTEGER AS y0, max(year(time))::INTEGER AS y1,
            min(latitude) AS south, max(latitude) AS north, max(longitude) AS east
     FROM (${datasetSql('jaguars')})`,
  );
  assert.equal(row.jaguars, 117);
  assert.equal(row.fixes, 134690);
  assert.deepEqual([row.y0, row.y1], [1999, 2016]);
  assert.ok(row.south > -35 && row.north < 35 && row.east < -30, JSON.stringify(row));
});

test('the ocean: 30 species to pick from, and the picked ones only', async () => {
  const species = await duckdb(STACK_URL, datasetSql('ocean_species'));
  assert.equal(species.length, 30);
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(DISTINCT species)::INTEGER AS species, count(DISTINCT tag)::INTEGER AS tags,
            count(*) FILTER (WHERE longitude > 100 OR longitude < -260)::INTEGER AS outside
     FROM (${fill(datasetSql('ocean'))})`,
  );
  assert.equal(row.species, 2);
  const picked = species.filter((s) => ['Northern Elephant Seal', 'White Shark'].includes(s.species));
  assert.equal(row.tags, picked.reduce((n, s) => n + Number(s.tags), 0));
  assert.equal(row.outside, 0);
});

test('the gateway keeps the tracks: a second read is served from the cache', () => {
  for (const path of ['/atn/topp.csv', '/zenodo/records/5001568/files/DataS1.zip']) {
    const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${path}`]);
    headers();
    assert.match(headers(), /X-Cache-Status: HIT/i, path);
  }
});

let view;
after(async () => view && view.browser.close());

test('loads for an anonymous visitor within 45 s, every tab with no panel in error', async () => {
  const provisioned = await api(STACK_URL, '/api/dashboards/uid/animal-movement-tracking', { anonymous: true });
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'gallery');
  view = await openDashboard('/d/animal-movement-tracking', { datasets: DATASETS });
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  for (const tab of ['Gulls', 'Jaguars', 'Ocean predators']) {
    await view.page.getByRole('tab', { name: tab }).click();
    await view.page.waitForTimeout(3000);
    assert.equal(await view.panelErrors(), 0, tab);
  }
});
