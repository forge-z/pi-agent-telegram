import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Runtime } from "./runtime.js";

export type CommandAccess = {
  source: "telegram";
  user: string;
  chat: string;
  messageThreadId?: number;
};
export class CommandError extends Error {}
export class Commands {
  private work = new Map<string, Promise<unknown>>();
  private inputs = new Map<string, { id: string; text: string }>();
  constructor(private app: Runtime) {}
  key(requestId: string, access: CommandAccess) {
    return `telegram:${access.chat}:${access.user}:${access.messageThreadId === undefined ? "" : `topic:${access.messageThreadId}:`}${requestId}`;
  }
  allowed(access: CommandAccess) {
    const rows = this.app.store.all<{ id: string; title: string }>(
      "SELECT c.id,c.title FROM conversations c JOIN telegram_grants g ON g.conversationId=c.id WHERE g.chat=? AND g.user=? AND c.id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY c.rowid DESC",
      access.chat,
      access.user,
    );
    return rows.filter((row) => {
      if (!this.app.telegramChats.dedicated(row.id))
        return access.messageThreadId === undefined;
      if (!this.app.telegramChats.owns(row.id, access)) return false;
      try {
        this.app.telegramChats.authorize(row.id, access);
        return true;
      } catch {
        return false;
      }
    });
  }
  authorize(id: string, access: CommandAccess) {
    if (
      this.app.telegramChats.dedicated(id) &&
      this.app.telegramChats.owns(id, access)
    )
      // A listing may omit temporarily unavailable rows. An admission must
      // preserve the actual error so polling can retry rather than reject it.
      this.app.telegramChats.authorize(id, access);
    if (!this.allowed(access).some((item) => item.id === id))
      throw new CommandError("Conversa não autorizada neste chat.");
    this.app.assertConversationAvailable(id);
  }
  busy(id: string) {
    return [...this.inputs.values()].some((input) => input.id === id);
  }
  async active(access: CommandAccess) {
    const ids = new Set(this.allowed(access).map((item) => item.id));
    const inspection = await this.app.harness.inspect(context);
    return inspection.tasks
      .filter(({ record }) => ids.has(String(record.conversationId)))
      .map(({ record, state }) => ({
        id: String(record.id),
        kind: record.kind,
        conversationId: String(record.conversationId),
        background: record.background,
        abortRequested: record.abortRequested,
        status: record.state.status,
        phase: state.kind,
      }));
  }
  async close() {
    await Promise.allSettled(this.work.values());
  }
}
