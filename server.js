import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/* ===================== SEND ===================== */

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/* ===================== GET MEMORY ===================== */

async function getFullMemory(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/memory?user_id=eq.${userId}&order=weight.desc.nullslast,created_at.desc&limit=50`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.filter(m => !m.type || m.type === "fact");
  } catch (e) {
    console.error("getFullMemory error:", e);
    return [];
  }
}

/* ===================== SAVE DIALOG ===================== */

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

/* ===================== SAVE FACT ===================== */

async function saveMemory(userId, fact) {
  try {
    // проверка на дубли
    const existing = await getFullMemory(userId);
    if (existing.some(m => m.content === fact)) return;

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

/* ===================== EXTRACT FACTS ===================== */

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
        messages: [
          {
            role: "system",
            content: `Верни JSON:
{ "facts": ["..."] }
Если нет фактов → []`
          },
          { role: "user", content: text }
        ]
      })
    });

    const raw = (await res.json()).choices?.[0]?.message?.content || "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.facts || [];

  } catch {
    return [];
  }
}

/* ===================== GENERATE ===================== */

async function generateResponse(userId, userText, memory) {
  try {
    const memoryContext = memory
      .slice(0, 10)
      .map(m => m.content)
      .join("\n");

    // ищем имя
    const nameRecord = memory.find(m => m.content.toLowerCase().includes("имя"));
    const userName = nameRecord ? nameRecord.content.split(":")[1]?.trim() : null;

    const systemPrompt = `Ты — Кузя.

ПАМЯТЬ:
${memoryContext || "нет"}

ПРАВИЛА:
- если знаешь имя → используй его
- не игнорируй факты
- отвечай прямо`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.8,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ]
      })
    });

    let reply = (await res.json()).choices?.[0]?.message?.content || "Ошибка";

    // усиливаем имя
    if (userName && !reply.includes(userName)) {
      reply = `${userName}, ${reply}`;
    }

    return reply;

  } catch {
    return "Ошибка";
  }
}

/* ===================== WEBHOOK ===================== */

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
