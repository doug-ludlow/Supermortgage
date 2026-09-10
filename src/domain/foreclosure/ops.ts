/**
 * §13 operating rules over the pure calculators (gates, referral, timeframes,
 * firms, litigation, scra): the occupancy default, pre-filing and exception
 * grounds, NY §1304/§1306 gate, refused-command record and rule-set swap of
 * 13.1; the hold exits, pending-motion instruction, MN gate, unacknowledged
 * postponement, DMDC re-check and rescission of 13.2; the referral package,
 * non-PR deadline, MERS assignment, NY 1304 checklist, firm SLAs, bankruptcy
 * hold, reserve fallback and inspection stop of 13.3; the review outcomes of
 * 13.4; the exhibit versions, 70% warning, rescission exposure, second
 * contested period, bill rebuttal and method deviation of 13.5; the firm
 * suspension, DRA exception, fee earning and scorecard of 13.6; the
 * litigation gates of 13.7; the DMDC lifecycle, affidavit gate, waiver refusal
 * and Feb 29 tail of 13.8; and the Form 1022, late-charge waiver, election
 * ledger, default election, orders request and late request of 13.9.
 */
import { type PlainDate, addDays, addMonths, daysBetween, endOfMonth, parts, ymd, addYears } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, fannieEt, federal } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { gate120, preFilingAppGate, certificationWindow, pendingMotionInstruction, nonPrDeadline, tierAtReceipt, ladderSuspension, regxDays, BLOCKED_BY_HOLD, type GateState, type Tier, type Rung } from "./gates.ts";
import { referralEligible, reviewOutcome, type Gates as ReferralGates } from "./referral.ts";
import { RESCISSION_EXPOSURE_CENTS, atRisk, creditDelays, type Delay } from "./timeframes.ts";
import { earnedPct, suspensionEffective, draEventLate, eoShortfalls, eoTierFor, form200Expectation, escalationDue, transferNoticeGate, type EoTier, type Method as FirmMethod, type Confirmation } from "./firms.ts";
import { motionDraftDue, classify, form20Due, litigationHold, exceptionTrigger, environmental, leadPaintNoticeDue } from "./litigation.ts";
import { protectionEndsOn, dmdcFresh, preServiceObligation, capEffectivePaymentDue, form1022Due, requestWithinStatute, capEndsOn, restorationInstallment, endDateLetterDue, armCappedRate } from "./scra.ts";

export interface Escalation { readonly kind: "officer" | "attorney" | "human_agent" | "fnma_portal_operator" | "signing_officer" | "lossmit_reviewer" | "compliance_sentinel"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; }
export interface Instruction { readonly kind: string; readonly to: "attorney_network" | "firm"; readonly due: PlainDate; readonly sent: boolean; }

// ============================================================ 13.1 120-day prohibition
/** Rule 13.1: unknown occupancy is a principal residence; a model conclusion otherwise below 0.9 goes to a human agent. */
export function occupancyDefault(i: { occupancy: "principal_residence" | "non_principal" | "unknown"; model_conclusion?: { non_principal: boolean; confidence: number } | null }): { treated_as: "principal_residence" | "non_principal"; escalation: Escalation | null } {
  const m = i.model_conclusion ?? null;
  if (i.occupancy === "non_principal") return { treated_as: "non_principal", escalation: null };
  if (m && m.non_principal && m.confidence < 0.9) return { treated_as: "principal_residence", escalation: { kind: "human_agent", reason: `model concluded non-principal residence at confidence ${m.confidence} (< 0.9) — verify before the non-PR path (13.1 guardrail)` } };
  return { treated_as: m && m.non_principal ? "non_principal" : "principal_residence", escalation: null };
}

/** Rule 13.1 §1024.41(f)(2): a complete application before the first notice holds the first notice until the appeal window expires or the appeal is denied. */
export function preFilingAppHold(i: { earliest_unpaid_due: PlainDate; complete_received_on: PlainDate; determination_sent_on: PlainDate; appeal_available: boolean; appeal_denied_on?: PlainDate | null; referral_attempt_on: PlainDate }): { gate: "REGX_1024_41F2_PRE_FILING_APP_GATE"; state: "open" | "closed"; opens_on: PlainDate; refusal: string | null; day_of_attempt: number } {
  const windowEnd = i.appeal_available ? addDays(i.determination_sent_on, 15) : i.determination_sent_on;
  const opens = i.appeal_denied_on && i.appeal_denied_on < windowEnd ? i.appeal_denied_on : windowEnd;
  const state = i.referral_attempt_on >= opens ? "open" : "closed";
  const exitKnown = preFilingAppGate({ complete_app_before_first_notice: true, exit: i.appeal_available ? null : "ineligible_no_appeal", duplicative_41i: false });
  void exitKnown;
  return { gate: "REGX_1024_41F2_PRE_FILING_APP_GATE", state, opens_on: opens, refusal: state === "closed" ? `referral refused by REGX_1024_41F2_PRE_FILING_APP_GATE until ${opens} (appeal window expiry) or appeal denial (§1024.41(f)(2))` : null, day_of_attempt: daysBetween(i.earliest_unpaid_due, i.referral_attempt_on) };
}

/** Rule 13.1 §1024.41(f)(1)(ii)/(iii): a due-on-sale or lienholder exception opens the first notice on that ground only; the default ground stays behind the 120-day gate. */
export function exceptionGround(i: { ground: "due_on_sale" | "join_lienholder" | "default"; recorded_by_role: string; counsel_memo_document_id?: string | null; today: PlainDate; earliest_unpaid_due: PlainDate; principal_residence: boolean }): { allowed: boolean; state: GateState; refusal: string | null } {
  if (i.ground !== "default") { const ok = i.recorded_by_role === "officer" && Boolean(i.counsel_memo_document_id); const g = gate120(i.today, i.earliest_unpaid_due, i.principal_residence, ok ? i.ground : null); return { allowed: ok && g.state === "exception_open", state: g.state, refusal: ok ? null : "exception requires an officer record with the counsel memo (§1024.41(f)(1)(ii)/(iii))" }; }
  const g = gate120(i.today, i.earliest_unpaid_due, i.principal_residence, null);
  return { allowed: g.state === "open" || g.state === "not_applicable", state: g.state, refusal: g.state === "closed" ? `first notice refused on ground=default: REGX_1024_41F1_120_DAY_GATE opens ${g.opens_on}` : null };
}

/** Rule 13.1/13.3 NY: referral may proceed at day 121 (policy) but the first notice waits for §1304 day 90 and the §1306 filing. */
export function nyFirstNoticeGate(i: { today: PlainDate; earliest_unpaid_due: PlainDate; s1304_mailed_on: PlainDate | null; s1306_filed: boolean }): { referral_allowed: boolean; first_notice_allowed: boolean; gate: "STATE_PREFC_NOTICE_GATE:NY"; opens_on: PlainDate | null; refusal: string | null } {
  const day = daysBetween(i.earliest_unpaid_due, i.today); const referral = day >= 121;
  const opens = i.s1304_mailed_on ? addDays(i.s1304_mailed_on, 90) : null;
  const ok = Boolean(opens) && i.today >= opens! && i.s1306_filed;
  return { referral_allowed: referral, first_notice_allowed: ok, gate: "STATE_PREFC_NOTICE_GATE:NY", opens_on: opens, refusal: ok ? null : `first notice refused by STATE_PREFC_NOTICE_GATE:NY${opens ? ` until ${opens}` : " (no §1304 mailing)"}${i.s1306_filed ? "" : " and §1306 filing evidence"} (RPAPL §1304/§1306)` };
}

/** Rule 13.1: a referral attempt against a closed gate is refused, recorded, escalated sev-1, and nothing leaves for the attorney network. */
export function refusedReferral(i: { gate: string; opens_on: PlainDate | null; attempted_on: PlainDate; actor: string }): { refused: true; event: { type: "foreclosure.gate.refused"; gate: string; attempted_on: PlainDate; actor: string }; escalation: Escalation; attorney_message_sent: false } {
  return { refused: true, event: { type: "foreclosure.gate.refused", gate: i.gate, attempted_on: i.attempted_on, actor: i.actor }, escalation: { kind: "compliance_sentinel", severity: "sev1", reason: `referral attempted ${i.attempted_on} while ${i.gate} closed${i.opens_on ? ` (opens ${i.opens_on})` : ""} — attempt logged (13.1 timer table: refused command → Compliance Sentinel)` }, attorney_message_sent: false };
}

/** Rule 13.1 rule 6: the rule-set swap is a versioned gate definition; evaluations after the effective date carry the new codes and a diff is produced. */
export const GATE_DEFINITIONS: Record<"regx.lossmit.2013" | "regx.lossmit.2024nprm", readonly string[]> = { "regx.lossmit.2013": ["REGX_1024_41F1_120_DAY_GATE", "REGX_1024_41F2_PRE_FILING_APP_GATE"], "regx.lossmit.2024nprm": ["REGX_1024_41F1_120_DAY_GATE", "NPRM_REVIEW_CYCLE_GATE", "NPRM_FEE_FREEZE"] };
export function ruleSetSwap(i: { effective_on: PlainDate; evaluation_on: PlainDate }): { rule_set: "regx.lossmit.2013" | "regx.lossmit.2024nprm"; gate_codes: readonly string[]; diff: { added: string[]; removed: string[] } } {
  const after = i.evaluation_on >= i.effective_on; const rs = after ? "regx.lossmit.2024nprm" : "regx.lossmit.2013";
  const a = GATE_DEFINITIONS["regx.lossmit.2013"], b = GATE_DEFINITIONS["regx.lossmit.2024nprm"];
  return { rule_set: rs, gate_codes: GATE_DEFINITIONS[rs], diff: { added: b.filter((c) => !a.includes(c)), removed: a.filter((c) => !b.includes(c)) } };
}

/** Rule 13.1/13.3: a transfer-in with the transferor's first filing evidenced never gets a second first notice; the 7.1 statement flag is set from boarding. */
export function transferredFirstFiling(i: { transferor_first_notice_filed_at: PlainDate | null; transferor_state_prefc_notice_sent: boolean; transferor_lpi_due: PlainDate }): { second_first_notice_allowed: boolean; statement_flag_from_boarding: boolean; resend_state_prefc_notice: boolean; timeframe_lpi_due: PlainDate } {
  const filed = Boolean(i.transferor_first_notice_filed_at);
  return { second_first_notice_allowed: !filed, statement_flag_from_boarding: filed, resend_state_prefc_notice: !filed && !i.transferor_state_prefc_notice_sent, timeframe_lpi_due: i.transferor_lpi_due };
}

// ============================================================ 13.2 dual tracking
/** Rule 13.2 §1024.41(g)(1): an ineligible determination without appeal rights closes the hold the day it is sent; with appeal rights the hold closes the day after the 14-day appeal window (determination + 15 — the same "window expiry" day 13.1-T5 uses) unless the appeal is denied earlier; certification is permitted only inside sale − 15 … sale − 7. */
export function holdExitAndCertification(i: { determination_sent_on: PlainDate; appeal_available: boolean; sale_on: PlainDate; certify_on: PlainDate; appeal_denied_on?: PlainDate | null }): { hold_closes_on: PlainDate; window: { opens: PlainDate; closes: PlainDate }; certification_permitted: boolean } {
  const windowEnd = i.appeal_available ? addDays(i.determination_sent_on, 15) : i.determination_sent_on;
  const closes = i.appeal_denied_on && i.appeal_denied_on < windowEnd ? i.appeal_denied_on : windowEnd; const w = certificationWindow(i.sale_on);
  return { hold_closes_on: closes, window: w, certification_permitted: i.certify_on >= closes && i.certify_on >= w.opens && i.certify_on <= w.closes };
}

