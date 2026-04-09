import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

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

// --- MEMORY UPDATE ---
async function updateState(oldSummary, userMessage, agentReply) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 100,
    messages: [
      {
        role: "system",
        content: `
Сожми разговор в суть.

Оставь:
— желания пользователя
— цели
— повторяющиеся темы

Убери:
— лишние слова
— вежливость

Коротко.
`,
      },
      {
        role: "user",
        content: `
Было:
${oldSummary}

Новое:
${userMessage}

Ответ:
${agentReply}

Новая память:
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

Ты не чат-бот.
Ты продолжаешь мысль.

Запрещено:
— "как я могу помочь"
— "что ты думаешь"
— "расскажи подробнее"

Ты:
— отвечаешь по сути
— усиливаешь направление
— не задаёшь дежурные вопросы

Если пользователь сказал "развивайся" — ты меняешь поведение.

Память:
${state}
`;
}

// --- AGENT ---
export async function generateReply(userId, message) {
  const state = await getState(userId);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.8,
    max_tokens: 200,
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
