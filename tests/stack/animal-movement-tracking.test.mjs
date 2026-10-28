// The animal-movement-tracking dashboard: three open datasets of animal tracks,
// each read by DuckDB on the server through the gateway's month-long cache and
// handed to the browser as a Chaski dataset, where each tab turns its tracks
// into steps (speed, turning angle, distance from home) for one Mosaic
// selection. The datasets' SQL runs here as Grafana runs it, with the
// dashboard's variables filled in, and so do the steps' SQL over them. The maps need
// Kepler Plus (compose.plus.yaml): on a stack without it the dashboard is not
// provisioned and the browser tests are skipped; the data and gateway tests
// run either way.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/animal-movement-tracking.json');
const DATASETS = ['gulls', 'jaguars', 'ocean_species', 'ocean'];
const STEPS = { gullSteps: 'gulls', jagSteps: 'jaguars', oceanSteps: 'ocean' };

const datasetSql = (name) => {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name);
  return query.source.query.rawSql;
};
// A browser dataset built from a server one, run here over the server one's SQL.
const stepsSql = (name) => {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name);
  return query.source.sql.replaceAll(`$${STEPS[name]}`, `(${fill(datasetSql(STEPS[name]))})`);
};
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const fill = (sql, { year = '2023', species = ['Northern Elephant Seal', 'White Shark'] } = {}) =>
  sql.replaceAll('${year:raw}', year).replaceAll('${species:sqlstring}', species.map(quote).join(','));

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'animal-movement-tracking');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'plus', 'mosaic', 'mobility', 'migration', 'wildlife']);
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

test('every variable a Mosaic panel or a filter writes or reads is declared, and each tab has its selection', () => {
  const names = new Set(dashboard.spec.variables.map((v) => v.spec.name));
  const filters = findAll(dashboard, (n) => n.kind === 'filters');
  assert.deepEqual(filters.map((f) => f.refId).sort(), ['gullFilters', 'jagFilters', 'oceanFilters']);
  for (const f of filters) {
    for (const x of f.filters) {
      for (const ref of [x.from, x.to, x.variable].filter(Boolean)) assert.ok(names.has(ref.slice(1)), `${f.refId}: ${ref}`);
    }
  }
  const mosaics = findAll(dashboard, (n) => n.kind === 'Panel' && n.spec.vizConfig.group === 'ubica-chaski-mosaic-panel');
  for (const p of mosaics) {
    const written = [...p.spec.vizConfig.spec.options.variables.matchAll(/^\s+(?:from|to): (.+)$/gm)]
      .flatMap((m) => m[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()));
    for (const w of written) assert.ok(names.has(w), `${p.spec.title}: ${w}`);
    assert.match(p.spec.vizConfig.spec.options.spec, /(gull|jag|ocean)Filters: \{ select: crossfilter \}/, p.spec.title);
  }
});

test('each tab\'s Fleet layer hides the animals with no position in the time window', () => {
  const fleets = findAll(dashboard, (n) => n.type === 'fleet' && n.config?.visConfig);
  assert.equal(fleets.length, 3);
  for (const f of fleets) assert.equal(f.config.visConfig.fleetSilent, 'hide', f.config.label);
});

test('the steps: speeds, turns, hours and distances from home within their ranges', async () => {
  for (const name of Object.keys(STEPS)) {
    const [row] = await duckdb(
      STACK_URL,
      `SELECT count(*)::INTEGER AS n, count(turn_deg)::INTEGER AS turns,
              min(turn_deg) AS turn0, max(turn_deg) AS turn1,
              count(*) FILTER (WHERE turn_deg IS NULL)::INTEGER AS straight
       FROM (${stepsSql(name)})`,
    );
    assert.ok(row.turns > row.n / 5, `${name}: ${row.turns} turns of ${row.n}`);
    assert.ok(row.turn0 >= -180 && row.turn1 <= 180, `${name}: ${row.turn0}..${row.turn1}`);
  }
  const [gulls] = await duckdb(
    STACK_URL,
    `SELECT median(speed_kmh) AS speed, max(speed_kmh) AS fastest, min(sun_hour) AS h0, max(sun_hour) AS h1
     FROM (${stepsSql('gullSteps')})`,
  );
  assert.ok(gulls.speed < 2 && gulls.fastest > 30 && gulls.fastest < 120, JSON.stringify(gulls));
  assert.ok(gulls.h0 >= 0 && gulls.h1 < 24, JSON.stringify(gulls));
  const [jaguars] = await duckdb(STACK_URL, `SELECT median(home_km) AS home, max(hour) AS h1 FROM (${stepsSql('jagSteps')})`);
  assert.ok(jaguars.home > 1 && jaguars.home < 10, `median ${jaguars.home} km from the range centre`);
  assert.ok(jaguars.h1 < 24);
  const [ocean] = await duckdb(
    STACK_URL,
    `SELECT median(km_day) AS kmday, max(from_tag_km) AS far, min(day)::INTEGER AS d0 FROM (${stepsSql('oceanSteps')})`,
  );
  assert.ok(ocean.kmday > 10 && ocean.kmday < 100, `${ocean.kmday} km a day`);
  assert.ok(ocean.far > 3000 && ocean.far < 20000, `${ocean.far} km from tagging`);
  assert.equal(ocean.d0, 0);
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

const provisioned = await api(STACK_URL, '/api/dashboards/uid/animal-movement-tracking', { anonymous: true });
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor within 45 s, every tab with no panel in error', { skip }, async () => {
  view = await openDashboard('/d/animal-movement-tracking', { datasets: [...DATASETS, ...Object.keys(STEPS)] });
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  for (const tab of ['Gulls', 'Jaguars', 'Ocean predators']) {
    await view.page.getByRole('tab', { name: tab }).click();
    await view.page.waitForTimeout(3000);
    assert.equal(await view.panelErrors(), 0, tab);
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0, `${tab}: a Mosaic panel in error`);
  }
});
