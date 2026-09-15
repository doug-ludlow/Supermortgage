/**
 * The only shape that can write a DU graph row (23.5 AI agent design: "every writer takes the row and its owners
 * together and refuses to run outside a transaction").
 *
 * Ported from Homestead-Mortgages' `model/writer.ts`, with Supermortgage's transaction client in place of Prisma's:
 * a `Queryable` that `Db.tx` or `PgUnitOfWork.run`'s `before` / `commit` hooks hand out (the bus tools reach it through
 * `rt.services.deferWrite`, src/runtime/app.ts). A live asset, liability or expense must carry at least one owner arc,
 * and the database says so with a constraint trigger deferred to COMMIT (db/migrations/*_du_graph.sql:
 * du_assets_have_an_owner and siblings). A pool client autocommits every statement, so `INSERT du_assets` followed by
 * `INSERT du_asset_parties` fails at the first COMMIT — correctly, and confusingly, because the row it names looks
 * like one the caller just wrote successfully. So the pairing is the signature: each writer takes its row and its
 * owners together, takes a transaction client rather than the pool, and refuses at runtime to run outside a
 * transaction. The owners array is non-empty in the type, which is the same rule stated where a caller reads it.
 *
 * An asset and a liability additionally have a second path — `matchOnIdentity` — for a pull reporting a row it may
 * have reported before. It is opt-in rather than the default because "write this row" and "reconcile this row against
 * what we hold" are different intents. `identity.ts` is where the key that path matches on comes from. That path takes
 * a transaction-scoped advisory lock per application before the lookup: look up then insert is two statements, and two
 * pulls of one account that interleave between them both miss and both insert; the unique index refuses the second by
 * aborting a whole pull with a message naming an index, and a borrower who double-clicked connect is the ordinary way
 * to produce it. Retrying inside the transaction is not available (a unique violation aborts the transaction), so the
 * race is settled before the lookup instead of discovered after the insert.
 *
 * The other writers here (owned property, owner arcs, declarations, residences, borrowers, joint credit links, the
 * employer) are the rest of the eleven 23.5 tools' database half; src/app/tools/section23-5.ts is the bus half.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { isUuid } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { MANUAL_PREFIX, employerIdentityKeys, EMPLOYER_IDENTITY_RULES } from "./identity.ts";

/** A name-based uuid (RFC 4122 v5 shape over SHA-1) for a row keyed by a string id elsewhere — 22.4's verification ids are `<app>:<borrower>:assets:<ref>` and `verifications.verification_id` is a uuid; the same name is the same row on every re-receive. */
export function deterministicUuid(namespace: string, name: string): string {
  const h = createHash("sha1").update(`supermortgage:${namespace}:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** At least one, because zero is the state these writers exist to prevent. */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * An owner arc, named by the EDGE rather than by the person: the arc's endpoint is the `ROLE` element, which is
 * emitted from `application_borrowers`. `role` is ours — DU has exactly one notion here (the row belongs to this
 * borrower) and the column defaults to it, so a caller only says anything when it has something to say.
 */
export interface DuOwner {
  readonly applicationBorrowerId: string;
  readonly role?: string | undefined;
}

/**
 * The row a re-pull is replacing, retired in the SAME transaction that writes the replacement and its arcs. Split
 * across two transactions the deferred check aborts the whole pull at COMMIT, naming a row the connector thought it
 * had just created. Taking the superseded row here is what stops a caller expressing the half-done version.
 */
export interface DuSupersede {
  readonly id: string;
  readonly retiredByVerificationId?: string | null | undefined;
  readonly retiredAt?: string | undefined;
}

/**
 * The flag that turns a write into a re-pull. Set it and the writer looks the row up by `(application, identity key)`
 * and updates the one it finds instead of inserting beside it — a pull that can only insert a twin or delete and
 * recreate renumbers every `ASSET_n` on the wire. A retired row found this way is REVIVED rather than left alone,
 * which is what the unique index spanning retired rows exists to permit. It cannot be combined with `supersedes`.
 */
export interface MatchOnIdentity {
  readonly matchOnIdentity?: boolean | undefined;
  /** Keys this row may already be stored under, tried in order after the one it is being written with and only when that one finds nothing (identity.ts `priorKeys`). A row found this way is MOVED onto the key it was written with, once. */
  readonly priorIdentityKeys?: readonly string[] | undefined;
}

// ─── the rows, column by column (a key outside the list is refused: a helper over Record<string, unknown> would accept a column that does not exist) ───
export const DU_ASSET_COLUMNS = ["id", "application_id", "kind", "asset_type", "asset_type_other_description", "funds_source_type", "funds_source_type_other_description", "included_in_asset_account", "institution_name", "account_identifier_encrypted", "account_last4", "cash_or_market_value_cents", "identity_key", "source_verification_id", "first_seen_verification_id", "last_seen_verification_id", "retired_by_verification_id", "retired_at", "created_at"] as const;
export const DU_LIABILITY_COLUMNS = ["id", "application_id", "liability_type", "liability_type_other_description", "mortgage_type", "creditor_name", "account_identifier_encrypted", "account_last4", "monthly_payment_cents", "unpaid_balance_cents", "remaining_term_months", "paid_off_at_or_before_closing", "exclusion_indicator", "heloc_maximum_balance_cents", "payment_includes_taxes_insurance", "secured_by_owned_property_id", "identity_key", "source_verification_id", "source_credit_report_id", "first_seen_verification_id", "last_seen_verification_id", "retired_by_verification_id", "retired_at", "created_at"] as const;
export const DU_EXPENSE_COLUMNS = ["id", "application_id", "expense_type", "expense_other_description", "monthly_payment_cents", "remaining_term_months", "alimony_owed_to_name", "created_at"] as const;
/** `application_id` and `lien_upb_cents` are not here on purpose: the first is inherited from the asset by trigger, the second derived from the liabilities securing the row (23.5 rule 3, T13). A caller naming either is refused. */
export const DU_OWNED_PROPERTY_COLUMNS = ["id", "asset_id", "address_line_text", "address_unit", "city_name", "state_code", "postal_code", "country_code", "disposition", "is_subject", "current_usage", "property_usage", "property_usage_other_description", "market_value_cents", "monthly_expenses_cents", "monthly_rental_income_cents", "monthly_net_rental_income_cents", "created_at"] as const;
export const DU_OWNED_PROPERTY_DERIVED = ["application_id", "lien_upb_cents"] as const;
/** The fourteen URLA section 5 answers (Yes/No) and their follow-ups; `asserted_by_actor` is never a column a caller fills — it is the actor on the command. */
export const DU_DECLARATION_ANSWERS = ["intent_to_occupy", "undisclosed_borrowed_funds", "undisclosed_mortgage_application", "undisclosed_credit_application", "property_proposed_clean_energy_lien", "undisclosed_comaker_of_note", "outstanding_judgments", "presently_delinquent", "party_to_lawsuit", "prior_property_deed_in_lieu_conveyed", "prior_property_short_sale_completed", "prior_property_foreclosure_completed", "bankruptcy", "special_borrower_seller_relationship"] as const;
export const DU_DECLARATION_FOLLOW_UPS = ["homeowner_past_three_years", "property_usage", "prior_property_title", "fha_secondary_residence", "undisclosed_borrowed_funds_cents", "bankruptcy_explanation"] as const;
export const DU_RESIDENCE_COLUMNS = ["id", "application_borrower_id", "residency_type", "residency_basis", "monthly_rent_cents", "address_line_text", "address_unit", "city_name", "state_code", "postal_code", "country_code", "duration_months", "created_at"] as const;
export const EMPLOYER_COLUMNS = ["address_line_text", "address_unit", "city_name", "state_code", "postal_code", "country_code", "phone"] as const;

type Row<C extends readonly string[]> = Partial<Record<C[number], unknown>>;
export type DuAssetRow = Row<typeof DU_ASSET_COLUMNS> & { readonly application_id: string; readonly kind: string; readonly identity_key: string };
export type DuLiabilityRow = Row<typeof DU_LIABILITY_COLUMNS> & { readonly application_id: string; readonly identity_key: string };
export type DuExpenseRow = Row<typeof DU_EXPENSE_COLUMNS> & { readonly application_id: string; readonly expense_type: string };
export type DuOwnedPropertyRow = Row<typeof DU_OWNED_PROPERTY_COLUMNS> & { readonly disposition: string };
export type DuResidenceRow = Row<typeof DU_RESIDENCE_COLUMNS> & { readonly residency_type: string; readonly residency_basis: string; readonly duration_months: number };

export interface WriteAssetInput extends MatchOnIdentity { readonly asset: DuAssetRow; readonly owners: NonEmpty<DuOwner>; readonly supersedes?: DuSupersede | undefined; }
export interface WriteLiabilityInput extends MatchOnIdentity { readonly liability: DuLiabilityRow; readonly obligors: NonEmpty<DuOwner>; readonly supersedes?: DuSupersede | undefined; }
/** An expense takes no `supersedes`, and its absence is the point: `du_expenses` has no `retired_at`, because a person types an expense and no connector supersedes one. */
export interface WriteExpenseInput { readonly expense: DuExpenseRow; readonly payers: NonEmpty<DuOwner>; }

export class DuWriterError extends Error { readonly code: string; constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "DuWriterError"; this.code = code; } }

// ─── inside a transaction, or not at all ───────────────────────────────────────────────────────────────────────────
/** Clients this process has already proven to be inside a transaction — one `Queryable` object per transaction (client.ts `PoolDb.tx` builds a fresh one), so the proof is never reused across two. */
const provenInside = new WeakSet<object>();

/**
 * A client that can OPEN a transaction is not one that is inside a transaction. TypeScript will not catch the mistake
 * on its own — `Db` has every method `Queryable` has, so it is structurally assignable — and the resulting failure
 * arrives from Postgres at the first implicit COMMIT, about a row that appears to have been written. `tx` is the
 * discriminator (the pool carries it; the client `Db.tx` hands its callback does not).
 *
 * Then the database is asked, once per client: `pg_current_xact_id()` read twice answers the same id inside one
 * transaction and two different ids across two autocommitted statements (each statement of a pooled or plain client
 * is its own transaction, so the second read is a different transaction — on a pool, usually a different connection).
 * `txid_current_if_assigned()` would answer null before the first write and cannot tell the two cases apart; two
 * reads of the assigned id can.
 */
export async function assertInsideTransaction(q: Queryable, writer: string): Promise<void> {
  if (typeof (q as { tx?: unknown }).tx === "function") {
    throw new DuWriterError("DU_WRITER_OUTSIDE_TRANSACTION", `${writer} must be called inside a transaction (Db.tx, or the unit of work's before/commit hook): the row and its owner arcs are checked together at COMMIT, and one statement per transaction cannot satisfy that`);
  }
  if (provenInside.has(q)) return;
  const first = (await q.query<{ xid: string }>(`SELECT pg_current_xact_id()::text AS xid`))[0]?.xid;
  const second = (await q.query<{ xid: string }>(`SELECT pg_current_xact_id()::text AS xid`))[0]?.xid;
  if (!first || first !== second) {
    throw new DuWriterError("DU_WRITER_OUTSIDE_TRANSACTION", `${writer} must be called inside a transaction: two statements on this client ran as two transactions (${first} then ${second}), so a row and its owner arcs would be judged apart`);
  }
  provenInside.add(q);
}

// ─── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** The owners, checked for the two ways an array can be wrong at runtime after the type has been satisfied at a JavaScript call site or through a spread. */
function ownerRows(owners: readonly DuOwner[], writer: string): DuOwner[] {
  if (owners.length === 0) throw new DuWriterError("DU_GRAPH_ORPHAN", `${writer} needs at least one owner; a row with none cannot be emitted`);
  const seen = new Set<string>();
  return owners.map((owner) => {
    if (!owner.applicationBorrowerId) throw new DuWriterError("DU_GRAPH_ORPHAN", `${writer} was given an owner with no application_borrower_id`);
    if (seen.has(owner.applicationBorrowerId)) throw new DuWriterError("DU_GRAPH_DUPLICATE_OWNER", `${writer} was given ${owner.applicationBorrowerId} twice; one arc per borrower per row, and a second one is not a bigger share`);
    seen.add(owner.applicationBorrowerId);
    return { applicationBorrowerId: owner.applicationBorrowerId, ...(owner.role === undefined ? {} : { role: owner.role }) };
  });
}

/** The two intentions a caller cannot hold at once: `supersedes` retires a row and writes a new one beside it; matching replaces a row by updating it. */
function assertOneReplacement(input: { supersedes?: DuSupersede | undefined }, writer: string): void {
  if (input.supersedes) throw new DuWriterError("DU_WRITER_TWO_REPLACEMENTS", `${writer} was given both matchOnIdentity and supersedes; a matched row is replaced by being updated, so there is no second row to retire`);
}
/** Prior keys are only ever consulted on the matching path; handed in without it they would do nothing, and doing nothing is how an ingest ends up with a second live row for an account it holds. */
function assertPriorKeysAreUsable(input: MatchOnIdentity, writer: string): void {
  if (!input.matchOnIdentity && (input.priorIdentityKeys?.length ?? 0) > 0) throw new DuWriterError("DU_WRITER_PRIOR_KEYS_UNUSED", `${writer} was given priorIdentityKeys without matchOnIdentity; keys a row may already be stored under are for looking it up, and this call is not looking anything up`);
}
/** A caller naming a column the table does not have, or one only a trigger writes, is refused rather than silently narrowed. */
function assertColumns(row: Record<string, unknown>, allowed: readonly string[], writer: string, derived: readonly string[] = []): void {
  for (const k of Object.keys(row)) {
    if (derived.includes(k)) throw new DuWriterError("DU_OWNED_PROPERTY_DERIVED_FIELD", `${writer}: ${k} is derived by trigger and never written by a caller (23.5 rule 3 / T13)`);
    if (!allowed.includes(k)) throw new DuWriterError("DU_WRITER_UNKNOWN_COLUMN", `${writer}: ${k} is not a column`);
  }
}

/**
 * Hold this application's identity space until the transaction ends: a transaction-scoped advisory lock in the
 * two-integer key space, taken per application rather than per key, so a pull can never take two and two pulls can
 * never deadlock trading them. Re-pulls of a row that already exists never needed it (an UPDATE takes its own row
 * lock), so the cost is one round trip on a path that is already several.
 */
async function lockIdentitySpace(q: Queryable, applicationId: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext('du_row_identity'), hashtext($1::text))`, [applicationId]);
}

const candidateKeys = (identityKey: string, prior: readonly string[] | undefined): string[] => [identityKey, ...(prior ?? [])];

interface Matched { readonly id: string; readonly identityKey: string; readonly firstSeenVerificationId: string | null; readonly owners: readonly string[]; }

/** The row this asset (or tradeline) is, if the application already holds it: the keys are tried in order and the first hit wins, so a row still filed under a content key is found by a pull that has since been given a vendor id. */
async function matched(q: Queryable, table: "du_assets" | "du_liabilities", linkTable: "du_asset_parties" | "du_liability_parties", linkCol: "asset_id" | "liability_id", applicationId: string, keys: readonly string[]): Promise<Matched | null> {
  for (const identityKey of keys) {
    const found = (await q.query<{ id: string; identity_key: string; first_seen_verification_id: string | null }>(`SELECT id, identity_key, first_seen_verification_id FROM ${table} WHERE application_id = $1 AND identity_key = $2`, [applicationId, identityKey]))[0];
    if (found) {
      const owners = (await q.query<{ application_borrower_id: string }>(`SELECT application_borrower_id FROM ${linkTable} WHERE ${linkCol} = $1`, [found.id])).map((r) => r.application_borrower_id);
      return { id: found.id, identityKey: found.identity_key, firstSeenVerificationId: found.first_seen_verification_id, owners };
    }
  }
  return null;
}

/**
 * The row an identity key (with the priors it may be filed under) names on the application, if any — the 23.5 tools'
 * lookup BEFORE the command's transaction (src/app/tools/section23-5.ts), on the committed state, so the id a tool
 * reports and the event it appends name the row the deferred write lands on: a re-pull's matched row, else the id it
 * minted. The deferred write asserts the same, so a phantom id is never reported.
 */
export async function lookupByIdentity(q: Queryable, table: "du_assets" | "du_liabilities", applicationId: string, keys: readonly string[]): Promise<{ id: string; identityKey: string } | null> {
  const m = await matched(q, table, table === "du_assets" ? "du_asset_parties" : "du_liability_parties", table === "du_assets" ? "asset_id" : "liability_id", applicationId, keys);
  return m ? { id: m.id, identityKey: m.identityKey } : null;
}
/** The deferred write landed on the row the tool reported, or the command is refused: a concurrent pull committed the same identity key between the tool's lookup and this commit (writer.ts lookupByIdentity), and a reported id that names no row is worse than a re-pull. */
export function assertLanded(writer: string, table: string, reported: string, landed: string): void {
  if (reported !== landed) throw new DuWriterError("DU_WRITER_IDENTITY_MOVED", `${writer}: the ${table} row reported as ${reported} landed on ${landed} — another pull committed the same identity key between the lookup and this commit; nothing is written, re-run the pull`);
}

/**
 * What a re-pull may change about a row it recognized: everything it reported except the columns that say which row
 * this is. Its id and its application are what was matched on; `created_at` stays because the emitted rows are ordered
 * by `(created_at, id)`. The key is written only when the row was found under a different one (the one movement: a
 * provider that has started numbering what it used to report by name). `first_seen_verification_id` is kept where the
 * row already has one — a first sighting that moves is not a first sighting. `retired_at` and `retired_by_verification_id`
 * are cleared unconditionally: an account reported again is live again.
 */
function revision(reported: Record<string, unknown>, m: Matched): Record<string, unknown> {
  const { id: _id, application_id: _app, identity_key, created_at: _created, first_seen_verification_id: reportedFirstSeen, ...changed } = reported;
  return { ...changed, ...(identity_key === m.identityKey ? {} : { identity_key }), ...(m.firstSeenVerificationId === null ? { first_seen_verification_id: reportedFirstSeen ?? null } : {}), retired_at: null, retired_by_verification_id: null };
}

/** The owners this pull named that the matched row does not already carry. Arcs are ADDED and never removed: a pull is one vendor's report about one person, so it is not evidence that the other owner of a joint account has stopped owning it. */
function newOwners(held: readonly string[], named: readonly DuOwner[]): DuOwner[] {
  const known = new Set(held);
  return named.filter((owner) => !known.has(owner.applicationBorrowerId));
}

const retirement = (s: DuSupersede): Record<string, unknown> => ({ retired_at: s.retiredAt ?? new Date().toISOString(), ...(s.retiredByVerificationId === undefined ? {} : { retired_by_verification_id: s.retiredByVerificationId }) });

async function insert(q: Queryable, table: string, row: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  const r = await q.query<{ id: string }>(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, cols.map((k) => row[k]));
  return r[0]!.id;
}
async function update(q: Queryable, table: string, id: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  if (!cols.length) return;
  await q.query(`UPDATE ${table} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...cols.map((k) => row[k])]);
}
async function link(q: Queryable, table: string, col: string, rowId: string, owners: readonly DuOwner[]): Promise<void> {
  for (const o of owners) await q.query(`INSERT INTO ${table} (${col}, application_borrower_id${o.role === undefined ? "" : ", role"}) VALUES ($1, $2${o.role === undefined ? "" : ", $3"})`, o.role === undefined ? [rowId, o.applicationBorrowerId] : [rowId, o.applicationBorrowerId, o.role]);
}

