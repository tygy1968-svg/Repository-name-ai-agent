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
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function getFullMemory(userId) {
  try {
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

  } catch (e) {
    console.error("getFullMemory error:", e);
    return [];
  }
}

async function saveDialog(userId, userMsg, botReply) {
  try {
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
          role: "interaction",
          type: "dialog",
          content: `Пользователь: ${userMsg}\nКузя: ${botReply}`
        }
      ])
    });
  } catch (e) {
    console.error("saveDialog error:", e);
  }
}

async function saveMemory(userId, fact) {
  try {
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
          role: "system",
          type: "fact",
          content: fact,
          weight: 0.9
        }
      ])
    });
  } catch (e) {
    console.error("saveMemory error:", e);
  }
}

async function extractFacts(text) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 100,
        messages: [
          {
            role: "system",
            content: `Извлеки факты о пользователе. JSON: { "facts": ["..."] }`
          },
          { role: "user", content: text }
        ]
      })
    });

    const data = await res.json();
    try {
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
      return parsed.facts || [];
    } catch {
      return [];
    }
  } catch (e) {
    console.error("extractFacts error:", e);
    return [];
  }
}

async function generateResponse(userId, userText, memory) {
  try {
    const memoryContext = memory
      .slice(0, 15)
      .map(m => m.content)
      .join("\n");

    const systemPrompt = `Ты — Кузя.

ПАМЯТЬ:
${memoryContext || "нет"}

Используй память для контекста. Отвечай прямо.`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.85,
        max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ]
      })
    });

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || "Ошибка";

    return reply;
  } catch (e) {
    console.error("generateResponse error:", e);
    return "Ошибка";
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || "";

    const memory = await getFullMemory(userId);
    const reply = await generateResponse(userId, text, memory);

    await sendMessage(chatId, reply);
    await saveDialog(userId, text, reply);

    const facts = await extractFacts(text);
    for (const fact of facts) {
      await saveMemory(userId, fact);
    }

    res.sendStatus(200);

  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(200);
  }
});

app.listen(10000, () => {
  console.log("Кузя работает");
});
