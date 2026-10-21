import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../lab/sql/decision-ledger-proposal.sql", import.meta.url), "utf8");

test("lab schema remains separate from existing production memory tables", () => {
  assert.match(sql, /create table if not exists public\.kuzya_decision_ledger_lab/i);
  assert.doesNotMatch(sql, /\b(?:alter|drop|truncate|delete from|update)\s+(?:table\s+)?public\.(?:memory|kuzia_evolution|agent_state)\b/i);
});

test("lab schema blocks row mutation and client access", () => {
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.kuzya_decision_ledger_lab from anon, authenticated/i);
  assert.match(sql, /before update or delete on public\.kuzya_decision_ledger_lab/i);
  assert.match(sql, /raise exception 'Laboratory decision events are append-only'/i);
});

test("lab schema enforces parent linkage and correction parent", () => {
  assert.match(sql, /unique \(namespace, event_id\)/i);
  assert.match(sql, /foreign key \(namespace, parent_event_id\)/i);
  assert.match(sql, /event_type <> 'correction' or parent_event_id is not null/i);
});
