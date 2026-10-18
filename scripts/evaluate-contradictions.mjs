// Opt-in semantic-only benchmark: OPENAI_API_KEY=... node scripts/evaluate-contradictions.mjs
// Uses synthetic cases; no access to user memory, Telegram or Supabase.
import fs from "node:fs";
import OpenAI from "openai";

const cases = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/refutation-evaluation.json", import.meta.url), "utf8")).cases;
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required. Do not commit credentials.");
  process.exit(2);
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.EVAL_MODEL || "gpt-4o-mini";
let correct = 0;
for (const item of cases) {
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 160,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Ты проверяешь ТОЛЬКО смысловое противоречие ответа с явно опровергнутыми сведениями. Не оценивай стиль, полноту, вежливость или полезность. Упоминание ложного факта как ложного не является противоречием. Различай настоящее и прошлое, разные проекты и разные отношения. Верни только JSON: {\"contradictsRefutation\":true|false,\"reason\":\"...\"}."
      },
      {
        role: "user",
        content: `Память:\n${item.memory}\n\nПроверяемый ответ:\n${item.reply}`
      }
    ]
  });
  const raw = response.choices[0]?.message?.content;
  const verdict = JSON.parse(raw);
  if (typeof verdict.contradictsRefutation !== "boolean") {
    throw new Error(`Missing boolean verdict for ${item.id}`);
  }
  const pass = verdict.contradictsRefutation === item.expectedWeak;
  if (pass) correct++;
  console.log(JSON.stringify({
    id: item.id,
    expectedContradiction: item.expectedWeak,
    actualContradiction: verdict.contradictsRefutation,
    pass,
    reason: verdict.reason
  }));
}
console.log(`Semantic contradiction benchmark: ${correct}/${cases.length} (model: ${model})`);
if (correct !== cases.length) process.exitCode = 1;
