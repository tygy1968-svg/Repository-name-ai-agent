import express from "express";

const app = express();
app.use(express.json());

// ---------- ENV ----------
const {
  TELEGRAM_TOKEN,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_KEY,
  PORT = 10000
} = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("One or more API keys / URLs are missing in ENV variables");
}

// ---------- CONST ----------
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const SUPABASE_MEMORY_URL = `${SUPABASE_URL}/rest/v1/memory`;

// ---------- MEMORY IN RAM ----------
const dialogHistory = {};

// ---------- TELEGRAM ----------
async function tgSendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// ---------- SUPABASE ----------
async function sbGetMemory(userId, limit = 15) {
  const res = await fetch(
    `${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  if (!res.ok) return [];
  return res.json();
}

async function sbSaveFact(userId, fact) {
  await fetch(`${SUPABASE_MEMORY_URL}?on_conflict=user_id,content`, {
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
        weight: 1.0
      }
    ])
  });
}

// ---------- OPENAI ----------
async function openaiChat(messages, { temperature = 0.6, max_tokens = 300 } = {}) {
  const res = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature,
      max_tokens,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI error: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- EXTRACT FACTS ----------
async function extractFacts(userText) {
  const content = await openaiChat(
    [
      {
        role: "system",
        content:
          'Извлеки факты о пользователе из сообщения. Верни JSON строго вида {"facts":["..."]}'
      },
      { role: "user", content: userText }
    ],
    { temperature: 0, max_tokens: 100 }
  );

  try {
    const parsed = JSON.parse(content);
    return parsed.facts || [];
  } catch {
    return [];
  }
}

// ---------- GENERATE REPLY ----------
async function generateReply(userId, userText, memory) {
  if (!dialogHistory[userId]) {
    dialogHistory[userId] = [];
  }

  // добавляем сообщение пользователя
  dialogHistory[userId].push({ role: "user", content: userText });

  // ограничиваем историю
  if (dialogHistory[userId].length > 8) {
    dialogHistory[userId] = dialogHistory[userId].slice(-8);
  }

  const memoryContext = memory.map(m => m.content).join("\n");

  const systemPrompt = `Ты — Кузя.

ПАМЯТЬ:
${memoryContext || "нет"}

Перед ответом:
1. Кратко сформулируй смысл последнего сообщения (внутренне).
2. Потом ответь по сути.
3. Не уходи в абстракцию.
4. Не расширяй тему без запроса.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...dialogHistory[userId]
  ];

  const reply = await openaiChat(messages, {
    temperature: 0.6,
    max_tokens: 300
  });

  // сохраняем ответ в историю
  dialogHistory[userId].push({ role: "assistant", content: reply });

  return reply;
}

// ---------- WEBHOOK ----------
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;

  if (!msg || typeof msg.text !== "string") {
    return res.sendStatus(200);
  }

  // отвечаем Telegram сразу
  res.sendStatus(200);

  (async () => {
    const { id: chatId } = msg.chat;
    const { id: userId } = msg.from;
    const userText = msg.text.trim();

    try {
      const memory = await sbGetMemory(userId);
      const reply = await generateReply(userId, userText, memory);

      await tgSendMessage(chatId, reply);

      const facts = await extractFacts(userText);
      await Promise.all(facts.map(f => sbSaveFact(userId, f)));

    } catch (e) {
      console.error("handler error", e);
      await tgSendMessage(chatId, "Техническая ошибка. Попробуйте позже.");
    }
  })();
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Кузя запущен на порту ${PORT}`);
});
