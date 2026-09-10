/**
 * Registry overrides for Section 11 (early intervention, collections, FDCPA)
 * timers whose spec rows are prose. Per-communication rules (call caps,
 * quiet hours, disclosure fragments) are evaluator-backed: they are asserted
 * on each outbound attempt rather than clocked.
 *
 * Event vocabulary: `notice.sent` carries `{notice_id, template, channels,
 * sent_at}` (src/notices/service.ts), so every notice satisfier matches on
 * `template=`; the `contact.*`, `fdcpa.*`, `imminent_default.*` and `smdu.*`
 * events are produced by plan.ts, fdcpa.ts, imminent-default.ts and the §11
 * bus tools (src/app/tools/section11.ts). Where a spec column lists several
 * alternatives (three satisfiers, two triggers) the registry grammar takes one
 * pattern, so the §11 producers emit one canonical `regx.ei_*` event alongside
 * the spec's own events (windows.ts / ops.ts) — the 14.1
 * `bankruptcy.notice.verified{result}` precedent — and the override names it.
 *
 * "Cancelled by" columns: the kernel's TimerEngine cancels by instance id only,
 * so this module also carries the section's cancellation table
 * (`EARLY_INTERVENTION_CANCELLATIONS`) and the reader that applies it
 * (`attachEarlyInterventionTimerCancellations`), plus the generic
 * `cancel_timers: string[]` payload convention plan.ts / imminent-default.ts use.
 */
import type { TimerRegistry, TimerOverride, TimerDef } from "../../kernel/timers/registry.ts";
import type { TimerEngine, TimerInstance } from "../../kernel/timers/engine.ts";
import { parseEventPattern, eventMatches, SYSTEM, type EventPattern, type EventStore, type DomainEvent, type Actor } from "../../kernel/events/index.ts";
import { addDays } from "../../kernel/calendar/date.ts";

/**
 * `TimerRegistry.override` re-parses `anchorField` from the raw anchor text on every call, so a second override of the
 * same code (the satisfied-by pass below) would drop an anchor the first pass set. This wrapper carries the current
 * anchor forward unless the override sets one (or replaces the anchor text).
 */
function keepAnchor(reg: TimerRegistry): (code: string, o: TimerOverride) => void {
  return (code, o) => { const cur = reg.get(code); reg.override(code, { ...(o.anchorField === undefined && o.anchor === undefined && cur?.anchorField ? { anchorField: cur.anchorField } : {}), ...o }); };
}

const EI_VARIANT_TEMPLATES = "{NTC_REGX_39B_EARLY_INTERVENTION, NTC_REGX_39D_EARLY_INTERVENTION_FDCPA, NTC_REGX_39C_EARLY_INTERVENTION_BK, NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA}";
const EI_STANDARD_BK_TEMPLATES = "{NTC_REGX_39B_EARLY_INTERVENTION, NTC_REGX_39C_EARLY_INTERVENTION_BK}";
const EI_BK_TEMPLATES = "{NTC_REGX_39C_EARLY_INTERVENTION_BK, NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA}";
const EI_FDCPA_TEMPLATES = "{NTC_REGX_39D_EARLY_INTERVENTION_FDCPA, NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA}";
/** 12.2's Evaluation Notice family plus the Form 182 / Reg B adverse notice 11.5 issues for a declined current borrower. */
const EVALUATION_NOTICE_TEMPLATES = "{NTC_FNMA_EVAL_NOTICE_STREAMLINED, NTC_FNMA_D23206_TPP_OFFER, NTC_FNMA_D23204_DEFERRAL_OFFER, NTC_FNMA_D23205_DISASTER_DEFERRAL_OFFER, NTC_FNMA_A42106_FORM182_ADVERSE_ACTION}";
/** 11.5 rule 8: the adverse-action content travels on Form 182 (current borrower), 12.2's denial notice (delinquent <60 days) or 12.2's Reg B template. */
const ADVERSE_ACTION_TEMPLATES = "{NTC_FNMA_A42106_FORM182_ADVERSE_ACTION, NTC_REGX_41C1_DENIAL, NTC_REGB_1002_9_LM_ADVERSE_ACTION}";
/** `loan.delinquency.window_opened` from the 11.1 counter job / 1.1 boarding: principal residence, and a live leg that is `open` at creation (boarding's event carries no status and arms). */
const LIVE_WINDOW_TRIGGER = "`loan.delinquency.window_opened{principal_residence=true, live_status!=exempt_bk, live_status!=exempt_fdcpa_cease, live_status!=exempt_discharge, live_status!=not_applicable}`";
const NOTICE_WINDOW_TRIGGER = "`loan.delinquency.window_opened{principal_residence=true, notice_status!=satisfied_by_prior_180, notice_status!=deferred_transferee, notice_status!=bk_modified_required, notice_status!=exempt_bk_no_option, notice_status!=exempt_bk_cease, notice_status!=exempt_fdcpa_no_option, notice_status!=exempt_fdcpa_bk, notice_status!=exempt_discharge, notice_status!=not_applicable}`";

