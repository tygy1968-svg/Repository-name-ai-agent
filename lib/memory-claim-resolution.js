// Laboratory-only: resolve explicitly linked claims without modifying source memory.
// The caller must assign stable claimKey values; text similarity is not proof of identity.
export function resolveMemoryClaim(records, claimKey) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  if (typeof claimKey !== "string" || !claimKey.trim()) throw new TypeError("claimKey required");
  const matches = records.filter((r) => r && r.claimKey === claimKey);
  const refutations = matches.filter((r) => r.type === "refuted");
  if (refutations.length) return { status: "refuted", answer: null, sources: refutations.map((r) => r.id) };
  const facts = matches.filter((r) => r.type === "fact" && typeof r.content === "string" && r.content.trim());
  if (!facts.length) return { status: "unknown", answer: null, sources: [] };
  const unique = [...new Set(facts.map((r) => r.content.trim()))];
  if (unique.length !== 1) return { status: "conflict", answer: null, sources: facts.map((r) => r.id) };
  return { status: "verified_candidate", answer: unique[0], sources: facts.map((r) => r.id) };
}
