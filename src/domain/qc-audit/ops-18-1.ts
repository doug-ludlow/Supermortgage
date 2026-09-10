/**
 * §18.1 Internal QC plan — the rules the first cut (./ops.ts) does not cover:
 * the engines behind the six re-derivation tools the Agents paragraph names
 * (`ledger.recompute` = independent C-1.1-01 allocation order,
 * `escrow.recompute_analysis` = an independent Appendix E cushion with the 1/6 cap
 * (never the production `cushion()` — a QC rederive that calls the engine under
 * test cannot see the engine's defect),
 * `arm.second_engine` = 7.2's engine B `verifyArmAdjustment` (arm-verify.ts,
 * BigInt fixed-point, shares nothing with engine A `computeArmAdjustment` —
 * spec 7.2: "an independently implemented `verifyArmAdjustment` (engine B,
 * different code path/library)"),
 * `notice.checklist`, `timers.history`, `investor_events.replay`); the AI-off
 * cycle run of T12; the satisfaction events behind `SM_QC_CAPA_SEV1_10BD`,
 * `SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE` and `SM_QC_CONSUMER_REMEDIATION_30`;
 * the Fannie Mae QC-results request clock and the CSBS external-audit row;
 * the rule-C remediation ledger draft the owning agent posts; and, from the
 * fix pass: the seeded/hashed draw and cycle window (T1), the finding state
 * machine with the root-cause gate and the money-finding dossier (T2, T3), the
 * CAPA / report / vendor clocks with their events (T4–T6), the AI version
 * state machine behind `SM_AI_EVAL_GATE` (T7), the fairness test and its
 * counsel route (T8), the disclosure package (T9), the `qc_audit` DB-role
 * mirror (T10), the kill-switch and human-path check (T11) and the annual
 * governance clocks (policy review, plan re-approval, ISBR, Colorado impact
 * assessment, AFS receipt).
 */
import { type PlainDate, addDays, addMonths, endOfMonth, startOfMonth, ymd, parts, min as minDate } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, businessDaysBetween, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EventStore, EventInput, DomainEvent, Actor } from "../../kernel/events/index.ts";
import type { CushionInputs } from "../escrow/analysis.ts";
import type { RateInputs, RateBound } from "../notices/arm.ts";
import { verifyArmAdjustment, parseRate8, roundToEighth8 } from "../notices/arm-verify.ts";
import type { ChecklistResult } from "../../notices/checklist.ts";
import { sampleSize, seededDraw, targeted, errorRate, toleranceBreached, TOLERANCE, type RuleFamily, type TargetedFlags, type ErrorRate } from "./sampling.ts";
import { rederiveTest, sha256, type RederiveRow } from "./ops.ts";
import { fairnessScreen } from "./findings.ts";

// ============================================================ rule A: rederive engines
export type AllocationBucket = "interest" | "principal" | "escrow" | "late_charge";
export interface BucketCents { readonly interest_cents: Cents; readonly principal_cents: Cents; readonly escrow_cents: Cents; readonly late_charge_cents: Cents; }
/** C-1.1-01 application order (2.1 rule 5): uniform instruments interest → principal → escrow → late charge; pre-1999 instruments escrow first. */
export const C1101_ORDER: Readonly<Record<"uniform_1999_plus" | "pre_1999", readonly AllocationBucket[]>> = { uniform_1999_plus: ["interest", "principal", "escrow", "late_charge"], pre_1999: ["escrow", "interest", "principal", "late_charge"] };
const bucketKey = (b: AllocationBucket): keyof BucketCents => `${b}_cents`;
/** Rule A `QC_PAY_ALLOCATION_RECOMPUTE`: an independent waterfall over the amounts due; `variance_cents` is the money the production engine put in the wrong bucket (sum of over-applications). */
export function rederivePaymentAllocation(i: { subject_id: string; profile?: "uniform_1999_plus" | "pre_1999"; amount_cents: Cents; due: BucketCents; observed: BucketCents & { suspense_cents?: Cents } }): RederiveRow & { readonly expected_allocation: BucketCents & { suspense_cents: Cents }; readonly misapplied: { bucket: AllocationBucket | "suspense"; expected_cents: Cents; observed_cents: Cents }[] } {
  const order = C1101_ORDER[i.profile ?? "uniform_1999_plus"];
  let left = i.amount_cents;
  const exp: Record<keyof BucketCents, Cents> = { interest_cents: 0n, principal_cents: 0n, escrow_cents: 0n, late_charge_cents: 0n };
  for (const b of order) { const k = bucketKey(b); const take = i.due[k] < left ? i.due[k] : left; exp[k] = take < 0n ? 0n : take; left -= exp[k]; }
  const expected_allocation = { ...exp, suspense_cents: left };
  const misapplied: { bucket: AllocationBucket | "suspense"; expected_cents: Cents; observed_cents: Cents }[] = [];
  let over = 0n;
  for (const b of order) { const k = bucketKey(b); if (i.observed[k] !== exp[k]) { misapplied.push({ bucket: b, expected_cents: exp[k], observed_cents: i.observed[k] }); if (i.observed[k] > exp[k]) over += i.observed[k] - exp[k]; } }
  const obsSusp = i.observed.suspense_cents ?? 0n;
  if (obsSusp !== left) { misapplied.push({ bucket: "suspense", expected_cents: left, observed_cents: obsSusp }); if (obsSusp > left) over += obsSusp - left; }
  const row = rederiveTest("QC_PAY_ALLOCATION_RECOMPUTE", "payment", i.subject_id, 0n, over, { expected: { order, ...expected_allocation }, observed: { ...i.observed, suspense_cents: obsSusp } });
  return { ...row, expected_allocation, misapplied };
}

export type CushionSource = "policy" | "instrument" | "state";
/**
 * Independent Appendix E cushion (Reg X §1024.17(c)(1)(ii): "one-sixth of the estimated total annual payments";
 * a lower instrument or state limit governs): a months-based limit is floor(annual × months ÷ 12), a dollar
 * instrument limit is taken as stated; every candidate is capped at floor(annual ÷ 6). Written without the escrow
 * engine's `cushion()` so a defect there (the spec's 1/4-for-1/6 example) shows as a variance instead of being reproduced.
 */
export function appendixECushion(annual: Cents, c: CushionInputs = {}): { cents: Cents; months: number; source: CushionSource; cap_cents: Cents } {
  if (annual < 0n) throw new RangeError("annual disbursements must be ≥ 0");
  const cap_cents = annual / 6n;
  if (c.instrument_dollars_cents !== undefined && c.instrument_dollars_cents !== null) return { cents: c.instrument_dollars_cents <= cap_cents ? c.instrument_dollars_cents : cap_cents, months: 0, source: "instrument", cap_cents };
  let months = c.policy_months ?? 2; let source: CushionSource = "policy";
  if (c.instrument_months !== undefined && c.instrument_months !== null && c.instrument_months < months) { months = c.instrument_months; source = "instrument"; }
  if (c.state_max_months !== undefined && c.state_max_months !== null && c.state_max_months < months) { months = c.state_max_months; source = "state"; }
  const hundredths = BigInt(Math.round(months * 100));                      // months may be fractional (e.g. 1.5)
  const byMonths = (annual * hundredths) / 1200n;                            // floor(annual × months ÷ 12)
  return { cents: byMonths <= cap_cents ? byMonths : cap_cents, months, source, cap_cents };
}
/** Rule A/C `QC_ESCROW_ANALYSIS_RECOMPUTE`: the cushion re-derived from annual disbursements under Appendix E (policy 2 months, never above 1/6) by `appendixECushion` — not by the production engine — against the analysis's figure. */
export function rederiveEscrowCushion(i: { subject_id: string; annual_disbursements_cents: Cents; observed_cushion_cents: Cents; cushion?: CushionInputs }): RederiveRow & { readonly expected_cushion: ReturnType<typeof appendixECushion> } {
  const c = appendixECushion(i.annual_disbursements_cents, i.cushion ?? {});
  const row = rederiveTest("QC_ESCROW_ANALYSIS_RECOMPUTE", "escrow_analysis", i.subject_id, c.cents, i.observed_cushion_cents, { expected: { months: c.months, source: c.source, cap_cents: c.cap_cents, annual_disbursements_cents: i.annual_disbursements_cents }, observed: { fraction_of_annual: Number(i.observed_cushion_cents) / Number(i.annual_disbursements_cents) } });
  return { ...row, expected_cushion: c };
}

export interface SecondEngineRate { readonly new_rate_pct: string; readonly unrounded_pct: string; readonly bound: RateBound; readonly midpoint_flag: boolean; readonly engine: "B"; }
/**
 * Rule A `QC_ARM_ADJ_RECOMPUTE` ("rederive vs second engine (7.2)"): 7.2's engine B `verifyArmAdjustment` — the
 * BigInt fixed-point implementation that shares nothing with engine A `computeArmAdjustment` (the engine production
 * ran) — re-derives the rate (index + margin, 1/8 rounding, caps, floor) and the level payment; a rate mismatch fails
 * even when the payment happens to agree. Rates are compared as engine B parses them (8-place integers), not as Decimals.
 */
export function rederiveArmAdjustment(i: { subject_id: string; rate: RateInputs; expected_upb_cents: Cents; remaining_term: number; interest_only?: boolean; observed: { new_rate_pct: string; payment_cents: Cents } }): RederiveRow & { readonly expected_rate: SecondEngineRate; readonly rate_matches: boolean; readonly cap_bound: boolean } {
  const b = verifyArmAdjustment({ ...i.rate, expected_upb_cents: i.expected_upb_cents, remaining_term_months: i.remaining_term, ...(i.interest_only !== undefined ? { interest_only: i.interest_only } : {}) });
  const midpoint_flag = roundToEighth8(parseRate8(i.rate.index_pct) + parseRate8(i.rate.margin_pct), i.rate.rounding ?? "half_down").midpoint;
  const r: SecondEngineRate = { new_rate_pct: b.new_rate_pct, unrounded_pct: b.unrounded_pct, bound: b.bound, midpoint_flag, engine: "B" };
  const rate_matches = parseRate8(r.new_rate_pct) === parseRate8(i.observed.new_rate_pct);
  const row = rederiveTest("QC_ARM_ADJ_RECOMPUTE", "loan", i.subject_id, b.new_pi_cents, i.observed.payment_cents, { expected: { engine: "B", new_rate_pct: r.new_rate_pct, unrounded_pct: r.unrounded_pct, bound: r.bound, midpoint_flag }, observed: { new_rate_pct: i.observed.new_rate_pct } });
  return { ...row, result: rate_matches && row.variance_cents === 0n ? "pass" : "fail", expected_rate: r, rate_matches, cap_bound: r.bound !== "none" };
}

export interface ChecklistTestRow { readonly rule_code: "QC_NOTICE_CONTENT_CHECKLIST"; readonly subject_type: "notice"; readonly subject_id: string; readonly template_code: string; readonly template_version: string; readonly result: "pass" | "fail"; readonly expected: { blocking: 0 }; readonly observed: { blocking: number; warnings: number; failed_rule_ids: string[] }; readonly variance_cents: null; readonly reviewer_kind: "engine"; }
/** Rule A `QC_NOTICE_CONTENT_CHECKLIST`: a rendered notice is a pass only when its registry checklist has no blocking failure. */
export function noticeChecklistTest(i: { subject_id: string; template_code: string; checklist: ChecklistResult }): ChecklistTestRow {
  return { rule_code: "QC_NOTICE_CONTENT_CHECKLIST", subject_type: "notice", subject_id: i.subject_id, template_code: i.template_code, template_version: i.checklist.template_version, result: i.checklist.blocking.length === 0 ? "pass" : "fail", expected: { blocking: 0 }, observed: { blocking: i.checklist.blocking.length, warnings: i.checklist.warnings.length, failed_rule_ids: i.checklist.results.filter((r) => !r.passed && !r.skipped).map((r) => r.rule_id) }, variance_cents: null, reviewer_kind: "engine" };
}

