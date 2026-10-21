import test from "node:test";
import assert from "node:assert/strict";
import { classifyInteractionWrite } from "../lib/telegram-write-outcome.js";

test("successful delivery and confirmed DB write are recorded", () => {
  assert.deepEqual(classifyInteractionWrite({ telegramSent: true, dbWriteResult: true, sourceMessageId: "42" }), {
    status: "recorded", durable: true, needsReconciliation: false, safeToRetryBlindly: false
  });
});
test("Telegram delivery alone never proves DB persistence", () => {
  const r = classifyInteractionWrite({ telegramSent: true, dbWriteResult: false, sourceMessageId: "42" });
  assert.equal(r.status, "write_failed");
  assert.equal(r.durable, false);
  assert.equal(r.needsReconciliation, true);
});
test("unknown DB outcome requires reconciliation rather than blind retry", () => {
  const r = classifyInteractionWrite({ telegramSent: true, sourceMessageId: "42" });
  assert.equal(r.status, "write_unknown");
  assert.equal(r.safeToRetryBlindly, false);
});
test("no confirmed Telegram delivery is not a recorded exchange", () => {
  assert.equal(classifyInteractionWrite({ telegramSent: false, dbWriteResult: true, sourceMessageId: "42" }).status, "delivery_unconfirmed");
});
test("missing message identifier cannot support reliable reconciliation", () => {
  const r = classifyInteractionWrite({ telegramSent: true, dbWriteResult: true, sourceMessageId: "" });
  assert.equal(r.status, "untraceable");
  assert.equal(r.durable, false);
});
