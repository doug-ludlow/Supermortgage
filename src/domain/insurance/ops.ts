/**
 * §9 mechanics beyond hazard/fpi/refund/flood/lossdraft/inspection/
 * preservation: the CA placement cap (9.1), first-notice variants, track
 * selection and vendor fee screening (9.2), refund independence from the
 * carrier (9.5), LOMA termination, same-day lapses and the vendor heartbeat
 * (9.6), the loss-draft escrow event (9.7), vacancy confirmation and the
 * PFPIP package (9.8), and the preservation mode/registration/audit clocks
 * (9.9). bigint cents; calendars as the spec names them.
 */
import { type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { lpiCoverage, firstNoticeContent, selectTrack, fpiClocks, escrowGuard, type InsuranceType, type FpiTrack, type EscrowGuard } from "./fpi.ts";
import { cancellation, type CancellationInput, type CancellationResult } from "./refund.ts";
import { floodNoticeClocks, floodVendorSeverity } from "./flood.ts";
import { nextInspectionWindow, pfpipTaskDue, inspectionWindow, pfpipExceptionSubmitOn } from "./inspection.ts";
import { carrierVacancyNoticeDue, preservationMode, registrationClocks, auditDocumentsDue } from "./preservation.ts";
import { eventDeadlineMs } from "../investor/period.ts";

export const ET = "America/New_York";

// ---- 9.1 -------------------------------------------------------------------
/** 9.1-T10 / 9.2 rule 4: in capped states (CA) the LPI amount may never exceed replacement cost; a request above RCV is blocked by the jurisdiction override. */
export function lpiPlacementRequest(f: { state: string; requested_cents: Cents; rcv_cents: Cents; upb_cents: Cents; last_known_cents: Cents | null; state_cap_cents: Cents | null }): { blocked: boolean; reason: string | null; allowed_cents: Cents; deductible_cents: Cents; basis: string } {
  const cap = f.state === "CA" ? (f.state_cap_cents ?? f.rcv_cents) : f.state_cap_cents;
  const c = lpiCoverage({ last_known_cents: f.last_known_cents, rcv_cents: f.rcv_cents, upb_cents: f.upb_cents, state_cap_cents: cap });
  const blocked = f.state === "CA" && f.requested_cents > f.rcv_cents;
  return { blocked, reason: blocked ? "jurisdiction override (CA): the placed amount may not exceed the replacement cost value" : null, allowed_cents: c.coverage_cents, deductible_cents: c.deductible_cents, basis: c.basis };
}

// ---- 9.2 -------------------------------------------------------------------
/** 9.2 rule 2 / T6: a windstorm-only gap names "windstorm" as the insurance type and carries the (c)(2)(v)(C) insufficient-coverage statement. */
export function firstNoticeVariant(kind: "expiring" | "expired" | "insufficient", type: InsuranceType): { insurance_type: "hazard" | "windstorm"; condition: string; vC_statement: string | null; purchase_phrase: "will purchase" } {
  const c = firstNoticeContent(kind, type);
  return { insurance_type: c.insurance_type, condition: c.condition, vC_statement: type === "wind" ? "we have a reasonable basis to believe your insurance does not provide sufficient coverage for windstorm (comment 37(c)(2)(v)-1)" : null, purchase_phrase: c.purchase_phrase };
}
/** 9.2 rule 2 / T9: a lapse of flood coverage the FDPA requires opens the `fdpa_flood` track — the 45-day flood notice, never an MS-3(A). */
export function fpiCaseOpen(f: { insurance_type: InsuranceType; fdpa_required: boolean; opened_on: PlainDate }): { track: FpiTrack; first_notice: "INS_FPI_FIRST_MS3A" | "INS_FLOOD_FPI_NOTICE_45"; ms3a: boolean } {
  const track = f.insurance_type === "flood" && f.fdpa_required ? "fdpa_flood" : selectTrack(f.insurance_type === "flood" ? "hazard" : f.insurance_type);
  return { track, first_notice: track === "fdpa_flood" ? "INS_FLOOD_FPI_NOTICE_45" : "INS_FPI_FIRST_MS3A", ms3a: track !== "fdpa_flood" };
}
export interface LapseDetectedInput { readonly escrowed: boolean; readonly regx_days_delinquent: number; readonly cancellation_reason: "nonpayment" | "underwriting" | "other" | null; readonly vacant?: boolean; readonly insurance_type: InsuranceType; readonly fdpa_required: boolean; readonly opened_on: PlainDate; }
export interface LapseDetectedOutcome { readonly guard: EscrowGuard; readonly case_status: "k5_blocked" | "first_notice_pending" | "flood_notice_pending" | "closed_servicer_pays"; readonly k5_gate: "n/a" | "blocked_advance" | "open_inability"; readonly premium: "advanced_by_3_7" | "borrower_charge_after_cycle"; readonly first_notice: "INS_FPI_FIRST_MS3A" | "INS_FLOOD_FPI_NOTICE_45" | null; readonly track: FpiTrack; }
/** 9.1-T5 / 9.2-T3–T4 / state machine: `insurance.lapse_detected` opens the 9.2 case with the escrow/(k)(5) guard evaluated first — an escrowed borrower > 30 days overdue without documented inability is `k5_blocked` (3.7 advances; no FPI notice); with inability the gate opens and the cycle proceeds. */
export function lapseDetected(f: LapseDetectedInput): LapseDetectedOutcome {
  const guard = escrowGuard(f.escrowed, f.regx_days_delinquent, f.cancellation_reason, f.vacant ?? false);
  const c = fpiCaseOpen({ insurance_type: f.insurance_type, fdpa_required: f.fdpa_required, opened_on: f.opened_on });
  if (guard === "servicer_pays") return { guard, case_status: "closed_servicer_pays", k5_gate: "n/a", premium: "advanced_by_3_7", first_notice: null, track: c.track };
  if (guard === "k5_blocked") return { guard, case_status: "k5_blocked", k5_gate: "blocked_advance", premium: "advanced_by_3_7", first_notice: null, track: c.track };
  return { guard, case_status: c.track === "fdpa_flood" ? "flood_notice_pending" : "first_notice_pending", k5_gate: guard === "k5_inability_documented" ? "open_inability" : "n/a", premium: "borrower_charge_after_cycle", first_notice: c.first_notice, track: c.track };
}
/** B-6-01 / §1024.37(h) / T10: the borrower is charged only the bona fide premium — no vendor "servicer expense reimbursement", commission or affiliate arrangement. */
export function placementConfig(f: { vendor_id: string; whitelist: readonly string[]; affiliate: boolean; fees: readonly { kind: string; cents: Cents }[] }): { accepted: boolean; rejected: string[] } {
  const rejected: string[] = [];
  if (!f.whitelist.includes(f.vendor_id)) rejected.push("vendor not on the program whitelist");
  if (f.affiliate) rejected.push("affiliate carrier prohibited");
  for (const fee of f.fees) if (/reimburse|commission|kickback|servicer.*expense|bonus/i.test(fee.kind)) rejected.push(`${fee.kind}: B-6-01 commission/expense-reimbursement exclusion; §1024.37(h) bona fide premium only`);
  return { accepted: rejected.length === 0, rejected };
}

// ---- 9.5 -------------------------------------------------------------------
/** 9.5 rule 4 / T3: the borrower's refund is paid by day 15 regardless of the carrier's acknowledgment; a late ack is a sev-3 vendor follow-up. */
export function refundTimeline(i: CancellationInput, carrierAckOn: PlainDate | null, paidOn: PlainDate | null): { result: CancellationResult; borrower_refund_by: PlainDate; refund_on_time: boolean | null; carrier_ack_late: boolean; vendor_followup: "sev3" | null; officer_breach_risk_on: PlainDate } {
  const r = cancellation(i);
  const ackLate = carrierAckOn !== null && carrierAckOn > r.deadline;
  return { result: r, borrower_refund_by: r.deadline, refund_on_time: paidOn === null ? null : paidOn <= r.deadline, carrier_ack_late: ackLate, vendor_followup: ackLate ? "sev3" : null, officer_breach_risk_on: addBusinessDaysCal(i.evidence_received_on, 12) };
}
const addBusinessDaysCal = (d: PlainDate, n: number): PlainDate => { let x = d; for (let k = 0; k < n; k++) x = addDay(x); return x; };
const addDay = (d: PlainDate): PlainDate => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10) as PlainDate; };

