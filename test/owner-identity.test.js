import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createOwnerIdentity, BINDING_KEY } from '../owner-identity.js';

const token = 'bind_test-secret-never-committed-production';
const human = id => ({ from: { id, is_bot: false }, chat: { id, type: 'private' } });
function fixture() {
  let row, writes = 0, unavailable = false;
  const options = { url: 'https://database.invalid', key: 'fake',
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(200000).toISOString(), now: () => 100000,
    fetchImpl: async (url, options) => {
      if (unavailable) return new Response('', { status: 503 });
      if (options.method === 'POST') {
        writes++;
        if (row) return new Response('', { status: 409 });
        const body = JSON.parse(options.body);
        assert.equal(body.user_id, BINDING_KEY);
        assert.equal(body.summary.includes(token), false);
        row = { summary: body.summary };
        return new Response('', { status: 201 });
      }
      return Response.json(row ? [row] : []);
    }
  };
  return { options, identity: createOwnerIdentity(options), writes: () => writes, fail: () => { unavailable = true; } };
}

test('owner link binds a real private sender, survives restart, cannot transfer ownership', async () => {
  const f = fixture();
  assert.equal(await f.identity.enroll(human('123'), 'wrong'), false);
  assert.equal(await f.identity.load(), null);
  assert.equal(await f.identity.enroll(human('123'), token), true);
  assert.equal(await createOwnerIdentity(f.options).load(), '123');
  assert.equal(await f.identity.enroll(human('123'), token), true);
  assert.equal(await f.identity.enroll(human('456'), token), false);
  assert.equal(f.writes(), 1);
});

test('enrollment rejects expired tokens, service bots, group and anonymous senders', async () => {
  const f = fixture();
  for (const message of [human('1087968824'), { ...human('123'), from: { id: '123', is_bot: true } },
    { ...human('123'), sender_chat: { id: '-1' } }, { ...human('123'), chat: { id: '-1', type: 'supergroup' } }]) {
    assert.equal(await f.identity.enroll(message, token), false);
  }
  assert.equal(await createOwnerIdentity({ ...f.options, now: () => 200000 }).enroll(human('123'), token), false);
  assert.equal(f.writes(), 0);
});

test('concurrent enrollment has one winner; database failures never authorize', async () => {
  const f = fixture();
  const results = await Promise.all([f.identity.enroll(human('123'), token), f.identity.enroll(human('456'), token)]);
  assert.equal(results.filter(Boolean).length, 1);
  f.fail();
  await assert.rejects(f.identity.load(), /read_failed/);
  await assert.rejects(f.identity.enroll(human('123'), token), /read_failed/);
});
