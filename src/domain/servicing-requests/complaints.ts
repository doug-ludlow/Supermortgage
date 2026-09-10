/** §4.5 Complaint handling / UDAAP — clocks, triage, population remediation. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
export function cfpbDeadlines(receivedOn: PlainDate): { response_by: PlainDate; final_by: PlainDate } { return { response_by: addDays(receivedOn, 15), final_by: addDays(receivedOn, 60) }; }
export function emailReplyDeadlineMs(receivedMs: number): number { return receivedMs + 48 * 3_600_000; }
export function nyDeadlines(receivedOn: PlainDate, foreclosureRelated: boolean): { ack_by: PlainDate; response_by: PlainDate } { return { ack_by: addBusinessDays(receivedOn, 5, servicer), response_by: addBusinessDays(receivedOn, foreclosureRelated ? 15 : 30, servicer) }; }
export function triage(f: { text: string; complaints_90d: number; channel: "written" | "oral" }): { severity: "critical" | "standard"; repeat: boolean; opens_noe: boolean; script_1024_38b5: boolean } {
  const critical = /sale (is )?(tomorrow|imminent|scheduled)|discriminat|servicemember|military|disaster|threat|abuse|regulator|media/i.test(f.text);
  const noeSubstance = /fee|charge|misapplied|payment|escrow|payoff|foreclos|modification|error/i.test(f.text);
  return { severity: critical ? "critical" : "standard", repeat: f.complaints_90d >= 2, opens_noe: f.channel === "written" && noeSubstance, script_1024_38b5: f.channel === "oral" && noeSubstance };
}
export function populationRemediation(loans: number, perLoanCents: Cents): { total_cents: Cents; officer_approval: true; steps: string[] } { return { total_cents: BigInt(loans) * perLoanCents, officer_approval: true, steps: ["reverse with original assessment dates", "NTC_REMEDIATION_REFUND", "Metro 2 corrections", "partner notification", "15.2 claim corrections"] }; }
export function udaapScreen(f: { injury: boolean; avoidable: boolean; misleading_material: boolean; unreasonable_advantage: boolean }): { unfair: boolean; deceptive: boolean; abusive: boolean } { return { unfair: f.injury && !f.avoidable, deceptive: f.misleading_material, abusive: f.unreasonable_advantage }; }
