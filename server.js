import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ===== TELEGRAM =====
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

// ===== MEMORY =====
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
        memory_type: "longterm"
      }
    ])
  });
}

// ===== PLANNER =====
async function planAction(userText, memory) {
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

Твоя задача — решить:
1) Ответить пользователю
2) Сохранить сообщение в долгосрочную память

Ответь строго JSON без объяснений:

{
  "action": "reply" | "reply_and_save",
  "reply": "текст ответа"
}

Сохраняй только если сообщение содержит:
- важный факт
- предпочтение
- решение
- план
- информацию, которая пригодится позже

Память:
${memory}
`
        },
        {
          role: "user",
          content: userText
        }
      ],
      temperature: 0.2
    })
  });

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(text);
  } catch {
    return { action: "reply", reply: text };
  }
}

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text || "";

    const memory = await getMemory();
    const decision = await planAction(text, memory);

    if (decision.action === "reply_and_save") {
      await saveMemory(userId, text);
    }

    await sendMessage(chatId, decision.reply || "Ок.");

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
