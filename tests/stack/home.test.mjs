// The home dashboard: the file's conventions, the search queries its cards
// repeat over (Infinity reading Grafana's own search API), the screenshots and
// assets the gateway serves for it, and the page itself, opened as a visitor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, findAll } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('dashboards/home.json');
const spec = dashboard.spec;
const variable = (name) => spec.variables.find((v) => v.spec.name === name).spec;

// The Infinity query a variable holds, with the tag filter at "All", the way
// the dashboard sends it.
async function uidsOf(name) {
  const inner = variable(name).query.spec.infinityQuery;
  const query = { ...inner, refId: 'A', datasource: { uid: 'infinity', type: 'yesoreyeram-infinity-datasource' } };
  query.url = query.url.replace('$tag', variable('tag').current.value);
  const { status, json, text } = await api(STACK_URL, '/api/ds/query', { method: 'POST', body: { queries: [query], from: 'now-5m', to: 'now' }, anonymous: true });
  assert.equal(status, 200, text.slice(0, 300));
  const frame = json.results.A.frames[0];
  const values = frame.data.values[frame.schema.fields.findIndex((f) => f.name === '__value')];
  return values;
}

test('conventions: uid, description, tags, no time picker', () => {
  assert.equal(dashboard.metadata.name, 'home');
  assert.ok(spec.description.length > 40);
  assert.ok(spec.tags.includes('infinity') && spec.tags.includes('business-text'));
  assert.equal(spec.timeSettings.hideTimepicker, true);
});

test('the cards repeat over the Gallery and Plus folders, read from the search API', async () => {
  const repeats = findAll(spec.layout, (n) => n.repeat?.mode === 'variable').map((n) => n.repeat.value);
  assert.deepEqual(repeats.sort(), ['gallery', 'plus']);
  const gallery = await uidsOf('gallery');
  assert.ok(gallery.length >= 20, `gallery uids: ${gallery.length}`);
  assert.ok(gallery.includes('earthquakes'));
  const plus = await uidsOf('plus');
  const provisioned = await api(STACK_URL, '/api/dashboards/uid/f1-race-laps');
  if (provisioned.status === 200) assert.ok(plus.includes('f1-race-laps'));
  else assert.equal(plus.length, 0);
});

test('every screenshot is named after a dashboard, and the gateway serves them with the assets', async () => {
  const uids = ['dashboards/gallery', 'plus/dashboards']
    .flatMap((dir) => readdirSync(new URL(`../../${dir}/`, import.meta.url)))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -5));
  const shots = readdirSync(new URL('../../home/screenshots/', import.meta.url)).filter((f) => f.endsWith('.jpg'));
  assert.ok(shots.length >= 20, `screenshots: ${shots.length}`);
  for (const shot of shots) assert.ok(uids.includes(shot.slice(0, -4)), `${shot} names no dashboard`);
  for (const path of ['/home/assets/logo.svg', '/home/assets/contours.svg', '/home/assets/outfit.woff2', `/home/screenshots/${shots[0]}`]) {
    const res = await fetch(new URL(path, STACK_URL));
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('cache-control') ?? '', /max-age/, path);
  }
});

test('it is the home page, and it opens for a visitor with every card and no panel in error', async () => {
  const prefs = await api(STACK_URL, '/api/org/preferences');
  assert.equal(prefs.json.homeDashboardUID, 'home');
  const view = await openDashboard('/d/home', { chaski: false, timeoutMs: 90_000 });
  try {
    await view.page.waitForTimeout(3000);
    assert.equal(await view.panelErrors(), 0);
    // One panel per card, repeated over the variables; Grafana renders the
    // ones below the fold only when scrolled to, so count panels, not cards.
    const panels = await view.page.locator('[data-viz-panel-key]').count();
    assert.ok(panels >= 20, `panels: ${panels}`);
    assert.equal(await view.page.locator('text=Couldn\'t build text from template').count(), 0);
  } finally {
    await view.browser.close();
  }
});
