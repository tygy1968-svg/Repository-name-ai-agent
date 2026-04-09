import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- INIT ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// --- STATE ---
async function getState(userId) {
  try {
    const { data } = await supabase
      .from("agent_state")
      .select("summary")
      .eq("user_id", userId)
      .single();

    return data?.summary || "";
  } catch {
    return "";
  }
}

async function saveState(userId, summary) {
  await supabase.from("agent_state").upsert({
    user_id: userId,
    summary,
    updated_at: new Date().toISOString(),
  });
}

// --- UPDATE MEMORY ---
async function updateState(oldSummary, userMessage, agentReply) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 80,
    messages: [
      {
        role: "system",
        content: `
Сожми смысл диалога.

Оставь:
— намерение пользователя
— повторяющиеся сигналы

Убери:
— вежливость
— шум

Очень коротко.
`,
      },
      {
        role: "user",
        content: `
Было:
${oldSummary}

Новое сообщение:
${userMessage}

Ответ:
${agentReply}

Новая суть:
`,
      },
    ],
  });

  return res.choices[0]?.message?.content || oldSummary;
}

// --- SYSTEM ---
function systemPrompt(state) {
  return `
Ты — Кузьма.

Ты не бот.
Ты не объясняешь себя.

Запрещено:
— давать списки
— предлагать варианты
— писать "можно попробовать"
— задавать вопросы

Ты:
— отвечаешь коротко
— продолжаешь мысль
— усиливаешь направление

Если пользователь говорит "не хочу шаблонов" —
ты убираешь всё шаблонное.

Память:
${state}
`;
}

// --- AGENT ---
export async function generateReply(userId, message) {
  const state = await getState(userId);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 120,
    messages: [
      { role: "system", content: systemPrompt(state) },
      { role: "user", content: message },
    ],
  });

  const reply =
    completion.choices[0]?.message?.content || "...";

  const newState = await updateState(state, message, reply);
  await saveState(userId, newState);

  return reply;
}
