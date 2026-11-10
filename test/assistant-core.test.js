import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantCore, VOICE_CORE_RULES, SHARED_CORE_VERSION } from '../assistant-core.js';
import { OWNER_TELEGRAM_ID } from '../unified-context.js';

const options = text => ({ userId: OWNER_TELEGRAM_ID, text, channel: 'telegram' });
const packet = () => ({ access: 'owner', facts: [], userStatements: [], calls: [], unavailable: [], recentDialog: [] });

test('Telegram and phone use one executor, model function, context and ordered conversation', async () => {
  const requests = [], contexts = [];
  const core = createAssistantCore({ store: { load: async request => { contexts.push(request); return packet(); } },
    complete: async messages => { requests.push(messages); return 'Ответ на ' + messages.at(-1).content; } });
  const first = await core.respond(options('Запомни наш план'));
  const second = await core.respond({ ...options('Продолжим тот же план'), channel: 'phone' });
  const third = await core.respond(options('Что ты предложил в звонке?'));
  assert.equal(first.core, SHARED_CORE_VERSION); assert.equal(second.core, first.core);
  assert.equal(third.core, first.core); assert.equal(contexts.length, 3);
  assert(requests[1].some(row => row.role === 'assistant' && row.content === first.answer));
  assert(requests[2].some(row => row.role === 'assistant' && row.content === second.answer));
  assert.match(requests[1][0].content, /Сейчас канал Телефон/);
  assert.match(requests[1][0].content, /не через другого помощника/);
});

test('a fresh executor reloads cross-channel history as quoted words, not confirmed facts', async () => {
  let input;
  const core = createAssistantCore({ store: { load: async () => ({ ...packet(), recentDialog: [{
    channel: 'voice_core', priorAssistantWords: 'Предлагал сравнить два варианта', evidence: 'generated_not_confirmed_fact'
  }] }) }, complete: async messages => { input = messages[0].content; return 'Помню предложение сравнить варианты.'; } });
  await core.respond(options('Продолжим после перезапуска'));
  assert.match(input, /Предлагал сравнить два варианта/);
  assert.match(input, /generated_not_confirmed_fact/);
  assert.match(input, /не подтверждённые факты/);
});

test('unverified callers cannot read memory or invoke the shared model', async () => {
  let calls = 0;
  const core = createAssistantCore({ store: { load: async () => { calls++; return packet(); } }, complete: async () => { calls++; return 'private'; } });
  await assert.rejects(core.respond({ ...options('секрет'), userId: 'other' }), /access_denied/);
  await assert.rejects(core.respond({ ...options('секрет'), channel: 'phone', authorize: () => false }), /owner_authentication_required/);
  assert.equal(calls, 0);
});

test('revoking a phone grant during generation discards the private result and history', async () => {
  let authorized = true, calls = 0;
  const requests = [];
  const core = createAssistantCore({ store: { load: async () => packet() }, complete: async messages => {
    requests.push(messages); if (!calls++) { authorized = false; return 'PRIVATE DISCARDED'; } return 'safe';
  } });
  await assert.rejects(core.respond({ ...options('question'), channel: 'phone', authorize: () => authorized }), /owner_authentication_required/);
  await core.respond(options('Следующий вопрос'));
  assert.doesNotMatch(JSON.stringify(requests[1]), /PRIVATE DISCARDED/);
});

test('photographs share the same history while bot file URLs never enter later turns', async () => {
  const requests = [];
  const core = createAssistantCore({ store: { load: async () => packet() }, complete: async messages => { requests.push(messages); return 'На фото шампунь.'; } });
  await core.respond({ ...options('Что за товар?'), imageUrl: 'https://api.telegram.org/file/botSECRET/photo.jpg' });
  await core.respond({ ...options('Что было на фото?'), channel: 'phone' });
  assert.equal(requests[0].at(-1).content[1].image_url.url, 'https://api.telegram.org/file/botSECRET/photo.jpg');
  assert.doesNotMatch(JSON.stringify(requests[1]), /SECRET/);
  assert(requests[1].some(row => row.content === 'На фото шампунь.'));
});

test('simultaneous requests from phone and Telegram cannot overwrite each other', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const core = createAssistantCore({ store: { load: async () => packet() }, complete: async messages => {
    requests.push(messages); if (requests.length === 1) await gate; return String(requests.length);
  } });
  const first = core.respond(options('Первый'));
  const second = core.respond({ ...options('Второй'), channel: 'phone' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests.length, 1);
  release(); await Promise.all([first, second]);
  assert(requests[1].some(row => row.role === 'assistant' && row.content === '1'));
});

test('voice rules keep greetings and authorization local, substantive work in the common core', () => {
  assert.match(VOICE_CORE_RULES, /ask_kuzya/); assert.match(VOICE_CORE_RULES, /askKuzya/);
  assert.match(VOICE_CORE_RULES, /Код подтверждения.*только authenticate_owner/);
});

test('web lookup uses only a planned public query, never the full private conversation', async () => {
  const searched = [];
  const core = createAssistantCore({ store: { load: async () => packet() },
    plan: async () => ({ needs_web: true, search_query: 'сегодняшняя погода Киев' }),
    search: async query => { searched.push(query); return { ok: true, results: [] }; }, complete: async () => 'Ответ' });
  await core.respond(options('Какая погода, мой телефон +380670000001'));
  assert.deepEqual(searched, ['сегодняшняя погода Киев']);
  const blocked = createAssistantCore({ store: { load: async () => packet() },
    plan: async () => ({ needs_web: true, search_query: '+380670000001 код 123456' }),
    search: async query => { searched.push(query); return {}; }, complete: async () => 'Ответ без проверки' });
  await blocked.respond(options('Частный вопрос')); assert.equal(searched.length, 1);
});

test('a fatal model planning error cannot trigger another generation or corrupt the next turn', async () => {
  let failed = true, generations = 0;
  const core = createAssistantCore({ store: { load: async () => packet() },
    plan: async () => { if (failed) throw Object.assign(new Error('balance'), { code: 'credit_balance_exhausted' }); return {}; },
    isFatal: error => error.code === 'credit_balance_exhausted', complete: async () => { generations++; return 'Следующий ответ'; } });
  await assert.rejects(core.respond(options('Первый вопрос')), /balance/);
  assert.equal(generations, 0); failed = false;
  assert.equal((await core.respond({ ...options('Новая попытка'), channel: 'phone' })).answer, 'Следующий ответ');
});
