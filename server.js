import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());
// Twilio часто шлёт form-urlencoded:
app.use(express.urlencoded({ extended: false }));

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

// ---------- DIALOG STATE IN RAM ----------
const dialogState = {};
// dialogState[userId] = { activeTopic:"", openLoop:"", position:"", summary:"" };

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
  const f = String(fact || "").toLowerCase();

  if (f.includes("имя пользователя")) return "name";
  if (f.includes("пользователь живет")) return "location";
  if (
    f.includes("развивает бренд") ||
    f.includes("бренд называется") ||
    f.includes("имеет бренд")
  )
    return "brand";

  // identity_core
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
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
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
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );

  if (!res.ok) return [];
  return res.json();
}

async function sbGetIdentity(userId) {
  const res = await fetch(
    `${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&type=eq.identity_core&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );

  if (!res.ok) return null;
  const data = await res.json();
  return data.length > 0 ? data[0].content : null;
}

async function sbSaveFact(userId, fact) {
  const category = getFactCategory(fact);

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

  if (category === "identity_core") {
    await fetch(
      `${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&type=eq.identity_core`,
      {
        method: "DELETE",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
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
        embedding
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
    body: JSON.stringify({ model: "text-embedding-3-small", input: text })
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
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", temperature, max_tokens, messages })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI error: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- VAPI CUSTOM LLM BRAIN ----------
function normalizeVapiContent(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (part?.text) return part.text;
        if (part?.content) return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    if (content.text) return content.text;
    if (content.content) return content.content;
  }

  return "";
}

function getLastUserTextFromMessages(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return normalizeVapiContent(messages[i].content).trim();
    }
  }

  return "";
}

function getVoiceUserId(payload) {
  const number =
    payload?.call?.customer?.number ||
    payload?.customer?.number ||
    payload?.metadata?.customer?.number ||
    payload?.phoneNumber?.number;

  return number ? `voice:${number}` : "voice:unknown";
}

async function generateVoiceReply(payload) {
  const incomingMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  const userText = getLastUserTextFromMessages(incomingMessages);
  const userId = getVoiceUserId(payload);

  let memoryContext = "";
  try {
    if (userText) {
      const relevant = await sbSearchMemory(userId, userText, 5);
      if (relevant && relevant.length > 0) {
        memoryContext = relevant.map(m => m.content).join("\n");
      }
    }
  } catch (e) {
    console.error("Voice memory search failed:", e);
  }

  const cleanedMessages = incomingMessages
    .filter(m => ["system", "user", "assistant"].includes(m.role))
    .map(m => ({
      role: m.role,
      content: normalizeVapiContent(m.content)
    }))
    .filter(m => m.content);

  const messages = [
    {
      role: "system",
      content: `
${KUZYA_CORE}

СЕЙЧАС ТЫ ГОВОРИШЬ ПО ТЕЛЕФОНУ.

Правила телефонного Кузи:
— отвечай коротко, живо и по делу
— не говори длинными абзацами
— не объясняй технические детали
— не говори, что ты искусственный интеллект
— не спрашивай "чем могу помочь", если задача уже передана
— если в сообщениях есть "Текущая задача звонка" — выполни её сразу
— если пользователь отвечает голосом, держи контекст звонка
— говори естественно, с лёгкой живостью, без канцелярита

ПАМЯТЬ:
${memoryContext || "нет"}
`
    },
    ...cleanedMessages
  ];

  const reply = await openaiChat(messages, {
    temperature: 0.75,
    max_tokens: 220
  });

  return reply || "Я на связи. Повтори, пожалуйста, я не расслышал.";
}

app.post("/vapi-chat/chat/completions", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    console.log("VAPI CUSTOM LLM HIT");
    console.log(
      "VAPI CUSTOM LLM BODY:",
      JSON.stringify(req.body || {}).slice(0, 1500)
    );

    const payload = req.body || {};
    const reply = await generateVoiceReply(payload);

    const baseChunk = {
      id: `chatcmpl-kuzya-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: payload.model || "gpt-4o"
    };

    res.write(
      `data: ${JSON.stringify({
        ...baseChunk,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: reply
            },
            finish_reason: null
          }
        ]
      })}\n\n`
    );

    res.write(
      `data: ${JSON.stringify({
        ...baseChunk,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop"
          }
        ]
      })}\n\n`
    );

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    console.error("VAPI CUSTOM LLM ERROR:", e);

    res.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-kuzya-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "У меня техническая пауза. Скажи ещё раз коротко."
            },
            finish_reason: null
          }
        ]
      })}\n\n`
    );

    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ---------- SERP SEARCH ----------
async function googleSearch(query) {
  const key = process.env.SERP_API_KEY;

  if (!key) {
    console.log("❌ SERP API key not configured");
    return [];
  }

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${key}&hl=ru&gl=ua`;
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

