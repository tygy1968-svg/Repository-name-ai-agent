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
  try {
    console.log("Saving fact:", fact);

    const embedding = await createEmbedding(fact);

    const res = await fetch(`${SUPABASE_MEMORY_URL}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=ignore-duplicates"
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

    if (!res.ok) {
      const errorText = await res.text();
      console.error("Supabase save error:", res.status, errorText);
    } else {
      const data = await res.json();
      if (data.length > 0) {
        console.log("Memory saved:", data[0].content);
      } else {
        console.log("Memory already exists (duplicate skipped):", fact);
      }
    }
  } catch (error) {
    console.error("sbSaveFact exception:", error);
  }
}

async function sbSearchMemory(userId, queryText, k = 5) {
  const queryEmbedding = await createEmbedding(queryText);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_memory`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: k,
      p_user_id: String(userId)
    })
  });

  if (!res.ok) {
    console.error("vector search error:", await res.text());
    return [];
  }

  return res.json();
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
        content: `
Извлеки ТОЛЬКО важные и долговременные факты о пользователе.

Сохраняй:
- имя
- город/страну
- название бренда, бизнеса или проекта
- род деятельности
- устойчивые предпочтения (например, "обращаться на ты")

НЕ сохраняй:
- временные состояния и эмоции
- самооценки и случайные фразы
- предположения ("не указал", "возможно", "кажется")
- общие формулировки вроде "пользователь интересуется..."

Формулируй факты кратко, чётко и утвердительно.

Верни строго JSON:
{"facts":["..."]}

Если важных фактов нет, верни:
{"facts":[]}
`
      },
      { role: "user", content: userText }
    ],
    { temperature: 0, max_tokens: 150 }
  );

  try {
    const parsed = JSON.parse(content);
    return parsed.facts || [];
  } catch {
    console.error("Fact parse error:", content);
    return [];
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

  // --- NEW MEMORY LOGIC (as requested) ---
  let memoryContext = "";

  // Краткий превью последних фактов для планировщика
  const recentMemoryPreview = (memory || [])
    .slice(0, 5)
    .map(m => m.content)
    .join("\n");

  // Планирование (влияет на стиль ответа, но не блокирует память)
  const plan = await planStep(userText, recentMemoryPreview);

  // Векторный поиск памяти выполняем ВСЕГДА
  let relevant = [];
  try {
    relevant = await sbSearchMemory(userId, userText, 5);
  } catch (e) {
    console.error("Memory search failed:", e);
  }

  // Если векторный поиск ничего не дал — используем последние факты
  if (relevant && relevant.length > 0) {
    memoryContext = relevant.map(m => m.content).join("\n");
  } else {
    memoryContext = recentMemoryPreview;
  }

  console.log("Memory context used:", memoryContext);
  // --- END NEW MEMORY LOGIC ---

  // Шаг 1 — стратегический анализ (скрытый)
  const analysis = await strategicAnalysis(userText, memoryContext);

  // Шаг 2 — генерация осмысленного ответа (with memoryContext in system prompt)
  const draft = await openaiChat(
    [
      {
        role: "system",
        content: `
Ты — Кузя, умный персональный ассистент с долговременной памятью.

ФАКТЫ О ПОЛЬЗОВАТЕЛЕ:
${memoryContext || "Нет сохранённых фактов"}

Перед тобой внутренний стратегический анализ:
${analysis}

Используй факты о пользователе, если они релевантны вопросу.
Если факт прямо отвечает на вопрос — отвечай уверенно, без лишних уточнений.

Стиль ответа:
- Займи позицию.
- Аргументируй кратко и по делу.
- Если данных действительно нет — скажи об этом честно.
- Без шаблонных фраз и лишней воды.
- При необходимости задай 1 уточняющий вопрос.
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
      console.log("Extracted facts:", facts);

      if (facts.length === 0) {
        console.log("No facts extracted from message:", userText);
      } else {
        await Promise.all(facts.map(f => sbSaveFact(userId, f)));
      }

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
