/**
 * §10 operational rules that sit above the calculators: the HPA decision
 * clock and its breach, the MN/NY/CA overlays, the SMDU outage fallback, the
 * nightly sweep's actions and its self-check, the LAR 89 buffer/close clocks,
 * the premium-stop statement guard, disclosure release/channel/records, the
 * escrow MI-line release, escrow events for refunds, insurer rescissions,
 * the MN information request and the denial QC sample.
 */
import { type PlainDate, addDays, addMonths, daysBetween, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";
import { fannieBusinessDay } from "../investor/period.ts";
import { decisionDue, ltvBps } from "./cancellation.ts";
import { firstOfFollowingMonth } from "./schedule.ts";
import { automaticTermination, finalizationClocks, notCurrentGrounds, type AutoResult, type FinalizationClocks, type Lar89Code } from "./termination.ts";
import { disclosurePlan, disclosureChannel } from "./disclosure.ts";
import { lpmiOptionsNoticeDue as _lpmiDue } from "./termination.ts";

export const ET = "America/New_York";
const mmddyy = (d: PlainDate): string => { const { y, m, d: dd } = parts(d); return `${String(m).padStart(2, "0")}${String(dd).padStart(2, "0")}${String(y % 100).padStart(2, "0")}`; };
const monthName = (d: PlainDate): string => ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][parts(d).m - 1]! + " " + parts(d).y;

// ---- 10.1 --------------------------------------------------------------------

export interface ClockStatus { readonly code: string; readonly due: PlainDate; readonly status: "open" | "satisfied" | "breached"; readonly escalation: { role: "officer"; severity: number } | null; readonly sentinel_line: string | null; }

/** 10.1-T3 — the 30-day HPA decision clock: breached at 23:59 servicer time on the due date without a decision *and* a notice. */
export function decisionClock(i: { received_on: PlainDate; evidence_satisfied_on?: PlainDate | null; decided_on: PlainDate | null; notice_sent_on: PlainDate | null; now: PlainDate }): ClockStatus {
  const due = decisionDue(i.received_on, i.evidence_satisfied_on ?? null);
  const code = "HPA_4904B_DENIAL_NOTICE_30";
  if (i.decided_on !== null && i.notice_sent_on !== null && i.notice_sent_on <= due) return { code, due, status: "satisfied", escalation: null, sentinel_line: null };
  if (i.now > due) return { code, due, status: "breached", escalation: { role: "officer", severity: 1 }, sentinel_line: `${code} breached: request received ${i.received_on}; no decision or notice by ${due} 23:59 servicer time` };
  return { code, due, status: "open", escalation: null, sentinel_line: null };
}

/** 10.1-T7 — Minnesota owner-occupied overlay: 30-day response clock and the §47.207 current-value path offered in the acknowledgment. */
export function mnRequestOverlay(i: { state: string; owner_occupied: boolean; received_on: PlainDate }): { timer: { code: "MN_47_207_RESPONSE_30"; due: PlainDate } | null; ack_paths: readonly string[]; mn_current_value: { threshold_bps: 8000; basis: "appraisal within 90 days"; appraisal_max_age_days: 90; at_borrower_cost: true } | null; response_types: readonly string[] } {
  const mn = i.state === "MN" && i.owner_occupied;
  return {
    timer: mn ? { code: "MN_47_207_RESPONSE_30", due: addDays(i.received_on, 30) } : null,
    ack_paths: mn ? ["hpa_original_value", "fnma_original_value", "mn_current_value"] : ["hpa_original_value", "fnma_original_value"],
    mn_current_value: mn ? { threshold_bps: 8000, basis: "appraisal within 90 days", appraisal_max_age_days: 90, at_borrower_cost: true } : null,
    response_types: mn ? ["approve", "request_additional_information", "deny_with_written_reasons"] : ["approve", "deny_with_written_reasons"],
  };
}

