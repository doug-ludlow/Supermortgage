/**
 * §35.1 rule 7 — one loan, one writer: "`PgUnitOfWork.run` opens the transaction first, takes
 * `pg_advisory_xact_lock(hashtext('uow'), hashtext(<loan_id>))` and, for an application scope,
 * `pg_advisory_xact_lock(hashtext('uow'), hashtext(<application_id>))` (both, in that order, for the 30.2 hand-off scope),
 * then hydrates, runs, persists and commits; a global command (no loan, no application) takes `hashtext('uow:global')`."
 * Transaction-scoped: the lock dies with the transaction, so nothing is ever left locked (PostgreSQL 16 §13.3.5).
 * Precedents: src/domain/underwriting/du/writer.ts:170, src/runtime/borrower/commands.ts:221.
 *
 * The global lock (35.1 open questions, build decision): a global command takes `uow:global` before it reads when it
 * declares `expected_versions` (a read-then-bump it wants serialized), and otherwise just before it persists, and only
 * when it wrote a global row — a staff or portal command that touches no global row takes no platform-wide lock (two
 * admins' commands must interleave: 34.1-T5), and the loser of an undeclared read-then-bump race is refused STALE_RECORD
 * by the primary key (rule 8's mechanical guard), never silently overwritten.
 */
import type { Queryable } from "../../../infra/db/client.ts";

export interface LockScope { readonly loanId?: string; readonly applicationId?: string; }

/** The SQL of each lock taken, in order (a test asserts the loan lock was the wait). */
export const SCOPE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('uow'), hashtext($1))";
export const GLOBAL_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('uow:global'))";

export async function takeScopeLocks(q: Queryable, scope: LockScope, o: { readonly globalAtStart?: boolean } = {}): Promise<readonly string[]> {
  const taken: string[] = [];
  if (scope.loanId) { await q.query(SCOPE_LOCK_SQL, [scope.loanId]); taken.push(`uow:${scope.loanId}`); }
  if (scope.applicationId) { await q.query(SCOPE_LOCK_SQL, [scope.applicationId]); taken.push(`uow:${scope.applicationId}`); }
  if (!taken.length && o.globalAtStart) { await q.query(GLOBAL_LOCK_SQL); taken.push("uow:global"); }
  return taken;
}
/** The global lock at persist time — a global command that wrote a global row (see the module note). */
export async function takeGlobalLock(q: Queryable): Promise<void> { await q.query(GLOBAL_LOCK_SQL); }
