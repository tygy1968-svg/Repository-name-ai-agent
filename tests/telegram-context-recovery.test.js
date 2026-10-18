import test from "node:test";
import assert from "node:assert/strict";
import { recoverTelegramTurns } from "../lib/telegram-context-recovery.js";

const row = (overrides = {}) => ({
  user_id: "yulia", channel: "telegram", event_type: "interaction",
  timestamp: "2026-10-19T00:00:00Z", stimulus: "Привет", response: "Я на связи",
  ...overrides
});

test("recovers stored Telegram text as separate turns", () => {
  assert.deepEqual(recoverTelegramTurns([row()]).map(t => [t.role, t.content]), [
    ["user", "Привет"], ["assistant", "Я на связи"]
  ]);
});
test("never mixes another owner or phone diagnostic into personal context", () => {
  const result = recoverTelegramTurns([
    row({ user_id: "other", stimulus: "Чужая запись" }),
    row({ channel: "voice", stimulus: "Разбуди коллегу" }),
    row({ event_type: "diagnostic", stimulus: "Тест" }),
    row()
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every(t => !/Чужая|коллегу|Тест/.test(t.content)));
});
test("chronological ordering and bounded most recent rows", () => {
  const result = recoverTelegramTurns([
    row({ timestamp: "2026-10-19T03:00:00Z", stimulus: "третий" }),
    row({ timestamp: "2026-10-19T01:00:00Z", stimulus: "первый" }),
    row({ timestamp: "2026-10-19T02:00:00Z", stimulus: "второй" })
  ], { limit: 2 });
  assert.deepEqual(result.filter(t => t.role === "user").map(t => t.content), ["второй", "третий"]);
});
test("missing text, invalid timestamps and text bounds", () => {
  const result = recoverTelegramTurns([
    row({ timestamp: "not-a-date" }),
    row({ stimulus: null, response: "abcdef" })
  ], { maxChars: 3 });
  assert.deepEqual(result.map(t => t.content), ["abc"]);
});
test("provenance is explicitly unverified", () => {
  assert.equal(recoverTelegramTurns([row()])[0].provenance, "stored_interaction_unverified");
});
