// The europe-power-flows dashboard (Plus): the physical flows across Europe's
// borders from Energy-Charts, read on the server through the gateway for eight
// countries, held by Chaski, drawn as a directed graph that Graphviz lays out
// in the browser and as arcs on the Kepler Plus traffic layer. Live data, so
// the checks are about shape and plausible ranges. It needs Kepler Plus
// (compose.plus.yaml): without it, the browser test is skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'europe-power-flows';
const DATASETS = ['countries', 'flows', 'edges'];
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const source = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source;
const flowsSql = source('flows').query.rawSql;
// The browser datasets run on the server: each dataset as a subquery.
const inline = (sql) =>
  ['flows', 'countries'].reduce((s, name) => s.replaceAll(`$${name}`, () => `(${name === 'flows' ? flowsSql : source(name).sql})`), sql);

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  for (const tag of ['chaski', 'duckdb', 'kepler', 'plus', 'business-text', 'business-charts', 'energy', 'live']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  assert.deepEqual(findAll(dashboard, (n) => n.kind === 'dataset' && n.source).map((n) => n.name).sort(), [...DATASETS].sort());
});

test('reads Energy-Charts only through the gateway, and Graphviz from a pinned version', () => {
  for (const [url] of flowsSql.matchAll(/'https?:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/energy-charts\/v2\/cbpf\?/, url);
  const graph = panelTitled(dashboard, 'Who powers whom — laid out by Graphviz in your browser');
  assert.match(graph.vizConfig.spec.options.afterRender, /@viz-js\/viz@\d+\.\d+\.\d+\//);
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  const browserSql = [
    ...findAll(dashboard, (n) => n.group === 'ubica-chaski-datasource' && typeof n.spec?.rawSql === 'string').map((n) => n.spec.rawSql),
    source('countries').sql,
    source('edges').sql,
  ];
  for (const sql of browserSql) {
    for (const line of sql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('the panels filter each other by country and by step', () => {
  const sqlOf = (title) => findAll(panelTitled(dashboard, title), (n) => typeof n.rawSql === 'string').map((n) => n.rawSql).join('\n');
  const code = (title) => panelTitled(dashboard, title).vizConfig.spec.options.getOption;
  // The map, the timeline and the ranking follow the country picked; the map and the ranking the step.
  assert.match(sqlOf('The same flows on the map'), /\$country[\s\S]*\$step|\$step[\s\S]*\$country/);
  assert.match(sqlOf('Two days across the borders — click a moment'), /\$country/);
  assert.match(sqlOf('Who sends, who takes — click a country'), /\$step/);
  // The graph redraws on either; the charts write them.
  assert.match(sqlOf('Who powers whom — laid out by Graphviz in your browser'), /\$step AS step, \$country AS country/);
  assert.match(code('Two days across the borders — click a moment'), /'var-' \+ STEP/);
  assert.match(code('Who sends, who takes — click a country'), /'var-' \+ VAR/);
  const names = findAll(dashboard, (n) => n.kind === 'TextVariable').map((n) => n.spec.name).sort();
  assert.deepEqual(names, ['country', 'step']);
});

test('every border reported names a known country, and the flows are in GW', async () => {
  const [r] = await duckdb(STACK_URL, inline(`SELECT
      count(DISTINCT reporter) AS reporters,
      count(*) FILTER (WHERE neighbour <> 'sum' AND neighbour NOT IN (SELECT id FROM $countries)) AS unknown,
      max(abs(gw)) AS top
    FROM $flows`));
  // Energy-Charts allows four requests at once: at least four of the eight answer.
  assert.ok(r.reporters >= 4, `${r.reporters} countries answered`);
  assert.equal(Number(r.unknown), 0, 'a neighbour with no row in countries');
  // The largest single border carries a few GW, never hundreds.
  assert.ok(r.top > 0.5 && r.top < 20, `largest flow ${r.top} GW`);
});

test('the edges are one per border and step, over complete steps only', async () => {
  const rows = await duckdb(STACK_URL, inline(`WITH e AS (${source('edges').sql})
    SELECT count(*) AS n, count(DISTINCT time) AS steps, count(*) FILTER (WHERE a >= b) AS unordered,
           max(time) AS latest, count(DISTINCT a || b) AS borders FROM e`));
  const [r] = rows;
  assert.ok(r.steps >= 24, `${r.steps} complete steps`);
  assert.ok(r.borders >= 25, `${r.borders} borders`);
  assert.equal(Number(r.unordered), 0, 'a border not in alphabetical order');
  const hours = (Date.now() - Number(r.latest)) / 3_600_000;
  assert.ok(hours < 12, `latest complete step ${hours.toFixed(1)} h ago`);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('the map draws the borders as arcs on a traffic layer, with the country picked ringed', () => {
  const map = panelTitled(dashboard, 'The same flows on the map');
  assert.equal(map.vizConfig.group, 'ubica-keplerplus-panel');
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => [l.type, l.config.dataId]).sort(), [['point', 'grafana-B'], ['traffic', 'grafana-A']]);
});

test('loads for an anonymous visitor, with the graph drawn and no panel in error', { skip, timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}?refresh=`, { datasets: DATASETS, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
  await view.page.waitForSelector('.grid-svg', { timeout: 60_000 });
  const drawn = await view.page.evaluate(() => ({
    countries: document.querySelectorAll('.grid-svg g.node').length,
    borders: document.querySelectorAll('.grid-svg g.edge').length,
  }));
  assert.ok(drawn.countries >= 15 && drawn.borders >= 15, JSON.stringify(drawn));
});