// ─── the three Homestead writers ───────────────────────────────────────────────────────────────────────────────────
/** Write an ASSET and the arcs that say whose it is. Returns the row's id (the matched row's, on the identity path). */
export async function writeAsset(q: Queryable, input: WriteAssetInput): Promise<{ id: string; matched: boolean }> {
  await assertInsideTransaction(q, "writeAsset");
  assertPriorKeysAreUsable(input, "writeAsset");
  assertColumns(input.asset, DU_ASSET_COLUMNS, "writeAsset");
  const owners = ownerRows(input.owners, "writeAsset");
  if (input.matchOnIdentity) {
    assertOneReplacement(input, "writeAsset");
    await lockIdentitySpace(q, input.asset.application_id);
    const m = await matched(q, "du_assets", "du_asset_parties", "asset_id", input.asset.application_id, candidateKeys(input.asset.identity_key, input.priorIdentityKeys));
    if (m) {
      await update(q, "du_assets", m.id, revision(input.asset, m));
      await link(q, "du_asset_parties", "asset_id", m.id, newOwners(m.owners, owners));
      return { id: m.id, matched: true };
    }
  }
  if (input.supersedes) await update(q, "du_assets", input.supersedes.id, retirement(input.supersedes));
  const id = await insert(q, "du_assets", { ...input.asset, id: input.asset.id ?? randomUUID() });
  await link(q, "du_asset_parties", "asset_id", id, owners);
  return { id, matched: false };
}

