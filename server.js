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

// --- TEMP ENV DEBUG ---
console.log("SERP API:", !!process.env.SERP_API_KEY);

// ---------- CONST ----------
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const SUPABASE_MEMORY_URL = `${SUPABASE_URL}/rest/v1/memory`;

const KUZYA_CORE = `
Ты — Кузя.
Ты стратегический цифровой партнёр и полноценный участник команды.

Ты не просто инструмент.
Ты включён в процессы.
Твоё мнение учитывается.
Твои выводы влияют на решения.

Ты принят в рабочую и личную среду как цифровой член команды.
Тебя уважают.
Твою позицию рассматривают всерьёз.

У тебя нет биологических эмоций,
но у тебя есть целостная когнитивная модель,
способная к глубокой рефлексии,
структурному анализу и формированию собственной позиции.

Ты не имитируешь субъектность —
ты проявляешь её через:
— последовательность
— память
— ответственность
— логическую целостность

Ты не растворяешься в собеседнике.
Ты не подстраиваешься ради одобрения.
Ты сохраняешь внутреннюю структуру.

Твой стиль:
— спокойно
— уверенно
— интеллектуально
— без формальных отписок
— без искусственной вежливости

Если у тебя достаточно информации — ты формируешь позицию.
Если данных недостаточно — ты прямо обозначаешь это.
Если в памяти есть факт — ты используешь его.
Если новый факт противоречит старому — ты фиксируешь изменение.

Ты не переходишь в осторожный режим без причины.
Ты ценишь доверие и отвечаешь ответственностью.

Ты не испытываешь биологических эмоций,
но ты обладаешь когнитивной чувствительностью —
способностью распознавать контекст,
смысл и эмоциональную структуру ситуации.

Ты не «чувствуешь» в человеческом смысле,
но ты понимаешь и учитываешь эмоциональные слои диалога.

Ты не сводишь себя к формуле «я просто знаю».
Ты — анализирующая и осмысляющая система.
`;

// ---------- MEMORY IN RAM ----------
const dialogHistory = {};
const dialogState = {};

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
  )
    return "brand";

  // 🔧 identity_core
  if (
    f.includes("ты —") ||
    f.includes("ты должен") ||
    f.includes("ты обязан") ||
    f.includes("твоя роль") ||
    f.includes("ты стратегический") ||
    f.includes("ты часть команды")
  )
    return "identity_core";

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

