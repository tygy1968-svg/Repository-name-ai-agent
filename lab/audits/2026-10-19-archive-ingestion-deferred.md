# Archive ingestion is deferred — 2026-10-19

## Intent
The long-term plan is to let Kuzya consult archived historical chats when a safe, reliable mechanism exists. The user explicitly says **it is too early now**.

## Present scope
- Do not ingest, index, embed, summarize, or import historical archived chats into Supabase or the agent.
- Do not treat archive access as a prerequisite for improving the current Telegram system.
- Preserve existing archives without modification.
- Focus first on a verified baseline: Telegram response path, source-of-truth for owner identity, memory provenance and correction, stable context retrieval, diagnostic vs personal data, and tests.

## Future design questions (not implementation authorization)
- Explicit owner authorization and selected archive scope.
- Separation of verbatim archival material from confirmed current personal facts.
- Provenance and timestamps, contradictions and retractions, reversible imports.
- Access controls and deletion/export mechanisms.
- Retrieval quality and clear disclosure of uncertain archival recollections.

No production modifications. No archive contents accessed or imported as part of this note.
