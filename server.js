import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ===================== TELEGRAM =====================

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

// ===================== MEMORY =====================

async function getMemory(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&order=created_at.desc&limit=20`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const data = await res.json();

  if (!Array.isArray(data)) return "";

  return data
    .map(x => x.content)
    .filter(Boolean)
    .join("\n");
}

async function saveMemory(userId, content) {
  if (!content || content.length < 5) return;

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

// ===================== SIMPLE SAVE LOGIC =====================

function shouldSave(text) {
  const t = text.toLowerCase();

  return (
    t.includes("меня зовут") ||
    t.includes("я живу") ||
    t.includes("я работаю") ||
    t.includes("я владел") ||
    t.includes("мой бренд") ||
    t.includes("я планирую") ||
    t.includes("я буду")
  );
}

// ===================== WEBHOOK =====================

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || "";

    // 1. Получаем память ТОЛЬКО этого пользователя
    const memory = await getMemory(userId);

    // 2. Генерируем ответ
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
Ты автономный агент.

Правила:
1. Если вопрос касается фактов пользователя — сначала проверь память.
2. Если факт есть — ответь строго на основе памяти.
3. Если факта нет — скажи: "Я не знаю."

Факты пользователя:
${memory || "нет сохранённых фактов"}
`
          },
          { role: "user", content: text }
        ],
        temperature: 0.4
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Ок.";

    // 3. Отправляем ответ сразу
    await sendMessage(chatId, reply);

    // 4. Сохраняем память без GPT
    if (shouldSave(text)) {
      saveMemory(userId, text);
    }

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
