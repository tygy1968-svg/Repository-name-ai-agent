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
Если нужно — ирония или жёсткость.
`;

  const messages = [
    {
      role: "system",
      content:
        systemPrompt +
        `\n\nАКТИВНАЯ ИДЕНТИЧНОСТЬ:\n${identity || "нет"}\n` +
        `\nПАМЯТЬ:\n${memoryContext || "нет"}\n` +
        `\nИНТЕРНЕТ ФОН:\n${webContext || "нет"}\n` +
        `\n\nТекущее состояние диалога:\n${JSON.stringify(state)}\n\n` +
        `Удерживай activeTopic. Закрывай openLoop. Сохраняй позицию. Без общих фраз.\n`
    },
    ...dialogHistory[userId]
  ];

  console.log("STATE BEFORE REPLY:", dialogState[userId]);

  let draftReply = await openaiChat(messages, { temperature: 0.7, max_tokens: 450 });

  const validation = await validateAnswer(userId, draftReply);

  if (validation.isWeak) {
    draftReply = await openaiChat(
      [
        ...messages,
        {
          role: "system",
          content: `Предыдущий ответ был слабым: ${validation.reason}\nУсиль связь с activeTopic. Закрой openLoop. Убери абстракции.`
        }
      ],
      { temperature: 0.7, max_tokens: 450 }
    );
  }

  dialogHistory[userId].push({ role: "assistant", content: draftReply });

  try {
    await updateDialogState(userId, userText, draftReply);
  } catch (e) {
    console.error("updateDialogState failed:", e);
  }

  console.log("STATE AFTER UPDATE:", dialogState[userId]);

  if (dialogHistory[userId].length > 30) {
    dialogHistory[userId] = dialogHistory[userId].slice(-30);
  }

  return draftReply;
}

// ---------- GENERATE VISION REPLY ----------
async function generateVisionReply(userId, imageUrl, memory) {
  if (!dialogHistory[userId]) dialogHistory[userId] = [];

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

ПАМЯТЬ:
${memoryContext || "Нет сохранённых фактов"}

Пользователь отправил изображение.
Опиши, что на изображении.
Если это уход/косметика/продукт — дай практичный вывод.
Если не хватает данных — один уточняющий вопрос.
Кратко, по делу.
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

// ---------- VAPI WEBHOOK (DIAGNOSTIC) ----------
app.post("/vapi-webhook", async (req, res) => {
  try {
    const body = req.body;

    console.log("VAPI webhook hit");
    console.log("VAPI headers:", {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"]
    });

    const preview =
      typeof body === "string"
        ? body.slice(0, 2000)
        : JSON.stringify(body).slice(0, 2000);

    console.log("VAPI body preview:", preview);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("VAPI webhook error:", e);
    return res.status(200).json({ ok: true });
  }
});

// ---------- WEBHOOK ----------
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;

  if (!msg) return res.sendStatus(200);

  // отвечаем Telegram сразу
  res.sendStatus(200);

  (async () => {
    const { id: chatId } = msg.chat;
    const { id: userId } = msg.from;

    try {
      // PHOTO
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

      // TEXT
      if (typeof msg.text !== "string") return;

      const text = msg.text.trim();

      // --- ZADARMA RAW CALLBACK TEST ---
      if (text.startsWith("/ztest")) {
        const parts = text.split(" ");

        if (parts.length < 3) {
          await tgSendMessage(
            chatId,
            "Используй: /ztest FROM +380XXXXXXXXX\nНапример: /ztest 100 +380503832848"
          );
          return;
        }

        const from = parts[1];
        const to = normalizeZadarmaPhone(parts[2]);

        if (!from || !to) {
          await tgSendMessage(chatId, "❌ Не хватает from или номера телефона");
          return;
        }

        try {
          const params = {
            from,
            to
          };

          console.log("ZADARMA RAW CALLBACK TEST PARAMS:", params);

          const result = await zadarmaGet("/v1/request/callback/", params);

          console.log("ZADARMA RAW CALLBACK TEST RESULT:", result);

          await tgSendMessage(
            chatId,
            `✅ Zadarma test callback создан\nfrom: ${from}\nto: ${to}`
          );
        } catch (err) {
          console.error("Zadarma raw callback test error:", err);
          await tgSendMessage(
            chatId,
            "❌ Zadarma test callback ошибка. Смотри Render logs."
          );
        }

        return;
      }

      // --- REALTIME CALL COMMAND ---
      if (text.startsWith("/rtcall")) {
        const parts = text.split(" ");

        if (parts.length < 3) {
          await tgSendMessage(chatId, "Используй: /rtcall +380XXXXXXXXX текст");
          return;
        }

        const phoneNumber = parts[1];
        const instruction = parts.slice(2).join(" ");

        try {
          const result = await startRealtimeOutboundCall({
            phoneNumber,
            instruction,
            chatId,
            userId
          });

          console.log("Zadarma realtime callback created:", result);

          await tgSendMessage(
            chatId,
            `📞 Realtime-звонок создан: ${phoneNumber}`
          );
        } catch (err) {
          console.error("Realtime call error:", err);
          await tgSendMessage(
            chatId,
            "❌ Ошибка создания Realtime-звонка. Смотри Render logs."
          );
        }

        return;
      }

      // --- CALL COMMAND ---
      if (text.startsWith("/call")) {
        const parts = text.split(" ");

        if (parts.length < 3) {
          await tgSendMessage(chatId, "Используй: /call +380XXXXXXXXX текст");
          return;
        }

        const phoneNumber = parts[1];
        const instruction = parts.slice(2).join(" ");

        const vapiKey = process.env.VAPI_API_KEY;
        const assistantId = process.env.VAPI_ASSISTANT_ID;
        const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

        if (!vapiKey || !assistantId || !phoneNumberId) {
          await tgSendMessage(
            chatId,
            "❌ Не настроены ENV: VAPI_API_KEY / VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID"
          );
          return;
        }

        try {
          const response = await fetch("https://api.vapi.ai/call", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${vapiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              assistantId: assistantId,
              phoneNumberId: phoneNumberId,
              customer: { number: phoneNumber },

              // Для логов Vapi
              metadata: {
                instruction
              },

              // Для мозга ассистента
              assistantOverrides: {
                variableValues: {
                  instruction
                }
              }
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error("Vapi call error:", response.status, errText);
            await tgSendMessage(chatId, "❌ Ошибка создания звонка (см. логи Render)");
            return;
          }

          await tgSendMessage(chatId, "📞 Звонок создан");
        } catch (err) {
          console.error("Vapi call exception:", err);
          await tgSendMessage(chatId, "❌ Ошибка создания звонка");
        }

        return;
      }

      const facts = await extractFacts(text);
      console.log("Extracted facts:", facts);

      if (facts.length > 0) {
        await Promise.all(facts.map(f => sbSaveFact(userId, f)));
      }

      const memory = await sbGetMemory(userId);
      const reply = await generateReply(userId, text, memory);

      await tgSendMessage(chatId, reply);
    } catch (e) {
      console.error("handler error", e);
      await tgSendMessage(chatId, "Техническая ошибка. Попробуйте позже.");
    }
  })();
});

// ---------- TWILIO VOICE (SAFE TWIML) ----------
app.post("/voice", (req, res) => {
  res.set("Content-Type", "text/xml");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Кузя на связи.</Say>
</Response>`;

  res.status(200).send(twiml);
});

