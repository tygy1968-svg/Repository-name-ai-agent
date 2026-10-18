import test from "node:test";
import assert from "node:assert/strict";
import { resolveMemoryClaim } from "../lib/memory-claim-resolution.js";

test("refutation overrides matching fact regardless of input order", () => {
  const fact = { id: 1, claimKey: "brand", type: "fact", content: "Brand X" };
  const correction = { id: 2, claimKey: "brand", type: "refuted", content: "Brand X is disproven" };
  for (const records of [[fact, correction], [correction, fact]]) {
    assert.deepEqual(resolveMemoryClaim(records, "brand"), { status: "refuted", answer: null, sources: [2] });
  }
});
test("unrelated refutation does not suppress another claim", () => {
  const records = [
    { id: 1, claimKey: "brand", type: "fact", content: "Brand X" },
    { id: 2, claimKey: "address", type: "refuted", content: "Old address" },
  ];
  assert.equal(resolveMemoryClaim(records, "brand").answer, "Brand X");
});
test("conflicting facts cause abstention", () => {
  const result = resolveMemoryClaim([
    { id: 1, claimKey: "role", type: "fact", content: "Ally" },
    { id: 2, claimKey: "role", type: "fact", content: "Guide" },
  ], "role");
  assert.equal(result.status, "conflict");
  assert.equal(result.answer, null);
});
test("unknown and malformed input are handled safely", () => {
  assert.equal(resolveMemoryClaim([], "brand").status, "unknown");
  assert.throws(() => resolveMemoryClaim(null, "brand"), /array/);
  assert.throws(() => resolveMemoryClaim([], ""), /claimKey/);
});