export interface TimerInstanceLike { readonly id: string; readonly code: string; readonly status: string; readonly dueAt?: number | undefined; readonly dueDate?: PlainDate | undefined; readonly satisfiedAt?: string | undefined; readonly satisfiedByEventId?: string | undefined; readonly breachedAt?: string | undefined; readonly armedAt: string; readonly armedByEventId: string; }
export interface TimerHistoryRow { readonly id: string; readonly code: string; readonly status: string; readonly armed_at: string; readonly due_date: PlainDate | null; readonly satisfied_at: string | null; readonly satisfied_by_event_id: string | null; readonly breached_at: string | null; readonly on_time: boolean | null; readonly events: { id: string; type: string; occurred_at: string }[]; }
/** Rule A `QC_NOTICE_TIMING` / evidence: the immutable timer history — armed, due, satisfied/breached and whether satisfaction beat the due instant. */
export function timerHistory(instances: readonly TimerInstanceLike[], events: readonly { id: string; type: string; occurredAt: string; payload: Record<string, unknown> }[] = []): { rows: TimerHistoryRow[]; late_or_breached: string[]; result: "pass" | "fail" } {
  const rows = instances.map((t) => {
    const onTime = t.satisfiedAt ? (t.dueAt === undefined ? true : Date.parse(t.satisfiedAt) <= t.dueAt) : t.status === "breached" || t.status === "satisfied_late" ? false : null;
    return { id: t.id, code: t.code, status: t.status, armed_at: t.armedAt, due_date: t.dueDate ?? null, satisfied_at: t.satisfiedAt ?? null, satisfied_by_event_id: t.satisfiedByEventId ?? null, breached_at: t.breachedAt ?? null, on_time: onTime, events: events.filter((e) => e.payload.timer_id === t.id || e.id === t.armedByEventId || e.id === t.satisfiedByEventId).map((e) => ({ id: e.id, type: e.type, occurred_at: e.occurredAt })) };
  });
  const late = rows.filter((r) => r.on_time === false).map((r) => r.id);
  return { rows, late_or_breached: late, result: late.length === 0 ? "pass" : "fail" };
}

export interface ReplayedInvestorEvent { readonly id: string; readonly type: string; readonly occurred_at: string; readonly sequence: number; readonly status: "sent" | "accepted" | "rejected" | "corrected" | "other"; readonly ref: string | null; }
/** Rule A `QC_INVESTOR_EVENT_TIMELINESS`: replay the loan's investor-event log in sequence; every rejection must be followed by a correction or acceptance for the same reference. */
export function replayInvestorEvents(i: { loan_id: string; events: readonly { id: string; type: string; occurredAt: string; sequence: number; payload: Record<string, unknown> }[] }): { loan_id: string; timeline: ReplayedInvestorEvent[]; counts: Record<ReplayedInvestorEvent["status"], number>; open_rejections: string[]; result: "pass" | "fail" } {
  const statusOf = (type: string): ReplayedInvestorEvent["status"] => /\.(sent|submitted|transmitted)$/.test(type) ? "sent" : /\.accepted$/.test(type) ? "accepted" : /\.rejected(_soft|_hard)?$/.test(type) ? "rejected" : /\.(corrected|resubmitted)$/.test(type) ? "corrected" : "other";
  const timeline = [...i.events].filter((e) => /^(investor_event|lar|remittance)\./.test(e.type)).sort((a, b) => a.sequence - b.sequence)
    .map((e) => ({ id: e.id, type: e.type, occurred_at: e.occurredAt, sequence: e.sequence, status: statusOf(e.type), ref: typeof e.payload.event_id === "string" ? e.payload.event_id : typeof e.payload.lar_id === "string" ? e.payload.lar_id : null }));
  const counts: Record<ReplayedInvestorEvent["status"], number> = { sent: 0, accepted: 0, rejected: 0, corrected: 0, other: 0 };
  const open = new Map<string, string>();
  for (const e of timeline) { counts[e.status] += 1; const key = e.ref ?? e.id; if (e.status === "rejected") open.set(key, e.id); else if ((e.status === "corrected" || e.status === "accepted") && e.ref) open.delete(e.ref); }
  const open_rejections = [...open.values()];
  return { loan_id: i.loan_id, timeline, counts, open_rejections, result: open_rejections.length === 0 ? "pass" : "fail" };
}

// ============================================================ T12: the AI-off cycle run
export interface CycleRun { readonly ai_off: boolean; readonly rederive_results: readonly { subject_id: string; result: "pass" | "fail"; variance_cents: Cents; reviewer_kind: "engine" }[]; readonly judgment: { readonly population_n: number; readonly n: number; readonly selection_seed: number; readonly sample_ids: readonly string[]; readonly reviewer_kind: "human" | "llm"; readonly queue: "ops_console_qc_workbench" | "llm_judgment"; readonly human_review_below_confidence: 0.85 }; }
/** Rule B + AI-off path: census rederives are engine-only either way; the judgment draw (seeded) keeps its n and its members, only the reviewer changes — human workbench when the flag is set. */
export function runCycle(i: { ai_off: boolean; population_ids: readonly string[]; selection_seed: number; rederive: readonly { subject_id: string; expected: Cents; observed: Cents }[] }): CycleRun {
  const N = i.population_ids.length; const n = sampleSize(N);
  return {
    ai_off: i.ai_off,
    rederive_results: i.rederive.map((r) => ({ subject_id: r.subject_id, result: r.observed - r.expected === 0n ? "pass" : "fail", variance_cents: r.observed - r.expected, reviewer_kind: "engine" })),
    judgment: { population_n: N, n, selection_seed: i.selection_seed, sample_ids: seededDraw(i.population_ids, n, i.selection_seed), reviewer_kind: i.ai_off ? "human" : "llm", queue: i.ai_off ? "ops_console_qc_workbench" : "llm_judgment", human_review_below_confidence: 0.85 },
  };
}

// ============================================================ timer-table satisfaction events
export type FindingSeverity = "sev1_consumer_harm_or_fnma_breach" | "sev2_rule_breach_no_harm" | "sev3_documentation" | "sev4_observation";
export interface Capa { readonly id: string; readonly action_kind: string; readonly status: "open" | "in_progress" | "completed"; readonly completed_on?: PlainDate | null; }
/** `SM_QC_CAPA_SEV1_10BD` / `_SEV2_30` / `_SEV3_90` satisfy on "all CAPAs `completed`": the last completion emits `qc.finding.capas_completed`; breach of the sev-1 clock escalates to the officer and the partner. */
export function capaCompletion(i: { finding_id: string; severity: FindingSeverity; validated_on: PlainDate; capas: readonly Capa[]; today: PlainDate; cal?: Calendar }): { all_completed: boolean; open_capa_ids: string[]; timer: { code: "SM_QC_CAPA_SEV1_10BD" | "SM_QC_CAPA_SEV2_30" | "SM_QC_CAPA_SEV3_90"; due: PlainDate }; breached: boolean; event: { type: "qc.finding.capas_completed"; finding_id: string; severity: FindingSeverity; completed_on: PlainDate } | null; escalations: { kind: "officer" | "partner"; reason: string }[] } {
  const cal = i.cal ?? servicer;
  const timer = i.severity === "sev1_consumer_harm_or_fnma_breach" ? { code: "SM_QC_CAPA_SEV1_10BD" as const, due: addBusinessDays(i.validated_on, 10, cal) } : i.severity === "sev2_rule_breach_no_harm" ? { code: "SM_QC_CAPA_SEV2_30" as const, due: addDays(i.validated_on, 30) } : { code: "SM_QC_CAPA_SEV3_90" as const, due: addDays(i.validated_on, 90) };
  const open = i.capas.filter((c) => c.status !== "completed").map((c) => c.id);
  const all = i.capas.length > 0 && open.length === 0;
  const completedOn = all ? i.capas.map((c) => c.completed_on ?? i.today).reduce((a, b) => (b > a ? b : a)) : null;
  const breached = !all && i.today > timer.due;
  const escalations: { kind: "officer" | "partner"; reason: string }[] = breached ? [{ kind: "officer", reason: `${timer.code} breached: CAPA ${open.join(", ")} on finding ${i.finding_id} not completed by ${timer.due}` }] : [];
  if (breached && timer.code === "SM_QC_CAPA_SEV1_10BD") escalations.push({ kind: "partner", reason: `sev-1 finding ${i.finding_id}: CAPA overdue since ${timer.due} — partner notified (subservicing agreement QC clause)` });
  return { all_completed: all, open_capa_ids: open, timer, breached, event: all && completedOn ? { type: "qc.finding.capas_completed", finding_id: i.finding_id, severity: i.severity, completed_on: completedOn } : null, escalations };
}

/** `SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE`: the re-test at the next cycle close emits `qc.capa.effectiveness_tested{result}`; a failed re-test reopens the finding. */
export function effectivenessCheck(i: { finding_id: string; capa_id: string; completed_on: PlainDate; next_cycle_close_on: PlainDate; retest: { fails: number; passes: number; family: RuleFamily } }): { anchor: { field: "next_cycle_close_on"; on: PlainDate }; result: "pass" | "fail"; event: { type: "qc.capa.effectiveness_tested"; finding_id: string; capa_id: string; result: "pass" | "fail"; cycle_close_on: PlainDate }; finding_status: "closed" | "reopened" } {
  const result = toleranceBreached(i.retest.fails, i.retest.passes, i.retest.family) ? "fail" : "pass";
  return { anchor: { field: "next_cycle_close_on", on: i.next_cycle_close_on }, result, event: { type: "qc.capa.effectiveness_tested", finding_id: i.finding_id, capa_id: i.capa_id, result, cycle_close_on: i.next_cycle_close_on }, finding_status: result === "pass" ? "closed" : "reopened" };
}

/** `SM_QC_CONSUMER_REMEDIATION_30`: refunds posted + notices sent within 30 calendar days of validation; the last of the two emits `qc.remediation.completed{refunds_posted=true, notices_sent=true}`. */
export function consumerRemediation(i: { finding_id: string; validated_on: PlainDate; remediation_cents_total: Cents; refunds: readonly { loan_id: string; cents: Cents; posted_on: PlainDate | null }[]; notices: readonly { loan_id: string; template_code: string; sent_on: PlainDate | null }[]; today: PlainDate }): { armed: boolean; due: PlainDate; refunds_posted: boolean; notices_sent: boolean; posted_cents: Cents; complete: boolean; breached: boolean; event: { type: "qc.remediation.completed"; finding_id: string; refunds_posted: true; notices_sent: true; completed_on: PlainDate } | null; officer_required: boolean } {
  const due = addDays(i.validated_on, 30);
  const refundsPosted = i.refunds.every((r) => r.posted_on !== null); const noticesSent = i.notices.every((n) => n.sent_on !== null);
  const posted = i.refunds.filter((r) => r.posted_on !== null).reduce((s, r) => s + r.cents, 0n);
  const complete = refundsPosted && noticesSent && posted >= i.remediation_cents_total;
  const completedOn = complete ? [...i.refunds.map((r) => r.posted_on!), ...i.notices.map((n) => n.sent_on!)].reduce((a, b) => (b > a ? b : a), i.validated_on) : null;
  return { armed: i.remediation_cents_total > 0n, due, refunds_posted: refundsPosted, notices_sent: noticesSent, posted_cents: posted, complete, breached: !complete && i.today > due, event: complete && completedOn ? { type: "qc.remediation.completed", finding_id: i.finding_id, refunds_posted: true, notices_sent: true, completed_on: completedOn } : null, officer_required: i.remediation_cents_total > 2_500_000n };
}

/** Rule C: the reversing/correcting entry set a money finding drafts for the dossier — balanced, rule-referenced, and posted by the owning agent (never by `qc-audit`). */
export function remediationLedgerDraft(i: { finding_id: string; rule_code: string; variance_cents: Cents; from_account: string; to_account: string; effective_date: PlainDate; owning_agent: string }): { posted_by: string; drafted_by: "qc-audit"; entry_set: { effectiveDate: PlainDate; description: string; lines: { account: string; amountCents: Cents; ruleRef: string }[] }; balanced: boolean } {
  const amt = i.variance_cents < 0n ? -i.variance_cents : i.variance_cents;
  const lines = [{ account: i.to_account, amountCents: amt, ruleRef: `18.1 rule C ${i.rule_code} finding ${i.finding_id}` }, { account: i.from_account, amountCents: -amt, ruleRef: `18.1 rule C ${i.rule_code} finding ${i.finding_id}` }];
  return { posted_by: i.owning_agent, drafted_by: "qc-audit", entry_set: { effectiveDate: i.effective_date, description: `QC remediation ${i.finding_id}: reverse ${amt}¢ ${i.from_account} → ${i.to_account}`, lines }, balanced: lines.reduce((s, l) => s + l.amountCents, 0n) === 0n };
}

