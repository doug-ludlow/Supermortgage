/**
 * Session-level Postgres advisory locks for tests that share something other than a database. Every suite has its
 * own database now (src/infra/db/test-db.ts), so the journey lock that once serialised journey-driving files on the
 * shared test database is no longer taken by any file; it stays for a suite that needs it. The browser lock is:
 * the three suites that build and drive the Next.js shell under Chromium (32.13, 32.16 rail, 32.17) each build the
 * standalone app into the one `.next-t13` (Next refuses a second concurrent build of the same directory), spawn a
 * server and a browser, and three at once on a small runner starve the video and the frame waits — so they take it
 * in `test.before` and release it in `test.after`.
 *
 * Advisory locks are scoped to the database the session is connected to (the lock tag carries the database OID), so
 * a lock taken on a file's own clone would serialise nothing; the client here always connects to the maintenance
 * database (`postgres`) of the same server, as the template build in test-db.ts does, whatever URL the caller passes.
 */
import pg from "pg";
import { adminUrlOf } from "./test-db.ts";

export const JOURNEY_LOCK_KEY = 32_001;
export const BROWSER_LOCK_KEY = 32_003;

export interface TestLock { release(): Promise<void> }

export async function acquireJourneyLock(connectionString: string, key: number = JOURNEY_LOCK_KEY): Promise<TestLock> {
  const client = new pg.Client({ connectionString: adminUrlOf(connectionString) });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [key]);
  let released = false;
  return { async release() { if (released) return; released = true; try { await client.query("SELECT pg_advisory_unlock($1)", [key]); } finally { await client.end(); } } };
}

/** One browser-driven shell suite at a time (see the module comment). */
export const acquireBrowserLock = (connectionString: string): Promise<TestLock> => acquireJourneyLock(connectionString, BROWSER_LOCK_KEY);