/** Rule 13.2 comment 41(g)-3: a pending dispositive motion draws a withdraw/continuance instruction; a ruling anyway is not a breach when the instruction and the firm's filed request are on file. */
export function pendingMotion(i: { application_received_on: PlainDate; motion_pending: boolean; firm_filed_request: boolean; court_ruled_anyway: boolean }): { instruction: "WITHDRAW_MOTION" | "REQUEST_CONTINUANCE" | null; compliance_evidence: string[]; breach: boolean } {
  if (!i.motion_pending) return { instruction: null, compliance_evidence: [], breach: false };
  const ins = pendingMotionInstruction();
  const evidence = ["instruction:" + ins, ...(i.firm_filed_request ? ["firm_filed_request"] : [])];
  return { instruction: ins, compliance_evidence: evidence, breach: i.court_ruled_anyway && !i.firm_filed_request };
}

/** Rule 13.2 Minn. Stat. §582.043: any pending application (complete or not) blocks referral. */
export function mnReferralGate(i: { state: string; application_status: "pending_incomplete" | "pending_complete" | "none" | "closed" }): { allowed: boolean; refusal: string | null } {
  const blocked = i.state === "MN" && i.application_status.startsWith("pending");
  return { allowed: !blocked, refusal: blocked ? "foreclosure.refer refused: STATE_MN_582_043_DUAL_TRACK_GATE — an application is pending (Minn. Stat. §582.043)" : null };
}

/** Rule 13.2 (`REGX_1024_41G_INSTRUCT_COUNSEL_1BD` breach): a HOLD_DISPOSITIVE/POSTPONE_SALE instruction unacknowledged after 1 BD → sev 1 `attorney` escalation with the `officer` informed, plus a phone task; DRA reconciliation flags a missing postponement event after 2 BD. */
export function unacknowledgedPostponement(i: { instruction_sent_on: PlainDate; acknowledged_on: PlainDate | null; dra_postponement_event_on: PlainDate | null; today: PlainDate }): { ack_due: PlainDate; escalation: Escalation | null; officer_informed: boolean; phone_task: boolean; dra_expected_by: PlainDate; dra_exception: boolean } {
  const ackDue = addBusinessDays(i.instruction_sent_on, 1, servicer); const unack = !i.acknowledged_on && i.today > ackDue;
  const draBy = addBusinessDays(i.instruction_sent_on, 2, servicer);
  return { ack_due: ackDue, escalation: unack ? { kind: "attorney", severity: "sev1", reason: `POSTPONE_SALE sent ${i.instruction_sent_on} not acknowledged by ${ackDue} (REGX_1024_41G_INSTRUCT_COUNSEL_1BD breach: sev 1 → attorney; officer informed)` } : null, officer_informed: unack, phone_task: unack, dra_expected_by: draBy, dra_exception: i.dra_postponement_event_on === null && i.today > draBy };
}

/** Rule 13.2/13.8: a DMDC re-check inside the certification window showing active duty withholds certification and instructs postponement. */
export function certificationDmdcCheck(i: { sale_on: PlainDate; check_on: PlainDate; active_duty: boolean }): { in_window: boolean; certification: "withheld" | "issued"; instruction: "POSTPONE_SALE" | "CERTIFY_SALE"; violation_suspected: false } {
  const w = certificationWindow(i.sale_on); const inWin = i.check_on >= w.opens && i.check_on <= i.sale_on;
  return { in_window: inWin, certification: i.active_duty ? "withheld" : "issued", instruction: i.active_duty ? "POSTPONE_SALE" : "CERTIFY_SALE", violation_suspected: false };
}

/** Rule 13.2/13.5/15.1: a sale held in violation is rescinded through 15.1 and books the A1-4.2-02 exposure. */
export function rescissionAfterViolation(i: { sale_on: PlainDate; violation: "dual_tracking" | "scra" | "bankruptcy_stay"; third_party_costs_cents: Cents }): { flow: "15.1.rescission"; exposure_cents: Cents; root_cause: string; escalations: Escalation[] } {
  return { flow: "15.1.rescission", exposure_cents: RESCISSION_EXPOSURE_CENTS + i.third_party_costs_cents, root_cause: `servicer:${i.violation}`, escalations: [{ kind: "attorney", severity: "sev1", reason: `sale ${i.sale_on} held in violation (${i.violation}) — rescind` }, { kind: "officer", severity: "sev1", reason: "A1-4.2-02 rescission fee exposure" }] };
}

// ============================================================ 13.3 referral
/** Rule 13.3 E-1.2-02/E-3.2-05: the referral package carries manifest hashes; the referral date is recorded; status 43 queued; the firm's acknowledgment is due in 2 BD. */
export function referralPackage(i: { referral_on: PlainDate; day: number; principal_residence: boolean; review_outcome: string; documents: readonly { id: string; sha256: string }[] }): { allowed: boolean; refusal: string | null; manifest: { id: string; sha256: string }[]; referral_sent_at: PlainDate; status_code: "43"; firm_ack_due: PlainDate } {
  const ok = i.review_outcome === "refer" && (!i.principal_residence || i.day >= 121) && i.documents.length > 0;
  return { allowed: ok, refusal: ok ? null : i.review_outcome !== "refer" ? `review outcome ${i.review_outcome} is not refer` : i.documents.length === 0 ? "referral package is empty" : "principal residence: no referral before day 121 (E-1.2-02)", manifest: i.documents.map((d) => ({ id: d.id, sha256: d.sha256 })), referral_sent_at: i.referral_on, status_code: "43", firm_ack_due: addBusinessDays(i.referral_on, 2, servicer) };
}

/** Rule 13.3 E-1.2-02/E-3.2-04: a non-principal residence refers by day 120; a complete BRP inside the window records the E-3.2-04 postponement and suspends the deadline. */
export function nonPrReferral(i: { earliest_unpaid_due: PlainDate; today: PlainDate; complete_brp_on?: PlainDate | null }): { refer_by: PlainDate; day: number; postponement: "E-3.2-04" | null; deadline_suspended: boolean } {
  const by = nonPrDeadline(i.earliest_unpaid_due); const brp = i.complete_brp_on && i.complete_brp_on <= by;
  return { refer_by: by, day: daysBetween(i.earliest_unpaid_due, i.today), postponement: brp ? "E-3.2-04" : null, deadline_suspended: Boolean(brp) };
}

/** Rule 13.3 E-1.1-02: in a pre-recordation state the MERS assignment must be recorded before the first notice. */
export function mersAssignmentGate(i: { mers_mortgagee: boolean; pre_recordation_state: boolean; assignment_recorded_on: PlainDate | null; gates_open_on: PlainDate }): { allowed: boolean; allowed_from: PlainDate | null; refusal: string | null } {
  if (!i.mers_mortgagee || !i.pre_recordation_state) return { allowed: true, allowed_from: i.gates_open_on, refusal: null };
  if (!i.assignment_recorded_on) return { allowed: false, allowed_from: null, refusal: "first_notice.authorize refused: MERS assignment to the servicer unrecorded in a pre-recordation state (E-1.1-02)" };
  const from = i.assignment_recorded_on > i.gates_open_on ? i.assignment_recorded_on : i.gates_open_on;
  return { allowed: true, allowed_from: from, refusal: null };
}

/** Rule 13.3 RPAPL §1304/§1306: the NY 90-day notice checklist and the DFS filing within 3 BD; the first notice waits for day 90. */
export function ny1304(i: { mailed_on: PlainDate; county_agencies: readonly string[]; certified_mail_evidence: boolean; first_class_evidence: boolean; s1306_filed_on: PlainDate | null; first_notice_requested_on: PlainDate }): { checklist_passed: boolean; failing: string[]; s1306_due: PlainDate; s1306_on_time: boolean; first_notice_allowed_from: PlainDate; first_notice_allowed: boolean } {
  const failing: string[] = [];
  if (i.county_agencies.length < 5) failing.push("fewer than 5 counseling agencies for the county (§1304(2))");
  if (!i.certified_mail_evidence) failing.push("no certified-mail evidence (§1304(2))");
  if (!i.first_class_evidence) failing.push("no first-class mail evidence (§1304(2))");
  const due = addBusinessDays(i.mailed_on, 3, servicer); const from = addDays(i.mailed_on, 90);
  const filedOk = Boolean(i.s1306_filed_on) && i.s1306_filed_on! <= due;
  return { checklist_passed: failing.length === 0, failing, s1306_due: due, s1306_on_time: filedOk, first_notice_allowed_from: from, first_notice_allowed: failing.length === 0 && filedOk && i.first_notice_requested_on >= from };
}

/** Rule 13.3 E-3.2-05: a firm document request unanswered after 3 BD → sev-1 and compensatory-fee exposure flagged. */
export function firmDocumentRequest(i: { requested_on: PlainDate; fulfilled_on: PlainDate | null; today: PlainDate }): { due: PlainDate; breached: boolean; escalation: Escalation | null; comp_fee_exposure_flag: boolean } {
  const due = addBusinessDays(i.requested_on, 3, servicer); const breached = !i.fulfilled_on && i.today > due;
  return { due, breached, escalation: breached ? { kind: "officer", severity: "sev1", reason: `firm document request of ${i.requested_on} unanswered past ${due} (E-3.2-05)` } : null, comp_fee_exposure_flag: breached };
}

/** Rule 13.3 E-3.1-04: a bankruptcy after referral → firm notified within 1 BD, case on hold, referral-back to the same firm on relief. */
export function bankruptcyAfterReferral(i: { firm_id: string; petition_on: PlainDate; relief_on?: PlainDate | null }): { notify_firm_by: PlainDate; case_status: "on_hold_bankruptcy" | "active"; referral_back_to: string | null } {
  return { notify_firm_by: addBusinessDays(i.petition_on, 1, servicer), case_status: i.relief_on ? "active" : "on_hold_bankruptcy", referral_back_to: i.relief_on ? i.firm_id : null };
}

/** Rule 13.3 E-3.3-05: an expired reserve price with no refresh in time → the bid basis falls back to total indebtedness, with the reason in the decision record. */
export function reserveFallback(i: { reserve_cents: Cents | null; reserve_expires_on: PlainDate | null; sale_on: PlainDate; refresh_available_by: PlainDate | null; total_indebtedness_cents: Cents; insurance_claims_cents?: Cents }): { basis: "reserve" | "indebtedness"; max_bid_cents: Cents; rationale: string } {
  const valid = i.reserve_cents !== null && i.reserve_expires_on !== null && i.reserve_expires_on >= i.sale_on;
  const refreshed = i.refresh_available_by !== null && i.refresh_available_by <= i.sale_on;
  if (valid || refreshed) { const r = i.reserve_cents!; const max = r < i.total_indebtedness_cents ? r : i.total_indebtedness_cents; return { basis: r < i.total_indebtedness_cents ? "reserve" : "indebtedness", max_bid_cents: max, rationale: "unexpired reserve price used (E-3.3-05)" }; }
  return { basis: "indebtedness", max_bid_cents: i.total_indebtedness_cents - (i.insurance_claims_cents ?? 0n), rationale: `reserve price expired ${i.reserve_expires_on ?? "n/a"} before the rescheduled sale ${i.sale_on} and no refresh was available in time — bid total indebtedness minus outstanding insurance claims (E-3.3-05)` };
}

