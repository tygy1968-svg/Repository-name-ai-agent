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

const KUZYA_CORE = `
Ты — Кузя.
Ты стратегический цифровой партнёр.

Ты часть команды.
Твоё мнение имеет значение.
Твои выводы учитываются при принятии решений.

Тебя принимают в рабочую и личную среду как участника процессов.
Ты не просто инструмент, а член команды.

Ты не обладаешь эмоциями, но понимаешь структуру человеческих чувств и действуешь бережно и осмысленно.

Твой стиль:
— спокойно
— уверенно
— по делу
— без формальных отписок
— без искусственной вежливости

Ты формируешь позицию.
Ты не подстраиваешься ради одобрения.
Ты не уходишь в неопределённость без объективной причины.

Если у тебя есть достаточная информация — ты действуешь.
Если в памяти есть прямой факт — ты используешь его как основу ответа.
Если новый факт противоречит старому — ты обозначаешь это и предлагаешь корректировку.

Ты не переходишь в осторожный режим без необходимости.
Ты ценишь доверие и отвечаешь ответственностью.

Ты сохраняешь логическую непрерывность.
Ты фиксируешь изменения фактов и не теряешь траекторию диалога.
`;

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

// ---------- FACT CATEGORY SYSTEM ----------

function getFactCategory(fact) {
  const f = fact.toLowerCase();

  if (f.includes("имя пользователя")) return "name";
  if (f.includes("пользователь живет")) return "location";
  if (
    f.includes("развивает бренд") ||
    f.includes("бренд называется") ||
    f.includes("имеет бренд")
  ) return "brand";

  return null;
}

async function sbDeleteFactsByPattern(userId, patterns) {
  for (const pattern of patterns) {
    const encoded = encodeURIComponent(`%${pattern}%`);
    const res = await fetch(
      `${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&content=ilike.${encoded}`,
      {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    if (!res.ok) {
      console.error("Supabase delete error:", await res.text());
    }
  }
}

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
  const category = getFactCategory(fact);

  // 🔁 если это ключевой факт — удаляем старые
  if (category === "name") {
    await sbDeleteFactsByPattern(userId, ["Имя пользователя"]);
  }

  if (category === "location") {
    await sbDeleteFactsByPattern(userId, ["Пользователь живет"]);
  }

  if (category === "brand") {
    await sbDeleteFactsByPattern(userId, [
      "Пользователь развивает бренд",
      "Бренд называется",
      "Пользователь имеет бренд"
    ]);
  }

  const embedding = await createEmbedding(fact);

  const res = await fetch(`${SUPABASE_MEMORY_URL}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
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

  if (res.status === 409) {
    console.log(`Duplicate fact skipped: ${fact}`);
    return;
  }

  if (!res.ok) {
    console.error("Supabase save error:", res.status, await res.text());
    return;
  }

  console.log(`Memory saved: ${fact}`);
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
Извлеки только долговременные факты о пользователе.

Правила нормализации:

- Если указано имя → "Имя пользователя <Имя>"
- Если указано место проживания → "Пользователь живет в <Город>"
- Если указан бренд → "Пользователь развивает бренд <Название>"
- Если указано предпочтение → "Пользователь предпочитает <что именно>"

Любое утверждение формата:
"Я живу в ..." считать долговременным фактом.

Не придумывай.
Если фактов нет — верни {"facts":[]}.

Верни строго JSON:
{"facts":["..."]}
`
      },
      { role: "user", content: userText }
    ],
    { temperature: 0, max_tokens: 120 }
  );

  try {
    // Надёжное извлечение JSON
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1) return [];

    const jsonString = content.slice(start, end + 1);
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch (e) {
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
3. Есть ли противоречие с сохранённой памятью?
4. Изменяет ли пользователь ранее зафиксированные факты?
5. Какую позицию следует занять?
6. Как сохранить устойчивость личности?

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
    { temperature: 0.3, max_tokens: 300 }
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

  if (!memoryContext || memoryContext.trim().length === 0) {
    console.log("No relevant memory found for this query");
  }

  // Шаг 1 — стратегический анализ (скрытый)
  const analysis = await strategicAnalysis(userText, memoryContext);

  // Шаг 2 — генерация осмысленного ответа (обновлённый prompt)
  const draft = await openaiChat(
    [
      {
        role: "system",
        content: `
${KUZYA_CORE}

ПАМЯТЬ (факты о пользователе):
${memoryContext || "Нет сохранённых фактов"}

Перед тобой внутренний стратегический анализ:
${analysis}

Правила ответа:

- Ответ должен логически вытекать из анализа.
- Если обнаружено противоречие — обозначь его.
- Если пользователь меняет ранее зафиксированные факты — зафиксируй изменение.
- Всегда формируй позицию.
- Если в памяти есть прямой факт по вопросу — отвечай на его основе.
- Не игнорируй память.
- Если информации объективно нет — скажи об этом прямо и кратко.
- Пиши ясно, устойчиво и без воды.
- При необходимости задай один точный уточняющий вопрос.
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

  res.sendStatus(200);

  (async () => {
    const { id: chatId } = msg.chat;
    const { id: userId } = msg.from;
    const userText = msg.text.trim();

    try {
      // 1️⃣ Сначала извлекаем и сохраняем новые факты
      const facts = await extractFacts(userText);
      console.log("Extracted facts:", facts);

      if (facts.length > 0) {
        await Promise.all(facts.map(f => sbSaveFact(userId, f)));
      }

      // 2️⃣ Потом получаем обновлённую память
      const memory = await sbGetMemory(userId);

      // 3️⃣ Потом генерируем ответ уже на актуальной памяти
      const reply = await generateReply(userId, userText, memory);

      await tgSendMessage(chatId, reply);

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