export function applyEarlyInterventionTimerOverrides(reg: TimerRegistry): void {
  const o = keepAnchor(reg);
  // ---- 11.1 contact cadence ------------------------------------------------
  o("REGX_1024_39A_LIVE_CONTACT_36", { trigger: LIVE_WINDOW_TRIGGER, anchorField: "due_date", why: "§11.1 timer table: `loan.delinquency.window_opened{due_date}` (principal residence) → +36 calendar days 23:59 loan-local (§1024.39(a)); windows whose live leg is exempt at creation (`exempt_bk`, `exempt_fdcpa_cease`, `exempt_discharge`, non-principal residence `not_applicable`) never arm; later overlays cancel (cancellation table)." });
  o("REGX_1024_39A_LIVE_CONTACT_36_WARN_28", { trigger: LIVE_WINDOW_TRIGGER, anchorField: "due_date", why: "§11.1 timer table: 'same' as REGX_1024_39A_LIVE_CONTACT_36; warning at due_date + 28." });
  o("FNMA_A42104_VARY_TIMES_CYCLE", { trigger: "`contact.plan.cycle_closed`", evaluator: "11.1.variedAttemptTimes", why: "§11.1 timer table: per 3 consecutive cycles ≥1 evening (after 17:00 local) or weekend attempt and ≥2 distinct daypart slots (A4-2.1-04); `contact.plan.cycle_closed` is emitted by plan.ts closeCycle." });
  o("FNMA_D2202_OUTBOUND_START_36", { trigger: "`loan.delinquency.started`", anchorField: "due_date", offset: "+36 calendar_days (rolled to the next servicer business day)", why: "§11.1 timer table: `loan.delinquency.started` (all loans) → day 36 = due_date + 36, next open day if closed (A4-2.1-04); the counter job (ops.ts counterRun) emits `loan.delinquency.started{due_date}` on day 1 of a delinquency; cancelled by the plan's cease/suspend/close (`cancel_timers`)." });
  o("FNMA_D2202_OUTBOUND_EVERY_7", { trigger: "`contact.attempted{direction=outbound}`", why: "§11.1 timer table: `contact.attempted` (outbound) while the plan is active → last attempt +7 calendar days (shift to next open day); cancelled by plan ceased/suspended/closed through the `cancel_timers` payload plan.ts emits (cancellation reader)." });
  o("FNMA_D2202_CONTINUE_AFTER_210", { trigger: "`loan.delinquency.day_reached{day=210}`", offset: "every 7 calendar_days", why: "§11.1 timer table: `loan.delinquency.day_reached{210}` → attempts continue every 7 days (policy = Guide 'authorized', D2-2-02); the counter job (ops.ts delinquencyMilestone) emits `loan.delinquency.day_reached{day}` at the spec's milestone days." });
  o("FNMA_D2202_PTP_FOLLOWUP_30", { anchorField: "due_on", offset: "0", why: "§11.1 timer table: anchor 'promise date (≤ +30 days from promise)', offset '0 (checked 00:05 next day)' — `borrower.promise_to_pay.recorded{due_on}` (11.3 promise.record tool) anchors on the promise date; the 00:05 check the next day breaks it (`resume cadence (not a breach)`: severity null) unless a covering `payment.applied` satisfied it (11.1-T17)." });
  o("REGF_1006_14_CALL_CAP_7IN7", { trigger: "`contact.attempt.requested{mode∈{voice, ai_voice, human_voice}, direction=outbound, fdcpa_debt_collector_flag=true}`", evaluator: "11.1.callCap7in7", why: "§11.1 timer table: 'every outbound voice attempt' — the 11.1 dial request (ops-11-1.ts) spells the dialer mode `ai_voice`/`human_voice` (rule 9: counted 'by AI or human'), the 11.4 Contact Engine request spells `voice` (incl. voicemails); max 7 counted calls per person per debt in trailing 7 days (Reg F §1006.14(b))." });
  o("REGF_1006_6B1_QUIET_HOURS", { trigger: "`contact.attempt.requested{direction=outbound, line_type∈{mobile, landline, voip, unknown}}`", evaluator: "11.1.quietHours", why: "§11.1 timer table: 'every outbound communication' — allowed 08:00–21:00 consumer-local (policy voice 08:00–20:30, SMS/email 08:00–20:00) (Reg F §1006.6(b)(1)); 11.1-T12: 08:00 consumer-local is refused. The 11.1 dial request (ops-11-1.ts, recorded by contact.log for every outbound attempt) is the one that carries the number's `line_type` and the candidate-zone local times (rule 8) the evaluator reads; the 11.4 Contact Engine request for the same dial carries neither, so the gate arms once per dial." });
  o("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE", { trigger: "`regx.ei_windows.resume_after_bk`", anchorField: "next_due_date", why: "§11.1 timer table: `bankruptcy.dismissed/closed/reaffirmed` → windows re-open from the next payment due date (§1024.39(c)(2)(i)). The 14.x `bankruptcy.status.changed{to∈{dismissed, closed, reaffirmed}}` carries no due date; 14.3's rule-6 decision `bankruptcy.early_intervention.evaluated{trigger=resume, required=true, resume_from_due_date}` (the 14.3 bus tool) does, and the §11 ingestion hook (ops-11-1.ts attachBankruptcyResumeHooks_11_1 → resumeWindowsAfterBankruptcy → windows.ts resumeAfterBankruptcy) emits `regx.ei_windows.resume_after_bk{next_due_date}` — the gate anchors on that date." });
  o("SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD", { trigger: "`regx.ei_window.human_fallback.required`", anchorField: "live_due_at", why: "§11.1 timer table: trigger '`live_contact.ai_voice_counts=false` for the loan's jurisdiction, or AI-only efforts ≥3 without live contact by day 28' — two alternatives, one canonical event `regx.ei_window.human_fallback.required{reason∈{ai_voice_counts_false, ai_only_efforts_3_by_day_28}}` emitted by the counter job (flag off) and the day-28 review (ops.ts aiOnlyEscalation, alongside `contact.ai_only.escalated`); task due 5 calendar days before `live_due_at`." });
  o("TCPA_64_1200_A1_CELL_CONSENT_GATE", { trigger: "`contact.attempt.requested{mode∈{ai_voice, sms}, line_type∈{mobile, voip, unknown}}`", evaluator: "11.1.tcpaConsentUnrevoked", why: "§11.1 timer table: requires unrevoked `tcpa_voice`/`tcpa_sms` consent (47 CFR 64.1200(a)(1))." });
  o("TCPA_64_1200_A3_LANDLINE_AI_3IN30", { trigger: "`contact.attempt.requested{mode=ai_voice, line_type=landline, written_consent=false}`", evaluator: "11.1.landlineAi3in30", why: "§11.1 timer table: max 3 AI-voice attempts per landline number in trailing 30 days without written consent (47 CFR 64.1200(a)(3))." });
  // ---- 11.2 early intervention notices ------------------------------------
  o("REGX_1024_39B_WRITTEN_NOTICE_45", { trigger: NOTICE_WINDOW_TRIGGER, anchorField: "due_date", why: "§11.2 timer table: `loan.delinquency.window_opened{due_date}` (principal residence) → +45 calendar days; a leg `satisfied_by_prior_180` (active cycle covers D+45), `deferred_transferee`, `bk_modified_required` or exempt at creation never arms (the counter job carries `notice_status`; boarding's event has none and arms); cancelled by installment paid ≤ due, bankruptcy (the modified notice governs), discharge (cancellation table)." });
  o("FNMA_D2101_NO_SOLICIT_LT30", { trigger: "`solicitation_package.send_requested`", evaluator: "11.2.delinquentAtLeast30OrImminentDefault", why: "§11.2 timer table: `regx_days_delinquent ≥ 30` (or imminent-default request by the borrower, 11.5) before any solicitation package (D2-1-01); `solicitation_package.send_requested` is emitted by the 11.2 print.request tool." });
  o("REGX_1024_39B_NOTICE_180_REPEAT", { trigger: `\`notice.sent{template∈${EI_STANDARD_BK_TEMPLATES}}\``, anchorField: "provided_at", offset: "+180 calendar_days", why: "§11.2 timer table: `notice.sent` (standard/bk variants) → +180 calendar days from `provided_at` (the send date when the event carries none); the ≥45/<45 test at +180 is the nightly cycle-end review (windows.ts cycleEndReview): ≥45 days delinquent keeps the +180 deadline, <45 emits `regx.ei_cycle.reviewed{repeat_required=false}` which cancels it because the duty moves to 45 days after the due date for which the borrower remains delinquent — that window's own REGX_1024_39B_WRITTEN_NOTICE_45 (§1024.39(b)(1)); 11.2-T4." });
  o("REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE", { trigger: "`regx.ei_transferee.deferred`", anchorField: "first_post_transfer_due_date", why: "§11.2 timer table: `loan.boarded{transferor_ei_notice_sent_at ≥ transfer_date − 45}` → written notice +45 calendar days after the first post-transfer due date if still delinquent (comment 39(b)(1)-5). The cross-field test is computed by the §11 transfer-in overlay (ops.ts transfereeBoarding), which emits `regx.ei_transferee.deferred{first_post_transfer_due_date}` from the boarding data; cancelled by the installment paid ≤ due (cancellation table)." });
  o("REGX_1024_39C_RESUME_NEXT_DUE", { trigger: "`regx.ei_windows.resume_after_bk`", anchorField: "next_due_date", why: "§11.2 timer table: `bankruptcy.dismissed/closed/reaffirmed` → windows from the next due date follow the standard rules (§1024.39(c)(2)(i)); anchored on the `next_due_date` the §11 reaction computes (windows.ts resumeAfterBankruptcy) because the 14.x status event carries none." });
  o("REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM", { trigger: "`bankruptcy.status.changed{to=discharged}`", offset: "until payment.applied", why: "§11.2 timer table: `bankruptcy.discharged` — 14.x emits it as `bankruptcy.status.changed{to=discharged}` (ops-14-1.ts dischargeMode) — then (b) re-arms on the first `payment.applied` with `received_on ≥ petition_date`; (a) never re-arms (§1024.39(c)(2)(ii)). The cross-field test is made by ops.ts postPetitionPayment, which emits the satisfier." });
  o("REGX_1024_39D_FDCPA_NOTICE_190", { trigger: `\`notice.sent{template∈${EI_FDCPA_TEMPLATES}}\``, anchorField: "provided_at", offset: "+190 calendar_days", why: "§11.2 timer table: `notice.sent{variant ∈ fdcpa, bk_fdcpa}` — the fdcpa-variant templates (notice.sent carries `template`) → +190 calendar days from `provided_at` (11.2-T5: 2026-12-14 → 2027-06-22); at +180 the nightly cycle-end review decides: ≥45 days delinquent keeps +190, else the later of (45 days after the due date for which the borrower remains delinquent) and +190 — when that date is past +190 it is the window's own REGX_1024_39B_WRITTEN_NOTICE_45 and `regx.ei_cycle.reviewed{repeat_required=false}` cancels this instance (§1024.39(d)(3)(iii))." });
  o("REGX_1024_39C_BK_MODIFIED_NOTICE_45", { trigger: "`regx.ei_notice.bk_modified_required`", anchorField: "anchor_on", why: "§11.2 timer table: `bankruptcy.petition.filed` while `regx_days_delinquent ≥ 1`, or first `loan.delinquency.started` during the case → modified notice +45 calendar days from the petition date (or delinquency start) (§1024.39(c)(1)(iii)(A)). Two triggers and a delinquency test the 14.x petition event cannot express (it carries `fnma_delinquency_days`, not the Reg X counter), so the §11 petition overlay (ops.ts petitionOverlay: a notice leg moved to `bk_modified_required`) and the counter job (first delinquency in the case) emit `regx.ei_notice.bk_modified_required{anchor_on, basis}`; a petition by a current borrower arms nothing (11.2-T6)." });
  o("SM_EI_NOTICE_CONTENT_CHECKLIST", { trigger: `\`notice.rendered{template∈${EI_VARIANT_TEMPLATES}}\``, evaluator: "11.2.checklistComplete", why: "§11.2 timer table: gate at render — all checklist items true for the variant (standard, fdcpa, bk, bk_fdcpa); NoticeService emits `notice.rendered` only when the block rules pass and `notice.held` otherwise, and print.request refuses a held notice." });
  o("FNMA_D2204_SOLICITATION_45", { trigger: "`loan.delinquency.day_reached{day=45, qrpc_established=false, resolved=false}`", why: "§11.2 timer table: `loan.delinquency.day_reached{45}` with no `contact.qrpc.established` and no resolution → send on day 45 (policy hand-off day 43) (D2-2-04); the counter job (ops.ts delinquencyMilestone) emits `loan.delinquency.day_reached{day, qrpc_established, resolved}`." });
  o("FNMA_D2204_BSP_AFTER_QRPC_3BD", { trigger: "`contact.qrpc.established{resolution_status=none, prior_bsp_id is null}`", anchorField: "achieved_at", why: "§11.2 timer table: `contact.qrpc.established{resolution=none}` with no prior BSP → BSP within 3 servicer business days of the QRPC date (D2-2-04); the 11.3 qrpc.capture tool emits `resolution_status` and looks up `prior_bsp_id` in `solicitation_packages` (11.2-T12: a prior BSP arms nothing)." });
  // ---- 11.3 QRPC / promises -----------------------------------------------
  o("FNMA_D2202_CESSATION_ON_QRPC", { evaluator: "11.3.cessationOnQrpc", why: "§11.3 timer table: `contact.qrpc.established` → plan ceased{qrpc_workout | qrpc_no_interest | ptp_pending}, or stays active when the commitment is partial/callback-only (D2-2-02)." });
  o("FNMA_D2202_PTP_MAX_30", { trigger: "`borrower.promise_to_pay.recorded`", evaluator: "11.3.promiseWithin30Days", why: "§11.3 timer table: cadence-ceasing promise must have `due_on ≤ +30 calendar_days` (D2-2-02); `borrower.promise_to_pay.recorded` is emitted by the 11.3 promise.record tool." });
  o("FNMA_LL202605_QRPC_REASON_REQUIRED", { trigger: "`investor_events.building{family=qrpc}`", evaluator: "11.3.qrpcReasonPresent", why: "§11.3 timer table: QRPC action event build (5.7) requires reason type (LL-2026-05)." });
  o("SM_LICENSED_NEGOTIATION_GATE", { trigger: "`contact.modification_terms.discussed`", evaluator: "11.3.licensedNegotiator", why: "§11.3 timer table: `jurisdiction_rules.mlo_licensing_for_lossmit=false` or `licensed_specialist` on the call." });
  o("SM_THIRD_PARTY_AUTH_GATE", { trigger: "`contact.started{party_role∈{trusted_advisor, authorized_third_party}}`", evaluator: "11.3.thirdPartyAuthorized", why: "§11.3 timer table: valid unexpired authorization or in-call recorded consent." });
  // ---- 11.4 FDCPA ----------------------------------------------------------
  o("REGF_1006_100_RETENTION_3Y", { trigger: "`collection.activity.last`", anchorField: "on", offset: "+3 years", why: "§11.4 timer table: retain 3 years after last collection activity (recordings 3 years after the call) — subsumed by `life_of_loan_plus_4y` (Reg F §1006.100); `collection.activity.last` is emitted by fdcpa.ts on every collection contact." });
  o("REGF_1006_18E_DISCLOSURE_GATE", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true}`", evaluator: "11.4.disclosureFragmentPresent", why: "§11.4 timer table: disclosure fragment present (initial vs subsequent variant) on every DC-loan communication (Reg F §1006.18(e))." });
  o("REGF_1006_2_LCM_ONLY_VOICEMAIL", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true, channel=voicemail}`", evaluator: "11.4.limitedContentMessageOnly", why: "§11.4 timer table: voicemail on DC loan uses the limited-content message template only (Reg F §1006.2(j))." });
  o("REGF_1006_30A_FURNISH_GATE_14", { trigger: "`fdcpa.validation_notice.sent`", anchorField: "sent_on", offset: "+14 calendar_days", why: "§11.4 timer table: +14 calendar days with no undeliverability notice, or any telephone/in-person conversation, opens furnishing (Reg F §1006.30(a))." });
  o("REGF_1006_34_VALIDATION_NOTICE_5D", { anchorField: "on", why: "§11.4 timer table: `fdcpa.initial_communication.recorded` (anchor: the initial communication date, payload `on`) → written validation notice within 5 calendar days (Reg F §1006.34(a)(1)(i)(B))." });
  o("REGF_1006_38_DISPUTE_CEASE_GATE", { trigger: "`fdcpa.dispute.received{written=true, within_validation_period=true}`", why: "§11.4 timer table: written dispute within the period → collection ceases until `verification_sent` (Reg F §1006.38(c)); emitted by fdcpa.ts receiveDispute and the 11.3 dispute.intake tool (11.4-T5)." });
  o("REGF_1006_38_OC_REQUEST_GATE", { trigger: "`fdcpa.original_creditor.requested{written=true, within_validation_period=true}`", why: "§11.4 timer table: written original-creditor request within the period → until `oc_sent` (Reg F §1006.38(d))." });
  o("REGF_1006_38_OVERSHADOW_GATE", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true, within_validation_period=true}`", evaluator: "11.4.noOvershadowing", why: "§11.4 timer table: no demand inconsistent with dispute rights; no 'pay within X days' shorter than the period (Reg F §1006.38(b))." });
  o("REGF_1006_42_ESIGN_GATE", { trigger: "`notice.rendered{template=NTC_REGF_1006_34_VALIDATION_B1}`", evaluator: "11.4.esignConsentForValidation", why: "§11.4 timer table: electronic validation notice needs a valid E-SIGN consent for class `regf_validation` (Reg F §1006.42) — gated at the B-1's render, before the channel decision (the authored code is NTC_REGF_1006_34_VALIDATION_B1)." });
  o("REGF_1006_6B3_WORKPLACE_GATE", { trigger: "`contact.attempt.requested{workplace_flag=true, employer_prohibits=true}`", evaluator: "11.4.workplaceProhibited", why: "§11.4 timer table: number/email flagged workplace + employer prohibits → no contact (Reg F §1006.6(b)(3))." });
  o("REGF_1006_6C_CEASE_GATE", { trigger: "`fdcpa.cease.received{written=true}`", offset: "until fdcpa.cease.withdrawn", why: "§11.4 timer table: written cease is permanent unless withdrawn in writing (Reg F §1006.6(c)); `fdcpa.cease.received{written=true}` is emitted by fdcpa.ts receiveCease." });
  o("REGF_1006_6D5_SMS_RND_60", { trigger: "`contact.attempt.requested{mode=sms, fdcpa_debt_collector=true}`", evaluator: "11.4.reassignedNumberCheckFresh", why: "§11.4 timer table: last RND check ≤60 calendar days old, or consumer texted from the number ≤60 days ago (Reg F §1006.6(d)(5))." });
  o("REGF_1006_6E_OPTOUT_PRESENT", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true, channel∈{email, sms}}`", evaluator: "11.4.optOutPresent", why: "§11.4 timer table: opt-out statement present; no fee (Reg F §1006.6(e))." });
  o("SM_REGF_VERIFICATION_RESPONSE_30", { trigger: "`fdcpa.dispute.received`", anchorField: "on", why: "§11.4 timer table: dispute received → verification sent within 30 calendar days (policy)." });
  // ---- 11.5 imminent default ----------------------------------------------
  o("CO_AI_ACT_PRE_DECISION_NOTICE", { trigger: "`imminent_default.evaluating{state=CO, ai_influenced=true}`", evaluator: "11.5.preDecisionNoticeDelivered", why: "§11.5 timer table: pre-decision notice delivered before any AI-influenced adverse determination (Colorado SB 24-205)." });
  o("FNMA_D2101_CASH_RESERVE_25000", { trigger: "`imminent_default.evaluating`", evaluator: "11.5.cashReserveBelow25000", why: "§11.5 timer table: `cash_reserves_cents < 2,500,000` (waived for PCS >50 mi on liquidation track) (D2-1-01)." });
  o("FNMA_D2101_ELIGIBILITY_WINDOW_60", { trigger: "`imminent_default.evaluating`", evaluator: "11.5.delinquentUnder60", why: "§11.5 timer table: `regx_days_delinquent(evaluation_date) < 60` (D2-1-01)." });
  o("FNMA_D2101_FICO_AGE_90", { trigger: "`imminent_default.evaluating{path=credit}`", anchorField: "fico_date", evaluator: "11.5.ficoFresh", why: "§11.5 timer table: `evaluation_date − fico_date ≤ 90 calendar_days` (D2-1-01)." });
  o("FNMA_D2205_ACCEPT_14", { trigger: "`lossmit.offer.sent{kind∈{offer, counteroffer}}`", why: "§11.5 timer table: offer/counteroffer sent → acceptance within 14 calendar days (D2-2-05)." });
  o("FNMA_D2205_DECISION_5D_30D", { trigger: "`smdu.case.decided`", anchorField: "decided_on", why: "§11.5 timer table: decision made → Evaluation Notice within 5 days, and ≤30 days after complete BRP (D2-2-05); the 30-day leg is `REGX_1024_41C1_EVALUATE_30`; `smdu.case.decided{decision}` is emitted by imminent-default.ts smduDecision." });
  o("FNMA_D2205_INCOME_DOC_90", { trigger: "`lossmit.application.completed`", anchorField: "oldest_income_document_date", why: "§11.5 timer table: ≤90 calendar days at `brp_complete_at` (180 for disaster-impacted per D2-2-05)." });
  o("FNMA_SMDU_PORTAL_TASK_1BD", { trigger: "`human_portal_task.created{kind=smdu}`", why: "§11.5 timer table: `human_portal_task.created{smdu}` → 1 `business_days_fannie_et` from creation; ops.ts smduB2bOutage opens the task (`kind=smdu`, owner `fnma_portal_operator`) when SMDU B2B is unavailable ≥4 hours (11.5-T12)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("REGF_1006_14_POST_CONVERSATION_7", { trigger: "`contact.completed{outcome∈{conversation, qrpc}, fdcpa_debt_collector=true}`", why: "§11.1 timer table: `contacts{outcome ∈ conversation,qrpc}` on a DC loan → no call for 7 calendar days (Reg F §1006.14(b)(2)(ii)); `contact.completed` is emitted by plan.ts recordAttempt and the contact.log tool." });
  o("SM_QRPC_HUMAN_VERIFY_1BD", { trigger: "`contact.qrpc.captured{human_verification_required=true}`", anchorField: "achieved_at", why: "§11.3 timer table: `qrpc_complete` while `live_contact.ai_voice_counts=false` (or sampled ≥10 %) → human verification within 1 `business_days_servicer`. The capture event fires when the record enters `pending_human_verification`; `contact.qrpc.established` fires only after `qrpc_verified` (11.3-T7), so it cannot be the trigger." });
  o("REGF_1006_34_ASSUMED_RECEIPT_5D", { trigger: "`fdcpa.validation_notice.sent`", anchorField: "sent_on", why: "§11.4 timer table: `validation_sent_at` → +5 `business_days_federal` = `assumed_receipt_on` (Reg F §1006.34(b)(3))." });
  o("REGF_1006_34_VALIDATION_PERIOD_30", { trigger: "`fdcpa.validation_notice.assumed_received`", anchorField: "assumed_receipt_on", why: "§11.4 timer table: `assumed_receipt_on` + 30 calendar days = `validation_period_end_on` (Reg F §1006.34(b)(5))." });
  o("SM_ID_SMDU_SUBMIT_2BD", { trigger: "`imminent_default.eligible`", anchorField: "eligibility_date", why: "§11.5 timer table: `eligible` → SMDU submission within 2 `business_days_servicer`; `imminent_default.eligible` is emitted by imminent-default.ts evaluationEvents." });
  o("SM_ID_REVIEWER_SLA_2BD", { trigger: "`imminent_default.reviewer_pending`", anchorField: "entry", why: "§11.5 timer table: `reviewer_pending` → reviewer decision within 2 `business_days_servicer`; emitted by evaluationEvents (ineligible) and smduDecision (declined)." });
  o("FNMA_D2101_FORM182_ADVERSE_30", { trigger: "`smdu.case.declined{current_at_evaluation=true}`", anchorField: "declined_on", why: "§11.5 timer table: `smdu_declined` for a borrower current at evaluation → Form 182 within 30 calendar days of the decline (D2-1-01); `smdu.case.declined` is emitted by imminent-default.ts smduDecision, and an accepted counteroffer (`lossmit.offer.accepted{within_window=true, kind=counteroffer}`) cancels the timer through the cancellation table (11.5-T8) rather than gating its arming — acceptance is unknown at decline time." });
  o("REGB_1002_9_ADVERSE_ACTION_30", { trigger: "`imminent_default.reviewer_pending`", anchorField: "brp_complete_at", why: "§11.5 timer table: completed application (`brp_complete_at`) with an adverse outcome → adverse action notice within 30 calendar days of the complete date (Reg B §1002.9); the outcome is known only at the adverse determination (ineligible / smdu_declined → `imminent_default.reviewer_pending`), whose payload carries `brp_complete_at`." });
  applyEarlyInterventionSatisfiedOverrides(reg);
}

/** Satisfaction events / evaluators for the §11 rows whose "Satisfied by" column is prose or empty. */
export function applyEarlyInterventionSatisfiedOverrides(reg: TimerRegistry): void {
  const o = keepAnchor(reg);
  // ---- 11.1
  o("REGX_1024_39A_LIVE_CONTACT_36", { satisfied: "`regx.ei_window.live.satisfied`", why: "§11.1 timer table: '`contact.live.established` in window, or `good_faith_efforts.determined`, or `lossmit.ongoing_contact` active' — three alternatives, one canonical union event `regx.ei_window.live.satisfied{basis}` emitted alongside each (plan.ts recordAttempt/recordInbound and the contact.log tool with `contact.live.established`; windows.ts goodFaithDetermination with `good_faith_efforts.determined`; ops.ts applyOngoingLossmit for the §1024.41 ongoing-contact safe harbor); 'cancelled by installment paid ≤ due, bankruptcy, FDCPA cease, discharge' is the cancellation table." });
  o("REGX_1024_39A_LIVE_CONTACT_36_WARN_28", { satisfied: "`regx.ei_window.live.satisfied`", why: "§11.1 timer table: 'same' as REGX_1024_39A_LIVE_CONTACT_36 — the canonical live-contact/good-faith/ongoing-lossmit satisfier." });
  o("FNMA_D2202_OUTBOUND_START_36", { satisfied: "`contact.attempted{direction=outbound}`", why: "§11.1 timer table: 'first `contact.attempted{direction=outbound}`' (D2-2-02)." });
  o("FNMA_D2202_OUTBOUND_EVERY_7", { satisfied: "`contact.attempted{direction=outbound}`", why: "§11.1 timer table: 'next `contact.attempted`' — the recurring clock re-arms on each outbound attempt (D2-2-02)." });
  o("FNMA_D2202_CEASE_PRE_SALE_30NJ", { evaluator: "11.1.preSaleContactAllowed", why: "§11.1 timer table: outbound attempts blocked from sale − 30 (non-judicial) unless `jurisdiction_rules.contact_required_through_sale` (D2-2-02)." });
  o("FNMA_D2202_CEASE_PRE_SALE_60J", { evaluator: "11.1.preSaleContactAllowed", why: "§11.1 timer table: outbound attempts blocked from sale − 60 (judicial) unless `jurisdiction_rules.contact_required_through_sale` (D2-2-02); 11.1-T16 refuses attempts from 2027-04-16 for a 2027-06-15 sale." });
  o("FNMA_D2202_CONTINUE_AFTER_210", { satisfied: "`contact.attempted{direction=outbound}`", why: "§11.1 timer table: 'same as EVERY_7' — the next outbound attempt." });
  o("REGF_1006_14_POST_CONVERSATION_7", { evaluator: "11.1.postConversationCooloff", why: "§11.1 timer table: consent-based callback exception (`regf_exclusion=consent_within_7d`) or 7 days elapsed (Reg F §1006.14(b)(2)(ii))." });
  o("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE", { satisfied: "`loan.delinquency.window_opened{after_bk_resume=true}`", why: "§11.1 timer table: 'windows re-open from that due date' (§1024.39(c)(2)(i)) — the counter job opens the resumed windows `after_bk_resume=true` (windows.ts resumeAfterBankruptcy / ops.ts counterRun)." });
  o("SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD", { satisfied: "`contact.attempted{mode=human_voice}`", why: "§11.1 timer table: 'human attempt logged (`mode=human_voice`)'." });
  o("TCPA_64_1200_A10_REVOCATION_HONOR_10BD", { satisfied: "`consent.revocation.honored`", why: "§11.1 timer table: 'channel blocked for that number/address' — honored at commit (47 CFR 64.1200(a)(10)); emitted by the preference.set tool, ops.ts smsRevocation and fdcpa.ts receiveCease (oral)." });
  // ---- 11.2
  o("REGX_1024_39B_WRITTEN_NOTICE_45", { satisfied: `\`notice.sent{template∈${EI_VARIANT_TEMPLATES}}\``, why: "§11.2 timer table: '`notice.sent` (EI variant) with `provided_at ≤ due`' — the four EI templates (notice.sent carries `template`); an unrelated notice (payment reminder, statement) never discharges the §1024.39(b) duty." });
  o("REGX_1024_39B_NOTICE_180_REPEAT", { satisfied: `\`notice.sent{template∈${EI_VARIANT_TEMPLATES}}\``, why: "§11.2 timer table: 'next `notice.sent`' — an EI variant (a repeat is itself an EI notice; the standard/bk send starts the next cycle)." });
  o("REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE", { satisfied: `\`notice.sent{template∈${EI_VARIANT_TEMPLATES}}\``, why: "§11.2 timer table: '`notice.sent`' — the transferee's first EI notice (an EI variant template)." });
  o("FNMA_D2204_SOLICITATION_45", { satisfied: "`solicitation_package.sent`", why: "§11.2 timer table: '`solicitation_packages.sent_at` (745 letter or BSP)' — the send event the 11.2 print.request / fnma.action.emit tools produce (D2-2-04)." });
  o("FNMA_D2204_BSP_AFTER_QRPC_3BD", { satisfied: "`solicitation_package.sent{kind=bsp}`", why: "§11.2/11.3 timer tables: '`solicitation_packages{kind=bsp}.sent_at`' (D2-2-04)." });
  o("REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM", { satisfied: "`regx.ei_windows.discharge_rearmed`", why: "§11.2 timer table: (b) re-arms on the first `payment.applied` with `received_on ≥ petition_date` (§1024.39(c)(2)(ii)) — the cross-field test is made by ops.ts postPetitionPayment, which emits `regx.ei_windows.discharge_rearmed{petition_date, received_on}` for the qualifying payment (the 2.1 `payment.applied` payload carries no petition date)." });
  o("REGX_1024_39C_BK_MODIFIED_NOTICE_45", { satisfied: `\`notice.sent{template∈${EI_BK_TEMPLATES}}\``, why: "§11.2 timer table: '`notice.sent{variant ∈ bk, bk_fdcpa}` for this bk_case_id' — the bk-variant templates (notice.sent carries `template`, not `variant`)." });
  o("REGX_1024_39C_ONCE_PER_CASE_GATE", { trigger: `\`notice.sent{template∈${EI_BK_TEMPLATES}}\``, evaluator: "11.2.onceBkNoticePerCase", why: "§11.2 timer table: a second bk notice for the same case (reopened included) is refused (comment 39(c)(2)-1); the 11.2 notice.render tool consults `ei_notice_cycles` for the case." });
  o("REGX_1024_39C_RESUME_NEXT_DUE", { satisfied: "`loan.delinquency.window_opened{after_bk_resume=true}`", why: "§11.2 timer table: 'windows from that due date follow the standard rules' (§1024.39(c)(2)(i))." });
  o("REGX_1024_39D_FDCPA_NOTICE_190", { satisfied: `\`notice.sent{template∈${EI_FDCPA_TEMPLATES}}\``, why: "§11.2 timer table: 'next `notice.sent` (fdcpa variant)'." });
  // ---- 11.3
  o("FNMA_D2210_INSPECTION_SUSPEND_30", { evaluator: "11.3.qrpcWithin30Days", why: "§11.3 timer table: informational gate read by the inspection scheduler — QRPC within the last 30 days on an occupied property (D2-2-10)." });
  o("SM_QRPC_HUMAN_VERIFY_1BD", { satisfied: "`contact.qrpc.reviewed{outcome∈{qrpc_verified, qrpc_rejected}}`", why: "§11.3 timer table: '`qrpc_verified` or `qrpc_rejected` (with human call task)' — emitted by the qrpc.capture tool's human_verify op." });
  o("SM_QRPC_STALE_30", { satisfied: "`contact.qrpc.established`", why: "§11.3 timer table: 'new QRPC, plan active, or resolution' — a fresh QRPC re-arms the recurring policy clock; on maturity (achieved_at + 30, 11.3-T12) the plan re-activates." });
  // ---- 11.4
  o("REGF_1006_100_RETENTION_3Y", { satisfied: "`records.retention.expired{class=regf_3y}`", why: "§11.4 timer table: retention rule — subsumed by `life_of_loan_plus_4y` (Reg F §1006.100); emitted by fdcpa.ts retentionSweep." });
  o("REGF_1006_30A_FURNISH_GATE_14", { satisfied: "`fdcpa.furnishing_gate.opened`", why: "§11.4 timer table: '`furnishing_gate_open_at` set' (Reg F §1006.30(a)); emitted by fdcpa.ts on a conversation or 14 days after mailing." });
  o("REGF_1006_34_VALIDATION_NOTICE_5D", { satisfied: "`notice.sent{template=NTC_REGF_1006_34_VALIDATION_B1}`", why: "§11.4 timer table: '`notice.sent{NTC_REGF_1006_34_VALIDATION_B1}` (in the initial communication or after)' — notice.sent carries the template code (Reg F §1006.34(a)(1)(i))." });
  o("REGF_1006_34_ASSUMED_RECEIPT_5D", { satisfied: "`fdcpa.validation_notice.assumed_received`", why: "§11.4 timer table: rule row — `assumed_receipt_on` computed (Reg F §1006.34(b)(5))." });
  o("REGF_1006_34_VALIDATION_PERIOD_30", { satisfied: "`fdcpa.validation_period.ended`", why: "§11.4 timer table: 'period end' (Reg F §1006.34(b)(5)); emitted by fdcpa.ts fdcpaSweep." });
  o("REGF_1006_38_DISPUTE_CEASE_GATE", { satisfied: "`notice.sent{template∈{NTC_REGF_1006_38_VERIFICATION, NTC_REGF_1006_38_DUPLICATIVE}}`", why: "§11.4 timer table: '`fdcpa_disputes.verification_sent`' — the verification (or duplicative-dispute) notice actually sent lifts the cease (Reg F §1006.38(c)-(d)); 11.4-T5: collection resumes when verification mails." });
  o("REGF_1006_38_OC_REQUEST_GATE", { satisfied: "`notice.sent{template=NTC_REGF_1006_38_ORIGINAL_CREDITOR}`", why: "§11.4 timer table: '`NTC_REGF_1006_38_ORIGINAL_CREDITOR` sent' (Reg F §1006.38(c))." });
  o("REGF_1006_6B2_ATTORNEY_GATE", { satisfied: "`fdcpa.attorney_gate.released{reason∈{consent, nonresponse_30d}}`", why: "§11.4 timer table: 'until attorney consents or fails to respond for 30 calendar days' (Reg F §1006.6(b)(2)); emitted by fdcpa.ts attorneyGateReview." });
  o("REGF_1006_6C_CEASE_GATE", { satisfied: "`fdcpa.cease.withdrawn{written=true}`", why: "§11.4 timer table: 'permanent (unless withdrawn in writing)' (Reg F §1006.6(c)); emitted by fdcpa.ts withdrawCease." });
  o("SM_REGF_VERIFICATION_RESPONSE_30", { satisfied: "`notice.sent{template=NTC_REGF_1006_38_VERIFICATION}`", why: "§11.4 timer table: 'verification sent'." });
  // ---- 11.5
  o("FNMA_D2101_FORM182_ADVERSE_30", { satisfied: "`notice.sent{template=NTC_FNMA_A42106_FORM182_ADVERSE_ACTION}`", why: "§11.5 timer table: '`NTC_FNMA_A42106_FORM182_ADVERSE_ACTION` sent' (D2-1-01)." });
  o("FNMA_D2205_ACCEPT_14", { satisfied: "`lossmit.offer.accepted`", why: "§11.5 timer table (12.2 owns): 'acceptance (verbal/written/payment)' (D2-2-05); emitted by imminent-default.ts offerAccepted." });
  o("FNMA_D2205_DECISION_5D_30D", { satisfied: `\`notice.sent{template∈${EVALUATION_NOTICE_TEMPLATES}}\``, why: "§11.5 timer table (12.2 owns): 'Evaluation Notice' — the 12.2 evaluation-notice templates or the 11.5 Form 182 for a declined current borrower (D2-2-05)." });
  o("FNMA_D2205_INCOME_DOC_90", { evaluator: "11.5.incomeDocsFresh", why: "§11.5 timer table: validation — oldest income document ≤90 days at `brp_complete_at` (180 disaster) (D2-2-05)." });
  o("FNMA_SMDU_PORTAL_TASK_1BD", { satisfied: "`human_portal_task.completed{kind=smdu, decision_attached=true}`", why: "§11.5 timer table: 'task completed with decision attached' — ops.ts completePortalTask emits it only when the decision PDF is attached (11.5-T12)." });
  o("REGB_1002_9_ADVERSE_ACTION_30", { satisfied: `\`notice.sent{template∈${ADVERSE_ACTION_TEMPLATES}}\``, why: "§11.5 timer table: 'adverse-action notice (combined with Form 182 / 12.2 denial notice)' (Reg B §1002.9) — rule 8: Form 182 for a current borrower; for a delinquent-but-<60-day borrower the 12.2 denial notice (NTC_REGX_41C1_DENIAL) carries the same content; 12.2's NTC_REGB_1002_9_LM_ADVERSE_ACTION is the Reg B template." });
  o("REGX_1024_41B2_LM_ACK_5", { satisfied: "`notice.sent{template∈{NTC_REGX_41B2_ACK_COMPLETE, NTC_REGX_41B2_ACK_INCOMPLETE}}`", why: "§11.5 timer table (12.1 owns): 'acknowledgment sent' (§1024.41(b)(2))." });
  o("REGX_1024_41C1_EVALUATE_30", { satisfied: `\`notice.sent{template∈${EVALUATION_NOTICE_TEMPLATES}}\``, why: "§11.5 timer table (12.2 owns): 'evaluation notice sent' (§1024.41(c)(1))." });
  o("SM_ID_REVIEWER_SLA_2BD", { satisfied: "`lossmit.decision.reviewed`", why: "§11.5 timer table: '`lossmit.decision.reviewed`' — emitted by imminent-default.ts reviewerDecision." });
  o("SM_ID_SMDU_SUBMIT_2BD", { satisfied: "`smdu.submission.acknowledged`", why: "§11.5 timer table: 'SMDU ack / portal task complete' — emitted by imminent-default.ts smduSubmission on the B2B acknowledgment." });
}

// ---- "cancelled by" columns -------------------------------------------------------------------------

export interface TimerCancellation {
  readonly code: string;
  /** Event pattern (registry grammar) that cancels the armed instances of `code` for the event's loan. */
  readonly on: string;
  readonly reason: string;
  readonly why: string;
  /** Narrows to specific instances (e.g. the window whose installment was paid); default: every armed/breached instance for the loan. */
  readonly select?: (inst: TimerInstance, e: DomainEvent) => boolean;
}
type Payload = Record<string, unknown>;
/** Comment 39(a)-1: the missed installment paid on/before the leg's deadline removes that window's duty — `payment.applied{installment_due_date, credited_as_of}` (2.1) names the window by its due date. */
/** The day-28 warning is cancelled with its window ("same" column): the installment paid on/before the day-36 deadline (anchor + 36), not the warning's own due date — 11.1-T3 pays on day 28–31 and no REGX_1024_39A_* clock may breach. */
const paidBeforeLiveDue = (inst: TimerInstance, e: DomainEvent): boolean => {
  const p = e.payload as Payload;
  if (typeof p.installment_due_date !== "string" || p.installment_due_date !== inst.anchorDate) return false;
  const credited = typeof p.credited_as_of === "string" ? p.credited_as_of.slice(0, 10) : e.occurredAt.slice(0, 10);
  return credited <= addDays(inst.anchorDate, 36);
};
const paidBeforeDue = (inst: TimerInstance, e: DomainEvent): boolean => {
  const p = e.payload as Payload;
  if (typeof p.installment_due_date !== "string" || p.installment_due_date !== inst.anchorDate) return false;
  const credited = typeof p.credited_as_of === "string" ? p.credited_as_of.slice(0, 10) : e.occurredAt.slice(0, 10);
  return inst.dueDate === undefined || credited <= inst.dueDate;
};

export const EARLY_INTERVENTION_CANCELLATIONS: readonly TimerCancellation[] = [
  // 11.1 REGX_1024_39A_LIVE_CONTACT_36 (+ the day-28 warning): "cancelled by installment paid ≤ due, bankruptcy, FDCPA cease, discharge"
  { code: "REGX_1024_39A_LIVE_CONTACT_36", on: "`payment.applied`", select: paidBeforeDue, reason: "paid_before_36", why: "§11.1 timer table / comment 39(a)-1: the missed installment paid on or before day 36 removes the duty (11.1-T3 rolling delinquency never breaches)." },
  { code: "REGX_1024_39A_LIVE_CONTACT_36_WARN_28", on: "`payment.applied`", select: paidBeforeLiveDue, reason: "paid_before_36", why: "§11.1 timer table: 'same' — the warning falls with its window when the installment is paid on/before day 36 (rule 4: the rolling borrower's windows are cancelled on day 28–31)." },
  { code: "REGX_1024_39A_LIVE_CONTACT_36", on: "`bankruptcy.petition.filed`", reason: "exempt_bk", why: "§1024.39(c)(1)(i): no live contact while any borrower is a debtor (11.1-T7)." },
  { code: "REGX_1024_39A_LIVE_CONTACT_36_WARN_28", on: "`bankruptcy.petition.filed`", reason: "exempt_bk", why: "§1024.39(c)(1)(i)." },
  { code: "REGX_1024_39A_LIVE_CONTACT_36", on: "`fdcpa.cease.received{written=true}`", reason: "exempt_fdcpa_cease", why: "§1024.39(d)(1): a servicer subject to the FDCPA is exempt from (a) after a §805(c) cease (11.4-T7)." },
  { code: "REGX_1024_39A_LIVE_CONTACT_36_WARN_28", on: "`fdcpa.cease.received{written=true}`", reason: "exempt_fdcpa_cease", why: "§1024.39(d)(1)." },
  { code: "REGX_1024_39A_LIVE_CONTACT_36", on: "`bankruptcy.status.changed{to=discharged}`", reason: "exempt_discharge", why: "§1024.39(c)(2)(ii): after a discharge (a) never resumes (11.1-T8)." },
  { code: "REGX_1024_39A_LIVE_CONTACT_36_WARN_28", on: "`bankruptcy.status.changed{to=discharged}`", reason: "exempt_discharge", why: "§1024.39(c)(2)(ii)." },
  // 11.2 REGX_1024_39B_WRITTEN_NOTICE_45: "cancelled by installment paid ≤ due, bk/fdcpa exemptions"
  { code: "REGX_1024_39B_WRITTEN_NOTICE_45", on: "`payment.applied`", select: paidBeforeDue, reason: "paid_before_45", why: "§11.2 timer table / comment 39(b)(1)-1: paid before day 45 → no notice (11.2-T2)." },
  { code: "REGX_1024_39B_WRITTEN_NOTICE_45", on: "`bankruptcy.petition.filed`", reason: "bk_modified_required", why: "§1024.39(c)(1)(iii): from the petition the (b) duty is the one modified notice per case, clocked by REGX_1024_39C_BK_MODIFIED_NOTICE_45 'regardless of' the window (11.2 rule 5)." },
  { code: "REGX_1024_39B_WRITTEN_NOTICE_45", on: "`bankruptcy.status.changed{to=discharged}`", reason: "exempt_discharge", why: "§1024.39(c)(2)(ii): (b) resumes only on a post-petition payment (REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM)." },
  { code: "REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE", on: "`payment.applied`", select: paidBeforeDue, reason: "cured_before_due", why: "§11.2 timer table: '+45 calendar_days if still delinquent' — the first post-transfer installment paid ≤ due ends the duty." },
  // 11.2 cycle rows: the nightly cycle-end review moves the duty to the window timer when <45 days delinquent at cycle end
  { code: "REGX_1024_39B_NOTICE_180_REPEAT", on: "`regx.ei_cycle.reviewed{repeat_required=false}`", reason: "lt45_at_cycle_end", why: "§1024.39(b)(1): <45 days delinquent at the end of the 180-day period → due 45 days after the payment due date for which the borrower remains delinquent (that window's REGX_1024_39B_WRITTEN_NOTICE_45); 11.2 rule 3 / 11.2-T4." },
  { code: "REGX_1024_39D_FDCPA_NOTICE_190", on: "`regx.ei_cycle.reviewed{repeat_required=false}`", reason: "lt45_at_cycle_end", why: "§1024.39(d)(3)(iii): <45 days delinquent at the end of the 180 days → the later of (45 days after the due date for which the borrower remains delinquent) and +190; the window timer carries the later date." },
  // 11.5 FNMA_D2101_FORM182_ADVERSE_30: "(no accepted counteroffer)"
  { code: "FNMA_D2101_FORM182_ADVERSE_30", on: "`lossmit.offer.accepted{within_window=true, kind=counteroffer}`", reason: "counteroffer_accepted", why: "D2-1-01: Form 182 is due 'unless it offers a counteroffer the borrower accepts' (11.5-T8)." },
];

const isString = (x: unknown): x is string => typeof x === "string";

/** Cancel the armed/breached instances of `codes` for one loan (the command-boundary helper the §11 tools use, and the reader below). */
export function cancelEarlyInterventionTimers(engine: TimerEngine, loanId: string | undefined, codes: readonly string[], reason: string, actor: Actor = SYSTEM, select?: (inst: TimerInstance) => boolean): TimerInstance[] {
  if (!loanId) return [];
  const out: TimerInstance[] = [];
  for (const inst of engine.forSubject("loan", loanId)) {
    if (!codes.includes(inst.code) || (inst.status !== "armed" && inst.status !== "breached")) continue;
    if (select && !select(inst)) continue;
    engine.cancel(inst.id, reason, actor); out.push(inst);
  }
  return out;
}

/**
 * The recurring step for the §11 recurring clocks (FNMA_D2202_OUTBOUND_EVERY_7, FNMA_D2202_CONTINUE_AFTER_210,
 * SM_QRPC_STALE_30). The kernel engine's `onEvent` satisfies-and-re-arms a recurring instance while iterating its
 * instance list in place, so the re-armed instance is visited and satisfied by the same event without end. This guard
 * subscribes BEFORE the engine (subscription order is delivery order): it marks the armed instance satisfied, records
 * `timer.satisfied`, and re-arms the next occurrence only when the event is not also the trigger (the engine then arms
 * exactly one next instance by trigger). Harmless once the kernel iterates a snapshot.
 */
export function attachEarlyInterventionRecurringGuard(events: EventStore, engine: () => TimerEngine, actor: Actor = SYSTEM): () => void {
  return events.subscribe("*", (e) => {
    if (!e.loanId || e.type.startsWith("timer.")) return;
    const eng = engine(); if (!eng) return;
    for (const inst of [...eng.forSubject("loan", e.loanId)]) {
      if (inst.status !== "armed" && inst.status !== "breached") continue;
      const def = eng ? RECURRING_DEFS(eng).get(inst.code) : undefined;
      if (!def || !def.satisfiedPattern || !eventMatches(def.satisfiedPattern, e)) continue;
      const late = inst.status === "breached";
      inst.satisfiedAt = e.occurredAt; inst.satisfiedByEventId = e.id; inst.status = late ? "satisfied_late" : "satisfied";
      events.append({ type: "timer.satisfied", loanId: e.loanId, actor, causationId: e.id, payload: { code: inst.code, timer_id: inst.id, late, recurring: true } });
      if (!(def.triggerPattern && eventMatches(def.triggerPattern, e))) eng.arm(def, e, { subjectOverride: inst.subject });
    }
  });
}
const RECURRING_CACHE = new WeakMap<TimerEngine, Map<string, TimerDef>>();
function RECURRING_DEFS(eng: TimerEngine): Map<string, TimerDef> {
  let m = RECURRING_CACHE.get(eng);
  if (!m) { m = new Map(); for (const d of (eng as unknown as { registry: TimerRegistry }).registry.unique()) if (d.kindNorm === "recurring" && d.process.startsWith("11.")) m.set(d.code, d); RECURRING_CACHE.set(eng, m); }
  return m;
}

/**
 * Applies the "cancelled by" columns: every event is matched against `EARLY_INTERVENTION_CANCELLATIONS`, and any event
 * carrying `cancel_timers: string[]` (plan.ts cease/suspend/close, imminent-default.ts offerAccepted) cancels those codes
 * for its loan. Wire it wherever the loan's TimerEngine is built (the unit of work), after the engine subscribes.
 */
export function attachEarlyInterventionTimerCancellations(engine: TimerEngine, events: EventStore, actor: Actor = SYSTEM): () => void {
  const rules = EARLY_INTERVENTION_CANCELLATIONS.map((r) => { const pattern = parseEventPattern(r.on); if (!pattern) throw new TypeError(`bad cancellation pattern ${r.on}`); return { ...r, pattern: pattern as EventPattern }; });
  return events.subscribe("*", (e) => {
    if (!e.loanId || e.type.startsWith("timer.")) return;
    for (const r of rules) if (eventMatches(r.pattern, e)) cancelEarlyInterventionTimers(engine, e.loanId, [r.code], r.reason, actor, r.select ? (inst) => r.select!(inst, e) : undefined);
    const ct = (e.payload as Payload).cancel_timers;
    if (Array.isArray(ct) && ct.some(isString)) cancelEarlyInterventionTimers(engine, e.loanId, ct.filter(isString), `${e.type}${typeof (e.payload as Payload).reason === "string" ? `{${String((e.payload as Payload).reason)}}` : ""}`, actor);
  });
}
