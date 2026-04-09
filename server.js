import express from "express";
import fetch from "node-fetch";
import { generateReply } from "./agent.js";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// --- WEBHOOK ---
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    const text = msg?.text;
    const chatId = msg?.chat?.id;
    const userId = msg?.from?.id;

    if (!text || !chatId) return res.send("ok");

    const reply = await generateReply(userId, text);

    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: reply,
        }),
      }
    );

    res.send("ok");
  } catch (e) {
    console.log("error:", e);
    res.send("ok");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Agent started on port", PORT);
});
