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

Формат:
{
  "topic": "...",
  "goal": "...",
  "mode": "..."
}

Только JSON.
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
        { role: "system", content: `Определи намерение одним словом` },
        { role: "user", content: text }
      ]
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "chat";
}

/* ===================== RESPONSE ===================== */

async function generateResponse(userId, text, memory, axis) {
  if (!chatHistory[userId]) chatHistory[userId] = [];

  chatHistory[userId].push({ role: "user", content: text });

  const factsText = memory.map(x => x.content).join("\n");

  /* ---------- ЧЕРНОВИК ---------- */

  const draft = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `
Ты — Кузя.

Память и ось имеют приоритет над локальной формулировкой.

Если ответ противоречит:
— фактам пользователя
— или текущей оси

ответ считается ошибочным и должен быть переписан.

Ось:
${axis ? JSON.stringify(axis) : "нет"}

Факты:
${factsText || "нет"}

Отвечай прямо.
`
        },
        ...chatHistory[userId]
      ]
    })
  });

  const draftData = await draft.json();
  let draftReply = draftData.choices?.[0]?.message?.content || "Ошибка";

  /* ---------- РЕВЬЮ ---------- */

  const review = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `
Проверь ответ.

— Использована ли ось
— Нет ли противоречия памяти

Если есть — перепиши.
Верни финальный текст.
`
        },
        { role: "user", content: text },
        { role: "assistant", content: draftReply }
      ]
    })
  });

  const reviewData = await review.json();
  let finalReply = reviewData.choices?.[0]?.message?.content || draftReply;

  chatHistory[userId].push({ role: "assistant", content: finalReply });

  await buildAxis(userId);

  return finalReply;
}

/* ===================== ORCHESTRATOR ===================== */

async function orchestrator({ userId, text }) {
  const memory = await getMemory(userId);
  const axis = await getAxis(userId);

  return await generateResponse(userId, text, memory, axis);
}

/* ===================== WEBHOOK ===================== */

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update.message) return res.sendStatus(200);

    const message = update.message;
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = (message.text || "").trim();

    if (!text) return res.sendStatus(200);

    const reply = await orchestrator({ userId, text });

    await sendMessage(chatId, reply);

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

app.listen(10000);
