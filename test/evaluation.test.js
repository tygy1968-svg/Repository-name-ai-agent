import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantCore } from '../assistant-core.js';
import { OWNER_TELEGRAM_ID } from '../unified-context.js';
import { scenarios, emptyPacket, reviewFlags } from '../eval/scenarios.js';
import { createModelClient, createBudget, requestBody, readAnswer } from '../eval/model-client.js';
import { retrievalBaseline } from '../eval/retrieval-baseline.js';

test('diagnostics expose three retrieval gaps without calling a model or a database', async () => {
  const result = await retrievalBaseline();
  assert.equal(result.modelsCalled, 0);
  assert.equal(result.results.length, 8);
  assert.deepEqual(result.results.filter(row => row.status === 'gap').map(row => row.id), ['R02', 'R03', 'R05']);
});

test('evaluation preserves the baseline request and uses a separate Responses adapter for the candidate', () => {
  const messages = [{ role: 'system', content: 'Синтетический контекст' }, { role: 'user', content: 'Привет' }];
  assert.deepEqual(requestBody('gpt-4o', messages), { model: 'gpt-4o', messages, temperature: 0.4, max_tokens: 700, store: false });
  const body = requestBody('gpt-6.1-sol', messages);
  assert.equal(body.reasoning.effort, 'low'); assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 2048); assert.deepEqual(body.input, messages);
  assert.equal(body.temperature, undefined); assert.equal(body.max_tokens, undefined);
  assert.throws(() => requestBody('invented-model', messages), /unsupported/);
  assert.throws(() => requestBody('gpt-4o', [{ role: 'user', content: [] }]), /text_evaluation_only/);
});

test('truncated, incomplete, reasoning-only and empty replies cannot become successful answers', () => {
  assert.throws(() => readAnswer('gpt-4o', { choices: [{ finish_reason: 'length', message: { content: 'Часть' } }] }), /incomplete/);
  assert.throws(() => readAnswer('gpt-6.1-sol', { status: 'incomplete', output: [] }), /incomplete/);
  assert.throws(() => readAnswer('gpt-6.1-sol', { status: 'completed', output: [{ type: 'reasoning' }] }), /empty/);
  assert.equal(readAnswer('gpt-6.1-sol', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ответ' }] }] }), 'Ответ');
});

test('a failed API request is not retried and its body and credentials stay out of evidence', async () => {
  let calls = 0;
  const records = [];
  const complete = createModelClient({ model: 'gpt-4o', apiKey: 'FAKE-SECRET', budget: createBudget(), records, fetchImpl: async () => {
    calls++; return new Response('FAKE-SECRET echoed sensitive error', { status: 429 });
  } });
  await assert.rejects(complete([{ role: 'user', content: 'Синтетический вопрос' }]), /openai_http_429/);
  assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(records), /FAKE-SECRET|sensitive error/);
});

test('both adapters retain actual response identity, usage and text with a fixed destination', async () => {
  for (const model of ['gpt-4o', 'gpt-6.1-sol']) {
    const records = [];
    const complete = createModelClient({ model, apiKey: 'FAKE-SECRET', budget: createBudget(), records, fetchImpl: async (address, options) => {
      assert.match(address, /^https:\/\/api\.openai\.com\/v1\/(?:responses|chat\/completions)$/);
      assert.equal(options.redirect, 'error'); assert.ok(options.signal);
      const common = { model: 'returned-snapshot', usage: { total_tokens: 42 } };
      return Response.json(model === 'gpt-4o'
        ? { ...common, choices: [{ finish_reason: 'stop', message: { content: 'Проверочный ответ' } }] }
        : { ...common, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Проверочный ответ' }] }] },
      { headers: { 'x-request-id': 'synthetic-request' } });
    } });
    assert.equal(await complete([{ role: 'user', content: 'Синтетический вопрос' }]), 'Проверочный ответ');
    assert.equal(records[0].returnedModel, 'returned-snapshot'); assert.equal(records[0].requestId, 'synthetic-request');
    assert.equal(records[0].usage.total_tokens, 42); assert.doesNotMatch(JSON.stringify(records), /FAKE-SECRET/);
  }
});

test('budget refuses a request before network access and retains failed request reservations', async () => {
  let calls = 0;
  const budget = createBudget(0.000001);
  const client = createModelClient({ model: 'gpt-4o', apiKey: 'synthetic', budget, records: [], fetchImpl: async () => { calls++; throw Error('network'); } });
  await assert.rejects(client([{ role: 'user', content: 'Вопрос' }]), /budget_exhausted/);
  assert.equal(calls, 0);
  const reserved = createBudget();
  const failed = createModelClient({ model: 'gpt-4o', apiKey: 'synthetic', budget: reserved, records: [], fetchImpl: async () => { throw Error('network'); } });
  await assert.rejects(failed([{ role: 'user', content: 'Вопрос' }]), /request_failed/);
  assert.equal(reserved.snapshot().calls, 1); assert.ok(reserved.snapshot().reservedUsd > 0);
});

test('unauthenticated phone access cannot reach the evaluation model', async () => {
  let calls = 0;
  const core = createAssistantCore({ store: { load: async () => emptyPacket() }, complete: async () => { calls++; return 'Нельзя'; } });
  await assert.rejects(core.respond({ userId: OWNER_TELEGRAM_ID, channel: 'phone', text: 'Личный план', authorize: () => false }), /owner_authentication_required/);
  assert.equal(calls, 0);
});

test('every scenario requires semantic review even when automatic pattern checks pass', () => {
  assert.equal(scenarios.length, 15);
  assert.equal(new Set(scenarios.map(row => row.id)).size, 15);
  const flags = reviewFlags(scenarios[0], 'Четверг, 15:00. Но также выдуманный факт.');
  assert.deepEqual(flags.missingPatterns, []); assert.equal(flags.semanticReview, 'required');
});
