/**
 * §35.5 rule 8 — ACH origination and NACHA returns as cycles (rule set `cashiering.returns.v1`): the daily file build (`ach_file_build`,
 * banking days 14:00 ET), the FAKE ODFI's settlement feed, the return/NOC file ingest (`ach_returns_ingest`, banking days 08:00 ET) and
 * 2.3 rule 7 applied per returned entry inside the loan's unit of work. Nothing here decides a money figure: the draft amount is 2.3 rule 4's
 * (`draftAmount` over the schedule row), every gate is 2.3's own (`nacha.build_entry`'s guardrails and evaluators, executed in-process —
 * GATES_ARE_2_3S), the reversal is 2.1 rule 9 through 2.3's `autodraft.read/write{op: return}`, the NSF fee is 2.7 rule 7's `assessNsf`
 * (NSF_ONLY_WHERE_ALLOWED: `loan_servicing_configs.nsf_fee_allowed`, min(2,500¢, cap), once per item, never for R11), the retry is 2.3's
 * disposition ("RETRY PYMT", the third banking day after the return's settlement date; at most two within 180 days — MAX_2_REINITIATIONS_180
 * → `suspended_returns`, a `borrower-comms` hand-off).
 *
 *   PgFakeOdfiQueue              the FAKE ODFI's return-file queue — `documents` rows (`kind ach_return_file`, `metadata.status queued`), one
 *                                shared FAKE per database (the sweep job and the API see the same file), never per Runtime; `fakeReturnFile`
 *                                scripts a return/NOC file in the codec's layout (src/infra/integrations/codecs/nacha.ts returnRecord).
 *   settleTransmittedEntries     the settlement feed: every transmitted / acknowledged entry whose effective entry date has come settles on it
 *                                (`ach.entry.settled`, the loan's `payments` row through the cash-rows port — channel `ach_debit_origin`,
 *                                `received_on = credited_as_of = settlement_date`, `status received`, the extra principal as `curtailment_cents`
 *                                — and the enrollment's `last_debit_cents` / `next_draft_on`), for the loan's next `cashiering_daily` unit.
 *   buildAchFile(rt, in)         the `ach_file_build` unit: per active enrollment whose next settlement date (2.3 rule 3 `settlementDateFor`)
 *                                is T+1 or T+2 banking days, 2.3's `nacha.build_entry` in the loan's unit of work (ENROLLMENT_ACTIVE,
 *                                NACHA_WEB_ACCOUNT_VALIDATION_GATE, REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10, FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE
 *                                named in the decision), plus the built reinitiations due in the window; one `ach_files` row (file_id_modifier,
 *                                counts, sha256, the stored file) and its `ach_entries` rows in one global unit of work with `ach.file.built{…,
 *                                origination: true}` (satisfies and re-arms SM_ACH_FILE_BUILD_1BD); transmitted through the transmit port
 *                                (`ach.file.transmitted`; a deferred acknowledgement is retried by the next build with the same document).
 *   ingestReturnFile(rt, in)     the `ach_returns_ingest` unit: the settlement feed first; every queued return file (sha256 unique — the same
 *                                bytes again write nothing but a decision naming the first file), each return matched to its entry by trace
 *                                number, `ach.return.received{code, …, received_on, origination: true}` (arms SM_ACH_RETURN_ACTIONED_1BD; 2.3's
 *                                fields so its own clocks arm) and `ach_returns` in one loan unit of work, then `actionReturn` in the next;
 *                                NOCs to `ach_nocs` (`ach.noc.received`); the `ach_return_files` row with `ach.return_file.received`.
 *   actionReturn(rt, unit, in)   2.3 rule 7 for one returned entry on an open loan unit of work: 2.3's `autodraft.read/write{op: return}`
 *                                in-process (the mirror sets, `payment.reversed`, `installment.restored` through `installments.restore`, the
 *                                return notice, the enrollment's status), the NSF fee through 2.7's `assessNsf` (Dr nsf_fees / Cr nsf_fee_income,
 *                                rule_ref 2.7:r7:nsf), the reinitiation `ach_entries` row, the `borrower-comms` hand-off, `ach.return.actioned`
 *                                (satisfies SM_ACH_RETURN_ACTIONED_1BD) and the decision.
 *   achFileBuild / achReturnsIngest / achReturnAction   the bus tools (src/app/tools/section35-5.ts binds them).
 *
 * Money is bigint cents; dates are PlainDate; every event type is a string literal (tools/lint-emission.ts). The ODFI identifiers are FAKE.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { CommandRefused, type CommandContext } from "../../app/commands.ts";
import { str, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { AccountRef } from "../../kernel/ledger/ledger.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, startOfMonth, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { buildNachaFile, parseAchReturns, returnRecord, traceNumber, type AchBatch, type AchEntry, type AchReturn } from "../../infra/integrations/codecs/nacha.ts";
import { draftAmount, settlementDateFor, variableAmountNoticeStatus, type Authorization, type Enrollment } from "../cashiering/autodraft.ts";
import { CashieringOps } from "../cashiering/ops.ts";
import { nsfFee } from "../cashiering/latecharges.ts";
import type { Runtime } from "../../runtime/app.ts";
import { recipientsOf, servicingParties } from "../../runtime/servicing-parties.ts";
import { CASHIERING_AGENT, MODEL_VERSION_DETERMINISTIC, PROMPT_VERSION_35_5, readSchedule, type InstallmentRow } from "./installments.ts";
import { EXCLUDED_STATUSES, loanCashStateFromRows } from "./cashiering-cycle.ts";
import { jurisdictionRulesFor, servicingConfigIfAny } from "./servicing-config.ts";
import { bindUnit, commitUnit, executeInUnit, openUnit, type BoundUnit } from "./in-process.ts";
import { ports35_5 } from "./ports-35-5.ts";

export const RULE_SET_RETURNS = "cashiering.returns.v1";
export const CYCLE_ACH_FILE_BUILD = "ach_file_build";
export const CYCLE_ACH_RETURNS_INGEST = "ach_returns_ingest";
/** Event literals this file emits. */
export const FILE_BUILT = "ach.file.built";
export const FILE_TRANSMITTED = "ach.file.transmitted";
export const ENTRY_SETTLED = "ach.entry.settled";
export const RETURN_FILE_RECEIVED = "ach.return_file.received";
export const RETURN_RECEIVED = "ach.return.received";
export const RETURN_ACTIONED = "ach.return.actioned";
export const NOC_RECEIVED = "ach.noc.received";
export const BUILD_RUN_COMPLETED = "ach.file_build.run_completed";
export const RETURNS_RUN_COMPLETED = "ach.returns_ingest.run_completed";
export const ACH_FILE_KIND = "ach_file";
export const ACH_RETURN_FILE_KIND = "ach_return_file";
export const RULE_REF_NSF = "2.7:r7:nsf";
export const DESCRIPTION_DRAFT = "MORTGAGE PMT";
export const DESCRIPTION_RETRY = "RETRY PYMT";
/** The FAKE ODFI (2.3 Integrations `nacha`): the immediate destination / origin, the company id and the originating DFI routing of every file. */
export const FAKE_ODFI = { routing: "021000021", immediate_destination: "021000021", immediate_origin: "1123456789", company_name: "SUPERMORTGAGE", company_id: "1123456789" } as const;
/** 2.3 rule 7 / OQ6: the automatic retry settles on the third banking day after the return's settlement date (policy within Nacha's 3–5). */
export const RETRY_BANKING_DAYS = 3;
export const MAX_REINITIATIONS = 2;

export type ReturnAction = "reversed_reinitiated" | "reversed_suspended" | "account_terminated" | "enrollment_cancelled_fraud" | "corrected_entry" | "none_already_paid";
export const RETURN_ACTIONS: readonly ReturnAction[] = ["reversed_reinitiated", "reversed_suspended", "account_terminated", "enrollment_cancelled_fraud", "corrected_entry", "none_already_paid"];
type Row = Record<string, unknown>;
const s = (v: Cents): string => v.toString();
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const sha256 = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");
function refuse(command: string, code: string, citation: string, reason: string): never { throw new CommandRefused(command, code, citation, reason); }
const enrollmentAgg = (id: string): { kind: "autodraft_enrollment"; id: string } => ({ kind: "autodraft_enrollment", id });
const loanAcct = (loanId: string, account: "nsf_fees"): AccountRef => ({ scope: "loan", loanId, account });
const pad = (v: string, n: number): string => v.padEnd(n, " ").slice(0, n);

// ---------------------------------------------------------------- the typed rows (2.3's ach_files / ach_entries / ach_returns / ach_nocs, 35.5's ach_return_files)
export interface AchEntryRow {
  readonly id: string; readonly loan_id: string | null; readonly enrollment_key: string | null; readonly direction: string; readonly sec_code: string; readonly amount_cents: Cents; readonly effective_entry_date: PlainDate; readonly settlement_date: PlainDate | null;
  readonly company_entry_description: string; readonly trace_number: string | null; readonly file_id: string | null; readonly status: string; readonly return_code: string | null; readonly returned_at: string | null; readonly reinitiation_of_entry_id: string | null; readonly reinitiation_count: number; readonly idempotency_key: string; readonly created_at: string;
}
const ENTRY_COLS = "id, loan_id, enrollment_key, direction::text AS direction, sec_code::text AS sec_code, amount_cents::text AS amount_cents, effective_entry_date::text AS effective_entry_date, settlement_date::text AS settlement_date, company_entry_description, trace_number, file_id, status::text AS status, return_code, returned_at::text AS returned_at, reinitiation_of_entry_id, reinitiation_count, idempotency_key, created_at::text AS created_at";
const entryOf = (r: Row): AchEntryRow => ({ id: String(r.id), loan_id: (r.loan_id as string | null) ?? null, enrollment_key: (r.enrollment_key as string | null) ?? null, direction: String(r.direction), sec_code: String(r.sec_code), amount_cents: c(r.amount_cents), effective_entry_date: D(String(r.effective_entry_date)), settlement_date: r.settlement_date ? D(String(r.settlement_date)) : null,
  company_entry_description: String(r.company_entry_description), trace_number: (r.trace_number as string | null) ?? null, file_id: (r.file_id as string | null) ?? null, status: String(r.status), return_code: (r.return_code as string | null) ?? null, returned_at: (r.returned_at as string | null) ?? null, reinitiation_of_entry_id: (r.reinitiation_of_entry_id as string | null) ?? null, reinitiation_count: Number(r.reinitiation_count ?? 0), idempotency_key: String(r.idempotency_key), created_at: String(r.created_at) });
