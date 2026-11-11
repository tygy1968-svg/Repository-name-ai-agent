import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAssistantCore, isPrivateRecall, VOICE_CORE_RULES } from '../assistant-core.js';
import { OWNER_TELEGRAM_ID, CONTINUITY_RULES } from '../unified-context.js';
import { probeVoiceStyle } from '../voice-style-probe.js';
import { buildInboundInstructions } from '../inbound-voice.js';

test('private phone recall performs one generation without the public-search planner', async () => {
  let time = 0, reads = 0, plans = 0, generations = 0, prompt;
  const core = createAssistantCore({ clock: () => time,
    store: { load: async () => { reads++; time += 20; return { access: 'owner', incomingMessages: [{ text: 'Синтетическое приглашение' }] }; } },
    plan: async () => { plans++; throw new Error('private recall should not plan web'); },
    complete: async messages => { generations++; prompt = messages[0].content; time += 30; return 'В записи осталось приглашение.'; } });
  const result = await core.respond({ userId: OWNER_TELEGRAM_ID, channel: 'phone', text: 'Куда и на какое время Юлю пригласили 7 ноября?' });
  assert.deepEqual([reads, plans, generations], [1, 0, 1]);
  assert.deepEqual(result.timings, { queueMs: 0, retrievalMs: 20, planningMs: 0, searchMs: 0, generationMs: 30, plannerSkipped: true, totalMs: 50 });
  assert.match(prompt, /Синтетическое приглашение/); assert.match(prompt, /мужском грамматическом роде/);
  assert.match(prompt, /цитаты других людей сохраняй/);
});

test('public and mixed questions keep fresh search; Telegram keeps its existing planner', async () => {
  for (const [channel, text] of [['phone', 'Какая сейчас погода?'], ['phone', 'Что мы обсуждали о погоде и какой сейчас прогноз?'], ['telegram', 'Что мне передали 7 ноября?']]) {
    let plans = 0, searches = 0, time = 0;
    const core = createAssistantCore({ clock: () => time,
      store: { load: async () => { time += 10; return { access: 'owner' }; } },
      plan: async () => { plans++; time += 20; return { needs_web: true, search_query: 'погода Киев' }; },
      search: async () => { searches++; time += 30; return { ok: true, results: [] }; },
      complete: async () => { time += 40; return 'Проверил источник.'; } });
    const result = await core.respond({ userId: OWNER_TELEGRAM_ID, channel, text });
    assert.equal(plans, 1); assert.equal(searches, 1); assert.equal(result.timings.plannerSkipped, false);
    assert.equal(result.timings.totalMs, 100);
  }
  for (const q of ['Куда меня пригласили?', 'На чём мы остановились в Telegram?', 'Що мені передавали в розмові?']) assert.equal(isPrivateRecall(q), true, q);
  for (const q of ['Ты помнишь, какой сейчас президент?', 'Что мне говорили про цены и тарифы?', 'Найди новости', 'Куда пригласили президента?']) assert.equal(isPrivateRecall(q), false, q);
});

test('both voice prompts keep one lookup, one greeting, masculine wording and local acknowledgements', () => {
  const prompt = buildInboundInstructions({ core: CONTINUITY_RULES });
  assert.match(prompt, /О себе говори в мужском/); assert.match(prompt, /Поздоровайся один раз/);
  assert.match(prompt, /один ask_kuzya/); assert.match(prompt, /Не делай перед ним read_shared_context/);
  assert.doesNotMatch(prompt, /перед ответами.*вызывай read_shared_context/);
  assert.match(VOICE_CORE_RULES, /спасибо.*без проверки памяти/);
});

function probeFixture(options = {}) {
  let socket;
  class FakeSocket extends EventEmitter {
    constructor(url, config) { super(); socket = this; this.url = url; this.config = config; this.sent = []; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.emit('close'); }
  }
  const promise = probeVoiceStyle({ apiKey: 'fake-never-output', model: 'gpt-realtime', instructions: 'Synthetic only', tools: [], WebSocketImpl: FakeSocket, ...options });
  const event = data => socket.emit('message', Buffer.from(JSON.stringify(data)));
  const response = (id, text) => event({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } });
  socket.emit('open'); event({ type: 'session.updated' });
  return { socket, promise, event, response };
}

test('realtime style probe is bounded, text-only, deduplicated and cannot execute tools or calls', async () => {
  const h = probeFixture();
  h.response('one', 'Привет! Рад тебя слышать.'); h.response('one', 'Дубль не должен сдвинуть сценарий.');
  h.response('two', 'Слушаю.'); h.response('three', 'Так, готовий продовжити.');
  h.response('four', 'Да, конечно, можешь оставить сообщение.');
  h.event({ type: 'response.done', response: { id: 'five', status: 'completed', output: [{ type: 'function_call', name: 'leave_message', arguments: JSON.stringify({ message: 'Встреча 14 ноября в 17 часов' }) }] } });
  const result = await h.promise;
  assert.equal(result.ok, true); assert.equal(result.results.length, 5); assert.equal(h.socket.closed, true);
  assert.equal(h.socket.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime');
  assert(h.socket.sent.filter(e => e.type === 'response.create').every((e, i) => e.response.tool_choice === (i === 4 ? 'auto' : 'none') && e.response.max_output_tokens === 128));
  assert(h.socket.sent.filter(e => e.type === 'response.create').every(e => e.response.output_modalities[0] === 'text'));
  assert.equal(h.socket.sent.filter(e => e.type === 'response.create').length, 5);
  assert.doesNotMatch(JSON.stringify(result), /fake-never-output/);
});

test('feminine wording, API failures and timeouts cannot be reported as a successful voice check', async () => {
  const feminine = probeFixture(); feminine.response('one', 'Рада тебя слышать.'); feminine.response('two', 'Привет ещё раз.'); feminine.response('three', 'Так, готова.'); feminine.response('four', 'Нажми кнопку.'); feminine.response('five', 'Я записал без инструмента.');
  assert.equal((await feminine.promise).ok, false);
  const failure = probeFixture(); failure.event({ type: 'error', error: { message: 'fake-never-output' } });
  assert.deepEqual(await failure.promise, { ok: false, error: 'probe_api_error', results: [] });
  const timeout = probeFixture({ timeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await timeout.promise).error, 'probe_timeout'); assert.equal(timeout.socket.closed, true);
});
