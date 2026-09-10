/**
 * §16.3 operating rules over the release calculators (./release.ts): the jurisdiction release matrix
 * (rule 6 and the state table, with each state's penalty model), instrument and signatory selection
 * (rule 1 / T9), the Form 2009 custody request (rule 2 / WE2), the machine-checked content checklist
 * (rule 3), the execution command gate (rule 4 / T12), the LPOA gate over `lpoas` rows (T5), recording
 * channel, paper packages, recorder rejects and the recorded image hash (rule 5 / T1, T7, T8), the
 * recorder fee schedule, fee pass-through postings and the F-1-05 claim (rule 7 / T10), the penalty
 * posting gate (F-1-09), borrower notification and note return (rule 8), the penalty-exposure model
 * (rule 9 / T2, T6, T9), the SF CPM execution package (T5), the NJ right-to-demand notice (T6), the
 * Maryland delivery clock (WE3 / T4) with its receipt-or-clearance anchor (fundsAnchor), the California trustee
 * path (WE2 / T3), which event closes the statutory duty per state (statutoryDutyEvent), payoff reversal read
 * off the loan's persisted events (reversalState / payoffReversal, T11), the Outputs ledger sets over the
 * postings (ledgerEntrySet) and the paper recording package with its positive-pay check and mail-tracking
 * barcode (paperRecordingPackage, T8). One small pure function per rule; dates are PlainDate, money is bigint
 * cents, calendar days never roll forward (decision 3).
 *
 * Defect worked around (reported in notes): ./release.ts `penaltyExposure` feeds one "daysLate" number
 * into the New York tiers, which the statute keys on days *since payoff* (RPL §275: >30/>60/>90), and
 * charges Ohio's $100/day from the second day of breach with no notice concept (R.C. §5301.36: $250,
 * then $100/day *after notice*). `penaltyExposureReport` below implements the statutes.
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { AccountRef, CorporateAccount, EntrySetInput, LoanAccount } from "../../kernel/ledger/ledger.ts";
import { feePassThrough, caTrusteeClocks, internalTimers, enoteClocks, deactivationClocks } from "./release.ts";

/** The process's Timers attribute — the clocks a voided task (payoff reversed before execution, T11) releases. */
export const RELEASE_TIMERS_16_3 = ["CA_CC2941_TRUSTEE_DELIVERY_30", "CA_CC2941_TRUSTEE_RECORD_21", "FNMA_A2104_SEND_FOR_EXECUTION_2BD", "FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD", "MD_RP_7106_RELEASE_DELIVERY_7", "NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10", "NY_RPAPL1921_NOTE_RETURN_45", "SM_BORROWER_RELEASE_NOTICE_5BD", "SM_CUSTODY_DOCS_RETURN_10BD", "SM_ERECORD_REJECT_FIX_2BD", "SM_FNMA_EXECUTION_RETURN_15BD", "SM_LPOA_RECORDED_GATE", "SM_RECORDING_CONFIRM_30", "SM_RELEASE_EXECUTE_3BD", "SM_RELEASE_PENALTY_NONPASS_GATE", "SM_RELEASE_PREPARE_5BD", "SM_RELEASE_SUBMIT_21", "STATE_LIEN_RELEASE_DEADLINE"] as const;

// ───────────────────────────── types (spec data model) ─────────────────────────────
export type InstrumentType = "satisfaction_of_mortgage" | "release_of_mortgage" | "discharge_of_mortgage" | "certificate_of_discharge" | "certificate_of_satisfaction" | "cancellation_of_security_deed" | "release_of_lien" | "deed_of_release_and_reconveyance" | "request_for_full_reconveyance" | "substitution_of_trustee_and_full_reconveyance" | "request_for_release_public_trustee" | "satisfaction_piece" | "ucc3_termination";
export type MortgageeOfRecord = "mers" | "fannie_mae" | "partner" | "supermortgage" | "prior_lender_unassigned" | "other";
export type SignatoryPath = "mers_signing_officer" | "lpoa_attorney_in_fact" | "fnma_execution" | "partner_officer" | "trustee_third_party";
export type RecordingPath = "direct" | "trustee_third_party" | "public_trustee";
export type SecurityInstrument = "mortgage" | "deed_of_trust" | "security_deed";
export type ReleaseStatus = "opened" | "awaiting_custody_docs" | "held" | "prepared" | "awaiting_execution" | "sent_to_fnma" | "sent_to_partner" | "executed" | "notarized" | "submitted" | "recorded" | "rejected" | "borrower_notified" | "mers_deactivation_pending" | "closed" | "delivered_to_trustee" | "trustee_recorded" | "submitted_to_public_trustee" | "void" | "post_recording_reversal" | "penalty_exposure";
export type RecordingChannel = "simplifile" | "csc" | "epn" | "paper_mail" | "walk_in";
export interface Escalation { readonly kind: "signing_officer" | "attorney" | "officer" | "human_agent"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; readonly opened_on?: PlainDate; }
export interface Posting { readonly account: string; readonly debit: Cents; readonly credit: Cents; readonly rule_ref: string; }

/** SHA-256 of a document image/text — `documents.sha256` (retention `life_of_loan_plus_4y`). */
export function sha256(content: string | Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }

// ───────────────────────────── rule 6 / rule 9: jurisdiction_rules.release ─────────────────────────────
/** The state table's "Penalty / consequence" column as a computable model (`jurisdiction_rules.release.penalty`). */
export type PenaltyModel =
  | { readonly kind: "none"; readonly attorney_fees: false }
  | { readonly kind: "damages_and_fees"; readonly attorney_fees: true }
  | { readonly kind: "forfeiture"; readonly cents: Cents; readonly attorney_fees: boolean }
  | { readonly kind: "tiered_from_anchor"; readonly tiers: readonly { readonly after_days: number; readonly cents: Cents }[]; readonly attorney_fees: false }
  | { readonly kind: "per_week_after_deadline"; readonly per_week_cents: Cents; readonly cap_cents: Cents; readonly attorney_fees: true }
  | { readonly kind: "flat_then_per_day_after_notice"; readonly flat_cents: Cents; readonly per_day_cents: Cents; readonly cap_cents: Cents; readonly attorney_fees: true }
  | { readonly kind: "after_written_request"; readonly cents: Cents; readonly request_days: number; readonly attorney_fees: boolean }
  | { readonly kind: "civil_penalty_up_to"; readonly max_cents: Cents; readonly attorney_fees: false }
  | { readonly kind: "floor_or_actual_damages"; readonly floor_cents: Cents; readonly attorney_fees: true };

