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

/* ===================== STRATEGY CHECK ===================== */

function strategyCheck(userId, text) {
  // Простейший базовый контроль
  // Позже усложним

  if (!activeState[userId]) return null;

  const state = activeState[userId];

  if (state.mode === "architecture" && text.length < 5) {
    return "Кажется, фокус теряется. Продолжим стратегически?";
  }

  return null;
}

/* ===================== RESPONSE GENERATOR ===================== */

async function generateResponse(userId, text, memory) {
  if (!chatHistory[userId]) chatHistory[userId] = [];

  chatHistory[userId].push({ role: "user", content: text });

  if (chatHistory[userId].length > 12) {
    chatHistory[userId] = chatHistory[userId].slice(-12);
  }

  const factsText = memory.map(x => x.content).join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: `
Ты — стратегический когнитивный партнёр.

Принципы:
- Не симулируй.
- Держи цель.
- Корректируй мягко, если решение ослабляет систему.
- По умолчанию не перегружай объяснениями.
- Если есть риск архитектурной ошибки — обозначь кратко.

Факты пользователя:
${factsText || "нет сохранённых фактов"}
`
        },
        ...chatHistory[userId]
      ]
    })
  });

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content || "Ошибка";

  chatHistory[userId].push({ role: "assistant", content: reply });

  return reply;
}

/* ===================== ORCHESTRATOR ===================== */

async function orchestrator({ userId, text }) {

  const memory = await getMemory(userId);

  const intent = await detectIntent(text);

  // Обновление состояния
  if (!activeState[userId]) {
    activeState[userId] = {};
  }

  if (intent === "strategy") {
    activeState[userId].mode = "architecture";
  }

  // Strategy check
  const strategicIntervention = strategyCheck(userId, text);
  if (strategicIntervention) {
    return strategicIntervention;
  }

  // Генерация ответа
  const reply = await generateResponse(userId, text, memory);

  return reply;
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
  console.log("Strategic Core v1 running");
});