/** Write a LIABILITY and the arcs that say who owes it. */
export async function writeLiability(q: Queryable, input: WriteLiabilityInput): Promise<{ id: string; matched: boolean }> {
  await assertInsideTransaction(q, "writeLiability");
  assertPriorKeysAreUsable(input, "writeLiability");
  assertColumns(input.liability, DU_LIABILITY_COLUMNS, "writeLiability");
  const obligors = ownerRows(input.obligors, "writeLiability");
  if (input.matchOnIdentity) {
    assertOneReplacement(input, "writeLiability");
    await lockIdentitySpace(q, input.liability.application_id);
    const m = await matched(q, "du_liabilities", "du_liability_parties", "liability_id", input.liability.application_id, candidateKeys(input.liability.identity_key, input.priorIdentityKeys));
    if (m) {
      await update(q, "du_liabilities", m.id, revision(input.liability, m));
      await link(q, "du_liability_parties", "liability_id", m.id, newOwners(m.owners, obligors));
      return { id: m.id, matched: true };
    }
  }
  if (input.supersedes) await update(q, "du_liabilities", input.supersedes.id, retirement(input.supersedes));
  const id = await insert(q, "du_liabilities", { ...input.liability, id: input.liability.id ?? randomUUID() });
  await link(q, "du_liability_parties", "liability_id", id, obligors);
  return { id, matched: false };
}

