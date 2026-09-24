import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { curlIn, hostPort, remove, runDetached, sh, waitFor } from '../lib/docker.mjs';
import { ADMIN, api, dsQueryBody, rowsOf } from '../lib/grafana.mjs';

const IMAGE = process.env.GRAFANA_IMAGE ?? 'ghcr.io/ubica-ecuador/geostack-grafana:dev';

const EXPECTED = {
  'ubica-keplergl-panel': { version: '1.0.0', signature: 'unsigned' },
  'ubica-chaski-datasource': { version: '1.0.0', signature: 'unsigned' },
  'motherduck-duckdb-datasource': { version: '0.4.5', signature: 'unsigned' },
  'yesoreyeram-infinity-datasource': { version: '4.0.0', signature: 'valid' },
  'volkovlabs-echarts-panel': { version: '7.2.5', signature: 'valid' },
  'volkovlabs-table-panel': { version: '3.6.8', signature: 'valid' },
  'volkovlabs-variable-panel': { version: '5.2.0', signature: 'valid' },
};

// Same as provisioning/datasources/datasources.yaml (Task 3): the offline test
// has to prove those LOADs find the baked files and never go online.
//
// The leading SET is required: Grafana 13.2.1 always launches a backend
// plugin's subprocess with HOME pinned to GF_PATHS_HOME (/usr/share/grafana),
// never the container's own HOME, regardless of GF_PLUGINS_FORWARD_HOST_ENV_VARS
// (verified by reading /proc/<pid>/environ of the running DuckDB datasource
// process). DuckDB's own $HOME-based default extension directory is therefore
// unreachable from inside the plugin, so the directory has to be named
// explicitly instead of relying on the image's HOME env var.
const INIT_SQL =
  "SET extension_directory='/opt/geostack/duckdb-home/.duckdb/extensions'; SET allow_persistent_secrets = false; " +
  'LOAD httpfs; LOAD spatial; LOAD json; LOAD excel; LOAD raster; LOAD http_client; ' +
  'LOAD avro; LOAD iceberg; LOAD h3; LOAD a5; LOAD lindel; ' +
  "SET enable_external_file_cache = false; SET disabled_filesystems = 'LocalFileSystem';";

let id;
let base;

before(async () => {
  id = runDetached(IMAGE, { dockerArgs: ['-p', '127.0.0.1::3000'] });
  base = `http://127.0.0.1:${hostPort(id, 3000)}`;
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, { what: 'grafana /api/health' });
});

after(() => remove(id));

test('runs Grafana Enterprise 13.2.1', async () => {
  const { json } = await api(base, '/api/frontend/settings');
  assert.equal(json.buildInfo.version, '13.2.1');
  assert.equal(json.buildInfo.edition, 'Enterprise');
});

test('the seven plugins load with the pinned versions and signatures', async () => {
  const { json } = await api(base, '/api/plugins');
  for (const [pluginId, want] of Object.entries(EXPECTED)) {
    const plugin = json.find((p) => p.id === pluginId);
    assert.ok(plugin, `${pluginId} did not load`);
    assert.equal(plugin.info.version, want.version, pluginId);
    assert.equal(plugin.signature, want.signature, pluginId);
  }
});

test('anonymous visitors are Viewers, not Admins', async () => {
  assert.equal((await api(base, '/api/search', { anonymous: true })).status, 200);
  const create = await api(base, '/api/dashboards/db', {
    method: 'POST',
    anonymous: true,
    body: { dashboard: { id: null, uid: null, title: 'anonymous write' }, overwrite: false },
  });
  assert.ok([401, 403].includes(create.status), `anonymous could create a dashboard (${create.status})`);
});

test('safe defaults, and plugins and DuckDB home outside /var/lib/grafana', () => {
  const env = JSON.parse(sh('docker', ['image', 'inspect', '--format', '{{json .Config.Env}}', IMAGE]));
  for (const entry of [
    'GF_PATHS_PLUGINS=/opt/geostack/plugins',
    'HOME=/opt/geostack/duckdb-home',
    'GF_AUTH_ANONYMOUS_ENABLED=true',
    'GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer',
    'GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ubica-keplergl-panel,ubica-chaski-datasource,motherduck-duckdb-datasource',
    'GF_PLUGINS_FORWARD_HOST_ENV_VARS=motherduck-duckdb-datasource,yesoreyeram-infinity-datasource',
    'GF_PLUGIN_PAGINATION_MAX_PAGES=12',
    'GF_PLUGINS_PREINSTALL_DISABLED=true',
  ]) {
    assert.ok(env.includes(entry), `missing ${entry}`);
  }
  assert.ok(!env.some((entry) => entry.startsWith('GF_DEFAULT_APP_MODE=development')));
});

