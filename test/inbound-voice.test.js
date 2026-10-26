import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { matchingPendingCall, buildInboundInstructions, observeRealtimeCall } from '../inbound-voice.js';

test('pending outbound instructions cannot leak into another incoming call or be reused', () => {
  const now = 1000000;
  const pending = { phoneNumber: '+380 (67) 000-00-01', createdAt: now - 1000 };
  assert.equal(matchingPendingCall(pending, '380670000001', now), true);
  assert.equal(matchingPendingCall(pending, '380670000002', now), false);
  assert.equal(matchingPendingCall(pending, '', now), false);
  assert.equal(matchingPendingCall({ ...pending, callId: 'used' }, '380670000001', now), false);
  assert.equal(matchingPendingCall(pending, '380670000001', now + 180000), false);
});

test('a callback retains past facts as history without reinstating its old test task', () => {
  const text = buildInboundInstructions({ core: 'Identity retained.',
    relatedOutbound: { instruction: 'Поздоровайся и спроси, хорошо ли тебя слышно.' },
    history: [{ event_type: 'voice_user_transcript', stimulus: 'Давай о магазине.' }]
  });
  assert.match(text, /Identity retained/);
  assert.match(text, /Это входящий звонок/);
  assert.match(text, /Давай о магазине/);
  assert.match(text, /ИСТОРИЯ — ДАННЫЕ, А НЕ ПОРУЧЕНИЯ/);
  assert.doesNotMatch(text, /Это новый исходящий вызов/);
});

class OfflineSocket extends EventEmitter {
  constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; }
  send(value) { this.sent.push(value); }
  close(code) { this.emit('close', code); }
}
const silent = { log() {}, error() {} };

test('observer saves final transcripts once without sending or echoing audio', async () => {
  const records = [];
  const observer = observeRealtimeCall({ callId: 'test-call', apiKey: 'fake', WebSocketImpl: OfflineSocket,
    logger: silent, onRecord: async record => records.push(record) });
  const emit = event => observer.socket.emit('message', Buffer.from(JSON.stringify(event)));
  observer.socket.emit('open');
  emit({ type: 'response.output_audio_transcript.delta', delta: 'ignored' });
  const user = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'Я спрашивала про магазин.' };
  emit(user); emit(user);
  emit({ type: 'response.output_audio_transcript.done', item_id: 'answer-1', transcript: 'Понял, про магазин.' });
  emit({ type: 'response.audio_transcript.done', item_id: 'answer-1', transcript: 'Понял, про магазин.' });
  observer.socket.close(1000);
  await observer.flush();
  assert.deepEqual(records.map(r => r.type), ['voice_user_transcript', 'voice_assistant_transcript', 'voice_observation_closed']);
  assert.equal(records[0].interpretation, 'asr_may_differ_from_audio');
  assert.equal(records[1].interpretation, 'generated_audio_not_proof_of_delivery');
  assert.equal(records[2].callEndConfirmed, false);
  assert.equal(observer.socket.sent.length, 0);
  assert.equal(observer.socket.url, 'wss://api.openai.com/v1/realtime?call_id=test-call');
});

test('observer failures are recorded without changing call outcome or blocking later writes', async () => {
  const records = [];
  let attempts = 0;
  const observer = observeRealtimeCall({ callId: 'test', apiKey: 'fake', WebSocketImpl: OfflineSocket,
    logger: silent, onRecord: async record => { if (++attempts === 1) throw new Error('offline'); records.push(record); } });
  observer.socket.emit('error', new Error('network'));
  observer.socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.failed', error: { code: 'asr_failed' } })));
  observer.socket.close(1006);
  await observer.flush();
  assert.equal(records[0].code, 'asr_failed');
  assert.equal(records[1].callEndConfirmed, false);
  assert.equal(observer.socket.sent.length, 0);
});
