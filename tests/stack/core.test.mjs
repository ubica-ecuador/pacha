import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, sh, waitFor } from '../lib/docker.mjs';
import { api, basicAuth, duckdb, rawGet } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';

const healthy = async () => (await fetch(`${STACK_URL}/api/health`)).ok;

test('the project is pacha, with grafana-data as its only volume', () => {
  const config = JSON.parse(compose(['config', '--format', 'json']));
  assert.equal(config.name, 'pacha');
  assert.deepEqual(Object.keys(config.volumes ?? {}), ['grafana-data']);
});

test('STACK_PORT moves the one published port', () => {
  const config = JSON.parse(compose(['config', '--format', 'json'], { env: { ...process.env, STACK_PORT: '3999' } }));
  const published = Object.entries(config.services)
    .filter(([, service]) => service.ports?.length)
    .map(([name]) => name)
    .filter((name) => name !== 'mcp'); // loopback only, Task 7
  assert.deepEqual(published, ['gateway']);
  assert.equal(String(config.services.gateway.ports[0].published), '3999');
});

test('Grafana answers through the gateway', async () => {
  assert.ok(await healthy());
});

test('the three datasources are provisioned, and Chaski has no URL', async () => {
  for (const uid of ['duckdb', 'infinity', 'duckdbwasm']) {
    assert.equal((await api(STACK_URL, `/api/datasources/uid/${uid}`)).status, 200, uid);
  }
  const { json } = await api(STACK_URL, '/api/datasources/uid/duckdbwasm');
  assert.equal(json.type, 'ubica-chaski-datasource');
  assert.equal(json.url ?? '', '');
  assert.equal(json.jsonData.memoryLimitMB, 1024);
});

test('the server DuckDB is the pinned engine', async () => {
  const [row] = await duckdb(STACK_URL, 'SELECT version() AS v');
  assert.equal(row.v, 'v1.5.4');
});

test('DuckDB reaches the tiler by its service name', async () => {
  // Not /healthz: httpfs's read_text() sends a HEAD preflight, and /healthz
  // (like /readyz and /) is a plain FastAPI @app.get route that only answers
  // GET, 405-ing that HEAD — DuckDB then reports the whole read as "HTTP 0".
  // /api is FastAPI's own OpenAPI route, mounted without a method restriction,
  // so it answers HEAD too (verified with curl -X HEAD against both).
  const [row] = await duckdb(STACK_URL, "LOAD httpfs; SELECT content FROM read_text('http://titiler/api')");
  assert.ok(JSON.parse(row.content));
});

test('the tiler is served under /titiler with the prefix taken off', async () => {
  assert.equal((await fetch(`${STACK_URL}/titiler/healthz`)).status, 200);
  // TiTiler publishes its OpenAPI document at /api, not at FastAPI's default
  // /openapi.json (see titiler.application.main, which sets openapi_url="/api";
  // verified in tests/images/titiler.test.mjs).
  const doc = await (await fetch(`${STACK_URL}/titiler/api`)).json();
  assert.equal(doc.servers?.[0]?.url, '/titiler');
});

// grafana.ubica.ec and pacha.ubica.dev put the gateway on their reverse
// proxy's network too, where `titiler` already names another stack's tiler.
// The decoys are plain nginx: they answer 404 where Grafana and TiTiler answer.
test('on a network shared with other stacks, the gateway still reaches its own Grafana and tiler', async (t) => {
  const net = 'aaa-pacha-decoys'; // sorts before pacha_default
  const gateway = compose(['ps', '-q', 'gateway']);
  const decoys = []; // container ids, filled in as each one starts
  t.after(async () => {
    try { sh('docker', ['network', 'disconnect', net, gateway]); } catch {}
    for (const id of decoys) try { sh('docker', ['rm', '-f', id]); } catch {}
    try { sh('docker', ['network', 'rm', net]); } catch {}
    compose(['restart', 'gateway']);
    await waitFor(healthy, { what: 'gateway after the decoys' });
  });
  // A crashed earlier run can leave this network behind; clear it before
  // creating it. If it's still held by containers from that run, the create
  // below fails and that's the error the test reports — no extra machinery.
  try { sh('docker', ['network', 'rm', net]); } catch {}
  sh('docker', ['network', 'create', net]);
  for (const alias of ['titiler', 'grafana']) {
    decoys.push(sh('docker', ['run', '-d', '--rm', '--network', net, '--network-alias', alias, 'nginx:1.27-alpine']));
  }
  sh('docker', ['network', 'connect', net, gateway]);
  // A restart drops nginx's cached lookups (valid=30s): what follows resolves anew.
  compose(['restart', 'gateway']);
  await waitFor(healthy, { what: 'gateway on the decoy network' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(`${STACK_URL}/titiler/healthz`)).status, 200);
    assert.equal((await fetch(`${STACK_URL}/api/health`)).status, 200);
  }
});

test('Grafana Live upgrades to a websocket through the gateway', async () => {
  // A browser always sends Origin; a plain GET from Node does not. Grafana
  // Live checks it against GF_SERVER_ROOT_URL (compose.yaml) before
  // upgrading, so the request has to look like a real browser's to prove the
  // gateway/root_url combination actually works — not just that the socket
  // upgrades when nothing checks the Origin at all.
  const res = await rawGet(`${STACK_URL}/api/live/ws`, {
    authorization: basicAuth(),
    origin: new URL(STACK_URL).origin,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  });
  assert.equal(res.status, 101);
});

test('Grafana Live rejects a websocket from a foreign Origin', async () => {
  // The positive test above would also pass if the Origin check were simply
  // off. Proving a mismatched Origin is refused is what shows it is on.
  const res = await rawGet(`${STACK_URL}/api/live/ws`, {
    authorization: basicAuth(),
    origin: 'https://evil.example',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  });
  assert.equal(res.status, 403);
});

test("Chaski's engine goes out compressed", async () => {
  const res = await rawGet(`${STACK_URL}/public/plugins/ubica-chaski-datasource/duckdb-eh.wasm`, { 'accept-encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
});

test('the gateway starts, and Grafana keeps serving, while the tiler is down', async () => {
  compose(['stop', 'titiler']);
  try {
    compose(['restart', 'gateway']);
    await waitFor(healthy, { what: 'grafana through the gateway with titiler stopped' });
    assert.equal((await fetch(`${STACK_URL}/titiler/healthz`)).status, 502);
  } finally {
    compose(['up', '-d', '--wait', 'titiler']);
  }
});

test('plugins left in an old volume do not shadow the baked ones', async () => {
  // grafana.ubica.ec's volume carries a plugins/ of its own.
  compose([
    'exec', '-T', 'grafana', 'sh', '-c',
    'mkdir -p /var/lib/grafana/plugins/ubica-keplergl-panel && ' +
      'printf \'{"type":"panel","id":"ubica-keplergl-panel","name":"stale","info":{"version":"0.0.1"}}\' ' +
      '> /var/lib/grafana/plugins/ubica-keplergl-panel/plugin.json',
  ]);
  try {
    compose(['restart', 'grafana']);
    await waitFor(healthy, { what: 'grafana after restart' });
    const { json } = await api(STACK_URL, '/api/plugins/ubica-keplergl-panel/settings');
    assert.equal(json.info.version, '1.0.1');
  } finally {
    compose(['exec', '-T', 'grafana', 'rm', '-rf', '/var/lib/grafana/plugins']);
  }
});
