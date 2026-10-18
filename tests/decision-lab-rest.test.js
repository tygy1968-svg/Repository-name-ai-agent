import test from "node:test";
import assert from "node:assert/strict";
import { readLabDecisions, appendLabDecision } from "../lib/decision-lab-rest.js";

const base = {
  url: "https://example.supabase.co/rest/v1/kuzya_decision_ledger_lab",
  key: "synthetic-test-key",
  namespace: "lab-continuity",
};

test("append and recover linked decisions through a mocked REST boundary", async () => {
  const rows = [];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === "POST") {
      rows.push(JSON.parse(options.body));
      return { ok: true, status: 201 };
    }
    const u = new URL(url);
    assert.equal(u.searchParams.get("namespace"), "eq.lab-continuity");
    return { ok: true, status: 200, json: async () => rows.map((r) => ({
      event_id: r.event_id, parent_event_id: r.parent_event_id,
      event_type: r.event_type, summary: r.summary, reason: r.reason,
      event_timestamp: r.event_timestamp
    })) };
  };
  const options = { ...base, fetchImpl };
  let history = await readLabDecisions(options);
  history = await appendLabDecision(options, history, { id: "d", type: "decision", summary: "A" });
  history = await appendLabDecision(options, history, { id: "c", type: "correction", summary: "B", parentId: "d", reason: "New evidence" });
  const recovered = await readLabDecisions(options);
  assert.deepEqual(recovered, history);
  assert.equal(recovered[1].parentId, "d");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "POST", "GET"]);
});

test("refuses non-lab endpoints and namespaces before any network call", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true }; };
  await assert.rejects(() => readLabDecisions({ ...base, url: "https://example.supabase.co/rest/v1/memory", fetchImpl }), /laboratory/);
  await assert.rejects(() => readLabDecisions({ ...base, namespace: "production", fetchImpl }), /namespace/);
  await assert.rejects(() => readLabDecisions({ ...base, url: "http://example.org/rest/v1/kuzya_decision_ledger_lab", fetchImpl }), /HTTPS/);
  assert.equal(calls, 0);
});

test("fails closed on rejected writes and invalid read responses", async () => {
  const options = { ...base, fetchImpl: async () => ({ ok: false, status: 403 }) };
  await assert.rejects(() => appendLabDecision(options, [], { type: "decision", summary: "A" }), /403/);
  await assert.rejects(() => readLabDecisions(options), /403/);
  await assert.rejects(() => readLabDecisions({ ...base, fetchImpl: async () => ({ ok: true, json: async () => ({ unexpected: true }) }) }), /response/);
});

test("never sends credentials to a non-Supabase host", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Should not call network"); };
  await assert.rejects(() => readLabDecisions({
    ...base, url: "https://evil.example/rest/v1/kuzya_decision_ledger_lab", fetchImpl
  }), /Supabase host/);
  await assert.rejects(() => readLabDecisions({
    ...base, url: "https://example.supabase.co.evil.example/rest/v1/kuzya_decision_ledger_lab", fetchImpl
  }), /Supabase host/);
  assert.equal(calls, 0);
});
