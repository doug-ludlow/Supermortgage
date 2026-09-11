/**
 * §21.5 operating rules — changed circumstances, revised Loan Estimates and tolerance management: the good-faith
 * baseline §1026.19(e)(3)(i)–(iii) sets at `fee.baseline.set` (21.2), the six revision reasons (e)(3)(iv)(A)–(F), the
 * 10 % aggregate threshold ("increase by more than 10 percent"), the 3-general-business-day revised-LE clock
 * (e)(4)(i) on the creditor calendar, the 4-specific-business-day receipt limit and the CD bar of (e)(4)(ii), the
 * tolerance test at every stage, the closing-table cure and the 60-day refund of (f)(2)(v) — bigint cents, PlainDate
 * strings, the four named calendars, and the 21.2 fee model / calculations reused, never re-implemented.
 *
 * `ToleranceService` is the process's command surface (the `disclosure` agent's tools call it). Events (subject = the
 * application; every payload carries `application_id` so the origination timers arm — src/kernel/timers/engine.ts):
 *
 *   fee.change.classified{fee_code, class_before, class_after, direction, matters}
 *   changed_circumstance.recorded{cc_id, kind, basis, valid=true, information_received_at, information_received_on, revised_le_due_at,
 *                                 revised_le_due_on, reflected_on, affected_fee_codes, threshold_test}     [arms REGZ_1026_19E4_REVISED_LE_3BD]
 *   changed_circumstance.rejected{cc_id, basis, valid=false, invalid_reason, reflected_on∈{none_invalid, none_decrease}}
 *   fee.baseline.reset{cc_id, fee_codes, items}  ·  fee.baseline.reset.withdrawn{cc_id, fee_codes}   (3-day breach: the original baseline governs)
 *   disclosure.le.rendered{disclosure_id, le_version, basis=revised, data_hash, cc_ids}
 *   disclosure.le.delivered{le_version} / disclosure.le.mailed{le_version}                 (21.2's channel events, revised versions)
 *   disclosure.le.revised{disclosure_id, version, cc_ids, reason, reasons, channel, issued_on, deemed_receipt_date, latest_receipt_on}
 *                                                                                           [arms REGZ_1026_19E4_REVISED_LE_4SBD_GATE; satisfies 21.4's REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD when reason=rate_lock]
 *   disclosure.le.revised.refused{code∈{NO_REVISED_LE_AFTER_CD, FOUR_DAY_LIMIT}, cc_ids, route}
 *   disclosure.le.received{disclosure_id, le_version, evidence, effective_receipt_date}
 *   changed_circumstance.reflected{cc_id, reflected_on∈{le, cd, corrected_cd}, disclosure_id}   [satisfies REGZ_1026_19E4_REVISED_LE_3BD on either route]
 *   disclosure.cd.revised_estimate.requested{cc_id, route, fee_codes, amounts}                 (the 25.2 hand-off: reflectOnCD)
 *   gate.revised_le_4sbd.opened{disclosure_id, effective_receipt_date, earliest_consummation_date}   [satisfies the 4-SBD gate]
 *   tolerance.test.completed{test_id, stage, status, total_excess_cents, run_at, run_on}     [arms SM_TOLERANCE_CURE_REVIEW_SLA_1BD when status=escalated; 25.1 consumes]
 *   tolerance.cure.applied{cure_id, test_id, amount_cents, method=lender_credit_at_closing, funded_by, ledger_set_id, cd_statement}
 *   tolerance.cure.reviewed{test_id, reviewer_role, outcome}                                  [satisfies SM_TOLERANCE_CURE_REVIEW_SLA_1BD]
 *   tolerance.refund.issued{cure_id, amount_cents, instrument, sent_at, sent_on, due_on}
 *   disclosure.cd.correction.requested{reason=tolerance_refund, cure_id}                      (25.2 requestCorrectedCD)
 *   tolerance.refund.completed{cure_id, refund_sent, corrected_cd_delivered, no_excess_found}   [satisfies REGZ_1026_19F2V_TOLERANCE_REFUND_60 — both (f)(2)(v) duties]
 *   compliance.incident.opened{incident_id, code}                                             (breach handling, the exam file)
 *
 * Consumed: fee.baseline.set (21.2); changed_circumstance.recorded{kind=rate_lock|borrower_request} / lock.executed (21.4);
 * escrow.waiver.decided{origin=origination, le_revision} (30.3); intent.to_proceed.received (21.4, basis E after the
 * 21.2 expiration); disclosure.cd.delivered / disclosure.cd.corrected (25.2); closing.consummated (26.x).
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, plainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, regzSpecific } from "../../kernel/calendar/business.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { formatCents, type Cents } from "../../kernel/money/index.ts";
import type { Actor, DomainEvent, EventStore, Clock } from "../../kernel/events/index.ts";
import type { AccountRef, CorporateAccount, EntrySet, Ledger } from "../../kernel/ledger/ledger.ts";
import {
  AGENT, civilDate, creditorCalendarFrom, PHOENIX_CREDITOR, deriveToleranceClass, deemedReceiptDate, consentValidFor, isElectronic, isInPerson, DELIVERY_CHANNELS,
  assembleFees, sectionTotals, loanEstimateCalcs, computeApr, netPrepaidFinanceCharge, h24Payload, dataHash, H24_TEMPLATE_VERSION,
  type CreditorCalendarSpec, type FeeItemInput, type FeeItem, type ToleranceClass, type LeSection, type DeliveryChannel, type ReceiptEvidence, type EsignConsent, type LeRenderInput, type SectionTotals, type LeCalcs, type AprCalculation,
} from "./ops-21-2.ts";

export { AGENT };
export const ENGINE_VERSION = "21.5 tolerance engine 2026.09";
/** `rule_sets.cure_review_threshold_cents` default: a cure above $500 is posted and root-caused by compliance-sentinel. */
export const CURE_REVIEW_THRESHOLD_CENTS: Cents = 50_000n;
export const FEE_TABLE_MAX_AGE_DAYS = 30;
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isoOrThrow = (v: unknown, what: string): string => { const s = nonEmpty(v, what); if (Number.isNaN(Date.parse(s))) throw new RangeError(`${what} must be an ISO instant`); return s; };
const S = (c: Cents): string => c.toString();

// ============================================================ vocabulary (data model)
export type Basis = "A1" | "A2" | "A3" | "B" | "C" | "D" | "E" | "F";
export const BASES: readonly Basis[] = ["A1", "A2", "A3", "B", "C", "D", "E", "F"];
/** Baseline addendum §3 `changed_circumstances.kind` + `eligibility_change` (discrepancy 5: no value for reason (B)). */
export type CcKind = "extraordinary_event" | "inaccurate_info" | "new_info" | "borrower_request" | "rate_lock" | "le_expired" | "construction_delay" | "eligibility_change";
export const KIND_BY_BASIS: Readonly<Record<Basis, CcKind>> = { A1: "extraordinary_event", A2: "inaccurate_info", A3: "new_info", B: "eligibility_change", C: "borrower_request", D: "rate_lock", E: "le_expired", F: "construction_delay" };
/** The operative words of §1026.19(e)(3)(iv) each basis must map to (the narrative quotes them). */
export const OPERATIVE_WORDS: Readonly<Record<Basis, string>> = {
  A1: "an extraordinary event beyond the control of any interested party or other unexpected event specific to the consumer or transaction",
  A2: "information specific to the consumer or transaction that the creditor relied upon when providing the disclosures … and that was inaccurate or changed after the disclosures were provided",
  A3: "new information specific to the consumer or transaction that the creditor did not rely on when providing the original disclosures",
  B: "the consumer is ineligible for an estimated charge previously disclosed because a changed circumstance … affected the consumer's creditworthiness or the value of the security for the loan",
  C: "the consumer requests revisions to the credit terms or the settlement that cause an estimated charge to increase",
  D: "the interest rate was not locked when the disclosures were provided … the interest rate is subsequently locked",
  E: "the consumer indicates an intent to proceed with the transaction more than 10 business days … after the disclosures … are provided",
  F: "the transaction involves financing of a new construction and the creditor reasonably expects that settlement will occur more than 60 days after the original disclosures",
};
export type ReflectedOn = "le" | "cd" | "corrected_cd" | "none_decrease" | "none_invalid";
export type CcStatus = "detected" | "evaluated_valid" | "evaluated_invalid" | "revised_le_scheduled" | "revised_le_delivered" | "reflected_on_cd" | "closed";
export type PaidBy = "borrower" | "seller" | "lender" | "other";
export type Stage = "le_revision" | "cd_initial" | "cd_corrected" | "pre_funding" | "post_consummation" | "qc";
export const STAGES: readonly Stage[] = ["le_revision", "cd_initial", "cd_corrected", "pre_funding", "post_consummation", "qc"];
export const POST_CONSUMMATION_STAGES: readonly Stage[] = ["post_consummation", "qc"];
export type TestStatus = "pass" | "cure_required" | "cured_at_closing" | "refund_required" | "refunded" | "escalated";

export interface FeeHistoryEntry { readonly at: string; readonly from_cents: Cents; readonly to_cents: Cents; readonly cause: string; readonly cc_id: string | null; readonly actor: string; }
/** `fee_items` as 21.5 reads them: the class is derived at `fee.baseline.set`, never entered; `history` records every amount change with its cause. */
export interface BaselineItem {
  readonly fee_code: string; readonly description: string; readonly le_section: LeSection; readonly mismo_fee_type: string; readonly tolerance_class: ToleranceClass;
  baseline_amount_cents: Cents; readonly baseline_disclosure_id: string; readonly baseline_set_at: string; baseline_reset_cc_id: string | null; current_amount_cents: Cents;
  readonly paid_by: PaidBy; readonly estimate_source: string; readonly estimate_source_ref: string; readonly estimated_at: PlainDate; readonly history: FeeHistoryEntry[];
}
export interface ThresholdTest { readonly bucket_baseline_cents: Cents; readonly bucket_revised_cents: Cents; readonly increase_cents: Cents; readonly threshold_cents: Cents; readonly exceeds: boolean; readonly items: readonly string[]; }
export interface FourDayCheck { readonly latest_receipt: PlainDate | null; readonly cd_delivered_on: PlainDate | null; readonly effective_receipt_date: PlainDate | null; readonly permitted: boolean; readonly route: "le" | "cd" | "corrected_cd"; readonly reason: string; }
export interface ChangedCircumstanceRow {
  readonly cc_id: string; readonly application_id: string; readonly kind: CcKind; readonly basis: Basis; readonly information_received_at: string; readonly information_received_on: PlainDate; readonly discovered_at: string;
  readonly source_event_id: string | null; readonly narrative: string; readonly evidence_document_ids: readonly string[]; readonly affected_fee_codes: readonly string[]; readonly ten_pct_threshold_test: ThresholdTest | null;
  readonly valid: boolean; readonly invalid_reason: string | null; readonly revised_le_due_at: string | null; readonly revised_le_due_on: PlainDate | null; revised_le_disclosure_id: string | null; reflected_on: ReflectedOn;
  baseline_reset: boolean; status: CcStatus; readonly recorded_by: string; reviewer_id: string | null; readonly four_day_check: FourDayCheck | null; readonly external: boolean; readonly revised_amounts: Readonly<Record<string, Cents>>;
  breach: { at: string; incident_id: string; reset_withdrawn: boolean } | null;
}

