import express from "express"; // Node v18+ already has fetch globally. If you deploy on older Node, // uncomment the next line and add node-fetch to your package.json deps. // import fetch from "node-fetch";

const app = express(); app.use(express.json());

// ---------- ENV ---------- const { TELEGRAM_TOKEN, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY, PORT = 10000 } = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) { throw new Error("One or more API keys / URLs are missing in ENV variables"); }

// ---------- CONST ---------- const TELEGRAM_API = https://api.telegram.org/bot${TELEGRAM_TOKEN}; const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"; const SUPABASE_MEMORY_URL = ${SUPABASE_URL}/rest/v1/memory;

// ---------- HELPERS ---------- async function tgSendMessage(chatId, text) { await fetch(${TELEGRAM_API}/sendMessage, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) }); }

async function sbGetMemory(userId, limit = 15) { const res = await fetch( ${SUPABASE_MEMORY_URL}?user_id=eq.${userId}&order=created_at.desc&limit=${limit}, { headers: { apikey: SUPABASE_KEY, Authorization: Bearer ${SUPABASE_KEY} } } ); if (!res.ok) return []; return res.json(); }

async function sbSaveFact(userId, fact) { // uses Supabase upsert via on_conflict to skip duplicates await fetch(${SUPABASE_MEMORY_URL}?on_conflict=user_id,content, { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: Bearer ${SUPABASE_KEY}, "Content-Type": "application/json" }, body: JSON.stringify([ { user_id: String(userId), role: "system", type: "fact", content: fact, weight: 1.0 } ]) }); }

async function openaiChat(messages, { temperature = 0.7, max_tokens = 300 } = {}) { const res = await fetch(OPENAI_ENDPOINT, { method: "POST", headers: { Authorization: Bearer ${OPENAI_API_KEY}, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", temperature, max_tokens, messages }) }); if (!res.ok) throw new Error(OpenAI error: ${await res.text()}); const data = await res.json(); return data.choices?.[0]?.message?.content ?? ""; }

async function extractFacts(userText) { const content = await openaiChat( [ { role: "system", content: Извлеки факты о пользователе из сообщения. Верни JSON строго вида {\"facts\":[\"...\"]} }, { role: "user", content: userText } ], { temperature: 0, max_tokens: 100 } );

try { const parsed = JSON.parse(content); return parsed.facts || []; } catch { return []; } }

async function generateReply(userId, userText, memory) { const memoryContext = memory.map(m => m.content).join("\n"); const systemPrompt = `Ты — Кузя.

ПАМЯТЬ: ${memoryContext || "нет"}

Отвечай чётко и по сути.`;

return openaiChat( [ { role: "system", content: systemPrompt }, { role: "user", content: userText } ], { temperature: 0.6, max_tokens: 300 } ); }

// ---------- WEBHOOK ---------- app.post("/webhook", async (req, res) => { const msg = req.body.message; if (!msg || typeof msg.text !== "string") { return res.sendStatus(200); // ignore non-text updates }

// immediately confirm to Telegram res.sendStatus(200);

// handle in background (async () => { const { id: chatId } = msg.chat; const { id: userId } = msg.from; const userText = msg.text.trim();

try {
  const memory = await sbGetMemory(userId);
  const reply = await generateReply(userId, userText, memory);
  await tgSendMessage(chatId, reply);

  const facts = await extractFacts(userText);
  await Promise.all(facts.map(f => sbSaveFact(userId, f)));
} catch (e) {
  console.error("handler error", e);
  await tgSendMessage(chatId, "Упс, техническая ошибка. Попробуйте позже.");
}

})(); });

// ---------- START ---------- app.listen(PORT, () => { console.log(Кузя запущен на порту ${PORT}); });
