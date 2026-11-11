import crypto from 'node:crypto';

export const BRIDGE_VERSION = 'dot_bridge_prototype_2026_11_11';
const fail = code => Object.assign(new Error(code), { code });
const copy = value => structuredClone(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// Prototype core only: no public endpoint, token minting, model, messages or calls.
// store.transaction must serialize and atomically persist the entire state before
// returning. A production multi-worker adapter must implement the same atomicity.
export function createTaskQueue({ store, now = Date.now, uuid = crypto.randomUUID }) {
  const expire = row => {
    if (['pending', 'running'].includes(row.status) && row.deadlineAt <= now()) {
      row.status = 'expired'; row.updatedAt = now(); row.lease = null;
    }
  };
  return {
    async enqueue({ ownerId, ownerVerified, requestId, question, source, callId, turnId, ttlMs = 30 * 60000 }) {
      // The application supplies these fields AFTER its existing owner check;
      // this method is intentionally not exposed as a dot tool.
      if (!ownerVerified || !text(ownerId, 100) || !['owner_telegram', 'owner_phone', 'synthetic_pilot'].includes(source)) throw fail('owner_only');
      if (!text(requestId, 200) || !text(question, 6000) || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * 3600000 ||
          (source === 'owner_phone' && (!text(callId, 200) || !text(turnId, 200)))) throw fail('invalid_task');
      return store.transaction(state => {
        const existing = state.tasks.find(t => t.ownerId === ownerId && t.requestId === requestId);
        if (existing) {
          if (existing.question !== question || existing.source !== source || existing.callId !== (callId || null) || existing.turnId !== (turnId || null)) throw fail('idempotency_conflict');
          return { task: copy(existing), duplicate: true };
        }
        if (state.tasks.length >= 1000) throw fail('pilot_capacity_reached');
        const id = uuid(), timestamp = now();
        const task = { id, ownerId, requestId, source, question, callId: callId || null, turnId: turnId || null,
          status: 'pending', createdAt: timestamp, updatedAt: timestamp, deadlineAt: timestamp + ttlMs,
          phoneReplyDeadlineAt: source === 'owner_phone' ? timestamp + Math.min(ttlMs, 8000) : null,
          lease: null, result: null, delivery: null };
        state.tasks.push(task);
        return { task: copy(task), duplicate: false };
      });
    },
    async list(ownerId) {
      return store.transaction(state => {
        const rows = state.tasks.filter(t => t.ownerId === ownerId);
        rows.forEach(expire);
        return rows.filter(t => t.status === 'pending' || (t.status === 'running' && t.lease.expiresAt <= now())).slice(0, 20)
          .map(({ lease, result, delivery, ...task }) => copy(task));
      });
    },
    async claim({ ownerId, workerId, taskId, leaseMs = 60000 }) {
      if (!text(workerId, 100) || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 5 * 60000) throw fail('invalid_claim');
      return store.transaction(state => {
        const task = state.tasks.find(t => t.id === taskId && t.ownerId === ownerId);
        if (!task) throw fail('task_not_found');
        expire(task);
        if (task.status === 'running' && task.lease.expiresAt > now()) throw fail('task_already_claimed');
        if (!['pending', 'running'].includes(task.status)) throw fail('task_not_pending');
        task.status = 'running'; task.updatedAt = now();
        task.lease = { token: uuid(), workerId, expiresAt: Math.min(now() + leaseMs, task.deadlineAt) };
        return copy(task);
      });
    },
    async complete({ ownerId, workerId, taskId, leaseToken, resultId, answer, sources = [] }) {
      if (!text(resultId, 200) || !text(answer, 6000) || !Array.isArray(sources) || sources.length > 20 ||
          sources.some(s => !text(s, 500))) throw fail('invalid_result');
      return store.transaction(state => {
        const task = state.tasks.find(t => t.id === taskId && t.ownerId === ownerId);
        if (!task) throw fail('task_not_found');
        if (task.status === 'completed' && task.result?.id === resultId) {
          if (task.result.workerId !== workerId || task.result.leaseToken !== leaseToken || task.result.answer !== answer ||
              JSON.stringify(task.result.sources) !== JSON.stringify(sources)) throw fail('idempotency_conflict');
          return { task: copy(task), duplicate: true };
        }
        expire(task);
        if (task.status !== 'running' || task.lease.token !== leaseToken || task.lease.workerId !== workerId || task.lease.expiresAt <= now()) throw fail('lease_not_active');
        task.status = 'completed'; task.updatedAt = now();
        task.result = { id: resultId, workerId, leaseToken, answer, sources: copy(sources), completedAt: now(),
          provenance: 'dot_tool_result_not_verified_fact_or_executed_action', endToEndMs: now() - task.createdAt };
        task.lease = null;
        return { task: copy(task), duplicate: false };
      });
    },
    async cancel({ ownerId, taskId }) {
      return store.transaction(state => {
        const task = state.tasks.find(t => t.id === taskId && t.ownerId === ownerId);
        if (!task) throw fail('task_not_found');
        if (['pending', 'running'].includes(task.status)) { task.status = 'cancelled'; task.lease = null; task.updatedAt = now(); }
        return copy(task);
      });
    },
    async takeResult({ ownerId, ownerVerified, taskId, destination, callId, turnId }) {
      if (!ownerVerified) throw fail('owner_only');
      if (!['telegram_owner', 'phone_owner'].includes(destination)) throw fail('invalid_destination');
      return store.transaction(state => {
        const task = state.tasks.find(t => t.id === taskId && t.ownerId === ownerId);
        if (!task) throw fail('task_not_found');
        if (task.status !== 'completed') return { ready: false, status: task.status };
        // No delayed answer is pushed over a newer phone turn or another call.
        if (destination === 'phone_owner' && (task.source !== 'owner_phone' || task.callId !== callId || task.turnId !== turnId || now() > task.phoneReplyDeadlineAt)) return { ready: false, status: 'stale_phone_turn' };
        if (task.delivery) return { ready: false, status: 'already_taken' };
        task.delivery = { token: uuid(), destination, takenAt: now(), state: 'reserved_not_proof_of_delivery' };
        return { ready: true, deliveryToken: task.delivery.token, answer: task.result.answer, sources: copy(task.result.sources), endToEndMs: task.result.endToEndMs };
      });
    },
    async settleDelivery({ ownerId, taskId, deliveryToken, outcome, receiptId }) {
      if (!['sent', 'not_sent', 'unknown'].includes(outcome) || (outcome === 'sent' && !text(receiptId, 200))) throw fail('invalid_delivery_receipt');
      return store.transaction(state => {
        const task = state.tasks.find(t => t.id === taskId && t.ownerId === ownerId);
        if (!task || task.delivery?.token !== deliveryToken) throw fail('delivery_not_active');
        if (task.delivery.state === 'sent') {
          if (outcome !== 'sent' || task.delivery.receiptId !== receiptId) throw fail('idempotency_conflict');
          return { sent: true, duplicate: true };
        }
        // Retry only a DEFINITE non-send. An ambiguous timeout stays reserved for
        // reconciliation; exactly-once external delivery is not claimed.
        if (outcome === 'not_sent') task.delivery = null;
        else Object.assign(task.delivery, { state: outcome, receiptId: outcome === 'sent' ? receiptId : null, settledAt: now() });
        return { sent: outcome === 'sent', retryable: outcome === 'not_sent', requiresReconciliation: outcome === 'unknown' };
      });
    }
  };
}

// Metadata-only event. Private question and result are fetched with scoped tools.
// A receiver must never treat a webhook 2xx as a completed dot response.
export function taskCreatedEvent(task) {
  return { eventId: `task_created:${task.id}`, name: 'kuzya.task.created', timestamp: new Date(task.createdAt).toISOString(),
    data: { task_id: task.id, source: task.source }, cursor: null };
}