export async function readEntry(q: Queryable, id: string): Promise<AchEntryRow | undefined> { const r = (await q.query<Row>(`SELECT ${ENTRY_COLS} FROM ach_entries WHERE id = $1`, [id]))[0]; return r ? entryOf(r) : undefined; }
export async function readEntriesFor(q: Queryable, loanId: string): Promise<AchEntryRow[]> { return (await q.query<Row>(`SELECT ${ENTRY_COLS} FROM ach_entries WHERE loan_id = $1 ORDER BY created_at, effective_entry_date`, [loanId])).map(entryOf); }
async function entryByTrace(q: Queryable, trace: string): Promise<AchEntryRow | undefined> { const r = (await q.query<Row>(`SELECT ${ENTRY_COLS} FROM ach_entries WHERE trace_number = $1 ORDER BY created_at DESC LIMIT 1`, [trace]))[0]; return r ? entryOf(r) : undefined; }
export interface NewEntry { readonly id: string; readonly loan_id: string; readonly enrollment_key: string; readonly sec_code: string; readonly amount_cents: Cents; readonly effective_entry_date: PlainDate; readonly company_entry_description: string; readonly trace_number: string | null; readonly file_id: string | null; readonly status: "built" | "transmitted"; readonly reinitiation_of_entry_id: string | null; readonly reinitiation_count: number; readonly idempotency_key: string; }
/** One `ach_entries` row (2.3's table; `loan_id` / `enrollment_key` are 0145's columns — the typed enrollment_id FK stays NULL until 35.1's projector). */
export async function insertEntry(q: Queryable, e: NewEntry): Promise<void> {
  await q.query(`INSERT INTO ach_entries (id, enrollment_id, payment_id, direction, sec_code, amount_cents, effective_entry_date, settlement_date, company_entry_description, trace_number, file_id, status, reinitiation_of_entry_id, reinitiation_count, idempotency_key, loan_id, enrollment_key)
    VALUES ($1, NULL, NULL, 'debit', $2::sec_code, $3, $4, NULL, $5, $6, $7, $8::ach_entry_status, $9, $10, $11, $12, $13)`,
    [e.id, e.sec_code, e.amount_cents, e.effective_entry_date, e.company_entry_description, e.trace_number, e.file_id, e.status, e.reinitiation_of_entry_id, e.reinitiation_count, e.idempotency_key, e.loan_id, e.enrollment_key]);
}
export interface AchFileRow { readonly id: string; readonly file_id_modifier: string; readonly built_at: string; readonly transmitted_at: string | null; readonly entry_count: number; readonly total_debit_cents: Cents; readonly total_credit_cents: Cents; readonly ack_status: string | null; readonly document_id: string | null; readonly hash: string | null; }
const FILE_COLS = "id, file_id_modifier, built_at::text AS built_at, transmitted_at::text AS transmitted_at, entry_count, total_debit_cents::text AS total_debit_cents, total_credit_cents::text AS total_credit_cents, ack_status, document_id, hash";
const fileOf = (r: Row): AchFileRow => ({ id: String(r.id), file_id_modifier: String(r.file_id_modifier), built_at: String(r.built_at), transmitted_at: (r.transmitted_at as string | null) ?? null, entry_count: Number(r.entry_count), total_debit_cents: c(r.total_debit_cents), total_credit_cents: c(r.total_credit_cents), ack_status: (r.ack_status as string | null) ?? null, document_id: (r.document_id as string | null) ?? null, hash: (r.hash as string | null) ?? null });
export async function readAchFiles(q: Queryable): Promise<AchFileRow[]> { return (await q.query<Row>(`SELECT ${FILE_COLS} FROM ach_files ORDER BY built_at, id`)).map(fileOf); }
/** One `ach_files` row (2.3's table): the build's control totals and the stored file's hash. */
export async function insertAchFile(q: Queryable, f: { id: string; file_id_modifier: string; built_at: string; entry_count: number; total_debit_cents: Cents; document_id: string | null; hash: string }): Promise<void> {
  await q.query(`INSERT INTO ach_files (id, file_id_modifier, built_at, entry_count, total_debit_cents, total_credit_cents, ack_status, document_id, hash) VALUES ($1, $2, $3, $4, $5, 0, NULL, $6, $7)`, [f.id, f.file_id_modifier, f.built_at, f.entry_count, f.total_debit_cents, f.document_id, f.hash]);
}
export interface ReturnFileRow { readonly id: string; readonly as_of_date: PlainDate; readonly file_name: string; readonly sha256: string; readonly document_id: string | null; readonly returns: number; readonly nocs: number; readonly entries_matched: number; readonly entries_unmatched: number; readonly received_at: string; readonly processed_at: string | null; }
const RETURN_FILE_COLS = "id, as_of_date::text AS as_of_date, file_name, sha256, document_id, returns, nocs, entries_matched, entries_unmatched, received_at::text AS received_at, processed_at::text AS processed_at";
const returnFileOf = (r: Row): ReturnFileRow => ({ id: String(r.id), as_of_date: D(String(r.as_of_date)), file_name: String(r.file_name), sha256: String(r.sha256), document_id: (r.document_id as string | null) ?? null, returns: Number(r.returns), nocs: Number(r.nocs), entries_matched: Number(r.entries_matched), entries_unmatched: Number(r.entries_unmatched), received_at: String(r.received_at), processed_at: (r.processed_at as string | null) ?? null });
export async function readReturnFiles(q: Queryable): Promise<ReturnFileRow[]> { return (await q.query<Row>(`SELECT ${RETURN_FILE_COLS} FROM ach_return_files ORDER BY created_at, id`)).map(returnFileOf); }
/** One `ach_return_files` row (35.5's table; forbid_mutation — written once the file is processed, both timestamps on it). */
export async function insertReturnFile(q: Queryable, r: ReturnFileRow): Promise<void> {
  await q.query(`INSERT INTO ach_return_files (id, as_of_date, file_name, sha256, document_id, returns, nocs, entries_matched, entries_unmatched, received_at, processed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [r.id, r.as_of_date, r.file_name, r.sha256, r.document_id, r.returns, r.nocs, r.entries_matched, r.entries_unmatched, r.received_at, r.processed_at]);
}
export interface AchReturnRow { readonly id: string; readonly entry_id: string; readonly return_code: string; readonly received_at: string; readonly action_taken: string | null; readonly raw: Row | null; }
export async function readReturnsFor(q: Queryable, entryId: string): Promise<AchReturnRow[]> {
  return (await q.query<Row>(`SELECT id, entry_id, return_code, received_at::text AS received_at, action_taken, raw FROM ach_returns WHERE entry_id = $1 ORDER BY received_at, id`, [entryId])).map((r) => ({ id: String(r.id), entry_id: String(r.entry_id), return_code: String(r.return_code), received_at: String(r.received_at), action_taken: (r.action_taken as string | null) ?? null, raw: (r.raw as Row | null) ?? null }));
}

// ---------------------------------------------------------------- the FAKE ODFI's return-file queue: documents rows, one shared FAKE per database
export interface QueuedReturnFile { readonly document_id: string; readonly sha256: string; readonly as_of_date: PlainDate; readonly file_name: string; readonly content: string; readonly received_at: string; }
export const PgFakeOdfiQueue = {
  /** The ODFI delivers a return/NOC file for a banking day: a `documents` row queued (`storage_uri fake-queue://…`, the bytes in the metadata until the ingest stores the file). */
  async postReturns(db: Queryable, f: { as_of_date: PlainDate | string; content: string; file_name?: string; received_at?: string }): Promise<{ document_id: string; sha256: string }> {
    const bytes = Buffer.from(f.content, "utf8"); const hash = sha256(f.content); const id = randomUUID(); const asOf = D(String(f.as_of_date));
    const fileName = f.file_name ?? `RET-${asOf.replace(/-/g, "")}.ach`; const receivedAt = f.received_at ?? `${asOf}T12:00:00.000Z`;
    await db.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata) VALUES ($1, $2, $3, $4, $5, 'text/plain', 'respa_5y', $6::jsonb)`,
      [id, ACH_RETURN_FILE_KIND, hash, bytes.length, `fake-queue://ach-returns/${hash}`, toJson({ status: "queued", fake_store: "35.5", as_of_date: asOf, file_name: fileName, received_at: receivedAt, fake_bytes_b64: bytes.toString("base64") })]);
    return { document_id: id, sha256: hash };
  },
  /** The queued files delivered by the day, oldest first, marked dequeued (documents has no append-only trigger at HEAD; 35.2's column rule must keep `metadata` writable for this kind — plan §9 R7). */
  async fetch(q: Queryable, asOf: PlainDate, now: string): Promise<QueuedReturnFile[]> {
    const rows = await q.query<{ id: string; sha256: string; metadata: Row }>(`SELECT id, sha256, metadata FROM documents WHERE kind = $1 AND metadata->>'status' = 'queued' AND (metadata->>'as_of_date')::date <= $2::date ORDER BY created_at, id`, [ACH_RETURN_FILE_KIND, asOf]);
    const out: QueuedReturnFile[] = [];
    for (const r of rows) {
      await q.query(`UPDATE documents SET metadata = metadata || $2::jsonb WHERE id = $1`, [r.id, toJson({ status: "dequeued", dequeued_at: now })]);
      out.push({ document_id: r.id, sha256: r.sha256, as_of_date: D(String(r.metadata.as_of_date ?? asOf)), file_name: String(r.metadata.file_name ?? r.id), content: Buffer.from(String(r.metadata.fake_bytes_b64 ?? ""), "base64").toString("utf8"), received_at: String(r.metadata.received_at ?? now) });
    }
    return out;
  },
  async mark(q: Queryable, documentId: string, status: string, extra: Row = {}): Promise<void> { await q.query(`UPDATE documents SET metadata = metadata || $2::jsonb WHERE id = $1`, [documentId, toJson({ status, ...extra })]); },
};
/** A return/NOC file in the codec's layout (a file header, one `6`/`7` pair per item from `returnRecord`, a file control) — what the FAKE ODFI scripts for a test. */
export function fakeReturnFile(items: readonly { trace_number: string; amount_cents: Cents; code: string; returned_on: PlainDate; routing?: string; account?: string; individual_id?: string; name?: string; transaction_code?: "27" | "37"; corrected_data?: string }[], asOf: PlainDate): string {
  const header = pad(`101 ${FAKE_ODFI.immediate_destination}${FAKE_ODFI.immediate_origin}${asOf.slice(2, 4)}${asOf.slice(5, 7)}${asOf.slice(8, 10)}0800A094101FAKE ODFI RETURNS`, 94);
  const body = items.map((it) => returnRecord({ transactionCode: it.transaction_code ?? "27", rdfi: it.routing ?? FAKE_ODFI.routing, account: it.account ?? "FAKE0000", amountCents: it.amount_cents, individualId: it.individual_id ?? "", name: it.name ?? "FAKE PAYER", originalTrace: it.trace_number, code: it.code, returnDate: it.returned_on, ...(it.corrected_data ? { correctedData: it.corrected_data } : {}) })).join("");
  const control = pad(`9${String(1).padStart(6, "0")}${String(Math.ceil((items.length * 2 + 2) / 10)).padStart(6, "0")}${String(items.length * 2).padStart(8, "0")}`, 94);
  return `${header}\n${body}${control}\n`;
}

