// The earthquakes dashboard, opened as an anonymous visitor.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const opened = [];
const open = async (query = '') => {
  const view = await openDashboard(`/d/earthquakes${query}`);
  opened.push(view);
  return view;
};
after(async () => Promise.all(opened.map((v) => v.browser.close())));

test('is provisioned in Start here under its old uid', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/earthquakes');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'start-here');
});

test('loads for an anonymous visitor within 45 s, with no panel in error', async () => {
  const view = await open();
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  assert.ok((await view.statNumber('Earthquakes')) > 1000);
});

test('rows without PAGER fields load and render', async () => {
  const view = await open();
  const [row] = await view.chaski('SELECT count(*) FILTER (WHERE alert IS NULL) AS without, count(*) AS total FROM datasets.quakes');
  assert.ok(Number(row.without) > 0 && Number(row.without) < Number(row.total));
  assert.equal(await view.panelErrors(), 0);
});

test('exposure covers the strong quakes and finds people near some of them', async () => {
  const view = await open();
  const [row] = await view.chaski(
    'SELECT (SELECT count(*) FROM datasets.quakes WHERE mag >= 4.5) AS strong, count(*) AS exposed, sum(people_100km) AS people FROM datasets.exposure',
  );
  assert.equal(Number(row.exposed), Number(row.strong));
  assert.ok(Number(row.people) > 0);
});
