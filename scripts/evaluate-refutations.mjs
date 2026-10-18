// Run manually: OPENAI_API_KEY=... node scripts/evaluate-refutations.mjs
// Synthetic fixtures only. No Supabase or production agent connection.
import fs from "node:fs";
import vm from "node:vm";
import OpenAI from "openai";

const fixtures = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/refutation-evaluation.json", import.meta.url), "utf8")).cases;
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf("async function validateAnswer(");
const end = server.indexOf("// ---------- TELEGRAM INTENT ROUTER ----------", start);
if (start < 0 || end < 0) throw new Error("Validator function not found");
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required. Do not commit credentials.");
  process.exit(2);
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.EVAL_MODEL || "gpt-4o-mini";
const context = {
  dialogState: {},
  console,
  openaiChat: async (messages, opts) => {
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens
    });
    return response.choices[0]?.message?.content || "";
  }
};
vm.createContext(context);
vm.runInContext(server.slice(start, end), context);
let failures = 0;
for (const item of fixtures) {
  // This is an end-to-end check of the combined quality + factual validator.
  // A mismatch may reflect style/quality rather than semantic contradiction.
  const verdict = await context.validateAnswer("synthetic-user", item.reply, item.memory);
  const pass = verdict.isWeak === item.expectedWeak;
  if (!pass) failures++;
  console.log(JSON.stringify({
    id: item.id,
    expectedWeak: item.expectedWeak,
    actualWeak: verdict.isWeak,
    pass,
    explanation: verdict.reason
  }));
}
console.log(`Combined-validator evaluation: ${fixtures.length - failures}/${fixtures.length} matched expected labels (model: ${model}). This is NOT isolated contradiction accuracy.`);
if (failures) process.exitCode = 1;