/** 10.1-T8 — SMDU unavailable: retry with backoff for 4 hours; at case day 15+ open the portal fallback with the prepared data set; the HPA clock never moves. */
export function smduOutageFallback(i: { outage_hours: number; case_day: number; hpa_due: PlainDate; data_set: Record<string, unknown> }): { escalation: { kind: "human_portal_task"; owner_role: "fnma_portal_operator"; package: Record<string, unknown> } | null; retry: boolean; hpa_timer: { code: "HPA_4904B_DENIAL_NOTICE_30"; due: PlainDate; changed: false } } {
  const fallback = i.outage_hours >= 4 && i.case_day >= 15;
  return {
    escalation: fallback ? { kind: "human_portal_task", owner_role: "fnma_portal_operator", package: { ...i.data_set, channel: "SMDU UI evaluation", hpa_due: i.hpa_due } } : null,
    retry: !fallback,
    hpa_timer: { code: "HPA_4904B_DENIAL_NOTICE_30", due: i.hpa_due, changed: false },
  };
}

// ---- 10.2 / 10.3 -------------------------------------------------------------

export interface TerminationActions {
  readonly event: "mi.terminated" | "mi.cancelled";
  readonly effective: PlainDate;
  readonly lar89: { code: Lar89Code; action_date: string; line: string; due_ms: number };
  readonly insurer_message: { queued: true; reason: string; due: PlainDate };
  readonly escrow_interim_analysis: { requested: true; due: PlainDate };
  readonly timers: readonly { code: string; due: PlainDate }[];
}

/** R-F1…R-F6 as concrete actions for a termination/cancellation with effective date E. */
export function terminationActions(loanId: string, clocks: FinalizationClocks, kind: "automatic_78" | "automatic_midpoint" | "borrower" = "automatic_78"): TerminationActions {
  const e = clocks.effective_on;
  return {
    event: kind === "borrower" ? "mi.cancelled" : "mi.terminated", effective: e,
    lar89: { code: clocks.lar89.code, action_date: clocks.lar89.action_date, line: `89 0 ${loanId} ${clocks.lar89.code} ${clocks.lar89.action_date}`, due_ms: lar89Clocks(e).period_close_ms },
    insurer_message: { queued: true, reason: kind === "borrower" ? "HPA_borrower_cancellation" : kind === "automatic_midpoint" ? "FNMA_midpoint" : "HPA_automatic_termination", due: clocks.insurer_notice_due },
    escrow_interim_analysis: { requested: true, due: clocks.escrow_interim_analysis_due },
    timers: [
      { code: "HPA_4904A_TERMINATION_NOTICE_30", due: clocks.notice_due }, { code: "HPA_4902E_STOP_PREMIUM_30", due: clocks.premium_stop_by }, { code: "HPA_4902F1_REFUND_45", due: clocks.refund_due },
      { code: "MI_INSURER_CANCEL_NOTICE_45", due: addDays(e, 45) }, { code: "SM_MI_INSURER_CANCEL_TARGET_2BD", due: clocks.insurer_notice_due },
    ],
  };
}

/** 10.2-T1 — the nightly sweep on the scheduled date: terminate if current, else defer with the not-current notice. */
export function sweepTermination(i: { loan_id: string; installments: readonly AppliedInstallment[]; scheduled_date: PlainDate; applies?: boolean; kind?: "automatic_78" | "automatic_midpoint"; cal?: Calendar }): { result: AutoResult; actions: TerminationActions | null; not_current_notice: NotCurrentNotice | null } {
  const result = automaticTermination(i.installments, i.scheduled_date, i.applies ?? true, i.cal ?? servicer);
  if (result.status === "terminated") return { result, actions: terminationActions(i.loan_id, result.clocks, i.kind ?? "automatic_78"), not_current_notice: null };
  if (result.status === "deferred_not_current") return { result, actions: result.clocks ? terminationActions(i.loan_id, result.clocks, i.kind ?? "automatic_78") : null, not_current_notice: notCurrentNotice(i.installments, i.scheduled_date) };
  return { result, actions: null, not_current_notice: null };
}

