/**
 * §18.7 operating rules over the eligibility calculator (./networth.ts): the BD5 GL-close
 * deadline and the stale run that blocks the quarterly certification (T7), the warning and
 * breach clocks the status ladder arms (T2, T3), the $50B large-servicer crossing (T6), the
 * Form 1002 / 1002A `submitted` transitions and the officer certification (T5, T8), the
 * capital/liquidity plan and material-change notice of a large seller/servicer, the one-loan
 * rule (T9), the partner UPB report clock, the CSBS prudential-standards applicability test and
 * the agent guardrails (hashed GL sources, sourced liquidity classification, no GL adjustments,
 * officer-only certification). Pure functions: bigint cents, PlainDate strings, calendars from
 * src/kernel/calendar. Nothing here touches GL balances (guardrail).
 *
 * Corrections to the shared calculator (./networth.ts is read-only for this process):
 *   - `declineTriggers` compares exactly in bigint and fires the two-quarter trigger only on a
 *     decline of *more than* 40% (A4-1-01: "by more than 40% over two-consecutive quarterly
 *     reporting periods"); networth.ts fires it at exactly 40.00%.
 *   - `form1002Clock` warns on the spec's warning day (day 20 / day 40); networth.ts's
 *     `form1002Due` warns at due − 10 for every quarter, so the December 31 filing warned on
 *     day 50 (2027-02-19) instead of day 40 (2027-02-09).
 *   - `eligibilityTest` adds rule 7's third clause (projected next-quarter position from the
 *     boarding pipeline), which the calculator does not model.
 */
