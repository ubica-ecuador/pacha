// The datacenter-interconnection dashboard: PeeringDB's data centres, the
// submarine cables and the latest RIPE Atlas pings to one anchor, read through
// the gateway. The data is live, so the checks are about shape, not numbers.
// It needs Kepler Plus (compose.plus.yaml): without it, the browser test is
// skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { api, duckdb } from '../lib/grafana.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { openDashboard } from '../lib/browser.mjs';

const DATASETS = ['facilities', 'cables', 'landings', 'latency'];
const QUITO = '19206681'; // the mesh measurement of the CEDIA anchor, the default target
const dashboard = loadDashboard('plus/dashboards/datacenter-interconnection.json');
const serverSql = (name) =>
  findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql.replaceAll('${target:raw}', QUITO);

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/datacenter-interconnection');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'datacenter-interconnection');
  assert.ok(dashboard.spec.description);
  for (const tag of ['chaski', 'duckdb', 'kepler', 'network', 'live', 'plus']) assert.ok(dashboard.spec.tags.includes(tag), tag);
});

test('reads every source through the gateway only', () => {
  for (const name of DATASETS) assert.match(serverSql(name), /http:\/\/feeds\//, name);
  assert.doesNotMatch(JSON.stringify(dashboard), /peeringdb\.com\/api|submarinecablemap\.com\/api|atlas\.ripe\.net\/api/);
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  const browserSql = findAll(dashboard, (n) => n.group === 'ubica-chaski-datasource' && typeof n.spec?.rawSql === 'string');
  for (const { spec } of browserSql) {
    for (const line of spec.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('every dataset has rows with a place', async () => {
  const [f] = await duckdb(STACK_URL, `SELECT count(*) AS n, count(*) FILTER (WHERE latitude IS NULL) AS nowhere FROM (${serverSql('facilities')})`);
  assert.ok(f.n > 3000 && Number(f.nowhere) === 0, `${f.n} data centres, ${f.nowhere} with no place`);
  const [c] = await duckdb(STACK_URL, `SELECT count(*) AS n FROM (${serverSql('cables')}) WHERE geometry LIKE '{"type":"MultiLineString"%'`);
  assert.ok(c.n > 500, `only ${c.n} cables`);
  const [l] = await duckdb(STACK_URL, `SELECT count(*) AS n FROM (${serverSql('landings')})`);
  assert.ok(l.n > 1000, `only ${l.n} landing points`);
});

test('the pings to the default target come from hundreds of anchors, minutes ago', async () => {
  const [r] = await duckdb(STACK_URL, `WITH p AS (${serverSql('latency')})
    SELECT count(*) FILTER (WHERE rtt_ms IS NOT NULL) AS answering, any_value(target) AS target,
           date_diff('minute', max(time), now()) AS minutes FROM p`);
  assert.equal(r.target, 'Quito, EC');
  assert.ok(r.answering > 500, `only ${r.answering} anchors answering`);
  assert.ok(r.minutes < 30, `latest ping ${r.minutes} min ago`);
});

test('PeeringDB is served from the cache, and the gateway passes on the dashboard routes only', () => {
  const headers = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${path}`]);
  headers('/peeringdb/fac');
  assert.match(headers('/peeringdb/fac'), /X-Cache-Status: (HIT|STALE|UPDATING)/i);
  const status = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://feeds${path}`]);
  assert.equal(status('/peeringdb/net'), '404');
  assert.equal(status('/atlas/latest/1;drop.json'), '404');
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads every dataset for an anonymous visitor, with no panel in error', { skip }, async () => {
  view = await openDashboard('/d/datacenter-interconnection?refresh=', { datasets: DATASETS, timeoutMs: 90_000 });
  assert.equal(await view.panelErrors(), 0);
  const [{ answering }] = await view.chaski('SELECT count(*) FILTER (WHERE rtt_ms IS NOT NULL) AS answering FROM datasets.latency');
  assert.ok(Number(answering) > 500, `${answering} anchors answering`);
  assert.ok((await view.statNumber('Median RTT')) > 0);
});
