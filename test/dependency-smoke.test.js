import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { once } from 'node:events';
import * as agents from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';

// Evaluate the actual application with fake credentials and outbound fetch blocked.
// LiveKit connection startup is intercepted before any room or call is created.
async function loadApplication(filename, overrides = {}, env = {}) {
  const outbound = [];
  const context = createContext({
    console: { log() {}, error() {}, warn() {}, info() {} },
    process: { env, argv: ['node', filename] },
    Buffer, URL, URLSearchParams, Headers, Request, Response,
    AbortController, AbortSignal, FormData, Blob, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
    fetch: async (url, options = {}) => {
      outbound.push({ url: String(url), method: options.method || 'GET' });
      assert.ok(String(url).startsWith('https://database.invalid/'),
        'unexpected outbound request: ' + url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const url = new URL('../' + filename, import.meta.url);
  const source = await readFile(url, 'utf8');
  const module = new SourceTextModule(source, {
    context, identifier: url.href,
    initializeImportMeta(meta) { meta.url = url.href; }
  });
  await module.link(async (specifier) => {
    const exports = overrides[specifier] || await import(specifier);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { exports: module.namespace, outbound };
}

test('real agent creates its voice session and serializable endCall tool', async (t) => {
  agents.initializeLogger({ pretty: false, level: 'silent' });
  const stop = new Error('stop before connecting voice session');
  let startedAgent;
  let cliOptions;
  t.mock.method(agents.voice.AgentSession.prototype, 'start', async function ({ agent }) {
    startedAgent = agent;
    throw stop;
  });
  class OfflineRealtimeModel extends openai.realtime.RealtimeModel {
    constructor(options) { super({ ...options, apiKey: 'test-not-a-real-key' }); }
  }
  const app = await loadApplication('agent.js', {
    '@livekit/agents': { ...agents, cli: { ...agents.cli, runApp(options) { cliOptions = options; } } },
    '@livekit/agents-plugin-openai': {
      ...openai, realtime: { ...openai.realtime, RealtimeModel: OfflineRealtimeModel }
    }
  }, { SUPABASE_URL: 'https://database.invalid', SUPABASE_KEY: 'test-only' });
  assert.ok(cliOptions, 'application still configures its CLI worker');
  await assert.rejects(app.exports.default.entry({
    job: { metadata: JSON.stringify({ instruction: 'Offline compatibility test' }) },
    room: { name: 'offline-test' },
    connect: async () => {}
  }), (error) => error === stop);
  assert.ok(startedAgent instanceof agents.voice.Agent);
  const tool = startedAgent.toolCtx.getFunctionTool('endCall');
  assert.ok(tool, 'endCall remains registered after the LiveKit upgrade');
  const schema = agents.llm.toJsonSchema(tool.parameters);
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.reason.type, 'string');
  assert.ok(tool.parameters.safeParse({ reason: 'goodbye' }).success);
  assert.ok(!tool.parameters.safeParse({ reason: 123 }).success);
  assert.ok(app.outbound.length > 0, 'agent exercised the mocked memory path');
});

test('real HTTP server starts, serves the voice UI, and acknowledges an empty webhook', async (t) => {
  const express = (await import('express')).default;
  let server;
  const wrapper = Object.assign(function () {
    const app = express();
    const listen = app.listen.bind(app);
    app.listen = (...args) => { server = listen(...args); return server; };
    return app;
  }, express);
  const app = await loadApplication('server.js', { express: { default: wrapper } }, {
    PORT: 0, TELEGRAM_TOKEN: 'test-only', OPENAI_API_KEY: 'test-only',
    SUPABASE_URL: 'https://database.invalid', SUPABASE_KEY: 'test-only'
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + '/realtime-test');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Kuzya Realtime Test/);
  const webhook = await fetch(base + '/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(webhook.status, 200);
  assert.equal(app.outbound.length, 0, 'readiness checks must not send messages or write memory');
});
