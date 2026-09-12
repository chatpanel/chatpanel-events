import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, mcpProvider } from '../mcp-client.js';

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const out = handler(String(url), calls.at(-1));
    return {
      ok: out.status ? out.status < 300 : true, status: out.status || 200, url: String(url),
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : k === 'Mcp-Session-Id' ? out.sid || null : null) },
      json: async () => out.body, text: async () => JSON.stringify(out.body), body: { cancel: async () => {} },
    };
  };
  f.calls = calls;
  return f;
}

test('a stdio server goes through the bridge with the bridge token, and the provider prefixes its tools', async () => {
  const fetchImpl = fakeFetch((url, c) => {
    const m = c.body.message;
    if (m.method === 'initialize') return { body: { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fs' } } } };
    if (m.id == null) return { status: 202, body: null };
    if (m.method === 'tools/list') return { body: { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] } } };
    if (m.method === 'tools/call') return { body: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `contents of ${m.params.arguments.path}` }] } } };
    return { body: { jsonrpc: '2.0', id: m.id, error: { code: -1, message: 'nope' } } };
  });
  const c = new McpClient({ transport: 'stdio', id: 'fs', command: 'npx', args: ['-y', 'x'], bridgeUrl: 'http://127.0.0.1:4319', bridgeToken: 'tok', fetchImpl });
  await c.connect();
  const tools = await c.listTools();
  assert.equal(tools.length, 1);
  assert.ok(fetchImpl.calls.every((x) => x.url === 'http://127.0.0.1:4319/mcp-local'), 'every message went to the bridge');
  assert.ok(fetchImpl.calls.every((x) => x.headers.Authorization === 'Bearer tok'), 'as the desktop, with the bridge token');
  assert.equal(fetchImpl.calls[0].body.server.command, 'npx');
  const p = mcpProvider(c, 'Files');
  assert.equal(p.specs[0].name, 'mcp_files__read_file');
  assert.equal(p.remote, true);
  const out = await p.execute('mcp_files__read_file', { path: '/tmp/a' });
  assert.match(String(typeof out === 'string' ? out : out.text), /contents of \/tmp\/a/);
});

test('an http server is fetched directly, with no bridge token on the wire', async () => {
  const fetchImpl = fakeFetch((url, c) => {
    const m = c.body;
    if (m.method === 'initialize') return { sid: 's1', body: { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'r' } } } };
    if (m.id == null) return { status: 202, body: null };
    return { body: { jsonrpc: '2.0', id: m.id, result: { tools: [] } } };
  });
  const c = new McpClient({ url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer api' }, bridgeToken: 'tok', fetchImpl });
  await c.connect();
  assert.equal(fetchImpl.calls[0].url, 'https://mcp.example.com/mcp');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer api', 'the server\'s own header, never the bridge token');
  assert.equal(c.sessionId, 's1');
});
