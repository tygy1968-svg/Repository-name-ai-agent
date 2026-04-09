import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

// === SUPABASE ===

async function getMemory(userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });

  const data = await res.json();
  return data.map(x => x.text).join("\n");
}

async function saveMemory(userId, text) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/memory`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([{ user_id: userId, text }])
  });

  const result = await res.text();

  console.log("SUPABASE SAVE RESPONSE:", result);

  if (!res.ok) {
    throw new Error(result);
  }
}

// === WEBHOOK ===

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text || "";
  const lower = text.toLowerCase();

  try {

    if (lower.includes("запомни")) {
      await saveMemory(userId, text);
      await sendMessage(chatId, "Сохранено в базу.");
      return res.sendStatus(200);
    }

    if (lower.includes("что ты знаешь")) {
      const memory = await getMemory(userId);
      await sendMessage(chatId, memory || "Пусто.");
      return res.sendStatus(200);
    }

    await sendMessage(chatId, "Ок.");

  } catch (err) {
    console.log("ERROR:", err.message);
    await sendMessage(chatId, "Ошибка записи: " + err.message);
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Agent started on port", PORT);
});
