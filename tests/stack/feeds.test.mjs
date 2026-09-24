import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { duckdb, rawGet } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';

const VEHICLES = '/mbta/realtime/VehiclePositions_enhanced.json';

test('DuckDB reads an MBTA feed through feeds', async () => {
  const [row] = await duckdb(STACK_URL, `LOAD httpfs; SELECT length(content) AS n FROM read_text('http://feeds${VEHICLES}')`);
  assert.ok(Number(row.n) > 1000, `feed is only ${row.n} bytes`);
});

test('a second read within 15 s is served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${VEHICLES}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

test('no stale copies, ever', () => {
  assert.doesNotMatch(compose(['exec', '-T', 'gateway', 'nginx', '-T']), /proxy_cache_use_stale/);
});

test('feeds refuses a request relayed by a public proxy', async () => {
  const { port } = new URL(STACK_URL);
  const res = await rawGet(`http://127.0.0.1:${port}${VEHICLES}`, { host: 'feeds', 'x-forwarded-for': '203.0.113.9' });
  assert.equal(res.status, 403);
});
