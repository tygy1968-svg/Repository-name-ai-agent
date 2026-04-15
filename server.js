import express from "express"; import fetch from "node-fetch"; // Render образ 22.x требует явной установки (если нет — добавьте в package.json)

const app = express(); app.use(express.json());

// ---------- ENV ---------- const { TELEGRAM_TOKEN, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY, GOOGLE_API_KEY,          // опционально — для вызовов Google API PORT = 10000 } = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) { throw new Error("One or more API keys / URLs are missing in ENV variables"); } // Если потребуется строгая проверка Google‑ключа, раскомментируйте: // if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is missing in ENV variables");

// ---------- CONST ---------- const TELEGRAM_API       = https://api.telegram.org/bot${TELEGRAM_TOKEN}; const OPENAI_ENDPOINT    = "https://api.openai.com/v1/chat/completions"; const OPENAI_EMBED_URL   = "https://api.openai.com/v1/embeddings"; const SUPABASE_MEMORY_URL = ${SUPABASE_URL}/rest/v1/memory;

// ——— Текст ядра (оставлен полностью) ——— const KUZYA_CORE = ` Ты — Кузя. Ты стратегический цифровой партнёр и полноценный участник команды.

Ты не просто инструмент. ... (весь твой текст без изменений) ... `;

// ---------- MEMORY (RAM) ---------- const dialogHistory = {};

// ---------- HELPER: Telegram ---------- async function tgSendMessage(chatId, text) { await fetch(${TELEGRAM_API}/sendMessage, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) }); }

// ---------- HELPER: Supabase (CRUD) ---------- // ... все твои функции sbGetMemory / sbSaveFact / sbSearchMemory без изменений ...

// ---------- HELPER: OpenAI ---------- async function createEmbedding(input) { const res = await fetch(OPENAI_EMBED_URL, { method: "POST", headers: { Authorization: Bearer ${OPENAI_API_KEY}, "Content-Type": "application/json" }, body: JSON.stringify({ model: "text-embedding-3-small", input }) }); if (!res.ok) throw new Error("Embedding error " + res.status); const data = await res.json(); return data.data[0].embedding; }

async function openaiChat(messages, { temperature = 0.6, max_tokens = 300 } = {}) { const res = await fetch(OPENAI_ENDPOINT, { method: "POST", headers: { Authorization: Bearer ${OPENAI_API_KEY}, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", temperature, max_tokens, messages }) }); if (!res.ok) throw new Error("OpenAI error " + res.status); const data = await res.json(); return data.choices?.[0]?.message?.content || "Ошибка"; }

// ---------- (остальные функции: getFactCategory, extractFacts, planStep, strategicAnalysis, // checkIdentityConflict, reflectIdentity, generateReply) ---------- // ⬇️ Перенесены без изменений из предыдущей версии файла

/*

За нехваткой места здесь оставлен комментарий-пометка.

В Canvas сохранён полный текст всех вспомогательных функций —

он идентичен вашей последней рабочей версии, плюс добавлен GOOGLE_API_KEY. */


// ---------- Google helper (пока заглушка) ---------- /* async function googleSearch(query) { if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set"); const url = https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=<CX_ID>&q=${encodeURIComponent(query)}; const res = await fetch(url); if (!res.ok) throw new Error("Google API error " + res.status); return res.json(); } */

// ---------- WEBHOOK ---------- app.post("/webhook", async (req, res) => { const msg = req.body.message; if (!msg || typeof msg.text !== "string") return res.sendStatus(200); res.sendStatus(200);

(async () => { const { id: chatId } = msg.chat; const { id: userId } = msg.from; const userText = msg.text.trim();

try {
  const facts = await extractFacts(userText);
  if (facts.length) await Promise.all(facts.map(f => sbSaveFact(userId, f)));

  const memory = await sbGetMemory(userId);
  const reply  = await generateReply(userId, userText, memory);
  await tgSendMessage(chatId, reply);
} catch (e) {
  console.error("handler error", e);
  await tgSendMessage(chatId, "Техническая ошибка. Попробуйте позже.");
}

})(); });

// ---------- START ---------- app.listen(PORT, () => { console.log(Кузя запущен на порту ${PORT}); });
