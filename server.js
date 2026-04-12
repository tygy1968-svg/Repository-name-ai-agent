import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let chatHistory = {};

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
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&order=created_at.desc&limit=100`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const data = await res.json();
  return data || [];
}

/* ===================== SAVE MEMORY ===================== */

async function saveMemory(userId, content, weight) {
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
        role: "user",
        type: "fact",
        content,
        weight
      }
    ])
  });
}

/* ===================== MEMORY ANALYZER ===================== */

async function analyzeMemory(text) {
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
Определи, нужно ли сохранить факт.

Ответ строго JSON:

{
  "save": true/false,
  "fact": "...",
  "weight": 0-1
}

weight:
1 = критично
0.7 = важно
0.4 = можно забыть
`
        },
        { role: "user", content: text }
      ]
    })
  });

  const data = await res.json();

  try {
    return JSON.parse(data.choices?.[0]?.message?.content);
  } catch {
    return { save: false };
  }
}

/* ===================== AXIS ===================== */

async function getAxis(userId) {
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

  if (!data.length) return null;

  try {
    return JSON.parse(data[0].content);
  } catch {
    return null;
  }
}

async function upsertAxis(userId, axis) {
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
        type: "axis",
        content: JSON.stringify(axis)
      }
    ])
  });
}

/* ===================== AXIS BUILDER ===================== */

async function buildAxis(userId) {
  if (!chatHistory[userId] || chatHistory[userId].length < 6) return;

  const recent = chatHistory[userId].slice(-10);

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
Определи ось диалога в JSON:

{ "topic": "...", "goal": "...", "mode": "..." }
`
        },
        ...recent
      ]
    })
  });

  const data = await res.json();

  try {
    const axis = JSON.parse(data.choices[0].message.content);
    await upsertAxis(userId, axis);
  } catch {}
}

/* ===================== RESPONSE ===================== */

async function generateResponse(userId, text, memory, axis) {
  if (!chatHistory[userId]) chatHistory[userId] = [];

  chatHistory[userId].push({ role: "user", content: text });

  const strongMemory = memory
    .filter(m => m.weight >= 0.7)
    .map(m => m.content)
    .join("\n");

  /* ---------- DRAFT ---------- */

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

Используй только сильную память.

Память:
${strongMemory || "нет"}

Ось:
${axis ? JSON.stringify(axis) : "нет"}

Если ответ противоречит памяти — перепиши.

Отвечай прямо.
`
        },
        ...chatHistory[userId]
      ]
    })
  });

  const draftData = await draft.json();
  let draftReply = draftData.choices?.[0]?.message?.content || "Ошибка";

  /* ---------- REVIEW ---------- */

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
Проверь:

— нет ли конфликта с памятью
— ответ точный

Если нет — исправь.
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

  /* ---------- MEMORY SAVE ---------- */

  const analysis = await analyzeMemory(text);

  if (analysis.save) {
    await saveMemory(userId, analysis.fact, analysis.weight);
  }

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
    const msg = req.body.message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || "";

    const reply = await orchestrator({ userId, text });

    await sendMessage(chatId, reply);

    res.sendStatus(200);

  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

app.listen(10000);