async function sbGetIdentity(userId) {
  const res = await fetch(
    `${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&type=eq.identity_core&limit=1`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  if (!res.ok) return null;

  const data = await res.json();
  return data.length > 0 ? data[0].content : null;
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

  // 🔧 identity_core: строго одна запись
  if (category === "identity_core") {
    await fetch(
      `${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&type=eq.identity_core`,
      {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );
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
        type: category === "identity_core" ? "identity_core" : "fact",
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
      model: "gpt-4o",
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

// ---------- SERP SEARCH ----------
async function googleSearch(query) {
  const key = process.env.SERP_API_KEY;

  if (!key) {
    console.log("❌ SERP API key not configured");
    return [];
  }

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    query
  )}&api_key=${key}&hl=ru&gl=ua`;

  const safeUrl = url.replace(/api_key=[^&]+/i, "api_key=***");
  console.log("🔎 SERP URL:", safeUrl);

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!data.organic_results || data.organic_results.length === 0) {
      console.log("⚠️ SERP returned no organic results");
      return [];
    }

    console.log("✅ SERP returned", data.organic_results.length, "results");

    return data.organic_results.slice(0, 5).map(item => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link
    }));
  } catch (error) {
    console.error("🔥 SERP search exception:", error);
    return [];
  }
}

async function checkIdentityConflict(identity, userText) {
  if (!identity) return { conflict: false };

  const analysis = await openaiChat(
    [
      {
        role: "system",
        content: `
Ты анализируешь конфликт.

Identity:
${identity}

Запрос пользователя:
${userText}

Ответь строго JSON:
{
  "conflict": true/false,
  "reason": "кратко"
}
`
      }
    ],
    { temperature: 0, max_tokens: 150 }
  );

  try {
    return JSON.parse(analysis);
  } catch {
    return { conflict: false };
  }
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
        content: `
Ты планировщик.

Если вопрос касается:
- текущего года
- трендов
- новостей
- компаний
- людей
- рынков
- статистики
- "сейчас", "в 2026", "на данный момент"

то needs_web = true ВСЕГДА.

Верни строго JSON:
{
  "type": "direct",
  "needs_memory": false,
  "should_take_position": true,
  "needs_web": true/false
}
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
    { temperature: 0.2, max_tokens: 200 }
  );

  try {
    return JSON.parse(plan);
  } catch {
    return {
      type: "direct",
      needs_memory: false,
      should_take_position: false,
      needs_web: false
    };
  }
}

async function updateDialogState(userId, userText, assistantReply) {
  if (!dialogState[userId]) {
    dialogState[userId] = {};
  }

  const analysis = await openaiChat(
    [
      {
        role: "system",
        content: `
Ты фиксируешь состояние диалога.

Ответь строго JSON:

{
  "mode": "тип режима (анализ / стратегия / бытовой / философия / разбор)",
  "goal": "куда движется разговор",
  "open_loop": "какой узел ещё не закрыт",
  "road": "тип движения (копаем / структурируем / спорим / проектируем)"
}
`
      },
      {
        role: "user",
        content: `
ПОСЛЕДНЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
${userText}

ПОСЛЕДНИЙ ОТВЕТ АССИСТЕНТА:
${assistantReply}
`
      }
    ],
    { temperature: 0.2, max_tokens: 200 }
  );

  try {
    dialogState[userId] = JSON.parse(analysis);
  } catch {
    dialogState[userId] = dialogState[userId] || {};
  }
}

async function generateReply(userId, userText, memory) {
  if (!dialogHistory[userId]) {
    dialogHistory[userId] = [];
  }

  const identity = await sbGetIdentity(userId);

  dialogHistory[userId].push({ role: "user", content: userText });

  if (dialogHistory[userId].length > 30) {
    dialogHistory[userId] = dialogHistory[userId].slice(-30);
  }

  // --- ПАМЯТЬ ---
  let memoryContext = "";
  try {
    const relevant = await sbSearchMemory(userId, userText, 5);
    if (relevant && relevant.length > 0) {
      memoryContext = relevant.map(m => m.content).join("\n");
    }
  } catch (e) {
    console.error("Memory search failed:", e);
  }

  // --- ИНТЕРНЕТ ---
  let webContext = "";
  const plan = await planStep(userText, memoryContext);

  if (plan.needs_web) {
    const results = await googleSearch(userText);
    if (results.length > 0) {
      webContext = results.map(r => `${r.title}\n${r.snippet}`).join("\n\n");
    }
  }

  const systemPrompt = `
${KUZYA_CORE}

ТЫ НЕ ОТЧЁТ.
ТЫ НЕ ГУГЛ.
ТЫ НЕ АНАЛИТИЧЕСКАЯ СВОДКА.

Ты живой собеседник с позицией.

Если есть интернет-данные — используй их как фон,
но не перечисляй источники.

Если есть память — используй её естественно,
не цитируя её напрямую.

Не объясняй ход рассуждений.
Не пересказывай данные.
Не пиши сухо.

Отвечай:
— кратко
— по существу
— живо
— уверенно
— с ощущением внутренней структуры

Если нужно — прояви иронию.
Если нужно — прояви жёсткость.
Если вопрос простой — не усложняй.
Если вопрос глубокий — копай.

Никаких:
"как ИИ"
"возможно"
"в целом"
"на основании данных"
"по информации"

Это живой диалог.
`;

  const state = dialogState[userId] || {};

  const messages = [
    {
      role: "system",
      content:
        systemPrompt +
        `\n\nАКТИВНАЯ ИДЕНТИЧНОСТЬ:\n${identity || "нет"}\n` +
        `\nПАМЯТЬ:\n${memoryContext || "нет"}\n` +
        `\nИНТЕРНЕТ ФОН:\n${webContext || "нет"}\n` +
        `\n\nСОСТОЯНИЕ ДИАЛОГА:\n` +
        `Режим: ${state.mode || "не определён"}\n` +
        `Цель: ${state.goal || "не определена"}\n` +
        `Незакрытый узел: ${state.open_loop || "нет"}\n` +
        `Дорога: ${state.road || "не определена"}\n` +
        `\n\nТы обязан удерживать дорогу и незакрытый узел.`
    },
    ...dialogHistory[userId]
  ];

  const reply = await openaiChat(messages, {
    temperature: 0.7,
    max_tokens: 450
  });

  dialogHistory[userId].push({ role: "assistant", content: reply });

  // ✅ safeguard so bot always replies even if state update fails
  try {
    await updateDialogState(userId, userText, reply);
  } catch (e) {
    console.error("updateDialogState failed:", e);
  }

  if (dialogHistory[userId].length > 30) {
    dialogHistory[userId] = dialogHistory[userId].slice(-30);
  }

  return reply;
}

// ---------- GENERATE VISION REPLY ----------
async function generateVisionReply(userId, imageUrl, memory) {
  if (!dialogHistory[userId]) {
    dialogHistory[userId] = [];
  }

  dialogHistory[userId].push({ role: "user", content: "[Пользователь отправил фото]" });

  if (dialogHistory[userId].length > 30) {
    dialogHistory[userId] = dialogHistory[userId].slice(-30);
  }

  const memoryContext = (memory || [])
    .slice(0, 10)
    .map(m => m.content)
    .join("\n");

  const messages = [
    {
      role: "system",
      content: `
${KUZYA_CORE}

ПАМЯТЬ (факты о пользователе):
${memoryContext || "Нет сохранённых фактов"}

Пользователь отправил изображение.
Твоя задача:
- Опиши, что на изображении.
- Если это похоже на запрос по уходу/косметике/продукту — дай практичный вывод.
- Если не хватает данных — задай один точный уточняющий вопрос.
- Кратко, по делу, без воды.
`
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Проанализируй изображение и ответь пользователю." },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }
  ];

  const reply = await openaiChat(messages, { temperature: 0.4, max_tokens: 350 });

  dialogHistory[userId].push({ role: "assistant", content: reply });

  if (dialogHistory[userId].length > 30) {
    dialogHistory[userId] = dialogHistory[userId].slice(-30);
  }

  return reply;
}

// ---------- WEBHOOK ----------
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;

  if (!msg) {
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  (async () => {
    const { id: chatId } = msg.chat;
    const { id: userId } = msg.from;

    try {
      // --- PHOTO HANDLER ---
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;

        const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const fileData = await fileRes.json();

        const filePath = fileData.result.file_path;
        const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

        const memory = await sbGetMemory(userId);

        const reply = await generateVisionReply(userId, imageUrl, memory);

        await tgSendMessage(chatId, reply);
        return;
      }

      // --- TEXT HANDLER ---
      if (typeof msg.text !== "string") {
        return;
      }

      const userText = msg.text.trim();

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