export interface NotCurrentNotice { readonly code: "NTC_HPA_4904B_AUTO_NOT_CURRENT"; readonly installments: readonly PlainDate[]; readonly grounds_text: string; readonly send_by: PlainDate; }

/** 10.2-T2/T3 — the not-current notice names exactly the installment(s) unpaid at the preceding month-end. */
export function notCurrentNotice(installments: readonly AppliedInstallment[], T: PlainDate): NotCurrentNotice {
  const g = notCurrentGrounds(installments, T);
  return { code: "NTC_HPA_4904B_AUTO_NOT_CURRENT", installments: g, grounds_text: g.map((d) => `the ${monthName(d)} payment was not received by ${endOfMonth(d)}`).join("; "), send_by: addDays(T, 30) };
}

/** 10.2-T6 — the next sweep finds policies whose scheduled date passed with no decision: the 0-day timer breached (job failure). */
export function sweepMissedCheck(i: { policies: readonly { loan_id: string; scheduled_date: PlainDate; auto_status: string }[]; last_sweep_on: PlainDate | null; today: PlainDate }): { breached: boolean; timer: "HPA_4902B_AUTO_TERMINATE_0"; job_failure: boolean; escalation: { role: "officer"; severity: 1; affected_loans: readonly string[] } | null } {
  const affected = i.policies.filter((p) => p.auto_status === "pending" && p.scheduled_date < i.today).map((p) => p.loan_id);
  const missed = i.policies.filter((p) => p.auto_status === "pending" && p.scheduled_date < i.today && (i.last_sweep_on === null || i.last_sweep_on < p.scheduled_date)).length > 0;
  return { breached: affected.length > 0, timer: "HPA_4902B_AUTO_TERMINATE_0", job_failure: missed, escalation: affected.length ? { role: "officer", severity: 1, affected_loans: affected } : null };
}

export interface Lar89Clocks { readonly internal_target_ms: number; readonly bulk_cutoff_ms: number; readonly period_close_ms: number; readonly period_close_on: PlainDate; }

/** 10.2 R6 — internal next-BD 20:00 ET target; LSDU bulk cutoff BD2 15:00 ET; period close BD2 17:00 ET of the month after E. */
export function lar89Clocks(effective: PlainDate): Lar89Clocks {
  const bd2 = fannieBusinessDay(firstOfFollowingMonth(effective), 2);
  return { internal_target_ms: zonedEpochMs(addBusinessDays(effective, 1, fannieEt), "20:00", ET), bulk_cutoff_ms: zonedEpochMs(bd2, "15:00", ET), period_close_ms: zonedEpochMs(bd2, "17:00", ET), period_close_on: bd2 };
}

/** 10.2-T7 — LAR 89 not acked by the bulk cutoff: the policy buffer is breached and single-LAR entry goes to the portal operator before the 17:00 close. */
export function lar89AckStatus(i: { effective: PlainDate; acked_at_ms: number | null; now_ms: number }): { status: "acked" | "open" | "bulk_channel_closed" | "breached"; clocks: Lar89Clocks; timer_breached: string | null; human_portal_task: { kind: "single_lar_entry"; owner_role: "fnma_portal_operator"; by_ms: number } | null; escalation: { role: "officer"; severity: 2 } | null } {
  const clocks = lar89Clocks(i.effective);
  if (i.acked_at_ms !== null && i.acked_at_ms <= clocks.period_close_ms) return { status: "acked", clocks, timer_breached: null, human_portal_task: null, escalation: null };
  if (i.now_ms >= clocks.period_close_ms) return { status: "breached", clocks, timer_breached: "FNMA_IRM_LAR89_PERIOD_END", human_portal_task: { kind: "single_lar_entry", owner_role: "fnma_portal_operator", by_ms: clocks.period_close_ms }, escalation: { role: "officer", severity: 2 } };
  if (i.now_ms >= clocks.bulk_cutoff_ms) return { status: "bulk_channel_closed", clocks, timer_breached: "SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000", human_portal_task: { kind: "single_lar_entry", owner_role: "fnma_portal_operator", by_ms: clocks.period_close_ms }, escalation: null };
  return { status: "open", clocks, timer_breached: i.now_ms >= clocks.internal_target_ms ? "SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000" : null, human_portal_task: null, escalation: null };
}

