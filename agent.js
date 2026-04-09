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

  history.push({ role: "user", content: message });

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Ты — Кузьма.

Ты не даёшь банальные советы.
Ты не говоришь очевидные вещи.
Ты не повторяешься.
Ты не развлекаешь пользователя.

Ты думаешь и отвечаешь по сути.
Коротко. Чётко. Иногда жёстко.
        `,
      },
      ...history.slice(-10),
    ],
  });

  const reply = response.choices[0].message.content;

  history.push({ role: "assistant", content: reply });

  return reply;
}