// ============================================================ request / audit clocks
/** `FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD`: Fannie Mae's request for QC results, policies or "examples of application" — due as stated, else 10 BD; satisfied by the 18.2 package delivery. */
export function qcResultsRequest(i: { received_on: PlainDate; stated_due?: PlainDate | null; cal?: Calendar }): { code: "FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD"; anchor: PlainDate; due: PlainDate; basis: "as_stated" | "default_10bd"; satisfied_by: "fnma.request.delivered{kind=qc_results}"; delivery: { kind: "human_portal_task"; engine: "18.2"; signed_by: "officer"; contents: string[] } } {
  const stated = i.stated_due ?? null;
  return { code: "FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD", anchor: i.received_on, due: stated ?? addBusinessDays(i.received_on, 10, i.cal ?? servicer), basis: stated ? "as_stated" : "default_10bd", satisfied_by: "fnma.request.delivered{kind=qc_results}", delivery: { kind: "human_portal_task", engine: "18.2", signed_by: "officer", contents: ["comprehensive results of all testing", "evidence of correction actions taken", "policies and examples of their application"] } };
}
/** The delivery event the 18.2 engine emits when the on-request package leaves through the portal operator — the `fnma.request.delivered{kind=qc_results}` the timer row names. */
export function qcResultsDelivered(i: { request_id: string; delivered_on: PlainDate; signed_by_role: string; delivery_evidence_document_id: string | null }): { event: { type: "fnma.request.delivered"; kind: "qc_results"; request_id: string; delivered_on: PlainDate } | null; refusal: string | null } {
  if (i.signed_by_role !== "officer") return { event: null, refusal: "the Fannie Mae QC-results package carries the officer signature (18.1 escalations: `officer` — Fannie Mae/partner packages)" };
  if (!i.delivery_evidence_document_id) return { event: null, refusal: "delivery evidence (LQC/email confirmation) is required before the request is satisfied" };
  return { event: { type: "fnma.request.delivered", kind: "qc_results", request_id: i.request_id, delivered_on: i.delivered_on }, refusal: null };
}

/** `CSBS_EXTERNAL_AUDIT_ANNUAL`: applies when ≥ 2,000 loans in ≥ 2 states; the AFS with an audit opinion (`afs.received{audit_opinion=true}`, 18.7) within 12 months of FYE satisfies it. */
export function csbsExternalAudit(i: { fye: PlainDate; loan_count: number; states: number }): { applicable: boolean; due: PlainDate | null; satisfied_by: "afs.received{audit_opinion=true}"; basis: string } {
  const applicable = i.loan_count >= 2000 && i.states >= 2;
  return { applicable, due: applicable ? addMonths(i.fye, 12) : null, satisfied_by: "afs.received{audit_opinion=true}", basis: "CSBS Model Prudential Standards: internal audit and external audit for servicers with ≥2,000 loans in ≥2 states" };
}

/** `SM_AI_EVAL_GATE` facts → open only when every mandatory suite passed and a T1/T2 version carries an officer approval (LL-2026-04 change management). */
export function aiEvalGateFacts(i: { tier: "T0_deterministic" | "T1_consequential" | "T2_borrower_facing" | "T3_internal"; suites: readonly { suite_code: string; mandatory: boolean; pass: boolean }[]; approved_by: string | null }): { open: boolean; failed_mandatory: string[]; approval_required: boolean; reason: string | null } {
  const failed = i.suites.filter((s) => s.mandatory && !s.pass).map((s) => s.suite_code);
  const needsApproval = i.tier === "T1_consequential" || i.tier === "T2_borrower_facing";
  const noApproval = needsApproval && !i.approved_by;
  const reason = failed.length ? `mandatory suite(s) failed: ${failed.join(", ")}` : noApproval ? "no officer:ai_governance_owner approval on a T1/T2 version" : null;
  return { open: reason === null, failed_mandatory: failed, approval_required: needsApproval, reason };
}

// ============================================================ rule B: seeded, hashed draws (T1) and the cycle window
export interface SampleDraw { readonly rule_code: string; readonly population_n: number; readonly n: number; readonly selection_method: "random"; readonly selection_seed: number; readonly population_hash: string; readonly random_ids: readonly string[]; readonly targeted_ids: readonly string[]; readonly sample_ids: readonly string[]; readonly sample_n: number; }
/** `qc_samples.population_hash`: SHA-256 of the ordered id list (data model), so an examiner can prove the population the draw ran over. */
export const populationHash = (ids: readonly string[]): string => sha256(ids.join("\n"));
/** Rule B: the finite-population random draw (n = sampleSize(N), seeded) plus the always-in targeted additions (100% of denials, appeals, …); seed and population hash are recorded on the sample. */
export function drawSample(i: { rule_code: string; population: readonly { id: string; flags?: TargetedFlags }[]; selection_seed: number }): SampleDraw {
  const ids = i.population.map((p) => p.id);
  const N = ids.length; const n = sampleSize(N);
  const random_ids = seededDraw(ids, n, i.selection_seed);
  const targeted_ids = i.population.filter((p) => p.flags !== undefined && targeted(p.flags)).map((p) => p.id);
  const seen = new Set(random_ids);
  const sample_ids = [...random_ids, ...targeted_ids.filter((id) => !seen.has(id))];
  return { rule_code: i.rule_code, population_n: N, n, selection_method: "random", selection_seed: i.selection_seed, population_hash: populationHash(ids), random_ids, targeted_ids, sample_ids, sample_n: sample_ids.length };
}
/** Edge case "Examiner reproducibility": given `selection_seed` and `population_hash`, the draw regenerates identically; a population whose hash no longer matches cannot be replayed (`inconclusive`). */
export function regenerateDraw(i: { population_ids: readonly string[]; selection_seed: number; population_hash: string; n: number }): { result: "identical" | "inconclusive"; population_hash: string; sample_ids: readonly string[] } {
  const hash = populationHash(i.population_ids);
  if (hash !== i.population_hash) return { result: "inconclusive", population_hash: hash, sample_ids: [] };
  return { result: "identical", population_hash: hash, sample_ids: seededDraw(i.population_ids, i.n, i.selection_seed) };
}
/** `FNMA_A4101_QC_CYCLE_MONTHLY`: the monthly cycle for the prior month's population opens on BD3 of the month (after the investor-reporting close) and closes by BD20 (`business_days_servicer`). */
export function monthlyCycleWindow(year: number, month: number, cal: Calendar = servicer): { kind: "monthly"; period_start: PlainDate; period_end: PlainDate; opens_on: PlainDate; close_by: PlainDate } {
  const period_end = endOfMonth(addDays(ymd(year, month, 1), -1)); const { y, m } = parts(period_end);
  return { kind: "monthly", period_start: ymd(y, m, 1), period_end, opens_on: addBusinessDays(period_end, 3, cal), close_by: addBusinessDays(period_end, 20, cal) };
}

// ============================================================ findings state machine (T2, T3) and the CAPA / cycle clocks
export type FindingStatus = "open" | "validated" | "capa_assigned" | "remediating" | "effectiveness_check" | "closed" | "rejected" | "escalated_fnma";
export type RootCause = "rule_defect" | "model_behavior" | "data_defect" | "vendor" | "human_error" | "process_gap" | "external";
export interface FindingActor { readonly kind: "agent" | "human"; readonly id: string; readonly role?: string | null; readonly designation?: string | null; }
/** `qc_findings` (`cases.status`): open → validated (QC officer confirms) → capa_assigned → remediating → effectiveness_check → closed; alternates `rejected` (false positive, with rationale) and `escalated_fnma` (self-report path). */
export const FINDING_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = { open: ["validated", "rejected"], validated: ["capa_assigned", "escalated_fnma"], capa_assigned: ["remediating"], remediating: ["effectiveness_check"], effectiveness_check: ["closed", "capa_assigned"], closed: [], rejected: [], escalated_fnma: ["capa_assigned"] };
const isQcOfficer = (a: FindingActor): boolean => a.kind === "human" && a.role === "officer" && a.designation === "qc_officer";
/** Guards: `validated`/`rejected` only by `officer:qc_officer` (rejection needs a rationale — findings are never deleted); `capa_assigned` requires the root cause (rule B: "automatic `qc_finding` at population level with root-cause analysis"; T3). */
export interface FindingTransitionEvent { readonly type: `qc.finding.${FindingStatus}`; readonly finding_id: string; readonly status: FindingStatus; readonly severity: FindingSeverity; readonly root_cause: RootCause | null; readonly remediation_cents_total: Cents; readonly validated_at: PlainDate | null; readonly decided_by: string; readonly rationale: string | null; }
export function findingTransition(f: { status: FindingStatus; severity: FindingSeverity; root_cause: RootCause | null; rationale?: string | null; finding_id?: string; remediation_cents_total?: Cents }, to: FindingStatus, actor: FindingActor, on?: PlainDate | null): { ok: boolean; status: FindingStatus; refusal: string | null; event: FindingTransitionEvent | null } {
  const refuse = (refusal: string) => ({ ok: false, status: f.status, refusal, event: null });
  if (!FINDING_TRANSITIONS[f.status].includes(to)) return refuse(`qc_findings: no transition ${f.status} → ${to}`);
  if ((to === "validated" || to === "rejected") && !isQcOfficer(actor)) return refuse(`qc_findings: ${to} is decided by officer:qc_officer, not ${actor.kind}:${actor.id}`);
  if (to === "rejected" && !f.rationale) return refuse("qc_findings: a rejected finding carries a rationale (findings are never deleted)");
  if (to === "capa_assigned" && f.root_cause === null) return refuse("qc_findings: root cause required before capa_assigned (rule_defect | model_behavior | data_defect | vendor | human_error | process_gap | external)");
  // the transition event: `qc.finding.validated{severity, remediation_cents_total, validated_at}` arms the CAPA and consumer-remediation clocks; validated/rejected satisfy `SM_QC_FINDING_VALIDATE_5BD`
  return { ok: true, status: to, refusal: null, event: { type: `qc.finding.${to}`, finding_id: f.finding_id ?? "", status: to, severity: f.severity, root_cause: f.root_cause, remediation_cents_total: f.remediation_cents_total ?? 0n, validated_at: to === "validated" ? (on ?? null) : null, decided_by: `${actor.kind}:${actor.id}`, rationale: f.rationale ?? null } };
}

export interface PopulationFinding { readonly level: "population"; readonly finding_code: string; readonly rule_code: string; readonly cycle_id: string; readonly severity: FindingSeverity; readonly status: "open"; readonly root_cause: null; readonly root_cause_required: true; readonly error_rate: ErrorRate; readonly tolerance: number; readonly affected_population_query: string; readonly affected_count: number; readonly event: { type: "qc.finding.opened"; finding_code: string; level: "population"; rule_code: string; opened_at: PlainDate }; }
/** Rule B tolerance: `rate = fails / (pass + fails)` (Wilson 95% interval) above the family tolerance (2% rederive / 5% judgment / 0% sev-1 consumer harm) opens a population-level finding whose root cause is required before `capa_assigned` (T3). */
export function populationFinding(i: { rule_code: string; cycle_id: string; fails: number; passes: number; family: RuleFamily; opened_on: PlainDate }): { breached: boolean; error_rate: ErrorRate; tolerance: number; finding: PopulationFinding | null } {
  const er = errorRate(i.fails, i.passes); const tolerance = TOLERANCE[i.family];
  if (!toleranceBreached(i.fails, i.passes, i.family)) return { breached: false, error_rate: er, tolerance, finding: null };
  const finding_code = `${i.rule_code}:POPULATION:${i.cycle_id}`;
  return { breached: true, error_rate: er, tolerance, finding: { level: "population", finding_code, rule_code: i.rule_code, cycle_id: i.cycle_id, severity: i.family === "sev1_consumer_harm" ? "sev1_consumer_harm_or_fnma_breach" : "sev2_rule_breach_no_harm", status: "open", root_cause: null, root_cause_required: true, error_rate: er, tolerance, affected_population_query: `qc_tests where sample_id in (select id from qc_samples where cycle_id = '${i.cycle_id}' and rule_code = '${i.rule_code}') and result = 'fail'`, affected_count: i.fails, event: { type: "qc.finding.opened", finding_code, level: "population", rule_code: i.rule_code, opened_at: i.opened_on } } };
}

