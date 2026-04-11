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
let sessionStats = {};

/* ---------- SEND ---------- */

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/* ---------- MEMORY ---------- */

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

function extractCityFromMemory(memories) {
  if (!memories || !memories.length) return null;

  const cityRegex = /город\s*:\s*([A-Za-zА-Яа-яЁёІіЇїЄєҐґ'’\-\s]+)/i;
  const liveRegex = /жив[её]т?\s+в\s+([A-Za-zА-Яа-яЁёІіЇїЄєҐґ'’\-\s]+)/i;

  for (const item of memories) {
    const text = item.content || "";

    let match = text.match(cityRegex);
    if (match) return match[1].trim().replace(/[,\.].*$/, "");

    match = text.match(liveRegex);
    if (match) return match[1].trim().replace(/[,\.].*$/, "");
  }

  return null;
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

/* ---------- INTENT ---------- */

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
Определи намерение пользователя.
Ответ строго одним словом:

search
task
emotion
memory
chat
`
        },
        { role: "user", content: text }
      ]
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim().toLowerCase() || "chat";
}

/* ---------- SEARCH ---------- */

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

    const message = update.message;
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = (message.text || "").trim();

    if (!text) return res.sendStatus(200);

    const intent = await detectIntent(text);

    const memories = await getMemory(userId);
    const userCity = extractCityFromMemory(memories);

    /* ---------- SEARCH ---------- */

    if (intent === "search") {

      let searchQuery = text;

      const cityMentioned = /(киев|києв|kyiv|львов|львів|lviv|одесса|одеса|odesa|харьков|харків|kharkiv|днепр|dnipro)/i.test(text);

      if (!cityMentioned && userCity) {
        searchQuery = `${text} ${userCity}`;
      }

      const results = await searchPlaces(searchQuery);

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

    /* ---------- NORMAL RESPONSE ---------- */

    const factsText = memories.map(x => x.content).join("\n");

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
            content: `Ты — Кузя`
          },
          { role: "user", content: text }
        ]
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Ошибка";

    await sendMessage(chatId, reply);
    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

app.listen(3000);
