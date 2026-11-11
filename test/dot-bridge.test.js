import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskQueue, taskCreatedEvent } from '../bridge/task-queue.js';
import { createJsonStore } from '../bridge/json-store.js';
import { createDotToolAdapter, DOT_BRIDGE_TOOLS } from '../bridge/tool-adapter.js';

const owner = { ownerId: 'synthetic-owner', ownerVerified: true };
const request = { ...owner, requestId: 'telegram:synthetic:1', question: 'Объясни синтетическую запись о встрече.', source: 'synthetic_pilot' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kuzya-dot-pilot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  let clock = Date.parse('2026-11-11T14:00:00Z');
  const now = () => clock;
  const queue = createTaskQueue({ store: createJsonStore(path), now });
  return { path, queue, now, advance: delta => { clock += delta; } };
}
const complete = (task, answer = 'В синтетической записи встреча в четверг в 15:00.') => ({ ownerId: owner.ownerId,
  taskId: task.id, workerId: 'synthetic-worker', leaseToken: task.lease.token, resultId: 'synthetic-result-1', answer, sources: ['synthetic:meeting'] });

test('synthetic request traverses queue and dot tool contract, survives reload and records measured latency', async t => {
  const h = await fixture(t), submitted = await h.queue.enqueue(request);
  h.advance(250);
  const tools = createDotToolAdapter({ queue: h.queue, authenticate: async token => token === 'synthetic-token' ?
    { ownerId: owner.ownerId, workerId: 'synthetic-worker', scopes: ['kuzya.tasks'] } : null });
  const invoke = (name, args = {}) => tools({ token: 'synthetic-token', name, args });
  const task = (await invoke('kuzya_list_tasks')).tasks[0]; assert.equal(task.id, submitted.task.id);
  const claimed = (await invoke('kuzya_claim_task', { task_id: task.id })).task;
  h.advance(750);
  const args = { task_id: task.id, lease_token: claimed.lease.token, result_id: 'synthetic-result-1', answer: 'Синтетический ответ.', sources: ['synthetic:meeting'] };
  const result = await invoke('kuzya_complete_task', args); assert.equal(result.ok, true); assert.equal(result.task.result.endToEndMs, 1000);
  assert.equal((await invoke('kuzya_complete_task', args)).duplicate, true);
  const restarted = createTaskQueue({ store: createJsonStore(h.path), now: h.now });
  const delivery = { ...owner, taskId: task.id, destination: 'telegram_owner' };
  assert.equal((await restarted.takeResult(delivery)).answer, 'Синтетический ответ.');
  assert.equal((await restarted.takeResult(delivery)).status, 'already_taken');
  assert.equal((await stat(h.path)).mode & 0o777, 0o600);
  assert.equal((await invoke('kuzya_bridge_status')).dotConnected, false, 'a simulated worker is never reported as the actual dot');
});

test('parallel duplicates create one task, conflicting payload is rejected and no self-reply can enqueue through tools', async t => {
  const h = await fixture(t);
  const rows = await Promise.all(Array.from({ length: 8 }, () => h.queue.enqueue(request)));
  assert.equal(new Set(rows.map(r => r.task.id)).size, 1); assert.equal(rows.filter(r => !r.duplicate).length, 1);
  await assert.rejects(h.queue.enqueue({ ...request, question: 'Другая задача' }), { code: 'idempotency_conflict' });
  for (const source of ['caller_message', 'dot_result', 'assistant_reply']) await assert.rejects(h.queue.enqueue({ ...request, source }), { code: 'owner_only' });
  await assert.rejects(h.queue.enqueue({ ...request, ownerVerified: false }), { code: 'owner_only' });
  assert(!DOT_BRIDGE_TOOLS.some(t => /enqueue|send|call|buy/i.test(t.name)));
});

test('leases serialize workers, expire after restart and reject stale worker results', async t => {
  const h = await fixture(t), { task } = await h.queue.enqueue(request);
  const first = await h.queue.claim({ ownerId: owner.ownerId, taskId: task.id, workerId: 'synthetic-worker', leaseMs: 1000 });
  await assert.rejects(h.queue.claim({ ownerId: owner.ownerId, taskId: task.id, workerId: 'other' }), { code: 'task_already_claimed' });
  h.advance(1001);
  const restarted = createTaskQueue({ store: createJsonStore(h.path), now: h.now });
  const next = await restarted.claim({ ownerId: owner.ownerId, taskId: task.id, workerId: 'new-worker' });
  assert.notEqual(first.lease.token, next.lease.token);
  await assert.rejects(restarted.complete(complete(first)), { code: 'lease_not_active' });
  const done = { ...complete(next), workerId: 'new-worker' };
  assert.equal((await restarted.complete(done)).duplicate, false);
  await assert.rejects(restarted.complete({ ...done, answer: 'Изменённый повтор' }), { code: 'idempotency_conflict' });
});

