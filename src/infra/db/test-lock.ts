/**
 * Session-level Postgres advisory lock for tests that drive a whole origination journey on the shared test
 * database. The journey fixtures write the same global rows (the LLPA matrix, the daily rate sheet, the partner
 * program) with read-then-bump versioning, so two journeys running concurrently in `node --test`'s parallel file
 * workers race on them. Every journey-driving test file takes this lock in `test.before` and releases it in
 * `test.after`; files that only touch loan- or application-scoped rows do not need it.
 */
import pg from "pg";

export const JOURNEY_LOCK_KEY = 32_001;

export interface TestLock { release(): Promise<void> }

export async function acquireJourneyLock(connectionString: string, key: number = JOURNEY_LOCK_KEY): Promise<TestLock> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [key]);
  let released = false;
  return { async release() { if (released) return; released = true; try { await client.query("SELECT pg_advisory_unlock($1)", [key]); } finally { await client.end(); } } };
}
