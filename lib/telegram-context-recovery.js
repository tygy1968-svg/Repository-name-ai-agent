// Laboratory-only pure formatter. No database access or writes.
// Returned turns are historical context, never verified personal facts.
export function recoverTelegramTurns(rows, { ownerId = "yulia", limit = 20, maxChars = 4000 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  if (!ownerId || typeof ownerId !== "string") throw new TypeError("ownerId required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("invalid limit");
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 10000) throw new RangeError("invalid maxChars");
  const eligible = rows.filter(row =>
    row && String(row.user_id ?? "") === ownerId &&
    row.channel === "telegram" &&
    !["test", "diagnostic", "call"].includes(String(row.event_type ?? "").toLowerCase()) &&
    Number.isFinite(Date.parse(String(row.timestamp ?? "")))
  );
  eligible.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return eligible.slice(-limit).flatMap(row => {
    const turns = [];
    const stimulus = typeof row.stimulus === "string" ? row.stimulus.trim().slice(0, maxChars) : "";
    const response = typeof row.response === "string" ? row.response.trim().slice(0, maxChars) : "";
    if (stimulus) turns.push({ role: "user", content: stimulus, timestamp: row.timestamp, provenance: "stored_interaction_unverified" });
    if (response) turns.push({ role: "assistant", content: response, timestamp: row.timestamp, provenance: "stored_interaction_unverified" });
    return turns;
  });
}