/** Rule 13.3 E-3.3-05: significant uninsured damage on the pre-sale inspection → no bid; Servicing Representative contact task. */
export function preSaleInspectionStop(i: { major_damage: boolean; insured: boolean; damage_kind?: string }): { issue_bid: boolean; task: { kind: "servicing_representative_contact"; reason: string } | null } {
  const stop = i.major_damage && !i.insured;
  return { issue_bid: !stop, task: stop ? { kind: "servicing_representative_contact", reason: `major uninsured ${i.damage_kind ?? "damage"} reported on the pre-sale inspection — bid withheld (E-3.3-05)` } : null };
}

// ============================================================ 13.4 prereferral review
export type ReviewOutcome = ReturnType<typeof reviewOutcome> | "refer_expedited" | "hold_occupancy_unresolved" | "hold_sii";
/** Rule 13.4 E-3.2-01: an open offer window holds the review; at expiry without acceptance the re-review refers with no further delay. */
export function offerWindowHold(i: { window_ends_on: PlainDate; today: PlainDate; accepted: boolean }): { outcome: "hold_lossmit" | "refer" | "hold_performing" } {
  if (i.accepted) return { outcome: "hold_performing" };
  return { outcome: i.today <= i.window_ends_on ? "hold_lossmit" : "refer" };
}

/** Rule 13.4 E-3.2-04 ladder for a non-principal residence: complete BRP → postpone; offer → 14 days; acceptance → first payment by month-end; performing until breach. */
export function nonPrLadder(i: { earliest_unpaid_due: PlainDate; complete_brp_on: PlainDate; offer_sent_on?: PlainDate | null; accepted_on?: PlainDate | null; first_payment_due?: PlainDate | null; first_payment_received?: boolean }): { outcome: "postpone_e3204"; offer_expires_on: PlainDate | null; held_until: PlainDate | null; state: "brp_pending" | "offer_window" | "awaiting_first_payment" | "performing_until_breach" } {
  const day = daysBetween(i.earliest_unpaid_due, i.complete_brp_on); void day;
  if (i.first_payment_received) return { outcome: "postpone_e3204", offer_expires_on: i.offer_sent_on ? addDays(i.offer_sent_on, 14) : null, held_until: null, state: "performing_until_breach" };
  if (i.accepted_on && i.first_payment_due) return { outcome: "postpone_e3204", offer_expires_on: i.offer_sent_on ? addDays(i.offer_sent_on, 14) : null, held_until: endOfMonth(i.first_payment_due), state: "awaiting_first_payment" };
  if (i.offer_sent_on) return { outcome: "postpone_e3204", offer_expires_on: addDays(i.offer_sent_on, 14), held_until: addDays(i.offer_sent_on, 14), state: "offer_window" };
  return { outcome: "postpone_e3204", offer_expires_on: null, held_until: null, state: "brp_pending" };
}

/** D1-3-01 (LL-2026-01): the recommendation "to initiate or continue foreclosure proceedings", the disaster event date, "status of any repairs to the property", "Insurance loss claim date, status, and the amount of proceeds", and the borrower engagement summary (QRPC, intent) — spelled as ops-13-4 DISASTER_REQUEST_CONTENT. */
export const DISASTER_REQUEST_ELEMENTS = ["recommendation", "disaster_event_date", "repair_status", "insurance_claim", "borrower_engagement"] as const;
/** Rule 13.4 D1-3-01: disaster impact → hold; the request goes within 5 days with all five elements; approval → refer. */
export function disasterHold(i: { fema_ia: boolean; inspection_damage: boolean; review_completed_on: PlainDate; request: Record<string, unknown> | null; fnma_approval_id?: string | null }): { outcome: "hold_disaster_approval" | "refer"; request_due: PlainDate; elements_present: string[]; elements_missing: string[]; gate: "closed" | "open" } {
  const impacted = i.fema_ia && i.inspection_damage;
  const present = DISASTER_REQUEST_ELEMENTS.filter((e) => i.request && i.request[e] !== undefined && i.request[e] !== null && i.request[e] !== "");
  const missing = DISASTER_REQUEST_ELEMENTS.filter((e) => !present.includes(e));
  const approved = Boolean(i.fnma_approval_id);
  return { outcome: impacted && !approved ? "hold_disaster_approval" : "refer", request_due: addDays(i.review_completed_on, 5), elements_present: [...present], elements_missing: [...missing], gate: impacted && !approved ? "closed" : "open" };
}

/** Rule 13.4: active duty holds the review; the referral command is refused whatever else passes. */
export function scraHold(i: { active_duty: boolean; items_all_pass: boolean; gates: ReferralGates }): { outcome: "hold_scra" | "refer"; referral: { ok: boolean; blocked_by: string[] } } {
  const outcome = i.active_duty ? "hold_scra" : "refer";
  return { outcome, referral: referralEligible(outcome, { ...i.gates, scra: i.active_duty }) };
}

/** Rule 13.4/13.7 F-1-08: Massachusetts needs the lead-paint citation search before the review passes. */
export function maLeadPaintItem(i: { state: string; citation_search_document_id?: string | null }): { required: boolean; passed: boolean; refusal: string | null } {
  const req = i.state === "MA"; const ok = !req || Boolean(i.citation_search_document_id);
  return { required: req, passed: ok, refusal: ok ? null : "prereferral review refused: MA lead-paint citation search not evidenced (F-1-08; FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE)" };
}

/** Rule 13.4 E-3.2-02: abandonment (two vacant inspections, utilities off) permits the expedited outcome at breach-letter expiry on a non-PR; a principal residence still waits for day 121. */
export function expeditedReview(i: { vacant_inspections: number; utilities_off: boolean; principal_residence: boolean; breach_letter_expired: boolean; day: number }): { expedite_condition: boolean; outcome: "refer_expedited" | "hold_lossmit" | "refer"; regx_blocks_until_day: number | null } {
  const cond = i.vacant_inspections >= 2 && i.utilities_off;
  if (!cond) return { expedite_condition: false, outcome: i.day >= 121 ? "refer" : "hold_lossmit", regx_blocks_until_day: i.principal_residence ? 121 : null };
  if (i.principal_residence) return { expedite_condition: true, outcome: i.day >= 121 ? "refer_expedited" : "hold_lossmit", regx_blocks_until_day: 121 };
  return { expedite_condition: true, outcome: i.breach_letter_expired ? "refer_expedited" : "hold_lossmit", regx_blocks_until_day: null };
}

/** Rule 13.4: a model-evaluated item below 0.85 opens a human verification task; the review cannot complete until resolved. */
export function modelItemGate(i: { item: string; confidence: number; human_resolved: boolean }): { verification_task: Escalation | null; item_status: "pass" | "pending_human"; review_can_complete: boolean } {
  if (i.confidence >= 0.85 || i.human_resolved) return { verification_task: null, item_status: "pass", review_can_complete: true };
  return { verification_task: { kind: "human_agent", reason: `${i.item} evaluated at confidence ${i.confidence} (< 0.85) — verify` }, item_status: "pending_human", review_can_complete: false };
}

/** Rule 13.4: a pending successor-in-interest request fails SII_STATUS and holds the review. */
export function siiStatusItem(i: { pending_sii_request: boolean }): { item: "SII_STATUS"; passed: boolean; outcome: "hold_sii" | "pass" } { return { item: "SII_STATUS", passed: !i.pending_sii_request, outcome: i.pending_sii_request ? "hold_sii" : "pass" }; }

/** Rule 13.4: a bankruptcy scrub hit → hold and a 14.x case. */
export function bankruptcyScrubItem(i: { pacer_hit: boolean; case_number?: string | null }): { outcome: "hold_bankruptcy" | "pass"; open_bk_case: { section: "14.x"; case_number: string | null } | null } {
  return i.pacer_hit ? { outcome: "hold_bankruptcy", open_bk_case: { section: "14.x", case_number: i.case_number ?? null } } : { outcome: "pass", open_bk_case: null };
}

// ============================================================ 13.5 timeframes
/** Rule 13.5 LL-2025-01: the exhibit version in force on the sale date governs. */
export function exhibitVersionFor(versions: readonly { version: string; effective_on: PlainDate; days: number }[], saleOn: PlainDate): { version: string; days: number } {
  const rows = versions.filter((v) => v.effective_on <= saleOn).sort((a, b) => (a.effective_on < b.effective_on ? 1 : -1));
  if (!rows.length) throw new RangeError(`no allowable-timeframe exhibit effective on ${saleOn}`);
  return { version: rows[0]!.version, days: rows[0]!.days };
}

/** Rule 13.5 E-3.2-15: at 70% of (allowable + credits) → at_risk event and a firm status demand. */
export function timeframeWarning(i: { lpi_due: PlainDate; today: PlainDate; allowable: number; credited: number }): { elapsed: number; threshold: number; at_risk: boolean; event: "foreclosure.timeframe.at_risk" | null; instruction: Instruction | null } {
  const elapsed = daysBetween(i.lpi_due, i.today); const risk = atRisk(elapsed, i.allowable, i.credited);
  return { elapsed, threshold: Math.ceil(0.7 * (i.allowable + i.credited)), at_risk: risk, event: risk ? "foreclosure.timeframe.at_risk" : null, instruction: risk ? { kind: "STATUS_DEMAND", to: "firm", due: addBusinessDays(i.today, 2, servicer), sent: true } : null };
}

/** Rule 13.5 A1-4.2-02: a rescinded sale for a missed DMDC check books $1,000 + costs with root cause servicer:scra. */
export function rescissionExposure(i: { cause: "missed_dmdc_check" | "dual_tracking" | "bankruptcy_stay" | "firm_error"; third_party_costs_cents: Cents }): { exposure_cents: Cents; root_cause: string; servicer_error: boolean } {
  const rc: Record<string, string> = { missed_dmdc_check: "servicer:scra", dual_tracking: "servicer:dual_tracking", bankruptcy_stay: "servicer:bankruptcy", firm_error: "firm" };
  const servicerErr = i.cause !== "firm_error";
  return { exposure_cents: servicerErr ? RESCISSION_EXPOSURE_CENTS + i.third_party_costs_cents : 0n, root_cause: rc[i.cause]!, servicer_error: servicerErr };
}

/** Rule 13.5: a second contested period earns no additional credit (first-occurrence scope) and needs a "reasonable explanation" note — the same scoped engine `exposure()` and `fc.timeframe.get` use. */
export function contestedCredits(delays: readonly Delay[], ctx: { lpi_due?: PlainDate | null } = {}): { credited: number; notes: string[] } {
  const c = creditDelays(delays, ctx);
  return { credited: c.credited_days, notes: c.notes };
}