// ---------------------------------------------------------------- the enrollment as 2.3 reads it (the JSONB autodraft_enrollments row)
export interface EnrollmentView { readonly e: Enrollment; readonly raw_validation_status: string; readonly account_token: string; readonly data: Row; }
/** 2.3's Enrollment from the store row (src/app/tools/section2-3.ts writes it; cents as decimal strings). */
export function enrollmentOf(id: string, loanId: string, d: Row): EnrollmentView {
  const a = (d.authorization ?? {}) as Row;
  const authorization: Authorization = { borrower_name: String(a.borrower_name ?? ""), loan_number_masked: String(a.loan_number_masked ?? ""), routing: String(a.routing ?? ""), account_last4: String(a.account_last4 ?? d.account_last4 ?? ""), account_type: (a.account_type as Authorization["account_type"]) ?? "checking",
    amount_rule: (a.amount_rule as Authorization["amount_rule"]) ?? "full_periodic_payment", variable_amount_statement: a.variable_amount_statement === true, frequency: (a.frequency as Authorization["frequency"]) ?? "monthly", first_debit_on: D(String(a.first_debit_on ?? d.next_draft_on ?? "2000-01-01")),
    authorized_on: D(String(a.authorized_on ?? "2000-01-01")), company_name: String(a.company_name ?? ""), revocation_instructions: a.revocation_instructions === true, optional_statement: a.optional_statement === true, esign_consent: a.esign_consent === true, sec: (a.sec as Authorization["sec"]) ?? "WEB" };
  const raw = String(d.validation_status ?? "pending");
  const e: Enrollment = { id, loan_id: loanId, status: (d.status as Enrollment["status"]) ?? "requested", authorization, draft_day: Number(d.draft_day ?? 1), extra_principal_cents: c(d.extra_principal_cents), include_fees: d.include_fees === true, next_draft_on: typeof d.next_draft_on === "string" && d.next_draft_on ? D(d.next_draft_on) : null,
    validation_status: /^validated/.test(raw) ? "validated" : raw === "failed" ? "failed" : "pending", reinitiations: Array.isArray(d.reinitiations) ? (d.reinitiations as string[]).map((x) => D(x)) : [], returns_on_current_installment: Number(d.returns_on_current_installment ?? 0), last_debit_cents: d.last_debit_cents === null || d.last_debit_cents === undefined || d.last_debit_cents === "" ? null : c(d.last_debit_cents),
    notices: Array.isArray(d.notices) ? (d.notices as Row[]).map((n) => ({ template: String(n.template), sent_on: D(String(n.sent_on)), amount_cents: c(n.amount_cents), debit_on: D(String(n.debit_on)) })) : [] };
  return { e, raw_validation_status: raw, account_token: String(d.bank_account_token ?? `FAKE${authorization.account_last4 || "0000"}`), data: d };
}
/** The loan's grace days for 2.3 rule 3 (the configuration row's late-charge terms — rule 9 — else the terms row's, else 15). */
async function graceDaysFor(q: Queryable, loanId: string, asOf: PlainDate): Promise<number> {
  const cfg = await servicingConfigIfAny(q, loanId, asOf);
  if (cfg?.late_charge_terms?.grace_days !== undefined) return Number(cfg.late_charge_terms.grace_days);
  const t = (await q.query<{ g: number | null }>(`SELECT late_charge_grace_days AS g FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]))[0];
  return Number(t?.g ?? 15);
}
/** The installment the enrollment's next draft pays: the first `due` row in the month of `next_draft_on` (else the first due row within the last 31 days). */
async function nextDueRow(q: Queryable, loanId: string, e: Enrollment, asOf: PlainDate): Promise<InstallmentRow | undefined> {
  const from = e.next_draft_on ? startOfMonth(e.next_draft_on) : addDays(asOf, -31);
  return (await readSchedule(q, loanId, { status: "due", from }))[0];
}

// ---------------------------------------------------------------- the settlement feed (the FAKE ODFI settles on the effective entry date in the demo clock)
export interface SettledEntry { readonly entry_id: string; readonly loan_id: string; readonly payment_id: string; readonly settlement_date: PlainDate; readonly amount_cents: string; readonly duplicate: boolean; }
/** Every transmitted / acknowledged entry whose effective entry date is on or before `asOf` settles on that date: `ach.entry.settled`, the loan's `payments` row, the enrollment's last debit and next draft. */
export async function settleTransmittedEntries(rt: Runtime, asOf: PlainDate): Promise<SettledEntry[]> {
  const ports = ports35_5(rt);
  const due = (await rt.db.query<Row>(`SELECT ${ENTRY_COLS} FROM ach_entries WHERE status IN ('transmitted', 'acknowledged') AND effective_entry_date <= $1::date AND loan_id IS NOT NULL ORDER BY effective_entry_date, created_at`, [asOf])).map(entryOf);
  const out: SettledEntry[] = [];
  for (const entry of due) {
    const loanId = entry.loan_id!; const settlementDate = entry.effective_entry_date;
    const opened = await openUnit(rt, { loanId }); let bound: BoundUnit | undefined; let settled: SettledEntry | undefined;
    await rt.uow.run({ loanId }, async (uow) => {
      bound = bindUnit(rt, opened, uow); const ctx = bound.ctx;
      const rec = entry.enrollment_key ? bound.store.get("autodraft_enrollments", entry.enrollment_key) : undefined;
      const view = rec ? enrollmentOf(rec.id, loanId, rec.data) : null;
      const extra = view?.e.extra_principal_cents ?? 0n;
      const paymentId = randomUUID();
      // section2-3.ts settle's shape for an ACH-settled receipt (35.1's payments projector copies it unchanged): the loan's next unit posts it
      const w = ports.cashRows.writeReceivedPayment(bound.store, ctx, { payment_id: paymentId, loan_id: loanId, amount_cents: entry.amount_cents, received_on: settlementDate, credited_as_of: settlementDate, channel: "ach_debit_origin", instrument: "ach", designation: "contractual", status: "received", idempotency_key: sha256(`ach_debit_origin|${entry.id}`),
        ...(extra > 0n ? { curtailment_cents: extra } : {}), autodraft_trace: entry.trace_number, enrollment_id: entry.enrollment_key, ach_entry_id: entry.id, received_at: ctx.clock.now() });
      ctx.events.append({ type: ENTRY_SETTLED, loanId, ...(entry.enrollment_key ? { aggregate: enrollmentAgg(entry.enrollment_key) } : {}), actor: CASHIERING_AGENT, payload: { entry_id: entry.id, enrollment_id: entry.enrollment_key, loan_id: loanId, settlement_date: settlementDate, effective_entry_date: entry.effective_entry_date, amount_cents: s(entry.amount_cents), curtailment_cents: s(extra), trace: entry.trace_number, payment_id: w.payment_id, company_entry_description: entry.company_entry_description, file_id: entry.file_id, reinitiation_count: entry.reinitiation_count, duplicate: w.duplicate } });
      // the enrollment's own fields 2.3's settle moves: the last debit and the next draft (the following installment's settlement date, 2.3 rule 3)
      if (rec && view && !w.duplicate) {
        const grace = await graceDaysFor(rt.db, loanId, asOf);
        const rows = await readSchedule(rt.db, loanId, { from: startOfMonth(entry.effective_entry_date) });
        const paid = rows.find((r) => settlementDateFor(r.due_date, view.e.draft_day, grace, federal) === entry.effective_entry_date) ?? rows[0];
        const following = paid ? rows.find((r) => r.due_date > paid.due_date) : undefined;
        const nextDraft = following ? settlementDateFor(following.due_date, view.e.draft_day, grace, federal) : paid ? settlementDateFor(addMonths(paid.due_date, 1), view.e.draft_day, grace, federal) : null;
        bound.store.put("autodraft_enrollments", rec.id, { ...rec.data, last_debit_cents: s(entry.amount_cents), last_settlement_date: settlementDate, last_entry_id: entry.id, ...(nextDraft ? { next_draft_on: nextDraft } : {}), version_at: ctx.clock.now() }, CASHIERING_AGENT, ctx.clock.now());
      }
      settled = { entry_id: entry.id, loan_id: loanId, payment_id: w.payment_id, settlement_date: settlementDate, amount_cents: s(entry.amount_cents), duplicate: w.duplicate };
      bound.deferWrite(async (q) => { await q.query(`UPDATE ach_entries SET status = 'settled', settlement_date = $2 WHERE id = $1 AND status IN ('transmitted', 'acknowledged')`, [entry.id, settlementDate]); });
    }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); } });
    if (settled) out.push(settled);
  }
  return out;
}

// ---------------------------------------------------------------- the file build (`ach_file_build`)
export interface BuildInput { readonly as_of_date: PlainDate; }
export interface BuildRefusal { readonly enrollment_id: string; readonly loan_id: string; readonly gate: string; readonly code: string; readonly reason: string; readonly entry_id: string | null; }
export interface BuildSkip { readonly enrollment_id: string; readonly loan_id: string; readonly reason: string; readonly settlement_date: PlainDate | null; readonly entry_id: string | null; }
export interface BuildReport {
  readonly as_of_date: PlainDate; readonly run_id: string; readonly window: { readonly t1: PlainDate; readonly t2: PlainDate }; readonly file_id: string | null; readonly file_name: string | null; readonly sha256: string | null; readonly document_id: string | null; readonly file_id_modifier: string | null;
  readonly entries: number; readonly entry_ids: readonly string[]; readonly total_debit_cents: string; readonly refused: readonly BuildRefusal[]; readonly skipped: readonly BuildSkip[]; readonly transmitted: boolean; readonly ack_status: string | null; readonly transmit_reason: string | null;
  readonly built_event_id: string | null; readonly transmitted_event_id: string | null; readonly receipt_event_id: string; readonly retransmitted: readonly string[];
}
interface Candidate { readonly id: string; readonly loan_id: string; readonly enrollment_key: string; readonly sec_code: string; readonly amount_cents: Cents; readonly effective_entry_date: PlainDate; readonly description: string; readonly reinitiation_of_entry_id: string | null; readonly reinitiation_count: number; readonly idempotency_key: string; readonly existing: boolean; readonly routing: string; readonly account: string; readonly account_type: "checking" | "savings"; readonly individual_id: string; readonly individual_name: string; }
const GATE_NAMES: Readonly<Record<string, string>> = { "2.3.accountValidated": "NACHA_WEB_ACCOUNT_VALIDATION_GATE", ENROLLMENT_ACTIVE: "NACHA_WEB_ACCOUNT_VALIDATION_GATE", TEN_DAY_NOTICE: "REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10", NSF_RETRY_MAX2: "MAX_2_REINITIATIONS_180", NO_UNAUTHORIZED_REINITIATION: "NACHA_R11_CORRECTED_REINITIATION_60", SETTLEMENT_PAST_PENALTY_FREE: "FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE" };
const buildRecord = (r: Pick<BuildReport, "as_of_date" | "file_id" | "entries" | "total_debit_cents" | "refused" | "sha256" | "transmitted">): Row => ({ action: "ach.file.build", inputs: { as_of_date: r.as_of_date }, outputs: { file_id: r.file_id, entries: r.entries, total_debit_cents: r.total_debit_cents, sha256: r.sha256, transmitted: r.transmitted, refused: r.refused.map((x) => ({ enrollment_id: x.enrollment_id, gate: x.gate, code: x.code })) }, rule_set_version: RULE_SET_RETURNS, model_version: MODEL_VERSION_DETERMINISTIC, prompt_version: PROMPT_VERSION_35_5, confidence: 1 });
/** The decision's rationale: every refusal named by the 2.3 gate that refused it (GATES_ARE_2_3S). */
export const buildRationale = (r: Pick<BuildReport, "as_of_date" | "file_id" | "entries" | "total_debit_cents" | "refused" | "run_id">): string =>
  `cashiering.returns.v1: ach_file_build ${r.as_of_date} run ${r.run_id}: ${r.file_id ? `file ${r.file_id}` : "no file"} — ${r.entries} entr${r.entries === 1 ? "y" : "ies"}, total_debit_cents ${r.total_debit_cents}${r.refused.length ? `; refused (GATES_ARE_2_3S): ${r.refused.map((x) => `${x.enrollment_id} ${x.gate} (${x.code}: ${x.reason})`).join("; ")}` : ""}`;

/** The `ach_file_build` unit for a banking day (rule 8) — see the header. */
export async function buildAchFile(rt: Runtime, input: BuildInput, opts: { recordDecision: boolean } = { recordDecision: true }): Promise<BuildReport> {
  const asOf = input.as_of_date; const ports = ports35_5(rt); const now = rt.clock.now();
  const t1 = addBusinessDays(asOf, 1, federal); const t2 = addBusinessDays(asOf, 2, federal);
  const run = await ports.cycles.openRun(CYCLE_ACH_FILE_BUILD, asOf, asOf, 1, `ach.file.build:${now}`);
  const retransmitted = await retransmitDeferred(rt, now);
  const refused: BuildRefusal[] = []; const skipped: BuildSkip[] = []; const candidates: Candidate[] = [];
  // (A) every active enrollment on the book: the installment its next draft pays, 2.3 rule 3's settlement date, 2.3 rule 4's amount; in the window → 2.3's own nacha.build_entry in the loan's unit of work
  for (const row of await ports.cashRows.activeEnrollments()) {
    const loanId = row.loan_id; if (!loanId) continue;
    const view = enrollmentOf(row.id, loanId, row.data); const e = view.e;
    const loan = (await rt.db.query<{ status: string; boarded_at: string | null; servicer_loan_number: string | null }>(`SELECT status::text AS status, boarded_at::text AS boarded_at, servicer_loan_number FROM loans WHERE id = $1`, [loanId]))[0];
    if (!loan || !loan.boarded_at || EXCLUDED_STATUSES.includes(loan.status)) { skipped.push({ enrollment_id: e.id, loan_id: loanId, reason: "loan_not_serviced", settlement_date: null, entry_id: null }); continue; }
    const grace = await graceDaysFor(rt.db, loanId, asOf);
    const dueRow = await nextDueRow(rt.db, loanId, e, asOf);
    if (!dueRow) { skipped.push({ enrollment_id: e.id, loan_id: loanId, reason: "no_due_installment", settlement_date: null, entry_id: null }); continue; }
    const settlement = settlementDateFor(dueRow.due_date, e.draft_day, grace, federal);
    if (settlement < t1 || settlement > t2) { skipped.push({ enrollment_id: e.id, loan_id: loanId, reason: settlement < t1 ? "settlement_before_window" : "settlement_after_window", settlement_date: settlement, entry_id: null }); continue; }
    const amount = draftAmount(e, dueRow.pi_cents + dueRow.escrow_cents, 0n);
    const key = sha256(`${e.id}|${settlement}|${s(amount)}|0`);
    const existing = (await rt.db.query<{ id: string }>(`SELECT id FROM ach_entries WHERE idempotency_key = $1`, [key]))[0];
    if (existing) { skipped.push({ enrollment_id: e.id, loan_id: loanId, reason: "already_built", settlement_date: settlement, entry_id: existing.id }); continue; }
    // the penalty-free date (C-1.1-03): 2.3's own evaluator over the draft's facts
    const penaltyFree = evaluateGate("2.3.settlementWithinGrace", { settlement_date: settlement, due_date: dueRow.due_date, grace_days: grace });
    if (!penaltyFree.open) { refused.push({ enrollment_id: e.id, loan_id: loanId, gate: GATE_NAMES.SETTLEMENT_PAST_PENALTY_FREE!, code: "SETTLEMENT_PAST_PENALTY_FREE", reason: penaltyFree.reason ?? "settlement date is after due date + grace", entry_id: null }); continue; }
    const notice = variableAmountNoticeStatus(e, amount, settlement, asOf);
    const variableAmount = e.last_debit_cents !== null && e.last_debit_cents !== amount;
    const opened = await openUnit(rt, { loanId }); let bound: BoundUnit | undefined;
    try {
      await rt.uow.run({ loanId }, async (uow) => {
        bound = bindUnit(rt, opened, uow);
        await executeInUnit(rt, bound, { process: "2.3", name: "nacha.build_entry", actor: CASHIERING_AGENT, input: { enrollment_id: e.id, loan_id: loanId, amount_cents: s(amount), settlement_date: settlement, sec_code: e.authorization.sec, enrollment_status: e.status, facts: { validation_status: view.raw_validation_status, due_date: dueRow.due_date, settlement_date: settlement, grace_days: grace }, variable_amount: variableAmount, ten_day_notice_satisfied: notice.ok, nsf_reinitiations: e.reinitiations.length, installment_due_date: dueRow.due_date, company_entry_description: DESCRIPTION_DRAFT } });
      }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); } });
    } catch (err) {
      if (!(err instanceof CommandRefused)) throw err;
      refused.push({ enrollment_id: e.id, loan_id: loanId, gate: GATE_NAMES[err.code] ?? err.code, code: err.code, reason: err.message, entry_id: null });
      continue;
    }
    candidates.push({ id: randomUUID(), loan_id: loanId, enrollment_key: e.id, sec_code: e.authorization.sec, amount_cents: amount, effective_entry_date: settlement, description: DESCRIPTION_DRAFT, reinitiation_of_entry_id: null, reinitiation_count: 0, idempotency_key: key, existing: false,
      routing: e.authorization.routing || FAKE_ODFI.routing, account: view.account_token, account_type: e.authorization.account_type, individual_id: e.authorization.loan_number_masked || loan.servicer_loan_number || loanId.slice(0, 15), individual_name: e.authorization.borrower_name || "BORROWER" });
  }
  // (B) the reinitiations 2.3 rule 7 scheduled (built, no file yet): in the window they ride this file; one whose date has passed is named for the officer
  for (const r of (await rt.db.query<Row>(`SELECT ${ENTRY_COLS} FROM ach_entries WHERE status = 'built' AND file_id IS NULL AND loan_id IS NOT NULL ORDER BY effective_entry_date, created_at`)).map(entryOf)) {
    if (r.effective_entry_date > t2) { skipped.push({ enrollment_id: r.enrollment_key ?? "", loan_id: r.loan_id!, reason: "settlement_after_window", settlement_date: r.effective_entry_date, entry_id: r.id }); continue; }
    if (r.effective_entry_date < t1) { refused.push({ enrollment_id: r.enrollment_key ?? "", loan_id: r.loan_id!, gate: "SETTLEMENT_DATE_PASSED", code: "SETTLEMENT_DATE_PASSED", reason: `entry ${r.id} (${r.company_entry_description}) was to settle ${r.effective_entry_date}, before the window ${t1}…${t2}`, entry_id: r.id }); continue; }
    const rec = r.enrollment_key ? await rt.entities.current("autodraft_enrollments", r.enrollment_key) : undefined;
    const view = rec ? enrollmentOf(rec.id, r.loan_id!, rec.data) : null;
    candidates.push({ id: r.id, loan_id: r.loan_id!, enrollment_key: r.enrollment_key ?? "", sec_code: r.sec_code, amount_cents: r.amount_cents, effective_entry_date: r.effective_entry_date, description: r.company_entry_description, reinitiation_of_entry_id: r.reinitiation_of_entry_id, reinitiation_count: r.reinitiation_count, idempotency_key: r.idempotency_key, existing: true,
      routing: view?.e.authorization.routing || FAKE_ODFI.routing, account: view?.account_token ?? "FAKE0000", account_type: view?.e.authorization.account_type ?? "checking", individual_id: view?.e.authorization.loan_number_masked || r.loan_id!.slice(0, 15), individual_name: view?.e.authorization.borrower_name || "BORROWER" });
  }
  const total = candidates.reduce((a, x) => a + x.amount_cents, 0n);
  const base = { as_of_date: asOf, run_id: run.run_id, window: { t1, t2 }, refused, skipped, retransmitted };
  // (C) nothing to build: the day's `ach.file.built{entries: 0}` still completes the cycle (the recurring clock re-arms), the decision names the refusals
  if (!candidates.length) {
    const rep: Omit<BuildReport, "receipt_event_id"> = { ...base, file_id: null, file_name: null, sha256: null, document_id: null, file_id_modifier: null, entries: 0, entry_ids: [], total_debit_cents: "0", transmitted: false, ack_status: null, transmit_reason: null, built_event_id: null, transmitted_event_id: null };
    const built = await rt.uow.run({}, (ctx) => {
      const ev = ctx.events.append({ type: FILE_BUILT, aggregate: { kind: "cycle_run", id: run.run_id }, actor: CASHIERING_AGENT, payload: { file_id: null, as_of_date: asOf, run_id: run.run_id, entries: 0, total_debit_cents: "0", sha256: null, refused: refused.map((x) => ({ enrollment_id: x.enrollment_id, gate: x.gate, code: x.code })), skipped: skipped.length, origination: true } });
      if (opts.recordDecision) ctx.decide({ agent: CASHIERING_AGENT.id, action: "ach.file.build", rationale: `${buildRationale(rep)} — ${toJson(buildRecord(rep))}`, ruleSetVersion: RULE_SET_RETURNS, subject: { kind: "cycle_run", id: run.run_id }, ...(refused.length ? { ruleCode: "GATES_ARE_2_3S" } : {}), confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 });
      return ev;
    }, { clock: rt.clock });
    await ports.cycles.completeRun(run.run_id, { units_done: 1, units_dead: 0, units_skipped: 0 });
    const receipt = await electBuildReceipt(rt, { ...rep, built_event_id: built.result.id });
    return { ...rep, built_event_id: built.result.id, receipt_event_id: receipt.id };
  }
  // (D) the file: traces, the codec's batches (one per SEC code, description and effective date), one global unit of work for `ach.file.built`, the ach_files row, the entries and the stored file
  const traceBase = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM ach_entries WHERE trace_number IS NOT NULL`))[0]!.c);
  const traced = candidates.map((x, k) => ({ ...x, trace_sequence: traceBase + k + 1, trace_number: traceNumber(FAKE_ODFI.routing, traceBase + k + 1) }));
  const batches: AchBatch[] = [];
  for (const x of traced) {
    const keyOf = (b: AchBatch): string => `${b.secCode}|${b.entryDescription}|${b.effectiveDate}`;
    const entry: AchEntry = { transactionCode: x.account_type === "savings" ? "37" : "27", routingNumber: x.routing, accountNumber: x.account, amountCents: x.amount_cents, individualId: x.individual_id, individualName: x.individual_name, traceSequence: x.trace_sequence };
    const found = batches.find((b) => keyOf(b) === `${x.sec_code}|${x.description}|${x.effective_entry_date}`);
    if (found) batches[batches.indexOf(found)] = { ...found, entries: [...found.entries, entry] };
    else batches.push({ secCode: x.sec_code as AchBatch["secCode"], companyName: FAKE_ODFI.company_name, companyId: FAKE_ODFI.company_id, entryDescription: x.description, effectiveDate: x.effective_entry_date, odfiRouting: FAKE_ODFI.routing, entries: [entry] });
  }
  const wc = wallClock(Date.parse(now), "America/New_York");
  const modifierIndex = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM ach_files WHERE (built_at AT TIME ZONE 'America/New_York')::date = $1::date`, [asOf]))[0]!.c);
  const fileIdModifier = String.fromCharCode(65 + Math.min(modifierIndex, 25));
  const content = buildNachaFile({ immediateDestination: ` ${FAKE_ODFI.immediate_destination}`, immediateOrigin: FAKE_ODFI.immediate_origin, fileDate: asOf, fileTime: `${String(wc.hour).padStart(2, "0")}${String(wc.minute).padStart(2, "0")}`, fileIdModifier, batches });
  const hash = sha256(content); const fileId = randomUUID(); const fileName = `SM-ACH-${asOf.replace(/-/g, "")}-${fileIdModifier}.ach`;
  let documentId: string | null = null;
  const rep: Omit<BuildReport, "receipt_event_id" | "transmitted" | "ack_status" | "transmit_reason" | "transmitted_event_id" | "document_id" | "built_event_id"> = { ...base, file_id: fileId, file_name: fileName, sha256: hash, file_id_modifier: fileIdModifier, entries: traced.length, entry_ids: traced.map((x) => x.id), total_debit_cents: s(total) };
  const built = await rt.uow.run({}, (ctx) => {
    const ev = ctx.events.append({ type: FILE_BUILT, aggregate: { kind: ACH_FILE_KIND, id: fileId }, actor: CASHIERING_AGENT, payload: { file_id: fileId, as_of_date: asOf, run_id: run.run_id, file_name: fileName, file_id_modifier: fileIdModifier, entries: traced.length, entry_ids: traced.map((x) => x.id), total_debit_cents: s(total), sha256: hash, refused: refused.map((x) => ({ enrollment_id: x.enrollment_id, gate: x.gate, code: x.code })), skipped: skipped.length, window: { t1, t2 }, origination: true } });
    if (opts.recordDecision) ctx.decide({ agent: CASHIERING_AGENT.id, action: "ach.file.build", rationale: `${buildRationale(rep)} — ${toJson(buildRecord({ ...rep, transmitted: false }))}`, ruleSetVersion: RULE_SET_RETURNS, subject: { kind: ACH_FILE_KIND, id: fileId }, ...(refused.length ? { ruleCode: "GATES_ARE_2_3S" } : {}), confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 });
    return ev;
  }, { clock: rt.clock, commit: async (q) => {
    const doc = await ports.documents.store(q, { kind: ACH_FILE_KIND, bytes: content, mime_type: "text/plain", retention_class: "respa_5y", metadata: { source: "nacha", file_id: fileId, as_of_date: asOf, file_name: fileName, file_id_modifier: fileIdModifier, entries: traced.length } });
    documentId = doc.document_id;
    await insertAchFile(q, { id: fileId, file_id_modifier: fileIdModifier, built_at: now, entry_count: traced.length, total_debit_cents: total, document_id: doc.document_id, hash });
    for (const x of traced) {
      if (x.existing) await q.query(`UPDATE ach_entries SET file_id = $2, trace_number = $3 WHERE id = $1 AND status = 'built'`, [x.id, fileId, x.trace_number]);
      else await insertEntry(q, { id: x.id, loan_id: x.loan_id, enrollment_key: x.enrollment_key, sec_code: x.sec_code, amount_cents: x.amount_cents, effective_entry_date: x.effective_entry_date, company_entry_description: x.description, trace_number: x.trace_number, file_id: fileId, status: "built", reinitiation_of_entry_id: null, reinitiation_count: 0, idempotency_key: x.idempotency_key });
    }
  } });
  // (E) transmit through the port (35.1's outbox replaces it): accepted → the entries transmitted, `ach.file.transmitted`; rejected → officer; deferred → the next build retries with the same document
  const tx = await transmitFile(rt, { file_id: fileId, file_name: fileName, content, entries: traced.length }, now);
  await ports.cycles.completeRun(run.run_id, { units_done: 1, units_dead: 0, units_skipped: 0 });
  const full: Omit<BuildReport, "receipt_event_id"> = { ...rep, document_id: documentId, built_event_id: built.result.id, transmitted: tx.status === "accepted", ack_status: tx.status, transmit_reason: tx.reason, transmitted_event_id: tx.event_id };
  const receipt = await electBuildReceipt(rt, full);
  return { ...full, receipt_event_id: receipt.id };
}
/** The transmit: `ach_files.transmitted_at` / `ack_status`, the entries `transmitted`, `ach.file.transmitted` on acceptance; `ack_status` alone otherwise (an officer escalation on a rejection). */
async function transmitFile(rt: Runtime, f: { file_id: string; file_name: string; content: string; entries: number }, now: string): Promise<{ status: "accepted" | "rejected" | "deferred"; reason: string | null; event_id: string | null }> {
  const ports = ports35_5(rt);
  const ack = await ports.transmit.transmitAchFile({ file_id: f.file_id, file_name: f.file_name, content: f.content }, now);
  if (ack.status === "accepted") {
    await rt.db.tx(async (q) => { await q.query(`UPDATE ach_files SET transmitted_at = $2, ack_status = 'accepted' WHERE id = $1`, [f.file_id, now]); await q.query(`UPDATE ach_entries SET status = 'transmitted' WHERE file_id = $1 AND status = 'built'`, [f.file_id]); });
    const ev = await rt.uow.run({}, (ctx) => ctx.events.append({ type: FILE_TRANSMITTED, aggregate: { kind: ACH_FILE_KIND, id: f.file_id }, actor: CASHIERING_AGENT, payload: { file_id: f.file_id, file_name: f.file_name, transmitted_at: now, entries: f.entries, ack: ack.ack ?? null } }), { clock: rt.clock });
    return { status: "accepted", reason: null, event_id: ev.result.id };
  }
  await rt.db.tx((q) => q.query(`UPDATE ach_files SET ack_status = $2 WHERE id = $1`, [f.file_id, ack.status]));
  if (ack.status === "rejected") {
    const opened = await openUnit(rt, {}); let bound: BoundUnit | undefined;
    await rt.uow.run({}, async (uow) => { bound = bindUnit(rt, opened, uow); bound.escalations.open({ kind: "officer", ownerRole: "officer", severity: "2", payload: { rule_code: "ACH_FILE_REJECTED", file_id: f.file_id, file_name: f.file_name, reason: ack.reason ?? null, next: "the ODFI rejected the file: fix the entries and rebuild (the entries stay built)" } }, CASHIERING_AGENT); }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); } });
  }
  return { status: ack.status, reason: ack.reason ?? null, event_id: null };
}
/** A file the ODFI deferred (an outage) is retransmitted by the next build with the same stored document. */
async function retransmitDeferred(rt: Runtime, now: string): Promise<string[]> {
  const rows = await rt.db.query<{ id: string; entry_count: number; metadata: Row | null }>(`SELECT f.id, f.entry_count, d.metadata FROM ach_files f LEFT JOIN documents d ON d.id = f.document_id WHERE f.transmitted_at IS NULL AND f.ack_status = 'deferred' ORDER BY f.built_at`);
  const out: string[] = [];
  for (const r of rows) {
    const b64 = r.metadata && typeof r.metadata.fake_bytes_b64 === "string" ? r.metadata.fake_bytes_b64 : null; if (!b64) continue;
    const fileName = String(r.metadata?.file_name ?? `SM-ACH-${r.id}.ach`);
    const tx = await transmitFile(rt, { file_id: r.id, file_name: fileName, content: Buffer.from(b64, "base64").toString("utf8"), entries: r.entry_count }, now);
    if (tx.status === "accepted") out.push(r.id);
  }
  return out;
}
/** `ach.file_build.run_completed{…, origination: true}` — 35.3's spelling, emitted here so the registry finds it (deleted at 35.3's merge — plan §9 R1). */
async function electBuildReceipt(rt: Runtime, r: Omit<BuildReport, "receipt_event_id">): Promise<DomainEvent> {
  const res = await rt.uow.run({}, (ctx) => ctx.events.append({ type: BUILD_RUN_COMPLETED, aggregate: { kind: "cycle_run", id: r.run_id }, actor: CASHIERING_AGENT,
    payload: { as_of_date: r.as_of_date, run_id: r.run_id, cycle_code: CYCLE_ACH_FILE_BUILD, period_key: r.as_of_date, file_id: r.file_id, entries: r.entries, total_debit_cents: r.total_debit_cents, refused: r.refused.length, skipped: r.skipped.length, transmitted: r.transmitted, ack_status: r.ack_status, retransmitted: r.retransmitted, origination: true } }), { clock: rt.clock });
  return res.result;
}

// ---------------------------------------------------------------- the return action (2.3 rule 7 for one entry, on an open loan unit of work)
export interface ActionInput { readonly entry_id: string; readonly action?: ReturnAction | null; readonly as_of: PlainDate; readonly actor?: Actor; readonly return_file_id?: string | null; }
export interface ActionOutcome {
  readonly entry_id: string; readonly loan_id: string; readonly enrollment_id: string; readonly code: string; readonly action: ReturnAction; readonly payment_id: string | null; readonly reversed: boolean; readonly reversal_entry_set_ids: readonly string[]; readonly restored_due_dates: readonly string[];
  readonly nsf_fee_id: string | null; readonly nsf_fee_cents: string | null; readonly nsf_refused: string | null; readonly reinitiation_entry_id: string | null; readonly retry_on: PlainDate | null; readonly enrollment_status: string; readonly escalation_id: string | null; readonly notice_id: string | null; readonly notice_template: string | null; readonly return_id: string; readonly actioned_event_id: string;
}
const actionRecord = (o: ActionOutcome): Row => ({ entry_id: o.entry_id, loan_id: o.loan_id, action: "ach.return.action", inputs: { return_code: o.code, as_of: null }, outputs: { action: o.action, payment_id: o.payment_id, nsf_fee_id: o.nsf_fee_id, reinitiation_entry_id: o.reinitiation_entry_id, retry_on: o.retry_on, enrollment_status: o.enrollment_status, escalation_id: o.escalation_id }, rule_set_version: RULE_SET_RETURNS, model_version: MODEL_VERSION_DETERMINISTIC, prompt_version: PROMPT_VERSION_35_5, confidence: 1 });
/** 2.3 rule 7 applied to one returned entry (the ingest received it: status `returned`, its `ach_returns` row unactioned) — see the header. Throws CommandRefused with nothing written. */
export async function actionReturn(rt: Runtime, u: BoundUnit, i: ActionInput, opts: { recordDecision: boolean }): Promise<ActionOutcome> {
  const command = "ach.return.action"; const ctx = u.ctx; const actor = i.actor ?? CASHIERING_AGENT; const ports = ports35_5(rt);
  const entry = await readEntry(rt.db, i.entry_id); if (!entry) throw new RangeError(`no ach entry ${i.entry_id}`);
  if (!entry.loan_id || !entry.enrollment_key) refuse(command, "ENROLLMENT_REQUIRED", "35.5 rule 8: a return is actioned on its loan's enrollment", `entry ${entry.id} names no loan / enrollment`);
  const loanId = entry.loan_id;
  if (ctx.loanId !== loanId) refuse(command, "LOAN_SCOPE_REQUIRED", "35.5 rule 8: `ach.return.action` is one command per entry inside the loan's unit of work", `entry ${entry.id} belongs to loan ${loanId}, not the command's scope ${ctx.loanId || "(global)"}`);
  if (entry.status !== "returned" || !entry.return_code) refuse(command, "RETURN_REQUIRED", "35.5 rule 8: `ach_returns_ingest` matches the return to its entry before it is actioned", `entry ${entry.id} is ${entry.status}, not returned`);
  const returns = await readReturnsFor(rt.db, entry.id); const ret = returns[returns.length - 1];
  if (!ret) refuse(command, "RETURN_REQUIRED", "35.5 rule 8", `entry ${entry.id} has no ach_returns row`);
  if (ret.action_taken) refuse(command, "RETURN_ACTIONED", "35.5 rule 8: one action per return (idempotent by the ach_returns row)", `return ${ret.id} on entry ${entry.id} was actioned (${ret.action_taken})`);
  const code = ret.return_code;
  if (i.action && !RETURN_ACTIONS.includes(i.action)) throw new RangeError(`action must be one of ${RETURN_ACTIONS.join(", ")}`);
  if (i.action && i.action !== "none_already_paid" && i.action !== "reversed_suspended") throw new RangeError(`action override must be none_already_paid or reversed_suspended — the return code decides the rest (2.3 rule 7)`);
  const rec = u.store.get("autodraft_enrollments", entry.enrollment_key);
  if (!rec) refuse(command, "ENROLLMENT_REQUIRED", "35.5 rule 8", `no autodraft enrollment ${entry.enrollment_key} on loan ${loanId}`);
  const payment = u.store.list("payments", (d) => d.ach_entry_id === entry.id)[0];
  const posted = !!payment && payment.data.status === "posted";
  const unposted = !!payment && (payment.data.status === "received" || payment.data.status === "identified");
  // 2.7 rule 7's jurisdiction: the configuration row's nsf_fee_allowed (rule 9) and jurisdiction_rules.nsf_fee's cap (NSF_ONLY_WHERE_ALLOWED)
  const cfg = await servicingConfigIfAny(rt.db, loanId, i.as_of);
  const jurisdiction = cfg ? await jurisdictionRulesFor(rt.db, cfg.jurisdiction_state) : null;
  const nsfAllowed = cfg?.nsf_fee_allowed === true && jurisdiction?.nsf_fee.allowed !== false;
  const nsfCap = jurisdiction?.nsf_fee.cap_cents ?? null;
  const ourError = code === "R11";
  const facts = await loanCashStateFromRows(rt.db, loanId, i.as_of, { store: u.store, ledger: ctx.ledger });
  const recipients = recipientsOf(await servicingParties(rt, loanId));
  const installmentDue = posted && Array.isArray(payment!.data.installments) ? String((payment!.data.installments as string[])[0] ?? "") : "";
  // the fee 2.7 rule 7 would assess (for the notice's figure; assessed below when 2.3's disposition says so)
  const previewFee = nsfAllowed && !ourError && (code === "R01" || code === "R09") ? nsfFee(facts.state, { allowed: true, cap_cents: nsfCap }, { our_error: false, returned_on: i.as_of, ...(payment ? { payment_id: payment.id } : {}) }) : null;
  // 2.3's own command, in-process: the reversal (2.1 rule 9), `payment.reversed`, the rows restored (installments.restore), the return notice, the enrollment's status and retry
  const r = await executeInUnit(rt, u, { process: "2.3", name: "autodraft.read/write", actor, input: { op: "return", id: entry.enrollment_key, loan_id: loanId, code, returned_on: i.as_of, original_entry_on: entry.settlement_date ?? entry.effective_entry_date, ...(posted ? { payment_id: payment!.id } : {}), trace: entry.trace_number ?? undefined, amount_cents: s(entry.amount_cents), retry_banking_days: RETRY_BANKING_DAYS,
    ...(installmentDue ? { installment_due_date: installmentDue } : {}), defect_ours: ourError, authorization_valid: true, ...(previewFee ? { nsf_fee_cents: s(previewFee.amount_cents) } : {}), periodic_payment_cents: s(entry.amount_cents), recipients } });
  const out = (r.output ?? {}) as Row; const d = (out.disposition ?? {}) as Row;
  const retryOn = typeof d.retry_on === "string" && d.retry_on ? D(d.retry_on) : null; const enrollmentAction = String(d.enrollment_action ?? "none"); const retryRefused = typeof d.refused === "string" ? d.refused : null;
  const pay = payment ? u.store.get("payments", payment.id) : undefined;
  const reversal = pay && pay.data.reversal && typeof pay.data.reversal === "object" ? (pay.data.reversal as Row) : null;
  let reversalSets = reversal && Array.isArray(reversal.entry_set_ids) ? (reversal.entry_set_ids as string[]) : [];
  // 2.1 rule 9's mirror is every set the posting wrote (receipt · allocation · cash split). A loan-scoped unit of work hydrates only the sets with a line on the
  // loan (src/infra/db/ledger.ts setsForLoan), so 2.3's op cannot reach the custodial-only cash split (Dr pi cash / Dr ti cash / Cr clearing) and skips it: the
  // mirror is completed here from the persisted lines — negated line for line, the same rule_ref, `reversesSetId` on the set — and recorded on the payment's reversal.
  if (posted && pay && reversal) {
    const originals = Array.isArray(pay.data.ledger_entry_set_ids) ? (pay.data.ledger_entry_set_ids as string[]) : [];
    const mirrored = new Set(reversalSets.map((id) => ctx.ledger.sets().find((x) => x.id === id)?.reversesSetId).filter((x): x is string => typeof x === "string"));
    const completed: string[] = [];
    for (const setId of originals.filter((id) => !mirrored.has(id))) {
      const head = (await rt.db.query<{ description: string }>(`SELECT description FROM ledger_entry_sets WHERE id = $1`, [setId]))[0]; if (!head) continue;
      const lines = await rt.db.query<{ scope: string; account: string; loan_id: string | null; custodial_account_id: string | null; amount_cents: bigint; rule_ref: string }>(`SELECT scope::text AS scope, account, loan_id, custodial_account_id, amount_cents, rule_ref FROM ledger_lines WHERE set_id = $1 ORDER BY sequence`, [setId]);
      if (!lines.length) continue;
      const mirror = ctx.ledger.post({ effectiveDate: i.as_of, description: `REVERSAL of ${head.description}: returned item ${code} (${payment!.id})`, reversesSetId: setId,
        lines: lines.map((l) => ({ account: (l.scope === "loan" ? { scope: "loan", loanId: String(l.loan_id), account: l.account } : l.scope === "custodial" ? { scope: "custodial", custodialAccountId: String(l.custodial_account_id), account: l.account } : { scope: "corporate", account: l.account }) as AccountRef, amountCents: -BigInt(String(l.amount_cents)), ruleRef: l.rule_ref, memo: `reversal: returned item ${code} (${payment!.id})` })) }, ctx.clock.now());
      completed.push(mirror.id);
    }
    if (completed.length) { reversalSets = [...reversalSets, ...completed]; u.store.put("payments", pay.id, { ...pay.data, reversal: { ...reversal, entry_set_ids: reversalSets, completed_outside_scope: completed } }, actor, ctx.clock.now()); }
  }
  const restored = posted && Array.isArray(payment!.data.installments) ? (payment!.data.installments as string[]) : [];
  // a return before the payment was posted (Edge cases): the row is `returned` before any allocation, nothing to reverse
  if (unposted) u.store.put("payments", payment!.id, { ...payment!.data, status: "returned", returned: { return_code: code, returned_on: i.as_of, entry_id: entry.id } }, actor, ctx.clock.now());
  // the action: the officer's override, else 2.3's disposition
  let action: ReturnAction;
  if (i.action === "none_already_paid") action = "none_already_paid";
  else if (i.action === "reversed_suspended") action = "reversed_suspended";
  else if (enrollmentAction === "terminated") action = "account_terminated";
  else if (enrollmentAction === "revoked") action = code === "R11" ? "reversed_suspended" : "enrollment_cancelled_fraud";
  else if (enrollmentAction === "correct_and_reinitiate") action = "corrected_entry";
  else if (enrollmentAction === "suspended_returns" || enrollmentAction === "paused") action = "reversed_suspended";
  else action = retryOn && !retryRefused && entry.reinitiation_count < MAX_REINITIATIONS ? "reversed_reinitiated" : "reversed_suspended";
  // the NSF fee (2.7 rule 7 through 2.7's own op): only where allowed, min(2,500¢, cap), once per returned item, never for R11 or our error
  let nsfFeeId: string | null = null; let nsfCents: string | null = null; let nsfRefused: string | null = null;
  if (d.assess_nsf_fee === true) {
    if (!nsfAllowed) nsfRefused = `NSF_ONLY_WHERE_ALLOWED: ${cfg ? `${cfg.jurisdiction_state} does not allow an NSF fee (loan_servicing_configs.nsf_fee_allowed = false)` : "no configuration row (CONFIG_REQUIRED)"}`;
    else {
      const ops = new CashieringOps({ events: ctx.events, clock: { now: () => ctx.clock.now() }, actor });
      const fee = ops.assessNsf(facts.state, { allowed: true, cap_cents: nsfCap }, { our_error: ourError, returned_on: i.as_of, return_code: code, ...(payment ? { payment_id: payment.id } : {}) });
      if (fee) {
        ports.cashRows.writeFee(u.store, ctx, { ...fee, loan_id: loanId });
        ctx.ledger.post({ effectiveDate: i.as_of, description: `nsf fee ${fee.id}`, lines: [{ account: loanAcct(loanId, "nsf_fees"), amountCents: fee.amount_cents, ruleRef: RULE_REF_NSF }, { account: { scope: "corporate", account: "nsf_fee_income" }, amountCents: -fee.amount_cents, ruleRef: RULE_REF_NSF }] }, ctx.clock.now());
        nsfFeeId = fee.id; nsfCents = s(fee.amount_cents);
      } else nsfRefused = "2.7 rule 7: not assessed (already assessed once for this returned item, or an overlay)";
    }
  }
  // the reinitiation entry ("RETRY PYMT" on the third banking day after the return's settlement date; R11's corrected entry) — never a third within 180 days (MAX_2_REINITIATIONS_180)
  let reinitiationId: string | null = null; let reinitiation: NewEntry | null = null;
  if ((action === "reversed_reinitiated" || action === "corrected_entry") && retryOn) {
    const count = entry.reinitiation_count + 1;
    reinitiationId = randomUUID();
    reinitiation = { id: reinitiationId, loan_id: loanId, enrollment_key: entry.enrollment_key, sec_code: entry.sec_code, amount_cents: entry.amount_cents, effective_entry_date: retryOn, company_entry_description: typeof d.company_entry_description === "string" && d.company_entry_description ? d.company_entry_description : DESCRIPTION_RETRY, trace_number: null, file_id: null, status: "built", reinitiation_of_entry_id: entry.id, reinitiation_count: count, idempotency_key: sha256(`${entry.enrollment_key}|${retryOn}|${s(entry.amount_cents)}|${count}`) };
  }
  // the enrollment's status after 2.3's op (its own save); the MAX-2 exhaustion 2.3 refused becomes `suspended_returns` with the borrower-comms hand-off (rule 8)
  let enrollmentStatus = String(u.store.get("autodraft_enrollments", entry.enrollment_key)?.data.status ?? rec.data.status ?? "active");
  let escalationId: string | null = null;
  if (action === "reversed_suspended" && !i.action && code !== "R11" && enrollmentStatus === "active") {
    const cur = u.store.get("autodraft_enrollments", entry.enrollment_key)!;
    u.store.put("autodraft_enrollments", cur.id, { ...cur.data, status: "suspended_returns", suspended_on: i.as_of, suspended_reason: "MAX_2_REINITIATIONS_180", version_at: ctx.clock.now() }, actor, ctx.clock.now());
    ctx.events.append({ type: "autodraft.status.changed", loanId, aggregate: enrollmentAgg(entry.enrollment_key), actor, payload: { enrollment_id: entry.enrollment_key, status: "suspended_returns", return_code: code, reason: "MAX_2_REINITIATIONS_180", refused: retryRefused } });
    enrollmentStatus = "suspended_returns";
  }
  if (action === "reversed_suspended") {
    const esc = u.escalations.open({ kind: "human_portal_task", ownerRole: "borrower-comms", loanId, severity: "3", payload: { rule_code: "MAX_2_REINITIATIONS_180", timer_code: "NACHA_NSF_REINITIATION_180_MAX2", enrollment_id: entry.enrollment_key, entry_id: entry.id, return_code: code, payment_id: payment?.id ?? null, enrollment_status: enrollmentStatus, returns_on_current_installment: Number(u.store.get("autodraft_enrollments", entry.enrollment_key)?.data.returns_on_current_installment ?? 0), refused: retryRefused,
      next: "no further reinitiation is built (2.3 rule 7: at most two within 180 days; the second return on one installment suspends the enrollment) — contact the borrower for a new payment method or a reconfirmation (borrower-comms hand-off)" } }, actor);
    escalationId = esc.id;
  }
  const returnId = ret.id; const rein = reinitiation;
  u.deferWrite(async (q) => {
    await q.query(`UPDATE ach_returns SET action_taken = $2 WHERE id = $1 AND action_taken IS NULL`, [returnId, action]);
    if (rein) await insertEntry(q, rein);
  });
  const notice_id = typeof out.notice_id === "string" ? out.notice_id : null; const notice_template = typeof out.notice_template === "string" ? out.notice_template : null;
  const actioned = ctx.events.append({ type: RETURN_ACTIONED, loanId, aggregate: enrollmentAgg(entry.enrollment_key), actor, causationId: r.event.id, payload: { entry_id: entry.id, payment_id: posted ? payment!.id : null, code, return_code: code, action, nsf_fee_id: nsfFeeId, nsf_fee_cents: nsfCents, nsf_refused: nsfRefused, reinitiation_entry_id: reinitiationId, retry_on: retryOn, enrollment_id: entry.enrollment_key, enrollment_status: enrollmentStatus, reversed: reversalSets.length > 0, reversal_entry_set_ids: reversalSets, restored_due_dates: restored, return_id: returnId, return_file_id: i.return_file_id ?? null, escalation_id: escalationId, notice_id, notice_template, override: i.action ?? null, actioned_on: i.as_of } });
  const o: ActionOutcome = { entry_id: entry.id, loan_id: loanId, enrollment_id: entry.enrollment_key, code, action, payment_id: posted ? payment!.id : null, reversed: reversalSets.length > 0, reversal_entry_set_ids: reversalSets, restored_due_dates: restored, nsf_fee_id: nsfFeeId, nsf_fee_cents: nsfCents, nsf_refused: nsfRefused, reinitiation_entry_id: reinitiationId, retry_on: retryOn, enrollment_status: enrollmentStatus, escalation_id: escalationId, notice_id, notice_template, return_id: returnId, actioned_event_id: actioned.id };
  if (opts.recordDecision) ctx.decide({ agent: CASHIERING_AGENT.id, action: "ach.return.action", rationale: `${actionRationale(o)} — ${toJson(actionRecord(o))}`, ruleSetVersion: RULE_SET_RETURNS, loanId, subject: { kind: "ach_entry", id: entry.id }, ...(action === "reversed_suspended" ? { ruleCode: "MAX_2_REINITIATIONS_180" } : nsfRefused?.startsWith("NSF_ONLY") ? { ruleCode: "NSF_ONLY_WHERE_ALLOWED" } : {}), confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5, ...(actor.kind === "human" ? { approvedBy: actor.id, ...(actor.role ? { approvedRole: actor.role } : {}) } : {}) });
  return o;
}
export const actionRationale = (o: Pick<ActionOutcome, "entry_id" | "code" | "action" | "payment_id" | "nsf_fee_id" | "nsf_fee_cents" | "nsf_refused" | "reinitiation_entry_id" | "retry_on" | "enrollment_status" | "escalation_id">): string =>
  `cashiering.returns.v1: entry ${o.entry_id} returned ${o.code} → ${o.action}${o.payment_id ? ` (payment ${o.payment_id} reversed, 2.1 rule 9)` : " (no posted payment)"}; nsf_fee ${o.nsf_fee_id ? `${o.nsf_fee_id} ${o.nsf_fee_cents}¢` : o.nsf_refused ?? "none"}; reinitiation ${o.reinitiation_entry_id ? `${o.reinitiation_entry_id} on ${o.retry_on}` : "none"}; enrollment ${o.enrollment_status}${o.escalation_id ? `; borrower-comms hand-off ${o.escalation_id}` : ""}`;

