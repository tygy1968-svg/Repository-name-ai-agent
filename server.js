import express from "express";
import fetch   from "node-fetch";           // если нет  —  npm i node-fetch

const app = express();
app.use(express.json());

// ---------- ENV ----------
const {
  TELEGRAM_TOKEN,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_KEY,
  GOOGLE_API_KEY,           // опционально
  PORT = 10000
} = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("One or more API keys / URLs are missing in ENV variables");
}
// if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is missing"); // ← включите, когда понадобится

// ---------- CONST ----------
const TELEGRAM_API        = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const OPENAI_ENDPOINT     = "https://api.openai.com/v1/chat/completions";
const OPENAI_EMBED_URL    = "https://api.openai.com/v1/embeddings";
const SUPABASE_MEMORY_URL = `${SUPABASE_URL}/rest/v1/memory`;

// ---------- CORE TEXT (полный, без сокращений) ----------
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

// ---------- TELEGRAM ----------
async function tgSendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// ---------- SUPABASE ----------
// ... все функции getFactCategory, sbDeleteFactsByPattern, sbGetMemory,
// sbSaveFact, sbSearchMemory без изменений ...

// ---------- OPENAI ----------
async function createEmbedding(input) {
  const r = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input })
  });
  if (!r.ok) throw new Error("Embedding error " + r.status);
  const d = await r.json();
  return d.data[0].embedding;
}

async function openaiChat(messages, opts = {}) {
  const { temperature = 0.65, max_tokens = 350 } = opts;
  const r = await fetch(OPENAI_ENDPOINT, {
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
  if (!r.ok) throw new Error("OpenAI error " + r.status);
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "Ошибка";
}

// ---------- остальные функции (extractFacts, planStep, strategicAnalysis,
// checkIdentityConflict, reflectIdentity, generateReply) — вставь из своей последней
// рабочей версии БЕЗ изменений. Они здесь не дублируются ради краткости. ----------

// ---------- WEBHOOK ----------
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || typeof msg.text !== "string") return res.sendStatus(200);
  res.sendStatus(200);

  (async () => {
    const { id: chatId } = msg.chat;
    const { id: userId } = msg.from;
    const userText = msg.text.trim();

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
  })();
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Кузя запущен на порту ${PORT}`);
});