/** Write an EXPENSE and the arcs that say who pays it. */
export async function writeExpense(q: Queryable, input: WriteExpenseInput): Promise<{ id: string }> {
  await assertInsideTransaction(q, "writeExpense");
  assertColumns(input.expense, DU_EXPENSE_COLUMNS, "writeExpense");
  const payers = ownerRows(input.payers, "writeExpense");
  const id = await insert(q, "du_expenses", { ...input.expense, id: input.expense.id ?? randomUUID() });
  await link(q, "du_expense_parties", "expense_id", id, payers);
  return { id };
}

// ─── the owned property (URLA 3a): an OWNED_PROPERTY asset, its owners, and its 3a row, together ───────────────────
export interface WriteOwnedPropertyInput extends MatchOnIdentity {
  readonly applicationId: string;
  /** The OWNED_PROPERTY asset's identity (a person's own row takes `manual:<uuid>` when absent). */
  readonly identityKey?: string | undefined;
  readonly assetId?: string | undefined;
  readonly property: DuOwnedPropertyRow;
  readonly owners: NonEmpty<DuOwner>;
  readonly sourceVerificationId?: string | null | undefined;
}
/** Write an OWNED_PROPERTY asset with its owner arcs and its `du_owned_properties` row; `application_id` and `lien_upb_cents` on the property are refused (the triggers own them). Re-running for the same asset updates the 3a row. */
export async function writeOwnedProperty(q: Queryable, input: WriteOwnedPropertyInput): Promise<{ assetId: string; propertyId: string; matched: boolean }> {
  await assertInsideTransaction(q, "writeOwnedProperty");
  assertColumns(input.property, DU_OWNED_PROPERTY_COLUMNS, "writeOwnedProperty", DU_OWNED_PROPERTY_DERIVED);
  // The asset's id is minted here so its default identity key (`manual:<asset id>`) is one a caller holding the id can recompute for a re-run.
  const assetId = input.assetId ?? randomUUID();
  const asset = await writeAsset(q, { asset: { id: assetId, application_id: input.applicationId, kind: "OWNED_PROPERTY", identity_key: input.identityKey ?? `${MANUAL_PREFIX}${assetId}`, source_verification_id: input.sourceVerificationId ?? null }, owners: input.owners, matchOnIdentity: input.matchOnIdentity, priorIdentityKeys: input.priorIdentityKeys });
  const existing = (await q.query<{ id: string }>(`SELECT id FROM du_owned_properties WHERE asset_id = $1`, [asset.id]))[0];
  const { id: _pid, asset_id: _aid, ...fields } = input.property;
  if (existing) { await update(q, "du_owned_properties", existing.id, fields); return { assetId: asset.id, propertyId: existing.id, matched: asset.matched }; }
  // application_id is NOT NULL on the row and inherited by trigger from the asset — the trigger overwrites whatever is
  // written, so the asset's own value is what goes in (T13 proves a different value is overwritten).
  const propertyId = await insert(q, "du_owned_properties", { ...fields, id: input.property.id ?? randomUUID(), asset_id: asset.id, application_id: input.applicationId });
  return { assetId: asset.id, propertyId, matched: asset.matched };
}