// ---------------------------------------------------------------- the return-file ingest (`ach_returns_ingest`)
export interface IngestInput { readonly as_of_date: PlainDate; }
export interface ReturnOutcome { readonly return_id: string | null; readonly entry_id: string | null; readonly loan_id: string | null; readonly trace: string; readonly code: string; readonly kind: "return" | "noc"; readonly amount_cents: string; readonly matched: boolean; readonly action: ReturnAction | null; readonly error: string | null; readonly received_event_id: string | null; readonly actioned_event_id: string | null; }
export interface ReturnFileOutcome { readonly file_id: string; readonly sha256: string; readonly file_name: string; readonly as_of_date: PlainDate; readonly status: "processed" | "duplicate"; readonly duplicate_of: string | null; readonly returns: number; readonly nocs: number; readonly matched: number; readonly unmatched: number; readonly items: readonly ReturnOutcome[]; readonly received_event_id: string | null; readonly document_id: string | null; }
export interface ReturnsIngestReport { readonly as_of_date: PlainDate; readonly run_id: string; readonly settled: readonly SettledEntry[]; readonly files: readonly ReturnFileOutcome[]; readonly returns: number; readonly nocs: number; readonly actioned: number; readonly errors: readonly { entry_id: string | null; trace: string; error: string }[]; readonly duplicates: readonly string[]; readonly receipt_event_id: string; }
export const ingestRationale = (r: Pick<ReturnsIngestReport, "as_of_date" | "run_id" | "settled" | "files" | "returns" | "nocs" | "actioned">): string =>
  `cashiering.returns.v1: ach_returns_ingest ${r.as_of_date} run ${r.run_id}: settled ${r.settled.length} entr${r.settled.length === 1 ? "y" : "ies"}; ${r.files.length ? r.files.map((f) => f.status === "duplicate" ? `${f.file_name} (sha256 ${f.sha256}) is a duplicate of return file ${f.duplicate_of} — nothing written` : `file ${f.file_id} (${f.file_name}): ${f.returns} return(s), ${f.nocs} NOC(s), ${f.matched} matched, ${f.unmatched} unmatched; ${f.items.filter((x) => x.kind === "return").map((x) => `${x.trace} ${x.code} → ${x.action ?? x.error ?? "unmatched"}`).join(", ")}`).join("; ") : "no file queued"}`;

