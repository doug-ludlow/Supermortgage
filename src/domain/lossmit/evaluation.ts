/** §12.2 Complete-application evaluation and §12.3 appeal handling — hierarchy, tiers, deadlines, independence. */
import { type PlainDate, addDays, daysBetween, parts, ymd, addMonths } from "../../kernel/calendar/date.ts";

export type Option = "reinstatement" | "forbearance" | "repayment_plan" | "payment_deferral" | "disaster_payment_deferral" | "flex_mod" | "short_sale" | "mortgage_release" | "military_indulgence" | "qma";
export const HIERARCHY: readonly Option[] = ["reinstatement", "forbearance", "repayment_plan", "payment_deferral", "flex_mod", "short_sale", "mortgage_release"];
/** F-2-10 hierarchy walk. */
export function hierarchyWalk(f: { can_reinstate: boolean; hardship_temporary_unresolved: boolean; can_afford_repayment: boolean; deferral_eligible: boolean; flexmod_eligible: boolean; liquidation_requested?: boolean }): { offered: Option | null; path: Option[] } {
  const path: Option[] = [];
  if (f.can_reinstate) { path.push("reinstatement"); return { offered: "reinstatement", path }; }
  if (f.hardship_temporary_unresolved) { path.push("forbearance"); return { offered: "forbearance", path }; }
  path.push("repayment_plan"); if (f.can_afford_repayment) return { offered: "repayment_plan", path };
  path.push("payment_deferral"); if (f.deferral_eligible) return { offered: "payment_deferral", path };
  path.push("flex_mod"); if (f.flexmod_eligible) return { offered: "flex_mod", path };
  path.push("short_sale", "mortgage_release"); return { offered: "short_sale", path };
}
export type Tier = "ge_90" | "lt_90" | "le_37";
export function tier(completeOn: PlainDate, saleOn: PlainDate | null): Tier { if (!saleOn) return "ge_90"; const d = daysBetween(completeOn, saleOn); return d >= 90 ? "ge_90" : d > 37 ? "lt_90" : "le_37"; }
export function evaluationDeadlines(completeOn: PlainDate, providedOn: PlainDate, t: Tier, state?: string): { decision_due: PlainDate; accept_by: PlainDate; appeal_rights: boolean; deemed_rejected_on: PlainDate } {
  const days = state === "NY" ? 30 : t === "ge_90" ? 14 : 7;
  const accept = addDays(providedOn, days);
  return { decision_due: addDays(completeOn, 30), accept_by: accept, appeal_rights: t === "ge_90", deemed_rejected_on: addDays(accept, 5) };
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
