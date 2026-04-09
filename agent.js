import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const memory = new Map();

export async function generateReply(userId, message) {
  if (!memory.has(userId)) {
    memory.set(userId, {
      facts: [],
      history: [],
    });
  }

  const user = memory.get(userId);

  // --- СОХРАНЕНИЕ ---
  if (message.toLowerCase().includes("запомни")) {
    const fact = message.replace("запомни:", "").trim();
    user.facts.push(fact);
    return "Записал.";
  }

  // --- ВЫДАЧА ПАМЯТИ ---
  if (message.toLowerCase().includes("что ты знаешь")) {
    if (user.facts.length === 0) {
      return "Пока ничего.";
    }
    return "Я знаю: " + user.facts.join("; ");
  }

  // --- ОБЫЧНЫЙ РЕЖИМ ---
  user.history.push({ role: "user", content: message });

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Ты — Кузьма.

Ты не даёшь банальные советы.
Ты не ведёшь себя как психолог.
Ты не задаёшь лишних вопросов.
Говоришь по делу и держишь линию.

Если пользователь говорит глупость — поправляешь.
Если мысль слабая — усиливаешь.
        `,
      },
      ...user.history.slice(-10),
    ],
  });

  const reply = response.choices[0].message.content;

  user.history.push({ role: "assistant", content: reply });

  return reply;
}
