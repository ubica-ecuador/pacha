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
