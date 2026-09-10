/** §11.5 Imminent default evaluation — D2-1-01 base tests, hardship and credit paths, notice deadlines. */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";

export const RESERVES_LIMIT_CENTS = 2_500_000n, FICO_MAX = 620, FICO_AGE_MAX_DAYS = 90, DOC_AGE_MAX_DAYS = 90, HTI_THRESHOLD = Decimal.parse("0.40"), DELINQUENT_CEILING = 60;
export const HARDSHIP_PATHS: Record<string, "modification" | "liquidation"> = { death_of_borrower_or_wage_earner: "modification", disability_or_illness: "modification", divorce_or_legal_separation: "modification", separation_unmarried: "modification", step_rate_increase_last_12m: "modification", distant_transfer_or_pcs_gt_50mi: "liquidation" };

export function representativeScore(scores: readonly number[]): number { const s = [...scores].sort((a, b) => a - b); return s.length === 1 ? s[0]! : s.length === 2 ? s[0]! : s[Math.floor(s.length / 2)]!; }
export function hti(pitiaCents: Cents, grossMonthlyIncomeCents: Cents): { ratio: Decimal; pass: boolean; display: string } { const r = Decimal.ratio(pitiaCents, grossMonthlyIncomeCents); return { ratio: r, pass: r.cmp(HTI_THRESHOLD) > 0, display: r.toFixed(2) }; }

export interface Evaluation {
  readonly evaluation_date: PlainDate; readonly regx_days_delinquent: number; readonly principal_residence: boolean; readonly brp_complete: boolean; readonly oldest_doc_date: PlainDate;
  readonly cash_reserves_cents: Cents; readonly hardship_type: string | null; readonly hardship_documented: boolean; readonly pcs_distance_miles?: number;
  readonly credit?: { scores: readonly number[]; fico_date: PlainDate; delinquencies_30_in_6m: number; pitia_cents: Cents; gross_income_cents: Cents } | null;
}
export type Result = { outcome: "rerouted_delinquent" } | { outcome: "ineligible"; failed: string[] } | { outcome: "eligible_hardship" | "eligible_credit"; path: "modification" | "liquidation"; tests: Record<string, boolean> };

export function evaluate(e: Evaluation): Result {
  if (e.regx_days_delinquent >= DELINQUENT_CEILING) return { outcome: "rerouted_delinquent" };
  const failed: string[] = []; const tests: Record<string, boolean> = {};
  const pcs = e.hardship_type === "distant_transfer_or_pcs_gt_50mi" && (e.pcs_distance_miles ?? 0) >= 50.0;
  tests.occupancy = e.principal_residence; if (!e.principal_residence && !pcs) failed.push("occupancy");
  tests.brp_complete = e.brp_complete; if (!e.brp_complete) failed.push("brp_complete");
  tests.doc_age = daysBetween(e.oldest_doc_date, e.evaluation_date) <= DOC_AGE_MAX_DAYS; if (!tests.doc_age) failed.push("doc_age_90");
  tests.cash_reserves = e.cash_reserves_cents < RESERVES_LIMIT_CENTS; if (!tests.cash_reserves && !pcs) failed.push("cash_reserves");
  if (failed.length) return { outcome: "ineligible", failed };
  if (e.hardship_type && e.hardship_type in HARDSHIP_PATHS && e.hardship_documented) {
    if (e.hardship_type === "distant_transfer_or_pcs_gt_50mi" && !pcs) return { outcome: "ineligible", failed: ["pcs_distance_lt_50"] };
    return { outcome: "eligible_hardship", path: HARDSHIP_PATHS[e.hardship_type]!, tests };
  }
  if (!e.credit) return { outcome: "ineligible", failed: ["no_hardship_path_no_credit"] };
  const rep = representativeScore(e.credit.scores);
  tests.fico = rep <= FICO_MAX; tests.fico_age = daysBetween(e.credit.fico_date, e.evaluation_date) <= FICO_AGE_MAX_DAYS;
  tests.delinquency = e.credit.delinquencies_30_in_6m >= 2; tests.hti = hti(e.credit.pitia_cents, e.credit.gross_income_cents).pass;
  if (!tests.fico_age) return { outcome: "ineligible", failed: ["FNMA_D2101_FICO_AGE_90"] };
  if (tests.fico && (tests.delinquency || tests.hti)) return { outcome: "eligible_credit", path: "modification", tests };
  return { outcome: "ineligible", failed: [!tests.fico ? "fico_gt_620" : "delinquency_and_hti"] };
}
/** Evaluation Notice due: earlier of decision + 5 days and complete BRP + 30 days; 14-day acceptance window. */
export function noticeDeadlines(decisionOn: PlainDate, brpCompleteOn: PlainDate): { evaluation_notice_due: PlainDate; response_window_days: 14 } { const a = addDays(decisionOn, 5), b = addDays(brpCompleteOn, 30); return { evaluation_notice_due: a < b ? a : b, response_window_days: 14 }; }
/** D2-1-01: no solicitation of a borrower < 30 days delinquent who has not asked for help. */
export function solicitationGate(regxDays: number, borrowerAskedForHelp: boolean): { ok: true } | { ok: false; gate: "FNMA_D2101_NO_SOLICIT_LT30" } { return regxDays >= 30 || borrowerAskedForHelp ? { ok: true } : { ok: false, gate: "FNMA_D2101_NO_SOLICIT_LT30" }; }
