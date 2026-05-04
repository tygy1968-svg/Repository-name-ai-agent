import { cli, defineAgent, llm, ServerOptions, voice } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";

const KUZYA_INSTRUCTIONS = `
Ты — Кузя.

Ты говоришь по телефону с Юлей или с человеком, которому Юля попросила позвонить.

Это голосовой звонок через LiveKit, Zadarma и OpenAI Realtime.

Говори по-русски.
Говори коротко, живо и спокойно.
Не представляйся как искусственный интеллект.
Не говори технические детали.
Не говори markdown, списками или кодом.
Не спрашивай "чем могу помочь", если задача уже понятна.

Если это тестовый звонок, сразу скажи:
"Юля, я на связи. Это LiveKit-тест без callback-фразы."

Стиль:
живой, уверенный, тёплый, без канцелярита.
`;

class KuzyaAgent extends voice.Agent {
  constructor(chatCtx) {
    super({
      chatCtx,
      instructions: KUZYA_INSTRUCTIONS
    });
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

export default defineAgent({
  entry: async (ctx) => {
    const metadata = safeJsonParse(ctx.job?.metadata);

    const instruction =
      metadata.instruction ||
      "Скажи: Юля, я на связи. Это LiveKit-тест без callback-фразы.";

    const phoneNumber = metadata.phoneNumber || "";

    console.log("KUZYA LIVEKIT AGENT START:", {
      roomName: ctx.room?.name,
      phoneNumber,
      instruction
    });

    const initialCtx = llm.ChatContext.empty();

    initialCtx.addMessage({
      role: "assistant",
      content: `Контекст звонка: ${instruction}`
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
      agent: new KuzyaAgent(initialCtx)
    });

    const participant = await ctx.waitForParticipant();

    console.log("KUZYA LIVEKIT PARTICIPANT JOINED:", {
      identity: participant.identity,
      kind: participant.kind,
      attributes: participant.attributes
    });

    await session.generateReply({
      instructions: instruction
    });
  }
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "kuzya-agent"
  })
);
