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

async function vectorSearch(userId, text, limit = 3) {
  const embedding = await createEmbedding(text);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_memory`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_user_id: String(userId),
      match_count: limit
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("Vector search error: " + err);
  }

  return res.json();
}

async function sbSaveFact(userId, fact) {
  const embedding = await createEmbedding(fact);

  const response = await fetch(`${SUPABASE_MEMORY_URL}`, {
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
        weight: 1.0,
        embedding: embedding
      }
    ])
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Supabase save error:", err);
  } else {
    console.log("Saved to Supabase:", fact);
  }
}

// ---------- OPENAI ----------
async function createEmbedding(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("Embedding error: " + err);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

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

  console.log("extractFacts raw:", content);

  try {
    const parsed = JSON.parse(content);
    console.log("extractFacts parsed:", parsed);
    return parsed.facts || [];
  } catch (e) {
    console.error("extractFacts parse error:", e);
    return [];
  }
}

async function shouldKeepFact(text) {
  if (!text || text.length > 120) return false;
  if (/https?:\/\/|www\./i.test(text)) return false; // исключаем ссылки

  const verdict = await openaiChat(
    [
      {
        role: "system",
        content: `Ты — фильтр долговременной памяти ИИ.

Сохраняй (true), если это:
- имя, город, роль, предпочтения, цели, проекты, бренд, бизнес-контекст;
- информация, актуальная длительное время;
- данные, улучшающие будущие ответы.

Не сохраняй (false), если это:
- приветствия, эмоции, шутки, разовые действия;
- временные детали и ситуативные фразы;
- общие рассуждения без фактов.

Верни строго JSON:
{"keep": true}
или
{"keep": false}`
      },
      { role: "user", content: text }
    ],
    { temperature: 0, max_tokens: 20 }
  );

  console.log("shouldKeepFact raw:", verdict);

  try {
    const parsed = JSON.parse(verdict);
    console.log("shouldKeepFact parsed:", parsed);
    return parsed.keep === true;
  } catch (e) {
    console.error("shouldKeepFact parse error:", e);
    return false;
  }
}

async function saveFactIfValuable(userId, fact) {
  try {
    if (!fact || fact.length < 5 || fact.length > 120) return;
    if (/^\W*$/.test(fact)) return; // только символы/эмодзи

    const keep = await shouldKeepFact(fact);
    if (!keep) return;

    await sbSaveFact(userId, fact);
  } catch (e) {
    console.error("memory filter error", e);
  }
}

// ---------- GENERATE REPLY ----------
async function planStep(userText, memoryContext) {
  const plan = await openaiChat(
    [
      {
        role: "system",
        content: `Ты планировщик.
Определи:
1. Тип запроса (analysis / direct / emotional / strategic)
2. Нужно ли использовать память (true/false)
3. Нужно ли занять позицию (true/false)

Верни строго JSON:
{
  "type": "...",
  "needs_memory": true,
  "should_take_position": true
}`
      },
      {
        role: "user",
        content: `ПАМЯТЬ:
${memoryContext || "нет"}

СООБЩЕНИЕ:
${userText}`
      }
    ],
    { temperature: 0.2, max_tokens: 200 }
  );

  try {
    return JSON.parse(plan);
  } catch {
    return {
      type: "direct",
      needs_memory: false,
      should_take_position: false
    };
  }
}

async function strategicAnalysis(userText, memoryContext) {
  const analysis = await openaiChat(
    [
      {
        role: "system",
        content: `
Ты стратегический аналитик.
Это внутренний этап мышления.

НЕ отвечай пользователю.
Сделай структурированный анализ:

1. В чём реальный смысл запроса?
2. Какие есть ограничения?
3. Какие допущения ты вынужден сделать?
4. Чего не хватает для точности?
5. Какую рациональную позицию стоит занять?

Верни краткий, плотный анализ без воды.
`
      },
      {
        role: "user",
        content: `ПАМЯТЬ:
${memoryContext || "нет"}

СООБЩЕНИЕ:
${userText}`
      }
    ],
    { temperature: 0.3, max_tokens: 250 }
  );

  return analysis;
}

async function generateReply(userId, userText, memory) {
  if (!dialogHistory[userId]) {
    dialogHistory[userId] = [];
  }

  // фиксируем в диалоге
  dialogHistory[userId].push({ role: "user", content: userText });
  if (dialogHistory[userId].length > 8) {
    dialogHistory[userId] = dialogHistory[userId].slice(-8);
  }

  let memoryContext = "";

  // Линейная память (последние записи)
  const recentMemory = (memory || []).map(m => m.content).join("\n");

  try {
    // Семантическая (векторная) память
    const relevant = await vectorSearch(userId, userText, 3);
    const vectorMemory = relevant.map(r => r.content).join("\n");

    memoryContext = [vectorMemory, recentMemory]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    console.error("vector search failed", e);
    memoryContext = recentMemory; // fallback на обычную память
  }

  // Шаг 1 — стратегический анализ (скрытый)
  const analysis = await strategicAnalysis(userText, memoryContext);

  // Шаг 2 — генерация осмысленного ответа
  const draft = await openaiChat(
    [
      {
        role: "system",
        content: `
Ты — Кузя.

Перед тобой внутренний стратегический анализ:
${analysis}

Отвечай как думающий стратег:

- Займи позицию.
- Аргументируй её.
- Если данных недостаточно — прямо скажи.
- Не давай шаблонных списков.
- Не растягивай текст.
- Если нужно — задай 1 уточняющий вопрос.
`
      },
      ...dialogHistory[userId]
    ],
    { temperature: 0.65, max_tokens: 350 }
  );

  // сохраняем ответ в историю
  dialogHistory[userId].push({ role: "assistant", content: draft });

  return draft;
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
      await Promise.all(facts.map(f => saveFactIfValuable(userId, f)));

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
