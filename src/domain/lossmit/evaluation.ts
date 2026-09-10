/** §12.2 Complete-application evaluation and §12.3 appeal handling — hierarchy, tiers, deadlines, independence. */
import { type PlainDate, addDays, daysBetween, parts, ymd, addMonths } from "../../kernel/calendar/date.ts";

export type Option = "reinstatement" | "forbearance" | "repayment_plan" | "payment_deferral" | "disaster_payment_deferral" | "flex_mod" | "short_sale" | "mortgage_release" | "military_indulgence" | "qma";
export const HIERARCHY: readonly Option[] = ["reinstatement", "forbearance", "repayment_plan", "payment_deferral", "flex_mod", "short_sale", "mortgage_release"];
export const RETENTION_PATH: readonly Option[] = ["reinstatement", "forbearance", "repayment_plan", "payment_deferral", "flex_mod"];
export const LIQUIDATION_OPTIONS: readonly Option[] = ["short_sale", "mortgage_release"];
/** 12.2 data model `lossmit_option_determinations.result` (the subset the hierarchy walk itself decides). */
export type DeterminationResult = "offered" | "not_eligible" | "not_evaluated_ranking" | "not_requested";
export interface Determination { readonly option: Option; readonly rank: number; readonly result: DeterminationResult; readonly basis: string; }
export interface HierarchyFacts {
  readonly can_reinstate: boolean; readonly hardship_temporary_unresolved: boolean; readonly can_afford_repayment: boolean; readonly deferral_eligible: boolean; readonly flexmod_eligible: boolean;
  /** 12.2 rule 2: a borrower's stated liquidation request is evaluated first; the retention path still runs so every option gets a determination. */
  readonly liquidation_requested?: boolean; readonly liquidation_option?: "short_sale" | "mortgage_release"; readonly liquidation_eligible?: boolean;
}
/**
 * F-2-10 hierarchy walk (12.2 rule 2 / rule 5): every option in `HIERARCHY` gets a determination row. Retention
 * options are tested in order until one is offered; the options behind that offer are `not_evaluated_ranking`
 * (comment 41(d)-1 — the offered option outranks them), the ones tested and failed are `not_eligible`. A stated
 * liquidation request is evaluated first and, if eligible, offered; the retention path then continues in full.
 */
