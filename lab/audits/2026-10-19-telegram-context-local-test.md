# Local synthetic test run — 2026-10-19

Module: `lib/telegram-context-recovery.js`
Tests: `tests/telegram-context-recovery.test.js`

Executed on a local copy of the laboratory files with Node.js v22.16.0 using `node --test tests/*.test.js` in an isolated temporary directory.

Results: **5 passed, 0 failed**.
- stored text becomes ordered user/assistant turns;
- foreign owner and phone diagnostic records excluded;
- chronological sorting and limit;
- invalid timestamps, absent text and character bounds;
- returned provenance marked unverified.

Limits: no production deployment, no Supabase query, no live Telegram call, no verification of actual stored rows or of context restoration after restart. This does not claim the full repository test suite was run. No archive ingestion.
