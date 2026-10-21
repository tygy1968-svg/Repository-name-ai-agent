import test from "node:test";
import assert from "node:assert/strict";
import { appendDecisionEvent, traceDecision, latestDecisionState } from "../lib/decision-ledger.js";

test("preserves original decisions when corrections arrive", () => {
  const first = appendDecisionEvent([], { id: "d1", type: "decision", summary: "Use rule A", reason: "Initial evidence", timestamp: "2026-01-01T00:00:00Z" });
  const second = appendDecisionEvent(first, { id: "c1", type: "correction", summary: "Use rule B", reason: "New evidence", parentId: "d1", timestamp: "2026-01-02T00:00:00Z" });
  assert.equal(first.length, 1);
  assert.equal(first[0].summary, "Use rule A");
  assert.equal(second.length, 2);
  assert.deepEqual(traceDecision(second, "c1").map((e) => e.id), ["d1", "c1"]);
  assert.equal(latestDecisionState(second, "d1").latest.summary, "Use rule B");
});

test("rejects orphan corrections and missing parents", () => {
  assert.throws(() => appendDecisionEvent([], { type: "correction", summary: "Change" }), /parent/);
  assert.throws(() => appendDecisionEvent([], { type: "observation", summary: "Note", parentId: "missing" }), /Parent/);
});

test("rejects duplicates, empty summaries and unknown event types", () => {
  const items = appendDecisionEvent([], { id: "one", type: "decision", summary: "First" });
  assert.throws(() => appendDecisionEvent(items, { id: "one", type: "decision", summary: "Again" }), /Duplicate/);
  assert.throws(() => appendDecisionEvent([], { type: "decision", summary: " " }), /summary/);
  assert.throws(() => appendDecisionEvent([], { type: "invented", summary: "X" }), /type/);
});

test("unrelated decisions do not contaminate a decision lineage", () => {
  let items = appendDecisionEvent([], { id: "a", type: "decision", summary: "A" });
  items = appendDecisionEvent(items, { id: "b", type: "decision", summary: "B" });
  items = appendDecisionEvent(items, { id: "a2", type: "correction", summary: "A2", parentId: "a" });
  assert.deepEqual(latestDecisionState(items, "b").events.map((e) => e.id), ["b"]);
  assert.deepEqual(latestDecisionState(items, "a").events.map((e) => e.id), ["a", "a2"]);
});

test("returns null or empty trace for unknown id", () => {
  assert.equal(latestDecisionState([], "missing"), null);
  assert.deepEqual(traceDecision([], "missing"), []);
});
