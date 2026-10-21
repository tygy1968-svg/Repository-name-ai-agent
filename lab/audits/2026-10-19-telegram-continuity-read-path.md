# Telegram continuity: source-level audit — 2026-10-19

## Confirmed from lab server.js
- `sbLogKuziaInteraction` prepares a POST to `kuzia_interactions` with `stimulus`, `response`, timestamp, channel, user ID, and other metadata (approx. lines 1180–1245). It returns false on failed HTTP response. This proves a write path exists, not that every interaction was saved.
- `sbGetRecentKuziaInteractionsForContext` (approx. lines 1260–1295) queries the same table for `user_id=eq.yulia`, but selects only metadata and summaries. It **does not select `stimulus` or `response`**.
- `generateReply` (approx. lines 2733–2748) fetches the above context, then appends the new user message to `dialogHistory[userId]`, truncating to 30 messages. `dialogHistory` is in-process RAM, not a durable transcript.
- Some hardcoded responses return before this append. Their history handling must be reviewed separately.
- `/archive_summary` code exists, but user has explicitly deferred new archive ingestion. Do not exercise it.

## Consequences
1. There is a plausible continuity gap across restarts: durable interaction text can be written but is not fetched by this particular context function.
2. Do not assume a new database table is needed; first validate existing rows, ownership, and successful write coverage in an authorized read-only audit.
3. Do not treat call/test events as autobiographical facts.
4. Do not modify production or ingest archives.

## Next implementation boundary
Design a pure, independently testable formatter of trusted, already-fetched interaction rows that:
- verifies the expected owner ID;
- excludes diagnostic call events by default;
- orders chronologically;
- handles missing/empty text and bounded length;
- distinguishes user stimulus from assistant response;
- marks transcript as context, not confirmed personal facts.

A pure formatter alone does not make production retrieval durable. Integration and live validation remain separate, explicitly reviewed steps.
