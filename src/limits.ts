// Idempotency keys from the web, Telegram and tasks share one shape.
export const REQUEST_ID = /^[\w:.-]{1,160}$/;
// public/index.html repeats this as the message and task prompt maxlength.
export const MAX_TEXT = 32000;
