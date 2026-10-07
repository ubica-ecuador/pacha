// The air-quality dashboard, opened as an anonymous visitor. Its data is
// Sensor.Community's live feed, so the checks compare the page against itself,
// never against fixed numbers. It needs Kepler Plus (compose.plus.yaml): on a
// stack without it the dashboard is not provisioned, and the tests are skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

// Only one Chromium alive at a time, as in earthquakes.test.mjs.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/air-quality${query}`, { datasets: ['sensors'] });
  return current;
};
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/air-quality');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor within 45 s, with no panel in error', { skip }, async () => {
  const view = await open();
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  assert.ok((await view.statNumber('Sensors')) > 1000);
});

test('a PM2.5 range in the URL counts only the sensors in it', { skip }, async () => {
  const view = await open('?var-pm_lo=25&var-pm_hi=50');
  const [{ n }] = await view.chaski('SELECT count(*) AS n FROM datasets.sensors WHERE pm25_24h >= 25 AND pm25_24h < 50');
  assert.equal(await view.statNumber('Sensors'), Number(n));
});

test('a country in the URL counts only its sensors', { skip }, async () => {
  const view = await open('?var-country=DE');
  const [{ n }] = await view.chaski("SELECT count(*) AS n FROM datasets.sensors WHERE country = 'DE'");
  assert.equal(await view.statNumber('Sensors'), Number(n));
});

test('selecting a sensor via the URL shows it in "Selected sensor"', { skip }, async () => {
  const view = await open();
  const [top] = await view.chaski('SELECT sensor_id, country FROM datasets.sensors ORDER BY pm25_24h DESC LIMIT 1');

  const selectedView = await open(`?var-sensor=${top.sensor_id}`);
  const text = await (await selectedView.panel('Selected sensor')).innerText();
  assert.ok(text.includes(String(top.sensor_id)) && text.includes(top.country), text.slice(0, 200));
});

// The sparkline cards read the archive server side, through the gateway: a
// day's file comes from Sensor.Community once, then from the cache.
test('the archive is read through the feeds cache', { skip }, () => {
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  // The day's listing runs to megabytes: grep it where it is fetched.
  const file = compose(['exec', '-T', 'grafana', 'sh', '-c',
    `curl -s https://archive.sensor.community/${day}/ | grep -o -m 1 '${day}_sds011_sensor_[0-9]*\\.csv' | head -n 1`]).trim();
  assert.ok(file, `no SDS011 file listed for ${day}`);
  const headers = () =>
    compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds/sensor-community/archive/${day}/${file}`]);
  assert.match(headers(), /^HTTP\/1\.1 200/);
  assert.match(headers(), /X-Cache-Status: HIT/i);
});
