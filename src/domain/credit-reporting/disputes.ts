/**
 * 8.2 Dispute handling — ACDV and direct-dispute clocks, reviewer conditions,
 * Compliance Condition Code lifecycle, corrections fan-out.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, federal, servicer } from "../../kernel/calendar/business.ts";
import type { Ccc } from "./types.ts";

export type DisputeChannel = "acdv" | "direct_mail" | "direct_electronic" | "oral";
export type Determination = "verified_as_reported" | "modified" | "deleted_account" | "deleted_consumer" | "unverifiable" | "frivolous";

export interface DirectDisputeClocks {
  readonly received_on: PlainDate;
  readonly results_due: PlainDate;         // day 30
  readonly dispatch_target: PlainDate;     // policy: day 25
  readonly extended_to: PlainDate | null;  // +15 when supplemented within the 30 days
}

/** §1022.43(e): results before 30 days expire; supplementation within that period extends to 45 (8.2-T5). */
export function directDisputeClocks(receivedOn: PlainDate, supplementedOn: PlainDate | null = null): DirectDisputeClocks {
  const due = addDays(receivedOn, 30);
  const extended = supplementedOn !== null && supplementedOn <= due ? addDays(receivedOn, 45) : null;
  return { received_on: receivedOn, results_due: due, dispatch_target: addDays(receivedOn, 25), extended_to: extended };
}

/** Supplementation after the 30-day period opens a new case rather than extending (8.2-T5). */
export function supplementationOpensNewCase(receivedOn: PlainDate, supplementedOn: PlainDate): boolean {
  return supplementedOn > addDays(receivedOn, 30);
}

/** §1022.43(f)(2): frivolous/irrelevant notice within 5 business days of the determination (federal calendar). */
export function frivolousNoticeDue(determinedOn: PlainDate, cal: Calendar = federal): PlainDate {
  return addBusinessDays(determinedOn, 5, cal);
}

export interface FrivolousCheck { readonly repeat: boolean; readonly new_information: boolean; readonly human_approved: boolean; readonly channel: DisputeChannel; }

/** A frivolous determination is human-made, direct-channel only, and never when the repeat carries new information (rule 7). */
export function frivolousEligible(c: FrivolousCheck): boolean {
  return c.channel !== "acdv" && c.repeat && !c.new_information && c.human_approved;
}

export interface AcdvClocks {
  readonly received_on: PlainDate;
  readonly response_due: PlainDate;        // ACDV responseDueDate governs
  readonly internal_target: PlainDate;     // policy: 7 days after receipt, never after the due date
  readonly outer_bound: PlainDate;         // CRA receipt + 30 (45 with supplementation)
  readonly escalate_on: PlainDate;         // 90% of the due window
}

export function acdvClocks(receivedOn: PlainDate, responseDue: PlainDate, craReceivedOn: PlainDate, craExtended = false): AcdvClocks {
  const target = addDays(receivedOn, 7);
  const window = daysBetween(receivedOn, responseDue);
  return {
    received_on: receivedOn, response_due: responseDue,
    internal_target: target < responseDue ? target : responseDue,
    outer_bound: addDays(craReceivedOn, craExtended ? 45 : 30),
    escalate_on: addDays(receivedOn, Math.floor(window * 0.9)),
  };
}

