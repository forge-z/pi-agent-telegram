// Idempotency keys from the web, Telegram and tasks share one shape.
export const REQUEST_ID = /^[\w:.-]{1,160}$/;
// public/index.html repeats this as the message and task prompt maxlength.
export const MAX_TEXT = 32000;

/** Task run summaries are capped without cutting mid-word when possible. */
export function truncateTaskSummary(text: string, limit = 1000) {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  return (
    lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice
  ).trimEnd();
}
