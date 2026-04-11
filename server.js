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

/* ---------- SEND MESSAGE ---------- */

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

/* ---------- CITY ---------- */

function extractCityFromMemory(memories) {
  if (!memories || !memories.length) return null;

  for (let i = 0; i < memories.length; i++) {
    const text = memories[i].content || "";

    const cityMatch = text.match(
      /город\s*:\s*([A-Za-zА-Яа-яЁёІіЇїЄєҐґ'’\-\s]+)/i
    );

    if (cityMatch) {
      return cityMatch[1].trim().replace(/[,\.].*$/, "");
    }

    const liveMatch = text.match(
      /жив[её]т?\s+в\s+([A-Za-zА-Яа-яЁёІіЇїЄєҐґ'’\-\s]+)/i
    );

    if (liveMatch) {
      return liveMatch[1].trim().replace(/[,\.].*$/, "");
    }
  }

  return null;
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

/* ---------- RHYTHM ---------- */

function checkDialogueRhythm(userId) {
  const now = new Date();

  if (!sessionStats[userId]) {
    sessionStats[userId] = {
      startTime: now,
      messageCount: 0,
      pauseSuggested: false
    };
  }

  const session = sessionStats[userId];
  session.messageCount++;

  const minutesActive =
    (now - new Date(session.startTime)) / 1000 / 60;

  const hour = now.getHours();

  const lateNight = hour >= 1 && hour <= 4;
  const longSession = session.messageCount > 12;
  const longDuration = minutesActive > 20;

  if (
    lateNight &&
    longSession &&
    longDuration &&
    !session.pauseSuggested &&
    Math.random() < 0.2
  ) {
    session.pauseSuggested = true;
    return true;
  }

  return false;
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

    const intent = await detectIntent(text);

    const memories = await getMemory(userId);
    const userCity = extractCityFromMemory(memories);

    /* ---------- SEARCH ---------- */

    if (intent === "search") {

      // 🔥 УЛУЧШЕННАЯ ЛОГИКА РАЙОНА
      const nearMentioned = /(рядом|поблизости|возле|near)/i.test(text);

      const districtMentioned = /(подол|центр|оболонь|печерск|левый берег|правый берег|шевченковский|голосеевский)/i.test(text);

      if (nearMentioned && !districtMentioned) {
        await sendMessage(chatId, "В каком районе тебе удобнее?");
        return res.sendStatus(200);
      }

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

    /* ---------- MEMORY ANALYSIS ---------- */

    let analyzed = null;

    if (intent !== "search") {
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

    /* ---------- CHAT ---------- */

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
            content: `Ты — Кузя, гибридный агент Юли.

Говори естественно.
Мысли структурно.
Предлагай следующий шаг.`
          },
          { role: "user", content: text }
        ]
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Ошибка.";

    if (checkDialogueRhythm(userId)) {
      await sendMessage(chatId, "Похоже, ты давно в работе. Может сделать паузу?");
    }

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
  console.log("Kuzya agent FINAL started");
});
