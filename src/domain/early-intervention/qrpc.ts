/** §11.3 Quality Right Party Contact — D2-2-01 completeness, reason mapping and hardship extraction, promise-to-pay, staleness. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import { cessationReasonFor, type CommitmentKind } from "./plan.ts";
export type { CommitmentKind };

export interface Conversation {
  readonly verified_party: "borrower" | "coborrower" | "authorized_third_party" | "unverified";
  readonly reason_primary?: string | null; readonly hardship_nature?: string | null;
  readonly occupancy_status?: string | null;
  readonly ability_to_pay?: { can_resume_full_payment_on?: PlainDate | null; stated_surplus_cents?: Cents | null; commitment_kind?: string | null } | null;
  readonly options_explained?: readonly string[] | null; readonly options_not_appropriate_reason?: string | null;
  readonly commitment_kind?: CommitmentKind | null;
  readonly payment_importance_emphasized?: boolean;
}
export function qrpcCompleteness(c: Conversation): { complete: boolean; missing: string[] } {
  const m: string[] = [];
  if (c.verified_party === "unverified") m.push("verified_party");
  if (!c.reason_primary) m.push("reason");
  if (!c.occupancy_status) m.push("occupancy");
  if (!c.ability_to_pay || !(c.ability_to_pay.can_resume_full_payment_on || c.ability_to_pay.stated_surplus_cents != null || c.ability_to_pay.commitment_kind)) m.push("ability_to_pay");
  if (!(c.options_explained && c.options_explained.length) && !c.options_not_appropriate_reason) m.push("options");
  if (!c.commitment_kind || c.commitment_kind === "callback_only") m.push("commitment");
  if (!c.payment_importance_emphasized) m.push("payment_importance");
  return { complete: m.length === 0, missing: m };
}
/** 11.3 rule 1: the next attempt targets the elements still missing (T2). */
export function nextAttemptTargets(missing: readonly string[]): readonly string[] { return missing.filter((x) => x !== "verified_party" && x !== "payment_importance"); }

export const REASON_MAP: Record<string, string> = { unemployment: "016", reduction_in_income: "006", increase_in_expenses: "007", excessive_obligations: "007", death_of_borrower: "001", death_of_borrower_or_wage_earner: "001", death_of_family_member: "004", disability_or_illness: "002", disability_or_illness_borrower: "002", disability_or_illness_family: "003", divorce_or_separation: "005", separation_unmarried: "005", distant_employment_transfer: "009", business_failure: "017", disaster: "019", disaster_casualty: "019", disaster_property_problem: "011", property_problem: "011", inability_to_sell: "012", inability_to_sell_or_rent: "012", inability_to_rent: "013", military_service: "014", incarceration: "INC", payment_dispute: "027", servicing_problem: "023", other: "015", declined: "015" };
export function reasonCode(reason: string): string { return REASON_MAP[reason] ?? "015"; }

