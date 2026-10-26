import { setTimeout as delay } from 'node:timers/promises';

const terminalStatuses = new Set(['hangup', 'disconnected', 'ended', 'inactive']);
export const sipStatus = (participant) => String(
  participant?.attributes?.['sip.callStatus'] || participant?.attributes?.['sip.call_status'] || ''
).toLowerCase();

// Room disconnect can leave the last participant object with a stale `active` status.
// Keep an independent terminal state and never infer an answer from a timeout.
export function createCallLifecycle(room) {
  let identity;
  let endedReason;
  const markEnded = (reason) => { endedReason ||= reason; };
  const onDisconnect = () => markEnded('room_disconnected');
  const onParticipantDisconnect = (participant) => {
    if (participant.identity === identity) markEnded('participant_disconnected');
  };
  room.on('disconnected', onDisconnect);
  room.on('participantDisconnected', onParticipantDisconnect);
  const inspect = () => {
    if (room.isConnected === false) markEnded('room_disconnected');
    const current = room.remoteParticipants.get(identity);
    if (!current) markEnded('participant_disconnected');
    const status = sipStatus(current);
    if (terminalStatuses.has(status)) markEnded(`sip_status_${status}`);
    return { current, status };
  };
  return {
    markEnded,
    async waitForAnswer(participant, timeoutMs = 45000) {
      identity = participant.identity;
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const { current, status } = inspect();
        if (endedReason) return { answered: false, reason: endedReason };
        if (status === 'active') return { answered: true, participant: current };
        if (Date.now() >= deadline) return { answered: false, reason: 'answer_timeout' };
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    },
    async waitForEnd(timeoutMs = 15 * 60 * 1000) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        inspect();
        if (endedReason) return { ended: true, reason: endedReason, identity };
        if (Date.now() >= deadline) return { ended: false, reason: 'call_end_wait_timeout', identity };
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    },
    dispose() {
      room.off('disconnected', onDisconnect);
      room.off('participantDisconnected', onParticipantDisconnect);
    }
  };
}