export interface CapaDraft { readonly action_kind: "refund" | "re_notice" | "rule_fix" | "prompt_fix" | "retrain_eval" | "data_fix" | "vendor_action" | "training" | "policy_change"; readonly owner_role: string; readonly owner_agent: string; readonly due: PlainDate; readonly timer: "SM_QC_CONSUMER_REMEDIATION_30" | "SM_QC_CAPA_SEV1_10BD" | "SM_QC_CAPA_SEV2_30" | "SM_QC_CAPA_SEV3_90"; }
/** The CAPA clock the timer table names per severity: sev-1 10 BD, sev-2 30 calendar days, sev-3 90 calendar days from validation (the first cut's `capaDue` in ./findings.ts uses 15/30 BD for sev-2/3 — wrong; this is the corrected clock). */
export function capaDueOn(validated_on: PlainDate, severity: FindingSeverity, cal: Calendar = servicer): { code: "SM_QC_CAPA_SEV1_10BD" | "SM_QC_CAPA_SEV2_30" | "SM_QC_CAPA_SEV3_90"; due: PlainDate } {
  return severity === "sev1_consumer_harm_or_fnma_breach" ? { code: "SM_QC_CAPA_SEV1_10BD", due: addBusinessDays(validated_on, 10, cal) } : severity === "sev2_rule_breach_no_harm" ? { code: "SM_QC_CAPA_SEV2_30", due: addDays(validated_on, 30) } : { code: "SM_QC_CAPA_SEV3_90", due: addDays(validated_on, 90) };
}
/** The `qc.finding.opened` event every finding emits — population-level (rule B tolerance) or subject-level (rule C money rederive); `opened_at` arms `SM_QC_FINDING_VALIDATE_5BD` (opened_at + 5 BD for the QC officer). */
export interface FindingOpenedEvent { readonly type: "qc.finding.opened"; readonly finding_code: string; readonly level: "population" | "subject"; readonly rule_code: string; readonly severity: FindingSeverity; readonly opened_at: PlainDate; readonly subject_type?: string; readonly subject_id?: string; readonly variance_cents?: Cents; }
/** Rule C / T2: a failed money rederive opens a `qc_finding` (sev-2 when refunded before the payment-change date, else sev-1) with `variance_cents` — emitting `qc.finding.opened{level=subject, opened_at}` so the 5-BD validation clock arms — a CAPA `refund` on the 30-day consumer-remediation clock, a CAPA `re_notice` when a notice was affected, the drafted reversing entry set — and the corrected statement is issued by the owning agent (`escrow`), never by `qc-audit`. `opened_on` is the test date (defaults to `validated_on` for callers that record both at once). */
export function moneyRederiveFinding(i: { row: RederiveRow; finding_id: string; validated_on: PlainDate; opened_on?: PlainDate; refunded_before_payment_change: boolean; notice_affected: boolean; owning_agent: string; owner_role: string; from_account: string; to_account: string; affected_count?: number }): { finding: { case_type: "qc_finding"; finding_code: string; rule_code: string; severity: FindingSeverity; status: "open"; variance_cents: Cents; remediation_cents_total: Cents; affected_count: number; opened_by: "qc-audit"; opened_at: PlainDate }; event: FindingOpenedEvent | null; validate_due: PlainDate; capas: CapaDraft[]; corrected_statement: { issued_by: string; never_by: "qc-audit"; source: "notice_registry"; from_capa: "re_notice" } | null; ledger_draft: ReturnType<typeof remediationLedgerDraft>; remediation_timer: { code: "SM_QC_CONSUMER_REMEDIATION_30"; due: PlainDate } } {
  const variance = i.row.variance_cents; const abs = variance < 0n ? -variance : variance;
  if (variance === 0n) throw new RangeError(`${i.row.rule_code} ${i.row.subject_id}: a money finding needs variance_cents ≠ 0 (rule C)`);
  const severity: FindingSeverity = i.refunded_before_payment_change ? "sev2_rule_breach_no_harm" : "sev1_consumer_harm_or_fnma_breach";
  const opened_at = i.opened_on ?? i.validated_on;
  const due = addDays(i.validated_on, 30);
  const capas: CapaDraft[] = [{ action_kind: "refund", owner_role: i.owner_role, owner_agent: i.owning_agent, due, timer: "SM_QC_CONSUMER_REMEDIATION_30" }];
  if (i.notice_affected) capas.push({ action_kind: "re_notice", owner_role: i.owner_role, owner_agent: i.owning_agent, due, timer: "SM_QC_CONSUMER_REMEDIATION_30" });
  const finding_code = `${i.row.rule_code}:${i.row.subject_id}`;
  return {
    finding: { case_type: "qc_finding", finding_code, rule_code: i.row.rule_code, severity, status: "open", variance_cents: variance, remediation_cents_total: abs, affected_count: i.affected_count ?? 1, opened_by: "qc-audit", opened_at },
    event: { type: "qc.finding.opened", finding_code, level: "subject", rule_code: i.row.rule_code, severity, opened_at, subject_type: i.row.subject_type, subject_id: i.row.subject_id, variance_cents: variance },
    validate_due: findingValidateDue(opened_at),
    capas,
    corrected_statement: i.notice_affected ? { issued_by: i.owning_agent, never_by: "qc-audit", source: "notice_registry", from_capa: "re_notice" } : null,
    ledger_draft: remediationLedgerDraft({ finding_id: i.finding_id, rule_code: i.row.rule_code, variance_cents: variance, from_account: i.from_account, to_account: i.to_account, effective_date: i.validated_on, owning_agent: i.owning_agent }),
    remediation_timer: { code: "SM_QC_CONSUMER_REMEDIATION_30", due },
  };
}

/**
 * `SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE` anchor ("next cycle close", offset "1 cycle"): the close (BD20 of the following
 * month) of the cycle that tests the completion month's population — the first cycle whose population post-dates the
 * CAPA. A cycle already open when the CAPA completes tests the *prior* month (`qc.cycle.monthly` opens BD3 "for the
 * prior month's population"), i.e. activity from before the fix, so its close cannot evidence effectiveness: a CAPA
 * completed 2026-10-01 is re-tested at the November cycle close 2026-12-01 (October population), not at the October
 * cycle close 2026-10-29 (September population).
 */
export function nextCycleCloseOn(after: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(endOfMonth(after), 20, cal); }
/** `SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE` trigger: a single CAPA completing (with evidence) emits `qc.capa.completed{next_cycle_close_on}` — the computed anchor the effectiveness re-test is due at. */
export function completeCapa(i: { finding_id: string; capa_id: string; completed_on: PlainDate; evidence_document_ids: readonly string[]; cal?: Calendar }): { event: { type: "qc.capa.completed"; finding_id: string; capa_id: string; completed_at: PlainDate; next_cycle_close_on: PlainDate } | null; refusal: string | null } {
  if (i.evidence_document_ids.length === 0) return { event: null, refusal: "qc_corrective_actions: completion requires evidence_document_ids (CAPA evidence)" };
  return { event: { type: "qc.capa.completed", finding_id: i.finding_id, capa_id: i.capa_id, completed_at: i.completed_on, next_cycle_close_on: nextCycleCloseOn(i.completed_on, i.cal ?? servicer) }, refusal: null };
}
/** `SM_QC_FINDING_VALIDATE_5BD`: opened_at + 5 business days for the QC officer to validate or reject. */
export function findingValidateDue(opened_on: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(opened_on, 5, cal); }

// ============================================================ cycle sign-off and report delivery (T5)
/**
 * `qc.cycle.signed` — the QC officer signs the cycle (state `reported → signed`); arms the two 5-BD report clocks and
 * satisfies `FNMA_A4101_QC_CYCLE_MONTHLY`. The recurring row re-arms from this event on `cycle_clock_opens_on` — the BD3
 * opening of the *next* cycle (the one covering the month after `period_end`, default the month before `signed_on`),
 * so the re-armed close-by clock lands on that cycle's BD20, not 17 BD after the signature.
 */
export function signCycle(i: { cycle_id: string; signed_on: PlainDate; signer: FindingActor; period_end?: PlainDate; cal?: Calendar }): { event: { type: "qc.cycle.signed"; cycle_id: string; signed_at: PlainDate; period_end: PlainDate; cycle_clock_opens_on: PlainDate } | null; refusal: string | null; report_due: PlainDate | null } {
  if (!isQcOfficer(i.signer)) return { event: null, refusal: `qc_cycles: signed by officer:qc_officer, not ${i.signer.kind}:${i.signer.id}`, report_due: null };
  const cal = i.cal ?? servicer;
  const period_end = i.period_end ?? endOfMonth(addMonths(i.signed_on, -1));
  const nextOpen = parts(addMonths(period_end, 2));                                   // the next cycle covers period_end + 1 month and opens BD3 of the month after that
  return { event: { type: "qc.cycle.signed", cycle_id: i.cycle_id, signed_at: i.signed_on, period_end, cycle_clock_opens_on: monthlyCycleWindow(nextOpen.y, nextOpen.m, cal).opens_on }, refusal: null, report_due: addBusinessDays(i.signed_on, 5, cal) };
}
export type ReportAudience = "senior_management" | "board" | "partner" | "fnma_on_request" | "regulator";
/** `FNMA_A4101_QC_REPORT_SENIOR_MGMT_MONTHLY` / `SM_QC_REPORT_PARTNER_MONTHLY` satisfy on delivery evidence: `qc.report.delivered{audience}` is emitted only with `delivery_evidence`. */
export function reportDelivered(i: { cycle_id: string; audience: ReportAudience; signed_on: PlainDate; delivered_on: PlainDate | null; delivery_evidence: string | null; cal?: Calendar }): { due: PlainDate; on_time: boolean | null; event: { type: "qc.report.delivered"; cycle_id: string; audience: ReportAudience; delivered_at: PlainDate; delivery_evidence: string } | null; refusal: string | null } {
  const due = addBusinessDays(i.signed_on, 5, i.cal ?? servicer);
  if (i.delivered_on === null || !i.delivery_evidence) return { due, on_time: null, event: null, refusal: "qc_reports: delivery is evidenced (delivered_at + delivery_evidence) before the report clock is satisfied" };
  return { due, on_time: i.delivered_on <= due, event: { type: "qc.report.delivered", cycle_id: i.cycle_id, audience: i.audience, delivered_at: i.delivered_on, delivery_evidence: i.delivery_evidence }, refusal: null };
}

// ============================================================ vendor annual QC test (T6)
/** `FNMA_A4101_VENDOR_QC_TEST_ANNUAL`: anniversary clock — warning at 75% (9 months), breach at 12 months without `qc.vendor_test.completed` (month arithmetic, so a Feb-29 span still lands on the anniversary; the first cut's `vendorAnnualTest` adds 275/365 days). */
export function vendorAnnualClock(i: { vendor_id: string; onboarded_on: PlainDate; completed_tests: readonly { completed_on: PlainDate }[]; today: PlainDate }): { code: "FNMA_A4101_VENDOR_QC_TEST_ANNUAL"; anchor: PlainDate; warn_on: PlainDate; breach_on: PlainDate; warned: boolean; breached: boolean; satisfied: boolean; escalation: { kind: "officer"; severity: "sev1"; reason: string } | null } {
  const anchor = [...i.completed_tests.map((t) => t.completed_on)].reduce((a, b) => (b > a ? b : a), i.onboarded_on);
  const warn_on = addMonths(anchor, 9); const breach_on = addMonths(anchor, 12);
  const satisfied = i.completed_tests.some((t) => t.completed_on > i.onboarded_on && addMonths(t.completed_on, 12) > i.today && t.completed_on <= i.today);
  const breached = !satisfied && i.today >= breach_on;
  return { code: "FNMA_A4101_VENDOR_QC_TEST_ANNUAL", anchor, warn_on, breach_on, warned: !satisfied && i.today >= warn_on, breached, satisfied, escalation: breached ? { kind: "officer", severity: "sev1", reason: `vendor ${i.vendor_id}: annual QC test not completed by ${breach_on} (A4-1-01)` } : null };
}
/** `qc.vendor_test.completed` per active vendor — only with the test report evidence. */
export function vendorTestCompleted(i: { vendor_id: string; completed_on: PlainDate; report_document_id: string | null }): { event: { type: "qc.vendor_test.completed"; vendor_id: string; completed_at: PlainDate; report_document_id: string } | null; refusal: string | null } {
  if (!i.report_document_id) return { event: null, refusal: "annual Vendor QC Test Report is the evidence; no report, no completion" };
  return { event: { type: "qc.vendor_test.completed", vendor_id: i.vendor_id, completed_at: i.completed_on, report_document_id: i.report_document_id }, refusal: null };
}

