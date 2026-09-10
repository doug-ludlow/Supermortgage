/**
 * §18.3 STAR performance measurement — per-T-id rule functions layered on ./star.ts (rates, suppression,
 * reconciliation) and ./ops.ts (transferInExclusion, distributionFilter). Pure; bigint-free (the process has no money).
 *
 * Verified sources quoted below: STAR FAQs (Apr. 6, 2026) — "Loans are excluded from the transferor's metrics in the
 * transfer month. Transferred loans are excluded from the transferee's calculations for two months following transfer
 * (except for 6-month Mod and Payment Deferral Performance metrics)." and "STAR Scorecard results are confidential, and
 * a servicer may not disclose STAR Scorecard results to any third parties by any means".
 */
import { type PlainDate, addMonths, plainDate } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { type Metric, confidentialityFilter } from "./star.ts";
import { distributionFilter } from "./ops.ts";

export const STAR_METRICS: readonly Metric[] = ["T60", "C60", "RET_EFF", "MOD6", "PD6", "BEYOND_TF"];
/** Metrics the transferee exclusion does not touch (FAQ: "except for 6-month Mod and Payment Deferral Performance metrics"). */
export const TRANSFEREE_EXEMPT_METRICS: readonly Metric[] = ["MOD6", "PD6"];
/** "two months following transfer" — the transfer month and the next one, counted at month granularity. */
export const TRANSFEREE_EXCLUSION_MONTHS = 2;

const monthOf = (d: PlainDate): string => d.slice(0, 7);
const firstOfMonth = (d: PlainDate): PlainDate => plainDate(`${monthOf(d)}-01`);

/**
 * 18.3-T3 common rule at month granularity: a transferred-in loan is out of every metric but MOD6/PD6 for the transfer
 * month and the month after, whatever the day of transfer; a transferred-out loan is out of everything in the transfer month.
 * (./star.ts includedInMetric compares full dates, which stretches a mid-month transfer-in to three base months.)
 */
export function transfereeIncluded(metric: Metric, baseMonth: PlainDate, transferredIn: PlainDate | null, transferredOut: PlainDate | null = null): boolean {
  if (transferredOut !== null && monthOf(transferredOut) === monthOf(baseMonth)) return false;
  if (transferredIn === null || TRANSFEREE_EXEMPT_METRICS.includes(metric)) return true;
  return monthOf(baseMonth) >= monthOf(addMonths(firstOfMonth(transferredIn), TRANSFEREE_EXCLUSION_MONTHS));
}

export interface TransfereeMonth { readonly base_month: string; readonly excluded_from: Metric[]; readonly included_in: Metric[]; }
export interface TransfereeExclusionWindow {
  readonly transferred_in: PlainDate;
  /** Base months (YYYY-MM) in which the loan is excluded from every metric but MOD6/PD6. */
  readonly excluded_months: string[];
  /** First base month (YYYY-MM) in which the loan counts in all metrics. */
  readonly first_full_month: string;
  readonly excluded_metrics: Metric[];
  readonly always_included: Metric[];
  readonly by_month: TransfereeMonth[];
}
/** 18.3-T3: the schedule for one transfer-in — which metrics the loan is in, month by month, through its first full month. */
export function transfereeExclusionWindow(transferredIn: PlainDate): TransfereeExclusionWindow {
  const start = firstOfMonth(transferredIn);
  const by_month: TransfereeMonth[] = [];
  for (let k = 0; k <= TRANSFEREE_EXCLUSION_MONTHS; k++) {
    const base = addMonths(start, k);
    const included_in = STAR_METRICS.filter((m) => transfereeIncluded(m, base, transferredIn, null));
    by_month.push({ base_month: monthOf(base), excluded_from: STAR_METRICS.filter((m) => !included_in.includes(m)), included_in });
  }
  const excluded_months = by_month.filter((r) => r.excluded_from.length > 0).map((r) => r.base_month);
  return {
    transferred_in: transferredIn,
    excluded_months,
    first_full_month: monthOf(addMonths(start, TRANSFEREE_EXCLUSION_MONTHS)),
    excluded_metrics: STAR_METRICS.filter((m) => !TRANSFEREE_EXEMPT_METRICS.includes(m)),
    always_included: [...TRANSFEREE_EXEMPT_METRICS],
    by_month,
  };
}

// ---------------------------------------------------------------- confidentiality (T9)
export type StarAudience = "vendor" | "marketing" | "partner" | "internal" | "fnma";
export type StarDocumentKind = "newsletter" | "marketing_material" | "partner_report" | "internal_report" | "fnma_inquiry" | "distribution_list";
export const STAR_CONFIDENTIALITY_CITATION = "STAR FAQs (Apr. 6, 2026): \"STAR Scorecard results are confidential, and a servicer may not disclose STAR Scorecard results to any third parties by any means\"";
export interface ConfidentialityRefusal { readonly code: "STAR_CONFIDENTIALITY"; readonly citation: string; readonly matched: string; readonly reason: string; readonly escalation: { kind: "officer"; reason: string } | null; }
export interface ConfidentialityDecision { readonly allowed: boolean; readonly mentions_star_results: boolean; readonly refusal: ConfidentialityRefusal | null; }

const STAR_MENTION = /\bSTAR[- ](?:level|performer|recognition|rating)[^.\n]*|\bSTAR\s+(?:scorecard|results?|rank)[^.\n]*/i;

