// This machine builds amd64 only (no QEMU). What an arm64 build downloads is
// checked here instead, so a missing arm64 artifact fails now rather than on
// the release runner (P3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sh } from '../lib/docker.mjs';

const dockerfile = readFileSync(new URL('../../images/grafana/Dockerfile', import.meta.url), 'utf8');
const arg = (name) => dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];
const ENGINE = arg('DUCKDB_ENGINE_VERSION');

test('the Dockerfile pins the engine and the arm64 CLI hash', () => {
  assert.equal(ENGINE, '1.5.4');
  assert.match(arg('DUCKDB_CLI_SHA256_arm64') ?? '', /^[0-9a-f]{64}$/);
});

test('the arm64 DuckDB CLI matches its pinned sha256', async () => {
  const res = await fetch(`https://github.com/duckdb/duckdb/releases/download/v${ENGINE}/duckdb_cli-linux-arm64.zip`);
  assert.equal(res.status, 200);
  const digest = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
  assert.equal(digest, arg('DUCKDB_CLI_SHA256_arm64'));
});

for (const [repo, names] of [
  ['extensions.duckdb.org', ['spatial', 'httpfs', 'json', 'excel']],
  ['community-extensions.duckdb.org', ['http_client', 'raster']],
]) {
  for (const name of names) {
    test(`${name} exists for linux_arm64 on ${ENGINE}`, async () => {
      const res = await fetch(`https://${repo}/v${ENGINE}/linux_arm64/${name}.duckdb_extension.gz`, { method: 'HEAD' });
      assert.equal(res.status, 200);
    });
  }
}

test('the DuckDB datasource zip ships a linux_arm64 binary', () => {
  sh('docker', ['build', '--target', 'fetch', '-t', 'geostack-grafana-fetch:test', 'images/grafana']);
  const listing = sh('docker', ['run', '--rm', 'geostack-grafana-fetch:test', 'unzip', '-l', '/fetch/duckdb.zip']);
  assert.match(listing, /gpx_duckdb_datasource_linux_arm64/);
});
