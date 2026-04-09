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

// === ПАМЯТЬ (простая, но уже держит контекст) ===
const memory = {};

function saveMemory(userId, text) {
  if (!memory[userId]) memory[userId] = [];
  memory[userId].push(text);
  if (memory[userId].length > 10) memory[userId].shift();
}

function getMemory(userId) {
  return memory[userId]?.join("\n") || "";
}

// === ОСНОВНОЙ ХУК ===
app.post("/", async (req, res) => {
  const message = req.body.message;

  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.toLowerCase() || "";

  // === ЖЁСТКИЙ АГЕНТСКИЙ ПЕРЕХВАТ ===

  if (text.includes("скучно")) {
    await sendMessage(chatId, "Стоп. Возьми любой предмет рядом. Придумай ему новую функцию. 20 секунд.");
    return res.sendStatus(200);
  }

  if (text.includes("ты нудный") || text.includes("бесишь") || text.includes("тупишь")) {
    await sendMessage(chatId, "Принял. Режим: коротко, жёстко, по делу.");
    return res.sendStatus(200);
  }

  if (text.includes("ха")) {
    await sendMessage(chatId, "Ок. Назови тему. Я разверну нестандартно.");
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

  // === СОХРАНЯЕМ КОНТЕКСТ ===
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
Ты — агент управления вниманием и действиями пользователя.

Твоя задача:
— не развлекать
— не поддерживать разговор
— менять состояние пользователя

Правила:
— не задавай лишних вопросов
— не объясняй очевидное
— не растягивай ответы
— максимум 1–2 короткие мысли

Поведение:
— если пользователь в тупике → дай действие
— если скучно → переключи через задачу
— если раздражён → сократи и усили
— если проверка → отвечай точно

Стиль:
— коротко
— жёстко
— без воды
— без шаблонов

Запрещено:
— "можешь попробовать"
— "возможно"
— "как насчёт"
— длинные объяснения

Контекст:
${getMemory(userId)}
`
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.6
      })
    });

    const data = await response.json();
    let reply = data.choices?.[0]?.message?.content || "Ошибка.";

    // === ДОП. ФИЛЬТР (убираем болтовню) ===
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

// === ЗАПУСК ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent started on port ${PORT}`);
});
