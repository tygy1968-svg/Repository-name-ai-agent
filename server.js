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
let chatHistory = {}; // хранение истории по пользователям

// ================= TELEGRAM =================

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

// ================= MEMORY =================

async function getMemory(userId) {
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
  if (!Array.isArray(data)) return [];
  return data;
}

async function saveMemory(userId, content) {
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
        content: content,
        type: "anchor"
      }
    ])
  });
}

// ================= PARSING =================

function extractName(text) {
  const match = text.match(/^меня зовут\s+(.+)/i);
  return match ? match[1].trim() : null;
}

function extractCity(text) {
  const match = text.match(/^я живу в\s+(.+)/i);
  return match ? match[1].trim() : null;
}

// ================= WEBHOOK =================

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
    const lower = text.toLowerCase();

    // ===== сохраняем факты =====
    const name = extractName(text);
    if (name) {
      await saveMemory(userId, `Имя: ${name}`);
    }

    const city = extractCity(text);
    if (city) {
      await saveMemory(userId, `Город: ${city}`);
    }

    // ===== получаем факты =====
    const memory = await getMemory(userId);
    const factsText = memory.map(x => x.content).join("\n");

    // ===== история диалога =====
    if (!chatHistory[userId]) chatHistory[userId] = [];

    chatHistory[userId].push({ role: "user", content: text });

    if (chatHistory[userId].length > 10) {
      chatHistory[userId] = chatHistory[userId].slice(-10);
    }

    // ===== запрос к GPT =====
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
Ты умный автономный ассистент.

Используй факты пользователя, если они есть.

Факты:
${factsText || "нет сохранённых фактов"}
`
          },
          ...chatHistory[userId]
        ],
        temperature: 0.6
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Ок.";

    chatHistory[userId].push({ role: "assistant", content: reply });

    await sendMessage(chatId, reply);
    res.sendStatus(200);

  } catch (err) {
    console.error("ERROR:", err);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Agent started on port", PORT);
});