/**
 * 18.3-T9 guardrail: the confidentiality filter on report distribution. Any third-party-facing draft (vendor newsletter,
 * marketing material) that cites STAR results/standing is blocked; the partner only under the subservicing-agreement
 * confidentiality clause; internal and Fannie Mae-facing text passes. Recognition may travel only inside Fannie Mae's own
 * marketing package (`fnma_marketing_package`), never in Supermortgage's or a vendor's material.
 */
export function confidentialityGate(i: { audience: StarAudience; kind: StarDocumentKind; text: string; partner_confidentiality_clause?: boolean; fnma_marketing_package?: boolean }): ConfidentialityDecision {
  const matched = STAR_MENTION.exec(i.text)?.[0]?.trim() ?? (confidentialityFilter(i.text) ? "STAR" : null);
  if (matched === null) return { allowed: true, mentions_star_results: false, refusal: null };
  if (i.fnma_marketing_package === true && /recognition|top three|performer/i.test(i.text)) return { allowed: true, mentions_star_results: true, refusal: null };
  const f = distributionFilter({ audience: i.audience, text: i.text, ...(i.partner_confidentiality_clause !== undefined ? { partner_confidentiality_clause: i.partner_confidentiality_clause } : {}) });
  if (!f.blocked) return { allowed: true, mentions_star_results: true, refusal: null };
  const third_party = i.audience === "vendor" || i.audience === "marketing";
  return {
    allowed: false,
    mentions_star_results: true,
    refusal: {
      code: "STAR_CONFIDENTIALITY",
      citation: STAR_CONFIDENTIALITY_CITATION,
      matched,
      reason: `${i.kind} for ${i.audience} cites "${matched}" — ${f.reason ?? "STAR results may not be disclosed"}`,
      escalation: third_party ? { kind: "officer", reason: `third-party ${i.kind} draft cited STAR results; blocked by the confidentiality filter` } : null,
    },
  };
}

/** Distribution-list screen: every recipient outside internal/fnma (and the partner without the clause) is dropped from a STAR-bearing report. */
export function screenDistributionList(i: { text: string; recipients: readonly { id: string; audience: StarAudience }[]; partner_confidentiality_clause?: boolean }): { allowed: { id: string; audience: StarAudience }[]; dropped: { id: string; audience: StarAudience; reason: string }[] } {
  const allowed: { id: string; audience: StarAudience }[] = []; const dropped: { id: string; audience: StarAudience; reason: string }[] = [];
  for (const r of i.recipients) {
    const d = confidentialityGate({ audience: r.audience, kind: "distribution_list", text: i.text, ...(i.partner_confidentiality_clause !== undefined ? { partner_confidentiality_clause: i.partner_confidentiality_clause } : {}) });
    if (d.allowed) allowed.push({ id: r.id, audience: r.audience }); else dropped.push({ id: r.id, audience: r.audience, reason: d.refusal!.reason });
  }
  return { allowed, dropped };
}

// ---------------------------------------------------------------- partner report (SM_STAR_PARTNER_REPORT_MONTHLY)
export const STAR_PARTNER_REPORT_TEMPLATE = "STAR-RPT-MONTHLY-v1";
/** Timer row: `star.reconciled` (reconciled_at) → partner report delivered within 5 business days; satisfied by `star.partner_report.delivered`; sev-3. */
export function partnerReportClock(i: { reconciled_at: PlainDate; carries_star_data: boolean; cal?: Calendar }): { code: "SM_STAR_PARTNER_REPORT_MONTHLY"; anchor: PlainDate; due: PlainDate; satisfied_by: "star.partner_report.delivered"; breach: "sev3"; template: typeof STAR_PARTNER_REPORT_TEMPLATE; officer_signoff_required: boolean } {
  return { code: "SM_STAR_PARTNER_REPORT_MONTHLY", anchor: i.reconciled_at, due: addBusinessDays(i.reconciled_at, 5, i.cal ?? servicer), satisfied_by: "star.partner_report.delivered", breach: "sev3", template: STAR_PARTNER_REPORT_TEMPLATE, officer_signoff_required: i.carries_star_data };
}
/** Release gate for the partner report: STAR-bearing reports need the confidentiality clause and `officer` sign-off before `star.partner_report.delivered` may be emitted. */
export function partnerReportRelease(i: { carries_star_data: boolean; partner_confidentiality_clause: boolean; officer_signoff: { officer_id: string; signed_at: string } | null }): { allowed: boolean; refusal: { code: "STAR_CONFIDENTIALITY" | "OFFICER_SIGNOFF_REQUIRED"; reason: string } | null; event: "star.partner_report.delivered" | null } {
  if (!i.carries_star_data) return { allowed: true, refusal: null, event: "star.partner_report.delivered" };
  if (!i.partner_confidentiality_clause) return { allowed: false, refusal: { code: "STAR_CONFIDENTIALITY", reason: "partner report carries STAR data but the subservicing agreement has no confidentiality clause covering STAR Scorecard sharing" }, event: null };
  if (i.officer_signoff === null) return { allowed: false, refusal: { code: "OFFICER_SIGNOFF_REQUIRED", reason: "partner report carrying STAR data needs officer sign-off under the confidentiality clause" }, event: null };
  return { allowed: true, refusal: null, event: "star.partner_report.delivered" };
}