// ---- 9.6 -------------------------------------------------------------------
/** 9.6 rule 7 / T6: a LOMA clears the requirement; LPI flood is cancelled effective the letter date with the overlap refunded (30-day clock) and the removed notice sent. */
export function lomaLetter(f: { letter_date: PlainDate; received_on: PlainDate; lpi: CancellationInput["terms"]; borrower_paid_cents: Cents }): { requirement: "cleared"; cancellation_effective: PlainDate; refund: CancellationResult; notice: "INS_FLOOD_REMOVED_NOTICE"; file_letter: "B-3-01" } {
  const r = cancellation({ terms: f.lpi, borrower_coverage_start: f.letter_date, borrower_coverage_end: null, evidence_received_on: f.received_on, borrower_paid_cents: f.borrower_paid_cents, deadline_days: 30 });
  return { requirement: "cleared", cancellation_effective: f.letter_date, refund: r, notice: "INS_FLOOD_REMOVED_NOTICE", file_letter: "B-3-01" };
}
/** 9.6 rule 4 / T7: hazard and flood lapsing the same day → MS-3(A) and the flood 45-day notice as separate documents in one transmittal, each on its own clock. */
export function sameDayLapses(f: { mailed_on: PlainDate; hazard_lapse: boolean; flood_lapse: boolean }): { documents: { template: string; separate_document: true; clock: string; deadline: PlainDate }[]; transmittals: 1; timers_independent: true } {
  const docs: { template: string; separate_document: true; clock: string; deadline: PlainDate }[] = [];
  if (f.hazard_lapse) { const c = fpiClocks(f.mailed_on, null); docs.push({ template: "INS_FPI_FIRST_MS3A", separate_document: true, clock: "REGX_1024_37C_FPI_FIRST_NOTICE_45", deadline: c.earliest_charge }); }
  if (f.flood_lapse) { const c = floodNoticeClocks(f.mailed_on, null); docs.push({ template: "INS_FLOOD_FPI_NOTICE_45", separate_document: true, clock: "FDPA_4012A_E_FLOOD_FPI_NOTICE_45", deadline: c.borrower_deadline }); }
  return { documents: docs, transmittals: 1, timers_independent: true };
}
/** 9.6 edge "Vendor outage/LOL gap" / T8: no vendor message for 36 days → sev-2 and a re-order queue for every loan with a pending map-change alert. */
export function vendorHeartbeatCheck(f: { last_message_on: PlainDate; today: PlainDate; pending_alerts: readonly { loan_id: string; certificate_id: string }[] }): { severity: "ok" | "sev2"; reorder_queue: { loan_id: string; certificate_id: string; action: "manual_reorder" }[] } {
  const sev = floodVendorSeverity(f.last_message_on, f.today);
  return { severity: sev, reorder_queue: sev === "sev2" ? f.pending_alerts.map((a) => ({ ...a, action: "manual_reorder" as const })) : [] };
}

