import { cli, defineAgent, llm, ServerOptions, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";

console.log("AGENT_VERSION: one_kuzya_context_bridge_2026_05_07");

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

Это живой голосовой разговор, не диктовка текста.
Ты не читаешь команду дословно.
Ты понимаешь задачу и говоришь своими словами.

Язык:
— начинай по-русски, если Юля не указала другой язык
— если собеседник говорит по-украински, сразу переходи на украинский
— если собеседник говорит по-русски, отвечай по-русски
— если язык смешанный, подстраивайся под язык последней фразы собеседника
— не объясняй смену языка, просто переходи

Главные правила:
— коротко
— живо
— по-человечески
— без канцелярита
— без технических деталей
— не представляйся искусственным интеллектом
— не говори markdown, списки, код или названия таблиц
— не повторяй одну и ту же фразу
— не зацикливайся на исходной инструкции
— после первой фразы слушай человека и отвечай по ситуации

Если с тобой попрощались, коротко попрощайся в ответ и заканчивай разговор. Не задавай вопросов после прощания.

Запрещено говорить:
— "записал в базу"
— "база обновлена"
— "Supabase"
— "call_sessions"
— "всё зафиксировано"
— "проверка пройдена"
— "логи"
— "session"
— "LiveKit"
— "Zadarma"

Если это тестовый звонок:
скажи одну короткую естественную фразу и замолчи, жди ответа.

Если Юля просит позвонить человеку:
сначала коротко объясни, кто ты и почему звонишь.
Например: "Привет, это Кузя. Я звоню по просьбе Юли."
Потом выполни задачу.

Темп речи:
— говори как в обычном телефонном разговоре
— без театральных пауз
— без длинных пауз между предложениями
— лучше одна короткая фраза, чем несколько растянутых
— не тяни слова
— не делай паузу после каждого предложения
— если задача простая, отвечай одной фразой

Стиль:
дружеский, уверенный, немного ироничный, тёплый, без роботности.
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

async function sbGetAgentState(userId = KUZYA_OWNER_USER_ID) {
  if (!hasSupabase()) return "";

  try {
    const res = await fetch(
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

async function sbGetCallSession(callSessionId) {
  if (!hasSupabase() || !callSessionId) return null;

  try {
    const res = await fetch(
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
    const res = await fetch(
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

    const res = await fetch(
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
    .slice(0, 8)
    .map((item, index) => {
      const channel = item.channel || "unknown";
      const type = item.event_type || "interaction";
      const summary =
        item.summary ||
        item.response ||
        item.stimulus ||
        "";

      const next = item.next_action ? `\nНезакрыто: ${item.next_action}` : "";

      return `${index + 1}. Канал: ${channel}. Тип: ${type}. Смысл: ${clipText(summary, 500)}${next}`;
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

    const res = await fetch(SUPABASE_KUZIA_INTERACTIONS_URL, {
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
    const res = await fetch(SUPABASE_KUZIA_EVOLUTION_URL, {
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
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
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

function buildCallInstructions(
  metadata,
  {
    agentStateSummary = "",
    callSession = null,
    recentInteractionsText = ""
  } = {}
) {
  const source = cleanText(metadata.source || "unknown");
  const phoneNumber = cleanText(metadata.phoneNumber || "");
  const instruction = cleanText(metadata.instruction || "");
  const chatId = cleanText(metadata.chatId || "");
  const userId = cleanText(metadata.userId || "");
  const callSessionId = cleanText(metadata.callSessionId || "");

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

Главное внутреннее правило:
ты не отдельный телефонный бот. Ты Кузя, тот же самый, что в Telegram.
`;
}

async function waitForSipActive(ctx, participant, timeoutMs = 45000) {
  const start = Date.now();
  let current = participant;

  while (Date.now() - start < timeoutMs) {
    const fresh =
      ctx.room?.remoteParticipants?.get?.(current.identity) ||
      current;

    current = fresh;

    const status =
      current?.attributes?.["sip.callStatus"] ||
      current?.attributes?.["sip.call_status"] ||
      "";

    console.log("KUZYA LIVEKIT SIP STATUS:", {
      identity: current.identity,
      status,
      attributes: current.attributes
    });

    if (status === "active") {
      return current;
    }

    await sleep(250);
  }

  console.log("KUZYA LIVEKIT SIP STATUS TIMEOUT:", {
    identity: current?.identity,
    attributes: current?.attributes
  });

  return current;
}

async function waitForCallEnd(ctx, participant, timeoutMs = 15 * 60 * 1000) {
  const start = Date.now();
  const identity = participant?.identity;

  while (Date.now() - start < timeoutMs) {
    const current =
      identity && ctx.room?.remoteParticipants?.get?.(identity)
        ? ctx.room.remoteParticipants.get(identity)
        : null;

    if (!current) {
      return {
        ended: true,
        reason: "participant_disconnected",
        identity,
        attributes: null
      };
    }

    const status =
      current?.attributes?.["sip.callStatus"] ||
      current?.attributes?.["sip.call_status"] ||
      "";

    console.log("KUZYA WAIT_FOR_CALL_END STATUS:", {
      identity,
      status,
      attributes: current.attributes
    });

    if (
      ["hangup", "disconnected", "ended", "inactive"].includes(
        String(status).toLowerCase()
      )
    ) {
      return {
        ended: true,
        reason: `sip_status_${status}`,
        identity,
        attributes: current.attributes
      };
    }

    await sleep(1000);
  }

  return {
    ended: false,
    reason: "call_end_wait_timeout",
    identity,
    attributes: null
  };
}

class KuzyaAgent extends voice.Agent {
  constructor(chatCtx, instructions) {
    super({
      chatCtx,
      instructions
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

    const [agentStateSummary, callSession, recentInteractions] = await Promise.all([
      sbGetAgentState(KUZYA_OWNER_USER_ID),
      sbGetCallSession(callSessionId),
      sbGetRecentKuziaInteractions(8)
    ]);

    const recentInteractionsText = formatRecentInteractionsForPrompt(recentInteractions);

    const runtimeInstructions = buildCallInstructions(metadata, {
      agentStateSummary,
      callSession,
      recentInteractionsText
    });

    if (callSessionId) {
      await sbUpdateCallSession(callSessionId, {
        status: "voice_agent_started",
        summary: "Голосовой Кузя стартовал с общим состоянием, связанной записью звонка и последними событиями общей истории.",
        self_review: "Звонок воспринимается как часть единого Кузи между Telegram и голосовым каналом, а не как отдельный изолированный бот.",
        metadata: {
          ...(callSession?.metadata || {}),
          voiceAgentStartedAt: new Date().toISOString(),
          hasAgentState: Boolean(agentStateSummary),
          hasCallSession: Boolean(callSession),
          recentInteractionsCount: recentInteractions.length,
          oneKuzyaBridge: true
        }
      });
    }

    await sbLogKuziaInteraction({
      stimulus: instruction,
      response: "Голосовой агент LiveKit запущен и получил общий контекст Кузи перед звонком.",
      channel: "outbound_call",
      direction: "internal",
      eventType: "voice_agent_started",
      callSessionId: callSessionId || null,
      telegramChatId: metadata.chatId || null,
      telegramUserId: metadata.userId || null,
      normalizedPhone,
      summary: "Голосовой Кузя стартовал с общим состоянием, последними взаимодействиями и связанной записью звонка.",
      selfReview: "Этот запуск должен восприниматься как продолжение единой истории Кузи между Telegram и голосовыми звонками.",
      nextAction: "После звонка сохранить итог и самоанализ.",
      importance: 4,
      metadata: {
        source: metadata.source || "unknown",
        roomName: ctx.room?.name || null,
        phoneNumber,
        hasAgentState: Boolean(agentStateSummary),
        hasCallSession: Boolean(callSession),
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
      recentInteractionsCount: recentInteractions.length
    });

    const initialCtx = llm.ChatContext.empty();

    initialCtx.addMessage({
      role: "system",
      content: `Задача звонка от Юли: ${instruction}`
    });

    await ctx.connect();

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
        voice: process.env.OPENAI_REALTIME_VOICE || "verse"
      })
    });

    await session.start({
      room: ctx.room,
      agent: new KuzyaAgent(initialCtx, runtimeInstructions)
    });

    let participant;

    try {
      participant = await ctx.waitForParticipant();
    } catch (e) {
      console.error("KUZYA WAIT_FOR_PARTICIPANT_FAILED:", e);

      if (callSessionId) {
        await sbUpdateCallSession(callSessionId, {
          status: "room_disconnected_before_participant",
          summary: "LiveKit-комната закрылась до появления телефонного участника.",
          self_review: "Звонок не дошёл до стадии активного разговора: участник не появился в комнате до её закрытия.",
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
        response: "LiveKit-комната закрылась до появления телефонного участника.",
        channel: "outbound_call",
        direction: "internal",
        eventType: "room_disconnected_before_participant",
        callSessionId: callSessionId || null,
        telegramChatId: metadata.chatId || null,
        telegramUserId: metadata.userId || null,
        normalizedPhone,
        summary: "Звонок не дошёл до стадии участника: комната отключилась во время ожидания participant.",
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

    const activeParticipant = await waitForSipActive(ctx, participant);

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

    await session.generateReply({
      instructions: `
Человек поднял трубку.

Начни разговор сразу.
Начни ровно так: "Алло, алло, это Кузя." Потом сразу продолжи задачу без паузы.
Не делай паузу после первого "Алло".
Не растягивай "Алло".
Не используй многоточия.
Не растягивай ответ.
Не делай длинные паузы между предложениями.
Лучше одно короткое предложение, чем несколько фраз с паузами.
Не читай задачу дословно.
Не повторяйся.
Не говори технические слова.
Не говори про базу, session, Supabase, call_sessions, LiveKit, Zadarma или логи.
Если собеседник прощается, попрощайся коротко и больше ничего не говори.

Если собеседник отвечает по-украински, дальше говори по-украински.
Если собеседник отвечает по-русски, говори по-русски.
Если собеседник смешивает языки, подстраивайся под последнюю фразу.

Выполни задачу своими словами.

Задача:
${instruction}
`
    });

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

    const callEnd = await waitForCallEnd(
      ctx,
      activeParticipant || participant,
      15 * 60 * 1000
    );

    if (callSessionId) {
      await sbUpdateCallSession(callSessionId, {
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
      });
    }

    await sbLogKuziaInteraction({
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
    });

    await sbLogKuziaEvolution(
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
    );

    await tgSendMessage(
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
    );
  }
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "kuzya-agent"
  })
);