// ============================================================ rule 1: tolerance class derivation (never entered by hand)
export interface FeeChangeClassification { readonly fee_code: string; readonly class_before: ToleranceClass; readonly class_after: ToleranceClass; readonly direction: "increase" | "decrease" | "none"; readonly delta_cents: Cents; readonly matters: boolean; readonly why: string; }
/** The 21.2 derivation is the single source of the class (rule 1: from facts — section, provider, shopping — never from a list or the section label alone). */
export const classOf = (f: FeeItemInput): ToleranceClass => deriveToleranceClass(f);
/** Step (2) of the agent design: is this an increase in a class that matters? Zero → every increase; ten_percent → aggregate test; unlimited → best-information review; decreases never need a revised LE for good faith (rule 8). */
export function classifyFeeChange(item: FeeItemInput & { readonly tolerance_class?: ToleranceClass }, revised: FeeItemInput | Cents): FeeChangeClassification {
  const after: FeeItemInput = typeof revised === "bigint" ? { ...item, amount_cents: revised } : revised;
  const class_before = item.tolerance_class ?? classOf(item), class_after = classOf(after);
  const delta_cents = after.amount_cents - item.amount_cents;
  const direction = delta_cents > 0n ? "increase" : delta_cents < 0n ? "decrease" : "none";
  const matters = direction === "increase" && class_after !== "unlimited";
  const why = direction !== "increase" ? "a decrease or no change never requires a revised LE for good faith (§1026.19(e)(3)(i); rule 8)"
    : class_after === "zero" ? "zero-tolerance item: any increase over the baseline is an excess unless a valid changed circumstance resets it (§1026.19(e)(3)(i))"
    : class_after === "ten_percent" ? "ten-percent item: counts toward the aggregate; a reset needs the bucket to rise by more than 10 % (§1026.19(e)(3)(ii), (iv)(A))"
    : "best-information item: judged on the information reasonably available when estimated (§1026.19(e)(3)(iii))";
  return { fee_code: item.fee_code, class_before, class_after, direction, delta_cents, matters, why };
}
/** `fee.baseline.set` (21.2) → the baseline rows this process tests against. */
export function baselineFromEvent(e: DomainEvent, at?: string): BaselineItem[] {
  const p = e.payload as { disclosure_id?: string; items?: readonly { fee_code: string; le_section: LeSection; tolerance_class: ToleranceClass; baseline_amount_cents: string; estimate_source?: string; estimate_source_ref?: string; description?: string; mismo_fee_type?: string; paid_by?: PaidBy; estimated_at?: string }[] };
  if (!Array.isArray(p.items) || !p.items.length) throw new RangeError("fee.baseline.set carries no items");
  return p.items.map((it) => ({ fee_code: it.fee_code, description: it.description ?? it.fee_code, le_section: it.le_section, mismo_fee_type: it.mismo_fee_type ?? it.fee_code, tolerance_class: it.tolerance_class, baseline_amount_cents: BigInt(it.baseline_amount_cents), current_amount_cents: BigInt(it.baseline_amount_cents),
    baseline_disclosure_id: String(p.disclosure_id ?? ""), baseline_set_at: at ?? e.occurredAt, baseline_reset_cc_id: null, paid_by: it.paid_by ?? "borrower", estimate_source: it.estimate_source ?? "fee_schedule", estimate_source_ref: it.estimate_source_ref ?? "", estimated_at: plainDate((it.estimated_at ?? e.occurredAt).slice(0, 10)), history: [] }));
}
export const baselineFromFees = (fees: readonly FeeItem[], disclosureId: string, at: string): BaselineItem[] => fees.map((f) => ({ fee_code: f.fee_code, description: f.description, le_section: f.le_section, mismo_fee_type: f.mismo_fee_type, tolerance_class: f.tolerance_class, baseline_amount_cents: f.amount_cents, current_amount_cents: f.amount_cents, baseline_disclosure_id: disclosureId, baseline_set_at: at, baseline_reset_cc_id: null, paid_by: "borrower", estimate_source: f.estimate_source, estimate_source_ref: f.estimate_source_ref, estimated_at: f.estimated_at, history: [] }));

// ============================================================ rules 3 & 5: the 10 % arithmetic (open question 1: floor the limit, ceil the threshold)
/** `limit_cents = floor(baseline_sum × 110 / 100)` — 186,500 → 205,150; 186,505 → 205,155 (floor of 205,155.5). */
export function tenPercentLimitCents(baselineSum: Cents): Cents { if (baselineSum < 0n) throw new RangeError("bucket baseline cannot be negative"); return (baselineSum * 110n) / 100n; }
/** `threshold_cents = ceil(baseline_sum × 10 / 100)` — "more than 10 percent" strict at whole cents: 186,500 → 18,650; 186,505 → 18,651 (ceil of 18,650.5). */
export function resetThresholdCents(baselineSum: Cents): Cents { if (baselineSum < 0n) throw new RangeError("bucket baseline cannot be negative"); const n = baselineSum * 10n; return n % 100n === 0n ? n / 100n : n / 100n + 1n; }
/** Consumer-paid ten-percent items (seller-paid items are outside the consumer's sums — edge case). */
export const bucketOf = (items: readonly BaselineItem[]): BaselineItem[] => items.filter((f) => f.tolerance_class === "ten_percent" && f.paid_by === "borrower");
export const bucketBaselineSum = (items: readonly BaselineItem[]): Cents => bucketOf(items).reduce((a, f) => a + f.baseline_amount_cents, 0n);
export interface RevisedAmount { readonly fee_code: string; readonly amount_cents: Cents; /** a fee not on the baseline LE: its class from its facts (rule 1) */ readonly item?: FeeItemInput; }
/** Rule 5(iv): `increase = revised_bucket_sum − bucket_baseline_sum`, `exceeds = increase > threshold`; new bucket items enter at baseline 0. */
export function bucketThresholdTest(items: readonly BaselineItem[], revised: readonly RevisedAmount[]): ThresholdTest {
  const bucket = bucketOf(items); const byCode = new Map(revised.map((r) => [r.fee_code, r] as const));
  const bucket_baseline_cents = bucket.reduce((a, f) => a + f.baseline_amount_cents, 0n);
  let bucket_revised_cents = bucket.reduce((a, f) => a + (byCode.get(f.fee_code)?.amount_cents ?? f.current_amount_cents), 0n);
  const names = bucket.map((f) => f.fee_code);
  for (const r of revised) if (!bucket.some((f) => f.fee_code === r.fee_code) && r.item && classOf(r.item) === "ten_percent") { bucket_revised_cents += r.amount_cents; names.push(r.fee_code); }
  const increase_cents = bucket_revised_cents - bucket_baseline_cents; const threshold_cents = resetThresholdCents(bucket_baseline_cents);
  return { bucket_baseline_cents, bucket_revised_cents, increase_cents, threshold_cents, exceeds: increase_cents > threshold_cents, items: names };
}

