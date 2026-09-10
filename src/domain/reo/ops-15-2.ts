/**
 * §15.2 Expense reimbursement submission — rule functions on top of ./claims.ts:
 * the versioned allowable schedules (Operational prerequisites; `allowable_fee_schedules`), the rule-2 line
 * validator (`validateLine152`, every check the spec enumerates), the nightly candidate sweep (rule 1),
 * itemization/quantity bundles (rule 5, worked example rule 9), milestone billing (E-5-05; 15.2-T5), claim
 * assembly into the decision record with the rule-1 indicator and the rule-4 exclusions (tagged lines leave the claim;
 * 15.2-T4), the excess-fee request to the firm (15.2-T3), the bulk package with the NPI screen (15.2-T13), the channel
 * fallback (15.2-T11), PSA/ACH outcomes and the PSA auto-denial sweep (15.2-T6/T8), the deferral rule (15.2-T12) and the
 * cancelled-workout incentive repayment, recovered-advance repayment batches (rule 8; 15.2-T9), post-payment credits
 * (rule 7; 15.2-T10), denial triage and the cumulative officer briefing (rule 10; 15.2-T7), the claim-age rule (rule 6),
 * the FNMA_F105_ESCROW_ADV_CUTOFF_14 gate applied per line, and the P360 status / reconciliation-report projectors and
 * the repayment / incentive / credit facts whose events arm and satisfy the process's timers.
 */
import { type PlainDate, addDays, endOfMonth } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { validateLine, finalDueAt, claimTotals, psaClocks, achExpected, postPaymentRefund, denialTriage, attachmentContainsSsn, type ClaimLine, type ClaimContext, type LineValidation } from "./claims.ts";
import { EVALUATORS_15_2, CUTOFF_ADVANCE_KINDS } from "./evaluators-15-2.ts";

// ---- versioned allowable schedules (Operational prerequisites; `allowable_fee_schedules`) -------------------
/** One row of `allowable_fee_schedules` (0017_reo.sql): versioned by `rule_set`, keyed by code + jurisdiction. */
export interface AllowableRow {
  readonly rule_set: string; readonly code: string; readonly jurisdiction: string; readonly kind: string;
  readonly cap_cents: Cents; readonly cap_unit: "per_unit" | "per_default" | "per_claim" | "life_of_loan";
  readonly life_of_default: boolean; readonly life_cap_cents?: Cents; readonly track?: "judicial" | "non_judicial" | "*"; readonly variant?: string;
  readonly notes?: string; readonly source_url?: string;
}
export const FCL_FEE_RULE_SET = "fnma.fcl_fees.2024-12-18";
export const F105_LIMITS_RULE_SET = "fnma.f105_limits.2025-06";
export const PPM_RULE_SET = "fnma.ppm.2025-06";
export const TECH_FEE_RULE_SET = "fnma.tech_fees.2014-11";
const FCL_EXHIBIT_URL = "https://singlefamily.fanniemae.com/media/8971/display";
const F105_URL = "https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement";
const E506_URL = "https://servicing-guide.fanniemae.com/svc/e-5-06/technology-fees-and-electronic-invoicing";
const fcl = (jurisdiction: string, track: "judicial" | "non_judicial" | "*", cap_cents: Cents, variant?: string, notes?: string): AllowableRow =>
  ({ rule_set: FCL_FEE_RULE_SET, code: "attorney_fee_fcl", jurisdiction, kind: "attorney_fee", cap_cents, cap_unit: "per_default", life_of_default: true, track, ...(variant ? { variant } : {}), ...(notes ? { notes } : {}), source_url: FCL_EXHIBIT_URL });
const lim = (rule_set: string, code: string, kind: string, cap_cents: Cents, cap_unit: AllowableRow["cap_unit"], extra: Partial<AllowableRow> = {}): AllowableRow =>
  ({ rule_set, code, jurisdiction: "*", kind, cap_cents, cap_unit, life_of_default: false, source_url: rule_set === TECH_FEE_RULE_SET ? E506_URL : F105_URL, ...extra });
/** Allowable Foreclosure Attorney Fees Exhibit (Dec. 18, 2024), F-1-05 Defined Expense Reimbursement Limits (06/11/2025), PPM and E-5-06 caps as the spec states them. */
export const ALLOWABLE_FEE_SCHEDULES: readonly AllowableRow[] = [
  fcl("TX", "non_judicial", 230_000n), fcl("TX", "judicial", 380_000n, "50(a)(6)", "home-equity judicial"), fcl("FL", "judicial", 540_000n), fcl("FL", "judicial", 690_000n, "trial"),
  fcl("NY", "judicial", 680_000n), fcl("NY", "non_judicial", 200_000n, "co-op"), fcl("CA", "non_judicial", 230_000n), fcl("GA", "non_judicial", 222_500n), fcl("IL", "judicial", 410_000n),
  fcl("NJ", "judicial", 670_000n), fcl("OH", "judicial", 400_000n), fcl("PA", "judicial", 415_000n), fcl("VA", "non_judicial", 260_000n), fcl("WA", "non_judicial", 240_000n), fcl("WA", "judicial", 415_000n),
  fcl("AZ", "non_judicial", 225_000n), fcl("NV", "non_judicial", 265_000n), fcl("MI", "non_judicial", 255_000n), fcl("MA", "non_judicial", 470_000n), fcl("CT", "judicial", 440_000n), fcl("CT", "judicial", 500_000n, "foreclosure_by_sale"),
  fcl("MD", "*", 390_000n), fcl("MN", "non_judicial", 237_500n), fcl("MN", "non_judicial", 347_500n, "registered_land", "+$1,100 registered land"), fcl("CO", "non_judicial", 280_000n), fcl("NC", "*", 295_000n),
  // F-1-05 Defined Expense Reimbursement Limits (9.9 `allowable_matrix`)
  lim(F105_LIMITS_RULE_SET, "inspection_exterior", "inspection", 3_000n, "per_unit"), lim(F105_LIMITS_RULE_SET, "inspection_interior", "inspection", 4_500n, "per_unit"), lim(F105_LIMITS_RULE_SET, "inspection_insured_loss", "inspection", 6_000n, "per_unit"),
  lim(F105_LIMITS_RULE_SET, "code_violation", "code_violation", 100_000n, "per_unit", { life_cap_cents: 300_000n, notes: "$1,000 each / $3,000 life" }),
  lim(F105_LIMITS_RULE_SET, "mortgage_release_doc_prep", "mortgage_release_doc", 65_000n, "per_unit", { notes: "$650 each, upon completion" }),
  // Property Preservation Matrix caps with life-of-loan accumulators (9.9)
  lim(PPM_RULE_SET, "lock_change", "preservation", 6_000n, "per_unit"), lim(PPM_RULE_SET, "initial_grass_cut", "preservation", 12_500n, "per_unit"), lim(PPM_RULE_SET, "grass_recut", "preservation", 8_000n, "per_unit"),
  lim(PPM_RULE_SET, "debris_removal_cy", "preservation", 5_000n, "per_unit", { notes: "per cubic yard; >10 CY BATF, >20 CY bid (9.9)" }), lim(PPM_RULE_SET, "winterization", "preservation", 22_000n, "per_unit"),
  lim(PPM_RULE_SET, "boarding", "preservation", 18_500n, "per_unit"), lim(PPM_RULE_SET, "posting", "preservation", 5_000n, "per_unit"),
  // E-5-06 technology and e-invoice caps
  lim(TECH_FEE_RULE_SET, "technology_fee", "technology", 2_500n, "per_default", { life_of_default: true, notes: "$25.00 per loan for the life of a default" }),
  lim(TECH_FEE_RULE_SET, "einvoice_fcl", "einvoice", 500n, "life_of_loan", { life_cap_cents: 1_000n, notes: "$5.00 foreclosure; $10.00 for the life of the loan with einvoice_bk" }),
  lim(TECH_FEE_RULE_SET, "einvoice_bk", "einvoice", 500n, "life_of_loan", { life_cap_cents: 1_000n, notes: "$5.00 bankruptcy; $10.00 for the life of the loan with einvoice_fcl" }),
];
/** The table's primary key (0035: rule_set, code, jurisdiction, track, variant) — the exhibit's TX 50(a)(6), FL trial, NY co-op, WA judicial, CT foreclosure-by-sale and MN registered-land rows share code + jurisdiction. */
export function allowableRowKey(r: AllowableRow): string { return `${r.rule_set}|${r.code}|${r.jurisdiction}|${r.track ?? "*"}|${r.variant ?? ""}`; }
export type Track = "judicial" | "non_judicial";
/** Exhibit row for a state/track (variant such as "trial", "50(a)(6)", "co-op" when the invoice claims it). */
export function exhibitFor(state: string, track: Track, variant: string | null = null, schedule: readonly AllowableRow[] = ALLOWABLE_FEE_SCHEDULES): AllowableRow | null {
  const rows = schedule.filter((r) => r.code === "attorney_fee_fcl" && r.jurisdiction === state.toUpperCase() && (r.track === track || r.track === "*"));
  return rows.find((r) => (variant ? r.variant === variant : r.variant === undefined)) ?? null;
}
export function allowableFor(code: string, schedule: readonly AllowableRow[] = ALLOWABLE_FEE_SCHEDULES): AllowableRow | null { return schedule.find((r) => r.code === code && r.jurisdiction === "*") ?? null; }