import { type PlainDate, addDays, addMonths, addYears, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { netWorth, capitalPlanDue, form1002Due, form1002SubmittedAllowed, type NetWorthInput, type NetWorthResult } from "./networth.ts";
import { monthlyEligibilityRun, sha256, type QcEscalation } from "./ops.ts";

/** Events the 18.7 process emits; timers-18-7.ts names the same strings as timer satisfaction / triggers. */
export const ELIG_EVENTS = {
  gl_close_completed: "gl.close.completed{entity, period}",
  /** `computed → officer_certified`: satisfies FHFA_ELIG_QUARTERLY_TEST. */
  computed_certified: "eligibility.computed{quarter present, certified_by_officer_id present}",
  warning: "eligibility.threshold.warning",
  breach: "eligibility.breach.detected",
  breach_notified: "eligibility.breach.notified{partner=true, officer=true}",
  remediation_plan_approved: "eligibility.remediation_plan.approved{approved_by=board}",
  form1002_submitted: "filing.submitted{form=form_1002}",
  /** Quarterly (Mar/Jun/Sep) Form 1002 with WebMB confirmation and CEO/CFO certification: FNMA_A4102_FORM1002_Q_30. */
  form1002_q_submitted: "filing.submitted{form=form_1002, quarter∈{1, 2, 3}, webmb_confirmation present, ceo_cfo_certification present}",
  /** December 31 Form 1002: FNMA_A4102_FORM1002_YE_60. */
  form1002_ye_submitted: "filing.submitted{form=form_1002, quarter=4, webmb_confirmation present, ceo_cfo_certification present}",
  form1002a_submitted: "filing.submitted{form=form_1002a, webmb_confirmation present}",
  capliq_plan_submitted: "filing.submitted{form=capliq_plan}",
  /** Spec events list: `material_change.detected{decline_trigger}` — arms FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD (large only). */
  material_change_detected: "material_change.detected{large_servicer=true}",
  material_change_notified: "fnma.notified{kind=eligibility_material_change}",
  partner_upb_report_delivered: "partner.upb_report.delivered{template=ELIG-UPB-PARTNER-M-v1}",
  csbs_applicability_recorded: "csbs.prudential_applicability.recorded",
} as const;

/** A4-1-01: "$50 billion or more in residential first lien mortgage servicing UPB plus other servicing UPB". */
export const LARGE_SERVICER_THRESHOLD_CENTS: Cents = 5_000_000_000_000n;
/** Edge case: ratings lead time 6–12 months → warning at $40B. */
export const LARGE_SERVICER_WARNING_CENTS: Cents = 4_000_000_000_000n;

/** Calendar quarter-end: the last day of March, June, September or December. */
export function isQuarterEnd(period_end: PlainDate): boolean {
  return period_end === endOfMonth(period_end) && parts(period_end).m % 3 === 0;
}
/** Calendar quarter (1–4) of a quarter-end date. */
export function quarterOf(quarter_end: PlainDate): 1 | 2 | 3 | 4 { return (Math.ceil(parts(quarter_end).m / 3)) as 1 | 2 | 3 | 4; }

/** Schedule `eligibility.compute.monthly`: BD5 after month-end (the registry's "BD5" offset counts `business_days_fannie_et`). */
export function glCloseDeadline(period_end: PlainDate, cal: Calendar = fannieEt): PlainDate {
  return addBusinessDays(period_end, 5, cal);
}

// ---------------------------------------------------------------------------------------------------------------------
// Guardrails: "the agent never adjusts GL balances; every input is a hashed source document; classification of an asset
// as 'eligible security' or 'unrestricted cash' requires a source (custodial statement, facility agreement) or it is
// excluded; certifications are CEO/CFO acts (`officer`)."
// ---------------------------------------------------------------------------------------------------------------------
export interface SourceDocument { readonly id: string; readonly sha256: string | null }
export interface GlSnapshotIntake {
  readonly accepted: boolean;
  readonly refusal_code: "NEVER_ADJUST_GL" | "UNHASHED_SOURCE" | null;
  readonly refusal: string | null;
  readonly source_document_ids: readonly string[];
  /** Decision-record `inputs_hash`: sha256 over the sorted `id:sha256` pairs, null when refused. */
  readonly inputs_hash: string | null;
}
/** GL snapshot intake: every input is a hashed source document; the agent never adjusts GL balances (GL-side entries live in the accounting system). */
export function glSnapshotIntake(i: { entity: "supermortgage" | "partner"; period_end: PlainDate; source_documents: readonly SourceDocument[]; adjustments?: readonly { account: string; cents: Cents }[] }): GlSnapshotIntake {
  const ids = i.source_documents.map((d) => d.id);
  if ((i.adjustments ?? []).length > 0) return { accepted: false, refusal_code: "NEVER_ADJUST_GL", refusal: `GL snapshot for ${i.entity} ${i.period_end} refused: the agent never adjusts GL balances (${(i.adjustments ?? []).map((a) => a.account).join(", ")}) — GL-side entries live in the accounting system`, source_document_ids: ids, inputs_hash: null };
  const unhashed = i.source_documents.filter((d) => !d.sha256).map((d) => d.id);
  if (i.source_documents.length === 0 || unhashed.length > 0) return { accepted: false, refusal_code: "UNHASHED_SOURCE", refusal: `GL snapshot for ${i.entity} ${i.period_end} refused: every input is a hashed source document (${unhashed.length ? `no hash for ${unhashed.join(", ")}` : "no source documents"})`, source_document_ids: ids, inputs_hash: null };
  const hash = sha256([...i.source_documents].map((d) => `${d.id}:${d.sha256}`).sort().join("\n"));
  return { accepted: true, refusal_code: null, refusal: null, source_document_ids: ids, inputs_hash: hash };
}

export interface SourcedAmount { readonly item: string; readonly cents: Cents; readonly source_document_id: string | null }
export interface SecurityHolding extends SourcedAmount {
  readonly kind: "agency_mbs" | "gse_obligation" | "treasury" | "corporate" | "equity" | "other";
  readonly unpledged: boolean;
  readonly investment_grade: boolean;
}
export interface AdvanceLine { readonly item: string; readonly committed: Cents; readonly drawn: Cents; readonly facility_agreement_id: string | null; readonly covenant_breached: boolean }
export interface LiquidityClassification {
  readonly cash_unrestricted: Cents;
  readonly eligible_securities: Cents;
  readonly advance_line_committed: Cents;
  readonly advance_line_drawn: Cents;
  readonly excluded: readonly { readonly item: string; readonly cents: Cents; readonly reason: string }[];
}
const ELIGIBLE_SECURITY_KINDS: readonly SecurityHolding["kind"][] = ["agency_mbs", "gse_obligation", "treasury"];
/**
 * Rule 4 / guardrail: allowable liquidity is "unrestricted cash and cash equivalents; unpledged … investment grade securities
 * limited to" agency MBS, GSE obligations and U.S. Treasuries, and "50% of the unused portion of committed servicing advance
 * lines of credit" — each item needs a source (custodial statement, facility agreement) or it is excluded; committed-but-
 * unavailable lines (covenant breach) are excluded.
 */
export function classifyLiquidity(i: { cash: readonly SourcedAmount[]; securities: readonly SecurityHolding[]; advance_lines: readonly AdvanceLine[] }): LiquidityClassification {
  const excluded: { item: string; cents: Cents; reason: string }[] = [];
  let cash = 0n, sec = 0n, committed = 0n, drawn = 0n;
  for (const c of i.cash) {
    if (!c.source_document_id) excluded.push({ item: c.item, cents: c.cents, reason: "unrestricted cash requires a custodial/bank statement source" });
    else cash += c.cents;
  }
  for (const s of i.securities) {
    if (!s.source_document_id) excluded.push({ item: s.item, cents: s.cents, reason: "eligible security requires a custodial statement source" });
    else if (!ELIGIBLE_SECURITY_KINDS.includes(s.kind)) excluded.push({ item: s.item, cents: s.cents, reason: "securities limited to Fannie Mae/Freddie Mac/Ginnie Mae MBS, GSE obligations and U.S. Treasuries (A4-1-01)" });
    else if (!s.unpledged) excluded.push({ item: s.item, cents: s.cents, reason: "pledged security is not allowable liquidity (A4-1-01: unpledged)" });
    else if (!s.investment_grade) excluded.push({ item: s.item, cents: s.cents, reason: "security is not investment grade (A4-1-01)" });
    else sec += s.cents;
  }
  for (const l of i.advance_lines) {
    if (!l.facility_agreement_id) excluded.push({ item: l.item, cents: l.committed - l.drawn, reason: "committed servicing advance line requires the facility agreement" });
    else if (l.covenant_breached) excluded.push({ item: l.item, cents: l.committed - l.drawn, reason: "committed-but-unavailable line (covenant breach) is excluded from allowable liquidity" });
    else { committed += l.committed; drawn += l.drawn; }
  }
  return { cash_unrestricted: cash, eligible_securities: sec, advance_line_committed: committed, advance_line_drawn: drawn, excluded };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules 6–7 corrections over ./networth.ts
// ---------------------------------------------------------------------------------------------------------------------
export interface DeclineFlags { readonly q_over_q_25: boolean; readonly two_q_40: boolean; readonly losses_4q_30: boolean }
/**
 * Rule 6 / A4-1-01 material decline triggers, compared exactly in bigint: Adjusted Net Worth decline of "25% over a
 * quarterly reporting period" (25% or more), "by more than 40% over two-consecutive quarterly reporting periods" (strictly
 * more than 40%), or "Four or more consecutive quarterly losses accompanied by a decline … of 30% or more".
 */
export function declineTriggers(i: { anw: Cents; prior_anw?: Cents | null; two_quarters_back_anw?: Cents | null; four_quarters_back_anw?: Cents | null; consecutive_loss_quarters?: number }): DeclineFlags {
  const atLeast = (then: Cents | null | undefined, pct: bigint) => then !== null && then !== undefined && then > 0n && (then - i.anw) * 100n >= then * pct;
  const moreThan = (then: Cents | null | undefined, pct: bigint) => then !== null && then !== undefined && then > 0n && (then - i.anw) * 100n > then * pct;
  return { q_over_q_25: atLeast(i.prior_anw, 25n), two_q_40: moreThan(i.two_quarters_back_anw, 40n), losses_4q_30: (i.consecutive_loss_quarters ?? 0) >= 4 && atLeast(i.four_quarters_back_anw, 30n) };
}

/** UPB expected to board next quarter, by class (Section 5 boarding pipeline). */
export interface BoardingPipeline { readonly ent_ss_sa_upb: Cents; readonly ent_aa_upb: Cents; readonly gnma_upb: Cents; readonly other_upb: Cents }
export interface ProjectedPosition {
  readonly projected: NetWorthResult;
  /** Rule 7: "projected next-quarter position (UPB growth per boarding pipeline) would breach". */
  readonly would_breach: boolean;
  readonly reason: string | null;
}
/** Rule 7, third clause: re-run the requirement side with next quarter's UPB (current + pipeline) against today's ANW and liquidity. */
export function projectedNextQuarter(i: NetWorthInput, pipeline: BoardingPipeline): ProjectedPosition {
  const projected = netWorth({ ...i, ent_ss_sa_upb: i.ent_ss_sa_upb + pipeline.ent_ss_sa_upb, ent_aa_upb: i.ent_aa_upb + pipeline.ent_aa_upb, gnma_upb: i.gnma_upb + pipeline.gnma_upb, other_upb: i.other_upb + pipeline.other_upb, prior_anw: null, two_quarters_back_anw: null, four_quarters_back_anw: null, consecutive_loss_quarters: 0 });
  const reason = projected.nw_surplus < 0n ? "projected next-quarter nw_surplus < 0 (boarding pipeline)" : projected.liquidity_surplus < 0n ? "projected next-quarter liquidity_surplus < 0 (boarding pipeline)" : null;
  return { projected, would_breach: reason !== null, reason };
}

export interface EligibilityTestInput extends NetWorthInput { readonly pipeline?: BoardingPipeline | null }
export interface EligibilityResult extends NetWorthResult {
  readonly decline_flags: DeclineFlags;
  readonly projected: ProjectedPosition | null;
  /** Which rule put the entity in its status band (null when compliant). */
  readonly reason: string | null;
}
/**
 * Rules 1–7 with the corrections above: the calculator's components, exact decline triggers, and the status ladder
 * `compliant → warning → breach`. Warning band per docs/AUDIT-NOTES.md 18.7: surplus below 25% of the requirement or of
 * ANW (worked example 2: $800k is 32% of the $2.5M requirement and 24.24% of the $3.3M ANW), liquidity surplus below 25%
 * of the requirement, or a projected next-quarter breach from the boarding pipeline.
 */
export function eligibilityTest(i: EligibilityTestInput): EligibilityResult {
  const r = netWorth(i);
  const flags = declineTriggers({ anw: r.anw, prior_anw: i.prior_anw ?? null, two_quarters_back_anw: i.two_quarters_back_anw ?? null, four_quarters_back_anw: i.four_quarters_back_anw ?? null, consecutive_loss_quarters: i.consecutive_loss_quarters ?? 0 });
  const projected = i.pipeline ? projectedNextQuarter(i, i.pipeline) : null;
  const reason = flags.q_over_q_25 ? "decline_flags.q_over_q_25" : flags.two_q_40 ? "decline_flags.two_q_40" : flags.losses_4q_30 ? "decline_flags.losses_4q_30"
    : r.nw_surplus < 0n ? "nw_surplus < 0" : r.liquidity_surplus < 0n ? "liquidity_surplus < 0" : r.ratio_bps < 600 ? "ratio_bps < 600"
    : r.nw_surplus * 4n < r.req_nw ? "nw_surplus < 25% of req_nw" : r.nw_surplus * 4n < r.anw ? "nw_surplus < 25% of anw" : r.liquidity_surplus * 4n < r.required_liquidity ? "liquidity_surplus < 25% of req_liq"
    : projected?.would_breach ? projected.reason : null;
  const status: NetWorthResult["status"] = reason === null ? "compliant" : /^decline_flags|< 0$|ratio_bps < 600/.test(reason) ? "breach" : "warning";
  return { ...r, decline_flags: flags, projected, reason, status };
}

export interface StaleGlRun {
  readonly period_end: PlainDate;
  readonly bd5: PlainDate;
  readonly quarter_end: boolean;
  /** Integration rule: "failure → compute with the prior close flagged `stale`". */
  readonly stale: boolean;
  readonly flags: readonly ("stale")[];
  readonly computed_on: { readonly basis: "fresh_close" | "prior_close"; readonly period_end: PlainDate | null };
  /** "quarterly certification blocked until a fresh close" — monthly (non-quarter) runs carry no certification. */
  readonly certification_allowed: boolean;
  readonly refusal: string | null;
  /** Next state of the §18.7 state machine the run may enter. */
  readonly next_state: "officer_certified" | "reported_to_partner" | "computed";
  /** The event that clears the flag and re-runs the computation, or null when the close is fresh. */
  readonly awaiting: string | null;
}
/**
 * T7: a GL close missing at BD5 computes on the prior close flagged `stale`; at quarter-end the
 * certification (`computed → officer_certified`) cannot proceed until `gl.close.completed` for the period.
 */
export function staleGlRun(i: { period_end: PlainDate; gl_close: { period_end: PlainDate; received_on: PlainDate } | null; run_on?: PlainDate; cal?: Calendar }): StaleGlRun {
  const bd5 = glCloseDeadline(i.period_end, i.cal ?? fannieEt);
  const quarter_end = isQuarterEnd(i.period_end);
  const run = monthlyEligibilityRun({ period_end: i.period_end, bd5, today: i.run_on ?? bd5, gl_close: i.gl_close, quarter_end });
  const next_state: StaleGlRun["next_state"] = quarter_end ? (run.certification_allowed ? "officer_certified" : "computed") : "reported_to_partner";
  return {
    period_end: i.period_end, bd5, quarter_end, stale: run.stale, flags: run.stale ? ["stale"] : [], computed_on: run.computed_on,
    certification_allowed: run.certification_allowed, refusal: run.refusal, next_state, awaiting: run.stale ? ELIG_EVENTS.gl_close_completed : null,
  };
}

/** Edge case: quarter-end UPB not final — re-run on finalization; certification waits if the difference exceeds 0.5% of UPB. */
export function upbFinalization(i: { reconciled_upb: Cents; final_upb: Cents }): { rerun: boolean; difference: Cents; certification_waits: boolean } {
  const diff = i.final_upb - i.reconciled_upb;
  const abs = diff < 0n ? -diff : diff;
  // 0.5% = 5 / 1,000 of the final UPB.
  return { rerun: diff !== 0n, difference: diff, certification_waits: abs * 1_000n > i.final_upb * 5n };
}

export interface OfficerCertification {
  readonly allowed: boolean;
  readonly refusal: string | null;
  readonly state: "officer_certified" | "computed";
  readonly certified_by_officer_id: string | null;
  /** Satisfies FHFA_ELIG_QUARTERLY_TEST (`eligibility.computed{quarter present, certified_by_officer_id present}`). */
  readonly event: { readonly type: "eligibility.computed"; readonly payload: { readonly entity: "supermortgage" | "partner"; readonly quarter: 1 | 2 | 3 | 4; readonly period_end: PlainDate; readonly status: NetWorthResult["status"]; readonly certified_by_officer_id: string; readonly certified_on: PlainDate; readonly config_version: string } } | null;
  readonly timer: { readonly code: "FHFA_ELIG_QUARTERLY_TEST"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: string };
}
/**
 * State machine `computed → officer_certified` (Eligibility Certification ELIG-CERT-Q-v1): certifications are CEO/CFO acts
 * (`officer`) — the agent cannot certify; a stale run (T7) cannot be certified; only quarter-ends are certified.
 */
export function officerCertify(i: { entity: "supermortgage" | "partner"; period_end: PlainDate; status: NetWorthResult["status"]; stale: boolean; certified_by: { role: string; id: string }; certified_on: PlainDate; config_version?: string; cal?: Calendar }): OfficerCertification {
  const timer = { code: "FHFA_ELIG_QUARTERLY_TEST" as const, anchor: i.period_end, due: addBusinessDays(i.period_end, 10, i.cal ?? fannieEt), satisfied_by: ELIG_EVENTS.computed_certified };
  const refuse = (why: string): OfficerCertification => ({ allowed: false, refusal: `eligibility certification for ${i.entity} ${i.period_end} refused: ${why}`, state: "computed", certified_by_officer_id: null, event: null, timer });
  if (!isQuarterEnd(i.period_end)) return refuse("only the quarterly (quarter-end) result is certified; monthly runs are reported to the partner");
  if (i.certified_by.role !== "officer") return refuse(`certifications are CEO/CFO acts (officer); ${i.certified_by.role} ${i.certified_by.id} cannot certify`);
  if (i.stale) return refuse("result is stale — quarterly certification blocked until a fresh GL close");
  return {
    allowed: true, refusal: null, state: "officer_certified", certified_by_officer_id: i.certified_by.id,
    event: { type: "eligibility.computed", payload: { entity: i.entity, quarter: quarterOf(i.period_end), period_end: i.period_end, status: i.status, certified_by_officer_id: i.certified_by.id, certified_on: i.certified_on, config_version: i.config_version ?? "2026.1" } },
    timer,
  };
}

export interface WarningOutcome {
  readonly status: "warning";
  readonly timer: { readonly code: "SM_ELIG_WARNING_REMEDIATION_30"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: string };
  readonly escalations: readonly QcEscalation[];
  /** Arms SM_ELIG_WARNING_REMEDIATION_30 (anchor `detected_on`); section18-7.ts `eligibility.compute` appends it with the entity and period. */
  readonly event: { readonly type: "eligibility.threshold.warning"; readonly payload: { readonly detected_on: PlainDate; readonly reason: string; readonly remediation_plan_due: PlainDate } };
}
/** T2 / rule 7: `warning` → board-approved remediation plan within 30 calendar days of detection (sev-2). */
export function warningDetected(i: { detected_on: PlainDate; reason: string }): WarningOutcome {
  const due = addDays(i.detected_on, 30);
  return {
    status: "warning",
    timer: { code: "SM_ELIG_WARNING_REMEDIATION_30", anchor: i.detected_on, due, satisfied_by: ELIG_EVENTS.remediation_plan_approved },
    escalations: [{ kind: "officer", severity: "sev2", reason: `eligibility warning (${i.reason}): board-approved remediation plan due ${due}`, due }],
    event: { type: "eligibility.threshold.warning", payload: { detected_on: i.detected_on, reason: i.reason, remediation_plan_due: due } },
  };
}

export interface BreachOutcome {
  readonly status: "breach";
  readonly notices: readonly { readonly to: "partner" | "officer" | "fannie_mae"; readonly kind: string; readonly due: PlainDate; readonly citation: string }[];
  readonly timer: { readonly code: "SM_ELIG_BREACH_NOTIFY_1BD"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: string };
  /** Hand-off to 18.4: Fannie Mae notice as a "material adverse change" within 5 BD (A4-1-02). */
  readonly fnma_handoff: { readonly process: "18.4"; readonly kind: "material_adverse_change"; readonly due: PlainDate };
  readonly escalations: readonly QcEscalation[];
  /** Arms SM_ELIG_BREACH_NOTIFY_1BD (anchor `detected_on`); section18-7.ts `eligibility.compute` appends it with the entity and period. */
  readonly event: { readonly type: "eligibility.breach.detected"; readonly payload: { readonly detected_on: PlainDate; readonly trigger: string; readonly notify_by: PlainDate; readonly fnma_notice_by: PlainDate } };
}
/** T3 / worked example 3: `breach` → partner + officer notified within 1 BD; Fannie Mae within 5 BD as a material adverse change (18.4). */
export function breachDetected(i: { detected_on: PlainDate; trigger: string; cal?: Calendar }): BreachOutcome {
  const cal = i.cal ?? servicer;
  const bd1 = addBusinessDays(i.detected_on, 1, cal);
  const bd5 = addBusinessDays(i.detected_on, 5, cal);
  return {
    status: "breach",
    notices: [
      { to: "partner", kind: "eligibility_breach", due: bd1, citation: "subservicing agreement; §18.7 SM_ELIG_BREACH_NOTIFY_1BD" },
      { to: "officer", kind: "eligibility_breach", due: bd1, citation: "§18.7 SM_ELIG_BREACH_NOTIFY_1BD" },
      { to: "fannie_mae", kind: "material_adverse_change", due: bd5, citation: "Selling Guide A4-1-02 (18.4)" },
    ],
    timer: { code: "SM_ELIG_BREACH_NOTIFY_1BD", anchor: i.detected_on, due: bd1, satisfied_by: ELIG_EVENTS.breach_notified },
    fnma_handoff: { process: "18.4", kind: "material_adverse_change", due: bd5 },
    escalations: [{ kind: "officer", severity: "sev1", reason: `eligibility breach (${i.trigger}): partner and officer notice due ${bd1}; Fannie Mae material-adverse-change notice due ${bd5}`, due: bd1 }],
    event: { type: "eligibility.breach.detected", payload: { detected_on: i.detected_on, trigger: i.trigger, notify_by: bd1, fnma_notice_by: bd5 } },
  };
}
/** Satisfies SM_ELIG_BREACH_NOTIFY_1BD: both the partner and the officer notified (each with evidence). */
export function breachNotified(i: { detected_on: PlainDate; partner_notified_on: PlainDate | null; officer_notified_on: PlainDate | null; cal?: Calendar }): { complete: boolean; timely: boolean; event: { type: "eligibility.breach.notified"; payload: { partner: boolean; officer: boolean; partner_notified_on: PlainDate | null; officer_notified_on: PlainDate | null } } | null } {
  const due = addBusinessDays(i.detected_on, 1, i.cal ?? servicer);
  const complete = i.partner_notified_on !== null && i.officer_notified_on !== null;
  const timely = complete && i.partner_notified_on! <= due && i.officer_notified_on! <= due;
  return { complete, timely, event: complete ? { type: "eligibility.breach.notified", payload: { partner: true, officer: true, partner_notified_on: i.partner_notified_on, officer_notified_on: i.officer_notified_on } } : null };
}

export interface QuarterlyTest {
  readonly period_end: PlainDate;
  readonly result: EligibilityResult;
  /** Which rule put the entity in its status band (null when compliant). */
  readonly reason: string | null;
  readonly outcome: WarningOutcome | BreachOutcome | null;
  readonly certification_required: boolean;
}
/** Status ladder `compliant → warning → breach`: compute, then arm the clock the band requires (detection = the compute date). */
export function quarterlyTest(i: EligibilityTestInput & { period_end: PlainDate; computed_on: PlainDate; cal?: Calendar }): QuarterlyTest {
  const r = eligibilityTest(i);
  const outcome = r.status === "breach" ? breachDetected({ detected_on: i.computed_on, trigger: r.reason ?? "breach", ...(i.cal ? { cal: i.cal } : {}) })
    : r.status === "warning" ? warningDetected({ detected_on: i.computed_on, reason: r.reason ?? "warning" }) : null;
  return { period_end: i.period_end, result: r, reason: r.reason, outcome, certification_required: isQuarterEnd(i.period_end) };
}

export interface LargeServicerCrossing {
  readonly large: boolean;
  readonly crossed: boolean;
  readonly ratings_warning: boolean;
  /** Buffer (2 bps Enterprise / 5 bps Ginnie Mae) applies from the quarter of crossing. */
  readonly buffer_applies_from: PlainDate | null;
  /** Monthly Form 1002A starts with the first month after the crossing quarter (no report for the third month of a quarter). */
  readonly form1002a: { readonly first_month_end: PlainDate; readonly due: PlainDate } | null;
  readonly capliq_plan: { readonly year_end: PlainDate; readonly due: PlainDate } | null;
}
/** T6 / edge case: total UPB crossing $50B at a quarter-end activates the buffer, monthly 1002A and the capital/liquidity plan (Dec 31 + 90). */
export function largeServicerCrossing(i: { quarter_end: PlainDate; total_upb: Cents; prior_total_upb: Cents | null }): LargeServicerCrossing {
  const large = i.total_upb >= LARGE_SERVICER_THRESHOLD_CENTS;
  const crossed = large && (i.prior_total_upb === null || i.prior_total_upb < LARGE_SERVICER_THRESHOLD_CENTS);
  const first_month_end = endOfMonth(addMonths(i.quarter_end, 1));
  const year_end = ymd(parts(i.quarter_end).y, 12, 31);
  return {
    large, crossed, ratings_warning: !large && i.total_upb >= LARGE_SERVICER_WARNING_CENTS,
    buffer_applies_from: large ? i.quarter_end : null,
    form1002a: large ? { first_month_end, due: addDays(first_month_end, 30) } : null,
    capliq_plan: large ? { year_end, due: capitalPlanDue(year_end) } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Filings (A4-1-02) and the large seller/servicer obligations (A4-1-01)
// ---------------------------------------------------------------------------------------------------------------------
export interface Form1002Clock {
  readonly code: "FNMA_A4102_FORM1002_Q_30" | "FNMA_A4102_FORM1002_YE_60";
  readonly quarter: 1 | 2 | 3 | 4;
  readonly anchor: PlainDate;
  /** "within 30 days" (Mar/Jun/Sep) or "within 60 days" (Dec 31). */
  readonly due: PlainDate;
  /** Spec timer table: "warning day 20" / "warning day 40" counted from the quarter-end. */
  readonly warning: PlainDate;
  readonly satisfied_by: string;
}
/** T5: the Form 1002 clock the registry rows deliver — day 30 (warning day 20) for Mar/Jun/Sep, day 60 (warning day 40) for Dec 31. */
export function form1002Clock(quarter_end: PlainDate): Form1002Clock {
  const quarter = quarterOf(quarter_end);
  const ye = quarter === 4;
  return { code: ye ? "FNMA_A4102_FORM1002_YE_60" : "FNMA_A4102_FORM1002_Q_30", quarter, anchor: quarter_end, due: addDays(quarter_end, ye ? 60 : 30), warning: addDays(quarter_end, ye ? 40 : 20), satisfied_by: ye ? ELIG_EVENTS.form1002_ye_submitted : ELIG_EVENTS.form1002_q_submitted };
}

export interface Form1002Submission {
  readonly allowed: boolean;
  readonly refusal: string | null;
  readonly state: "submitted" | "form1002_prepared";
  readonly event: { readonly type: "filing.submitted"; readonly payload: { readonly form: "form_1002"; readonly quarter: 1 | 2 | 3 | 4; readonly period_end: PlainDate; readonly webmb_confirmation: string; readonly ceo_cfo_certification: string } } | null;
  readonly due: PlainDate;
}
/** T8: `form1002_prepared → submitted (WebMB)` needs the WebMB confirmation and the CEO/CFO certification record; the agent cannot supply either. */
export function form1002Submit(i: { period_end: PlainDate; webmb_confirmation: string | null; ceo_cfo_certification: string | null }): Form1002Submission {
  const allowed = form1002SubmittedAllowed(i.webmb_confirmation, i.ceo_cfo_certification);
  const quarter = quarterOf(i.period_end);
  const due = form1002Due(i.period_end).due;
  if (!allowed) {
    const missing = [i.webmb_confirmation === null ? "WebMB submission confirmation" : null, i.ceo_cfo_certification === null ? "CEO/CFO certification record (A4-1-02)" : null].filter((x): x is string => x !== null);
    return { allowed: false, refusal: `Form 1002 cannot be marked submitted: missing ${missing.join(" and ")}`, state: "form1002_prepared", event: null, due };
  }
  return { allowed: true, refusal: null, state: "submitted", event: { type: "filing.submitted", payload: { form: "form_1002", quarter, period_end: i.period_end, webmb_confirmation: i.webmb_confirmation!, ceo_cfo_certification: i.ceo_cfo_certification! } }, due };
}

export interface Form1002aSubmission {
  /** A4-1-02: monthly for large non-depositories, "no report for the third month of a quarter". */
  readonly required: boolean;
  readonly quarter_month: 1 | 2 | 3;
  readonly allowed: boolean;
  readonly refusal: string | null;
  readonly state: "submitted" | "form1002a_prepared" | "not_required";
  readonly timer: { readonly code: "FNMA_A4102_FORM1002A_M_30"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: string } | null;
  readonly event: { readonly type: "filing.submitted"; readonly payload: { readonly form: "form_1002a"; readonly period_end: PlainDate; readonly webmb_confirmation: string } } | null;
}
/** FNMA_A4102_FORM1002A_M_30: month-end (months 1–2 of each quarter, large only) → Form 1002A "within 30 days of the end of each month" through WebMB. */
export function form1002aSubmit(i: { month_end: PlainDate; large: boolean; webmb_confirmation: string | null }): Form1002aSubmission {
  const quarter_month = (((parts(i.month_end).m - 1) % 3) + 1) as 1 | 2 | 3;
  const required = i.large && quarter_month !== 3;
  const timer = required ? { code: "FNMA_A4102_FORM1002A_M_30" as const, anchor: i.month_end, due: addDays(i.month_end, 30), satisfied_by: ELIG_EVENTS.form1002a_submitted } : null;
  if (!required) return { required, quarter_month, allowed: false, refusal: i.large ? "no Form 1002A for the third month of a quarter (the quarter's Form 1002 covers it; A4-1-02)" : "Form 1002A is filed by large non-depository seller/servicers only (A4-1-02)", state: "not_required", timer, event: null };
  if (i.webmb_confirmation === null) return { required, quarter_month, allowed: false, refusal: "Form 1002A cannot be marked submitted: missing WebMB submission confirmation", state: "form1002a_prepared", timer, event: null };
  return { required, quarter_month, allowed: true, refusal: null, state: "submitted", timer, event: { type: "filing.submitted", payload: { form: "form_1002a", period_end: i.month_end, webmb_confirmation: i.webmb_confirmation } } };
}

/** A4-1-01 capital and liquidity plan contents for a large non-depository seller/servicer. */
export interface CapLiqPlan {
  readonly governance: boolean;
  readonly liquidity_risk_monitoring: boolean;
  /** Contingency funding plan tested "at least annually". */
  readonly contingency_funding_plan_tested_on: PlainDate | null;
  /** "Annual liquidity stress test" including MSR valuation. */
  readonly liquidity_stress_test_on: PlainDate | null;
  readonly stress_test_includes_msr_valuation: boolean;
}
export interface CapLiqPlanSubmission {
  readonly required: boolean;
  readonly allowed: boolean;
  readonly refusal: string | null;
  readonly missing: readonly string[];
  readonly late: boolean;
  readonly timer: { readonly code: "FNMA_A4101_LARGE_CAPLIQ_PLAN_90"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: string };
  readonly event: { readonly type: "filing.submitted"; readonly payload: { readonly form: "capliq_plan"; readonly year_end: PlainDate; readonly submitted_on: PlainDate } } | null;
}
/** FNMA_A4101_LARGE_CAPLIQ_PLAN_90: plan "Within 90 days after the end of each calendar year" (large only) with the A4-1-01 contents. */
export function capliqPlanSubmit(i: { year_end: PlainDate; large: boolean; plan: CapLiqPlan; submitted_on: PlainDate }): CapLiqPlanSubmission {
  const due = capitalPlanDue(i.year_end);
  const timer = { code: "FNMA_A4101_LARGE_CAPLIQ_PLAN_90" as const, anchor: i.year_end, due, satisfied_by: ELIG_EVENTS.capliq_plan_submitted };
  const yearAgo = addYears(i.submitted_on, -1);
  const missing = [
    i.plan.governance ? null : "governance",
    i.plan.liquidity_risk_monitoring ? null : "liquidity-risk monitoring",
    i.plan.contingency_funding_plan_tested_on !== null && i.plan.contingency_funding_plan_tested_on > yearAgo ? null : "contingency funding plan tested at least annually",
    i.plan.liquidity_stress_test_on !== null && i.plan.liquidity_stress_test_on > yearAgo ? null : "annual liquidity stress test",
    i.plan.stress_test_includes_msr_valuation ? null : "stress test including MSR valuation",
  ].filter((x): x is string => x !== null);
  const late = i.submitted_on > due;
  if (!i.large) return { required: false, allowed: false, refusal: "capital and liquidity plan is required of large non-depository seller/servicers only (A4-1-01)", missing, late, timer, event: null };
  if (missing.length) return { required: true, allowed: false, refusal: `capital and liquidity plan cannot be submitted: missing ${missing.join(", ")} (A4-1-01)`, missing, late, timer, event: null };
  return { required: true, allowed: true, refusal: null, missing, late, timer, event: { type: "filing.submitted", payload: { form: "capliq_plan", year_end: i.year_end, submitted_on: i.submitted_on } } };
}

export interface MaterialChangeNotice {
  /** Large seller/servicers only. */
  readonly required: boolean;
  readonly variant: "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD" | "FNMA_A4101_LARGE_MATERIAL_CHANGE_STRESS_1BD";
  readonly business_days: 5 | 1;
  readonly trigger_event: string;
  readonly timer: { readonly code: "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: string };
  readonly escalations: readonly QcEscalation[];
}
/**
 * FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD / _STRESS_1BD: Fannie Mae notified "Within five business days following any material
 * change" to the plan inputs and "within one business day of any material changes during times of stress" (A4-1-01).
 */
export function materialChangeNotice(i: { detected_on: PlainDate; large: boolean; stress: boolean; decline_trigger?: string | null; cal?: Calendar }): MaterialChangeNotice {
  const business_days = i.stress ? 1 : 5;
  const due = addBusinessDays(i.detected_on, business_days, i.cal ?? servicer);
  const what = i.decline_trigger ? `material change (${i.decline_trigger})` : "material change to capital/liquidity plan inputs";
  return {
    required: i.large, variant: i.stress ? "FNMA_A4101_LARGE_MATERIAL_CHANGE_STRESS_1BD" : "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD", business_days, trigger_event: ELIG_EVENTS.material_change_detected,
    timer: { code: "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD", anchor: i.detected_on, due, satisfied_by: ELIG_EVENTS.material_change_notified },
    escalations: i.large ? [{ kind: "officer", severity: "sev1", reason: `${what}${i.stress ? " during stress" : ""}: Fannie Mae notice due ${due} (${business_days} BD; A4-1-01)`, due }] : [],
  };
}
/** "notice evidenced": the Fannie Mae material-change notice with its evidence document satisfies the timer. */
export function materialChangeNotified(i: { detected_on: PlainDate; large: boolean; stress: boolean; sent_on: PlainDate; evidence_document_id: string | null; cal?: Calendar }): { allowed: boolean; refusal: string | null; timely: boolean; due: PlainDate; event: { type: "fnma.notified"; payload: { kind: "eligibility_material_change"; sent_on: PlainDate; evidence_document_id: string; stress: boolean } } | null } {
  const due = materialChangeNotice({ detected_on: i.detected_on, large: i.large, stress: i.stress, ...(i.cal ? { cal: i.cal } : {}) }).timer.due;
  if (i.evidence_document_id === null) return { allowed: false, refusal: "material-change notice cannot be recorded: notice must be evidenced (evidence document required)", timely: false, due, event: null };
  return { allowed: true, refusal: null, timely: i.sent_on <= due, due, event: { type: "fnma.notified", payload: { kind: "eligibility_material_change", sent_on: i.sent_on, evidence_document_id: i.evidence_document_id, stress: i.stress } } };
}

export interface ServiceOneLoanTest {
  readonly code: "FNMA_A4101_SERVICE_ONE_LOAN_DEC31";
  readonly evaluator: "18.7.servicesAtLeastOneFannieMaeLoan";
  readonly as_of: PlainDate;
  /** Facts for the registry evaluator (src/app/evaluators.ts). */
  readonly facts: { readonly fnma_loans_serviced_dec31: number };
  readonly breached: boolean;
  readonly consequence: string | null;
  readonly escalations: readonly QcEscalation[];
}
/** T9 / A4-1-01: "A servicer must service at least one loan for Fannie Mae as of December 31 of the prior calendar year" — zero → sev-1 to `officer` (approval at risk). */
export function serviceOneLoanTest(i: { as_of: PlainDate; fnma_loans_serviced: number }): ServiceOneLoanTest {
  const breached = i.fnma_loans_serviced < 1;
  return {
    code: "FNMA_A4101_SERVICE_ONE_LOAN_DEC31", evaluator: "18.7.servicesAtLeastOneFannieMaeLoan", as_of: i.as_of, facts: { fnma_loans_serviced_dec31: i.fnma_loans_serviced }, breached,
    consequence: breached ? "approval at risk: breach → loss of access to all technology that is licensed only to approved servicers (A4-1-01)" : null,
    escalations: breached ? [{ kind: "officer", severity: "sev1", reason: `approval at risk: ${i.fnma_loans_serviced} Fannie Mae loans serviced as of ${i.as_of} — A4-1-01 requires at least one loan serviced for Fannie Mae as of December 31 of the prior calendar year`, due: i.as_of }] : [],
  };
}

/** `SM_PARTNER_UPB_REPORT_MONTHLY_BD5`: subserviced UPB / remittance-type report (ELIG-UPB-PARTNER-M-v1) delivered by BD5 after month-end. */
export function partnerUpbReportDue(month_end: PlainDate, cal: Calendar = fannieEt): { code: "SM_PARTNER_UPB_REPORT_MONTHLY_BD5"; due: PlainDate; template: "ELIG-UPB-PARTNER-M-v1"; satisfied_by: string } {
  return { code: "SM_PARTNER_UPB_REPORT_MONTHLY_BD5", due: addBusinessDays(month_end, 5, cal), template: "ELIG-UPB-PARTNER-M-v1", satisfied_by: ELIG_EVENTS.partner_upb_report_delivered };
}

/** CSBS prudential standards (research/00a §5.3): state capital/liquidity keyed to the FHFA numbers for servicers with ≥ 2,000 loans in ≥ 2 states. */
export function csbsPrudentialApplicability(i: { quarter_end: PlainDate; loan_count: number; states: readonly string[]; fhfa_compliant: boolean }): { applies: boolean; loan_count: number; state_count: number; nc_safe_harbor: boolean; record_event: string; event: { type: "csbs.prudential_applicability.recorded"; payload: { quarter_end: PlainDate; applies: boolean; loan_count: number; state_count: number; states: string[]; fhfa_compliant: boolean; nc_safe_harbor: boolean } } } {
  const states = [...new Set(i.states.map((s) => s.toUpperCase()))].sort();
  const state_count = states.length;
  const applies = i.loan_count >= 2_000 && state_count >= 2;
  const nc_safe_harbor = applies && i.fhfa_compliant && states.includes("NC");
  return {
    applies, loan_count: i.loan_count, state_count, nc_safe_harbor, record_event: ELIG_EVENTS.csbs_applicability_recorded,
    // "loan-count/state test recorded": satisfies CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q (informs the Section 19 licensing program).
    event: { type: "csbs.prudential_applicability.recorded", payload: { quarter_end: i.quarter_end, applies, loan_count: i.loan_count, state_count, states, fhfa_compliant: i.fhfa_compliant, nc_safe_harbor } },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The period cycle and the remaining emitted events. These are the event shapes src/app/tools/section18-7.ts appends to
// the event store (`eligibility.period.close`, `remediation_plan.approve`, `partner_upb_report.deliver`,
// `material_change.detect`); the registry's 18.7 rows arm on the period events and are satisfied by the others.
// ---------------------------------------------------------------------------------------------------------------------
export type Entity = "supermortgage" | "partner";
export interface EmittedEvent<T extends string = string, P extends Record<string, unknown> = Record<string, unknown>> { readonly type: T; readonly payload: P }

export interface PeriodCloseEvents {
  readonly entity: Entity;
  readonly period_end: PlainDate;
  readonly quarter: 1 | 2 | 3 | 4;
  /** Month within the quarter (1–3): Form 1002A is filed for months 1–2 only (A4-1-02). */
  readonly quarter_month: 1 | 2 | 3;
  readonly quarter_end: boolean;
  readonly year_end: boolean;
  readonly large_servicer: boolean;
  /** `period.month_end` always; `period.quarter_end{quarter}` at a quarter-end; `period.year_end{large_servicer}` at Dec 31. */
  readonly events: readonly EmittedEvent[];
  readonly clocks: {
    readonly gl_close_by: PlainDate;
    readonly partner_upb_report_due: PlainDate;
    readonly eligibility_test_by: PlainDate | null;
    readonly form1002: Form1002Clock | null;
    readonly form1002a: { readonly code: "FNMA_A4102_FORM1002A_M_30"; readonly due: PlainDate } | null;
    readonly capliq_plan: { readonly code: "FNMA_A4101_LARGE_CAPLIQ_PLAN_90"; readonly due: PlainDate } | null;
  };
}
/**
 * Schedules `eligibility.compute.monthly` / `filing.form1002.cycle` / `filing.form1002a.cycle` / `capliq.plan.cycle`: closing a
 * calendar period appends the period events the 18.7 timer table arms on — `period.month_end{quarter_month}` (Form 1002A for
 * months 1–2 when large; the partner UPB report by BD5), `period.quarter_end{quarter}` (the quarterly eligibility test by BD10,
 * Form 1002 within 30 days for Mar/Jun/Sep, the CSBS applicability check) and `period.year_end{large_servicer}` (Form 1002
 * within 60 days, the capital/liquidity plan within 90 days when large, the one-loan rule). Every event carries `period_end`
 * so the clocks anchor on the period end however late the close is processed.
 */
export function periodCloseEvents(i: { entity: Entity; period_end: PlainDate; large_servicer: boolean; cal?: Calendar }): PeriodCloseEvents {
  if (i.period_end !== endOfMonth(i.period_end)) throw new RangeError(`period_end ${i.period_end} is not a month-end`);
  const quarter = quarterOf(i.period_end);
  const quarter_month = (((parts(i.period_end).m - 1) % 3) + 1) as 1 | 2 | 3;
  const quarter_end = isQuarterEnd(i.period_end);
  const year_end = parts(i.period_end).m === 12;
  const base = { entity: i.entity, period_end: i.period_end, quarter, quarter_month, large_servicer: i.large_servicer };
  const events: EmittedEvent[] = [{ type: "period.month_end", payload: { ...base } }];
  if (quarter_end) events.push({ type: "period.quarter_end", payload: { ...base } });
  if (year_end) events.push({ type: "period.year_end", payload: { ...base, year: parts(i.period_end).y } });
  const cal = i.cal ?? fannieEt;
  const f1002a = i.large_servicer && quarter_month !== 3 ? form1002aSubmit({ month_end: i.period_end, large: true, webmb_confirmation: null }).timer : null;
  return {
    entity: i.entity, period_end: i.period_end, quarter, quarter_month, quarter_end, year_end, large_servicer: i.large_servicer, events,
    clocks: {
      gl_close_by: glCloseDeadline(i.period_end, cal),
      partner_upb_report_due: partnerUpbReportDue(i.period_end, cal).due,
      eligibility_test_by: quarter_end ? addBusinessDays(i.period_end, 10, cal) : null,
      form1002: quarter_end ? form1002Clock(i.period_end) : null,
      form1002a: f1002a ? { code: "FNMA_A4102_FORM1002A_M_30", due: f1002a.due } : null,
      capliq_plan: year_end && i.large_servicer ? { code: "FNMA_A4101_LARGE_CAPLIQ_PLAN_90", due: capitalPlanDue(i.period_end) } : null,
    },
  };
}

export interface RemediationPlanApproval {
  readonly allowed: boolean;
  readonly refusal: string | null;
  readonly due: PlainDate;
  readonly timely: boolean;
  /** Satisfies SM_ELIG_WARNING_REMEDIATION_30 (`eligibility.remediation_plan.approved{approved_by=board}`). */
  readonly event: { readonly type: "eligibility.remediation_plan.approved"; readonly payload: { readonly approved_by: "board"; readonly approved_on: PlainDate; readonly plan_document_id: string; readonly warning_detected_on: PlainDate; readonly minutes_document_id: string | null } } | null;
}
/** Status ladder `warning → remediation_plan`: the plan is board-approved (escalation "board (remediation plans)") within 30 calendar days of the warning; an officer or agent approval is not the board's. */
export function remediationPlanApproval(i: { warning_detected_on: PlainDate; approved_by: string; approved_on: PlainDate; plan_document_id: string | null; minutes_document_id?: string | null }): RemediationPlanApproval {
  const due = addDays(i.warning_detected_on, 30);
  const refuse = (why: string): RemediationPlanApproval => ({ allowed: false, refusal: `remediation plan approval refused: ${why}`, due, timely: false, event: null });
  if (i.approved_by !== "board") return refuse(`the remediation plan is board-approved (§18.7 status ladder); ${i.approved_by} cannot approve it`);
  if (!i.plan_document_id) return refuse("the approved plan document is required (retention corporate_7y)");
  return { allowed: true, refusal: null, due, timely: i.approved_on <= due, event: { type: "eligibility.remediation_plan.approved", payload: { approved_by: "board", approved_on: i.approved_on, plan_document_id: i.plan_document_id, warning_detected_on: i.warning_detected_on, minutes_document_id: i.minutes_document_id ?? null } } };
}

export type UpbClass = "ent_ss_sa" | "ent_aa" | "gnma" | "other" | "subserviced_for_others" | "hfs_and_irlc";
export const UPB_CLASSES: readonly UpbClass[] = ["ent_ss_sa", "ent_aa", "gnma", "other", "subserviced_for_others", "hfs_and_irlc"];
export interface UpbPositionRow { readonly class: UpbClass; readonly upb_cents: Cents; readonly loan_count: number }
export interface PartnerUpbReport {
  readonly template: "ELIG-UPB-PARTNER-M-v1";
  readonly code: "SM_PARTNER_UPB_REPORT_MONTHLY_BD5";
  readonly period_end: PlainDate;
  readonly due: PlainDate;
  readonly timely: boolean;
  readonly subserviced_upb_cents: Cents;
  readonly loan_count: number;
  readonly by_remittance_type: readonly UpbPositionRow[];
  /** Satisfies SM_PARTNER_UPB_REPORT_MONTHLY_BD5 (`partner.upb_report.delivered{template=ELIG-UPB-PARTNER-M-v1}`). */
  readonly event: { readonly type: "partner.upb_report.delivered"; readonly payload: { readonly template: "ELIG-UPB-PARTNER-M-v1"; readonly period_end: PlainDate; readonly delivered_on: PlainDate; readonly recipient: string; readonly subserviced_upb_cents: Cents; readonly loan_count: number; readonly by_remittance_type: readonly UpbPositionRow[]; readonly receipt_id: string | null } };
}
/**
 * Monthly partner UPB report (ELIG-UPB-PARTNER-M-v1): the subserviced UPB by remittance type with loan counts, delivered by BD5
 * after month-end so the partner (master) can compute its own position (FHFA FAQ #10: the UPB moves from Supermortgage's
 * denominator to the partner's). The positions are the Section 5 month-end position rows; an empty report is refused.
 */
export function partnerUpbReportDelivered(i: { month_end: PlainDate; delivered_on: PlainDate; recipient: string; positions: readonly UpbPositionRow[]; receipt_id?: string | null; cal?: Calendar }): PartnerUpbReport {
  if (i.positions.length === 0) throw new RangeError(`partner UPB report for ${i.month_end}: no upb_positions rows (Section 5 month-end position required)`);
  const by = i.positions.filter((p) => p.class !== "hfs_and_irlc");
  const subserviced = by.reduce((a, p) => a + p.upb_cents, 0n);
  const loan_count = by.reduce((a, p) => a + p.loan_count, 0);
  const due = partnerUpbReportDue(i.month_end, i.cal ?? fannieEt).due;
  return {
    template: "ELIG-UPB-PARTNER-M-v1", code: "SM_PARTNER_UPB_REPORT_MONTHLY_BD5", period_end: i.month_end, due, timely: i.delivered_on <= due, subserviced_upb_cents: subserviced, loan_count, by_remittance_type: by,
    event: { type: "partner.upb_report.delivered", payload: { template: "ELIG-UPB-PARTNER-M-v1", period_end: i.month_end, delivered_on: i.delivered_on, recipient: i.recipient, subserviced_upb_cents: subserviced, loan_count, by_remittance_type: by, receipt_id: i.receipt_id ?? null } },
  };
}

export interface MaterialChangeDetection {
  readonly notice: MaterialChangeNotice;
  /** Arms FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD when `large_servicer=true` (anchor `detected_on`). */
  readonly event: { readonly type: "material_change.detected"; readonly payload: { readonly detected_on: PlainDate; readonly large_servicer: boolean; readonly stress: boolean; readonly decline_trigger: string | null; readonly source: string; readonly description: string } };
}
/** Spec events list `material_change.detected{decline_trigger}`: a material change to the capital/liquidity plan inputs (a decline trigger, a facility change, an MSR valuation shock) — the 5 BD / 1 BD (stress) Fannie Mae notice of a large seller/servicer (A4-1-01). */
export function materialChangeDetected(i: { detected_on: PlainDate; large: boolean; stress: boolean; decline_trigger?: string | null; source: string; description: string; cal?: Calendar }): MaterialChangeDetection {
  if (!i.description) throw new RangeError("material change needs a description");
  const notice = materialChangeNotice({ detected_on: i.detected_on, large: i.large, stress: i.stress, decline_trigger: i.decline_trigger ?? null, ...(i.cal ? { cal: i.cal } : {}) });
  return { notice, event: { type: "material_change.detected", payload: { detected_on: i.detected_on, large_servicer: i.large, stress: i.stress, decline_trigger: i.decline_trigger ?? null, source: i.source, description: i.description } } };
}

/** `gl.close.completed{entity, period}`: the GL adapter's monthly close for an entity, accepted only through glSnapshotIntake (hashed sources, no adjustments). */
export function glCloseCompletedEvent(i: { entity: Entity; period_end: PlainDate; received_on: PlainDate; intake: GlSnapshotIntake }): EmittedEvent<"gl.close.completed"> | null {
  if (!i.intake.accepted) return null;
  return { type: "gl.close.completed", payload: { entity: i.entity, period: i.period_end.slice(0, 7), period_end: i.period_end, received_on: i.received_on, inputs_hash: i.intake.inputs_hash, source_document_ids: [...i.intake.source_document_ids] } };
}

/** `upb.position.finalized{period}`: the Section 5 month-end position by investor and remittance type (LSDU / Servicing Platform reconciled). */
export function upbPositionFinalizedEvent(i: { entity: Entity; period_end: PlainDate; positions: readonly UpbPositionRow[]; source: string }): EmittedEvent<"upb.position.finalized"> {
  if (i.positions.length === 0) throw new RangeError(`upb position for ${i.entity} ${i.period_end}: no rows`);
  for (const p of i.positions) { if (!UPB_CLASSES.includes(p.class)) throw new RangeError(`upb class ${String(p.class)} is not one of ${UPB_CLASSES.join(", ")}`); if (p.upb_cents < 0n || p.loan_count < 0) throw new RangeError(`upb position ${p.class}: negative UPB or loan count`); }
  const total = i.positions.filter((p) => p.class !== "hfs_and_irlc" && p.class !== "subserviced_for_others").reduce((a, p) => a + p.upb_cents, 0n);
  return { type: "upb.position.finalized", payload: { entity: i.entity, period: i.period_end.slice(0, 7), period_end: i.period_end, source: i.source, master_serviced_upb_cents: total, classes: i.positions.map((p) => p.class) } };
}