export interface ReleaseRule {
  readonly deadline_days: number;
  /** Statutory anchor; the operational timer always starts at payoff (rule 6). */
  readonly deadline_anchor: "payoff" | "request" | "fee_receipt";
  readonly statutory: boolean;
  readonly satisfied_by: "recording" | "delivery" | "trustee_delivery";
  /** A Form 2009 request goes out on payoff day (rule 2): CA trustee delivery, CO, MD note return, NY on request. */
  readonly original_note_required: boolean;
  /** The instrument/package itself cannot be prepared or delivered without the original (CA trustee package, CO public trustee) — the `awaiting_custody_docs` state; MD's note return runs in parallel (WE3). */
  readonly original_required_for_instrument: boolean;
  readonly borrower_delivery_required: boolean;
  readonly fee_pass_through_allowed: boolean;
  readonly fee_cap_cents: Cents | null;
  readonly trustee_reconveyance: boolean;
  readonly public_trustee: boolean;
  readonly title_self_release_mechanism: boolean;
  readonly note_return_on_request_days: number | null;
  readonly penalty: string;
  readonly penalty_model: PenaltyModel;
  readonly cite: string;
}
const NONE: PenaltyModel = { kind: "none", attorney_fees: false };
const R = (deadline_days: number, o: Partial<ReleaseRule> & { penalty: string; cite: string }): ReleaseRule => ({ deadline_days, deadline_anchor: "payoff", statutory: true, satisfied_by: "recording", original_note_required: false, original_required_for_instrument: false, borrower_delivery_required: false, fee_pass_through_allowed: true, fee_cap_cents: null, trustee_reconveyance: false, public_trustee: false, title_self_release_mechanism: false, note_return_on_request_days: null, penalty_model: NONE, ...o });
/** The §16.3 state matrix (verified 2026-09-09 unless marked); `jurisdiction_rules.release` is the runtime source. */
export const RELEASE_RULES: Record<string, ReleaseRule> = {
  CA: R(30, { satisfied_by: "trustee_delivery", original_note_required: true, original_required_for_instrument: true, fee_cap_cents: 4_500n, trustee_reconveyance: true, penalty: "all damages + $500 forfeiture (§2941(d)); fee ≤ $45 presumed reasonable (§2941(e))", penalty_model: { kind: "forfeiture", cents: 50_000n, attorney_fees: false }, cite: "Cal. Civ. Code §2941" }),
  NY: R(30, { note_return_on_request_days: 45, penalty: "$500 (>30 days), $1,000 (>60), $1,500 (>90)", penalty_model: { kind: "tiered_from_anchor", tiers: [{ after_days: 30, cents: 50_000n }, { after_days: 60, cents: 100_000n }, { after_days: 90, cents: 150_000n }], attorney_fees: false }, cite: "RPL §275; RPAPL §1921" }),
  FL: R(45, { borrower_delivery_required: true, penalty: "prevailing-party attorney fees (§701.04)", penalty_model: { kind: "damages_and_fees", attorney_fees: true }, cite: "Fla. Stat. §701.03; §701.04(2)" }),
  TX: R(30, { statutory: false, title_self_release_mechanism: true, penalty: "none (policy 30 CD); title-insurer affidavit release after 45-day notice (§12.017) [PARTIALLY VERIFIED]", cite: "Tex. Prop. Code §12.017" }),
  IL: R(30, { penalty: "$200 per offense + reasonable attorney's fees", penalty_model: { kind: "forfeiture", cents: 20_000n, attorney_fees: true }, cite: "765 ILCS 905/2, /4" }),
  MA: R(45, { satisfied_by: "delivery", penalty: "greater of $2,500 or actual damages + fees; actual damages only if confirmatory discharge within 30 days of demand", penalty_model: { kind: "floor_or_actual_damages", floor_cents: 250_000n, attorney_fees: true }, cite: "G.L. c.183 §55" }),
  NJ: R(30, { deadline_anchor: "fee_receipt", fee_cap_cents: 2_500n, penalty: "service fee ≤ $25; no damages in §46:18-11.2 (§46:18-11.3 [UNVERIFIED])", cite: "N.J.S.A. 46:18-11.2" }),
  VA: R(90, { title_self_release_mechanism: true, penalty: "$500 forfeiture; costs and fees after 10-BD certified demand", penalty_model: { kind: "forfeiture", cents: 50_000n, attorney_fees: true }, cite: "Va. Code §55.1-339" }),
  GA: R(60, { borrower_delivery_required: true, penalty: "$500 liquidated damages + losses + fees after 15-BD written demand", penalty_model: { kind: "forfeiture", cents: 50_000n, attorney_fees: true }, cite: "O.C.G.A. §44-14-3" }),
  OH: R(90, { penalty: "$250; then $100/day after notice up to $5,000 + fees", penalty_model: { kind: "flat_then_per_day_after_notice", flat_cents: 25_000n, per_day_cents: 10_000n, cap_cents: 500_000n, attorney_fees: true }, cite: "R.C. §5301.36" }),
  MI: R(75, { penalty: "[UNVERIFIED]", cite: "MCL 565.41–.44 [PARTIALLY VERIFIED]" }),
  WA: R(60, { deadline_anchor: "request", trustee_reconveyance: true, penalty: "damages + reasonable attorney fees; court-ordered recording", penalty_model: { kind: "damages_and_fees", attorney_fees: true }, cite: "RCW 61.16.030" }),
  AZ: R(30, { title_self_release_mechanism: true, penalty: "actual damages; $1,000 + damages 30 days after written request", penalty_model: { kind: "after_written_request", cents: 100_000n, request_days: 30, attorney_fees: false }, cite: "A.R.S. §33-712; §33-707" }),
  NC: R(30, { penalty: "actual damages; $1,000 + fees/costs 30 days after notification", penalty_model: { kind: "after_written_request", cents: 100_000n, request_days: 30, attorney_fees: true }, cite: "G.S. 45-36.9" }),
  CT: R(60, { deadline_anchor: "request", penalty: "$200/week after 60 days up to $5,000 + costs and fees", penalty_model: { kind: "per_week_after_deadline", per_week_cents: 20_000n, cap_cents: 500_000n, attorney_fees: true }, cite: "C.G.S. §49-8" }),
  MD: R(7, { satisfied_by: "delivery", original_note_required: true, fee_cap_cents: 1_500n, penalty: "costs and attorney fees if not delivered within 30 days; trustee fee > $15 is a misdemeanor", penalty_model: { kind: "damages_and_fees", attorney_fees: true }, cite: "Md. Real Prop. §7-106" }),
  MN: R(45, { deadline_anchor: "request", penalty: "civil penalty up to $500 + actual damages", penalty_model: { kind: "civil_penalty_up_to", max_cents: 50_000n, attorney_fees: false }, cite: "Minn. Stat. §47.208" }),
  CO: R(90, { original_note_required: true, original_required_for_instrument: true, public_trustee: true, penalty: "actual economic loss + attorney fees and costs", penalty_model: { kind: "damages_and_fees", attorney_fees: true }, cite: "C.R.S. §38-35-124; §38-39-102" }),
  PA: R(60, { penalty: "[UNVERIFIED]", cite: "21 P.S. §721-1 et seq. [PARTIALLY VERIFIED]" }),
  DEFAULT: R(60, { statutory: false, penalty: "none (policy)", cite: "policy" }),
};
export function releaseRule(state: string): ReleaseRule { return RELEASE_RULES[state] ?? RELEASE_RULES.DEFAULT!; }

/** Rule 6: `deadline_at = payoff_date + deadline_days`, calendar days, no weekend/holiday roll-forward (decision 3); the statutory anchor is recorded for exposure. */
export function statutoryDeadline(state: string, payoffOn: PlainDate): { deadline_at: PlainDate; deadline_days: number; statutory_anchor: ReleaseRule["deadline_anchor"]; satisfied_by: ReleaseRule["satisfied_by"]; cite: string; rolled_forward: false } {
  const r = releaseRule(state);
  return { deadline_at: addDays(payoffOn, r.deadline_days), deadline_days: r.deadline_days, statutory_anchor: r.deadline_anchor, satisfied_by: r.satisfied_by, cite: r.cite, rolled_forward: false };
}

// ───────────────────────────── rule 1: instrument and signatory selection ─────────────────────────────
/**
 * Instrument by state and security-instrument type (matrix "Instrument (typical)"). A California or Washington
 * deed of trust is always released by reconveyance — the request for full reconveyance to the trustee, or the
 * substitution-of-trustee variant where the DOT permits (decision 2); the certificate of discharge is the
 * CA *mortgage* instrument. Colorado releases through the public trustee.
 */
export function instrumentTypeFor(state: string, security: SecurityInstrument, o: { substitution_permitted?: boolean } = {}): InstrumentType {
  if (state === "CO") return "request_for_release_public_trustee";
  if (security === "deed_of_trust" && releaseRule(state).trustee_reconveyance) return o.substitution_permitted ? "substitution_of_trustee_and_full_reconveyance" : "request_for_full_reconveyance";
  switch (state) {
    case "CA": return "certificate_of_discharge";
    case "NY": case "FL": case "MN": case "NC": case "WA": return "satisfaction_of_mortgage";
    case "TX": return "release_of_lien";
    case "IL": case "OH": case "CT": return "release_of_mortgage";
    case "MA": case "NJ": case "MI": return "discharge_of_mortgage";
    case "VA": case "MD": return "certificate_of_satisfaction";
    case "GA": return "cancellation_of_security_deed";
    case "AZ": return "deed_of_release_and_reconveyance";
    case "PA": return "satisfaction_piece";
    default: return security === "security_deed" ? "cancellation_of_security_deed" : security === "deed_of_trust" ? "deed_of_release_and_reconveyance" : "satisfaction_of_mortgage";
  }
}

/** `SM_LPOA_RECORDED_GATE`: `lpoas.status=recorded` for the state (scope covering release/satisfaction) — the facts feed the registered evaluator `16.3.lpoaRecordedForState`. */
export interface LpoaRow { readonly state: string; readonly status: string; readonly scope?: readonly string[] | null; }
export function lpoaGate(state: string, lpoas: readonly LpoaRow[]): { gate: "SM_LPOA_RECORDED_GATE"; open: boolean; lpoa_status: string; facts: { lpoa_status: string; state: string }; fallback: "fnma_execution" | null; cite: "F-1-10; A2-1-04" } {
  const forState = lpoas.filter((l) => l.state === state && (!l.scope || l.scope.length === 0 || l.scope.some((s) => /satisfaction|release|reconveyance|full/i.test(s))));
  const recorded = forState.find((l) => l.status === "recorded");
  const lpoa_status = recorded ? "recorded" : forState[0]?.status ?? "none";
  return { gate: "SM_LPOA_RECORDED_GATE", open: !!recorded, lpoa_status, facts: { lpoa_status, state }, fallback: recorded ? null : "fnma_execution", cite: "F-1-10; A2-1-04" };
}