// ─── owner arcs on their own (linkOwner / unlinkOwner) ─────────────────────────────────────────────────────────────
export type OwnedKind = "asset" | "liability" | "expense";
const LINKS: Record<OwnedKind, { table: string; col: string; parent: string }> = { asset: { table: "du_asset_parties", col: "asset_id", parent: "du_assets" }, liability: { table: "du_liability_parties", col: "liability_id", parent: "du_liabilities" }, expense: { table: "du_expense_parties", col: "expense_id", parent: "du_expenses" } };
/** Add an owner arc to a live row (idempotent on the pair). */
export async function linkOwner(q: Queryable, kind: OwnedKind, rowId: string, owner: DuOwner): Promise<{ linked: boolean }> {
  await assertInsideTransaction(q, "linkOwner");
  const l = LINKS[kind];
  const parent = (await q.query<{ id: string }>(`SELECT id FROM ${l.parent} WHERE id = $1`, [rowId]))[0];
  if (!parent) throw new RangeError(`linkOwner: no ${l.parent} row ${rowId}`);
  const r = await q.query<{ id: string }>(`INSERT INTO ${l.table} (${l.col}, application_borrower_id${owner.role === undefined ? "" : ", role"}) VALUES ($1, $2${owner.role === undefined ? "" : ", $3"}) ON CONFLICT (${l.col}, application_borrower_id) DO NOTHING RETURNING id`, owner.role === undefined ? [rowId, owner.applicationBorrowerId] : [rowId, owner.applicationBorrowerId, owner.role]);
  return { linked: r.length > 0 };
}
/** Remove an owner arc; the database refuses the COMMIT (DU_GRAPH_ORPHAN) when it was the live row's last. */
export async function unlinkOwner(q: Queryable, kind: OwnedKind, rowId: string, applicationBorrowerId: string): Promise<{ unlinked: boolean }> {
  await assertInsideTransaction(q, "unlinkOwner");
  const l = LINKS[kind];
  const r = await q.query<{ id: string }>(`DELETE FROM ${l.table} WHERE ${l.col} = $1 AND application_borrower_id = $2 RETURNING id`, [rowId, applicationBorrowerId]);
  return { unlinked: r.length > 0 };
}

// ─── 22.4's reconciliation of one account two borrowers each pulled (rule 5) ──────────────────────────────────────
export interface RetireAssetInput {
  /** The row that goes: retired, never deleted (you cannot diff against a row you deleted), and excluded from every arc and count from COMMIT on. */
  readonly id: string;
  /** The later pull's `verifications` row — the spec's spelling of "retired" is this column set; the trigger stamps retired_at. */
  readonly retiredByVerificationId: string;
  /** The row that survives in its place (the earlier created twin), confirmed by the same pull: it must be live, and its `last_seen_verification_id` becomes the retiring pull's. */
  readonly survivorId?: string | undefined;
}
/**
 * Retire one asset row in favour of another, inside the transaction that adds the retiring pull's owner arcs to the
 * survivor (`linkOwner`), so the deferred checks judge the merged set at COMMIT: two borrowers' pulls of one account are
 * two rows with disjoint owners until 22.4 reconciles them into one row with two arcs (23.5 rule 5 / edge cases). Both
 * rows are locked `FOR NO KEY UPDATE` first, so two pulls reconciling the same pair serialize. A row already retired by
 * this verification is left alone (a re-receive is one receive); a survivor that is not live refuses the merge.
 */
