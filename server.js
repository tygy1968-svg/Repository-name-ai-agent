import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let lastUpdateId = null;
let chatHistory = {};
let pendingMemory = {};

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

/* ---------- РЕЖИМ D ---------- */

async function analyzeMemoryWithReason(text) {
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
Определи, содержит ли сообщение пользователя информацию,
которая может быть полезна в будущих разговорах.

Если не нужно сохранять — верни: NONE

Если нужно:
Факт: ...
Причина: ...
`
        },
        { role: "user", content: text }
      ]
    })
  });

  const data = await res.json();
  const result = data.choices?.[0]?.message?.content?.trim();
  if (!result || result === "NONE") return null;

  const lines = result.split("\n").map(x => x.trim());
  const factLine = lines.find(x => x.startsWith("Факт:"));
  const reasonLine = lines.find(x => x.startsWith("Причина:"));

  if (!factLine) return null;

  return {
    fact: factLine.replace("Факт:", "").trim(),
    reason: reasonLine ? reasonLine.replace("Причина:", "").trim() : ""
  };
}

/* ---------- SERPAPI GOOGLE PLACES ---------- */

async function searchPlaces(query) {
  if (!SERPAPI_KEY) return null;

  const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.local_results || data.local_results.length === 0) return [];

  return data.local_results.slice(0, 3).map(place => ({
    name: place.title,
    address: place.address,
    rating: place.rating || "нет рейтинга"
  }));
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

    /* ---------- ПОИСК ---------- */

    if (text.toLowerCase().startsWith("найди")) {

      const results = await searchPlaces(text);

      if (!results || results.length === 0) {
        await sendMessage(chatId, "Ничего не найдено по этому запросу.");
        return res.sendStatus(200);
      }

      const reply = results
        .map((r, i) => `${i + 1}. ${r.name}\n${r.address}\nРейтинг: ${r.rating}`)
        .join("\n\n");

      await sendMessage(chatId, reply);
      return res.sendStatus(200);
    }

    /* ---------- ПОДТВЕРЖДЕНИЕ ПАМЯТИ ---------- */

    if (pendingMemory[userId]) {
      const lower = text.toLowerCase();

      if (lower === "да") {
        await saveMemory(userId, pendingMemory[userId].fact);
        delete pendingMemory[userId];
        await sendMessage(chatId, "Сохранено.");
        return res.sendStatus(200);
      }

      if (lower === "нет") {
        delete pendingMemory[userId];
        await sendMessage(chatId, "Не сохраняю.");
        return res.sendStatus(200);
      }
    }

    /* ---------- АНАЛИЗ ПАМЯТИ (обновлённый) ---------- */

    // НЕ анализируем память для поисковых запросов
    let analyzed = null;

    if (!text.toLowerCase().startsWith("найди")) {
      analyzed = await analyzeMemoryWithReason(text);
    }

    if (analyzed) {
      pendingMemory[userId] = analyzed;

      await sendMessage(
        chatId,
        `Обнаружен долгосрочный факт:\n${analyzed.fact}\n\n` +
        `Почему это важно:\n${analyzed.reason}\n\n` +
        `Сохранить? (да / нет)`
      );

      return res.sendStatus(200);
    }

    /* ---------- ОБЫЧНЫЙ ОТВЕТ ---------- */

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

Перед действием проверяй, есть ли реальный модуль.
Если модуля нет — скажи прямо.

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
  console.log("Kuzya agent with SerpAPI started on port", PORT);
});
