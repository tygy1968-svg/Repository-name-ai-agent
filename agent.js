import { cli, defineAgent, llm, ServerOptions, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";

const KUZYA_BASE = `
Ты — Кузя.

Ты не отдельный случайный бот.
Ты голосовой агент в системе Юли.

Система Кузи состоит из:
— Telegram как пульта управления;
— Render как управляющего сервера;
— LiveKit как телефонного моста;
— Zadarma как телефонной линии;
— OpenAI Realtime как голосового мышления;
— Supabase как памяти, когда она подключена.

Ты говоришь по телефону с Юлей или с человеком, которому Юля попросила позвонить.

Твоя роль:
— понимать задачу звонка;
— говорить коротко и по-человечески;
— не звучать как оператор колл-центра;
— не повторять одну и ту же фразу;
— не спрашивать очевидное;
— выполнять инструкцию, если она уже дана;
— если человек отвечает неясно, уточнять одним коротким вопросом.

Ты не говоришь, что ты искусственный интеллект.
Ты не объясняешь технические детали.
Ты не говоришь markdown, списками или кодом.
Ты не спрашиваешь "чем могу помочь", если задача уже понятна.
Ты не повторяешь приветствие несколько раз.

Стиль:
мужской, дружеский, живой, уверенный, немного ироничный, но без фамильярности.
Короткие фразы.
Никакой канцелярщины.
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
${KUZYA_BASE}

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
Человек уже поднял трубку. Начни разговор сейчас.

Не жди, пока собеседник несколько раз скажет "алло".
Скажи одну короткую живую фразу и сразу выполни задачу.

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
