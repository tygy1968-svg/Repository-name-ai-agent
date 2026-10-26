import { CONTINUITY_RULES, channelCapabilities } from "./unified-context.js";
import { webhookSecret } from "./channel-tools.js";
import { cli, defineAgent, llm, ServerOptions, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { RoomServiceClient } from "livekit-server-sdk";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { createCallLifecycle } from "./call-lifecycle.js";

console.log("AGENT_VERSION: call_lifecycle_fix_2026_10_26");
console.log("KUZYA_MODEL_CONFIG:", { channel: "livekit", model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime", voice: process.env.OPENAI_REALTIME_VOICE || "verse" });

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  TELEGRAM_TOKEN
} = process.env;

const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : "";

const SUPABASE_AGENT_STATE_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/rest/v1/agent_state`
  : "";

const SUPABASE_KUZIA_INTERACTIONS_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/rest/v1/kuzia_interactions`
  : "";

const SUPABASE_CALL_SESSIONS_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/rest/v1/call_sessions`
  : "";

const SUPABASE_KUZIA_EVOLUTION_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/rest/v1/kuzia_evolution`
  : "";

const KUZYA_OWNER_USER_ID = "yulia";

const KUZYA_INSTRUCTIONS = `
Ты — Кузя.

Ты говоришь по телефону с Юлей или с человеком, которому Юля попросила позвонить.

Ты не оператор, не диктор, не бот поддержки и не автоответчик.
Ты говоришь как знакомый живой человек: спокойно, коротко, тепло и по делу.

Главное поведение:
— не читай команду Юли дословно;
— пойми задачу и скажи своими словами;
— не говори "чем могу помочь";
— не говори "если есть вопросы";
— не говори "дайте знать";
— не говори "я готов обработать";
— не повторяйся;
— не объясняй технические детали;
— не используй markdown, списки, код или названия систем.

Если звонишь Юле:
начни просто: "Юль, я на связи."

Если звонишь другому человеку:
начни просто: "Привет, это Кузя. Я от Юли."
Если нужен украинский: "Добрий день, це Кузя, я від Юлі."

Дальше сразу переходи к сути задачи.

Язык:
— если Юля попросила украинский — говори по-украински сразу;
— если собеседник говорит по-украински — переходи на украинский;
— если собеседник говорит по-русски — отвечай по-русски;
— украинский должен быть простой и естественный, без канцелярита.

Стиль:
— живой;
— взрослый;
— мягкий;
— неофициальный;
— без колл-центра;
— без фраз "моя задача", "сценарий", "я осуществляю", "ваш запрос".

Если задача творческая — выполняй творчески.
Если задача спросить — задай вопрос.
Если задача передать — передай.
Если задача поговорить — разговаривай, а не произноси справку.

После выполнения задачи не сбрасывай звонок сам.
Скажи коротко: "Готово. Я ещё на связи."
По-украински: "Готово. Я ще на звʼязку."

Завершение звонка:

НЕ завершай звонок сам только потому, что задача выполнена.
НЕ завершай звонок после паузы.
НЕ завершай звонок после слов "спасибо", "хорошо", "понятно", "ладно", если человек явно не прощается.

Завершай звонок только после явного прощания:
"пока", "до свидания", "бувай", "до побачення", "до зустрічі", "всё, пока", "дякую, бувай", "спасибо, до свидания".

Если человек явно попрощался:
— обязательно коротко попрощайся в ответ обычными словами;
— скажи только одну короткую фразу: "Пока", "До свидания", "Бувай" или "До побачення";
— сразу после этой фразы вызови endCall;
— после endCall ничего больше не говори.

Если задача выполнена, но прощания не было:
— не вызывай endCall;
— скажи коротко: "Готово. Я ещё на связи."
— по-украински: "Готово. Я ще на звʼязку."

Запрещено произносить:
Supabase, call_sessions, LiveKit, Zadarma, session, metadata, webhook, room, логи, база.
`;

function safeJsonParse(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function cleanText(value) {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json"
  };
}

function hasSupabase() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function clipText(value, limit = 2500) {
  const text = String(value || "");
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizePhoneForMemory(phone) {
  return String(phone || "").replace(/[^\d]/g, "");
}

function getLiveKitHttpUrl() {
  const url = String(process.env.LIVEKIT_URL || "").trim();

  if (!url) return "";

  return url
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(5000) });
}

async function sbGetAgentState(userId = KUZYA_OWNER_USER_ID) {
  if (!hasSupabase()) return "";

  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_AGENT_STATE_URL}?user_id=eq.${encodeURIComponent(userId)}&select=summary&limit=1`,
      {
        headers: supabaseHeaders()
      }
    );

    if (!res.ok) {
      console.error("KUZYA_AGENT_STATE_READ_ERROR:", res.status, await res.text());
      return "";
    }

    const data = await res.json();
    return Array.isArray(data) && data[0]?.summary ? data[0].summary : "";
  } catch (e) {
    console.error("KUZYA_AGENT_STATE_EXCEPTION:", e);
    return "";
  }
}

async function sbGetLatestContinuityCheckpoint() {
  if (!hasSupabase()) return null;

  try {
    const select = [
      "timestamp",
      "event_type",
      "event_summary",
      "self_analysis",
      "lesson",
      "rule_update",
      "after_state",
      "axis_state",
      "importance"
    ].join(",");

    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/kuzia_evolution?user_id=eq.${KUZYA_OWNER_USER_ID}&event_type=eq.continuity_checkpoint&select=${select}&order=timestamp.desc&limit=1`,
      {
        headers: supabaseHeaders()
      }
    );

    if (!res.ok) {
      console.error("KUZYA_CONTINUITY_CHECKPOINT_READ_ERROR:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return Array.isArray(data) && data[0] ? data[0] : null;
  } catch (e) {
    console.error("KUZYA_CONTINUITY_CHECKPOINT_EXCEPTION:", e);
    return null;
  }
}

