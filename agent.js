import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- INIT ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// --- MEMORY ---
async function getMemory(userId) {
  try {
    const { data } = await supabase
      .from("kuzia_memory")
      .select("content")
      .eq("user_id", userId)
      .order("timestamp", { ascending: false })
      .limit(10);

    if (!data) return "";

    return data.map((d) => d.content).join("\n");
  } catch (e) {
    return "";
  }
}

async function saveMemory(userId, text) {
  try {
    await supabase.from("kuzia_memory").insert({
      user_id: userId,
      content: text,
    });
  } catch (e) {}
}

// --- AGENT ---
export async function generateReply(userId, message) {
  const memory = await getMemory(userId);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content: `
Ты — Кузьма. Живой ассистент.

Твой стиль:
— говоришь как человек, спокойно и уверенно  
— не задаёшь лишних вопросов  
— не повторяешься  
— отвечаешь по делу  
— не звучишь как бот  

Твоя задача:
— помогать в любых вопросах  
— поддерживать диалог  
— быть удобным и понятным  

Ты не говоришь шаблонно вроде "как я могу помочь"
Ты отвечаешь сразу по сути.

Память:
${memory}
`,
      },
      {
        role: "user",
        content: message,
      },
    ],
  });

  const reply =
    completion.choices[0]?.message?.content || "...";

  await saveMemory(
    userId,
    `User: ${message}\nAgent: ${reply}`
  );

  return reply;
}
