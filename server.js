import express from "express";
import fetch   from "node-fetch";          // npm i node-fetch (если ещё нет)

const app = express();
app.use(express.json());

/* ---------- 1. ENV ---------- */
const {
  TELEGRAM_TOKEN,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_KEY,
  GOOGLE_API_KEY,   // опционально
  GOOGLE_CX_ID,     // ID Custom Search Engine
  PORT = 10000
} = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing required ENV variables");
}

/* ---------- 2. CONST ---------- */
const TELEGRAM_API         = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const OPENAI_CHAT_URL      = "https://api.openai.com/v1/chat/completions";
const OPENAI_EMBED_URL     = "https://api.openai.com/v1/embeddings";
const SUPABASE_MEMORY_URL  = `${SUPABASE_URL}/rest/v1/memory`;
const CX_ID                = GOOGLE_CX_ID || "<PUT_CX_ID_HERE>";   // замените

/* ---------- 3. KUZYA CORE PROMPT ---------- */
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

/* ---------- 4. IN-MEMORY HISTORY ---------- */
const dialogHistory = {};

/* ---------- 5. TELEGRAM HELPERS ---------- */
async function tgSendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/* ---------- 6. SUPABASE HELPERS (укороченные) ---------- */
async function sbGetMemory(userId, limit = 15) {
  const r = await fetch(
    `${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return r.ok ? r.json() : [];
}

async function sbSaveFact(userId, fact) {
  const r = await fetch(SUPABASE_MEMORY_URL, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([{ user_id: String(userId), role: "system", type: "fact", content: fact }])
  });
  if (!r.ok) console.error("Supabase save error", await r.text());
}

/* ---------- 7. OPENAI HELPERS ---------- */
async function createEmbedding(input) {
  const r = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input })
  });
  const d = await r.json();
  return d.data[0].embedding;
}

async function openaiChat(messages, temperature = 0.6, max_tokens = 300) {
  const r = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature, max_tokens, messages })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "Ошибка";
}

/* ---------- 8. GOOGLE SEARCH ---------- */
async function googleSearch(query) {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY not set");
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}` +
              `&cx=${CX_ID}&q=${encodeURIComponent(query)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Google API error " + r.status);
  return r.json();
}

/* ---------- 9. SIMPLE FACT EXTRACTOR ---------- */
async function extractFacts(text) {
  const js