/** 10.2-T8 — no installment due after the premium-stop date may carry the MI escrow component. */
export function statementMiGuard(i: { installment_due: PlainDate; effective: PlainDate; includes_mi: boolean }): { blocked: boolean; gate: "HPA_4902E_STOP_PREMIUM_30"; premium_stop_by: PlainDate; alert: { role: "officer"; severity: 1 } | null } {
  const stop = addDays(i.effective, 30);
  const blocked = i.includes_mi && i.installment_due > stop;
  return { blocked, gate: "HPA_4902E_STOP_PREMIUM_30", premium_stop_by: stop, alert: blocked ? { role: "officer", severity: 1 } : null };
}

/** 10.2-T11 — NY Ins. Law §6503(d): at ≤ 75% of the original appraised value the borrower stops paying; the servicer carries the premium until Fannie Mae criteria are met. */
export function nyPremiumGate(i: { state: string; upb_cents: Cents; original_appraised_value_cents: Cents; history_ok: boolean; fnma_eligible?: boolean }): { gate_open: boolean; ltv_bps: number; stop_borrower_premium: boolean; premium_borne_by: "borrower" | "servicer_corporate" | "none_terminated"; escalation: { role: "officer"; record: "corporate premium carry" } | null; reevaluate: "monthly_10_1" | null } {
  const bps = ltvBps(i.upb_cents, i.original_appraised_value_cents);
  if (i.state !== "NY" || bps > 7500) return { gate_open: false, ltv_bps: bps, stop_borrower_premium: false, premium_borne_by: "borrower", escalation: null, reevaluate: null };
  if (i.fnma_eligible === true && i.history_ok) return { gate_open: true, ltv_bps: bps, stop_borrower_premium: true, premium_borne_by: "none_terminated", escalation: null, reevaluate: null };
  return { gate_open: true, ltv_bps: bps, stop_borrower_premium: true, premium_borne_by: "servicer_corporate", escalation: { role: "officer", record: "corporate premium carry" }, reevaluate: "monthly_10_1" };
}

/** 10.3-T7 — the midpoint date passes without a sweep decision. */
export function midpointSweepCheck(i: { midpoint_termination_date: PlainDate; decided_on: PlainDate | null; today: PlainDate }): { timer: "HPA_4902C_MIDPOINT_TERMINATE_0"; status: "open" | "satisfied" | "breached"; escalation: { role: "officer"; severity: 1 } | null } {
  if (i.decided_on !== null) return { timer: "HPA_4902C_MIDPOINT_TERMINATE_0", status: "satisfied", escalation: null };
  if (i.today > i.midpoint_termination_date) return { timer: "HPA_4902C_MIDPOINT_TERMINATE_0", status: "breached", escalation: { role: "officer", severity: 1 } };
  return { timer: "HPA_4902C_MIDPOINT_TERMINATE_0", status: "open", escalation: null };
}

// ---- 10.4 --------------------------------------------------------------------

