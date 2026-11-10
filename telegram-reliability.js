import { OWNER_WORKSPACE_CHAT_ID, isOwnerTelegramMessage } from './channel-tools.js';

export const RELIABILITY_VERSION = 'telegram_reliability_2026_11_10';
export const GROUP_IDENTITY_HINT = 'Сообщение отправлено от имени группы, поэтому я не могу подтвердить автора. Напиши мне лично: https://t.me/kuzya_echo_bot — или переключи отправку в группе на свой личный профиль. Личную память по анонимному сообщению я не открываю.';

export function telegramDecision(message, ownerId) {
  if (isOwnerTelegramMessage(message, ownerId)) return { accepted: true, reason: 'owner' };
  const ownWorkspace = ['group', 'supergroup'].includes(message?.chat?.type) && String(message.chat.id) === OWNER_WORKSPACE_CHAT_ID;
  const anonymous = ownWorkspace && String(message.sender_chat?.id) === String(message.chat.id) && !message.is_automatic_forward;
  return { accepted: false, reason: anonymous ? 'anonymous_workspace_sender' : !ownerId ? 'unverified_sender' : 'sender_or_chat_not_allowed', hint: anonymous && Boolean(message.text || message.photo || message.voice) };
}

// Deliberately process-local: it prevents concurrent redelivery and serializes
// owner turns, but is not a durable job queue or an exactly-once call guarantee.
export function createTelegramQueue({ now = Date.now, maxPending = 8, maxSeen = 2000, ttl = 86400000, onError = () => {} } = {}) {
  let tail = Promise.resolve(), pending = 0;
  const seen = new Map();
  const keyFor = update => Number.isSafeInteger(update?.update_id) ? `update:${update.update_id}` :
    Number.isSafeInteger(update?.message?.message_id) && update?.message?.chat?.id != null ? `message:${update.message.chat.id}:${update.message.message_id}` : null;
  return {
    submit(update, job) {
      for (const [key, at] of seen) { if (now() - at >= ttl) seen.delete(key); }
      const key = keyFor(update);
      if (key && seen.has(key)) return 'duplicate';
      if (pending >= maxPending) return 'busy';
      if (key) { seen.set(key, now()); while (seen.size > maxSeen) seen.delete(seen.keys().next().value); }
      pending++;
      tail = tail.then(job).catch(error => { try { onError(error); } catch {} }).finally(() => { pending--; });
      return 'queued';
    },
    drain: () => tail,
    get pending() { return pending; }
  };
}

export function createNoticeLimiter({ now = Date.now, interval = 60000 } = {}) {
  let nextAt = 0;
  return () => { if (now() < nextAt) return false; nextAt = now() + interval; return true; };
}

export function splitTelegramText(value, limit = 3500) {
  const text = String(value || '');
  if (!text.trim()) throw new Error('empty_telegram_reply');
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    const newline = rest.lastIndexOf('\n', end - 1);
    if (newline > end / 2) end = newline + 1;
    chunks.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const ACCOUNT_CODES = new Set(['credit_balance_exhausted', 'insufficient_quota', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'invalid_api_key']);
export const isAccountError = error => ACCOUNT_CODES.has(error?.code) || error?.status === 401 || error?.type === 'insufficient_quota';

export function telegramFailureText(error) {
  if (error?.code === 'credit_balance_exhausted' || error?.code === 'insufficient_quota') return 'Я получил сообщение, но у меня закончился баланс OpenAI API. Нужно пополнить баланс организации, к которой относится мой API-ключ, и затем повторить сообщение. Подписка ChatGPT и этот баланс учитываются отдельно.';
  if (isAccountError(error)) return 'Я получил сообщение, но доступ к модели ограничен настройками API: нужно проверить ключ, оплату или лимит организации/проекта. Повторные сообщения это ограничение не снимут. Пароли и ключи в чат присылать не нужно.';
  if (error?.status === 429) return 'Я получил сообщение, но сейчас достигнут временный лимит запросов к модели. Попробуй чуть позже; задачу я пока не выполнил.';
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return 'Я получил сообщение, но сервис не успел ответить вовремя. Попробуй отправить его ещё раз. Успешное выполнение не подтверждено.';
  return 'Я получил сообщение, но при обработке возникла техническая ошибка. Попробуй ещё раз. Не считаю задачу выполненной без подтверждённого результата.';
}
