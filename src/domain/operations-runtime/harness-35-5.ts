/**
 * Test-only fixtures for 35.5's spec tests (src/domain/operations-runtime/35-5.spec.test.ts): the tapes of the worked examples
 * boarded through the real transfer route (one-loan `TransferBatchData` → encodeTransferBatch → boardTransferBatch), the demo note
 * funded through the real hand-off (createApplication → fundApplication), and the readers the T-ids assert with. No figure is
 * asserted here — every cent is repeated as an assertion in the spec test (tools/audit.py counts only there).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../../infra/db/client.ts";
import type { ApplicationRecord } from "../../infra/db/applications.ts";
import type { Actor, FixedClock } from "../../kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { makeMin } from "../boarding/min.ts";
import { amortizedBalance } from "../boarding/demo-batch.ts";
import { PARTNER_ORG, TRANSFEROR_ORG } from "../boarding/fixtures.ts";
import { encodeTransferBatch, type TransferBatchData } from "../boarding/tape-codec.ts";
import type { StagedLoan } from "../boarding/types.ts";
import type { LoanFundedPayload, OriginationSnapshot } from "../orig-boarding/ops-30-2.ts";
import { boardTransferBatch, type TransferBatchSummary } from "../../runtime/transfers.ts";
import { demoFunded, demoSnapshot, fundApplication, type DemoOverrides, type FundApplicationResult } from "../../runtime/origination.ts";
import type { Runtime } from "../../runtime/app.ts";

export const INTAKE: Actor = { kind: "agent", id: "intake" };
export const FUNDING: Actor = { kind: "agent", id: "funding" };
export const SEED: Actor = { kind: "system", id: "seed-35-5" };
export const PARTNER_SERVICER_NUMBER = "987654321";
export const TRANSFEROR_SERVICER_NUMBER = "123456789";

// ---------------------------------------------------------------- the tapes of the worked examples (StagedLoan, 1.1's canonical view)
export interface TapeSpec {
  readonly transferor_loan_number: string; readonly original_upb_cents: Cents; readonly note_rate_pct: string; readonly original_term_months: number; readonly first_payment_date: PlainDate; readonly maturity_date: PlainDate;
  readonly next_due_date: PlainDate; readonly upb_cents: Cents; readonly pi_cents: Cents; readonly escrow_payment_cents: Cents; readonly state: string; readonly city: string; readonly postal_code: string; readonly late_charge_pct?: string; readonly late_charge_grace_days?: number;
}
/** Worked example B / 35.5-T2: tape loan T-7 ($300,000.00 at 6.500%, 360 months, first payment 2021-10-01, next due 2026-11-01, UPB $280,458.24, P&I $1,896.20, escrow $412.30, TX). */
export const T7_TAPE: TapeSpec = { transferor_loan_number: "T-7", original_upb_cents: 30_000_000n, note_rate_pct: "6.500", original_term_months: 360, first_payment_date: D("2021-10-01"), maturity_date: D("2051-09-01"), next_due_date: D("2026-11-01"), upb_cents: 28_045_824n, pi_cents: 189_620n, escrow_payment_cents: 41_230n, state: "TX", city: "Austin", postal_code: "78701" };
/** 2.1's fixture L-1 (worked example D): original $250,000.00 at 6.500%, 360, first payment 2021-09-01, maturity 2051-08-01, next due 2026-09-01, UPB $249,774.00, P&I $1,580.17, escrow $612.40, TX — a tape that does not amortize to zero (HF-005's exception on the run). */
export const L1_TAPE: TapeSpec = { transferor_loan_number: "L-1", original_upb_cents: 25_000_000n, note_rate_pct: "6.500", original_term_months: 360, first_payment_date: D("2021-09-01"), maturity_date: D("2051-08-01"), next_due_date: D("2026-09-01"), upb_cents: 24_977_400n, pi_cents: 158_017n, escrow_payment_cents: 61_240n, state: "TX", city: "Houston", postal_code: "77002" };
/** 35.5-T12's NY branch: a note late charge of 5.000% above NY's 2.000% bound (seed 0143), next due 2026-10-01. */
export const NY_TAPE: TapeSpec = { transferor_loan_number: "NY-1", original_upb_cents: 30_000_000n, note_rate_pct: "6.500", original_term_months: 360, first_payment_date: D("2021-10-01"), maturity_date: D("2051-09-01"), next_due_date: D("2026-10-01"), upb_cents: amortizedBalance(30_000_000n, "6.500", 360, 60), pi_cents: 189_620n, escrow_payment_cents: 41_230n, state: "NY", city: "Rochester", postal_code: "14604", late_charge_pct: "5.000", late_charge_grace_days: 15 };