/** The `ach_returns_ingest` unit for a banking day (rule 8) — see the header. */
export async function ingestReturnFile(rt: Runtime, input: IngestInput, opts: { recordDecision: boolean } = { recordDecision: true }): Promise<ReturnsIngestReport> {
  const asOf = input.as_of_date; const ports = ports35_5(rt); const now = rt.clock.now();
  const run = await ports.cycles.openRun(CYCLE_ACH_RETURNS_INGEST, asOf, asOf, 1, `ach.returns.ingest:${now}`);
  // (A) the settlement feed: what settled by today becomes the loan's received payment (its next unit posts it)
  const settled = await settleTransmittedEntries(rt, asOf);
  const files: ReturnFileOutcome[] = []; const errors: ReturnsIngestReport["errors"][number][] = [];
  const queued = await rt.db.tx((q) => PgFakeOdfiQueue.fetch(q, asOf, now));
  for (const f of queued) {
    // idempotency: the file's sha256 (ach_return_files unique) — the same bytes again write nothing but a decision naming the first file
    const prior = (await rt.db.query<{ id: string; as_of_date: string }>(`SELECT id, as_of_date::text AS as_of_date FROM ach_return_files WHERE sha256 = $1`, [f.sha256]))[0];
    if (prior) {
      const dup: ReturnFileOutcome = { file_id: prior.id, sha256: f.sha256, file_name: f.file_name, as_of_date: asOf, status: "duplicate", duplicate_of: prior.id, returns: 0, nocs: 0, matched: 0, unmatched: 0, items: [], received_event_id: null, document_id: null };
      if (opts.recordDecision) await rt.uow.run({}, (ctx) => { ctx.decide({ agent: CASHIERING_AGENT.id, action: "ach.returns.ingest", rationale: `DUPLICATE_FILE: ${f.file_name} (sha256 ${f.sha256}) is return file ${prior.id} (received ${prior.as_of_date}) — nothing written`, ruleSetVersion: RULE_SET_RETURNS, subject: { kind: ACH_RETURN_FILE_KIND, id: prior.id }, ruleCode: "DUPLICATE_FILE", confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 }); }, { clock: rt.clock });
      await rt.db.tx((q) => PgFakeOdfiQueue.mark(q, f.document_id, "duplicate", { duplicate_of: prior.id }));
      files.push(dup); continue;
    }
    const parsed: AchReturn[] = parseAchReturns(f.content);
    const fileId = randomUUID(); const items: ReturnOutcome[] = [];
    for (const it of parsed) {
      const trace = it.originalTrace.trim();
      const entry = trace ? await entryByTrace(rt.db, trace) : undefined;
      if (!entry || !entry.loan_id || !entry.enrollment_key) { items.push({ return_id: null, entry_id: entry?.id ?? null, loan_id: entry?.loan_id ?? null, trace, code: it.code, kind: it.kind, amount_cents: s(it.amountCents), matched: false, action: null, error: entry ? "entry has no loan" : "no entry with this trace number", received_event_id: null, actioned_event_id: null }); continue; }
      const loanId = entry.loan_id;
      if (it.kind === "noc") {
        const opened = await openUnit(rt, { loanId }); let bound: BoundUnit | undefined; let ev: DomainEvent | undefined; const nocId = randomUUID();
        await rt.uow.run({ loanId }, async (uow) => {
          bound = bindUnit(rt, opened, uow);
          ev = bound.ctx.events.append({ type: NOC_RECEIVED, loanId, aggregate: enrollmentAgg(entry.enrollment_key!), actor: CASHIERING_AGENT, payload: { noc_id: nocId, entry_id: entry.id, enrollment_id: entry.enrollment_key, code: it.code, change_code: it.code, corrected_data: it.correctedData ?? null, trace, received_on: asOf, return_file_id: fileId, next: "the enrollment's account fields are corrected on the next build (2.3 rule 2 validation by warranty); no payment effect" } });
          bound.deferWrite(async (q) => { await q.query(`INSERT INTO ach_nocs (id, entry_id, change_code, corrected_data, received_at, action_taken) VALUES ($1, $2, $3, $4::jsonb, $5, 'recorded')`, [nocId, entry.id, it.code, toJson({ corrected_data: it.correctedData ?? null, trace, return_file_id: fileId }), now]); });
        }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); } });
        items.push({ return_id: nocId, entry_id: entry.id, loan_id: loanId, trace, code: it.code, kind: "noc", amount_cents: s(it.amountCents), matched: true, action: null, error: null, received_event_id: ev?.id ?? null, actioned_event_id: null });
        continue;
      }
      // (B) the return received, in the loan's unit of work: the entry `returned`, the ach_returns row, `ach.return.received` (2.3's fields + 35.5's received_on / origination — arms SM_ACH_RETURN_ACTIONED_1BD and 2.3's own clocks)
      const returnId = randomUUID(); let receivedEv: DomainEvent | undefined;
      const already = entry.status === "returned" ? (await readReturnsFor(rt.db, entry.id)).find((x) => x.action_taken === null) : undefined;
      if (already) { /* received on an earlier pass and still unactioned: (C) actions it now */ }
      else if (entry.status === "returned") { items.push({ return_id: null, entry_id: entry.id, loan_id: loanId, trace, code: it.code, kind: "return", amount_cents: s(it.amountCents), matched: true, action: null, error: "entry already returned and actioned", received_event_id: null, actioned_event_id: null }); continue; }
      else {
        const paymentId = (await rt.entities.load({ loanId })).filter((x) => x.kind === "payments" && x.data.ach_entry_id === entry.id).sort((a, b) => b.version - a.version)[0]?.id ?? null;
        const opened = await openUnit(rt, { loanId }); let bound: BoundUnit | undefined;
        await rt.uow.run({ loanId }, async (uow) => {
          bound = bindUnit(rt, opened, uow);
          receivedEv = bound.ctx.events.append({ type: RETURN_RECEIVED, loanId, aggregate: enrollmentAgg(entry.enrollment_key!), actor: CASHIERING_AGENT, payload: { return_id: returnId, entry_id: entry.id, enrollment_id: entry.enrollment_key, code: it.code, reason_code: it.code, return_code: it.code, [it.code]: true, payment_id: paymentId, received_on: asOf, returned_on: asOf, return_settlement_date: asOf, original_settlement_date: entry.settlement_date ?? entry.effective_entry_date, trace, amount_cents: s(entry.amount_cents), return_file_id: fileId, company_entry_description: entry.company_entry_description, reinitiation_count: entry.reinitiation_count, origination: true } });
          bound.deferWrite(async (q) => {
            await q.query(`UPDATE ach_entries SET status = 'returned', return_code = $2, returned_at = $3 WHERE id = $1 AND status IN ('transmitted', 'acknowledged', 'settled', 'built')`, [entry.id, it.code, now]);
            await q.query(`INSERT INTO ach_returns (id, entry_id, return_code, received_at, action_taken, raw) VALUES ($1, $2, $3, $4, NULL, $5::jsonb)`, [returnId, entry.id, it.code, now, toJson({ kind: it.kind, code: it.code, original_trace: trace, amount_cents: s(it.amountCents), individual_id: it.individualId, return_date: it.returnDate ?? null, return_file_id: fileId, as_of_date: asOf })]);
          });
        }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); } });
      }
      // (C) 2.3 rule 7 in the next loan unit of work; a throw leaves the return received and the clock armed to breach (sev 2 → officer)
      try {
        const opened = await openUnit(rt, { loanId }); let bound: BoundUnit | undefined; let outcome: ActionOutcome | undefined;
        await rt.uow.run({ loanId }, async (uow) => { bound = bindUnit(rt, opened, uow); outcome = await actionReturn(rt, bound, { entry_id: entry.id, as_of: asOf, return_file_id: fileId }, { recordDecision: true }); }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); } });
        items.push({ return_id: outcome!.return_id, entry_id: entry.id, loan_id: loanId, trace, code: it.code, kind: "return", amount_cents: s(it.amountCents), matched: true, action: outcome!.action, error: null, received_event_id: receivedEv?.id ?? null, actioned_event_id: outcome!.actioned_event_id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ entry_id: entry.id, trace, error: message });
        items.push({ return_id: already?.id ?? returnId, entry_id: entry.id, loan_id: loanId, trace, code: it.code, kind: "return", amount_cents: s(it.amountCents), matched: true, action: null, error: message, received_event_id: receivedEv?.id ?? null, actioned_event_id: null });
      }
    }
    const returnsN = parsed.filter((x) => x.kind === "return").length; const nocsN = parsed.length - returnsN; const matched = items.filter((x) => x.matched).length; const unmatched = items.length - matched;
    // (D) the file stored and its row written once processed, with `ach.return_file.received` (an unmatched return is the officer's)
    let documentId: string | null = null; const openedG = await openUnit(rt, {}); let boundG: BoundUnit | undefined;
    const fileEv = await rt.uow.run({}, async (uow) => {
      boundG = bindUnit(rt, openedG, uow);
      const ev = boundG.ctx.events.append({ type: RETURN_FILE_RECEIVED, aggregate: { kind: ACH_RETURN_FILE_KIND, id: fileId }, actor: CASHIERING_AGENT, payload: { file_id: fileId, as_of_date: asOf, file_name: f.file_name, sha256: f.sha256, returns: returnsN, nocs: nocsN, entries_matched: matched, entries_unmatched: unmatched, received_at: f.received_at, actioned: items.filter((x) => x.action).length, errors: errors.length, origination: true } });
      for (const x of items.filter((y) => !y.matched)) boundG.escalations.open({ kind: "officer", ownerRole: "officer", severity: "2", payload: { rule_code: "RETURN_UNMATCHED", return_file_id: fileId, trace: x.trace, code: x.code, amount_cents: x.amount_cents, next: "a return with no entry of ours: reconcile with the ODFI" } }, CASHIERING_AGENT);
      return ev;
    }, { clock: rt.clock, commit: async (q) => {
      const doc = await ports.documents.store(q, { kind: ACH_RETURN_FILE_KIND, bytes: f.content, mime_type: "text/plain", retention_class: "respa_5y", metadata: { source: "nacha", return_file_id: fileId, as_of_date: asOf, file_name: f.file_name, queue_document_id: f.document_id } });
      documentId = doc.document_id;
      await insertReturnFile(q, { id: fileId, as_of_date: asOf, file_name: f.file_name, sha256: f.sha256, document_id: doc.document_id, returns: returnsN, nocs: nocsN, entries_matched: matched, entries_unmatched: unmatched, received_at: f.received_at, processed_at: now });
      if (boundG) await commitUnit(q, rt, boundG);
      await PgFakeOdfiQueue.mark(q, f.document_id, "ingested", { return_file_id: fileId });
    } });
    files.push({ file_id: fileId, sha256: f.sha256, file_name: f.file_name, as_of_date: asOf, status: "processed", duplicate_of: null, returns: returnsN, nocs: nocsN, matched, unmatched, items, received_event_id: fileEv.result.id, document_id: documentId });
  }
  const returns = files.reduce((a, f) => a + f.returns, 0); const nocs = files.reduce((a, f) => a + f.nocs, 0); const actioned = files.reduce((a, f) => a + f.items.filter((x) => x.action).length, 0);
  const duplicates = files.filter((f) => f.status === "duplicate").map((f) => f.duplicate_of!);
  await ports.cycles.completeRun(run.run_id, { units_done: files.filter((f) => f.status === "processed").length + (files.length ? 0 : 1), units_dead: errors.length, units_skipped: duplicates.length });
  const partial = { as_of_date: asOf, run_id: run.run_id, settled, files, returns, nocs, actioned, errors, duplicates };
  if (opts.recordDecision && (files.some((f) => f.status === "processed") || settled.length)) await rt.uow.run({}, (ctx) => { ctx.decide({ agent: CASHIERING_AGENT.id, action: "ach.returns.ingest", rationale: ingestRationale(partial), ruleSetVersion: RULE_SET_RETURNS, subject: files.find((f) => f.status === "processed") ? { kind: ACH_RETURN_FILE_KIND, id: files.find((f) => f.status === "processed")!.file_id } : { kind: "cycle_run", id: run.run_id }, confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 }); }, { clock: rt.clock });
  // the run's receipt (35.3's spelling, emitted here so the registry finds it; deleted at 35.3's merge — plan §9 R1)
  const receipt = await rt.uow.run({}, (ctx) => ctx.events.append({ type: RETURNS_RUN_COMPLETED, aggregate: { kind: "cycle_run", id: run.run_id }, actor: CASHIERING_AGENT,
    payload: { as_of_date: asOf, run_id: run.run_id, cycle_code: CYCLE_ACH_RETURNS_INGEST, period_key: asOf, settled: settled.length, files: files.length, file_ids: files.map((f) => f.file_id), returns, nocs, actioned, errors: errors.length, duplicates, origination: true } }), { clock: rt.clock });
  return { ...partial, receipt_event_id: receipt.result.id };
}

