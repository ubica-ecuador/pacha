// The mbta-subway-diagram dashboard: the MBTA subway as a line diagram that
// Graphviz lays out in the browser, beside a Kepler Plus fleet map, both fed
// by Chaski datasets that the server fills from the MBTA's GTFS Realtime feeds
// and its LAMP schedule archive, through the gateway. Live data, so the checks
// are about shape and plausible ranges. It needs Kepler Plus
// (compose.plus.yaml): without it, the browser test is skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'mbta-subway-diagram';
const DATASETS = ['network', 'tracks', 'trains', 'arrivals'];
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const serverSql = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;
const diagram = panelTitled(dashboard, 'Line diagram — laid out by Graphviz in your browser');
const placedSql = diagram.data.spec.queries.find((q) => q.spec.refId === 'T').spec.query.spec.rawSql;
// A browser query run on the server: each dataset as a subquery, the variables empty.
const inline = (sql) =>
  DATASETS.reduce((s, name) => s.replaceAll(`$${name}`, () => `(${serverSql(name)})`), sql).replace(/\$(train|station)\b/g, "''");
const inBoston = (r) => r.latitude > 42.2 && r.latitude < 42.45 && r.longitude > -71.27 && r.longitude < -70.98;
const LINES = ['Red', 'Orange', 'Blue', 'Green', 'Mattapan'];

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  for (const tag of ['chaski', 'duckdb', 'plus', 'kepler', 'business-text', 'transit', 'live']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  assert.deepEqual(findAll(dashboard, (n) => n.kind === 'dataset' && n.source).map((n) => n.name).sort(), [...DATASETS].sort());
});

test('reads the MBTA only through the gateway, and Graphviz from a pinned version', () => {
  for (const name of DATASETS) {
    for (const [url] of serverSql(name).matchAll(/'https?:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/mbta\/(realtime|lamp)\//, url);
  }
  assert.match(diagram.vizConfig.spec.options.afterRender, /@viz-js\/viz@\d+\.\d+\.\d+\//);
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  const browserSql = findAll(dashboard, (n) => n.group === 'ubica-chaski-datasource' && typeof n.spec?.rawSql === 'string');
  assert.ok(browserSql.length >= 8);
  for (const { spec } of browserSql) {
    for (const line of spec.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('the network is the nine canonical patterns, stations in order around Boston', async () => {
  const rows = await duckdb(STACK_URL, serverSql('network'));
  const patterns = Object.groupBy(rows, (r) => r.pattern);
  assert.equal(Object.keys(patterns).length, 9, Object.keys(patterns).join(' '));
  for (const [pattern, stops] of Object.entries(patterns)) {
    assert.deepEqual(stops.map((r) => r.seq).sort((a, b) => a - b), stops.map((_, i) => i + 1), pattern);
    assert.ok(stops.length >= 8, `${pattern}: ${stops.length} stations`);
  }
  const stations = new Set(rows.map((r) => r.station));
  assert.ok(stations.size > 115 && stations.size < 140, `${stations.size} stations`);
  assert.ok(rows.every(inBoston) && rows.every((r) => LINES.includes(r.line)));
  // Both Red Line branches leave Alewife.
  assert.equal(rows.filter((r) => r.line === 'Red' && r.seq === 1 && r.name === 'Alewife').length, 2);
});

test('each pattern has its track, as long as the line is', async () => {
  const rows = await duckdb(STACK_URL, `WITH t AS (${serverSql('tracks')})
    SELECT pattern, line, ST_Length_Spheroid(ST_FlipCoordinates(ST_GeomFromGeoJSON(geojson))) / 1000 AS km FROM t`);
  assert.equal(rows.length, 9);
  // The Orange Line is about 11 miles long.
  const orange = rows.find((r) => r.line === 'Orange');
  assert.ok(orange.km > 16 && orange.km < 19.5, `Orange ${orange.km} km`);
});

test('every train is around Boston, and placed on a hop of the network', async () => {
  const [trains, placed, network] = await Promise.all([
    duckdb(STACK_URL, serverSql('trains')),
    duckdb(STACK_URL, inline(placedSql)),
    duckdb(STACK_URL, serverSql('network')),
  ]);
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));
  // Service runs from about 5 am to 1 am.
  if (hour >= 7 && hour <= 22) assert.ok(trains.length >= 40, `only ${trains.length} trains`);
  assert.ok(trains.every(inBoston), 'a train outside Boston');
  assert.ok(trains.every((t) => LINES.includes(t.line)));
  const stations = new Set(network.map((r) => r.station));
  for (const t of placed) {
    assert.ok(stations.has(t.from_station) && stations.has(t.to_station), JSON.stringify(t));
    assert.ok(t.progress >= 0 && t.progress <= 1, JSON.stringify(t));
  }
  assert.ok(placed.length >= trains.length * 0.9, `${placed.length} of ${trains.length} trains placed`);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor, with the network drawn and no panel in error', { skip, timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}?refresh=`, { datasets: DATASETS, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
  await view.page.waitForSelector('.subway-svg', { timeout: 60_000 });
  const drawn = await view.page.evaluate(() => ({
    stations: document.querySelectorAll('.subway-svg [data-station]').length,
    hops: document.querySelectorAll('.subway-svg g.edge').length,
    trains: document.querySelectorAll('.subway-svg .train').length,
  }));
  assert.ok(drawn.stations > 115 && drawn.hops > 115, JSON.stringify(drawn));
  const [{ n }] = await view.chaski('SELECT count(*) AS n FROM datasets.trains WHERE station IS NOT NULL');
  assert.ok(drawn.trains >= Number(n) * 0.9, `${drawn.trains} trains drawn of ${n}`);
});