let seq = 0;
const unique = (): string => `${Date.now() % 1_000_000}${(seq++).toString().padStart(3, "0")}`;
/** One clean loan on a transfer tape: every 1.1 hard rule passes (position, trial balance, MERS, custody, licensed state, contact, consents), twelve months of paid history before the next due date. */
export function tapeLoan(t: TapeSpec, transferDate: PlainDate): { loan: StagedLoan; data: TransferBatchData } {
  const n = `${t.transferor_loan_number}-${unique()}`;
  const fnma = String(4_200_000_000 + Number(unique().slice(-9)) % 700_000_000).padStart(10, "0").slice(0, 10);
  const min = makeMin(TRANSFEROR_ORG, unique());
  const escrowed = t.escrow_payment_cents > 0n;
  const installment = t.pi_cents + t.escrow_payment_cents;
  const installments = []; const payments = [];
  for (let k = 12; k >= 1; k--) { const due = addMonths(t.next_due_date, -k); installments.push({ due_date: due, amount_cents: installment }); payments.push({ received_on: addDays(due, 3), amount_cents: installment }); }
  const instrument = addMonths(t.first_payment_date, -2);
  const loan: StagedLoan = {
    transferor_loan_number: n, fnma_loan_number: fnma, min, mers_eligible: true, remittance_type: "A/A", upb_cents: t.upb_cents, next_due_date: t.next_due_date, note_rate_pct: t.note_rate_pct, pi_cents: t.pi_cents, escrow_payment_cents: t.escrow_payment_cents,
    maturity_date: t.maturity_date, original_term_months: t.original_term_months, original_upb_cents: t.original_upb_cents, instrument_date: instrument, origination_date: instrument, first_payment_date: t.first_payment_date, interest_method: "30_360", amortization: "fixed",
    escrowed, escrow_balance_cents: escrowed ? t.escrow_payment_cents * 3n : 0n, escrow_lines: escrowed ? [{ line_type: "county_tax", annual_amount_cents: t.escrow_payment_cents * 8n, next_due_date: addDays(transferDate, 120) }, { line_type: "hazard", annual_amount_cents: t.escrow_payment_cents * 4n, next_due_date: addDays(transferDate, 200) }] : [], escrow_sign_consistent: true,
    last_escrow_analysis_date: escrowed ? addDays(transferDate, -90) : null, late_charge_pct: t.late_charge_pct ?? "5.000", late_charge_grace_days: t.late_charge_grace_days ?? 15, deferred_principal_cents: 0n, forborne_principal_cents: 0n, nib_separated: true,
    bankruptcy: { active: false }, foreclosure: { active: false }, lossmit: { in_process: false }, scra: { active: false },
    borrower: { legal_name: `Fixture Borrower ${n}`, tin: "000-12-3456", phone: "+16025550100", email: `fixture.${n.toLowerCase()}@example.test`, preferred_language: "en" },
    property: { address_line1: `${100 + (seq % 800)} Fixture St`, city: t.city, state: t.state, postal_code: t.postal_code, occupancy: "owner_occupied" },
    custody: { custodian: "Bank Custodian NA", certification_status: "certified" }, consents: { esign_evidence: true, tcpa_voice_evidence: true }, tax_parcel_verified: true, hazard_policy_expires: addDays(transferDate, 300), mi: { flag: false }, flood_determination_life_of_loan: true,
    sii: { present: false, complete: true }, unapplied_cents: 0n, fair_lending_present: true, acp_enrolled: false, fees_advances_cents: 0n, fees_itemized: true, corporate_advances_cents: 0n, late_charges_due_cents: 0n, mers_investor_is_fnma: true, installments, payments,
  };
  const data: TransferBatchData = { loans: [loan], fnma: [{ fnma_loan_number: fnma, on_approved_list: true, remittance_type: "A/A", upb_cents: t.upb_cents }], trialBalance: [{ transferor_loan_number: n, fnma_loan_number: fnma, upb_cents: t.upb_cents }], mers: [{ min, status: "Active", servicer_org_id: TRANSFEROR_ORG, investor_org_id: "1000001" }],
    images: [{ transferor_loan_number: n, document_type: "note", filename: `${n}_note.pdf`, sha256: "a".repeat(64) }], fairLending: [{ transferor_loan_number: n, ethnicity: "Not provided", race: "Not provided", sex: "Not provided", age: "40", preferred_language: "en" }] };
  return { loan, data };
}

