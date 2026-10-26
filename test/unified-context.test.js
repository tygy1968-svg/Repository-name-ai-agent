import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OWNER_TELEGRAM_ID, createContextStore, selectMemories, channelCapabilities, falseCapabilityDenial } from '../unified-context.js';
import { isVoiceConnectionRequest, isOwnerTelegramMessage, OWNER_WORKSPACE_CHAT_ID, createVoiceAccess, createVoiceToolHandler, attachRealtimeTools, searchInternet, webhookSecret, validWebhookSecret } from '../channel-tools.js';

test('shared context works without embeddings, excludes refutations and model claims, isolates users', async () => {
  let reads = 0;
  const store = createContextStore({ url: 'https://db.invalid', key: 'fake', fetchImpl: async url => {
    reads++;
    const u = new URL(url);
    if (u.pathname.endsWith('/memory')) {
      assert.equal(u.searchParams.get('user_id'), `eq.${OWNER_TELEGRAM_ID}`);
      return Response.json([
        { id: 1, content: 'его', type: 'fact' },
        { id: 2, content: 'Опровергнутый бренд нельзя включать', type: 'refuted' },
        { id: 3, content: 'Юля подтвердила: Кузя позвонил брату Гене.', type: 'fact', source: JSON.stringify({ kind: 'owner_confirmed' }) }
      ]);
    }
    if (u.pathname.endsWith('/kuzia_interactions')) return Response.json([
      { id: 'a', event_type: 'telegram_message', telegram_user_id: OWNER_TELEGRAM_ID, stimulus: 'Что мы просили передать Гене?', response: 'Выдуманный совместный проект', timestamp: '2026-10-27' },
      { id: 'b', event_type: 'voice_user_transcript', stimulus: 'Чужая речь', metadata: {} },
      { id: 'c', event_type: 'telegram_message', telegram_user_id: 'other', stimulus: 'Чужая личная память' },
      { id: 'd', event_type: 'voice_user_transcript', stimulus: 'Продолжим про магазин', metadata: { ownerAuthenticated: true } }
    ]);
    return Response.json([]);
  } });
  assert.equal((await store.load({ userId: 'other' })).access, 'denied');
  assert.equal(reads, 0);
  const packet = await store.load({ userId: OWNER_TELEGRAM_ID, query: 'Гене' });
  assert.equal(packet.facts.length, 1);
  assert.equal(packet.facts[0].evidence, 'owner_confirmed');
  assert.equal(packet.userStatements.length, 2);
  assert.doesNotMatch(JSON.stringify(packet), /Выдуманный|Чужая|Опровергнутый/);
});

test('database outage is marked unavailable, not proof of empty memory', async () => {
  const store = createContextStore({ url: 'https://db.invalid', key: 'fake', fetchImpl: async () => new Response('', { status: 503 }) });
  const packet = await store.load({ userId: OWNER_TELEGRAM_ID });
  assert.equal(packet.partial, true); assert.equal(packet.unavailable.length, 4);
});

test('fact write failure preserves prior data; missing embeddings still allow insertion', async () => {
  const methods = [];
  let payload;
  const store = createContextStore({ url: 'https://db.invalid', key: 'fake', fetchImpl: async (_, options) => {
    methods.push(options.method); payload = JSON.parse(options.body)[0]; return new Response('', { status: 503 });
  } });
  await assert.rejects(store.appendFact({ userId: OWNER_TELEGRAM_ID, fact: 'Пользователь живет в Киеве', originalText: 'Я живу в Киеве' }), /503/);
  assert.deepEqual(methods, ['POST']);
  assert.equal(payload.embedding, null); assert.equal(payload.role, 'user');
  assert.equal(JSON.parse(payload.source).originalText, 'Я живу в Киеве');
});

test('supersession affects retrieval only; source list remains intact', () => {
  const rows = [{ id: 1, content: 'Юля живёт в старом городе', type: 'fact' },
    { id: 2, content: 'Юля живёт в новом городе', type: 'fact', source: JSON.stringify({ supersedes: [1] }) }];
  assert.deepEqual(selectMemories(rows).map(r => r.id), [2]); assert.equal(rows.length, 2);
});

test('voice access is one-use, expiring, bounded and never inferred from caller ID', () => {
  let now = 1000;
  const access = createVoiceAccess({ now: () => now, randomCode: () => '123456' });
  assert.throws(() => access.issue('other'));
  access.issue(OWNER_TELEGRAM_ID); assert.equal(access.has('call'), false);
  assert.equal(access.verify('call', '123456'), true);
  assert.equal(access.verify('other-call', '123456'), false);
  assert.equal(access.has('other-call'), false);
  now += 46 * 60000; assert.equal(access.has('call'), false);
  access.issue(OWNER_TELEGRAM_ID); for (let i=0;i<5;i++) assert.equal(access.verify('bad', '111111'), false);
  assert.equal(access.verify('call', '123456'), false);
  access.issue(OWNER_TELEGRAM_ID); now += 6 * 60000; assert.equal(access.verify('call', '123456'), false);
});

