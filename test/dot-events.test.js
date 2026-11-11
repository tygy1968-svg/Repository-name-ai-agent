import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Webhook } from 'standardwebhooks';
import { createDotEvents, createSecretVault } from '../bridge/events.js';
import { callbackUrl, resolveCallback, isPublicAddress, signedWebhook, createWebhookPost } from '../bridge/webhook-transport.js';
import { createSupabaseStore } from '../bridge/supabase-store.js';
import { createTaskQueue } from '../bridge/task-queue.js';

const principal = { ownerId: 'synthetic-owner', workerId: 'synthetic-dot', scopes: ['kuzya.tasks'] };
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const params = { name: 'kuzya.task.created', arguments: {}, delivery: { mode: 'webhook', url: 'https://callback.example/mcp', secret } };
function fixture() {
  let clock = Date.now(), approved = true, status = 200, verifyFail = false, state = { revision: 0, commit_id: null, state: { version: 1, tasks: [] } };
  const rpc = async (name, args) => {
    if (name === 'kuzya_bridge_read_state') return structuredClone(state);
    if (state.revision !== args.p_expected_revision) return { committed: false };
    state = { revision: state.revision + 1, commit_id: args.p_commit_id, state: structuredClone(args.p_state) };
    return { committed: true, revision: state.revision, commit_id: state.commit_id };
  };
  const store = createSupabaseStore({ rpc });
  const vault = createSecretVault(Buffer.alloc(32, 8));
  const posts = [];
  const post = async (url, request) => {
    posts.push({ url, ...request });
    const payload = JSON.parse(request.body);
    return { ok: status >= 200 && status < 300, status, body: JSON.stringify({ challenge: verifyFail ? 'wrong' : payload.challenge }) };
  };
  const config = { store, vault, post, canDeliver: async () => approved, now: () => clock };
  const events = createDotEvents(config);
  const enqueue = (id = 'one') => createTaskQueue({ store, now: () => clock }).enqueue({ ownerId: principal.ownerId, ownerVerified: true,
    requestId: id, question: 'Private synthetic question', source: 'synthetic_pilot' });
  return { store, vault, events, config, posts, enqueue, state: () => state.state,
    advance: n => { clock += n; }, revoke: () => { approved = false; }, status: n => { status = n; }, verifyFail: () => { verifyFail = true; } };
}

test('callback validation blocks private/mapped/reserved destinations and rebinding on each lookup', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('93.184.216.34'), true);
  for (const url of ['http://callback.example', 'https://127.0.0.1', 'https://[::1]', 'https://x:y@callback.example', 'https://callback.example:8443', 'https://callback.local']) assert.throws(() => callbackUrl(url));
  let privateNow = false;
  const lookup = async () => [{ address: privateNow ? '127.0.0.1' : '93.184.216.34', family: 4 }];
  assert.equal((await resolveCallback('callback.example', lookup)).address, '93.184.216.34'); privateNow = true;
  await assert.rejects(resolveCallback('callback.example', lookup), { code: 'callback_not_public' });
  await assert.rejects(resolveCallback('callback.example', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), { code: 'callback_not_public' });
});

test('subscription verifies a signed challenge, encrypts secrets, renews idempotently and survives service restart', async () => {
  const h = fixture(); const sub = await h.events.subscribe(principal, params);
  const request = h.posts[0];
  assert.equal(new Webhook(secret).verify(request.body, request.headers).type, 'verification');
  assert(!JSON.stringify(h.state()).includes(secret)); assert(!JSON.stringify(h.state()).includes(params.delivery.url));
  assert.equal((await h.events.subscribe(principal, { ...params, ttlMs: 60000 })).id, sub.id);
  assert.equal(h.state().subscriptions.length, 1); assert.equal(h.posts.length, 1, 'bounded verification cache');
  h.advance(300001);
  await h.events.subscribe(principal, params); assert.equal(h.posts.length, 2, 'cache lifetime is not extended by cached renewals');
  await h.enqueue();
  const restarted = createDotEvents(h.config);
  assert.equal((await restarted.dispatchOne()).accepted, true);
  assert.equal((await restarted.dispatchOne()).attempted, false);
  assert.equal(h.state().tasks[0].status, 'pending', 'a webhook 2xx never completes a dot task');
  assert(!h.posts.at(-1).body.includes('Private synthetic question'));
  assert.equal(h.state().outbox[0].deliveries[sub.id].state, 'accepted');
});

test('callback failure, wrong scope and foreign unsubscribe cannot activate or stop owner subscriptions', async () => {
  const h = fixture(); h.verifyFail();
  await assert.rejects(h.events.subscribe(principal, params), { code: 'callback_verification_failed' });
  assert.equal(h.state().subscriptions?.length || 0, 0);
  await assert.rejects(h.events.list({ ...principal, scopes: [] }), { code: 'scope_required' });
  await assert.rejects(h.events.subscribe(principal, { ...params, arguments: { ownerId: 'forged' } }), { code: 'invalid_subscription' });
  const good = fixture(); await good.events.subscribe(principal, params);
  await good.events.unsubscribe({ ...principal, ownerId: 'another-owner' }, { ...params, delivery: { mode: 'webhook', url: params.delivery.url } });
  assert.equal(good.state().subscriptions[0].status, 'active');
});

