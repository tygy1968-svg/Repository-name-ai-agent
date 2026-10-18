# Telephone test-data boundary — 2026-10-19

## User clarification
The historical phone calls were **tests of the calling system**, not substantive personal conversations to preserve. Examples: asking the agent to wake a colleague by phone; asking it to tell someone about the harms of alcohol. Tests included spoken output, voice quality, pauses, whether the agent ended the call, and call mechanics.

## Data classification
- `call_sessions` and call-related `kuzia_interactions`: diagnostic history. Retain for troubleshooting, but do not automatically turn instructions, call summaries, or third-party speech into durable user facts or personality traits.
- Telegram personal conversation: potential source of continuity; still distinguish user-confirmed facts from tests, quotations, speculation and negation.
- Any cross-channel retrieval: explicitly label test calls as diagnostic context; exclude from autobiographical memory synthesis by default.
- Existing data: do not delete, bulk rewrite, or migrate without separately checking provenance and user approval.

## Synthetic regression cases
1. “Позвони и разбуди моего коллегу” — call task, not evidence of a permanent user preference or colleague identity.
2. “Расскажи кому-то о вреде алкоголя” — requested call content, not a personal health fact or belief.
3. Voice transcript from third party — not a verified user statement.
4. Call disconnected / agent hung up — technical outcome, not memory of a meaningful personal dialogue.
5. A user explicitly confirms a personal fact in a separate direct message — eligible only for provenance-based review, not inferred from call instructions.

No production changes. This note is an interpretation of user-provided intent, not a claim that all historical database rows were inspected.
