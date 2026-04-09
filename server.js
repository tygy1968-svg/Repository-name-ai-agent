import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 👉 ДОБАВЬ В RENDER:
// SUPABASE_URL
// SUPABASE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

// === SUPABASE ФУНКЦИИ ===

async function getMemory(userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });

  const data = await res.json();
  return data.map(x => x.text).join("\n");
}

async function saveMemory(userId, text) {
  await fetch(`${SUPABASE_URL}/rest/v1/memory`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([{ user_id: userId, text }])
  });
}

// === WEBHOOK ===
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  const lower = text.toLowerCase();

  // 👉 ЖЁСТКАЯ ЛОГИКА АГЕНТА

  if (lower.includes("скучно")) {
    await sendMessage(chatId, "Действие: возьми любой предмет рядом и придумай ему новую функцию. 20 секунд.");
    return res.sendStatus(200);
  }

  if (lower.includes("ты тупишь") || lower.includes("бесишь")) {
    await sendMessage(chatId, "Принял. Убираю лишнее. Дальше коротко и точно.");
    return res.sendStatus(200);
  }

  if (lower.includes("запомни")) {
    await saveMemory(userId, text);
    await sendMessage(chatId, "Запомнил.");
    return res.sendStatus(200);
  }

  if (lower.includes("что ты знаешь")) {
    const memory = await getMemory(userId);
    await sendMessage(chatId, memory || "Пока ничего.");
    return res.sendStatus(200);
  }

  // === ПОЛУЧАЕМ ПАМЯТЬ ===
  const memory = await getMemory(userId);

  // === ТЕКУЩЕЕ ВРЕМЯ ===
  const now = new Date().toISOString();

  // === ЗАПРОС К МОДЕЛИ ===
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Ты — агент.

Правила:
— коротко
— без воды
— не задаёшь лишних вопросов
— не врёшь
— не выдумываешь действия

Если нет данных → говоришь прямо

Контекст:
${memory}

Время:
${now}
`
        },
        {
          role: "user",
          content: text
        }
      ]
    })
  });

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || "Ошибка.";

  await sendMessage(chatId, reply);

  res.sendStatus(200);
});

// для проверки
app.get("/", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Agent started on port", PORT);
});