export interface SelectionInput { readonly state: string; readonly security_instrument: SecurityInstrument; readonly mortgagee_of_record: MortgageeOfRecord; readonly min_active: boolean; readonly lpoa_recorded?: boolean; readonly lpoas?: readonly LpoaRow[]; readonly substitution_permitted?: boolean; readonly mers_registered?: boolean; readonly confidence?: number; readonly min?: string | null; readonly fnma_loan_number?: string | null; readonly deadline_at?: PlainDate | null; readonly discovered_on?: PlainDate | null; }
export interface Selection { readonly instrument_type: InstrumentType; readonly mortgagee_of_record: MortgageeOfRecord; readonly signatory_path: SignatoryPath | null; readonly recording_path: RecordingPath; readonly executes_in_name_of: "mers" | "fannie_mae" | "partner" | "supermortgage" | null; readonly status: "opened" | "held"; readonly hold_reason: string | null; readonly escalation: Escalation | null; readonly corrective_action: "mers_assignment" | "prior_lender_assignment" | "title_review" | null; readonly lpoa_gate: "SM_LPOA_RECORDED_GATE" | null; readonly lpoa_gate_open: boolean | null; readonly recites: { readonly mers_as_nominee: boolean; readonly min: string | null; readonly fnma_loan_number: string | null }; readonly review_by: PlainDate | null; }
/** Rule 1 (a)–(f): who executes, in whose name, through which recording path; confidence < 0.9 on the mortgagee of record holds the task for attorney/title review before deadline − 15 days. */
export function selectInstrument(i: SelectionInput): Selection {
  const rule = releaseRule(i.state);
  const instrument_type = instrumentTypeFor(i.state, i.security_instrument, i.substitution_permitted !== undefined ? { substitution_permitted: i.substitution_permitted } : {});
  const recording_path: RecordingPath = rule.public_trustee ? "public_trustee" : instrument_type === "request_for_full_reconveyance" ? "trustee_third_party" : "direct";
  const recites = { mers_as_nominee: false, min: i.min ?? null, fnma_loan_number: i.fnma_loan_number ?? null };
  const base = { instrument_type, mortgagee_of_record: i.mortgagee_of_record, recording_path, lpoa_gate: null, lpoa_gate_open: null, review_by: null, hold_reason: null, escalation: null, corrective_action: null, recites, status: "opened" as const };
  const review_by = i.deadline_at ? addDays(i.deadline_at, -15) : null;
  if (i.confidence !== undefined && i.confidence < 0.9) {
    return { ...base, signatory_path: null, executes_in_name_of: null, status: "held", hold_reason: `mortgagee-of-record confidence ${i.confidence} < 0.9`, corrective_action: "title_review", review_by, escalation: { kind: "attorney", reason: `mortgagee of record uncertain (confidence ${i.confidence}); title review before ${review_by ?? "the deadline − 15 days"} (16.3 guardrail)`, ...(i.discovered_on ? { opened_on: i.discovered_on } : {}) } };
  }
  switch (i.mortgagee_of_record) {
    case "mers": {
      if (!i.min_active) return { ...base, signatory_path: null, executes_in_name_of: null, status: "held", hold_reason: "MERS of record but MIN inactive — Rule 2 §4 land-record discrepancy", corrective_action: "title_review", review_by, escalation: { kind: "attorney", reason: "MERS is mortgagee of record but the MIN is inactive; correct the land records before release (MERS Rule 2 §4)", ...(i.discovered_on ? { opened_on: i.discovered_on } : {}) } };
      return { ...base, signatory_path: "mers_signing_officer", executes_in_name_of: "mers", recites: { ...recites, mers_as_nominee: true } };
    }
    case "fannie_mae": {
      const open = i.lpoas ? lpoaGate(i.state, i.lpoas).open : i.lpoa_recorded === true;
      return { ...base, signatory_path: open ? "lpoa_attorney_in_fact" : "fnma_execution", executes_in_name_of: "fannie_mae", lpoa_gate: "SM_LPOA_RECORDED_GATE", lpoa_gate_open: open };
    }
    case "partner": return { ...base, signatory_path: "partner_officer", executes_in_name_of: "partner", escalation: { kind: "officer", reason: "partner is mortgagee of record — partner officer (or Supermortgage under the partner's POA) executes" } };
    case "supermortgage": return { ...base, signatory_path: "partner_officer", executes_in_name_of: "supermortgage" };
    case "prior_lender_unassigned": case "other": {
      const corrective = i.mortgagee_of_record === "prior_lender_unassigned" ? (i.mers_registered ? "mers_assignment" : "prior_lender_assignment") : "title_review";
      return { ...base, signatory_path: null, executes_in_name_of: null, status: "held", hold_reason: "mortgagee of record is a prior lender with no recorded assignment", corrective_action: corrective, review_by, escalation: { kind: "attorney", severity: "sev1", reason: `assignment gap at payoff: record a corrective ${corrective === "mers_assignment" ? "MERS" : "prior-lender"} assignment first (rule 1(d)); the statutory clock keeps running`, ...(i.discovered_on ? { opened_on: i.discovered_on } : {}) } };
    }
  }
}

/** Rule 1(a)/3 and F-1-09: the instrument text (public record, not borrower-facing) recites the MIN and the Fannie Mae loan number; the signatory block matches the authority. Hashed as the unsigned `documents` row. */
export function draftInstrument(sel: Pick<Selection, "instrument_type" | "executes_in_name_of" | "signatory_path" | "recites">, f: { state: string; county: string; borrower_names: readonly string[]; property_address: string; apn?: string | null; original_recording_reference: string; original_recording_date: PlainDate; legal_description?: string | null; original_lender: string; partner_name: string; return_to: string }): { title: string; text: string; sha256: string; recites_min: boolean; recites_fnma_loan_number: boolean; signatory_block: string } {
  const title = sel.instrument_type.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
  const signatory_block = sel.executes_in_name_of === "mers" ? `Mortgage Electronic Registration Systems, Inc., as nominee for ${f.original_lender}, its successors and assigns, by Supermortgage as Subservicer for ${f.partner_name}, by its MERS Signing Officer`
    : sel.executes_in_name_of === "fannie_mae" ? (sel.signatory_path === "lpoa_attorney_in_fact" ? "Fannie Mae, by Supermortgage, its attorney-in-fact under recorded Limited Power of Attorney" : "Fannie Mae, by its authorized signatory (SF CPM Documents)")
    : sel.executes_in_name_of === "partner" ? `${f.partner_name}, by its authorized officer` : "Supermortgage, by its authorized officer";
  const lines = [title.toUpperCase(), `${f.state}, ${f.county} County. Return to: ${f.return_to}.`,
    `The undersigned, holder of the ${sel.instrument_type.includes("reconveyance") ? "deed of trust" : "security instrument"} executed by ${f.borrower_names.join(" and ")} recorded ${f.original_recording_date} as ${f.original_recording_reference}, covering ${f.property_address}${f.apn ? ` (APN ${f.apn})` : ""}, certifies that the debt secured thereby has been PAID IN FULL and the lien is fully satisfied and released.`,
    ...(f.legal_description ? [`Legal description: ${f.legal_description}`] : []),
    ...(sel.recites.min ? [`MIN: ${sel.recites.min}`] : []), ...(sel.recites.fnma_loan_number ? [`Fannie Mae Loan No.: ${sel.recites.fnma_loan_number}`] : []),
    `Signatory: ${signatory_block}.`, `Acknowledgment: State of ${f.state}, County of ${f.county} — in the recording state's statutory form.`];
  const text = lines.join("\n");
  return { title, text, sha256: sha256(text), recites_min: !!sel.recites.min, recites_fnma_loan_number: !!sel.recites.fnma_loan_number, signatory_block };
}

// ───────────────────────────── task opening (inputs and triggers) ─────────────────────────────
export interface OpenedTask { status: "opened" | "awaiting_custody_docs"; deadline_at: PlainDate; statutory_anchor: ReleaseRule["deadline_anchor"]; satisfied_by: ReleaseRule["satisfied_by"]; original_note_required: boolean; custody_in_parallel: boolean; timers: { STATE_LIEN_RELEASE_DEADLINE: PlainDate; SM_RELEASE_PREPARE_5BD: PlainDate; SM_RELEASE_SUBMIT_21: PlainDate; FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD: PlainDate | null }; cite: string }
/** `loan.paid_in_full` → one `release_tasks` row per recording office; `awaiting_custody_docs` only where the package itself needs the original (CA trustee, CO, a recorder demanding it) — Maryland's note return runs in parallel (WE3). */
export function openReleaseTask(i: { state: string; payoff_on: PlainDate; original_note_required?: boolean; borrower_requested_note?: boolean; recorder_requires_original?: boolean }): OpenedTask {
  const rule = releaseRule(i.state); const d = statutoryDeadline(i.state, i.payoff_on); const t = internalTimers(i.payoff_on);
  const original = rule.original_note_required || i.original_note_required === true || i.borrower_requested_note === true || i.recorder_requires_original === true;
  const blocksInstrument = rule.original_required_for_instrument || i.recorder_requires_original === true;
  const minus7 = addDays(d.deadline_at, -7); const submit = minus7 < t.submit_by ? minus7 : t.submit_by;
  return { status: blocksInstrument ? "awaiting_custody_docs" : "opened", deadline_at: d.deadline_at, statutory_anchor: d.statutory_anchor, satisfied_by: d.satisfied_by, original_note_required: original, custody_in_parallel: original && !blocksInstrument, timers: { STATE_LIEN_RELEASE_DEADLINE: d.deadline_at, SM_RELEASE_PREPARE_5BD: t.prepare_by, SM_RELEASE_SUBMIT_21: submit, FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD: original ? t.custody_request_by : null }, cite: d.cite };
}

