// The f1-race-laps dashboard: Formula 1 sessions from OpenF1, read by DuckDB
// on the server through the gateway's cache and throttle and handed to the
// browser as Chaski datasets. The datasets' SQL runs here as Grafana runs it,
// for one finished race (Baku 2026), with the dashboard's variables filled in.
// The maps need Kepler Plus (compose.plus.yaml): on a stack without it the
// dashboard is not provisioned and the browser test is skipped; the data and
// gateway tests run either way.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('plus/dashboards/f1-race-laps.json');
const DATASETS = ['sessions', 'drivers', 'laps', 'control', 'replay', 'duel'];

const datasetSql = (name) => {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name);
  return query.source.query.rawSql;
};
const VARS = { year: '2026', session: '11377', driver_a: '63', driver_b: '3', lap: '20' };
const fill = (sql, vars) => sql.replace(/\$\{(\w+)(?::raw)?\}/g, (_, name) => vars[name]);
// A dataset's rows summarised by `select`: its SET statements first, then its query as a subquery.
const summarise = (name, select, vars = VARS, tail = '') => {
  const statements = fill(datasetSql(name), vars).split(/;\s*\n/);
  const last = statements.pop();
  return duckdb(STACK_URL, [...statements.map((s) => `${s};`), `SELECT ${select} FROM (${last}) ${tail}`].join('\n'));
};

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'f1-race-laps');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'plus', 'business-charts', 'sport']);
});

test('every dataset reads OpenF1 through the gateway, and nothing else does', () => {
  for (const name of DATASETS) {
    const urls = datasetSql(name).match(/(?:https?:)?\/\/[^'\s)]+/g) ?? [];
    assert.ok(urls.length > 0, `${name} reads nothing`);
    for (const url of urls) assert.match(url, /^http:\/\/feeds\/openf1\/v1\//, `${name}: ${url}`);
  }
  const panels = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) => p.spec.data.spec.queries);
  for (const q of panels) assert.equal(q.spec.query.datasource.name, 'duckdbwasm');
});

let geo;
test('the season: finished races only, each placed on the map', async () => {
  const rows = await duckdb(STACK_URL, fill(datasetSql('sessions'), VARS));
  const baku = rows.find((r) => r.session_key === 11377);
  assert.ok(baku, 'Baku 2026 is offered');
  assert.ok(rows.every((r) => r.date_end < Date.now() - 3 * 3600_000), 'a session still running is offered');
  assert.ok(rows.filter((r) => r.lat0 === null).length === 0, 'a circuit has no place on the map');
  assert.ok(Math.abs(baku.lat0 - 40.37) < 0.05 && Math.abs(baku.lon0 - 49.84) < 0.05, JSON.stringify(baku));
  geo = [baku.lat0, baku.lon0, baku.a, baku.b, baku.e0, baku.n0].join(',');
});

test('the race: 22 drivers, Russell first, about a thousand laps with tyres and positions', async () => {
  const [d] = await summarise('drivers', `count(*)::INTEGER AS n, max(driver) FILTER (WHERE position = 1) AS winner,
    count(best_lap)::INTEGER AS timed`);
  assert.deepEqual(d, { n: 22, winner: 'RUS', timed: 22 });
  const [l] = await summarise('laps', `count(*)::INTEGER AS n, max(lap_number)::INTEGER AS last,
    count(*) FILTER (WHERE compound IN ('SOFT', 'MEDIUM', 'HARD'))::INTEGER AS tyred,
    count(position)::INTEGER AS placed, count(*) FILTER (WHERE pit_in)::INTEGER AS stops`);
  assert.equal(l.last, 51);
  assert.ok(l.n > 950 && l.tyred > 0.95 * l.n && l.placed > 0.95 * l.n, JSON.stringify(l));
  assert.equal(l.stops, 36);
  const [c] = await summarise('control', `count(*) FILTER (WHERE category = 'SafetyCar' AND message ILIKE '%DEPLOYED%')::INTEGER AS sc,
    count(*) FILTER (WHERE kind = 'weather')::INTEGER AS weather`);
  assert.equal(c.sc, 2);
  assert.ok(c.weather > 60, JSON.stringify(c));
});

test('the replay: every car through lap 20, on the streets of Baku', async () => {
  const [r] = await summarise('replay', `count(DISTINCT car)::INTEGER AS cars, count(*)::INTEGER AS n,
    count(speed_kmh)::INTEGER AS timed, min(latitude) AS s, max(latitude) AS n_, min(longitude) AS w, max(longitude) AS e`,
  { ...VARS, geo });
  assert.equal(r.cars, 22);
  assert.ok(r.n > 5000 && r.timed > 0.95 * r.n, JSON.stringify(r));
  // The circuit's box, with a margin for the pit lane: about 2 by 1.5 km.
  assert.ok(r.s > 40.355 && r.n_ < 40.38 && r.w > 49.82 && r.e < 49.86, JSON.stringify(r));
});

test('the duel: both fastest laps, the same length, about 6 km', async () => {
  const rows = await summarise('duel', `slot, any_value(lap)::INTEGER AS lap, round(max(distance_m)) AS m,
    count(latitude)::INTEGER AS placed, count(*)::INTEGER AS n`, { ...VARS, geo }, 'GROUP BY slot');
  rows.sort((x, y) => x.slot.localeCompare(y.slot));
  assert.deepEqual(rows.map((r) => [r.slot, r.lap]), [['A', 49], ['B', 48]]);
  for (const r of rows) {
    assert.ok(r.m > 5800 && r.m < 6100, JSON.stringify(r));
    assert.ok(r.placed > 0.95 * r.n, JSON.stringify(r));
  }
  assert.equal(rows[0].m, rows[1].m);
});

test('the gateway keeps OpenF1 answers, and hands "no results" on as an empty list', () => {
  const get = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-D', '-', `http://feeds${path}`]);
  get('/openf1/v1/drivers?session_key=11377');
  assert.match(get('/openf1/v1/drivers?session_key=11377'), /X-Cache-Status: HIT/i);
  const none = get('/openf1/v1/location?session_key=11377&driver_number=63&date>=2020-01-01T00:00:00&date<2020-01-01T00:00:01');
  assert.match(none, /^HTTP\/1\.1 200/);
  assert.match(none, /\r?\n\r?\n\[\]$/);
  assert.match(compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://feeds/openf1/v1/meetings']), /^404$/);
});

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/f1-race-laps', { anonymous: true });
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads Baku for an anonymous visitor within 60 s, both tabs with no panel in error', { skip }, async () => {
  const query = Object.entries(VARS).map(([k, v]) => `var-${k}=${v}`).join('&');
  view = await openDashboard(`/d/f1-race-laps?${query}`, { datasets: DATASETS, timeoutMs: 120_000 });
  assert.ok(view.loadMs <= 60_000, `took ${view.loadMs} ms`);
  for (const title of ['Tyre strategy', 'Race control']) await view.panel(title);
  assert.equal(await view.panelErrors(), 0, 'Race');
  await view.page.getByRole('tab', { name: 'A against B' }).click();
  for (const title of ['The replay lap, A against B', 'A against B, second by second', 'Gap through the lap', 'Who is quicker where', 'Fastest laps, A against B']) {
    await view.panel(title);
  }
  assert.equal(await view.panelErrors(), 0, 'A against B');
});