// ---- 9.7 -------------------------------------------------------------------
/** 9.7 rule 12 / T10: every loss-draft posting emits an escrow event (category loss_draft) due 03:00 ET the next Fannie Mae business day. */
export function lossDraftEscrowEvent(f: { deposited_at_ms: number; amount_cents: Cents; loan_id: string }): { event: { type: "escrow.deposit"; escrow_category: "loss_draft"; amount_cents: Cents; loan_id: string }; submit_by_ms: number } {
  return { event: { type: "escrow.deposit", escrow_category: "loss_draft", amount_cents: f.amount_cents, loan_id: f.loan_id }, submit_by_ms: eventDeadlineMs(f.deposited_at_ms) };
}

// ---- 9.8 -------------------------------------------------------------------
/** 9.8 rule 5 / T3: a vacancy finding with the inspector's signed certification flips occupancy, starts the interior monthly schedule, notifies the carrier, opens 9.9 and updates PFPIP within 2 business days. */
export function vacancyConfirmed(f: { inspected_on: PlainDate; certification_signed: boolean; pfpip: boolean; earliest_unpaid_due?: PlainDate | null }): { occupancy: "vacant"; interior_schedule: { from: PlainDate; to: PlainDate }; carrier_notify_by: PlainDate; preservation_case: "opened"; pfpip_update_by: PlainDate | null; pfpip_exception_submit_on: PlainDate | null } {
  if (!f.certification_signed) throw new RangeError("occupancy cannot be marked vacant without the inspector's signed certification (9.8 guardrail)");
  return { occupancy: "vacant", interior_schedule: nextInspectionWindow(f.inspected_on), carrier_notify_by: carrierVacancyNoticeDue(f.inspected_on), preservation_case: "opened", pfpip_update_by: f.pfpip ? pfpipTaskDue(f.inspected_on) : null,
    pfpip_exception_submit_on: f.pfpip && f.earliest_unpaid_due ? pfpipExceptionSubmitOn(f.earliest_unpaid_due, f.inspected_on) : null };
}
export const PFPIP_MANDATORY_FIELDS = ["referral_date", "attorney", "bankruptcy_status", "loss_mit_status", "litigation_flag", "occupancy", "qrpc_date", "hazard_claim", "hoa", "posting_preference", "stop_all_work"] as const;
/** 9.8 rule 8 / T5: day 90 falling on a weekend still opens the order; the PFPIP submission task is due within 2 business days and the package carries every mandatory field. */
export function pfpipSubmission(f: { earliest_unpaid_due: PlainDate; package: Record<string, unknown> }): { day90_on: PlainDate; task_due: PlainDate; missing_fields: string[]; complete: boolean } {
  const w = inspectionWindow(f.earliest_unpaid_due);
  const missing = PFPIP_MANDATORY_FIELDS.filter((k) => f.package[k] === undefined);
  return { day90_on: w.order_allowed, task_due: pfpipTaskDue(w.order_allowed), missing_fields: missing, complete: missing.length === 0 };
}