// ============================================================ rule 5: changed-circumstance validity
/** Causes that are never a changed circumstance (AI guardrails): the creditor's/SM's own estimation error, a vendor's general price increase, a fee the agent forgot to disclose. */
export const NOT_A_CHANGED_CIRCUMSTANCE = /rate[- ]card|price[- ]list|general (?:price|fee|rate) increase|across[- ]the[- ]board|vendor[- ]wide|market[- ]wide|(?:our|creditor'?s?|sm'?s?|lender'?s?) (?:own )?(?:estimat\w*|error|mistake|oversight)|estimation error|forgot|forgotten|omitted|overlooked|left off/i;
export interface CcEvaluationInput {
  readonly basis: Basis; readonly narrative: string; readonly evidence_document_ids: readonly string[]; readonly information_received_at: string;
  readonly revised: readonly RevisedAmount[]; /** the agent's structured finding for (A)/(B): is the cause specific to this consumer or transaction? (the narrative screen applies either way) */ readonly transaction_specific?: boolean | null;
}
export interface CcEvaluation { readonly valid: boolean; readonly invalid_reason: string | null; readonly kind: CcKind; readonly direction: "increase" | "decrease" | "none" | "reprice"; readonly threshold_test: ThresholdTest | null; readonly zero_codes: readonly string[]; readonly bucket_codes: readonly string[]; readonly unlimited_codes: readonly string[]; readonly reset_scope: "none" | "zero_items" | "zero_and_bucket" | "bucket" | "all"; readonly reflected_if_invalid: ReflectedOn; }
/** (i) basis ∈ (A)–(F); (ii) receipt evidence; (iii) (A)/(B) need a transaction-/consumer-specific fact; (iv) bucket items reset only when `increase > threshold`; decreases never qualify (rule 8). */
export function evaluateChangedCircumstance(items: readonly BaselineItem[], i: CcEvaluationInput): CcEvaluation {
  if (!BASES.includes(i.basis)) throw new RangeError(`basis ${JSON.stringify(i.basis)} is not one of ${BASES.join("/")} (§1026.19(e)(3)(iv))`);
  nonEmpty(i.narrative, "narrative"); isoOrThrow(i.information_received_at, "information_received_at");
  const kind = KIND_BY_BASIS[i.basis];
  const byCode = new Map(items.map((f) => [f.fee_code, f] as const));
  const classFor = (r: RevisedAmount): ToleranceClass | null => byCode.get(r.fee_code)?.tolerance_class ?? (r.item ? classOf(r.item) : null);
  const zero_codes = i.revised.filter((r) => classFor(r) === "zero").map((r) => r.fee_code);
  const bucket_codes = i.revised.filter((r) => classFor(r) === "ten_percent").map((r) => r.fee_code);
  const unlimited_codes = i.revised.filter((r) => classFor(r) === "unlimited").map((r) => r.fee_code);
  const invalid = (reason: string, reflected: ReflectedOn = "none_invalid", threshold: ThresholdTest | null = null, direction: CcEvaluation["direction"] = "increase"): CcEvaluation => ({ valid: false, invalid_reason: reason, kind, direction, threshold_test: threshold, zero_codes, bucket_codes, unlimited_codes, reset_scope: "none", reflected_if_invalid: reflected });
  if (i.basis === "E") return { valid: i.evidence_document_ids.length > 0, invalid_reason: i.evidence_document_ids.length ? null : "basis (E) needs the intent evidence (date and time of the indication) on file", kind, direction: "reprice", threshold_test: null, zero_codes, bucket_codes, unlimited_codes, reset_scope: i.evidence_document_ids.length ? "all" : "none", reflected_if_invalid: "none_invalid" };
  for (const r of i.revised) if (classFor(r) === null) throw new RangeError(`${r.fee_code} is not on the baseline LE and carries no fee facts to classify it (rule 1)`);
  if (!i.revised.length) throw new RangeError("a changed circumstance names at least one affected fee (affected_fee_item_ids)");
  const deltas = i.revised.map((r) => r.amount_cents - (byCode.get(r.fee_code)?.baseline_amount_cents ?? 0n));
  if (!deltas.some((d) => d > 0n)) return invalid("no estimated charge increases — a decrease never requires a revised LE for good-faith purposes (§1026.19(e)(3)(i); rule 8); the CD shows the lower actual", "none_decrease", null, deltas.some((d) => d < 0n) ? "decrease" : "none");
  if (!i.evidence_document_ids.length) return invalid("no evidence: `information_received_at` must be evidenced by the vendor document, quote or borrower statement (rule 5(ii))");
  if (NOT_A_CHANGED_CIRCUMSTANCE.test(i.narrative)) return invalid(`the narrative describes the creditor's own estimation error, a vendor's general price increase or an omitted fee — not "information specific to the consumer or transaction" (§1026.19(e)(3)(iv)(A); rule 5(iii)): "${i.narrative}"`);
  if ((i.basis === "A1" || i.basis === "A2" || i.basis === "A3" || i.basis === "B") && i.transaction_specific === false) return invalid("basis (A)/(B) requires a fact specific to this consumer or transaction (rule 5(iii)); the agent recorded transaction_specific=false");
  const threshold = bucket_codes.length ? bucketThresholdTest(items, i.revised) : null;
  const bucketResets = threshold !== null && threshold.exceeds;
  if (!zero_codes.length && !unlimited_codes.length && threshold && !threshold.exceeds)
    return invalid(`ten-percent bucket rises ${S(threshold.increase_cents)} cents, not more than the ${S(threshold.threshold_cents)}-cent threshold (10 % of ${S(threshold.bucket_baseline_cents)}) — no reset permitted even for a transaction-specific change (§1026.19(e)(3)(iv)(A): "increase by more than 10 percent")`, "none_invalid", threshold);
  const reset_scope: CcEvaluation["reset_scope"] = zero_codes.length && bucketResets ? "zero_and_bucket" : zero_codes.length ? "zero_items" : bucketResets ? "bucket" : "none";
  return { valid: true, invalid_reason: null, kind, direction: "increase", threshold_test: threshold, zero_codes, bucket_codes, unlimited_codes, reset_scope, reflected_if_invalid: "none_invalid" };
}

// ============================================================ rule 7: timing
export const endOfDayIso = (d: PlainDate, tz: string): string => toIso(zonedEpochMs(d, "23:59", tz));
/** `revised_le_due = addBusinessDays(information_received_at::date, 3, 'creditor')`, end of day in the creditor's zone — Oct 20 14:30 MST → Fri Oct 23, 2026 23:59 MST. */
export function revisedLeDueAt(informationReceivedAt: string, spec: CreditorCalendarSpec = PHOENIX_CREDITOR): { information_received_on: PlainDate; due_on: PlainDate; due_at: string } {
  isoOrThrow(informationReceivedAt, "information_received_at");
  const information_received_on = civilDate(informationReceivedAt, spec.time_zone);
  const due_on = addBusinessDays(information_received_on, 3, creditorCalendarFrom(spec));
  return { information_received_on, due_on, due_at: endOfDayIso(due_on, spec.time_zone) };
}
/** `latest_receipt = subtractBusinessDays(consummation_date, 4, 'regz_specific')` — Fri Nov 6 → Mon Nov 2 (Nov 5, 4, 3, 2; Sunday Nov 1 excluded); Wed Nov 18 → Fri Nov 13 (Tue 17, Mon 16, Sat 14, Fri 13). */
export const latestRevisedLeReceipt = (consummationOn: PlainDate): PlainDate => addBusinessDays(consummationOn, -4, regzSpecific);
/** The consumer must receive the revised LE not later than four specific business days before consummation: earliest consummation = receipt + 4 SBD. */
export const earliestConsummationAfterRevisedLe = (effectiveReceiptDate: PlainDate): PlainDate => addBusinessDays(effectiveReceiptDate, 4, regzSpecific);
export interface FourDayInput {
  readonly consummation_on: PlainDate | null; readonly cd_delivered_on: PlainDate | null; readonly today: PlainDate;
  /** the planned delivery: channel + date, and receipt evidence when the borrower already viewed/acknowledged it */
  readonly channel?: DeliveryChannel | null; readonly issue_on?: PlainDate | null; readonly receipt_evidence_on?: PlainDate | null;
}
/** §1026.19(e)(4)(ii) both sentences: no revised LE on or after the CD date (→ corrected CD); receipt (actual evidence or the 3-SBD presumption) not later than 4 SBD before consummation (else the CD carries the revised estimate). */
export function fourDayRule(i: FourDayInput): FourDayCheck {
  const latest_receipt = i.consummation_on ? latestRevisedLeReceipt(i.consummation_on) : null;
  if (i.cd_delivered_on && i.today >= i.cd_delivered_on) return { latest_receipt, cd_delivered_on: i.cd_delivered_on, effective_receipt_date: null, permitted: false, route: "corrected_cd", reason: `§1026.19(e)(4)(ii): the Closing Disclosure was provided ${i.cd_delivered_on} — no revised Loan Estimate on or after that date; the revised estimate rides on the CD or a corrected CD (25.2)` };
  const issue_on = i.issue_on ?? i.today;
  const effective_receipt_date = i.receipt_evidence_on ?? (i.channel && isInPerson(i.channel) ? issue_on : deemedReceiptDate(issue_on));
  if (latest_receipt && effective_receipt_date > latest_receipt) return { latest_receipt, cd_delivered_on: i.cd_delivered_on, effective_receipt_date, permitted: false, route: "cd", reason: `§1026.19(e)(4)(ii): a revised LE ${i.channel ?? "delivered"} ${issue_on} is received ${effective_receipt_date}${i.receipt_evidence_on ? "" : " (three specific business days after delivery or mailing)"}, after the latest receipt ${latest_receipt} for consummation ${i.consummation_on} — the revised estimate goes on the CD` };
  return { latest_receipt, cd_delivered_on: i.cd_delivered_on, effective_receipt_date, permitted: true, route: "le", reason: latest_receipt ? `receipt ${effective_receipt_date} is on or before the latest receipt ${latest_receipt} (consummation ${i.consummation_on} − 4 specific business days)` : "no consummation date scheduled yet; the four-day limit is re-checked when one is" };
}
/** §1026.19(f)(2)(v): refund and corrected CD no later than 60 calendar days after consummation — Fri Nov 6, 2026 → Tue Jan 5, 2027. */
export const refundDueOn = (consummationOn: PlainDate): PlainDate => addDays(consummationOn, 60);

// ============================================================ rules 2–4, 9: the tolerance test
export interface ActualItem { readonly fee_code: string; readonly amount_cents: Cents; readonly item?: FeeItemInput; readonly paid_by?: PaidBy; readonly estimate_source?: string; readonly estimated_at?: PlainDate; }
export interface ZeroResult { readonly fee_code: string; readonly baseline_cents: Cents; readonly actual_cents: Cents; readonly excess_cents: Cents; }
export interface TenPctResult { readonly items: readonly { fee_code: string; baseline_cents: Cents; actual_cents: Cents }[]; readonly baseline_sum_cents: Cents; readonly actual_sum_cents: Cents; readonly limit_cents: Cents; readonly excess_cents: Cents; }
export interface UnlimitedResult { readonly fee_code: string; readonly baseline_cents: Cents; readonly actual_cents: Cents; readonly estimate_source: string; readonly estimated_at: PlainDate; readonly reasonableness: "consistent" | "stale_source" | "unsupported"; }
export interface ToleranceTestRow {
  readonly test_id: string; readonly application_id: string; readonly stage: Stage; readonly run_at: string; readonly run_on: PlainDate; readonly baseline_snapshot_id: string; readonly comparison_disclosure_id: string;
  readonly zero_results: readonly ZeroResult[]; readonly lender_credit_result: { baseline_cents: Cents; actual_cents: Cents; shortfall_cents: Cents }; readonly ten_pct_result: TenPctResult; readonly unlimited_results: readonly UnlimitedResult[];
  readonly total_excess_cents: Cents; status: TestStatus; readonly cure_route: "none" | "lender_credit_at_closing" | "refund_post_consummation"; compliance_test_run_id: string | null; readonly engine_version: string; readonly review_threshold_cents: Cents;
}
/** Rule 2: `shortfall = max(0, baseline_credit − actual_credit)` in absolute terms — both SM-borne and rate-dependent credits count; −$2,617 baseline vs −$2,417 on the CD → 20,000 cents. */
export function lenderCreditShortfall(baselineCreditCents: Cents, actualCreditCents: Cents): Cents {
  if (baselineCreditCents > 0n || actualCreditCents > 0n) throw new RangeError("lender credits are stated as non-positive cents (section J)");
  const s = actualCreditCents - baselineCreditCents; return s > 0n ? s : 0n;
}
export interface ToleranceTestInput { readonly application_id: string; readonly stage: Stage; readonly run_at: string; readonly comparison_disclosure_id: string; readonly baseline_snapshot_id?: string; readonly actuals: readonly ActualItem[]; readonly lender_credit_actual_cents: Cents; readonly lender_credit_baseline_cents?: Cents; readonly review_threshold_cents?: Cents; readonly time_zone?: string; }
/** The pure engine 25.1/25.2/28.x call: zero test, lender-credit test, 10 % aggregate, best-information review; `cure_cents = Σ zero excess + shortfall + ten_pct excess` (rule 9). */
export function toleranceTest(items: readonly BaselineItem[], i: ToleranceTestInput): ToleranceTestRow {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.comparison_disclosure_id, "comparison_disclosure_id"); isoOrThrow(i.run_at, "run_at");
  if (!STAGES.includes(i.stage)) throw new RangeError(`stage ${JSON.stringify(i.stage)} is not one of ${STAGES.join("/")}`);
  const consumer = items.filter((f) => f.paid_by === "borrower" && f.le_section !== "J_lender_credit");
  const actualOf = new Map<string, ActualItem>(); for (const a of i.actuals) { if (typeof a.amount_cents !== "bigint") throw new RangeError(`${a.fee_code}: amount_cents must be bigint cents`); if ((a.paid_by ?? "borrower") === "borrower") actualOf.set(a.fee_code, a); }
  const known = new Set(consumer.map((f) => f.fee_code));
  const extra = [...actualOf.values()].filter((a) => !known.has(a.fee_code) && a.item);
  const cls = (a: ActualItem): ToleranceClass => classOf(a.item!);
  const zero_results: ZeroResult[] = [...consumer.filter((f) => f.tolerance_class === "zero").map((f) => { const actual = actualOf.get(f.fee_code)?.amount_cents ?? 0n; const ex = actual - f.baseline_amount_cents; return { fee_code: f.fee_code, baseline_cents: f.baseline_amount_cents, actual_cents: actual, excess_cents: ex > 0n ? ex : 0n }; }),
    ...extra.filter((a) => cls(a) === "zero").map((a) => ({ fee_code: a.fee_code, baseline_cents: 0n, actual_cents: a.amount_cents, excess_cents: a.amount_cents }))];
  const bucketItems = [...bucketOf(consumer).map((f) => ({ fee_code: f.fee_code, baseline_cents: f.baseline_amount_cents, actual_cents: actualOf.get(f.fee_code)?.amount_cents ?? 0n })), ...extra.filter((a) => cls(a) === "ten_percent").map((a) => ({ fee_code: a.fee_code, baseline_cents: 0n, actual_cents: a.amount_cents }))];
  const baseline_sum_cents = bucketItems.reduce((s, x) => s + x.baseline_cents, 0n), actual_sum_cents = bucketItems.reduce((s, x) => s + x.actual_cents, 0n), limit_cents = tenPercentLimitCents(baseline_sum_cents);
  const tenExcess = actual_sum_cents - limit_cents;
  const ten_pct_result: TenPctResult = { items: bucketItems, baseline_sum_cents, actual_sum_cents, limit_cents, excess_cents: tenExcess > 0n ? tenExcess : 0n };
  const baselineCredit = i.lender_credit_baseline_cents ?? items.filter((f) => f.le_section === "J_lender_credit").reduce((s, f) => s + f.baseline_amount_cents, 0n);
  const lender_credit_result = { baseline_cents: baselineCredit, actual_cents: i.lender_credit_actual_cents, shortfall_cents: lenderCreditShortfall(baselineCredit, i.lender_credit_actual_cents) };
  const runOn = plainDate(i.run_at.slice(0, 10));
  const unlimited_results: UnlimitedResult[] = consumer.filter((f) => f.tolerance_class === "unlimited").map((f) => { const a = actualOf.get(f.fee_code); const stale = addDays(f.estimated_at, FEE_TABLE_MAX_AGE_DAYS) < plainDate(f.baseline_set_at.slice(0, 10)); return { fee_code: f.fee_code, baseline_cents: f.baseline_amount_cents, actual_cents: a?.amount_cents ?? 0n, estimate_source: f.estimate_source, estimated_at: f.estimated_at, reasonableness: stale ? "stale_source" : f.estimate_source_ref ? "consistent" : "unsupported" }; });
  const total_excess_cents = zero_results.reduce((s, z) => s + z.excess_cents, 0n) + lender_credit_result.shortfall_cents + ten_pct_result.excess_cents;
  const post = POST_CONSUMMATION_STAGES.includes(i.stage); const threshold = i.review_threshold_cents ?? CURE_REVIEW_THRESHOLD_CENTS;
  const cure_route = total_excess_cents === 0n ? "none" : post ? "refund_post_consummation" : "lender_credit_at_closing";
  const status: TestStatus = total_excess_cents === 0n ? "pass" : total_excess_cents > threshold ? "escalated" : post ? "refund_required" : "cure_required";
  return { test_id: randomUUID(), application_id: i.application_id, stage: i.stage, run_at: i.run_at, run_on: i.time_zone ? civilDate(i.run_at, i.time_zone) : runOn, baseline_snapshot_id: i.baseline_snapshot_id ?? `baseline:${items.map((f) => `${f.fee_code}=${S(f.baseline_amount_cents)}`).join(",")}`, comparison_disclosure_id: i.comparison_disclosure_id,
    zero_results, lender_credit_result, ten_pct_result, unlimited_results, total_excess_cents, status, cure_route, compliance_test_run_id: null, engine_version: ENGINE_VERSION, review_threshold_cents: threshold };
}
/** §1026.38(h)(3) statement 25.2 prints next to the lender credit on the CD. */
export const cureStatement = (cents: Cents): string => `Includes ${formatCents(cents)} credit for increase in closing costs above legal limit`;