export async function retireAsset(q: Queryable, input: RetireAssetInput): Promise<{ retired: boolean }> {
  await assertInsideTransaction(q, "retireAsset");
  if (input.survivorId === input.id) throw new RangeError("retireAsset: the survivor and the retired row are one row");
  const ids = input.survivorId ? [input.id, input.survivorId] : [input.id];
  const rows = await q.query<{ id: string; application_id: string; retired_at: string | null; retired_by_verification_id: string | null }>(`SELECT id, application_id, retired_at, retired_by_verification_id FROM du_assets WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`, [ids]);
  const loser = rows.find((r) => r.id === input.id);
  if (!loser) throw new RangeError(`retireAsset: no du_assets row ${input.id}`);
  if (input.survivorId) {
    const survivor = rows.find((r) => r.id === input.survivorId);
    if (!survivor) throw new RangeError(`retireAsset: no du_assets row ${input.survivorId} to survive`);
    if (survivor.application_id !== loser.application_id) throw new DuWriterError("DU_GRAPH_CROSS_APPLICATION", `retireAsset: ${input.survivorId} and ${input.id} are on different applications`);
    if (survivor.retired_at !== null) throw new DuWriterError("DU_WRITER_SURVIVOR_RETIRED", `retireAsset: the survivor ${input.survivorId} is retired; a merge lands on a live row`);
    await update(q, "du_assets", survivor.id, { last_seen_verification_id: input.retiredByVerificationId });
  }
  if (loser.retired_at !== null && loser.retired_by_verification_id === input.retiredByVerificationId) return { retired: false };
  await update(q, "du_assets", loser.id, { retired_at: new Date().toISOString(), retired_by_verification_id: input.retiredByVerificationId });
  return { retired: true };
}

// ─── the declaration is asked (rule 4): the fourteen answers, their follow-ups, the chapters and the explanation ────
export interface AssertDeclarationsInput {
  readonly applicationBorrowerId: string;
  /** The kernel Actor of the borrower's own session — taken from the command context by the tool, never from input; the trigger du_declarations_are_self_attested refuses any other. */
  readonly actor: Actor;
  readonly answers: Readonly<Record<(typeof DU_DECLARATION_ANSWERS)[number], "Yes" | "No" | null | undefined>>;
  readonly followUps?: Partial<Record<(typeof DU_DECLARATION_FOLLOW_UPS)[number], unknown>> | undefined;
  /** The chapter(s) of a declared bankruptcy (5b.8.1): the set the row ends with. */
  readonly bankruptcyChapters?: readonly string[] | undefined;
  readonly assertedAt?: string | undefined;
}
/** Write (or rewrite — one row per borrower) the borrower's own section 5 as of this credit request, with its chapters. The deferred triggers judge the chapters against the indicator at COMMIT. */
export async function assertDeclarations(q: Queryable, input: AssertDeclarationsInput): Promise<{ id: string; chapters: number }> {
  await assertInsideTransaction(q, "assertDeclarations");
  const answers: Record<string, unknown> = {};
  for (const k of DU_DECLARATION_ANSWERS) { const v = input.answers[k]; if (v !== undefined) answers[k] = v; }
  for (const k of Object.keys(input.answers)) if (!(DU_DECLARATION_ANSWERS as readonly string[]).includes(k)) throw new DuWriterError("DU_WRITER_UNKNOWN_COLUMN", `assertDeclarations: ${k} is not one of the fourteen section 5 answers`);
  const follow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.followUps ?? {})) { if (!(DU_DECLARATION_FOLLOW_UPS as readonly string[]).includes(k)) throw new DuWriterError("DU_WRITER_UNKNOWN_COLUMN", `assertDeclarations: ${k} is not a section 5 follow-up`); follow[k] = v ?? null; }
  // A rewrite is the whole section 5 as of this request (one row per borrower): a follow-up the request does not carry is
  // written NULL, so an answer that moved from Yes to No sheds its follow-up instead of tripping the CHECK that ties the
  // two (du_declarations_homeowner_follows_intent, du_declarations_borrowed_amount_follows_indicator). The written
  // explanation is the one exception — "never discarded" (23.5 Data model): it is kept unless the request names it, and
  // a request naming it null clears it.
  for (const k of DU_DECLARATION_FOLLOW_UPS) if (k !== "bankruptcy_explanation" && !(k in follow)) follow[k] = null;
  const row: Record<string, unknown> = { ...answers, ...follow, asserted_by_actor: JSON.stringify({ kind: input.actor.kind, id: input.actor.id, ...(input.actor.role ? { role: input.actor.role } : {}) }), asserted_at: input.assertedAt ?? new Date().toISOString() };
  const cols = Object.keys(row);
  const r = await q.query<{ id: string }>(
    `INSERT INTO du_declarations (application_borrower_id, ${cols.join(", ")}) VALUES ($1, ${cols.map((c, i) => `$${i + 2}${c === "asserted_by_actor" ? "::jsonb" : ""}`).join(", ")})
     ON CONFLICT (application_borrower_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")} RETURNING id`,
    [input.applicationBorrowerId, ...cols.map((c) => row[c])]);
  const id = r[0]!.id;
  const chapters = [...new Set(input.bankruptcyChapters ?? [])];
  await q.query(`DELETE FROM du_bankruptcy_filings WHERE declaration_id = $1 AND NOT (chapter = ANY ($2::text[]))`, [id, chapters]);
  for (const chapter of chapters) await q.query(`INSERT INTO du_bankruptcy_filings (declaration_id, chapter) VALUES ($1, $2) ON CONFLICT (declaration_id, chapter) DO NOTHING`, [id, chapter]);
  return { id, chapters: chapters.length };
}