/** Board one tape loan through `POST /v1/transfers/batches`' route (boardTransferBatch) on `transferDate` at 14:00Z; the clock is set to that instant. */
export async function boardTapeLoan(rt: Runtime, clock: FixedClock, tape: TapeSpec, batchId: string, transferDate: PlainDate): Promise<{ loan_id: string; summary: TransferBatchSummary; loan: StagedLoan }> {
  clock.set(`${transferDate}T14:00:00.000Z`);
  const { loan, data } = tapeLoan(tape, transferDate);
  const summary = await boardTransferBatch(rt, { batch_id: batchId, transfer_date: transferDate, transferor_name: "Fixture Transferor LLC", transferor_servicer_number: TRANSFEROR_SERVICER_NUMBER, partner_servicer_number: PARTNER_SERVICER_NUMBER, transferor_mers_org_id: TRANSFEROR_ORG, partner_mers_org_id: PARTNER_ORG }, encodeTransferBatch(data), SEED);
  const loan_id = summary.loan_ids[loan.transferor_loan_number];
  if (summary.status !== "boarded" || !loan_id) throw new Error(`tape ${tape.transferor_loan_number} did not board: ${JSON.stringify({ status: summary.status, hard: summary.hard_by_loan })}`);
  return { loan_id, summary, loan };
}

// ---------------------------------------------------------------- the fund path
export interface FundOverrides { readonly snapshot?: (base: OriginationSnapshot, record: ApplicationRecord) => DemoOverrides; readonly funded?: Partial<LoanFundedPayload>; }
/** Open an application for the partner and fund it through 30.2's hand-off (`POST /v1/applications/{id}/fund`'s route: fundApplication) with the demo snapshot and any overrides. */
export async function fundDemoNote(rt: Runtime, partnerPartyId: string, o: FundOverrides = {}): Promise<{ application_id: string; result: FundApplicationResult; snapshot: OriginationSnapshot }> {
  const created = await rt.createApplication({ partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "web", interview_language: "en-US", prior_loan_id: null, borrowers: [{ legal_name: `Ada Fixture ${randomUUID().slice(0, 6)}`, borrower_role: "borrower" }], property: null }, INTAKE);
  const record = await rt.applications.get(created.application.id);
  if (!record) throw new Error("application not found after createApplication");
  const base = demoSnapshot(record);
  const snapshot = o.snapshot ? demoSnapshot(record, o.snapshot(base, record)) : base;
  const result = await fundApplication(rt, record.id, snapshot, demoFunded(record.id, o.funded ?? {}), FUNDING);
  return { application_id: record.id, result, snapshot };
}
/** A snapshot/funded pair funded with `fundApplication` directly (the refusal branch of T1 asserts the rejection). */
export async function fundDemoNoteRaw(rt: Runtime, partnerPartyId: string, o: FundOverrides = {}): Promise<{ application_id: string; run: () => Promise<FundApplicationResult> }> {
  const created = await rt.createApplication({ partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "web", interview_language: "en-US", prior_loan_id: null, borrowers: [{ legal_name: `Bea Fixture ${randomUUID().slice(0, 6)}`, borrower_role: "borrower" }], property: null }, INTAKE);
  const record = await rt.applications.get(created.application.id);
  if (!record) throw new Error("application not found after createApplication");
  const base = demoSnapshot(record);
  const snapshot = o.snapshot ? demoSnapshot(record, o.snapshot(base, record)) : base;
  return { application_id: record.id, run: () => fundApplication(rt, record.id, snapshot, demoFunded(record.id, o.funded ?? {}), FUNDING) };
}

