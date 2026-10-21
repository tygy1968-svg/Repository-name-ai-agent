# Telegram interaction durability audit — 2026-10-19

## Source-verified normal message path
In laboratory `server.js`, the ordinary text path:
1. obtains `reply = await generateReply(userId, text, memory)`;
2. calls `await tgSendMessage(chatId, reply)`;
3. calls `await sbLogKuziaInteraction({userId: "yulia", stimulus: text, response: reply, channel: "telegram", eventType: "telegram_message", ...})`;
4. proceeds to `maybeWriteKuziaEvolutionFromTelegram(...)`.

`sbLogKuziaInteraction` returns `false` on unsuccessful Supabase HTTP response or exception and `true` on success. **The ordinary text caller does not inspect this boolean**.

## Consequences and limitations
- Successful Telegram delivery does **not** establish that the corresponding interaction was durably recorded.
- Because the log write happens after Telegram send, a failure or process interruption in between can create a gap.
- The code does not presently provide a durable local queue, retry with stable idempotency key, or reconciliation check for this path.
- Other routes (photo, commands, phone) have separate behavior; this finding does not claim all messages were lost or all writes failed.
- The context reader selects summary/metadata but not stored stimulus/response, a second independent gap.

## Proposed lab acceptance criteria (not deployed)
1. Preserve Telegram's reply behavior, but explicitly record/observe log-write success and failure.
2. Use a stable source message identifier and idempotent retry/reconciliation design before retrying writes; avoid duplicate memory.
3. Verify stored user ID and chat identity are authorized, rather than assuming `"yulia"` for every inbound message.
4. Read bounded, owner-scoped Telegram transcript content for continuity; exclude call diagnostics and unverified facts.
5. Test simulated Supabase failure, network exception, process restart and duplicate delivery before any production integration.

No production edits, Supabase writes, calls, or archive ingestion.