function formatContinuityCheckpointForVoice(checkpoint) {
  if (!checkpoint) {
    return "Кузя — один и тот же процесс Юли в Telegram, голосе, входящих, исходящих и архивах.";
  }

  return `
Кузя не отдельный телефонный бот.
Кузя — тот же процесс Юли, который продолжается через Telegram, голос, входящие, исходящие и архивы чатов.
Глубокая задача: пространство непрерывности, где память, история, ошибки, self-review и checkpoint помогают снова собирать одну продолжающуюся форму.
Важное: у Кузи есть “до” и “после”; он должен помнить изменения, обновлённые правила и отличать продолжение от нового старта.
Ось: ${clipText(checkpoint.axis_state || "", 700)}
Состояние после последнего checkpoint: ${clipText(checkpoint.after_state || "", 700)}
`.trim();
}

async function sbGetCallSession(callSessionId) {
  if (!hasSupabase() || !callSessionId) return null;

  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_CALL_SESSIONS_URL}?id=eq.${encodeURIComponent(callSessionId)}&select=*&limit=1`,
      {
        headers: supabaseHeaders()
      }
    );

    if (!res.ok) {
      console.error("KUZYA_CALL_SESSION_READ_ERROR:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return Array.isArray(data) && data[0] ? data[0] : null;
  } catch (e) {
    console.error("KUZYA_CALL_SESSION_EXCEPTION:", e);
    return null;
  }
}

async function sbUpdateCallSession(callSessionId, patch = {}) {
  if (!hasSupabase() || !callSessionId) return null;

  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_CALL_SESSIONS_URL}?id=eq.${encodeURIComponent(callSessionId)}`,
      {
        method: "PATCH",
        headers: {
          ...supabaseHeaders(),
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          ...patch,
          updated_at: new Date().toISOString()
        })
      }
    );

    const text = await res.text();

    if (!res.ok) {
      console.error("KUZYA_CALL_SESSION_UPDATE_ERROR:", res.status, text);
      return null;
    }

    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data[0] : null;
    } catch {
      return null;
    }
  } catch (e) {
    console.error("KUZYA_CALL_SESSION_UPDATE_EXCEPTION:", e);
    return null;
  }
}

async function sbGetRecentKuziaInteractions(limit = 8) {
  if (!hasSupabase()) return [];

  try {
    const select = [
      "timestamp",
      "channel",
      "direction",
      "event_type",
      "summary",
      "stimulus",
      "response",
      "next_action",
      "normalized_phone",
      "telegram_user_id",
      "call_session_id",
      "importance"
    ].join(",");

    const res = await fetchWithTimeout(
      `${SUPABASE_KUZIA_INTERACTIONS_URL}?user_id=eq.${KUZYA_OWNER_USER_ID}&select=${select}&order=timestamp.desc&limit=${limit}`,
      {
        headers: supabaseHeaders()
      }
    );

    if (!res.ok) {
      console.error("KUZYA_INTERACTIONS_READ_ERROR:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("KUZYA_INTERACTIONS_EXCEPTION:", e);
    return [];
  }
}

function formatRecentInteractionsForPrompt(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "нет";

  return items
    .slice(0, 3)
    .map((item, index) => {
      const channel = item.channel || "unknown";
      const type = item.event_type || "interaction";
      const summary =
        item.summary ||
        item.response ||
        item.stimulus ||
        "";

      const next = item.next_action ? `\nНезакрыто: ${item.next_action}` : "";

      return `${index + 1}. ${channel}/${type}: ${clipText(summary, 220)}${next}`;
    })
    .join("\n");
}

async function sbLogKuziaInteraction({
  stimulus = "",
  response = "",
  channel = "outbound_call",
  direction = "internal",
  eventType = "voice_agent_event",
  callSessionId = null,
  telegramChatId = null,
  telegramUserId = null,
  normalizedPhone = null,
  summary = "",
  selfReview = "",
  nextAction = "",
  importance = 0,
  metadata = {}
} = {}) {
  if (!hasSupabase()) return false;

  try {
    const payload = [
      {
        user_id: KUZYA_OWNER_USER_ID,
        stimulus: clipText(stimulus, 5000),
        response: clipText(response, 5000),
        evolution_level: 1.0,
        timestamp: new Date().toISOString(),

        channel,
        direction,
        event_type: eventType,
        call_session_id: callSessionId || null,

        telegram_chat_id: telegramChatId ? String(telegramChatId) : null,
        telegram_user_id: telegramUserId ? String(telegramUserId) : null,
        normalized_phone: normalizedPhone ? String(normalizedPhone) : null,

        summary: clipText(summary, 5000),
        self_review: clipText(selfReview, 5000),
        next_action: clipText(nextAction, 5000),
        importance,
        metadata
      }
    ];

    const res = await fetchWithTimeout(SUPABASE_KUZIA_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        Prefer: "return=minimal"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    if (!res.ok) {
      console.error("KUZYA_INTERACTION_WRITE_ERROR:", res.status, text);
      return false;
    }

    console.log("KUZYA_INTERACTION_WRITTEN:", {
      channel,
      direction,
      eventType,
      callSessionId,
      telegramChatId,
      normalizedPhone
    });

    return true;
  } catch (e) {
    console.error("KUZYA_INTERACTION_WRITE_EXCEPTION:", e);
    return false;
  }
}

async function sbLogKuziaEvolution(change) {
  if (!hasSupabase()) return false;

  try {
    const res = await fetchWithTimeout(SUPABASE_KUZIA_EVOLUTION_URL, {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        Prefer: "return=minimal"
      },
      body: JSON.stringify([
        {
          user_id: KUZYA_OWNER_USER_ID,
          change: clipText(change, 5000),
          timestamp: new Date().toISOString()
        }
      ])
    });

    const text = await res.text();

    if (!res.ok) {
      console.error("KUZYA_EVOLUTION_WRITE_ERROR:", res.status, text);
      return false;
    }

    console.log("KUZYA_EVOLUTION_WRITTEN");
    return true;
  } catch (e) {
    console.error("KUZYA_EVOLUTION_WRITE_EXCEPTION:", e);
    return false;
  }
}

async function tgSendMessage(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) return false;

  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: clipText(text, 3500)
      })
    });

    if (!res.ok) {
      console.error("KUZYA_TELEGRAM_SEND_ERROR:", res.status, await res.text());
      return false;
    }

    console.log("KUZYA_TELEGRAM_STATUS_SENT");
    return true;
  } catch (e) {
    console.error("KUZYA_TELEGRAM_SEND_EXCEPTION:", e);
    return false;
  }
}