/** Md. Real Prop. §7-106 anchor: receipt of certified funds/wire, or *clearance* for other paper; an unknown funds kind or a clearance not yet known keeps the earliest date (receipt) — conservative, as rule 6 anchors every clock at the earliest point. */
export function fundsAnchor(i: { funds_received_on: PlainDate; funds_kind?: string | null; cleared_on?: PlainDate | null }): { anchor: PlainDate; basis: "receipt_certified_or_wire" | "clearance" | "receipt_pending_clearance" } {
  const certified = !i.funds_kind || ["wire", "certified", "certified_check", "cashiers_check", "ach"].includes(i.funds_kind);
  if (certified) return { anchor: i.funds_received_on, basis: "receipt_certified_or_wire" };
  return i.cleared_on ? { anchor: i.cleared_on, basis: "clearance" } : { anchor: i.funds_received_on, basis: "receipt_pending_clearance" };
}

/**
 * The `lien_release.task_opened` payload: the state-keyed clocks arm from it (16.2's `loan.paid_in_full` carries no state),
 * with the computed anchors the registry rows name. `sel` is null when the task was opened by the payoff event before the
 * agent's rule-1 selection (selection_pending); the clocks arm on the state and payoff date alone.
 */
export function taskOpenedPayload(i: { release_task_id: string; state: string; county: string | null; payoff_on: PlainDate; funds_received_on: PlainDate | null; funds_kind?: string | null; funds_cleared_on?: PlainDate | null; mortgagee_kind: "bank" | "nonbank" | null; task: OpenedTask; sel: Selection | null; opened_by?: "agent" | "payoff_event" }): Record<string, unknown> {
  const fa = fundsAnchor({ funds_received_on: i.funds_received_on ?? i.payoff_on, funds_kind: i.funds_kind ?? null, cleared_on: i.funds_cleared_on ?? null });
  return { release_task_id: i.release_task_id, state: i.state, county: i.county, instrument_type: i.sel?.instrument_type ?? null, mortgagee_of_record: i.sel?.mortgagee_of_record ?? null, mortgagee_kind: i.mortgagee_kind, signatory_path: i.sel?.signatory_path ?? null, recording_path: i.sel?.recording_path ?? null, selection_pending: i.sel === null, opened_by: i.opened_by ?? "agent", original_note_required: i.task.original_note_required, status: i.sel?.status === "held" ? "held" : i.task.status, payoff_on: i.payoff_on, payoff_date: i.payoff_on, funds_received_on: i.funds_received_on ?? i.payoff_on, funds_kind: i.funds_kind ?? null, md_delivery_anchor: fa.anchor, funds_anchor_basis: fa.basis, statutory_release_due: i.task.deadline_at, deadline_at: i.task.deadline_at, statutory_anchor: i.task.statutory_anchor, satisfied_by: i.task.satisfied_by, submit_by: i.task.timers.SM_RELEASE_SUBMIT_21, prepare_by: i.task.timers.SM_RELEASE_PREPARE_5BD };
}

/** Which 16.3 event closes the statutory duty for the state (registry column: `lien_release.recorded`, or `delivered` where the statute is satisfied by delivery; CA §2941(b)(1): the beneficiary's duty is delivery to the trustee). Every closing event carries `statutory_duty: "satisfied"` — the one pattern STATE_LIEN_RELEASE_DEADLINE waits on. */
export function statutoryDutyEvent(state: string): "lien_release.recorded" | "lien_release.delivered" | "lien_release.delivered_to_trustee" {
  const by = releaseRule(state).satisfied_by;
  return by === "delivery" ? "lien_release.delivered" : by === "trustee_delivery" ? "lien_release.delivered_to_trustee" : "lien_release.recorded";
}

// ───────────────────────────── inputs: payoff reversal state (T11) ─────────────────────────────
export interface ReversalState { readonly reversed: boolean; readonly reversed_on: PlainDate | null; readonly reversal_event_id: string | null; readonly fnma_liquidated_in_error_open: boolean; readonly paid_in_full_on: PlainDate | null; readonly cause: string | null; }
/** `payoff_reversed` / open `fnma_liquidated_in_error` read from the loan's *persisted* events, never from a caller flag: reversed when 16.2's last `payoff.reversed` follows the last `loan.paid_in_full`; the liquidated-in-error correction stays open until a re-posted payoff or `payoff.liquidated_in_error.resolved`. */
export function reversalState(events: readonly { readonly id: string; readonly type: string; readonly occurredAt: string; readonly sequence: number; readonly payload: Record<string, unknown> }[]): ReversalState {
  let paid: (typeof events)[number] | null = null, rev: (typeof events)[number] | null = null, lieOpen = false;
  for (const e of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (e.type === "loan.paid_in_full") { paid = e; lieOpen = false; }
    else if (e.type === "payoff.reversed") { rev = e; if (e.payload.fnma_liquidated_in_error === true) lieOpen = true; }
    else if (e.type === "payoff.liquidated_in_error.resolved") lieOpen = false;
  }
  const reversed = !!rev && (!paid || rev.sequence > paid.sequence);
  const dateOf = (e: (typeof events)[number] | null, k: string): PlainDate | null => (e ? ((typeof e.payload[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.payload[k] as string) ? e.payload[k] : e.occurredAt.slice(0, 10)) as PlainDate) : null);
  return { reversed, reversed_on: reversed ? dateOf(rev, "returned_on") : null, reversal_event_id: reversed ? rev!.id : null, fnma_liquidated_in_error_open: reversed && lieOpen, paid_in_full_on: dateOf(paid, "payoff_date"), cause: reversed ? String(rev!.payload.cause ?? "") || null : null };
}

// ───────────────────────────── outputs: ledger ─────────────────────────────
/** Outputs "Ledger": the 16.3 postings as one balanced kernel entry set (docs/ARCHITECTURE.md: balanced sets with a rule_ref on every line). `recording_fee_payable` is the loan-level liability 16.2 credited from the borrower's payoff funds; every other account is corporate — penalties never touch loan accounts (F-1-09). */
export function ledgerEntrySet(postings: readonly Posting[], o: { loan_id: string; effective_on: PlainDate; description: string; source_event_id?: string | null }): EntrySetInput {
  const ref = (account: string): AccountRef => (account === "recording_fee_payable" ? { scope: "loan", loanId: o.loan_id, account: account as LoanAccount } : { scope: "corporate", account: account as CorporateAccount });
  const lines = postings.filter((p) => p.debit - p.credit !== 0n).map((p) => ({ account: ref(p.account), amountCents: p.debit - p.credit, ruleRef: p.rule_ref }));
  return { effectiveDate: o.effective_on, description: o.description, lines, ...(o.source_event_id ? { sourceEventId: o.source_event_id } : {}) };
}

// ───────────────────────────── rule 5 / T8: the paper package ─────────────────────────────
export interface PaperPackage { readonly mail_job: { readonly jobId: string; readonly noticeId: string; readonly template: "RECORDING_PACKAGE_PAPER"; readonly recipient: { readonly name: string; readonly address: string }; readonly pages: number; readonly separateDocument: true }; readonly check: { readonly check_number: string; readonly payee: string; readonly amount_cents: Cents; readonly positive_pay: true; readonly issued_on: PlainDate; readonly funding_account: "corporate_cash" }; readonly mail_tracking_barcode: string; readonly contents: readonly ["printed_instrument", "recording_fee_check_positive_pay", "self_addressed_return_envelope", "pria_cover_sheet"]; }
/** USPS Intelligent Mail barcode (31 digits) assigned to the piece when the print-mail job is created; the recorder's package is tracked by it (rule 5). Deterministic per job so a retried submission reuses the same piece. */
export function mailTrackingBarcode(jobId: string): string { return BigInt(`0x${sha256(`imb:${jobId}`).slice(0, 26)}`).toString().padStart(31, "0").slice(-31); }
/** Rule 5 / T8: "printed instrument, check for fees, self-addressed return" via `print-mail`, fee check on positive pay (6.4), tracked by mail-tracking barcode. */
export function paperRecordingPackage(i: { submission_id: string; recorder_name: string; recorder_address: string; fee_cents: Cents; pages: number; submitted_on: PlainDate }): PaperPackage {
  const jobId = `mail-${i.submission_id}`;
  return { mail_job: { jobId, noticeId: i.submission_id, template: "RECORDING_PACKAGE_PAPER", recipient: { name: i.recorder_name, address: i.recorder_address }, pages: Math.max(1, i.pages) + 2, separateDocument: true },
    check: { check_number: `RF-${i.submission_id}`, payee: i.recorder_name, amount_cents: i.fee_cents, positive_pay: true, issued_on: i.submitted_on, funding_account: "corporate_cash" },
    mail_tracking_barcode: mailTrackingBarcode(jobId), contents: ["printed_instrument", "recording_fee_check_positive_pay", "self_addressed_return_envelope", "pria_cover_sheet"] };
}

