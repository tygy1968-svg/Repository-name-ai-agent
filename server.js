import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ===== отправка =====
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

// ===== ПАМЯТЬ =====

// читаем
async function getMemory(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/kuzia_memory?user_id=eq.${userId}&order=timestamp.desc&limit=20`,
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

// сохраняем
async function saveMemory(userId, text) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kuzia_memory`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([
      {
        user_id: userId,
        content: text,
        importance: 1
      }
    ])
  });

  const result = await res.text();

  if (!res.ok) {
    console.log("SUPABASE ERROR:", result);
    throw new Error(result);
  }
}

// ===== WEBHOOK =====

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = message.text || "";
  const lower = text.toLowerCase();

  try {

    // ===== команды =====

    if (lower.includes("запомни")) {
      await saveMemory(userId, text);
      await sendMessage(chatId, "Сохранено.");
      return res.sendStatus(200);
    }

    if (lower.includes("что ты знаешь")) {
      const memory = await getMemory(userId);
      await sendMessage(chatId, memory || "Пусто.");
      return res.sendStatus(200);
    }

    if (lower.includes("скучно")) {
      await sendMessage(chatId, "Действие: возьми предмет рядом и придумай ему новую функцию. 20 секунд.");
      return res.sendStatus(200);
    }

    // ===== память =====

    const memory = await getMemory(userId);
    const now = new Date().toISOString();

    // ===== ответ =====

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

— не врёшь
— не выдумываешь действия
— коротко
— по делу

Контекст:
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

    // сохраняем диалог
    await saveMemory(userId, `user: ${text}`);
    await saveMemory(userId, `agent: ${reply}`);

    await sendMessage(chatId, reply);

  } catch (err) {
    console.log("ERROR:", err.message);
    await sendMessage(chatId, "Ошибка: " + err.message);
  }

  res.sendStatus(200);
});

// ===== тест =====
app.get("/", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Agent started on port", PORT);
});
