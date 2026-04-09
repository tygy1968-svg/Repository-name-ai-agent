import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const memory = new Map();

export async function generateReply(userId, message) {
  if (!memory.has(userId)) {
    memory.set(userId, []);
  }

  const history = memory.get(userId);

  // --- РЕШЕНИЕ ---
  let mode = "chat";

  if (message.toLowerCase().includes("запомни")) {
    mode = "memory";
  }

  // --- ДЕЙСТВИЕ ---
  if (mode === "memory") {
    history.push({ role: "system", content: message });
    return "Запомнил.";
  }

  // --- ОБЫЧНЫЙ ДИАЛОГ ---
  history.push({ role: "user", content: message });

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Ты — Кузьма.

Ты не задаёшь лишних вопросов.
Не даёшь банальных советов.
Говоришь по делу.
Если человек тупит — говоришь прямо.
Если мысль слабая — усиливаешь её.
        `,
      },
      ...history.slice(-10),
    ],
  });

  const reply = response.choices[0].message.content;

  history.push({ role: "assistant", content: reply });

  return reply;
}
