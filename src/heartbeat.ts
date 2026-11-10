import type { Store } from "./store.js";
import { telegramConversationRoute } from "./task-telegram.js";

/** Chat and topic a heartbeat posts to. */
export interface LongCallRoute {
  chat: string;
  messageThreadId?: number;
}
/** What the harness knows about the tool running right now. */
export interface LongCallState {
  /** When the running tool started. */
  startedAt?: number;
  /** Last progress notification the server sent, if any. */
  progress?: string;
}
export interface LongCallTransport {
  /** Returns the sent message so the next tick can edit it. */
  send(
    chat: string,
    text: string,
    options: { messageThreadId?: number },
  ): Promise<{ message_id?: number } | undefined>;
  edit(chat: string, messageId: number, text: string): Promise<unknown>;
  delete?(chat: string, messageId: number): Promise<unknown>;
}

function interval(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
/** First status message after this long without an answer. */
export function longCallFirstMs(
  env: Record<string, string | undefined> = process.env,
) {
  return interval(env, "LONG_CALL_FIRST_MS", 60_000);
}
/** Edit interval of that same message. */
export function longCallEveryMs(
  env: Record<string, string | undefined> = process.env,
) {
  return interval(env, "LONG_CALL_EVERY_MS", 180_000);
}
export function longCallText(elapsedMs: number, progress?: string) {
  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  const detail = progress?.replace(/\s+/g, " ").trim().slice(0, 200);
  return `still running (${minutes} min)…${detail ? `\n${detail}` : ""}`;
}
/**
 * Only an interactive turn gets a heartbeat. A scheduled run, a job or a system
 * note speaks through `notify`; a status message there would be unsolicited.
 */
export function longCallRoute(
  store: Store,
  conversationId: string,
): LongCallRoute | undefined {
  const source = store.get<{ source: string }>(
    "SELECT source FROM requests WHERE conversationId=? AND status='pending' ORDER BY rowid DESC LIMIT 1",
    conversationId,
  )?.source;
  if (source !== "telegram" && source !== "web") return undefined;
  const route = telegramConversationRoute(store, conversationId);
  if (!route) return undefined;
  return {
    chat: route.chat,
    ...(route.messageThreadId
      ? { messageThreadId: route.messageThreadId }
      : {}),
  };
}

const TICK_MS = 1000;

interface Lease {
  id: string;
  route: LongCallRoute;
  state: () => LongCallState | undefined;
  refs: number;
  toolStart?: number;
  progress?: string;
  messageId?: number;
  sentAt: number;
  busy: boolean;
}

/** Ephemeral status for a tool call that outlives the first minute. Best effort. */
export class LongCallHeartbeat {
  private leases = new Map<string, Lease>();
  private timer?: ReturnType<typeof setInterval>;
  private firstMs: number;
  private everyMs: number;
  constructor(
    private transport: LongCallTransport,
    options: { firstMs?: number; everyMs?: number } = {},
  ) {
    this.firstMs = options.firstMs ?? longCallFirstMs();
    this.everyMs = options.everyMs ?? longCallEveryMs();
  }
  start(
    id: string,
    route: LongCallRoute,
    state: () => LongCallState | undefined,
  ) {
    const existing = this.leases.get(id);
    if (existing) {
      existing.refs++;
      return () => this.release(existing);
    }
    const lease: Lease = { id, route, state, refs: 1, sentAt: 0, busy: false };
    this.leases.set(id, lease);
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    return () => this.release(lease);
  }
  close() {
    const leases = [...this.leases.values()];
    this.leases.clear();
    this.stopTimer();
    for (const lease of leases) void this.clear(lease);
  }
  private release(lease: Lease) {
    if (--lease.refs > 0) return;
    this.leases.delete(lease.id);
    void this.clear(lease);
    if (!this.leases.size) this.stopTimer();
  }
  private stopTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private tick() {
    const now = Date.now();
    for (const lease of this.leases.values()) {
      if (lease.busy) continue;
      let state: LongCallState | undefined;
      try {
        state = lease.state();
      } catch {
        state = undefined;
      }
      const startedAt = state?.startedAt;
      // The call ended (or the turn did): the status message has served its purpose.
      if (startedAt === undefined) {
        this.leases.delete(lease.id);
        void this.clear(lease);
        if (!this.leases.size) this.stopTimer();
        continue;
      }
      if (startedAt !== lease.toolStart) {
        lease.toolStart = startedAt;
        lease.progress = undefined;
      }
      if (state?.progress) lease.progress = state.progress;
      const elapsed = now - startedAt;
      if (lease.messageId === undefined) {
        if (elapsed >= this.firstMs) void this.send(lease, elapsed);
      } else if (now - lease.sentAt >= this.everyMs)
        void this.edit(lease, elapsed);
    }
  }
  private async send(lease: Lease, elapsed: number) {
    lease.busy = true;
    try {
      const sent = await this.transport.send(
        lease.route.chat,
        longCallText(elapsed, lease.progress),
        lease.route.messageThreadId === undefined
          ? {}
          : { messageThreadId: lease.route.messageThreadId },
      );
      const messageId = sent?.message_id;
      if (!Number.isSafeInteger(messageId) || messageId! <= 0) {
        this.leases.delete(lease.id);
        if (!this.leases.size) this.stopTimer();
        return;
      }
      lease.messageId = messageId;
      lease.sentAt = Date.now();
      // The call may have finished while the message was in flight.
      if (!this.leases.has(lease.id)) await this.clear(lease);
    } catch {
      // A status message must never hammer Telegram; the turn continues without it.
      this.leases.delete(lease.id);
      if (!this.leases.size) this.stopTimer();
    } finally {
      lease.busy = false;
    }
  }
  private async edit(lease: Lease, elapsed: number) {
    lease.busy = true;
    try {
      await this.transport.edit(
        lease.route.chat,
        lease.messageId!,
        longCallText(elapsed, lease.progress),
      );
      lease.sentAt = Date.now();
    } catch {
      // Keep the message, but back off a full interval instead of every tick.
      lease.sentAt = Date.now();
    } finally {
      lease.busy = false;
    }
  }
  private async clear(lease: Lease) {
    const messageId = lease.messageId;
    lease.messageId = undefined;
    if (messageId === undefined || !this.transport.delete) return;
    try {
      await this.transport.delete(lease.route.chat, messageId);
    } catch {
      // Already deleted or Telegram refused; nothing left to do.
    }
  }
}
