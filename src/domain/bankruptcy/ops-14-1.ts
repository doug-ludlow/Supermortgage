/**
 * §14.1 operating rules over the pure calculators in case.ts: notice ingestion
 * with immediate stay gates (rule 1, T1), PCL matching and the rejected notice
 * (rule 1, T2), the post-petition late-charge overlay (rules 4/5, T5), conversion
 * (rule 10, T6), Chapter 7 contractual application and discharge-injunction mode
 * (rules 6d/10, T10), debtor direct payments and `bk_postpetition_suspense`
 * (rule 6b, example B), plan review and the objection package (rule 7, T12),
 * cramdown / Form 20 (rule 9, T13), the Rule 4001(a)(3) relief-order gate and
 * `assertGateOpen` (rule 8, T14), post-sale filings (rule 12, T15), dismissal
 * reversion (rule 10, T16), counsel document requests (E-2.1-04, T17), docket
 * classification confidence (guardrails) and the expense claim against the
 * Allowable Bankruptcy Attorney Fees exhibit (rule 11, T18). Money is bigint
 * cents; dates are PlainDate; nothing here mutates the note.
 */
import { type PlainDate, addDays, addMonths, addYears, daysBetween, dayOfWeek } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { monthlyInterest, ratePercent, type Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import type { AccountRef, EntrySet, EntrySetInput, LineInput, LoanAccount } from "../../kernel/ledger/ledger.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { stayGates, conversionPocBar, priorFilingClass, applyVoucher, type Chapter, type Ledgers, type StayState } from "./case.ts";
import { rollForward9006 } from "./notices.ts";

export const RULE_SET_VERSION = { frbp: "frbp.2025-12", guide: "fnma.guide.2026-08-12", fees: "fnma.bk_fees.2025-11-12" } as const;

export interface Escalation { readonly kind: "attorney" | "officer" | "signing_officer" | "human_agent" | "fnma_portal_operator" | "lossmit_reviewer" | "human_portal_task"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; }
export type DecisionType = "verify" | "gate" | "prior_filing_class" | "referral" | "claim_compute" | "plan_review" | "objection" | "payment_application" | "mfr_path" | "agreed_order" | "cramdown_strategy" | "dismissal_close" | "post_sale";
export interface DecisionRecord { readonly decision_type: DecisionType; readonly outcome: string; readonly rationale: string; readonly rule_set_version: string; readonly human_review_reason: readonly string[]; }
export interface EmittedEvent { readonly type: string; readonly occurred_at: string; readonly payload: Record<string, unknown>; }

// ============================================================ stay-gate projection (data model `stay_gates`)
export interface StayGateProjection {
  readonly collections_blocked: boolean; readonly foreclosure_blocked: boolean; readonly late_charges_blocked: boolean; readonly nsf_fees_blocked: boolean; readonly autodraft_paused: boolean;
  readonly contact_route: "borrower" | "counsel_only" | "counsel_and_borrower_informational"; readonly early_intervention_mode: "normal" | "bk_modified_once" | "exempt";
  readonly payoff_mode: "standard" | "reasonable_time_bk"; readonly escrow_mode: "standard" | "postpetition_ch13"; readonly reason_codes: readonly string[]; readonly computed_at: string;
}
/** Every block on (E-2.1-03 "immediately suspend any and all debt collection efforts"; §362(a)(3)–(6)). */
export function gatesOn(computedAt: string, reason: string, chapter: Chapter | null = null): StayGateProjection {
  return { collections_blocked: true, foreclosure_blocked: true, late_charges_blocked: true, nsf_fees_blocked: true, autodraft_paused: true, contact_route: "counsel_only", early_intervention_mode: "bk_modified_once", payoff_mode: "reasonable_time_bk", escrow_mode: chapter === "13" || chapter === "12" ? "postpetition_ch13" : "standard", reason_codes: [reason], computed_at: computedAt };
}
/** Every block off — used when a notice is rejected (rule 1) or the case is dismissed (rule 10). */
export function gatesOff(computedAt: string, reason: string): StayGateProjection {
  return { collections_blocked: false, foreclosure_blocked: false, late_charges_blocked: false, nsf_fees_blocked: false, autodraft_paused: false, contact_route: "borrower", early_intervention_mode: "normal", payoff_mode: "standard", escrow_mode: "standard", reason_codes: [reason], computed_at: computedAt };
}

// ============================================================ rule 1: detection → gates immediately; verification in parallel
export type NoticeSource = "ebn" | "pcl" | "vendor" | "contact" | "mail" | "attorney" | "dra" | "boarding" | "trustee_payment";
export interface ScheduledContact { readonly id: string; readonly kind: string; readonly at: string; }
const COLLECTION_CONTACT = /^(d2202_call|d2_2_02_call|collection_call|qrpc_attempt|payment_reminder|breach_letter|outbound_collection)$/;
/**
 * A notice from any source creates `bankruptcy.notice.received` and applies gates in the
 * same transaction (E-2.1-03; §362(k)); verification runs in parallel, not before. Scheduled
 * outbound collection contacts (the D2-2-02 cadence) are cancelled.
 */
export const GATE_SLA_MINUTES = 5;
export function ingestNotice(i: { source: NoticeSource; received_at: string; loan_id: string; chapter?: Chapter | null; case_number_full?: string | null; scheduled_contacts?: readonly ScheduledContact[]; now?: string | null }): {
  events: EmittedEvent[]; gates: StayGateProjection; applied_at: string; applied_within_minutes: number; cancelled_contacts: ScheduledContact[];
  verification: { status: "verifying"; due: PlainDate; timer: "SM_BK_VERIFY_1BD" }; satisfies: "FNMA_E2_1_03_SUSPEND_COLLECTION_0"; sla: { limit_minutes: 5; breached: boolean; escalation: Escalation | null };
} {
  // The gate recomputation is written in the ingesting transaction; `now` is that transaction's clock (the projection's
  // `computed_at`) so `applied_within_minutes` is the real §342(g)/§362(k) evidence, not a constant.
  const appliedAt = i.now ?? i.received_at;
  if (Date.parse(appliedAt) < Date.parse(i.received_at)) throw new RangeError(`gates cannot be applied (${appliedAt}) before the notice was received (${i.received_at})`);
  const minutes = (Date.parse(appliedAt) - Date.parse(i.received_at)) / 60_000;
  const gates = gatesOn(appliedAt, `bankruptcy.notice.received:${i.source}`, i.chapter ?? null);
  const cancelled = (i.scheduled_contacts ?? []).filter((c) => COLLECTION_CONTACT.test(c.kind) && Date.parse(c.at) >= Date.parse(i.received_at));
  const receivedOn = i.received_at.slice(0, 10) as PlainDate;
  const breached = minutes > GATE_SLA_MINUTES;
  return {
    events: [
      { type: "bankruptcy.notice.received", occurred_at: i.received_at, payload: { loan_id: i.loan_id, source: i.source, case_number_full: i.case_number_full ?? null } },
      { type: "bankruptcy.gates.applied", occurred_at: appliedAt, payload: { loan_id: i.loan_id, ...gates, applied_within_minutes: minutes } },
      ...cancelled.map((c) => ({ type: "contact.scheduled.cancelled", occurred_at: appliedAt, payload: { loan_id: i.loan_id, contact_id: c.id, kind: c.kind, reason: "bankruptcy_active" } })),
    ],
    gates, applied_at: appliedAt, applied_within_minutes: minutes, cancelled_contacts: cancelled,
    verification: { status: "verifying", due: addBusinessDays(receivedOn, 1, servicer), timer: "SM_BK_VERIFY_1BD" }, satisfies: "FNMA_E2_1_03_SUSPEND_COLLECTION_0",
    sla: { limit_minutes: GATE_SLA_MINUTES, breached, escalation: breached ? { kind: "officer", severity: "sev1", reason: `stay gates applied ${minutes} minutes after the notice (limit ${GATE_SLA_MINUTES}): FNMA_E2_1_03_SUSPEND_COLLECTION_0 breach — §362(k) exposure; Compliance Sentinel` } : null },
  };
}

// ============================================================ rule 1: PCL matching and verification
export interface BorrowerIdentity { readonly last_name: string; readonly ssn4: string; readonly first_name: string; readonly property_address: string; }
export interface PclParty { readonly last_name: string; readonly ssn4: string; readonly first_name?: string | null; readonly address?: string | null; readonly case_number_full: string; readonly chapter?: Chapter; readonly date_filed?: PlainDate; }
const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** A hit is accepted when SSN4 + last name + (first name or property address in the case address) match. */
export function pclMatch(b: BorrowerIdentity, h: PclParty): { matched: boolean; reason: string } {
  if (norm(h.last_name) !== norm(b.last_name)) return { matched: false, reason: `last name ${h.last_name} ≠ ${b.last_name}` };
  if (h.ssn4 !== b.ssn4) return { matched: false, reason: `same surname, SSN4 ${h.ssn4} ≠ borrower SSN4 ${b.ssn4}` };
  const first = norm(h.first_name) !== "" && norm(h.first_name) === norm(b.first_name);
  const street = norm(b.property_address).split(",")[0] ?? "";
  const addr = street !== "" && norm(h.address).includes(street);
  return first || addr ? { matched: true, reason: `SSN4 + last name + ${first ? "first name" : "property address"} match on ${h.case_number_full}` } : { matched: false, reason: "SSN4 and surname match but neither first name nor property address does" };
}
export type SerialFilerClass = ReturnType<typeof priorFilingClass>;
export type ReferralType = "poc_only" | "full" | "cramdown" | "repeat_filer" | "post_sale" | "ch11" | "conversion" | "mfr";
export interface PriorCase { readonly case_number_full: string; readonly chapter: Chapter; readonly filed_on: PlainDate; readonly disposition: "dismissed" | "discharged" | "pending" | "closed"; readonly disposed_on: PlainDate | null; }
/** §362(c)(3)–(4): prior cases "pending within the preceding 1-year period" and dismissed — dismissed within the year before the petition. */
export function priorDismissedWithin1y(priorCases: readonly PriorCase[], petitionOn: PlainDate): PriorCase[] {
  return priorCases.filter((p) => p.disposition === "dismissed" && p.disposed_on !== null && p.disposed_on < petitionOn && p.disposed_on >= addYears(petitionOn, -1));
}
/** Rule 3 (F-2-01 / E-2.2-0x): full referral within 14 days when ≥60 dpd at filing, an open foreclosure, Chapter 11, a serial filer or a cramdown; otherwise `poc_only` immediately (14.1-Q3). */
export function initialReferralType(chapter: Chapter, fnmaDelinquencyDays: number, openForeclosure: boolean, serialFilerClass: SerialFilerClass, cramdown = false): ReferralType {
  if (chapter === "11") return "ch11";
  if (serialFilerClass !== "none") return "repeat_filer";
  if (cramdown) return "cramdown";
  return fnmaDelinquencyDays >= 60 || openForeclosure ? "full" : "poc_only";
}
/**
 * Verification outcome: a matched hit (or a notice case number that resolves) opens the case; otherwise the notice is
 * rejected with a decision record and the gates are released. Both outcomes emit `bankruptcy.notice.verified{result}`
 * (the one event `SM_BK_VERIFY_1BD` is satisfied by — the registry grammar holds a single pattern, the spec's
 * "`bankruptcy.petition.filed` or `bankruptcy.notice.rejected` (with evidence)" are both emitted alongside it).
 * `bankruptcy.petition.filed` carries the verified facts the §14.1 clocks key on (`serial_filer_class`, `referral`,
 * `chapter`, `petition_date`); Chapters 7/12/13 also open the Rule 3002(c) claims window (`bankruptcy.claims_window.opened`)
 * and Chapter 11 requires Form 20 within 1 BD (`bankruptcy.form20.required{cause=chapter_11}`, E-2.2-02).
 */
export function verifyNotice(i: { notice_id: string; loan_id: string; borrower: BorrowerIdentity; hits: readonly PclParty[]; case_number_from_notice?: string | null; verified_at: string; prior_cases?: readonly PriorCase[]; abusive_pattern?: boolean; fnma_delinquency_days_at_filing?: number; open_foreclosure?: boolean }): {
  case_opened: boolean; case_number_full: string | null; decision: DecisionRecord; event: EmittedEvent; events: EmittedEvent[]; gates: StayGateProjection; timer_satisfied: "SM_BK_VERIFY_1BD"; serial_filer_class: SerialFilerClass | null; referral: ReferralType | null;
} {
  const evaluated = i.hits.map((h) => ({ hit: h, ...pclMatch(i.borrower, h) }));
  const byNumber = i.case_number_from_notice ? i.hits.find((h) => h.case_number_full === i.case_number_from_notice) ?? null : null;
  const match = evaluated.find((e) => e.matched)?.hit ?? byNumber;
  if (match) {
    const chapter = match.chapter ?? null; const petitionOn = match.date_filed ?? null;
    const serial = priorFilingClass(petitionOn ? priorDismissedWithin1y(i.prior_cases ?? [], petitionOn).length : 0, i.abusive_pattern === true);
    const referral = chapter ? initialReferralType(chapter, i.fnma_delinquency_days_at_filing ?? 0, i.open_foreclosure === true, serial) : null;
    const filed: EmittedEvent = { type: "bankruptcy.petition.filed", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, case_number_full: match.case_number_full, chapter, petition_date: petitionOn, order_for_relief_date: petitionOn, serial_filer_class: serial, referral, fnma_delinquency_days: i.fnma_delinquency_days_at_filing ?? 0, open_foreclosure: i.open_foreclosure === true, notice_id: i.notice_id } };
    const events: EmittedEvent[] = [filed, { type: "bankruptcy.notice.verified", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, notice_id: i.notice_id, result: "case_opened", case_number_full: match.case_number_full } }];
    if (petitionOn && (chapter === "7" || chapter === "12" || chapter === "13")) events.push({ type: "bankruptcy.claims_window.opened", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, case_number_full: match.case_number_full, chapter, cause: "order_for_relief", anchor: "order_for_relief_date", anchored_on: petitionOn, rule: "Fed. R. Bankr. P. 3002(c)" } });
    if (chapter === "11") events.push({ type: "bankruptcy.form20.required", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, case_number_full: match.case_number_full, cause: "chapter_11", guide: "E-2.2-02" } });
    // 7.1 alias (data model event alias map: `bankruptcy.petition.filed` = 7.1 `bankruptcy.case.opened`): the opened case arms the recurring docket reconciliation (SM_BK_DOCKET_SYNC_1BD)
    events.push({ type: "bankruptcy.case.opened", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, case_number_full: match.case_number_full, chapter, petition_date: petitionOn, opened_at: i.verified_at } });
    events.push({ type: "bankruptcy.status.changed", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, to: "active", chapter } });
    return { case_opened: true, case_number_full: match.case_number_full, decision: { decision_type: "verify", outcome: "verified", rationale: evaluated.find((e) => e.matched)?.reason ?? `case number ${match.case_number_full} from the notice resolved via cases/find`, rule_set_version: RULE_SET_VERSION.guide, human_review_reason: [] },
      event: filed, events, gates: gatesOn(i.verified_at, "bankruptcy.petition.filed", chapter), timer_satisfied: "SM_BK_VERIFY_1BD", serial_filer_class: serial, referral };
  }
  const rationale = evaluated.length ? `no PCL hit matches: ${evaluated.map((e) => `${e.hit.case_number_full} — ${e.reason}`).join("; ")}` : "no PCL/vendor hit for the borrower";
  const evidence = evaluated.map((e) => ({ case_number_full: e.hit.case_number_full, reason: e.reason }));
  const rejected: EmittedEvent = { type: "bankruptcy.notice.rejected", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, notice_id: i.notice_id, evidence } };
  return { case_opened: false, case_number_full: null, decision: { decision_type: "verify", outcome: "rejected", rationale, rule_set_version: RULE_SET_VERSION.guide, human_review_reason: [] },
    event: rejected, events: [rejected, { type: "bankruptcy.notice.verified", occurred_at: i.verified_at, payload: { loan_id: i.loan_id, notice_id: i.notice_id, result: "rejected", evidence } }], gates: gatesOff(i.verified_at, "bankruptcy.notice.rejected"), timer_satisfied: "SM_BK_VERIFY_1BD", serial_filer_class: null, referral: null };
}

// ============================================================ rules 4/5: the 2.7 `bankruptcy_active` late-charge overlay
/** A late charge whose grace period ends on or after the petition date is never assessed (memo only; billable only through a 14.2 notice where the district permits, 14.1-Q6). */
export function postpetitionLateCharge(i: { due: PlainDate; grace_days: number; petition_on: PlainDate; late_charge_cents: Cents; postpetition_late_charges_permitted?: boolean }): {
  grace_ends: PlainDate; postpetition: boolean; assessed_cents: Cents; memo_cents: Cents; claim_item: boolean; billable_via_14_2: boolean; overlay: "bankruptcy_active" | null; reason: string;
} {
  const graceEnds = addDays(i.due, i.grace_days);
  const post = graceEnds >= i.petition_on;   // the assessment would fall the day after grace, i.e. post-petition
  if (!post) return { grace_ends: graceEnds, postpetition: false, assessed_cents: i.late_charge_cents, memo_cents: 0n, claim_item: true, billable_via_14_2: false, overlay: null, reason: `grace ended ${graceEnds} before the petition ${i.petition_on}: pre-petition late charge is a Form 410A Part 3 fee item` };
  return { grace_ends: graceEnds, postpetition: true, assessed_cents: 0n, memo_cents: i.late_charge_cents, claim_item: false, billable_via_14_2: i.postpetition_late_charges_permitted === true, overlay: "bankruptcy_active", reason: `grace ends ${graceEnds} on or after the petition ${i.petition_on}: not assessed (2.7 bankruptcy_active overlay; 14.1-Q6)` };
}

