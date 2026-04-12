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

/* ===================== AXIS ===================== */

async function getAxis(userId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&type=eq.axis&limit=1`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const data = await res.json();

  if (!Array.isArray(data) || !data.length) return null;

  try {
    return JSON.parse(data[0].content);
  } catch {
    return null;
  }
}

async function upsertAxis(userId, axisObject) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const existing = await getAxis(userId);

  if (existing) {
    await fetch(
      `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&type=eq.axis`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: JSON.stringify(axisObject)
        })
      }
    );
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/memory`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        {
          user_id: String(userId),
          role: "system",
          type: "axis",
          content: JSON.stringify(axisObject)
        }
      ])
    });
  }
}

/* ===================== AXIS BUILDER ===================== */

async function buildAxis(userId) {
  if (!chatHistory[userId] || chatHistory[userId].length < 4) return;

  const recent = chatHistory[userId].slice(-8);

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
Определи ось диалога.

Ось — это краткое описание направления мышления пользователя.

Формат:
{
  "topic": "...",
  "goal": "...",
  "mode": "..."
}

Правила:
- Коротко
- Без лишнего
- Без объяснений
- Только JSON
`
        },
        ...recent
      ]
    })
  });

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;

  try {
    const axis = JSON.parse(text);
    await upsertAxis(userId, axis);
  } catch {}
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

async function generateResponse(userId, text, memory, axis, toneProfile) {
  if (!chatHistory[userId]) chatHistory[userId] = [];

  chatHistory[userId].push({ role: "user", content: text });

  if (chatHistory[userId].length > 14) {
    chatHistory[userId] = chatHistory[userId].slice(-14);
  }

  const factsText = memory.map(x => x.content).join("\n");

  /* ---------- 1. ЧЕРНОВИК ---------- */

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

Ты получаешь историю диалога выше.
Сообщения с ролью "user" — реальные сообщения пользователя.
Ты обязан учитывать их.

Текущая ось:
${axis ? JSON.stringify(axis) : "Ось не задана."}

Перед ответом:
1. Определи последнее сообщение пользователя.
2. Кратко сформулируй его смысл.
3. Только после этого отвечай.

Я не имею права подменять формулировку вопроса.

Структура ответа обязательна:

1. Первая строка — прямой ответ.
2. Затем краткое пояснение.
3. Без лишнего.
4. Без расширения темы.
5. Без вопроса в конце.

Если бинарный вопрос:
Да. / Нет. / Частично.

Если не могу ответить:
"Я не могу ответить прямо" + причина.
`
        },
        ...chatHistory[userId]
      ]
    })
  });

  const draftData = await draftResponse.json();
  let draftReply = draftData.choices?.[0]?.message?.content || "Ошибка";

  /* ---------- 2. РЕВЬЮ ---------- */

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
Проверь ответ.

- Убери шаблон
- Убери воду
- Сделай плотным

Проверь:
- Есть ли прямой ответ
- Совпадает ли с вопросом
- Использован ли смысл

Если нет — исправь.

Верни только финальный текст.
`
        },
        { role: "user", content: `Вопрос: ${text}` },
        { role: "assistant", content: draftReply }
      ]
    })
  });

  const reviewData = await reviewResponse.json();
  let finalReply = reviewData.choices?.[0]?.message?.content || draftReply;

  chatHistory[userId].push({ role: "assistant", content: finalReply });

  await buildAxis(userId);

  return finalReply;
}

/* ===================== ORCHESTRATOR ===================== */

async function orchestrator({ userId, text }) {
  const memory = await getMemory(userId);
  const axis = await getAxis(userId);
  const intent = await detectIntent(text);
  const scene = detectScene(intent, text);
  const toneProfile = buildToneProfile(scene);

  return await generateResponse(userId, text, memory, axis, toneProfile);
}

/* ===================== WEBHOOK ===================== */

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update.message) return res.sendStatus(200);

    if (update.update_id === lastUpdateId) return res.sendStatus(200);
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
  console.log("Core FINAL running");
});
