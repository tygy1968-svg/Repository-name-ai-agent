import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Telegram candidate extraction is not automatic durable memory write", () => {
  const start = source.indexOf("const facts = await extractFacts(text);");
  const end = source.indexOf("const memory = await sbGetMemory(userId);", start);
  assert.ok(start >= 0 && end > start, "Telegram fact extraction block exists");
  const block = source.slice(start, end);
  assert.match(block, /LAB_FACT_CANDIDATES_NOT_SAVED/);
  assert.doesNotMatch(block, /sbSaveFact\s*\(/);
  assert.doesNotMatch(block, /fetch\s*\(/);
});

test("candidate-only block precedes generation and response", () => {
  const start = source.indexOf("const facts = await extractFacts(text);");
  const generation = source.indexOf("const reply = await generateReply(userId, text, memory);", start);
  const send = source.indexOf("await tgSendMessage(chatId, reply);", generation);
  assert.ok(start >= 0 && generation > start && send > generation);
});