// ───────────────────────────── rule 2: originals (Form 2009) ─────────────────────────────
export function custodyRequest(i: { state: string; payoff_on: PlainDate; original_note_required?: boolean; borrower_requested_note?: boolean; recorder_requires_original?: boolean; sent_on?: PlainDate | null; received_on?: PlainDate | null; today?: PlainDate | null }): { required: boolean; form: "2009"; documents: readonly string[]; request_by: PlainDate; sent_on_time: boolean | null; return_monitor_by: PlainDate | null; received_on_time: boolean | null; lost_document_path: boolean; status: "not_required" | "due" | "requested" | "received" | "overdue" } {
  const rule = releaseRule(i.state);
  const required = rule.original_note_required || i.original_note_required === true || i.borrower_requested_note === true || i.recorder_requires_original === true;
  const request_by = addBusinessDays(i.payoff_on, 1, servicer);
  const return_monitor_by = i.sent_on ? addBusinessDays(i.sent_on, 10, servicer) : null;
  const today = i.today ?? null;
  const overdue = !!return_monitor_by && !i.received_on && !!today && today > return_monitor_by;
  const documents = rule.public_trustee ? ["original_note_cancelled", "deed_of_trust_copy"] : rule.trustee_reconveyance ? ["original_note", "original_deed_of_trust"] : ["original_note", "original_security_instrument"];
  return { required, form: "2009", documents: required ? documents : [], request_by, sent_on_time: i.sent_on ? i.sent_on <= request_by : null, return_monitor_by, received_on_time: i.received_on && return_monitor_by ? i.received_on <= return_monitor_by : null, lost_document_path: overdue, status: !required ? "not_required" : i.received_on ? "received" : overdue ? "overdue" : i.sent_on ? "requested" : "due" };
}

// ───────────────────────────── rule 3: content checklist ─────────────────────────────
export const CHECKLIST_ITEMS = ["instrument_title", "min", "fnma_loan_number", "original_recording_reference", "legal_description", "borrower_names_as_recorded", "property_address_apn", "full_satisfaction_statement", "signatory_block", "notary_acknowledgment_form", "pria_cover_sheet", "return_to_address", "fees_from_recorder_schedule"] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];
export function releaseChecklist(i: { present: Partial<Record<ChecklistItem, boolean>>; county_requires_legal_description: boolean; mers: boolean }): { passed: boolean; required: ChecklistItem[]; failed: ChecklistItem[]; cite: "F-1-09; 16.3 rule 3" } {
  const required = CHECKLIST_ITEMS.filter((k) => (k === "legal_description" ? i.county_requires_legal_description : k === "min" ? i.mers : true));
  const failed = required.filter((k) => i.present[k] !== true);
  return { passed: failed.length === 0, required, failed, cite: "F-1-09; 16.3 rule 3" };
}

// ───────────────────────────── rule 4 / T12: the execution command ─────────────────────────────
export interface RefusedCommand { readonly accepted: false; readonly refusal: { readonly code: "NO_EXECUTION_WITHOUT_CHECKLIST" | "NO_PROOF_OF_PAYOFF" | "AGENT_NEVER_SIGNS" | "HELD_FOR_REVIEW"; readonly citation: string; readonly reason: string }; readonly event: { readonly type: "command.refused"; readonly command: "routeForExecution"; readonly actor: string; readonly at: string; readonly code: string }; readonly logged: true; }
export interface AcceptedCommand { readonly accepted: true; readonly refusal: null; readonly event: { readonly type: "lien_release.execution_requested"; readonly command: "routeForExecution"; readonly actor: string; readonly at: string }; readonly escalation: Escalation; readonly logged: true; }
/** The gate reads the *persisted* checklist result and payoff evidence (the caller's assertions are not evidence); the agent never signs; a held task stays held until the review clears. */
export function executionCommand(i: { checklist_passed: boolean; payoff_evidence_document_id: string | null; actor: string; attempted_at: string; agent_signs?: boolean; hold_reason?: string | null; review_cleared?: boolean }): RefusedCommand | AcceptedCommand {
  const refuse = (code: RefusedCommand["refusal"]["code"], citation: string, reason: string): RefusedCommand => ({ accepted: false, refusal: { code, citation, reason }, event: { type: "command.refused", command: "routeForExecution", actor: i.actor, at: i.attempted_at, code }, logged: true });
  if (i.agent_signs) return refuse("AGENT_NEVER_SIGNS", "16.3 guardrail: the agent never signs", "execution is a signing_officer act; the agent routes the package");
  if (!i.checklist_passed) return refuse("NO_EXECUTION_WITHOUT_CHECKLIST", "16.3 guardrail: no execution without a passed checklist and proof of payoff", "run runReleaseChecklist to a pass before routing for execution");
  if (!i.payoff_evidence_document_id) return refuse("NO_PROOF_OF_PAYOFF", "16.3 guardrail: no execution without a passed checklist and proof of payoff", "attach the payoff evidence document");
  if (i.hold_reason && !i.review_cleared) return refuse("HELD_FOR_REVIEW", "16.3 guardrail: confidence < 0.9 on mortgagee-of-record → hold and attorney/title review before deadline − 15 days", `task held: ${i.hold_reason}`);
  return { accepted: true, refusal: null, event: { type: "lien_release.execution_requested", command: "routeForExecution", actor: i.actor, at: i.attempted_at }, escalation: { kind: "signing_officer", reason: "release instrument ready for execution: payoff evidence, checklist result and authority certificate attached" }, logged: true };
}

// ───────────────────────────── rule 5: recording ─────────────────────────────
export interface SubmissionPlan { readonly channel: RecordingChannel; readonly package: readonly string[]; readonly fee_check: { readonly positive_pay: true; readonly amount_cents: Cents } | null; readonly tracked_by: "vendor_package_id" | "mail_tracking_barcode" | "local_agent_receipt"; readonly submit_by: PlainDate; readonly confirm_chase_on: PlainDate | null; readonly timers: readonly ["SM_RELEASE_SUBMIT_21", "SM_RECORDING_CONFIRM_30"]; readonly statutory_deadline_unchanged: PlainDate; }
/** Rule 5: eRecord where the county participates; else a paper package with a positive-pay fee check via print-mail, tracked; walk-in only for imminent statutory breaches. */
export function recordingSubmission(i: { payoff_on: PlainDate; deadline_at: PlainDate; erecord_covered: boolean; secondary_covered?: boolean; fee_cents: Cents; submitted_on?: PlainDate | null; today?: PlainDate | null }): SubmissionPlan {
  const submit21 = addDays(i.payoff_on, 21); const minus7 = addDays(i.deadline_at, -7);
  const submit_by = minus7 < submit21 ? minus7 : submit21;
  const imminent = !!i.today && daysBetween(i.today, i.deadline_at) <= 3;
  const channel: RecordingChannel = i.erecord_covered ? "simplifile" : i.secondary_covered ? "csc" : imminent ? "walk_in" : "paper_mail";
  const paper = channel === "paper_mail" || channel === "walk_in";
  return { channel, package: paper ? ["printed_instrument", "recording_fee_check_positive_pay", "self_addressed_return_envelope", "pria_cover_sheet"] : ["pria_xml_package", "instrument_image", "fee_statement_ach"], fee_check: paper ? { positive_pay: true, amount_cents: i.fee_cents } : null, tracked_by: channel === "paper_mail" ? "mail_tracking_barcode" : channel === "walk_in" ? "local_agent_receipt" : "vendor_package_id", submit_by, confirm_chase_on: i.submitted_on ? addDays(i.submitted_on, 30) : null, timers: ["SM_RELEASE_SUBMIT_21", "SM_RECORDING_CONFIRM_30"], statutory_deadline_unchanged: i.deadline_at };
}

/** Recording confirmed (eRecord webhook / paper return / trustee or public-trustee recording): the recorded image is hashed into `documents`, `lien_release.recorded` satisfies the statutory clock and the 30-day monitor and starts the borrower notice and 16.4 clocks. */
export function recordedRelease(i: { state: string; recorded_on: PlainDate; recording_reference: string; image: string | Uint8Array; deadline_at: PlainDate; via: "erecord" | "paper" | "trustee" | "public_trustee" | "third_party" }): { status: "recorded" | "trustee_recorded"; recorded_image_sha256: string; document: { kind: "recorded_release_image"; sha256: string; byte_size: number; retention_class: "life_of_loan_plus_4y" }; on_time: boolean; days_late: number; event: { type: "lien_release.recorded"; payload: { state: string; recorded_at: PlainDate; recording_reference: string; recorded_image_sha256: string; via: string } }; borrower_notice_by: PlainDate; mers_deactivation_due: PlainDate; mers_deactivation_target: PlainDate } {
  const hash = sha256(i.image); const byte_size = typeof i.image === "string" ? Buffer.byteLength(i.image) : i.image.byteLength;
  const days_late = Math.max(0, daysBetween(i.deadline_at, i.recorded_on)); const dc = deactivationClocks(i.recorded_on);
  return { status: i.via === "trustee" ? "trustee_recorded" : "recorded", recorded_image_sha256: hash, document: { kind: "recorded_release_image", sha256: hash, byte_size, retention_class: "life_of_loan_plus_4y" }, on_time: days_late === 0, days_late, event: { type: "lien_release.recorded", payload: { state: i.state, recorded_at: i.recorded_on, recording_reference: i.recording_reference, recorded_image_sha256: hash, via: i.via } }, borrower_notice_by: addBusinessDays(i.recorded_on, 5, servicer), mers_deactivation_due: dc.due_on, mers_deactivation_target: dc.policy_target };
}

