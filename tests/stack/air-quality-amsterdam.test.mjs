// The air-quality-amsterdam dashboard, opened as an anonymous visitor. Its data
// is Luchtmeetnet's live feed, so the checks compare the page against itself,
// never against fixed numbers. It needs Kepler Plus (compose.plus.yaml): on a
// stack without it the dashboard is not provisioned, and the tests are skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

// Only one Chromium alive at a time, as in earthquakes.test.mjs.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/air-quality-amsterdam${query}`, { datasets: ['series'] });
  return current;
};
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/air-quality-amsterdam');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor within 45 s, with no panel in error', { skip }, async () => {
  const view = await open();
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  const [{ n }] = await view.chaski('SELECT count(DISTINCT station) AS n FROM datasets.series');
  assert.ok(Number(n) >= 10, `only ${n} stations have readings`);
  assert.ok((await view.statNumber('Stations reporting')) >= 1);
});

test('the readings are at most a few hours old', { skip }, async () => {
  const view = await open();
  const [{ hours }] = await view.chaski(
    "SELECT date_diff('hour', max(time)::TIMESTAMP, now()::TIMESTAMP) AS hours FROM datasets.series",
  );
  assert.ok(Number(hours) <= 6, `latest reading ${hours} h ago`);
});

test('a station in the URL shows it in "Selected station"', { skip }, async () => {
  const view = await open();
  const [top] = await view.chaski('SELECT station, any_value(name) AS name FROM datasets.series GROUP BY station ORDER BY max(no2) DESC LIMIT 1');

  const selectedView = await open(`?var-station=${top.station}`);
  const text = await (await selectedView.panel('Selected station')).innerText();
  assert.ok(text.includes(top.station) && text.includes(top.name), text.slice(0, 200));
});

// Luchtmeetnet is read server side, through the gateway: an hour's request
// goes upstream once, then comes from the cache. The gateway serves it with or
// without the dashboard, so these run either way.
const HOUR = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
const MEASUREMENTS = `/luchtmeetnet/measurements?station_number=NL49014&formula=NO2&start=${iso(new Date(HOUR - 86_400_000))}&end=${iso(HOUR)}`;

test('DuckDB reads Luchtmeetnet through feeds', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT json_array_length((http_get('http://feeds${MEASUREMENTS}')->>'body')::JSON->'data') AS n`,
  );
  assert.ok(Number(row.n) > 0, 'no readings for Vondelpark in the last 24 hours');
});

test('a second read within the hour is served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${MEASUREMENTS}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});