// ---- rule 2 (F-1-05 Defined Expense Reimbursement Limits): the 15.2 line and context -----------------------
export type F105InspectionType = "exterior" | "interior" | "insured_loss";
/** F-1-05 / 9.9 `allowable_matrix`: exterior $30, interior $45, insured-loss $60 (./claims.ts keys curbside/exterior/interior with exterior = $45 — corrected here). */
export const INSPECTION_CAPS_F105 = { exterior: 3_000n, interior: 4_500n, insured_loss: 6_000n } as const;
export type PreservationCode = "lock_change" | "initial_grass_cut" | "grass_recut" | "debris_removal_cy" | "winterization" | "boarding" | "posting";
export type NonrecoverableIndicator = "blank" | "non_recoverable" | "not_yet_recovered";
export type ClaimLine152 = ClaimLine & {
  readonly f105_inspection_type?: F105InspectionType;
  /** PPM code the preservation line is itemized under (rule 5: bundles are itemized). */
  readonly preservation_code?: PreservationCode;
  readonly einvoice_kind?: "fcl" | "bk";
  /** MI premium coverage months (rule 2: after the default date through the month of the liquidation event). */
  readonly service_start?: PlainDate; readonly service_end?: PlainDate;
  /** Rule 1: the Non-Recoverable Indicator and, for `non_recoverable`, the cited legal basis. */
  readonly nonrecoverable_indicator?: NonrecoverableIndicator; readonly legal_basis?: string | null;
  readonly collected_from_borrower?: boolean; readonly omitted_from_payoff_figure?: boolean; readonly borrower_recoverable?: boolean;
  /** Rule 4: preservation after a Fannie Mae acquisition only when SF CPM directed (15.1 rule 6). */
  readonly sf_cpm_directed?: boolean;
  readonly excess_fee_variant?: string | null;
};
export interface ClaimContext152 extends ClaimContext {
  readonly track?: Track;
  /** Rule 4 / FNMA_F105_ESCROW_ADV_CUTOFF_14: the legal date the 14-day insurance/HOA cut-off runs from — the sale, the Mortgage Release acceptance, the short-sale closing, or for a TPS the later of completion and court confirmation (jurisdiction override); defaults to `event_date`. */
  readonly legal_date?: PlainDate | null;
  /** Rule 2: MI premiums are claimable only after the default date. */
  readonly default_date?: PlainDate | null;
  /** Life-of-loan / life-of-default accumulators by allowable code (`expense_claim_lines.life_of_loan_used_cents`). */
  readonly life_of_loan_used?: Readonly<Record<string, Cents>>;
  /** HOA lowest-of parameters: project declaration maximum and the state statutory maximum (jurisdiction_rules). */
  readonly hoa_declaration_max_cents?: Cents | null; readonly hoa_state_statutory_max_cents?: Cents | null;
  /** Rule 4: Fannie Mae acquired the property at the event (REO) — preservation/inspections after it are non-reimbursable. */
  readonly acquired_by_fnma?: boolean;
  readonly schedule?: readonly AllowableRow[];
}
export interface ContextInput {
  readonly event_date: PlainDate; readonly state: string; readonly track: Track; readonly servicing_option: ClaimContext["servicing_option"];
  readonly default_date?: PlainDate | null; readonly reclassified?: boolean; readonly acquired_by_fnma?: boolean; readonly life_of_loan_used?: Readonly<Record<string, Cents>>;
  readonly hoa_declaration_max_cents?: Cents | null; readonly hoa_state_statutory_max_cents?: Cents | null; readonly excess_fee_variant?: string | null; readonly schedule?: readonly AllowableRow[];
  readonly legal_date?: PlainDate | null;
}
/** Builds the validation context with the attorney-fee exhibit resolved from the versioned schedule (no caller-supplied caps). */
export function claimContext152(i: ContextInput): ClaimContext152 {
  const schedule = i.schedule ?? ALLOWABLE_FEE_SCHEDULES;
  const row = exhibitFor(i.state, i.track, i.excess_fee_variant ?? null, schedule);
  if (!row) throw new RangeError(`no ${FCL_FEE_RULE_SET} row for ${i.state} ${i.track} — load the Allowable Foreclosure Attorney Fees Exhibit`);
  return { event_date: i.event_date, state: i.state.toUpperCase(), track: i.track, attorney_fee_exhibit_cents: row.cap_cents, servicing_option: i.servicing_option, schedule, legal_date: i.legal_date ?? null,
    default_date: i.default_date ?? null, life_of_loan_used: i.life_of_loan_used ?? {}, hoa_declaration_max_cents: i.hoa_declaration_max_cents ?? null, hoa_state_statutory_max_cents: i.hoa_state_statutory_max_cents ?? null,
    ...(i.reclassified !== undefined ? { reclassified: i.reclassified } : {}), ...(i.acquired_by_fnma !== undefined ? { acquired_by_fnma: i.acquired_by_fnma } : {}) };
}
export interface LineValidation152 extends LineValidation { readonly rule_set: string | null; readonly life_of_loan_used_cents: Cents; readonly indicator: NonrecoverableIndicator; }
const minCents = (...xs: (Cents | null | undefined)[]): Cents | null => xs.reduce<Cents | null>((m, x) => (x === null || x === undefined ? m : m === null || x < m ? x : m), null);
/** Rule 4 tags: the line is non-reimbursable by date, not defective — assembleClaim excludes it from the claim instead of holding the claim in draft (15.2-T4). */
export const RULE4_EXCLUSION_TAGS = ["post_sale_nonreimbursable", "post_acquisition_nonreimbursable"] as const;
export type Rule4Tag = (typeof RULE4_EXCLUSION_TAGS)[number];
const POST_SALE_TAG: Rule4Tag = "post_sale_nonreimbursable";
/** FNMA_F105_ESCROW_ADV_CUTOFF_14 applied to one line: the gate evaluator on `{advance_kind, legal_date, paid_on}` (the same facts the timer instance annotates). */
export function escrowAdvanceCutoff(l: Pick<ClaimLine152, "kind" | "paid_on">, c: Pick<ClaimContext152, "event_date" | "legal_date">): { open: boolean; reason: string | null; legal_date: PlainDate; cutoff: PlainDate } {
  const legal = c.legal_date ?? c.event_date;
  const r = EVALUATORS_15_2["15.2.escrowAdvanceWithinCutoff"]!({ advance_kind: l.kind, legal_date: legal, paid_on: l.paid_on ?? "" });
  return { open: r.open, reason: r.reason ?? null, legal_date: legal, cutoff: addDays(legal, 14) };
}

/**
 * Rule 2, every check the spec lists: attorney fee ≤ exhibit × milestone %; technology ≤ $25 per default; e-invoice ≤ $5 FCL + $5 BK
 * ($10 life of loan); inspections $30/$45/$60; preservation ≤ PPM caps with life-of-loan accumulators unless `hometracker_bid_id`;
 * HOA ≤ min(actual, declaration max, statutory max); taxes actual; hazard/flood/HOA through event + 14; MI premiums after the default
 * date through the month of the event; Mortgage Release doc prep ≤ $650; code violations ≤ $1,000 each / $3,000 life; overhead rejected.
 * Rule 1: `non_recoverable` needs a cited legal basis; collected or omitted-by-our-error lines are not claimable. Messages mirror P360's edit vocabulary.
 */