// ============================================================ ledger (baseline §5 accounts added here)
export const TOLERANCE_CURE_EXPENSE: AccountRef = { scope: "corporate", account: "tolerance_cure_expense" };
export const BORROWER_REFUNDS_PAYABLE: AccountRef = { scope: "corporate", account: "borrower_refunds_payable" };
export const CORPORATE_CASH: AccountRef = { scope: "corporate", account: "corporate_cash" };
export type FundedBy = "sm" | "partner";
export interface ToleranceCureRow { readonly cure_id: string; readonly application_id: string; readonly test_id: string; readonly amount_cents: Cents; readonly method: "lender_credit_at_closing" | "refund_post_consummation"; readonly funded_by: FundedBy; readonly posted_at: string; cd_disclosure_id: string | null; refund_instrument: "ach" | "check" | null; refund_sent_at: string | null; refund_sent_on: PlainDate | null; readonly refund_due_on: PlainDate | null; readonly ledger_entry_id: string; refund_ledger_entry_id: string | null; corrected_cd_delivered_at: string | null; readonly cd_statement: string; }

// ============================================================ revised LE rows
export type RevisedLeStatus = "rendered" | "delivered" | "mailed" | "received" | "deemed_received" | "refused";
export interface RevisedLeRow {
  readonly application_id: string; readonly disclosure_id: string; readonly kind: "le"; readonly le_version: number; readonly basis: "revised"; readonly revision_reason_cc_ids: readonly string[]; readonly reason: CcKind; readonly reasons: readonly CcKind[];
  status: RevisedLeStatus; readonly rendered_at: string; readonly data_hash: string; readonly template_version: string; readonly notice_code: "NTC_REGZ_1026_37_LE_REVISED"; readonly fees: readonly FeeItem[]; readonly totals: SectionTotals; readonly calcs: LeCalcs; readonly apr: AprCalculation;
  readonly rate_lock_block: { locked: boolean; lock_expires_at: string | null } | null; readonly costs_expire_at: string | null; readonly what_changed: readonly string[]; readonly h24: Record<string, unknown>;
  delivery_channel: DeliveryChannel | null; delivered_at: string | null; mailed_at: string | null; issued_on: PlainDate | null; esign_consent_id: string | null; mailing_proof_id: string | null;
  deemed_receipt_date: PlainDate | null; received_at: string | null; receipt_evidence: ReceiptEvidence | null; effective_receipt_date: PlainDate | null; latest_receipt_on: PlainDate | null; earliest_consummation_date: PlainDate | null; gate_opened_at: string | null; late: boolean;
}
export class ToleranceRefused extends Error { readonly code: string; readonly citation: string; constructor(code: string, citation: string, msg: string) { super(`${code}: ${msg}`); this.name = "ToleranceRefused"; this.code = code; this.citation = citation; } }

// ============================================================ the service
interface EscalationOpener { open(input: { kind: "sev1" | "sev2" | "officer"; applicationId?: string; severity?: string; ownerRole?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
export interface ToleranceServiceDeps { readonly events: EventStore; readonly clock: Clock; readonly ledger?: Ledger; readonly escalations?: EscalationOpener; readonly calendar?: CreditorCalendarSpec; readonly review_threshold_cents?: Cents; }
interface AppState {
  items: BaselineItem[]; lender_credit_baseline_cents: Cents; baseline_disclosure_id: string | null; le_version: number; ccs: Map<string, ChangedCircumstanceRow>; revised: Map<string, RevisedLeRow>;
  cd_delivered_on: PlainDate | null; cd_delivered_at: string | null; consummation_on: PlainDate | null; consummation_at: string | null; costs_expire_at: string | null; intent_at: string | null; lock: { locked: boolean; lock_expires_at: string | null; points_cents: Cents; lender_credit_cents: Cents } | null;
  tests: ToleranceTestRow[]; cures: ToleranceCureRow[]; incidents: { incident_id: string; code: string; at: string; cc_id: string | null }[];
}
export interface RecordCcInput extends CcEvaluationInput { readonly application_id: string; readonly source_event_id?: string | null; readonly recorded_by?: string; readonly consummation_on?: PlainDate | null; }
export interface RevisedLeInput extends Omit<LeRenderInput, "disclosure_id"> { readonly disclosure_id: string; readonly cc_ids: readonly string[]; readonly costs_expire_at?: string | null; }

/**
 * Per-application state over the event store: the baseline in force, every changed circumstance, every revised LE
 * version, the tests, cures and refunds. Subscribes to the events other processes emit (fee.baseline.set, 21.4's lock
 * and changed-circumstance events, 30.3's escrow-waiver decision, 25.2's CD events, 26.x's consummation).
 */
export class ToleranceService {
  private readonly events: EventStore; private readonly clock: Clock; private readonly ledger: Ledger | null; private readonly esc: EscalationOpener; readonly calendar: CreditorCalendarSpec; private readonly threshold: Cents;
  private readonly apps = new Map<string, AppState>();
  constructor(deps: ToleranceServiceDeps) {
    this.events = deps.events; this.clock = deps.clock; this.ledger = deps.ledger ?? null; this.calendar = deps.calendar ?? PHOENIX_CREDITOR; this.threshold = deps.review_threshold_cents ?? CURE_REVIEW_THRESHOLD_CENTS;
    this.esc = deps.escalations ?? { open: (input, by) => { const id = `ESC-${this.events.all().length + 1}`; this.events.append({ type: "escalation.created", applicationId: input.applicationId ?? "", actor: by, payload: { escalation_id: id, kind: input.kind, owner_role: input.ownerRole ?? input.kind, severity: input.severity ?? null, ...(input.payload ?? {}) } }); return { id }; } };
    this.events.subscribe("*", (e) => this.onEvent(e));
  }
  private append(type: string, applicationId: string, payload: Record<string, unknown>, at?: string, actor: Actor = AGENT): DomainEvent {
    return this.events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor, payload: { application_id: applicationId, ...payload }, ...(at ? { occurredAt: at } : {}) });
  }
  private appId(e: DomainEvent): string | null { return e.applicationId ?? ((e.payload as { application_id?: string }).application_id ?? null); }
  private state(applicationId: string): AppState {
    nonEmpty(applicationId, "application_id");
    let s = this.apps.get(applicationId);
    if (!s) { s = { items: [], lender_credit_baseline_cents: 0n, baseline_disclosure_id: null, le_version: 1, ccs: new Map(), revised: new Map(), cd_delivered_on: null, cd_delivered_at: null, consummation_on: null, consummation_at: null, costs_expire_at: null, intent_at: null, lock: null, tests: [], cures: [], incidents: [] }; this.apps.set(applicationId, s); }
    return s;
  }
  // ---- read side
  baseline(applicationId: string): readonly BaselineItem[] { return this.state(applicationId).items; }
  baselineOf(applicationId: string, feeCode: string): BaselineItem { const f = this.state(applicationId).items.find((x) => x.fee_code === feeCode); if (!f) throw new RangeError(`no fee ${feeCode} on the baseline of ${applicationId}`); return f; }
  cc(ccId: string): ChangedCircumstanceRow { for (const s of this.apps.values()) { const r = s.ccs.get(ccId); if (r) return r; } throw new RangeError(`no changed circumstance ${ccId}`); }
  revisedLe(disclosureId: string): RevisedLeRow { for (const s of this.apps.values()) { const r = s.revised.get(disclosureId); if (r) return r; } throw new RangeError(`no revised LE ${disclosureId}`); }
  test(testId: string): ToleranceTestRow { for (const s of this.apps.values()) { const t = s.tests.find((x) => x.test_id === testId); if (t) return t; } throw new RangeError(`no tolerance test ${testId}`); }
  cure(cureId: string): ToleranceCureRow { for (const s of this.apps.values()) { const c = s.cures.find((x) => x.cure_id === cureId); if (c) return c; } throw new RangeError(`no tolerance cure ${cureId}`); }
  tests(applicationId: string): readonly ToleranceTestRow[] { return this.state(applicationId).tests; }
  cures(applicationId: string): readonly ToleranceCureRow[] { return this.state(applicationId).cures; }
  incidents(applicationId: string) { return this.state(applicationId).incidents; }
  facts(applicationId: string): { cd_delivered_on: PlainDate | null; consummation_on: PlainDate | null; le_version: number; costs_expire_at: string | null; intent_at: string | null } { const s = this.state(applicationId); return { cd_delivered_on: s.cd_delivered_on, consummation_on: s.consummation_on, le_version: s.le_version, costs_expire_at: s.costs_expire_at, intent_at: s.intent_at }; }
  scheduleConsummation(applicationId: string, on: PlainDate | null): void { this.state(applicationId).consummation_on = on; }

  // ---- consumed events
  private onEvent(e: DomainEvent): void {
    const app = this.appId(e); if (!app) return;
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "fee.baseline.set": this.setBaseline(app, e); return;
      case "disclosure.le.issued": if (typeof p.closing_costs_expire_at === "string") this.state(app).costs_expire_at = p.closing_costs_expire_at; return;
      case "intent.to_proceed.received": if (p.valid !== false) this.state(app).intent_at = typeof p.received_at === "string" ? p.received_at : e.occurredAt; return;
      case "lock.executed": this.state(app).lock = { locked: true, lock_expires_at: typeof p.expires_at === "string" ? p.expires_at : null, points_cents: BigInt(String(p.points_cents ?? "0")), lender_credit_cents: BigInt(String(p.lender_credit_cents ?? "0")) }; return;
      case "changed_circumstance.recorded": if (e.actor.id !== AGENT.id || !this.state(app).ccs.has(String(p.cc_id))) this.adoptExternalCc(app, e); return;
      case "escrow.waiver.decided": if (p.origin === "origination" && p.le_revision && typeof p.le_revision === "object") this.onEscrowWaiver(app, e); return;
      case "disclosure.cd.delivered": case "disclosure.cd.corrected": this.onCd(app, e); return;
      case "closing.consummated": { const s = this.state(app); s.consummation_at = typeof p.consummation_at === "string" ? p.consummation_at : e.occurredAt; s.consummation_on = typeof p.consummation_on === "string" ? plainDate(p.consummation_on) : civilDate(s.consummation_at, this.calendar.time_zone); return; }
      default: return;
    }
  }
  /** `fee.baseline.set` (21.2): the LE v1 classes and amounts become the good-faith baseline; a later `fee.baseline.set` for a higher version (basis E re-issue) replaces it. */
  private setBaseline(app: string, e: DomainEvent): void {
    const s = this.state(app); const p = e.payload as { disclosure_id?: string; le_version?: number; lender_credit_baseline_cents?: string };
    if (s.items.length && Number(p.le_version ?? 1) <= 1 && s.baseline_disclosure_id) return;   // the initial baseline is set once; revisions arrive through changed circumstances
    s.items = baselineFromEvent(e); s.baseline_disclosure_id = String(p.disclosure_id ?? ""); s.lender_credit_baseline_cents = p.lender_credit_baseline_cents !== undefined ? BigInt(p.lender_credit_baseline_cents) : s.items.filter((f) => f.le_section === "J_lender_credit").reduce((a, f) => a + f.baseline_amount_cents, 0n);
    if (Number(p.le_version ?? 1) > s.le_version) s.le_version = Number(p.le_version);
  }
  /** 21.4's `changed_circumstances{kind='rate_lock'|'borrower_request'}` rows (basis D/C) join this process's register so the revised LE that carries them is the one satisfying 21.4's clock; basis D resets the rate-dependent charges (points, credits — rule 6). */
  private adoptExternalCc(app: string, e: DomainEvent): void {
    const s = this.state(app); const p = e.payload as { cc_id?: string; kind?: CcKind; basis?: Basis; discovered_at?: string; revised_le_due_at?: string; revised_le_due_on?: string; reflected_on?: string; narrative?: string; affected_amount_cents?: string; lock_id?: string };
    const cc_id = String(p.cc_id ?? e.id); if (s.ccs.has(cc_id)) return;
    const basis: Basis = p.basis ?? (p.kind === "rate_lock" ? "D" : "C"); const at = p.discovered_at ?? e.occurredAt;
    const due = p.revised_le_due_at ? { information_received_on: civilDate(at, this.calendar.time_zone), due_on: plainDate(String(p.revised_le_due_on ?? p.revised_le_due_at.slice(0, 10))), due_at: p.revised_le_due_at } : revisedLeDueAt(at, this.calendar);
    const reflected_on: ReflectedOn = p.reflected_on === "cd" || p.reflected_on === "corrected_cd" ? p.reflected_on : "le";
    const affected: string[] = []; const revised: Record<string, Cents> = {};
    if (basis === "D" && s.lock) { for (const f of s.items) if (f.le_section === "A_origination" && /point|discount/i.test(f.mismo_fee_type + f.fee_code)) { affected.push(f.fee_code); revised[f.fee_code] = s.lock.points_cents; } }
    s.ccs.set(cc_id, { cc_id, application_id: app, kind: p.kind ?? KIND_BY_BASIS[basis], basis, information_received_at: at, information_received_on: due.information_received_on, discovered_at: at, source_event_id: e.id, narrative: p.narrative ?? `${p.kind ?? basis} recorded by 21.4`, evidence_document_ids: p.lock_id ? [`lock:${p.lock_id}`] : [],
      affected_fee_codes: affected, ten_pct_threshold_test: null, valid: true, invalid_reason: null, revised_le_due_at: due.due_at, revised_le_due_on: due.due_on, revised_le_disclosure_id: null, reflected_on, baseline_reset: false, status: reflected_on === "le" ? "revised_le_scheduled" : "evaluated_valid", recorded_by: `${e.actor.kind}:${e.actor.id}`, reviewer_id: null, four_day_check: null, external: true, revised_amounts: revised, breach: null });
    if (affected.length) this.resetBaseline(cc_id, at);
  }
  /** 30.3's approved escrow waiver at origination: a borrower-requested change (basis C) — the escrow waiver fee is a new creditor charge (zero); the initial escrow lines fall to zero (unlimited, a decrease). */
  private onEscrowWaiver(app: string, e: DomainEvent): ChangedCircumstanceRow {
    const p = e.payload as { waiver_id?: string; le_revision: { escrow_waiver_fee_cents?: string; line_label?: string }; basis_document_id?: string; decided_on?: string };
    const fee = BigInt(String(p.le_revision.escrow_waiver_fee_cents ?? "0"));
    const s = this.state(app);
    const revised: RevisedAmount[] = [{ fee_code: "escrow_waiver_fee", amount_cents: fee, item: { fee_code: "escrow_waiver_fee", description: p.le_revision.line_label ?? "Escrow Waiver Fee", le_section: "A_origination", mismo_fee_type: "EscrowWaiverFee", amount_cents: fee, provider_source: "creditor", shoppable: false, estimate_source: "pricing_engine", estimate_source_ref: `waiver:${String(p.waiver_id ?? e.id)}`, estimated_at: civilDate(e.occurredAt, this.calendar.time_zone), finance_charge: true } },
      ...s.items.filter((f) => f.le_section === "G_initial_escrow").map((f) => ({ fee_code: f.fee_code, amount_cents: 0n }))];
    return this.recordChangedCircumstance({ application_id: app, basis: "C", narrative: `the consumer requested an escrow waiver (30.3 waiver ${String(p.waiver_id ?? e.id)}, decided ${String(p.decided_on ?? e.occurredAt.slice(0, 10))}): "the consumer requests revisions to the credit terms or the settlement that cause an estimated charge to increase" — escrow waiver fee ${formatCents(fee)}; initial escrow lines removed`,
      evidence_document_ids: [String(p.basis_document_id ?? e.id)], information_received_at: e.occurredAt, revised, source_event_id: e.id, recorded_by: "agent:disclosure" }).cc;
  }
  /** 25.2's CD events: the delivery date bars every later revised LE; a CD/corrected CD naming `cc_ids` reflects those changed circumstances (the 3-day clock's alternative satisfier). */
  private onCd(app: string, e: DomainEvent): void {
    const s = this.state(app); const p = e.payload as { issued_on?: string; delivered_at?: string; cc_ids?: readonly string[]; reason?: string; cure_id?: string; disclosure_id?: string };
    const at = p.delivered_at ?? e.occurredAt; const on = p.issued_on ? plainDate(p.issued_on) : civilDate(at, this.calendar.time_zone);
    if (e.type === "disclosure.cd.delivered" && (s.cd_delivered_on === null || on < s.cd_delivered_on)) { s.cd_delivered_on = on; s.cd_delivered_at = at; }
    const ids = Array.isArray(p.cc_ids) ? p.cc_ids : [];
    for (const id of ids) { const cc = s.ccs.get(id); if (cc && cc.status !== "revised_le_delivered" && cc.status !== "closed") { cc.status = "reflected_on_cd"; cc.reflected_on = e.type === "disclosure.cd.corrected" ? "corrected_cd" : "cd"; cc.revised_le_disclosure_id = String(p.disclosure_id ?? e.id); this.append("changed_circumstance.reflected", app, { cc_id: id, reflected_on: cc.reflected_on, disclosure_id: cc.revised_le_disclosure_id, via: e.type }, at); } }
    if (e.type === "disclosure.cd.corrected" && p.reason === "tolerance_refund") { const cure = s.cures.find((c) => c.cure_id === p.cure_id) ?? s.cures.find((c) => c.method === "refund_post_consummation" && c.corrected_cd_delivered_at === null); if (cure) { cure.corrected_cd_delivered_at = at; cure.cd_disclosure_id = String(p.disclosure_id ?? e.id); this.completeRefundIfDone(app, cure, at); } }
  }