const REJECT_FIXES: Record<string, string> = { MISSING_LEGAL_DESCRIPTION: "add the legal description transcribed from the recorded security instrument image (never invented)", MARGIN: "reformat to the recorder's margin/font rules and regenerate the PRIA cover sheet", NAME_MISMATCH: "conform borrower/trustor names to the recorded instrument and flag the discrepancy", MISSING_ACKNOWLEDGMENT: "re-notarize in the recording state's acknowledgment form", FEE_SHORT: "recompute fees from the recorder's schedule" };
/** Rule 5 / T7: a recorder rejection is fixed and resubmitted within 2 BD; the statutory deadline never moves; repeated rejects go to the attorney. */
export function recorderReject(i: { rejected_on: PlainDate; reject_code: string; deadline_at: PlainDate; prior_rejects: number; attempt: number }): { timer: "SM_ERECORD_REJECT_FIX_2BD"; fix_by: PlainDate; deadline_at: PlainDate; correction: string; status: "rejected"; status_after_fix: "prepared"; resubmission_attempt: number; escalation: Escalation | null } {
  return { timer: "SM_ERECORD_REJECT_FIX_2BD", fix_by: addBusinessDays(i.rejected_on, 2, servicer), deadline_at: i.deadline_at, correction: REJECT_FIXES[i.reject_code] ?? `correct ${i.reject_code} per the recorder's reject text`, status: "rejected", status_after_fix: "prepared", resubmission_attempt: i.attempt + 1, escalation: i.prior_rejects >= 1 ? { kind: "attorney", severity: "sev2", reason: `repeated recorder rejects (${i.prior_rejects + 1}) — attorney review of the instrument (16.3 edge case)` } : null };
}

// ───────────────────────────── rule 3 / rule 7: recorder fee schedule ─────────────────────────────
export interface RecorderSchedule { readonly base_pages: number; readonly base_cents: Cents; readonly additional_page_cents: Cents; readonly cite: string; }
/** Recorder fee schedules ("fees computed from the recorder's schedule", rule 3): Ohio R.C. §317.32 — $34 for the first two pages, $8 each additional page. */
export const RECORDER_SCHEDULES: Record<string, RecorderSchedule> = { OH: { base_pages: 2, base_cents: 3_400n, additional_page_cents: 800n, cite: "Ohio R.C. §317.32" } };
export function recorderFee(i: { state: string; pages: number; schedule?: RecorderSchedule; vendor_ach_cents?: Cents | null; borrower_collected_cents?: Cents | null }): { fee_cents: Cents; schedule_cite: string | null; account: "recording_fee_payable"; matches_vendor_ach: boolean | null; matches_borrower_collection: boolean | null } {
  const s = i.schedule ?? RECORDER_SCHEDULES[i.state] ?? null;
  const fee_cents = s ? s.base_cents + BigInt(Math.max(0, i.pages - s.base_pages)) * s.additional_page_cents : 0n;
  return { fee_cents, schedule_cite: s?.cite ?? null, account: "recording_fee_payable", matches_vendor_ach: i.vendor_ach_cents === undefined || i.vendor_ach_cents === null ? null : i.vendor_ach_cents === fee_cents, matches_borrower_collection: i.borrower_collected_cents === undefined || i.borrower_collected_cents === null ? null : i.borrower_collected_cents === fee_cents };
}

// ───────────────────────────── rule 7 / T10: fees ─────────────────────────────
export function releaseFeePosting(i: { state: string; fee_cents: Cents; fee_kind: "recording" | "trustee" | "notary" | "public_trustee"; disclosed_on_statement: boolean; permitted_by_security_instrument: boolean; c1205_conditions: boolean; payoff_on: PlainDate; fee_pass_through_allowed?: boolean; f105_eligible?: boolean; borrower_collected_cents?: Cents }): { chargeable: boolean; cap_cents: Cents | null; postings: Posting[]; balanced: boolean; paid_to: "trustee_or_recorder" | "notary"; matched_to_borrower_collection: boolean; f105_claim: { prepare_by: PlainDate; window_days: 60; amount_cents: Cents; timer: "FNMA_F105_EXPENSE_CLAIM_60" } | null; borrower_charge_cents: Cents; charge_target: "borrower" | "corporate_expense"; event: { type: "fee.posting_requested"; payload: { kind: string; charge_target: string; amount_cents: Cents } } } {
  const rule = releaseRule(i.state);
  const allowed = (i.fee_pass_through_allowed ?? rule.fee_pass_through_allowed) && i.permitted_by_security_instrument;
  const pt = feePassThrough({ state: i.state, c1205_conditions: i.c1205_conditions, allowed, disclosed_on_statement: i.disclosed_on_statement, fee_cents: i.fee_cents });
  const cap = rule.fee_cap_cents ?? pt.cap_cents; const chargeable = pt.chargeable && (cap === null || i.fee_cents <= cap);
  const postings: Posting[] = chargeable
    ? [{ account: "recording_fee_payable", debit: i.fee_cents, credit: 0n, rule_ref: "16.3.fee:C-1.2-05:borrower_funded" }, { account: "corporate_cash", debit: 0n, credit: i.fee_cents, rule_ref: "16.3.fee:C-1.2-05:borrower_funded" }]
    : [{ account: "release_recording_expense", debit: i.fee_cents, credit: 0n, rule_ref: "16.3.fee:corporate_expense" }, { account: "corporate_cash", debit: 0n, credit: i.fee_cents, rule_ref: "16.3.fee:corporate_expense" }];
  const f105 = !chargeable && i.f105_eligible !== false ? { prepare_by: addDays(i.payoff_on, 60), window_days: 60 as const, amount_cents: i.fee_cents, timer: "FNMA_F105_EXPENSE_CLAIM_60" as const } : null;
  if (f105) postings.push({ account: "f105_claim_receivable", debit: i.fee_cents, credit: 0n, rule_ref: "16.3.fee:F-1-05:claim" }, { account: "release_recording_expense", debit: 0n, credit: i.fee_cents, rule_ref: "16.3.fee:F-1-05:claim" });
  const d = postings.reduce((a, p) => a + p.debit, 0n), c = postings.reduce((a, p) => a + p.credit, 0n);
  const charge_target = chargeable ? "borrower" as const : "corporate_expense" as const;
  return { chargeable, cap_cents: cap, postings, balanced: d === c, paid_to: i.fee_kind === "notary" ? "notary" : "trustee_or_recorder", matched_to_borrower_collection: chargeable && (i.borrower_collected_cents ?? i.fee_cents) === i.fee_cents, f105_claim: f105, borrower_charge_cents: chargeable ? i.fee_cents : 0n, charge_target, event: { type: "fee.posting_requested", payload: { kind: `${i.fee_kind}_fee`, charge_target, amount_cents: i.fee_cents } } };
}

/** F-1-09 / `SM_RELEASE_PENALTY_NONPASS_GATE`: a late-release penalty posts only as corporate expense (Dr `release_penalty_expense`); borrower, loan and Fannie Mae claim targets are refused. The facts feed the registered evaluator `16.3.penaltyNeverPassedThrough`. */
export const PENALTY_FORBIDDEN_TARGETS = ["borrower", "loan", "fnma", "fannie_mae", "fnma_claim", "f105_claim"] as const;
export function penaltyPosting(i: { state: string; penalty_cents: Cents; charge_target: string; as_of: PlainDate }): { gate: "SM_RELEASE_PENALTY_NONPASS_GATE"; allowed: boolean; refusal: string | null; facts: { penalty_charge_target: string }; postings: Posting[]; balanced: boolean; event: { type: "fee.posting_requested"; payload: { kind: "release_penalty"; charge_target: string; amount_cents: Cents; state: string; as_of: PlainDate } }; cite: "F-1-09" } {
  const forbidden = (PENALTY_FORBIDDEN_TARGETS as readonly string[]).includes(i.charge_target);
  const allowed = !forbidden && i.charge_target === "corporate_expense" && i.penalty_cents > 0n;
  const postings: Posting[] = allowed ? [{ account: "release_penalty_expense", debit: i.penalty_cents, credit: 0n, rule_ref: "16.3.penalty:F-1-09:corporate_expense" }, { account: "corporate_cash", debit: 0n, credit: i.penalty_cents, rule_ref: "16.3.penalty:F-1-09:corporate_expense" }] : [];
  return { gate: "SM_RELEASE_PENALTY_NONPASS_GATE", allowed, refusal: forbidden ? `F-1-09: the servicer must not pass on to the borrower or to Fannie Mae any penalty fee for late release processing (charge_target=${i.charge_target})` : allowed ? null : `nothing to post (charge_target=${i.charge_target}, penalty=${i.penalty_cents})`, facts: { penalty_charge_target: i.charge_target }, postings, balanced: postings.reduce((a, p) => a + p.debit - p.credit, 0n) === 0n, event: { type: "fee.posting_requested", payload: { kind: "release_penalty", charge_target: i.charge_target, amount_cents: i.penalty_cents, state: i.state, as_of: i.as_of } }, cite: "F-1-09" };
}

