import test from "node:test";
import assert from "node:assert/strict";
import { appendDecisionEvent, traceDecision } from "../lib/decision-ledger.js";
import { exportDecisionSnapshot, importDecisionSnapshot } from "../lib/decision-snapshot.js";

function sample() {
  let events = appendDecisionEvent([], { id: "decision", type: "decision", summary: "Initial decision", reason: "First evidence", timestamp: "2026-10-18T00:00:00Z" });
  events = appendDecisionEvent(events, { id: "revision", type: "correction", summary: "Revised decision", reason: "Contradicting evidence", parentId: "decision", timestamp: "2026-10-18T01:00:00Z" });
  return events;
}

test("exports and restores identical decision history across simulated process restart", () => {
  const saved = exportDecisionSnapshot(sample());
  const restored = importDecisionSnapshot(saved);
  assert.deepEqual(restored, sample());
  assert.deepEqual(traceDecision(restored, "revision").map((e) => e.id), ["decision", "revision"]);
  assert.equal(Object.isFrozen(restored), true);
});

test("detects altered content even when JSON remains valid", () => {
  const snapshot = JSON.parse(exportDecisionSnapshot(sample()));
  snapshot.events[0].summary = "Forged decision";
  assert.throws(() => importDecisionSnapshot(JSON.stringify(snapshot)), /checksum mismatch/);
});

test("rejects malformed, unsupported, and oversized snapshots", () => {
  assert.throws(() => importDecisionSnapshot("{"), /JSON/);
  assert.throws(() => importDecisionSnapshot(JSON.stringify({ version: 2, events: [] })), /format/);
  assert.throws(() => importDecisionSnapshot("x".repeat(9 * 1024 * 1024)), /size/);
});

test("does not accept unvalidated history for export", () => {
  assert.throws(() => exportDecisionSnapshot([{ id: "a", type: "correction", summary: "Orphan" }]), /parent/);
});