export function hierarchyWalk(f: HierarchyFacts): { offered: Option | null; offers: Option[]; path: Option[]; determinations: Determination[] } {
  const tests: Partial<Record<Option, [boolean, string]>> = {
    reinstatement: [f.can_reinstate, "funds available to reinstate (F-2-10 step a)"], forbearance: [f.hardship_temporary_unresolved, "temporary, unresolved hardship (F-2-10 step b)"],
    repayment_plan: [f.can_afford_repayment, "resolved hardship; can afford a repayment plan (F-2-10 step c; 12.5)"], payment_deferral: [f.deferral_eligible, "resolved hardship; cannot afford a repayment plan; D2-3.2-04 criteria (F-2-10 step d; 12.6)"],
    flex_mod: [f.flexmod_eligible, "permanent hardship or deferral-ineligible; D2-3.2-06 criteria (F-2-10 step e; 12.8)"],
  };
  const requested = f.liquidation_requested ? (f.liquidation_option ?? "short_sale") : null;
  const order: Option[] = requested ? [requested, ...RETENTION_PATH, ...LIQUIDATION_OPTIONS.filter((o) => o !== requested)] : [...HIERARCHY];
  const determinations: Determination[] = []; const offers: Option[] = [];
  let retentionOffered = false;
  for (const option of order) {
    const rank = HIERARCHY.indexOf(option) + 1;
    if (option === requested) { const ok = f.liquidation_eligible !== false; if (ok) offers.push(option); determinations.push({ option, rank, result: ok ? "offered" : "not_eligible", basis: `borrower requested ${option} — evaluated first (F-2-10; 12.2 rule 2)${ok ? "" : "; not eligible on loan data"}` }); continue; }
    const t = tests[option];
    if (t) {
      if (retentionOffered) { determinations.push({ option, rank, result: "not_evaluated_ranking", basis: `${offers[offers.length - 1]} outranks ${option} in the F-2-10 hierarchy (comment 41(d)-1)` }); continue; }
      if (t[0]) { retentionOffered = true; offers.push(option); determinations.push({ option, rank, result: "offered", basis: t[1] }); } else determinations.push({ option, rank, result: "not_eligible", basis: `not ${t[1]}` });
      continue;
    }
    // Liquidation options reached on the retention path: the first is offered only when no retention option was; the second is ranked behind it.
    if (requested) { determinations.push({ option, rank, result: "not_requested", basis: `borrower requested ${requested}; ${option} not requested (F-2-10)` }); continue; }
    if (retentionOffered || offers.length) determinations.push({ option, rank, result: "not_evaluated_ranking", basis: `${offers[0]} outranks ${option} in the F-2-10 hierarchy (comment 41(d)-1)` });
    else { offers.push(option); determinations.push({ option, rank, result: "offered", basis: "retention options exhausted → liquidation (F-2-10)" }); }
  }
  return { offered: offers[0] ?? null, offers, path: order, determinations };
}
export type Tier = "ge_90" | "lt_90" | "le_37";
export function tier(completeOn: PlainDate, saleOn: PlainDate | null): Tier { if (!saleOn) return "ge_90"; const d = daysBetween(completeOn, saleOn); return d >= 90 ? "ge_90" : d > 37 ? "lt_90" : "le_37"; }
/** Deemed-rejection policy grace (12.2 open question 1 / timer rows): 5 days after a 14-day (or NY 30-day) window, 3 days after the 7-day window. */
export function deemedRejectionGraceDays(windowDays: number): 3 | 5 { return windowDays === 7 ? 3 : 5; }
export function evaluationDeadlines(completeOn: PlainDate, providedOn: PlainDate, t: Tier, state?: string): { decision_due: PlainDate; accept_by: PlainDate; window_days: number; grace_days: 3 | 5; appeal_rights: boolean; deemed_rejected_on: PlainDate } {
  // 3 NYCRR 419.7(g) / `NY_419_7G_ACCEPT_30`: the 30-day window applies only at tier ge_90; the 45–90-day tier keeps Reg X's 7 days.
  const days = t === "ge_90" ? (state === "NY" ? 30 : 14) : 7;
  const accept = addDays(providedOn, days); const grace = deemedRejectionGraceDays(days);
  return { decision_due: addDays(completeOn, 30), accept_by: accept, window_days: days, grace_days: grace, appeal_rights: t === "ge_90", deemed_rejected_on: addDays(accept, grace) };
}
export function fnmaNoticeCheck(decisionOn: PlainDate, providedOn: PlainDate): boolean { return daysBetween(decisionOn, providedOn) <= 5; }
/** Ranking reason allowed only when the offered option outranks the denied one. */
export function rankingReasonAllowed(offered: Option, denied: Option): boolean { return HIERARCHY.indexOf(offered) < HIERARCHY.indexOf(denied); }
export function reviewerRequired(d: { denial: boolean; ineligible: boolean; duplicative: boolean; discretionary_c2ii: boolean; reg_b_adverse: boolean }): boolean { return d.denial || d.ineligible || d.duplicative || d.discretionary_c2ii || d.reg_b_adverse; }

// ───── §12.3 appeals ─────
export function appealEligible(t: Tier, firstFilingMadeAtReceipt: boolean, deniedModification: boolean): boolean { return deniedModification && (t === "ge_90" || !firstFilingMadeAtReceipt); }
export function appealWindow(denialProvidedOn: PlainDate, state?: string, postmarkOn?: PlainDate): PlainDate { const base = state === "NY" && postmarkOn ? postmarkOn : denialProvidedOn; return addDays(base, state === "CA" ? 30 : 14); }
export function appealDeadlines(receivedOn: PlainDate, providedOn?: PlainDate, transferOn?: PlainDate): { decision_due: PlainDate; accept_by: PlainDate | null } {
  const base = transferOn && transferOn > receivedOn ? transferOn : receivedOn;
  return { decision_due: addDays(base, 30), accept_by: providedOn ? addDays(providedOn, 14) : null };
}
export function independent(candidateId: string, excluded: readonly string[]): boolean { return !excluded.includes(candidateId); }
/** 15th rule: notice sent on/before the 15th → first trial payment due the 1st of next month; after → the month after. */
export function tppFirstDue(noticeSentOn: PlainDate): PlainDate { const { y, m, d } = parts(noticeSentOn); const next = addMonths(ymd(y, m, 1), d <= 15 ? 1 : 2); return next; }
export function caHolds(denialProvidedOn: PlainDate, appealDenialProvidedOn?: PlainDate): { no_nod_before: PlainDate; after_appeal_denial_before: PlainDate | null } { return { no_nod_before: addDays(denialProvidedOn, 31), after_appeal_denial_before: appealDenialProvidedOn ? addDays(appealDenialProvidedOn, 15) : null }; }
