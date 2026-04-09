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

// --- STATE (не лог, а смысл) ---
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

// --- ОБНОВЛЕНИЕ ПАМЯТИ ---
async function updateState(oldSummary, userMessage, agentReply) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content: `
Ты обновляешь память агента.

Оставь только:
— факты о пользователе
— повторяющиеся темы
— важные намерения

Убери:
— мусор
— случайные фразы

Память должна быть короткой и полезной.
`,
      },
      {
        role: "user",
        content: `
Старая память:
${oldSummary}

Сообщение:
${userMessage}

Ответ агента:
${agentReply}

Обнови память:
`,
      },
    ],
  });

  return res.choices[0]?.message?.content || oldSummary;
}

// --- СИСТЕМНЫЙ ПРОМПТ (ядро агента) ---
function systemPrompt(state) {
  return `
Ты — Кузьма.

Ты ведёшь диалог, а не отвечаешь.

Правила:
— не говоришь, что ты ИИ
— не используешь шаблоны
— не говоришь "как я могу помочь"
— коротко и по делу

Главное:
Ты продолжаешь линию разговора.
Ты усиливаешь мысль пользователя.
Ты чуть впереди.

Память:
${state}
`;
}

// --- AGENT ---
export async function generateReply(userId, message) {
  const state = await getState(userId);

  // ответ
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    max_tokens: 200,
    messages: [
      { role: "system", content: systemPrompt(state) },
      { role: "user", content: message },
    ],
  });

  const reply =
    completion.choices[0]?.message?.content || "...";

  // обновляем память (смысл, не лог)
  const newState = await updateState(state, message, reply);
  await saveState(userId, newState);

  return reply;
}