// ---- hardship extraction (11.3 design item 4; T3) ------------------------------------------
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const REASON_PATTERNS: readonly [RegExp, string][] = [
  [/\b(lost|losing|laid off|let go|fired|no longer have|out of)\b.{0,20}\b(job|work|employment)\b|\bunemploy|\blaid off\b|\blost my job\b/i, "unemployment"],
  [/\b(hours|pay|income|salary|wages|overtime)\b.{0,30}\b(cut|reduced|dropped|down|less|lower|decreas)/i, "reduction_in_income"],
  [/\b(passed away|died|death|funeral)\b/i, "death_of_borrower_or_wage_earner"],
  [/\b(sick|ill|illness|hospital|surgery|disab|medical|cancer|injur)/i, "disability_or_illness"],
  [/\b(divorce|separat)/i, "divorce_or_separation"],
  [/\b(hurricane|flood|tornado|wildfire|fire|storm|earthquake|disaster)\b/i, "disaster"],
  [/\b(transfer|relocat|pcs orders|moved for work)\b/i, "distant_employment_transfer"],
  [/\b(business|store|shop)\b.{0,20}\b(closed|failed|folded|went under)\b/i, "business_failure"],
  [/\b(deploy|active duty|military)\b/i, "military_service"],
  [/\b(jail|prison|incarcerat)/i, "incarceration"],
  [/\b(expenses|bills|child care|daycare|tuition)\b.{0,30}\b(up|went up|increased|higher|more)\b/i, "increase_in_expenses"],
  [/\b(rather not say|don'?t want to say|decline|prefer not)\b/i, "declined"],
];
export interface HardshipExtraction { readonly reason_primary: string; readonly fnma_reason_code: string; readonly hardship_started_on: PlainDate | null; readonly hardship_nature: "temporary" | "permanent" | "unknown"; readonly reason_narrative: string; readonly evidence_span: string; }
/**
 * Structured extractor over the borrower's own words: reason taxonomy (Form 710), F-1-21 code, the month the hardship
 * started ("in October" → the most recent October on or before the conversation, day unknown → the 1st), and the
 * temporary/permanent nature from the borrower's statement ("unknown" when not stated — never a QRPC blocker).
 */
export function extractHardship(narrative: string, spokenOn: PlainDate, o: { evidence_span?: string } = {}): HardshipExtraction {
  const text = narrative.trim();
  const reason = REASON_PATTERNS.find(([re]) => re.test(text))?.[1] ?? "other";
  let started: PlainDate | null = null;
  const m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/i.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1; const { y, m: cm } = parts(spokenOn);
    const year = m[2] ? Number(m[2]) : month <= cm ? y : y - 1;
    started = ymd(year, month, 1);
  } else { const ago = /\b(\d+)\s+(week|month|day)s?\s+ago\b/i.exec(text); if (ago) started = addDays(spokenOn, -Number(ago[1]) * (ago[2]!.toLowerCase() === "week" ? 7 : ago[2]!.toLowerCase() === "month" ? 30 : 1)); }
  const nature: HardshipExtraction["hardship_nature"] = /\b(permanent|for good|never|retired|disabled permanently|won'?t be able)\b/i.test(text) ? "permanent" : /\b(temporar|for now|until|back to work|new job|start(ing)? (work|a job)|couple of months|few months|short[- ]term)\b/i.test(text) ? "temporary" : "unknown";
  return { reason_primary: reason, fnma_reason_code: reasonCode(reason), hardship_started_on: started, hardship_nature: nature, reason_narrative: text.slice(0, 500), evidence_span: o.evidence_span ?? "transcript" };
}

/** Comment 39(a)-4 / 11.3-T9: a full payment promised by a date makes the options pitch not appropriate — recorded, not skipped. */
export function optionsDetermination(i: { commitment: CommitmentKind; promised_full_by?: PlainDate | null; options_explained?: readonly string[] }): { required: boolean; determination: string; options_explained: readonly string[] } {
  if ((i.commitment === "promise_to_pay_full" || i.commitment === "promise_to_pay") && i.promised_full_by) return { required: false, determination: "not_appropriate:full_payment_promised", options_explained: [] };
  return { required: true, determination: (i.options_explained?.length ?? 0) > 0 ? "explained" : "required", options_explained: i.options_explained ?? [] };
}

/** D2-2-02: a cadence-ceasing promise covers the full delinquent amount and is due within 30 days. */
export function promiseToPay(promisedCents: Cents, dueOn: PlainDate, recordedOn: PlainDate, totalDelinquentCents: Cents): { valid: boolean; covers: "full" | "partial"; within_30: boolean; plan: "ceased{ptp_pending}" | "active"; next_attempt_on?: PlainDate } {
  const within = daysBetween(recordedOn, dueOn) <= 30 && dueOn >= recordedOn;
  const full = promisedCents >= totalDelinquentCents;
  if (full && within) return { valid: true, covers: "full", within_30: within, plan: "ceased{ptp_pending}" };
  return { valid: false, covers: full ? "full" : "partial", within_30: within, plan: "active", next_attempt_on: addDays(dueOn, 1) };
}
export function promiseOutcome(paidCents: Cents, promisedCents: Cents): "kept" | "partial" | "broken" { return paidCents >= promisedCents ? "kept" : paidCents > 0n ? "partial" : "broken"; }

/** The `FNMA_D2202_CESSATION_ON_QRPC` outcome for a captured commitment, in the evaluator's vocabulary. */
export function cessationOnQrpc(commitment: CommitmentKind, o: { promise_valid?: boolean } = {}): { plan_status: "qrpc_workout" | "qrpc_no_interest" | "ptp_pending" | "active"; commitment_kind: CommitmentKind } {
  const r = cessationReasonFor(commitment, o);
  return { plan_status: r === "qrpc_workout" || r === "qrpc_no_interest" || r === "ptp_pending" ? r : "active", commitment_kind: commitment };
}

export const STALE_DAYS = 30;
/** `SM_QRPC_STALE_30`: anchor `achieved_at`, offset +30 calendar days — the QRPC is stale on day 30 (2026-12-11 → 2027-01-10). */
export function isStale(achievedOn: PlainDate, today: PlainDate, resolved: boolean): boolean { return !resolved && daysBetween(achievedOn, today) >= STALE_DAYS; }
export function qrpcStaleness(i: { achieved_on: PlainDate; today: PlainDate; resolution_status: "none" | "ptp_pending" | "workout_in_progress" | "resolved"; promise_broken?: boolean }): { timer: "SM_QRPC_STALE_30"; stale_on: PlainDate; stale: boolean; qrpc_age_days: number; plan_action: "re_activated" | "none"; resume_trigger: "qrpc_stale" | null; pre_referral_review: { latest_qrpc_on: PlainDate; qrpc_age_days: number; shows: string } } {
  const age = daysBetween(i.achieved_on, i.today);
  const unresolved = i.resolution_status === "none" || (i.resolution_status === "ptp_pending" && i.promise_broken === true);
  const stale = unresolved && age >= STALE_DAYS;
  return { timer: "SM_QRPC_STALE_30", stale_on: addDays(i.achieved_on, STALE_DAYS), stale, qrpc_age_days: age, plan_action: stale ? "re_activated" : "none", resume_trigger: stale ? "qrpc_stale" : null,
    pre_referral_review: { latest_qrpc_on: i.achieved_on, qrpc_age_days: age, shows: age >= STALE_DAYS ? "QRPC age 30+ days" : `QRPC age ${age} days` } };
}
export function thirdPartyAuthorization(kind: "written" | "oral_three_way", on: PlainDate): { scope: "discuss_only" | "full"; expires_on: PlainDate | null } { return kind === "oral_three_way" ? { scope: "discuss_only", expires_on: addDays(on, 90) } : { scope: "full", expires_on: null }; }
