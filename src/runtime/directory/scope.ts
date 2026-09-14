/**
 * 34.2 — the rows that are one person's (rule 5: "the person's rows only"; rule 3: "the activity stream is the record's rows").
 * The scope is resolved from the shared tables exactly as the borrower surface resolves a party's subjects
 * (src/infra/db/borrower-parties.ts subjectsOf): `application_borrowers.party_id`, `borrowers.party_id` → `loan_borrowers`,
 * scoped `loan_parties` roles — plus the ids the other tables key on (the conversation, the borrower rows, the application
 * borrower rows). Nothing here is stored; every projection of the directory starts from this.
 */
import type { Queryable } from "../../infra/db/client.ts";
import { PgBorrowerPartyRepository, type PartyRow, type Subject } from "../../infra/db/borrower-parties.ts";

export interface PartyScope {
  readonly party: PartyRow;
  readonly subjects: readonly Subject[];
  readonly loan_ids: readonly string[];
  readonly application_ids: readonly string[];
  readonly borrower_ids: readonly string[];
  readonly application_borrower_ids: readonly string[];
  readonly conversation_id: string | null;
}

/** The party's scope, or null when the id names no borrower party (a servicer or an investor is not in the directory). */
export async function partyScope(db: Queryable, partyId: string): Promise<PartyScope | null> {
  const parties = new PgBorrowerPartyRepository(db);
  const party = await parties.get(partyId);
  if (!party || party.party_type !== "borrower") return null;
  const subjects = await parties.subjectsOf(partyId);
  const [borrowers, abs, conv] = await Promise.all([
    db.query<{ id: string }>(`SELECT id::text AS id FROM borrowers WHERE party_id = $1 ORDER BY created_at`, [partyId]),
    db.query<{ id: string }>(`SELECT id::text AS id FROM application_borrowers WHERE party_id = $1 ORDER BY created_at`, [partyId]),
    db.query<{ conversation_id: string }>(`SELECT conversation_id::text AS conversation_id FROM conversations WHERE party_id = $1`, [partyId]),
  ]);
  const loan_ids = [...new Set(subjects.map((s) => s.loan_id).filter((x): x is string => !!x))];
  const application_ids = [...new Set(subjects.map((s) => s.application_id).filter((x): x is string => !!x))];
  return { party, subjects, loan_ids, application_ids, borrower_ids: borrowers.map((r) => r.id), application_borrower_ids: abs.map((r) => r.id), conversation_id: conv[0]?.conversation_id ?? null };
}

/**
 * Rule 5 / T5 ("no other party's event appears"): a row selected by a SHARED subject (a joint application, a loan with two
 * borrowers) is this person's only when it names no other party — `payload.party_id` (consent.esign.*, video.session.*, the
 * activation) and a `party` aggregate on loan_events; `subject_kind = 'party'` on agent_decisions. `$p` is the party-id
 * parameter's placeholder; NULLs are coalesced so an unscoped row (no party named) always passes.
 */
export const ownPartyEventPredicate = (p: string): string => `(payload->>'party_id' IS NULL OR payload->>'party_id' = ${p}) AND NOT (COALESCE(aggregate_kind, '') = 'party' AND COALESCE(aggregate_id, '') <> ${p})`;
export const ownPartyDecisionPredicate = (p: string): string => `NOT (COALESCE(subject_kind, '') = 'party' AND COALESCE(subject_id, '') <> ${p})`;

/** An ISO instant from a `timestamptz` column however the driver hands it back. */
export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === "string" ? (/\d{4}-\d{2}-\d{2}T/.test(v) ? v : new Date(v).toISOString()) : String(v ?? ""));