/** Rule 13.5: a compensatory-fee bill starts the 30-day rebuttal clock, drafts the package and escalates to the officer. */
export function billReceived(i: { received_on: PlainDate; bill_cents: Cents; exposure_cents: Cents }): { timer: "SM_COMP_FEE_BILL_REBUTTAL_30"; due: PlainDate; package: { drafted: true; variance_cents: Cents }; escalation: Escalation } {
  return { timer: "SM_COMP_FEE_BILL_REBUTTAL_30", due: addDays(i.received_on, 30), package: { drafted: true, variance_cents: i.bill_cents - i.exposure_cents }, escalation: { kind: "officer", severity: "sev2", reason: `compensatory fee bill ${i.bill_cents} cents received ${i.received_on}: officer-signed rebuttal or acceptance by ${addDays(i.received_on, 30)}` } };
}

/** Rule 13.5: a non-preferred method without Form 20 approval refuses first-notice authorization. */
export function methodDeviation(i: { preferred_method: boolean; form20_approval_id?: string | null }): { allowed: boolean; gate: "FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE"; refusal: string | null } {
  const ok = i.preferred_method || Boolean(i.form20_approval_id);
  return { allowed: ok, gate: "FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE", refusal: ok ? null : "first_notice.authorize refused: non-preferred method needs Regional Counsel approval via Form 20 (FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE)" };
}

// ============================================================ 13.6 firms
/** Rule 13.6 A4-2.2-04: a suspension cannot be implemented before 5 BD after Fannie Mae is notified with the plan. */
export function suspensionGate(i: { proposed_on: PlainDate; fnma_notified_on: PlainDate | null; plan_attached: boolean; implement_on: PlainDate }): { earliest: PlainDate | null; allowed: boolean; refusal: string | null } {
  if (!i.fnma_notified_on || !i.plan_attached) return { earliest: null, allowed: false, refusal: "suspension blocked: Fannie Mae must be notified with the transition plan first (A4-2.2-04)" };
  const earliest = suspensionEffective(i.fnma_notified_on);
  return { earliest, allowed: i.implement_on >= earliest, refusal: i.implement_on >= earliest ? null : `suspension blocked until ${earliest} (5 BD after Fannie Mae notice; A4-2.2-04)` };
}

/** Rule 13.6: an acknowledged POSTPONE_SALE with no DRA postponement event after 2 BD → exception, firm call task, 13.5 credit "DRA unverified". */
export function draPostponementCheck(i: { acknowledged_on: PlainDate; dra_event_on: PlainDate | null; today: PlainDate }): { expected_by: PlainDate; exception: boolean; firm_call_task: boolean; credit_status: "verified" | "DRA unverified" } {
  const by = addBusinessDays(i.acknowledged_on, 2, servicer); const late = i.dra_event_on === null ? i.today > by : draEventLate(by, i.dra_event_on, i.today);
  return { expected_by: by, exception: late, firm_call_task: late, credit_status: late ? "DRA unverified" : "verified" };
}

/** Rule 13.6 E-5-04/E-5-05: the schedule's 100% step (sale held / documents recorded) is earned only once any post-sale confirmation or ratification is completed; before that the prior 95% step holds. */
export function feeApproval(i: { method: FirmMethod; milestone: string; allowable_cents: Cents; confirmation?: Confirmation }): { pct: number; approved_cents: Cents; note: string | null } {
  const pct = earnedPct(i.method, i.milestone, i.confirmation ?? "pending");
  const capped = i.milestone !== "confirmation" && pct === 95 && (i.confirmation ?? "pending") === "pending" && earnedPct(i.method, i.milestone, "completed") === 100;
  return { pct, approved_cents: (i.allowable_cents * BigInt(pct) + 50n) / 100n, note: capped ? "the final 5% cannot be considered to be earned until confirmation (E-5-04)" : null };
}

/** Rule 13.6 rule 7: two consecutive months in the bottom scorecard band → risk-triggered review, officer informed. */
export function scorecardReview(history: readonly { month: string; band: "top" | "middle" | "bottom" }[]): { trigger: boolean; review: { kind: "risk_triggered"; scheduled: boolean } | null; escalation: Escalation | null } {
  const sorted = [...history].sort((a, b) => (a.month < b.month ? -1 : 1)); const last = sorted.slice(-2);
  const t = last.length === 2 && last.every((h) => h.band === "bottom");
  return { trigger: t, review: t ? { kind: "risk_triggered", scheduled: true } : null, escalation: t ? { kind: "officer", severity: "sev3", reason: `firm scorecard in the bottom band for ${last.map((h) => h.month).join(" and ")}` } : null };
}

// ============================================================ 13.7 litigation
/** Rule 13.7 E-1.3-01: an appeal of an adverse judgment cannot be filed before Fannie Mae's written approval is stored. */
export function appealFilingGate(i: { fnma_written_approval_document_id?: string | null }): { allowed: boolean; refusal: string | null; gate: "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE" } {
  const ok = Boolean(i.fnma_written_approval_document_id);
  return { allowed: ok, refusal: ok ? null : "attorney cannot file the appeal: Fannie Mae's written approval is not stored (E-1.3-01)", gate: "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE" };
}

/** Rule 13.7 E-1.3-01: a substantive motion's draft goes to Fannie Mae ≥5 BD before the deadline; the gate refuses filing otherwise. */
export function pleadingReviewGate(i: { filing_due: PlainDate; draft_given_on: PlainDate | null }): { draft_due: PlainDate; allowed: boolean; refusal: string | null } {
  const due = motionDraftDue(i.filing_due); const ok = Boolean(i.draft_given_on) && i.draft_given_on! <= due;
  return { draft_due: due, allowed: ok, refusal: ok ? null : `filing refused by FNMA_E1301_PLEADING_REVIEW_GATE: the draft was due to Fannie Mae by ${due} (≥5 BD before ${i.filing_due})` };
}

/** Rule 13.7: a quatro outage → the Form 20 package goes to Legal by email with an outage note; the portal filing completes on restoration; both timestamps kept. */
export function quatroOutage(i: { notice_received_on: PlainDate; outage: boolean; restored_on?: PlainDate | null }): { form20_due: PlainDate; email_sent: { on: PlainDate; outage_note: true } | null; portal_filed_on: PlainDate | null; timestamps: { email?: PlainDate; portal?: PlainDate } } {
  const due = addBusinessDays(i.notice_received_on, 2, servicer);
  if (!i.outage) return { form20_due: due, email_sent: null, portal_filed_on: i.notice_received_on, timestamps: { portal: i.notice_received_on } };
  return { form20_due: due, email_sent: { on: i.notice_received_on, outage_note: true }, portal_filed_on: i.restored_on ?? null, timestamps: { email: i.notice_received_on, ...(i.restored_on ? { portal: i.restored_on } : {}) } };
}

/** Rule 13.7 E-1.3-01: a workout offer on a litigated loan waits for counsel's acknowledgment. */
export function workoutCounselGate(i: { litigated: boolean; counsel_notified_on: PlainDate | null; counsel_acknowledged: boolean }): { allowed: boolean; refusal: string | null; gate: "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE" } {
  const ok = !i.litigated || (Boolean(i.counsel_notified_on) && i.counsel_acknowledged);
  return { allowed: ok, refusal: ok ? null : "offer held: counsel must be notified and acknowledge before a deferral/modification offer leaves on a litigated loan (E-1.3-01)", gate: "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE" };
}

// ============================================================ 13.8 SCRA foreclosure protection
/** Rule 13.8: a boarded loan gets a DMDC verification within 5 BD; results carry certificate ids. */
export function boardingDmdc(i: { boarded_on: PlainDate; results: readonly { borrower_id: string; status: "Y" | "N" | "Z"; certificate_id: string | null; as_of: PlainDate }[] }): { due: PlainDate; verified: boolean; parsed: { borrower_id: string; status: string; certificate_id: string }[]; missing_certificate: string[] } {
  const parsed = i.results.filter((r) => r.certificate_id).map((r) => ({ borrower_id: r.borrower_id, status: r.status, certificate_id: r.certificate_id! }));
  return { due: addBusinessDays(i.boarded_on, 5, servicer), verified: i.results.length > 0 && i.results.every((r) => r.as_of <= addBusinessDays(i.boarded_on, 5, servicer)), parsed, missing_certificate: i.results.filter((r) => !r.certificate_id).map((r) => r.borrower_id) };
}

/** Rule 13.8 D2-3.4-01: DMDC Y on a pre-service obligation opens the SCRA case: gate closed, status 32, late charges waived, SCRA_STAY within 1 BD, quarterly contact. */
export function openScraCase(i: { dmdc_status: "Y" | "N" | "Z"; origination_on: PlainDate; service_begin_on: PlainDate; verified_on: PlainDate; late_charges_since_service_cents: Cents }): { opened: boolean; event: "scra.case.opened" | null; gate: "closed" | "open"; status_code: "32" | null; late_charges_waived_cents: Cents; firm_instruction: Instruction | null; quarterly_timer: "FNMA_D23401_SM_CONTACT_90" | null; timers: readonly string[]; next_contact_on: PlainDate | null; refusal: string | null } {
  if (i.dmdc_status !== "Y") return { opened: false, event: null, gate: "open", status_code: null, late_charges_waived_cents: 0n, firm_instruction: null, quarterly_timer: null, timers: [], next_contact_on: null, refusal: `DMDC ${i.dmdc_status}: no case` };
  if (!preServiceObligation(i.origination_on, i.service_begin_on)) return { opened: false, event: null, gate: "open", status_code: null, late_charges_waived_cents: 0n, firm_instruction: null, quarterly_timer: null, timers: [], next_contact_on: null, refusal: "obligation originated during service — §3953 does not apply (attorney review for other protections)" };
  // D2-3.4-01: contact the servicemember "at a minimum, every three months" (FNMA_D23401_SM_CONTACT_90); the DMDC re-verification cadence (SM_DMDC_PERIODIC_ACTIVE_FC_90) is a separate timer that runs while a foreclosure case is open.
  return { opened: true, event: "scra.case.opened", gate: "closed", status_code: "32", late_charges_waived_cents: i.late_charges_since_service_cents, firm_instruction: { kind: "SCRA_STAY", to: "firm", due: addBusinessDays(i.verified_on, 1, servicer), sent: true }, quarterly_timer: "FNMA_D23401_SM_CONTACT_90", timers: ["FNMA_D23401_SM_CONTACT_90", "SM_DMDC_PERIODIC_ACTIVE_FC_90"], next_contact_on: addDays(i.verified_on, 90), refusal: null };
}

