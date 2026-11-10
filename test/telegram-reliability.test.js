import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramQueue, createNoticeLimiter, splitTelegramText, telegramDecision, telegramFailureText } from '../telegram-reliability.js';

test('duplicate updates cannot repeat a pending command; distinct turns stay in order', async () => {
  const queue = createTelegramQueue();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const events = [];
  assert.equal(queue.submit({ update_id: 7 }, async () => { events.push('first'); await wait; events.push('end'); }), 'queued');
  assert.equal(queue.submit({ update_id: 7 }, () => events.push('DUPLICATE CALL')), 'duplicate');
  assert.equal(queue.submit({ update_id: 8 }, () => events.push('second')), 'queued');
  await Promise.resolve(); assert.deepEqual(events, ['first']);
  release(); await queue.drain();
  assert.deepEqual(events, ['first', 'end', 'second']); assert.equal(queue.pending, 0);
});

test('full queue does not claim an update; retries can succeed after capacity frees', async () => {
  const queue = createTelegramQueue({ maxPending: 1 });
  let release; const wait = new Promise(resolve => { release = resolve; });
  queue.submit({ update_id: 1 }, () => wait);
  assert.equal(queue.submit({ update_id: 2 }, () => {}), 'busy');
  release(); await queue.drain();
  assert.equal(queue.submit({ update_id: 2 }, () => {}), 'queued'); await queue.drain();
});

test('a failed job cannot block subsequent owner messages', async () => {
  let errors = 0, ran = false;
  const queue = createTelegramQueue({ onError: () => { errors++; } });
  queue.submit({ update_id: 1 }, () => { throw Error('failed'); });
  queue.submit({ update_id: 2 }, () => { ran = true; });
  await queue.drain(); assert.equal(errors, 1); assert.equal(ran, true); assert.equal(queue.pending, 0);
});

test('deduplication is bounded and fallback keys include the chat', async () => {
  let now = 1, jobs = 0;
  const queue = createTelegramQueue({ now: () => now, ttl: 20, maxSeen: 2 });
  const update = chat => ({ message: { message_id: 9, chat: { id: chat } } });
  queue.submit(update(1), () => jobs++); queue.submit(update(2), () => jobs++);
  assert.equal(queue.submit(update(1), () => jobs++), 'duplicate');
  await queue.drain(); now += 20;
  assert.equal(queue.submit(update(1), () => jobs++), 'queued'); await queue.drain(); assert.equal(jobs, 3);
});

test('anonymous workspace gets only a neutral hint, never owner authorization', () => {
  const message = { from: { id: 1087968824, is_bot: true }, sender_chat: { id: -1003870803501 }, chat: { id: -1003870803501, type: 'supergroup' }, text: '/call +123' };
  assert.deepEqual(telegramDecision(message, '987654321'), { accepted: false, reason: 'anonymous_workspace_sender', hint: true });
  assert.equal(telegramDecision({ ...message, is_automatic_forward: true }, '987654321').hint, false);
  assert.equal(telegramDecision({ ...message, chat: { id: -7, type: 'supergroup' } }, '987654321').hint, false);
  assert.equal(telegramDecision({ from: { id: 987654321, is_bot: false }, chat: { id: 987654321, type: 'private' } }, '987654321').accepted, true);
});

test('group instructions cannot create a notification loop', () => {
  let now = 1; const allow = createNoticeLimiter({ now: () => now, interval: 60000 });
  assert.equal(allow(), true); assert.equal(allow(), false); now += 60000; assert.equal(allow(), true);
});

test('long replies preserve every character without splitting emoji surrogates', () => {
  const input = '😀'.repeat(2300) + '\n' + 'абв'.repeat(2200); const chunks = splitTelegramText(input);
  assert.equal(chunks.join(''), input); assert(chunks.every(chunk => chunk.length <= 3500 && !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.throws(() => splitTelegramText('  '), /empty/);
});

test('account problems, rate limits and timeouts have actionable, distinct replies', () => {
  assert.match(telegramFailureText({ code: 'credit_balance_exhausted' }), /пополнить баланс/);
  assert.match(telegramFailureText({ code: 'project_spend_limit_exceeded' }), /лимит/);
  assert.match(telegramFailureText({ status: 401 }), /Пароли и ключи.*не нужно/);
  assert.match(telegramFailureText({ status: 429 }), /временный лимит/);
  assert.match(telegramFailureText({ name: 'TimeoutError' }), /не успел/);
  assert.doesNotMatch(telegramFailureText({ message: 'sk-SECRET' }), /SECRET/);
});
