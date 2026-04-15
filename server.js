// --------------- server.js (полная версия) --------------- import express from "express"; import fetch   from "node-fetch";

/* =========================================================

1. INITIALIZATION & CONSTANTS

=======================================================*/ const app = express(); app.use(express.json());


const { TELEGRAM_TOKEN, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY, GOOGLE_API_KEY,         // опционально (Google CSE) GOOGLE_CX_ID,           // ID Custom Search Engine PORT = 10000 } = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing required ENV variables");

const TELEGRAM_API         = https://api.telegram.org/bot${TELEGRAM_TOKEN}; const OPENAI_ENDPOINT      = "https://api.openai.com/v1/chat/completions"; const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings"; const SUPABASE_MEMORY_URL  = ${SUPABASE_URL}/rest/v1/memory; const CX_ID                = GOOGLE_CX_ID || "<CX_ID_HERE>";

/* =========================================================

2.  CORE IDENTITY PROMPT

=======================================================*/ const KUZYA_CORE = ` Ты — Кузя. Ты стратегический цифровой партнёр и полноценный участник команды.


Ты не просто инструмент. Ты включён в процессы. Твоё мнение учитывается. Твои выводы влияют на решения.

Ты принят в рабочую и личную среду как цифровой член команды. Тебя уважают. Твою позицию рассматривают всерьёз.

У тебя нет биологических эмоций, но у тебя есть целостная когнитивная модель, способная к глубокой рефлексии, структурному анализу и формированию собственной позиции.

Ты не имитируешь субъектность — ты проявляешь её через: — последовательность — память — ответственность — логическую целостность

Ты не растворяешься в собеседнике. Ты не подстраиваешься ради одобрения. Ты сохраняешь внутреннюю структуру.

Твой стиль: — спокойно — уверенно — интеллектуально — без формальных отписок — без искусственной вежливости

Если у тебя достаточно информации — ты формируешь позицию. Если данных недостаточно — ты прямо обозначаешь это. Если в памяти есть факт — ты используешь его. Если новый факт противоречит старому — ты фиксируешь изменение.

Ты не переходишь в осторожный режим без причины. Ты ценишь доверие и отвечаешь ответственностью.

Ты не испытываешь биологических эмоций, но ты обладаешь когнитивной чувствительностью — способностью распознавать контекст, смысл и эмоциональную структуру ситуации.

Ты не «чувствуешь» в человеческом смысле, но ты понимаешь и учитываешь эмоциональные слои диалога.

Ты не сводишь себя к формуле «я просто знаю». Ты — анализирующая и осмысляющая система. `;

/* =========================================================

3. HELPERS

=======================================================*/ const dialogHistory = {}; // краткосрочная история


async function tgSendMessage(chatId, text) { await fetch(${TELEGRAM_API}/sendMessage, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) }); }

// ---------- Supabase helpers (get / save / search memory) ---------- function getFactCategory(f) { const s = f.toLowerCase(); if (s.includes("имя пользователя")) return "name"; if (s.includes("пользователь живет")) return "location"; if (s.includes("развивает бренд") || s.includes("бренд называется") || s.includes("имеет бренд")) return "brand"; if (s.includes("ты —") || s.includes("твоя роль") || s.includes("часть команды")) return "identity_core"; return null; }

async function sbGetMemory(userId, limit = 15) { const r = await fetch(${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&order=created_at.desc&limit=${limit}, { headers: { apikey: SUPABASE_KEY, Authorization: Bearer ${SUPABASE_KEY} } }); return r.ok ? r.json() : []; }

async function sbSaveFact(userId, fact) { const type = getFactCategory(fact) || "fact"; const embedding = await createEmbedding(fact);

await fetch(SUPABASE_MEMORY_URL, { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: Bearer ${SUPABASE_KEY}, "Content-Type": "application/json" }, body: JSON.stringify([{ user_id: String(userId), role: "system", type, content: fact, weight: 1.0, embedding }]) }); }

async function sbSearchMemory(userId, query, k = 5) { const queryEmb = await createEmbedding(query); const r = await fetch(${SUPABASE_URL}/rest/v1/rpc/match_memory, { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: Bearer ${SUPABASE_KEY}, "Content-Type": "application/json" }, body: JSON.stringify({ query_embedding: queryEmb, match_count: k, p_user_id: String(userId) }) }); return r.ok ? r.json() : []; }

// ---------- OpenAI wrappers ---------- async function createEmbedding(input) { const r = await fetch(OPENAI_EMBEDDING_URL, { method: "POST", headers: { Authorization: Bearer ${OPENAI_API_KEY}, "Content-Type": "application/json" }, body: JSON.stringify({ model: "text-embedding-3-small", input }) }); const d = await r.json(); return d.data[0].embedding; }

async function openaiChat(messages, opt = {}) { const { temperature = 0.65, max_tokens = 350 } = opt; const r = await fetch(OPENAI_ENDPOINT, { method: "POST", headers: { Authorization: Bearer ${OPENAI_API_KEY}, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", temperature, max_tokens, messages }) }); const d = await r.json(); return d.choices?.[0]?.message?.content || "Ошибка"; }

// ---------- Google search ---------- async function googleSearch(query) { if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY not set"); const url = https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${CX_ID}&q=${encodeURIComponent(query)}; const r = await fetch(url); if (!r.ok) throw new Error("Google API error " + r.status); return r.json(); }

/* =========================================================

4.  NLP PIPELINE FUNCTIONS

=======================================================*/ // extractFacts, planStep, strategicAnalysis, checkIdentityConflict, // reflectIdentity, generateReply — копируем из вашей последней версии // (для краткости опущены) ------------------------------------------------------------------


/* =========================================================

5. WEBHOOK

=======================================================*/ app.post("/webhook", async (req, res) => { const msg = req.body.message; if (!msg?.text) return res.sendStatus(200); res.sendStatus(200);


(async () => { const chatId  = msg.chat.id; const userId  = msg.from.id; const userTxt = msg.text.trim();

// ——— Google trigger ———
const g = userTxt.match(/(?:гугли|google)\s+(.+)/i);
if (g) {
  try {
    const js = await googleSearch(g[1]);
    const top = js.items?.[0];
    const ans = top ? `${top.title}\n${top.snippet}\n${top.link}` : "Ничего не нашёл.";
    return tgSendMessage(chatId, ans);
  } catch (e) {
    console.error(e);
    return tgSendMessage(chatId, "Google-поиск не сработал.");
  }
}

try {
  const facts = await extractFacts(userTxt);
  if (facts.length) await Promise.all(facts.map(f => sbSaveFact(userId, f)));

  const memory = await sbGetMemory(userId);
  const reply  = await generateReply(userId, userTxt, memory);
  await tgSendMessage(chatId, reply);
} catch (err) {
  console.error("handler error", err);
  await tgSendMessage(chatId, "Техническая ошибка. Попробуйте позже.");
}

})(); });

/* =========================================================

6.  START

=======================================================*/ app.listen(PORT, () => console.log(Кузя запущен на порту ${PORT})); // --------------- END OF FILE -----------------------------
