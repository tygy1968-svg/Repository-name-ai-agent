// Isolated lab REST adapter. No environment reads and no production defaults.
// Inject an endpoint, credential and fetch implementation explicitly.
import { appendDecisionEvent } from "./decision-ledger.js";

function config(options) {
  if (!options || typeof options !== "object") throw new TypeError("Missing configuration");
  const url = new URL(options.url);
  if (url.protocol !== "https:") throw new Error("HTTPS required");
  if (!url.hostname.endsWith(".supabase.co") || url.hostname === ".supabase.co") throw new Error("Supabase host required");
  if (url.username || url.password || url.search || url.hash) throw new Error("Endpoint must not contain credentials or query parameters");
  if (!url.pathname.endsWith("/rest/v1/kuzya_decision_ledger_lab")) throw new Error("Not a laboratory ledger endpoint");
  if (typeof options.key !== "string" || !options.key) throw new Error("Missing credential");
  if (typeof options.namespace !== "string" || !/^lab-[a-z0-9-]{1,64}$/.test(options.namespace)) throw new Error("Invalid lab namespace");
  if (typeof options.fetchImpl !== "function") throw new Error("Explicit fetch implementation required");
  return { url, key: options.key, namespace: options.namespace, fetchImpl: options.fetchImpl };
}

function headers(key, extras = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extras };
}

export async function readLabDecisions(options) {
  const { url, key, namespace, fetchImpl } = config(options);
  url.searchParams.set("namespace", `eq.${namespace}`);
  url.searchParams.set("select", "event_id,parent_event_id,event_type,summary,reason,event_timestamp");
  url.searchParams.set("order", "inserted_at.asc,id.asc");
  url.searchParams.set("limit", "10000");
  const response = await fetchImpl(url.toString(), { method: "GET", headers: headers(key) });
  if (!response.ok) throw new Error(`Laboratory read failed: HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Invalid laboratory response");
  let history = [];
  for (const row of rows) {
    history = appendDecisionEvent(history, {
      id: row.event_id, parentId: row.parent_event_id, type: row.event_type,
      summary: row.summary, reason: row.reason, timestamp: row.event_timestamp
    });
  }
  return history;
}

export async function appendLabDecision(options, history, event) {
  const { url, key, namespace, fetchImpl } = config(options);
  const updated = appendDecisionEvent(history, event);
  const item = updated.at(-1);
  const row = {
    namespace, event_id: item.id, parent_event_id: item.parentId,
    event_type: item.type, summary: item.summary, reason: item.reason,
    event_timestamp: item.timestamp
  };
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: headers(key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(row)
  });
  if (!response.ok) throw new Error(`Laboratory write failed: HTTP ${response.status}`);
  return updated;
}
