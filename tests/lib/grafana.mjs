// Talking to Grafana's HTTP API from the tests.
import { request as httpRequest } from 'node:http';

export const ADMIN = {
  user: process.env.GF_SECURITY_ADMIN_USER ?? 'admin',
  password: process.env.GF_SECURITY_ADMIN_PASSWORD ?? 'admin',
};

export function basicAuth({ user, password } = ADMIN) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

export async function api(base, path, { method = 'GET', body, anonymous = false, headers = {} } = {}) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(anonymous ? {} : { authorization: basicAuth() }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

// POST /api/ds/query body for one raw SQL query, the way the dashboards send it.
export function dsQueryBody(rawSql, datasourceUid = 'duckdb', type = 'motherduck-duckdb-datasource') {
  return {
    queries: [{ refId: 'A', datasource: { uid: datasourceUid, type }, rawSql, rawQuery: true, format: 1 }],
    from: 'now-5m',
    to: 'now',
  };
}

// Rows of refId A's first frame as plain objects. Throws with the datasource's
// own error text, which is what a failing test should show.
export function rowsOf(json) {
  const result = json?.results?.A;
  if (!result) throw new Error(`no result for A: ${JSON.stringify(json).slice(0, 500)}`);
  if (result.error) throw new Error(result.error);
  const frame = result.frames[0];
  const names = frame.schema.fields.map((field) => field.name);
  const columns = frame.data.values;
  const count = columns[0]?.length ?? 0;
  return Array.from({ length: count }, (_, i) => Object.fromEntries(names.map((name, j) => [name, columns[j][i]])));
}

export async function duckdb(base, rawSql) {
  const { status, json, text } = await api(base, '/api/ds/query', { method: 'POST', body: dsQueryBody(rawSql) });
  if (status !== 200) throw new Error(`/api/ds/query ${status}: ${text.slice(0, 500)}`);
  return rowsOf(json);
}

// A GET that may set Host or Upgrade, which fetch() will not. Resolves on the
// status line and drops the body.
export function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      res.destroy();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}
