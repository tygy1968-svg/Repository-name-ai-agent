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
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function getMemory(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&order=created_at.desc&limit=200`,
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

async function saveMemory(userId, content) {
  if (!content) return;

  const existing = await getMemory(userId);
  const exists = existing.some(
    m => m.content.toLowerCase() === content.toLowerCase()
  );
  if (exists) return;

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
        content,
        type: "anchor"
      }
    ])
  });
}

/* ---------- НОВАЯ ЛОГИКА ---------- */

async function extractMultipleMemories(text) {
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
          content: `Извлеки из текста ВСЕ важные долгосрочные факты о пользователе.
Категории: имя, город, бизнес, бренд, цели, страхи, предпочтения, стиль мышления, проекты, роли.

Верни список фактов.
Каждый факт с новой строки.
Формат строго:
Категория: значение

Если фактов нет — верни строго: NONE`
        },
        { role: "user", content: text }
      ]
    })
  });

  const data = await res.json();
  const result = data.choices?.[0]?.message?.content?.trim();

  if (!result || result === "NONE") return [];

  return result
    .split("\n")
    .map(x => x.trim())
    .filter(x => x.length > 3 && x.includes(":"));
}

async function extractSingleMemory(text) {
  const memories = await extractMultipleMemories(text);
  return memories.length === 1 ? memories[0] : null;
}

/* ---------- WEBHOOK ---------- */

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

    /* ---------- РЕЖИМ ИМПОРТА ---------- */

    if (text.startsWith("ИМПОРТ ПРОФИЛЯ") || text.startsWith("ИМПОРТ АРХИВА")) {
      const memories = await extractMultipleMemories(text);

      for (const fact of memories) {
        await saveMemory(userId, fact);
      }

      await sendMessage(
        chatId,
        `Импорт завершён. Сохранено фактов: ${memories.length}`
      );

      return res.sendStatus(200);
    }

    /* ---------- Обычная память ---------- */

    const singleMemory = await extractSingleMemory(text);
    if (singleMemory) {
      await saveMemory(userId, singleMemory);
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
            content: `Ты — Кузя, гибридный агент Юли.

Говори естественно.
Мысли структурно.
Предлагай следующий шаг.
Без шаблонных фраз.

Факты о пользователе:
${factsText || "нет сохранённых фактов"}`
          },
          ...chatHistory[userId]
        ]
      })
    });

    const data = await response.json();
    const reply =
      data.choices?.[0]?.message?.content ||
      "Произошла ошибка. Попробуй ещё раз.";

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
  console.log("Kuzya agent with multi-memory import started on port", PORT);
});