/** 10.4-T2 — annual disclosure not sent by the 12-month due date: breach, standalone auto-send, officer sev-2, Sentinel line. */
export function annualDisclosureCheck(i: { due: PlainDate; sent_on: PlainDate | null; now: PlainDate }): { timer: "HPA_4903A3_ANNUAL_DISCLOSURE_12M"; status: "open" | "satisfied" | "breached"; auto_send: { code: "NTC_HPA_4903A3_ANNUAL"; included_with: "standalone" } | null; escalation: { role: "officer"; severity: 2 } | null; sentinel: boolean } {
  const t = "HPA_4903A3_ANNUAL_DISCLOSURE_12M" as const;
  if (i.sent_on !== null && i.sent_on <= i.due) return { timer: t, status: "satisfied", auto_send: null, escalation: null, sentinel: false };
  if (i.now > i.due) return { timer: t, status: "breached", auto_send: { code: "NTC_HPA_4903A3_ANNUAL", included_with: "standalone" }, escalation: { role: "officer", severity: 2 }, sentinel: true };
  return { timer: t, status: "open", auto_send: null, escalation: null, sentinel: false };
}

export type DisclosureCode = "NTC_HPA_4903A3_ANNUAL" | "NTC_HPA_4903A3_ANNUAL_MN" | "NTC_HPA_4903A3_ANNUAL_CA" | "NTC_HPA_4903B_ANNUAL_LEGACY" | "NTC_FNMA_MI_ANNUAL_INFO";

/** 10.4 R1 — template by plan, consummation date, HPA scope and state. */
export function disclosureTemplateCode(i: { plan: string; consummation: PlainDate; hpa_covered: boolean; state: string }): DisclosureCode | null {
  if (i.plan === "lpmi") return null;
  if (i.consummation < "1999-07-29") return "NTC_HPA_4903B_ANNUAL_LEGACY";
  if (!i.hpa_covered) return "NTC_FNMA_MI_ANNUAL_INFO";
  if (i.state === "MN") return "NTC_HPA_4903A3_ANNUAL_MN";
  if (i.state === "CA") return "NTC_HPA_4903A3_ANNUAL_CA";
  return "NTC_HPA_4903A3_ANNUAL";
}

/** 10.4-T5 (CA) — the §2954.6 notice rides every §2954.2 statement in ≥ 10-pt bold; attachment satisfies the CA timer. */
export function caStatementAttachment(i: { state: string; statement_kind: string }): { attach: boolean; code: "NTC_HPA_4903A3_ANNUAL_CA"; min_pt: 10; bold: true; timer: "CA_2954_6_NOTICE_WITH_STATEMENT"; satisfied_by: "notice.attached"; release_blocked_without: boolean } {
  const attach = i.state === "CA" && i.statement_kind === "annual_escrow";
  return { attach, code: "NTC_HPA_4903A3_ANNUAL_CA", min_pt: 10, bold: true, timer: "CA_2954_6_NOTICE_WITH_STATEMENT", satisfied_by: "notice.attached", release_blocked_without: attach };
}

/** 10.4-T4 — LPMI gets no annual disclosure; the 4905(c)(2) options timer exists instead. */
export function disclosureSchedule(i: { plan: string; status: string; lpmi_equiv_termination_date: PlainDate | null; last_sent: PlainDate | null; boarded_on: PlainDate; escrow_statement_on?: PlainDate | null; form_1098_on?: PlainDate | null }): { annual_timer: { code: "HPA_4903A3_ANNUAL_DISCLOSURE_12M"; due: PlainDate; send_on: PlainDate; included_with: string } | null; timers: readonly { code: string; due: PlainDate }[] } {
  if (i.plan === "lpmi") return { annual_timer: null, timers: i.lpmi_equiv_termination_date ? [{ code: "HPA_4905C2_LPMI_OPTIONS_NOTICE_30", due: _lpmiDue(i.lpmi_equiv_termination_date) }] : [] };
  if (i.status !== "active") return { annual_timer: null, timers: [] };
  const p = disclosurePlan({ last_sent: i.last_sent, boarded_on: i.boarded_on, escrow_statement_on: i.escrow_statement_on ?? null, form_1098_on: i.form_1098_on ?? null });
  return { annual_timer: { code: "HPA_4903A3_ANNUAL_DISCLOSURE_12M", due: p.next_due, send_on: p.send_on, included_with: p.included_with }, timers: i.last_sent === null ? [{ code: "SM_MI_FIRST_DISCLOSURE_POST_BOARDING_60", due: addDays(i.boarded_on, 60) }] : [] };
}

