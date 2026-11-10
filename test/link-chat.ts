import type { Runtime } from "../src/runtime.js";

/** Point a chat at a conversation the way a linked Telegram chat is stored. */
export function linkChat(
  app: Runtime,
  chat: string,
  user: string,
  conversationId: string,
) {
  app.store.run(
    "INSERT INTO telegram VALUES (?,?,?) ON CONFLICT(chat) DO UPDATE SET conversationId=excluded.conversationId,user=excluded.user",
    chat,
    conversationId,
    user,
  );
  app.store.run(
    "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
    chat,
    user,
    conversationId,
  );
}
