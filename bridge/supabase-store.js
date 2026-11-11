import crypto from 'node:crypto';
import { taskCreatedEvent } from './task-queue.js';

const fail = code => Object.assign(new Error(code), { code });
const valid = state => state?.version === 1 && Array.isArray(state.tasks) && state.tasks.length <= 1000 &&
  (state.outbox === undefined || Array.isArray(state.outbox)) &&
  (state.subscriptions === undefined || Array.isArray(state.subscriptions));

// The callback MUST be synchronous and have no external side effects: CAS
// conflicts may replay it against a newer committed snapshot. HTTP and model
// calls belong outside the callback. No database key is ever sent to the dot.
export function createSupabaseStore({ rpc, namespace = 'main', maxAttempts = 8, uuid = crypto.randomUUID }) {
  if (typeof rpc !== 'function' || !/^[a-z0-9_-]{1,100}$/.test(namespace) || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw fail('invalid_store_config');
  const read = async () => {
    const row = await rpc('kuzya_bridge_read_state', { p_namespace: namespace });
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || !valid(row.state)) throw fail('invalid_bridge_state');
    return row;
  };
  return {
    async transaction(fn) {
      if (fn?.constructor?.name === 'AsyncFunction') throw fail('async_transaction_forbidden');
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const current = await read();
        const state = structuredClone(current.state);
        const result = fn(state);
        if (result && typeof result.then === 'function') throw fail('async_transaction_forbidden');
        if (!valid(state)) throw fail('invalid_bridge_state');
        // New task and wake-up event share ONE durable compare-and-swap. Failed
        // commits create neither. Metadata only; the private question is fetched
        // separately with scoped tools. Completing a task cannot enqueue itself.
        const before = new Set(current.state.tasks.map(task => task.id));
        for (const task of state.tasks) {
          if (before.has(task.id)) continue;
          state.outbox ??= [];
          const event = taskCreatedEvent(task);
          if (!state.outbox.some(row => row.id === event.eventId)) state.outbox.push({
            id: event.eventId, ownerId: task.ownerId, event, createdAt: task.createdAt,
            state: 'pending', attempts: 0, nextAttemptAt: task.createdAt
          });
        }
        if ((state.outbox?.length || 0) > 2000 || Buffer.byteLength(JSON.stringify(state)) > 32 * 1024 * 1024) throw fail('bridge_capacity_reached');
        // Read-only transactions do not churn revisions or conflict with claims.
        if (JSON.stringify(state) === JSON.stringify(current.state)) return structuredClone(result);
        const commitId = uuid();
        let receipt;
        try {
          receipt = await rpc('kuzya_bridge_cas_state', { p_namespace: namespace,
            p_expected_revision: current.revision, p_state: state, p_commit_id: commitId });
        } catch {
          // A timeout may follow a successful commit. Resolve only our exact
          // receipt; never blindly replay an uncertain mutation.
          try { if ((await read()).commit_id === commitId) return structuredClone(result); } catch {}
          throw fail('bridge_commit_unknown');
        }
        if (receipt?.committed === true && receipt.revision === current.revision + 1 && receipt.commit_id === commitId) return structuredClone(result);
        if (receipt?.committed !== false) throw fail('invalid_commit_receipt');
      }
      throw fail('bridge_write_conflict');
    }
  };
}

// Existing server-side Supabase credentials only. This client cannot follow a
// redirect to leak them. Keep it out of public bundles and MCP tool arguments.
export function createBridgeRpcClient({ projectUrl, serviceKey, fetchImpl = fetch }) {
  const base = new URL(projectUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !serviceKey) throw fail('invalid_rpc_config');
  const allowed = new Set(['kuzya_bridge_read_state', 'kuzya_bridge_cas_state']);
  return async (name, args) => {
    if (!allowed.has(name)) throw fail('rpc_not_allowed');
    const response = await fetchImpl(new URL('/rest/v1/rpc/' + name, base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(args)
    });
    if (!response.ok) throw fail('bridge_storage_unavailable');
    return response.json();
  };
}
