// What an anonymous visitor can make the server do. Grafana lets anyone who may
// view a dashboard send queries of their own to its datasources
// (/api/ds/query), not only the ones saved in dashboards, so the server DuckDB
// has to be safe to hand arbitrary SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose } from '../lib/docker.mjs';
import { api, dsQueryBody } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';

// Sends the query as an anonymous visitor would and returns DuckDB's error
// text, or null when the query ran.
async function anonymousDuckdbError(rawSql) {
  const { status, json, text } = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    anonymous: true,
    body: dsQueryBody(rawSql),
  });
  const result = json?.results?.A;
  assert.ok(result, `no result for the query (${status}): ${text.slice(0, 300)}`);
  return result.error ?? null;
}

test('an anonymous query cannot read local files through DuckDB', async () => {
  const error = await anonymousDuckdbError("SELECT size FROM read_blob('/var/lib/grafana/grafana.db')");
  assert.match(error ?? 'the query read grafana.db', /LocalFileSystem has been disabled/);
});

test('an anonymous query cannot turn the local filesystem back on', async () => {
  const error = await anonymousDuckdbError(
    "SET disabled_filesystems = ''; SELECT size FROM read_blob('/var/lib/grafana/grafana.db')",
  );
  assert.match(error ?? 'the query read grafana.db', /LocalFileSystem/);
});

// Only http_client happens to open DuckDB's secret manager before the disk goes
// off; without it, the first remote read looked for persistent secrets on disk
// and failed. The initSql turns persistent secrets off first, so the sandbox
// keeps working when http_client is dropped (the stricter URL allowlist in the
// spec does exactly that).
test('remote reads keep working without http_client loaded', async () => {
  const provisioned = readFileSync(new URL('../../provisioning/datasources/datasources.yaml', import.meta.url), 'utf8');
  const initSql = provisioned.match(/initSql: "(.*)"/)[1].replace('LOAD http_client; ', '');
  // A fresh uid each run: the plugin keeps an instance per uid for a while, so a
  // datasource deleted and recreated under the same uid can still run the old initSql.
  const uid = `security-no-http-client-${Date.now()}`;
  const path = `/api/datasources/uid/${uid}`;
  const created = await api(STACK_URL, '/api/datasources', {
    method: 'POST',
    body: { name: uid, uid, type: 'motherduck-duckdb-datasource', access: 'proxy', jsonData: { path: '', initSql } },
  });
  assert.equal(created.status, 200, created.text);
  try {
    const sql = "SELECT count(*) AS n FROM read_csv_auto('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.csv')";
    const { json } = await api(STACK_URL, '/api/ds/query', { method: 'POST', body: dsQueryBody(sql, uid) });
    assert.equal(json.results.A.error, undefined);
  } finally {
    await api(STACK_URL, path, { method: 'DELETE' });
  }
});

// mcp logs into Grafana as admin. DuckDB runs inside the grafana container, so
// if that container could reach mcp, an anonymous query could drive it.
test('the grafana container cannot reach the MCP server', () => {
  let outcome;
  try {
    outcome = compose([
      'exec', '-T', 'grafana',
      'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', 'http://mcp:8000/mcp',
    ]);
  } catch {
    outcome = 'unreachable';
  }
  assert.equal(outcome, 'unreachable', `mcp answered the grafana container with HTTP ${outcome}`);
});