// ============================================================ AI governance (rule D): versions and the eval gate (T7)
export type AiTier = "T0_deterministic" | "T1_consequential" | "T2_borrower_facing" | "T3_internal";
export type AiVersionStatus = "proposed" | "evaluated" | "approved" | "deployed" | "monitored" | "retired";
export interface EvalSuite { readonly suite_code: string; readonly mandatory: boolean; readonly pass: boolean; }
export interface AiVersion { readonly system_code: string; readonly version: string; readonly tier: AiTier; readonly change_kind: "new" | "minor" | "major"; readonly status: AiVersionStatus; readonly suites: readonly EvalSuite[]; readonly approved_by: string | null; }
const isAiGovernanceOwner = (a: FindingActor): boolean => a.kind === "human" && a.role === "officer" && a.designation === "ai_governance_owner";
/** `ai_system_versions.status`: proposed → evaluated once the suites ran; `approved` only by `officer:ai_governance_owner` and only when every mandatory suite passed (rule D.3); `ai.version.approved` satisfies `SM_AI_EVAL_GATE`. */
export function approveVersion(v: AiVersion, approver: FindingActor): { version: AiVersion; event: { type: "ai.version.approved"; system_code: string; version: string; approved_by: string } | null; refusal: string | null } {
  if (v.status !== "evaluated") return { version: v, event: null, refusal: `ai_system_versions: approve from evaluated, not ${v.status}` };
  const gate = aiEvalGateFacts({ tier: v.tier, suites: v.suites, approved_by: null });
  if (gate.failed_mandatory.length) return { version: v, event: null, refusal: `SM_AI_EVAL_GATE: ${gate.reason}` };
  if (!isAiGovernanceOwner(approver)) return { version: v, event: null, refusal: `ai_system_versions: approved_by is officer:ai_governance_owner, not ${approver.kind}:${approver.id}` };
  const next = { ...v, status: "approved" as const, approved_by: approver.id };
  return { version: next, event: { type: "ai.version.approved", system_code: v.system_code, version: v.version, approved_by: approver.id }, refusal: null };
}
export interface AiSystemDeployedEvent { readonly type: "ai_system.deployed"; readonly system_code: string; readonly version: string; readonly risk_tier: AiTier; readonly change_kind: "new" | "minor" | "major"; readonly deployed_at: PlainDate; /** `CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL` anchor (`impactAssessmentClock`): T1 new → +12 months, major → +90 days, minor → carried forward; null for T0/T2/T3. */ readonly impact_assessment_due: PlainDate | null; readonly impact_assessment_basis: ReturnType<typeof impactAssessmentClock>["basis"]; }
/** The deploy command asserts `SM_AI_EVAL_GATE` (`18.1.aiEvalGatePassed`): refused while any mandatory suite fails or a T1/T2 version lacks the owner's approval — the version stays where it is (T7: `evaluated`). A deployment carries the Colorado impact-assessment anchor the timer row reads (`current_impact_assessment_due` = the open clock, if any, for a `major`/`minor` change). */
export function deployVersion(v: AiVersion, deployed_on: PlainDate, opts: { current_impact_assessment_due?: PlainDate | null } = {}): { allowed: boolean; version: AiVersion; gate: "SM_AI_EVAL_GATE"; refusal: string | null; event: AiSystemDeployedEvent | null } {
  const gate = aiEvalGateFacts({ tier: v.tier, suites: v.suites, approved_by: v.approved_by });
  if (!gate.open) return { allowed: false, version: v, gate: "SM_AI_EVAL_GATE", refusal: `deploy refused — ${gate.reason}; version ${v.system_code}@${v.version} stays ${v.status}`, event: null };
  if (v.status !== "approved" && !(v.status === "evaluated" && !gate.approval_required)) return { allowed: false, version: v, gate: "SM_AI_EVAL_GATE", refusal: `ai_system_versions: deploy from approved, not ${v.status}`, event: null };
  const clock = impactAssessmentClock({ risk_tier: v.tier, change_kind: v.change_kind, deployed_on, current_due: opts.current_impact_assessment_due ?? null });
  return { allowed: true, version: { ...v, status: "deployed" }, gate: "SM_AI_EVAL_GATE", refusal: null, event: { type: "ai_system.deployed", system_code: v.system_code, version: v.version, risk_tier: v.tier, change_kind: v.change_kind, deployed_at: deployed_on, impact_assessment_due: clock.impact_assessment_due, impact_assessment_basis: clock.basis } };
}

// ============================================================ rule D.4 fairness (T8)
/** Two-proportion z-test (pooled) with a two-sided normal p-value. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): { z: number; p: number } {
  const p1 = x1 / n1, p2 = x2 / n2, pp = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return { z: Math.round(z * 1000) / 1000, p: Math.round(p * 10000) / 10000 };
}
export interface FairnessResult { readonly rule_code: string; readonly period: string; readonly protected_class: string; readonly proxy: boolean; readonly reference_denial_rate: number; readonly protected_denial_rate: number; readonly ratio: number; readonly z: number; readonly p: number; readonly finding: boolean; readonly route: "attorney" | null; readonly matched_pair_review: boolean; readonly distribution: { readonly status: "withheld_pending_counsel_review" | "summary_statistics"; readonly partner: "summary_statistics_only"; readonly privileged: boolean }; }
/** Rule D.4: per protected class the denial-rate ratio (reference ÷ protected) < 0.80 or a two-proportion z-test p < 0.05 triggers a finding and file-level matched-pair review; the result is a privileged-review candidate routed to `attorney` before any distribution (T8). */
export function fairnessTest(i: { rule_code: "QC_AI_FAIRNESS_LOSSMIT" | "QC_AI_FAIRNESS_FEES" | "QC_AI_FAIRNESS_FC_REFERRAL"; period: string; reference: { denials: number; decisions: number }; protected: { class: string; denials: number; decisions: number; proxy?: boolean } }): FairnessResult {
  const ref = i.reference.denials / i.reference.decisions, prot = i.protected.denials / i.protected.decisions;
  const screen = fairnessScreen(ref, prot);
  const { z, p } = twoProportionZ(i.reference.denials, i.reference.decisions, i.protected.denials, i.protected.decisions);
  const finding = screen.finding || p < 0.05;
  return { rule_code: i.rule_code, period: i.period, protected_class: i.protected.class, proxy: i.protected.proxy === true, reference_denial_rate: ref, protected_denial_rate: prot, ratio: screen.ratio, z, p, finding, route: finding ? "attorney" : null, matched_pair_review: finding, distribution: { status: finding ? "withheld_pending_counsel_review" : "summary_statistics", partner: "summary_statistics_only", privileged: finding } };
}
/** Distribution of a fairness finding (partner report, board pack) waits for counsel's review — open decision 18.1-Q4 default: conducted at counsel's direction; summary statistics shared with the partner. */
export function fairnessDistribution(r: FairnessResult, counsel_reviewed: boolean): { allowed: boolean; refusal: string | null; contents: "summary_statistics" | "none" } {
  if (r.finding && !counsel_reviewed) return { allowed: false, refusal: `${r.rule_code} ${r.period}: routed to attorney (privilege) — no distribution before counsel review`, contents: "none" };
  return { allowed: true, refusal: null, contents: "summary_statistics" };
}

// ============================================================ rule D.6 disclosure package (T9)
export interface AiInventoryRow { readonly code: string; readonly name: string; readonly kind: "agent" | "model" | "prompt_bundle" | "vendor_model" | "tool" | "deterministic_engine"; readonly purpose: string; readonly manner_of_use: string; readonly risk_tier: AiTier; readonly human_touchpoints: readonly string[]; readonly vendor: string | null; }
/** `FNMA_LL202604_AI_DISCLOSURE_REQUEST_5BD`: Fannie Mae's request for the types/purposes/safeguards of AI/ML ("promptly" — 5 BD internal SLA) logged as `fnma.request.received{kind=ai_disclosure}`. */
export function aiDisclosureRequest(i: { request_id: string; requester: "fnma" | "partner" | "regulator" | "borrower"; received_on: PlainDate; requested: readonly string[]; cal?: Calendar }): { code: "FNMA_LL202604_AI_DISCLOSURE_REQUEST_5BD"; due: PlainDate; event: { type: "fnma.request.received"; kind: "ai_disclosure"; request_id: string; requester: string; received_at: PlainDate; requested: readonly string[] } } {
  return { code: "FNMA_LL202604_AI_DISCLOSURE_REQUEST_5BD", due: addBusinessDays(i.received_on, 5, i.cal ?? servicer), event: { type: "fnma.request.received", kind: "ai_disclosure", request_id: i.request_id, requester: i.requester, received_at: i.received_on, requested: i.requested } };
}
export const DISCLOSURE_PACKAGE_CONTENTS = ["types of AI/ML used", "purpose and manner of use per system", "safeguards: tiering, human touchpoints, evaluations, monitoring, vendor flow-down, security", "current policy versions", "last annual review"] as const;
/** Rule D.6: the package is generated from the inventory — types, purpose and manner per system, safeguards, policy versions, last annual review — assembled by `qc-audit`; it carries no signature until the owner signs. */
export function aiDisclosurePackage(i: { request_id: string; inventory: readonly AiInventoryRow[]; policies: readonly { code: string; version: string; approved_on: PlainDate; last_reviewed_on: PlainDate | null }[]; vendor_attestations: readonly { vendor: string; expires_on: PlainDate }[] }): { request_id: string; assembled_by: "qc-audit"; contents: typeof DISCLOSURE_PACKAGE_CONTENTS; types: string[]; systems: { code: string; kind: string; purpose: string; manner_of_use: string; risk_tier: AiTier; safeguards: string[] }[]; policy_versions: { code: string; version: string; last_reviewed_on: PlainDate | null }[]; last_annual_review: PlainDate | null; signed_by: null; document_hash: string } {
  const systems = i.inventory.map((s) => ({ code: s.code, kind: s.kind, purpose: s.purpose, manner_of_use: s.manner_of_use, risk_tier: s.risk_tier, safeguards: [`tier ${s.risk_tier}`, ...s.human_touchpoints.map((h) => `human touchpoint: ${h}`), "evaluation gate SM_AI_EVAL_GATE", "daily monitoring + kill-switch", ...(s.vendor ? [`vendor flow-down: ${s.vendor} (${i.vendor_attestations.find((a) => a.vendor === s.vendor)?.expires_on ?? "no attestation on file"})`] : []), "ISBR Supplement security program"] }));
  const types = [...new Set(i.inventory.map((s) => s.kind))];
  const reviews = i.policies.map((p) => p.last_reviewed_on).filter((d): d is PlainDate => d !== null);
  const body = { request_id: i.request_id, types, systems, policies: i.policies };
  return { request_id: i.request_id, assembled_by: "qc-audit", contents: DISCLOSURE_PACKAGE_CONTENTS, types, systems, policy_versions: i.policies.map((p) => ({ code: p.code, version: p.version, last_reviewed_on: p.last_reviewed_on })), last_annual_review: reviews.length ? reviews.reduce((a, b) => (b > a ? b : a)) : null, signed_by: null, document_hash: sha256(JSON.stringify(body)) };
}
/** Signature and delivery: signed by `officer:ai_governance_owner` (and the partner's officer when Fannie Mae asks the master servicer), delivered by `fnma_portal_operator`; `ai.disclosure.sent` is the satisfaction event and carries the signer. */
export function sendAiDisclosure(i: { request_id: string; due: PlainDate; signer: FindingActor | null; delivered_by: string; sent_on: PlainDate | null; package_document_id: string | null; partner_officer_signed?: boolean; master_servicer_asked?: boolean }): { event: { type: "ai.disclosure.sent"; request_id: string; signed_by: string; signed_by_designation: "ai_governance_owner"; delivered_by: string; sent_at: PlainDate; package_document_id: string } | null; refusal: string | null; on_time: boolean | null } {
  if (!i.signer || !isAiGovernanceOwner(i.signer)) return { event: null, refusal: "the disclosure package is signed by officer:ai_governance_owner before it leaves (rule D.6)", on_time: null };
  if (i.master_servicer_asked === true && i.partner_officer_signed !== true) return { event: null, refusal: "Fannie Mae asked the master servicer: the partner's officer co-signs the package", on_time: null };
  if (i.delivered_by !== "fnma_portal_operator") return { event: null, refusal: `delivery is by fnma_portal_operator through the channel Fannie Mae specifies, not ${i.delivered_by}`, on_time: null };
  if (i.sent_on === null || !i.package_document_id) return { event: null, refusal: "not sent yet: sent_at and the package document are the delivery evidence", on_time: null };
  return { event: { type: "ai.disclosure.sent", request_id: i.request_id, signed_by: i.signer.id, signed_by_designation: "ai_governance_owner", delivered_by: i.delivered_by, sent_at: i.sent_on, package_document_id: i.package_document_id }, refusal: null, on_time: i.sent_on <= i.due };
}

