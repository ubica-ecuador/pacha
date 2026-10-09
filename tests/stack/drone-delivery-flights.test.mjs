// The drone-delivery-flights dashboard, opened as an anonymous visitor. Its
// data is CMU's published dataset, which never changes, so the checks may use
// its numbers. It needs Kepler Plus (compose.plus.yaml): on a stack without it
// the dashboard is not provisioned, and the tests are skipped.
//
// The first visit after the gateway's cache is emptied downloads 107 MB from
// figshare (about two minutes), longer than Grafana's query timeout; warm the
// cache first with feeds.test.mjs or a curl to http://feeds/figshare/files/26385151.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

// Only one Chromium alive at a time, as in earthquakes.test.mjs.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/drone-delivery-flights${query}`, { datasets: ['flights', 'track'] });
  return current;
};
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/drone-delivery-flights');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

const trackFlight = async (view) => {
  const [{ n, start }] = await view.chaski(
    "SELECT count(*)::INTEGER AS n, strftime(min(time), '%Y-%m-%d %H:%M') AS start FROM datasets.track",
  );
  return { n, start };
};

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor within 45 s, with no panel in error', { skip }, async () => {
  const view = await open();
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  const [{ flights }] = await view.chaski('SELECT count(*)::INTEGER AS flights FROM datasets.flights');
  assert.equal(flights, 209);
});

test('opens on flight 99, with its own track', { skip }, async () => {
  const view = await open();
  // Flight 99 took off at 17:45 in Pittsburgh on 19 June 2019 (21:45 UTC).
  assert.deepEqual(await trackFlight(view), { n: 1274, start: '2019-06-19 21:45' });
  const stats = await (await view.panel('The picked flight')).innerText();
  assert.match(stats, /3 min 11 s/);
  assert.match(stats, /23\.5\s*Wh\b/);
  assert.match(stats, /49\.7\s*Wh\/km/);
});

test('a flight in the URL loads only that flight', { skip }, async () => {
  const view = await open('?var-flight=12');
  assert.deepEqual(await trackFlight(view), { n: 775, start: '2019-05-06 20:19' });
});

test('energy per kilometre falls as the commanded speed rises', { skip }, async () => {
  const view = await open();
  const rows = await view.chaski(
    'SELECT speed_ms, avg(wh_per_km) AS wh FROM datasets.flights WHERE wh_per_km IS NOT NULL AND payload_g = 0 GROUP BY 1 ORDER BY 1',
  );
  assert.ok(rows.length >= 5, `only ${rows.length} speeds`);
  assert.ok(rows.at(-1).wh < rows[0].wh, JSON.stringify(rows));
});

test('a row of the flights table opens that flight', { skip }, async () => {
  const view = await open();
  const table = await view.panel('All flights');
  await table.getByRole('link', { name: '12', exact: true }).first().click();
  await view.page.waitForFunction(() => new URL(location.href).searchParams.get('var-flight') === '12', null, { timeout: 15_000 });
  await view.page.waitForFunction(
    () => window.__duckdbwasm?.stats?.loads?.filter((l) => l.name === 'track' && l.ok).length >= 2,
    null,
    { timeout: 30_000, polling: 250 },
  );
  assert.equal((await trackFlight(view)).n, 775);
});
