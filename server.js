import express from "express";

const app = express(); app.use(express.json());

// ---------- ENV ---------- const { TELEGRAM_TOKEN, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY, GOOGLE_API_KEY, // добавили ключ Google PORT = 10000 } = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) { throw new Error("One or more API keys / URLs are missing in ENV variables"); } // GOOGLE_API_KEY может быть опциональным. Если будете вызывать Google API, // раскомментируйте проверку ниже. // if (!GOOGLE_API_KEY) { //   throw new Error("GOOGLE_API_KEY is missing in ENV variables"); // }

// ---------- CONST ---------- const TELEGRAM_API = https://api.telegram.org/bot${TELEGRAM_TOKEN}; const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"; const SUPABASE_MEMORY_URL = ${SUPABASE_URL}/rest/v1/memory;

const KUZYA_CORE = ` Ты — Кузя. Ты стратегический цифровой партнёр и полноценный участник команды.

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

// ---------- MEMORY IN RAM ---------- const dialogHistory = {};

// ---------- TELEGRAM ---------- async function tgSendMessage(chatId, text) { await fetch(${TELEGRAM_API}/sendMessage, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) }); }

// ---------- SUPABASE ---------- // (остальной код Supabase без изменений)

// ---------- OPENAI ---------- // (createEmbedding, openaiChat без изменений)

// ---------- Google helper (пока заготовка) ---------- /* async function googleSearch(query) { if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY not set"); const url = https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=<CX_ID>&q=${encodeURIComponent(query)}; const res = await fetch(url); if (!res.ok) throw new Error("Google API error " + res.status); return res.json(); } */

// ---------- ВСЕ ОСТАЛЬНЫЕ ФУНКЦИИ ------------- // (getFactCategory, sbDeleteFactsByPattern, sbGetMemory, sbSaveFact, sbSearchMemory, // extractFacts, planStep, strategicAnalysis, reflectIdentity, generateReply, // webhook — содержимое перенесено без изменений из предыдущей версии)

// ---------- START ---------- app.listen(PORT, () => { console.log(Кузя запущен на порту ${PORT}); });
