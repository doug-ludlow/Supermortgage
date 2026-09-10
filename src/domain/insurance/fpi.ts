/**
 * 9.2–9.4 Force-placed insurance — reasonable basis, track selection, escrow
 * guard, LPI coverage/deductible, the §1024.37 notice clocks, reminder
 * variants and renewal timing.
 */
import { type PlainDate, addDays, addYears, daysBetween, max as maxDate } from "../../kernel/calendar/date.ts";
import { type Calendar, businessDaysBetween, federal } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Deficiency } from "./hazard.ts";
import { isLpiCurable } from "./hazard.ts";
import { dailyRate, type LpiTerm } from "./refund.ts";

export type BasisKind = "carrier_cancellation" | "carrier_nonrenewal" | "vendor_expiration_no_renewal" | "borrower_statement" | "evidence_rejected" | "insufficient_coverage";
export type FpiTrack = "regx_hazard" | "fdpa_flood";
export type InsuranceType = "hazard" | "wind" | "flood";

export function reasonableBasis(kind: BasisKind, deficiency?: Deficiency): boolean {
  if (kind === "insufficient_coverage") return deficiency !== undefined && isLpiCurable(deficiency);
  return true;
}

export function selectTrack(type: InsuranceType): FpiTrack { return type === "flood" ? "fdpa_flood" : "regx_hazard"; }

export type EscrowGuard = "proceed" | "servicer_pays" | "k5_blocked" | "k5_inability_documented";

/**
 * Rule 3 — escrowed loans ≤ 30 days delinquent never see FPI; > 30 days runs the §1024.17(k)(5) gate.
 * Inability to disburse exists only with a reasonable basis to believe the policy was cancelled/not renewed
 * "for reasons other than nonpayment of premium charges" or the property is vacant (comment 17(k)(5)(ii)(A)-1).
 */
export function escrowGuard(escrowed: boolean, regxDaysDelinquent: number, cancellationReason: "nonpayment" | "underwriting" | "other" | null, vacant = false): EscrowGuard {
  if (!escrowed) return "proceed";
  if (regxDaysDelinquent <= 30) return "servicer_pays";
  if (vacant) return "k5_inability_documented";
  return cancellationReason === "nonpayment" || cancellationReason === null ? "k5_blocked" : "k5_inability_documented";
}

/** B-6-01 deductible tiers for LPI property policies: coverage < $100,000 → $1,000; $100,000–$250,000 → $2,000; > $250,000 → $2,500 (worked: $250,000.00 → $2,000; $250,000.01 → $2,500). Flood and wind/hail-only LPI are excluded from the tiers. */
export function tierDeductible(coverage: Cents): Cents {
  if (coverage < 10_000_000n) return 100_000n;
  if (coverage <= 25_000_000n) return 200_000n;
  return 250_000n;
}

export interface LpiCoverageInput { readonly last_known_cents: Cents | null; readonly rcv_cents: Cents; readonly upb_cents: Cents; readonly state_cap_cents: Cents | null; readonly vacant?: boolean; }

/** Rule 4 — coverage = min(last known if within ±15% of RCV else RCV, state cap); never below UPB unless RCV < UPB. */
export function lpiCoverage(i: LpiCoverageInput): { coverage_cents: Cents; deductible_cents: Cents; basis: string } {
  let cov = i.rcv_cents, basis = "rcv";
  if (i.last_known_cents !== null && !i.vacant) {
    const diff = i.last_known_cents > i.rcv_cents ? i.last_known_cents - i.rcv_cents : i.rcv_cents - i.last_known_cents;
    if (diff * 100n <= i.rcv_cents * 15n) { cov = i.last_known_cents; basis = "last_known_within_15pct"; }
  }
  if (cov > i.rcv_cents) { cov = i.rcv_cents; basis = "rcv_over_insurance_cap"; }     // B-2-01: never above replacement value
  if (cov < i.upb_cents && i.rcv_cents >= i.upb_cents) { cov = i.upb_cents; basis = "upb_floor"; }
  if (i.state_cap_cents !== null && cov > i.state_cap_cents) { cov = i.state_cap_cents; basis = "state_cap"; }
  return { coverage_cents: cov, deductible_cents: tierDeductible(cov), basis };
}

