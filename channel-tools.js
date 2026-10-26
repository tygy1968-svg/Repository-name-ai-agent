import crypto from 'node:crypto';
import { humanTelegramSender } from './owner-identity.js';
import { OWNER_TELEGRAM_ID, formatContext } from './unified-context.js';

// Existing workspace chat, verified from historical owner messages in Supabase.
export const OWNER_WORKSPACE_CHAT_ID = '-1003870803501';
export function isVoiceConnectionRequest(text) {
  return /^(?:\/?voice(?:@\w+)?(?:\s+\d{4,8})?|\/start\s+voice|личный\s+код\s+\d{4,8}|(?:дай|пришли|получи)\s+код(?:\s+для\s+звонка)?|(?:подключи(?:ть)?|свяжи)\s+телефон)\s*[.!]?$/iu.test(String(text || '').trim());
}
export function isOwnerTelegramMessage(message, verifiedOwnerId) {
  if (!verifiedOwnerId || !humanTelegramSender(message) || String(message.from.id) !== String(verifiedOwnerId)) return false;
  const chat = message?.chat;
  return (chat?.type === 'private' && String(chat.id) === String(verifiedOwnerId)) ||
    (['group', 'supergroup'].includes(chat?.type) && String(chat.id) === OWNER_WORKSPACE_CHAT_ID);
}

export const webhookSecret = token => crypto.createHmac('sha256', token).update('kuzya-telegram-webhook-v1').digest('hex');
export function validWebhookSecret(received, expected) {
  const a = Buffer.from(String(received || '')), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function createVoiceAccess({ now = Date.now, randomCode = () => String(crypto.randomInt(100000, 1000000)) } = {}) {
  let challenge = null;
  const authorized = new Map();
  return {
    issue(userId) {
      for (const [id, expires] of authorized) if (expires <= now()) authorized.delete(id);
      if (String(userId) !== OWNER_TELEGRAM_ID) throw new Error('owner_only');
      challenge = { code: randomCode(), expires: now() + 5 * 60000, attempts: 0 };
      return challenge.code;
    },
    verify(callId, code) {
      if (!callId || !challenge || challenge.expires < now() || challenge.attempts >= 5) return false;
      challenge.attempts++;
      if (!validWebhookSecret(String(code).replace(/\s/g, ''), challenge.code)) return false;
      challenge = null; authorized.set(callId, now() + 45 * 60000); return true;
    },
    has(callId) { return (authorized.get(callId) || 0) > now(); },
    revoke(callId) { authorized.delete(callId); },
    redact(text) { return challenge ? String(text).split(challenge.code).join('[код скрыт]') : String(text).replace(/\b\d{6}\b/g, '[код скрыт]'); }
  };
}

export const VOICE_TOOLS = [
  { type: 'function', name: 'authenticate_owner', description: 'Подтвердить Юлю одноразовым шестизначным кодом из команды /voice в личном Telegram Кузи. Не проси пароли от аккаунтов.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false } },
  { type: 'function', name: 'read_shared_context', description: 'После подтверждения Юли прочитать общую память, сообщения Telegram Кузе и историю звонков. Вызови перед ответом о прошлых событиях; отсутствие результата не доказывает отсутствие события.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { type: 'function', name: 'search_internet', description: 'Найти свежую публичную информацию в интернете. Возвращает источники и время проверки, либо явную ошибку. Не отправляй в запрос личную память, коды или номера.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }
];

export async function searchInternet(query, { apiKey, fetchImpl = fetch } = {}) {
  const q = String(query || '').trim();
  if (!apiKey) return { ok: false, error: 'internet_not_configured' };
  if (!q || q.length > 500) return { ok: false, error: 'invalid_query' };
  try {
    const response = await fetchImpl(`https://serpapi.com/search.json?${new URLSearchParams({ q, api_key: apiKey, hl: 'ru', gl: 'ua' })}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, error: `search_http_${response.status}` };
    const data = await response.json();
    if (data.error) return { ok: false, error: 'search_provider_error' };
    return { ok: true, checkedAt: new Date().toISOString(), evidence: 'search_snippets_not_full_pages',
      results: (data.organic_results || []).slice(0, 5).map(row => ({ title: String(row.title || '').slice(0, 300), snippet: String(row.snippet || '').slice(0, 1200), url: row.link })) };
  } catch { return { ok: false, error: 'search_unavailable' }; }
}

export function createVoiceToolHandler({ callId, access, store, search, onResult = async () => {} }) {
  let count = 0;
  return async (name, args) => {
    const finish = async result => {
      try { await onResult({ name, ok: result.ok, error: result.error || null, checkedAt: new Date().toISOString(), sources: result.results?.map(r => r.url) || [] }); }
      catch { /* Audit failure must not invent a failure of a successful read. */ }
      return result;
    };
    if (++count > 40) return finish({ ok: false, error: 'call_tool_limit' });
    let result;
    if (name === 'authenticate_owner') {
      if (!access.has(callId) && !access.verify(callId, args.code)) return finish({ ok: false, error: 'authentication_failed', instruction: 'Нужен именно шестизначный код, созданный ботом после /voice или «подключи телефон». Пользовательский номер/личный PIN не является этим кодом. Telegram подключён; личная память ещё не открыта.' });
      result = { ok: true, authenticated: true, context: await store.load({ userId: OWNER_TELEGRAM_ID }) };
    } else if (name === 'read_shared_context') {
      if (!access.has(callId)) return finish({ ok: false, error: 'owner_authentication_required', instruction: 'Telegram подключён. Для личной памяти Юля должна отправить «подключи телефон» в Telegram Кузе и назвать полученный код.' });
      const context = await store.load({ userId: OWNER_TELEGRAM_ID, query: String(args.query || '').slice(0, 500) });
      result = { ok: true, context: formatContext(context) };
    } else if (name === 'search_internet') {
      if (!access.has(callId)) return finish({ ok: false, error: 'owner_authentication_required' });
      result = await search(args.query);
    } else return finish({ ok: false, error: 'unknown_tool' });
    return finish(result);
  };
}

// Adds function-call support to the existing sideband; no function names from
// user text are executed. One completion per response, bounded + deduplicated.
export function attachRealtimeTools(socket, handleTool, { logger = console } = {}) {
  const seen = new Set();
  let work = Promise.resolve();
  let closed = false;
  const send = event => { if (!closed) socket.send(JSON.stringify(event)); };
  socket.on('close', () => { closed = true; });
  socket.on('message', bytes => {
    let event; try { event = JSON.parse(bytes.toString()); } catch { return; }
    if (event.type !== 'response.done' || event.response?.status !== 'completed') return;
    const calls = (event.response.output || []).filter(item => item.type === 'function_call' && item.call_id && !seen.has(item.call_id));
    if (!calls.length || seen.size >= 40) return;
    calls.forEach(item => seen.add(item.call_id));
    work = work.then(async () => {
      for (const item of calls.slice(0, 8)) {
        let output;
        try {
          const args = JSON.parse(item.arguments || '{}');
          if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('bad arguments');
          output = await handleTool(item.name, args);
        } catch { output = { ok: false, error: 'tool_unavailable' }; }
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
      }
      send({ type: 'response.create' });
    }).catch(() => logger.error('KUZYA_VOICE_TOOL_DELIVERY_FAILED'));
  });
  return { flush: () => work };
}
