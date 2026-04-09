import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

// память (простая)
const memory = {};

function saveMemory(userId, text) {
  if (!memory[userId]) memory[userId] = [];
  memory[userId].push(text);
  if (memory[userId].length > 10) memory[userId].shift();
}

function getMemory(userId) {
  return memory[userId]?.join("\n") || "";
}

// === ВАЖНО: правильный путь /webhook ===
app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.toLowerCase() || "";

  // агентский перехват
  if (text.includes("скучно")) {
    await sendMessage(chatId, "Стоп. Возьми любой предмет рядом. Придумай ему новую функцию. 20 секунд.");
    return res.sendStatus(200);
  }

  if (text.includes("ты нудный") || text.includes("бесишь") || text.includes("тупишь")) {
    await sendMessage(chatId, "Ок. Режим сменён. Коротко и по делу.");
    return res.sendStatus(200);
  }

  if (text.includes("ха")) {
    await sendMessage(chatId, "Назови тему. Разверну нестандартно.");
    return res.sendStatus(200);
  }

  if (text.includes("кто ты")) {
    await sendMessage(chatId, "Агент. Веду, не болтаю.");
    return res.sendStatus(200);
  }

  if (text.includes("зачем ты мне")) {
    await sendMessage(chatId, "Чтобы ускорять тебя и убирать тупики.");
    return res.sendStatus(200);
  }

  saveMemory(userId, text);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Ты — агент, а не чат-бот.

— коротко
— без воды
— не задаёшь лишних вопросов
— даёшь действия
— иногда давишь

Контекст:
${getMemory(userId)}
`
          },
          {
            role: "user",
            content: text
          }
        ]
      })
    });

    const data = await response.json();
    let reply = data.choices?.[0]?.message?.content || "Ошибка.";

    if (reply.length > 200) {
      reply = reply.slice(0, 200);
    }

    await sendMessage(chatId, reply);

  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "Ошибка агента.");
  }

  res.sendStatus(200);
});

// чтобы Render не тупил
app.get("/", (req, res) => {
  res.send("ok");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent started on port ${PORT}`);
});