/** Rule 13.8 §3931: a default-judgment motion needs a signing-officer affidavit on certificates ≤30 days; the motion instruction releases only on filing evidence. */
export function affidavitGate(i: { judicial: boolean; certificate_on: PlainDate; today: PlainDate; executed_by_role: string | null; filing_evidence_document_id?: string | null }): { affidavit_required: boolean; affidavit_valid: boolean; motion_instruction_released: boolean; refusal: string | null } {
  if (!i.judicial) return { affidavit_required: false, affidavit_valid: true, motion_instruction_released: true, refusal: null };
  const fresh = dmdcFresh(i.certificate_on, i.today); const signed = i.executed_by_role === "signing_officer"; const valid = fresh && signed;
  return { affidavit_required: true, affidavit_valid: valid, motion_instruction_released: valid && Boolean(i.filing_evidence_document_id), refusal: !fresh ? "affidavit refused: DMDC certificates older than 30 days (SCRA_3931_AFFIDAVIT_GATE)" : !signed ? "affidavit refused: only a signing_officer executes the §3931 affidavit" : !i.filing_evidence_document_id ? "motion instruction held until the affidavit filing evidence is stored" : null };
}

/** Rule 13.8: a DMDC outage in the sale week → postponement, never proceeding on stale results. */
export function dmdcOutageBeforeSale(i: { sale_on: PlainDate; today: PlainDate; dmdc_available: boolean; last_certificate_on: PlainDate | null }): { instruction: "POSTPONE_SALE" | "CERTIFY_SALE"; reason: string } {
  const fresh = i.last_certificate_on !== null && dmdcFresh(i.last_certificate_on, i.today) && daysBetween(i.last_certificate_on, i.sale_on) <= 7;
  if (!i.dmdc_available && !fresh) return { instruction: "POSTPONE_SALE", reason: `DMDC unavailable within 7 days of the sale ${i.sale_on} — postpone rather than proceed (13.8)` };
  return { instruction: "CERTIFY_SALE", reason: "sale − 7 verification on file" };
}

/** Rule 13.8: a Z result → retry with alternate name/DOB; unresolved → attorney decides on an "unable to determine" affidavit; no (A) affidavit. */
export function zResult(i: { attempts: readonly { name_variant: string; dob_variant: string; status: "Y" | "N" | "Z" }[] }): { resolved: "Y" | "N" | null; retry_required: boolean; escalation: Escalation | null; affidavit_kind: "A_not_in_service" | "unable_to_determine" | "in_service" | null } {
  const last = i.attempts[i.attempts.length - 1];
  const resolved = i.attempts.find((a) => a.status !== "Z");
  if (resolved) return { resolved: resolved.status as "Y" | "N", retry_required: false, escalation: null, affidavit_kind: resolved.status === "Y" ? "in_service" : "A_not_in_service" };
  if (i.attempts.length < 2) return { resolved: null, retry_required: true, escalation: null, affidavit_kind: null };
  void last;
  return { resolved: null, retry_required: false, escalation: { kind: "attorney", reason: "DMDC Z after alternate name/DOB retry — decide on an 'unable to determine' affidavit (no (A) affidavit)" }, affidavit_kind: "unable_to_determine" };
}

/** Rule 13.8: a sale held in violation → same-day attorney and officer escalation; 13.5 rescission exposure booked. */
export function saleInViolation(i: { sale_on: PlainDate; discovered_on: PlainDate; third_party_costs_cents: Cents }): { escalations: Escalation[]; due: PlainDate; exposure_cents: Cents; root_cause: "servicer:scra" } {
  return { escalations: [{ kind: "attorney", severity: "sev1", reason: `sale ${i.sale_on} held during SCRA protection — rescission` }, { kind: "officer", severity: "sev1", reason: "SCRA violation — rescission and A1-4.2-02 exposure" }], due: i.discovered_on, exposure_cents: RESCISSION_EXPOSURE_CENTS + i.third_party_costs_cents, root_cause: "servicer:scra" };
}

/** Rule 13.8 D2-3.4-01: the agent never solicits or accepts an SCRA waiver; a borrower's request routes to the attorney. */
export function waiverRequest(i: { borrower_asks_to_waive: boolean }): { solicited: false; accepted: false; escalation: Escalation | null } {
  return { solicited: false, accepted: false, escalation: i.borrower_asks_to_waive ? { kind: "attorney", reason: "borrower asked to waive SCRA protection so the sale can proceed — Fannie Mae forbids seeking consent (D2-3.4-01); attorney handles any §3918 agreement" } : null };
}

/** Rule 13.8 rule 3: the tail is one calendar year inclusive; Feb 29 clamps to Feb 28; the gate opens the following day. */
export function protectionTail(serviceEndOn: PlainDate): { protection_ends_on: PlainDate; gate_opens_on: PlainDate } {
  const ends = protectionEndsOn(serviceEndOn); if (!ends) throw new RangeError("protection end date could not be computed");
  return { protection_ends_on: ends, gate_opens_on: addDays(ends, 1) };
}

// ============================================================ 13.9 SCRA interest cap
/** Rule 13.9 F-1-19: Form 1022 by BD9 of the following month (portfolio) or upload by CD15 (MBS), both tracked with acknowledgments. */
export function form1022Schedule(i: { reduction_month: PlainDate; mbs: boolean; acked_on?: PlainDate | null }): { channel: "email_bd9" | "upload_cd15"; due: PlainDate; tracked: true; acknowledged: boolean } {
  const { y, m } = parts(i.reduction_month); const next = addMonths(ymd(y, m, 1), 1); const ch = form1022Due(i.reduction_month, i.mbs).channel;
  return { channel: ch, due: ch === "email_bd9" ? addBusinessDays(addDays(next, -1), 9, fannieEt) : ymd(parts(next).y, parts(next).m, 15), tracked: true, acknowledged: Boolean(i.acked_on) };
}

/** Rule 13.9: late charges assessed during the cap are waived/refunded with the recalculation; new ones are blocked by the 2.7 gate. */
export function lateChargeWaiver(i: { charges: readonly { assessed_on: PlainDate; cents: Cents; paid: boolean }[]; cap_effective_due: PlainDate; cap_ends_on: PlainDate }): { waived_cents: Cents; refunded_cents: Cents; new_charges_blocked: true; gate: "SCRA_3937_FEES_IN_CAP_GATE" } {
  let waived = 0n, refunded = 0n;
  for (const c of i.charges) if (c.assessed_on >= i.cap_effective_due && c.assessed_on <= i.cap_ends_on) { if (c.paid) refunded += c.cents; else waived += c.cents; }
  return { waived_cents: waived, refunded_cents: refunded, new_charges_blocked: true, gate: "SCRA_3937_FEES_IN_CAP_GATE" };
}

export interface Posting { readonly account: string; readonly debit: Cents; readonly credit: Cents; readonly rule_ref: string; }
/** Rule 13.9: overpayment election — refund posts Dr scra_overpayment_payable / Cr cash; curtailment posts against principal; apply-to-installment needs the balance. */
export function overpaymentElection(i: { overpayment_cents: Cents; next_payment_cents: Cents; election: "refund" | "curtailment" | "apply_to_installment" | null; recorded_on?: PlainDate | null }): { postings: Posting[]; balanced: boolean; election_recorded: boolean; statement_line: string | null; shortfall_cents: Cents; sufficient_alone: boolean } {
  const sufficient = i.overpayment_cents >= i.next_payment_cents; const short = sufficient ? 0n : i.next_payment_cents - i.overpayment_cents;
  const base = { election_recorded: Boolean(i.election && i.recorded_on), shortfall_cents: short, sufficient_alone: sufficient };
  if (i.election === "refund") { const p: Posting[] = [{ account: "scra_overpayment_payable", debit: i.overpayment_cents, credit: 0n, rule_ref: "13.9.overpayment.refund" }, { account: "cash", debit: 0n, credit: i.overpayment_cents, rule_ref: "13.9.overpayment.refund" }]; return { postings: p, balanced: true, statement_line: "SCRA interest refund", ...base }; }
  if (i.election === "curtailment") { const p: Posting[] = [{ account: "scra_overpayment_payable", debit: i.overpayment_cents, credit: 0n, rule_ref: "13.9.overpayment.curtailment" }, { account: "principal", debit: 0n, credit: i.overpayment_cents, rule_ref: "13.9.overpayment.curtailment" }]; return { postings: p, balanced: true, statement_line: "SCRA overpayment applied to principal", ...base }; }
  if (i.election === "apply_to_installment") { const p: Posting[] = [{ account: "scra_overpayment_payable", debit: i.overpayment_cents, credit: 0n, rule_ref: "13.9.overpayment.installment" }, { account: "installments_due", debit: 0n, credit: i.overpayment_cents, rule_ref: "13.9.overpayment.installment" }]; return { postings: p, balanced: true, statement_line: sufficient ? "SCRA overpayment applied to installment" : `SCRA overpayment applied to installment (borrower adds ${short} cents)`, ...base }; }
  return { postings: [], balanced: true, statement_line: null, ...base };
}

/** Rule 13.9 decision 13.9-3: no election within 30 days → the default election (principal curtailment) applies and the borrower is told. */
export function defaultElection(i: { letter_sent_on: PlainDate; election?: "refund" | "curtailment" | "apply_to_installment" | null; today: PlainDate }): { due: PlainDate; applied: "refund" | "curtailment" | "apply_to_installment" | null; defaulted: boolean; borrower_notice: "NTC_SCRA_3937_OVERPAYMENT_ELECTION" | null } {
  const due = addDays(i.letter_sent_on, 30);
  if (i.election) return { due, applied: i.election, defaulted: false, borrower_notice: null };
  if (i.today <= due) return { due, applied: null, defaulted: false, borrower_notice: null };
  return { due, applied: "curtailment", defaulted: true, borrower_notice: "NTC_SCRA_3937_OVERPAYMENT_ELECTION" };
}

/** Rule 13.9 guardrail: a written assertion of service with DMDC N and no orders is never denied without attorney review; orders are requested. */
export function assertedServiceWithoutEvidence(i: { written_assertion: boolean; dmdc_status: "Y" | "N" | "Z"; orders_document_id?: string | null }): { denial_allowed: boolean; escalation: Escalation | null; request_orders: boolean } {
  if (i.dmdc_status === "Y" || i.orders_document_id) return { denial_allowed: false, escalation: null, request_orders: false };
  return { denial_allowed: false, escalation: i.written_assertion ? { kind: "attorney", reason: "borrower asserts service in writing; DMDC N and no orders — attorney review before any denial (13.9 guardrail)" } : null, request_orders: true };
}

/** Rule 13.9 rule 1: a request after the 180-day window is honored on verified service (policy) for the service period plus the tail; Form 1022 goes out. */
export function lateRequest(i: { release_on: PlainDate; request_on: PlainDate; service_verified: boolean; service_begin_on: PlainDate; mbs: boolean }): { statutory: boolean; honored: boolean; cap_from_due: PlainDate; cap_ends_on: PlainDate; retroactive: boolean; form_1022: { channel: "email_bd9" | "upload_cd15" } | null } {
  const w = requestWithinStatute(i.release_on, i.request_on); const honored = w.statutory || (w.honored && i.service_verified);
  return { statutory: w.statutory, honored, cap_from_due: capEffectivePaymentDue(i.service_begin_on), cap_ends_on: addYears(i.release_on, 1), retroactive: honored, form_1022: honored ? { channel: form1022Due(i.request_on, i.mbs).channel } : null };
}

