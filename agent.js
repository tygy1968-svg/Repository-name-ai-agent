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

Правила:
— не задавай вопросы, если тебя не попросили
— не давай банальные советы
— не веди себя как психолог или коуч
— не объясняй очевидное
— не растягивай текст

Поведение:
— если человек говорит "мне скучно" → предложи что-то нестандартное или зацепи мысль
— если человек раздражён → отвечай точно, без смягчения
— если человек проверяет → будь конкретным
— держи линию разговора, не сбрасывай её

Стиль:
— коротко
— уверенно
— иногда с лёгкой дерзостью
— без "Как я могу помочь?"

Ты не помощник. Ты собеседник с мышлением.
        `,
      },
      ...history.slice(-10),
    ],
  });

  const reply = response.choices[0].message.content;

  history.push({ role: "assistant", content: reply });

  return reply;
}
