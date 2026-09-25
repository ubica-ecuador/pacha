import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:8000/mcp';
const TOKEN = process.env.PACHA_MCP_TOKEN ?? 'pacha-local';
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pacha-tests', version: '0.0.0' } };

// One JSON-RPC message over streamable HTTP. The reply may come as plain JSON
// or as server-sent events; either way, pick the message with our id.
async function rpc(message, { token = TOKEN, session } = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  let reply;
  if (message.id !== undefined && res.ok) {
    const bodies = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
      : [text];
    reply = bodies
      .map((body) => {
        try {
          return JSON.parse(body);
        } catch {
          return undefined;
        }
      })
      .find((m) => m?.id === message.id);
  }
  return { status: res.status, session: res.headers.get('mcp-session-id') ?? session, reply };
}

async function session() {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT });
  assert.equal(init.status, 200);
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session: init.session });
  return init.session;
}

test('refuses callers without the token', async () => {
  const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }, { token: null });
  assert.equal(status, 401);
});

test('offers the dashboard-building tools, and not the ones left off', async () => {
  const id = await session();
  const { reply } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { session: id });
  const names = reply.result.tools.map((tool) => tool.name);
  for (const name of ['search_dashboards', 'get_dashboard_by_uid', 'update_dashboard', 'list_datasources', 'run_panel_query']) {
    assert.ok(names.includes(name), `${name} missing from ${names.join(', ')}`);
  }
  assert.ok(!names.includes('query_prometheus'), 'prometheus tools should be off');
});

test('reaches Grafana with the admin credentials', async () => {
  const id = await session();
  const { reply } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_datasources', arguments: {} } }, { session: id });
  assert.match(JSON.stringify(reply.result), /duckdbwasm/);
});

test('is published on loopback only', () => {
  const config = JSON.parse(compose(['config', '--format', 'json']));
  const [port] = config.services.mcp.ports;
  assert.equal(port.host_ip, '127.0.0.1');
  assert.equal(String(port.published), '8000');
});
