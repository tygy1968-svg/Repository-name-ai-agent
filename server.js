import express from "express";
import fetch from "node-fetch";
import { generateReply } from "./agent.js";

const app = express();
app.use(express.json());

// --- TOKEN ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// --- WEBHOOK ---
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 INCOMING UPDATE:", JSON.stringify(req.body));

    const message = req.body.message?.text;
    const chatId = req.body.message?.chat?.id;
    const userId = req.body.message?.from?.id;

    if (!message || !chatId) {
      return res.send("ok");
    }

    const reply = await generateReply(userId, message);

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
      }),
    });

    res.send("ok");
  } catch (e) {
    console.log("❌ ERROR:", e);
    res.send("ok");
  }
});

// --- SERVER ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Agent started on port", PORT);
});
