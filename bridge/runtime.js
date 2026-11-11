import { createSupabaseStore } from './supabase-store.js';
import { createTaskQueue } from './task-queue.js';
import { createDotEvents, createSecretVault } from './events.js';
import { createDotMcpRouter } from './mcp-router.js';

// Composition only. No environment secrets are read at import, no server is
// started, no route is mounted and no outbound delivery occurs automatically.
export function createBridgeRuntime({ rpc, namespace = 'main', encryptionKey, authenticate, canDeliver,
  readContext, resourceUrl, authorizationServer, allowedOrigins, post, now = Date.now }) {
  if (typeof authenticate !== 'function' || typeof canDeliver !== 'function') throw Error('verified_oauth_dependencies_required');
  const store = createSupabaseStore({ rpc, namespace });
  const queue = createTaskQueue({ store, now });
  const events = createDotEvents({ store, vault: createSecretVault(encryptionKey), canDeliver, post, now });
  const router = createDotMcpRouter({ queue, events, authenticate, readContext, resourceUrl, authorizationServer, allowedOrigins });
  let timer, busy = false, closed = false;
  const dispatchOnce = async () => {
    if (closed || busy) return { attempted: false };
    busy = true;
    try { return await events.dispatchOne(); } finally { busy = false; }
  };
  return {
    router, queue, events,
    // Only a trusted backend AFTER its existing owner check may call this.
    enqueueVerifiedOwner: args => queue.enqueue(args),
    dispatchOnce,
    startWorker({ intervalMs = 5000, onError = () => {} } = {}) {
      if (closed || timer) throw Error('bridge_worker_already_started_or_closed');
      if (!Number.isInteger(intervalMs) || intervalMs < 5000 || intervalMs > 60000) throw Error('invalid_worker_interval');
      timer = setInterval(() => { void dispatchOnce().catch(error => {
        // Do not log tokens, callback URLs, payloads or arbitrary DB errors.
        onError({ code: ['bridge_commit_unknown', 'bridge_write_conflict', 'bridge_storage_unavailable'].includes(error.code) ? error.code : 'bridge_worker_unavailable' });
      }); }, intervalMs);
      timer.unref();
    },
    close() { closed = true; clearInterval(timer); timer = null; }
  };
}