/** Reviewer conditions (8.2 AI agent design, policy defaults all on; 8.2-Q1): condition (1) `verified_as_reported` with confidence < 0.85 → `human_agent`. */
export const REVIEW_CONFIDENCE = 0.85;
export type DisputeCategory = "not_mine" | "identity_theft" | "mixed_file" | "liability" | "terms" | "status_or_rating" | "payment_history" | "balance" | "amount_past_due" | "dates" | "special_comment_or_ccc" | "bankruptcy_cii" | "deceased" | "scra" | "transfer_duplicate" | "other";
/** Condition (2): categories that go to the `officer`. */
export const OFFICER_CATEGORIES: ReadonlySet<DisputeCategory> = new Set<DisputeCategory>(["identity_theft", "mixed_file", "not_mine", "deceased", "bankruptcy_cii", "scra"]);
export type DisputeContext = "litigation" | "attorney" | "cfpb_complaint" | "state_regulator_complaint";
export interface ReviewInput {
  readonly determination: Determination;
  readonly confidence: number;
  readonly category?: DisputeCategory;
  readonly channel?: DisputeChannel;
  /** (3) reinsertion of deleted data / a BRR. */
  readonly reinsertion_or_brr?: boolean;
  /** (4) direct-dispute (b) out-of-scope determination; `repeat_basis` = frivolous on a repeat-dispute basis. */
  readonly out_of_scope?: boolean;
  readonly repeat_basis?: boolean;
  /** (5) litigation / attorney / CFPB / state-regulator complaint context. */
  readonly context?: readonly DisputeContext[];
  /** (6) disputes on the same item within 12 months, this one included. */
  readonly disputes_same_item_12m?: number;
  /** (7) pre-boarding period; `prior_servicer_records_complete=false` → human_agent. */
  readonly pre_boarding_period?: boolean;
  readonly prior_servicer_records_complete?: boolean;
  /** (8) discrimination or fair-lending allegation. */
  readonly fair_lending_allegation?: boolean;
  /** Rule 3(iv): ACDV identifiers do not match ours. */
  readonly identifier_mismatch?: boolean;
  readonly adverse_ai_generated?: boolean;
}
export interface ReviewDecision { readonly required: boolean; readonly approver: "human_agent" | "officer" | null; readonly reasons: string[]; readonly conditions: number[]; readonly fair_lending_log: boolean; }

/** The eight reviewer conditions as code (8.2-T12). The strictest approver wins: any `officer` condition routes to the officer. */
export function requiresHumanReview(r: ReviewInput): ReviewDecision {
  const reasons: string[] = []; const conditions: number[] = []; let officer = false;
  const hit = (n: number, why: string, toOfficer: boolean): void => { conditions.push(n); reasons.push(`(${n}) ${why}`); if (toOfficer) officer = true; };
  if (r.determination === "verified_as_reported" && r.confidence < REVIEW_CONFIDENCE) hit(1, `verified_as_reported with confidence ${r.confidence} < ${REVIEW_CONFIDENCE}`, false);
  if (r.category && OFFICER_CATEGORIES.has(r.category)) hit(2, `category ${r.category}`, true);
  if (r.determination === "deleted_account" || r.determination === "deleted_consumer" || r.reinsertion_or_brr) hit(3, "deletion (DA/DF, ECOA Z) or reinsertion/BRR", true);
  if (r.channel !== "acdv" && (r.determination === "frivolous" || r.out_of_scope)) hit(4, r.repeat_basis ? "direct-dispute frivolous determination on a repeat-dispute basis" : "direct-dispute frivolous/irrelevant or (b) out-of-scope determination", r.repeat_basis === true);
  if (r.context && r.context.length > 0) hit(5, `${r.context.join("/")} context`, true);
  if ((r.disputes_same_item_12m ?? 0) >= 3) hit(6, `${r.disputes_same_item_12m} disputes on the same item within 12 months`, true);
  if (r.pre_boarding_period && r.prior_servicer_records_complete !== true) hit(7, "pre-boarding period with incomplete prior-servicer records", false);
  if (r.fair_lending_allegation) hit(8, "discrimination or fair-lending allegation (19.4 log)", true);
  if (r.identifier_mismatch) { reasons.push("rule 3(iv): consumer identifier mismatch (potential mixed file)"); }
  if (r.determination === "frivolous" && r.channel === "acdv") { reasons.push("an ACDV is never frivolous (guardrail)"); officer = true; }
  return { required: reasons.length > 0, approver: officer ? "officer" : reasons.length > 0 ? "human_agent" : null, reasons, conditions, fair_lending_log: r.fair_lending_allegation === true };
}

/** e-OSCAR status a furnisher must never let a case end in (8.2 guardrail: "never let a due date lapse"; 8.2-T3). */
export const ACDV_NO_RESPONSE_STATUS = "RESOLVED-NORESPONSEPROVIDED";
export const ACDV_SUBMITTED_STATUS = "RESOLVED-SENDINGTOAGENCY";
export const ACDV_RETURNED_STATUS = "RESOLVED-RETURNEDTOAGENCY";
export interface DueDatePlan { readonly escalate_to: "officer" | null; readonly submit_best_available: boolean; readonly determination: Determination; readonly follow_up_correction: boolean; readonly never: typeof ACDV_NO_RESPONSE_STATUS; }
/**
 * 8.2-T3 due-date breach prevention: no reviewer action by 90% of the Response
 * Due Date → the case auto-escalates to `officer`; absent action by the due date
 * the agent submits a best-available response (a modify/delete in the
 * consumer's favour with a follow-up correction) — never RESOLVED-NORESPONSEPROVIDED.
 */
