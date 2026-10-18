// Pure laboratory policy. Does not write to Supabase or call a model.
// Source classification is intentionally explicit: an LLM extraction alone
// never grants authority to store a personal fact.
export function decideFactCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("candidate object required");
  const text = String(candidate.content ?? "").trim();
  if (!text) return { status: "ignored", reason: "empty", mayPersistAsFact: false };
  const source = String(candidate.source ?? "");
  const evidence = String(candidate.evidence ?? "");
  if (candidate.refuted === true) return { status: "refutation_review", reason: "explicit_refutation", mayPersistAsFact: false };
  if (["test", "hypothetical", "quotation", "roleplay", "unknown"].includes(evidence)) {
    return { status: "candidate", reason: evidence, mayPersistAsFact: false };
  }
  if (source !== "user_explicit_confirmation" || evidence !== "direct_confirmed") {
    return { status: "candidate", reason: "unverified_source", mayPersistAsFact: false };
  }
  if (!candidate.sourceMessageId || !candidate.claimKey) {
    return { status: "candidate", reason: "missing_provenance", mayPersistAsFact: false };
  }
  return { status: "approved_for_reviewed_write", reason: "confirmed_with_provenance", mayPersistAsFact: true };
}