/** Premium from a rate table: coverage × rate% (round-half-up at the end). */
export function premiumFromRate(coverage: Cents, ratePct: string): Cents {
  return Decimal.fromBigInt(coverage).mul(Decimal.parse(ratePct).div(Decimal.fromInt(100))).toScaledInt(0, "HALF_UP");
}

export interface FpiClocks {
  readonly t0: PlainDate;                       // first notice mailed
  readonly reminder_not_before: PlainDate;      // t0 + 30
  readonly t1: PlainDate | null;                // reminder mailed
  readonly earliest_charge: PlainDate;          // max(t0+45, t1+15)
  readonly evidence_window_end: PlainDate;      // = earliest_charge; evidence on that day counts
}

/** Rule 6 / 9.3 rule 3. */
export function fpiClocks(t0: PlainDate, t1: PlainDate | null): FpiClocks {
  const base = addDays(t0, 45);
  const charge = t1 === null ? base : maxDate(base, addDays(t1, 15));
  return { t0, reminder_not_before: addDays(t0, 30), t1, earliest_charge: charge, evidence_window_end: charge };
}

export function reminderAllowed(clocks: FpiClocks, on: PlainDate): boolean { return on >= clocks.reminder_not_before; }

export type ChargeDecision = { readonly allowed: false; readonly reason: string } | { readonly allowed: true; readonly effective: PlainDate; readonly expiration: PlainDate };

/** Charge only after both gates and no continuous-coverage evidence by the window end; coverage is retroactive to the lapse. */
export function chargeDecision(clocks: FpiClocks, on: PlainDate, evidenceReceivedOn: PlainDate | null, lapseStart: PlainDate): ChargeDecision {
  if (clocks.t1 === null) return { allowed: false, reason: "REMINDER_NOT_MAILED" };
  if (on < clocks.earliest_charge) return { allowed: false, reason: `REGX_1024_37C_FPI_FIRST_NOTICE_45 open until ${clocks.earliest_charge}` };
  if (evidenceReceivedOn !== null && evidenceReceivedOn <= clocks.evidence_window_end) return { allowed: false, reason: "closed_evidence" };
  return { allowed: true, effective: lapseStart, expiration: addYears(lapseStart, 1) };
}

/** §1024.37(d)(5) / 9.3 rule 5 — a notice produced more than 5 federal business days before mailing must be regenerated. */
export function productionWindowOk(producedOn: PlainDate, mailedOn: PlainDate, cal: Calendar = federal): boolean {
  return businessDaysBetween(producedOn, mailedOn, cal) <= 5;
}

/** Rule 5 content assembly: first notices always say "will purchase"; wind gaps name windstorm. */
export interface NoticeContent { readonly condition: "is expiring" | "expired" | "provides insufficient coverage"; readonly purchase_phrase: "will purchase"; readonly insurance_type: "hazard" | "windstorm"; readonly extra_content_allowed: readonly string[]; }
export function firstNoticeContent(kind: "expiring" | "expired" | "insufficient", type: InsuranceType): NoticeContent {
  return {
    condition: kind === "expiring" ? "is expiring" : kind === "expired" ? "expired" : "provides insufficient coverage",
    purchase_phrase: "will purchase", insurance_type: type === "wind" ? "windstorm" : "hazard", extra_content_allowed: ["account_number"],
  };
}

// ---- (c)(4) / (d)(4) / (e)(4): nothing but the required content and the account number on the notice pages ----

export type NoticeStage = "first" | "reminder" | "renewal";
export type ParagraphKind = "required" | "account_number" | "other";
/** A rendered paragraph (block) of a notice — classified from its text; a pre-classified `kind` is accepted for callers that already know. */
export interface NoticeParagraph { readonly id?: string; readonly text?: string; readonly kind?: ParagraphKind; }
export interface NoticeChecklistResult { readonly ok: boolean; readonly violations: readonly string[]; readonly extra: readonly { readonly paragraph: string; readonly sentence: string }[]; }

