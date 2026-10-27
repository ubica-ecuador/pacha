// The starlink-constellation dashboard: CelesTrak's orbital elements through
// the gateway, read by the server DuckDB into a Chaski dataset; the browser
// moves every satellite along its orbit over the last 96 minutes and the
// globe, the Mosaic views and the sky over a point answer from there.
// The positions are checked here by running the browser's SQL on the server
// DuckDB, the same dialect, with the datasets as CTEs and the filters off.
// It needs Kepler Plus (compose.plus.yaml): without it, the browser test is
// skipped. STARLINK_UID points the browser test at a preview copy.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { datasetSql, findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard, parseStatNumber } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/starlink-constellation.json');
const uid = process.env.STARLINK_UID || 'starlink-constellation';
const panelSql = (title) =>
  findAll(dashboard, (n) => n.kind === 'Panel' && n.spec.title === title)[0].spec.data.spec.queries[0].spec.query.spec.rawSql;
// The SQL of a dataset, whether the browser or another datasource fills it.
const sourceSql = (name) =>
  findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query?.rawSql ?? datasetSql(dashboard, name);
const noComments = (sql) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

// The browser's SQL on the server: the datasets as CTEs, Cuenca as the point,
// no window, every filter open.
const elements = noComments(sourceSql('elements'));
const track = noComments(datasetSql(dashboard, 'track')).replaceAll('$elements', 'elements');
function onServer(sql) {
  const body = noComments(sql)
    .replace(/\$__crossfilter\(\$starFilters[^)]*\)/g, 'TRUE')
    .replaceAll('$elements', 'elements').replaceAll('$track', 'track')
    .replaceAll('$lat', "'-2.9'").replaceAll('$lon', "'-79.0'")
    .replaceAll('$starFrom', "''").replaceAll('$starTo', "''")
    .trim();
  const head = `WITH elements AS (${elements}), track AS (${track})`;
  return body.startsWith('WITH') ? `${head}, ${body.slice(4)}` : `${head} ${body}`;
}

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${uid}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'starlink-constellation');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['business-charts', 'chaski', 'duckdb', 'kepler', 'mosaic', 'plus', 'space']);
});

test('reads the elements through the gateway only', () => {
  assert.match(JSON.stringify(dashboard), /http:\/\/feeds\/celestrak\/starlink\.csv/);
  assert.doesNotMatch(sourceSql('elements'), /celestrak\.org/);
});

test('every satellite, every two minutes of the last orbit, each where its orbit allows', async () => {
  const [r] = await duckdb(STACK_URL, `WITH elements AS (${elements}), track AS (${track})
    SELECT count(DISTINCT norad) AS sats, count(DISTINCT time) AS steps,
           count(*) FILTER (WHERE abs(latitude) > 98 OR longitude NOT BETWEEN -180 AND 180) AS impossible,
           count(*) FILTER (WHERE altitude NOT BETWEEN 150000 AND 2000000) AS heights,
           count(DISTINCT shell) AS shells,
           date_diff('minute', max(time), now()::TIMESTAMP) AS minutes,
           count(*) FILTER (WHERE heading NOT BETWEEN 0 AND 360 OR speed_kmh NOT BETWEEN 20000 AND 30000) AS motion
    FROM track`);
  assert.ok(r.sats > 5000, `only ${r.sats} satellites`);
  assert.equal(Number(r.steps), 49);
  assert.equal(Number(r.impossible), 0);
  assert.equal(Number(r.heights), 0);
  assert.equal(Number(r.shells), 4);
  assert.ok(Math.abs(r.minutes) < 3, `the orbit ends ${r.minutes} min before now`);
  assert.equal(Number(r.motion), 0, 'ground tracks with an impossible heading or speed');
});

test('a few dozen satellites are 25° above the default point', async () => {
  const [r] = await duckdb(STACK_URL, onServer(panelSql('Overhead the point')));
  assert.ok(r.Overhead > 10 && r.Overhead < 200, `${r.Overhead} overhead`);
  const sky = await duckdb(STACK_URL, onServer(panelSql('The sky over the chosen point')));
  assert.ok(sky.length > 100, `${sky.length} points in the sky`);
  assert.ok(sky.every((p) => p.el >= 10 && p.el <= 90 && p.az >= 0 && p.az < 360));
});

test('CelesTrak is served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', 'http://feeds/celestrak/starlink.csv']);
  headers();
  assert.match(headers(), /X-Cache-Status: (HIT|STALE|UPDATING)/i);
});

test('is provisioned in Plus', { skip: skip || (uid !== 'starlink-constellation' && 'a preview copy') }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor, with no panel or Mosaic view in error', { skip }, async () => {
  view = await openDashboard(`/d/${uid}`, { datasets: ['elements', 'track'], timeoutMs: 180_000 });
  assert.equal(await view.panelErrors(), 0);
  assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
  // Read in place: the card is in the first screen, and headless Chromium,
  // busy drawing the globe in software, times out scrolling to it.
  const card = view.page.locator('[data-testid="data-testid Panel header Overhead the point"]')
    .locator('xpath=ancestor::*[@data-viz-panel-key][1]');
  const text = await card.innerText({ timeout: 120_000 });
  assert.ok(parseStatNumber(text.replace('Overhead the point', '')) > 0, text);
});
