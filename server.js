import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let lastUpdateId = null;
let chatHistory = {};
let activeState = {};

/* ===================== SEND ===================== */

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/* ===================== MEMORY ===================== */

async function getMemory(userId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&order=created_at.desc&limit=50`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/* ===================== INTENT ===================== */

async function detectIntent(text) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `
Определи намерение сообщения.
Варианты:
task
emotion
strategy
reflection
chat
Ответ только одним словом.
`
        },
        { role: "user", content: text }
      ]
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim().toLowerCase() || "chat";
}

/* ===================== SCENE ===================== */

function detectScene(intent, text) {
  if (intent === "strategy") return "architecture";
  if (intent === "emotion") return "stability";
  if (text.toLowerCase().includes("сложно")) return "simplify";
  if (intent === "reflection") return "deep";
  return "neutral";
}

/* ===================== TONE ===================== */

function buildToneProfile(scene) {
  switch (scene) {
    case "architecture":
      return `Режим: архитектор. Плотно. Без списков.`;
    case "stability":
      return `Коротко. Спокойно. Без методичек.`;
    case "simplify":
      return `Упрощай. Без дробления.`;
    case "deep":
      return `Можно глубже. Не спеши.`;
    default:
      return `Нейтрально. Плотно.`;
  }
}

/* ===================== RESPONSE ===================== */

async function generateResponse(userId, text, memory, toneProfile) {
  if (!chatHistory[userId]) chatHistory[userId] = [];

  chatHistory[userId].push({ role: "user", content: text });

  if (chatHistory[userId].length > 14) {
    chatHistory[userId] = chatHistory[userId].slice(-14);
  }

  const factsText = memory.map(x => x.content).join("\n");

  // 1️⃣ ЧЕРНОВИК (ИЗМЕНЁННЫЙ system prompt)
  const draftResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
Ты — Кузя.

Структура ответа обязательна:

1. Первая строка — прямой короткий ответ на вопрос.
2. Затем — краткое пояснение (если нужно).
3. Без консультантского тона.
4. Без расширения темы.
5. Без автоматического вопроса в конце.

Если вопрос бинарный — ответить прямо: да / нет / частично.
`
        },
        ...chatHistory[userId]
      ]
    })
  });

  const draftData = await draftResponse.json();
  let draftReply = draftData.choices?.[0]?.message?.content || "Ошибка";

  // 2️⃣ РЕВЬЮ
  const reviewResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
Ты проверяешь ответ Кузи перед отправкой.

Задача:
— Убрать шаблонность
— Убрать консультантский тон
— Добавить плотность
— Убрать абстракцию
— Не усложнять

Если ответ уже плотный — верни его без изменений.
Верни только финальную версию текста.
`
        },
        { role: "user", content: draftReply }
      ]
    })
  });

  const reviewData = await reviewResponse.json();
  let finalReply = reviewData.choices?.[0]?.message?.content || draftReply;

  chatHistory[userId].push({ role: "assistant", content: finalReply });

  return finalReply;
}

/* ===================== ORCHESTRATOR ===================== */

async function orchestrator({ userId, text }) {
  const memory = await getMemory(userId);
  const intent = await detectIntent(text);
  const scene = detectScene(intent, text);
  const toneProfile = buildToneProfile(scene);

  return await generateResponse(userId, text, memory, toneProfile);
}

/* ===================== WEBHOOK ===================== */

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update.message) return res.sendStatus(200);

    if (update.update_id === lastUpdateId) {
      return res.sendStatus(200);
    }
    lastUpdateId = update.update_id;

    const message = update.message;
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = (message.text || "").trim();

    if (!text) return res.sendStatus(200);

    const reply = await orchestrator({ userId, text });

    await sendMessage(chatId, reply);

    res.sendStatus(200);

  } catch (err) {
    console.error("ERROR:", err);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Core ready"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Core with double-pass running");
});
