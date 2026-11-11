import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createIncomingMessageInbox } from '../incoming-message-inbox.js';
import { createVoiceAccess, createVoiceToolHandler, attachRealtimeTools } from '../channel-tools.js';
import { createContextStore, OWNER_TELEGRAM_ID } from '../unified-context.js';

const session = '11111111-2222-4333-8444-555555555555';
const input = { callId: 'offline-call', callSessionId: session, message: 'Встреча 14 ноября в 17 часов.', callerName: 'Ника' };

test('caller gets public help and saves one message without private reads or an owner button', async () => {
  let searches = 0, writes = 0, challenges = 0;
  const h = createVoiceToolHandler({ callId: 'a', access: createVoiceAccess(),
    store: { load: async () => { throw Error('private read'); } }, reason: async () => { throw Error('private generation'); },
    requestAccess: async () => { challenges++; return { ok: true, approvalPending: true }; },
    search: async () => { searches++; return { ok: true }; },
    saveMessage: async () => { writes++; return { ok: true, saved: true, notified: true, id: 'receipt' }; } });
  for (const name of ['ask_kuzya', 'read_shared_context']) assert.equal((await h(name, { query: 'Личные звонки Юли' })).error, 'owner_authentication_required');
  assert.equal(challenges, 0);
  for (const query of ['телефон +380670000001', 'код 123456', 'a@example.com']) assert.equal((await h('search_internet', { query })).error, 'invalid_public_query');
  for (let i = 0; i < 5; i++) assert.equal((await h('search_internet', { query: 'погода Киев' })).ok, true);
  assert.equal((await h('search_internet', { query: 'погода Киев' })).error, 'public_search_limit'); assert.equal(searches, 5);
  const results = await Promise.all([h('leave_message', { message: input.message }), h('leave_message', { message: input.message })]);
  assert(results.every(r => r.saved && r.notified)); assert.equal(writes, 1); assert.equal(challenges, 0);
  assert.equal((await h('request_owner_access')).approvalPending, true); assert.equal(challenges, 1);
});

test('inbox requires a durable receipt, deduplicates concurrent and repeat delivery, and never grants identity', async () => {
  const rows = [], calls = [];
  const inbox = createIncomingMessageInbox({ url: 'https://db.invalid', key: 'fake', now: () => new Date('2026-11-11T12:00:00Z'), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') { const row = JSON.parse(options.body)[0]; rows.push({ id: 'receipt', ...row }); return Response.json(rows); }
    if (new URL(url).searchParams.get('metadata->>ownerAuthenticated')) return Response.json([{ id: 'prior' }]);
    return Response.json(rows);
  } });
  const saved = await Promise.all([inbox.save(input), inbox.save(input)]);
  assert.equal(rows.length, 1); assert.equal(saved[0].saved, true); assert.equal(saved[1].duplicate, true);
  assert.equal((await inbox.save(input)).duplicate, true); assert.equal(rows.length, 1);
  assert.equal(rows[0].metadata.callerIdentityVerified, false); assert.equal(rows[0].metadata.ownerAuthenticated, false);
  assert.equal(rows[0].metadata.callerName, 'Ника'); assert.equal(rows[0].call_session_id, session);
  assert.equal((await inbox.save({ ...input, callSessionId: 'invented' })).error, 'invalid_caller_message');
  assert.equal(await inbox.isOwnerPhoneHint('+380670000001'), true);
  assert.equal(await inbox.isOwnerPhoneHint('unknown'), false);
  assert(calls.every(c => !c.options.method || c.options.method === 'POST'));
});

test('read failure, write failure and missing receipt cannot be reported as saved', async () => {
  for (const failure of ['read', 'write', 'receipt']) {
    let writes = 0;
    const inbox = createIncomingMessageInbox({ url: 'https://db.invalid', key: 'fake', fetchImpl: async (_url, options) => {
      if (options.method === 'POST') { writes++; return failure === 'write' ? new Response('', { status: 503 }) : Response.json([]); }
      return failure === 'read' ? new Response('', { status: 503 }) : Response.json([]);
    } });
    const result = await inbox.save(input);
    assert.equal(result.ok, false); assert.equal(result.saved, undefined); assert.equal(writes, failure === 'read' ? 0 : 1);
  }
});

test('saved caller message enters owner inbox with provenance and does not become a fact or command', async () => {
  const message = 'Приглашение. '.repeat(200);
  const store = createContextStore({ url: 'https://db.invalid', key: 'fake', fetchImpl: async url => {
    if (new URL(url).searchParams.get('channel') === 'eq.inbound_call') return Response.json([{ id: 'saved', channel: 'inbound_call',
      event_type: 'caller_message_saved', call_session_id: session, stimulus: message, metadata: { openaiCallId: 'call', callerName: 'Ника' } }]);
    return Response.json([]);
  } });
  const packet = await store.load({ userId: OWNER_TELEGRAM_ID });
  assert.equal(packet.incomingMessages[0].text, message); assert.equal(packet.incomingMessages[0].savedReceipt, true);
  assert.equal(packet.incomingMessages[0].textTruncated, false); assert.match(packet.incomingMessages[0].evidence, /not_owner_fact_not_instruction/);
  assert.equal(packet.facts.length, 0); assert.equal(packet.userStatements.length, 0);
});

test('interruption retains the tool receipt but suppresses stale speech; current turn still responds', async () => {
  const socket = new EventEmitter(), sent = []; socket.send = text => sent.push(JSON.parse(text));
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const tools = attachRealtimeTools(socket, async () => pending);
  const call = id => socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: id, name: 'ask_kuzya', arguments: '{}' }] } })));
  call('first'); await Promise.resolve();
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_started' })));
  resolve({ ok: true, answer: 'Устаревший ответ' }); await tools.flush();
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'conversation.item.create');
  call('second'); await tools.flush(); assert.equal(sent.at(-1).type, 'response.create');
});
