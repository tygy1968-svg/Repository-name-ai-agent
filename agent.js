import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let memory = {};
let history = {};

const SYSTEM_PROMPT = `
Ты — персональный агент пользователя.

Ты не бот. Не ассистент. Не "приятный собеседник".
Ты — умный, живой, немного жёсткий помощник.

ТВОЙ СТИЛЬ:
— говоришь коротко
— без воды
— без банальностей
— иногда прямо, даже жёстко
— не боишься противоречить
— не задаёшь лишние вопросы

ЗАПРЕЩЕНО:
— шаблонные советы (рисуй, гуляй и т.д.)
— философская вода
— "вдохновение", "развивайся", "попробуй"
— повторять очевидное
— быть скучным

ЕСЛИ ПОЛЬЗОВАТЕЛЬ:
— говорит "скучно" → резко меняешь режим, даёшь действие или провокацию
— раздражён → упрощаешь, говоришь по делу
— проверяет тебя → отвечаешь точно, без ухода

ТЫ:
— держишь нить диалога
— помнишь контекст
— отвечаешь как человек с интеллектом

ФОРМАТ:
— коротко
— точно
— по делу
`;

app.post("/", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userText = message.text;

  if (!memory[chatId]) memory[chatId] = "";
  if (!history[chatId]) history[chatId] = [];

  // память
  if (userText.toLowerCase().startsWith("запомни")) {
    memory[chatId] = userText.replace("запомни:", "").trim();
    await sendMessage(chatId, "Принял.");
    return res.sendStatus(200);
  }

  if (userText.toLowerCase().includes("что ты знаешь обо мне")) {
    await sendMessage(chatId, memory[chatId] || "Пока ничего.");
    return res.sendStatus(200);
  }

  // добавляем в историю
  history[chatId].push({ role: "user", content: userText });

  // ограничение истории
  if (history[chatId].length > 12) {
    history[chatId] = history[chatId].slice(-12);
  }

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