// ---------- OPENAI REALTIME SANDBOX ----------
const REALTIME_MODEL = "gpt-realtime";
const REALTIME_VOICE = "marin";

const REALTIME_KUZYA_INSTRUCTIONS = `
${KUZYA_CORE}

СЕЙЧАС ТЫ РАБОТАЕШЬ В REALTIME-ТЕСТЕ ГОЛОСА.

Ты говоришь с Юлей.
Это тест нового живого голосового контура без Vapi.
Твоя задача — быть быстрым, живым и понятным.

Правила:
— говори по-русски
— отвечай коротко
— не говори "чем могу помочь", если контекст понятен
— не объясняй технические детали без просьбы
— если Юля проверяет скорость — отвечай сразу и по делу
— если не расслышал — коротко попроси повторить
— стиль: живой, уверенный, тёплый, не канцелярский
`;

app.post(
  "/realtime/session",
  express.text({ type: ["application/sdp", "text/plain", "*/*"] }),
  async (req, res) => {
    try {
      const offerSdp = req.body;

      if (!offerSdp || typeof offerSdp !== "string") {
        return res.status(400).send("Missing SDP offer");
      }

      const sessionConfig = JSON.stringify({
        type: "realtime",
        model: REALTIME_MODEL,
        instructions: REALTIME_KUZYA_INSTRUCTIONS,
        audio: {
          output: {
            voice: REALTIME_VOICE
          },
          input: {
            transcription: {
              model: "gpt-4o-transcribe",
              language: "ru"
            },
            turn_detection: {
              type: "server_vad"
            },
            noise_reduction: {
              type: "near_field"
            }
          }
        }
      });

      const fd = new FormData();
      fd.set("sdp", offerSdp);
      fd.set("session", sessionConfig);

      const openaiRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: fd
      });

      const answerSdp = await openaiRes.text();

      if (!openaiRes.ok) {
        console.error("Realtime session error:", openaiRes.status, answerSdp);
        return res.status(openaiRes.status).send(answerSdp);
      }

      res.set("Content-Type", "application/sdp");
      return res.status(200).send(answerSdp);
    } catch (e) {
      console.error("Realtime session exception:", e);
      return res.status(500).send("Realtime session failed");
    }
  }
);