// ============================================================ rule 10: conversion
/** Rule 10: "the Chapter 13 ledgers are frozen" — the plan-terms ledgers become immutable (any later `applyVoucher`/`applyDebtorPayment` throws a TypeError); the frozen snapshot is the record of the plan-terms view at conversion. */
export function freezeLedgers(l: Ledgers): Ledgers { for (const p of l.postpetition) Object.freeze(p); Object.freeze(l.postpetition); return Object.freeze(l); }
export const ledgersFrozen = (l: Ledgers): boolean => Object.isFrozen(l) && Object.isFrozen(l.postpetition);
/** Conversion keeps the petition date, switches chapter and gates, freezes the Chapter 13 ledgers and runs a new 70-day claims window from the conversion order (Rule 3002(c)). */
export function convertCase(i: { petition_on: PlainDate; chapter_from: Chapter; chapter_to: Chapter; conversion_on: PlainDate; ledgers: Ledgers; loan_id?: string; case_number_full?: string | null }): {
  chapter: Chapter; converted_from_chapter: Chapter; petition_date: PlainDate; conversion_date: PlainDate; poc_bar: PlainDate; poc_timer: { code: "FRBP_3002C_POC_BAR_70"; anchor: "conversion_date"; anchored_on: PlainDate; days: 70; due: PlainDate };
  ledgers_frozen: boolean; frozen_snapshot: { prepetition_arrearage_cents: Cents; postpetition_unpaid: PlainDate[]; postpetition_suspense_cents: Cents } | null; payment_application: "contractual_fifo" | "plan_terms"; referral: { type: "conversion"; to: "attorney" }; events: string[]; emitted: EmittedEvent[];
} {
  const freeze = (i.chapter_from === "13" || i.chapter_from === "12" || i.chapter_from === "11") && i.chapter_to === "7";
  const bar = rollForward9006(conversionPocBar(i.conversion_on));
  if (freeze) freezeLedgers(i.ledgers);   // rule 10: "the Chapter 13 ledgers are frozen and payments revert to contractual FIFO" — a later plan-terms application throws
  const at = `${i.conversion_on}T12:00:00.000Z`; const loan = i.loan_id ?? "";
  const emitted: EmittedEvent[] = [
    { type: "bankruptcy.case.converted", occurred_at: at, payload: { loan_id: loan, case_number_full: i.case_number_full ?? null, chapter_from: i.chapter_from, chapter_to: i.chapter_to, conversion_date: i.conversion_on, petition_date: i.petition_on, ledgers_frozen: freeze } },
    // Rule 3002(c): "70 days after the order for relief or entry of an order converting the case" — the same claims-window event the verified petition emits, anchored on the conversion order.
    ...(i.chapter_to === "7" || i.chapter_to === "12" || i.chapter_to === "13" ? [{ type: "bankruptcy.claims_window.opened", occurred_at: at, payload: { loan_id: loan, case_number_full: i.case_number_full ?? null, chapter: i.chapter_to, cause: "conversion", anchor: "conversion_date", anchored_on: i.conversion_on, rule: "Fed. R. Bankr. P. 3002(c)" } }] : []),
    { type: "bankruptcy.status.changed", occurred_at: at, payload: { loan_id: loan, to: "converted", chapter: i.chapter_to } },
  ];
  return {
    chapter: i.chapter_to, converted_from_chapter: i.chapter_from, petition_date: i.petition_on, conversion_date: i.conversion_on, poc_bar: bar,
    poc_timer: { code: "FRBP_3002C_POC_BAR_70", anchor: "conversion_date", anchored_on: i.conversion_on, days: 70, due: bar },
    ledgers_frozen: freeze, frozen_snapshot: freeze ? { prepetition_arrearage_cents: i.ledgers.prepetition_arrearage_cents, postpetition_unpaid: i.ledgers.postpetition.filter((p) => p.paid_cents < p.amount_cents).map((p) => p.due), postpetition_suspense_cents: i.ledgers.postpetition_suspense_cents } : null,
    payment_application: i.chapter_to === "7" ? "contractual_fifo" : "plan_terms", referral: { type: "conversion", to: "attorney" }, events: emitted.map((e) => e.type), emitted,
  };
}

// ============================================================ rule 6: payment application
export interface ContractInstallment { readonly due: PlainDate; readonly amount_cents: Cents; paid_cents: Cents; }
/** Rule 6(d): Chapter 7 — no plan, no separate ledger; a receipt applies contractually FIFO to the oldest unpaid installment (full installments only; the rest stays unapplied). */
export function applyContractualFifo(installments: ContractInstallment[], amount_cents: Cents): { applied: { due: PlainDate; cents: Cents }[]; remaining_unpaid: PlainDate[]; unapplied_cents: Cents } {
  let pool = amount_cents; const applied: { due: PlainDate; cents: Cents }[] = [];
  for (const inst of [...installments].sort((a, b) => (a.due < b.due ? -1 : 1))) {
    const need = inst.amount_cents - inst.paid_cents; if (need <= 0n) continue; if (pool < need) break;
    inst.paid_cents += need; pool -= need; applied.push({ due: inst.due, cents: need });
  }
  return { applied, remaining_unpaid: installments.filter((x) => x.paid_cents < x.amount_cents).map((x) => x.due).sort(), unapplied_cents: pool };
}
/**
 * Rule 6(b): a debtor's direct post-petition payment applies to the oldest unpaid post-petition
 * installment and never touches the pre-petition arrearage (unless counsel directs it in writing);
 * a partial goes to `bk_postpetition_suspense` under `bankruptcy_hold` (no 30-day return clock)
 * and is released when a full installment accumulates.
 */
export function applyDebtorPayment(l: Ledgers, amount_cents: Cents, received_on: PlainDate, counsel_directs_arrears = false): { applied: { due: PlainDate; cents: Cents }[]; applied_arrearage_cents: Cents; suspense_cents: Cents; hold: "bankruptcy_hold" | null; return_clock: null; received_on: PlainDate } {
  let pool = l.postpetition_suspense_cents + amount_cents; const applied: { due: PlainDate; cents: Cents }[] = [];
  for (const inst of l.postpetition.sort((a, b) => (a.due < b.due ? -1 : 1))) {
    const need = inst.amount_cents - inst.paid_cents; if (need <= 0n) continue; if (pool < need) break;
    inst.paid_cents += need; pool -= need; applied.push({ due: inst.due, cents: need });
  }
  let ar = 0n;
  if (counsel_directs_arrears && pool > 0n) { ar = pool < l.prepetition_arrearage_cents ? pool : l.prepetition_arrearage_cents; l.prepetition_arrearage_cents -= ar; pool -= ar; }
  l.postpetition_suspense_cents = pool;
  return { applied, applied_arrearage_cents: ar, suspense_cents: pool, hold: pool > 0n ? "bankruptcy_hold" : null, return_clock: null, received_on };
}

/**
 * Rule 8 / worked example A: `postpetition_days_delinquent` counts only whole unpaid installments —
 * a partially applied installment (an escrow `short_cents`, 14.1-Q5) leaves the loan post-petition
 * current. `postpetition_fnma_bucket` is Fannie Mae's month bucket: 60 when two installments are
 * wholly unpaid on the day after the second's due date (the spec's rule), 30 when one installment is
 * 30+ days unpaid, else 0 — an installment inside its own 30-day cycle (example A's Dec 1 on 12-18) is
 * not a delinquency bucket, so `current` is "not in a bucket". (case.ts `postpetitionDelinquencyDays`
 * counts a short installment as unpaid — the defect this function corrects.)
 */
export function postpetitionStatus(l: Ledgers, today: PlainDate): { current: boolean; days_delinquent: number; whole_unpaid: PlainDate[]; short: { due: PlainDate; short_cents: Cents }[]; fnma_bucket: 0 | 30 | 60 | 90 | 120; event: "bankruptcy.postpetition.delinquency.60" | null } {
  const sorted = [...l.postpetition].sort((a, b) => (a.due < b.due ? -1 : 1));
  const whole = sorted.filter((p) => p.paid_cents === 0n && p.due < today).map((p) => p.due);
  const short = sorted.filter((p) => p.paid_cents > 0n && p.paid_cents < p.amount_cents).map((p) => ({ due: p.due, short_cents: p.amount_cents - p.paid_cents }));
  const days = whole.length ? daysBetween(whole[0]!, today) : 0;
  const bucket = (whole.length >= 2 ? Math.min(4, whole.length) * 30 : whole.length === 1 && days >= 30 ? 30 : 0) as 0 | 30 | 60 | 90 | 120;
  return { current: bucket === 0, days_delinquent: days, whole_unpaid: whole, short, fnma_bucket: bucket, event: bucket >= 60 ? "bankruptcy.postpetition.delinquency.60" : null };
}

// ============================================================ rule 10: discharge
/** After discharge the loan is in discharge-injunction mode (§524(a)(2)): informational communications only, no personal-liability demands, in rem enforcement after the E-2.2-01 breach letter's informational variant. */
export function dischargeMode(i: { chapter: Chapter; discharge_on: PlainDate; reaffirmed: boolean; cured_and_maintained?: boolean; fnma_delinquency_days: number; loan_id?: string }): {
  debt_discharged: boolean; mode: "discharge_injunction" | "contractual"; stay_status: "ended_discharge"; gates: ReturnType<typeof stayGates>; contact_route: "informational_only" | "counsel_only" | "normal";
  breach_letter_template: "NTC_BK_BREACH_INFORMATIONAL" | "standard"; personal_liability_demands: boolean; foreclosure: "in_rem_only" | "standard"; statement_mode: "informational_h30e" | "standard"; credit_cii: "E" | "H" | null;
  referral_after_breach_allowed: boolean; fnma_status_code_while_open: "65" | "66" | "67" | "59"; events: string[]; emitted: EmittedEvent[];
} {
  const discharged = i.chapter === "7" ? !i.reaffirmed : i.chapter === "13" ? !(i.cured_and_maintained ?? true) : !i.reaffirmed;
  const g = stayGates("ended_discharge");
  const at = `${i.discharge_on}T12:00:00.000Z`; const loan = i.loan_id ?? "";
  const emitted: EmittedEvent[] = [
    { type: "bankruptcy.case.discharged", occurred_at: at, payload: { loan_id: loan, chapter: i.chapter, discharge_date: i.discharge_on, debt_discharged: discharged, reaffirmed: i.reaffirmed } },
    { type: "bankruptcy.stay.terminated", occurred_at: at, payload: { loan_id: loan, reason: "discharge", statute: "11 U.S.C. §362(c)(2)(C)" } },
    { type: "bankruptcy.status.changed", occurred_at: at, payload: { loan_id: loan, to: "discharged", chapter: i.chapter, mode: discharged ? "discharge_injunction" : "contractual" } },
  ];
  return {
    debt_discharged: discharged, mode: discharged ? "discharge_injunction" : "contractual", stay_status: "ended_discharge", gates: g, contact_route: discharged ? "informational_only" : "normal",
    breach_letter_template: discharged ? "NTC_BK_BREACH_INFORMATIONAL" : "standard", personal_liability_demands: false, foreclosure: discharged ? "in_rem_only" : "standard", statement_mode: discharged ? "informational_h30e" : "standard",
    credit_cii: discharged ? (i.chapter === "7" ? "E" : "H") : null, referral_after_breach_allowed: i.fnma_delinquency_days >= 120, fnma_status_code_while_open: i.chapter === "7" ? "65" : i.chapter === "11" ? "66" : i.chapter === "13" ? "67" : "59",
    events: emitted.map((e) => e.type), emitted,
  };
}

// ============================================================ rule 7: plan review and objections (E-2.1-06)
export type PlanModification = "rate" | "term" | "principal" | "maturity" | "lien";
export interface PlanTerms { readonly arrearage_proposed_cents: Cents; readonly cure_months: number; readonly plan_length_months?: number; readonly arrearage_interest_rate_pct?: string | null; readonly treatment: "cure_and_maintain" | "pay_outside" | "surrender" | "cramdown" | "lien_avoidance" | "short_term_modify"; readonly modifies: readonly PlanModification[]; readonly attorney_fees_included: boolean; }
export const OBJECTION_FEE_CENTS = 70_000n;   // Allowable Bankruptcy Attorney Fees exhibit (11/12/2025): Ch. 12/13 Objection to Plan $700
/** Arrearage tolerance: $50 or 0.5% of the claim, whichever is larger. */
export function arrearageTolerance(claimCents: Cents): Cents { const pct = divRound(claimCents * 5n, 1000n, "HALF_UP"); return pct > 5_000n ? pct : 5_000n; }
export function planReview(i: { plan: PlanTerms; claim_arrearage_cents: Cents; note_interest_on_arrears: boolean; principal_residence: boolean; conduit_district: boolean; objection_deadline: PlainDate; today: PlainDate }): {
  objection: boolean; grounds: string[]; variance_cents: Cents; tolerance_cents: Cents; cramdown_path: boolean; surrender: boolean;
  package: { template: "CRT_OBJ_CONFIRMATION"; fee_cents: Cents; escalation: Escalation; due_before: PlainDate; warn_at: PlainDate; produced_on: PlainDate; in_time: boolean; timer: "SM_BK_PLAN_OBJECTION_DEADLINE" } | null; decision: DecisionRecord;
} {
  const p = i.plan; const grounds: string[] = [];
  const variance = p.arrearage_proposed_cents > i.claim_arrearage_cents ? p.arrearage_proposed_cents - i.claim_arrearage_cents : i.claim_arrearage_cents - p.arrearage_proposed_cents;
  const tol = arrearageTolerance(i.claim_arrearage_cents);
  if (variance > tol) grounds.push(`arrearage variance ${variance} cents exceeds tolerance ${tol} cents (proposed vs Form 410A Part 3)`);
  const maxCure = Math.min(60, p.plan_length_months ?? 60);
  if (p.cure_months > maxCure) grounds.push(`cure period ${p.cure_months} months exceeds ${maxCure} months (§1322(d); local rule)`);
  const planInterest = p.arrearage_interest_rate_pct != null && p.arrearage_interest_rate_pct !== "0";
  if (planInterest !== i.note_interest_on_arrears) grounds.push(planInterest ? "interest on arrears proposed although the note/state law provide none (§1322(e))" : "no interest on arrears although the note/state law provide it (§1322(e))");
  const modifies = p.modifies.filter((m) => m !== "lien"); const cramdown = modifies.length > 0 && !i.principal_residence;
  if (modifies.length && i.principal_residence && p.treatment !== "short_term_modify") grounds.push(`plan modifies ${modifies.join("/")} on the principal residence (§1322(b)(2))`);
  if (p.modifies.includes("lien")) grounds.push("lien avoidance/stripping proposed");
  if (p.treatment === "pay_outside" && i.conduit_district) grounds.push("pay-outside treatment in a conduit district");
  if (!p.attorney_fees_included) grounds.push("attorney fees omitted from the plan");
  // Rule 7 lists each ground independently: a cramdown path (rule 9, Form 20) never waives an arrearage/cure/interest/fee objection.
  const objection = grounds.length > 0;
  const warnAt = addDays(i.today, Math.floor(0.7 * Math.max(0, daysBetween(i.today, i.objection_deadline))));
  return {
    objection, grounds, variance_cents: variance, tolerance_cents: tol, cramdown_path: cramdown, surrender: p.treatment === "surrender",
    package: objection ? { template: "CRT_OBJ_CONFIRMATION", fee_cents: OBJECTION_FEE_CENTS, escalation: { kind: "attorney", reason: `objection to confirmation: ${grounds.join("; ")}` }, due_before: i.objection_deadline, warn_at: warnAt, produced_on: i.today, in_time: i.today < i.objection_deadline, timer: "SM_BK_PLAN_OBJECTION_DEADLINE" } : null,
    decision: { decision_type: objection ? "objection" : "plan_review", outcome: objection ? (cramdown ? "object_and_cramdown_path" : "object") : cramdown ? "cramdown_path" : "no_objection", rationale: grounds.length ? grounds.join("; ") + (cramdown ? "; cramdown path (rule 9) runs in parallel" : "") : cramdown ? "no objection ground; cramdown path (rule 9, Form 20)" : "plan treatment matches the claim; a silent non-objection is a recorded decision (§1327)", rule_set_version: RULE_SET_VERSION.guide, human_review_reason: objection ? ["attorney files every objection"] : [] },
  };
}

// ============================================================ rule 9: cramdown / Form 20 (E-2.3-03; SVC-2025-06)
export function cramdownRequest(i: { claim_cents: Cents; secured_value_cents?: Cents | null; bifurcates: boolean; modifies: readonly PlanModification[]; principal_residence: boolean; short_term_or_balloon?: boolean; requested_on: PlainDate; recourse_or_indemnification: boolean; confirmed_on?: PlainDate | null }): {
  cramdown: boolean; event: "bankruptcy.cramdown.requested" | null; form20: { timer: "FNMA_E2_3_03_FORM20_IMMEDIATE_1BD"; due: PlainDate; status: "package_ready"; contents: string[]; review: "attorney"; submits: "officer" } | null;
  form_3179_created: false; note_modified: false; secured_cents: Cents | null; unsecured_cents: Cents | null; repurchase: { required_before_implementation: boolean; decided_by: "officer" };
  smdu_task: { kind: "human_portal_task"; owner_role: "fnma_portal_operator"; plan_terms_view: "pending_fnma_booking"; created_on: PlainDate } | null; bk_unsecured_cramdown_opened: boolean; late_charges_capitalized: false; escalations: Escalation[]; emitted: EmittedEvent[];
} {
  const cram = (i.bifurcates || i.modifies.length > 0) && (!i.principal_residence || i.short_term_or_balloon === true);
  const at = `${i.requested_on}T12:00:00.000Z`;
  const emitted: EmittedEvent[] = cram ? [{ type: "bankruptcy.cramdown.requested", occurred_at: at, payload: { claim_cents: i.claim_cents, secured_value_cents: i.secured_value_cents ?? null, modifies: [...i.modifies], principal_residence: i.principal_residence } },
    { type: "bankruptcy.form20.required", occurred_at: at, payload: { cause: "cramdown", guide: "E-2.3-03", requested_on: i.requested_on } }] : [];
  const secured = i.bifurcates && i.secured_value_cents != null ? (i.secured_value_cents < i.claim_cents ? i.secured_value_cents : i.claim_cents) : null;
  const esc: Escalation[] = cram ? [{ kind: "attorney", reason: "cramdown strategy review before Form 20" }, { kind: "officer", severity: "sev1", reason: "Form 20 submission to Fannie Mae Legal (F-4-02); Fannie Mae must be consulted on all cramdown strategy" }] : [];
  if (cram && i.recourse_or_indemnification) esc.push({ kind: "officer", reason: "voluntary repurchase decision must precede implementation (A1-3-01; SVC-2025-06)" });
  const confirmed = cram && i.confirmed_on != null;
  if (confirmed) esc.push({ kind: "fnma_portal_operator", reason: "report confirmed cramdown terms through the SMDU UI" });
  return {
    cramdown: cram, event: cram ? "bankruptcy.cramdown.requested" : null,
    form20: cram ? { timer: "FNMA_E2_3_03_FORM20_IMMEDIATE_1BD", due: addBusinessDays(i.requested_on, 1, fannieEt), status: "package_ready", contents: ["case facts", "plan terms", "valuation comparison", "recourse/indemnification status", "MBS/portfolio status", "recommended strategy"], review: "attorney", submits: "officer" } : null,
    form_3179_created: false, note_modified: false, secured_cents: secured, unsecured_cents: secured === null ? null : i.claim_cents - secured, repurchase: { required_before_implementation: cram && i.recourse_or_indemnification, decided_by: "officer" },
    smdu_task: confirmed ? { kind: "human_portal_task", owner_role: "fnma_portal_operator", plan_terms_view: "pending_fnma_booking", created_on: i.confirmed_on as PlainDate } : null, bk_unsecured_cramdown_opened: confirmed, late_charges_capitalized: false, escalations: esc, emitted,
  };
}