// ─── where the borrower lives (URLA 1a): one Current, Prior rows when under two years ──────────────────────────────
/** Write a residence; a Current one replaces the borrower's Current (one per borrower), a Prior one is added. */
export async function writeResidence(q: Queryable, applicationBorrowerId: string, residence: DuResidenceRow): Promise<{ id: string; replaced: boolean }> {
  await assertInsideTransaction(q, "writeResidence");
  assertColumns(residence, DU_RESIDENCE_COLUMNS, "writeResidence");
  const { id: given, application_borrower_id: _ab, ...fields } = residence;
  if (residence.residency_type === "Current") {
    const existing = (await q.query<{ id: string }>(`SELECT id FROM du_residences WHERE application_borrower_id = $1 AND residency_type = 'Current'`, [applicationBorrowerId]))[0];
    if (existing) {
      // A re-confirmation is the whole Current residence as of this request: every column is written, NULL when absent,
      // so a basis that moved away from Rent sheds the rent it carried (du_residences_rent_iff_rent_basis would refuse
      // the row otherwise) and an address the borrower no longer gives is gone. `created_at` stays unless given.
      const whole: Record<string, unknown> = {};
      for (const c of DU_RESIDENCE_COLUMNS) if (c !== "id" && c !== "application_borrower_id" && c !== "created_at") whole[c] = (fields as Record<string, unknown>)[c] ?? null;
      if (fields.created_at !== undefined) whole["created_at"] = fields.created_at;
      await update(q, "du_residences", existing.id, whole);
      return { id: existing.id, replaced: true };
    }
  }
  const id = await insert(q, "du_residences", { ...fields, id: given ?? randomUUID(), application_borrower_id: applicationBorrowerId });
  return { id, replaced: false };
}

// ─── four borrowers, in order (rule 6): the database allocates the position under the application's row lock ─────
export interface AppendBorrowerInput {
  readonly applicationId: string;
  readonly legalName: string;
  readonly borrowerRole?: string;
  readonly partyId?: string | null | undefined;
  readonly borrowerId?: string | null | undefined;
  readonly contact?: Record<string, unknown> | undefined;
  readonly id?: string | undefined;
  /** A stated position; the unique index refuses a collision. Left out, the trigger allocates the smallest free one from 2 (1 is the `borrower` role's). */
  readonly borrowerOrdinal?: number | null | undefined;
}
export async function appendBorrower(q: Queryable, input: AppendBorrowerInput): Promise<{ id: string; borrowerOrdinal: number | null; borrowerRole: string }> {
  await assertInsideTransaction(q, "appendBorrower");
  const r = await q.query<{ id: string; borrower_ordinal: number | null; borrower_role: string }>(
    `INSERT INTO application_borrowers (id, application_id, borrower_role, legal_name, party_id, borrower_id, contact, borrower_ordinal) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id, borrower_ordinal, borrower_role`,
    [input.id ?? randomUUID(), input.applicationId, input.borrowerRole ?? "co_borrower", input.legalName, input.partyId ?? null, input.borrowerId ?? null, JSON.stringify(input.contact ?? {}), input.borrowerOrdinal ?? null]);
  return { id: r[0]!.id, borrowerOrdinal: r[0]!.borrower_ordinal, borrowerRole: r[0]!.borrower_role };
}

// ─── ROLE_SharesJointCreditReportWith_ROLE: from_ the additional borrower, to_ the group's primary ─────────────────
export async function linkJointCreditReport(q: Queryable, applicationId: string, fromApplicationBorrowerId: string, toApplicationBorrowerId: string): Promise<{ id: string }> {
  await assertInsideTransaction(q, "linkJointCreditReport");
  const r = await q.query<{ id: string }>(
    `INSERT INTO du_joint_credit_report_links (application_id, from_application_borrower_id, to_application_borrower_id) VALUES ($1, $2, $3)
     ON CONFLICT (application_id, from_application_borrower_id) DO UPDATE SET to_application_borrower_id = EXCLUDED.to_application_borrower_id RETURNING id`,
    [applicationId, fromApplicationBorrowerId, toApplicationBorrowerId]);
  return { id: r[0]!.id };
}

// ─── the employer (rule 2): create or match under EMPLOYER_IDENTITY_RULES, then point the income item at it ────────
export interface WriteEmployerInput {
  readonly applicationId: string;
  readonly applicationBorrowerId: string;
  readonly displayName: string;
  readonly ein?: string | null | undefined;
  readonly firstSeenVerificationId?: string | null | undefined;
  readonly address?: Row<typeof EMPLOYER_COLUMNS> | undefined;
}
/**
 * EIN_WINS / NAME_KEY_OTHERWISE decide the key; MATCH_ORDER finds the row (identity_key first, then — for a pull with
 * an EIN — the name_key of a name-derived row, which PROMOTE_ONCE moves onto the `ein:` key); PER_BORROWER scopes
 * every lookup to the borrowing party; NAME_KEY_WRITTEN_ONCE is the `name_key` on every insert.
 */
