export interface TelegramTypingOptions {
  signal?: AbortSignal;
  messageThreadId?: number;
}
type SendTyping = (
  chat: string,
  options: TelegramTypingOptions,
) => Promise<unknown>;
interface Lease {
  active: () => boolean;
  stop: () => void;
}
interface Group {
  chat: string;
  messageThreadId?: number;
  leases: Map<number, Lease>;
  sentAt: number;
  request?: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  };
}

/** Ephemeral, best-effort status; never participates in the durable reply ledger. */
export class TelegramTyping {
  private groups = new Map<string, Group>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private send?: SendTyping) {}
  start(
    id: number,
    chat: string,
    active: () => boolean,
    options: TelegramTypingOptions = {},
  ) {
    if (!this.send || options.signal?.aborted) return () => {};
    try {
      if (!active()) return () => {};
    } catch {
      return () => {};
    }
    const key = JSON.stringify([chat, options.messageThreadId]);
    let group = this.groups.get(key);
    if (group?.leases.has(id)) return group.leases.get(id)!.stop;
    if (!group) {
      group = {
        chat,
        messageThreadId: options.messageThreadId,
        leases: new Map(),
        sentAt: Date.now(),
      };
      this.groups.set(key, group);
      if (!this.timer) {
        this.timer = setInterval(() => this.check(), 250);
        this.timer.unref();
      }
    }
    const current = group;
    const stop = () => {
      options.signal?.removeEventListener("abort", stop);
      if (!current.leases.delete(id)) return;
      if (current.leases.size) return;
      if (current.request) {
        clearTimeout(current.request.timer);
        current.request.controller.abort();
        current.request = undefined;
      }
      this.groups.delete(key);
      if (!this.groups.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
    current.leases.set(id, { active, stop });
    options.signal?.addEventListener("abort", stop, { once: true });
    if (current.leases.size === 1) this.pulse(current);
    return stop;
  }
  check() {
    for (const group of this.groups.values()) {
      for (const lease of group.leases.values()) {
        try {
          if (!lease.active()) lease.stop();
        } catch {
          lease.stop();
        }
      }
      if (group.leases.size && Date.now() - group.sentAt >= 4000)
        this.pulse(group);
    }
  }
  private pulse(group: Group) {
    if (group.request) return;
    const controller = new AbortController();
    const finish = () => {
      if (group.request?.controller !== controller) return;
      clearTimeout(group.request.timer);
      group.request = undefined;
      controller.abort();
    };
    const timer = setTimeout(finish, 2000);
    timer.unref();
    group.request = { controller, timer };
    group.sentAt = Date.now();
    try {
      void this.send!(group.chat, {
        signal: controller.signal,
        ...(group.messageThreadId === undefined
          ? {}
          : { messageThreadId: group.messageThreadId }),
      })
        .catch(() => {})
        .finally(finish);
    } catch {
      finish();
    }
  }
  close() {
    for (const group of this.groups.values())
      for (const lease of group.leases.values()) lease.stop();
  }
}