// ---------------------------------------------------------------- readers
export interface TimerRow extends Record<string, unknown> { readonly id: string; readonly code: string; readonly status: string; readonly subject_kind: string; readonly subject_id: string; readonly anchor_date: string; readonly satisfied_by_event_id: string | null; readonly armed_by_event_id: string; }
export const readTimer = async (db: Db, loanId: string, code: string): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT id, code, status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, satisfied_by_event_id, armed_by_event_id FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at`, [loanId, code]);
export interface EventRow extends Record<string, unknown> { readonly id: string; readonly type: string; readonly sequence: bigint; readonly actor_id: string; readonly payload: Record<string, unknown>; readonly xmin: string; }
export const readEvents = async (db: Db, loanId: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT id, type, sequence, actor_id, payload, xmin::text AS xmin FROM loan_events WHERE loan_id = $1 ORDER BY loan_events.sequence`, [loanId]);
export interface RowRead extends Record<string, unknown> { readonly due_date: string; readonly sequence: number; readonly pi_cents: bigint; readonly interest_cents: bigint; readonly principal_cents: bigint; readonly escrow_cents: bigint; readonly upb_before_cents: bigint; readonly upb_after_cents: bigint; readonly rate_bps: number; readonly status: string; readonly terms_id: string; readonly schedule_run_id: string; readonly absorbs_rounding: boolean; readonly satisfied_by_payment_id: string | null; readonly credited_as_of: string | null; readonly xmin: string; }
export const readRows = async (db: Db, loanId: string): Promise<RowRead[]> => db.query<RowRead>(`SELECT due_date::text AS due_date, sequence, pi_cents, interest_cents, principal_cents, escrow_cents, upb_before_cents, upb_after_cents, rate_bps, status::text AS status, terms_id, schedule_run_id, absorbs_rounding, satisfied_by_payment_id, credited_as_of::text AS credited_as_of, xmin::text AS xmin FROM loan_installments WHERE loan_id = $1 ORDER BY due_date`, [loanId]);
export interface RunRead extends Record<string, unknown> { readonly id: string; readonly terms_id: string | null; readonly source: string; readonly rows: number; readonly rows_replaced: number; readonly rows_kept: number; readonly pi_cents: bigint; readonly rate_bps: number; readonly upb_start_cents: bigint; readonly total_interest_cents: bigint; readonly total_principal_cents: bigint; readonly maturity_variance_cents: bigint; readonly replaced: unknown[]; readonly sha256: string; readonly decision_id: string | null; readonly trigger_event_id: string | null; }
export const readRuns = async (db: Db, loanId: string): Promise<RunRead[]> => db.query<RunRead>(`SELECT id, terms_id, source, rows, rows_replaced, rows_kept, pi_cents, rate_bps, upb_start_cents, total_interest_cents, total_principal_cents, maturity_variance_cents, replaced, sha256, decision_id, trigger_event_id FROM installment_schedule_runs WHERE loan_id = $1 ORDER BY created_at, id`, [loanId]);
/** Every row's `to_jsonb` (byte-identity assertions), by due date. */
export const rowsJson = async (db: Db, loanId: string): Promise<string[]> => (await db.query<{ j: string }>(`SELECT to_jsonb(i)::text AS j FROM loan_installments i WHERE loan_id = $1 ORDER BY due_date`, [loanId])).map((r) => r.j);

/** The partner's servicing custodial accounts (clearing / pi / ti) cashiering posts to — the lifecycle.test.ts fixture (only `clearing` is created by a transfer board). */
export async function seedCustodial(db: Db, partnerPartyId: string): Promise<{ clearing: string; pi: string; ti: string }> {
  const out = { clearing: "", pi: "", ti: "" };
  for (const kind of ["clearing", "pi", "ti"] as const) {
    const found = await db.query<{ id: string }>(`SELECT id FROM custodial_accounts WHERE partner_party_id = $1 AND kind = $2 ORDER BY created_at LIMIT 1`, [partnerPartyId, kind]);
    out[kind] = found[0]?.id ?? (await db.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, $2, 'A/A') RETURNING id`, [partnerPartyId, kind]))[0]!.id;
  }
  return out;
}
/** The partner's servicer party as boardTransferBatch keys it (by servicer number). */
export async function partnerPartyOf(db: Db, servicerNumber: string = PARTNER_SERVICER_NUMBER): Promise<string> {
  const found = await db.query<{ id: string }>(`SELECT id FROM parties WHERE party_type = 'servicer' AND servicer_number = $1 LIMIT 1`, [servicerNumber]);
  if (found[0]) return found[0].id;
  return (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', 'Supermortgage', $1, $2) RETURNING id`, [servicerNumber, PARTNER_ORG]))[0]!.id;
}
/** A borrower party linked to the loan's borrower row (servicingParties reads `borrowers.party_id`), so a notice has a recipient; the mailing address is the property's. */
export async function linkBorrowerParty(db: Db, loanId: string, email: string | null = null): Promise<string> {
  const b = (await db.query<{ id: string; legal_name: string }>(`SELECT b.id, b.legal_name FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loanId]))[0];
  if (!b) throw new Error(`no borrower on loan ${loanId}`);
  const party = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', $1, $2::jsonb) RETURNING id`, [b.legal_name, JSON.stringify(email ? { email } : {})]))[0]!.id;
  await db.query(`UPDATE borrowers SET party_id = $2 WHERE id = $1`, [b.id, party]);
  return party;
}
