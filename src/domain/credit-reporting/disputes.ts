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

/** Reviewer conditions (8.2-T12): confidence below the threshold, or any listed condition, waits for a human. */
export const REVIEW_CONFIDENCE = 0.8;
export interface ReviewInput { readonly determination: Determination; readonly confidence: number; readonly identifier_mismatch?: boolean; readonly pre_boarding_period?: boolean; readonly adverse_ai_generated?: boolean; }

export function requiresHumanReview(r: ReviewInput): { required: boolean; approver: "human_agent" | "officer" | null; reasons: string[] } {
  const reasons: string[] = [];
  if (r.confidence < REVIEW_CONFIDENCE) reasons.push(`confidence ${r.confidence} < ${REVIEW_CONFIDENCE}`);
  if (r.identifier_mismatch) reasons.push("consumer identifier mismatch");
  if (r.determination === "frivolous") reasons.push("frivolous determinations are human-made");
  const officer = r.determination === "deleted_account" || r.determination === "deleted_consumer";
  if (officer) reasons.push("delete codes require officer approval");
  return { required: reasons.length > 0, approver: officer ? "officer" : reasons.length > 0 ? "human_agent" : null, reasons };
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