test('transient webhook retries preserve event ID with fresh signatures; unsubscribe/revoke/410 stop future delivery', async () => {
  const h = fixture(); await h.events.subscribe(principal, params); await h.enqueue(); h.status(503);
  assert.equal((await h.events.dispatchOne()).accepted, false);
  assert.equal((await h.events.dispatchOne()).attempted, false);
  const first = h.posts.at(-1); h.advance(2000); h.status(200);
  assert.equal((await h.events.dispatchOne()).accepted, true);
  const retry = h.posts.at(-1);
  assert.equal(first.headers['webhook-id'], retry.headers['webhook-id']);
  assert.notEqual(first.headers['webhook-timestamp'], retry.headers['webhook-timestamp']);
  await h.enqueue('two'); h.revoke(); const count = h.posts.length;
  assert.equal((await h.events.dispatchOne()).accepted, false); assert.equal(h.posts.length, count);
  assert.equal(h.state().subscriptions[0].status, 'revoked');
  const other = fixture(); await other.events.subscribe(principal, params); await other.enqueue(); other.status(410);
  await other.events.dispatchOne(); assert.equal(other.state().subscriptions[0].status, 'revoked');
  const unsub = fixture(); await unsub.events.subscribe(principal, params); await unsub.enqueue();
  const args = { name: params.name, arguments: {}, delivery: { mode: 'webhook', url: params.delivery.url } };
  await unsub.events.unsubscribe(principal, args); await unsub.events.unsubscribe(principal, args);
  assert.equal((await unsub.events.dispatchOne()).attempted, false);
});

test('key rotation uses a bounded dual signature and ciphertext is bound to subscription ID', async () => {
  const h = fixture(); await h.events.subscribe(principal, params);
  const replacement = 'whsec_' + crypto.randomBytes(32).toString('base64');
  await h.events.subscribe(principal, { ...params, delivery: { ...params.delivery, secret: replacement } });
  await h.enqueue(); await h.events.dispatchOne();
  const request = h.posts.at(-1);
  assert.equal(new Webhook(secret).verify(request.body, request.headers).name, params.name);
  assert.equal(new Webhook(replacement).verify(request.body, request.headers).name, params.name);
  const sub = h.state().subscriptions[0];
  assert.throws(() => h.vault.open('different-subscription', sub.delivery));
  assert.throws(() => createSecretVault(Buffer.alloc(5)), { code: 'bridge_encryption_key_required' });
  assert.throws(() => signedWebhook({ id: 'one', payload: {}, subscriptionId: 'sub', secret: 'weak' }), { code: 'invalid_signing_secret' });
});

test('HTTPS transport pins vetted DNS address, keeps TLS validation, bounds replies and never follows redirects', async () => {
  let seen, calls = 0, responseStatus = 200, responseSize = 2;
  const request = (options, receive) => {
    calls++; seen = options;
    const req = new EventEmitter(); req.setTimeout = () => {};
    req.destroy = error => { queueMicrotask(() => { req.emit('error', error); req.emit('close'); }); };
    req.end = () => options.lookup(options.hostname, {}, (error, address, family) => {
      if (error) { req.destroy(error); return; }
      assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
      const response = new EventEmitter(); response.statusCode = responseStatus; response.resume = () => {};
      receive(response);
      if (responseStatus >= 300 && responseStatus < 400) return;
      response.emit('data', Buffer.alloc(responseSize)); response.emit('end'); req.emit('close');
    });
    return req;
  };
  const post = createWebhookPost({ request, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal((await post('https://callback.example/events', { body: '{}', headers: {} })).ok, true);
  assert.equal(seen.servername, 'callback.example'); assert.equal(seen.rejectUnauthorized, true); assert.equal(seen.agent, false);
  responseStatus = 302;
  await assert.rejects(post('https://callback.example/events', { body: '{}', headers: {} }), { code: 'redirect_not_allowed' });
  assert.equal(calls, 2, 'redirect did not create another request');
  responseStatus = 200; responseSize = 70000;
  await assert.rejects(post('https://callback.example/events', { body: '{}', headers: {} }), { code: 'callback_response_too_large' });
  const blocked = createWebhookPost({ request, lookup: async () => [{ address: '169.254.169.254', family: 4 }] });
  await assert.rejects(blocked('https://callback.example/events', { body: '{}', headers: {} }), { code: 'callback_not_public' });
});

test('expired subscriptions, permanent failures and bounded retry exhaustion cannot send indefinitely', async () => {
  const expired = fixture(); await expired.events.subscribe(principal, { ...params, ttlMs: 1000 });
  await expired.enqueue(); expired.advance(1001);
  assert.equal((await expired.events.dispatchOne()).attempted, false);
  const failure = fixture(); const sub = await failure.events.subscribe(principal, params); await failure.enqueue(); failure.status(503);
  for (let i = 0; i < 6; i++) { assert.equal((await failure.events.dispatchOne()).accepted, false); failure.advance(60000); }
  assert.equal(failure.state().outbox[0].deliveries[sub.id].state, 'exhausted');
  assert.equal((await failure.events.dispatchOne()).attempted, false);
  const large = fixture(); await large.events.subscribe(principal, params); await large.enqueue(); large.status(413);
  await large.events.dispatchOne(); large.advance(60000);
  assert.equal((await large.events.dispatchOne()).attempted, false);
});
