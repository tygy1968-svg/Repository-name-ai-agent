import crypto from 'node:crypto';

export const CALL_APPROVAL_VERSION = 'telegram_call_button_2026_11_10';
// Process-local, call-specific approval. Caller ID never grants access.
export function createCallApprovals({ access, loadOwner, send, now = Date.now, randomToken = () => crypto.randomBytes(16).toString('hex') }) {
  const calls = new Map();
  const flights = new Map();
  let lastSent = -Infinity;
  function open(callId, label = 'Текущий телефонный разговор') {
    if (calls.has(callId)) return true;
    if (calls.size >= 100) return false;
    calls.set(callId, { label, openedAt: now() });
    return true;
  }
  function close(callId) { calls.delete(callId); access.revoke(callId); }
  const pending = () => ({ ok: true, authenticated: false, approvalPending: true,
    instruction: 'Кнопка подтверждения отправлена в личный Telegram Юли. Скажи: «Нажми “Это я — открыть память” в нашем личном Telegram и скажи мне “готово”». Код не нужен. После «готово» снова вызови нужный инструмент; не объявляй память открытой до authenticated=true.' });
  async function deliver(callId) {
    const call = calls.get(callId);
    if (!call) return { ok: false, error: 'call_not_active' };
    if (access.has(callId)) return { ok: true, authenticated: true };
    if (call.token && call.expiresAt > now()) return pending();
    if (now() - lastSent < 60000) return { ok: false, error: 'approval_rate_limited', instruction: 'Подожди минуту перед повторной отправкой кнопки. Память пока закрыта.' };
    const owner = await loadOwner();
    if (!owner) return { ok: false, error: 'owner_not_bound' };
    if (calls.get(callId) !== call) return { ok: false, error: 'call_not_active' };
    // Reserve before network I/O: concurrent calls cannot bypass the global limit.
    if (now() - lastSent < 60000) return { ok: false, error: 'approval_rate_limited' };
    lastSent = now();
    const token = randomToken();
    Object.assign(call, { token, owner: String(owner), expiresAt: now() + 5 * 60000 });
    const started = new Date(call.openedAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
    try {
      const message = await send(owner, `Кузя: запрос доступа к личной памяти.\n${call.label}, начало ${started} по Киеву.\nНажми только если сейчас разговариваешь со мной по телефону. Кнопка открывает память именно для этого звонка, до 45 минут. Коды диктовать не нужно.`, {
        inline_keyboard: [[{ text: 'Это я — открыть память', callback_data: `kzcall:${token}` }]]
      });
      if (!Number.isInteger(message?.message_id)) throw new Error('missing_message_id');
      if (calls.get(callId) !== call) return { ok: false, error: 'call_not_active' };
      call.messageId = message.message_id;
      return pending();
    } catch {
      if (calls.get(callId) === call) { delete call.token; delete call.messageId; }
      return { ok: false, error: 'approval_delivery_failed', instruction: 'Не удалось отправить кнопку в личный Telegram. Память остаётся закрытой. Открой личный чат @kuzya_echo_bot и нажми «Начать», если ещё не нажимала.' };
    }
  }
  function request(callId) {
    if (!flights.has(callId)) flights.set(callId, deliver(callId).finally(() => flights.delete(callId)));
    return flights.get(callId);
  }
  async function confirm(callback) {
    const owner = await loadOwner();
    if (!owner || callback?.from?.is_bot !== false || String(callback?.from?.id) !== String(owner) ||
      callback?.message?.chat?.type !== 'private' || String(callback.message.chat.id) !== String(owner)) return { ok: false, error: 'owner_only' };
    const match = /^kzcall:([a-f0-9]{32})$/.exec(String(callback.data || ''));
    if (!match) return { ok: false, error: 'invalid_approval' };
    for (const [callId, call] of calls) {
      if (call.token !== match[1] || call.owner !== String(owner) || call.messageId !== callback.message.message_id) continue;
      if (call.expiresAt <= now()) return { ok: false, error: 'approval_expired' };
      delete call.token; // Atomic consumption: a duplicate click cannot renew the grant.
      access.authorize(callId);
      return { ok: true, authenticated: true, callId };
    }
    return { ok: false, error: 'approval_not_active' };
  }
  return { open, close, request, confirm };
}