test('versions are exposed as image labels', () => {
  const labels = JSON.parse(sh('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', IMAGE]));
  assert.equal(labels['io.geostack.kepler-panel.version'], '1.0.0');
  assert.equal(labels['io.geostack.chaski.version'], '1.0.0');
  assert.equal(labels['io.geostack.duckdb-datasource.version'], '0.4.5');
  assert.equal(labels['io.geostack.duckdb-engine.version'], '1.5.4');
  assert.equal(labels['io.geostack.business-charts.version'], '7.2.5');
  assert.match(labels['org.opencontainers.image.description'], /Not affiliated with Grafana Labs/);
});

test("only this architecture's DuckDB binary is left", () => {
  const arch = sh('docker', ['image', 'inspect', '--format', '{{.Architecture}}', IMAGE]);
  const files = sh('docker', ['run', '--rm', '--entrypoint', 'ls', IMAGE, '/opt/geostack/plugins/motherduck-duckdb-datasource']).split('\n');
  assert.deepEqual(files.filter((f) => f.startsWith('gpx_')), [`gpx_duckdb_datasource_linux_${arch}`]);
});

test('DuckDB loads every baked extension with no network at all', async () => {
  const offline = runDetached(IMAGE, { dockerArgs: ['--network', 'none'] });
  try {
    const curl = (...args) => curlIn(offline, ['-s', '-u', `${ADMIN.user}:${ADMIN.password}`, ...args]);
    await waitFor(() => curl('-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:3000/api/health') === '200', {
      what: 'grafana with --network none',
    });
    curl(
      '-X', 'POST', '-H', 'content-type: application/json',
      '-d', JSON.stringify({ name: 'DuckDB', uid: 'duckdb', type: 'motherduck-duckdb-datasource', access: 'proxy', jsonData: { path: '', initSql: INIT_SQL } }),
      'http://localhost:3000/api/datasources',
    );
    // One call into each extension, so a missing one fails here by name. The
    // cell ids are cast to text: as JSON numbers they would lose precision.
    const sql =
      'LOAD spatial; LOAD httpfs; LOAD json; LOAD excel; LOAD http_client; LOAD raster; ' +
      'LOAD avro; LOAD iceberg; LOAD h3; LOAD a5; LOAD lindel; ' +
      'SELECT version() AS v, ST_AsText(ST_Point(1, 2)) AS p, ' +
      'h3_latlng_to_cell(-2.9, -79.0, 7)::VARCHAR AS h3, a5_lonlat_to_cell(-79.0, -2.9, 10)::VARCHAR AS a5, ' +
      'hilbert_encode([1, 2]::INTEGER[2]) AS hilbert, ' +
      "(SELECT count(*) FROM duckdb_functions() WHERE function_name IN ('iceberg_scan', 'RT_Read')) AS table_functions";
    const out = curl('-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify(dsQueryBody(sql)), 'http://localhost:3000/api/ds/query');
    const [row] = rowsOf(JSON.parse(out));
    assert.equal(row.v, 'v1.5.4');
    assert.equal(row.p, 'POINT (1 2)');
    assert.equal(row.h3, '610509782519906303');
    assert.equal(row.a5, '2955903420613001216');
    assert.equal(row.hilbert, 7);
    assert.ok(Number(row.table_functions) >= 2, 'iceberg_scan or RT_Read is missing');
  } finally {
    remove(offline);
  }
});

// Last on purpose: Grafana's plugin preinstall runs in the background after
// startup, so by now it would have had time to write into the folder.
test('nothing is downloaded at startup: the plugin folder holds exactly the seven', () => {
  const dirs = sh('docker', ['exec', id, 'ls', '/opt/geostack/plugins']).split('\n').sort();
  assert.deepEqual(dirs, Object.keys(EXPECTED).sort());
});
