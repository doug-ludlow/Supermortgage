/**
 * Failure vocabulary shared by every adapter. The spec distinguishes three
 * things that can go wrong when we talk to a counterparty, and the outbox
 * treats each differently:
 *
 *   TransientFailure   — network/5xx/timeout: retry with backoff, then dead-letter.
 *   AdapterUnavailable — a declared outage: stop retrying now, open the
 *                        adapter's human fallback (portal task / bank portal /
 *                        web app) immediately; timers keep running.
 *   PermanentRejection — the counterparty answered "no" (hard reject, fatal
 *                        rule, recorder reject): never retried as-is; the
 *                        domain must correct and submit a new message.
 */
export class TransientFailure extends Error {
  readonly retryable = true;
  readonly cause2: unknown;
  constructor(message: string, cause?: unknown) { super(message); this.name = "TransientFailure"; this.cause2 = cause; }
}
export class AdapterUnavailable extends Error {
  readonly retryable = false;
  readonly fallbackKind: string;
  constructor(adapter: string, fallbackKind: string, message = `${adapter} unavailable`) { super(message); this.name = "AdapterUnavailable"; this.fallbackKind = fallbackKind; }
}
export class PermanentRejection extends Error {
  readonly retryable = false;
  readonly code: string;
  readonly details: readonly string[];
  constructor(code: string, message: string, details: readonly string[] = []) { super(message); this.name = "PermanentRejection"; this.code = code; this.details = details; }
}

export type FailureKind = "transient" | "unavailable" | "rejected" | "unknown";
export function classify(e: unknown): FailureKind {
  if (e instanceof TransientFailure) return "transient";
  if (e instanceof AdapterUnavailable) return "unavailable";
  if (e instanceof PermanentRejection) return "rejected";
  return "unknown";
}