// ───────────────────────────── rule 9 / T2 / T6 / T9: penalty exposure ─────────────────────────────
/** The state's penalty model evaluated for one task: NY tiers key on days since payoff (RPL §275), CT per week past the 60 days, OH $250 then $100/day after notice, capped; unliquidated "damages + fees" states carry attorney-fee exposure. */
export function penaltyExposureReport(i: { state: string; payoff_on?: PlainDate | null; deadline_at: PlainDate; as_of: PlainDate; satisfied_on: PlainDate | null; notice_given_on?: PlainDate | null; written_request_on?: PlainDate | null; /** STATE_LIEN_RELEASE_DEADLINE's persisted status (`breached` / `satisfied_late`) — the engine's verdict wins over the dates. */ timer_breached?: boolean }): { breached: boolean; days_late: number; days_since_anchor: number; penalty_exposure_cents: Cents; attorney_fee_exposure: boolean; basis: string; severity: "sev1" | null; officer_notified: boolean; reported_by: "compliance-sentinel"; charge_target: "corporate_expense"; pass_through_to_borrower_or_fnma: false; timer: "STATE_LIEN_RELEASE_DEADLINE"; cite: string } {
  const rule = releaseRule(i.state); const m = rule.penalty_model;
  const end = i.satisfied_on ?? i.as_of;
  const anchor = i.payoff_on ?? addDays(i.deadline_at, -rule.deadline_days);
  const days_since_anchor = Math.max(0, daysBetween(anchor, end));
  const days_late = Math.max(0, daysBetween(i.deadline_at, end));
  const breached = days_late > 0 || i.timer_breached === true;
  const cap = (v: Cents, c: Cents): Cents => (v > c ? c : v);
  let cents = 0n; let basis: string;
  switch (m.kind) {
    case "none": basis = rule.penalty; break;
    case "damages_and_fees": basis = `unliquidated: ${rule.penalty}`; break;
    case "forfeiture": cents = breached ? m.cents : 0n; basis = `forfeiture on breach (${rule.penalty})`; break;
    case "tiered_from_anchor": { const tier = [...m.tiers].reverse().find((t) => days_since_anchor > t.after_days); cents = tier ? tier.cents : 0n; basis = `tier by days since payoff (${days_since_anchor}): ${rule.penalty}`; break; }
    case "per_week_after_deadline": cents = breached ? cap(BigInt(Math.ceil(days_late / 7)) * m.per_week_cents, m.cap_cents) : 0n; basis = `${Math.ceil(days_late / 7)} week(s) past the deadline (${rule.penalty})`; break;
    case "flat_then_per_day_after_notice": { const afterNotice = breached && i.notice_given_on ? Math.max(0, daysBetween(i.notice_given_on, end)) : 0; cents = breached ? cap(m.flat_cents + BigInt(afterNotice) * m.per_day_cents, m.cap_cents) : 0n; basis = breached ? `$250 on breach${i.notice_given_on ? ` + $100/day × ${afterNotice} after notice ${i.notice_given_on}` : " (no notice yet)"}, capped $5,000` : rule.penalty; break; }
    case "after_written_request": { const since = i.written_request_on ? daysBetween(i.written_request_on, end) : -1; cents = breached && since > m.request_days ? m.cents : 0n; basis = breached ? (i.written_request_on ? `${since} days after the written request (${rule.penalty})` : "actual damages until a written request runs 30 days") : rule.penalty; break; }
    case "civil_penalty_up_to": cents = breached ? m.max_cents : 0n; basis = `exposure at the statutory maximum (${rule.penalty})`; break;
    case "floor_or_actual_damages": cents = breached ? m.floor_cents : 0n; basis = `floor (${rule.penalty})`; break;
  }
  return { breached, days_late, days_since_anchor, penalty_exposure_cents: cents, attorney_fee_exposure: breached && m.attorney_fees, basis, severity: breached ? "sev1" : null, officer_notified: breached, reported_by: "compliance-sentinel", charge_target: "corporate_expense", pass_through_to_borrower_or_fnma: false, timer: "STATE_LIEN_RELEASE_DEADLINE", cite: rule.cite };
}

/** Rule 1(d) / T9: an assignment gap holds the task, opens the attorney escalation the day it is found, and the statutory clock keeps running with exposure reported. */
export function assignmentGap(i: { state: string; payoff_on: PlainDate; discovered_on: PlainDate; mers_registered: boolean; as_of: PlainDate }): { held: true; status: "held"; corrective_action: "mers_assignment" | "prior_lender_assignment"; escalation: Escalation & { opened_on: PlainDate }; statutory_due: PlainDate; timer_running: true; exposure: ReturnType<typeof penaltyExposureReport> } {
  const sel = selectInstrument({ state: i.state, security_instrument: "mortgage", mortgagee_of_record: "prior_lender_unassigned", min_active: i.mers_registered, lpoa_recorded: false, mers_registered: i.mers_registered, discovered_on: i.discovered_on });
  const due = statutoryDeadline(i.state, i.payoff_on).deadline_at;
  return { held: true, status: "held", corrective_action: i.mers_registered ? "mers_assignment" : "prior_lender_assignment", escalation: { ...sel.escalation!, opened_on: i.discovered_on }, statutory_due: due, timer_running: true, exposure: penaltyExposureReport({ state: i.state, payoff_on: i.payoff_on, deadline_at: due, as_of: i.as_of, satisfied_on: null }) };
}

// ───────────────────────────── T5: Fannie Mae execution ─────────────────────────────
export function fnmaExecutionPackage(i: { state: string; prepared_on: PlainDate; lpoa_recorded: boolean; original_required: boolean; fnma_loan_number: string; sent_on?: PlainDate | null }): { gate: "SM_LPOA_RECORDED_GATE"; blocked: boolean; signatory_path: "lpoa_attorney_in_fact" | "fnma_execution"; channel: "email" | "mail"; to: string; send_by: PlainDate; package: readonly string[]; reason: string; follow_up_by: PlainDate | null; timers: readonly ["FNMA_A2104_SEND_FOR_EXECUTION_2BD", "SM_FNMA_EXECUTION_RETURN_15BD"] } {
  const blocked = !i.lpoa_recorded;
  return { gate: "SM_LPOA_RECORDED_GATE", blocked, signatory_path: blocked ? "fnma_execution" : "lpoa_attorney_in_fact", channel: i.original_required ? "mail" : "email", to: i.original_required ? "Fannie Mae, Attn: SF CPM, Documents, 5600 Granite Parkway VII, Plano, TX 75024" : "sfcpm.servicingdocuments@fanniemae.com", send_by: addBusinessDays(i.prepared_on, 2, servicer), package: ["fnma_loan_number", "reason", "executable_document", "cover_letter", "return_shipping_label"], reason: `Satisfaction — no LPOA for ${i.state}`, follow_up_by: i.sent_on ? addBusinessDays(i.sent_on, 15, servicer) : null, timers: ["FNMA_A2104_SEND_FOR_EXECUTION_2BD", "SM_FNMA_EXECUTION_RETURN_15BD"] };
}

// ───────────────────────────── rule 8: borrower notification and note return ─────────────────────────────
export function borrowerNotification(i: { state: string; recorded_on: PlainDate; consent_on_file: boolean; enote?: boolean; note_requested_on?: PlainDate | null; note_received_on?: PlainDate | null }): { notice: "NTC_LIEN_RELEASE_RECORDED"; send_by: PlainDate; channel: "edelivery" | "mail"; attach_recorded_image: true; statutory: boolean; breach_severity: "sev1" | "sev3"; timer: "SM_BORROWER_RELEASE_NOTICE_5BD"; note_return: { notice: "NTC_NOTE_RETURNED" | "NTC_ENOTE_PAPER_COPY"; by: PlainDate | null; marked: "Paid in Full" | "Copy / Paid-In-Full"; timer: "NY_RPAPL1921_NOTE_RETURN_45" | null } | null } {
  const rule = releaseRule(i.state);
  const requiresReturn = rule.original_note_required && !rule.public_trustee && !rule.trustee_reconveyance ? true : i.state === "NY" ? !!i.note_requested_on : false;
  let note_return: ReturnType<typeof borrowerNotification>["note_return"] = null;
  if (requiresReturn || i.note_requested_on) {
    if (i.enote) note_return = { notice: "NTC_ENOTE_PAPER_COPY", by: enoteClocks(i.recorded_on, i.recorded_on).paper_copy_by, marked: "Copy / Paid-In-Full", timer: null };
    else if (i.state === "NY" && i.note_requested_on) note_return = { notice: "NTC_NOTE_RETURNED", by: addDays(i.note_requested_on, rule.note_return_on_request_days ?? 45), marked: "Paid in Full", timer: "NY_RPAPL1921_NOTE_RETURN_45" };
    else note_return = { notice: "NTC_NOTE_RETURNED", by: i.note_received_on ? addBusinessDays(i.note_received_on, 5, servicer) : null, marked: "Paid in Full", timer: null };
  }
  return { notice: "NTC_LIEN_RELEASE_RECORDED", send_by: addBusinessDays(i.recorded_on, 5, servicer), channel: i.consent_on_file ? "edelivery" : "mail", attach_recorded_image: true, statutory: rule.borrower_delivery_required, breach_severity: i.state === "FL" ? "sev1" : "sev3", timer: "SM_BORROWER_RELEASE_NOTICE_5BD", note_return };
}