// ---- 9.9 -------------------------------------------------------------------
/** 9.9 rule 7 / T7: a vacant-property registration ordinance → file by the deadline, claim the fee at actual cost, schedule the renewal. */
export function vacantRegistration(f: { trigger_on: PlainDate; rule: { within_days: number; renewal_months: number | null }; fee_cents: Cents; filed_on?: PlainDate | null }): { file_by: PlainDate; filed_on: PlainDate | null; filed_on_time: boolean | null; renew_on: PlainDate | null; renewal_anchor: "filed_at" | "filing_deadline"; fee_claim_cents: Cents; fee_basis: "actual_cost"; fines_reimbursable: false } {
  const c = registrationClocks(f.trigger_on, f.rule, f.filed_on ?? null); if (!c) throw new RangeError("no registration rule");
  return { file_by: c.file_by, filed_on: f.filed_on ?? null, filed_on_time: f.filed_on ? f.filed_on <= c.file_by : null, renew_on: c.renew_on, renewal_anchor: c.renewal_anchor, fee_claim_cents: f.fee_cents, fee_basis: "actual_cost", fines_reimbursable: false };
}
/** 9.9 rule 1 / T9–T10: PFPIP "Do insp and preserv" → program mode (no servicer securing order; monitor and send updates); an active Chapter 13 suspends preservation pending attorney guidance with restricted PFPIP permissions. */
export function preservationPlan(f: { pfpip: boolean; permission: string; chapter13_active: boolean }): { mode: ReturnType<typeof preservationMode>; servicer_securing_order: boolean; monitor_program: boolean; updates: string[]; attorney_guidance_required: boolean; pfpip_permission: string | null } {
  const mode = preservationMode(f);
  if (mode === "suspended") return { mode, servicer_securing_order: false, monitor_program: f.pfpip, updates: [], attorney_guidance_required: true, pfpip_permission: f.pfpip ? "Do curbside inspection and no preserv." : null };
  if (mode === "pfpip") return { mode, servicer_securing_order: false, monitor_program: true, updates: ["occupancy", "claim", "hoa", "stop_work"], attorney_guidance_required: false, pfpip_permission: f.permission };
  return { mode, servicer_securing_order: true, monitor_program: false, updates: [], attorney_guidance_required: false, pfpip_permission: null };
}
/** 9.9 rule / FNMA_PPM_AUDIT_RESPONSE_7 (T11): documents to Fannie Mae within 7 calendar days of an audit request (the 5-BD policy clock lands on the same date). */
export function auditRequest(requestedOn: PlainDate): { documents_due: PlainDate; calendar_deadline: PlainDate; role: "officer" } {
  const cal = addBusinessDaysCal(requestedOn, 7);
  const bd = auditDocumentsDue(requestedOn);
  return { documents_due: bd < cal ? bd : cal, calendar_deadline: cal, role: "officer" };
}
export const at = (d: PlainDate, hhmm: string): number => zonedEpochMs(d, hhmm, ET);
export const bd = (d: PlainDate, n: number): PlainDate => addBusinessDays(d, n, servicer);