export function validateLine152(l: ClaimLine152, c: ClaimContext152): LineValidation152 {
  const base = validateLine(l, c);
  const schedule = c.schedule ?? ALLOWABLE_FEE_SCHEDULES;
  const used = c.life_of_loan_used ?? {};
  const messages = base.messages.filter((m) => !/^(inspection_over_cap|preservation_over_allowable|technology_fee_over_cap|einvoice_over_cap|code_violation_over_cap|post_sale_nonreimbursable)/.test(m));
  // rule 4 / FNMA_F105_ESCROW_ADV_CUTOFF_14 — insurance/HOA advances through the legal date + 14 (the gate evaluator decides; ./claims.ts keys the cut-off on event_date only)
  if (CUTOFF_ADVANCE_KINDS.has(l.kind) && l.paid_on !== null && !escrowAdvanceCutoff(l, c).open) messages.push(POST_SALE_TAG);
  let code = base.allowable_code; let cap = base.cap_cents; let ruleSet: string | null = null; let lifeUsed = 0n;
  const amount = base.amount_cents;
  const row = (k: string): AllowableRow | null => allowableFor(k, schedule);
  switch (l.kind) {
    case "attorney_fee": ruleSet = FCL_FEE_RULE_SET; break;
    case "inspection": {
      const type: F105InspectionType = l.f105_inspection_type ?? (l.inspection_type === "interior" ? "interior" : "exterior");
      const r = row(`inspection_${type}`); code = `inspection_${type}`; cap = r?.cap_cents ?? INSPECTION_CAPS_F105[type]; ruleSet = r?.rule_set ?? F105_LIMITS_RULE_SET;
      if (l.unit_cents > cap) messages.push(`inspection_over_cap cap=${cap}`);
      if (c.acquired_by_fnma && (l.service_date ?? l.paid_on ?? c.event_date) > c.event_date && !l.sf_cpm_directed) messages.push("post_acquisition_nonreimbursable");
      break;
    }
    case "preservation": {
      const r = l.preservation_code ? row(l.preservation_code) : null;
      if (!r) { if (!l.hometracker_bid_id) messages.push("preservation_code_missing: itemize under a PPM code or attach the approved hometracker_bid_id"); code = l.preservation_code ?? "preservation"; cap = null; }
      else {
        code = r.code; cap = r.cap_cents; ruleSet = r.rule_set; lifeUsed = used[r.code] ?? 0n;
        if (l.unit_cents > r.cap_cents && !l.hometracker_bid_id) messages.push(`preservation_over_allowable cap=${r.cap_cents}`);
        if (r.life_cap_cents !== undefined && lifeUsed + amount > r.life_cap_cents && !l.hometracker_bid_id) messages.push(`preservation_life_cap life=${r.life_cap_cents}`);
      }
      if (c.acquired_by_fnma && (l.service_date ?? l.paid_on ?? c.event_date) > c.event_date && !l.sf_cpm_directed) messages.push("post_acquisition_nonreimbursable");
      break;
    }
    case "technology": {
      const r = row("technology_fee"); code = "technology_fee"; cap = r?.cap_cents ?? 2_500n; ruleSet = r?.rule_set ?? TECH_FEE_RULE_SET; lifeUsed = used.technology_fee ?? 0n;
      if (lifeUsed + amount > cap) messages.push(`technology_fee_over_cap cap=${cap} life_of_default`);
      break;
    }
    case "einvoice": {
      const kind = l.einvoice_kind ?? "fcl"; const r = row(`einvoice_${kind}`); code = `einvoice_${kind}`; cap = r?.cap_cents ?? 500n; ruleSet = r?.rule_set ?? TECH_FEE_RULE_SET;
      lifeUsed = (used.einvoice_fcl ?? 0n) + (used.einvoice_bk ?? 0n);
      if (l.unit_cents > cap || (used[`einvoice_${kind}`] ?? 0n) + amount > cap) messages.push(`einvoice_over_cap cap=${cap} ${kind}`);
      const life = r?.life_cap_cents ?? 1_000n; if (lifeUsed + amount > life) messages.push(`einvoice_life_cap life=${life}`);
      break;
    }
    case "code_violation": {
      const r = row("code_violation"); code = "code_violation"; cap = r?.cap_cents ?? 100_000n; ruleSet = r?.rule_set ?? F105_LIMITS_RULE_SET; lifeUsed = used.code_violation ?? 0n;
      if (l.unit_cents > cap) messages.push(`code_violation_over_cap cap=${cap}`);
      const life = r?.life_cap_cents ?? 300_000n; if (lifeUsed + amount > life) messages.push(`code_violation_life_cap life=${life}`);
      break;
    }
    case "mortgage_release_doc": { const r = row("mortgage_release_doc_prep"); code = "mortgage_release_doc_prep"; cap = r?.cap_cents ?? 65_000n; ruleSet = r?.rule_set ?? F105_LIMITS_RULE_SET; break; }
    case "hoa": {
      const lowest = minCents(amount, c.hoa_declaration_max_cents, c.hoa_state_statutory_max_cents); cap = lowest === amount ? null : lowest; ruleSet = F105_LIMITS_RULE_SET; code = "hoa";
      if (lowest !== null && amount > lowest) messages.push(`hoa_over_lowest_of cap=${lowest}`);
      break;
    }
    case "mi_premium": {
      ruleSet = F105_LIMITS_RULE_SET; code = "mi_premium";
      const throughMonth = endOfMonth(c.event_date);
      if (l.service_end !== undefined && l.service_end > throughMonth) messages.push(`mi_premium_after_event_month through=${throughMonth}`);
      if (l.service_start !== undefined && c.default_date && l.service_start < c.default_date) messages.push(`mi_premium_before_default default=${c.default_date}`);
      break;
    }
    case "taxes": case "hazard": case "flood": case "attorney_cost": case "registration": ruleSet = F105_LIMITS_RULE_SET; break;
    default: break;
  }
  // rule 1 — recoverability and the indicator
  const indicator: NonrecoverableIndicator = l.nonrecoverable_indicator ?? "blank";
  if (indicator === "non_recoverable" && !l.legal_basis) messages.push("nonrecoverable_without_basis: cite the jurisdiction_rules / contract basis (E-5-05)");
  if (l.collected_from_borrower) messages.push("collected_from_borrower: book to advance_recoveries, no claim (E-5-05)");
  if (l.omitted_from_payoff_figure && (l.borrower_recoverable ?? true)) messages.push("e505_not_included");
  return { ok: messages.length === 0, amount_cents: amount, messages, allowable_code: code, cap_cents: cap, rule_set: ruleSet, life_of_loan_used_cents: lifeUsed, indicator };
}

// ---- rule 1 / schedules: nightly claim-candidate sweep -------------------------------------------------
export type AdvanceKind = "escrow_tax" | "escrow_hazard" | "escrow_flood" | "hoa" | "mi_premium" | "inspection" | "preservation" | "registration" | "utilities" | "attorney_fee_fcl" | "attorney_fee_bk" | "legal_cost" | "recording" | "valuation" | "mediation" | "technology_fee" | "einvoice_fee" | "workout_expense" | "delinquency_pi" | "other";
export interface AdvanceRow {
  readonly id: string; readonly loan_id: string; readonly kind: AdvanceKind; readonly amount_cents: Cents;
  readonly paid_at: PlainDate | null; readonly invoice_document_id: string | null; readonly allowable_code: string | null;
  readonly borrower_recoverable: boolean;
  /** Collected from the borrower at reinstatement/payoff/workout → `advance_recoveries`, no claim. */
  readonly collected_from_borrower?: boolean;
  /** Recoverable but left out of the reinstatement/payoff figure by our error (E-5-05). */
  readonly omitted_from_payoff_figure?: boolean;
  readonly claim_line_id?: string | null;
}
export type SweepSkipReason = "not_paid" | "missing_invoice" | "already_claimed" | "collected_from_borrower" | "e505_not_included" | "pi_advances_not_claimable";
export interface SweepResult { readonly candidates: readonly AdvanceRow[]; readonly skipped: readonly { advance_id: string; reason: SweepSkipReason }[]; readonly by_loan: Readonly<Record<string, Cents>>; }

/** Rule 1 — a line is claimable iff paid (invoice retained), not yet claimed, not collected from the borrower and not omitted by our error. */
export function sweepClaimCandidates(advances: readonly AdvanceRow[]): SweepResult {
  const candidates: AdvanceRow[] = []; const skipped: { advance_id: string; reason: SweepSkipReason }[] = []; const byLoan: Record<string, Cents> = {};
  for (const a of advances) {
    const reason: SweepSkipReason | null =
      a.kind === "delinquency_pi" ? "pi_advances_not_claimable"
      : a.claim_line_id ? "already_claimed"
      : a.collected_from_borrower ? "collected_from_borrower"
      : a.borrower_recoverable && a.omitted_from_payoff_figure ? "e505_not_included"
      : a.paid_at === null ? "not_paid"
      : a.invoice_document_id === null ? "missing_invoice" : null;
    if (reason) { skipped.push({ advance_id: a.id, reason }); continue; }
    candidates.push(a); byLoan[a.loan_id] = (byLoan[a.loan_id] ?? 0n) + a.amount_cents;
  }
  return { candidates, skipped, by_loan: byLoan };
}

// ---- milestone events that start the final-claim clock (Inputs and triggers) -------------------------------
export type MilestoneKind = "workout_completed" | "shortsale_closed" | "deferral_completed" | "tps_completed" | "reinstatement" | "payoff" | "reo_disposition" | "mortgage_release" | "foreclosure_sale" | "govt_claim_proceeds";
const MILESTONE_EVENTS: Readonly<Record<string, MilestoneKind>> = {
  "lossmit.modification.completed": "workout_completed", "shortsale.closed": "shortsale_closed", "lossmit.deferral.completed": "deferral_completed", "tps.completed": "tps_completed", "loan.reinstated": "reinstatement",
  "payoff.funds.cleared": "payoff", "reo.disposed_by_fnma": "reo_disposition", "mortgage_release.completed": "mortgage_release", "foreclosure.sale.held": "foreclosure_sale", "mi.claim.settled": "govt_claim_proceeds",
};
export const LIQUIDATION_MILESTONES: ReadonlySet<MilestoneKind> = new Set(["reo_disposition", "tps_completed", "shortsale_closed", "mortgage_release", "foreclosure_sale"]);
/** Maps a producing section's milestone event to the `claim.milestone.reached` fact that arms E501/F106/TARGET_20/CUTOFF_14 (never `lossmit.modification.effective`). */
export function milestoneReached(i: { event_type: string; loan_id: string; milestone_date: PlainDate; mi_insured: boolean; legal_date?: PlainDate | null }): { type: "claim.milestone.reached"; payload: { kind: MilestoneKind; loan_id: string; milestone_date: PlainDate; legal_date: PlainDate; mi_insured: boolean; completion_date: PlainDate } } | null {
  if (i.event_type === "lossmit.modification.effective") return null;
  const kind = MILESTONE_EVENTS[i.event_type]; if (!kind) return null;
  return { type: "claim.milestone.reached", payload: { kind, loan_id: i.loan_id, milestone_date: i.milestone_date, legal_date: i.legal_date ?? i.milestone_date, mi_insured: i.mi_insured, completion_date: i.milestone_date } };
}

// ---- rule 5: itemization and quantity ------------------------------------------------------------------
export interface ItemizedInput { readonly label: string; readonly unit_cents: Cents; readonly quantity: number; }
export interface ItemizedLine extends ItemizedInput { readonly amount_cents: Cents; }
/** Rule 5 — unit price × quantity = amount (cents, no rounding); quantities are whole numbers. */
export function itemize(items: readonly ItemizedInput[]): { lines: readonly ItemizedLine[]; total_cents: Cents } {
  const lines = items.map((it) => {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) throw new RangeError(`quantity for ${it.label} must be a positive whole number (Job Aid)`);
    return { ...it, amount_cents: it.unit_cents * BigInt(it.quantity) };
  });
  return { lines, total_cents: lines.reduce((s, l) => s + l.amount_cents, 0n) };
}