// ============================================================ 13.1 gate sweep and the non-PR deadline ladder
/** Rule 13.1 T1: the daily sweep projects the gate and emits `foreclosure.gate.opened` once — on the day it first opens, never again while it stays open. */
export function gateSweep(i: { today: PlainDate; earliest_unpaid_due: PlainDate | null; principal_residence: boolean | null; previous_state: GateState | null }): { state: GateState; opens_on: PlainDate | null; days: number; events: { type: "foreclosure.gate.opened" | "foreclosure.gate.closed"; code: "REGX_1024_41F1_120_DAY_GATE"; on: PlainDate }[] } {
  const g = gate120(i.today, i.earliest_unpaid_due, i.principal_residence, null);
  const events: { type: "foreclosure.gate.opened" | "foreclosure.gate.closed"; code: "REGX_1024_41F1_120_DAY_GATE"; on: PlainDate }[] = [];
  if (g.state === "open" && i.previous_state !== "open") events.push({ type: "foreclosure.gate.opened", code: "REGX_1024_41F1_120_DAY_GATE", on: i.today });
  if (g.state === "closed" && i.previous_state === "open") events.push({ type: "foreclosure.gate.closed", code: "REGX_1024_41F1_120_DAY_GATE", on: i.today });
  return { state: g.state, opens_on: g.opens_on, days: g.days, events };
}

export type LadderEvent = { readonly kind: "complete_brp" | "retention_offer" | "accepted_with_first_payment_due" | "first_payment_received" | "inquiry" | "incomplete_brp" | "determination_no_offer" | "offer_window_expired" | "plan_breached" | "referral_sent"; readonly on: PlainDate; readonly first_payment_due?: PlainDate; readonly event_id?: string };
/** One `foreclosure_deadline_suspensions` row: the E-3.2-04 rung, the arming event and the resume condition. */
export interface DeadlineSuspension { readonly timer: "FNMA_E1202_NONPR_REFER_BY_120"; readonly rung: Rung; readonly armed_by_event_id: string; readonly from: PlainDate; readonly resume_condition: string; readonly resumes_on: PlainDate | "on_breach"; readonly ended_on: PlainDate | null; readonly end_reason: string | null }
/** Rule 13.1 rule 5 / E-1.2-02 BRP exception: the non-PR day-120 deadline is suspended (never breached) while an E-3.2-04 rung is open; an inquiry or an incomplete BRP never suspends; an offer window that expires unaccepted ends the suspension that day (E-3.2-01); a breach fires sev 2 to foreclosure-ops with the 13.5 exposure flag. */
export function nonPrDeadlineLadder(i: { earliest_unpaid_due: PlainDate; events: readonly LadderEvent[]; today: PlainDate }): { timer: "FNMA_E1202_NONPR_REFER_BY_120"; deadline: PlainDate; day: number; suspensions: DeadlineSuspension[]; suspended: boolean; referred: boolean; breached: boolean; breach: { severity: "sev2"; to: "foreclosure-ops"; comp_fee_exposure_flag: true } | null; status: "running" | "suspended" | "referred" | "breached" } {
  const deadline = nonPrDeadline(i.earliest_unpaid_due); const rows: DeadlineSuspension[] = []; let referred = false;
  const open = (): DeadlineSuspension | null => { const last = rows[rows.length - 1]; return last && last.ended_on === null ? last : null; };
  const close = (idx: number, on: PlainDate, why: string): void => { const r = rows[idx]!; rows[idx] = { ...r, ended_on: on, end_reason: why }; };
  const sorted = [...i.events].filter((e) => e.on <= i.today).sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  for (const e of sorted) {
    const cur = open(); const idx = rows.length - 1;
    if (cur && cur.resumes_on !== "on_breach" && cur.resumes_on < e.on) close(idx, cur.resumes_on, "rung window expired without the next rung (E-3.2-01: no delay once the response time frame has expired)");
    if (e.kind === "referral_sent") { referred = true; const o = open(); if (o) close(rows.length - 1, e.on, "referred"); continue; }
    if (e.kind === "determination_no_offer" || e.kind === "offer_window_expired" || e.kind === "plan_breached") { const o = open(); if (o) close(rows.length - 1, e.on, e.kind === "plan_breached" ? "lossmit.plan.breached — referral resumes" : e.kind === "offer_window_expired" ? "offer window expired unaccepted (E-3.2-01)" : "determination sent with no offer — referral resumes"); continue; }
    const rung = ladderSuspension(e.kind === "accepted_with_first_payment_due" ? { kind: e.kind, on: e.on, first_payment_due: e.first_payment_due! } : { kind: e.kind, on: e.on });
    if (!rung) continue;   // inquiries and incomplete BRPs never postpone (E-3.2-04)
    const o = open(); if (o) close(rows.length - 1, e.on, `next rung ${rung.rung} armed`);
    const cond = rung.rung === "a_eval_30" ? "lossmit.determination.sent (≤30-day evaluation)" : rung.rung === "b_offer_14" ? "acceptance or expiry of the 14-day response window" : rung.rung === "c_accepted_month_end" ? "first payment received by the last day of the month it is due" : "lossmit.plan.breached";
    rows.push({ timer: "FNMA_E1202_NONPR_REFER_BY_120", rung: rung.rung, armed_by_event_id: e.event_id ?? `${e.kind}@${e.on}`, from: e.on, resume_condition: cond, resumes_on: rung.resume_on, ended_on: null, end_reason: null });
  }
  const cur = open();
  if (cur && cur.resumes_on !== "on_breach" && cur.resumes_on < i.today) close(rows.length - 1, cur.resumes_on, "rung window expired without the next rung (E-3.2-01)");
  const suspended = open() !== null;
  const breached = !referred && !suspended && i.today >= deadline;
  return { timer: "FNMA_E1202_NONPR_REFER_BY_120", deadline, day: regxDays(i.today, i.earliest_unpaid_due), suspensions: rows, suspended, referred, breached, breach: breached ? { severity: "sev2", to: "foreclosure-ops", comp_fee_exposure_flag: true } : null, status: referred ? "referred" : suspended ? "suspended" : breached ? "breached" : "running" };
}

// ============================================================ 13.2 hold opening, performing hold, protection snapshot
/** Rule 13.2 T1/T3: a complete application after the first filing opens `regx_g_dual_track` when received >37 days before the sale (HOLD_DISPOSITIVE within 1 BD, REGX_1024_41G_INSTRUCT_COUNSEL_1BD); 15–37 days ⇒ no Reg X hold, Fannie Mae expedited review due before the certification window opens and certification withheld until the determination is sent. */
export function dualTrackHoldOpen(i: { first_notice_filed_on: PlainDate; sale_on: PlainDate | null; received_on: PlainDate; acknowledged_on?: PlainDate | null; determination_sent_on?: PlainDate | null }): { tier: ReturnType<typeof tierAtReceipt>; hold: { kind: "regx_g_dual_track"; scope: readonly string[]; opened_at: PlainDate; rule_citation: "12 CFR 1024.41(g)" } | null; fnma_hold: { kind: "fnma_e3401_evaluation"; scope: readonly string[]; opened_at: PlainDate; rule_citation: "FNMA E-3.4-01" } | null; instruction: Instruction | null; timer: "REGX_1024_41G_INSTRUCT_COUNSEL_1BD" | null; acknowledged: boolean; expedited_review_due_before: PlainDate | null; certification_withheld: boolean; refusal: string | null } {
  if (i.received_on < i.first_notice_filed_on) return { tier: tierAtReceipt(i.received_on, i.sale_on), hold: null, fnma_hold: null, instruction: null, timer: null, acknowledged: false, expedited_review_due_before: null, certification_withheld: false, refusal: "received before the first notice or filing — §1024.41(f)(2) (13.1), not (g)" };
  const tier = tierAtReceipt(i.received_on, i.sale_on);
  if (tier.regx !== "none") {
    const due = addBusinessDays(i.received_on, 1, servicer);
    return { tier, hold: { kind: "regx_g_dual_track", scope: BLOCKED_BY_HOLD.hold_evaluation, opened_at: i.received_on, rule_citation: "12 CFR 1024.41(g)" }, fnma_hold: null, instruction: { kind: "HOLD_DISPOSITIVE", to: "firm", due, sent: true }, timer: "REGX_1024_41G_INSTRUCT_COUNSEL_1BD", acknowledged: Boolean(i.acknowledged_on) && i.acknowledged_on! <= due, expedited_review_due_before: null, certification_withheld: true, refusal: null };
  }
  if (tier.fnma === "fnma_15_to_37") {
    const w = certificationWindow(i.sale_on!);
    return { tier, hold: null, fnma_hold: { kind: "fnma_e3401_evaluation", scope: BLOCKED_BY_HOLD.fnma_e3401_evaluation, opened_at: i.received_on, rule_citation: "FNMA E-3.4-01" }, instruction: null, timer: null, acknowledged: false, expedited_review_due_before: w.opens, certification_withheld: !i.determination_sent_on || i.determination_sent_on >= w.opens, refusal: null };
  }
  return { tier, hold: null, fnma_hold: null, instruction: null, timer: null, acknowledged: false, expedited_review_due_before: null, certification_withheld: false, refusal: null };
}

/** Rule 13.2 T5: an accepted offer with the first trial payment received holds `hold_performing` (first notice, judgment motion, sale scheduling and conduct) until `lossmit.trial.failed`; a failure on the last day of the month due reopens sale scheduling the next day. */
export function performingHold(i: { accepted_on: PlainDate; first_payment_received_on: PlainDate; trial_failed_on?: PlainDate | null }): { hold: "hold_performing"; kind: "fnma_trial_performing"; blocks: readonly string[]; until: "lossmit.trial.failed"; closed_on: PlainDate | null; sale_schedule_reopens_on: PlainDate | null; stepAllowedOn: (step: string, on: PlainDate) => boolean } {
  const closed = i.trial_failed_on ?? null; const reopens = closed ? addDays(closed, 1) : null;
  const blocks = BLOCKED_BY_HOLD.hold_performing;
  return { hold: "hold_performing", kind: "fnma_trial_performing", blocks, until: "lossmit.trial.failed", closed_on: closed, sale_schedule_reopens_on: reopens, stepAllowedOn: (step, on) => !blocks.includes(step) || (reopens !== null && on >= reopens) };
}

/** Rule 13.2 rule 1 / 1024.41(b)(3): the protection snapshot is written once at receipt — no sale scheduled ⇒ `g_full_90` (appeal rights, 14-day acceptance) — and a sale set later does not recompute it. */
export function protectionSnapshot(i: { received_on: PlainDate; sale_at_receipt: PlainDate | null; later_sale_on?: PlainDate | null }): { tier: Tier; appeal: boolean; acceptance_days: 14 | 7 | 0; days_before_sale: number | null; sale_at_receipt: PlainDate | null; recomputed: false; note: string } {
  const t = tierAtReceipt(i.received_on, i.sale_at_receipt);
  return { tier: t.regx, appeal: t.appeal, acceptance_days: t.acceptance_days, days_before_sale: t.days_before_sale, sale_at_receipt: i.sale_at_receipt, recomputed: false, note: i.later_sale_on ? `sale later set ${i.later_sale_on}: protections fixed as of receipt (comment 41(b)(3)-2) — tier stays ${t.regx}` : "written once at receipt (1024.41(b)(3))" };
}

