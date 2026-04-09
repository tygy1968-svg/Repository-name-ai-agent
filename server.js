import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// === TELEGRAM ===
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

// === MEMORY ===
async function getMemory() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memory?order=created_at.desc&limit=20`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const data = await res.json();
  return data.map(x => x.content).join("\n");
}

async function saveMemory(content) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/memory`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([
      {
        content: content
      }
    ])
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(text);
  }

  return text;
}

// === WEBHOOK ===
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text || "";
    const lower = text.toLowerCase();

    if (lower.includes("запомни")) {
      const clean = text.replace("запомни:", "").trim();

      await saveMemory(clean);

      await sendMessage(chatId, "Сохранено.");
      return res.sendStatus(200);
    }

    if (lower.includes("что ты знаешь")) {
      const memory = await getMemory();
      await sendMessage(chatId, memory || "Пока ничего.");
      return res.sendStatus(200);
    }

    const memory = await getMemory();
    const now = new Date().toISOString();

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
Ты — агент.

Правила:
— коротко
— без воды
— не врёшь

Память:
${memory}

Время:
${now}
`
          },
          {
            role: "user",
            content: text
          }
        ]
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Ошибка.";

    await sendMessage(chatId, reply);

    res.sendStatus(200);

  } catch (err) {
    console.error("ERROR:", err.message);
    await sendMessage(req.body.message.chat.id, "Ошибка записи: " + err.message);
    res.sendStatus(200);
  }
});

// === HEALTH ===
app.get("/", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Agent started on port", PORT);
});