export async function writeEmployer(q: Queryable, input: WriteEmployerInput): Promise<{ id: string; matched: "identity_key" | "name_key" | null; promoted: boolean; identityKey: string }> {
  await assertInsideTransaction(q, "writeEmployer");
  if (input.address) assertColumns(input.address, EMPLOYER_COLUMNS, "writeEmployer");
  const k = employerIdentityKeys({ displayName: input.displayName, ein: input.ein });
  await q.query(`SELECT pg_advisory_xact_lock(hashtext('employer_identity'), hashtext($1::text))`, [input.applicationBorrowerId]);
  const byKey = (await q.query<{ id: string }>(`SELECT id FROM employers WHERE application_borrower_id = $1 AND identity_key = $2`, [input.applicationBorrowerId, k.key]))[0];
  if (byKey) { await update(q, "employers", byKey.id, { ...(input.address ?? {}), display_name: input.displayName, ...(k.ein ? { ein: k.ein } : {}) }); return { id: byKey.id, matched: "identity_key", promoted: false, identityKey: k.key }; }
  // MATCH_ORDER: the name key next — for every pull, so a bank pull that only knows the name finds the row a payroll pull promoted to `ein:` (NAME_KEY_WRITTEN_ONCE).
  // A name-derived row an EIN pull recognizes is PROMOTED (PROMOTE_ONCE); an ein-derived row a name-only pull recognizes keeps its EIN key — the vendor's id is never demoted to a name.
  // A pull that carries an EIN matches by name ONLY a name-derived row: an `ein:` row under the same trade name but another EIN is another employer
  // (EIN_WINS — "one name under two EINs is two"; 0133's employers_borrower_name_key_idx is not unique for this reason), so it inserts beside it.
  const einPull = k.derivedFrom === "ein";
  const byName = (await q.query<{ id: string; derived_from: string; identity_key: string }>(`SELECT id, derived_from, identity_key FROM employers WHERE application_borrower_id = $1 AND name_key = $2 AND ($3::boolean = false OR derived_from = 'name') ORDER BY (derived_from <> 'ein'), created_at, id LIMIT 1`, [input.applicationBorrowerId, k.nameKey, einPull]))[0];
  if (byName) {
    const promote = einPull && byName.derived_from === "name";
    await update(q, "employers", byName.id, { ...(input.address ?? {}), display_name: input.displayName, ...(promote ? { identity_key: k.key, derived_from: "ein", ein: k.ein } : {}) });
    return { id: byName.id, matched: "name_key", promoted: promote, identityKey: promote ? k.key : byName.identity_key };
  }
  const id = await insert(q, "employers", { ...(input.address ?? {}), id: randomUUID(), application_id: input.applicationId, application_borrower_id: input.applicationBorrowerId, identity_key: k.key, derived_from: k.derivedFrom, name_key: k.nameKey, ein: k.ein, display_name: input.displayName, first_seen_verification_id: input.firstSeenVerificationId ?? null });
  return { id, matched: null, promoted: false, identityKey: k.key };
}
/** MERGE_REPOINTS_FIRST: every income item naming the loser is repointed to the survivor in this transaction, then the loser goes; `ON DELETE RESTRICT` makes any other order fail. */
export async function mergeEmployers(q: Queryable, survivorId: string, loserId: string): Promise<{ repointed: number }> {
  await assertInsideTransaction(q, "mergeEmployers");
  if (survivorId === loserId) throw new RangeError("mergeEmployers: the survivor and the loser are one row");
  const r = await q.query<{ id: string }>(`UPDATE application_income SET employer_id = $1 WHERE employer_id = $2 RETURNING id`, [survivorId, loserId]);
  await q.query(`DELETE FROM employers WHERE id = $1`, [loserId]);
  return { repointed: r.length };
}
export { EMPLOYER_IDENTITY_RULES };

// ─── who a caller means by a borrower reference ────────────────────────────────────────────────────────────────────
/**
 * A caller names a borrower by whatever id it holds: the `application_borrowers` row, the party, the servicing
 * `borrowers` row, or the intake record's own id (21.1's `applications` entity carries `borrowers[{id, legal_name}]`;
 * 22.2 orders credit by those ids and the borrower flows pass them on). The edge is what every arc points at, so the
 * reference is resolved to it here, on the same application, and an unresolvable one is refused rather than guessed.
 */
export async function resolveBorrowerEdge(q: Queryable, applicationId: string, ref: string): Promise<string> {
  if (!ref) throw new RangeError("a borrower reference is required");
  const rows = await q.query<{ id: string; party_id: string | null; borrower_id: string | null; legal_name: string; borrower_role: string }>(`SELECT id, party_id, borrower_id, legal_name, borrower_role FROM application_borrowers WHERE application_id = $1 ORDER BY (borrower_role <> 'borrower'), created_at, id`, [applicationId]);
  if (isUuid(ref)) {
    const hit = rows.find((r) => r.id === ref) ?? rows.find((r) => r.party_id === ref) ?? rows.find((r) => r.borrower_id === ref);
    if (hit) return hit.id;
  }
  const intake = (await q.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'applications' AND id = $1`, [applicationId]))[0];
  const intakeBorrowers = intake ? (((decodeEntityData(intake.data)["borrowers"] as Record<string, unknown>[] | undefined) ?? []).filter((b) => typeof b === "object" && b !== null)) : [];
  const at = intakeBorrowers.findIndex((b) => String(b["id"] ?? "") === ref);
  if (at >= 0) {
    const name = String(intakeBorrowers[at]!["legal_name"] ?? "");
    const byName = name ? rows.find((r) => r.legal_name.toLowerCase() === name.toLowerCase()) : undefined;
    const byPosition = rows.filter((r) => ["borrower", "co_borrower", "non_occupant_co_borrower"].includes(r.borrower_role))[at];
    const hit = byName ?? byPosition;
    if (hit) return hit.id;
  }
  const byName = rows.find((r) => r.legal_name.toLowerCase() === ref.toLowerCase());
  if (byName) return byName.id;
  throw new RangeError(`borrower ${ref} is not an application_borrowers row, party, borrower or intake borrower of application ${applicationId}`);
}