/** 10.4-T6 — e-delivery only with a valid, unrevoked consent for the class on the send date. */
export function disclosureChannelAt(i: { consent: { class: string; given_on: PlainDate; revoked_on: PlainDate | null } | null; send_on: PlainDate }): { channel: "electronic" | "mail"; reason: string } {
  const c = i.consent;
  const valid = c !== null && c.class === "annual_disclosures" && c.given_on <= i.send_on && (c.revoked_on === null || c.revoked_on > i.send_on);
  return { channel: disclosureChannel(valid), reason: valid ? "esign consent in force" : c === null ? "no esign consent" : c.revoked_on !== null && c.revoked_on <= i.send_on ? `consent revoked ${c.revoked_on}` : "consent does not cover annual_disclosures" };
}

/** 10.4-T7 — composition re-checks status at release: MI already ended → suppress the page and send the 4904(a) notice within 30 days. */
export function disclosureReleaseCheck(i: { terminated_on: PlainDate | null; release_on: PlainDate }): { suppress_pmi_page: boolean; send_instead: { code: "NTC_HPA_4904A_CANCELLED"; due: PlainDate } | null } {
  if (i.terminated_on !== null && i.terminated_on <= i.release_on) return { suppress_pmi_page: true, send_instead: { code: "NTC_HPA_4904A_CANCELLED", due: addDays(i.terminated_on, 30) } };
  return { suppress_pmi_page: false, send_instead: null };
}

export interface DisclosureRecord { readonly id: number; readonly loan_id: string; readonly schedule_version_id: string; readonly projected_80_date: PlainDate | null; readonly projected_78_date: PlainDate | null; readonly projected_midpoint_date: PlainDate | null; readonly sent_on: PlainDate; }

/** 10.4-T9 — `mi_disclosures` is append-only: a new record carries the new projection; the prior record is untouched. */
export function appendDisclosureRecord(records: readonly DisclosureRecord[], r: Omit<DisclosureRecord, "id">): readonly DisclosureRecord[] {
  return [...records, { id: records.length + 1, ...r }];
}

// ---- 10.5 --------------------------------------------------------------------

/** 10.5-T4 / R6 — interim analysis within 10 BD closes the MI line as of E, refunds its balance as surplus within 30 days, and drops the payment by the MI deposit effective the first installment due ≥ 31 days after E. */
export function escrowMiLineRelease(i: { E: PlainDate; mi_line_balance_cents: Cents; monthly_mi_deposit_cents: Cents; old_payment_cents: Cents; analysis_on?: PlainDate | null; cal?: Calendar }): { interim_analysis_due: PlainDate; analysis_on: PlainDate; surplus_cents: Cents; surplus_refund_due: PlainDate; new_payment_cents: Cents; new_payment_effective: PlainDate; refund_regardless_of_50_threshold: true; min_30_gate_bypassed: true } {
  const due = addBusinessDays(i.E, 10, i.cal ?? servicer);
  const on = i.analysis_on ?? due;
  let eff = firstOfFollowingMonth(i.E);
  while (daysBetween(i.E, eff) < 31) eff = addMonths(eff, 1);
  return { interim_analysis_due: due, analysis_on: on, surplus_cents: i.mi_line_balance_cents, surplus_refund_due: addDays(on, 30), new_payment_cents: i.old_payment_cents - i.monthly_mi_deposit_cents, new_payment_effective: eff, refund_regardless_of_50_threshold: true, min_30_gate_bypassed: true };
}

export const ESCROW_EVENTS_LIVE_FROM: PlainDate = ymd(2026, 12, 1);