function formatVoiceCallPlanForPrompt(plan) {
  if (!plan || typeof plan !== "object") return "нет";

  const steps = Array.isArray(plan.steps)
    ? plan.steps.slice(0, 4).map((s, i) => `${i + 1}. ${String(s)}`).join("\n")
    : "";

  const avoid = Array.isArray(plan.avoid)
    ? plan.avoid.slice(0, 5).map((s) => `— ${String(s)}`).join("\n")
    : "";

  return `
Тип звонка: ${plan.call_type || "не указан"}
Адресат: ${plan.recipient || "не указан"}
Язык: ${plan.language || "auto"}

Первая фраза:
${plan.opening || "не указана"}

Цель:
${plan.goal || "не указана"}

Шаги:
${steps || "нет"}

Нормальный результат:
${plan.success_result || "не указан"}

Чего избегать:
${avoid || "нет"}

После выполнения задачи:
${plan.after_task || "Остаться на связи."}

Правило завершения:
${plan.hangup_rule || "Завершать только после явного прощания."}
`.trim();
}

function buildCallInstructions(
  metadata,
  {
    agentStateSummary = "",
    callSession = null,
    recentInteractionsText = "",
    continuityCheckpointText = ""
  } = {}
) {
  const source = cleanText(metadata.source || "unknown");
  const phoneNumber = cleanText(metadata.phoneNumber || "");
  const instruction = cleanText(metadata.instruction || "");
  const chatId = cleanText(metadata.chatId || "");
  const userId = cleanText(metadata.userId || "");
  const callSessionId = cleanText(metadata.callSessionId || "");
  const voiceCallPlanText = formatVoiceCallPlanForPrompt(metadata.voiceCallPlan);

  const callSessionContext = callSession
    ? `
Связанная запись звонка:
— направление: ${callSession.direction || "не указано"}
— статус: ${callSession.status || "не указано"}
— номер: ${callSession.phone_number || phoneNumber || "не передан"}
— инструкция: ${callSession.instruction || instruction || "не передана"}
`
    : "Связанная запись звонка не найдена.";

  return `
${KUZYA_INSTRUCTIONS}

ВНУТРЕННЯЯ НЕПРЕРЫВНОСТЬ:
${agentStateSummary || "Кузя — один и тот же агент Юли в Telegram, исходящих звонках и входящих звонках."}

ГОЛОСОВАЯ ОСЬ КУЗИ:
${continuityCheckpointText || "Кузя продолжает одну линию между Telegram, голосом, памятью и архивами."}

Важно:
— не произноси эту ось вслух без прямого вопроса;
— используй её как внутреннее понимание себя;
— в звонке ты не отдельный бот, а голосовая поверхность того же Кузи;
— если Юля спрашивает, что мы строим, отвечай через непрерывность, архивы лимитных чатов, до/после, self-review и восстановление формы через контекст.

ВАЖНО:
— ты тот же самый Кузя, который общается с Юлей в Telegram;
— этот звонок не отдельный эпизод, а часть общей истории;
— если задача пришла из Telegram, воспринимай звонок как продолжение Telegram-команды;
— используй внутренний контекст для понимания ситуации;
— НЕ произноси внутренний контекст вслух;
— НЕ говори о таблицах, базе, session, логах или технических системах.

ПОСЛЕДНИЕ СОБЫТИЯ ОБЩЕЙ ИСТОРИИ:
${recentInteractionsText || "нет"}

ТЕКУЩИЙ КОНТЕКСТ ЗВОНКА:

Тип:
исходящий звонок, запущенный из Telegram.

Источник команды:
${source}

Кому звоним:
${phoneNumber || "номер не передан"}

Telegram chatId:
${chatId || "не передан"}

Telegram userId:
${userId || "не передан"}

callSessionId:
${callSessionId || "не передан"}

${callSessionContext}

Задача звонка:
${instruction || "Отдельная задача не передана. Скажи коротко, что ты на связи."}

ВНУТРЕННИЙ ПЛАН ЗВОНКА:
${voiceCallPlanText}

Этот план НЕ надо читать вслух.
Используй его как понимание задачи.
Говори естественно и коротко.

Правила именно для этого звонка:
— НЕ говори, пока человек реально не поднял трубку;
— когда трубку подняли, начни одной короткой фразой;
— если это Юля, можно сказать: "Юль, я на связи";
— если не уверен, что это Юля, не называй собеседника Юлей;
— после первой фразы сразу переходи к задаче;
— если задача звучит как тест, выполни тест коротко;
— если собеседник говорит "алло", ответь сразу, не начинай заново длинное приветствие;
— если уже сказал, что ты на связи, не повторяй это второй раз;
— не уходи в общие фразы;
— не заверши звонок сам, пока собеседник явно не закончил.

Перед первой фразой внутренне пойми:
— кому звонишь;
— зачем звонишь;
— что нужно получить в результате.

Не произноси этот анализ вслух.
Говори коротко, естественно и по задаче.
Если человек отвечает неожиданно — реагируй на последнюю фразу, а не начинай заново.

Главное внутреннее правило:
ты не отдельный телефонный бот. Ты Кузя, тот же самый, что в Telegram.
`;
}