  // ---- steps (3)–(6): record, reset, schedule, render, deliver
  /** Steps (3)–(5) of the agent design: basis + narrative + evidence → validity (rule 5) → due date (rule 7) → the four-day/CD route → reset (rule 6) → `changed_circumstance.recorded{valid=true}` (arms the 3-day clock) or `.rejected`. */
  recordChangedCircumstance(i: RecordCcInput): { cc: ChangedCircumstanceRow; event: DomainEvent; evaluation: CcEvaluation } {
    const s = this.state(i.application_id); if (i.consummation_on !== undefined) s.consummation_on = i.consummation_on;
    const evaluation = evaluateChangedCircumstance(s.items, i);
    const due = revisedLeDueAt(i.information_received_at, this.calendar);
    const today = civilDate(i.information_received_at, this.calendar.time_zone);
    const check = fourDayRule({ consummation_on: s.consummation_on, cd_delivered_on: s.cd_delivered_on, today });
    const cc_id = randomUUID(); const revised_amounts = Object.fromEntries(i.revised.map((r) => [r.fee_code, r.amount_cents]));
    const affected_fee_codes = evaluation.reset_scope === "all" ? s.items.map((f) => f.fee_code) : i.revised.map((r) => r.fee_code);
    const reflected_on: ReflectedOn = evaluation.valid ? check.route : evaluation.reflected_if_invalid;
    const cc: ChangedCircumstanceRow = { cc_id, application_id: i.application_id, kind: evaluation.kind, basis: i.basis, information_received_at: i.information_received_at, information_received_on: due.information_received_on, discovered_at: i.information_received_at, source_event_id: i.source_event_id ?? null, narrative: i.narrative, evidence_document_ids: [...i.evidence_document_ids],
      affected_fee_codes, ten_pct_threshold_test: evaluation.threshold_test, valid: evaluation.valid, invalid_reason: evaluation.invalid_reason, revised_le_due_at: evaluation.valid ? due.due_at : null, revised_le_due_on: evaluation.valid ? due.due_on : null, revised_le_disclosure_id: null, reflected_on,
      baseline_reset: false, status: evaluation.valid ? "evaluated_valid" : "evaluated_invalid", recorded_by: i.recorded_by ?? "agent:disclosure", reviewer_id: null, four_day_check: check, external: false, revised_amounts, breach: null };
    s.ccs.set(cc_id, cc);
    // the current estimate moves with or without a valid basis (the invalid increase becomes a cure candidate); history records the cause
    for (const r of i.revised) { const f = s.items.find((x) => x.fee_code === r.fee_code); if (f) { if (f.current_amount_cents !== r.amount_cents) { f.history.push({ at: i.information_received_at, from_cents: f.current_amount_cents, to_cents: r.amount_cents, cause: `${i.basis} ${evaluation.valid ? "valid" : "invalid"}: ${i.narrative.slice(0, 80)}`, cc_id, actor: cc.recorded_by }); f.current_amount_cents = r.amount_cents; } } else if (r.item) { s.items.push({ fee_code: r.fee_code, description: r.item.description, le_section: r.item.le_section, mismo_fee_type: r.item.mismo_fee_type, tolerance_class: classOf(r.item), baseline_amount_cents: 0n, current_amount_cents: r.amount_cents, baseline_disclosure_id: s.baseline_disclosure_id ?? "", baseline_set_at: i.information_received_at, baseline_reset_cc_id: null, paid_by: "borrower", estimate_source: r.item.estimate_source, estimate_source_ref: r.item.estimate_source_ref, estimated_at: r.item.estimated_at, history: [{ at: i.information_received_at, from_cents: 0n, to_cents: r.amount_cents, cause: `new fee (${i.basis}): ${i.narrative.slice(0, 80)}`, cc_id, actor: cc.recorded_by }] }); } }
    const common = { cc_id, kind: cc.kind, basis: cc.basis, valid: cc.valid, information_received_at: cc.information_received_at, information_received_on: cc.information_received_on, discovered_at: cc.discovered_at, narrative: cc.narrative, evidence_document_ids: cc.evidence_document_ids, affected_fee_codes, threshold_test: evaluation.threshold_test ? { ...evaluation.threshold_test, bucket_baseline_cents: S(evaluation.threshold_test.bucket_baseline_cents), bucket_revised_cents: S(evaluation.threshold_test.bucket_revised_cents), increase_cents: S(evaluation.threshold_test.increase_cents), threshold_cents: S(evaluation.threshold_test.threshold_cents) } : null, source_event_id: cc.source_event_id, reflected_on };
    if (!evaluation.valid) { const event = this.append("changed_circumstance.rejected", i.application_id, { ...common, invalid_reason: evaluation.invalid_reason, baseline_reset: false }, i.information_received_at); return { cc, event, evaluation }; }
    const event = this.append("changed_circumstance.recorded", i.application_id, { ...common, revised_le_due_at: cc.revised_le_due_at, revised_le_due_on: cc.revised_le_due_on, four_day_check: check, reset_scope: evaluation.reset_scope }, i.information_received_at);
    this.resetBaseline(cc_id, i.information_received_at);
    if (check.route !== "le") this.reflectOnCD(cc_id, i.information_received_at); else cc.status = "revised_le_scheduled";
    return { cc, event, evaluation };
  }
  /** Rule 6 + guardrail: never without a `changed_circumstances` row with `valid=true`, evidence and a basis; zero items → only the affected ones; bucket → the whole bucket to revised estimates when `exceeds`; basis (E) → everything; never when the bucket increase is at or below 10 %. */
  resetBaseline(ccId: string, at?: string): { reset: readonly string[]; event: DomainEvent | null } {
    const cc = this.cc(ccId); const s = this.state(cc.application_id); const when = at ?? this.clock.now();
    if (!cc.valid) throw new ToleranceRefused("NO_RESET_WITHOUT_VALID_CC", "12 CFR 1026.19(e)(3)(iv); 21.5 guardrails", `changed circumstance ${ccId} is not valid (${cc.invalid_reason ?? "evaluated_invalid"}) — the original baseline governs`);
    if (!cc.evidence_document_ids.length) throw new ToleranceRefused("NO_RESET_WITHOUT_EVIDENCE", "21.5 rule 5(ii); guardrails", `changed circumstance ${ccId} carries no evidence`);
    if (cc.baseline_reset) return { reset: [], event: null };
    const reset: string[] = [];
    const bump = (f: BaselineItem, to: Cents, cause: string) => { if (f.baseline_amount_cents === to) return; f.history.push({ at: when, from_cents: f.baseline_amount_cents, to_cents: to, cause, cc_id: ccId, actor: cc.recorded_by }); f.baseline_amount_cents = to; f.baseline_reset_cc_id = ccId; reset.push(f.fee_code); };
    if (cc.basis === "E") { for (const f of s.items) bump(f, cc.revised_amounts[f.fee_code] ?? f.current_amount_cents, "basis (E): every baseline resets to the current estimate (a new offer)"); s.lender_credit_baseline_cents = s.items.filter((f) => f.le_section === "J_lender_credit").reduce((a, f) => a + f.baseline_amount_cents, 0n); }
    else {
      const bucketReset = cc.ten_pct_threshold_test?.exceeds === true;
      for (const f of s.items) {
        const revised = cc.revised_amounts[f.fee_code];
        if (f.tolerance_class === "zero" && revised !== undefined && cc.affected_fee_codes.includes(f.fee_code)) { if (f.le_section === "J_lender_credit" && revised > f.baseline_amount_cents) throw new ToleranceRefused("NO_LENDER_CREDIT_REDUCTION", "comment 19(e)(3)(i)-5 (CFPB TRID FAQ); 21.5 guardrails", "never reduce lender credits"); bump(f, revised, `basis (${cc.basis}) reset to the revised estimate`); }
        else if (f.tolerance_class === "ten_percent" && f.paid_by === "borrower" && revised !== undefined && !bucketReset) throw new ToleranceRefused("BUCKET_THRESHOLD_NOT_EXCEEDED", "12 CFR 1026.19(e)(3)(iv)(A) 'increase by more than 10 percent'; 21.5 guardrails", `never reset a ten-percent baseline when the aggregate increase (${S(cc.ten_pct_threshold_test?.increase_cents ?? 0n)} cents) is at or below 10 %`);
        else if (f.tolerance_class === "ten_percent" && f.paid_by === "borrower" && bucketReset) bump(f, revised ?? f.current_amount_cents, "basis (A)/(B)/(C) bucket reset: the whole bucket refreshes to the revised estimates (open question 3 default)");
      }
    }
    cc.baseline_reset = reset.length > 0;
    const event = reset.length ? this.append("fee.baseline.reset", cc.application_id, { cc_id: ccId, fee_codes: reset, fee_item_ids: reset, items: s.items.filter((f) => reset.includes(f.fee_code)).map((f) => ({ fee_code: f.fee_code, tolerance_class: f.tolerance_class, baseline_amount_cents: S(f.baseline_amount_cents) })) }, when) : null;
    return { reset, event };
  }
  /** Step (5): `computeRevisedLEDueDate` for a recorded row (rule 7). */
  revisedLeDue(ccId: string): { due_on: PlainDate | null; due_at: string | null } { const cc = this.cc(ccId); return { due_on: cc.revised_le_due_on, due_at: cc.revised_le_due_at }; }
  /** `checkFourDayRule` on today's facts for a planned delivery. */
  checkFourDayRule(applicationId: string, i: { today: PlainDate; channel?: DeliveryChannel | null; issue_on?: PlainDate | null; receipt_evidence_on?: PlainDate | null; consummation_on?: PlainDate | null }): FourDayCheck {
    const s = this.state(applicationId); if (i.consummation_on !== undefined) s.consummation_on = i.consummation_on;
    return fourDayRule({ consummation_on: s.consummation_on, cd_delivered_on: s.cd_delivered_on, today: i.today, channel: i.channel ?? null, issue_on: i.issue_on ?? null, receipt_evidence_on: i.receipt_evidence_on ?? null });
  }
  /** Step (6b): hand the revised estimate to 25.2 — the CD (fewer than four specific business days remain) or a corrected CD (the CD is out); the 3-day clock is then satisfied by that CD. */
  reflectOnCD(ccId: string, at?: string): { cc: ChangedCircumstanceRow; event: DomainEvent } {
    const cc = this.cc(ccId); const s = this.state(cc.application_id); const when = at ?? this.clock.now();
    const route: "cd" | "corrected_cd" = s.cd_delivered_on && civilDate(when, this.calendar.time_zone) >= s.cd_delivered_on ? "corrected_cd" : "cd";
    cc.reflected_on = route; cc.status = "evaluated_valid";
    const event = this.append("disclosure.cd.revised_estimate.requested", cc.application_id, { cc_id: ccId, route, to_process: "25.2", fee_codes: cc.affected_fee_codes, amounts: Object.fromEntries(Object.entries(cc.revised_amounts).map(([k, v]) => [k, S(v)])), revised_le_due_at: cc.revised_le_due_at, reason: cc.four_day_check?.reason ?? "revised LE barred" }, when);
    return { cc, event };
  }
  /** Step (6a): render LE v(n+1) with the 21.2 fee model and calculations; refused on or after the CD date, when it would lower the lender credit, or when no changed circumstance is named. */
  renderRevisedLE(i: RevisedLeInput): RevisedLeRow {
    const s = this.state(i.application_id); nonEmpty(i.disclosure_id, "disclosure_id");
    if (!i.cc_ids.length) throw new RangeError("a revised LE names the changed circumstances it carries (revision_reason_cc_ids)");
    const ccs = i.cc_ids.map((id) => this.cc(id)); for (const cc of ccs) if (cc.application_id !== i.application_id) throw new RangeError(`changed circumstance ${cc.cc_id} belongs to another application`);
    const today = civilDate(this.clock.now(), this.calendar.time_zone);
    if (s.cd_delivered_on && today >= s.cd_delivered_on) { this.append("disclosure.le.revised.refused", i.application_id, { code: "NO_REVISED_LE_AFTER_CD", cc_ids: i.cc_ids, route: "corrected_cd", cd_delivered_on: s.cd_delivered_on }); throw new ToleranceRefused("NO_REVISED_LE_AFTER_CD", "12 CFR 1026.19(e)(4)(ii)", `the CD was provided ${s.cd_delivered_on}; a revised LE is never issued on or after that date — reflectOnCD routes the estimate to 25.2`); }
    const fees = assembleFees(i.fees, i.as_of); const totals = sectionTotals(fees);
    if (totals.lender_credits_cents > s.lender_credit_baseline_cents) throw new ToleranceRefused("NO_LENDER_CREDIT_REDUCTION", "comment 19(e)(3)(i)-5 (CFPB TRID FAQ); 21.5 guardrails", `lender credits ${formatCents(totals.lender_credits_cents)} would fall below the baseline ${formatCents(s.lender_credit_baseline_cents)} — never reduce lender credits`);
    const mi = i.mi_monthly_cents !== undefined ? { mi_monthly_cents: i.mi_monthly_cents } : {};
    const calcs = loanEstimateCalcs({ loan_cents: i.loan_cents, rate_pct: i.pricing.rate_pct, term_months: i.term_months, loan_costs_cents: totals.loan_costs_cents, ...mi });
    const apr = computeApr({ loan_cents: i.loan_cents, rate_pct: i.pricing.rate_pct, term_months: i.term_months, prepaid_finance_charge_cents: netPrepaidFinanceCharge(fees), ...mi });
    const classed: FeeItem[] = fees.map((f) => { const b = s.items.find((x) => x.fee_code === f.fee_code); return { ...f, tolerance_class: b?.tolerance_class ?? classOf(f), baseline_amount_cents: b?.baseline_amount_cents ?? 0n, baseline_disclosure_id: b?.baseline_disclosure_id ?? i.disclosure_id }; });
    const le_version = s.le_version + 1;
    const what_changed = ccs.map((cc) => `${cc.basis}: ${cc.narrative}`);
    const intentInPeriod = s.intent_at !== null && s.costs_expire_at !== null && Date.parse(s.intent_at) <= Date.parse(s.costs_expire_at);
    const costs_expire_at = intentInPeriod ? null : (i.costs_expire_at ?? null);   // comment 37(a)(13)-4: blank once intent arrived in the period
    const h24 = { ...h24Payload({ ...i, fees: classed, totals, calcs, apr, rendered_on: today }), le_version, revision_reason_cc_ids: [...i.cc_ids], what_changed, costs_expire_at, notice_code: "NTC_REGZ_1026_37_LE_REVISED" };
    const hash = dataHash({ loan_cents: i.loan_cents, term_months: i.term_months, pricing: i.pricing, fees: classed.map((f) => [f.fee_code, f.amount_cents]), calcs, apr: apr.apr_disclosed, loan_officer: i.loan_officer, le_version, cc_ids: i.cc_ids });
    const row: RevisedLeRow = { application_id: i.application_id, disclosure_id: i.disclosure_id, kind: "le", le_version, basis: "revised", revision_reason_cc_ids: [...i.cc_ids], reason: ccs[0]!.kind, reasons: ccs.map((c) => c.kind), status: "rendered", rendered_at: this.clock.now(), data_hash: hash, template_version: H24_TEMPLATE_VERSION, notice_code: "NTC_REGZ_1026_37_LE_REVISED",
      fees: classed, totals, calcs, apr, rate_lock_block: s.lock ? { locked: s.lock.locked, lock_expires_at: s.lock.lock_expires_at } : i.pricing.locked ? { locked: true, lock_expires_at: i.pricing.lock_expires_at ?? null } : null, costs_expire_at, what_changed, h24,
      delivery_channel: null, delivered_at: null, mailed_at: null, issued_on: null, esign_consent_id: null, mailing_proof_id: null, deemed_receipt_date: null, received_at: null, receipt_evidence: null, effective_receipt_date: null, latest_receipt_on: null, earliest_consummation_date: null, gate_opened_at: null, late: false };
    s.revised.set(i.disclosure_id, row); s.le_version = le_version;
    for (const cc of ccs) { cc.revised_le_disclosure_id = i.disclosure_id; if (cc.status === "evaluated_valid") cc.status = "revised_le_scheduled"; }
    // the figure snapshot the borrower surface diffs against the prior version (32.4 "What changed": computed from two snapshots, never free text)
    this.append("disclosure.le.rendered", i.application_id, { disclosure_id: i.disclosure_id, le_version, basis: "revised", data_hash: hash, template_version: H24_TEMPLATE_VERSION, cc_ids: i.cc_ids, apr: apr.apr_disclosed, tip_pct: calcs.tip_pct, pi_cents: S(calcs.pi_cents),
      rate_pct: i.pricing.rate_pct, loan_cents: S(i.loan_cents), points_cents: S(i.pricing.points_cents), lender_credits_cents: S(totals.lender_credits_cents), total_closing_costs_cents: S(totals.total_closing_costs_cents), reason: row.reason, reasons: row.reasons,
      fees: classed.map((f) => ({ fee_code: f.fee_code, description: f.description, le_section: f.le_section, amount_cents: S(f.amount_cents), baseline_amount_cents: S(f.baseline_amount_cents) })) });
    // current estimates follow the rendered figures (step 1: fee_items.current_amount_cents with source and time)
    for (const f of classed) { const b = s.items.find((x) => x.fee_code === f.fee_code); if (b && b.current_amount_cents !== f.amount_cents) { b.history.push({ at: this.clock.now(), from_cents: b.current_amount_cents, to_cents: f.amount_cents, cause: `LE v${le_version} render`, cc_id: null, actor: "agent:disclosure" }); b.current_amount_cents = f.amount_cents; } }
    return row;
  }
  /**
   * `deliverDisclosure` for a revised LE: the (e)(4)(ii) bar and four-day limit are asserted on the delivery facts (a mailed LE that
   * would be deemed received after the latest receipt is refused and routed to the CD); electronic channels need the 21.1 consent.
   * Emits the channel event, `disclosure.le.revised` (arms the 4-SBD gate; `reason=rate_lock` satisfies 21.4's clock) and one
   * `changed_circumstance.reflected{reflected_on=le}` per changed circumstance (satisfies the 3-day clock, late when breached).
   */
  deliverRevisedLE(disclosureId: string, d: { channel: DeliveryChannel; at?: string; consent?: EsignConsent | null; mailing_proof_id?: string | null; receipt_evidence_at?: string | null }): RevisedLeRow {
    const r = this.revisedLe(disclosureId); const s = this.state(r.application_id); const at = d.at ?? this.clock.now();
    if (!DELIVERY_CHANNELS.includes(d.channel)) throw new RangeError(`channel ${d.channel} is not one of ${DELIVERY_CHANNELS.join("/")}`);
    if (r.issued_on) throw new ToleranceRefused("ALREADY_ISSUED", "21.5 state machine", `revised LE ${disclosureId} was already issued on ${r.issued_on}`);
    const issued_on = civilDate(at, this.calendar.time_zone);
    const check = fourDayRule({ consummation_on: s.consummation_on, cd_delivered_on: s.cd_delivered_on, today: issued_on, channel: d.channel, issue_on: issued_on, receipt_evidence_on: d.receipt_evidence_at ? civilDate(d.receipt_evidence_at, this.calendar.time_zone) : null });
    if (!check.permitted) {
      const code = check.route === "corrected_cd" ? "NO_REVISED_LE_AFTER_CD" : "FOUR_DAY_LIMIT"; r.status = "refused";
      this.append("disclosure.le.revised.refused", r.application_id, { disclosure_id: disclosureId, code, cc_ids: r.revision_reason_cc_ids, route: check.route, channel: d.channel, latest_receipt: check.latest_receipt, effective_receipt_date: check.effective_receipt_date, reason: check.reason }, at);
      for (const id of r.revision_reason_cc_ids) this.reflectOnCD(id, at);
      throw new ToleranceRefused(code, "12 CFR 1026.19(e)(4)(ii)", check.reason);
    }
    if (isElectronic(d.channel)) { const c = consentValidFor(d.consent, at); if (!c.ok) throw new ToleranceRefused("NO_ESIGN_CONSENT", "12 CFR 1026.37(o)(3)(iii); 15 U.S.C. 7001(c)", `${c.reason} — deliver by print the same day`); }
    if (d.channel === "mail" && !d.mailing_proof_id) throw new ToleranceRefused("NO_MAILING_PROOF", "12 CFR 1026.19(e)(4)(ii) mailbox presumption evidence", "a mailed revised LE needs the print vendor's mailing-date evidence");
    r.delivery_channel = d.channel; r.issued_on = issued_on; r.esign_consent_id = isElectronic(d.channel) ? d.consent!.id : null; r.mailing_proof_id = d.mailing_proof_id ?? null;
    r.deemed_receipt_date = isInPerson(d.channel) ? null : deemedReceiptDate(issued_on); r.latest_receipt_on = check.latest_receipt;
    r.late = r.revision_reason_cc_ids.some((id) => { const cc = this.cc(id); return cc.revised_le_due_at !== null && Date.parse(at) > Date.parse(cc.revised_le_due_at); });
    if (d.channel === "mail") { r.mailed_at = at; r.status = "mailed"; this.append("disclosure.le.mailed", r.application_id, { disclosure_id: disclosureId, le_version: r.le_version, mailed_at: at, mailing_proof_id: d.mailing_proof_id, issued_on }, at); }
    else { r.delivered_at = at; r.status = "delivered"; this.append("disclosure.le.delivered", r.application_id, { disclosure_id: disclosureId, le_version: r.le_version, channel: d.channel, delivered_at: at, esign_consent_id: r.esign_consent_id, issued_on }, at); }
    this.append("disclosure.le.revised", r.application_id, { disclosure_id: disclosureId, version: r.le_version, le_version: r.le_version, cc_ids: r.revision_reason_cc_ids, revision_reason_cc_ids: r.revision_reason_cc_ids, reason: r.reason, reasons: r.reasons, channel: d.channel, in_person: isInPerson(d.channel), issued_on, deemed_receipt_date: r.deemed_receipt_date ?? issued_on, latest_receipt_on: r.latest_receipt_on, late: r.late, data_hash: r.data_hash, notice: r.notice_code }, at);
    for (const id of r.revision_reason_cc_ids) { const cc = this.cc(id); cc.status = "revised_le_delivered"; cc.reflected_on = "le"; cc.revised_le_disclosure_id = disclosureId; this.append("changed_circumstance.reflected", r.application_id, { cc_id: id, reflected_on: "le", disclosure_id: disclosureId, le_version: r.le_version, late: r.late }, at); }
    if (isInPerson(d.channel)) this.setReceipt(r, "in_person", issued_on, at);
    else if (d.receipt_evidence_at) this.recordReceipt(disclosureId, { kind: "authenticated_view", at: d.receipt_evidence_at, borrower_id: "consumer" });
    return r;
  }
  private setReceipt(r: RevisedLeRow, evidence: ReceiptEvidence, on: PlainDate, at: string): void {
    r.received_at = evidence === "mailbox_rule" ? null : at; r.receipt_evidence = evidence; r.effective_receipt_date = on; r.status = evidence === "mailbox_rule" ? "deemed_received" : "received";
    r.earliest_consummation_date = earliestConsummationAfterRevisedLe(on);
    this.append("disclosure.le.received", r.application_id, { disclosure_id: r.disclosure_id, le_version: r.le_version, evidence, received_on: evidence === "mailbox_rule" ? null : on, effective_receipt_date: on, earliest_consummation_date: r.earliest_consummation_date }, at);
    const s = this.state(r.application_id); if (s.consummation_on && s.consummation_on >= r.earliest_consummation_date) this.openFourDayGate(r, at);
  }
  /** Receipt evidence tied to the authenticated borrower moves `effective_receipt_date` earlier than the presumption (and can open the gate). */
  recordReceipt(disclosureId: string, ev: { kind: "authenticated_view" | "acknowledgement" | "esignature"; at: string; borrower_id: string }): RevisedLeRow {
    const r = this.revisedLe(disclosureId); if (!r.issued_on) throw new ToleranceRefused("NOT_ISSUED", "21.5 state machine", "no delivery to evidence receipt of");
    if (r.receipt_evidence === "esign_confirmed" || r.receipt_evidence === "in_person") return r;
    const on = civilDate(ev.at, this.calendar.time_zone); if (on < r.issued_on) throw new RangeError(`receipt evidence ${ev.at} precedes delivery on ${r.issued_on}`);
    this.setReceipt(r, "esign_confirmed", r.deemed_receipt_date && r.deemed_receipt_date < on ? r.deemed_receipt_date : on, ev.at); return r;
  }
  /** Mailbox sweep: on the third specific business day the revised LE is deemed received. */
  deemReceived(disclosureId: string, today: PlainDate): RevisedLeRow { const r = this.revisedLe(disclosureId); if (r.receipt_evidence || !r.deemed_receipt_date || today < r.deemed_receipt_date) return r; this.setReceipt(r, "mailbox_rule", r.deemed_receipt_date, endOfDayIso(today, this.calendar.time_zone)); return r; }
  private openFourDayGate(r: RevisedLeRow, at: string): void { if (r.gate_opened_at) return; r.gate_opened_at = at; this.append("gate.revised_le_4sbd.opened", r.application_id, { disclosure_id: r.disclosure_id, le_version: r.le_version, effective_receipt_date: r.effective_receipt_date, earliest_consummation_date: r.earliest_consummation_date }, at); }
  /** Daily sweep: once today reaches the earliest consummation date the gate row is satisfied. */
  openGateIfDue(disclosureId: string, today: PlainDate): boolean { const r = this.revisedLe(disclosureId); if (r.gate_opened_at || !r.earliest_consummation_date || today < r.earliest_consummation_date) return false; this.openFourDayGate(r, endOfDayIso(today, this.calendar.time_zone)); return true; }
  gateFacts(applicationId: string, requestedOn: PlainDate): Record<string, unknown> {
    const s = this.state(applicationId); const latest = [...s.revised.values()].filter((r) => r.issued_on).sort((a, b) => a.le_version - b.le_version).at(-1);
    return { requested_on: requestedOn, effective_receipt_date: latest?.effective_receipt_date ?? latest?.deemed_receipt_date ?? null, revised_le_version: latest?.le_version ?? null, cd_delivered_on: s.cd_delivered_on };
  }
  /** `assertGateOpen(application_id, REGZ_1026_19E4_REVISED_LE_4SBD_GATE)` exposed to 26.x. */
  assertGateOpen(applicationId: string, requestedOn: PlainDate): void { const g = revisedLeFourDayGate(this.gateFacts(applicationId, requestedOn)); if (!g.open) throw new ToleranceRefused("REGZ_1026_19E4_REVISED_LE_4SBD_GATE", "12 CFR 1026.19(e)(4)(ii)", g.reason ?? "closed"); }