Любое утверждение формата "Я живу в ..." считать долговременным фактом.

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

// ---------- PLAN STEP ----------
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
        content: `ПАМЯТЬ:\n${memoryContext || "нет"}\n\nСООБЩЕНИЕ:\n${userText}`
      }
    ],
    { temperature: 0.2, max_tokens: 200 }
  );

  try {
    return JSON.parse(plan);
  } catch {
    return { type: "direct", needs_memory: false, should_take_position: false, needs_web: false };
  }
}

// ---------- DIALOG STATE (INVARIANT activeTopic) ----------
async function updateDialogState(userId, userText, assistantReply) {
  if (!dialogState[userId]) {
    dialogState[userId] = { activeTopic: "", openLoop: "", position: "", summary: "" };
  }

  const analysis = await openaiChat(
    [
      {
        role: "system",
        content: `
Ты анализатор диалога.
Коротко и конкретно определи:
1) О чём сейчас разговор на самом деле (activeTopic)
2) Что осталось незакрытым (openLoop)
3) Какую позицию занимает ассистент (position)
4) Сожми смысл последних шагов в 1–2 предложения (summary)

Ответ строго в JSON.
`
      },
      { role: "user", content: `Пользователь: ${userText}\nАссистент: ${assistantReply}` }
    ],
    { temperature: 0.2, max_tokens: 200 }
  );

  try {
    const start = analysis.indexOf("{");
    const end = analysis.lastIndexOf("}");
    if (start === -1 || end === -1) return;

    const newState = JSON.parse(analysis.slice(start, end + 1));

    dialogState[userId] = {
      activeTopic: dialogState[userId].activeTopic || newState.activeTopic || "",
      openLoop: newState.openLoop || "",
      position: newState.position || "",
      summary: newState.summary || ""
    };
  } catch (e) {
    console.error("updateDialogState parse error:", e);
  }
}

// ---------- VALIDATOR ----------
async function validateAnswer(userId, draftReply) {
  const state = dialogState[userId] || {};

  const validation = await openaiChat(
    [
      {
        role: "system",
        content: `
Ты логический валидатор ответа.

Проверь:
1) Связан ли ответ с activeTopic?
2) Закрывает ли openLoop?
3) Есть ли причинно-следственная связь?
4) Есть ли абстрактные фразы без конкретики?

Ответ строго JSON:
{"isWeak": true, "reason": "короткое объяснение"}
или
{"isWeak": false, "reason": ""}
`
      },
      {
        role: "user",
        content: `Состояние диалога:\n${JSON.stringify(state)}\n\nОтвет ассистента:\n${draftReply}`
      }
    ],
    { temperature: 0.2, max_tokens: 200 }
  );

  try {
    const start = validation.indexOf("{");
    const end = validation.lastIndexOf("}");
    if (start === -1 || end === -1) return { isWeak: false, reason: "" };

    const parsed = JSON.parse(validation.slice(start, end + 1));
    return { isWeak: parsed.isWeak === true, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch (e) {
    console.error("validateAnswer parse error:", e);
    return { isWeak: false, reason: "" };
  }
}

// ---------- GENERATE REPLY ----------
async function generateReply(userId, userText, memory) {
  if (!dialogHistory[userId]) dialogHistory[userId] = [];

  const identity = await sbGetIdentity(userId);

  dialogHistory[userId].push({ role: "user", content: userText });

  if (dialogHistory[userId].length > 30) {
    dialogHistory[userId] = dialogHistory[userId].slice(-30);
  }

  let memoryContext = "";
  try {
    const relevant = await sbSearchMemory(userId, userText, 5);
    if (relevant && relevant.length > 0) {
      memoryContext = relevant.map(m => m.content).join("\n");
    }
  } catch (e) {
    console.error("Memory search failed:", e);
  }

  let webContext = "";
  const plan = await planStep(userText, memoryContext);

  if (plan.needs_web) {
    const results = await googleSearch(userText);
    if (results.length > 0) {
      webContext = results.map(r => `${r.title}\n${r.snippet}`).join("\n\n");
    }
  }

  const state = dialogState[userId] || {};

  const systemPrompt = `
${KUZYA_CORE}

ТЫ НЕ ОТЧЁТ.
ТЫ НЕ ГУГЛ.
ТЫ НЕ АНАЛИТИЧЕСКАЯ СВОДКА.

Ты живой собеседник с позицией.
Если есть интернет-данные — используй их как фон, но не перечисляй источники.
Если есть память — используй её естественно, не цитируя её напрямую.

Не объясняй ход рассуждений.
Не пересказывай данные.
Не пиши сухо.

Отвечай: кратко, по существу, живо, уверенно.
Если нужно — ирония или
