// Portable snapshots for restarting the laboratory decision ledger.
// Only validated event data is accepted; snapshots are not executable instructions.
import crypto from "node:crypto";
import { appendDecisionEvent } from "./decision-ledger.js";

const VERSION = 1;
const MAX_EVENTS = 10000;
const MAX_BYTES = 8 * 1024 * 1024;

function canonical(events) {
  return JSON.stringify({ version: VERSION, events });
}

export function exportDecisionSnapshot(history) {
  if (!Array.isArray(history) || history.length > MAX_EVENTS) throw new TypeError("Invalid history");
  let validated = [];
  for (const event of history) validated = appendDecisionEvent(validated, event);
  const payload = canonical(validated);
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("Snapshot too large");
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  return JSON.stringify({ version: VERSION, events: validated, sha256: digest });
}

export function importDecisionSnapshot(snapshot) {
  if (typeof snapshot !== "string" || Buffer.byteLength(snapshot) > MAX_BYTES) {
    throw new TypeError("Invalid snapshot size");
  }
  let data;
  try { data = JSON.parse(snapshot); } catch { throw new Error("Invalid snapshot JSON"); }
  if (!data || data.version !== VERSION || !Array.isArray(data.events) || data.events.length > MAX_EVENTS) {
    throw new Error("Unsupported snapshot format");
  }
  if (typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error("Missing checksum");
  const expected = crypto.createHash("sha256").update(canonical(data.events)).digest("hex");
  if (expected !== data.sha256) throw new Error("Snapshot checksum mismatch");
  let restored = [];
  for (const event of data.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid snapshot event");
    const fields = ["id", "type", "summary", "reason", "parentId", "timestamp"];
    if (Object.keys(event).sort().join(",") !== fields.sort().join(",")) throw new Error("Unexpected snapshot fields");
    restored = appendDecisionEvent(restored, event);
  }
  return restored;
}
