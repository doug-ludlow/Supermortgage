/** §16.3 Lien release and §16.4 MERS deactivation — signatory path, state deadlines, penalties, internal timers, deactivation gate. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export type SignatoryPath = "mers_signing_officer" | "fnma_attorney_in_fact" | "send_to_fnma_documents" | "partner_officer" | "obtain_assignment_first" | "trustee_reconveyance" | "public_trustee";
export function selectSignatory(f: { state: string; min_active: boolean; mortgagee_of_record: "mers" | "fnma" | "partner" | "prior_lender"; lpoa_recorded: boolean; instrument: "mortgage" | "deed_of_trust" | "security_deed"; third_party_trustee?: boolean }): SignatoryPath {
  if (f.state === "CO") return "public_trustee";
  if (f.instrument === "deed_of_trust" && f.third_party_trustee) return "trustee_reconveyance";
  if (f.mortgagee_of_record === "mers" && f.min_active) return "mers_signing_officer";
  if (f.mortgagee_of_record === "fnma") return f.lpoa_recorded ? "fnma_attorney_in_fact" : "send_to_fnma_documents";
  if (f.mortgagee_of_record === "partner") return "partner_officer";
  return "obtain_assignment_first";
}
export const RELEASE_DAYS: Record<string, { days: number; basis: "recording" | "delivery" | "trustee_delivery"; cite: string }> = { OH: { days: 90, basis: "recording", cite: "R.C. §5301.36" }, FL: { days: 45, basis: "recording", cite: "§701.03" }, CA: { days: 30, basis: "trustee_delivery", cite: "CC §2941(b)(1)" }, MD: { days: 7, basis: "delivery", cite: "RP §7-106" }, MA: { days: 45, basis: "delivery", cite: "c. 183 §55" }, NY: { days: 30, basis: "recording", cite: "RPL §275" }, NJ: { days: 30, basis: "recording", cite: "46:18-11.2" }, TX: { days: 60, basis: "recording", cite: "Prop. §12.017" }, DEFAULT: { days: 60, basis: "recording", cite: "policy" } };   // [state values UNVERIFIED; jurisdiction_rules is the runtime source]
export function releaseDeadline(state: string, payoffOn: PlainDate): { due_on: PlainDate; basis: string; cite: string } { const r = RELEASE_DAYS[state] ?? RELEASE_DAYS.DEFAULT!; return { due_on: addDays(payoffOn, r.days), basis: r.basis, cite: r.cite }; }
export function internalTimers(payoffOn: PlainDate): { prepare_by: PlainDate; execute_by: PlainDate; submit_by: PlainDate; borrower_notice_after_recording_bd: 5; custody_request_by: PlainDate } { return { prepare_by: addBusinessDays(payoffOn, 5, servicer), execute_by: addBusinessDays(addBusinessDays(payoffOn, 5, servicer), 3, servicer), submit_by: addDays(payoffOn, 21), borrower_notice_after_recording_bd: 5, custody_request_by: addBusinessDays(payoffOn, 1, servicer) }; }
export function penaltyExposure(state: string, daysLate: number): Cents {
  if (daysLate <= 0) return 0n;
  if (state === "NY") return daysLate > 90 ? 150_000n : daysLate > 60 ? 100_000n : 50_000n;
  if (state === "OH") { const v = 25_000n + BigInt(Math.max(0, daysLate - 1)) * 10_000n; return v > 500_000n ? 500_000n : v; }
  if (state === "CT") { const v = BigInt(Math.ceil(daysLate / 7)) * 20_000n; return v > 500_000n ? 500_000n : v; }
  return 0n;
}
export function caTrusteeClocks(payoffOn: PlainDate, deliveredOn?: PlainDate): { deliver_by: PlainDate; trustee_record_by: PlainDate | null } { return { deliver_by: addDays(payoffOn, 30), trustee_record_by: deliveredOn ? addDays(deliveredOn, 21) : null }; }
export function feePassThrough(f: { state: string; c1205_conditions: boolean; allowed: boolean; disclosed_on_statement: boolean; fee_cents: Cents }): { chargeable: boolean; cap_cents: Cents | null } { const cap = f.state === "CA" ? 4_500n : f.state === "MD" ? 1_500n : f.state === "NJ" ? 2_500n : null; return { chargeable: f.c1205_conditions && f.allowed && f.disclosed_on_statement && (cap === null || f.fee_cents <= cap), cap_cents: cap }; }

// ───── §16.4 MERS deactivation ─────
export function deactivationGate(releaseRecorded: boolean): { ok: true } | { ok: false; gate: "SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE" } { return releaseRecorded ? { ok: true } : { ok: false, gate: "SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE" }; }
export function deactivationClocks(lastRecordingOn: PlainDate): { due_on: PlainDate; policy_target: PlainDate; verify_by: PlainDate; escalate_on: PlainDate } { return { due_on: addDays(lastRecordingOn, 60), policy_target: addBusinessDays(lastRecordingOn, 5, servicer), verify_by: addBusinessDays(lastRecordingOn, 3, servicer), escalate_on: addDays(lastRecordingOn, 55) }; }
export function enoteClocks(payoffOn: PlainDate, recordingOn?: PlainDate): { paid_off_status_by: PlainDate; paper_copy_by: PlainDate | null } { return { paid_off_status_by: addBusinessDays(payoffOn, 2, servicer), paper_copy_by: recordingOn ? addBusinessDays(recordingOn, 10, servicer) : null }; }
export function reversalDue(reversalNeededOn: PlainDate): PlainDate { return addBusinessDays(reversalNeededOn, 5, servicer); }
export function mreException(f: { min_active: boolean; paid_off_release_recorded_on: PlainDate | null; today: PlainDate; loan_active: boolean; subservicer_is_us: boolean }): "active_min_on_paid_loan" | "inactive_min_on_active_loan" | "wrong_subservicer" | null {
  if (f.min_active && f.paid_off_release_recorded_on && daysBetween(f.paid_off_release_recorded_on, f.today) > 60) return "active_min_on_paid_loan";
  if (!f.min_active && f.loan_active) return "inactive_min_on_active_loan"; if (!f.subservicer_is_us) return "wrong_subservicer"; return null;
}