// ============================================================ rule 8: relief order and the Rule 4001(a)(3) 14-day stay
/** `relief_granted` → `foreclosure_blocked` stays true through the 14th day after entry (9006 forward) unless the order waives the stay; collections stay blocked in personam while the case is open. */
export function reliefOrderGate(i: { entered_on: PlainDate; waived_stay: boolean; today: PlainDate; loan_id?: string }): { stay_status: "relief_granted"; foreclosure_blocked: boolean; stayed_through: PlainDate; opens_on: PlainDate; collections_blocked: true; contact_route: "counsel_only"; timer: "FRBP_4001A3_ORDER_STAY_14"; events: string[]; emitted: EmittedEvent[] } {
  const through = i.waived_stay ? i.entered_on : rollForward9006(addDays(i.entered_on, 14));
  const opens = i.waived_stay ? i.entered_on : addDays(through, 1);
  const blocked = i.today < opens; const loan = i.loan_id ?? "";
  const emitted: EmittedEvent[] = [
    { type: "bankruptcy.stay.relief_granted", occurred_at: `${i.entered_on}T12:00:00.000Z`, payload: { loan_id: loan, entered_on: i.entered_on, stayed_through: through, opens_on: opens, waived_14_day_stay: i.waived_stay } },
    { type: "bankruptcy.status.changed", occurred_at: `${i.entered_on}T12:00:00.000Z`, payload: { loan_id: loan, to: "relief_granted" } },
    // The daily stay-gate recomputation emits the expiry of the Rule 4001(a)(3) stay once — the event the gate is satisfied by ("expiry → foreclosure_blocked=false").
    ...(blocked ? [] : [{ type: "bankruptcy.stay.relief_effective", occurred_at: `${i.today}T12:00:00.000Z`, payload: { loan_id: loan, entered_on: i.entered_on, opened_on: opens, foreclosure_blocked: false, timer: "FRBP_4001A3_ORDER_STAY_14" } }]),
  ];
  return { stay_status: "relief_granted", foreclosure_blocked: blocked, stayed_through: through, opens_on: opens, collections_blocked: true, contact_route: "counsel_only", timer: "FRBP_4001A3_ORDER_STAY_14", events: emitted.map((e) => e.type), emitted };
}
export class GateClosed extends Error { readonly gate: string; readonly opens_on: PlainDate; readonly action: string; constructor(gate: string, action: string, opensOn: PlainDate, why: string) { super(`${gate}: ${action} refused — ${why}`); this.name = "GateClosed"; this.gate = gate; this.opens_on = opensOn; this.action = action; } }
/** `assertGateOpen` for a foreclosure act (referral, first legal, sale, publication) while a relief order's 14-day stay runs. Throws `GateClosed`. */
export function assertGateOpen(i: { action: "foreclosure.refer" | "foreclosure.first_legal" | "foreclosure.sale" | "foreclosure.publication"; entered_on: PlainDate; waived_stay: boolean; today: PlainDate }): { allowed: true; gate: "FRBP_4001A3_ORDER_STAY_14"; opened_on: PlainDate; event: "foreclosure.gate.checked" } {
  const g = reliefOrderGate(i);
  if (g.foreclosure_blocked) throw new GateClosed("FRBP_4001A3_ORDER_STAY_14", i.action, g.opens_on, `relief order entered ${i.entered_on} is stayed through ${g.stayed_through} (Fed. R. Bankr. P. 4001(a)(3)); foreclosure_blocked=true until ${g.opens_on}`);
  return { allowed: true, gate: "FRBP_4001A3_ORDER_STAY_14", opened_on: g.opens_on, event: "foreclosure.gate.checked" };
}

// ============================================================ rule 12: post-sale filings (E-2.3-06)
export function postSaleIdentified(i: { sale_held_on: PlainDate; petition_on: PlainDate; learned_on: PlainDate; learned_at?: string | null }): {
  post_sale: boolean; event: "bankruptcy.post_sale.identified" | null; template: { name: "Bankruptcy Notification Template"; to: "SF CPM"; timer: "FNMA_E2_3_06_POST_SALE_NOTIFY_2BD"; due: PlainDate; includes_reogram_status: true; officer_cc: true } | null;
  counsel: { engaged_on: PlainDate; escalation: Escalation } | null; gates: StayGateProjection; eviction_reo_frozen: boolean; reogram_p360_update: "per_fnma_direction_15_1" | null; sale_validity: "attorney_review_possible_stay_violation" | "not_applicable";
} {
  const post = i.petition_on <= i.sale_held_on;
  const at = i.learned_at ?? `${i.learned_on}T12:00:00.000Z`;
  if (!post) return { post_sale: false, event: null, template: null, counsel: null, gates: gatesOff(at, "petition after the sale: no post-sale review"), eviction_reo_frozen: false, reogram_p360_update: null, sale_validity: "not_applicable" };
  return {
    post_sale: true, event: "bankruptcy.post_sale.identified", template: { name: "Bankruptcy Notification Template", to: "SF CPM", timer: "FNMA_E2_3_06_POST_SALE_NOTIFY_2BD", due: addBusinessDays(i.learned_on, 2, fannieEt), includes_reogram_status: true, officer_cc: true },
    counsel: { engaged_on: i.learned_on, escalation: { kind: "attorney", severity: "sev1", reason: `petition ${i.petition_on} predates the foreclosure sale held ${i.sale_held_on}: the sale may be void as a stay violation (§362(a)(3)–(5)); counsel engaged ${i.learned_on}` } },
    gates: gatesOn(at, "bankruptcy.post_sale.identified"), eviction_reo_frozen: true, reogram_p360_update: "per_fnma_direction_15_1", sale_validity: "attorney_review_possible_stay_violation",
  };
}

// ============================================================ rule 10: dismissal reversion
export interface ContractualInstallment { readonly due: PlainDate; readonly pi_cents: Cents; readonly escrow_cents: Cents; }
/** On dismissal `bk_prepetition_arrearage` dissolves back into the contractual installments: cure receipts (applied P&I-first, 14.1-Q5) reduce the oldest installments FIFO exactly as they were applied; suspended late charges are waived (2.7 default); 13.x resumes with the breach letter. */
export function dismissalReversion(i: { dismissed_on: PlainDate; cured_cents: Cents; prepetition_installments: readonly ContractualInstallment[]; suspended_late_charges_cents: Cents; counsel_confirmed_stay_ended?: boolean; loan_id?: string; case_number_full?: string | null; dismissal_with_prejudice?: boolean }): {
  stay_status: "ended_dismissal"; gates: StayGateProjection; ledger_of_record: "contract_terms"; contract_terms_view: { due: PlainDate; pi_cents: Cents; cured_cents: Cents; status: "cured" | "partially_cured" | "unpaid" }[];
  cured_installments: PlainDate[]; partially_cured: { due: PlainDate; cured_cents: Cents; remaining_cents: Cents } | null; residual_unapplied_cents: Cents;
  late_charges: { suspended_cents: Cents; waived_cents: Cents; decision: "waived_default"; rule: "2.7" }; events: (EmittedEvent & { consumers: string[] })[];
  foreclosure: { resumes: true; requires_breach_letter: true; guide: "E-2.2-01/-04" }; serial_filer_precompute: { dismissed_on: PlainDate; counts_toward_362c3_until: PlainDate };
} {
  let pool = i.cured_cents; const view: { due: PlainDate; pi_cents: Cents; cured_cents: Cents; status: "cured" | "partially_cured" | "unpaid" }[] = [];
  for (const inst of [...i.prepetition_installments].sort((a, b) => (a.due < b.due ? -1 : 1))) {
    const take = pool >= inst.pi_cents ? inst.pi_cents : pool; pool -= take;
    view.push({ due: inst.due, pi_cents: inst.pi_cents, cured_cents: take, status: take === inst.pi_cents ? "cured" : take > 0n ? "partially_cured" : "unpaid" });
  }
  const partial = view.find((v) => v.status === "partially_cured") ?? null;
  const at = `${i.dismissed_on}T12:00:00.000Z`;
  return {
    stay_status: "ended_dismissal", gates: i.counsel_confirmed_stay_ended === false ? gatesOn(at, "dismissal: awaiting counsel confirmation") : gatesOff(at, "bankruptcy.case.dismissed"), ledger_of_record: "contract_terms", contract_terms_view: view,
    cured_installments: view.filter((v) => v.status === "cured").map((v) => v.due), partially_cured: partial ? { due: partial.due, cured_cents: partial.cured_cents, remaining_cents: partial.pi_cents - partial.cured_cents } : null, residual_unapplied_cents: pool,
    late_charges: { suspended_cents: i.suspended_late_charges_cents, waived_cents: i.suspended_late_charges_cents, decision: "waived_default", rule: "2.7" },
    // the alias map's `bankruptcy.case.dismissed` (= 8.3 `bankruptcy.dismissed`) for 13.x/2.7/8.3/14.3/14.4/5.7 and the generic phase event for 7.1 — appended to the event store by `bk.case.read/write{op=dismiss}`, delivered to every subscriber
    events: [{ type: "bankruptcy.case.dismissed", occurred_at: at, payload: { loan_id: i.loan_id ?? "", case_number_full: i.case_number_full ?? null, dismissed_on: i.dismissed_on, cured_cents: i.cured_cents, dismissal_with_prejudice: i.dismissal_with_prejudice === true, breach_letter_required: true }, consumers: ["13.x", "2.7", "8.3", "14.3", "14.4", "5.7"] },
      { type: "bankruptcy.stay.terminated", occurred_at: at, payload: { loan_id: i.loan_id ?? "", reason: "dismissal", statute: "11 U.S.C. §362(c)(2)(B)" }, consumers: ["13.x"] },
      { type: "bankruptcy.status.changed", occurred_at: at, payload: { loan_id: i.loan_id ?? "", to: "dismissed" }, consumers: ["7.1"] }],
    foreclosure: { resumes: true, requires_breach_letter: true, guide: "E-2.2-01/-04" }, serial_filer_precompute: { dismissed_on: i.dismissed_on, counts_toward_362c3_until: addYears(i.dismissed_on, 1) },
  };
}

// ============================================================ E-2.1-04: counsel document requests (3 BD) — T17
export function documentRequestDue(i: { requested_at: string; fulfilled_on?: PlainDate | null; today?: PlainDate | null }): { requested_on: PlainDate; requested_weekday: number; due: PlainDate; business_days: 3; calendar: "business_days_servicer"; timer: "FNMA_E2_1_04_DOCS_TO_FIRM_3BD"; breached: boolean; escalation: Escalation | null } {
  const on = i.requested_at.slice(0, 10) as PlainDate; const due = addBusinessDays(on, 3, servicer);
  const breached = i.fulfilled_on == null && i.today != null && i.today > due;
  return { requested_on: on, requested_weekday: dayOfWeek(on), due, business_days: 3, calendar: "business_days_servicer", timer: "FNMA_E2_1_04_DOCS_TO_FIRM_3BD", breached, escalation: breached ? { kind: "officer", severity: "sev2", reason: `counsel document request of ${on} unanswered past ${due} (E-2.1-04: three business days)` } : null };
}

// ============================================================ guardrail support: docket classification confidence
const ALWAYS_HUMAN = /^(dismissal_order|discharge_order|relief_order_entered|conversion_order|case_closed)$/;
export function docketClassification(i: { event_type: string; confidence: number }): { state_change_allowed: boolean; human_verification_required: boolean; verifier: "agent" | "human_agent" | "attorney_or_human_agent"; reason: string } {
  if (ALWAYS_HUMAN.test(i.event_type)) return { state_change_allowed: false, human_verification_required: true, verifier: "attorney_or_human_agent", reason: `${i.event_type} is always human-verified against the PDF before it changes state` };
  if (!(i.confidence >= 0.9)) return { state_change_allowed: false, human_verification_required: true, verifier: "human_agent", reason: `classification confidence ${i.confidence} below 0.90` };
  return { state_change_allowed: true, human_verification_required: false, verifier: "agent", reason: `confidence ${i.confidence} ≥ 0.90` };
}

// ============================================================ rule 11: expense claim against the Allowable Bankruptcy Attorney Fees exhibit (11/12/2025) — T18
export type BkFeeKind = "mfr" | "poc_preparation" | "reaffirmation" | "poc_plan_review" | "objection_to_plan" | "payment_change_notice" | "fee_notice" | "noa" | "form_410a" | "mediation_full" | "mediation_reduced" | "post_stip_default" | "post_stip_stay_termination" | "status_response_agreed" | "status_response_objection" | "disbursement_response_agreed" | "disbursement_response_objection";
export function allowableBkFee(chapter: Chapter, kind: BkFeeKind): Cents | null {
  switch (kind) {
    case "mfr": return chapter === "7" ? 122_500n : 135_000n;
    case "poc_preparation": return chapter === "7" ? 37_500n : null;
    case "reaffirmation": return chapter === "7" ? 32_500n : null;
    case "poc_plan_review": return chapter === "7" ? null : 122_500n;
    case "objection_to_plan": return chapter === "12" || chapter === "13" ? 70_000n : null;
    case "payment_change_notice": return chapter === "13" ? 17_500n : null;
    case "fee_notice": return chapter === "13" ? 20_000n : null;
    case "noa": return 0n;
    case "form_410a": return 32_500n;
    case "mediation_full": return 90_000n;
    case "mediation_reduced": return 47_500n;
    case "post_stip_default": return 12_500n;
    case "post_stip_stay_termination": return 25_000n;
    case "status_response_agreed": case "disbursement_response_agreed": return 12_500n;
    case "status_response_objection": case "disbursement_response_objection": return 62_500n;
  }
}
export type ClaimMilestone = "relief_granted" | "dismissal" | "discharge_abandonment" | "reinstatement" | "payoff" | "workout";
export function expenseClaim(i: { milestone: ClaimMilestone; milestone_on: PlainDate; chapter: Chapter; lines: readonly { kind: BkFeeKind; invoiced_cents: Cents }[] }): {
  due: PlainDate; timer: "FNMA_E5_01_BK_EXPENSE_CLAIM_60"; channel: "p360"; fee_schedule: string; lines: { kind: BkFeeKind; invoiced_cents: Cents; allowable_cents: Cents | null; matches: boolean; excess_cents: Cents }[]; all_match: boolean; claim_cents: Cents; excess_requires_approval: boolean;
} {
  const lines = i.lines.map((l) => { const a = allowableBkFee(i.chapter, l.kind); const excess = a === null ? l.invoiced_cents : l.invoiced_cents > a ? l.invoiced_cents - a : 0n; return { kind: l.kind, invoiced_cents: l.invoiced_cents, allowable_cents: a, matches: a !== null && l.invoiced_cents === a, excess_cents: excess }; });
  return { due: addDays(i.milestone_on, 60), timer: "FNMA_E5_01_BK_EXPENSE_CLAIM_60", channel: "p360", fee_schedule: RULE_SET_VERSION.fees, lines, all_match: lines.every((l) => l.matches), claim_cents: lines.reduce((s, l) => s + (l.allowable_cents === null ? 0n : l.invoiced_cents < l.allowable_cents ? l.invoiced_cents : l.allowable_cents), 0n), excess_requires_approval: lines.some((l) => l.excess_cents > 0n) };
}

// ============================================================ rule 3 / worked example clocks (T3): the §14.1 clocks from the verified petition
export interface ClockDue { readonly timer: string; readonly anchor: "petition_date" | "order_for_relief_date"; readonly anchored_on: PlainDate; readonly due: PlainDate; readonly roll: "none" | "frbp_9006_forward"; }
/**
 * The clocks the verified petition starts (a voluntary petition is the order for relief, §301(b)): Fannie Mae "two weeks"
 * clocks are calendar days without roll (policy); FRBP clocks roll forward under Rule 9006(a)(1)(C) on the court calendar.
 * Chapter 11 claims follow the court-set bar date (Rule 3003(c)(3)), so the 70/120-day clocks do not run.
 */
export function clocks14_1(i: { petition_on: PlainDate; chapter: Chapter; fnma_delinquency_days: number; open_foreclosure?: boolean; serial_filer_class?: SerialFilerClass; cramdown?: boolean }): {
  order_for_relief_on: PlainDate; referral: { type: ReferralType; full: boolean; timer: "FNMA_F2_01_BK_REFERRAL_14" | null; due: PlainDate; basis: string };
  prior_filing_check: ClockDue; poc_bar: ClockDue | null; poc_supplement: ClockDue | null; poc_package: ClockDue | null; poc_package_target: PlainDate | null;
} {
  const type = initialReferralType(i.chapter, i.fnma_delinquency_days, i.open_foreclosure === true, i.serial_filer_class ?? "none", i.cramdown === true);
  const full = type !== "poc_only";
  const orr = i.petition_on;
  const ch11 = i.chapter === "11";
  const bar = ch11 ? null : rollForward9006(addDays(orr, 70));
  return {
    order_for_relief_on: orr,
    referral: { type, full, timer: full ? "FNMA_F2_01_BK_REFERRAL_14" : null, due: full ? addDays(orr, 14) : orr, basis: full ? `${type} referral within 14 calendar days of the petition ("two weeks", F-2-01; ${i.fnma_delinquency_days} days delinquent at filing)` : "poc_only referral sent immediately (policy 14.1-Q3: the 70-day claims clock does not wait); converts to full within 14 days of the loan reaching 60 days delinquent" },
    prior_filing_check: { timer: "FNMA_E2_1_02_PRIOR_FILING_CHECK_14", anchor: "petition_date", anchored_on: orr, due: addDays(orr, 14), roll: "none" },
    poc_bar: bar ? { timer: "FRBP_3002C_POC_BAR_70", anchor: "order_for_relief_date", anchored_on: orr, due: bar, roll: "frbp_9006_forward" } : null,
    poc_supplement: ch11 ? null : { timer: "FRBP_3002C7_POC_SUPPLEMENT_120", anchor: "order_for_relief_date", anchored_on: orr, due: rollForward9006(addDays(orr, 120)), roll: "frbp_9006_forward" },
    poc_package: ch11 ? null : { timer: "SM_BK_POC_PACKAGE_T35", anchor: "order_for_relief_date", anchored_on: orr, due: addDays(orr, 35), roll: "none" },
    poc_package_target: bar ? addDays(bar, -35) : null,
  };
}

// ============================================================ E-2.2-01 / E-2.2-04 completion timelines (F-2-01)
export type CompletionTimer = "FNMA_E2_2_01_CH7_COMPLETION_2M2W" | "FNMA_E2_2_04_CH13_COMPLETION_5M2W" | "FNMA_E2_2_04_POSTCONF_COMPLETION_2M2W";
/**
 * "five months and two weeks" (ch. 12/13) / "two months and two weeks" (ch. 7) — "from the 60th day of delinquency or referral
 * if <60 days delinquent at filing; from the filing if ≥60 days delinquent or in foreclosure"; a post-confirmation 60-day
 * delinquency runs "two months and two weeks" from day 60. The registry grammar cannot express months + days in one offset, so
 * the referral / day-60 events carry `completion_due_on` computed here and the rows anchor on it.
 */
export function completionClock(i: { chapter: Chapter; petition_on: PlainDate; fnma_delinquency_days_at_filing: number; open_foreclosure: boolean; day_60_on?: PlainDate | null; referral_sent_on?: PlainDate | null; post_confirmation?: boolean }): { timer: CompletionTimer | null; anchor: "petition_date" | "day_60" | "referral" | null; anchored_on: PlainDate | null; due: PlainDate | null; months: number; days: 14 } {
  if (i.post_confirmation) { const on = i.day_60_on ?? null; return { timer: "FNMA_E2_2_04_POSTCONF_COMPLETION_2M2W", anchor: "day_60", anchored_on: on, due: on ? addDays(addMonths(on, 2), 14) : null, months: 2, days: 14 }; }
  if (i.chapter === "11") return { timer: null, anchor: null, anchored_on: null, due: null, months: 0, days: 14 };
  const fromFiling = i.fnma_delinquency_days_at_filing >= 60 || i.open_foreclosure;
  const anchor = fromFiling ? "petition_date" : i.day_60_on ? "day_60" : i.referral_sent_on ? "referral" : null;
  const on = fromFiling ? i.petition_on : i.day_60_on ?? i.referral_sent_on ?? null;
  const months = i.chapter === "7" ? 2 : 5;
  return { timer: i.chapter === "7" ? "FNMA_E2_2_01_CH7_COMPLETION_2M2W" : "FNMA_E2_2_04_CH13_COMPLETION_5M2W", anchor, anchored_on: on, due: on ? addDays(addMonths(on, months), 14) : null, months, days: 14 };
}

