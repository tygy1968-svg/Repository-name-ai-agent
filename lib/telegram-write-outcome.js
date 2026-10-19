// Pure laboratory model of a Telegram persistence decision.
// No network requests, retries, or production side effects.
export function classifyInteractionWrite({ telegramSent, dbWriteResult, sourceMessageId }) {
  if (!sourceMessageId || !String(sourceMessageId).trim()) {
    return { status: "untraceable", durable: false, needsReconciliation: true, safeToRetryBlindly: false };
  }
  if (telegramSent !== true) {
    return { status: "delivery_unconfirmed", durable: false, needsReconciliation: false, safeToRetryBlindly: false };
  }
  if (dbWriteResult === true) {
    return { status: "recorded", durable: true, needsReconciliation: false, safeToRetryBlindly: false };
  }
  if (dbWriteResult === false) {
    return { status: "write_failed", durable: false, needsReconciliation: true, safeToRetryBlindly: false };
  }
  return { status: "write_unknown", durable: false, needsReconciliation: true, safeToRetryBlindly: false };
}
