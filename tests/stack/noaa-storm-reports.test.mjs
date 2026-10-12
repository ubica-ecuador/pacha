// The noaa-storm-reports dashboard: the NWS Local Storm Reports of the past
// week, read live by Infinity from NOAA's public ArcGIS Feature Service. Every
// query is run as a visitor runs it, with the dashboard's variables filled in
// as Grafana fills them on load; the service is public, so these tests need the
// internet. A quiet week can hold few reports, so the checks are about shape.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'noaa-storm-reports';
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
    body: { from: 'now-7d', to: 'now', queries: [{ ...fill(query, vars), refId: 'A', datasource: INFINITY }] },
  });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  return rowsOf(res.json);
}
const queries = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) =>
  p.spec.data.spec.queries.map((q) => ({ title: p.spec.title, ref: q.spec.refId, spec: q.spec.query.spec })),
);
const queryOf = (title, ref) => queries.find((q) => q.title === title && q.ref === ref).spec;

const keys = async (name) => (await infinity(variable(name).query.spec.infinityQuery, {})).map((r) => r.key);
const DEFAULTS = {
  type: await keys('type'),
  state: await keys('state'),
  ...Object.fromEntries(['mapFrom', 'mapTo', 'west', 'south', 'east', 'north'].map((n) => [n, variable(n).current.value])),
};

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['infinity', 'kepler', 'weather', 'live']);
  assert.ok(queries.every((q) => q.spec.url.startsWith('https://services9.arcgis.com/')));
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets the whole week, the same count the service gives, in North America', { timeout: 120_000 }, async () => {
  const [{ n }] = await infinity(queryOf('Reports this week', 'G'), DEFAULTS);
  const rows = await infinity(queryOf('Severe weather reports — last 7 days', 'A'), DEFAULTS);
  assert.ok(n > 0, 'no report this week');
  assert.equal(rows.length, n);
  const week = Date.now() - 8 * 86400_000;
  assert.ok(rows.every((r) => r.time > week), 'a report older than the week');
  // The extent the side panels start from: the States, Alaska, Hawaii and Puerto Rico (Guam lies outside).
  const inside = rows.filter((r) => r.latitude > 15 && r.latitude < 72 && r.longitude > -170 && r.longitude < -60);
  assert.ok(inside.length >= 0.95 * rows.length, `${inside.length} of ${rows.length} inside the extent`);
  const hurt = await infinity(queryOf('Severe weather reports — last 7 days', 'I'), DEFAULTS);
  assert.ok(hurt.every((r) => r.casualties > 0));
});

test('the counters, charts and table answer, and agree with each other', { timeout: 120_000 }, async () => {
  const [day] = await infinity(queryOf('Last 24 hours', 'B'), DEFAULTS);
  const [window] = await infinity(queryOf("In the player's window", 'C'), DEFAULTS);
  for (const kind of ['tornado', 'hail', 'wind', 'flood', 'lightning', 'wildfire']) {
    assert.ok(day[kind] >= 0 && day[kind] <= window[kind], kind);
  }
  const types = await infinity(queryOf('Reports by type', 'D'), DEFAULTS);
  const [{ n }] = await infinity(queryOf('Reports this week', 'G'), DEFAULTS);
  const typed = types.reduce((sum, r) => sum + r.n, 0);
  assert.ok(typed > 0.95 * n && typed <= n, `${typed} of ${n}`);
  const states = await infinity(queryOf('States with most reports', 'E'), DEFAULTS);
  assert.ok(states.length > 0 && states.length <= 15);
  const recent = await infinity(queryOf('Most recent reports', 'F'), DEFAULTS);
  assert.equal(recent.length, Math.min(200, typed));
  const days = await infinity(queryOf('Deaths and injuries per day', 'H'), DEFAULTS);
  assert.ok(days.length >= 1 && days.length <= 9 && days.every((r) => r.deaths >= 0 && r.injuries >= 0));
});

test('loads for an anonymous visitor, with no panel in error', { timeout: 180_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
});