  // ---- breach of the 3-day clock (T12): the reset is withdrawn, the original baseline governs, the revised disclosure still issues
  onRevisedLeBreached(ccId: string, nowIso: string): { incident_id: string; reset_withdrawn: readonly string[]; escalated_to: readonly string[] } {
    const cc = this.cc(ccId); const s = this.state(cc.application_id); const incident_id = `INC-REVLE3BD-${cc.application_id}-${ccId.slice(0, 8)}`;
    const withdrawn: string[] = [];
    for (const f of s.items) if (f.baseline_reset_cc_id === ccId) { const h = [...f.history].reverse().find((x) => x.cc_id === ccId && x.cause.includes("reset")); if (h) { f.history.push({ at: nowIso, from_cents: f.baseline_amount_cents, to_cents: h.from_cents, cause: "REGZ_1026_19E4_REVISED_LE_3BD breached: reset withdrawn — a late revision cannot support good faith; the original baseline governs", cc_id: ccId, actor: "system:timer" }); f.baseline_amount_cents = h.from_cents; f.baseline_reset_cc_id = null; withdrawn.push(f.fee_code); } }
    cc.baseline_reset = false; cc.breach = { at: nowIso, incident_id, reset_withdrawn: withdrawn.length > 0 };
    const escalated_to = ["compliance-sentinel", "officer"] as const;
    this.esc.open({ kind: "sev1", applicationId: cc.application_id, severity: "1", ownerRole: "officer", payload: { code: "REGZ_1026_19E4_REVISED_LE_3BD", cc_id: ccId, incident_id, escalated_to: [...escalated_to], root_cause_required: true } }, AGENT);
    if (withdrawn.length) this.append("fee.baseline.reset.withdrawn", cc.application_id, { cc_id: ccId, fee_codes: withdrawn, fee_item_ids: withdrawn, reason: "late revised LE — original baseline governs the tolerance test" }, nowIso);
    this.append("compliance.incident.opened", cc.application_id, { incident_id, code: "REGZ_1026_19E4_REVISED_LE_3BD", severity: 1, cc_id: ccId, escalated_to: [...escalated_to], root_cause_required: true, breached_at: nowIso, exam_file: true }, nowIso);
    s.incidents.push({ incident_id, code: "REGZ_1026_19E4_REVISED_LE_3BD", at: nowIso, cc_id: ccId });
    return { incident_id, reset_withdrawn: withdrawn, escalated_to };
  }