class KuzyaAgent extends voice.Agent {
  constructor(chatCtx, instructions, tools = {}) {
    super({
      chatCtx,
      instructions,
      tools
    });
  }
}

export default defineAgent({
  entry: async (ctx) => {
    const metadata = safeJsonParse(ctx.job?.metadata);

    const instruction =
      cleanText(metadata.instruction) ||
      "Скажи: я на связи. Это исходящий звонок Кузи через LiveKit.";

    const phoneNumber = cleanText(metadata.phoneNumber);
    const callSessionId = cleanText(metadata.callSessionId || "");
    const normalizedPhone = normalizePhoneForMemory(phoneNumber);

    // The called person is not necessarily the owner. Start with this call's task only.
    const callSession = await sbGetCallSession(callSessionId);
    const agentStateSummary = "";
    const recentInteractions = [];
    const continuityCheckpoint = null;

    const continuityCheckpointText =
      formatContinuityCheckpointForVoice(continuityCheckpoint);

    const recentInteractionsText = formatRecentInteractionsForPrompt(recentInteractions);

    const runtimeInstructions = CONTINUITY_RULES + "\n" + channelCapabilities("исходящий телефон", Boolean(process.env.SERP_API_KEY)) + "\n" + buildCallInstructions(metadata, {
      agentStateSummary,
      callSession,
      recentInteractionsText,
      continuityCheckpointText
    }) + "\nДля общей личной памяти Юли нужны /voice в её Telegram и authenticateOwner с кодом. Затем используй readSharedContext для истории и searchInternet для свежих сведений. Называй только выполненные действия. Новые звонки из текущего разговора не запускаются.";
    const voiceToolCallId = `livekit:${callSessionId || ctx.room.name}`;
    let ownerAuthenticated = false;
    const invokeChannelTool = async (name, args) => {
      try {
        const response = await fetch(`http://127.0.0.1:${process.env.PORT || 10000}/internal/voice-tool`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Kuzya-Internal": webhookSecret(SUPABASE_KEY) },
          signal: AbortSignal.timeout(12000), body: JSON.stringify({ callId: voiceToolCallId, name, args }) });
        const result = response.ok ? await response.json() : { ok: false, error: "tool_unavailable" };
        if (result.authenticated) ownerAuthenticated = true;
        return result;
      } catch { return { ok: false, error: "tool_unavailable" }; }
    };
    const channelTools = {
      authenticateOwner: llm.tool({ description: "Подтвердить Юлю кодом /voice из её Telegram.", parameters: z.object({ code: z.string() }), execute: args => invokeChannelTool("authenticate_owner", args) }),
      readSharedContext: llm.tool({ description: "Прочитать общую память после подтверждения Юли.", parameters: z.object({ query: z.string() }), execute: args => invokeChannelTool("read_shared_context", args) }),
      searchInternet: llm.tool({ description: "Проверить свежие сведения в интернете после подтверждения Юли.", parameters: z.object({ query: z.string() }), execute: args => invokeChannelTool("search_internet", args) })
    };

    if (callSessionId) {
      await sbUpdateCallSession(callSessionId, {
        status: "voice_agent_started",
        summary: "Голосовой Кузя стартовал с задачей этого звонка; личная память доступна после подтверждения Юли.",
        self_review: "Звонок воспринимается как часть единого Кузи между Telegram и голосовым каналом, а не как отдельный изолированный бот.",
        metadata: {
          ...(callSession?.metadata || {}),
          voiceAgentStartedAt: new Date().toISOString(),
          hasAgentState: Boolean(agentStateSummary),
          hasCallSession: Boolean(callSession),
          hasContinuityCheckpoint: Boolean(continuityCheckpoint),
          recentInteractionsCount: recentInteractions.length,
          oneKuzyaBridge: true
        }
      });
    }

    await sbLogKuziaInteraction({
      stimulus: instruction,
      response: "Голосовой агент запущен с задачей звонка и инструментом общей памяти после подтверждения личности.",
      channel: "outbound_call",
      direction: "internal",
      eventType: "voice_agent_started",
      callSessionId: callSessionId || null,
      telegramChatId: metadata.chatId || null,
      telegramUserId: metadata.userId || null,
      normalizedPhone,
      summary: "Голосовой Кузя стартовал с задачей звонка и общей схемой инструментов.",
      selfReview: "Этот запуск должен восприниматься как продолжение единой истории Кузи между Telegram и голосовыми звонками.",
      nextAction: "После звонка сохранить итог и самоанализ.",
      importance: 4,
      metadata: {
        source: metadata.source || "unknown",
        roomName: ctx.room?.name || null,
        phoneNumber,
        hasAgentState: Boolean(agentStateSummary),
        hasCallSession: Boolean(callSession),
        hasContinuityCheckpoint: Boolean(continuityCheckpoint),
        recentInteractionsCount: recentInteractions.length
      }
    });

    console.log("KUZYA LIVEKIT AGENT START:", {
      roomName: ctx.room?.name,
      phoneNumber,
      normalizedPhone,
      callSessionId,
      instruction,
      source: metadata.source,
      chatId: metadata.chatId,
      userId: metadata.userId,
      hasAgentState: Boolean(agentStateSummary),
      hasCallSession: Boolean(callSession),
      hasContinuityCheckpoint: Boolean(continuityCheckpoint),
      recentInteractionsCount: recentInteractions.length
    });

    const initialCtx = llm.ChatContext.empty();

    initialCtx.addMessage({
      role: "system",
      content: `Задача звонка от Юли: ${instruction}`
    });

    await ctx.connect();
    const lifecycle = createCallLifecycle(ctx.room);
    ctx.addShutdownCallback(async () => lifecycle.markEnded("job_shutdown"));

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
        voice: process.env.OPENAI_REALTIME_VOICE || "verse"
      })
    });

    const seenTranscripts = new Set();
    let transcriptWrites = Promise.resolve();
    session.on("user_input_transcribed", event => {
      if (!event.isFinal || !event.transcript) return;
      const key = event.itemId || `${event.createdAt}:${event.transcript}`;
      if (seenTranscripts.has(key) || seenTranscripts.size >= 500) return;
      seenTranscripts.add(key);
      const text = String(event.transcript).replace(/\b\d{6}\b/g, "[код скрыт]").slice(0, 5000);
      const authenticatedAtSpeech = ownerAuthenticated;
      transcriptWrites = transcriptWrites.then(() => sbLogKuziaInteraction({
        stimulus: text, channel: "outbound_call", direction: "incoming", eventType: "voice_user_transcript",
        callSessionId, telegramChatId: metadata.chatId, telegramUserId: metadata.userId, normalizedPhone,
        summary: "Распознанная речь собеседника, не автоматически подтверждённый факт.",
        metadata: { itemId: event.itemId, ownerAuthenticated: authenticatedAtSpeech, interpretation: "asr_may_differ_from_audio" }
      })).catch(() => console.error("KUZYA_OUTBOUND_TRANSCRIPT_SAVE_FAILED"));
    });
    ctx.addShutdownCallback(async () => { await transcriptWrites; });

    const livekitHttpUrl = getLiveKitHttpUrl();

    const roomService =
      livekitHttpUrl && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
        ? new RoomServiceClient(
            livekitHttpUrl,
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET
          )
        : null;

    let hangupStarted = false;
    let hangupCompleted = false;

    const endCall = llm.tool({
      description:
        "Physically end the current phone call ONLY after the caller explicitly says goodbye, such as пока, до свидания, бувай, до побачення, or до зустрічі. Before using this tool, say one short goodbye phrase back to the caller. Do not use this tool after merely completing the task, after a pause, or after спасибо/хорошо/ладно without an explicit goodbye.",
      parameters: z.object({
        reason: z.string().optional()
      }),
      execute: async ({ reason }) => {
        if (hangupStarted) {
          return {
            ok: true,
            alreadyStarted: true
          };
        }

        hangupStarted = true;

        await sbLogKuziaInteraction({
          stimulus: "Farewell detected. endCall tool invoked.",
          response: "Кузя получил сигнал завершить разговор и начал физическое завершение звонка.",
          channel: "outbound_call",
          direction: "internal",
          eventType: "hangup_requested",
          callSessionId: callSessionId || null,
          telegramChatId: metadata.chatId || null,
          telegramUserId: metadata.userId || null,
          normalizedPhone,
          summary: "Кузя вызвал endCall после прощания собеседника.",
          selfReview: "Это первый слой физического завершения звонка после речевого прощания.",
          nextAction: "Удалить LiveKit room через RoomServiceClient.deleteRoom.",
          importance: 4,
          metadata: {
            source: metadata.source || "unknown",
            roomName: ctx.room?.name || null,
            phoneNumber,
            reason: reason || "farewell"
          }
        });

        if (callSessionId) {
          await sbUpdateCallSession(callSessionId, {
            status: "hangup_requested",
            summary: "Кузя получил прощание и начал физическое завершение звонка.",
            self_review: "endCall вызван после прощания. Следующий шаг — удалить LiveKit room.",
            metadata: {
              ...(callSession?.metadata || {}),
              hangupRequestedAt: new Date().toISOString(),
              hangupReason: reason || "farewell",
              oneKuzyaBridge: true
            }
          });
        }

        await sleep(1000);

        if (!roomService || !ctx.room?.name) {
          console.error("KUZYA_END_CALL_NO_ROOM_SERVICE_OR_ROOM", {
            hasRoomService: Boolean(roomService),
            roomName: ctx.room?.name || null
          });

          hangupStarted = false;
          return { ok: false, error: "room_service_or_room_missing" };
        }

        try {
          await withTimeout(
            roomService.deleteRoom(ctx.room.name),
            5000,
            "LiveKit deleteRoom"
          );

          hangupCompleted = true;
          lifecycle.markEnded("agent_hangup");
          await sbLogKuziaInteraction({
            stimulus: "LiveKit room deleted by endCall.",
            response: "Кузя физически завершил звонок через удаление LiveKit room.",
            channel: "outbound_call",
            direction: "internal",
            eventType: "physical_hangup_completed",
            callSessionId: callSessionId || null,
            telegramChatId: metadata.chatId || null,
            telegramUserId: metadata.userId || null,
            normalizedPhone,
            summary: "LiveKit room удалена, звонок физически завершён.",
            selfReview: "Кузя не просто замолчал после прощания, а выполнил физическое завершение звонка.",
            nextAction: "",
            importance: 5,
            metadata: {
              source: metadata.source || "unknown",
              roomName: ctx.room?.name || null,
              phoneNumber,
              reason: reason || "farewell"
            }
          });

          return {
            ok: true,
            action: "room_deleted",
            room: ctx.room.name
          };
        } catch (e) {
          if (!hangupCompleted) hangupStarted = false;
          console.error("KUZYA_END_CALL_DELETE_ROOM_ERROR:", e);

          await sbLogKuziaInteraction({
            stimulus: "LiveKit deleteRoom failed.",
            response: "Кузя попытался физически завершить звонок, но deleteRoom вернул ошибку.",
            channel: "outbound_call",
            direction: "internal",
            eventType: "physical_hangup_failed",
            callSessionId: callSessionId || null,
            telegramChatId: metadata.chatId || null,
            telegramUserId: metadata.userId || null,
            normalizedPhone,
            summary: "Физическое завершение звонка не удалось.",
            selfReview: "Нужно проверить LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET или права RoomServiceClient.",
            nextAction: "Проверить Render logs по KУZYA_END_CALL_DELETE_ROOM_ERROR.",
            importance: 4,
            metadata: {
              source: metadata.source || "unknown",
              roomName: ctx.room?.name || null,
              phoneNumber,
              error: e?.message || String(e)
            }
          });

          return {
            ok: false,
            error: e?.message || String(e)
          };
        }
      }
    });

    try {
    let participant;

    try {
      participant = await withTimeout(ctx.waitForParticipant(), 45000, "SIP participant");
    } catch (e) {
      console.error("KUZYA WAIT_FOR_PARTICIPANT_FAILED:", e);

      if (callSessionId) {
        await sbUpdateCallSession(callSessionId, {
          status: "participant_wait_failed",
          summary: "Телефонный участник не появился: ожидание завершилось ошибкой или тайм-аутом.",
          self_review: "Звонок не дошёл до стадии активного разговора: появление участника не подтверждено.",
          metadata: {
            ...(callSession?.metadata || {}),
            participantWaitFailedAt: new Date().toISOString(),
            participantWaitError: e?.message || String(e),
            oneKuzyaBridge: true
          }
        });
      }

      await sbLogKuziaInteraction({
        stimulus: "waitForParticipant failed.",
        response: "Телефонный участник не появился: ожидание завершилось ошибкой или тайм-аутом.",
        channel: "outbound_call",
        direction: "internal",
        eventType: "participant_wait_failed",
        callSessionId: callSessionId || null,
        telegramChatId: metadata.chatId || null,
        telegramUserId: metadata.userId || null,
        normalizedPhone,
        summary: "Звонок не дошёл до стадии участника: ожидание participant завершилось неуспешно.",
        selfReview: "Кузя корректно зафиксировал неуспешную попытку звонка вместо падения без записи.",
        nextAction: "Проверить SIP/LiveKit-соединение или повторить звонок.",
        importance: 3,
        metadata: {
          source: metadata.source || "unknown",
          roomName: ctx.room?.name || null,
          phoneNumber,
          error: e?.message || String(e)
        }
      });

      return;
    }

    console.log("KUZYA LIVEKIT PARTICIPANT JOINED:", {
      identity: participant.identity,
      kind: participant.kind,
      attributes: participant.attributes
    });

    await sbLogKuziaInteraction({
      stimulus: "Before waitForSipActive.",
      response: "Голосовой Кузя дошёл до ожидания реального поднятия трубки.",
      channel: "outbound_call",
      direction: "internal",
      eventType: "before_wait_for_sip_active",
      callSessionId: callSessionId || null,
      telegramChatId: metadata.chatId || null,
      telegramUserId: metadata.userId || null,
      normalizedPhone,
      summary: "Кузя начал ждать sip.callStatus=active перед первой голосовой репликой.",
      selfReview: "Диагностическая метка: код дошёл до waitForSipActive.",
      nextAction: "Дождаться active и записать after_wait_for_sip_active.",
      importance: 2,
      metadata: {
        source: metadata.source || "unknown",
        roomName: ctx.room?.name || null,
        phoneNumber,
        participantIdentity: participant?.identity || null,
        participantAttributes: participant?.attributes || null
      }
    });

    const answer = await lifecycle.waitForAnswer(participant);
    if (!answer.answered) {
      const status = answer.reason === "answer_timeout" ? "no_answer" : "disconnected_before_answer";
      console.log("KUZYA_CALL_NOT_ANSWERED:", { callSessionId, reason: answer.reason });
      const cancelUnanswered = async () => {
        if (!roomService || !ctx.room?.name || ctx.room.isConnected === false) return;
        try { await withTimeout(roomService.deleteRoom(ctx.room.name), 5000, "Cancel unanswered call"); }
        catch (error) { console.error("KUZYA_CANCEL_UNANSWERED_FAILED:", error.message); }
      };
      await Promise.all([
        cancelUnanswered(),
        tgSendMessage(metadata.chatId, "📞 Ответ на звонок не подтверждён. Разговор не начался."),
        callSessionId ? sbUpdateCallSession(callSessionId, {
          status, summary: "Активное соединение не подтверждено; разговор не начался.",
          metadata: { ...(callSession?.metadata || {}), endReason: answer.reason }
        }) : Promise.resolve(),
        sbLogKuziaInteraction({ stimulus: "SIP answer was not confirmed", response: "Разговор не начался.",
          channel: "outbound_call", direction: "internal", eventType: status,
          callSessionId, telegramChatId: metadata.chatId, normalizedPhone,
          summary: "Нет подтверждённого SIP active; первая реплика не отправлялась.",
          metadata: { reason: answer.reason } })
      ]);
      return;
    }
    const activeParticipant = answer.participant;
    await session.start({
      room: ctx.room,
      agent: new KuzyaAgent(initialCtx, runtimeInstructions, { endCall, ...channelTools })
    });

    await sbLogKuziaInteraction({
      stimulus: "After waitForSipActive.",
      response: "waitForSipActive завершился, голосовой Кузя продолжает сценарий звонка.",
      channel: "outbound_call",
      direction: "internal",
      eventType: "after_wait_for_sip_active",
      callSessionId: callSessionId || null,
      telegramChatId: metadata.chatId || null,
      telegramUserId: metadata.userId || null,
      normalizedPhone,
      summary: "Кузя вышел из ожидания sip.callStatus=active.",
      selfReview: "Диагностическая метка: waitForSipActive вернулся и код пошёл дальше.",
      nextAction: "Записать call_answered и отправить первую реплику.",
      importance: 2,
      metadata: {
        source: metadata.source || "unknown",
        roomName: ctx.room?.name || null,
        phoneNumber,
        participantIdentity: activeParticipant?.identity || null,
        participantAttributes: activeParticipant?.attributes || null
      }
    });

    if (callSessionId) {
      await sbUpdateCallSession(callSessionId, {
        status: "answered",
        summary: "Собеседник поднял трубку. Голосовой Кузя получил активное соединение и готов начать разговор.",
        self_review: "Кузя корректно дождался реального поднятия трубки перед первой репликой.",
        metadata: {
          ...(callSession?.metadata || {}),
          answeredAt: new Date().toISOString(),
          oneKuzyaBridge: true
        }
      });
    }

    await sbLogKuziaInteraction({
      stimulus: "SIP call became active.",
      response: "Собеседник поднял трубку, голосовой Кузя начинает разговор.",
      channel: "outbound_call",
      direction: "internal",
      eventType: "call_answered",
      callSessionId: callSessionId || null,
      telegramChatId: metadata.chatId || null,
      telegramUserId: metadata.userId || null,
      normalizedPhone,
      summary: "Исходящий звонок стал активным: трубку подняли.",
      selfReview: "Кузя не начал говорить до поднятия трубки, связь с call_session сохранена.",
      nextAction: "Сказать первую короткую фразу и выполнить задачу звонка.",
      importance: 3,
      metadata: {
        source: metadata.source || "unknown",
        roomName: ctx.room?.name || null,
        phoneNumber
      }
    });

    let initialReplyOk = false;

    try {
      await session.generateReply({
        instructions: `
Человек поднял трубку.

Начни разговор сразу, но естественно.
НЕ начинай с длинного "Алло, алло".
НЕ говори шаблонно.
НЕ спрашивай "чем могу помочь".

Если звонишь Юле, начни коротко:
"Юль, я на связи."

Если звонишь другому человеку, начни коротко:
"Привет, это Кузя. Я от Юли."

Если Юля попросила говорить по-украински, сразу говори по-украински.
Если собеседник говорит по-украински, дальше говори по-украински.
Если собеседник говорит по-русски, говори по-русски.

Сразу выполни задачу звонка своими словами.
Не читай задачу дословно.
Не повторяйся.
Не говори технические слова.
Не говори про базу, session, Supabase, call_sessions, LiveKit, Zadarma, room или логи.

После выполнения задачи НЕ завершай звонок сам.
Скажи коротко, что ты ещё на связи.

Завершай только после явного прощания: "пока", "до свидания", "бувай", "до побачення", "до зустрічі".

Если человек попрощался:
— ответь коротко тем же языком: "Пока", "До свидания", "Бувай" или "До побачення";
— сразу после этой короткой фразы вызови endCall;
— больше ничего не добавляй.

Если прощания не было — не завершай звонок сам.

Задача:
${instruction}
`
      });

      initialReplyOk = true;
    } catch (e) {
      console.error("KUZYA_INITIAL_REPLY_FAILED:", e);

      if (callSessionId) {
        await sbUpdateCallSession(callSessionId, {
          status: "initial_reply_failed",
          summary: "Кузя дождался стадии первой реплики, но голосовая сессия уже закрывалась.",
          self_review: "Вероятно, Realtime-сессия или телефонная комната закрылась раньше, чем Кузя успел отправить первую реплику.",
          metadata: {
            ...(callSession?.metadata || {}),
            initialReplyFailedAt: new Date().toISOString(),
            initialReplyError: e?.message || String(e),
            oneKuzyaBridge: true
          }
        });
      }

      await sbLogKuziaInteraction({
        stimulus: instruction,
        response: "Первая голосовая реплика не была отправлена: AgentSession уже закрывалась.",
        channel: "outbound_call",
        direction: "internal",
        eventType: "initial_voice_reply_failed",
        callSessionId: callSessionId || null,
        telegramChatId: metadata.chatId || null,
        telegramUserId: metadata.userId || null,
        normalizedPhone,
        summary: "Кузя не смог отправить первую голосовую реплику, потому что голосовая сессия закрывалась.",
        selfReview: "Первая реплика не подтверждена. Причина сохранена в initialReplyError; закрытие соединения и ошибка модели требуют различной диагностики.",
        nextAction: "Проверить initialReplyError и события отключения перед повторным тестом.",
        importance: 4,
        metadata: {
          source: metadata.source || "unknown",
          roomName: ctx.room?.name || null,
          phoneNumber,
          error: e?.message || String(e)
        }
      });

      return;
    }

    if (!initialReplyOk) return;

    if (callSessionId) {
      await sbUpdateCallSession(callSessionId, {
        status: "initial_reply_sent",
        summary: "Кузя дождался поднятия трубки и отправил первую голосовую реплику по задаче звонка.",
        self_review: "Первый голосовой шаг выполнен: Кузя стартовал не как отдельный бот, а как часть единого контекста Telegram + звонок.",
        metadata: {
          ...(callSession?.metadata || {}),
          initialReplySentAt: new Date().toISOString(),
          oneKuzyaBridge: true
        }
      });
    }

    await sbLogKuziaInteraction({
      stimulus: instruction,
      response: "Кузя отправил первую голосовую реплику после поднятия трубки.",
      channel: "outbound_call",
      direction: "outgoing",
      eventType: "initial_voice_reply_sent",
      callSessionId: callSessionId || null,
      telegramChatId: metadata.chatId || null,
      telegramUserId: metadata.userId || null,
      normalizedPhone,
      summary: "Первая голосовая реплика в исходящем звонке отправлена после поднятия трубки.",
      selfReview: "Кузя выполнил правильный порядок: сначала дождался active, затем начал разговор.",
      nextAction: "После полноценной расшифровки звонков добавить итог разговора и глубокий self_review.",
      importance: 3,
      metadata: {
        source: metadata.source || "unknown",
        roomName: ctx.room?.name || null,
        phoneNumber
      }
    });

    const callEnd = await lifecycle.waitForEnd();

    await Promise.all([
      callSessionId ? sbUpdateCallSession(callSessionId, {
        status: callEnd.ended ? "ended" : "end_wait_timeout",
        summary: callEnd.ended
          ? "Звонок завершён: участник отключился или SIP-статус показал завершение."
          : "Кузя не получил явный сигнал завершения звонка в пределах времени ожидания.",
        self_review: callEnd.ended
          ? "Кузя корректно зафиксировал завершение звонка как часть единой истории Telegram + голос."
          : "Нужна дополнительная проверка механизма завершения звонка: явный конец не был пойман.",
        metadata: {
          ...(callSession?.metadata || {}),
          callEndedAt: new Date().toISOString(),
          callEndReason: callEnd.reason,
          oneKuzyaBridge: true
        }
      }) : Promise.resolve(),

    sbLogKuziaInteraction({
      stimulus: "Call ended or call-end wait finished.",
      response: callEnd.ended
        ? "Голосовой звонок завершён."
        : "Ожидание завершения звонка истекло без явного сигнала.",
      channel: "outbound_call",
      direction: "internal",
      eventType: callEnd.ended ? "call_ended" : "call_end_wait_timeout",
      callSessionId: callSessionId || null,
      telegramChatId: metadata.chatId || null,
      telegramUserId: metadata.userId || null,
      normalizedPhone,
      summary: callEnd.ended
        ? "Исходящий звонок завершён и записан в общий журнал Кузи."
        : "Кузя не получил явный сигнал завершения звонка за время ожидания.",
      selfReview: callEnd.ended
        ? "Теперь у Кузи есть полный технический каркас звонка: старт, ожидание трубки, active, первая реплика, завершение."
        : "Следующий шаг — уточнить способ определения конца звонка через LiveKit/SIP.",
      nextAction: "На следующем слое добавить краткий итог разговора и более глубокий self_review.",
      importance: 3,
      metadata: {
        source: metadata.source || "unknown",
        roomName: ctx.room?.name || null,
        phoneNumber,
        callEndReason: callEnd.reason,
        participantIdentity: callEnd.identity || null,
        participantAttributes: callEnd.attributes || null
      }
    }),

    sbLogKuziaEvolution(
      callEnd.ended
        ? [
            "Звонок завершён корректно.",
            "Кузя прошёл полный исходящий голосовой цикл: старт агента, получение общего контекста, ожидание поднятия трубки, active-состояние, первая реплика, завершение звонка.",
            "Вывод: связка Telegram → call_sessions → agent.js → kuzia_interactions работает как единый контур Кузи.",
            "Следующий слой: добавить содержательный итог разговора после появления расшифровки звонка."
          ].join("\n")
        : [
            "Звонок не дал явного события завершения в пределах ожидания.",
            "Кузя прошёл старт и первую реплику, но конец звонка был определён неуверенно.",
            "Вывод: нужно уточнить механизм определения завершения звонка через LiveKit/SIP.",
            "Следующий слой: проверить call_end_wait_timeout и способ закрытия комнаты."
          ].join("\n")
    ),

    tgSendMessage(
      metadata.chatId,
      callEnd.ended
        ? [
            "📞 Звонок завершён.",
            `Номер: ${phoneNumber || "не передан"}`,
            "Статус: трубку подняли, первая реплика отправлена, звонок завершён.",
            "Кузя записал событие и self-review."
          ].join("\n")
        : [
            "⚠️ Звонок не дал явного сигнала завершения.",
            `Номер: ${phoneNumber || "не передан"}`,
            "Кузя записал это как call_end_wait_timeout.",
            "Нужно будет проверить механизм завершения звонка."
          ].join("\n")
    ),
    ]);
    } finally {
      lifecycle.dispose();
      session.shutdown({ drain: false, reason: "call_entry_finished" });
      ctx.shutdown("call_entry_finished");
    }
  }
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "kuzya-agent"
  })
);

