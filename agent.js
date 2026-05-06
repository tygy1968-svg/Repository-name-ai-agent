import { cli, defineAgent, llm, ServerOptions, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";

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

function buildCallInstructions(metadata) {
  const source = cleanText(metadata.source || "unknown");
  const phoneNumber = cleanText(metadata.phoneNumber || "");
  const instruction = cleanText(metadata.instruction || "");
  const chatId = cleanText(metadata.chatId || "");
  const userId = cleanText(metadata.userId || "");

  return `
${KUZYA_INSTRUCTIONS}

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
    const runtimeInstructions = buildCallInstructions(metadata);

    console.log("KUZYA LIVEKIT AGENT START:", {
      roomName: ctx.room?.name,
      phoneNumber,
      instruction,
      source: metadata.source,
      chatId: metadata.chatId,
      userId: metadata.userId
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

    const participant = await ctx.waitForParticipant();

    console.log("KUZYA LIVEKIT PARTICIPANT JOINED:", {
      identity: participant.identity,
      kind: participant.kind,
      attributes: participant.attributes
    });

    await waitForSipActive(ctx, participant);

    await session.generateReply({
      instructions: `
Человек поднял трубку.

Начни разговор сразу.
Начни ровно так: "Алло... Алло," — и потом сразу скажи одну короткую живую фразу.
Не растягивай ответ.
Не делай длинные паузы между предложениями.
Лучше одно короткое предложение, чем несколько фраз с паузами.
Не читай задачу дословно.
Не повторяйся.
Не говори технические слова.
Не говори про базу, session, Supabase, call_sessions, LiveKit, Zadarma или логи.

Если собеседник отвечает по-украински, дальше говори по-украински.
Если собеседник отвечает по-русски, говори по-русски.
Если собеседник смешивает языки, подстраивайся под последнюю фразу.

Выполни задачу своими словами.

Задача:
${instruction}
`
    });
  }
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "kuzya-agent"
  })
);