/** T6 (NJ nonbank): notify the mortgagor of the right to demand cancellation within 10 days of payoff; cancel within 30 days of the fee; the letter's day count is computed from its dates, never asserted. */
export function njCancellationNotice(i: { payoff_on: PlainDate; nonbank: boolean; fee_cents: Cents; fee_received_on?: PlainDate | null; cancellation_submitted_on?: PlainDate | null; notice_date?: PlainDate | null }): { notice: "NTC_NJ_CANCELLATION_RIGHT" | null; notice_by: PlainDate | null; timer: "NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10" | null; fee_within_cap: boolean; cap_cents: Cents; cancel_by: PlainDate | null; satisfied_by_submission: boolean; days_after_payoff: number | null; on_time: boolean | null } {
  const cap = releaseRule("NJ").fee_cap_cents ?? 0n;
  const days = i.notice_date ? daysBetween(i.payoff_on, i.notice_date) : null;
  const common = { fee_within_cap: i.fee_cents <= cap, cap_cents: cap, cancel_by: i.fee_received_on ? addDays(i.fee_received_on, 30) : null, satisfied_by_submission: !!i.cancellation_submitted_on, days_after_payoff: days };
  if (!i.nonbank) return { notice: null, notice_by: null, timer: null, ...common, on_time: null };
  const notice_by = addDays(i.payoff_on, 10);
  return { notice: "NTC_NJ_CANCELLATION_RIGHT", notice_by, timer: "NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10", ...common, on_time: i.notice_date ? i.notice_date <= notice_by : null };
}

// ───────────────────────────── WE2 / T3: California third-party trustee ─────────────────────────────
export function caTrusteePath(i: { payoff_on: PlainDate; custody_sent_on: PlainDate | null; originals_received_on: PlainDate | null; executed_on?: PlainDate | null; delivered_to_trustee_on?: PlainDate | null; delivery_evidence_document_id?: string | null; reconveyance_recorded_on?: PlainDate | null; substitution_permitted?: boolean }): { instrument_type: InstrumentType; recording_path: RecordingPath; custody_request_by: PlainDate; deliver_by: PlainDate; operational_target: PlainDate; trustee_record_by: PlainDate | null; delivery_on_time: boolean | null; delivery_satisfies_timer: boolean; trustee_on_time: boolean | null; timers: readonly ["FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD", "CA_CC2941_TRUSTEE_DELIVERY_30", "CA_CC2941_TRUSTEE_RECORD_21"]; forfeiture_cents: Cents; package: readonly ["original_note", "original_deed_of_trust", "request_for_full_reconveyance"] } {
  const clocks = caTrusteeClocks(i.payoff_on, i.delivered_to_trustee_on ?? undefined);
  const m = releaseRule("CA").penalty_model; const forfeiture_cents = m.kind === "forfeiture" ? m.cents : 0n;
  const instrument_type = instrumentTypeFor("CA", "deed_of_trust", { substitution_permitted: i.substitution_permitted === true });
  const delivery_on_time = i.delivered_to_trustee_on ? i.delivered_to_trustee_on <= clocks.deliver_by : null;
  return { instrument_type, recording_path: instrument_type === "request_for_full_reconveyance" ? "trustee_third_party" : "direct", custody_request_by: addBusinessDays(i.payoff_on, 1, servicer), deliver_by: clocks.deliver_by, operational_target: rollBack(clocks.deliver_by, servicer), trustee_record_by: clocks.trustee_record_by, delivery_on_time, delivery_satisfies_timer: delivery_on_time === true && !!i.delivery_evidence_document_id, trustee_on_time: i.reconveyance_recorded_on && clocks.trustee_record_by ? i.reconveyance_recorded_on <= clocks.trustee_record_by : null, timers: ["FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD", "CA_CC2941_TRUSTEE_DELIVERY_30", "CA_CC2941_TRUSTEE_RECORD_21"], forfeiture_cents, package: ["original_note", "original_deed_of_trust", "request_for_full_reconveyance"] };
}

// ───────────────────────────── WE3 / T4: Maryland delivery ─────────────────────────────
/** Md. Real Prop. §7-106: the executed release reaches the disbursing settlement agent within 7 days of certified funds/wire (clearance for other paper); delivery *with evidence* satisfies the statute; recording stays monitored. */
export function mdDelivery(i: { funds_received_on: PlainDate; certified_or_wire: boolean; cleared_on?: PlainDate | null; delivered_on?: PlainDate | null; evidence_document_id?: string | null; submitted_on?: PlainDate | null }): { timer: "MD_RP_7106_RELEASE_DELIVERY_7"; anchor: PlainDate; due: PlainDate; delivered_on_time: boolean | null; evidence_present: boolean; satisfied: boolean; satisfied_by: "delivery_to_settlement_agent"; statute_satisfied_by_delivery: true; recording_monitor: "SM_RECORDING_CONFIRM_30"; recording_confirm_by: PlainDate | null; cite: "Md. Real Prop. §7-106" } {
  const anchor = i.certified_or_wire ? i.funds_received_on : (i.cleared_on ?? i.funds_received_on);
  const due = addDays(anchor, 7);
  const delivered_on_time = i.delivered_on ? i.delivered_on <= due : null; const evidence_present = !!i.evidence_document_id;
  return { timer: "MD_RP_7106_RELEASE_DELIVERY_7", anchor, due, delivered_on_time, evidence_present, satisfied: delivered_on_time === true && evidence_present, satisfied_by: "delivery_to_settlement_agent", statute_satisfied_by_delivery: true, recording_monitor: "SM_RECORDING_CONFIRM_30", recording_confirm_by: i.submitted_on ? addDays(i.submitted_on, 30) : null, cite: "Md. Real Prop. §7-106" };
}

// ───────────────────────────── T11: payoff reversal ─────────────────────────────
/** Inputs "`payoff.reversed` (cancel/void the task before execution; after recording → attorney)": the row's side state, the event the tools emit, and which clocks the void releases (every 16.3 clock before recording; only the borrower-notice/note-return clocks after — the statutory duty was met). */
export function payoffReversal(i: { reversed_on: PlainDate; executed_at: PlainDate | null; submitted_at?: PlainDate | null; recorded_at: PlainDate | null }): { status: "void" | "stopped_unrecorded" | "post_recording_reversal"; task_status: "void" | "post_recording_reversal"; event: "lien_release.voided" | "lien_release.post_recording_reversal"; instrument_signed: boolean; escalation: Escalation | null; borrower_charge_cents: 0n; officer_informed: boolean; loan_serviced_as: "secured" | "unsecured_pending_cure"; action: string; timers_released: readonly string[] } {
  if (i.recorded_at && i.recorded_at <= i.reversed_on) return { status: "post_recording_reversal", task_status: "post_recording_reversal", event: "lien_release.post_recording_reversal", instrument_signed: true, escalation: { kind: "attorney", severity: "sev1", reason: `payoff reversed ${i.reversed_on} after the release recorded ${i.recorded_at}: re-recording / reinstatement of lien per state law` }, borrower_charge_cents: 0n, officer_informed: true, loan_serviced_as: "unsecured_pending_cure", action: "attorney re-recording or reinstatement of lien; no borrower charge", timers_released: ["SM_BORROWER_RELEASE_NOTICE_5BD", "NY_RPAPL1921_NOTE_RETURN_45"] };
  if (i.executed_at && i.executed_at <= i.reversed_on) return { status: "stopped_unrecorded", task_status: "void", event: "lien_release.voided", instrument_signed: true, escalation: null, borrower_charge_cents: 0n, officer_informed: true, loan_serviced_as: "secured", action: "stop: cancel the submission and void the executed instrument", timers_released: RELEASE_TIMERS_16_3 };
  return { status: "void", task_status: "void", event: "lien_release.voided", instrument_signed: false, escalation: null, borrower_charge_cents: 0n, officer_informed: false, loan_serviced_as: "secured", action: "task voided before execution; no instrument is signed", timers_released: RELEASE_TIMERS_16_3 };
}