test('tools deny reads before pairing and return the same context after pairing', async () => {
  const access = createVoiceAccess({ randomCode: () => '123456' });
  access.issue(OWNER_TELEGRAM_ID);
  let reads = 0, searches = 0;
  const handler = createVoiceToolHandler({ callId: 'call', access, store: { load: async () => { reads++; return { facts: ['Кузя позвонил брату'] }; } }, search: async () => { searches++; return { ok: false, error: 'offline' }; } });
  assert.equal((await handler('read_shared_context', { query: 'Гена' })).ok, false); assert.equal(reads, 0);
  assert.equal((await handler('authenticate_owner', { code: '123456' })).authenticated, true);
  assert.match((await handler('read_shared_context', { query: 'Гена' })).context, /позвонил брату/);
  assert.equal((await handler('search_internet', { query: 'weather' })).error, 'offline');
  assert.equal(searches, 1);
  assert.equal((await handler('start_call', {})).error, 'unknown_tool');
});

test('sideband executes only completed function calls once and returns result before response', async () => {
  const socket = new EventEmitter(), sent = []; socket.send = text => sent.push(JSON.parse(text));
  let count = 0;
  const tools = attachRealtimeTools(socket, async (name, args) => { count++; assert.equal(name, 'read_shared_context'); return { ok: true, query: args.query }; });
  const event = { type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'fc1', name: 'read_shared_context', arguments: '{"query":"Гена"}' }] } };
  socket.emit('message', JSON.stringify(event)); socket.emit('message', JSON.stringify(event));
  await tools.flush();
  assert.equal(count, 1); assert.equal(sent[0].item.type, 'function_call_output');
  assert.equal(sent[0].item.call_id, 'fc1'); assert.equal(sent[1].type, 'response.create');
  socket.emit('close');
});

test('internet retains URLs and dates and distinguishes provider errors from empty results', async () => {
  const success = await searchInternet('news', { apiKey: 'fake', fetchImpl: async () => Response.json({ organic_results: [{ title: 'News', snippet: 'Result', link: 'https://example.com' }] }) });
  assert.equal(success.ok, true); assert.equal(success.results[0].url, 'https://example.com'); assert.ok(success.checkedAt);
  assert.equal((await searchInternet('news', { apiKey: 'fake', fetchImpl: async () => Response.json({ error: 'quota' }) })).ok, false);
  assert.equal((await searchInternet('news', {})).error, 'internet_not_configured');
});

test('Telegram delivery authentication cannot be forged by an owner ID in a JSON body', () => {
  const secret = webhookSecret('fake-token');
  assert.equal(validWebhookSecret('', secret), false);
  assert.equal(validWebhookSecret('1087968824', secret), false);
  assert.equal(validWebhookSecret(secret, secret), true);
});

test('owner can use existing workspace and private chat, but other members and groups remain isolated', () => {
  const message = { from: { id: OWNER_TELEGRAM_ID }, chat: { id: OWNER_WORKSPACE_CHAT_ID, type: 'supergroup' } };
  assert.equal(isOwnerTelegramMessage(message), true);
  assert.equal(isOwnerTelegramMessage({ ...message, from: { id: 'other' } }), false);
  assert.equal(isOwnerTelegramMessage({ ...message, chat: { id: '-1', type: 'supergroup' } }), false);
  assert.equal(isOwnerTelegramMessage({ ...message, chat: { id: OWNER_TELEGRAM_ID, type: 'private' } }), true);
  assert.equal(isOwnerTelegramMessage({ ...message, chat: { id: OWNER_WORKSPACE_CHAT_ID, type: 'channel' } }), false);
});

test('voice setup recognizes the actual user phrasing before it reaches a text model', () => {
  for (const text of ['/voice', '/voice@kuzya_echo_bot', 'Voice 12345', 'Личный код 12345', 'подключи телефон', 'Пришли код для звонка']) assert.equal(isVoiceConnectionRequest(text), true, text);
  for (const text of ['Что значит voice?', 'Я читала про команду /voice', 'Позвони Гене', '12345']) assert.equal(isVoiceConnectionRequest(text), false, text);
});

test('capability facts distinguish an enabled phone from authorization and channel limitations', () => {
  assert.match(channelCapabilities('Telegram', true), /Входящие телефонные звонки ПОДКЛЮЧЕНЫ/);
  assert.match(channelCapabilities('phone', false), /Telegram ПОДКЛЮЧЁН/);
  assert.equal(falseCapabilityDenial('Я не могу принимать входящие звонки.'), true);
  assert.equal(falseCapabilityDenial('Я не умею звонить.'), true);
  assert.equal(falseCapabilityDenial('Я пока не могу звонить без подтверждения.'), false);
  assert.equal(falseCapabilityDenial('Личная память в этом звонке пока закрыта.'), false);
});

test('failed authentication is auditable without recording the supplied code', async () => {
  const audit = [];
  const handler = createVoiceToolHandler({ callId: 'test', access: createVoiceAccess(), store: {}, onResult: async row => audit.push(row) });
  assert.equal((await handler('authenticate_owner', { code: '12345' })).error, 'authentication_failed');
  assert.equal(audit[0].error, 'authentication_failed');
  assert.doesNotMatch(JSON.stringify(audit), /12345/);
});
