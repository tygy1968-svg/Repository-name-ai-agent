import crypto from 'node:crypto';

export const BINDING_KEY = '__kuzya_owner_telegram_binding_v1';
// Only the hash is committed. The short-lived enrollment link is delivered to
// the owner in the existing trusted conversation, never via a public group.
const ENROLLMENT_HASH = '0b83dc4dda25600b2a7accd557e5b45dcb111cb23fa215725f500d7ff91498c3';
const ENROLLMENT_EXPIRES = '2026-10-27T23:06:30.592734+00:00';

export function humanTelegramSender(message) {
  return message?.from?.is_bot === false && !message.sender_chat &&
    /^[1-9][0-9]{0,15}$/.test(String(message.from.id)) &&
    String(message.from.id) !== '1087968824';
}

export function createOwnerIdentity({ url, key, fetchImpl = fetch,
  tokenHash = ENROLLMENT_HASH, expiresAt = ENROLLMENT_EXPIRES, now = Date.now }) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const endpoint = `${url}/rest/v1/agent_state`;
  async function load() {
    const response = await fetchImpl(`${endpoint}?user_id=eq.${BINDING_KEY}&select=summary`, {
      headers, signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('owner_binding_read_failed');
    const rows = await response.json();
    if (!rows.length) return null;
    const binding = JSON.parse(rows[0].summary);
    if (binding.version !== 1 || !humanTelegramSender({ from: { id: binding.telegramUserId, is_bot: false } })) throw new Error('invalid_owner_binding');
    return String(binding.telegramUserId);
  }
  async function enroll(message, token) {
    if (!humanTelegramSender(message) || message.chat?.type !== 'private' || String(message.chat.id) !== String(message.from.id)) return false;
    const digest = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(tokenHash)) || now() >= Date.parse(expiresAt)) return false;
    const candidate = String(message.from.id);
    const existing = await load();
    if (existing) return existing === candidate;
    // Plain INSERT: the primary key makes first enrollment atomic. Never upsert
    // over a binding, even if a second account obtains the old enrollment link.
    const response = await fetchImpl(endpoint, { method: 'POST', headers,
      signal: AbortSignal.timeout(5000), body: JSON.stringify({ user_id: BINDING_KEY,
        summary: JSON.stringify({ version: 1, telegramUserId: candidate, verifiedAt: new Date(now()).toISOString(), method: 'trusted_conversation_link' }),
        updated_at: new Date(now()).toISOString() }) });
    if (!response.ok && response.status !== 409) throw new Error('owner_binding_write_failed');
    return await load() === candidate;
  }
  return { load, enroll };
}
