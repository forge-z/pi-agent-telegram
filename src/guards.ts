/** Guards that keep one turn from repeating itself or asking a background run
 * for an approval nobody can give. Pure helpers, so they test without a store. */

/** Identical calls allowed before the next one is refused. */
export const MAX_IDENTICAL_CALLS = 5;

/** An unanswered approval card gets one reminder after this long… */
export const APPROVAL_REMIND_MS = 4 * 3_600_000;
/** …and is expired after this long. */
export const APPROVAL_EXPIRE_MS = 24 * 3_600_000;

export const SCHEDULED_APPROVAL_REFUSAL =
  "needs approval; not available in scheduled runs";

/** JSON with sorted keys, so `{a, b}` and `{b, a}` are the same call. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

/** Counts identical calls within one turn. A new turn resets the guard. */
export class LoopGuard {
  private counts = new Map<string, number>();

  reset() {
    this.counts.clear();
  }

  /** Returns a refusal once the same call repeats too often in this turn. */
  check(toolName: string, input: unknown): string | null {
    return this.note("", toolName, input);
  }

  /** One effective call: server + target + normalized arguments. */
  note(server: string, target: string, args: unknown): string | null {
    const key = `${server}\0${target}\0${stableJson(args)}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count <= MAX_IDENTICAL_CALLS) return null;
    return `You already made this exact ${target} call ${MAX_IDENTICAL_CALLS} times in this turn, so it will not change the result. Change approach: tell the user what you were trying to do, what came back, and what you need from them.`;
  }
}

/** What an unanswered approval card needs now, if anything. */
export function approvalAction(
  ageMs: number,
  reminded: boolean,
): "remind" | "expire" | null {
  if (ageMs >= APPROVAL_EXPIRE_MS) return "expire";
  if (ageMs >= APPROVAL_REMIND_MS && !reminded) return "remind";
  return null;
}

/** A background/scheduled run has nobody to approve, so `ask` becomes `block`. */
export function scheduledApprovalRefusal(
  scheduled: boolean,
  readOnly: boolean,
): string | null {
  return scheduled && !readOnly ? SCHEDULED_APPROVAL_REFUSAL : null;
}