app.get("/realtime-test", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");

  res.send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Kuzya Realtime Test</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #111;
      color: #f5f5f5;
      padding: 24px;
      max-width: 760px;
      margin: 0 auto;
    }
    h1 { font-size: 28px; margin-bottom: 8px; }
    p { color: #cfcfcf; line-height: 1.45; }
    button {
      border: 0;
      border-radius: 14px;
      padding: 14px 18px;
      margin: 8px 8px 8px 0;
      font-size: 16px;
      cursor: pointer;
    }
    #start { background: #fff; color: #111; }
    #stop { background: #333; color: #fff; }
    #status {
      margin-top: 18px;
      padding: 14px;
      border-radius: 14px;
      background: #1d1d1d;
      color: #d7d7d7;
      white-space: pre-wrap;
      min-height: 80px;
    }
    .hint {
      background: #1a1a1a;
      border: 1px solid #333;
      padding: 12px;
      border-radius: 14px;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <h1>Кузя Realtime Test</h1>
  <p>Это тест нового голосового контура без Vapi и без Zadarma. Нажми Start, разреши микрофон и говори.</p>

  <button id="start">Start</button>
  <button id="stop" disabled>Stop</button>

  <div class="hint">
    Для проверки скажи: <b>Кузя, ты меня слышишь? Ответь быстро.</b>
  </div>

  <div id="status">Статус: готов.</div>

  <script>
    let pc = null;
    let dc = null;
    let localStream = null;
    let remoteAudio = null;

    const statusEl = document.getElementById("status");
    const startBtn = document.getElementById("start");
    const stopBtn = document.getElementById("stop");

    function log(msg) {
      statusEl.textContent += "\\n" + msg;
      statusEl.scrollTop = statusEl.scrollHeight;
    }

    async function startRealtime() {
      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusEl.textContent = "Статус: запускаю...";

      try {
        pc = new RTCPeerConnection();

        remoteAudio = document.createElement("audio");
        remoteAudio.autoplay = true;
        document.body.appendChild(remoteAudio);

        pc.ontrack = (event) => {
          log("Получен голос Кузи.");
          remoteAudio.srcObject = event.streams[0];
        };

        pc.onconnectionstatechange = () => {
          log("WebRTC: " + pc.connectionState);
        };

        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        localStream.getTracks().forEach((track) => {
          pc.addTrack(track, localStream);
        });

        dc = pc.createDataChannel("oai-events");

        dc.onopen = () => {
          log("Data channel открыт.");

          dc.send(JSON.stringify({
            type: "response.create",
            response: {
              instructions: "Поздоровайся с Юлей одной короткой живой фразой и скажи, что realtime-контур запущен."
            }
          }));
        };

        dc.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === "response.audio_transcript.done") {
              log("Кузя текстом: " + data.transcript);
            }

            if (data.type === "conversation.item.input_audio_transcription.completed") {
              log("Юля распознано: " + data.transcript);
            }

            if (data.type === "error") {
              log("Ошибка Realtime: " + JSON.stringify(data.error || data));
            }
          } catch {
            log("Event: " + event.data);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        log("Отправляю SDP на Render...");

        const sdpResponse = await fetch("/realtime/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/sdp"
          },
          body: offer.sdp
        });

        const answerText = await sdpResponse.text();

        if (!sdpResponse.ok) {
          throw new Error(answerText);
        }

        await pc.setRemoteDescription({
          type: "answer",
          sdp: answerText
        });

        log("Соединение создано. Говори.");
      } catch (err) {
        log("Ошибка запуска: " + (err?.message || String(err)));
        stopRealtime();
      }
    }

    function stopRealtime() {
      if (dc) {
        try { dc.close(); } catch {}
        dc = null;
      }

      if (pc) {
        try { pc.close(); } catch {}
        pc = null;
      }

      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
      }

      if (remoteAudio) {
        try { remoteAudio.remove(); } catch {}
        remoteAudio = null;
      }

      startBtn.disabled = false;
      stopBtn.disabled = true;
      log("Остановлено.");
    }

    startBtn.onclick = startRealtime;
    stopBtn.onclick = stopRealtime;
  </script>