const MONTHS = "(January|February|March|April|May|June|July|August|September|October|November|December)";
/**
 * Sentences the §1024.37(c)(2)/(d)(2)/(e)(2) items produce in the MS-3 family — each pattern is anchored to the whole
 * model-form sentence as this platform's templates print it (src/notices/authored/section9-2.ts, section09.ts), so a
 * sentence that merely contains a trigger word ("immediately", "contact us at", "estimate", "within N days") is extra
 * content: (c)(4) permits nothing beyond the (c)(2) items and the account number.
 */
const REQUIRED_SENTENCES: readonly RegExp[] = [
  new RegExp(`^${MONTHS} \\d{1,2}, \\d{4}$`, "i"),                                                        // (i) date
  /^subject: (second and final )?notice about .*insurance.* — please (provide|update) (the )?insurance information for /i,   // subject line naming the notice (model forms)
  /^from: supermortgage, /i, /^to: [^,]+, /i,                                                             // (ii)/(iii) servicer / borrower name and mailing address
  /^dear [^:]+: our records show that your .*insurance (is expiring|expired|provides insufficient coverage) on .*, and we do not have evidence that you have had .*insurance on the property listed above since then$/i,   // (v)(A)–(B)
  /^the type of (hazard )?insurance for which we do not have evidence is /i,                              // (v)(C) — comment 37(c)(2)(v)-1 (windstorm)
  /^(if you had .*insurance for the period\(s\) stated above, )?you must immediately provide us with (your |updated )?.*insurance information for the property at:?$/i,   // (iv) request (address follows in its own block)
  /^property: /i,                                                                                         // (iv) physical address
  /^because .*insurance is required on your property, we (will purchase insurance on your property at your expense|intend to maintain insurance on your property by renewing or replacing the insurance we bought)$/i,   // (vi) / (e)(2)(vi)(B)
  /^you must pay us for any period during which the insurance we buy is in effect but you do not have insurance$/i,   // (vi) model-form sentence
  /^the insurance we buy may cost significantly more than insurance you can buy yourself and may not provide as much coverage as an insurance policy you buy yourself$/i,   // (ix)(A)–(B)
  /^(to avoid being charged( for those period\(s\))?, |if you buy your own insurance, )?please provide the information promptly, and in writing: send a declarations page, certificate or policy showing continuous coverage to .*, or upload it through your borrower portal$/i,   // (vii)/(viii)
  /^if you have any questions, (please )?contact us at \(\d{3}\) \d{3}-\d{4}$/i,                          // (x)
  /^please review the additional information enclosed (in the same (envelope|transmittal)|with this (letter|notice))$/i,   // (xi)
  /^supermortgage · \(\d{3}\) \d{3}-\d{4} · .* · send insurance information to /i,                       // footer: servicer name, phone, address, how to provide ((ii)/(viii)/(x))
];
const REMINDER_SENTENCES: readonly RegExp[] = [
  /^this is the second and final notice$/i,                                                                // (d)(2)(i)(B)
  /^the insurance we buy will cost \$[\d,]+\.\d{2} annually( \(an estimate\))?$/i,                        // (d)(2)(i)(D) (+ the estimate label, comment 37(d)(2)(i)(D)-1)
  /^dear [^:]+: we received the insurance information you provided$/i,                                    // (d)(2)(ii)(C)
  /^however, we are unable to verify that you had .*insurance on the property listed above for the following period\(s\): /i,   // (d)(2)(ii)(D)
  /^you will be charged for insurance we purchased for any period during which we cannot verify that you had .*insurance$/i,   // (d)(2)(ii)(E)
];
const RENEWAL_SENTENCES: readonly RegExp[] = [
  /^dear [^:]+: because we did not have evidence that you had .*insurance on the property listed above, we previously purchased insurance on your property at your expense, effective /i,   // (e)(2)(v)
  /^the insurance we bought (expired|is expiring|will expire) on /i,                                       // (e)(2)(vi)(A)
  /^the insurance we buy will cost \$[\d,]+\.\d{2} annually( \(an estimate\))?$/i,                        // (e)(2)(vii)(C)
];

