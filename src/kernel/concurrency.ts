/**
 * Bounded concurrency over independent units of work. `mapLimit` runs `fn` over `items` with at most `limit` in
 * flight and resolves to the results in item order; one rejection rejects the whole map once the in-flight items
 * settle (the caller's own try/catch inside `fn` is the way to keep going).
 *
 * Why it exists: the daily passes over the book (35.5's cashiering unit, 13.1's counters, 35.3's executor) run one
 * short transaction per loan, and a loan-day is round-trip bound — a CPU profile of the demo advance is mostly
 * idle time on the socket. Running a few loans at once cuts the wall clock without changing any loan's own order:
 * each unit is its own unit of work under its own per-loan lock (35.1 rule 7).
 *
 * The limit stays below the pool's size (src/infra/db/client.ts `max`): a unit holds one transaction client and may
 * still run a pool query while it holds it, so `limit` units need `limit + 1` connections to be deadlock-free.
 */
export const UNIT_CONCURRENCY = 2;

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0; let failure: unknown; let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++; if (i >= items.length || failed) return;
      try { out[i] = await fn(items[i]!, i); } catch (e) { if (!failed) { failed = true; failure = e; } return; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw failure;
  return out;
}