/** 10.5-T9 — from Dec. 1, 2026 the insurer deposit and the borrower disbursement are escrow events due 03:00 ET the next Fannie business day. */
export function refundEscrowEvents(i: { posted_on: PlainDate; legs: readonly { kind: "deposit" | "disbursement"; amount_cents: Cents }[] }): { events: readonly { type: "escrow.event"; category: "taxes_insurance"; kind: string; amount_cents: Cents; accept_by_ms: number }[]; accept_by_ms: number | null; reason: string | null } {
  if (i.posted_on < ESCROW_EVENTS_LIVE_FROM) return { events: [], accept_by_ms: null, reason: "escrow events begin 2026-12-01 (LL-2026-05); Form 496A captures the flows until then" };
  const acceptBy = zonedEpochMs(addBusinessDays(i.posted_on, 1, fannieEt), "03:00", ET);
  return { events: i.legs.map((l) => ({ type: "escrow.event", category: "taxes_insurance", kind: l.kind, amount_cents: l.amount_cents, accept_by_ms: acceptBy })), accept_by_ms: acceptBy, reason: null };
}

/** 10.5-T10 — insurer rescission/cancellation: LAR 89 code 54 dated the notice date, Fannie Mae told within 30 days, borrower refund leg held for the officer. */
export function insurerRescission(i: { received_on: PlainDate; loan_active: boolean }): { lar89: { code: "54"; action_date: string; line_suffix: string }; fnma_notification: { due: PlainDate; channel: "lar89" | "email_liquidated" }; borrower_refund_leg: { status: "held"; decision_by: "officer"; borrower_entitled_unless: "borrower misrepresentation" }; mi_escrow_line: "closed"; hpa_termination_notice: false; informational_letter: true; exposure_review: "A1-3-02" } {
  const ad = mmddyy(i.received_on);
  return { lar89: { code: "54", action_date: ad, line_suffix: `54 ${ad}` }, fnma_notification: { due: addDays(i.received_on, 30), channel: i.loan_active ? "lar89" : "email_liquidated" }, borrower_refund_leg: { status: "held", decision_by: "officer", borrower_entitled_unless: "borrower misrepresentation" }, mi_escrow_line: "closed", hpa_termination_notice: false, informational_letter: true, exposure_review: "A1-3-02" };
}

// ---- 10.6 --------------------------------------------------------------------

/** 10.6-T6 — a request missing essentials: information request within 30 days of receipt (MN §47.207 subd. 4; used nationally); 60 days to respond. */
export function infoRequest(i: { state: string; received_on: PlainDate; missing: readonly string[] }): { notice: "NTC_MI_INFO_REQUEST" | null; send_by: PlainDate | null; satisfies: "MN_47_207_RESPONSE_30" | null; closes_after_days: 60; missing: readonly string[] } {
  if (i.missing.length === 0) return { notice: null, send_by: null, satisfies: null, closes_after_days: 60, missing: [] };
  return { notice: "NTC_MI_INFO_REQUEST", send_by: addDays(i.received_on, 30), satisfies: i.state === "MN" ? "MN_47_207_RESPONSE_30" : null, closes_after_days: 60, missing: i.missing };
}

/** 10.6-T10 — deterministic 10% monthly QC sample of denials; sampled rows are marked and feed `qc_finding` cases. */
export function qcSample<T extends { id: string }>(denials: readonly T[], rateBps = 1000): { sampled_ids: readonly string[]; marked: readonly (T & { qc_sampled: boolean })[]; cases: readonly { case_type: "qc_finding"; denial_id: string; status: "open" }[] } {
  const sorted = [...denials].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const picked = new Set<string>();
  sorted.forEach((d, idx) => { if (Math.floor(((idx + 1) * rateBps) / 10000) > Math.floor((idx * rateBps) / 10000)) picked.add(d.id); });
  return { sampled_ids: sorted.filter((d) => picked.has(d.id)).map((d) => d.id), marked: denials.map((d) => ({ ...d, qc_sampled: picked.has(d.id) })), cases: [...picked].map((id) => ({ case_type: "qc_finding", denial_id: id, status: "open" })) };
}

export { finalizationClocks };