  // ---- step (7): the test at every stage, the cure, the refund
  runToleranceTest(i: Omit<ToleranceTestInput, "review_threshold_cents" | "time_zone"> & { readonly review_threshold_cents?: Cents }): { test: ToleranceTestRow; event: DomainEvent } {
    const s = this.state(i.application_id);
    const test = toleranceTest(s.items, { ...i, lender_credit_baseline_cents: i.lender_credit_baseline_cents ?? s.lender_credit_baseline_cents, review_threshold_cents: i.review_threshold_cents ?? this.threshold, time_zone: this.calendar.time_zone, baseline_snapshot_id: i.baseline_snapshot_id ?? `${s.baseline_disclosure_id ?? "baseline"}@${s.items.filter((f) => f.baseline_reset_cc_id).map((f) => f.baseline_reset_cc_id).join("|") || "initial"}` });
    if (POST_CONSUMMATION_STAGES.includes(test.stage) && s.consummation_at === null) throw new ToleranceRefused("NOT_CONSUMMATED", "12 CFR 1026.19(f)(2)(v)", `stage ${test.stage} runs after consummation (closing.consummated not seen for ${i.application_id})`);
    s.tests.push(test);
    const event = this.append("tolerance.test.completed", i.application_id, { test_id: test.test_id, stage: test.stage, status: test.status, total_excess_cents: S(test.total_excess_cents), cure_route: test.cure_route, run_at: test.run_at, run_on: test.run_on, comparison_disclosure_id: test.comparison_disclosure_id, zero_excess_cents: S(test.zero_results.reduce((a, z) => a + z.excess_cents, 0n)), lender_credit_shortfall_cents: S(test.lender_credit_result.shortfall_cents), ten_pct_excess_cents: S(test.ten_pct_result.excess_cents), engine_version: ENGINE_VERSION }, i.run_at);
    if (test.status === "escalated") this.esc.open({ kind: "sev2", applicationId: i.application_id, severity: "2", ownerRole: "compliance", payload: { code: "SM_TOLERANCE_CURE_REVIEW_SLA_1BD", test_id: test.test_id, escalated_to: ["compliance-sentinel"], total_excess_cents: S(test.total_excess_cents), review: "root cause; the cure still posts" } }, AGENT);
    if (test.cure_route === "refund_post_consummation" && this.ledger) this.ledger.post({ effectiveDate: test.run_on, description: `tolerance excess ${formatCents(test.total_excess_cents)} found after consummation (test ${test.test_id}) — refund payable to the borrower`, lines: [{ account: TOLERANCE_CURE_EXPENSE, amountCents: test.total_excess_cents, ruleRef: "21.5 rule 9: post-consummation excess refunded within 60 days (§1026.19(f)(2)(v))" }, { account: BORROWER_REFUNDS_PAYABLE, amountCents: -test.total_excess_cents, ruleRef: "21.5 baseline §5: borrower_refunds_payable" }] }, i.run_at);
    return { test, event };
  }
  /** `compliance-sentinel` review of an escalated cure (root cause; closing not blocked). */
  recordCureReview(testId: string, r: { reviewer_id: string; outcome: "root_cause_recorded" | "no_action"; at?: string }): DomainEvent { const t = this.test(testId); nonEmpty(r.reviewer_id, "reviewer_id"); return this.append("tolerance.cure.reviewed", t.application_id, { test_id: testId, reviewer_role: "compliance-sentinel", reviewer_id: r.reviewer_id, outcome: r.outcome }, r.at); }
  /** Rule 9 at the CD stage: a lender credit equal to the excess; the borrower's cash to close falls by `cure_cents`. Guardrails: never the refund route before consummation; never funded by the borrower. */
  applyCure(testId: string, i: { funded_by: FundedBy; cd_disclosure_id: string; at?: string }): { cure: ToleranceCureRow; event: DomainEvent; ledger_set: EntrySet | null } {
    const t = this.test(testId); const s = this.state(t.application_id); const at = i.at ?? this.clock.now(); nonEmpty(i.cd_disclosure_id, "cd_disclosure_id");
    if (t.total_excess_cents === 0n) throw new ToleranceRefused("NO_EXCESS", "21.5 rule 9", `test ${testId} passed — nothing to cure`);
    if (t.cure_route !== "lender_credit_at_closing") throw new ToleranceRefused("CURE_AT_CLOSING_ONLY", "21.5 rule 9", `test ${testId} at stage ${t.stage} is refunded post-consummation (issueRefund), not credited on the CD`);
    if (s.cures.some((c) => c.test_id === testId)) throw new ToleranceRefused("ALREADY_CURED", "21.5 state machine", `test ${testId} is already cured`);
    const amount = t.total_excess_cents;
    const ledger_set = this.ledger ? this.ledger.post({ effectiveDate: civilDate(at, this.calendar.time_zone), description: `tolerance cure ${formatCents(amount)} — lender credit on CD ${i.cd_disclosure_id} (test ${testId}, funded by ${i.funded_by})`, lines: [{ account: TOLERANCE_CURE_EXPENSE, amountCents: amount, ruleRef: `21.5 rule 9/10: cure at closing funded by ${i.funded_by} (term sheet)` }, { account: CORPORATE_CASH, amountCents: -amount, ruleRef: "21.5 rule 9: lender credit funded into the closing — never by the borrower" }] }, at) : null;
    const cure: ToleranceCureRow = { cure_id: randomUUID(), application_id: t.application_id, test_id: testId, amount_cents: amount, method: "lender_credit_at_closing", funded_by: i.funded_by, posted_at: at, cd_disclosure_id: i.cd_disclosure_id, refund_instrument: null, refund_sent_at: null, refund_sent_on: null, refund_due_on: null, ledger_entry_id: ledger_set?.id ?? `pending:${testId}`, refund_ledger_entry_id: null, corrected_cd_delivered_at: null, cd_statement: cureStatement(amount) };
    s.cures.push(cure); t.status = "cured_at_closing";
    const event = this.append("tolerance.cure.applied", t.application_id, { cure_id: cure.cure_id, test_id: testId, amount_cents: S(amount), method: cure.method, funded_by: i.funded_by, cd_disclosure_id: i.cd_disclosure_id, ledger_set_id: cure.ledger_entry_id, cd_statement: cure.cd_statement, cash_to_close_reduction_cents: S(amount) }, at);
    return { cure, event, ledger_set };
  }
  /** Rule 9 after consummation: refund by ACH/check within 60 calendar days (partner `officer` releases), then 25.2's corrected CD is requested; both duties close the row. */
  issueRefund(testId: string, i: { instrument: "ach" | "check"; sent_at: string; funded_by: FundedBy; released_by: { kind: "human"; id: string; role: string } }): { cure: ToleranceCureRow; event: DomainEvent; ledger_set: EntrySet | null; due_on: PlainDate } {
    const t = this.test(testId); const s = this.state(t.application_id); isoOrThrow(i.sent_at, "sent_at");
    if (t.total_excess_cents === 0n) throw new ToleranceRefused("NO_EXCESS", "21.5 rule 9", `test ${testId} passed — nothing to refund`);
    if (t.cure_route !== "refund_post_consummation") throw new ToleranceRefused("CURE_AT_CLOSING_MANDATORY", "21.5 guardrails: never choose the refund route when the excess is known before consummation", `test ${testId} at stage ${t.stage} is cured on the CD at closing (applyCure)`);
    if (i.released_by.kind !== "human" || i.released_by.role !== "officer") throw new ToleranceRefused("OFFICER_RELEASE", "21.5 escalations: partner `officer` (refund release)", "a post-consummation refund is released by the partner officer");
    if (!s.consummation_on) throw new ToleranceRefused("NOT_CONSUMMATED", "12 CFR 1026.19(f)(2)(v)", "no consummation date");
    if (s.cures.some((c) => c.test_id === testId)) throw new ToleranceRefused("ALREADY_REFUNDED", "21.5 state machine", `test ${testId} is already refunded`);
    const amount = t.total_excess_cents; const due_on = refundDueOn(s.consummation_on); const sent_on = civilDate(i.sent_at, this.calendar.time_zone);
    const ledger_set = this.ledger ? this.ledger.post({ effectiveDate: sent_on, description: `tolerance refund ${formatCents(amount)} sent by ${i.instrument} (test ${testId}); borrower_refunds_payable cleared`, lines: [{ account: BORROWER_REFUNDS_PAYABLE, amountCents: amount, ruleRef: "21.5 rule 9: refund of the excess no later than 60 days after consummation (§1026.19(f)(2)(v))" }, { account: CORPORATE_CASH, amountCents: -amount, ruleRef: `21.5: ${i.instrument} refund released by officer ${i.released_by.id}` }] }, i.sent_at) : null;
    const cure: ToleranceCureRow = { cure_id: randomUUID(), application_id: t.application_id, test_id: testId, amount_cents: amount, method: "refund_post_consummation", funded_by: i.funded_by, posted_at: i.sent_at, cd_disclosure_id: null, refund_instrument: i.instrument, refund_sent_at: i.sent_at, refund_sent_on: sent_on, refund_due_on: due_on, ledger_entry_id: ledger_set?.id ?? `pending:${testId}`, refund_ledger_entry_id: ledger_set?.id ?? null, corrected_cd_delivered_at: null, cd_statement: cureStatement(amount) };
    s.cures.push(cure); t.status = "refunded";
    const event = this.append("tolerance.refund.issued", t.application_id, { cure_id: cure.cure_id, test_id: testId, amount_cents: S(amount), instrument: i.instrument, sent_at: i.sent_at, sent_on, due_on, late: sent_on > due_on, funded_by: i.funded_by, released_by: `${i.released_by.kind}:${i.released_by.id}`, ledger_set_id: cure.ledger_entry_id }, i.sent_at);
    this.append("disclosure.cd.correction.requested", t.application_id, { reason: "tolerance_refund", cure_id: cure.cure_id, amount_cents: S(amount), due_on, to_process: "25.2" }, i.sent_at);
    return { cure, event, ledger_set, due_on };
  }
  private completeRefundIfDone(app: string, cure: ToleranceCureRow, at: string): void {
    if (!cure.refund_sent_at || !cure.corrected_cd_delivered_at) return;
    this.append("tolerance.refund.completed", app, { cure_id: cure.cure_id, test_id: cure.test_id, refund_sent: true, corrected_cd_delivered: true, no_excess_found: false, refund_sent_at: cure.refund_sent_at, corrected_cd_delivered_at: cure.corrected_cd_delivered_at, due_on: cure.refund_due_on }, at);
  }
  /** "Satisfied trivially if no excess": the post-consummation window closes with no `refund_required` test on file. */
  closeRefundWindow(applicationId: string, at?: string): DomainEvent {
    const s = this.state(applicationId); const when = at ?? this.clock.now();
    if (s.tests.some((t) => t.cure_route === "refund_post_consummation" && t.status !== "refunded")) throw new ToleranceRefused("REFUND_OUTSTANDING", "12 CFR 1026.19(f)(2)(v)", "a post-consummation excess is still unrefunded");
    return this.append("tolerance.refund.completed", applicationId, { cure_id: null, refund_sent: false, corrected_cd_delivered: false, no_excess_found: true, consummation_on: s.consummation_on }, when);
  }
  /** The decision record (`agent_decisions`) the agent writes per changed circumstance / test. */
  decisionRecord(i: { cc_id?: string | null; test_id?: string | null; application_id: string; model_version: string; prompt_version: string; rationale: string; confidence?: number }): Record<string, unknown> {
    const cc = i.cc_id ? this.cc(i.cc_id) : null; const t = i.test_id ? this.test(i.test_id) : null;
    return { cc_id: cc?.cc_id ?? null, application_id: i.application_id, source_event_id: cc?.source_event_id ?? null, fee_item_ids: cc?.affected_fee_codes ?? [], basis: cc?.basis ?? null, narrative: cc?.narrative ?? null, evidence_document_ids: cc?.evidence_document_ids ?? [], threshold_test: cc?.ten_pct_threshold_test ?? null, valid: cc?.valid ?? null, revised_le_due_at: cc?.revised_le_due_at ?? null,
      four_day_check: cc?.four_day_check ? { latest_receipt: cc.four_day_check.latest_receipt, cd_delivered_at: this.state(i.application_id).cd_delivered_at, route: cc.four_day_check.route } : null, test_id: t?.test_id ?? null, cure_cents: t ? S(t.total_excess_cents) : null, rationale: i.rationale, model_version: i.model_version, prompt_version: i.prompt_version, confidence: i.confidence ?? null, engine_version: ENGINE_VERSION };
  }
}

