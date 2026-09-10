/** §4.5 Complaint handling / UDAAP — clocks, triage, population remediation. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
export function cfpbDeadlines(receivedOn: PlainDate): { response_by: PlainDate; final_by: PlainDate } { return { response_by: addDays(receivedOn, 15), final_by: addDays(receivedOn, 60) }; }
export function emailReplyDeadlineMs(receivedMs: number): number { return receivedMs + 48 * 3_600_000; }
/** 3 NYCRR 419.6 complaint categories: 30 BD / 15 BD or before the sale (foreclosure-related) / 7 BD (payoff); +7 BD extension (30-day category only). */
export type NyComplaintCategory = "standard" | "foreclosure" | "payoff";
export interface NyComplaintFacts { readonly category: NyComplaintCategory; readonly sale_on?: PlainDate | null; }
/**
 * NY 419.6 clocks (servicer business days): acknowledgment 5 BD; response 30 BD, or for a foreclosure-related complaint the
 * earlier of 15 BD and the day before the sale, or 7 BD for a payoff dispute — the computed anchor `ny_response_due` of
 * NY_419_6_COMPLAINT_RESPONSE_30BD. A boolean is the foreclosure-related flag (no sale date known).
 */
export function nyDeadlines(receivedOn: PlainDate, foreclosureRelated: boolean | NyComplaintFacts): { ack_by: PlainDate; response_by: PlainDate; extendable: boolean } {
  const f: NyComplaintFacts = typeof foreclosureRelated === "boolean" ? { category: foreclosureRelated ? "foreclosure" : "standard" } : foreclosureRelated;
  const ack_by = addBusinessDays(receivedOn, 5, servicer);
  if (f.category === "payoff") return { ack_by, response_by: addBusinessDays(receivedOn, 7, servicer), extendable: false };
  if (f.category === "foreclosure") { const bd = addBusinessDays(receivedOn, 15, servicer); const beforeSale = f.sale_on ? addDays(f.sale_on, -1) : null; return { ack_by, response_by: beforeSale && beforeSale < bd ? beforeSale : bd, extendable: false }; }
  return { ack_by, response_by: addBusinessDays(receivedOn, 30, servicer), extendable: true };
}
/** 419.6 extension: +7 servicer BD, 30-day category only (NY_419_6_COMPLAINT_RESPONSE_30BD `_EXT_7BD`). */
export function nyComplaintExtension(d: { response_by: PlainDate; extendable: boolean }): PlainDate | { error: "EXTENSION_NOT_PERMITTED" } { return d.extendable ? addBusinessDays(d.response_by, 7, servicer) : { error: "EXTENSION_NOT_PERMITTED" }; }
export function triage(f: { text: string; complaints_90d: number; channel: "written" | "oral" }): { severity: "critical" | "standard"; repeat: boolean; opens_noe: boolean; script_1024_38b5: boolean } {
  // Rule 2: `severity=critical` for foreclosure-sale-imminent, discrimination (any protected basis), servicemember, disaster, safety/abuse, media/regulator.
  const critical = /sale (is )?(tomorrow|imminent|scheduled)|discriminat|national origin|because (of|I am|I'm) (my |a |an )?(race|religion|sex|gender|age|disabilit|familial|handicap|color|ethnic)|servicemember|active duty|military|disaster|threat|abuse|regulator|media/i.test(f.text);
  const noeSubstance = /fee|charge|misapplied|payment|escrow|payoff|foreclos|modification|error/i.test(f.text);
  return { severity: critical ? "critical" : "standard", repeat: f.complaints_90d >= 2, opens_noe: f.channel === "written" && noeSubstance, script_1024_38b5: f.channel === "oral" && noeSubstance };
}
/** 4.5 (Texas): a letter on a §50(a)(6) loan alleging a failure to comply with Tex. Const. art. XVI §50(a)(6) — the Form 20 / 60-day-cure trigger (`complaint.tx_50a6_defect.alleged`). */
export function tx50a6Allegation(text: string): boolean { return /50\s*\(\s*a\s*\)\s*\(\s*6\s*\)|(constitution|constitutional)[^.]{0,80}(defect|violat|fail|comply|home equity)|home[- ]equity[^.]{0,80}(constitution|defect|cap|violat)/i.test(text); }
export function populationRemediation(loans: number, perLoanCents: Cents): { total_cents: Cents; officer_approval: true; steps: string[] } { return { total_cents: BigInt(loans) * perLoanCents, officer_approval: true, steps: ["reverse with original assessment dates", "NTC_REMEDIATION_REFUND", "Metro 2 corrections", "partner notification", "15.2 claim corrections"] }; }
export function udaapScreen(f: { injury: boolean; avoidable: boolean; misleading_material: boolean; unreasonable_advantage: boolean }): { unfair: boolean; deceptive: boolean; abusive: boolean } { return { unfair: f.injury && !f.avoidable, deceptive: f.misleading_material, abusive: f.unreasonable_advantage }; }
/** 4.5 rule 6 / T6: the `FEE_COMPLAINTS_PER_1000` monitor — three complaints about the same undisclosed fee in a month open a `udaap_review` with the lookback query. */
export function feeComplaintMonitor(f: { complaints: readonly { fee_code: string; channel: string; received_on: PlainDate }[]; month: string; fee_code: string; channel: string; lookback_months?: number }): { opens_udaap_review: boolean; matching: number; lookback_months: number; criteria: string } {
  const matching = f.complaints.filter((c) => c.fee_code === f.fee_code && c.channel === f.channel && c.received_on.startsWith(f.month)).length;
  const lookback = f.lookback_months ?? 24;
  return { opens_udaap_review: matching >= 3, matching, lookback_months: lookback, criteria: `fee_code = '${f.fee_code}' AND channel = '${f.channel}' AND assessed_on >= now() - interval '${lookback} months'` };
}