export function dueDatePlan(c: AcdvClocks, today: PlainDate, reviewed: boolean, draft: Determination): DueDatePlan {
  const dueReached = today >= c.response_due;
  const bestAvailable = !reviewed && dueReached;
  const determination: Determination = bestAvailable && draft === "verified_as_reported" ? "modified" : draft;
  return { escalate_to: !reviewed && today >= c.escalate_on ? "officer" : null, submit_best_available: bestAvailable, determination, follow_up_correction: bestAvailable && determination !== draft, never: ACDV_NO_RESPONSE_STATUS };
}
/** 8.2-T1: the case closes only on RESOLVED-RETURNEDTOAGENCY, with the closing CCC scheduled for the next cycle (rule 6). */
export function acdvCaseClose(eoscarStatus: string, determination: Determination, continuingDisagreement = false): { closed: boolean; ccc_next_cycle: Ccc | null; reason: string | null } {
  if (eoscarStatus !== ACDV_RETURNED_STATUS) return { closed: false, ccc_next_cycle: null, reason: `e-OSCAR status ${eoscarStatus}; close requires ${ACDV_RETURNED_STATUS}` };
  return { closed: true, ccc_next_cycle: cccOnClose(determination, continuingDisagreement), reason: null };
}

/** CCC on receipt: XB (rule 6). Whether to AUD depends on distance to the next cycle. */
export function cccOnReceipt(receivedOn: PlainDate, nextCycleTransmitOn: PlainDate): { ccc: Ccc; via: "aud" | "next_cycle" } {
  return { ccc: "XB", via: daysBetween(receivedOn, nextCycleTransmitOn) > 10 ? "aud" : "next_cycle" };
}

/** CCC on close (rule 6). */
export function cccOnClose(d: Determination, continuingDisagreement = false): Ccc {
  if (d === "modified" || d === "deleted_account" || d === "deleted_consumer" || d === "unverifiable") return "XR";
  if (d === "verified_as_reported") return continuingDisagreement ? "XC" : "XH";
  return "XB";
}

export type Bureau = "equifax" | "experian" | "transunion" | "innovis";
export const BUREAUS: readonly Bureau[] = ["equifax", "experian", "transunion", "innovis"];

export interface CorrectionFanOut { readonly aud_to: readonly Bureau[]; readonly aud_due: PlainDate; readonly in_cycle: true; readonly b2_notice_due: PlainDate | null; }

/** Rule 5 / 8.1 rule 12: AUDs to every other bureau within 2 BD; the next cycle still carries the value; B-2 if new negative info. */
export function correctionFanOut(determinedOn: PlainDate, originatingBureau: Bureau | null, addsNegativeInfo: boolean, b1OnFile: boolean, cal: Calendar = servicer): CorrectionFanOut {
  return {
    aud_to: BUREAUS.filter((b) => b !== originatingBureau),
    aud_due: addBusinessDays(determinedOn, 2, cal),
    in_cycle: true,
    b2_notice_due: addsNegativeInfo && !b1OnFile ? addDays(determinedOn, 30) : null,
  };
}

/** Reinsertion of deleted data is never automatic (§1681i(a)(5)(B)). */
export function reinsertionAllowed(evidence: boolean, officerApproved: boolean, certification: boolean): boolean {
  return evidence && officerApproved && certification;
}

/** Rule 3(iii): a pre-boarding item with no substantiation is `unverifiable`. */
export function preBoardingDetermination(transferorRecord: boolean, boardingReconciliation: boolean, substantiated: boolean): Determination {
  if (!transferorRecord && !boardingReconciliation) return "unverifiable";
  return substantiated ? "verified_as_reported" : "modified";
}

/** e-OSCAR adapter guard (8.2-T4): submit is refused until the ACDV has been viewed. */
export class AcdvSubmitGuard {
  private readonly viewed = new Set<string>();
  view(controlNumber: string): void { this.viewed.add(controlNumber); }
  canSubmit(controlNumber: string): boolean { return this.viewed.has(controlNumber); }
}

/** Rule 9: a direct dispute asserting a servicing error is also an NoE. */
export function isAlsoNoe(category: string): boolean {
  return ["misapplied_payment", "wrongful_late_fee", "payment_history", "balance"].includes(category);
}
