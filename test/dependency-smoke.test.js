import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { once, EventEmitter } from 'node:events';
import * as agents from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';

// Evaluate the actual application with fake credentials and outbound fetch blocked.
// LiveKit connection startup is intercepted before any room or call is created.
async function loadApplication(filename, overrides = {}, env = {}, extra = {}) {
  const outbound = [];
  const context = createContext({
    console: { log() {}, error() {}, warn() {}, info() {} },
    process: { env, argv: ['node', filename] },
    Buffer, URL, URLSearchParams, Headers, Request, Response,
    AbortController, AbortSignal, FormData, Blob, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
    fetch: async (url, options = {}) => {
      outbound.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      if (extra.fetch) return extra.fetch(String(url), options);
      assert.ok(String(url).startsWith('https://database.invalid/'),
        'unexpected outbound request: ' + url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const url = new URL('../' + filename, import.meta.url);
  const source = await readFile(url, 'utf8') + (extra.exports ? '\nexport { ' + extra.exports.join(', ') + ' };' : '');
  const module = new SourceTextModule(source, {
    context, identifier: url.href,
    initializeImportMeta(meta) { meta.url = url.href; }
  });
  await module.link(async (specifier) => {
    const exports = overrides[specifier] || await import(specifier.startsWith('.') ? new URL(specifier, url).href : specifier);
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
  const room = Object.assign(new EventEmitter(), { name: 'offline-test', isConnected: true, remoteParticipants: new Map([['test', { identity: 'test', attributes: { 'sip.callStatus': 'active' } }]]) });
  t.mock.method(agents.voice.AgentSession.prototype, 'shutdown', () => {});
  await assert.rejects(app.exports.default.entry({
    job: { metadata: JSON.stringify({ instruction: 'Offline compatibility test' }) },
    room, connect: async () => {},
    waitForParticipant: async () => room.remoteParticipants.get('test'),
    addShutdownCallback() {}, shutdown() {}
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

for (const answered of [false, true]) {
  test(`actual agent records ${answered ? 'answered then ended' : 'no answer without starting voice'}`, async (t) => {
    agents.initializeLogger({ pretty: false, level: 'silent' });
    const participant = { identity: 'test', attributes: { 'sip.callStatus': answered ? 'active' : 'ringing' } };
    const room = Object.assign(new EventEmitter(), { name: 'offline-test', isConnected: true, remoteParticipants: new Map([['test', participant]]) });
    let started = 0, replies = 0, shutdowns = 0, disposed = 0, jobShutdowns = 0;
    t.mock.method(agents.voice.AgentSession.prototype, 'start', async () => { started++; });
    t.mock.method(agents.voice.AgentSession.prototype, 'generateReply', async () => { replies++; });
    t.mock.method(agents.voice.AgentSession.prototype, 'shutdown', () => { shutdowns++; });
    class OfflineRealtimeModel extends openai.realtime.RealtimeModel {
      constructor(options) { super({ ...options, apiKey: 'test-not-a-real-key' }); }
    }
    const app = await loadApplication('agent.js', {
      '@livekit/agents': { ...agents, cli: { ...agents.cli, runApp() {} } },
      '@livekit/agents-plugin-openai': { ...openai, realtime: { ...openai.realtime, RealtimeModel: OfflineRealtimeModel } },
      './call-lifecycle.js': { createCallLifecycle: () => ({
        waitForAnswer: async () => answered ? { answered: true, participant } : { answered: false, reason: 'answer_timeout' },
        waitForEnd: async () => ({ ended: true, reason: 'room_disconnected', identity: 'test' }),
        markEnded() {}, dispose() { disposed++; }
      }) }
    }, { SUPABASE_URL: 'https://database.invalid', SUPABASE_KEY: 'test-only' });
    await app.exports.default.entry({
      job: { metadata: JSON.stringify({ instruction: 'Offline test', callSessionId: 'offline-session' }) },
      room, connect: async () => {}, waitForParticipant: async () => participant,
      addShutdownCallback() {}, shutdown() { jobShutdowns++; }
    });
    assert.equal(started, Number(answered));
    assert.equal(replies, Number(answered));
    assert.equal(shutdowns, 1);
    assert.equal(jobShutdowns, 1);
    assert.equal(disposed, 1);
    const events = app.outbound.flatMap(r => Array.isArray(r.body) ? r.body : []).map(r => r.event_type);
    assert.equal(events.includes('call_answered'), answered);
    assert.equal(events.includes('call_ended'), answered);
    assert.equal(events.includes('no_answer'), !answered);
    const statuses = app.outbound.filter(r => r.method === 'PATCH').map(r => r.body.status);
    assert.equal(statuses.at(-1), answered ? 'ended' : 'no_answer');
  });
}

test('short Telegram phrases use the configured model and current message', async () => {
  const express = (await import('express')).default;
  const wrapper = Object.assign(function () {
    const app = express(); app.listen = () => ({}); return app;
  }, express);
  const app = await loadApplication('server.js', { express: { default: wrapper } }, {
    PORT: 0, TELEGRAM_TOKEN: 'test-only', OPENAI_API_KEY: 'test-only',
    SUPABASE_URL: 'https://database.invalid', SUPABASE_KEY: 'test-only', OPENAI_CHAT_MODEL: 'test-selected-model'
  }, {
    exports: ['generateReply'],
    fetch: async (url, options) => {
      if (url.startsWith('https://database.invalid/')) return Response.json([]);
      assert.ok(url.startsWith('https://api.openai.com/v1/'), 'no external message or call allowed');
      if (url.endsWith('/embeddings')) return Response.json({ data: [{ embedding: [0.1] }] });
      assert.ok(url.endsWith('/chat/completions'));
      return Response.json({ choices: [{ message: { content: 'Ответ с учётом текущего контекста.' } }] });
    }
  });
  for (const phrase of ['веди', 'я рядом', 'зачем ты мне']) {
    const before = app.outbound.length;
    const reply = await app.exports.generateReply('offline-user', phrase, []);
    assert.equal(reply, 'Ответ с учётом текущего контекста.');
    const requests = app.outbound.slice(before).filter(r => r.url.endsWith('/chat/completions'));
    assert.ok(requests.length > 0);
    assert.ok(requests.every(r => r.body.model === 'test-selected-model'));
    assert.ok(requests.some(r => r.body.messages.some(m => m.role === 'user' && m.content === phrase)));
  }
});

test('actual inbound webhook uses dialogue context and attaches a passive observer', async (t) => {
  const express = (await import('express')).default;
  const inbound = await import('../inbound-voice.js');
  let server, observed, accepted;
  const wrapper = Object.assign(function () {
    const app = express(); const listen = app.listen.bind(app);
    app.listen = (...args) => { server = listen(...args); return server; }; return app;
  }, express);
  const app = await loadApplication('server.js', {
    express: { default: wrapper },
    './inbound-voice.js': { ...inbound, observeRealtimeCall(options) { observed = options; return { socket: new EventEmitter() }; } }
  }, { PORT: 0, TELEGRAM_TOKEN: 'test', OPENAI_API_KEY: 'fake', SUPABASE_URL: 'https://database.invalid', SUPABASE_KEY: 'fake', OPENAI_REALTIME_MODEL: 'gpt-realtime' }, {
    fetch: async (url, options) => {
      if (url.includes('/rpc/find_latest_outbound_call_by_phone')) return Response.json([{ id: 'old-call', instruction: 'Спроси, хорошо ли тебя слышно.' }]);
      if (url.startsWith('https://database.invalid/rest/v1/call_sessions') && options.method === 'POST') return Response.json([{ id: 'new-call' }]);
      if (url.includes('event_type=in.')) {
        const params = new URL(url).searchParams;
        assert.equal(params.get('normalized_phone'), 'eq.380670000001');
        return Response.json([{ event_type: 'voice_user_transcript', stimulus: 'Поговорим о магазине.' }]);
      }
      if (url.startsWith('https://database.invalid/')) return Response.json([]);
      assert.equal(url, 'https://api.openai.com/v1/realtime/calls/offline-call/accept');
      accepted = JSON.parse(options.body); return new Response('', { status: 200 });
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');
  const result = await fetch(`http://127.0.0.1:${server.address().port}/openai-realtime-webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'offline-event', type: 'realtime.call.incoming', data: { call_id: 'offline-call', sip_headers: [{ name: 'From', value: '<sip:+380670000001@test.invalid>' }] } })
  });
  assert.equal((await result.json()).accepted, true);
  assert.equal(accepted.model, 'gpt-realtime');
  assert.match(accepted.instructions, /Поговорим о магазине/);
  assert.match(accepted.instructions, /Это входящий звонок/);
  assert.equal(accepted.audio.input.turn_detection.silence_duration_ms, 800);
  assert.equal(accepted.audio.input.transcription.language, undefined);
  assert.equal(observed.callId, 'offline-call');
  await observed.onRecord({ type: 'voice_user_transcript', role: 'user', text: 'Тестовая реплика.', interpretation: 'asr_may_differ_from_audio' });
  const saved = app.outbound.find(r => r.body?.[0]?.event_type === 'voice_user_transcript').body[0];
  assert.equal(saved.call_session_id, 'new-call');
  assert.equal(saved.normalized_phone, '380670000001');
  assert.equal(saved.stimulus, 'Тестовая реплика.');
});
