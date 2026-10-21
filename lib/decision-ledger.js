// Pure, append-only decision history for laboratory continuity experiments.
// No database access or production side effects.
import crypto from "node:crypto";

const TYPES = new Set(["decision", "observation", "correction", "checkpoint"]);
const MAX_TEXT = 4000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function appendDecisionEvent(history, event) {
  if (!Array.isArray(history)) throw new TypeError("History must be an array");
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Invalid event");
  if (!TYPES.has(event.type)) throw new TypeError("Unknown event type");
  if (typeof event.summary !== "string" || !event.summary.trim() || event.summary.length > MAX_TEXT) {
    throw new TypeError("Invalid summary");
  }
  const id = event.id ?? crypto.randomUUID();
  if (typeof id !== "string" || !id.trim() || id.length > 128) throw new TypeError("Invalid id");
  if (history.some((item) => item.id === id)) throw new Error("Duplicate event id");
  const parentId = event.parentId ?? null;
  if (parentId !== null && (typeof parentId !== "string" || !history.some((item) => item.id === parentId))) {
    throw new Error("Parent must exist in history");
  }
  if (event.type === "correction" && parentId === null) throw new Error("Correction requires a parent");
  const reason = event.reason ?? "";
  if (typeof reason !== "string" || reason.length > MAX_TEXT) throw new TypeError("Invalid reason");
  const timestamp = event.timestamp ?? new Date().toISOString();
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) throw new TypeError("Invalid timestamp");
  const record = Object.freeze({ id, type: event.type, summary: event.summary.trim(), reason, parentId, timestamp });
  return Object.freeze([...history, record]);
}

export function traceDecision(history, id) {
  if (!Array.isArray(history)) throw new TypeError("History must be an array");
  const byId = new Map(history.map((event) => [event.id, event]));
  if (!byId.has(id)) return [];
  const trace = [];
  const seen = new Set();
  let cursor = id;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error("Cycle in history");
    seen.add(cursor);
    const item = byId.get(cursor);
    if (!item) throw new Error("Broken parent link");
    trace.unshift(item);
    cursor = item.parentId;
  }
  return trace;
}

export function latestDecisionState(history, id) {
  if (!Array.isArray(history)) throw new TypeError("History must be an array");
  if (!history.some((event) => event.id === id)) return null;
  const descendants = new Set([id]);
  for (const event of history) {
    if (event.parentId !== null && descendants.has(event.parentId)) descendants.add(event.id);
  }
  const relevant = history.filter((event) => descendants.has(event.id));
  return Object.freeze({ rootId: id, latest: relevant.at(-1), events: Object.freeze(relevant) });
}