/** REGZ_1026_19E4_REVISED_LE_4SBD_GATE (not_before_gate on `consummate`): open when no revised LE is outstanding or the requested consummation is on/after the latest revised LE's receipt + 4 specific business days. Facts: `requested_on`, `effective_receipt_date` (evidence or presumption), `revised_le_version`. */
export function revisedLeFourDayGate(f: { requested_on?: unknown; effective_receipt_date?: unknown; revised_le_version?: unknown }): { open: boolean; reason?: string } {
  if (typeof f.requested_on !== "string" || !f.requested_on) return { open: false, reason: "requested consummation date is required" };
  if (typeof f.effective_receipt_date !== "string" || !f.effective_receipt_date) return { open: true };
  const earliest = earliestConsummationAfterRevisedLe(plainDate(f.effective_receipt_date));
  if (plainDate(f.requested_on) >= earliest) return { open: true };
  return { open: false, reason: `consummation ${f.requested_on} is earlier than ${earliest}: revised LE${f.revised_le_version ? ` v${String(f.revised_le_version)}` : ""} received ${f.effective_receipt_date} must be received not later than four specific business days before consummation (§1026.19(e)(4)(ii)) — latest receipt for ${f.requested_on} was ${latestRevisedLeReceipt(plainDate(f.requested_on))}` };
}
