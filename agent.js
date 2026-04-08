import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- INIT ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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
    console.log("getMemory error:", e);
    return "";
  }
}

async function saveMemory(userId, text) {
  try {
    await supabase.from("kuzia_memory").insert({
      user_id: userId,
      content: text,
    });
  } catch (e) {
    console.log("saveMemory error:", e);
  }
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
        content: `Ты агент. Используй память и не повторяйся.

Память:
${memory}`,
      },
      {
        role: "user",
        content: message,
      },
    ],
  });

  const reply = completion.choices[0]?.message?.content || "...";

  await saveMemory(userId, `User: ${message}\nAgent: ${reply}`);

  return reply;
}