test('cancelled/expired tasks and changed phone turns never produce a stale spoken answer', async t => {
  const h = await fixture(t);
  const { task } = await h.queue.enqueue({ ...request, source: 'owner_phone', callId: 'test-call', turnId: 'turn-1', ttlMs: 3000 });
  const running = await h.queue.claim({ ownerId: owner.ownerId, taskId: task.id, workerId: 'synthetic-worker' });
  await h.queue.complete(complete(running));
  const deliver = { ...owner, taskId: task.id, destination: 'phone_owner', callId: 'test-call', turnId: 'turn-1' };
  for (const change of [{ turnId: 'turn-2' }, { callId: 'different-call' }]) assert.equal((await h.queue.takeResult({ ...deliver, ...change })).status, 'stale_phone_turn');
  await assert.rejects(h.queue.takeResult({ ...deliver, ownerVerified: false }), { code: 'owner_only' });
  h.advance(3001); assert.equal((await h.queue.takeResult(deliver)).status, 'stale_phone_turn');
  const expired = (await h.queue.enqueue({ ...request, requestId: 'expire', ttlMs: 1000 })).task;
  h.advance(1001); await h.queue.list(owner.ownerId);
  await assert.rejects(h.queue.claim({ ownerId: owner.ownerId, taskId: expired.id, workerId: 'synthetic-worker' }), { code: 'task_not_pending' });
  const cancelled = (await h.queue.enqueue({ ...request, requestId: 'cancel' })).task;
  const claim = await h.queue.claim({ ownerId: owner.ownerId, taskId: cancelled.id, workerId: 'synthetic-worker' });
  await h.queue.cancel({ ownerId: owner.ownerId, taskId: cancelled.id });
  await assert.rejects(h.queue.complete(complete(claim)), { code: 'lease_not_active' });
});

test('tool boundary enforces identity and scope before reading context; private task text is absent from events', async t => {
  const h = await fixture(t), { task } = await h.queue.enqueue(request);
  let reads = 0, principal = null;
  const tool = createDotToolAdapter({ queue: h.queue, authenticate: async () => principal, readContext: async () => { reads++; return { partial: true }; } });
  const read = () => tool({ name: 'kuzya_read_context', args: { query: 'Синтетическая встреча' } });
  assert.equal((await read()).error, 'authentication_required');
  principal = { ownerId: 'other-owner', workerId: 'test', scopes: ['kuzya.tasks'] };
  assert.equal((await read()).error, 'scope_required'); assert.equal(reads, 0);
  assert.deepEqual((await tool({ name: 'kuzya_list_tasks' })).tasks, []);
  assert.equal((await tool({ name: 'kuzya_claim_task', args: { task_id: task.id } })).error, 'task_not_found');
  principal = { ...principal, ownerId: owner.ownerId, scopes: ['kuzya.memory.read'] };
  assert.equal((await read()).context.partial, true); assert.equal(reads, 1);
  assert.equal((await tool({ name: 'kuzya_read_context', args: { query: 'test', ownerId: 'forged' } })).error, 'invalid_arguments');
  const event = taskCreatedEvent(task);
  assert.equal(event.eventId, taskCreatedEvent(task).eventId); assert.equal(event.name, 'kuzya.task.created');
  assert(!JSON.stringify(event).includes(request.question)); assert(!JSON.stringify(event).includes(owner.ownerId));
});

test('a slow phone answer can finish in background and return to Telegram without speaking after eight seconds', async t => {
  const h = await fixture(t), { task } = await h.queue.enqueue({ ...request, source: 'owner_phone', callId: 'phone', turnId: 'turn' });
  const claimed = await h.queue.claim({ ownerId: owner.ownerId, taskId: task.id, workerId: 'synthetic-worker' });
  h.advance(9000);
  await h.queue.complete(complete(claimed));
  const route = { ...owner, taskId: task.id, callId: 'phone', turnId: 'turn' };
  assert.equal((await h.queue.takeResult({ ...route, destination: 'phone_owner' })).status, 'stale_phone_turn');
  assert.equal((await h.queue.takeResult({ ...route, destination: 'telegram_owner' })).ready, true);
});

test('storage failure never becomes a saved result and a corrupt file is not silently overwritten', async t => {
  const h = await fixture(t);
  const queue = createTaskQueue({ store: { transaction: async () => { throw Error('synthetic disk failure'); } } });
  await assert.rejects(queue.enqueue(request), /disk failure/);
  await h.queue.enqueue(request);
  const before = await readFile(h.path, 'utf8');
  await assert.rejects(h.queue.enqueue({ ...request, question: 'conflict' }));
  assert.equal(await readFile(h.path, 'utf8'), before);
  await writeFile(h.path, '{corrupt');
  await assert.rejects(h.queue.list(owner.ownerId));
  assert.equal(await readFile(h.path, 'utf8'), '{corrupt');
});

test('delivery acknowledgement distinguishes durable result, sent receipt, definite failure and ambiguity', async t => {
  const h = await fixture(t), { task } = await h.queue.enqueue(request);
  const running = await h.queue.claim({ ownerId: owner.ownerId, taskId: task.id, workerId: 'synthetic-worker' });
  await h.queue.complete(complete(running));
  const route = { ...owner, taskId: task.id, destination: 'telegram_owner' };
  let result = await h.queue.takeResult(route);
  assert.equal((await h.queue.settleDelivery({ ownerId: owner.ownerId, taskId: task.id, deliveryToken: result.deliveryToken, outcome: 'not_sent' })).retryable, true);
  result = await h.queue.takeResult(route); assert.equal(result.ready, true);
  const settle = { ownerId: owner.ownerId, taskId: task.id, deliveryToken: result.deliveryToken };
  await assert.rejects(h.queue.settleDelivery({ ...settle, outcome: 'sent' }), { code: 'invalid_delivery_receipt' });
  assert.equal((await h.queue.settleDelivery({ ...settle, outcome: 'unknown' })).requiresReconciliation, true);
  assert.equal((await h.queue.takeResult(route)).ready, false, 'an ambiguous timeout is not retried blindly');
  assert.equal((await h.queue.settleDelivery({ ...settle, outcome: 'sent', receiptId: 'synthetic-telegram:1' })).sent, true);
  assert.equal((await h.queue.settleDelivery({ ...settle, outcome: 'sent', receiptId: 'synthetic-telegram:1' })).duplicate, true);
  await assert.rejects(h.queue.settleDelivery({ ...settle, outcome: 'not_sent' }), { code: 'idempotency_conflict' });
});