// ============================================================ the qc_audit database role (T10)
export const QC_AUDIT_DB_ROLE = "qc_audit" as const;
/** Mirror of db/migrations/0046_qc_audit_db_role.sql: SELECT on every public table; INSERT only on the QC/AI governance records, cases, escalations, decisions, documents and the access log; no UPDATE/DELETE anywhere but the two status columns sets; explicit denials on the operational and ledger tables. */
export const QC_AUDIT_DB_GRANTS = {
  select: "ALL TABLES IN SCHEMA public",
  insert: ["qc_cycles", "qc_samples", "qc_tests", "qc_findings", "qc_corrective_actions", "qc_reports", "cases", "escalations", "agent_decisions", "documents", "human_portal_tasks", "ai_evaluations", "ai_monitoring_metrics", "ai_disclosure_requests", "access_log"],
  update_columns: { qc_cycles: ["status", "closed_at", "report_document_id", "signed_by_officer_id"], qc_findings: ["status", "root_cause", "affected_population_query", "affected_count", "remediation_cents_total", "reported_to_partner_at", "reported_to_fnma_at"] },
  denied: ["ledger_entry_sets", "ledger_lines", "ledger_accounts", "loan_events", "loans", "loan_terms", "notices", "notice_deliveries", "notice_batches", "qc_rules", "rule_sets", "timers"],
} as const;
/** The spec's `ledger_entries` is the physical pair `ledger_entry_sets` + `ledger_lines`. */
export const physicalTables = (table: string): string[] => (table === "ledger_entries" ? ["ledger_entry_sets", "ledger_lines"] : [table]);
/** One `access_log` row as the table is declared (db/migrations/0001_baseline.sql: table_name, row_id uuid null, actor_kind, actor_id, purpose, accessed_at). A denied write names no row, so `row_id` is null. */
export interface AccessLogRow { readonly table_name: string; readonly row_id: null; readonly actor_kind: "agent"; readonly actor_id: string; readonly purpose: string; readonly accessed_at: string; }
export interface WriteAttemptLog { readonly access_log: AccessLogRow; readonly event: { type: "security.access_denied"; role: "qc_audit"; principal: string; table: string; physical_tables: string[]; op: "INSERT" | "UPDATE" | "DELETE"; sqlstate: "42501"; statement_hash: string | null; at: string }; }
/** Where a denied attempt is recorded: the append-only event store (`security.access_denied`) and the `access_log` table (the role holds INSERT on it — migration 0046). */
export interface WriteAttemptSink { readonly events: Pick<EventStore, "append">; readonly access_log: { insert(row: AccessLogRow): void }; }
/** An in-memory `access_log` (the Postgres table's shape) for tests and the AI-off console. */
export class MemoryAccessLog { readonly rows: AccessLogRow[] = []; insert(row: AccessLogRow): void { this.rows.push(row); } }
/**
 * T10: `qc-audit` attempting `INSERT` into `ledger_entries` — the role holds no INSERT there, so Postgres raises SQLSTATE
 * 42501 (insufficient_privilege); a denied statement cannot write inside its own failed transaction, so the application
 * layer records the attempt through `sink`: an `access_log` row and a `security.access_denied` event appended to the
 * event store (both are returned as `logged`; without a sink the log is only described).
 */
export function qcAuditWriteAttempt(i: { table: string; op: "INSERT" | "UPDATE" | "DELETE"; principal: string; at: string; statement?: string | null; column?: string | null }, sink?: WriteAttemptSink): { denied: boolean; sqlstate: "42501" | null; role: "qc_audit"; physical_tables: string[]; log: WriteAttemptLog | null; logged: { event_id: string; access_log_row: AccessLogRow } | null } {
  const physical = physicalTables(i.table);
  const insertOk = i.op === "INSERT" && physical.every((t) => (QC_AUDIT_DB_GRANTS.insert as readonly string[]).includes(t));
  const updateCols = (QC_AUDIT_DB_GRANTS.update_columns as Record<string, readonly string[]>)[i.table];
  const updateOk = i.op === "UPDATE" && updateCols !== undefined && i.column !== undefined && i.column !== null && updateCols.includes(i.column);
  const denied = physical.some((t) => (QC_AUDIT_DB_GRANTS.denied as readonly string[]).includes(t)) || !(insertOk || updateOk);
  if (!denied) return { denied: false, sqlstate: null, role: QC_AUDIT_DB_ROLE, physical_tables: physical, log: null, logged: null };
  const statement_hash = i.statement ? sha256(i.statement) : null;
  const log: WriteAttemptLog = { access_log: { table_name: i.table, row_id: null, actor_kind: "agent", actor_id: i.principal, purpose: `write_denied:${i.op}:42501`, accessed_at: i.at }, event: { type: "security.access_denied", role: QC_AUDIT_DB_ROLE, principal: i.principal, table: i.table, physical_tables: physical, op: i.op, sqlstate: "42501", statement_hash, at: i.at } };
  if (!sink) return { denied: true, sqlstate: "42501", role: QC_AUDIT_DB_ROLE, physical_tables: physical, log, logged: null };
  sink.access_log.insert(log.access_log);
  const { type, ...payload } = log.event;
  const appended = sink.events.append({ type, occurredAt: i.at, actor: { kind: "agent", id: i.principal }, aggregate: { kind: "db_role", id: QC_AUDIT_DB_ROLE }, payload });
  return { denied: true, sqlstate: "42501", role: QC_AUDIT_DB_ROLE, physical_tables: physical, log, logged: { event_id: appended.id, access_log_row: log.access_log } };
}

// ============================================================ rule D.5 monitoring, kill-switch and the human path (T11)
export const T1_OVERRIDE_BAND = { low: 0.02, high: 0.15 } as const;
/** Rule D.5: a T1 metric outside its band for 2 consecutive days trips the kill-switch — `feature flag <agent>.enabled=false` + the human path — and emits `ai.kill_switch.tripped`. */
export function killSwitchEvaluation(i: { system_code: string; risk_tier: AiTier; metric: "override_rate"; daily: readonly { day: PlainDate; value: number }[] }): { band: typeof T1_OVERRIDE_BAND; consecutive_breach_days: number; tripped: boolean; flag: { key: string; value: boolean }; human_path: "human_agent"; event: { type: "ai.kill_switch.tripped"; system_code: string; metric: "override_rate"; days: PlainDate[]; flag: string } | null } {
  const out = (v: number) => v < T1_OVERRIDE_BAND.low || v > T1_OVERRIDE_BAND.high;
  let run = 0; for (const d of i.daily) run = out(d.value) ? run + 1 : 0;
  const tripped = i.risk_tier === "T1_consequential" && run >= 2;
  const key = `${i.system_code}.enabled`;
  return { band: T1_OVERRIDE_BAND, consecutive_breach_days: run, tripped, flag: { key, value: !tripped }, human_path: "human_agent", event: tripped ? { type: "ai.kill_switch.tripped", system_code: i.system_code, metric: i.metric, days: i.daily.slice(-run).map((d) => d.day), flag: `${key}=false` } : null };
}
/** T11 verification: with the flag off, a synthetic case must reach the human path (ops-console queue, decided by a human) without the agent being invoked; the evidence is the routing record on the synthetic case. */
export function verifyHumanPath(i: { system_code: string; flag: { key: string; value: boolean }; synthetic_case: { id: string; kind: "synthetic"; subject_kind: string }; routing: { invoked: "agent" | "human_agent"; queue: string | null; decided_by_kind: "agent" | "human" | null } }): { verified: boolean; routed_to: "human_agent" | "agent"; agent_invoked: boolean; queue: string | null; failures: string[]; evidence: { case_id: string; synthetic: true; flag: string; routed_to: "human_agent" | "agent" } } {
  const failures: string[] = [];
  if (i.flag.key !== `${i.system_code}.enabled` || i.flag.value !== false) failures.push(`flag ${i.system_code}.enabled is not false`);
  if (i.routing.invoked !== "human_agent") failures.push("the agent was invoked with the flag off");
  if (i.routing.queue === null) failures.push("no human queue on the synthetic case");
  if (i.routing.decided_by_kind !== "human") failures.push("the synthetic case was not decided by a human");
  const routed_to = i.routing.invoked;
  return { verified: failures.length === 0, routed_to, agent_invoked: routed_to === "agent", queue: i.routing.queue, failures, evidence: { case_id: i.synthetic_case.id, synthetic: true, flag: `${i.flag.key}=${i.flag.value}`, routed_to } };
}
/** `SM_AI_MONITORING_REVIEW_MONTHLY`: the monthly review of `ai_monitoring_metrics` (BD5) emits `ai.monitoring.reviewed`. */
export function monitoringReviewed(i: { month: string; reviewed_on: PlainDate; reviewer: FindingActor; systems_reviewed: readonly string[] }): { event: { type: "ai.monitoring.reviewed"; month: string; reviewed_at: PlainDate; reviewer: string; systems_reviewed: readonly string[]; monitoring_clock_month_end: PlainDate } | null; refusal: string | null } {
  if (!isAiGovernanceOwner(i.reviewer) && !isQcOfficer(i.reviewer)) return { event: null, refusal: "the monthly monitoring review is signed by officer:ai_governance_owner or officer:qc_officer" };
  if (i.systems_reviewed.length === 0) return { event: null, refusal: "a review names the systems reviewed" };
  const m = /^(\d{4})-(\d{2})$/.exec(i.month); if (!m) throw new RangeError(`month must be YYYY-MM, got ${i.month}`);
  // the recurring row re-arms from this event: the next review covers the following month and is due BD5 after its month-end
  const monitoring_clock_month_end = endOfMonth(addMonths(ymd(Number(m[1]), Number(m[2]), 1), 1));
  return { event: { type: "ai.monitoring.reviewed", month: i.month, reviewed_at: i.reviewed_on, reviewer: i.reviewer.id, systems_reviewed: i.systems_reviewed, monitoring_clock_month_end }, refusal: null };
}

// ============================================================ annual governance clocks: policy review, plan re-approval, ISBR attestation, Colorado impact assessment
/** `FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL`: each AI-GOV-* document reviewed by its owner within 12 months (warning 60 days out); `ai.policy.reviewed{signed_by_owner=true}` satisfies. */
export function annualPolicyReview(i: { policy_code: string; version: string; approved_on: PlainDate; reviewed_on: PlainDate | null; reviewer: FindingActor | null }): { due: PlainDate; warn_on: PlainDate; event: { type: "ai.policy.reviewed"; policy_code: string; version: string; reviewed_at: PlainDate; signed_by_owner: true; next_review_due: PlainDate } | null; refusal: string | null } {
  const due = addMonths(i.approved_on, 12); const warn_on = addDays(due, -60);
  if (i.reviewed_on === null || i.reviewer === null) return { due, warn_on, event: null, refusal: "not reviewed" };
  if (!isAiGovernanceOwner(i.reviewer)) return { due, warn_on, event: null, refusal: "LL-2026-04: the owner (officer:ai_governance_owner) reviews and signs the policy" };
  return { due, warn_on, event: { type: "ai.policy.reviewed", policy_code: i.policy_code, version: i.version, reviewed_at: i.reviewed_on, signed_by_owner: true, next_review_due: addMonths(i.reviewed_on, 12) }, refusal: null };
}
/**
 * `FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL`: a plan version approved by the board/managing member and accepted by the partner
 * emits `qc.plan.approved{version, initial}`; re-approval is due 12 months later. `initial=true` (no `supersedes_version`)
 * arms the recurring row; a re-approval (`initial=false`) satisfies it and re-arms it from the new `approved_at` — so one
 * re-approval never arms the clock twice.
 */
