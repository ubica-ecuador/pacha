// The international-migration dashboard: provisioned in Gallery, its DuckDB
// queries, as the file holds them, answering for Ecuador through Grafana, and
// the page opened as an anonymous visitor.
//
// Every query reads UN DESA's spreadsheets from un.org when it runs (about 4 s
// each): nothing is cached between them.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';

const dashboard = loadDashboard('dashboards/gallery/international-migration.json');

// Grafana's DuckDB datasource quotes a variable as an SQL string; so do these.
const ECUADOR = { country: '218', direction: 'immigrants', view: 'arcs', sex: 'both', top: '5', mapFrom: '', mapTo: '' };
const interpolate = (sql, vars) => sql.replace(/\$(\w+)/g, (match, name) => (name in vars ? `'${vars[name]}'` : match));

const queriesOf = (title) => panelTitled(dashboard, title).data.spec.queries.map((q) => q.spec.query.spec.rawSql);
const rows = (title, vars = {}, index = 0) => duckdb(STACK_URL, interpolate(queriesOf(title)[index], { ...ECUADOR, ...vars }));

// The panels' queries, and the country picker's (a plain string query, which
// the v2 schema keeps as `__legacyStringValue`).
const countrySql = dashboard.spec.variables.find((v) => v.spec.name === 'country').spec.query.spec.__legacyStringValue;
const allSql = [...findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql), countrySql];

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/international-migration');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('no query installs or loads an extension: the datasource has them loaded, and the disk is off', () => {
  assert.equal(allSql.length, 9);
  for (const sql of allSql) assert.doesNotMatch(sql, /\b(INSTALL|LOAD)\s+\w+\s*;/);
});

test('the country picker lists every country with an estimate, by M49 code', { timeout: 120_000 }, async () => {
  const got = await duckdb(STACK_URL, countrySql);
  assert.ok(got.length > 200, `only ${got.length} countries`);
  assert.ok(got.some((r) => r.__text === 'Ecuador' && r.__value === '218'));
});

test('the corridors chart gets Ecuador\'s largest origins and destinations', { timeout: 120_000 }, async () => {
  const got = await rows('Corridors in and out');
  const side = (s) => got.filter((r) => r.side === s);
  assert.equal(side('in').length, 5);
  assert.equal(side('out').length, 5);
  assert.ok(side('in').some((r) => r.code === '170'), 'Colombia among the origins');
  assert.ok(side('out').some((r) => r.code === '840'), 'the United States among the destinations');
  for (const r of got) assert.ok(r.share > 0 && r.share <= 100, JSON.stringify(r));
  // The $top on each side add up to no more than the side's total.
  for (const s of ['in', 'out']) assert.ok(side(s).reduce((sum, r) => sum + r.share, 0) <= 100.5);
});

test('the corridors chart follows the map clock to an earlier estimate', { timeout: 120_000 }, async () => {
  const latest = await rows('Corridors in and out');
  const in1990 = await rows('Corridors in and out', { mapTo: '1992-07-01T00:00:00.000Z' });
  assert.equal(in1990.length, 10);
  assert.notDeepEqual(in1990.map((r) => r.people), latest.map((r) => r.people));
});

test('the pyramid gets men and women of Ecuador\'s largest corridors, with their codes', { timeout: 120_000 }, async () => {
  const got = await rows('Men and women by corridor');
  assert.equal(got.length, 5);
  for (const r of got) {
    assert.match(r.code, /^\d+$/);
    assert.ok(r.Men > 0 && r.Women > 0, JSON.stringify(r));
  }
});

test('every other DuckDB query answers for Ecuador', { timeout: 10 * 60_000 }, async () => {
  for (const title of ['Key figures', 'International migrants, % of population', 'Women among migrants · ${country:text}']) {
    const got = await rows(title);
    assert.ok(got.length > 0, title);
  }
  // The map: corridors in the arcs view, flows in the flows view, every country's stock.
  const [arcs, stock, flows] = queriesOf('Migrant corridors');
  assert.ok((await duckdb(STACK_URL, interpolate(arcs, ECUADOR))).length >= 35 * 5);
  assert.ok((await duckdb(STACK_URL, interpolate(stock, ECUADOR))).length > 35 * 200);
  assert.ok((await duckdb(STACK_URL, interpolate(flows, { ...ECUADOR, view: 'flows' }))).length >= 35 * 10);
});

let view;
after(async () => view && view.browser.close());

test('loads for an anonymous visitor within 45 s, with no panel in error', { timeout: 120_000 }, async () => {
  view = await openDashboard('/d/international-migration?var-country=218', { chaski: false });
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  for (const title of ['Corridors in and out', 'Men and women by corridor']) {
    const panel = await view.panel(title);
    assert.equal(await panel.locator('canvas').count(), 1, `${title} draws`);
  }
  assert.equal(await view.panelErrors(), 0);
});
