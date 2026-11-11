import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore, createBridgeRpcClient } from '../bridge/supabase-store.js';
import { createTaskQueue } from '../bridge/task-queue.js';

function database() {
  const rows = new Map(); let conflicts = 0, loseReceipt = false;
  const rpc = async (name, args) => {
    // Yield between read and CAS so independent stores really race.
    await new Promise(resolve => setImmediate(resolve));
    const current = rows.get(args.p_namespace) || { revision: 0, state: { version: 1, tasks: [] }, commit_id: null };
    if (name === 'kuzya_bridge_read_state') return structuredClone(current);
    if (current.revision !== args.p_expected_revision) { conflicts++; return { committed: false }; }
    const next = { revision: current.revision + 1, state: structuredClone(args.p_state), commit_id: args.p_commit_id };
    rows.set(args.p_namespace, next);
    if (loseReceipt) { loseReceipt = false; throw Error('synthetic timeout after commit'); }
    return { committed: true, revision: next.revision, commit_id: next.commit_id };
  };
  return { rpc, rows, conflicts: () => conflicts, loseNextReceipt: () => { loseReceipt = true; } };
}
const request = { ownerId: 'synthetic-owner', ownerVerified: true, requestId: 'telegram:one', question: 'Синтетическая задача', source: 'synthetic_pilot' };

test('independent database stores race safely, restart and atomically save one metadata event', async () => {
  const db = database();
  const queues = Array.from({ length: 4 }, () => createTaskQueue({ store: createSupabaseStore({ rpc: db.rpc }) }));
  const answers = await Promise.all(queues.map(queue => queue.enqueue(request)));
  assert.equal(new Set(answers.map(answer => answer.task.id)).size, 1);
  const row = db.rows.get('main');
  assert.equal(row.state.tasks.length, 1); assert.equal(row.state.outbox.length, 1);
  assert(!JSON.stringify(row.state.outbox).includes(request.question));
  assert.equal(row.state.outbox[0].event.data.task_id, answers[0].task.id);
  assert(db.conflicts() > 0);
  const restarted = createTaskQueue({ store: createSupabaseStore({ rpc: db.rpc }) });
  const task = (await restarted.list(request.ownerId))[0];
  const claims = await Promise.allSettled(queues.map((queue, i) => queue.claim({ ownerId: request.ownerId, workerId: 'worker-' + i, taskId: task.id })));
  assert.equal(claims.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(db.rows.get('main').state.outbox.length, 1, 'claim does not create a reply loop');
});

test('unknown commit receipt is reconciled exactly and unreadable uncertainty never reports success', async () => {
  const db = database(); db.loseNextReceipt();
  const store = createSupabaseStore({ rpc: db.rpc });
  const queue = createTaskQueue({ store });
  assert.equal((await queue.enqueue(request)).duplicate, false);
  assert.equal(db.rows.get('main').state.tasks.length, 1);
  let called = 0;
  const unavailable = createSupabaseStore({ rpc: async name => {
    if (name === 'kuzya_bridge_read_state' && called++ === 0) return { revision: 0, state: { version: 1, tasks: [] } };
    throw Error('synthetic outage');
  } });
  await assert.rejects(createTaskQueue({ store: unavailable }).enqueue(request), { code: 'bridge_commit_unknown' });
});

test('database transactions do not overwrite on corruption/conflict, execute side effects or churn readonly revisions', async () => {
  const db = database(); const store = createSupabaseStore({ rpc: db.rpc });
  await createTaskQueue({ store }).enqueue(request);
  const revision = db.rows.get('main').revision;
  await createTaskQueue({ store }).list(request.ownerId);
  assert.equal(db.rows.get('main').revision, revision);
  await assert.rejects(store.transaction(async () => 'not allowed'), { code: 'async_transaction_forbidden' });
  await assert.rejects(store.transaction(() => { throw Error('callback failed'); }), /callback failed/);
  assert.equal(db.rows.get('main').revision, revision);
  const failing = createSupabaseStore({ maxAttempts: 2, rpc: async name => name === 'kuzya_bridge_read_state' ?
    { revision: 0, state: { version: 1, tasks: [] } } : { committed: false } });
  await assert.rejects(createTaskQueue({ store: failing }).enqueue(request), { code: 'bridge_write_conflict' });
  const corrupt = createSupabaseStore({ rpc: async () => ({ revision: 5, state: { version: 3, tasks: [] } }) });
  await assert.rejects(corrupt.transaction(() => null), { code: 'invalid_bridge_state' });
  assert.equal(db.rows.get('main').revision, revision);
});

test('RPC client keeps credentials server side, limits functions and refuses redirects/failure receipts', async () => {
  let seen;
  const rpc = createBridgeRpcClient({ projectUrl: 'https://synthetic.example', serviceKey: 'synthetic-test-key', fetchImpl: async (url, options) => {
    seen = { url: String(url), options }; return new Response(JSON.stringify({ revision: 1 }));
  } });
  assert.equal((await rpc('kuzya_bridge_read_state', { p_namespace: 'test' })).revision, 1);
  assert.equal(seen.options.redirect, 'error'); assert.equal(seen.options.headers.apikey, 'synthetic-test-key');
  assert.equal(seen.url, 'https://synthetic.example/rest/v1/rpc/kuzya_bridge_read_state');
  await assert.rejects(rpc('arbitrary_function', {}), { code: 'rpc_not_allowed' });
  assert.throws(() => createBridgeRpcClient({ projectUrl: 'http://synthetic.example', serviceKey: 'x' }), { code: 'invalid_rpc_config' });
  const fail = createBridgeRpcClient({ projectUrl: 'https://synthetic.example', serviceKey: 'synthetic', fetchImpl: async () => new Response('private error body', { status: 500 }) });
  await assert.rejects(fail('kuzya_bridge_read_state', {}), { code: 'bridge_storage_unavailable' });
});
