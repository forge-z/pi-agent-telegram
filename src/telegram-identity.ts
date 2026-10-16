import { hash, type Store } from "./store.js";
import type { TelegramOwner } from "./telegram-chats.js";

/** Environment allowlists in clean mode; old single-owner receipts remain readable. */
export function telegramIdentity(
  store: Store,
  owner?: Pick<TelegramOwner, "chat" | "user">,
) {
  try {
    const raw = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='telegram:connection'",
    );
    const credential = store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider='telegram:bot'",
    );
    if (!raw || !credential) return;
    const config = JSON.parse(raw.value);
    const identity = JSON.parse(credential.value);
    const chat = owner?.chat ?? config.chatId;
    const user = owner?.user ?? config.userId;
    if (
      config.enabled !== true ||
      !Number.isSafeInteger(config.bot?.id) ||
      config.bot.id <= 0 ||
      identity.botId !== config.bot.id ||
      typeof identity.token !== "string" ||
      !identity.token ||
      typeof chat !== "string" ||
      !/^-?[1-9]\d*$/.test(chat) ||
      typeof user !== "string" ||
      !/^[1-9]\d*$/.test(user)
    )
      return;
    const chats = config.allowedChats ?? [config.chatId];
    const users = config.allowedUsers ?? [config.userId];
    if (
      !Array.isArray(chats) ||
      !chats.includes(chat) ||
      !Array.isArray(users) ||
      !users.includes(user)
    )
      return;
    return {
      chat,
      user,
      botId: config.bot.id as number,
      credentialBinding: hash(credential.value),
    };
  } catch {
    return;
  }
}
