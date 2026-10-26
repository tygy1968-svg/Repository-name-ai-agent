import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCallLifecycle } from '../call-lifecycle.js';

function fixture(status = 'ringing') {
  const participant = { identity: 'phone-test', attributes: { 'sip.callStatus': status } };
  const room = Object.assign(new EventEmitter(), {
    isConnected: true, remoteParticipants: new Map([[participant.identity, participant]])
  });
  return { participant, room, lifecycle: createCallLifecycle(room) };
}

test('ringing timeout never becomes an answered call', async () => {
  const { lifecycle, participant } = fixture();
  assert.deepEqual(await lifecycle.waitForAnswer(participant, 5), { answered: false, reason: 'answer_timeout' });
  lifecycle.dispose();
});

test('answer is accepted only after SIP active', async () => {
  const { lifecycle, participant } = fixture();
  setTimeout(() => { participant.attributes['sip.callStatus'] = 'active'; }, 5);
  const result = await lifecycle.waitForAnswer(participant, 200);
  assert.equal(result.answered, true);
  assert.equal(result.participant, participant);
  lifecycle.dispose();
});

test('disconnect before answer is not successful', async () => {
  const { lifecycle, room, participant } = fixture();
  room.emit('disconnected');
  assert.deepEqual(await lifecycle.waitForAnswer(participant, 5), { answered: false, reason: 'room_disconnected' });
  lifecycle.dispose();
});

test('room disconnect wins over stale active participant data', async () => {
  const { lifecycle, room, participant } = fixture('active');
  await lifecycle.waitForAnswer(participant);
  room.emit('disconnected');
  const result = await lifecycle.waitForEnd(200);
  assert.equal(result.ended, true);
  assert.equal(result.reason, 'room_disconnected');
  lifecycle.dispose();
  assert.equal(room.listenerCount('disconnected'), 0);
  assert.equal(room.listenerCount('participantDisconnected'), 0);
});

test('own successful hangup ends wait without a participant update', async () => {
  const { lifecycle, participant } = fixture('active');
  await lifecycle.waitForAnswer(participant);
  lifecycle.markEnded('agent_hangup');
  lifecycle.markEnded('job_shutdown');
  const result = await lifecycle.waitForEnd(200);
  assert.equal(result.ended, true);
  assert.equal(result.reason, 'agent_hangup');
  lifecycle.dispose();
});

test('another participant leaving does not end the phone call', async () => {
  const { lifecycle, room, participant } = fixture('active');
  await lifecycle.waitForAnswer(participant);
  room.emit('participantDisconnected', { identity: 'another-agent' });
  assert.equal((await lifecycle.waitForEnd(5)).ended, false);
  room.emit('participantDisconnected', participant);
  assert.equal((await lifecycle.waitForEnd(5)).reason, 'participant_disconnected');
  lifecycle.dispose();
});
