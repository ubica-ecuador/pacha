// Checks on configuration alone: nothing here needs the stack running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, sh } from './lib/docker.mjs';

const DEV = ['-f', 'compose.yaml', '-f', 'compose.dev.yaml'];

test('compose.dev.yaml refuses to start without KEPLER_DIST', () => {
  const env = { ...process.env };
  delete env.KEPLER_DIST;
  assert.throws(() => compose([...DEV, 'config'], { env }), /KEPLER_DIST/);
});

test('compose.dev.yaml mounts the given dist over the baked plugin, read-only', () => {
  const config = JSON.parse(compose([...DEV, 'config', '--format', 'json'], { env: { ...process.env, KEPLER_DIST: '/tmp/kepler-dist' } }));
  const mount = config.services.grafana.volumes.find((v) => v.target === '/opt/pacha/plugins/ubica-keplergl-panel');
  assert.equal(mount?.source, '/tmp/kepler-dist');
  assert.equal(mount?.read_only, true);
});

// Both read STACK_VERSION, but bake reads it from the shell and compose also
// from .env: keep it out of .env, or export it, or this compares two tags.
test('bake builds the image names compose runs', () => {
  const bake = JSON.parse(sh('docker', ['buildx', 'bake', '--print']));
  const config = JSON.parse(compose(['config', '--format', 'json']));
  assert.deepEqual(bake.target.grafana.tags, [config.services.grafana.image]);
  assert.deepEqual(bake.target.titiler.tags, [config.services.titiler.image]);
});

// --env-file /dev/null: a developer's own .env may well say edge.
test('Grafana bakes the release Kepler unless KEPLER_PANEL_CHANNEL says otherwise', () => {
  const env = { ...process.env };
  delete env.KEPLER_PANEL_CHANNEL;
  const channel = (extra = {}) =>
    JSON.parse(compose(['--env-file', '/dev/null', 'config', '--format', 'json'], { env: { ...env, ...extra } }))
      .services.grafana.build.args?.KEPLER_PANEL_CHANNEL;
  assert.equal(channel(), 'release');
  assert.equal(channel({ KEPLER_PANEL_CHANNEL: 'edge' }), 'edge');
});

// bake is what publishes images to GHCR (P3): those must never bake edge, no
// matter what a developer's own KEPLER_PANEL_CHANNEL says.
test('bake always builds the release Kepler, whatever KEPLER_PANEL_CHANNEL says', () => {
  const bake = JSON.parse(sh('docker', ['buildx', 'bake', '--print'], { env: { ...process.env, KEPLER_PANEL_CHANNEL: 'edge' } }));
  assert.equal(bake.target.grafana.args.KEPLER_PANEL_CHANNEL, 'release');
});

const DASHBOARDS = ['-f', 'compose.yaml', '-f', 'compose.dashboards.yaml'];

test('compose.dashboards.yaml refuses to start without DASHBOARDS_DIR', () => {
  const env = { ...process.env };
  delete env.DASHBOARDS_DIR;
  assert.throws(() => compose(['--env-file', '/dev/null', ...DASHBOARDS, 'config'], { env }), /DASHBOARDS_DIR/);
});

test('compose.dashboards.yaml mounts the repo: its Repository read-only, its dashboards writable, its routes as templates', () => {
  const config = JSON.parse(
    compose(['--env-file', '/dev/null', ...DASHBOARDS, 'config', '--format', 'json'], { env: { ...process.env, DASHBOARDS_DIR: '/tmp/pd' } }),
  );
  const mount = (service, target) => config.services[service].volumes.find((v) => v.target === target);
  assert.equal(mount('grafana', '/etc/grafana/provisioning/repositories/dashboards')?.source, '/tmp/pd/grafana/repositories');
  assert.equal(mount('grafana', '/etc/grafana/provisioning/repositories/dashboards')?.read_only, true);
  assert.equal(mount('grafana', '/var/lib/pacha/extra-dashboards')?.source, '/tmp/pd/dashboards');
  assert.ok(!mount('grafana', '/var/lib/pacha/extra-dashboards')?.read_only);
  assert.equal(mount('gateway', '/etc/nginx/templates/feeds.d')?.source, '/tmp/pd/gateway');
  assert.equal(mount('gateway', '/srv/datasets-extra')?.source, '/tmp/pd/datasets');
  assert.match(config.services.gateway.environment.NGINX_ENVSUBST_FILTER, /FEED/);
});

// A route whose key .env lacks must not stop nginx (and Grafana behind it).
test('the gateway starts with a dashboards repo route whose FEED_ key is unset', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pacha-dashboards-'));
  for (const sub of ['gateway/http', 'datasets', 'dashboards', 'grafana/repositories']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'gateway/http/probe.conf.template'), 'proxy_cache_path /var/cache/nginx/probe keys_zone=probe:1m;\n');
  writeFileSync(join(dir, 'gateway/probe.conf.template'), '    location = /probe { proxy_cache probe; return 200 "${FEED_UNSET_PROBE_KEY}"; }\n');
  const env = { ...process.env, DASHBOARDS_DIR: dir };
  delete env.FEED_UNSET_PROBE_KEY;
  const out = compose(['--env-file', '/dev/null', '-p', 'pacha-config-test', ...DASHBOARDS, 'run', '--rm', '--no-deps', '-T', 'gateway', 'nginx', '-t'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  compose(['-p', 'pacha-config-test', 'down'], { env });
  assert.doesNotMatch(out, /emerg/);
});
