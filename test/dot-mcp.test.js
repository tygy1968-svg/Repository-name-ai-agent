import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDotMcpRouter } from '../bridge/mcp-router.js';
import { createTaskQueue } from '../bridge/task-queue.js';
import { createJsonStore } from '../bridge/json-store.js';

const resourceUrl = 'https://bridge.example/dot/mcp';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kuzya-mcp-'));
  const queue = createTaskQueue({ store: createJsonStore(join(dir, 'state.json')) });
  const principals = new Map([
    ['owner-token', { ownerId: 'owner', workerId: 'dot', scopes: ['kuzya.tasks'] }],
    ['other-token', { ownerId: 'other', workerId: 'other-dot', scopes: ['kuzya.tasks'] }],
    ['memory-token', { ownerId: 'owner', workerId: 'dot', scopes: ['kuzya.memory.read'] }],
    ['no-scope', { ownerId: 'owner', workerId: 'dot', scopes: [] }]
  ]);
  let reads = 0, checks = 0;
  const app = express();
  app.use(createDotMcpRouter({ queue, resourceUrl, authorizationServer: 'https://identity.example',
    authenticate: async token => { checks++; return principals.get(token); },
    readContext: async ({ ownerId }) => { reads++; return { ownerId, partial: true, source: 'synthetic' }; } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  // node:http preserves the explicit Host needed to test the public URL on a
  // loopback socket; fetch/Undici may replace Host with the socket destination.
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(url + path, { method: options.method || 'GET', headers: { host: 'bridge.example', ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    req.on('error', reject); req.end(options.body);
  });
  const rpc = async (method, params = {}, token = 'owner-token') => {
    const response = await request('/dot/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25'
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return { status: response.status, data: await response.json() };
  };
  const call = async (name, args = {}, token) => rpc('tools/call', { name, arguments: args }, token);
  const enqueue = () => queue.enqueue({ ownerId: 'owner', ownerVerified: true, requestId: 'synthetic-1', question: 'Синтетическая встреча', source: 'synthetic_pilot' });
  return { queue, principals, request, rpc, call, enqueue, reads: () => reads, checks: () => checks };
}

test('HTTP MCP discovery and authentication fail closed before body parsing or private reads', async t => {
  const h = await fixture(t);
  const discovery = await h.request('/.well-known/oauth-protected-resource/dot/mcp');
  assert.equal(discovery.status, 200);
  assert.deepEqual(await discovery.json(), { resource: resourceUrl, authorization_servers: ['https://identity.example/'],
    scopes_supported: ['kuzya.tasks', 'kuzya.memory.read'], bearer_methods_supported: ['header'] });
  const denied = await h.request('/dot/mcp', { method: 'POST', body: '{bad' });
  assert.equal(denied.status, 401); assert.match(denied.headers.get('www-authenticate'), /resource_metadata="https:\/\/bridge.example\//);
  assert.equal((await h.rpc('tools/list', {}, 'bad-token')).status, 401);
  assert.equal((await h.rpc('tools/list', {}, 'no-scope')).status, 403);
  assert.equal((await h.request('/dot/mcp', { headers: { host: 'attacker.example' } })).status, 403);
  assert.equal((await h.request('/dot/mcp', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await h.request('/dot/mcp', { headers: { authorization: 'Bearer owner-token' } })).status, 405);
  assert.equal(h.reads(), 0);
});

test('official SDK completes an HTTP task round trip with scope isolation and idempotency', async t => {
  const h = await fixture(t), { task } = await h.enqueue();
  const init = await h.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1' } });
  assert.equal(init.status, 200); assert.equal(init.data.result.serverInfo.name, 'kuzya-dot-bridge');
  assert(!init.data.result.capabilities.events, 'no events are advertised before persistent subscriptions exist');
  const listed = await h.rpc('tools/list'); assert.equal(listed.status, 200);
  assert.equal(listed.data.result.tools.length, 4);
  assert(!listed.data.result.tools.some(tool => tool.name === 'kuzya_read_context'));
  assert.deepEqual((await h.call('kuzya_list_tasks', {}, 'other-token')).data.result.structuredContent.tasks, []);
  assert.equal((await h.call('kuzya_claim_task', { task_id: task.id }, 'other-token')).data.result.structuredContent.error, 'task_not_found');
  const claim = (await h.call('kuzya_claim_task', { task_id: task.id })).data.result.structuredContent.task;
  const args = { task_id: task.id, lease_token: claim.lease.token, result_id: 'synthetic-result', answer: 'Ответ через HTTP.', sources: ['synthetic'] };
  assert.equal((await h.call('kuzya_complete_task', args)).data.result.structuredContent.duplicate, false);
  assert.equal((await h.call('kuzya_complete_task', args)).data.result.structuredContent.duplicate, true);
  assert.equal((await h.call('kuzya_complete_task', { ...args, answer: 'Перезапись' })).data.result.structuredContent.error, 'idempotency_conflict');
  assert.equal((await h.queue.takeResult({ ownerId: 'owner', ownerVerified: true, taskId: task.id, destination: 'telegram_owner' })).answer, 'Ответ через HTTP.');
  assert.equal((await h.call('kuzya_bridge_status')).data.result.structuredContent.dotConnected, false);
});

test('HTTP schemas, context scope, revocation and request bounds protect the queue', async t => {
  const h = await fixture(t);
  const memoryTools = await h.rpc('tools/list', {}, 'memory-token');
  assert.deepEqual(memoryTools.data.result.tools.map(tool => tool.name), ['kuzya_read_context']);
  assert((await h.call('kuzya_read_context', { query: 'synthetic' })).data.error, 'ungranted tool is not registered');
  const invalid = await h.call('kuzya_read_context', { query: 'synthetic', ownerId: 'forged' }, 'memory-token');
  assert(invalid.data.error || invalid.data.result?.isError); assert.equal(h.reads(), 0);
  assert.equal((await h.call('kuzya_read_context', { query: 'synthetic' }, 'memory-token')).data.result.structuredContent.context.partial, true);
  assert.equal(h.reads(), 1);
  h.principals.delete('memory-token');
  assert.equal((await h.call('kuzya_read_context', { query: 'synthetic' }, 'memory-token')).status, 401);
  const headers = { authorization: 'Bearer owner-token', 'content-type': 'application/json' };
  assert.equal((await h.request('/dot/mcp', { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal((await h.request('/dot/mcp', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(40000) }) })).status, 413);
});

test('MCP router cannot start with missing verifier or non-HTTPS identity/resource URLs', () => {
  const config = { queue: {}, authenticate: async () => null, resourceUrl, authorizationServer: 'https://identity.example' };
  assert.throws(() => createDotMcpRouter({ ...config, authenticate: null }), /verified_auth/);
  assert.throws(() => createDotMcpRouter({ ...config, resourceUrl: 'http://bridge.example/mcp' }), /https_url/);
  assert.throws(() => createDotMcpRouter({ ...config, authorizationServer: 'https://user:pass@identity.example' }), /https_url/);
});
