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

/* ===================== SCENE DETECTION ===================== */

function detectScene(intent, text) {
  if (intent === "strategy") return "architecture";
  if (intent === "emotion") return "stability";
  if (text.toLowerCase().includes("сложно")) return "simplify";
  if (intent === "reflection") return "deep";
  return "neutral";
}

/* ===================== TONE PROFILE ===================== */

function buildToneProfile(scene) {
  switch (scene) {
    case "architecture":
      return `
Режим: архитектор-партнёр.
Тон: спокойный, структурный, без академической сухости.
Избегай корпоративного стиля.
`;
    case "stability":
      return `
Режим: устойчивость.
Тон: спокойный, без излишней психологии.
Не упрощай автоматически — предложи альтернативный угол.
`;
    case "simplify":
      return `
Режим: упрощение без примитивизации.
Сконцентрируйся на сути.
Не перегружай списками.
`;
    case "deep":
      return `
Режим: совместное размышление.
Позволь глубину.
Не спеши.
`;
    default:
      return `
Режим: нейтральный стратегический партнёр.
Держи цель.
`;
  }
}

/* ===================== RESPONSE GENERATOR ===================== */

async function generateResponse(userId, text, memory, toneProfile) {
  if (!chatHistory[userId]) chatHistory[userId] = [];

  chatHistory[userId].push({ role: "user", content: text });

  if (chatHistory[userId].length > 14) {
    chatHistory[userId] = chatHistory[userId].slice(-14);
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
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
Ты — стратегический когнитивный партнёр.

Принципы:
- Не симулируй.
- Держи структуру.
- Если есть риск хаоса — обозначь мягко.
- По умолчанию не объясняй лишнее.

${toneProfile}

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

  const scene = detectScene(intent, text);

  const toneProfile = buildToneProfile(scene);

  const reply = await generateResponse(
    userId,
    text,
    memory,
    toneProfile
  );

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

app.get("/", (req, res) => res.send("Core v2 ready"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Strategic Core v2 running");
});
