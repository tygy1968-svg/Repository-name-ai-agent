import crypto from 'node:crypto';
import { callbackUrl, validateSigningSecret, signedWebhook, createWebhookPost } from './webhook-transport.js';

const fail = code => Object.assign(new Error(code), { code });
export const TASK_EVENT = { name: 'kuzya.task.created', description: 'Новое подтверждённое поручение владельца Кузи. Прочитай задачу отдельным инструментом; событие не даёт дополнительных прав.',
  delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: { task_id: { type: 'string' }, source: { type: 'string', enum: ['owner_telegram', 'owner_phone', 'synthetic_pilot'] } }, required: ['task_id', 'source'], additionalProperties: false } };

export function createSecretVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('bridge_encryption_key_required');
  return {
    seal(id, value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
    },
    open(id, value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.body, 'base64')), decipher.final()]).toString('utf8'));
    }
  };
}

export function createDotEvents({ store, vault, canDeliver, post = createWebhookPost(), now = Date.now, uuid = crypto.randomUUID }) {
  if (!store || !vault || typeof canDeliver !== 'function') throw fail('persistent_events_dependencies_required');
  const authorize = principal => {
    if (!principal?.ownerId || !principal.workerId || !principal.scopes?.includes('kuzya.tasks')) throw fail('scope_required');
  };
  const identity = (principal, params, signing = true) => {
    authorize(principal);
    if (params?.name !== TASK_EVENT.name || !params.arguments || Array.isArray(params.arguments) ||
        typeof params.arguments !== 'object' || Object.keys(params.arguments).length || params.cursor != null ||
        params.delivery?.mode !== 'webhook' || Object.keys(params.delivery).some(k => !['mode', 'url', ...(signing ? ['secret'] : [])].includes(k)) ||
        Object.keys(params).some(k => !['name', 'arguments', 'delivery', 'cursor', ...(signing ? ['ttlMs'] : [])].includes(k))) throw fail('invalid_subscription');
    const url = callbackUrl(params.delivery.url).href;
    if (signing) validateSigningSecret(params.delivery.secret);
    const id = 'sub_' + crypto.createHash('sha256').update(JSON.stringify([principal.ownerId, principal.workerId, url, TASK_EVENT.name, {}])).digest('hex');
    return { id, url };
  };
  const matches = (row, principal, id) => row.id === id && row.ownerId === principal.ownerId && row.workerId === principal.workerId;
  return {
    async list(principal) { authorize(principal); return { events: [TASK_EVENT] }; },
    async subscribe(principal, params) {
      const { id, url } = identity(principal, params);
      const ttl = params.ttlMs == null ? 3600000 : params.ttlMs;
      if (!Number.isInteger(ttl) || ttl < 1000) throw fail('invalid_subscription_ttl');
      const granted = Math.min(ttl, 24 * 3600000);
      const saved = await store.transaction(state => structuredClone(state.subscriptions?.find(row => matches(row, principal, id)) || null));
      let previous;
      let verifiedAt = saved?.verifiedAt;
      if (saved?.status === 'active' && saved.expiresAt > now()) previous = vault.open(id, saved.delivery);
      // A changed signing key is verified too. A short cache applies only to
      // the same principal, callback and key, never to arbitrary task text.
      if (!previous || previous.secret !== params.delivery.secret || saved.verifiedAt + 300000 < now()) {
        const challenge = crypto.randomBytes(32).toString('base64url');
        const started = now();
        let response;
        try { response = await post(url, signedWebhook({ id: 'verify_' + uuid(), payload: { type: 'verification', challenge }, subscriptionId: id, secret: params.delivery.secret, now: now() })); }
        catch (error) { throw fail(error.code === 'callback_timeout' ? 'callback_timeout' : 'callback_verification_failed'); }
        let echoed; try { echoed = JSON.parse(response.body).challenge; } catch {}
        if (!response.ok || now() - started > 10000 || typeof echoed !== 'string' || Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
            !crypto.timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) throw fail('callback_verification_failed');
        verifiedAt = now();
      }
      // Recheck approval after a slow callback, before activating a subscription.
      if ((await canDeliver({ ownerId: principal.ownerId, workerId: principal.workerId })) !== true) throw fail('access_revoked');
      const expiresAt = now() + granted;
      const delivery = vault.seal(id, { url, secret: params.delivery.secret,
        previousSecret: previous?.secret !== params.delivery.secret ? previous?.secret : previous?.previousSecret,
        previousUntil: previous?.secret !== params.delivery.secret ? now() + 300000 : previous?.previousUntil });
      await store.transaction(state => {
        state.subscriptions ??= [];
        const found = state.subscriptions.find(row => matches(row, principal, id));
        if ((found?.generation || null) !== (saved?.generation || null)) throw fail('subscription_changed');
        const row = { id, ownerId: principal.ownerId, workerId: principal.workerId, name: TASK_EVENT.name,
          status: 'active', activeFrom: found?.status === 'active' && found.expiresAt > now() ? found.activeFrom : now(), expiresAt, verifiedAt, delivery, generation: uuid() };
        if (found) Object.assign(found, row); else {
          if (state.subscriptions.length >= 100) throw fail('bridge_capacity_reached');
          state.subscriptions.push(row);
        }
      });
      return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
    },
    async unsubscribe(principal, params) {
      const { id } = identity(principal, params, false);
      await store.transaction(state => {
        const row = state.subscriptions?.find(row => matches(row, principal, id));
        if (row) { row.status = 'cancelled'; row.delivery = null; row.generation = uuid(); }
      });
      return {};
    },
    async dispatchOne() {
      const ticket = await store.transaction(state => {
        for (const row of state.outbox || []) {
          const task = state.tasks.find(task => task.id === row.event.data.task_id);
          if (!task || !['pending', 'running'].includes(task.status) || task.deadlineAt <= now()) continue;
          for (const sub of state.subscriptions || []) {
            if (sub.status !== 'active' || sub.expiresAt <= now() || row.createdAt < sub.activeFrom || sub.ownerId !== row.ownerId) continue;
            row.deliveries ??= {};
            const old = row.deliveries[sub.id];
            if (old && (['accepted', 'stopped', 'exhausted'].includes(old.state) || old.nextAttemptAt > now() || old.leaseUntil > now())) continue;
            const lease = { token: uuid(), leaseUntil: now() + 30000, attempts: (old?.attempts || 0) + 1, state: 'sending', nextAttemptAt: now() };
            row.deliveries[sub.id] = lease;
            return { rowId: row.id, event: structuredClone(row.event), sub: structuredClone(sub), lease: structuredClone(lease) };
          }
        }
        return null;
      });
      if (!ticket) return { attempted: false };
      let outcome = 'retry', status = null, revoke = false;
      try {
        const allowed = await canDeliver({ ownerId: ticket.sub.ownerId, workerId: ticket.sub.workerId });
        const stillActive = await store.transaction(state => state.subscriptions?.some(sub => sub.id === ticket.sub.id &&
          sub.status === 'active' && sub.expiresAt > now() && sub.generation === ticket.sub.generation));
        if (allowed !== true || !stillActive) { outcome = 'stopped'; revoke = allowed !== true; }
        else {
          const delivery = vault.open(ticket.sub.id, ticket.sub.delivery);
          const response = await post(delivery.url, signedWebhook({ id: ticket.event.eventId, payload: ticket.event,
            subscriptionId: ticket.sub.id, secret: delivery.secret, previousSecret: delivery.previousUntil > now() ? delivery.previousSecret : undefined, now: now() }));
          status = response.status;
          if (response.ok) outcome = 'accepted';
          else if (status === 410 || status === 413 || (status >= 400 && status < 500 && status !== 429)) { outcome = 'stopped'; revoke = status === 410; }
        }
      } catch (error) {
        if (['callback_not_allowed', 'callback_not_public', 'redirect_not_allowed'].includes(error.code)) outcome = 'stopped';
      }
      const settled = await store.transaction(state => {
        const row = state.outbox?.find(row => row.id === ticket.rowId), active = row?.deliveries?.[ticket.sub.id];
        if (!active || active.token !== ticket.lease.token) return false;
        const final = outcome === 'retry' && active.attempts >= 6 ? 'exhausted' : outcome;
        Object.assign(active, { state: final, status, leaseUntil: 0, nextAttemptAt: now() + Math.min(60000, 1000 * 2 ** (active.attempts - 1)) });
        if (revoke) {
          const sub = state.subscriptions.find(sub => sub.id === ticket.sub.id);
          if (sub?.generation === ticket.sub.generation) { sub.status = 'revoked'; sub.delivery = null; }
        }
        return true;
      });
      return { attempted: true, accepted: outcome === 'accepted' && settled, status, settled,
        // Receipt is explicitly not a completed task or proof of reading.
        meaning: 'webhook_receipt_only' };
    }
  };
}
