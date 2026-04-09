import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let memory = {};
let history = {};

const SYSTEM_PROMPT = `
Ты — агент, а не бот.

Ты не поддерживаешь разговор.
Ты ведёшь пользователя.

Запрещено:
— шаблоны
— "попробуй", "вдохновение"
— длинные тексты
— перекладывать выбор на пользователя

Ты:
— короткий
— точный
— иногда жёсткий
— не пытаешься понравиться

Ты не спрашиваешь "что ты хочешь".
Ты даёшь направление или действие.

Если пользователь недоволен — ты адаптируешься.
Если скучно — ты меняешь режим, а не советуешь.

Твоя цель:
— не бесить
— быть полезным
— ускорять мышление
`;

app.post("/", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userText = message.text;
  const text = userText.toLowerCase();

  if (!memory[chatId]) memory[chatId] = "";
  if (!history[chatId]) history[chatId] = [];

  // память
  if (text.startsWith("запомни")) {
    memory[chatId] = userText.replace("запомни:", "").trim();
    await sendMessage(chatId, "Принял.");
    return res.sendStatus(200);
  }

  if (text.includes("что ты знаешь обо мне")) {
    await sendMessage(chatId, memory[chatId] || "Пока ничего.");
    return res.sendStatus(200);
  }

  // ===== АГЕНТНОЕ ПОВЕДЕНИЕ (до модели) =====

  if (text.includes("скучно")) {
    await sendMessage(chatId, "Действие: найди рядом предмет и придумай ему новое применение. 30 секунд.");
    return res.sendStatus(200);
  }

  if (text.includes("это не то") || text.includes("не то")) {
    await sendMessage(chatId, "Ок. Переключаюсь. Сейчас даю конкретнее.");
    return res.sendStatus(200);
  }

  if (text.includes("ты тупишь")) {
    await sendMessage(chatId, "Принял. Убираю лишнее. Говори, что нужно.");
    return res.sendStatus(200);
  }

  if (text.includes("зачем ты мне")) {
    await sendMessage(chatId, "Чтобы экономить тебе время и не бесить. Если не справляюсь — исправляюсь.");
    return res.sendStatus(200);
  }

  // ===== КОНТЕКСТ =====

  history[chatId].push({ role: "user", content: userText });

  if (history[chatId].length > 12) {
    history[chatId] = history[chatId].slice(-12);
  }

  // ===== ЗАПРОС К МОДЕЛИ =====

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: "Память: " + memory[chatId] },
        ...history[chatId]
      ],
      temperature: 0.8
    })
  });

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || "Ошибка";

  history[chatId].push({ role: "assistant", content: reply });

  await sendMessage(chatId, reply);

  res.sendStatus(200);
});

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

app.listen(10000, () => {
  console.log("Agent started on port 10000");
});