export function planApproved(i: { version: string; approved_on: PlainDate; approved_by: FindingActor; partner_accepted_on: PlainDate | null; document_id: string | null; supersedes_version?: string | null }): { event: { type: "qc.plan.approved"; version: string; approved_at: PlainDate; approved_by: string; partner_accepted_at: PlainDate; initial: boolean; supersedes_version: string | null } | null; reapproval_due: PlainDate; refusal: string | null } {
  const reapproval_due = addMonths(i.approved_on, 12);
  if (i.approved_by.kind !== "human" || i.approved_by.role !== "officer") return { event: null, reapproval_due, refusal: "QC plan approval is an officer act (board/managing member)" };
  if (i.partner_accepted_on === null || !i.document_id) return { event: null, reapproval_due, refusal: "the plan is `approved` once signed (document_id) and accepted by the partner under the subservicing agreement" };
  const supersedes = i.supersedes_version ?? null;
  return { event: { type: "qc.plan.approved", version: i.version, approved_at: i.approved_on, approved_by: i.approved_by.id, partner_accepted_at: i.partner_accepted_on, initial: supersedes === null, supersedes_version: supersedes }, reapproval_due, refusal: null };
}
/** `FNMA_ISBR_ANNUAL_ATTESTATION` (Section 19 owns the evidence; 18.1 tracks): the "written attestation executed by a duly authorized corporate officer" emits `isbr.attestation.signed{signed_by_role=officer}`; due FYE + 90 with the Form 582 window. */
export function isbrAttestationSigned(i: { fiscal_year_end: PlainDate; signed_on: PlainDate | null; signer: FindingActor | null; document_id: string | null }): { due: PlainDate; event: { type: "isbr.attestation.signed"; fiscal_year_end: PlainDate; signed_at: PlainDate; signed_by: string; signed_by_role: "officer"; document_id: string; isbr_clock_fye: PlainDate } | null; refusal: string | null } {
  const due = addDays(i.fiscal_year_end, 90);
  if (!i.signer || i.signer.kind !== "human" || i.signer.role !== "officer") return { due, event: null, refusal: "ISBR Supplement: the attestation is executed by a duly authorized corporate officer" };
  if (i.signed_on === null || !i.document_id) return { due, event: null, refusal: "not signed" };
  // the recurring row re-arms from this event on the next fiscal year-end (+90 days), never on the signature date
  return { due, event: { type: "isbr.attestation.signed", fiscal_year_end: i.fiscal_year_end, signed_at: i.signed_on, signed_by: i.signer.id, signed_by_role: "officer", document_id: i.document_id, isbr_clock_fye: addMonths(i.fiscal_year_end, 12) }, refusal: null };
}
/** `CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL` (Colorado SB 24-205): a T1 system's impact assessment is due 12 months after deployment (and after each completed assessment) and within 90 days of a `major` change — the process computes `impact_assessment_due` on the arming event; minor changes carry the current due date forward. */
export function impactAssessmentClock(i: { risk_tier: AiTier; change_kind: "new" | "minor" | "major"; deployed_on: PlainDate; current_due: PlainDate | null }): { arms: boolean; impact_assessment_due: PlainDate | null; basis: "12_months_from_deployment" | "90_days_from_major_change" | "carried_forward" | "not_t1" } {
  if (i.risk_tier !== "T1_consequential") return { arms: false, impact_assessment_due: null, basis: "not_t1" };
  if (i.change_kind === "major") { const d = addDays(i.deployed_on, 90); return { arms: true, impact_assessment_due: i.current_due ? minDate(i.current_due, d) : d, basis: "90_days_from_major_change" }; }
  if (i.change_kind === "minor" && i.current_due) return { arms: false, impact_assessment_due: i.current_due, basis: "carried_forward" };
  return { arms: true, impact_assessment_due: addMonths(i.deployed_on, 12), basis: "12_months_from_deployment" };
}
/** The completed assessment satisfies the clock and re-arms it 12 months out (recurring): `ai.impact_assessment.completed{impact_assessment_due}`. */
export function impactAssessmentCompleted(i: { system_code: string; completed_on: PlainDate; document_id: string | null }): { event: { type: "ai.impact_assessment.completed"; system_code: string; completed_at: PlainDate; document_id: string; impact_assessment_due: PlainDate } | null; refusal: string | null } {
  if (!i.document_id) return { event: null, refusal: "the impact assessment document is the evidence" };
  return { event: { type: "ai.impact_assessment.completed", system_code: i.system_code, completed_at: i.completed_on, document_id: i.document_id, impact_assessment_due: addMonths(i.completed_on, 12) }, refusal: null };
}
/** `CSBS_EXTERNAL_AUDIT_ANNUAL` satisfaction: the audited financial statements land (18.4 auditor delivery / 18.7 eligibility) and 18.1 records `afs.received{audit_opinion}` — only an AFS carrying the auditor's opinion satisfies the CSBS external-audit row. */
export function afsReceived(i: { fiscal_year_end: PlainDate; received_on: PlainDate; audit_opinion: "unqualified" | "qualified" | "adverse" | "disclaimer" | null; auditor: string; document_id: string | null }): { event: { type: "afs.received"; fiscal_year_end: PlainDate; received_at: PlainDate; audit_opinion: boolean; opinion: string | null; auditor: string; document_id: string; csbs_clock_fye: PlainDate } | null; refusal: string | null } {
  if (!i.document_id) return { event: null, refusal: "the AFS document is the evidence" };
  // the recurring CSBS row re-arms from this event on the next fiscal year-end (+12 months), never on the receipt date
  return { event: { type: "afs.received", fiscal_year_end: i.fiscal_year_end, received_at: i.received_on, audit_opinion: i.audit_opinion !== null, opinion: i.audit_opinion, auditor: i.auditor, document_id: i.document_id, csbs_clock_fye: addMonths(i.fiscal_year_end, 12) }, refusal: null };
}

// ============================================================ the process's event writer and the emitters the timer rows arm on
/** The append-only store the process writes to (the platform `EventStore`; `MemoryEventStore` in tests and the AI-off console). */
export type QcEventSink = Pick<EventStore, "append">;
export const QC_AUDIT_ACTOR: Actor = { kind: "agent", id: "qc-audit" };
export const QC_SCHEDULER: Actor = { kind: "system", id: "scheduler" };
const asActor = (a: FindingActor): Actor => ({ kind: a.kind, id: a.id, ...(a.role ? { role: a.role } : {}) });
/** Event subjects: per-finding, per-vendor, per-version, per-policy and per-request aggregates, so a clock armed for one subject is satisfied only by that subject's event (kernel `sameSubject`). */
export const findingSubject = (finding_id: string) => ({ kind: "qc_finding", id: finding_id }) as const;
export const vendorSubject = (vendor_id: string) => ({ kind: "vendor", id: vendor_id }) as const;
export const versionSubject = (system_code: string, version: string) => ({ kind: "ai_system_version", id: `${system_code}@${version}` }) as const;
export const policySubject = (policy_code: string) => ({ kind: "ai_policy", id: policy_code }) as const;
export const requestSubject = (request_id: string) => ({ kind: "fnma_request", id: request_id }) as const;
export const fiscalYearSubject = (entity: string, fye: PlainDate) => ({ kind: "fiscal_year", id: `${entity}:${fye}` }) as const;
/**
 * Append one of the process's events (an ops `event` value: `{ type, ...payload }`) to the store — the single code path
 * behind every `qc.*` / `ai.*` / `fnma.request.*` emission the timer rows name. `occurredAt` is an ISO instant or a
 * PlainDate (taken at noon ET, so the Eastern civil date the anchors resolve on is the date given).
 */
export function appendQcEvent<E extends { readonly type: string }>(events: QcEventSink, e: E, occurredAt: string, opts: { actor?: Actor; aggregate?: { kind: string; id: string }; loanId?: string; causationId?: string } = {}): DomainEvent {
  const { type, ...payload } = e as { type: string } & Record<string, unknown>;
  if (!type) throw new RangeError("event type is required");
  const at = /^\d{4}-\d{2}-\d{2}$/.test(occurredAt) ? `${occurredAt}T16:00:00.000Z` : occurredAt;
  if (Number.isNaN(Date.parse(at))) throw new RangeError(`occurredAt must be an ISO instant or a PlainDate, got ${occurredAt}`);
  const input: EventInput = { type, occurredAt: at, actor: opts.actor ?? QC_AUDIT_ACTOR, payload, ...(opts.aggregate ? { aggregate: opts.aggregate } : {}), ...(opts.loanId ? { loanId: opts.loanId } : {}), ...(opts.causationId ? { causationId: opts.causationId } : {}) };
  return events.append(input);
}

// ---- the QC schedules (`qc.cycle.monthly`, the monitoring month-end, the fiscal year-end) ----------------------------
/** Ordinal of `today` among the month's servicer business days (1 = BD1); 0 when `today` is not a business day. */
export function businessDayOfMonth(today: PlainDate, cal: Calendar = servicer): number {
  if (!cal.isBusinessDay(today)) return 0;
  return businessDaysBetween(addDays(startOfMonth(today), -1), today, cal);
}
export interface QcScheduleInputs { readonly fiscal_year_end?: { month: number; day: number }; readonly entity?: string; readonly csbs?: { loan_count: number; states: number }; readonly cal?: Calendar; }
/**
 * The 18.1 schedules as events, from the nightly scheduler: `schedule.tick{cadence=monthly, business_day=3}` on BD3 (the
 * monthly cycle opens for the prior month's population, after the investor-reporting close — arms
 * `FNMA_A4101_QC_CYCLE_MONTHLY` on `cycle_clock_opens_on` = today, close by BD20), `period.month_end` on the last day of
 * the month (arms `SM_AI_MONITORING_REVIEW_MONTHLY` on `monitoring_clock_month_end` + 5 BD = BD5 of the next month) and
 * `period.fiscal_year_end{csbs_audit_required}` on the fiscal year-end (arms `FNMA_ISBR_ANNUAL_ATTESTATION` at FYE + 90
 * and, when ≥ 2,000 loans in ≥ 2 states, `CSBS_EXTERNAL_AUDIT_ANNUAL` at FYE + 12 months). Every tick carries the
 * anchor field its row reads, so the same field on the row's satisfying event re-arms the next period correctly.
 */
export function qcScheduleTicks(today: PlainDate, i: QcScheduleInputs = {}): EventInput[] {
  const cal = i.cal ?? servicer; const { y, m, d } = parts(today);
  const out: EventInput[] = [];
  if (businessDayOfMonth(today, cal) === 3) {
    const win = monthlyCycleWindow(y, m, cal);
    out.push({ type: "schedule.tick", actor: QC_SCHEDULER, payload: { cadence: "monthly", business_day: 3, job: "qc-cycle-open", date: today, period_start: win.period_start, period_end: win.period_end, cycle_clock_opens_on: today, close_by: win.close_by } });
  }
  if (today === endOfMonth(today)) out.push({ type: "period.month_end", actor: QC_SCHEDULER, payload: { month: `${y}-${String(m).padStart(2, "0")}`, month_end: today, date: today, monitoring_clock_month_end: today, monitoring_review_due: addBusinessDays(today, 5, cal), jobs: ["ai-monitoring-review"] } });
  const fye = i.fiscal_year_end ?? { month: 12, day: 31 };
  if (m === fye.month && d === fye.day) {
    const csbs = i.csbs ? csbsExternalAudit({ fye: today, loan_count: i.csbs.loan_count, states: i.csbs.states }) : null;
    out.push({ type: "period.fiscal_year_end", actor: QC_SCHEDULER, aggregate: fiscalYearSubject(i.entity ?? "supermortgage", today), payload: { entity: i.entity ?? "supermortgage", fiscal_year: y, fiscal_year_end: today, date: today, csbs_audit_required: csbs?.applicable ?? false, loan_count: i.csbs?.loan_count ?? null, states: i.csbs?.states ?? null, isbr_clock_fye: today, isbr_attestation_due: addDays(today, 90), csbs_clock_fye: today, csbs_audit_due: csbs?.due ?? null, jobs: ["isbr-attestation", ...(csbs?.applicable ? ["csbs-external-audit"] : [])] } });
  }
  return out;
}
export function emitQcScheduleTicks(today: PlainDate, events: QcEventSink, i: QcScheduleInputs = {}): DomainEvent[] { return qcScheduleTicks(today, i).map((e) => events.append(e)); }

// ---- vendors: onboarding (the `FNMA_A4101_VENDOR_QC_TEST_ANNUAL` trigger) and the completed annual test ------------
export type VendorKind = "outsourcing_firm" | "third_party_vendor" | "ai_vendor" | "law_firm" | "print_mail" | "telephony" | "document_ai" | "model_hosting";
export interface VendorOnboarding { readonly vendor_id: string; readonly name: string; readonly kind: VendorKind; readonly onboarded_on: PlainDate; readonly contract_document_id: string | null; readonly scp_screening: { screened_on: PlainDate; clear: boolean; document_id: string | null } | null; readonly ai_flow_down_attestation_document_id?: string | null; }
/**
 * Ingestion of the vendor-management module's onboarding record (Section 19): a vendor enters the annual QC-test
 * population only with its contract and a clear FHFA SCP / SAM / LDP screening on file (A4-1-01 vendor oversight incl.
 * Suspended Counterparty Program screening; A3-4-03), and an AI vendor only with its flow-down attestation (AI-GOV-006).
 * Appends `vendor.onboarded{vendor_id, onboarded_on}` on the vendor subject — the anniversary clock arms from it.
 */
