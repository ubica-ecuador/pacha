// The drone-delivery-flights dashboard. Its data is CMU's published dataset,
// which never changes, so the checks may use its numbers. It needs Kepler Plus
// (compose.plus.yaml): on a stack without it the dashboard is not provisioned,
// and the page tests are skipped.
//
// The first visit after the gateway's cache is emptied downloads 107 MB from
// figshare (about two minutes), longer than Grafana's query timeout; warm the
// cache first with feeds.test.mjs or a curl to http://feeds/figshare/files/26385151.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'drone-delivery-flights';
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const [fixes] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'fixes');

// Only one Chromium alive at a time, as in earthquakes.test.mjs.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/${UID}${query}`, { datasets: ['fixes', 'flights'] });
  return current;
};
after(async () => current && current.browser.close());

// The picked flight's figures, once its stat panel has drawn them (it sits below the fold).
const statsOf = async (view) => {
  const panel = await view.panel('The picked flight');
  await view.page.waitForFunction((el) => /\d+ min \d+ s/.test(el.innerText), await panel.elementHandle(), { timeout: 30_000 });
  return panel.innerText();
};

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.ok(dashboard.spec.tags.includes('plus') && dashboard.spec.tags.includes('chaski'));
  assert.equal(fixes.source.datasource.uid, 'duckdb');
  // Brushes and pickers write these; a dataset reading one would reload on each
  // change, and a reload rebuilds every Mosaic panel and clears its brushes.
  const written = ['flight', 'whkm_lo', 'whkm_hi', 'wind_lo', 'wind_hi', 't0', 't1', 'route', 'payload'];
  for (const dataset of findAll(dashboard, (n) => n.kind === 'dataset')) {
    const sql = dataset.source.sql ?? dataset.source.query?.rawSql ?? '';
    for (const name of written) assert.doesNotMatch(sql, new RegExp(`\\$\\{?${name}\\b`), `${dataset.name} reads ${name}`);
  }
  // Both maps filter on the GPU from their Selection.
  const maps = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplerplus-panel');
  assert.deepEqual(maps.map((m) => m.vizConfig.spec.options.mosaicSelection).sort(), ['droneFilters', 'flightFilters']);
});

test('the server sends one row per second of every flight, with their totals', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(*)::INTEGER AS n, count(DISTINCT flight)::INTEGER AS flights,
            count(DISTINCT flight) FILTER (WHERE latitude IS NULL)::INTEGER AS no_gps,
            round(sum(wh))::INTEGER AS wh, round(sum(m) / 1000)::INTEGER AS km
     FROM (${fixes.source.query.rawSql})`,
  );
  // 209 flights of about three minutes; nine altitude tests logged no GPS.
  assert.deepEqual(row, { n: 38820, flights: 209, no_gps: 9, wh: 4233, km: 95 });
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor within 45 s, with no panel in error, on flight 99', { skip }, async () => {
  const view = await open();
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
  const [{ flights }] = await view.chaski('SELECT count(*)::INTEGER AS flights FROM datasets.flights');
  assert.equal(flights, 209);
  // Flight 99 took off at 17:45 in Pittsburgh on 19 June 2019.
  const stats = await statsOf(view);
  assert.match(stats, /2019-06-19 17:45/);
  assert.match(stats, /3 min 11 s/);
  assert.match(stats, /23\.5\s*Wh\b/);
  assert.match(stats, /49\.7\s*Wh\/km/);
  assert.equal(await view.statNumber('Flights'), 209);
});

test('a payload in the URL keeps its flights in the totals', { skip }, async () => {
  const view = await open('?var-payload=500%20g');
  assert.equal(await view.statNumber('Flights'), 66);
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
  const table = await view.panel('Flights kept');
  await table.getByRole('link', { name: '12', exact: true }).first().click();
  await view.page.waitForFunction(() => new URL(location.href).searchParams.get('var-flight') === '12', null, { timeout: 15_000 });
  // Flight 12: 1 min 56 s, 13.0 Wh.
  await view.page.waitForFunction(
    () => /1 min 56 s/.test(document.body.innerText),
    null,
    { timeout: 30_000, polling: 250 },
  );
  const stats = await statsOf(view);
  assert.match(stats, /13(\.0)?\s*Wh\b/);
});