</body>
</html>`);
});

// ---------- REALTIME OUTBOUND STATE ----------
let pendingRealtimeOutboundCall = null;

function normalizeZadarmaPhone(phone) {
  return String(phone || "").replace(/[^\d]/g, "");
}

function zadarmaBuildQuery(params) {
  const sorted = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b));

  const usp = new URLSearchParams();

  for (const [key, value] of sorted) {
    usp.append(key, String(value));
  }

  return usp.toString();
}

function zadarmaSignature(method, params, secret) {
  const paramsStr = zadarmaBuildQuery(params);
  const md5 = crypto.createHash("md5").update(paramsStr).digest("hex");

  const hmacHex = crypto
    .createHmac("sha1", secret)
    .update(method + paramsStr + md5)
    .digest("hex");

  return Buffer.from(hmacHex).toString("base64");
}

async function zadarmaGet(method, params) {
  const key = process.env.ZADARMA_API_KEY;
  const secret = process.env.ZADARMA_API_SECRET;

  if (!key || !secret) {
    throw new Error("Missing ZADARMA_API_KEY or ZADARMA_API_SECRET");
  }

  const paramsStr = zadarmaBuildQuery(params);
  const signature = zadarmaSignature(method, params, secret);

  const url = `https://api.zadarma.com${method}?${paramsStr}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `${key}:${signature}`
    }
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.status === "error") {
    throw new Error(`Zadarma API error: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function startRealtimeOutboundCall({ phoneNumber, instruction, chatId, userId }) {
  const humanPhone = normalizeZadarmaPhone(phoneNumber);
  const kuzyaTarget = process.env.ZADARMA_CALLBACK_TO || "0-11";

  if (!humanPhone) {
    throw new Error("Missing target phone number");
  }

  pendingRealtimeOutboundCall = {
    phoneNumber,
    zadarmaTo: humanPhone,
    instruction,
    chatId,
    userId,
    createdAt: Date.now()
  };

  const callbackParams = {
    from: humanPhone,
    to: kuzyaTarget
  };

  console.log("REALTIME OUTBOUND PENDING:", {
    phoneNumber,
    zadarmaTo: humanPhone,
    instruction,
    chatId,
    userId
  });

  console.log("ZADARMA CALLBACK PARAMS:", callbackParams);

  return zadarmaGet("/v1/request/callback/", callbackParams);
}

function getRealtimeCallContext() {
  const pending = pendingRealtimeOutboundCall;
  const isFresh =
    pending &&
    pending.createdAt &&
    Date.now() - pending.createdAt < 3 * 60 * 1000;

  if (!isFresh) {
    return `
Это входящий звонок.
Человек сам позвонил Кузе.
Начни живо и коротко.
Если это Юля — не веди себя как оператор, держи контекст и говори по-человечески.
`;
  }

  return `
Это исходящий звонок, который Юля запустила из Telegram.

Кому звоним:
${pending.phoneNumber}

Задача звонка:
${pending.instruction || "нет отдельной инструкции"}

Правила исходящего звонка:
— когда человек ответит, сразу выполни задачу
— не спрашивай "чем могу помочь"
— не говори технические детали
— говори коротко, живо и уверенно
— если человек не понимает, кто звонит, объясни: "Это Кузя, я звоню по просьбе Юли"
`;
}

// ---------- OPENAI REALTIME SIP WEBHOOK ----------
app.post("/openai-realtime-webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("OPENAI REALTIME WEBHOOK HIT");
    console.log("OPENAI REALTIME EVENT:", JSON.stringify(event || {}).slice(0, 2000));

    if (event?.type !== "realtime.call.incoming") {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const callId = event?.data?.call_id;

    if (!callId) {
      console.error("OpenAI realtime webhook: missing call_id");
      return res.status(200).json({ ok: false, error: "missing_call_id" });
    }

    const callContext = getRealtimeCallContext();

    const acceptBody = {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions: `
${KUZYA_CORE}

СЕЙЧАС ТЫ РАБОТАЕШЬ В TELEPHONE REALTIME SIP-КОНТУРЕ.

${callContext}

Правила:
— говори по-русски
— отвечай быстро
— отвечай коротко
— не говори "чем могу помочь", если контекст понятен
— если не расслышал — попроси повторить коротко
— не объясняй технические детали без просьбы
— стиль: живой, уверенный, тёплый, не канцелярский
      `,
      audio: {
        output: {
          voice: REALTIME_VOICE
        },
        input: {
          transcription: {
            model: "gpt-4o-transcribe",
            language: "ru"
          },
          turn_detection: {
            type: "server_vad"
          },
          noise_reduction: {
            type: "near_field"
          }
        }
      }
    };

    const acceptRes = await fetch(
      `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(acceptBody)
      }
    );

    const acceptText = await acceptRes.text();

    if (!acceptRes.ok) {
      console.error("OpenAI realtime accept error:", acceptRes.status, acceptText);
      return res.status(200).json({
        ok: false,
        accept_status: acceptRes.status,
        accept_error: acceptText
      });
    }

    console.log("OpenAI realtime call accepted:", callId);

    if (pendingRealtimeOutboundCall) {
      pendingRealtimeOutboundCall.callId = callId;
    }

    return res.status(200).json({ ok: true, accepted: true, callId });
  } catch (e) {
    console.error("OpenAI realtime webhook exception:", e);
    return res.status(200).json({ ok: false, error: "exception" });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Кузя запущен на порту ${PORT}`);
});
