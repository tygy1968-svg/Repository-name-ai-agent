import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallApprovals } from '../call-approvals.js';
import { createVoiceAccess, createVoiceToolHandler } from '../channel-tools.js';

function fixture(extra = {}) {
  let time = Date.parse('2026-11-10T18:00:00Z'), serial = 0;
  const sent = [];
  const access = createVoiceAccess({ now: () => time });
  const approvals = createCallApprovals({ access, now: () => time, loadOwner: async () => '42',
    randomToken: () => (++serial).toString(16).padStart(32, '0'),
    send: async (owner, text, markup) => { sent.push({ owner, text, markup }); return { message_id: sent.length }; }, ...extra });
  const callback = (n = 0) => ({ from: { id: 42, is_bot: false }, message: { chat: { id: 42, type: 'private' }, message_id: n + 1 }, data: sent[n].markup.inline_keyboard[0][0].callback_data });
  return { access, approvals, sent, callback, advance: ms => { time += ms; } };
}

test('button opens exactly one active call once; request itself never grants memory', async () => {
  const h = fixture(); h.approvals.open('a'); h.approvals.open('b');
  const pending = await h.approvals.request('a');
  assert.equal(pending.authenticated, false); assert.equal(h.access.has('a'), false);
  assert.equal(h.sent[0].owner, '42'); assert.match(h.sent[0].text, /Коды диктовать не нужно/);
  assert(Buffer.byteLength(h.callback().data) <= 64);
  assert.equal((await h.approvals.confirm(h.callback())).authenticated, true);
  assert.equal(h.access.has('a'), true); assert.equal(h.access.has('b'), false);
  assert.equal((await h.approvals.confirm(h.callback())).ok, false);
  h.advance(45 * 60000); assert.equal(h.access.has('a'), false);
});

test('forwarded, foreign, bot, group and mismatched-message callbacks cannot grant access', async () => {
  const h = fixture(); h.approvals.open('a'); await h.approvals.request('a');
  for (const change of [c => c.from.id = 43, c => c.from.is_bot = true, c => c.message.chat.type = 'group',
    c => c.message.chat.id = 43, c => c.message.message_id = 100, c => c.data += 'x']) {
    const callback = h.callback(); change(callback);
    assert.equal((await h.approvals.confirm(callback)).ok, false); assert.equal(h.access.has('a'), false);
  }
  assert.equal((await h.approvals.confirm(h.callback())).ok, true);
});

test('closed, expired and restarted approvals are unusable', async () => {
  for (const mode of ['close', 'expire', 'restart']) {
    const h = fixture(); h.approvals.open('a'); await h.approvals.request('a');
    if (mode === 'close') h.approvals.close('a');
    if (mode === 'expire') h.advance(5 * 60000);
    const handler = mode === 'restart' ? fixture().approvals : h.approvals;
    assert.equal((await handler.confirm(h.callback())).ok, false); assert.equal(h.access.has('a'), false);
  }
});

test('duplicate and concurrent requests send one button, with bounded global rate', async () => {
  const h = fixture(); h.approvals.open('a'); h.approvals.open('b');
  await Promise.all([h.approvals.request('a'), h.approvals.request('a')]);
  await h.approvals.request('a'); assert.equal(h.sent.length, 1);
  assert.equal((await h.approvals.request('b')).error, 'approval_rate_limited');
  h.advance(60000); await h.approvals.request('b'); assert.equal(h.sent.length, 2);
  assert.equal((await h.approvals.request('unknown')).error, 'call_not_active');
});

test('delivery failure and a call closing during delivery never create an access grant', async () => {
  const failure = fixture({ send: async () => { throw new Error('fake secret'); } });
  failure.approvals.open('a'); const result = await failure.approvals.request('a');
  assert.equal(result.error, 'approval_delivery_failed'); assert(!JSON.stringify(result).includes('fake secret'));
  const h = fixture({ send: async () => { h.approvals.close('a'); return { message_id: 1 }; } });
  h.approvals.open('a'); assert.equal((await h.approvals.request('a')).error, 'call_not_active');
  assert.equal(h.access.has('a'), false);
});

test('memory tools deny strangers without a button and allow reads and report actual access after owner clicks', async () => {
  const h = fixture(); h.approvals.open('a'); let reads = 0;
  const handler = createVoiceToolHandler({ callId: 'a', access: h.access, store: { load: async () => { reads++; return {}; } }, requestAccess: () => h.approvals.request('a') });
  assert.equal((await handler('read_shared_context', {})).error, 'owner_authentication_required'); assert.equal(reads, 0); 
  assert.equal((await handler('request_owner_access', {})).authenticated, false);
  await h.approvals.confirm(h.callback());
  assert.equal((await handler('request_owner_access', {})).authenticated, true);
  assert.equal((await handler('read_shared_context', {})).authenticated, true); assert.equal(reads, 1);
  h.approvals.close('a'); assert.equal(h.access.has('a'), false);
});
