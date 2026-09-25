import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostPort, remove, runDetached, sh, waitFor } from '../lib/docker.mjs';

const IMAGE = process.env.TITILER_IMAGE ?? 'ghcr.io/ubica-ecuador/pacha-titiler:dev';
const GFS = 'stac+https://stac.dynamical.org/noaa-gfs-forecast/collection.json';

let warm;
let base;

before(() => {
  warm = runDetached(IMAGE, {
    dockerArgs: ['-p', '127.0.0.1::80', '-e', 'TITILER_API_ROOT_PATH=/titiler', '-e', `ICECHUNK_PRELOAD=${GFS}`],
  });
  base = `http://127.0.0.1:${hostPort(warm, 80)}`;
});

after(() => remove(warm));

test('healthz answers', async () => {
  await waitFor(async () => (await fetch(`${base}/healthz`)).ok, { what: 'titiler /healthz' });
});

test('readyz turns 200 once the GFS preload has been tried', async () => {
  await waitFor(async () => (await fetch(`${base}/readyz`)).status === 200, {
    timeoutMs: 300_000,
    intervalMs: 2_000,
    what: 'titiler /readyz with GFS preloading',
  });
});

test('readyz does not wait forever for an unreachable repository', async () => {
  const id = runDetached(IMAGE, {
    dockerArgs: ['-p', '127.0.0.1::80', '-e', 'ICECHUNK_PRELOAD=stac+https://unreachable.invalid/collection.json'],
  });
  try {
    const url = `http://127.0.0.1:${hostPort(id, 80)}/readyz`;
    await waitFor(async () => (await fetch(url)).status === 200, { what: 'readyz after a failed preload' });
  } finally {
    remove(id);
  }
});

test('the API knows it is served under /titiler', async () => {
  // TiTiler publishes its OpenAPI document at /api, not at FastAPI's default
  // /openapi.json (see titiler.application.main, which sets openapi_url="/api").
  const doc = await (await fetch(`${base}/api`)).json();
  assert.equal(doc.servers?.[0]?.url, '/titiler');
});

test('the versions installed are exactly those in constraints.txt', () => {
  const pinned = readFileSync(new URL('../../images/titiler/constraints.txt', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const frozen = sh('docker', ['run', '--rm', '--entrypoint', 'pip', IMAGE, 'freeze']).split('\n');
  for (const line of pinned) {
    const name = line.split('==')[0];
    assert.ok(frozen.includes(line), `${line} is not installed; found ${frozen.filter((f) => f.startsWith(name)).join(', ') || 'nothing'}`);
  }
});