export function noticeSentenceKind(sentence: string, stage: NoticeStage = "first"): ParagraphKind {
  const s = sentence.trim().replace(/[.!]$/, "");
  if (s === "") return "required";
  if (/^loan number ending \d{4}$/i.test(s) || /^(account|loan) (number|no\.?):? ?(ending )?[\d\-x]+$/i.test(s)) return "account_number";
  const allowed = [...REQUIRED_SENTENCES, ...(stage === "reminder" ? REMINDER_SENTENCES : stage === "renewal" ? RENEWAL_SENTENCES : [])];
  return allowed.some((re) => re.test(s)) ? "required" : "other";
}

function sentences(text: string): string[] {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * (c)(4): "a servicer may not include any information other than information required by paragraph (c)(2) … except for the
 * borrower's mortgage loan account number" ((d)(4), (e)(4) likewise). Every sentence on the notice pages must be one the
 * required items produce; an estimated premium on the first notice, a marketing paragraph, an agent list — anything
 * else — fails the render. Inserts belong on separate sheets in the same transmittal.
 */
export function noticeChecklist(paragraphs: readonly NoticeParagraph[], stage: NoticeStage = "first"): NoticeChecklistResult {
  const extra: { paragraph: string; sentence: string }[] = [];
  paragraphs.forEach((p, idx) => {
    const id = p.id ?? String(idx);
    if (p.text === undefined) { if (p.kind === "other") extra.push({ paragraph: id, sentence: "" }); return; }
    for (const s of sentences(p.text)) if (noticeSentenceKind(s, stage) === "other") extra.push({ paragraph: id, sentence: s });
  });
  const para = stage === "first" ? "(c)(4)" : stage === "reminder" ? "(d)(4)" : "(e)(4)";
  const offending = [...new Set(extra.map((e) => e.paragraph))];
  return { ok: extra.length === 0, violations: offending.map(() => `extra_content_${para}`), extra };
}

/** Bold-format check over rendered blocks: every pattern must appear inside a bold block ((c)(3), (d)(3), (e)(3)). */
export function boldItemsPresent(blocks: readonly { readonly bold: boolean; readonly text: string }[], required: readonly RegExp[]): { ok: boolean; missing: string[] } {
  const boldText = blocks.filter((b) => b.bold).map((b) => b.text).join(" ");
  const missing = required.filter((re) => !re.test(boldText)).map((re) => re.source);
  return { ok: missing.length === 0, missing };
}

// ---- 9.3 reminder ------------------------------------------------------------

export interface EvidenceRow { readonly received_on: PlainDate; readonly effective: PlainDate; readonly expiration: PlainDate | null; readonly written: boolean; }
export interface ReminderVariant { readonly variant: "b_no_info" | "c_insufficient"; readonly gaps: readonly { readonly from: PlainDate; readonly to: PlainDate }[]; }

/** Rule 1 — no written evidence → MS-3(B); evidence leaving gaps from lapse_start → MS-3(C) with [Date Range]s (end exclusive → printed as the day before). */
export function reminderVariant(evidence: readonly EvidenceRow[], lapseStart: PlainDate, asOf: PlainDate): ReminderVariant {
  const written = evidence.filter((e) => e.written).sort((a, b) => (a.effective < b.effective ? -1 : 1));
  if (written.length === 0) return { variant: "b_no_info", gaps: [{ from: lapseStart, to: asOf }] };
  const gaps: { from: PlainDate; to: PlainDate }[] = [];
  let cursor = lapseStart;
  for (const e of written) {
    if (e.effective > cursor) gaps.push({ from: cursor, to: addDays(e.effective, -1) });
    const end = e.expiration ?? asOf;
    if (end > cursor) cursor = end;
  }
  if (cursor < asOf) gaps.push({ from: cursor, to: asOf });
  return gaps.length === 0 ? { variant: "c_insufficient", gaps: [] } : { variant: "c_insufficient", gaps };
}

export interface PremiumQuote { readonly annual_premium_cents: Cents; readonly is_estimate: boolean; readonly basis: string; }
export function premiumQuote(carrierQuote: Cents | null, coverage: Cents, tableRatePct: string): PremiumQuote {
  if (carrierQuote !== null) return { annual_premium_cents: carrierQuote, is_estimate: false, basis: "carrier_quote" };
  return { annual_premium_cents: premiumFromRate(coverage, tableRatePct), is_estimate: true, basis: `rate_table ${tableRatePct}%` };
}

// ---- 9.4 renewal ---------------------------------------------------------------

export interface RenewalClocks { readonly anniversary: PlainDate; readonly notice_target: PlainDate; readonly chargeable: PlainDate | null; readonly charge_on: PlainDate | null; }

/** Rule 2 — renewal charge = max(A, t2 + 45); coverage renews on A regardless. */
export function renewalClocks(placementEffective: PlainDate, t2: PlainDate | null): RenewalClocks {
  const a = addYears(placementEffective, 1);
  const chargeable = t2 === null ? null : addDays(t2, 45);                     // §1024.37(e)(1)(i) gate
  return { anniversary: a, notice_target: addDays(a, -60), chargeable, charge_on: chargeable === null ? null : maxDate(a, chargeable) };
}

/** The renewal charge is refused until the MS-3(D) has been mailed and max(A, t2 + 45) has arrived. */
export function renewalChargeAllowed(clocks: RenewalClocks, on: PlainDate): { allowed: boolean; reason: string | null } {
  if (clocks.charge_on === null) return { allowed: false, reason: "RENEWAL_NOTICE_NOT_MAILED" };
  return on >= clocks.charge_on ? { allowed: true, reason: null } : { allowed: false, reason: `REGX_1024_37E_FPI_RENEWAL_NOTICE_45 open until ${clocks.charge_on}` };
}

export interface RenewalCharge { readonly clocks: RenewalClocks; readonly term: LpiTerm; readonly amount_cents: Cents; readonly is_estimate: boolean; readonly daily_rate: Decimal; readonly charge_on: PlainDate | null; }

/** Rule 2 — the renewal premium (quote or rate-table estimate) is charged on max(A, t2 + 45) for the term A → A + 1 year; its daily rate feeds 9.4 rule 4 gap charges and 9.5 refunds. */
export function renewalCharge(placementEffective: PlainDate, t2: PlainDate | null, quote: PremiumQuote): RenewalCharge {
  const clocks = renewalClocks(placementEffective, t2);
  const term: LpiTerm = { effective: clocks.anniversary, expiration: addYears(clocks.anniversary, 1), premium_cents: quote.annual_premium_cents };
  return { clocks, term, amount_cents: quote.annual_premium_cents, is_estimate: quote.is_estimate, daily_rate: dailyRate(term), charge_on: clocks.charge_on };
}

/** (e)(5) — one MS-3(D) per anniversary: refuse a second notice within 365 days for the same anniversary. */
export function renewalNoticeAllowed(last: { mailed: PlainDate; anniversary: PlainDate } | null, targetAnniversary: PlainDate, on: PlainDate): boolean {
  if (last === null) return true;
  return daysBetween(last.mailed, on) >= 365 || last.anniversary !== targetAnniversary;
}

/** Rule 4 — prompt gap charge where state law permits, else a new 9.2 cycle. */
export function gapChargeDecision(gapDays: number, dailyRateCents: Decimal, statePromptChargeProhibited: boolean): { action: "prompt_charge"; cents: Cents } | { action: "new_cycle" } {
  if (statePromptChargeProhibited) return { action: "new_cycle" };
  return { action: "prompt_charge", cents: dailyRateCents.mul(Decimal.fromInt(gapDays)).toScaledInt(0, "HALF_UP") };
}