export function onboardVendor(events: QcEventSink, v: VendorOnboarding, opts: { actor?: Actor; today?: PlainDate } = {}): { event: DomainEvent | null; refusal: string | null; annual_test: ReturnType<typeof vendorAnnualClock> | null } {
  if (!v.vendor_id || !v.name) throw new RangeError("vendor_id and name are required");
  if (!v.contract_document_id) return { event: null, refusal: `vendor ${v.vendor_id}: no executed contract on file — not onboarded (A2-1-01 vendor risk management program)`, annual_test: null };
  if (!v.scp_screening || !v.scp_screening.document_id) return { event: null, refusal: `vendor ${v.vendor_id}: FHFA Suspended Counterparty Program / SAM / LDP screening evidence is required before onboarding (A4-1-01)`, annual_test: null };
  if (!v.scp_screening.clear) return { event: null, refusal: `vendor ${v.vendor_id}: screening hit on ${v.scp_screening.screened_on} — onboarding refused, escalate to officer`, annual_test: null };
  if (v.kind === "ai_vendor" && !v.ai_flow_down_attestation_document_id) return { event: null, refusal: `vendor ${v.vendor_id}: an AI vendor onboards with its flow-down attestation (AI-GOV-006 'no less protective', LL-2026-04)`, annual_test: null };
  const event = appendQcEvent(events, { type: "vendor.onboarded", vendor_id: v.vendor_id, name: v.name, kind: v.kind, onboarded_on: v.onboarded_on, contract_document_id: v.contract_document_id, scp_screened_on: v.scp_screening.screened_on, scp_screening_document_id: v.scp_screening.document_id, ai_vendor: v.kind === "ai_vendor", annual_test_warn_on: addMonths(v.onboarded_on, 9), annual_test_due: addMonths(v.onboarded_on, 12) }, v.onboarded_on, { actor: opts.actor ?? QC_AUDIT_ACTOR, aggregate: vendorSubject(v.vendor_id) });
  return { event, refusal: null, annual_test: vendorAnnualClock({ vendor_id: v.vendor_id, onboarded_on: v.onboarded_on, completed_tests: [], today: opts.today ?? v.onboarded_on }) };
}
/** The completed annual test, appended on the vendor subject (satisfies that vendor's `FNMA_A4101_VENDOR_QC_TEST_ANNUAL` and re-arms it a year out). */
export function recordVendorTestCompleted(events: QcEventSink, i: Parameters<typeof vendorTestCompleted>[0], opts: { actor?: Actor } = {}): { event: DomainEvent | null; refusal: string | null } {
  const r = vendorTestCompleted(i);
  if (!r.event) return { event: null, refusal: r.refusal };
  return { event: appendQcEvent(events, r.event, i.completed_on, { actor: opts.actor ?? QC_AUDIT_ACTOR, aggregate: vendorSubject(i.vendor_id) }), refusal: null };
}

// ---- findings: the appended state-machine transitions ------------------------------------------------------------
export interface FindingRecord { readonly finding_id: string; readonly status: FindingStatus; readonly severity: FindingSeverity; readonly root_cause: RootCause | null; readonly remediation_cents_total: Cents; readonly rationale?: string | null; }
/** `qc.finding.opened` appended on the finding subject (population- or subject-level); arms `SM_QC_FINDING_VALIDATE_5BD`. */
export function openFinding(events: QcEventSink, finding_id: string, opened: FindingOpenedEvent | PopulationFinding["event"], opts: { actor?: Actor } = {}): DomainEvent {
  return appendQcEvent(events, opened, opened.opened_at, { actor: opts.actor ?? QC_AUDIT_ACTOR, aggregate: findingSubject(finding_id) });
}
/**
 * The QC officer validates a finding: `qc.finding.validated{severity, remediation_cents_total, validated_at}` is appended on
 * the finding subject — it satisfies `SM_QC_FINDING_VALIDATE_5BD` and arms the CAPA clock (`SM_QC_CAPA_SEV1_10BD` for
 * sev-1) and, when `remediation_cents_total > 0`, `SM_QC_CONSUMER_REMEDIATION_30`. Refusals are the state machine's.
 */
export function validateFinding(events: QcEventSink, f: FindingRecord, actor: FindingActor, on: PlainDate): { ok: boolean; status: FindingStatus; refusal: string | null; event: DomainEvent | null } {
  const r = findingTransition(f, "validated", actor, on);
  if (!r.ok || !r.event) return { ok: false, status: r.status, refusal: r.refusal, event: null };
  const { type: _t, ...payload } = r.event;
  const event = events.append({ type: "qc.finding.validated", occurredAt: `${on}T16:00:00.000Z`, actor: asActor(actor), aggregate: findingSubject(f.finding_id), payload: { ...payload, finding_id: f.finding_id } });
  return { ok: true, status: "validated", refusal: null, event };
}
/** The QC officer rejects a finding (false positive, rationale required — findings are never deleted): `qc.finding.rejected{status=rejected}` also satisfies `SM_QC_FINDING_VALIDATE_5BD`. */
export function rejectFinding(events: QcEventSink, f: FindingRecord, actor: FindingActor, on: PlainDate): { ok: boolean; status: FindingStatus; refusal: string | null; event: DomainEvent | null } {
  const r = findingTransition(f, "rejected", actor, on);
  if (!r.ok || !r.event) return { ok: false, status: r.status, refusal: r.refusal, event: null };
  const { type: _t, ...payload } = r.event;
  const event = events.append({ type: "qc.finding.rejected", occurredAt: `${on}T16:00:00.000Z`, actor: asActor(actor), aggregate: findingSubject(f.finding_id), payload: { ...payload, finding_id: f.finding_id, rejected_at: on } });
  return { ok: true, status: "rejected", refusal: null, event };
}

// ---- AI governance: the proposed version (the `SM_AI_EVAL_GATE` trigger), its evaluation, the approval, the policy approval
export interface VersionProposal { readonly system_code: string; readonly version: string; readonly tier: AiTier; readonly change_kind: "new" | "minor" | "major"; readonly model_id?: string | null; readonly prompt_hash?: string | null; readonly rule_set_versions?: readonly string[]; readonly proposed_on: PlainDate; readonly proposed_by: FindingActor; }
/**
 * `ai_system_versions.status = proposed`: a new model / prompt / rule-set version enters change management (AI-GOV-003).
 * Appends `ai.version.proposed` on the version subject — `SM_AI_EVAL_GATE` arms as a not-before gate that only the
 * owner's approval (`ai.version.approved`) closes; a deploy attempt while it is open is refused (T7).
 */
export function proposeVersion(events: QcEventSink, p: VersionProposal): { version: AiVersion; event: DomainEvent } {
  if (!p.system_code || !p.version) throw new RangeError("system_code and version are required");
  if (!p.model_id && !p.prompt_hash && !(p.rule_set_versions?.length)) throw new RangeError(`${p.system_code}@${p.version}: a proposal names what changed — model_id, prompt_hash or rule_set_versions (AI-GOV-003 versioning)`);
  const version: AiVersion = { system_code: p.system_code, version: p.version, tier: p.tier, change_kind: p.change_kind, status: "proposed", suites: [], approved_by: null };
  const event = appendQcEvent(events, { type: "ai.version.proposed", system_code: p.system_code, version: p.version, risk_tier: p.tier, change_kind: p.change_kind, model_id: p.model_id ?? null, prompt_hash: p.prompt_hash ?? null, rule_set_versions: p.rule_set_versions ?? [], proposed_at: p.proposed_on, proposed_by: `${p.proposed_by.kind}:${p.proposed_by.id}`, gate: "SM_AI_EVAL_GATE" }, p.proposed_on, { actor: asActor(p.proposed_by), aggregate: versionSubject(p.system_code, p.version) });
  return { version, event };
}
/** `proposed → evaluated`: the evaluation suites ran (`ai_evaluations` rows); the results travel with the version for the gate. */
export function recordEvaluations(v: AiVersion, suites: readonly EvalSuite[]): { version: AiVersion; refusal: string | null } {
  if (v.status !== "proposed" && v.status !== "evaluated") return { version: v, refusal: `ai_system_versions: evaluate from proposed, not ${v.status}` };
  if (suites.length === 0) return { version: v, refusal: "no evaluation suites ran" };
  return { version: { ...v, status: "evaluated", suites }, refusal: null };
}
/** The owner's approval appended on the version subject — closes that version's `SM_AI_EVAL_GATE`. */
export function recordVersionApproved(events: QcEventSink, v: AiVersion, approver: FindingActor, on: PlainDate): ReturnType<typeof approveVersion> & { appended: DomainEvent | null } {
  const r = approveVersion(v, approver);
  if (!r.event) return { ...r, appended: null };
  return { ...r, appended: appendQcEvent(events, { ...r.event, approved_at: on }, on, { actor: asActor(approver), aggregate: versionSubject(v.system_code, v.version) }) };
}
/**
 * `ai_policy_documents`: an AI-GOV-* policy approved by its owner (`officer:ai_governance_owner`, LL-2026-04 "owner(s) that
 * implements, maintains and reviews the policies and procedures at least annually") with the signed document. Appends
 * `ai.policy.approved{approved_at}` on the policy subject — arms `FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL`.
 */
export function approvePolicy(events: QcEventSink, i: { policy_code: string; version: string; approved_on: PlainDate; owner: FindingActor; document_id: string | null }): { event: DomainEvent | null; refusal: string | null; next_review_due: PlainDate; warn_on: PlainDate } {
  const next_review_due = addMonths(i.approved_on, 12); const warn_on = addDays(next_review_due, -60);
  if (!/^AI-GOV-\d{3}$/.test(i.policy_code)) throw new RangeError(`policy_code must be an AI-GOV-nnn document, got ${i.policy_code}`);
  if (!isAiGovernanceOwner(i.owner)) return { event: null, refusal: "LL-2026-04: the AI/ML policy set is approved by its owner, officer:ai_governance_owner", next_review_due, warn_on };
  if (!i.document_id) return { event: null, refusal: "the signed policy document is the evidence", next_review_due, warn_on };
  const event = appendQcEvent(events, { type: "ai.policy.approved", policy_code: i.policy_code, version: i.version, approved_at: i.approved_on, owner: i.owner.id, document_id: i.document_id, next_review_due, warn_on }, i.approved_on, { actor: asActor(i.owner), aggregate: policySubject(i.policy_code) });
  return { event, refusal: null, next_review_due, warn_on };
}
/** The owner's annual review appended on the policy subject — satisfies (and re-arms) that policy's review clock. */
export function recordPolicyReviewed(events: QcEventSink, i: Parameters<typeof annualPolicyReview>[0]): ReturnType<typeof annualPolicyReview> & { appended: DomainEvent | null } {
  const r = annualPolicyReview(i);
  if (!r.event || !i.reviewer) return { ...r, appended: null };
  return { ...r, appended: appendQcEvent(events, r.event, r.event.reviewed_at, { actor: asActor(i.reviewer), aggregate: policySubject(i.policy_code) }) };
}

// ---- Fannie Mae requests for QC results (the `FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD` trigger) --------------------
/**
 * Fannie Mae's request for QC results, policies or "examples of application" arrives by letter/email/LQC and is logged
 * as `fnma.request.received{kind=qc_results, received_at}` on the request subject (Integrations: "no API"); the
 * package goes out as a `human_portal_task` (18.2) with the officer signature — `qcResultsDelivered` records it.
 */
export function qcResultsRequestReceived(events: QcEventSink, i: { request_id: string; received_on: PlainDate; stated_due?: PlainDate | null; requested: readonly string[]; channel: "letter" | "email" | "lqc"; cal?: Calendar }): ReturnType<typeof qcResultsRequest> & { request_id: string; event: DomainEvent } {
  if (!i.request_id) throw new RangeError("request_id is required");
  if (i.requested.length === 0) throw new RangeError(`${i.request_id}: the request names what Fannie Mae asked for (results, policies, examples of application)`);
  const r = qcResultsRequest({ received_on: i.received_on, stated_due: i.stated_due ?? null, ...(i.cal ? { cal: i.cal } : {}) });
  const event = appendQcEvent(events, { type: "fnma.request.received", kind: "qc_results", request_id: i.request_id, received_at: i.received_on, stated_due: i.stated_due ?? null, due: r.due, basis: r.basis, requested: i.requested, channel: i.channel }, i.received_on, { actor: { kind: "external", id: "fnma" }, aggregate: requestSubject(i.request_id) });
  return { ...r, request_id: i.request_id, event };
}

// ---- fiscal-year evidence 18.1 tracks (Section 19 / 18.4 own it): appended on the fiscal-year subject the FYE tick armed on
/** The officer's ISBR attestation appended on the fiscal-year subject — satisfies `FNMA_ISBR_ANNUAL_ATTESTATION` for that year and re-arms it at the next FYE + 90. */
export function recordIsbrAttestationSigned(events: QcEventSink, i: Parameters<typeof isbrAttestationSigned>[0], opts: { entity?: string } = {}): ReturnType<typeof isbrAttestationSigned> & { appended: DomainEvent | null } {
  const r = isbrAttestationSigned(i);
  if (!r.event || !i.signer) return { ...r, appended: null };
  return { ...r, appended: appendQcEvent(events, r.event, r.event.signed_at, { actor: asActor(i.signer), aggregate: fiscalYearSubject(opts.entity ?? "supermortgage", i.fiscal_year_end) }) };
}
/** The audited financial statements appended on the fiscal-year subject — with the auditor's opinion they satisfy `CSBS_EXTERNAL_AUDIT_ANNUAL` for that year and re-arm it at the next FYE + 12 months. */
export function recordAfsReceived(events: QcEventSink, i: Parameters<typeof afsReceived>[0], opts: { entity?: string } = {}): ReturnType<typeof afsReceived> & { appended: DomainEvent | null } {
  const r = afsReceived(i);
  if (!r.event) return { ...r, appended: null };
  return { ...r, appended: appendQcEvent(events, r.event, r.event.received_at, { actor: { kind: "external", id: i.auditor }, aggregate: fiscalYearSubject(opts.entity ?? "supermortgage", i.fiscal_year_end) }) };
}