// ---- E-5-05 milestone billing (15.2-T5) ------------------------------------------------------------------
export const JUDICIAL_MILESTONES: Readonly<Record<string, number>> = { title_requested: 30, title_reviewed: 40, complaint_filed: 50, service_started: 60, service_complete: 70, judgment_prepared: 80, judgment_to_court: 90, bid_confirmed: 95, sale_held: 100 };
export const NON_JUDICIAL_MILESTONES: Readonly<Record<string, number>> = { title_requested: 30, title_reviewed: 65, notices_started: 75, first_legal: 85, sale_package: 95, sale_held: 100 };
export interface MilestoneInvoice { readonly milestone: string; readonly invoice_cents: Cents; }
export interface MilestoneBill { readonly milestone: string; readonly cumulative_pct: number; readonly earned_cents: Cents; readonly fee_line_cents: Cents; readonly over_cents: Cents; readonly out_of_order: boolean; }
/** E-5-05 — fees are earned at established milestones (cumulative % of the exhibit) and never prorated between milestones; an earlier milestone invoiced after a later one earns nothing more. */
export function milestoneBilling(exhibitCents: Cents, track: Track, invoices: readonly MilestoneInvoice[]): { bills: readonly MilestoneBill[]; total_fee_cents: Cents } {
  const sched = track === "judicial" ? JUDICIAL_MILESTONES : NON_JUDICIAL_MILESTONES;
  let billedPct = 0; let total = 0n; const bills: MilestoneBill[] = [];
  for (const inv of invoices) {
    const pct = sched[inv.milestone];
    if (pct === undefined) throw new RangeError(`${inv.milestone} is not an E-5-05 ${track} milestone — fees are not prorated between milestones`);
    const cumulative = Decimal.fromBigInt(exhibitCents).mul(Decimal.fromInt(pct)).div(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP");
    const previously = Decimal.fromBigInt(exhibitCents).mul(Decimal.fromInt(billedPct)).div(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP");
    const outOfOrder = pct <= billedPct;
    const earned = outOfOrder ? 0n : cumulative - previously;
    const feeLine = inv.invoice_cents < earned ? inv.invoice_cents : earned;
    bills.push({ milestone: inv.milestone, cumulative_pct: pct, earned_cents: earned, fee_line_cents: feeLine, over_cents: inv.invoice_cents > earned ? inv.invoice_cents - earned : 0n, out_of_order: outOfOrder });
    billedPct = Math.max(billedPct, pct); total += feeLine;
  }
  return { bills, total_fee_cents: total };
}

// ---- 15.2-T3: excess-fee approval request to the firm ----------------------------------------------------
export interface ExcessFeeRequest { readonly escalation: { kind: "attorney"; reason: string; cap_cents: Cents; invoice_cents: Cents; portal: "P360 Excess Fees and Costs" }; readonly before_submission: true; readonly line_claimable: false; }
/** Fees above the exhibit need SF CPM excess-fee approval obtained by the law firm through the P360 Excess Fees and Costs portal (E-5-04; Job Aid) — the agent asks the firm for the approval id before submission. */
export function excessFeeApprovalRequest(line: ClaimLine152, v: LineValidation, state: string): ExcessFeeRequest | null {
  const over = v.messages.find((m) => m.startsWith("attorney_fee_over_exhibit"));
  if (!over || line.approval_id || v.cap_cents === null) return null;
  return { escalation: { kind: "attorney", reason: `${state} attorney fee ${v.amount_cents} exceeds the exhibit cap ${v.cap_cents}: request the SF CPM excess-fee approval id from the firm (P360 Excess Fees and Costs) before submission`, cap_cents: v.cap_cents, invoice_cents: v.amount_cents, portal: "P360 Excess Fees and Costs" }, before_submission: true, line_claimable: false };
}

// ---- claim assembly → decision record -------------------------------------------------------------------
export type ClaimType = "571" | "fnma_mod" | "npl" | "hecm" | "recon" | "sol";
export interface AssembleInput {
  readonly loan_id: string; readonly claim_type: ClaimType; readonly milestone_kind: MilestoneKind; readonly milestone_date: PlainDate;
  readonly mi_insured: boolean; readonly disposition_date: PlainDate | null;
  readonly lines: readonly (ClaimLine152 & { readonly advance_id: string; readonly evidence_ids?: readonly string[] })[];
  readonly credits: readonly { kind: "hazard_refund" | "flood_refund" | "mi_refund" | "borrower_collection" | "escrow_balance" | "rents" | "other"; amount_cents: Cents; received_at: PlainDate }[];
  readonly context: ClaimContext152;
  /** E-4.4-02: a hazard refund is expected on this liquidation. */
  readonly hazard_refund_expected?: boolean;
  /** E-4.4-02: the carrier refused the refund; the comment goes on the final claim instead of a credit line. */
  readonly refund_refusal_comment?: string | null;
  readonly interim?: boolean;
  /** 15.2-T12 / edge case "Modification capitalized advances": the deferral's closing date, whether the loan has since paid off (P360 subtype) and the auto-generated incentive. */
  readonly deferral?: { readonly closed_on?: PlainDate | null; readonly post_payoff?: boolean; readonly incentive_cents?: Cents | null } | null;
}
export interface DecisionLine { readonly advance_id: string; readonly code: string; readonly amount: Cents; readonly cap: Cents | null; readonly rule_set: string | null; readonly validation: "pass" | "fail"; readonly indicator: NonrecoverableIndicator; readonly legal_basis: string | null; readonly evidence_ids: readonly string[]; readonly messages: readonly string[]; readonly p360_subtype: string | null; }
export type ExcludedReason = "collected_from_borrower" | "e505_not_included" | Rule4Tag;
export interface ExcludedLine { readonly advance_id: string; readonly reason: ExcludedReason; readonly tag: Rule4Tag | null; readonly amount: Cents; readonly messages: readonly string[]; }
export interface ClaimDecision {
  readonly loan_id: string; readonly claim_type: ClaimType; readonly milestone: MilestoneKind; readonly milestone_date: PlainDate;
  readonly final_due_at: PlainDate | null; readonly policy_due_at: PlainDate; readonly internal_target_at: PlainDate;
  readonly lines: readonly DecisionLine[];
  /** Lines left off the claim: rule 1 (collected / omitted by our error) and rule 4 (tagged non-reimbursable by date — 15.2-T4). */
  readonly excluded: readonly ExcludedLine[];
  readonly credits: readonly AssembleInput["credits"][number][];
  readonly gross: Cents; readonly net: Cents; readonly status: "draft" | "validated"; readonly exceptions: readonly string[]; readonly interim: boolean;
  readonly e4402_comment: string | null;
  /** Escalations the assembly raises (15.2-T3: the attorney request for the excess-fee approval id). */
  readonly escalations: readonly ExcessFeeRequest["escalation"][];
  /** The capitalized-advance / incentive rule for a `deferral_completed` claim (15.2-T12); null otherwise. */
  readonly deferral: DeferralRule | null;
}
/**
 * E-5-01 anchors: REO — Fannie Mae's disposition, whether the property was "acquired through foreclosure sale or a Fannie Mae Mortgage
 * Release" (unknown at the sale / release; F-1-06's 30 days from the settlement when MI-insured) — so a Mortgage Release is `reo` here, not a workout
 * (./claims.ts finalDueAt treats `mortgage_release` as event + 60, which is not the Guide's anchor — corrected by this mapping).
 */
const kindOf = (m: MilestoneKind): Parameters<typeof finalDueAt>[0]["kind"] => (m === "reo_disposition" || m === "foreclosure_sale" || m === "mortgage_release" ? "reo" : m === "tps_completed" ? "tps" : m === "shortsale_closed" ? "short_sale" : "workout");

/**
 * Agents paragraph — the decision record `{claim, milestone, final_due_at, lines[], credits[], gross, net, exceptions[]}`. Rule 1 sets the
 * indicator: liquidation claims leave it blank; at reinstatement/payoff/workout a collected line goes to `advance_recoveries` (no claim),
 * a legally non-recoverable line carries `non_recoverable` with its basis, an omitted-by-our-error line is not claimable, the rest are
 * `not_yet_recovered`. E-4.4-02 blocks a final claim without the refund credit or refusal comment.
 */
export function assembleClaim(i: AssembleInput): ClaimDecision {
  const due = finalDueAt({ event_date: i.milestone_date, mi_insured: i.mi_insured, disposition_date: i.disposition_date, kind: kindOf(i.milestone_kind) });
  const liquidation = LIQUIDATION_MILESTONES.has(i.milestone_kind);
  const deferral = i.milestone_kind === "deferral_completed" ? deferralRule({ completed_on: i.milestone_date, closed_on: i.deferral?.closed_on ?? i.milestone_date, post_payoff: i.deferral?.post_payoff ?? false, incentive_cents: i.deferral?.incentive_cents ?? null }) : null;
  const excluded: ExcludedLine[] = []; const kept: AssembleInput["lines"][number][] = []; const keptValidations: LineValidation152[] = [];
  for (const l of i.lines) {
    if (!liquidation && l.collected_from_borrower) { excluded.push({ advance_id: l.advance_id, reason: "collected_from_borrower", tag: null, amount: l.unit_cents * BigInt(l.quantity), messages: ["collected_from_borrower"] }); continue; }
    if (!liquidation && l.omitted_from_payoff_figure && (l.borrower_recoverable ?? true)) { excluded.push({ advance_id: l.advance_id, reason: "e505_not_included", tag: null, amount: l.unit_cents * BigInt(l.quantity), messages: ["e505_not_included"] }); continue; }
    const v = validateLine152(l, i.context);
    // rule 4 (15.2-T4): a line dated past the cut-off is tagged `post_sale_nonreimbursable` (or `post_acquisition_nonreimbursable`) and excluded — it is not a defect that holds the claim in draft
    const tag = RULE4_EXCLUSION_TAGS.find((t) => v.messages.includes(t));
    if (tag) { excluded.push({ advance_id: l.advance_id, reason: tag, tag, amount: v.amount_cents, messages: v.messages }); continue; }
    kept.push(l); keptValidations.push(v);
  }
  const subtype = deferral?.p360_subtype ?? null;
  const lines: DecisionLine[] = kept.map((l, k) => { const v = keptValidations[k]!; return { advance_id: l.advance_id, code: v.allowable_code, amount: v.amount_cents, cap: v.cap_cents, rule_set: v.rule_set, validation: v.ok ? "pass" : "fail", indicator: liquidation ? "blank" : (l.nonrecoverable_indicator ?? "not_yet_recovered"), legal_basis: l.legal_basis ?? null, evidence_ids: l.evidence_ids ?? [], messages: v.messages, p360_subtype: subtype }; });
  const totals = claimTotals(keptValidations, i.credits.map((c) => c.amount_cents));
  const exceptions = lines.filter((l) => l.validation === "fail").map((l) => `${l.advance_id}: ${l.messages.join(", ")}`);
  const escalations = kept.flatMap((l, k) => { const r = excessFeeApprovalRequest(l, keptValidations[k]!, i.context.state); return r ? [r.escalation] : []; });
  const hasHazardCredit = i.credits.some((c) => c.kind === "hazard_refund");
  const refusal = i.refund_refusal_comment ?? null;
  if (i.hazard_refund_expected && !i.interim && !hasHazardCredit && !refusal) exceptions.push("FNMA_E4402_REFUND_CREDIT_ON_FINAL: credit line missing and no refusal comment (E-4.4-02)");
  return { loan_id: i.loan_id, claim_type: i.claim_type, milestone: i.milestone_kind, milestone_date: i.milestone_date, final_due_at: due.final_due, policy_due_at: due.policy_due, internal_target_at: due.internal_target,
    lines, excluded, credits: [...i.credits], gross: totals.gross_cents, net: totals.net_cents, status: exceptions.length === 0 ? "validated" : "draft", exceptions, interim: i.interim ?? false, e4402_comment: !hasHazardCredit && refusal ? refusal : null, escalations, deferral };
}

// ---- bulk package + NPI screen (15.2-T13; Job Aid limits) ------------------------------------------------
export interface Attachment { readonly name: string; readonly line_index: number; readonly text: string; }
export interface BulkPackage {
  readonly ok: boolean; readonly blocked_by: readonly string[]; readonly findings: readonly { attachment: string; finding: "ssn_detected" }[];
  readonly xlsx_rows: readonly Record<string, unknown>[]; readonly json: { claim_number: string; line_count: number; attachment_names: readonly string[] }; readonly manifest: readonly string[];
}
const MAX_LINES = 100, MAX_ATTACHMENTS_PER_LINE = 5;
/** Job Aid — ZIP = .XLSX (Claims tab) + generated .JSON + attachments named per the manifest; ≤100 lines, ≤5 attachments per line; NPI must be removed (SSN screen blocks the package and logs the finding). */
export function buildBulkPackage(claim: ClaimDecision, claimNumber: string, attachments: readonly Attachment[]): BulkPackage {
  const blocked: string[] = []; const findings: { attachment: string; finding: "ssn_detected" }[] = [];
  if (claim.status !== "validated") blocked.push(`claim is ${claim.status}: ${claim.exceptions.join("; ")}`);
  if (claim.lines.length > MAX_LINES) blocked.push(`line count ${claim.lines.length} exceeds ${MAX_LINES} per claim`);
  const perLine = new Map<number, number>();
  for (const a of attachments) {
    perLine.set(a.line_index, (perLine.get(a.line_index) ?? 0) + 1);
    if (attachmentContainsSsn(a.text)) { findings.push({ attachment: a.name, finding: "ssn_detected" }); }
  }
  for (const [ix, n] of perLine) if (n > MAX_ATTACHMENTS_PER_LINE) blocked.push(`line ${ix} has ${n} attachments (max ${MAX_ATTACHMENTS_PER_LINE})`);
  if (findings.length) blocked.push(`redaction check failed: ${findings.map((f) => f.attachment).join(", ")} contain NPI`);
  const names = attachments.map((a) => a.name);
  const rows = claim.lines.map((l, k) => ({ claim_number: claimNumber, claim_type: claim.claim_type, line: k + 1, expense_code: l.code, amount_cents: l.amount, nonrecoverable_indicator: l.indicator, attachment_names: attachments.filter((a) => a.line_index === k).map((a) => a.name).join(";") }));
  return { ok: blocked.length === 0, blocked_by: blocked, findings, xlsx_rows: rows, json: { claim_number: claimNumber, line_count: claim.lines.length, attachment_names: names }, manifest: [`${claimNumber}.xlsx`, `${claimNumber}.json`, ...names] };
}

// ---- channel selection / API fallback (15.2-T11; Integrations "Failure") ---------------------------------
export interface ChannelInput { readonly api_credentialed: boolean; readonly api_status: number | null; readonly bulk_available?: boolean; readonly today: PlainDate; readonly final_due_at: PlainDate | null; readonly line_count: number; }
export interface ChannelDecision {
  readonly channel: "api" | "bulk_upload" | "single_entry"; readonly package_generated: boolean;
  readonly portal_task: { kind: "human_portal_task"; task: "p360.claims.bulk_upload" | "p360.claims.single_entry"; owner: "fnma_portal_operator"; opened_on: PlainDate; deadline_shown: PlainDate | null } | null;
  readonly fallback_by: PlainDate | null; readonly irt_late_filing_dispute: boolean; readonly screenshots_required: boolean; readonly reason: string;
}
/** 15.2-T11 — a 5xx from the Expense Claims API falls back to the bulk ZIP and a same-day portal task showing the deadline; on the deadline day with bulk down, single entry (≤3 lines) + screenshots + IRT dispute. */
export function submissionChannel(i: ChannelInput): ChannelDecision {
  const fallbackBy = i.final_due_at === null ? null : addDays(i.final_due_at, -5);
  const apiUp = i.api_credentialed && i.api_status !== null && i.api_status >= 200 && i.api_status < 300;
  if (apiUp) return { channel: "api", package_generated: false, portal_task: null, fallback_by: fallbackBy, irt_late_filing_dispute: false, screenshots_required: false, reason: "Expense Claims API accepted the payload" };
  const bulkUp = i.bulk_available ?? true;
  if (bulkUp) {
    return { channel: "bulk_upload", package_generated: true, portal_task: { kind: "human_portal_task", task: "p360.claims.bulk_upload", owner: "fnma_portal_operator", opened_on: i.today, deadline_shown: i.final_due_at }, fallback_by: fallbackBy, irt_late_filing_dispute: false, screenshots_required: false,
      reason: i.api_credentialed ? `API returned ${i.api_status ?? "no response"} on ${i.today} — bulk package generated` : "API not credentialed — bulk-upload launch channel" };
  }
  const deadlineDay = i.final_due_at !== null && i.today >= i.final_due_at;
  if (i.line_count <= 3 || deadlineDay) {
    return { channel: "single_entry", package_generated: false, portal_task: { kind: "human_portal_task", task: "p360.claims.single_entry", owner: "fnma_portal_operator", opened_on: i.today, deadline_shown: i.final_due_at }, fallback_by: fallbackBy, irt_late_filing_dispute: deadlineDay, screenshots_required: deadlineDay, reason: deadlineDay ? "P360 bulk path down on the deadline day — single-entry attempt with screenshots; IRT late-filing dispute" : "bulk path down; ≤3 lines entered singly" };
  }
  return { channel: "bulk_upload", package_generated: true, portal_task: { kind: "human_portal_task", task: "p360.claims.bulk_upload", owner: "fnma_portal_operator", opened_on: i.today, deadline_shown: i.final_due_at }, fallback_by: fallbackBy, irt_late_filing_dispute: false, screenshots_required: false, reason: "bulk path down; package staged for re-upload the same day (claim age not yet started)" };
}

// ---- rule 6: claim age --------------------------------------------------------------------------------------
export interface StoredClaimAge { readonly submitted_at?: PlainDate | string | null; readonly final_due_at?: PlainDate | null; readonly age_reset_count?: number; readonly status?: string; }
/** Rule 6 — submit once; a re-submission (edit after submission) resets the claim age to the new submission date: refused when that date is past `final_due_at`, else `age_reset_count++` and the deadlines re-evaluate against it. */
export function resubmissionCheck(claim: StoredClaimAge, submitOn: PlainDate): { resubmission: boolean; allowed: boolean; age_reset_count: number; age_from: PlainDate; refusal: string | null } {
  const resubmission = !!claim.submitted_at;
  const due = claim.final_due_at ?? null;
  if (resubmission && due !== null && submitOn > due) return { resubmission, allowed: false, age_reset_count: claim.age_reset_count ?? 0, age_from: submitOn, refusal: `NO_RESUBMIT_PAST_FINAL_DUE: re-submitting on ${submitOn} would push the claim age past final_due_at ${due} — file a PSA comment/attachment instead (rule 6)` };
  return { resubmission, allowed: true, age_reset_count: (claim.age_reset_count ?? 0) + (resubmission ? 1 : 0), age_from: submitOn, refusal: null };
}

// ---- PSA (15.2-T6) and ACH (15.2-T8) outcomes -------------------------------------------------------------
export function psaOutcome(enteredOn: PlainDate, respondedOn: PlainDate | null, today: PlainDate): { internal_due: PlainDate; response_due: PlainDate; status: "psa" | "submitted" | "denied"; severity: "sev1" | "sev2" | null; auto_denied: boolean } {
  const c = psaClocks(enteredOn);
  if (respondedOn !== null && respondedOn <= c.response_due) return { ...c, status: "submitted", severity: null, auto_denied: false };
  if (today > c.response_due) return { ...c, status: "denied", severity: "sev1", auto_denied: true };
  return { ...c, status: "psa", severity: today > c.internal_due ? "sev2" : null, auto_denied: false };
}
/** 15.2-T6 on the stored claims: every claim still in PSA past its 60-day countdown with no response recorded is auto-denied (sev-1); still-open ones past the internal 10 are sev-2. */
export function psaAutoDenialSweep(claims: readonly { claim_id: string; psa_at: PlainDate; psa_responded_at?: PlainDate | null }[], today: PlainDate): readonly { claim_id: string; outcome: ReturnType<typeof psaOutcome> }[] {
  return claims.map((c) => ({ claim_id: c.claim_id, outcome: psaOutcome(c.psa_at, c.psa_responded_at ?? null, today) })).filter((x) => x.outcome.auto_denied || x.outcome.severity !== null);
}
export const FNMA_REO_DISBURSEMENTS_MAILBOX = "FannieMae_REO_Disbursements@fanniemae.com";
export function achMatchOutcome(paidOn: PlainDate, matchedOn: PlainDate | null, today: PlainDate, cal: Calendar = fannieEt): { expected: PlainDate; escalate_after: PlainDate; status: "paid" | "awaiting_ach" | "unmatched"; escalation: { severity: "sev2"; package_to: string } | null } {
  const a = achExpected(paidOn, cal);
  if (matchedOn !== null) return { ...a, status: "paid", escalation: null };
  if (today > a.escalate_after) return { ...a, status: "unmatched", escalation: { severity: "sev2", package_to: FNMA_REO_DISBURSEMENTS_MAILBOX } };
  return { ...a, status: "awaiting_ach", escalation: null };
}

// ---- P360 status projector (weekly poll; state machine) ----------------------------------------------------
export type P360Status = "submitted" | "hold" | "approved" | "psa" | "paid" | "partially_paid" | "denied" | "curtailed" | "rejected" | "void";
export interface StatusUpdate { readonly claim_id: string; readonly p360_status: P360Status; readonly at: PlainDate; readonly paid_amount_cents?: Cents; readonly check_number?: string | null; readonly line_outcomes?: readonly { advance_id: string; status: "approved" | "denied" | "curtailed"; approved_cents?: Cents; reason?: string }[]; }
export interface ProjectedEvent { readonly type: string; readonly payload: Record<string, unknown>; }
export interface StatusProjection { readonly patch: Record<string, unknown>; readonly events: readonly ProjectedEvent[]; readonly changed: boolean; }
/** Spec state machine: Submitted/Hold stay `submitted`; PSA starts the 60-day countdown (+ internal 10); Paid sets the 3-BD ACH expectation; every poll refreshes, only a change moves the claim. */
export function projectStatusUpdate(stored: { status?: string; p360_status?: string | null }, u: StatusUpdate): StatusProjection {
  const status = u.p360_status === "hold" ? "submitted" : u.p360_status;
  const refreshed: ProjectedEvent = { type: "p360.claim.status_refreshed", payload: { claim_id: u.claim_id, p360_status: u.p360_status, status, at: u.at } };
  if ((stored.p360_status ?? stored.status) === u.p360_status) return { patch: { p360_status: u.p360_status }, events: [refreshed], changed: false };
  const patch: Record<string, unknown> = { status, p360_status: u.p360_status };
  const payload: Record<string, unknown> = { claim_id: u.claim_id, status, p360_status: u.p360_status, at: u.at };
  if (u.p360_status === "psa") { const c = psaClocks(u.at); Object.assign(patch, { psa_at: u.at, psa_due_at: c.response_due, psa_internal_due_at: c.internal_due }); Object.assign(payload, { psa_at: u.at, psa_due_at: c.response_due }); }
  if (u.p360_status === "paid" || u.p360_status === "partially_paid") { const a = achExpected(u.at); Object.assign(patch, { paid_at: u.at, paid_amount_cents: u.paid_amount_cents ?? null, check_number: u.check_number ?? null, ach_expected_by: a.expected }); Object.assign(payload, { paid_at: u.at, paid_amount_cents: u.paid_amount_cents ?? null, ach_expected_by: a.expected }); }
  if (u.line_outcomes?.length) patch.line_outcomes = u.line_outcomes;
  return { patch, events: [refreshed, { type: "p360.claim.status_changed", payload }], changed: true };
}

// ---- rule 10: curtailment / denial triage (15.2-T7) ---------------------------------------------------------
export type DenialReason = Parameters<typeof denialTriage>[0];
export interface DeniedLine { readonly advance_id: string; readonly loan_id: string; readonly amount_cents: Cents; readonly reason: DenialReason; readonly denied_on: PlainDate; }
export interface TriagedLine {
  readonly advance_id: string; readonly action: ReturnType<typeof denialTriage>;
  readonly irt: { category: "Expense Denied" | "Expense Curtailed"; file_by: PlainDate; evidence: readonly string[] } | null;
  readonly write_off: { amount_cents: Cents; authority: "agent" | "officer"; root_cause: DenialReason } | null;
}
/** Rule 10 — curable denials → IRT inquiry with evidence within 5 BD; policy denials → partner-loss write-off with the root cause; late-claim denials caused by a P360 outage are disputed with outage evidence. */
export function triageDenial(d: DeniedLine, cal: Calendar = fannieEt): TriagedLine {
  const action = denialTriage(d.reason);
  if (action === "write_off") return { advance_id: d.advance_id, action, irt: null, write_off: { amount_cents: d.amount_cents, authority: writeOffAuthority(d.amount_cents), root_cause: d.reason } };
  const evidence = action === "dispute_with_outage_evidence" ? ["p360_outage_screenshots", "single_entry_attempt_log", "submission_timestamps"] : ["invoice", "corrected_subtype"];
  return { advance_id: d.advance_id, action, irt: { category: "Expense Denied", file_by: irtInquiryDue(d.denied_on, cal), evidence }, write_off: null };
}
/** IRT Submitter User Manual — the submitter has seven calendar days from the Fannie Mae analyst's response. */
export function irtReplyDue(fnmaResponseOn: PlainDate): PlainDate { return addDays(fnmaResponseOn, 7); }

// ---- rule 7: credits received after payment (15.2-T10) --------------------------------------------------------
export type CreditKind = AssembleInput["credits"][number]["kind"];
/** Rule 7 — refunds received before the final claim are `claim_credits`; after payment they are remitted: 318 hazard, 336 MI within 30 days, 571 other. */
export function postPaymentCredit(i: { kind: CreditKind; amount_cents: Cents; received_at: PlainDate; claim_paid: boolean }): { treatment: "claim_credit" | "remit"; remit_code: "318" | "336" | "571" | null; due: PlainDate | null; amount_cents: Cents } {
  if (!i.claim_paid) return { treatment: "claim_credit", remit_code: null, due: null, amount_cents: i.amount_cents };
  const r = postPaymentRefund(i.kind === "hazard_refund" || i.kind === "flood_refund" ? "hazard" : i.kind === "mi_refund" ? "mi" : "other", i.received_at);
  return { treatment: "remit", remit_code: r.code, due: r.due, amount_cents: i.amount_cents };
}
/**
 * The credit as received against a stored claim (10.5's `mi.insurer.refund_received`, 9.5's unearned hazard refund, escrow balances, rents): a `claim_credits`
 * row and the fact that arms FNMA_F105_MI_REFUND_336_30 — `fnma_reimbursed_premium` is true only when the claim Fannie Mae paid carried an MI premium line.
 */
export function creditReceivedEvent(loanId: string, claimId: string, i: { kind: CreditKind; amount_cents: Cents; received_at: PlainDate }, claim: { paid_at?: PlainDate | string | null; status?: string; lines?: readonly { code: string }[] }): ProjectedEvent & { treatment: ReturnType<typeof postPaymentCredit> } {
  const paid = !!claim.paid_at || ["paid", "partially_paid", "closed"].includes(String(claim.status ?? ""));
  const t = postPaymentCredit({ kind: i.kind, amount_cents: i.amount_cents, received_at: i.received_at, claim_paid: paid });
  const premiumReimbursed = paid && i.kind === "mi_refund" && (claim.lines === undefined || claim.lines.some((l) => l.code === "mi_premium"));
  return { type: "expense_claim.credit.received", payload: { loan_id: loanId, claim_id: claimId, kind: i.kind, amount_cents: i.amount_cents, received_at: i.received_at, treatment: t.treatment, remit_code: t.remit_code, remit_due: t.due, fnma_reimbursed_premium: premiumReimbursed, claim_paid: paid }, treatment: t };
}

// ---- reconciliation-report / bank-feed match (monthly; SM_P360_ACH_MATCH_3BD) ---------------------------------
export interface PaidClaimRow { readonly claim_id: string; readonly loan_id: string; readonly paid_at: PlainDate; readonly paid_amount_cents: Cents; readonly ach_matched_entry_id?: string | null; }
export interface BankCredit { readonly entry_id: string; readonly amount_cents: Cents; readonly posted_on: PlainDate; readonly originator: string; }
export interface RemittanceLine { readonly code: "318" | "336" | "350" | "352" | "353" | "571"; readonly amount_cents: Cents; readonly settled_on: PlainDate; readonly loan_id: string; readonly claim_id?: string | null; }
export interface ReconcileResult {
  readonly matched: readonly { claim_id: string; entry_id: string; matched_on: PlainDate }[];
  readonly unmatched: readonly { claim_id: string; expected: PlainDate; escalate_after: PlainDate; status: "awaiting_ach" | "unmatched"; package: { to: string; contents: readonly string[] } | null }[];
  readonly settled: readonly RemittanceLine[];
  readonly events: readonly ProjectedEvent[];
}
/** ACH credits from Fannie Mae matched to Paid claims by amount within the 3-BD window (+2 BD tolerance); unmatched → package to the REO disbursements mailbox; report refunds/remittances → settled. */
export function reconcileReport(i: { paid_claims: readonly PaidClaimRow[]; bank_credits: readonly BankCredit[]; remittances: readonly RemittanceLine[]; today: PlainDate }, cal: Calendar = fannieEt): ReconcileResult {
  const used = new Set<string>(); const matched: ReconcileResult["matched"][number][] = []; const unmatched: ReconcileResult["unmatched"][number][] = []; const events: ProjectedEvent[] = [];
  for (const c of i.paid_claims) {
    if (c.ach_matched_entry_id) continue;
    const hit = i.bank_credits.find((b) => !used.has(b.entry_id) && b.amount_cents === c.paid_amount_cents && b.posted_on >= c.paid_at && /fannie/i.test(b.originator));
    if (hit) { used.add(hit.entry_id); matched.push({ claim_id: c.claim_id, entry_id: hit.entry_id, matched_on: hit.posted_on }); events.push({ type: "p360.payment.ach_matched", payload: { claim_id: c.claim_id, loan_id: c.loan_id, entry_id: hit.entry_id, amount_cents: c.paid_amount_cents, matched_on: hit.posted_on } }); continue; }
    const o = achMatchOutcome(c.paid_at, null, i.today, cal);
    unmatched.push({ claim_id: c.claim_id, expected: o.expected, escalate_after: o.escalate_after, status: o.status === "unmatched" ? "unmatched" : "awaiting_ach", package: o.escalation ? { to: o.escalation.package_to, contents: ["P360 File Details (check #/date/amount)", "bank statement for the ACH window", "claim number and servicer number"] } : null });
  }
  for (const r of i.remittances) events.push({ type: "remittance.special.settled", payload: { code: r.code, amount_cents: r.amount_cents, settled_on: r.settled_on, loan_id: r.loan_id, claim_id: r.claim_id ?? null } });
  return { matched, unmatched, settled: i.remittances, events };
}

// ---- payment deferral / capitalized advances (15.2-T12) --------------------------------------------------
export const CAPITALIZED_ADVANCE_CLAIM_FROM: PlainDate = "2023-10-01" as PlainDate;
/** Job Aid: workout incentive claims remain auto-generated (`P360AutoGenerated`) with a $1,000 cap — reconciled, never duplicated on our claim. */
export const WORKOUT_INCENTIVE_CAP_CENTS: Cents = 100_000n;
/** Job Aid: the P360 subtype reserved for post-payoff payment-deferral reimbursements; an active loan's deferral costs are itemized under their own line types. */
export const POST_PAYOFF_PD_SUBTYPE = "General Services – Post Payoff PD Reimbursement";
export interface DeferralRule {
  readonly claim_type: ClaimType; readonly due_at: PlainDate;
  /** Modifications/deferrals closed on/after Oct. 1, 2023: the capitalized advances must be claimed by us (no auto-generation); earlier closings were P360AutoGenerated. */
  readonly capitalized_advance_rule: "claim_required_no_auto_generation" | "auto_generated"; readonly lines_claimed_by_us: boolean;
  readonly p360_subtype: string | null;
  readonly incentive: { readonly p360_line: "P360AutoGenerated"; readonly on_claim: false; readonly cap_cents: Cents; readonly paid_cents: Cents | null; readonly expected_cents: Cents | null };
}
/** F-1-05 / Job Aid — the rule for a completed payment deferral: 60 days from completion; post-Oct-2023 capitalized advances are ours to claim; the incentive stays auto-generated ($1,000 cap); the post-payoff subtype only after a payoff. */
export function deferralRule(i: { completed_on: PlainDate; closed_on: PlainDate; post_payoff?: boolean; incentive_cents?: Cents | null }): DeferralRule {
  const required = i.closed_on >= CAPITALIZED_ADVANCE_CLAIM_FROM;
  const paid = i.incentive_cents ?? null;
  return { claim_type: "fnma_mod", due_at: addDays(i.completed_on, 60), capitalized_advance_rule: required ? "claim_required_no_auto_generation" : "auto_generated", lines_claimed_by_us: required,
    p360_subtype: i.post_payoff ? POST_PAYOFF_PD_SUBTYPE : null,
    incentive: { p360_line: "P360AutoGenerated", on_claim: false, cap_cents: WORKOUT_INCENTIVE_CAP_CENTS, paid_cents: paid, expected_cents: paid === null ? null : paid < WORKOUT_INCENTIVE_CAP_CENTS ? paid : WORKOUT_INCENTIVE_CAP_CENTS } };
}
/** 15.2-T12 — the deferral claim: itemized lines (claimed by us when the capitalized-advance rule requires it, else left to P360's auto-generation) with the rule applied. */
export function deferralExpenseClaim(i: { completed_on: PlainDate; closed_on: PlainDate; lines: readonly ItemizedInput[]; post_payoff?: boolean; incentive_cents?: Cents | null }): DeferralRule & { lines: readonly ItemizedLine[]; auto_generated_lines: readonly ItemizedLine[]; total_cents: Cents } {
  const rule = deferralRule(i); const it = itemize(i.lines);
  return { ...rule, lines: rule.lines_claimed_by_us ? it.lines : [], auto_generated_lines: rule.lines_claimed_by_us ? [] : it.lines, total_cents: rule.lines_claimed_by_us ? it.total_cents : 0n };
}
/** F-1-05 — a modification/deferral incentive is repaid (CRS 350) within 60 days of the cancellation when the workout is not re-entered within 30 days. */
export function incentiveRepayment(i: { cancellation_date: PlainDate; re_entered_on: PlainDate | null; incentive_cents: Cents; today: PlainDate }): { reenter_by: PlainDate; re_entered_within_30: boolean | null; repay: boolean; crs_code: "350"; fnma_repay_due_at: PlainDate; amount_cents: Cents } {
  const reenterBy = addDays(i.cancellation_date, 30);
  const reEntered = i.re_entered_on !== null && i.re_entered_on <= reenterBy ? true : i.today > reenterBy || i.re_entered_on !== null ? false : null;   // null: the 30-day re-entry window is still open
  return { reenter_by: reenterBy, re_entered_within_30: reEntered, repay: reEntered === false, crs_code: "350", fnma_repay_due_at: addDays(i.cancellation_date, 60), amount_cents: i.incentive_cents };
}

// ---- rule 8: recovered-advance repayment batch (15.2-T9) -------------------------------------------------
export interface ReimbursedAdvance { readonly advance_id: string; readonly reimbursed_cents: Cents; readonly reimbursed_on: PlainDate; }
export type RecoverySource = "borrower_reinstatement" | "payoff" | "repurchase";
export function recoveryRepaymentBatch(i: { completion_on: PlainDate; source: RecoverySource; collected_cents: Cents; reimbursed: readonly ReimbursedAdvance[] }): { crs_code: "353" | "352"; fnma_repay_due_at: PlainDate; recoveries: readonly { advance_id: string; amount_cents: Cents }[]; total_cents: Cents } {
  const fifo = [...i.reimbursed].sort((a, b) => (a.reimbursed_on < b.reimbursed_on ? -1 : a.reimbursed_on > b.reimbursed_on ? 1 : 0));
  let left = i.collected_cents; const recoveries: { advance_id: string; amount_cents: Cents }[] = [];
  for (const r of fifo) { if (left <= 0n) break; const take = r.reimbursed_cents < left ? r.reimbursed_cents : left; recoveries.push({ advance_id: r.advance_id, amount_cents: take }); left -= take; }
  return { crs_code: i.source === "borrower_reinstatement" ? "353" : "352", fnma_repay_due_at: addDays(i.completion_on, 60), recoveries, total_cents: recoveries.reduce((s, r) => s + r.amount_cents, 0n) };
}
/** Reimbursed advances FIFO-able from the paid claims on file: every line of a Paid claim, dated by the payment. */
export function reimbursedAdvancesFromClaims(claims: readonly { paid_at: PlainDate | null; lines: readonly { advance_id: string; amount: Cents }[] }[]): ReimbursedAdvance[] {
  return claims.flatMap((c) => (c.paid_at === null ? [] : c.lines.map((l) => ({ advance_id: l.advance_id, reimbursed_cents: l.amount, reimbursed_on: c.paid_at! }))));
}
/** The fact that arms FNMA_F105_RECOVERABLE_REPAY_60 (anchor `completion_date`): a repayment batch scheduled because Fannie Mae had already reimbursed the recovered advances. */
export function recoveryRepaymentEvent(loanId: string, i: { completion_on: PlainDate; source: RecoverySource }, batch: ReturnType<typeof recoveryRepaymentBatch>): ProjectedEvent | null {
  if (batch.total_cents <= 0n) return null;
  return { type: "advance_recovery.repayment_scheduled", payload: { loan_id: loanId, source: i.source, completion_date: i.completion_on, fnma_reimbursed_advances: true, crs_code: batch.crs_code, fnma_repay_due_at: batch.fnma_repay_due_at, total_cents: batch.total_cents, recoveries: batch.recoveries } };
}
/** The fact that arms FNMA_F105_INCENTIVE_REPAY_60 (anchor `cancellation_date`): a cancelled modification/deferral not re-entered within 30 days. */
export function incentiveRepaymentEvent(loanId: string, i: { cancellation_date: PlainDate; workout_id?: string | null }, r: ReturnType<typeof incentiveRepayment>): ProjectedEvent | null {
  if (!r.repay) return null;
  return { type: "workout_incentive.repayment_scheduled", payload: { loan_id: loanId, workout_id: i.workout_id ?? null, cancellation_date: i.cancellation_date, re_entered_within_30: false, crs_code: r.crs_code, fnma_repay_due_at: r.fnma_repay_due_at, amount_cents: r.amount_cents } };
}

// ---- guardrail thresholds ----------------------------------------------------------------------------------
export const OFFICER_DENIAL_BRIEFING_CENTS: Cents = 500_000n;
export const AGENT_WRITE_OFF_LINE_CAP_CENTS: Cents = 50_000n;
export interface DenialBriefing { readonly per_loan: Readonly<Record<string, Cents>>; readonly officer_briefing: boolean; readonly loans_over_threshold: readonly string[]; readonly systematic_reason: string | null; readonly newly_over_threshold: readonly string[]; readonly newly_systematic: boolean; }
/**
 * Agents paragraph — denials > $5,000 per loan (or a systematic pattern) → `officer` briefing. `denials` is the loan's cumulative denial history
 * (the poll accumulates it across calls); `prior` is the history before this poll so the briefing is raised when the threshold is crossed, not on every poll after.
 */
export function denialBriefing(denials: readonly { loan_id: string; amount_cents: Cents; reason: string }[], prior: readonly { loan_id: string; amount_cents: Cents; reason: string }[] = []): DenialBriefing {
  const tally = (ds: readonly { loan_id: string; amount_cents: Cents; reason: string }[]): { perLoan: Record<string, Cents>; over: string[]; systematic: string | null } => {
    const perLoan: Record<string, Cents> = {}; const byReason: Record<string, number> = {};
    for (const d of ds) { perLoan[d.loan_id] = (perLoan[d.loan_id] ?? 0n) + d.amount_cents; byReason[d.reason] = (byReason[d.reason] ?? 0) + 1; }
    return { perLoan, over: Object.entries(perLoan).filter(([, c]) => c > OFFICER_DENIAL_BRIEFING_CENTS).map(([l]) => l), systematic: Object.entries(byReason).find(([, n]) => n >= 3)?.[0] ?? null };
  };
  const now = tally(denials), before = tally(prior);
  const newlyOver = now.over.filter((l) => !before.over.includes(l));
  const newlySystematic = now.systematic !== null && before.systematic === null;
  return { per_loan: now.perLoan, officer_briefing: newlyOver.length > 0 || newlySystematic, loans_over_threshold: now.over, systematic_reason: now.systematic, newly_over_threshold: newlyOver, newly_systematic: newlySystematic };
}
/** Open question 4 default — agent ≤ $500/line; `officer` above. */
export function writeOffAuthority(lineCents: Cents): "agent" | "officer" { return lineCents <= AGENT_WRITE_OFF_LINE_CAP_CENTS ? "agent" : "officer"; }

/** Rule 10 — curable denials go to IRT within 5 BD; the Fannie Mae response starts the 7-day reply clock. */
export function irtInquiryDue(deniedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(deniedOn, 5, cal); }

// ---- 9.9 timers reused here (timer table): over-allowable preservation bids and Fannie Mae bid decisions ------------
/**
 * FNMA_PPM_OVER_ALLOWABLE_BID_15 — "over-allowable condition discovered → `preservation.bid.submitted` within 15 calendar days;
 * claim lines above allowables without a bid id fail validation". The condition is discovered when the assembly finds a preservation
 * line over its PPM cap (or life cap) with no `hometracker_bid_id`: the line fails (rule 2) and the HomeTracker bid clock starts.
 */
export interface OverAllowableCondition { readonly advance_id: string; readonly item: string; readonly amount_cents: Cents; readonly cap_cents: Cents | null; readonly discovered_on: PlainDate; readonly bid_due: PlainDate; }
export const OVER_ALLOWABLE_BID_DAYS = 15;
export const BID_RECONSIDER_DAYS = 7;
export function overAllowableConditions(claim: Pick<ClaimDecision, "lines">, discoveredOn: PlainDate): OverAllowableCondition[] {
  return claim.lines.filter((l) => l.validation === "fail" && l.messages.some((m) => m.startsWith("preservation_over_allowable") || m.startsWith("preservation_life_cap")))
    .map((l) => ({ advance_id: l.advance_id, item: l.code, amount_cents: l.amount, cap_cents: l.cap, discovered_on: discoveredOn, bid_due: addDays(discoveredOn, OVER_ALLOWABLE_BID_DAYS) }));
}
/** The fact that arms FNMA_PPM_OVER_ALLOWABLE_BID_15 (anchor `discovered_on`). */
export function overAllowableDiscoveredEvent(loanId: string, claimId: string, c: OverAllowableCondition): ProjectedEvent {
  return { type: "preservation.condition.discovered", payload: { loan_id: loanId, claim_id: claimId, advance_id: c.advance_id, item: c.item, over_allowable: true, amount_cents: c.amount_cents, cap_cents: c.cap_cents, discovered_on: c.discovered_on, bid_due: c.bid_due, portal: "HomeTracker" } };
}

/** HomeTracker bid feed (Inputs: "HomeTracker bid decisions (9.9)") — one record per bid: submitted, and once Fannie Mae decides, the decision. */
export type BidOutcome = "approved" | "denied" | "modified";
export interface HomeTrackerBidRecord {
  readonly bid_id: string; readonly advance_id: string; readonly claim_id?: string | null; readonly item?: string | null;
  readonly bid_cents: Cents; readonly submitted_on: PlainDate;
  readonly decided_on?: PlainDate | null; readonly outcome?: BidOutcome | null; readonly approved_cents?: Cents | null;
  /** The PPM cap the line is otherwise held to — an unreconsidered denial reduces the claimable amount to it. */
  readonly cap_cents?: Cents | null;
}
export interface IngestedBid {
  readonly bid_id: string; readonly advance_id: string; readonly claim_id: string | null; readonly item: string; readonly bid_cents: Cents; readonly submitted_on: PlainDate;
  readonly decided_on: PlainDate | null; readonly outcome: BidOutcome | null; readonly approved_cents: Cents | null; readonly reconsider_by: PlainDate | null;
  /** What the line may claim on the strength of this bid: approved → the bid; modified → the approved amount; denied (unreconsidered) → the PPM cap; undecided → the cap until the decision. */
  readonly claimable_cents: Cents; readonly events: readonly ProjectedEvent[];
}
const BID_OUTCOMES: ReadonlySet<string> = new Set(["approved", "denied", "modified"]);
/** Validates the inbound HomeTracker record and produces `preservation.bid.submitted` (satisfies FNMA_PPM_OVER_ALLOWABLE_BID_15) and, when decided, `preservation.bid.decided{outcome}` (denied/modified arms FNMA_PPM_BID_RECONSIDER_7 on `decided_on`). */
export function ingestHomeTrackerBid(loanId: string, r: HomeTrackerBidRecord): IngestedBid {
  if (!r.bid_id || !r.advance_id) throw new RangeError("HomeTracker bid record needs bid_id and advance_id");
  if (!r.submitted_on) throw new RangeError(`HomeTracker bid ${r.bid_id} needs submitted_on`);
  if (typeof r.bid_cents !== "bigint" || r.bid_cents <= 0n) throw new RangeError(`HomeTracker bid ${r.bid_id} needs a positive bid_cents`);
  const outcome = r.outcome ?? null;
  if (outcome !== null && !BID_OUTCOMES.has(outcome)) throw new RangeError(`HomeTracker bid ${r.bid_id}: outcome must be approved, denied or modified, not ${String(outcome)}`);
  if (outcome !== null && !r.decided_on) throw new RangeError(`HomeTracker bid ${r.bid_id}: a decision needs decided_on`);
  if (outcome === "modified" && (r.approved_cents === undefined || r.approved_cents === null)) throw new RangeError(`HomeTracker bid ${r.bid_id}: a modified bid needs approved_cents`);
  const decidedOn = outcome === null ? null : r.decided_on!;
  const item = r.item ?? "preservation"; const cap = r.cap_cents ?? 0n;
  const claimable = outcome === "approved" ? r.bid_cents : outcome === "modified" ? r.approved_cents! : cap;
  const reconsiderBy = outcome === "denied" || outcome === "modified" ? addDays(decidedOn!, BID_RECONSIDER_DAYS) : null;
  const events: ProjectedEvent[] = [{ type: "preservation.bid.submitted", payload: { loan_id: loanId, bid_id: r.bid_id, advance_id: r.advance_id, claim_id: r.claim_id ?? null, item, bid_cents: r.bid_cents, submitted_on: r.submitted_on, portal: "HomeTracker" } }];
  if (outcome !== null) events.push({ type: "preservation.bid.decided", payload: { loan_id: loanId, bid_id: r.bid_id, advance_id: r.advance_id, claim_id: r.claim_id ?? null, item, outcome, decided_on: decidedOn, approved_cents: outcome === "approved" ? r.bid_cents : outcome === "modified" ? r.approved_cents! : 0n, claimable_cents: claimable, reconsider_by: reconsiderBy } });
  return { bid_id: r.bid_id, advance_id: r.advance_id, claim_id: r.claim_id ?? null, item, bid_cents: r.bid_cents, submitted_on: r.submitted_on, decided_on: decidedOn, outcome, approved_cents: outcome === "modified" ? r.approved_cents! : outcome === "approved" ? r.bid_cents : null, reconsider_by: reconsiderBy, claimable_cents: claimable, events };
}
/**
 * FNMA_PPM_BID_RECONSIDER_7 — "Fannie Mae bid decision (denied/modified) → reconsideration submitted or accepted within 7 calendar days;
 * unreconsidered denials reduce the claimable amount". The reconsideration we submit in HomeTracker restores the bid as the claimable
 * amount pending Fannie Mae's answer; a reconsideration after the 7 days is recorded late (the timer breaches sev-3 and the line stays at the cap).
 */
export function bidReconsideration(loanId: string, bid: Pick<IngestedBid, "bid_id" | "advance_id" | "claim_id" | "outcome" | "decided_on" | "bid_cents" | "claimable_cents">, submittedOn: PlainDate, evidence: readonly string[]): { event: ProjectedEvent; reconsider_by: PlainDate; late: boolean; claimable_cents: Cents } {
  if (bid.outcome !== "denied" && bid.outcome !== "modified") throw new RangeError(`bid ${bid.bid_id} is ${bid.outcome ?? "undecided"} — only a denied or modified bid is reconsidered (PPM)`);
  if (!bid.decided_on) throw new RangeError(`bid ${bid.bid_id} has no decision date`);
  if (!evidence.length) throw new RangeError(`bid ${bid.bid_id}: a reconsideration needs supporting evidence (photos, revised scope, contractor estimate)`);
  const reconsiderBy = addDays(bid.decided_on, BID_RECONSIDER_DAYS); const late = submittedOn > reconsiderBy;
  const claimable = late ? bid.claimable_cents : bid.bid_cents;
  return { event: { type: "preservation.bid.reconsideration_submitted", payload: { loan_id: loanId, bid_id: bid.bid_id, advance_id: bid.advance_id, claim_id: bid.claim_id, outcome_reconsidered: bid.outcome, decided_on: bid.decided_on, submitted_on: submittedOn, reconsider_by: reconsiderBy, late, evidence, claimable_cents_pending: claimable } }, reconsider_by: reconsiderBy, late, claimable_cents: claimable };
}