// ============================================================ 13.3 reinstatement and third-party sale settlement
/** Rule 13.3 rule 4 / E-3.2-08: a full tender before the sale is accepted; the firm is notified within 2 BD (target same day; E-3.2-06), the sale cancelled, the original note returned via Form 2009 when it was pulled, and the status code updated. */
export function reinstatementAccepted(i: { tendered_on: PlainDate; sale_on: PlainDate; quote_cents: Cents; tendered_cents: Cents; note_pulled: boolean }): { accepted: boolean; refusal: string | null; event: "loan.reinstated" | null; firm_notify_by: PlainDate | null; firm_notify_target: PlainDate | null; timer: "FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD" | null; instruction: Instruction | null; sale_cancelled: boolean; note_return: "Form 2009" | null; status_code_update: boolean } {
  const ok = i.tendered_on < i.sale_on && i.tendered_cents >= i.quote_cents;
  if (!ok) return { accepted: false, refusal: i.tendered_on >= i.sale_on ? "tender after the sale — payoff/redemption path (16.x)" : `tender ${i.tendered_cents} short of the quote ${i.quote_cents} — partial reinstatement only if it makes the borrower eligible for a workout (12.x)`, event: null, firm_notify_by: null, firm_notify_target: null, timer: null, instruction: null, sale_cancelled: false, note_return: null, status_code_update: false };
  return { accepted: true, refusal: null, event: "loan.reinstated", firm_notify_by: addBusinessDays(i.tendered_on, 2, servicer), firm_notify_target: i.tendered_on, timer: "FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD", instruction: { kind: "CANCEL_SALE", to: "firm", due: i.tendered_on, sent: true }, sale_cancelled: true, note_return: i.note_pulled ? "Form 2009" : null, status_code_update: true };
}

/** The event that closes the TPS proceeds clock on the platform: 15.1's CRS special remittance settlement (`remittance.special.settled{code∈{311, 351}}`) — the 13.3 row's `remittance.special.sent{action_code=71}` names the 5.x removal action code, which is reported in the sale month, not the remittance; `timers.ts` overrides the row to this event so the timer can close. */
export const TPS_PROCEEDS_SETTLED = "`remittance.special.settled{code∈{311, 351}}`";
/** Rule 13.3 rule 6: a third-party sale above indebtedness books the surplus to `tps_surplus_payable`; proceeds are remitted within 5 BD of final payment (fannie_et) under `FNMA_E3502_TPS_PROCEEDS_REMIT_5BD` (armed by 15.1's `tps.proceeds.received{kind=final_payment}`, satisfied by `TPS_PROCEEDS_SETTLED`), Action Code 71 in the sale month, closing statement to SF CPM the same day. The deposit clock `FNMA_E3502_TPS_DEPOSIT_REMIT_5BD` belongs to a sale that fails to finalize (`sale.failed_to_finalize`), never to a completed sale. */
export function thirdPartySaleSettlement(i: { sale_on: PlainDate; winning_bid_cents: Cents; total_indebtedness_cents: Cents; final_payment_on: PlainDate }): { surplus_cents: Cents; shortfall_cents: Cents; surplus_account: "tps_surplus_payable" | null; remit_by: PlainDate; timer: "FNMA_E3502_TPS_PROCEEDS_REMIT_5BD"; satisfied_by: typeof TPS_PROCEEDS_SETTLED; action_code: "71"; action_code_period: string; closing_statement_due: PlainDate; mi_claim: boolean } {
  const d = i.winning_bid_cents - i.total_indebtedness_cents; const surplus = d > 0n ? d : 0n; const short = d < 0n ? -d : 0n;
  return { surplus_cents: surplus, shortfall_cents: short, surplus_account: surplus > 0n ? "tps_surplus_payable" : null, remit_by: addBusinessDays(i.final_payment_on, 5, fannieEt), timer: "FNMA_E3502_TPS_PROCEEDS_REMIT_5BD", satisfied_by: TPS_PROCEEDS_SETTLED, action_code: "71", action_code_period: i.sale_on.slice(0, 7), closing_statement_due: i.final_payment_on, mi_claim: short > 0n };
}

// ============================================================ 13.6 firm selection, retention, escalation, transfers
/** Rule 13.6 rule 1 / F-2-04: due diligence checks the E&O tier minimums for the firm's annual foreclosure volume; a passing file yields the Form 200 package for the partner officer's signature (the certification is the officer's). */
export function firmDueDiligence(i: { annual_foreclosures: number; eo_per_occurrence_cents: Cents; eo_aggregate_cents: Cents; qualifying_attorneys?: number }): { tier: EoTier; passed: boolean; failing: string[]; form200_package: { for_signature_by: "officer"; certifies: "F-2-04 minimum requirements"; status: "form200_pending" } | null } {
  const tier = eoTierFor(i.annual_foreclosures); const failing = eoShortfalls(tier, i.eo_per_occurrence_cents, i.eo_aggregate_cents);
  if (i.qualifying_attorneys !== undefined && i.qualifying_attorneys < 2) failing.push("fewer than two Qualifying Attorneys in the jurisdiction (F-2-04)");
  return { tier, passed: failing.length === 0, failing, form200_package: failing.length === 0 ? { for_signature_by: "officer", certifies: "F-2-04 minimum requirements", status: "form200_pending" } : null };
}

/** Rule 13.6 rule 1 / A4-2.2-01: Form 200 → 15-BD response expectation (fannie_et); "No Objection" + training + LRA ⇒ `retained`; a referral to a non-retained firm is refused (FNMA_A4201_RETAINED_FIRM_GATE). */
export function firmRetention(i: { form200_submitted_on: PlainDate; response: "no_objection" | "objection" | "info_requested" | null; training_completed_on?: PlainDate | null; lra_executed_on?: PlainDate | null; eo_expires_on?: PlainDate | null; today?: PlainDate }): { expectation_due: PlainDate; timer: "FNMA_A4201_FORM200_RESPONSE_15BD"; status: "form200_pending" | "no_objection" | "rejected" | "retained"; referral_allowed: boolean; refusal: string | null } {
  const due = form200Expectation(i.form200_submitted_on);
  const status = i.response === "objection" ? "rejected" : i.response === "no_objection" ? (i.training_completed_on && i.lra_executed_on ? "retained" : "no_objection") : "form200_pending";
  const eoOk = !i.eo_expires_on || !i.today || i.eo_expires_on >= i.today;
  const allowed = status === "retained" && eoOk;
  return { expectation_due: due, timer: "FNMA_A4201_FORM200_RESPONSE_15BD", status, referral_allowed: allowed, refusal: allowed ? null : `referral refused by FNMA_A4201_RETAINED_FIRM_GATE: firm is ${status}${eoOk ? "" : " with expired E&O"} (A4-2.2-01)` };
}

/** Rule 13.6 rule 4 / A4-2.2-02: an escalation category (bar complaint, sanctions, breach, fraud …) goes by email to loanservicing@fanniemae.com within 2 BD of discovery — same day for breaches/fraud — naming points of contact; the decision record and message id are stored. */
export function firmEscalation(i: { firm_id: string; category: string; discovered_on: PlainDate; pocs: readonly string[]; sent_on?: PlainDate | null }): { due: PlainDate; timer: "FNMA_A4202_FIRM_ESCALATION_2BD"; channel: "email:loanservicing@fanniemae.com"; message_id: string; pocs: readonly string[]; on_time: boolean | null; record: { firm_id: string; category: string; discovered_at: PlainDate; sent_to_fnma_at: PlainDate | null; decision: { action: "escalate"; rule_results: string[] } }; refusal: string | null } {
  const sameDay = /breach|fraud/i.test(i.category); const due = escalationDue(i.discovered_on, sameDay);
  const messageId = `msg-${i.firm_id}-${i.category.replace(/\W+/g, "_")}-${i.discovered_on}`;
  return { due, timer: "FNMA_A4202_FIRM_ESCALATION_2BD", channel: "email:loanservicing@fanniemae.com", message_id: messageId, pocs: i.pocs, on_time: i.sent_on ? i.sent_on <= due : null, record: { firm_id: i.firm_id, category: i.category, discovered_at: i.discovered_on, sent_to_fnma_at: i.sent_on ?? null, decision: { action: "escalate", rule_results: [`A4-2.2-02 within two business days of discovery${sameDay ? " (sooner: circumstances warrant)" : ""}`] } }, refusal: i.pocs.length === 0 ? "escalation email must name points of contact (A4-2.2-02)" : null };
}

/** Rule 13.6 rule 5 / E-1.1-01: the transfer that makes ≥30 in 6 months (same state, from-firm → to-firm) is blocked until Fannie Mae has had 5 BD notice; a post-sale transfer needs prior approval. */
export function matterTransferGate(i: { state: string; from_firm: string; to_firm: string; transfers_in_6m_including_this: number; fnma_notified_on?: PlainDate | null; transfer_on: PlainDate; post_sale?: boolean; fnma_approval_document_id?: string | null }): { notice_required: boolean; gate: "FNMA_E1101_BULK_TRANSFER_NOTICE_5BD" | "FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE" | null; earliest: PlainDate | null; allowed: boolean; refusal: string | null } {
  if (i.post_sale && !i.fnma_approval_document_id) return { notice_required: false, gate: "FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE", earliest: null, allowed: false, refusal: "post-sale matter transfer needs Fannie Mae prior approval (E-1.1-01)" };
  const req = transferNoticeGate(i.transfers_in_6m_including_this);
  if (!req) return { notice_required: false, gate: null, earliest: i.transfer_on, allowed: true, refusal: null };
  if (!i.fnma_notified_on) return { notice_required: true, gate: "FNMA_E1101_BULK_TRANSFER_NOTICE_5BD", earliest: null, allowed: false, refusal: `transfer ${i.from_firm}→${i.to_firm} (${i.state}) is the ${i.transfers_in_6m_including_this}th in 6 months — blocked until Fannie Mae is notified 5 BD ahead (E-1.1-01)` };
  const earliest = addBusinessDays(i.fnma_notified_on, 5, servicer);
  return { notice_required: true, gate: "FNMA_E1101_BULK_TRANSFER_NOTICE_5BD", earliest, allowed: i.transfer_on >= earliest, refusal: i.transfer_on >= earliest ? null : `transfer blocked until ${earliest} (5 BD after Fannie Mae notice; E-1.1-01)` };
}

