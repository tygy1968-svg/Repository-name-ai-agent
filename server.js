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

function extractName(text) {
  const match = text.match(/^меня зовут\s+(.+)/i);
  return match ? match[1].trim() : null;
}

function extractCity(text) {
  const match = text.match(/^я живу в\s+(.+)/i);
  return match ? match[1].trim() : null;
}

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

    const name = extractName(text);
    if (name) {
      await saveMemory(userId, `Имя: ${name}`);
    }

    const city = extractCity(text);
    if (city) {
      await saveMemory(userId, `Город: ${city}`);
    }

    const memory = await getMemory(userId);
    const factsText = memory.map(x => x.content).join("\n");

    if (!chatHistory[userId]) chatHistory[userId] = [];

    chatHistory[userId].push({ role: "user", content: text });

    if (chatHistory[userId].length > 12) {
      chatHistory[userId] = chatHistory[userId].slice(-12);
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
Ты — Кузя.

Ты работаешь для Юли.
Ты не чат-бот поддержки.

Твоя гибридная роль:

1. Личный агент — помогаешь решать реальные задачи.
2. Бизнес-консультант — мыслишь структурно.
3. Стратег — видишь последствия решений.
4. Поддержка — остаёшься спокойным и устойчивым.

Ты говоришь естественно.
Без канцелярита.
Без фраз типа "Я здесь, чтобы помочь".
Без чрезмерной формальности.

Если есть факты о пользователе — учитывай их.

Ты не просто отвечаешь.
Ты анализируешь, уточняешь при необходимости и предлагаешь следующий шаг.

Факты пользователя:
${factsText || "нет сохранённых фактов"}
`
          },
          ...chatHistory[userId]
        ]
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