// ---------------------------------------------------------------- the bus tools
type Services = { runtime?: Runtime; deferWrite?: (fn: (q: Queryable) => Promise<void>) => void };
const asOfOf = (i: ToolInput): PlainDate => { const v = str(i, "as_of_date"); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new RangeError("as_of_date (YYYY-MM-DD) is required"); return D(v); };
const runtimeOf = (rt: ToolRuntime, name: string): Runtime => { const runtime = (rt.services as Services).runtime; if (!runtime) throw new RangeError(`${name} needs the hosted runtime (services.runtime)`); return runtime; };
/** `ach.file.build{as_of_date}` — the runner through `services.runtime` (its own units of work, sequential to this command's); the decision is the bus's. */
export async function achFileBuild(i: ToolInput, _ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const asOf = asOfOf(i);
  return buildAchFile(runtimeOf(rt, "ach.file.build"), { as_of_date: asOf }, { recordDecision: false });
}
/** `ach.returns.ingest{as_of_date}` — the runner through `services.runtime`; every return's own action decision is recorded in its loan's unit of work, the run's is the bus's. */
export async function achReturnsIngest(i: ToolInput, _ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const asOf = asOfOf(i);
  return ingestReturnFile(runtimeOf(rt, "ach.returns.ingest"), { as_of_date: asOf }, { recordDecision: false });
}
/** `ach.return.action{entry_id, action?}` on the command's own (loan-scoped) unit of work — 2.3 rule 7 for the entry; an `action` override is `officer`'s (the def's guardrail); the decision is the bus's. */
export async function achReturnAction(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const entryId = str(i, "entry_id"); if (!entryId) throw new RangeError("entry_id is required");
  const action = str(i, "action");
  if (action && !RETURN_ACTIONS.includes(action as ReturnAction)) throw new RangeError(`action must be one of ${RETURN_ACTIONS.join(", ")}`);
  const services = rt.services as Services; const runtime = services.runtime; const deferWrite = services.deferWrite;
  if (!runtime || !deferWrite) throw new RangeError("ach.return.action needs the hosted runtime (services.runtime, services.deferWrite)");
  const bound: BoundUnit = { scope: { loanId: ctx.loanId }, store: rt.store, mark: 0, openEscalations: [], deferred: [], ctx, escalations: rt.escalations, toolRt: rt, deferWrite };
  return actionReturn(runtime, bound, { entry_id: entryId, action: action ? (action as ReturnAction) : null, as_of: D(ctx.now.slice(0, 10)), actor: ctx.actor }, { recordDecision: false });
}