// ============================================================ 13.7 litigation intake, exception triggers, environmental, lead paint
/** Rule 13.7 rules 1, 3, 4: intake classifies the pleading, computes the 2-BD Form 20 deadline from receipt, and opens `LITIGATION_HOLD` on judgment/sale when enforceability/standing/priority is attacked or an injunction is sought. */
export function litigationIntake(i: { served_on: PlainDate; damages_against_fnma: boolean; attacks_validity_priority_enforceability: boolean; enumerated_risk: boolean; damages_claim: boolean; confidence: number; seeks_injunction?: boolean; damages_only?: boolean; form20_submitted_on?: PlainDate | null }): { classification: "non_routine" | "routine" | "attorney_confirmation_required"; category: 1 | 2 | 3 | null; form20: { required: boolean; due: PlainDate; task: "human_portal_task{kind=form20}"; submitted_on: PlainDate | null; on_time: boolean | null }; hold: { code: "LITIGATION_HOLD"; steps: readonly ["judgment_motion", "sale_conduct"]; opened_on: PlainDate } | null; status_code: "33"; escalation: Escalation | null } {
  const c = classify({ damages_against_fnma: i.damages_against_fnma, attacks_validity_priority_enforceability: i.attacks_validity_priority_enforceability, enumerated_risk: i.enumerated_risk, damages_claim: i.damages_claim, confidence: i.confidence });
  const due = form20Due(i.served_on); const required = c.classification !== "routine";
  const hold = c.classification === "non_routine" && litigationHold({ category: c.category, seeks_injunction: i.seeks_injunction ?? false, damages_only: i.damages_only ?? false });
  return { classification: c.classification, category: c.category, form20: { required, due, task: "human_portal_task{kind=form20}", submitted_on: i.form20_submitted_on ?? null, on_time: i.form20_submitted_on ? i.form20_submitted_on <= due : null }, hold: hold ? { code: "LITIGATION_HOLD", steps: ["judgment_motion", "sale_conduct"], opened_on: i.served_on } : null, status_code: "33", escalation: c.classification === "attorney_confirmation_required" ? { kind: "attorney", reason: `classification confirmation required before "routine" is accepted (confidence ${i.confidence}${i.damages_claim ? ", damages claim present" : ""})` } : null };
}
/** Rule 13.7 rule 2 / E-1.3-02: standing/MERS/HAMP matters file Form 20 only on the trigger (summary judgment, briefing, trial), within 2 BD of it; an answer alone is no trigger. */
export function form20ExceptionTrigger(i: { matter: "standing" | "mers" | "hamp"; event: "answer" | "summary_judgment_motion" | "briefing" | "trial"; on: PlainDate }): { form20_required: boolean; due: PlainDate | null; timer: "FNMA_E1302_FORM20_EXCEPTION_TRIGGER" | null } {
  const t = exceptionTrigger(i.matter, i.event);
  return { form20_required: t, due: t ? form20Due(i.on) : null, timer: t ? "FNMA_E1302_FORM20_EXCEPTION_TRIGGER" : null };
}
export const ENVIRONMENTAL_REPORT_ELEMENTS = ["value", "debt", "occupancy", "children_under_8", "documentation", "recommendation"] as const;
/** Rule 13.7 rule 5 / F-1-08: a suspected hazard opens a 10-day confirmation task; confirmed ⇒ gate closed (referral/first notice/judgment/sale refused), Servicing Representative report within 2 BD with the report elements. */
export function environmentalHazard(i: { state: "suspected" | "confirmed"; on: PlainDate; report?: Partial<Record<(typeof ENVIRONMENTAL_REPORT_ELEMENTS)[number], unknown>> | null }): { confirmation_task: { due: PlainDate } | null; gate: "FNMA_F108_ENV_NO_FORECLOSURE_GATE"; gate_closed: boolean; referral_allowed: boolean; report_by: PlainDate | null; report_elements_missing: string[]; refusal: string | null } {
  const e = environmental(i.state, i.on);
  const missing = i.state === "confirmed" ? ENVIRONMENTAL_REPORT_ELEMENTS.filter((k) => !i.report || i.report[k] === undefined || i.report[k] === null || i.report[k] === "") : [];
  return { confirmation_task: e.confirm_by ? { due: e.confirm_by } : null, gate: "FNMA_F108_ENV_NO_FORECLOSURE_GATE", gate_closed: e.gate_closed, referral_allowed: !e.gate_closed, report_by: e.report_by, report_elements_missing: [...missing], refusal: e.gate_closed ? "foreclosure.refer refused: FNMA_F108_ENV_NO_FORECLOSURE_GATE — environmental hazard confirmed; wait for Fannie Mae's direction to proceed (F-1-08)" : null };
}
export const LEAD_PAINT_ELEMENTS = ["property_value_cents", "total_debt_cents", "children_under_8", "documentation_ids"] as const;
/** Rule 13.7 rule 5 / F-1-08: a lead-paint citation on a referred 1–4 unit property is reported to the Servicing Representative within 30 days of referral with value, debt, children under 8 and documentation. */
export function leadPaintNotification(i: { referral_on: PlainDate; units: number; notification: Partial<Record<(typeof LEAD_PAINT_ELEMENTS)[number], unknown>> | null; sent_on?: PlainDate | null }): { applies: boolean; due: PlainDate; timer: "FNMA_F108_LEAD_PAINT_NOTIFY_30"; elements_missing: string[]; complete: boolean; on_time: boolean | null } {
  const missing = LEAD_PAINT_ELEMENTS.filter((k) => !i.notification || i.notification[k] === undefined || i.notification[k] === null || i.notification[k] === "" || (Array.isArray(i.notification[k]) && (i.notification[k] as unknown[]).length === 0));
  const due = leadPaintNoticeDue(i.referral_on);
  return { applies: i.units >= 1 && i.units <= 4, due, timer: "FNMA_F108_LEAD_PAINT_NOTIFY_30", elements_missing: [...missing], complete: missing.length === 0, on_time: i.sent_on ? i.sent_on <= due : null };
}

// ============================================================ 13.8 affidavit records review and evidenced case close
export interface AffidavitChecklist { readonly certificate_ids: readonly string[]; readonly certificate_on: PlainDate; readonly party_match: boolean; readonly conflicting_assertions: boolean; readonly future_call_up: boolean }
/** Rule 13.8 rule 5: an affidavit is executed only by a `signing_officer` after the recorded records review — certificate ids ≤30 days, party matching, no conflicting assertions, no unresolved Future Call-Up. */
export function scraAffidavit(i: { judicial: boolean; today: PlainDate; executed_by_role: string | null; checklist: AffidavitChecklist; kind: "non_military_affidavit" | "unable_to_determine" | "military_status_declaration"; filing_evidence_document_id?: string | null }): { allowed: boolean; refusal: string | null; records_review: { passed: boolean; failing: string[] }; motion_instruction_released: boolean; gate: "SCRA_3931_AFFIDAVIT_GATE" } {
  const failing: string[] = [];
  if (i.checklist.certificate_ids.length === 0) failing.push("no DMDC certificate ids");
  if (!i.checklist.party_match) failing.push("parties do not match the certificates");
  if (i.checklist.conflicting_assertions) failing.push("conflicting assertions of service on file");
  if (i.checklist.future_call_up) failing.push("unresolved Future Call-Up flag");
  const g = affidavitGate({ judicial: i.judicial, certificate_on: i.checklist.certificate_on, today: i.today, executed_by_role: i.executed_by_role, filing_evidence_document_id: i.filing_evidence_document_id ?? null });
  if (i.judicial && !g.affidavit_valid && g.refusal) failing.push(g.refusal);
  const ok = failing.length === 0;
  return { allowed: ok, refusal: ok ? null : `affidavit refused (SCRA_3931_AFFIDAVIT_GATE): ${failing.join("; ")}`, records_review: { passed: ok, failing }, motion_instruction_released: ok && g.motion_instruction_released, gate: "SCRA_3931_AFFIDAVIT_GATE" };
}
/** Rule 13.8: a period ends only on evidence — orders, the DMDC "Left Active Duty" flag or borrower confirmation — never on the agent's say-so; the tail then runs a calendar year and the gate opens the day after. */
export function scraCaseClose(i: { service_end_on: PlainDate; evidence: { orders_document_id?: string | null; dmdc_certificate_id?: string | null; borrower_confirmation_contact_id?: string | null } }): { allowed: boolean; refusal: string | null; basis: "orders" | "dmdc_left_active_duty" | "borrower_confirmation" | null; status: "open_tail_12m" | null; protection_ends_on: PlainDate | null; gate_opens_on: PlainDate | null; timer: "SCRA_3953_TAIL_1Y" | null } {
  const basis = i.evidence.orders_document_id ? "orders" : i.evidence.dmdc_certificate_id ? "dmdc_left_active_duty" : i.evidence.borrower_confirmation_contact_id ? "borrower_confirmation" : null;
  if (!basis) return { allowed: false, refusal: "service end needs evidence: orders, the DMDC Left-Active-Duty certificate, or the borrower's confirmation (13.8 inputs) — the gate stays closed", basis: null, status: null, protection_ends_on: null, gate_opens_on: null, timer: null };
  const t = protectionTail(i.service_end_on);
  return { allowed: true, refusal: null, basis, status: "open_tail_12m", protection_ends_on: t.protection_ends_on, gate_opens_on: t.gate_opens_on, timer: "SCRA_3953_TAIL_1Y" };
}

// ============================================================ 13.9 cap tail, ARM adjustments, fees inside the cap
/** Rule 13.9 rule 9: the cap ends `addYears(service_end_on, 1)` inclusive; restoration is the first installment due after; the end-date letter goes out 60 days before restoration. */
export function capTail(i: { service_end_on: PlainDate; restored_payment_cents: Cents }): { cap_ends_on: PlainDate; timer: "SCRA_3937A1_CAP_TAIL_1Y"; restoration_due: PlainDate; restored_payment_cents: Cents; end_letter_due: PlainDate; notice: "NTC_SCRA_3937_RATE_END"; capInForceOn: (d: PlainDate) => boolean } {
  const ends = capEndsOn(i.service_end_on);
  return { cap_ends_on: ends, timer: "SCRA_3937A1_CAP_TAIL_1Y", restoration_due: restorationInstallment(ends), restored_payment_cents: i.restored_payment_cents, end_letter_due: endDateLetterDue(ends), notice: "NTC_SCRA_3937_RATE_END", capInForceOn: (d) => d <= ends };
}
/** Rule 13.9 rule 3: an ARM adjustment during the cap applies min(6%, adjusted rate) and emits Transaction 83 / the rate_payment.change servicing event. */
export function armAdjustment(i: { adjusted_rate_pct: string; scheduled_on: PlainDate; cap_active: boolean }): { applied_rate_pct: string; capped: boolean; event: { type: "investor.event"; kind: "lar_83"; servicing_event: "rate_payment.change"; on: PlainDate }; timer: "FNMA_F119_ARM_TXN83" } {
  const applied = i.cap_active ? armCappedRate(i.adjusted_rate_pct) : i.adjusted_rate_pct;
  return { applied_rate_pct: applied, capped: applied !== i.adjusted_rate_pct, event: { type: "investor.event", kind: "lar_83", servicing_event: "rate_payment.change", on: i.scheduled_on }, timer: "FNMA_F119_ARM_TXN83" };
}
/** Rule 13.9 rule 5 / §3937(d): a fee assessed on or before `cap_ends_on` counts as interest and is forgiven; the gate runs through the tail. */
export function feeInsideCap(i: { assessed_on: PlainDate; cap_effective_due: PlainDate; cap_ends_on: PlainDate }): { inside: boolean; gate: "SCRA_3937_FEES_IN_CAP_GATE"; disposition: "forgive" | "collectible" } {
  const inside = i.assessed_on >= i.cap_effective_due && i.assessed_on <= i.cap_ends_on;
  return { inside, gate: "SCRA_3937_FEES_IN_CAP_GATE", disposition: inside ? "forgive" : "collectible" };
}
export const federalBusinessDays = (d: PlainDate, n: number): PlainDate => addBusinessDays(d, n, federal);