// ============================================================ rule 3: the referral package (E-1.1-02) and its clocks
export const REFERRAL_PACKAGE_CONTENTS = ["note copy from the custodian (original / lost-note affidavit via Form 2009 where needed)", "mortgage, assignments and MERS milestones", "case coversheet", "prior-case list (plans, pleadings, schedules, POCs)", "bankruptcy_ledger_views snapshot", "collection and foreclosure history", "workout history", "property value", "escrow statement as of the petition date", "computed POC package (rule 5) if ready", "requested actions (NOA, POC, plan review, MFR, objection)"] as const;
const FULL_REFERRAL: ReadonlySet<ReferralType> = new Set(["full", "cramdown", "repeat_filer", "ch11", "conversion"]);
export function referralPackage(i: { loan_id: string; chapter: Chapter; petition_on: PlainDate; sent_on: PlainDate; type: ReferralType; firm_id: string; fnma_delinquency_days_at_filing: number; open_foreclosure?: boolean; day_60_on?: PlainDate | null; serial_filer_class?: SerialFilerClass; plan_confirmed?: boolean }): {
  event: EmittedEvent; full: boolean; label: "repeat filer" | "possible bankruptcy abuse" | null; timer: "FNMA_F2_01_BK_REFERRAL_14" | "FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14" | null; due: PlainDate | null; in_time: boolean | null; ack_due: PlainDate; ack_timer: "FNMA_E2_1_04_LAWFIRM_ACK_2BD"; completion: ReturnType<typeof completionClock>; contents: readonly string[]; escalation: Escalation | null;
} {
  const full = FULL_REFERRAL.has(i.type);
  const serial = i.serial_filer_class ?? "none";
  const label = serial === "abusive_suspected" ? "possible bankruptcy abuse" : serial !== "none" ? "repeat filer" : null;
  const due = i.type === "mfr" ? (i.day_60_on ? addDays(i.day_60_on, 14) : null) : full ? addDays(i.petition_on, 14) : null;
  const timer = i.type === "mfr" ? "FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14" : full ? "FNMA_F2_01_BK_REFERRAL_14" : null;
  const inTime = due ? i.sent_on <= due : null;
  const completion = i.type === "mfr" && i.plan_confirmed ? completionClock({ chapter: i.chapter, petition_on: i.petition_on, fnma_delinquency_days_at_filing: i.fnma_delinquency_days_at_filing, open_foreclosure: i.open_foreclosure === true, day_60_on: i.day_60_on ?? null, post_confirmation: true })
    : completionClock({ chapter: i.chapter, petition_on: i.petition_on, fnma_delinquency_days_at_filing: i.fnma_delinquency_days_at_filing, open_foreclosure: i.open_foreclosure === true, day_60_on: i.day_60_on ?? null, referral_sent_on: i.sent_on });
  return {
    event: { type: "bankruptcy.referral.sent", occurred_at: `${i.sent_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, chapter: i.chapter, type: i.type, full, label, firm_id: i.firm_id, sent_at: i.sent_on, petition_date: i.petition_on, day_60: i.day_60_on ?? null, completion_timer: full || i.type === "mfr" ? completion.timer : null, completion_anchor: completion.anchor, completion_due_on: completion.due, requests: i.type === "mfr" ? ["MFR", "motion to dismiss (local practice)"] : label ? ["NOA", "POC", "plan review", "evaluate §362(d)(4) in rem relief and dismissal with prejudice"] : ["NOA", "POC", ...(i.chapter === "12" || i.chapter === "13" ? ["plan review"] : [])] } },
    full, label, timer, due, in_time: inTime, ack_due: addBusinessDays(i.sent_on, 2, servicer), ack_timer: "FNMA_E2_1_04_LAWFIRM_ACK_2BD", completion, contents: REFERRAL_PACKAGE_CONTENTS,
    escalation: inTime === false ? { kind: "officer", severity: "sev1", reason: `${i.type} referral sent ${i.sent_on} after the ${due} deadline (${timer}: "two weeks"; compensatory-fee exposure, E-2.1-10)` } : null,
  };
}

// ============================================================ rule 5: Form 410A Part 5 from the ledger (T4)
export const FORM_410A_PART5_COLUMNS = ["A date", "B contractual payment amount", "C funds received", "D amount incurred", "E description", "F contractual due date", "G prin, int & esc past due balance", "H amount to principal", "I amount to interest", "J amount to escrow", "K amount to fees or charges", "L unapplied funds", "M principal balance", "N accrued interest balance", "O escrow balance", "P fees / charges balance", "Q unapplied funds balance"] as const;
export interface Part5Row {
  readonly date: PlainDate; readonly contractual_payment_cents: Cents; readonly funds_received_cents: Cents; readonly amount_incurred_cents: Cents; readonly description: string; readonly contractual_due_date: PlainDate | null; readonly past_due_balance_cents: Cents;
  readonly to_principal_cents: Cents; readonly to_interest_cents: Cents; readonly to_escrow_cents: Cents; readonly to_fees_cents: Cents; readonly unapplied_cents: Cents;
  readonly principal_balance_cents: Cents; readonly accrued_interest_balance_cents: Cents; readonly escrow_balance_cents: Cents; readonly fees_balance_cents: Cents; readonly unapplied_balance_cents: Cents;
  readonly ledger_entry_set_id: string; readonly ledger_entry_ids: readonly string[];
}
export interface Part5Totals { readonly principal_due_cents: Cents; readonly interest_due_cents: Cents; readonly prepetition_fees_due_cents: Cents; readonly escrow_deficiency_cents: Cents; readonly funds_on_hand_cents: Cents; readonly total_prepetition_arrearage_cents: Cents; }
const loanSum = (s: EntrySet, loanId: string, account: string, sign: 1n | -1n): Cents => s.lines.filter((l) => l.account.scope === "loan" && l.account.loanId === loanId && l.account.account === account && (sign > 0n ? l.amountCents > 0n : l.amountCents < 0n)).reduce((t, l) => t + l.amountCents * sign, 0n);
const cashIn = (s: EntrySet): Cents => s.lines.filter((l) => l.account.scope === "custodial" && l.amountCents > 0n).reduce((t, l) => t + l.amountCents, 0n);
/**
 * Part 5 of Form 410A (rev. 12/23): the loan payment history "from the first date of default through the petition date",
 * generated from the posted `ledger_entries` — one row per entry set, 17 columns A–Q, every row carrying the ids of the
 * ledger lines it was derived from so the history is provable (`FORM410A_PART5_LEDGER_TIE`). Sets dated before the first
 * default seed the opening balances (the escrow balance carried into the default period) without a row.
 * Conventions: loan `interest_due` debits are scheduled interest coming due (a contractual installment row; the principal
 * portion is the contractual P&I less that interest), `late_charges`/`other_fees` debits are fees incurred, `escrow` debits
 * are disbursements advanced (the borrower's escrow balance is the negation of the loan escrow account), custodial cash
 * debits are funds received and the loan credits they carry are the amounts applied (H–L).
 */
export function form410aPart5(i: { loan_id: string; sets: readonly EntrySet[]; first_default_due: PlainDate; petition_on: PlainDate; principal_balance_cents: Cents; pi_cents: Cents; escrow_monthly_cents: Cents; part3?: Part5Totals | null }): {
  starts: PlainDate | null; ends: PlainDate; columns: readonly string[]; rows: Part5Row[]; totals: Part5Totals; checks: { FORM410A_PART5_LEDGER_TIE: boolean; FORM410A_FIRST_DEFAULT_ANCHOR: boolean; FORM410A_PART3_SUM: boolean; FORM410A_PART5_TIES_TO_PART3: boolean | null }; ledger_line_ids: string[];
} {
  const sets = [...i.sets].filter((s) => s.effectiveDate <= i.petition_on && s.lines.some((l) => l.account.scope === "loan" && l.account.loanId === i.loan_id)).sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : a.postedAt < b.postedAt ? -1 : 1));
  let principal = i.principal_balance_cents, interest = 0n, escrowAcct = 0n, fees = 0n, unapplied = 0n, pastDue = 0n, principalDue = 0n;
  const rows: Part5Row[] = []; const lineIds: string[] = [];
  for (const s of sets) {
    const iDue = loanSum(s, i.loan_id, "interest_due", 1n), feeInc = loanSum(s, i.loan_id, "late_charges", 1n) + loanSum(s, i.loan_id, "other_fees", 1n), escDisb = loanSum(s, i.loan_id, "escrow", 1n);
    const toInt = loanSum(s, i.loan_id, "interest_due", -1n), toPrin = loanSum(s, i.loan_id, "principal", -1n), toEsc = loanSum(s, i.loan_id, "escrow", -1n), toFees = loanSum(s, i.loan_id, "late_charges", -1n) + loanSum(s, i.loan_id, "other_fees", -1n), toUnapplied = loanSum(s, i.loan_id, "suspense_unapplied", -1n) - loanSum(s, i.loan_id, "suspense_unapplied", 1n);
    const received = cashIn(s);
    const installment = iDue > 0n;
    const principalPortion = installment ? i.pi_cents - iDue : 0n;
    interest += iDue - toInt; principal -= toPrin; escrowAcct += escDisb - toEsc; fees += feeInc - toFees; unapplied += toUnapplied;
    if (s.effectiveDate < i.first_default_due) continue;   // before the first date of default: the set seeds the running balances (column O's opening escrow) but is not history
    if (installment) { pastDue += i.pi_cents + i.escrow_monthly_cents; principalDue += principalPortion; }
    pastDue -= toInt + toPrin + toEsc;
    const ids = s.lines.map((l) => l.id); lineIds.push(...ids);
    rows.push({ date: s.effectiveDate, contractual_payment_cents: installment ? i.pi_cents + i.escrow_monthly_cents : 0n, funds_received_cents: received, amount_incurred_cents: installment ? 0n : feeInc + escDisb, description: s.description, contractual_due_date: installment ? s.effectiveDate : null, past_due_balance_cents: pastDue,
      to_principal_cents: toPrin, to_interest_cents: toInt, to_escrow_cents: toEsc, to_fees_cents: toFees, unapplied_cents: toUnapplied, principal_balance_cents: principal, accrued_interest_balance_cents: interest, escrow_balance_cents: -escrowAcct, fees_balance_cents: fees, unapplied_balance_cents: unapplied, ledger_entry_set_id: s.id, ledger_entry_ids: ids });
  }
  const deficiency = escrowAcct > 0n ? escrowAcct : 0n;
  const totals: Part5Totals = { principal_due_cents: principalDue, interest_due_cents: interest, prepetition_fees_due_cents: fees, escrow_deficiency_cents: deficiency, funds_on_hand_cents: unapplied, total_prepetition_arrearage_cents: principalDue + interest + fees + deficiency - unapplied };
  const known = new Set(i.sets.flatMap((s) => s.lines.map((l) => l.id)));
  const tie = rows.length > 0 && rows.every((r) => r.ledger_entry_ids.length > 0 && r.ledger_entry_ids.every((id) => known.has(id)) && i.sets.some((s) => s.id === r.ledger_entry_set_id));
  const p3 = i.part3 ?? null;
  return {
    starts: rows[0]?.date ?? null, ends: i.petition_on, columns: FORM_410A_PART5_COLUMNS, rows, totals,
    checks: { FORM410A_PART5_LEDGER_TIE: tie, FORM410A_FIRST_DEFAULT_ANCHOR: rows[0]?.date === i.first_default_due && rows[0]?.contractual_due_date === i.first_default_due, FORM410A_PART3_SUM: totals.total_prepetition_arrearage_cents === totals.principal_due_cents + totals.interest_due_cents + totals.prepetition_fees_due_cents + totals.escrow_deficiency_cents - totals.funds_on_hand_cents,
      FORM410A_PART5_TIES_TO_PART3: p3 ? (["principal_due_cents", "interest_due_cents", "prepetition_fees_due_cents", "escrow_deficiency_cents", "funds_on_hand_cents", "total_prepetition_arrearage_cents"] as const).every((k) => p3[k] === totals[k]) : null },
    ledger_line_ids: lineIds,
  };
}

// ============================================================ rule 5 inputs: the petition-date escrow statement and pre-petition fee items
/** Rule 3001(c)(2)(C): "an escrow-account statement, prepared as of the date the petition was filed" — the balance at petition and the deficiency for funds advanced (max(0, −balance)). */
export function petitionEscrowStatement(i: { opening_balance_cents: Cents; opening_on: PlainDate; petition_on: PlainDate; disbursements: readonly { on: PlainDate; kind: string; cents: Cents }[]; deposits?: readonly { on: PlainDate; cents: Cents }[] }): { balance_at_petition_cents: Cents; escrow_deficiency_for_funds_advanced_cents: Cents; lines: { on: PlainDate; description: string; cents: Cents; balance_cents: Cents }[] } {
  const items = [...i.disbursements.filter((d) => d.on > i.opening_on && d.on <= i.petition_on).map((d) => ({ on: d.on, description: `${d.kind} disbursed`, cents: -d.cents })), ...(i.deposits ?? []).filter((d) => d.on > i.opening_on && d.on <= i.petition_on).map((d) => ({ on: d.on, description: "escrow deposit", cents: d.cents }))].sort((a, b) => (a.on < b.on ? -1 : 1));
  let bal = i.opening_balance_cents; const lines = items.map((x) => { bal += x.cents; return { ...x, balance_cents: bal }; });
  return { balance_at_petition_cents: bal, escrow_deficiency_for_funds_advanced_cents: bal < 0n ? -bal : 0n, lines };
}
/** Pre-petition fee items claimable in Part 3 (late charges whose grace ended pre-petition, NSF, inspections, recoverable attorney/recording costs, non-escrow advances) — incurred on or before the petition. */
export function prepetitionFees(i: { items: readonly { kind: string; on: PlainDate; cents: Cents }[]; petition_on: PlainDate }): { total_cents: Cents; items: { kind: string; on: PlainDate; cents: Cents }[] } {
  const items = i.items.filter((f) => f.on <= i.petition_on).map((f) => ({ kind: f.kind, on: f.on, cents: f.cents }));
  return { total_cents: items.reduce((s, f) => s + f.cents, 0n), items };
}
export interface PostpetitionScheduleEntry { readonly due: PlainDate; readonly payment_number: number; readonly pi_cents: Cents; readonly escrow_cents: Cents; readonly amount_cents: Cents; }
/** Rule 6: the post-petition schedule opens with the first installment due after the petition (fixture: 2026-10-01, payment #39); the post-petition escrow analysis (3.2/14.2) changes the escrow line from its effective due date. */
export function postpetitionSchedule(i: { first_postpetition_due: PlainDate; first_postpetition_payment_number: number; months: number; pi_cents: Cents; escrow_cents: Cents; escrow_change?: { escrow_new_cents: Cents; effective_due_date: PlainDate } | null }): PostpetitionScheduleEntry[] {
  const out: PostpetitionScheduleEntry[] = [];
  for (let k = 0; k < i.months; k++) { const due = addMonths(i.first_postpetition_due, k); const esc = i.escrow_change && due >= i.escrow_change.effective_due_date ? i.escrow_change.escrow_new_cents : i.escrow_cents; out.push({ due, payment_number: i.first_postpetition_payment_number + k, pi_cents: i.pi_cents, escrow_cents: esc, amount_cents: i.pi_cents + esc }); }
  return out;
}
/** Scheduled split of payment `n` of the note's amortization (the plan-terms view applies each post-petition installment per the contractual schedule as if the pre-petition installments had been paid). */
export function scheduledSplit(note: { original_upb_cents: Cents; rate_pct: string; term_months: number; pi_cents: Cents }, paymentNumber: number): { payment_number: number; upb_before_cents: Cents; interest_cents: Cents; principal_cents: Cents } {
  const upb = balanceAfter(note.original_upb_cents, note.rate_pct, note.term_months, paymentNumber - 1); const interest = monthlyInterest(upb, ratePercent(note.rate_pct));
  return { payment_number: paymentNumber, upb_before_cents: upb, interest_cents: interest, principal_cents: note.pi_cents - interest };
}

// ============================================================ rule 6(a): trustee vouchers — split, postings, decision, reminder (T7, T8)
export type VoucherDesignation = "arrearage" | "post-petition" | "conduit" | "unlabelled";
/** Voucher designations the spec names ("arrearage"/"post-petition"/"conduit", else unlabelled); anything else is refused rather than silently applied. */
export function normalizeDesignation(raw: string | null | undefined): VoucherDesignation {
  const d = (raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (d === "arrearage" || d === "arrears" || d === "pre-petition" || d === "prepetition") return "arrearage";
  if (d === "post-petition" || d === "postpetition" || d === "ongoing") return "post-petition";
  if (d === "conduit") return "conduit";
  if (d === "" || d === "unlabelled" || d === "unlabeled" || d === "none") return "unlabelled";
  throw new RangeError(`trustee voucher designation "${raw}" is not one of arrearage / post-petition / conduit / unlabelled`);
}
export interface InstallmentAllocation { readonly due: PlainDate; readonly payment_number: number; readonly applied_cents: Cents; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly escrow_cents: Cents; readonly paid_after_cents: Cents; readonly short_cents: Cents; }
export interface ArrearageAllocation { readonly component: "interest" | "principal" | "fees" | "escrow_deficiency"; readonly installment_due: PlainDate | null; readonly cents: Cents; readonly of_cents: Cents; }
export interface ClaimComponent { readonly component: ArrearageAllocation["component"]; readonly installment_due: PlainDate | null; readonly cents: Cents; }
/** Policy 14.1-Q5 cure order: the P&I components of the claim installments oldest-first (interest then principal), then fees, then the escrow deficiency; the petition-date funds on hand (already the creditor's) net the tail so the components sum to Part 3's total. */
export function arrearageCureOrder(claim: { installments: readonly { due: PlainDate; interest_cents: Cents; principal_cents: Cents }[]; fees_cents: Cents; escrow_deficiency_cents: Cents; funds_on_hand_cents?: Cents }): ClaimComponent[] {
  const out: ClaimComponent[] = [];
  for (const x of [...claim.installments].sort((a, b) => (a.due < b.due ? -1 : 1))) { out.push({ component: "interest", installment_due: x.due, cents: x.interest_cents }); out.push({ component: "principal", installment_due: x.due, cents: x.principal_cents }); }
  if (claim.fees_cents > 0n) out.push({ component: "fees", installment_due: null, cents: claim.fees_cents });
  if (claim.escrow_deficiency_cents > 0n) out.push({ component: "escrow_deficiency", installment_due: null, cents: claim.escrow_deficiency_cents });
  let net = claim.funds_on_hand_cents ?? 0n;
  for (let k = out.length - 1; k >= 0 && net > 0n; k--) { const c = out[k]!; const t = net < c.cents ? net : c.cents; out[k] = { ...c, cents: c.cents - t }; net -= t; }
  return out.filter((c) => c.cents > 0n);
}
const BK_ACCOUNT = (loanId: string, account: "bk_prepetition_arrearage" | "bk_postpetition_suspense" | "bk_trustee_clearing" | "bk_unsecured_cramdown"): AccountRef => ({ scope: "loan", loanId, account: account as LoanAccount });   // §14.1 data model: bk_* loan sub-accounts (baseline §5 extension)
const takeInOrder = (components: readonly Cents[], paidBefore: Cents, take: Cents): Cents[] => { const out: Cents[] = []; let skip = paidBefore, pool = take; for (const c of components) { const avail = c > skip ? c - skip : 0n; skip = skip > c ? skip - c : 0n; const t = pool < avail ? pool : avail; out.push(t); pool -= t; } return out; };
/**
 * Rule 6(a) / E-2.2-04: the voucher posts to `bk_trustee_clearing` and is split per its designation — conduit post-petition
 * amounts to the oldest unpaid post-petition installment in contractual order (interest, principal, escrow — C-1.1-01; a
 * partially covered installment carries `short_cents` on the escrow line, 14.1-Q5, never suspense), arrearage amounts reduce
 * `bk_prepetition_arrearage` in the claim's component order; unlabelled funds follow the confirmed plan's designation, else
 * post-petition first (conduit districts) or arrearage first — every application is a recorded `payment_application`
 * decision. The postings are one balanced entry set (Dr custodial cash per allocation / Cr the loan accounts) linked to
 * `bankruptcy.trustee_payment.received`; a short installment produces the informational payment-change reminder
 * (`NTC_BK_PAYMENT_INSTRUCTIONS`) to the trustee and counsel citing the filed 410S-1.
 */
export function applyTrusteeVoucher(i: {
  loan_id: string; ledgers: Ledgers; schedule: readonly PostpetitionScheduleEntry[]; note: { original_upb_cents: Cents; rate_pct: string; term_months: number; pi_cents: Cents };
  voucher: { amount_cents: Cents; designation: string | null; received_on: PlainDate; case_number_full?: string | null; claim_no?: string | null; memo?: string | null };
  conduit_district: boolean; plan_designation?: "post-petition" | "arrearage" | null; claim: { total_cents: Cents; components: readonly ClaimComponent[] };
  payment_change?: { prior_amount_cents: Cents; new_amount_cents: Cents; effective_due_date: PlainDate; form_410s1_filed_on: PlainDate | null; form_410s1_docket_no: string | null } | null; custodial?: { pi_account_id: string; ti_account_id: string } | null; chapter?: Chapter;
}): {
  designation: VoucherDesignation; designation_applied: "post-petition" | "arrearage"; decision: DecisionRecord; applied_postpetition_cents: Cents; applied_arrearage_cents: Cents; allocations: InstallmentAllocation[]; arrearage_allocations: ArrearageAllocation[]; arrearage_after_cents: Cents; arrearage_cured_bp: number;
  short: { due: PlainDate; short_cents: Cents }[]; suspense_cents: Cents; status: ReturnType<typeof postpetitionStatus>;
  /** Set 1: Dr custodial cash / Cr `bk_trustee_clearing` for the whole voucher (rule 6(a): "post to `bk_trustee_clearing`"). */
  receipt_postings: EntrySetInput;
  /** Set 2: Dr `bk_trustee_clearing` / Cr the loan accounts per the split ("then split per the voucher"). */
  postings: EntrySetInput; postings_sum_cents: Cents; clearing_account: "bk_trustee_clearing"; clearing_residual_cents: Cents; events: EmittedEvent[]; reminder: { template: "NTC_BK_PAYMENT_INSTRUCTIONS"; recipients: readonly ["trustee", "counsel"]; channel: "mail_only"; informational: true; payload: Record<string, unknown> } | null;
} {
  if (i.voucher.amount_cents <= 0n) throw new RangeError("a trustee voucher must be a positive amount");
  const designation = normalizeDesignation(i.voucher.designation);
  const l = i.ledgers;
  const before = new Map(l.postpetition.map((p) => [p.due, p.paid_cents] as const));
  const arrearsBefore = l.prepetition_arrearage_cents;
  const applied: "post-petition" | "arrearage" = designation === "arrearage" ? "arrearage" : designation === "unlabelled" ? (i.plan_designation ?? (i.conduit_district ? "post-petition" : "arrearage")) : "post-petition";
  const r = applyVoucher(l, { amount_cents: i.voucher.amount_cents, designation: applied === "arrearage" ? "arrearage" : "post-petition", conduit_district: i.conduit_district });
  const allocations: InstallmentAllocation[] = [];
  for (const p of [...l.postpetition].sort((a, b) => (a.due < b.due ? -1 : 1))) {
    const was = before.get(p.due) ?? 0n; const take = p.paid_cents - was; if (take <= 0n) continue;
    const sched = i.schedule.find((s) => s.due === p.due); if (!sched) throw new RangeError(`post-petition installment ${p.due} is not on the plan-terms schedule`);
    const split = scheduledSplit(i.note, sched.payment_number);
    const [int, prin, esc] = takeInOrder([split.interest_cents, split.principal_cents, sched.escrow_cents], was, take) as [Cents, Cents, Cents];
    allocations.push({ due: p.due, payment_number: sched.payment_number, applied_cents: take, interest_cents: int, principal_cents: prin, escrow_cents: esc, paid_after_cents: p.paid_cents, short_cents: p.amount_cents - p.paid_cents });
  }
  const curedBefore = i.claim.total_cents - arrearsBefore;
  const arrearageAlloc: ArrearageAllocation[] = takeInOrder(i.claim.components.map((c) => c.cents), curedBefore, r.applied_arrearage_cents).map((cents, k) => ({ component: i.claim.components[k]!.component, installment_due: i.claim.components[k]!.installment_due, cents, of_cents: i.claim.components[k]!.cents })).filter((a) => a.cents > 0n);
  const firstInst = i.claim.components.filter((c) => c.installment_due === i.claim.components[0]?.installment_due && (c.component === "interest" || c.component === "principal"));
  const firstPi = firstInst.reduce((s, c) => s + c.cents, 0n); const curedNow = i.claim.total_cents - l.prepetition_arrearage_cents; const firstCured = curedNow < firstPi ? curedNow : firstPi;
  const curedBp = firstPi > 0n ? Number((firstCured * 10_000n) / firstPi) : 0;
  const pi = i.custodial?.pi_account_id ?? "custodial-pi", ti = i.custodial?.ti_account_id ?? "custodial-ti";
  const piCash = allocations.reduce((s, a) => s + a.interest_cents + a.principal_cents, 0n) + arrearageAlloc.filter((a) => a.component !== "escrow_deficiency").reduce((s, a) => s + a.cents, 0n);
  const tiCash = allocations.reduce((s, a) => s + a.escrow_cents, 0n) + arrearageAlloc.filter((a) => a.component === "escrow_deficiency").reduce((s, a) => s + a.cents, 0n);
  // rule 6(a): "post to `bk_trustee_clearing`, then split per the voucher" — set 1 (receipt): Dr custodial cash / Cr bk_trustee_clearing for the whole voucher;
  // set 2 (split): Dr bk_trustee_clearing / Cr the loan accounts for what the voucher covers. Funds the voucher cannot apply (an overpaid arrearage,
  // a payment after dismissal — edge case "refund to the trustee (not the debtor)") stay in clearing pending the refund.
  const residual = i.voucher.amount_cents - piCash - tiCash;
  const receipt: LineInput[] = [];
  if (piCash + residual > 0n) receipt.push({ account: { scope: "custodial", custodialAccountId: pi, account: "custodial_pi_cash" }, amountCents: piCash + residual, ruleRef: "14.1:rule6a:trustee_voucher:receipt:custodial_pi", memo: `trustee disbursement received — P&I and arrearage portions${residual > 0n ? ` (incl. ${residual} cents unapplied, pending refund to the trustee)` : ""}` });
  if (tiCash > 0n) receipt.push({ account: { scope: "custodial", custodialAccountId: ti, account: "custodial_ti_cash" }, amountCents: tiCash, ruleRef: "14.1:rule6a:trustee_voucher:receipt:custodial_ti", memo: "trustee disbursement received — escrow portions" });
  receipt.push({ account: BK_ACCOUNT(i.loan_id, "bk_trustee_clearing"), amountCents: -i.voucher.amount_cents, ruleRef: "14.1:rule6a:trustee_voucher:receipt:clearing", memo: `voucher ${i.voucher.amount_cents} cents pending split (${designation})` });
  const lines: LineInput[] = [{ account: BK_ACCOUNT(i.loan_id, "bk_trustee_clearing"), amountCents: piCash + tiCash, ruleRef: "14.1:rule6a:trustee_voucher:split:clearing", memo: `split per voucher designation ${designation} → ${applied}` }];
  for (const a of allocations) {
    if (a.interest_cents > 0n) lines.push({ account: { scope: "loan", loanId: i.loan_id, account: "interest_due" }, amountCents: -a.interest_cents, ruleRef: "14.1:rule6a:conduit:interest", memo: `installment ${a.due} (payment #${a.payment_number}) interest` });
    if (a.principal_cents > 0n) lines.push({ account: { scope: "loan", loanId: i.loan_id, account: "principal" }, amountCents: -a.principal_cents, ruleRef: "14.1:rule6a:conduit:principal", memo: `installment ${a.due} (payment #${a.payment_number}) principal` });
    if (a.escrow_cents > 0n) lines.push({ account: { scope: "loan", loanId: i.loan_id, account: "escrow" }, amountCents: -a.escrow_cents, ruleRef: "14.1:rule6a:conduit:escrow", memo: `installment ${a.due} escrow${a.short_cents > 0n ? ` (short ${a.short_cents} cents on the escrow line, 14.1-Q5)` : ""}` });
  }
  if (r.applied_arrearage_cents > 0n) lines.push({ account: BK_ACCOUNT(i.loan_id, "bk_prepetition_arrearage"), amountCents: -r.applied_arrearage_cents, ruleRef: "14.1:rule6a:arrearage:cure", memo: `cure receipt: ${arrearageAlloc.map((a) => `${a.component} ${a.cents} of ${a.of_cents}${a.installment_due ? ` (${a.installment_due})` : ""}`).join("; ")}` });
  const at = `${i.voucher.received_on}T12:00:00.000Z`;
  const label = `trustee voucher ${i.voucher.received_on} ${i.voucher.amount_cents} cents (${designation}${i.voucher.memo ? `: ${i.voucher.memo}` : ""})`;
  const receiptPostings: EntrySetInput = { effectiveDate: i.voucher.received_on, description: `${label} — receipt to bk_trustee_clearing`, lines: receipt };
  const postings: EntrySetInput = { effectiveDate: i.voucher.received_on, description: `${label} — split from bk_trustee_clearing`, lines };
  const status = postpetitionStatus(l, i.voucher.received_on);
  const short = r.short;
  const decision: DecisionRecord = { decision_type: "payment_application", outcome: designation === "unlabelled" ? `unlabelled → ${applied} first (${i.plan_designation ? "confirmed plan designation" : i.conduit_district ? "conduit district" : "non-conduit district"})` : `${designation} → ${applied}`, rationale: `voucher ${i.voucher.amount_cents} cents: ${r.applied_postpetition_cents} post-petition (${allocations.map((a) => `${a.due} ${a.applied_cents}`).join(", ") || "none"}), ${r.applied_arrearage_cents} arrearage (${arrearageAlloc.map((a) => `${a.component} ${a.cents}`).join(", ") || "none"}); short: ${short.map((s) => `${s.due} ${s.short_cents}`).join(", ") || "none"}`, rule_set_version: RULE_SET_VERSION.guide, human_review_reason: [] };
  const pc = i.payment_change ?? null; const firstShort = short[0] ?? null;
  const reminder = firstShort ? { template: "NTC_BK_PAYMENT_INSTRUCTIONS" as const, recipients: ["trustee", "counsel"] as const, channel: "mail_only" as const, informational: true as const, payload: { chapter: i.chapter ?? "13", conduit: true, postpetition_amount_cents: pc?.new_amount_cents ?? (l.postpetition.find((p) => p.due === firstShort.due)?.amount_cents ?? 0n), prior_amount_cents: pc?.prior_amount_cents ?? null, effective_due_date: pc?.effective_due_date ?? firstShort.due, form_410s1_filed_on: pc?.form_410s1_filed_on ?? null, form_410s1_docket_no: pc?.form_410s1_docket_no ?? null, shortfall_cents: firstShort.short_cents, shortfall_due_date: firstShort.due, notice_date: i.voucher.received_on } } : null;
  const events: EmittedEvent[] = [{ type: "bankruptcy.trustee_payment.received", occurred_at: at, payload: { loan_id: i.loan_id, amount_cents: i.voucher.amount_cents, designation, designation_applied: applied, case_number_full: i.voucher.case_number_full ?? null, claim_no: i.voucher.claim_no ?? null, applied_postpetition_cents: r.applied_postpetition_cents, applied_arrearage_cents: r.applied_arrearage_cents, short, clearing_account: "bk_trustee_clearing" } }];
  if (r.applied_postpetition_cents > 0n) events.push({ type: "bankruptcy.postpetition.payment.applied", occurred_at: at, payload: { loan_id: i.loan_id, source: "trustee", allocations } });
  if (r.applied_arrearage_cents > 0n) events.push({ type: "bankruptcy.prepetition.payment.applied", occurred_at: at, payload: { loan_id: i.loan_id, source: "trustee", cents: r.applied_arrearage_cents, allocations: arrearageAlloc, bk_prepetition_arrearage_cents: l.prepetition_arrearage_cents } });
  if (reminder) events.push({ type: "bankruptcy.payment_change_reminder.requested", occurred_at: at, payload: { loan_id: i.loan_id, template_code: reminder.template, recipients: [...reminder.recipients], shortfall_cents: firstShort!.short_cents } });
  return { designation, designation_applied: applied, decision, applied_postpetition_cents: r.applied_postpetition_cents, applied_arrearage_cents: r.applied_arrearage_cents, allocations, arrearage_allocations: arrearageAlloc, arrearage_after_cents: l.prepetition_arrearage_cents, arrearage_cured_bp: curedBp, short, suspense_cents: l.postpetition_suspense_cents, status,
    receipt_postings: receiptPostings, postings, postings_sum_cents: lines.reduce((s, x) => s + x.amountCents, 0n), clearing_account: "bk_trustee_clearing", clearing_residual_cents: residual, events, reminder };
}

// ============================================================ rule 8: post-petition 60-day delinquency → MFR package and referral (T9)
export type MfrPath = "mfr" | "motion_to_dismiss" | "agreed_order" | "adequate_protection" | "sequestration_of_rents";
export const MFR_PACKAGE_CONTENTS = ["post-petition payment history declaration (CRT_MFR_DECL, from bankruptcy_ledger_views, signed by signing_officer)", "note and mortgage", "proof of claim", "plan", "escrow statement", "property value", "recommended relief"] as const;
/**
 * `postpetition_fnma_bucket=60` when two post-petition installments are wholly unpaid on the day after the second's due date →
 * `bankruptcy.postpetition.delinquency.60` fires (payload carries `conduit_district`, `plan_confirmed` and the E-2.2-04
 * post-confirmation completion date), the MFR package is assembled the same day for `attorney`, and the referral is due within
 * 14 calendar days (E-2.1-08 "no later than two weeks from the 60th day"); a later referral breaches sev-1 (Guide breach;
 * compensatory fees). Conduit districts confirm plan-payment status with the trustee within 5 BD before the referral.
 */
/**
 * Rule 8: "The engine then scores the path" — every one of the spec's five paths is scored, with its basis: MFR (default when
 * ≥ 2 post-petition installments are unpaid and no cure/agreed order is in place; Ch. 7 when the SOI is surrender or the
 * debtor is delinquent; investment property with no equity and not necessary to reorganization, §362(d)(2)); motion to
 * dismiss (counsel's recommendation under local practice); agreed order/stipulation (a post-petition cure ≤ 6 months from an
 * otherwise-performing debtor, policy 14.1-Q7); adequate protection (conduit district with confirmation > 45 days after the
 * 341 meeting, E-2.1-06); sequestration of rents (investment property, E-2.3-04). The primary path is the relief counsel is
 * asked to pursue; the other applicable paths are companions filed alongside it.
 */
export function scoreMfrPath(i: { chapter: Chapter; whole_unpaid: number; conduit_district: boolean; plan_confirmed: boolean; agreed_order_cure_months: number | null; debtor_otherwise_performing: boolean; investment_property: boolean; investment_property_no_equity: boolean; soi_surrender: boolean; counsel_recommends_dismissal: boolean; meeting_341_on: PlainDate | null; today: PlainDate }): { path: MfrPath; companions: MfrPath[]; candidates: { path: MfrPath; applies: boolean; basis: string }[]; rationale: string } {
  const agreed = i.agreed_order_cure_months != null && i.agreed_order_cure_months <= 6 && i.debtor_otherwise_performing;
  const daysSince341 = i.meeting_341_on ? daysBetween(i.meeting_341_on, i.today) : null;
  const adequate = i.conduit_district && !i.plan_confirmed && daysSince341 !== null && daysSince341 > 45;
  const mfr = (i.whole_unpaid >= 2 && !agreed) || (i.chapter === "7" && (i.soi_surrender || i.whole_unpaid >= 1)) || i.investment_property_no_equity;
  const candidates: { path: MfrPath; applies: boolean; basis: string }[] = [
    { path: "agreed_order", applies: agreed, basis: agreed ? `debtor proposes to cure the post-petition default over ${i.agreed_order_cure_months} months and is otherwise performing — accepted by policy (≤ 6 months, 14.1-Q7); post-stipulation defaults follow the $125/$250 notice-of-default path` : i.agreed_order_cure_months != null ? `proposed cure of ${i.agreed_order_cure_months} months exceeds 6 months or the debtor is not otherwise performing — workout path (12.x) with Fannie Mae approval where required (14.1-Q7)` : "no cure proposed by the debtor" },
    { path: "motion_to_dismiss", applies: i.counsel_recommends_dismissal, basis: i.counsel_recommends_dismissal ? "counsel recommends a motion to dismiss under local practice (E-2.2-04: relief from the automatic stay or a dismissal of the case in accordance with local bankruptcy rules and practices)" : "no dismissal recommendation from counsel" },
    { path: "mfr", applies: mfr, basis: mfr ? (i.investment_property_no_equity ? "investment property with no equity and not necessary to an effective reorganization (11 U.S.C. §362(d)(2))" : i.chapter === "7" ? (i.soi_surrender ? "Chapter 7 statement of intention surrenders the property (E-2.2-01: obtain relief as expeditiously as possible)" : "Chapter 7 debtor delinquent and the property not otherwise protected") : `${i.whole_unpaid} post-petition installments unpaid and no cure/agreed order in place (11 U.S.C. §362(d)(1): lack of adequate protection)`) : "fewer than two post-petition installments unpaid, or a cure/agreed order is in place" },
    { path: "adequate_protection", applies: adequate, basis: adequate ? `conduit district, plan not confirmed ${daysSince341} days after the 341 meeting (> 45): instruct counsel to consider a Motion for Adequate Protection Payments (E-2.1-06)` : "not a conduit district awaiting confirmation more than 45 days after the 341 meeting" },
    { path: "sequestration_of_rents", applies: i.investment_property, basis: i.investment_property ? "investment property: confirm the assignment-of-rents clause and have counsel file a Motion for Sequestration of Rental Income (E-2.3-04)" : "principal residence — no rents to sequester" },
  ];
  const path: MfrPath = agreed ? "agreed_order" : i.counsel_recommends_dismissal ? "motion_to_dismiss" : mfr ? "mfr" : adequate ? "adequate_protection" : i.investment_property ? "sequestration_of_rents" : "mfr";
  const companions = candidates.filter((c) => c.applies && c.path !== path).map((c) => c.path);
  return { path, companions, candidates, rationale: `${path}: ${candidates.find((c) => c.path === path)!.basis}${companions.length ? `; alongside ${companions.join(", ")}` : ""}` };
}
export function mfrReferral(i: { loan_id: string; ledgers: Ledgers; today: PlainDate; chapter: Chapter; petition_on: PlainDate; conduit_district: boolean; plan_confirmed: boolean; fnma_delinquency_days_at_filing?: number; open_foreclosure?: boolean; referral_sent_on?: PlainDate | null; agreed_order_cure_months?: number | null; debtor_otherwise_performing?: boolean; investment_property?: boolean; investment_property_no_equity?: boolean; soi_surrender?: boolean; counsel_recommends_dismissal?: boolean; meeting_341_on?: PlainDate | null; firm_id?: string }): {
  status: ReturnType<typeof postpetitionStatus>; fired: boolean; event: EmittedEvent | null; day_60: PlainDate | null; referral_due: PlainDate | null; timer: "FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14"; path: MfrPath | null; path_scoring: ReturnType<typeof scoreMfrPath> | null;
  package: { template: "CRT_MFR_DECL"; assembled_on: PlainDate; same_day: true; contents: readonly string[]; declaration_signer: "signing_officer"; to: "attorney"; fee_cents: Cents | null; escalation: Escalation } | null;
  trustee_status_confirm: { timer: "FNMA_E2_2_04_TRUSTEE_STATUS_CONFIRM_5BD"; due: PlainDate; before_referral: true } | null; completion: ReturnType<typeof completionClock> | null;
  referral: { sent_on: PlainDate; in_time: boolean; breached: boolean; escalation: Escalation | null; event: EmittedEvent } | null; breached_unsent: boolean; events: EmittedEvent[];
} {
  const status = postpetitionStatus(i.ledgers, i.today);
  const fired = status.event !== null;
  if (!fired) return { status, fired: false, event: null, day_60: null, referral_due: null, timer: "FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14", path: null, path_scoring: null, package: null, trustee_status_confirm: null, completion: null, referral: null, breached_unsent: false, events: [] };
  const day60 = addDays(status.whole_unpaid[1]!, 1);   // "two post-petition installments unpaid on the day after the second's due date" — the day the event fired, whatever day the ledger is read
  const due = addDays(day60, 14);
  const completion = i.plan_confirmed ? completionClock({ chapter: i.chapter, petition_on: i.petition_on, fnma_delinquency_days_at_filing: i.fnma_delinquency_days_at_filing ?? 0, open_foreclosure: i.open_foreclosure === true, day_60_on: day60, post_confirmation: true }) : completionClock({ chapter: i.chapter, petition_on: i.petition_on, fnma_delinquency_days_at_filing: i.fnma_delinquency_days_at_filing ?? 0, open_foreclosure: i.open_foreclosure === true, day_60_on: day60 });
  const at = `${day60}T12:00:00.000Z`;
  const event: EmittedEvent = { type: "bankruptcy.postpetition.delinquency.60", occurred_at: at, payload: { loan_id: i.loan_id, chapter: i.chapter, day_60: day60, whole_unpaid: status.whole_unpaid, fnma_bucket: status.fnma_bucket, conduit_district: i.conduit_district, plan_confirmed: i.plan_confirmed, referral_due: due, completion_timer: completion.timer, completion_due_on: completion.due } };
  const scoring = scoreMfrPath({ chapter: i.chapter, whole_unpaid: status.whole_unpaid.length, conduit_district: i.conduit_district, plan_confirmed: i.plan_confirmed, agreed_order_cure_months: i.agreed_order_cure_months ?? null, debtor_otherwise_performing: i.debtor_otherwise_performing === true, investment_property: i.investment_property === true, investment_property_no_equity: i.investment_property_no_equity === true, soi_surrender: i.soi_surrender === true, counsel_recommends_dismissal: i.counsel_recommends_dismissal === true, meeting_341_on: i.meeting_341_on ?? null, today: i.today });
  const path = scoring.path;
  const fee = allowableBkFee(i.chapter, "mfr");
  const pkg = { template: "CRT_MFR_DECL" as const, assembled_on: day60, same_day: true as const, contents: MFR_PACKAGE_CONTENTS, declaration_signer: "signing_officer" as const, to: "attorney" as const, fee_cents: fee, escalation: { kind: "attorney" as const, reason: `${scoring.rationale}: ${status.whole_unpaid.length} post-petition installments unpaid (${status.whole_unpaid.join(", ")}) on ${day60}; MFR package assembled ${day60}; referral due ${due} (E-2.1-08)` } };
  const events: EmittedEvent[] = [event, { type: "bankruptcy.mfr_package.assembled", occurred_at: at, payload: { loan_id: i.loan_id, template: "CRT_MFR_DECL", path, companions: scoring.companions, fee_cents: fee, referral_due: due } }];
  let referral: { sent_on: PlainDate; in_time: boolean; breached: boolean; escalation: Escalation | null; event: EmittedEvent } | null = null;
  if (i.referral_sent_on) {
    const inTime = i.referral_sent_on <= due;
    const ev: EmittedEvent = { type: "bankruptcy.referral.sent", occurred_at: `${i.referral_sent_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, chapter: i.chapter, type: "mfr", full: false, firm_id: i.firm_id ?? null, sent_at: i.referral_sent_on, day_60: day60, referral_due: due, path, completion_due_on: completion.due } };
    referral = { sent_on: i.referral_sent_on, in_time: inTime, breached: !inTime, escalation: inTime ? null : { kind: "officer", severity: "sev1", reason: `MFR referral sent ${i.referral_sent_on}, after the ${due} deadline (E-2.1-08: "no later than two weeks from the 60th day of delinquency"; FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14 breach — Guide breach, compensatory fees)` }, event: ev };
    events.push(ev);
  }
  return { status, fired: true, event, day_60: day60, referral_due: due, timer: "FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14", path, path_scoring: scoring, package: pkg, trustee_status_confirm: i.conduit_district ? { timer: "FNMA_E2_2_04_TRUSTEE_STATUS_CONFIRM_5BD", due: addBusinessDays(day60, 5, servicer), before_referral: true } : null, completion, referral, breached_unsent: !i.referral_sent_on && i.today > due, events };
}

// ============================================================ rule 2: prior filings, the serial-filer stay and counsel's confirmation (T11)
/**
 * §362(c)(3): one prior case pending and dismissed within the preceding year → the stay "shall terminate with respect to the
 * debtor on the 30th day after the filing" unless extended after a hearing completed before the 30 days expire; the platform
 * moves `stay_status` to `terminated_362c3` on day 31 only after counsel's written confirmation (E-2.1-03 — counsel's express
 * advice before any collection continues) and keeps every gate on until then. §362(c)(4): two or more → the stay "shall not go
 * into effect"; `not_in_effect_362c4` with `foreclosure_blocked=true` until counsel confirms in writing (5 BD). Any class other
 * than `none` is an immediate referral labelled "repeat filer" / "possible bankruptcy abuse" (E-2.3-01) with a request that
 * counsel evaluate §362(d)(4) in rem relief and dismissal with prejudice.
 */
export function serialFilerStay(i: { loan_id: string; petition_on: PlainDate; chapter: Chapter; prior_cases: readonly PriorCase[]; abusive_pattern?: boolean; today: PlainDate; extension_order_on?: PlainDate | null; counsel_written_confirmation_on?: PlainDate | null; counsel_confirmation_document_id?: string | null }): {
  serial_filer_class: SerialFilerClass; prior_dismissed_within_1y: PriorCase[]; checked: EmittedEvent; referral: { type: "repeat_filer"; label: "repeat filer" | "possible bankruptcy abuse"; immediate: true; requests: string[]; due: PlainDate } | null;
  stay: { status: StayState; day_30: PlainDate | null; day_31: PlainDate | null; terminated_on: PlainDate | null; extension_order_on: PlainDate | null; awaiting_counsel_confirmation: boolean; confirmed_on: PlainDate | null; basis: string };
  gates: ReturnType<typeof stayGates>; timer: { code: "USC_362C3_SERIAL_STAY_30" | "USC_362C4_NO_STAY_CONFIRM_5BD"; due: PlainDate; satisfied: boolean } | null; escalation: Escalation | null; events: EmittedEvent[];
} {
  const prior = priorDismissedWithin1y(i.prior_cases, i.petition_on);
  const cls = priorFilingClass(prior.length, i.abusive_pattern === true);
  const at = `${i.today}T12:00:00.000Z`;
  const checked: EmittedEvent = { type: "bankruptcy.prior_filings.checked", occurred_at: at, payload: { loan_id: i.loan_id, petition_date: i.petition_on, serial_filer_class: cls, prior_cases: i.prior_cases.map((p) => p.case_number_full), prior_dismissed_within_1y: prior.map((p) => p.case_number_full) } };
  const events: EmittedEvent[] = [checked];
  const label = cls === "abusive_suspected" ? "possible bankruptcy abuse" as const : "repeat filer" as const;
  const referral = cls === "none" ? null : { type: "repeat_filer" as const, label, immediate: true as const, requests: ["NOA", "POC", "evaluate §362(d)(4) in rem relief", "evaluate dismissal with prejudice", ...(cls === "one_prior_dismissed_1y" ? ["§362(c)(3) extension hearing position; written confirmation of termination on day 31"] : cls === "two_plus_prior_dismissed_1y" ? ["written confirmation that no stay is in effect (§362(c)(4))"] : [])], due: i.petition_on };
  const confirmed = i.counsel_written_confirmation_on ?? null;
  if (cls === "one_prior_dismissed_1y") {
    const day30 = addDays(i.petition_on, 30), day31 = addDays(i.petition_on, 31);
    const extended = i.extension_order_on != null && i.extension_order_on <= day30;
    if (extended) {
      events.push({ type: "bankruptcy.stay.extended", occurred_at: `${i.extension_order_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, order_entered_on: i.extension_order_on, statute: "11 U.S.C. §362(c)(3)(B)" } }, { type: "bankruptcy.stay.serial_30.resolved", occurred_at: `${i.extension_order_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, result: "extended", order_entered_on: i.extension_order_on } });
      return { serial_filer_class: cls, prior_dismissed_within_1y: prior, checked, referral, stay: { status: "in_effect", day_30: day30, day_31: day31, terminated_on: null, extension_order_on: i.extension_order_on ?? null, awaiting_counsel_confirmation: false, confirmed_on: null, basis: `stay extended by order entered ${i.extension_order_on} after a hearing completed before day 30 (§362(c)(3)(B))` }, gates: stayGates("in_effect"), timer: { code: "USC_362C3_SERIAL_STAY_30", due: day30, satisfied: true }, escalation: null, events };
    }
    if (i.today < day31) return { serial_filer_class: cls, prior_dismissed_within_1y: prior, checked, referral, stay: { status: "in_effect", day_30: day30, day_31: day31, terminated_on: null, extension_order_on: null, awaiting_counsel_confirmation: false, confirmed_on: null, basis: `stay in effect through day 30 (${day30}) unless extended (§362(c)(3))` }, gates: stayGates("in_effect"), timer: { code: "USC_362C3_SERIAL_STAY_30", due: day30, satisfied: false }, escalation: { kind: "attorney", reason: `§362(c)(3) case: confirm in writing whether the stay terminated as to the debtor on ${day31} (day 31) or was extended by order` }, events };
    if (confirmed && confirmed >= day31) {
      events.push({ type: "bankruptcy.stay.terminated", occurred_at: `${confirmed}T12:00:00.000Z`, payload: { loan_id: i.loan_id, reason: "362c3", terminated_on: day31, counsel_confirmed_on: confirmed, counsel_confirmation_document_id: i.counsel_confirmation_document_id ?? null } }, { type: "bankruptcy.stay.serial_30.resolved", occurred_at: `${confirmed}T12:00:00.000Z`, payload: { loan_id: i.loan_id, result: "terminated_362c3", terminated_on: day31, counsel_confirmed_on: confirmed } }, { type: "bankruptcy.status.changed", occurred_at: `${confirmed}T12:00:00.000Z`, payload: { loan_id: i.loan_id, to: "stay_terminated", reason: "362c3" } });
      return { serial_filer_class: cls, prior_dismissed_within_1y: prior, checked, referral, stay: { status: "terminated_362c3", day_30: day30, day_31: day31, terminated_on: day31, extension_order_on: null, awaiting_counsel_confirmation: false, confirmed_on: confirmed, basis: `no extension order by day 30 (${day30}): the stay terminated as to the debtor on ${day31} (§362(c)(3)(A)); counsel confirmed in writing ${confirmed}` }, gates: stayGates("terminated_362c3", true), timer: { code: "USC_362C3_SERIAL_STAY_30", due: day30, satisfied: true }, escalation: null, events };
    }
    return { serial_filer_class: cls, prior_dismissed_within_1y: prior, checked, referral, stay: { status: "in_effect", day_30: day30, day_31: day31, terminated_on: null, extension_order_on: null, awaiting_counsel_confirmation: true, confirmed_on: null, basis: `day 31 (${day31}) reached with no extension order: the stay has terminated as to the debtor by operation of law (§362(c)(3)(A)) but the platform records terminated_362c3 only on counsel's written confirmation (E-2.1-03); every gate stays on` }, gates: stayGates("in_effect"), timer: { code: "USC_362C3_SERIAL_STAY_30", due: day30, satisfied: false }, escalation: { kind: "attorney", severity: "sev2", reason: `§362(c)(3) day 31 (${day31}) passed without an extension order: written confirmation that the stay terminated is required before any collection or foreclosure act` }, events };
  }
  if (cls === "two_plus_prior_dismissed_1y") {
    const due = addBusinessDays(i.petition_on, 5, servicer);
    if (confirmed) events.push({ type: "attorney.confirmation", occurred_at: `${confirmed}T12:00:00.000Z`, payload: { loan_id: i.loan_id, no_stay: true, confirmed_on: confirmed, statute: "11 U.S.C. §362(c)(4)(A)", document_id: i.counsel_confirmation_document_id ?? null } });
    return { serial_filer_class: cls, prior_dismissed_within_1y: prior, checked, referral, stay: { status: "not_in_effect_362c4", day_30: null, day_31: null, terminated_on: null, extension_order_on: null, awaiting_counsel_confirmation: !confirmed, confirmed_on: confirmed, basis: "two or more prior cases pending and dismissed within the preceding year: the stay does not go into effect (§362(c)(4)(A)); collection continues only on counsel's written confirmation (E-2.1-03)" }, gates: stayGates("not_in_effect_362c4", confirmed !== null), timer: { code: "USC_362C4_NO_STAY_CONFIRM_5BD", due, satisfied: confirmed !== null }, escalation: confirmed ? null : { kind: "attorney", reason: `§362(c)(4) case: written confirmation that no stay is in effect is due ${due}; gates stay on until confirmed` }, events };
  }
  return { serial_filer_class: cls, prior_dismissed_within_1y: prior, checked, referral, stay: { status: "in_effect", day_30: null, day_31: null, terminated_on: null, extension_order_on: null, awaiting_counsel_confirmation: false, confirmed_on: null, basis: cls === "abusive_suspected" ? "stay in effect; pattern of filings around foreclosure/transfer → counsel to evaluate §362(d)(4) in rem relief" : "no prior case pending within the preceding year: the stay is in effect (§362(a))" }, gates: stayGates("in_effect"), timer: null, escalation: cls === "abusive_suspected" ? { kind: "attorney", reason: "possible bankruptcy abuse: evaluate §362(d)(4) in rem relief and dismissal with prejudice (E-2.3-01)" } : null, events };
}

// ============================================================ Rule 3002(c)(7): the filed claim and its 120-day supplement
export function pocFiled(i: { loan_id: string; order_for_relief_on: PlainDate; filed_on: PlainDate; bar_date: PlainDate; writings_complete: boolean; docket_no?: string | null; claim_no?: string | null }): { timely: boolean; status: "filed" | "supplement_due"; event: EmittedEvent; supplement: { timer: "FRBP_3002C7_POC_SUPPLEMENT_120"; anchor: "order_for_relief_date"; anchored_on: PlainDate; due: PlainDate; roll: "frbp_9006_forward" } | null } {
  const timely = i.filed_on <= i.bar_date;
  return { timely, status: i.writings_complete ? "filed" : "supplement_due",
    event: { type: "bankruptcy.poc.filed", occurred_at: `${i.filed_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, filed_on: i.filed_on, order_for_relief_date: i.order_for_relief_on, bar_date: i.bar_date, timely, writings_complete: i.writings_complete, docket_no: i.docket_no ?? null, claim_no: i.claim_no ?? null } },
    supplement: i.writings_complete ? null : { timer: "FRBP_3002C7_POC_SUPPLEMENT_120", anchor: "order_for_relief_date", anchored_on: i.order_for_relief_on, due: rollForward9006(addDays(i.order_for_relief_on, 120)), roll: "frbp_9006_forward" } };
}
// ============================================================ E-2.1-06: adequate protection in conduit districts
/** "where the trustee receives both pre- and post-petition payments and confirmation is more than 45 days after the creditors' meeting, the servicer must instruct the law firm to consider requesting interim payments" — resolved by the instruction or by confirmation. */
export function adequateProtectionCheck(i: { loan_id: string; meeting_341_on: PlainDate; conduit_district: boolean; plan_confirmed_on?: PlainDate | null; attorney_instructed_on?: PlainDate | null; today: PlainDate }): { applies: boolean; due: PlainDate; timer: "FNMA_E2_1_06_ADEQUATE_PROTECTION_45"; instruct_counsel: boolean; trigger: EmittedEvent | null; resolution: EmittedEvent | null } {
  const due = addDays(i.meeting_341_on, 45);
  const confirmedInTime = i.plan_confirmed_on != null && i.plan_confirmed_on <= due;
  const applies = i.conduit_district && !confirmedInTime;
  const trigger: EmittedEvent | null = i.conduit_district ? { type: "bankruptcy.docket.event.received", occurred_at: `${i.meeting_341_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, kind: "meeting_341_held", meeting_341_at: i.meeting_341_on, conduit_district: true, plan_confirmed: false } } : null;
  const resolution: EmittedEvent | null = i.plan_confirmed_on ? { type: "bankruptcy.adequate_protection.resolved", occurred_at: `${i.plan_confirmed_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, result: "plan_confirmed", on: i.plan_confirmed_on } }
    : i.attorney_instructed_on ? { type: "bankruptcy.adequate_protection.resolved", occurred_at: `${i.attorney_instructed_on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, result: "attorney_instructed", on: i.attorney_instructed_on, motion: "adequate protection payments" } } : null;
  return { applies, due, timer: "FNMA_E2_1_06_ADEQUATE_PROTECTION_45", instruct_counsel: applies && i.today >= due && !resolution, trigger, resolution };
}
// ============================================================ detection source (h): an orphan trustee payment
export function orphanTrusteePayment(i: { loan_id: string; received_at: string; amount_cents: Cents; payer_type: string; open_case: boolean; case_number_on_voucher?: string | null }): { orphan: boolean; events: EmittedEvent[]; due: PlainDate | null; timer: "SM_BK_ORPHAN_TRUSTEE_PAYMENT_2BD"; resolve: (result: "case_opened" | "resolved", at: string) => EmittedEvent } {
  const orphan = i.payer_type === "trustee" && !i.open_case;
  const receivedOn = i.received_at.slice(0, 10) as PlainDate;
  return { orphan, timer: "SM_BK_ORPHAN_TRUSTEE_PAYMENT_2BD", due: orphan ? addBusinessDays(receivedOn, 2, servicer) : null,
    events: orphan ? [{ type: "bankruptcy.orphan_payment.detected", occurred_at: i.received_at, payload: { loan_id: i.loan_id, payer_type: "trustee", open_case: false, amount_cents: i.amount_cents, case_number_full: i.case_number_on_voucher ?? null, received_at: i.received_at } }, { type: "bankruptcy.notice.received", occurred_at: i.received_at, payload: { loan_id: i.loan_id, source: "trustee_payment", case_number_full: i.case_number_on_voucher ?? null } }] : [],
    resolve: (result, at) => ({ type: "bankruptcy.orphan_payment.resolved", occurred_at: at, payload: { loan_id: i.loan_id, result } }) };
}

// ============================================================ §14.1 data model: bk_* loan sub-accounts (baseline §5 extension; db/migrations/0030)
/** The kernel's `LoanAccount` union (src/kernel/ledger/ledger.ts LOAN_ACCOUNTS) does not yet list them — `BK_ACCOUNT` casts; the Postgres side is open text with the 0030 comment. */
export const BK_LOAN_ACCOUNTS = ["bk_prepetition_arrearage", "bk_postpetition_suspense", "bk_postpetition_fees_memo", "bk_unsecured_cramdown", "bk_trustee_clearing"] as const;

// ============================================================ lifecycle records the §14.1 tools ingest and the events they append
// Every function below validates one inbound record (a firm message, a docket entry, a trustee confirmation, an officer's
// submission, a docket lookup) and returns the event the tool handler (src/app/tools/section14-1.ts) appends to the event
// store — the trigger or satisfier a timers-14-1.ts row names, with every conditioned field on the payload. Timestamps anchor
// on their Eastern-time civil date (the engine's convention); dates are PlainDate; nothing here is a bare literal.
const iso = (s: unknown, field: string): string => { if (typeof s !== "string" || Number.isNaN(Date.parse(s)) || !/^\d{4}-\d{2}-\d{2}T/.test(s)) throw new RangeError(`${field} must be an ISO timestamp, got ${JSON.stringify(s)}`); return s; };
const civil = (at: string): PlainDate => wallClock(Date.parse(at), "America/New_York").date;
const isDate = (s: unknown, field: string): PlainDate => { if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError(`${field} must be a YYYY-MM-DD date, got ${JSON.stringify(s)}`); return s as PlainDate; };
const nonEmpty = (s: unknown, field: string): string => { if (typeof s !== "string" || s.trim() === "") throw new RangeError(`${field} is required`); return s; };
export const E2_1_04_SLA = { lawfirm_ack_bd: 2, docs_to_firm_bd: 3, workout_review_bd: 5, workout_submit_bd_fannie: 10, decision_to_firm_bd: 5, noa_filed_bd: 10 } as const;

/** E-2.1-04: the law firm acknowledges the referral package "within two business days" — satisfies FNMA_E2_1_04_LAWFIRM_ACK_2BD and arms the E-2.1-05 Notice of Appearance clock (10 BD policy). */
export function referralAcknowledged(i: { loan_id: string; referral_id: string; firm_id: string; sent_at: PlainDate; acknowledged_at: string; acknowledged_by?: string | null }): { event: EmittedEvent; acknowledged_on: PlainDate; ack_due: PlainDate; in_time: boolean; noa: { timer: "FNMA_E2_1_05_NOA_FILED_10BD"; due: PlainDate; guide: "E-2.1-05" } } {
  nonEmpty(i.referral_id, "referral_id"); nonEmpty(i.firm_id, "firm_id"); iso(i.acknowledged_at, "acknowledged_at"); isDate(i.sent_at, "sent_at");
  const on = civil(i.acknowledged_at); if (on < i.sent_at) throw new RangeError(`acknowledged_at ${on} precedes the referral sent ${i.sent_at}`);
  const ackDue = addBusinessDays(i.sent_at, E2_1_04_SLA.lawfirm_ack_bd, servicer); const inTime = on <= ackDue;
  return { event: { type: "bankruptcy.referral.acknowledged", occurred_at: i.acknowledged_at, payload: { loan_id: i.loan_id, referral_id: i.referral_id, firm_id: i.firm_id, acknowledged_at: i.acknowledged_at, acknowledged_on: on, acknowledged_by: i.acknowledged_by ?? null, sent_at: i.sent_at, ack_due: ackDue, in_time: inTime } },
    acknowledged_on: on, ack_due: ackDue, in_time: inTime, noa: { timer: "FNMA_E2_1_05_NOA_FILED_10BD", due: addBusinessDays(on, E2_1_04_SLA.noa_filed_bd, servicer), guide: "E-2.1-05" } };
}
/** E-2.1-04: a document/verification/certification/signature request from the firm — answered "no later than three business days after the law firm asks for them" (FNMA_E2_1_04_DOCS_TO_FIRM_3BD; T17). */
export function documentRequest(i: { loan_id: string; firm_id: string; request_id: string; request_at: string; items: readonly string[] }): { event: EmittedEvent; due: ReturnType<typeof documentRequestDue> } {
  nonEmpty(i.firm_id, "firm_id"); nonEmpty(i.request_id, "request_id"); iso(i.request_at, "request_at");
  if (!i.items.length || i.items.some((x) => typeof x !== "string" || x.trim() === "")) throw new RangeError("a document request names at least one item");
  const due = documentRequestDue({ requested_at: i.request_at });
  return { event: { type: "attorney.document_request.received", occurred_at: i.request_at, payload: { loan_id: i.loan_id, firm_id: i.firm_id, request_id: i.request_id, request_at: i.request_at, requested_on: due.requested_on, items: [...i.items], due: due.due, timer: due.timer } }, due };
}
/** The request is fulfilled only when every item asked for is provided (a partial answer does not stop the 3-BD clock). */
export function documentRequestFulfilled(i: { loan_id: string; request_id: string; request_at: string; fulfilled_at: string; items_requested: readonly string[]; items_provided: readonly string[]; document_ids: readonly string[] }): { event: EmittedEvent; fulfilled_on: PlainDate; due: PlainDate; in_time: boolean } {
  nonEmpty(i.request_id, "request_id"); iso(i.request_at, "request_at"); iso(i.fulfilled_at, "fulfilled_at");
  if (!i.document_ids.length) throw new RangeError("a fulfilled request carries the document ids sent to the firm (case_event with document hashes, rule 3)");
  const missing = i.items_requested.filter((x) => !i.items_provided.includes(x));
  if (missing.length) throw new RangeError(`document request ${i.request_id} is fulfilled only in part — missing: ${missing.join(", ")}`);
  if (Date.parse(i.fulfilled_at) < Date.parse(i.request_at)) throw new RangeError("fulfilled_at precedes request_at");
  const d = documentRequestDue({ requested_at: i.request_at }); const on = civil(i.fulfilled_at); const inTime = on <= d.due;
  return { event: { type: "attorney.document_request.fulfilled", occurred_at: i.fulfilled_at, payload: { loan_id: i.loan_id, request_id: i.request_id, request_at: i.request_at, fulfilled_at: i.fulfilled_at, fulfilled_on: on, document_ids: [...i.document_ids], items: [...i.items_provided], due: d.due, in_time: inTime } }, fulfilled_on: on, due: d.due, in_time: inTime };
}
export type WorkoutKind = "repayment_plan" | "forbearance" | "payment_deferral" | "modification" | "short_sale" | "deed_in_lieu" | "cramdown_terms" | "agreed_order_cure";
/** E-2.1-09 / E-2.3-03: workouts outside delegated authority, liquidation options and every cramdown strategy need Fannie Mae's approval (SMDU, 12.x). */
const FNMA_APPROVAL_KINDS: ReadonlySet<WorkoutKind> = new Set(["modification", "short_sale", "deed_in_lieu", "cramdown_terms"]);
/** E-2.1-04: a workout proposal from counsel — reviewed within 5 BD; submitted to Fannie Mae within 10 BD (Fannie Mae calendar) where approval is required. */
export function workoutProposal(i: { loan_id: string; firm_id: string; proposal_id: string; received_at: string; kind: WorkoutKind; terms: Record<string, unknown>; delegated_authority?: boolean }): { event: EmittedEvent; approval_required: boolean; review: { timer: "FNMA_E2_1_04_WORKOUT_REVIEW_5BD"; due: PlainDate }; submit: { timer: "FNMA_E2_1_04_WORKOUT_SUBMIT_10BD"; due: PlainDate; via: "smdu" } | null } {
  nonEmpty(i.firm_id, "firm_id"); nonEmpty(i.proposal_id, "proposal_id"); iso(i.received_at, "received_at");
  if (!["repayment_plan", "forbearance", "payment_deferral", "modification", "short_sale", "deed_in_lieu", "cramdown_terms", "agreed_order_cure"].includes(i.kind)) throw new RangeError(`workout kind ${String(i.kind)} is not one the spec names`);
  const approval = i.kind === "cramdown_terms" || (FNMA_APPROVAL_KINDS.has(i.kind) && i.delegated_authority !== true);
  const on = civil(i.received_at); const reviewDue = addBusinessDays(on, E2_1_04_SLA.workout_review_bd, servicer); const submitDue = approval ? addBusinessDays(on, E2_1_04_SLA.workout_submit_bd_fannie, fannieEt) : null;
  return { event: { type: "bankruptcy.workout_proposal.received", occurred_at: i.received_at, payload: { loan_id: i.loan_id, firm_id: i.firm_id, proposal_id: i.proposal_id, received_at: i.received_at, received_on: on, kind: i.kind, terms: { ...i.terms }, approval_required: approval, review_due: reviewDue, submit_due: submitDue } },
    approval_required: approval, review: { timer: "FNMA_E2_1_04_WORKOUT_REVIEW_5BD", due: reviewDue }, submit: submitDue ? { timer: "FNMA_E2_1_04_WORKOUT_SUBMIT_10BD", due: submitDue, via: "smdu" } : null };
}
export type WorkoutRecommendation = "accept" | "counter" | "decline" | "submit_to_fannie_mae";
export function workoutProposalReviewed(i: { loan_id: string; proposal_id: string; received_at: string; reviewed_at: string; recommendation: WorkoutRecommendation; rationale: string; reviewer?: string | null }): { event: EmittedEvent; reviewed_on: PlainDate; due: PlainDate; in_time: boolean } {
  nonEmpty(i.proposal_id, "proposal_id"); iso(i.received_at, "received_at"); iso(i.reviewed_at, "reviewed_at"); nonEmpty(i.rationale, "rationale");
  if (!["accept", "counter", "decline", "submit_to_fannie_mae"].includes(i.recommendation)) throw new RangeError(`recommendation ${String(i.recommendation)} is not accept/counter/decline/submit_to_fannie_mae`);
  const due = addBusinessDays(civil(i.received_at), E2_1_04_SLA.workout_review_bd, servicer); const on = civil(i.reviewed_at);
  return { event: { type: "bankruptcy.workout_proposal.reviewed", occurred_at: i.reviewed_at, payload: { loan_id: i.loan_id, proposal_id: i.proposal_id, reviewed_at: i.reviewed_at, reviewed_on: on, recommendation: i.recommendation, rationale: i.rationale, reviewer: i.reviewer ?? null, due, in_time: on <= due } }, reviewed_on: on, due, in_time: on <= due };
}
/** Fannie Mae's decision on a submitted workout (SMDU, 12.x) — relayed to counsel "within five business days" (FNMA_E2_1_04_DECISION_TO_FIRM_5BD). */
export function fnmaWorkoutDecision(i: { loan_id: string; proposal_id: string; received_at: string; decision: "approved" | "declined" | "countered"; smdu_case_id?: string | null; conditions?: readonly string[] }): { event: EmittedEvent; received_on: PlainDate; relay: { timer: "FNMA_E2_1_04_DECISION_TO_FIRM_5BD"; due: PlainDate } } {
  nonEmpty(i.proposal_id, "proposal_id"); iso(i.received_at, "received_at");
  if (!["approved", "declined", "countered"].includes(i.decision)) throw new RangeError(`decision ${String(i.decision)} is not approved/declined/countered`);
  const on = civil(i.received_at); const due = addBusinessDays(on, E2_1_04_SLA.decision_to_firm_bd, servicer);
  return { event: { type: "fnma.workout.decision.received", occurred_at: i.received_at, payload: { loan_id: i.loan_id, proposal_id: i.proposal_id, received_at: i.received_at, received_on: on, decision: i.decision, smdu_case_id: i.smdu_case_id ?? null, conditions: [...(i.conditions ?? [])], relay_due: due } }, received_on: on, relay: { timer: "FNMA_E2_1_04_DECISION_TO_FIRM_5BD", due } };
}
export function attorneyNotified(i: { loan_id: string; firm_id: string; notified_at: string; subject: string; regarding: "fnma_workout_decision" | "adequate_protection" | "instruction" | "status"; proposal_id?: string | null; decision?: string | null; document_id?: string | null; decision_received_at?: string | null }): { event: EmittedEvent; notified_on: PlainDate; due: PlainDate | null; in_time: boolean | null } {
  nonEmpty(i.firm_id, "firm_id"); iso(i.notified_at, "notified_at"); nonEmpty(i.subject, "subject");
  const on = civil(i.notified_at); const due = i.decision_received_at ? addBusinessDays(civil(iso(i.decision_received_at, "decision_received_at")), E2_1_04_SLA.decision_to_firm_bd, servicer) : null;
  return { event: { type: "attorney.notified", occurred_at: i.notified_at, payload: { loan_id: i.loan_id, firm_id: i.firm_id, notified_at: i.notified_at, notified_on: on, subject: i.subject, regarding: i.regarding, proposal_id: i.proposal_id ?? null, decision: i.decision ?? null, document_id: i.document_id ?? null, due, in_time: due ? on <= due : null } }, notified_on: on, due, in_time: due ? on <= due : null };
}
/** Outputs: the POC package is "ready" only when its content rules hold (FRBP_3001C2C_410A_PRESENT, FRBP_9037_REDACTION, FORM410A_PART3_SUM, FORM410A_PART5_LEDGER_TIE, FORM410A_FIRST_DEFAULT_ANCHOR) — then `bankruptcy.poc.package_ready` satisfies SM_BK_POC_PACKAGE_T35. */
export function pocPackageReady(i: { loan_id: string; order_for_relief_on: PlainDate; ready_at: string; part3: Part5Totals; part5_first_default_anchor: boolean; part5_ledger_tie: boolean; form_410a_present: boolean; escrow_statement_present: boolean; redaction_checked: boolean; writings_complete: boolean; claim_document_id?: string | null }): { event: EmittedEvent; ready_on: PlainDate; due: PlainDate; in_time: boolean; content_rules: Record<string, boolean> } {
  iso(i.ready_at, "ready_at"); isDate(i.order_for_relief_on, "order_for_relief_on");
  const p = i.part3;
  const rules: Record<string, boolean> = { FRBP_3001C2C_410A_PRESENT: i.form_410a_present && i.escrow_statement_present, FRBP_9037_REDACTION: i.redaction_checked, FORM410A_PART3_SUM: p.total_prepetition_arrearage_cents === p.principal_due_cents + p.interest_due_cents + p.prepetition_fees_due_cents + p.escrow_deficiency_cents - p.funds_on_hand_cents, FORM410A_PART5_LEDGER_TIE: i.part5_ledger_tie, FORM410A_FIRST_DEFAULT_ANCHOR: i.part5_first_default_anchor };
  const failed = Object.entries(rules).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) throw new RangeError(`POC package is not ready — content rules failed: ${failed.join(", ")}`);
  const on = civil(i.ready_at); const due = addDays(i.order_for_relief_on, 35);
  return { event: { type: "bankruptcy.poc.package_ready", occurred_at: i.ready_at, payload: { loan_id: i.loan_id, ready_at: i.ready_at, ready_on: on, order_for_relief_date: i.order_for_relief_on, due, in_time: on <= due, writings_complete: i.writings_complete, total_prepetition_arrearage_cents: p.total_prepetition_arrearage_cents, claim_document_id: i.claim_document_id ?? null, content_rules: rules } }, ready_on: on, due, in_time: on <= due, content_rules: rules };
}
export const RULE_3001_WRITINGS = ["note", "mortgage", "assignments", "perfection_evidence"] as const;
/** Rule 3002(c)(7)/3001(c)(1),(d): the supplement carries the writings (note with allonges or the lost-note affidavit, recorded mortgage, assignments/MERS report) and perfection evidence — filed within 120 days of the order for relief. */
export function pocSupplementFiled(i: { loan_id: string; order_for_relief_on: PlainDate; filed_at: string; writings: { note?: string | null; lost_note_affidavit?: string | null; mortgage?: string | null; assignments?: string | null; perfection_evidence?: string | null }; docket_no?: string | null; claim_no?: string | null }): { event: EmittedEvent; filed_on: PlainDate; due: PlainDate; timely: boolean; documents: Record<string, string> } {
  iso(i.filed_at, "filed_at"); isDate(i.order_for_relief_on, "order_for_relief_on");
  const docs: Record<string, string> = {};
  const note = i.writings.note || i.writings.lost_note_affidavit; if (!note) throw new RangeError("the supplement must attach the note (with allonges) or the lost-note affidavit (Rule 3001(c)(1))");
  docs[i.writings.note ? "note" : "lost_note_affidavit"] = note;
  for (const w of ["mortgage", "assignments", "perfection_evidence"] as const) { const d = i.writings[w]; if (!d) throw new RangeError(`the supplement must attach ${w} (Rule 3001(c)(1)/(d))`); docs[w] = d; }
  const on = civil(i.filed_at); const due = rollForward9006(addDays(i.order_for_relief_on, 120)); const timely = on <= due;
  return { event: { type: "bankruptcy.poc.supplement.filed", occurred_at: i.filed_at, payload: { loan_id: i.loan_id, filed_at: i.filed_at, filed_on: on, order_for_relief_date: i.order_for_relief_on, due, timely, docket_no: i.docket_no ?? null, claim_no: i.claim_no ?? null, writings: docs, writings_complete: true } }, filed_on: on, due, timely, documents: docs };
}
/** Docket event types (data model `bankruptcy_docket_events.event_type`: the spec's list plus the platform's monitor kinds the timer table names). */
export const DOCKET_EVENT_TYPES = ["meeting_341_scheduled", "bar_date_notice", "plan_filed", "plan_amended", "confirmation_hearing_set", "plan_confirmed", "plan_modification_filed", "objection_to_claim", "claim_transfer_notice", "mfr_hearing_set", "relief_order_entered", "agreed_order_entered", "soi_filed", "reaffirmation_filed", "reaffirmation_approved", "reaffirmation_rescinded", "trustee_notice_410c13_n", "motion_410c13_m1", "motion_410c13_m2", "dismissal_order", "discharge_order", "conversion_order", "case_closed", "case_reopened", "trustee_final_report", "abandonment", "motion_to_sell", "motion_to_incur_debt", "hardship_discharge",
  "noa_filed", "mfr_filed", "mfr_hearing_held", "mfr_continued_order", "mfr_extension_order", "meeting_341_held", "attorney_appearance"] as const;
export type DocketEventType = (typeof DOCKET_EVENT_TYPES)[number];
export interface DocketRecord {
  readonly loan_id: string; readonly case_number_full: string; readonly chapter: Chapter; readonly source: "ebn" | "pcl" | "vendor" | "attorney" | "mail" | "dra" | "contact"; readonly kind: string; readonly event_date: PlainDate; readonly entered_at: string;
  readonly docket_no?: string | null; readonly document_id?: string | null; readonly parsed?: Record<string, unknown>; readonly classifier_confidence: number; readonly verified_by?: "agent" | "human_agent" | "attorney" | null;
  /** Case facts the timer rows condition on (§362(e)(2) individual debtor; E-2.1-06 conduit district / confirmation). */
  readonly individual_debtor?: boolean; readonly conduit_district?: boolean; readonly plan_confirmed?: boolean; readonly petition_date?: PlainDate | null;
}
/**
 * Ingestion of one verified docket entry: the record is validated (a typed `kind`, dates, the classification gate — below 0.90
 * confidence or a dismissal/discharge/relief/conversion/closing order changes state only with a human verifier) and becomes
 * `bankruptcy.docket.event.received{kind, chapter, individual, …}` with the kind-specific anchors the rows read (`bar_date`,
 * `meeting_341_first_set_at`, `meeting_341_at`, `filed_at`, `entered_at`, `served_at`), plus the derived case events the
 * alias map names (relief → the Rule 4001(a)(3) gate; confirmation → `bankruptcy.plan.confirmed`; reaffirmation → `bankruptcy.reaffirmation.filed`).
 */
export function docketEventReceived(r: DocketRecord): { event: EmittedEvent; derived: EmittedEvent[]; gate: ReturnType<typeof docketClassification>; verified_by: "agent" | "human_agent" | "attorney" } {
  if (!(DOCKET_EVENT_TYPES as readonly string[]).includes(r.kind)) throw new RangeError(`docket event kind ${JSON.stringify(r.kind)} is not a typed docket event`);
  nonEmpty(r.case_number_full, "case_number_full"); isDate(r.event_date, "event_date"); iso(r.entered_at, "entered_at");
  if (!(r.classifier_confidence >= 0 && r.classifier_confidence <= 1)) throw new RangeError("classifier_confidence must be within [0, 1]");
  const gate = docketClassification({ event_type: r.kind, confidence: r.classifier_confidence });
  const human = r.verified_by === "human_agent" || r.verified_by === "attorney";
  if (!gate.state_change_allowed && !human) throw new RangeError(`docket ${r.kind} cannot change state: ${gate.reason} — verified_by human_agent/attorney against the PDF is required`);
  const p = r.parsed ?? {}; const kind = r.kind as DocketEventType;
  const payload: Record<string, unknown> = { loan_id: r.loan_id, case_number_full: r.case_number_full, chapter: r.chapter, source: r.source, kind, event_date: r.event_date, entered_at: r.entered_at, entered_on: r.event_date, docket_no: r.docket_no ?? null, document_id: r.document_id ?? null, classifier_confidence: r.classifier_confidence, verified_by: human ? r.verified_by : "agent", individual: r.individual_debtor ?? true, filed_at: r.event_date };
  const derived: EmittedEvent[] = []; const at = r.entered_at;
  switch (kind) {
    case "bar_date_notice": { payload.bar_date = isDate(p.bar_date, "parsed.bar_date"); if (r.chapter !== "11") payload.note = "Chapter 7/12/13 claims run Rule 3002(c)'s 70 days; a noticed bar date only overrides by court order"; break; }
    case "meeting_341_scheduled": { const m = isDate(p.meeting_at ?? r.event_date, "parsed.meeting_at"); payload.meeting_341_first_set_at = m; payload.meeting_341_at = m; if (r.petition_date) { const statutory = addDays(r.petition_date, 30); payload.soi_due_on = m < statutory ? m : statutory; } break; }
    case "meeting_341_held": { payload.meeting_341_at = isDate(p.meeting_at ?? r.event_date, "parsed.meeting_at"); payload.conduit_district = r.conduit_district === true; payload.plan_confirmed = r.plan_confirmed === true; break; }
    case "relief_order_entered": { const g = reliefOrderGate({ entered_on: r.event_date, waived_stay: p.waives_14_day_stay === true, today: r.event_date, loan_id: r.loan_id }); payload.waived_14_day_stay = p.waives_14_day_stay === true; payload.stayed_through = g.stayed_through; payload.opens_on = g.opens_on; derived.push(...g.emitted); break; }
    case "agreed_order_entered": { payload.cure_months = typeof p.cure_months === "number" ? p.cure_months : null; derived.push({ type: "bankruptcy.status.changed", occurred_at: at, payload: { loan_id: r.loan_id, to: "agreed_order" } }); break; }
    case "plan_confirmed": { derived.push({ type: "bankruptcy.plan.confirmed", occurred_at: at, payload: { loan_id: r.loan_id, case_number_full: r.case_number_full, confirmed_on: r.event_date } }, { type: "bankruptcy.status.changed", occurred_at: at, payload: { loan_id: r.loan_id, to: "plan_confirmed", chapter: r.chapter } }); break; }
    case "reaffirmation_filed": { derived.push({ type: "bankruptcy.reaffirmation.filed", occurred_at: at, payload: { loan_id: r.loan_id, filed_on: r.event_date, document_id: r.document_id ?? null } }); break; }
    case "soi_filed": { payload.intent = typeof p.intent === "string" ? p.intent : null; break; }
    case "motion_410c13_m1": case "trustee_notice_410c13_n": case "motion_410c13_m2": { payload.served_at = typeof p.served_at === "string" ? p.served_at : r.event_date; payload.served_by_mail = p.served_by_mail === true; break; }
    case "case_closed": { derived.push({ type: "bankruptcy.case.closed", occurred_at: at, payload: { loan_id: r.loan_id, closed_on: r.event_date } }, { type: "bankruptcy.status.changed", occurred_at: at, payload: { loan_id: r.loan_id, to: "closed" } }); break; }
    case "case_reopened": { derived.push({ type: "bankruptcy.case.reopened", occurred_at: at, payload: { loan_id: r.loan_id, reopened_on: r.event_date } }, { type: "bankruptcy.gates.applied", occurred_at: at, payload: { loan_id: r.loan_id, ...gatesOn(at, "bankruptcy.case.reopened", r.chapter) } }); break; }
    default: break;
  }
  return { event: { type: "bankruptcy.docket.event.received", occurred_at: at, payload }, derived, gate, verified_by: human ? (r.verified_by as "human_agent" | "attorney") : "agent" };
}
export type SoiAction = "reaffirmation_filed" | "surrender_relief" | "ride_through";
/** §521(a)(2)(B): the statement of intention is performed "within 30 days after the first date set for the meeting of creditors" — reaffirmation filed, surrender relief, or the ride-through recorded (a home mortgage debtor may ride through, §521(a)(6)/§362(h) reach personal property only). */
export function soiPerformed(i: { loan_id: string; action: SoiAction; performed_at: string; meeting_341_first_set_at: PlainDate; document_id?: string | null }): { event: EmittedEvent; performed_on: PlainDate; due: PlainDate; in_time: boolean } {
  if (!["reaffirmation_filed", "surrender_relief", "ride_through"].includes(i.action)) throw new RangeError(`SOI action ${String(i.action)} is not reaffirmation_filed/surrender_relief/ride_through`);
  iso(i.performed_at, "performed_at"); isDate(i.meeting_341_first_set_at, "meeting_341_first_set_at");
  const on = civil(i.performed_at); const due = addDays(i.meeting_341_first_set_at, 30);
  return { event: { type: "bankruptcy.soi.performed", occurred_at: i.performed_at, payload: { loan_id: i.loan_id, action: i.action, performed_at: i.performed_at, performed_on: on, meeting_341_first_set_at: i.meeting_341_first_set_at, due, in_time: on <= due, document_id: i.document_id ?? null } }, performed_on: on, due, in_time: on <= due };
}
/** E-2.2-04: in conduit districts plan-payment status is confirmed with the trustee within 5 BD of the 60th day before the referral (FNMA_E2_2_04_TRUSTEE_STATUS_CONFIRM_5BD). */
export function trusteeStatusConfirmed(i: { loan_id: string; case_number_full: string; day_60: PlainDate; confirmed_at: string; trustee_name: string; plan_payment_status: "current" | "delinquent" | "no_record"; last_disbursement_on?: PlainDate | null; arrearage_paid_cents?: Cents; postpetition_paid_cents?: Cents }): { event: EmittedEvent; confirmed_on: PlainDate; due: PlainDate; in_time: boolean; proceed_to_referral: boolean } {
  nonEmpty(i.case_number_full, "case_number_full"); nonEmpty(i.trustee_name, "trustee_name"); isDate(i.day_60, "day_60"); iso(i.confirmed_at, "confirmed_at");
  if (!["current", "delinquent", "no_record"].includes(i.plan_payment_status)) throw new RangeError(`plan_payment_status ${String(i.plan_payment_status)} is not current/delinquent/no_record`);
  const on = civil(i.confirmed_at); const due = addBusinessDays(i.day_60, 5, servicer);
  return { event: { type: "trustee.status.confirmed", occurred_at: i.confirmed_at, payload: { loan_id: i.loan_id, case_number_full: i.case_number_full, day_60: i.day_60, confirmed_at: i.confirmed_at, confirmed_on: on, trustee_name: i.trustee_name, plan_payment_status: i.plan_payment_status, last_disbursement_on: i.last_disbursement_on ?? null, arrearage_paid_cents: i.arrearage_paid_cents ?? 0n, postpetition_paid_cents: i.postpetition_paid_cents ?? 0n, due, in_time: on <= due } },
    confirmed_on: on, due, in_time: on <= due, proceed_to_referral: i.plan_payment_status !== "current" };
}
/** Schedules: the daily docket reconciliation for an open case (vendor alerts or PCL `cases/find` by `caseNumberFull`) — SM_BK_DOCKET_SYNC_1BD re-arms on every completed lookup. */
export function docketSyncCompleted(i: { loan_id: string; case_number_full: string; synced_at: string; source: "vendor" | "pcl"; entries_seen: number; last_docket_no?: string | null; pcl_report_id?: string | null }): { event: EmittedEvent; synced_on: PlainDate } {
  nonEmpty(i.case_number_full, "case_number_full"); iso(i.synced_at, "synced_at");
  if (i.source !== "vendor" && i.source !== "pcl") throw new RangeError("docket sync source is vendor or pcl (PCL is a locator; docket documents come via EBN, vendor or counsel)");
  if (!Number.isInteger(i.entries_seen) || i.entries_seen < 0) throw new RangeError("entries_seen must be a non-negative integer");
  const on = civil(i.synced_at);
  return { event: { type: "bankruptcy.docket.sync.completed", occurred_at: i.synced_at, payload: { loan_id: i.loan_id, case_number_full: i.case_number_full, synced_at: i.synced_at, synced_on: on, source: i.source, entries_seen: i.entries_seen, last_docket_no: i.last_docket_no ?? null, pcl_report_id: i.pcl_report_id ?? null } }, synced_on: on };
}
/** Rule 4001(d): an agreed order/stipulation is noticed; objections are due 14 days after the notice is mailed, +3 days when served by mail (Rule 9006(f)) — the anchor carries the adjustment. Policy 14.1-Q7 decides acceptance. */
export function agreedOrderNoticed(i: { loan_id: string; mailed_at: PlainDate; served_by_mail: boolean; cure_months: number; postpetition_default_cents: Cents; debtor_otherwise_performing: boolean; document_id?: string | null }): { event: EmittedEvent; objection_anchor_on: PlainDate; objection_deadline: PlainDate; accepted_by_policy: boolean; escalation: Escalation } {
  isDate(i.mailed_at, "mailed_at"); if (!Number.isInteger(i.cure_months) || i.cure_months < 1) throw new RangeError("cure_months must be a positive integer"); if (i.postpetition_default_cents <= 0n) throw new RangeError("an agreed order cures a positive post-petition default");
  const anchor = i.served_by_mail ? addDays(i.mailed_at, 3) : i.mailed_at; const deadline = addDays(anchor, 14);
  const accepted = i.cure_months <= 6 && i.debtor_otherwise_performing;
  return { event: { type: "bankruptcy.agreed_order.noticed", occurred_at: `${i.mailed_at}T12:00:00.000Z`, payload: { loan_id: i.loan_id, mailed_at: i.mailed_at, served_by_mail: i.served_by_mail, objection_anchor_on: anchor, objection_deadline: deadline, cure_months: i.cure_months, postpetition_default_cents: i.postpetition_default_cents, accepted_by_policy: accepted, document_id: i.document_id ?? null } },
    objection_anchor_on: anchor, objection_deadline: deadline, accepted_by_policy: accepted, escalation: { kind: "attorney", reason: accepted ? `agreed order noticed ${i.mailed_at}: ${i.cure_months}-month cure of ${i.postpetition_default_cents} cents accepted by policy (≤ 6 months, 14.1-Q7); objections due ${deadline} (Rule 4001(d)${i.served_by_mail ? " + 9006(f)" : ""})` : `agreed order noticed ${i.mailed_at}: ${i.cure_months}-month cure exceeds policy (14.1-Q7) — workout path (12.x) and Fannie Mae approval where required; objections due ${deadline}` } };
}
export type CodebtorGround = "1301c1" | "1301c2" | "1301c3";
/** §1301(c): counsel's request for relief from the co-debtor stay; a (c)(2) request "is granted automatically 20 days after filing absent a written objection" (§1301(d)). */
export function codebtorReliefRequested(i: { loan_id: string; filed_at: PlainDate; ground: CodebtorGround; codebtor_ids: readonly string[]; document_id?: string | null }): { event: EmittedEvent; auto_termination_on: PlainDate | null; timer: "USC_1301D_CODEBTOR_RELIEF_20" | null } {
  isDate(i.filed_at, "filed_at"); if (!["1301c1", "1301c2", "1301c3"].includes(i.ground)) throw new RangeError(`ground ${String(i.ground)} is not 1301c1/1301c2/1301c3`); if (!i.codebtor_ids.length) throw new RangeError("codebtor_ids names the non-filing obligor(s)");
  const auto = i.ground === "1301c2" ? addDays(i.filed_at, 20) : null;
  return { event: { type: "bankruptcy.codebtor_relief.requested", occurred_at: `${i.filed_at}T12:00:00.000Z`, payload: { loan_id: i.loan_id, filed_at: i.filed_at, ground: i.ground, codebtor_ids: [...i.codebtor_ids], auto_termination_on: auto, document_id: i.document_id ?? null } }, auto_termination_on: auto, timer: auto ? "USC_1301D_CODEBTOR_RELIEF_20" : null };
}
export function codebtorReliefResolved(i: { loan_id: string; filed_at: PlainDate; result: "objection_docketed" | "auto_terminated"; on: PlainDate; docket_no?: string | null }): { event: EmittedEvent } {
  isDate(i.filed_at, "filed_at"); isDate(i.on, "on"); const day20 = addDays(i.filed_at, 20);
  if (i.result === "auto_terminated" && i.on < day20) throw new RangeError(`the co-debtor stay terminates by operation of law on ${day20}, not ${i.on} (§1301(d))`);
  if (i.result === "objection_docketed" && i.on > day20) throw new RangeError(`an objection docketed ${i.on} is after day 20 (${day20}): the request was granted by operation of law (§1301(d))`);
  if (i.result !== "auto_terminated" && i.result !== "objection_docketed") throw new RangeError("result is objection_docketed or auto_terminated");
  return { event: { type: "bankruptcy.codebtor_relief.resolved", occurred_at: `${i.on}T12:00:00.000Z`, payload: { loan_id: i.loan_id, filed_at: i.filed_at, result: i.result, on: i.on, docket_no: i.docket_no ?? null, statute: "11 U.S.C. §1301(d)" } } };
}
/** E-2.3-03 / E-2.2-02: the `officer` submits the Form 20 (Non-Routine Litigation Form) to Fannie Mae Legal through the F-4-02 contact — satisfies FNMA_E2_3_03_FORM20_IMMEDIATE_1BD. */
export function form20Submitted(i: { loan_id: string; cause: "cramdown" | "chapter_11"; required_at: string; submitted_at: string; submitted_by: { kind: string; id: string; role?: string }; channel: "email" | "upload"; package_document_id: string; fnma_contact: string }): { event: EmittedEvent; submitted_on: PlainDate; due: PlainDate; in_time: boolean } {
  if (i.cause !== "cramdown" && i.cause !== "chapter_11") throw new RangeError("cause is cramdown or chapter_11"); iso(i.required_at, "required_at"); iso(i.submitted_at, "submitted_at"); nonEmpty(i.package_document_id, "package_document_id"); nonEmpty(i.fnma_contact, "fnma_contact");
  if (i.submitted_by.kind !== "human" || i.submitted_by.role !== "officer") throw new RangeError("Form 20 is submitted by the officer (14.1 guardrail: Form 20 and repurchase decisions require officer)");
  if (i.channel !== "email" && i.channel !== "upload") throw new RangeError("channel is email or upload (F-4-02 contact; 14.1-Q8)");
  const on = civil(i.submitted_at); const due = addBusinessDays(civil(i.required_at), 1, fannieEt);
  return { event: { type: "fnma.form20.submitted", occurred_at: i.submitted_at, payload: { loan_id: i.loan_id, cause: i.cause, required_at: i.required_at, submitted_at: i.submitted_at, submitted_on: on, submitted_by: `${i.submitted_by.kind}:${i.submitted_by.id}`, channel: i.channel, package_document_id: i.package_document_id, fnma_contact: i.fnma_contact, due, in_time: on <= due } }, submitted_on: on, due, in_time: on <= due };
}
/** The informational breach letter's cure period is derived from its dates (E-2.2-01 / security instrument §22: at least 30 days), never self-reported. */
export function breachLetterPayload(p: Record<string, unknown>): Record<string, unknown> {
  const nd = p.notice_date, cb = p.cure_by;
  if (typeof nd === "string" && typeof cb === "string" && /^\d{4}-\d{2}-\d{2}$/.test(nd) && /^\d{4}-\d{2}-\d{2}$/.test(cb)) return { ...p, cure_days: daysBetween(nd as PlainDate, cb as PlainDate) };
  return p;
}
