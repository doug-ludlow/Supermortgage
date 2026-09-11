/**
 * §20.1 Portfolio rate monitoring and refinance-opportunity detection — the deterministic rules of the `intake` agent
 * (spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-1-*.md). The trigger reads the SERVICING
 * portfolio through the investor-blind view `v_refi_universe` (rule 7: no `investor_id`, `fnma_loan_number`,
 * `pool_number`, `remittance_type`, `mbs_flag`, `sfc_codes`; `fnma_purchase_date` reaches only the recapture gate),
 * prices the candidate through 20.4's engine (`priceQuote`, rule set `fnma.llpa`), computes the benefit metrics
 * (rule 4), applies the fire rule (rule 5), the Fannie Mae / state gates (timer table) and the fair-lending controls
 * (rule 8), and hands `offer_ready` to 20.2 / `requested` to 20.3. One small function per rule / T-id; money is bigint
 * cents, rates 5 dp on the 0.125 % grid, rounding half-up to cents at the step stated.
 *
 * Reused, never re-implemented: levelPayment / monthlyInterest / ratePercent (src/kernel/money), prepaidInterest (30.2),
 * priceQuote / solvePassThrough / thirdPartyCosts (20.4), addBusinessDays + servicer / regzSpecific calendars (kernel).
 *
 * Events (every payload carries `origination: true` so the 20.1 timer rows arm — src/kernel/timers/engine.ts
 * isOriginationContext; `loanId` is the SERVICING loan the opportunity is about):
 *   refi.opportunity.detected{opportunity_id, loan_id, run_id, program_id, trigger_kind, transaction_type, property_state, borrower_interest_rule_applies, as_of_date}
 *       [arms FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M / FNMA_B2_1_3_03_TITLE_SEASONING_6M (transaction_type=cash_out), MA_183_28C_BORROWER_INTEREST_60M (property_state=MA, borrower_interest_rule_applies=true)]
 *   refi.opportunity.suppressed{opportunity_id, reason, reasons, opens_on}   [satisfies SM_REFI_OFFER_SLA_2BD's alternative branch by policy]
 *   refi.borrower_interest.determined{opportunity_id, pass, factors, months_since_consummation}   [satisfies MA_183_28C_BORROWER_INTEREST_60M]
 *   refi.opportunity.offer_ready{opportunity_id, detected_at, present_same_term_first, benefit_disclosure}   [arms SM_REFI_OFFER_SLA_2BD]
 *   refi.opportunity.offered{opportunity_id, offered_at, touch_id}   [written on 20.2's marketing.touch.sent{opportunity_id}; arms SM_REFI_OPPORTUNITY_EXPIRY_30 and SM_REFI_OFFER_FREQUENCY_CAP]
 *   refi.opportunity.engaged{opportunity_id, lead_id}   [written on 20.3's lead.created{opportunity_id}]
 *   refi.opportunity.requested{opportunity_id, requested_at, transaction_type, officer_acknowledgment_required}
 *   refi.opportunity.converted{application_id} · refi.opportunity.declined{declined_at, declined_on} · refi.opportunity.expired{expired_at}
 *   refi.trigger.run_completed{run_id, as_of_date, loans_in_universe, loans_evaluated, opportunities_detected, suppressed_by_reason}   [satisfies SM_REFI_TRIGGER_DAILY]
 *   refi.fair_lending_extract.written{run_id, extract_document_id}   [31.2 consumes]
 *   refi.opportunity.fnma_ownership.recorded{opportunity_id, fnma_owned}   [B2-1.3-02 > 95 % LTV check, after engagement only]
 */
import { createHash } from "node:crypto";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type Cents, centsToDecimal, levelPayment, monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addMonths, daysBetween, parts, plainDate, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, regzSpecific } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { prepaidInterest } from "../orig-boarding/ops-30-2.ts";
import { type QuoteContext, type QuoteInputs, type PricingQuote, type Occupancy, type PropertyType, type TransactionType, priceQuote, rateFromPct, pctOfCents } from "./ops-20-4.ts";

export const INTAKE_AGENT: Actor = { kind: "agent", id: "intake" };
export const RULE_SET_VERSION_20_1 = "sm.refi_trigger.v1";
export const ENGINE_VERSION_20_1 = "20.1-trigger.v1";
export const ET = "America/New_York";
/** Rule 2 / B2-1.3-02 (SEL-2025-08): LCOR cash back ≤ max(1 % of the new loan amount, $2,000). */
export const LCOR_CASH_BACK_FLOOR_CENTS = 200_000n;
export const LCOR_CASH_BACK_PCT = "1";
/** Rule 2: the loan amount rounds up to the next $1,000 only while the cash back stays under the cap. */
export const ROUNDING_STEP_CENTS = 100_000n;
/** Eligibility Matrix (DU 12.1, eff. Aug 5, 2026) LTV limits for the prescreen (rule 2). */
export const LTV_LIMITS_X10000 = { primary_fixed: 9700, primary_arm: 9500, second_home: 9000, investment: 7500, cash_out_primary: 8000, cash_out_second_home: 7500, cash_out_investment: 7500 } as const;
export const FNMA_OWNERSHIP_CHECK_LTV_X10000 = 9500;
/** M.G.L. c.183 §28C: a home loan consummated within the prior 60 months may be refinanced only in the borrower's interest. */
export const MA_28C_WINDOW_MONTHS = 60;
export const CANDIDATE_LOCK_DAYS = 45;
export const REFI_PRODUCT_CODE = "FRM30";

export class RefiRefused extends Error { readonly code: string; constructor(code: string, detail: string) { super(`${code}: ${detail}`); this.name = "RefiRefused"; this.code = code; } }
export class RefiRoleDenied extends Error { readonly code = "ROLE_DENIED"; readonly required: string; constructor(actor: Actor, required: string, what: string) { super(`${what} requires role ${required}; actor is ${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""}`); this.name = "RefiRoleDenied"; this.required = required; } }
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isHuman = (a: Actor, role: string): boolean => a.kind === "human" && a.role === role;
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))).digest("hex");
const dec = (s: string): Decimal => Decimal.parse(s);
const isoDateEt = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
export const money = (c: Cents): string => { const neg = c < 0n; const a = neg ? -c : c; const d = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `${neg ? "-" : ""}$${d}.${(a % 100n).toString().padStart(2, "0")}`; };
const maxC = (a: Cents, b: Cents): Cents => (a > b ? a : b);

// ============================================================ configuration (partner_programs; rule 6)
export type ProgramKind = "refi_self_improving";
export type ProductOwner = "partner" | "sm" | "third_party";
export interface PartnerProgram {
  readonly program_id: string; readonly partner_id: string; readonly kind: ProgramKind;
  /** Rule 6 (GLBA §1016.13): the refinance program is the PARTNER's product; SM's own products or a third-party lender's are refused / need a joint agreement. */
  readonly product_owner: ProductOwner; readonly joint_agreement_document_id?: string | null;
  readonly third_party_cost_recovery: "gain_on_sale_only"; readonly residual_treatment: "lender_credit" | "rate_step_down_only"; readonly residual_credit_cap_bps: string;
  readonly platform_fee_bps_annual: string; readonly platform_fee_payer: "partner" | "borrower";
  readonly min_rate_reduction_bps: number; readonly min_npv_cents: Cents; readonly holding_period_months: number; readonly discount_rate_basis: "new_note_rate";
  readonly max_offers_per_loan_per_12m: number; readonly resolicit_cooldown_days: number; readonly premium_recapture_suppression_days: number;
  readonly effective_from: PlainDate; readonly approved_by: string | null; readonly term_sheet_document_id: string | null;
}
/** The data-model defaults (term sheet parameters [UNVERIFIED] carried as configuration). */
export const DEFAULT_PROGRAM: PartnerProgram = { program_id: "prog-refi-partner-1", partner_id: "partner-1", kind: "refi_self_improving", product_owner: "partner", joint_agreement_document_id: null, third_party_cost_recovery: "gain_on_sale_only", residual_treatment: "lender_credit", residual_credit_cap_bps: "12.5", platform_fee_bps_annual: "12.5", platform_fee_payer: "partner",
  min_rate_reduction_bps: 25, min_npv_cents: 0n, holding_period_months: 84, discount_rate_basis: "new_note_rate", max_offers_per_loan_per_12m: 2, resolicit_cooldown_days: 90, premium_recapture_suppression_days: 120, effective_from: "2026-09-01" as PlainDate, approved_by: "human:u-officer", term_sheet_document_id: null };

/** Rule 6: every trigger read of servicing data is tagged with the program it serves (GLBA §1016.13 purpose limitation). */
export const purposeTag = (program: Pick<PartnerProgram, "program_id">): string => `partner_program:${program.program_id}`;
/** Rule 6 / T5 / O1-IT8: a program whose product owner is not the partner may not read servicing NPI (`glba_use_violation`); a third-party joint product needs the §1016.13(b) joint agreement. */
export function assertGlbaUse(program: PartnerProgram): string {
  if (program.kind !== "refi_self_improving") throw new RefiRefused("glba_use_violation", `partner_programs.kind ${String(program.kind)} is not a partner refinance program (12 CFR 1016.13(a): service-provider use is limited to the partner's own program)`);
  if (program.product_owner === "sm") throw new RefiRefused("glba_use_violation", "marketing SM's own products from the partner's servicing data is prohibited by default (12 CFR 1016.11(d), 1016.13; open question 3)");
  if (program.product_owner === "third_party" && !program.joint_agreement_document_id) throw new RefiRefused("glba_use_violation", "a joint product with a third-party lender needs a §1016.13(b) written joint agreement described in the partner's privacy notice");
  return purposeTag(program);
}

// ============================================================ investor blindness and the selection rule set (rules 1, 7, 8; T5)
export const INVESTOR_FIELDS: readonly string[] = ["investor_id", "investor", "fnma_loan_number", "pool_number", "remittance_type", "mbs_flag", "sfc_codes", "mbs_pool", "investor_name"];
export const PROHIBITED_SELECTION_FIELDS: readonly string[] = ["zip", "zip_code", "postal_code", "census_tract", "language_preference", "preferred_language", "age", "date_of_birth", "name", "legal_name", "borrower_name", "race", "ethnicity", "sex", "gender", "national_origin", "religion", "marital_status", "applicant_demographics", "credit_score", "representative_score_pull"];
/** Rule 8: the only columns the objective selection rule set may read. */
export const SELECTION_COLUMN_ALLOWLIST: readonly string[] = ["loan_id", "status", "note_rate_pct", "upb_cents", "remaining_term_months", "amortization", "product_code", "occupancy", "ltv_estimate", "property_state", "regx_days_delinquent", "mi_status", "mi_monthly_cents", "refi_do_not_solicit", "consent_flags", "bankruptcy_active", "foreclosure_referred", "lossmit_plan_active", "deceased_or_sii_pending", "transfer_out_pending", "escrowed", "pi_cents", "escrow_monthly_cents", "value_estimate", "note_date", "first_payment_date", "original_upb_cents", "original_term_months", "arm_first_adjustment_date"];
export interface RefiRuleSet { readonly version: string; readonly referenced_columns: readonly string[]; readonly approved_by: string | null; readonly reviewed_by_compliance: boolean; readonly view_definition_hash: string; }
export const SM_REFI_RULE_SET_V1: RefiRuleSet = { version: RULE_SET_VERSION_20_1, referenced_columns: SELECTION_COLUMN_ALLOWLIST, approved_by: "human:u-officer", reviewed_by_compliance: true, view_definition_hash: sha(SELECTION_COLUMN_ALLOWLIST) };
/** T5 / O1-IT7: the static check fails the build when the rule set references an investor field or a prohibited-basis proxy; the run cannot start. */
export function staticCheckRuleSet(rs: RefiRuleSet): { ok: true; columns: number } {
  const bad = rs.referenced_columns.filter((c) => INVESTOR_FIELDS.includes(c) || INVESTOR_FIELDS.some((f) => c.startsWith(`${f}.`)));
  if (bad.length) throw new RefiRefused("rule_set_static_check_failed", `selection rule set ${rs.version} references investor field(s) ${bad.join(", ")} (B2-1.3-04: the selection may never read investor identity)`);
  const proxy = rs.referenced_columns.filter((c) => PROHIBITED_SELECTION_FIELDS.includes(c) || c.startsWith("applicant_demographics"));
  if (proxy.length) throw new RefiRefused("rule_set_static_check_failed", `selection rule set ${rs.version} references prohibited-basis input(s) ${proxy.join(", ")} (Reg B §1002.4/§1002.5(b); rule 8)`);
  const unknown = rs.referenced_columns.filter((c) => !SELECTION_COLUMN_ALLOWLIST.includes(c));
  if (unknown.length) throw new RefiRefused("rule_set_static_check_failed", `selection rule set ${rs.version} references column(s) outside the allowlist: ${unknown.join(", ")} (officer + compliance-sentinel sign-off required for a view change)`);
  if (!rs.approved_by) throw new RefiRefused("rule_set_not_approved", `selection rule set ${rs.version} is not approved by the partner officer`);
  return { ok: true, columns: rs.referenced_columns.length };
}
/** Rule 7: a `v_refi_universe` row that carries an investor field is refused before the rule engine sees it. */
export function assertInvestorBlind(row: Record<string, unknown>): void {
  const hit = Object.keys(row).filter((k) => INVESTOR_FIELDS.includes(k));
  if (hit.length) throw new RefiRefused("investor_field_visible", `v_refi_universe row exposes ${hit.join(", ")} — the trigger's read model is investor-blind by construction (B2-1.3-04)`);
  const proxy = Object.keys(row).filter((k) => PROHIBITED_SELECTION_FIELDS.includes(k));
  if (proxy.length) throw new RefiRefused("prohibited_basis_input", `selection input carries ${proxy.join(", ")} (rule 8)`);
}

// ============================================================ the universe (rule 1)
export type MiStatus = "none" | "bpmi_active" | "lpmi" | "cancelled" | "terminated";
export interface ValueEstimate { readonly source: "origination_indexed" | "avm"; readonly value_cents: Cents; readonly as_of: PlainDate; readonly confidence: "high" | "medium" | "low"; }
/** One row of `v_refi_universe` (investor-blind): servicing facts the selection may read plus the candidate-construction inputs. */
export interface UniverseLoan {
  readonly loan_id: string; readonly partner_id: string; readonly status: "active" | "paid_off" | "foreclosed" | "reo" | "transferred_out" | "repurchased" | "charged_off" | "staged";
  readonly product_code: string; readonly amortization: "fixed" | "arm"; readonly note_date: PlainDate; readonly first_payment_date: PlainDate; readonly consummation_date: PlainDate; readonly title_date: PlainDate;
  readonly original_upb_cents: Cents; readonly original_term_months: number; readonly note_rate_pct: string; readonly pi_cents: Cents; readonly payments_made: number; readonly upb_cents: Cents; readonly next_due_date: PlainDate; readonly remaining_term_months: number;
  readonly escrowed: boolean; readonly escrow_monthly_cents: Cents; readonly net_escrow_deposit_estimate_cents: Cents; readonly taxes_annual_cents: Cents | null; readonly insurance_annual_cents: Cents | null;
  readonly mi_status: MiStatus; readonly mi_monthly_cents: Cents; readonly occupancy: Occupancy; readonly property_type: PropertyType; readonly units: 1 | 2 | 3 | 4; readonly property_state: string; readonly county: string; readonly county_limit_cents: Cents | null;
  readonly value_estimate: ValueEstimate; readonly representative_score: number | null; readonly score_source: "origination_file";
  readonly regx_days_delinquent: number; readonly bankruptcy_active: boolean; readonly foreclosure_referred: boolean; readonly lossmit_plan_active: boolean; readonly deceased_or_sii_pending: boolean; readonly transfer_out_pending: boolean;
  readonly refi_do_not_solicit: boolean; readonly refi_last_offered_at: string | null; readonly refi_offers_12m: number; readonly arm_first_adjustment_date: PlainDate | null;
}
/** Facts the GATES read (never the selection): the recapture anchor (29.4's `fnma_purchase_date`), the last decline, the rolling offer history. */
export interface GateFacts { readonly fnma_purchase_date: PlainDate | null; readonly declined_on: PlainDate | null; readonly offered_at: readonly string[]; }
export const NO_GATE_FACTS: GateFacts = { fnma_purchase_date: null, declined_on: null, offered_at: [] };
export type Path = "proactive" | "borrower_request";
export type ExclusionReason = "not_active" | "bankruptcy_active" | "foreclosure_referred" | "lossmit_plan_active" | "delinquent" | "marketing_suppression" | "deceased_or_sii_pending" | "transfer_out_pending" | "premium_recapture_window" | "cooldown" | "frequency_cap";
export interface UniverseResult { readonly purpose: string; readonly included: UniverseLoan[]; readonly excluded: { loan_id: string; reason: ExclusionReason; opens_on: PlainDate | null }[]; readonly loans_in_universe: number; }
/**
 * Rule 1: every active loan on the subserviced book (any investor, any remittance type) minus the exclusions; the
 * premium-recapture window, the cooldown and the frequency cap apply to the proactive path only (the borrower-request
 * path is unaffected). Every read is tagged `purpose=partner_program:<program_id>` (rule 6).
 */
export function loadUniverse(program: PartnerProgram, ruleSet: RefiRuleSet, rows: readonly UniverseLoan[], facts: Readonly<Record<string, GateFacts>>, asOf: PlainDate, path: Path = "proactive"): UniverseResult {
  const purpose = assertGlbaUse(program);
  staticCheckRuleSet(ruleSet);
  plainDate(asOf);
  const included: UniverseLoan[] = []; const excluded: UniverseResult["excluded"] = [];
  for (const row of rows) {
    assertInvestorBlind(row as unknown as Record<string, unknown>);
    const f = facts[row.loan_id] ?? NO_GATE_FACTS;
    const out = (reason: ExclusionReason, opens_on: PlainDate | null = null) => excluded.push({ loan_id: row.loan_id, reason, opens_on });
    if (row.status !== "active") { out("not_active"); continue; }
    if (row.bankruptcy_active) { out("bankruptcy_active"); continue; }
    if (row.foreclosure_referred) { out("foreclosure_referred"); continue; }
    if (row.lossmit_plan_active) { out("lossmit_plan_active"); continue; }
    if (row.deceased_or_sii_pending) { out("deceased_or_sii_pending"); continue; }
    if (row.transfer_out_pending) { out("transfer_out_pending"); continue; }
    if (path === "proactive") {
      if (row.regx_days_delinquent > 0) { out("delinquent"); continue; }                           // open question 6: current loans only
      if (row.refi_do_not_solicit) { out("marketing_suppression"); continue; }
      const rec = premiumRecaptureGate({ fnma_purchase_date: f.fnma_purchase_date, as_of: asOf, days: program.premium_recapture_suppression_days });
      if (!rec.open) { out("premium_recapture_window", rec.opens_on); continue; }
      const cd = resolicitCooldownGate({ declined_on: f.declined_on, as_of: asOf, days: program.resolicit_cooldown_days });
      if (!cd.open) { out("cooldown", cd.opens_on); continue; }
      const cap = offerFrequencyCapGate({ offered_at: f.offered_at, as_of: asOf, max_offers_per_loan_per_12m: program.max_offers_per_loan_per_12m });
      if (!cap.open) { out("frequency_cap", cap.opens_on); continue; }
    }
    included.push(row);
  }
  return { purpose, included, excluded, loans_in_universe: rows.filter((r) => r.status === "active").length };
}

// ============================================================ amortization arithmetic (worked example 1)
/** Scheduled interest each period is rounded half-up (F-1-09); the balance after `n` scheduled payments. */
export function balanceAfter(startCents: Cents, noteRatePct: string, piCents: Cents, n: number): Cents {
  const r = ratePercent(noteRatePct); let u = startCents;
  for (let i = 0; i < n; i++) { const int = monthlyInterest(u, r); u -= piCents - int; if (u < 0n) return 0n; }
  return u;
}
/** Scheduled UPB after `paymentsMade` payments on the original terms ($565,000 at 7.000 % after 24 payments = $553,106.41). */
export const scheduledUpb = (originalCents: Cents, noteRatePct: string, termMonths: number, paymentsMade: number): Cents => balanceAfter(originalCents, noteRatePct, levelPayment(originalCents, ratePercent(noteRatePct), termMonths), paymentsMade);
/** Per diem at note_rate / 365 on the current balance, half-up ($553,106.41 × 7.000 % / 365 = $106.08). */
export const perDiem365 = (upbCents: Cents, noteRatePct: string): Cents => centsToDecimal(upbCents).mul(ratePercent(noteRatePct)).div(Decimal.fromInt(365)).toCents("HALF_UP");
export interface PayoffEstimate { readonly upb_cents: Cents; readonly per_diem_cents: Cents; readonly days: number; readonly payoff_cents: Cents; readonly through: PlainDate; }
/** Payoff estimate through the disbursement date: scheduled balance + per diem × days from the next due date ($553,106.41 + 11 × $106.08 = $554,273.29). */
export function payoffEstimate(loan: Pick<UniverseLoan, "upb_cents" | "note_rate_pct" | "next_due_date">, through: PlainDate): PayoffEstimate {
  const days = Math.max(0, daysBetween(loan.next_due_date, through));
  const per_diem_cents = perDiem365(loan.upb_cents, loan.note_rate_pct);
  return { upb_cents: loan.upb_cents, per_diem_cents, days, payoff_cents: loan.upb_cents + per_diem_cents * BigInt(days), through };
}
/** Remaining interest on the existing loan = pi × remaining_term − upb (336 × $3,758.96 − $553,106.41 = $709,904.15). */
export const remainingInterest = (piCents: Cents, remainingMonths: number, upbCents: Cents): Cents => piCents * BigInt(remainingMonths) - upbCents;
/** NPV of a level monthly delta over H months at r/12: Σ delta / (1 + r/12)^m, rounded half-up to cents at the end ($356.34 × 84 at 6.125 % = $24,292.78). */
export function npvOfDelta(deltaCents: Cents, annualRate: string, months: number): Cents {
  const rm = dec(annualRate).div(Decimal.fromInt(12)); const d = centsToDecimal(deltaCents);
  let f = Decimal.ONE; let sum = Decimal.ZERO;
  for (let m = 1; m <= months; m++) { f = f.mul(Decimal.ONE.add(rm)); sum = sum.add(d.div(f)); }
  return sum.toCents("HALF_UP");
}
/** `rate_delta_bps = (r0 − r1) × 10,000` to one decimal (7.000 % → 6.125 % = 87.5). */
export const rateDeltaBps = (r0: string, r1: string): number => Number(dec(r0).sub(dec(r1)).mul(Decimal.fromInt(10_000)).toFixed(1, "HALF_UP"));
/** Whole months from `a` to `b` (Feb 6, 2023 → Nov 6, 2026 = 45). */
export function monthsBetween(a: PlainDate, b: PlainDate): number { const pa = parts(a), pb = parts(b); let m = (pb.y - pa.y) * 12 + (pb.m - pa.m); if (pb.d < pa.d) m -= 1; return m; }
/**
 * T11: the engine's P&I with its formula trace — a test (or a downstream document) asserting a different figure fails
 * with the trace, never silently ($560,000 at 6.125 %: 340261.90… → $3,402.62; $3,402.63 does not reproduce).
 */
export function assertPi(loanCents: Cents, noteRatePct: string, termMonths: number, expectedCents: Cents): { pi_cents: Cents; trace: string } {
  const r = ratePercent(noteRatePct); const rm = r.div(Decimal.fromInt(12)); const growth = Decimal.ONE.add(rm).pow(termMonths);
  const unrounded = centsToDecimal(loanCents).mul(rm).mul(growth).div(growth.sub(Decimal.ONE));
  const pi = levelPayment(loanCents, r, termMonths);
  const trace = `P&I = L × r/12 ÷ (1 − (1 + r/12)^−n) = ${money(loanCents)} × ${noteRatePct}%/12 ÷ (1 − (1 + ${rm.toFixed(10, "HALF_UP")})^−${termMonths}) = ${unrounded.toFixed(4, "HALF_UP")} → round_half_up = ${money(pi)}`;
  if (pi !== expectedCents) throw new RefiRefused("pi_mismatch", `asserted ${money(expectedCents)} does not reproduce: ${trace}`);
  return { pi_cents: pi, trace };
}

// ============================================================ candidate construction (rule 2)
export type TriggerKind = "scheduled" | "rate_move" | "borrower_request" | "mi_removal" | "arm_reset_ahead" | "term_change";
export interface CandidateSchedule { readonly consummation_date: PlainDate; readonly disbursement_date: PlainDate; readonly first_payment_date: PlainDate; readonly expected_purchase_ready_date: PlainDate; }
/** The run's standard schedule: consummation 36 days out, disbursement after rescission (+6), first payment on the 1st after the following month, Purchase Ready a week after disbursement (fixture: Oct 1 → Nov 6 / Nov 12 / Jan 1 / Nov 19). */
export function defaultSchedule(asOf: PlainDate): CandidateSchedule {
  const consummation_date = addDays(asOf, 36); const disbursement_date = addDays(consummation_date, 6);
  const p = parts(addMonths(disbursement_date, 1)); const first_payment_date = addMonths(ymd(p.y, p.m, 1), 1);
  return { consummation_date, disbursement_date, first_payment_date, expected_purchase_ready_date: addDays(disbursement_date, 7) };
}
export interface CandidateTerms {
  readonly transaction_type: TransactionType; readonly product_code: string; readonly term_months: number; readonly amortization: "fixed";
  readonly payoff_estimate_cents: Cents; readonly per_diem_cents: Cents; readonly payoff_days: number; readonly prepaid_interest_cents: Cents; readonly prepaid_days: number; readonly net_escrow_deposit_cents: Cents;
  readonly loan_amount_cents: Cents; readonly rounded_to_thousand: boolean; readonly cash_back_cents: Cents; readonly cash_back_cap_cents: Cents; readonly cash_out_requested_cents: Cents;
  readonly value_cents: Cents; readonly value_source: ValueEstimate["source"]; readonly ltv: string; readonly ltv_x10000: number;
  readonly schedule: CandidateSchedule; readonly note_rate: string | null; readonly pi_cents: Cents | null; readonly quote_id: string | null;
}
export interface EligibilityPrescreen { readonly ltv_ok: boolean; readonly seasoning_ok: boolean; readonly occupancy_ok: boolean; readonly delinquency_ok: boolean; readonly product_ok: boolean; readonly state_rule_ok: boolean | null; readonly requires_fnma_ownership_check: boolean; readonly fnma_owned: boolean | null; readonly ltv_limit_x10000: number; readonly reasons: readonly string[]; }
/** B2-1.3-02 / SEL-2025-08: cash back cap = max(1 % of the new loan amount, $2,000). */
export const cashBackCap = (loanCents: Cents): Cents => maxC(pctOfCents(loanCents, LCOR_CASH_BACK_PCT), LCOR_CASH_BACK_FLOOR_CENTS);
const roundUpToThousand = (c: Cents): Cents => ((c + ROUNDING_STEP_CENTS - 1n) / ROUNDING_STEP_CENTS) * ROUNDING_STEP_CENTS;
/** LTV = loan / value to 4 dp (0.7000) — the value is the indexed origination value or an AVM, never an appraisal. */
export function ltvOf(loanCents: Cents, valueCents: Cents): { ltv: string; x10000: number } { if (valueCents <= 0n) throw new RangeError("value_cents must be positive"); const x = Number(divRound(loanCents * 10_000n, valueCents, "HALF_UP")); return { ltv: (x / 10_000).toFixed(4), x10000: x }; }
export function ltvLimit(occupancy: Occupancy, amortization: "fixed" | "arm", transaction: TransactionType): number {
  if (transaction === "cash_out") return occupancy === "primary" ? LTV_LIMITS_X10000.cash_out_primary : occupancy === "second_home" ? LTV_LIMITS_X10000.cash_out_second_home : LTV_LIMITS_X10000.cash_out_investment;
  return occupancy === "primary" ? (amortization === "fixed" ? LTV_LIMITS_X10000.primary_fixed : LTV_LIMITS_X10000.primary_arm) : occupancy === "second_home" ? LTV_LIMITS_X10000.second_home : LTV_LIMITS_X10000.investment;
}
/**
 * Rule 2: LCOR (30-year fixed by default; also a term equal to the remaining term), loan amount = payoff estimate +
 * prepaid interest + net escrow deposit, rounded up to the next $1,000 only while cash back ≤ max(1 %, $2,000);
 * cash-out only on borrower request. Value = indexed origination value / AVM (low confidence widens the band: > 90 %
 * suppressed). The > 95 % Fannie Mae-ownership condition is an eligibility flag verified after engagement (T9).
 */
export function buildCandidate(loan: UniverseLoan, o: { transaction_type?: TransactionType; term_months?: number; schedule?: CandidateSchedule; as_of: PlainDate; borrower_request?: boolean; cash_out_requested_cents?: Cents }): { candidate: CandidateTerms; prescreen: EligibilityPrescreen } {
  const transaction_type = o.transaction_type ?? "limited_cash_out";
  if (transaction_type === "purchase") throw new RangeError("a refinance candidate is limited_cash_out or cash_out");
  if (transaction_type === "cash_out" && !o.borrower_request) throw new RefiRefused("cash_out_requires_borrower_request", "cash-out candidates are constructed only on borrower request, never proactively (rule 2; guardrail)");
  const schedule = o.schedule ?? defaultSchedule(o.as_of);
  const payoff = payoffEstimate(loan, schedule.disbursement_date);
  const term_months = o.term_months ?? 360;
  // prepaid interest at the note rate is unknown before pricing; the amount estimate uses the existing note rate (per diem on the new balance is re-stated by 20.4 on the quote)
  const raw = payoff.payoff_cents + prepaidInterest(payoff.payoff_cents, loan.note_rate_pct, schedule.disbursement_date).prepaid_interest_cents + loan.net_escrow_deposit_estimate_cents + (o.cash_out_requested_cents ?? 0n);
  const rounded = roundUpToThousand(raw);
  const cashBack = (L: Cents) => L - payoff.payoff_cents - prepaidInterest(L, loan.note_rate_pct, schedule.disbursement_date).prepaid_interest_cents - (o.cash_out_requested_cents ?? 0n);
  const useRounded = transaction_type === "limited_cash_out" ? cashBack(rounded) <= cashBackCap(rounded) : true;
  const loan_amount_cents = useRounded ? rounded : raw;
  const prepaid = prepaidInterest(loan_amount_cents, loan.note_rate_pct, schedule.disbursement_date);
  const cash_back_cents = loan_amount_cents - payoff.payoff_cents - prepaid.prepaid_interest_cents - (o.cash_out_requested_cents ?? 0n);
  const { ltv, x10000 } = ltvOf(loan_amount_cents, loan.value_estimate.value_cents);
  const limit = ltvLimit(loan.occupancy, "fixed", transaction_type);
  const reasons: string[] = [];
  const ltv_ok = x10000 <= limit && !(loan.value_estimate.confidence === "low" && x10000 > 9000);
  if (!ltv_ok) reasons.push(x10000 > limit ? `ltv ${ltv} exceeds ${limit / 100}% (Eligibility Matrix)` : "value_confidence=low and ltv > 90%");
  const occupancy_ok = ["primary", "second_home", "investment"].includes(loan.occupancy); if (!occupancy_ok) reasons.push("occupancy");
  const product_ok = loan.amortization === "fixed" || loan.amortization === "arm"; if (!product_ok) reasons.push("product");
  const delinquency_ok = loan.regx_days_delinquent === 0; if (!delinquency_ok) reasons.push("delinquent");
  if (transaction_type === "limited_cash_out" && cash_back_cents > cashBackCap(loan_amount_cents)) reasons.push("cash_back_exceeds_cap");
  const requires_fnma_ownership_check = x10000 > FNMA_OWNERSHIP_CHECK_LTV_X10000 && ltv_ok;
  return {
    candidate: { transaction_type, product_code: REFI_PRODUCT_CODE, term_months, amortization: "fixed", payoff_estimate_cents: payoff.payoff_cents, per_diem_cents: payoff.per_diem_cents, payoff_days: payoff.days, prepaid_interest_cents: prepaid.prepaid_interest_cents, prepaid_days: prepaid.days, net_escrow_deposit_cents: loan.net_escrow_deposit_estimate_cents,
      loan_amount_cents, rounded_to_thousand: useRounded, cash_back_cents, cash_back_cap_cents: cashBackCap(loan_amount_cents), cash_out_requested_cents: o.cash_out_requested_cents ?? 0n, value_cents: loan.value_estimate.value_cents, value_source: loan.value_estimate.source, ltv, ltv_x10000: x10000, schedule, note_rate: null, pi_cents: null, quote_id: null },
    prescreen: { ltv_ok, seasoning_ok: true, occupancy_ok, delinquency_ok, product_ok, state_rule_ok: null, requires_fnma_ownership_check, fnma_owned: null, ltv_limit_x10000: limit, reasons },
  };
}

// ============================================================ pricing through 20.4 (rule 3)
/** The candidate's 20.4 inputs: the representative score is the origination-file estimate (`score_source=origination_file`, never a consumer report before the consumer initiates). */
export function candidateQuoteInputs(loan: UniverseLoan, c: CandidateTerms): QuoteInputs {
  return { product_code: c.product_code, term_months: c.term_months, amortization: "fixed", transaction_type: c.transaction_type, occupancy: loan.occupancy, property_type: loan.property_type, units: loan.units,
    loan_amount_cents: c.loan_amount_cents, value_cents: c.value_cents, purchase_price_cents: null, representative_score: loan.representative_score, score_model: "classic_fico", score_source: loan.score_source, borrower_score_models: ["classic_fico"],
    state: loan.property_state, county: loan.county, county_limit_cents: loan.county_limit_cents, subordinate_financing_cents: 0n, mi_option: c.ltv_x10000 > 8000 ? "standard" : "none", homeready: false, homeready_evaluation: null, first_time_homebuyer: false, fthb_ami_waiver: false, dts_waiver: false, very_low_income: false,
    lock_period_days: CANDIDATE_LOCK_DAYS, expected_purchase_ready_date: c.schedule.expected_purchase_ready_date, escrowed: loan.escrowed, valuation_method: "hybrid", borrower_pays_third_party_costs: false,
    taxes_annual_cents: loan.taxes_annual_cents, insurance_annual_cents: loan.insurance_annual_cents, mi_annual_rate_pct: null, assumed_disbursement_date: c.schedule.disbursement_date, first_payment_date: c.schedule.first_payment_date };
}
/** Rule 3: `priceCandidate(loan_snapshot, product, lock_days)` — 20.4's pass-through solve; idempotent on (run_id, loan_id, product). The agent never chooses the rate. */
export function priceCandidate(events: EventStore | null, ctx: QuoteContext, loan: UniverseLoan, c: CandidateTerms, meta: { run_id: string; quoted_at: string }, actor: Actor = INTAKE_AGENT): { candidate: CandidateTerms; quote: PricingQuote } {
  const inputs = candidateQuoteInputs(loan, c);
  const quote = priceQuote(events, ctx, inputs, { quote_id: `Q-${meta.run_id}-${loan.loan_id}-${c.product_code}-${c.term_months}`, purpose: "candidate", quoted_at: meta.quoted_at, loan_id: loan.loan_id }, actor).quote;
  return { candidate: { ...c, note_rate: quote.note_rate, pi_cents: quote.outcome === "priced" ? quote.pi_cents : null, quote_id: quote.quote_id, prepaid_interest_cents: quote.outcome === "priced" ? quote.prepaid_interest_cents : c.prepaid_interest_cents, prepaid_days: quote.outcome === "priced" ? quote.prepaid_interest_days : c.prepaid_days, cash_back_cents: quote.outcome === "priced" ? c.loan_amount_cents - c.payoff_estimate_cents - quote.prepaid_interest_cents - c.cash_out_requested_cents : c.cash_back_cents }, quote };
}

// ============================================================ benefit metrics (rule 4)
export interface BenefitMetrics {
  readonly rate_delta_bps: number; readonly pi_delta_cents: Cents; readonly mi_delta_cents: Cents; readonly payment_delta_cents: Cents; readonly borrower_paid_costs_cents: Cents; readonly breakeven_months: number | null;
  readonly existing_remaining_interest_cents: Cents; readonly new_lifetime_interest_cents: Cents; readonly lifetime_interest_delta_cents: Cents;
  readonly same_term_months: number; readonly same_term_pi_cents: Cents; readonly same_term_pi_delta_cents: Cents; readonly same_term_lifetime_interest_cents: Cents; readonly same_term_lifetime_interest_delta_cents: Cents; readonly same_term_npv_cents: Cents;
  readonly holding_period_months: number; readonly npv_cents: Cents; readonly existing_balance_at_h_cents: Cents; readonly new_balance_at_h_cents: Cents; readonly balance_delta_at_h_cents: Cents; readonly seven_year_total_cost_delta_cents: Cents;
  readonly existing_note_rate: string; readonly candidate_note_rate: string; readonly existing_pi_cents: Cents; readonly candidate_pi_cents: Cents;
}
/**
 * Rule 4 in full, from the priced candidate: rate and payment deltas (MI dropping when the new LTV ≤ 80 % counts),
 * borrower-paid costs (= 0 by program design; the quote's borrower-paid jurisdiction items otherwise), breakeven,
 * lifetime interest vs the existing loan's remaining interest, the same-remaining-term alternative at the candidate
 * rate, the 84-month NPV at r1/12, the balances at H and the seven-year total cost delta.
 */
export function computeBenefit(loan: UniverseLoan, c: CandidateTerms, quote: PricingQuote, program: Pick<PartnerProgram, "holding_period_months">): BenefitMetrics {
  if (quote.outcome !== "priced" || !quote.note_rate) throw new RefiRefused("not_priceable", `no sheet rate covers the third-party costs for ${loan.loan_id}`);
  const r0 = rateFromPct(loan.note_rate_pct), r1 = quote.note_rate; const H = program.holding_period_months;
  const pi0 = loan.pi_cents, pi1 = quote.pi_cents, L1 = c.loan_amount_cents;
  const mi1 = quote.mi_monthly_cents; const mi0 = loan.mi_status === "bpmi_active" ? loan.mi_monthly_cents : 0n;
  const pi_delta_cents = pi0 - pi1; const mi_delta_cents = mi0 - mi1; const payment_delta_cents = pi_delta_cents + mi_delta_cents;
  const borrower_paid_costs_cents = quote.fee_items.filter((f) => f.paid_by === "borrower").reduce((a, f) => a + f.amount_cents, 0n);
  const breakeven_months = borrower_paid_costs_cents === 0n ? 0 : payment_delta_cents <= 0n ? null : Number(divRound(borrower_paid_costs_cents, payment_delta_cents, "CEIL"));
  const existing_remaining_interest_cents = remainingInterest(pi0, loan.remaining_term_months, loan.upb_cents);
  const new_lifetime_interest_cents = pi1 * BigInt(c.term_months) - L1;
  const same_term_months = loan.remaining_term_months;
  const same_term_pi_cents = levelPayment(L1, ratePercent(quote.note_rate_pct!), same_term_months);
  const same_term_lifetime_interest_cents = same_term_pi_cents * BigInt(same_term_months) - L1;
  const existing_balance_at_h_cents = balanceAfter(loan.upb_cents, loan.note_rate_pct, pi0, H);
  const new_balance_at_h_cents = balanceAfter(L1, quote.note_rate_pct!, pi1, H);
  return { rate_delta_bps: rateDeltaBps(r0, r1), pi_delta_cents, mi_delta_cents, payment_delta_cents, borrower_paid_costs_cents, breakeven_months,
    existing_remaining_interest_cents, new_lifetime_interest_cents, lifetime_interest_delta_cents: new_lifetime_interest_cents - existing_remaining_interest_cents,
    same_term_months, same_term_pi_cents, same_term_pi_delta_cents: pi0 - same_term_pi_cents, same_term_lifetime_interest_cents, same_term_lifetime_interest_delta_cents: same_term_lifetime_interest_cents - existing_remaining_interest_cents, same_term_npv_cents: npvOfDelta(pi0 - same_term_pi_cents + mi_delta_cents, r1, H),
    holding_period_months: H, npv_cents: npvOfDelta(payment_delta_cents, r1, H), existing_balance_at_h_cents, new_balance_at_h_cents, balance_delta_at_h_cents: existing_balance_at_h_cents - new_balance_at_h_cents,
    seven_year_total_cost_delta_cents: (pi0 * BigInt(H) + existing_balance_at_h_cents) - (pi1 * BigInt(H) + new_balance_at_h_cents), existing_note_rate: r0, candidate_note_rate: r1, existing_pi_cents: pi0, candidate_pi_cents: pi1 };
}

// ============================================================ fire rule (rule 5; T8)
export type FireMetrics = Pick<BenefitMetrics, "rate_delta_bps" | "npv_cents" | "seven_year_total_cost_delta_cents" | "lifetime_interest_delta_cents" | "same_term_npv_cents">;
export interface FireDecision { readonly fire: boolean; readonly present_same_term_first: boolean; readonly reasons: readonly string[]; }
/**
 * `offer_ready` iff rate_delta ≥ 25 bps and npv > min_npv and seven-year total cost delta > 0 and the prescreen and
 * the state rule pass and nothing suppresses; a 30-year reset that costs more over the full term (lifetime delta > 0)
 * is allowed only when the same-remaining-term candidate also has npv > 0, and the same-term option is presented first.
 */
export function fireRule(m: FireMetrics, program: Pick<PartnerProgram, "min_rate_reduction_bps" | "min_npv_cents">, gates: { prescreen_ok: boolean; state_rule_ok: boolean; suppression_reasons: readonly string[] }): FireDecision {
  const reasons: string[] = [];
  if (m.rate_delta_bps < program.min_rate_reduction_bps) reasons.push(`rate_delta_bps ${m.rate_delta_bps} < ${program.min_rate_reduction_bps}`);
  if (m.npv_cents <= program.min_npv_cents) reasons.push(`npv_cents ${m.npv_cents} ≤ ${program.min_npv_cents}`);
  if (m.seven_year_total_cost_delta_cents <= 0n) reasons.push("seven_year_total_cost_delta ≤ 0");
  if (!gates.prescreen_ok) reasons.push("prescreen_failed");
  if (!gates.state_rule_ok) reasons.push("state_rule_failed");
  reasons.push(...gates.suppression_reasons);
  let present_same_term_first = false;
  if (m.lifetime_interest_delta_cents > 0n) { if (m.same_term_npv_cents > 0n) present_same_term_first = true; else reasons.push("lifetime_interest_delta > 0 and same_term_npv ≤ 0"); }
  return { fire: reasons.length === 0, present_same_term_first, reasons };
}

// ============================================================ gates (timer table)
export interface GateResult { readonly open: boolean; readonly opens_on: PlainDate | null; readonly reason: string | null; }
const gateOpen = (open: boolean, opens_on: PlainDate | null, reason: string): GateResult => (open ? { open: true, opens_on, reason: null } : { open: false, opens_on, reason });
/** FNMA_C1_1_01_PREMIUM_RECAPTURE_120: closed until `fnma_purchase_date` + 120 calendar days (Aug 20, 2026 → Dec 18, 2026); no purchase date → open. */
export function premiumRecaptureGate(f: { fnma_purchase_date: PlainDate | null; as_of: PlainDate; days?: number }): GateResult {
  if (!f.fnma_purchase_date) return gateOpen(true, null, "");
  const opens_on = addDays(f.fnma_purchase_date, f.days ?? 120);
  return gateOpen(f.as_of >= opens_on, opens_on, `inside the premium-recapture window (C1-1-01): opens ${opens_on}`);
}
/**
 * The window closes (gate opens) at `purchase_date` + 120 days: `premium_recapture.assessed{loan_id, purchase_date,
 * window_closed_on, exposure_cents}` — the event 27.2 emits when it releases `recapture_exposure_cents` from the
 * gain-on-sale record; 20.1 appends the same platform record for a loan whose proactive suppression lifts (it satisfies
 * FNMA_C1_1_01_PREMIUM_RECAPTURE_120, armed by 29.4's `loan.purchased{purchase_date}`). Inside the window: no event.
 */
export function assessPremiumRecapture(events: EventStore, loan: Pick<UniverseLoan, "loan_id" | "upb_cents">, facts: Pick<GateFacts, "fnma_purchase_date">, at: string, actor: Actor = INTAKE_AGENT, days = 120): { open: boolean; opens_on: PlainDate | null; event: DomainEvent | null } {
  const g = premiumRecaptureGate({ fnma_purchase_date: facts.fnma_purchase_date, as_of: isoDateEt(at), days });
  if (!g.open || !facts.fnma_purchase_date) return { open: g.open, opens_on: g.opens_on, event: null };
  return { open: true, opens_on: g.opens_on, event: ev(events, "premium_recapture.assessed", loan.loan_id, at, { loan_id: loan.loan_id, purchase_date: facts.fnma_purchase_date, fnma_purchase_date: facts.fnma_purchase_date, window_closed_on: g.opens_on, exposure_cents: "0", assessed_by: "20.1", basis: "C1-1-01: no payoff within 120 days of the whole-loan purchase / MBS issue date" }, actor) };
}
/** SM_REFI_RESOLICIT_COOLDOWN_90: closed until declined_on + 90 calendar days (Oct 9, 2026 → Jan 7, 2027); the request path bypasses it. */
export function resolicitCooldownGate(f: { declined_on: PlainDate | null; as_of: PlainDate; days?: number }): GateResult {
  if (!f.declined_on) return gateOpen(true, null, "");
  const opens_on = addDays(f.declined_on, f.days ?? 90);
  return gateOpen(f.as_of >= opens_on, opens_on, `cooldown after the ${f.declined_on} decline: opens ${opens_on}`);
}
/** SM_REFI_OFFER_FREQUENCY_CAP: at most `max_offers_per_loan_per_12m` offers per rolling 12 months; opens when the oldest counted offer ages out. */
export function offerFrequencyCapGate(f: { offered_at: readonly string[]; as_of: PlainDate; max_offers_per_loan_per_12m?: number }): GateResult {
  const max = f.max_offers_per_loan_per_12m ?? 2; const since = addMonths(f.as_of, -12);
  const counted = f.offered_at.map((t) => (/^\d{4}-\d{2}-\d{2}T/.test(t) ? isoDateEt(t) : plainDate(t))).filter((d) => d > since && d <= f.as_of).sort();
  if (counted.length < max) return gateOpen(true, null, "");
  return gateOpen(false, addMonths(counted[counted.length - max]!, 12), `${counted.length} offers in the rolling 12 months ≥ cap ${max}`);
}
/** FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M: the new note date must be ≥ the existing note date + 12 months (Nov 20, 2025 → earliest Nov 20, 2026). */
export function cashoutNoteSeasoningGate(f: { note_date: PlainDate; new_note_date: PlainDate }): GateResult & { earliest_new_note_date: PlainDate; earliest_disbursement_date: PlainDate } {
  const earliest = addMonths(f.note_date, 12);
  // rescission after a signing on the earliest note date: 3 Reg Z specific business days (Saturdays count), disbursement the day after midnight of the third
  const earliest_disbursement_date = addDays(addBusinessDays(earliest, 3, regzSpecific), 1);
  return { ...gateOpen(f.new_note_date >= earliest, earliest, `existing note ${f.note_date} is ${daysBetween(f.note_date, f.new_note_date)} days old at ${f.new_note_date}; cash-out eligible on/after ${earliest} (B2-1.3-03)`), earliest_new_note_date: earliest, earliest_disbursement_date };
}
/** FNMA_B2_1_3_03_TITLE_SEASONING_6M: at least one borrower on title ≥ 6 months before the new loan's disbursement (inheritance / legal award / delayed financing excepted). */
export function titleSeasoningGate(f: { title_date: PlainDate; disbursement_date: PlainDate; exception?: "inheritance" | "legal_award" | "delayed_financing" | null }): GateResult {
  if (f.exception) return gateOpen(true, null, "");
  const opens_on = addMonths(f.title_date, 6);
  return gateOpen(f.disbursement_date >= opens_on, opens_on, `title taken ${f.title_date}; six months elapse ${opens_on} (B2-1.3-03)`);
}
export type BorrowerInterestFactor = "payment_reduction" | "rate_reduction" | "cash_proceeds_exceed_costs" | "arm_to_fixed" | "bona_fide_need" | "court_order";
export interface BorrowerInterestDetermination { readonly applies: boolean; readonly months_since_consummation: number; readonly pass: boolean; readonly factors: readonly BorrowerInterestFactor[]; readonly rule: string | null; }
export interface JurisdictionRefiRule { readonly statute: string; readonly window_months: number; }
export const MA_183_28C: JurisdictionRefiRule = { statute: "M.G.L. c.183 §28C", window_months: MA_28C_WINDOW_MONTHS };
/**
 * MA_183_28C_BORROWER_INTEREST_60M (rule; worked example 3; T6): where `jurisdiction_rules.refi_borrower_interest_rule`
 * is set and the existing loan was consummated < 60 months before the candidate consummation, the refinance must be in
 * the borrower's interest — factors: lower payment after costs, reduced rate, cash proceeds exceeding costs, ARM→fixed,
 * bona fide need / court order. A longer amortization is never a factor. No factor → the gate blocks, no offer issues.
 */
export function borrowerInterestRule(f: { property_state: string; existing_consummation_date: PlainDate; candidate_consummation_date: PlainDate; rules: Readonly<Record<string, JurisdictionRefiRule | undefined>>; pi_delta_cents: Cents; borrower_paid_costs_cents: Cents; rate_delta_bps: number; breakeven_months?: number | null; cash_proceeds_cents?: Cents; arm_to_fixed?: boolean; bona_fide_need?: boolean; court_order?: boolean }): BorrowerInterestDetermination {
  const rule = f.rules[f.property_state];
  const months = monthsBetween(f.existing_consummation_date, f.candidate_consummation_date);
  if (!rule || months >= rule.window_months) return { applies: false, months_since_consummation: months, pass: true, factors: [], rule: rule?.statute ?? null };
  const factors: BorrowerInterestFactor[] = [];
  if (f.pi_delta_cents > 0n && (f.borrower_paid_costs_cents === 0n || (f.breakeven_months !== null && f.breakeven_months !== undefined && f.breakeven_months <= rule.window_months))) factors.push("payment_reduction");
  if (f.rate_delta_bps > 0) factors.push("rate_reduction");
  if ((f.cash_proceeds_cents ?? 0n) > f.borrower_paid_costs_cents && (f.cash_proceeds_cents ?? 0n) > 0n) factors.push("cash_proceeds_exceed_costs");
  if (f.arm_to_fixed) factors.push("arm_to_fixed");
  if (f.bona_fide_need) factors.push("bona_fide_need");
  if (f.court_order) factors.push("court_order");
  return { applies: true, months_since_consummation: months, pass: factors.length > 0, factors, rule: rule.statute };
}
export interface GateStatus { readonly code: string; readonly status: "open" | "closed" | "not_applicable"; readonly opens_on: PlainDate | null; readonly reason: string | null; }
/** `checkGates`: every gate the opportunity is subject to, with its status; `assertGateOpen` refuses on a closed one. */
export function checkGates(f: { path: Path; transaction_type: TransactionType; as_of: PlainDate; program: PartnerProgram; facts: GateFacts; loan: Pick<UniverseLoan, "note_date" | "title_date" | "property_state" | "consummation_date">; schedule: CandidateSchedule; state_determination: BorrowerInterestDetermination | null }): GateStatus[] {
  const out: GateStatus[] = [];
  const push = (code: string, g: GateResult, applicable = true) => out.push({ code, status: !applicable ? "not_applicable" : g.open ? "open" : "closed", opens_on: g.opens_on, reason: applicable ? g.reason : null });
  push("FNMA_C1_1_01_PREMIUM_RECAPTURE_120", premiumRecaptureGate({ fnma_purchase_date: f.facts.fnma_purchase_date, as_of: f.as_of, days: f.program.premium_recapture_suppression_days }), f.path === "proactive");
  push("SM_REFI_RESOLICIT_COOLDOWN_90", resolicitCooldownGate({ declined_on: f.facts.declined_on, as_of: f.as_of, days: f.program.resolicit_cooldown_days }), f.path === "proactive");
  push("SM_REFI_OFFER_FREQUENCY_CAP", offerFrequencyCapGate({ offered_at: f.facts.offered_at, as_of: f.as_of, max_offers_per_loan_per_12m: f.program.max_offers_per_loan_per_12m }), f.path === "proactive");
  push("FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M", cashoutNoteSeasoningGate({ note_date: f.loan.note_date, new_note_date: f.schedule.consummation_date }), f.transaction_type === "cash_out");
  push("FNMA_B2_1_3_03_TITLE_SEASONING_6M", titleSeasoningGate({ title_date: f.loan.title_date, disbursement_date: f.schedule.disbursement_date }), f.transaction_type === "cash_out");
  const sd = f.state_determination;
  out.push({ code: "MA_183_28C_BORROWER_INTEREST_60M", status: !sd || !sd.applies ? "not_applicable" : sd.pass ? "open" : "closed", opens_on: sd?.applies ? addMonths(f.loan.consummation_date, MA_28C_WINDOW_MONTHS) : null, reason: sd?.applies && !sd.pass ? `${sd.rule}: no borrower's-interest factor` : null });
  return out;
}
export function assertGateOpen(gates: readonly GateStatus[], code: string): GateStatus {
  const g = gates.find((x) => x.code === code); if (!g) throw new RangeError(`no gate ${code} on this opportunity`);
  if (g.status === "closed") throw new RefiRefused(`gate_closed:${code}`, g.reason ?? `${code} is closed${g.opens_on ? ` until ${g.opens_on}` : ""}`);
  return g;
}

// ============================================================ the opportunity (data model; state machine)
export type OpportunityStatus = "detected" | "suppressed" | "offer_ready" | "offered" | "engaged" | "converted" | "declined" | "expired" | "requested";
export interface ExistingTerms { readonly note_rate: string; readonly upb_cents: Cents; readonly remaining_term_months: number; readonly pi_cents: Cents; readonly escrow_monthly_cents: Cents; readonly mi_monthly_cents: Cents; readonly mi_status: MiStatus; readonly occupancy: Occupancy; readonly product: string; readonly note_date: PlainDate; readonly first_payment_date: PlainDate; readonly investor_blind_hash: string; }
export interface RefiOpportunity {
  readonly opportunity_id: string; readonly run_id: string | null; readonly loan_id: string; readonly program_id: string; readonly trigger_kind: TriggerKind; readonly as_of_date: PlainDate; readonly detected_at: string;
  readonly existing_terms: ExistingTerms; readonly value_estimate: ValueEstimate; readonly candidate_terms: CandidateTerms | null; readonly same_term_candidate: { term_months: number; pi_cents: Cents; note_rate: string } | null; readonly benefit_metrics: BenefitMetrics | null; readonly eligibility_prescreen: EligibilityPrescreen | null;
  readonly gates: readonly GateStatus[]; readonly state_determination: BorrowerInterestDetermination | null; readonly status: OpportunityStatus; readonly suppression_reasons: readonly string[]; readonly present_same_term_first: boolean; readonly offer_valid_until: PlainDate | null;
  readonly campaign_id: string | null; readonly lead_id: string | null; readonly application_id: string | null; readonly decision_id: string | null; readonly alternatives: readonly { transaction_type: TransactionType; status: "deferred" | "offered"; earliest_note_date: PlainDate | null; earliest_disbursement_date: PlainDate | null; reason: string }[];
  readonly officer_acknowledgment_required: boolean; readonly explanation_text: string; readonly inputs_hash: string; readonly rule_set_version: string; readonly created_at: string;
}
export const idempotencyKey = (loanId: string, asOf: PlainDate, programId: string): string => `${loanId}|${asOf}|${programId}`;
export const existingTermsOf = (loan: UniverseLoan): ExistingTerms => ({ note_rate: rateFromPct(loan.note_rate_pct), upb_cents: loan.upb_cents, remaining_term_months: loan.remaining_term_months, pi_cents: loan.pi_cents, escrow_monthly_cents: loan.escrow_monthly_cents, mi_monthly_cents: loan.mi_monthly_cents, mi_status: loan.mi_status, occupancy: loan.occupancy, product: loan.product_code, note_date: loan.note_date, first_payment_date: loan.first_payment_date, investor_blind_hash: sha([loan.loan_id, "investor_blind"]) });
const base = (o: { opportunity_id: string; loan_id: string; run_id: string | null; program: PartnerProgram; trigger_kind: TriggerKind; as_of: PlainDate; at: string; loan: UniverseLoan }): RefiOpportunity => ({ opportunity_id: o.opportunity_id, run_id: o.run_id, loan_id: o.loan_id, program_id: o.program.program_id, trigger_kind: o.trigger_kind, as_of_date: o.as_of, detected_at: o.at, existing_terms: existingTermsOf(o.loan), value_estimate: o.loan.value_estimate, candidate_terms: null, same_term_candidate: null, benefit_metrics: null, eligibility_prescreen: null, gates: [], state_determination: null, status: "detected", suppression_reasons: [], present_same_term_first: false, offer_valid_until: null, campaign_id: null, lead_id: null, application_id: null, decision_id: null, alternatives: [], officer_acknowledgment_required: false, explanation_text: "", inputs_hash: "", rule_set_version: RULE_SET_VERSION_20_1, created_at: o.at });
const ev = (events: EventStore, type: string, loanId: string, at: string, payload: Record<string, unknown>, actor: Actor, aggregate?: { kind: string; id: string }) => events.append({ type, actor, occurredAt: at, loanId, ...(aggregate ? { aggregate } : {}), payload: { ...payload, origination: true, source: "origination" } });

/** Rule 10: the borrower-benefit disclosure payload (feeds 20.2 creatives and the 20.3 conversation) — computed fields only; the LLM drafts prose inside this frame. */
export function benefitDisclosurePayload(o: { existing: ExistingTerms; candidate: CandidateTerms; metrics: BenefitMetrics; present_same_term_first: boolean }): Record<string, unknown> {
  const m = o.metrics, c = o.candidate;
  return { current_rate: o.existing.note_rate, current_pi_cents: String(o.existing.pi_cents), new_rate: c.note_rate, new_pi_cents: String(c.pi_cents), rate_delta_bps: m.rate_delta_bps, pi_delta_cents: String(m.pi_delta_cents), remaining_term_months: o.existing.remaining_term_months, new_term_months: c.term_months,
    lifetime_interest_existing_cents: String(m.existing_remaining_interest_cents), lifetime_interest_new_cents: String(m.new_lifetime_interest_cents), same_term_months: m.same_term_months, same_term_pi_cents: String(m.same_term_pi_cents), same_term_lifetime_interest_cents: String(m.same_term_lifetime_interest_cents), present_same_term_first: o.present_same_term_first,
    cash_back_cents: String(c.cash_back_cents), cash_back_cap_cents: String(c.cash_back_cap_cents), borrower_paid_costs_cents: String(m.borrower_paid_costs_cents), costs_statement: "the rate you are offered already includes those costs; you could get a lower rate by paying them yourself", not_a_commitment: true, apr_example_required: "12 CFR 1026.24(f) (20.2)" };
}
export function explainBenefit(o: { existing: ExistingTerms; candidate: CandidateTerms; metrics: BenefitMetrics; present_same_term_first: boolean }): string {
  const m = o.metrics, c = o.candidate;
  const same = `Over the same ${m.same_term_months} months you have left, the new rate would make the payment ${money(m.same_term_pi_cents)} and cost ${money(m.same_term_lifetime_interest_cents)} in interest instead of ${money(m.existing_remaining_interest_cents)}.`;
  const reset = `A new ${c.term_months}-month term lowers the payment to ${money(c.pi_cents ?? 0n)} (${money(m.pi_delta_cents)} a month less) and costs ${money(m.new_lifetime_interest_cents)} in interest over its full term${m.lifetime_interest_delta_cents > 0n ? ", which is more than the interest left on your current loan" : `, ${money(-m.lifetime_interest_delta_cents)} less than the interest left on your current loan`}.`;
  return `${o.present_same_term_first ? `${same} ${reset}` : `${reset} ${same}`} Third-party costs are paid by Supermortgage and recovered from the sale of the loan through the rate — the rate you are offered already includes those costs; you could get a lower rate by paying them yourself. This is not a commitment to lend; rates change daily.`;
}

// ============================================================ the pipeline for one loan (rules 1–9) and the run (T1, T3, T6, T10)
export interface PipelineContext {
  readonly program: PartnerProgram; readonly rule_set: RefiRuleSet; readonly pricing: QuoteContext; readonly jurisdiction_rules: Readonly<Record<string, JurisdictionRefiRule | undefined>>;
  readonly as_of: PlainDate; readonly at: string; readonly run_id: string | null; readonly schedule?: CandidateSchedule;
}
export interface PipelineResult { readonly opportunity: RefiOpportunity; readonly events: DomainEvent[]; readonly quote: PricingQuote | null; }
/**
 * One loan through the deterministic pipeline: detected → candidate → price (20.4) → benefit → state rule → gates → fire
 * rule → `offer_ready` | `suppressed{reason}`. The borrower-request path skips the solicitation gates (rule 9) but not
 * eligibility; a cash-out request whose seasoning gates are closed is answered with an LCOR candidate now and the
 * cash-out deferred to the earliest eligible note date (worked example 2; T4).
 */
export function evaluateLoan(events: EventStore, ctx: PipelineContext, loan: UniverseLoan, facts: GateFacts, o: { trigger_kind: TriggerKind; path: Path; transaction_type?: TransactionType; cash_out_requested_cents?: Cents; opportunity_id?: string; bona_fide_need?: boolean }, actor: Actor = INTAKE_AGENT): PipelineResult {
  assertInvestorBlind(loan as unknown as Record<string, unknown>);
  const out: DomainEvent[] = []; const push = (e: DomainEvent) => { out.push(e); return e; };
  const opportunity_id = o.opportunity_id ?? `opp-${loan.loan_id}-${ctx.as_of}-${ctx.program.program_id}`;
  const schedule = ctx.schedule ?? defaultSchedule(ctx.as_of);
  let opp = base({ opportunity_id, loan_id: loan.loan_id, run_id: ctx.run_id, program: ctx.program, trigger_kind: o.trigger_kind, as_of: ctx.as_of, at: ctx.at, loan });
  const requested = o.transaction_type ?? "limited_cash_out";
  const ruleApplies = ctx.jurisdiction_rules[loan.property_state] !== undefined && monthsBetween(loan.consummation_date, schedule.consummation_date) < (ctx.jurisdiction_rules[loan.property_state]?.window_months ?? MA_28C_WINDOW_MONTHS);
  push(ev(events, "refi.opportunity.detected", loan.loan_id, ctx.at, { opportunity_id, loan_id: loan.loan_id, run_id: ctx.run_id, program_id: ctx.program.program_id, trigger_kind: o.trigger_kind, transaction_type: requested, property_state: loan.property_state, borrower_interest_rule_applies: ruleApplies, as_of_date: ctx.as_of, note_date: loan.note_date, title_date: loan.title_date, consummation_date: loan.consummation_date, purpose: purposeTag(ctx.program) }, actor, { kind: "refi_opportunity", id: opportunity_id }));
  // cash-out seasoning (B2-1.3-03): closed gates replace the cash-out candidate by an LCOR now and defer the cash-out
  let transaction_type: TransactionType = requested; const alternatives: RefiOpportunity["alternatives"][number][] = [];
  if (requested === "cash_out") {
    if (o.path !== "borrower_request") throw new RefiRefused("cash_out_requires_borrower_request", "cash-out candidates are constructed only on borrower request (rule 2)");
    const note = cashoutNoteSeasoningGate({ note_date: loan.note_date, new_note_date: schedule.consummation_date }); const title = titleSeasoningGate({ title_date: loan.title_date, disbursement_date: schedule.disbursement_date });
    if (!note.open || !title.open) { transaction_type = "limited_cash_out"; alternatives.push({ transaction_type: "cash_out", status: "deferred", earliest_note_date: note.open ? title.opens_on : note.earliest_new_note_date, earliest_disbursement_date: note.open ? null : note.earliest_disbursement_date, reason: (note.open ? title.reason : note.reason) ?? "seasoning" }); }
  }
  const built = buildCandidate(loan, { transaction_type, schedule, as_of: ctx.as_of, borrower_request: o.path === "borrower_request", ...(transaction_type === "cash_out" && o.cash_out_requested_cents !== undefined ? { cash_out_requested_cents: o.cash_out_requested_cents } : {}) });
  opp = { ...opp, candidate_terms: built.candidate, eligibility_prescreen: built.prescreen, alternatives };
  const suppression: string[] = [];
  // pricing (rule 3) and benefit (rule 4)
  let quote: PricingQuote | null = null; let metrics: BenefitMetrics | null = null;
  try {
    const priced = priceCandidate(events, ctx.pricing, loan, built.candidate, { run_id: ctx.run_id ?? `req-${loan.loan_id}`, quoted_at: ctx.at }, actor); quote = priced.quote; opp = { ...opp, candidate_terms: priced.candidate };
    if (quote.outcome === "priced") { metrics = computeBenefit(loan, priced.candidate, quote, ctx.program); opp = { ...opp, benefit_metrics: metrics, same_term_candidate: { term_months: metrics.same_term_months, pi_cents: metrics.same_term_pi_cents, note_rate: quote.note_rate! } }; }
    else suppression.push("not_priceable");
  } catch (e) { suppression.push(`pricing_refused:${(e as { code?: string }).code ?? (e as Error).message}`); }
  // state rule (rule; worked example 3)
  const sd = metrics ? borrowerInterestRule({ property_state: loan.property_state, existing_consummation_date: loan.consummation_date, candidate_consummation_date: schedule.consummation_date, rules: ctx.jurisdiction_rules, pi_delta_cents: metrics.pi_delta_cents, borrower_paid_costs_cents: metrics.borrower_paid_costs_cents, rate_delta_bps: metrics.rate_delta_bps, breakeven_months: metrics.breakeven_months, cash_proceeds_cents: opp.candidate_terms!.cash_out_requested_cents, arm_to_fixed: loan.amortization === "arm", bona_fide_need: o.bona_fide_need ?? false }) : null;
  if (sd?.applies) push(ev(events, "refi.borrower_interest.determined", loan.loan_id, ctx.at, { opportunity_id, pass: sd.pass, factors: sd.factors, months_since_consummation: sd.months_since_consummation, rule: sd.rule, property_state: loan.property_state }, actor, { kind: "refi_opportunity", id: opportunity_id }));
  const gates = checkGates({ path: o.path, transaction_type, as_of: ctx.as_of, program: ctx.program, facts, loan, schedule, state_determination: sd });
  for (const g of gates) if (g.status === "closed" && g.code !== "MA_183_28C_BORROWER_INTEREST_60M") suppression.push(g.code === "FNMA_C1_1_01_PREMIUM_RECAPTURE_120" ? "premium_recapture_window" : g.code === "SM_REFI_RESOLICIT_COOLDOWN_90" ? "cooldown" : g.code === "SM_REFI_OFFER_FREQUENCY_CAP" ? "frequency_cap" : g.code);
  if (o.path === "proactive" && loan.refi_do_not_solicit) suppression.push("marketing_suppression");
  const prescreen_ok = built.prescreen.ltv_ok && built.prescreen.occupancy_ok && built.prescreen.product_ok && (o.path === "proactive" ? built.prescreen.delinquency_ok : true);
  const fire = metrics ? fireRule(metrics, ctx.program, { prescreen_ok, state_rule_ok: sd ? sd.pass : true, suppression_reasons: suppression }) : { fire: false, present_same_term_first: false, reasons: [...suppression, "not_priced"] };
  opp = { ...opp, gates, state_determination: sd, eligibility_prescreen: { ...built.prescreen, state_rule_ok: sd ? sd.pass : null }, suppression_reasons: fire.reasons, present_same_term_first: fire.present_same_term_first, inputs_hash: sha({ loan, facts, as_of: ctx.as_of, rule_set: ctx.rule_set.version, sheet: ctx.pricing.sheet.rate_sheet_id }) };
  if (fire.fire && metrics && opp.candidate_terms) {
    const explanation_text = explainBenefit({ existing: opp.existing_terms, candidate: opp.candidate_terms, metrics, present_same_term_first: fire.present_same_term_first });
    opp = { ...opp, status: o.path === "borrower_request" ? "requested" : "detected", explanation_text };
    opp = markOfferReady(events, opp, ctx.at, actor, push);
  } else {
    const primary = fire.reasons.find((r) => ["premium_recapture_window", "cooldown", "frequency_cap", "marketing_suppression", "not_priceable"].includes(r)) ?? fire.reasons[0] ?? "no_benefit";
    const gate = gates.find((g) => g.status === "closed");
    opp = { ...opp, status: "suppressed" };
    push(ev(events, "refi.opportunity.suppressed", loan.loan_id, ctx.at, { opportunity_id, reason: primary, reasons: fire.reasons, opens_on: gate?.opens_on ?? null, due_at: gate?.opens_on ?? null, gate: gate?.code ?? null }, actor, { kind: "refi_opportunity", id: opportunity_id }));
  }
  return { opportunity: opp, events: out, quote };
}
/** `emitOfferReady`: `refi.opportunity.offer_ready{detected_at}` arms SM_REFI_OFFER_SLA_2BD (+2 servicer business days; 20.2 sends the first touch). */
export function markOfferReady(events: EventStore, opp: RefiOpportunity, at: string, actor: Actor = INTAKE_AGENT, sink: (e: DomainEvent) => DomainEvent = (e) => e): RefiOpportunity {
  if (!opp.candidate_terms || !opp.benefit_metrics) throw new RefiRefused("not_priced", `opportunity ${opp.opportunity_id} has no priced candidate`);
  if (opp.status === "suppressed") throw new RefiRefused("suppressed", `opportunity ${opp.opportunity_id} is suppressed (${opp.suppression_reasons.join(", ")}); only the partner officer may override (overrideSuppression)`);
  const next: RefiOpportunity = { ...opp, status: "offer_ready", offer_valid_until: addDays(isoDateEt(at), 30) };
  sink(ev(events, "refi.opportunity.offer_ready", opp.loan_id, at, { opportunity_id: opp.opportunity_id, loan_id: opp.loan_id, detected_at: at, present_same_term_first: opp.present_same_term_first, path: opp.trigger_kind === "borrower_request" ? "borrower_request" : "proactive", note_rate: opp.candidate_terms.note_rate, pi_cents: String(opp.candidate_terms.pi_cents ?? 0n), rate_delta_bps: opp.benefit_metrics.rate_delta_bps,
    benefit_disclosure: benefitDisclosurePayload({ existing: opp.existing_terms, candidate: opp.candidate_terms, metrics: opp.benefit_metrics, present_same_term_first: opp.present_same_term_first }), channel_eligibility: { email: true, portal_card: true, ai_voice: "20.2 PEWC gate", human_voice: "20.2 EBR gate" } }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }));
  return next;
}

export interface RefiTriggerRun {
  readonly run_id: string; readonly program_id: string; readonly as_of_date: PlainDate; readonly rate_sheet_id: string; readonly llpa_table_id: string; readonly rule_set_version: string; readonly view_definition_hash: string;
  readonly loans_in_universe: number; readonly loans_evaluated: number; readonly opportunities_detected: number; readonly suppressed_by_reason: Readonly<Record<string, number>>; readonly fair_lending_extract_document_id: string | null;
  readonly started_at: string; readonly completed_at: string; readonly agent_run_id: string | null; readonly trigger_kind: TriggerKind; readonly purpose: string;
}
export interface RunInput { readonly run_id: string; readonly trigger_kind: "scheduled" | "rate_move"; readonly loans: readonly UniverseLoan[]; readonly gate_facts: Readonly<Record<string, GateFacts>>; readonly prior_opportunities: readonly RefiOpportunity[]; readonly prior_extracts: readonly FairLendingExtract[]; readonly demographics?: Readonly<Record<string, DemographicCategory>>; readonly agent_run_id?: string | null; }
export interface RunResult { readonly run: RefiTriggerRun; readonly opportunities: RefiOpportunity[]; readonly reused: string[]; readonly extract: FairLendingExtract; readonly extract_written: boolean; readonly events: DomainEvent[]; }
/**
 * The daily run (SM_REFI_TRIGGER_DAILY, 06:30 ET after `rate_sheet.published`): static check → universe → pipeline per
 * loan → fair-lending extract (once per as_of_date) → `refi.trigger.run_completed`. Idempotent on
 * (loan_id, as_of_date, program_id): a second run on the same day reuses the rows it already wrote (T10).
 */
export function runTrigger(events: EventStore, ctx: PipelineContext, i: RunInput, actor: Actor = INTAKE_AGENT): RunResult {
  nonEmpty(i.run_id, "run_id");
  staticCheckRuleSet(ctx.rule_set);                                             // T5: the run cannot start
  if (ctx.pricing.sheet.status !== "active") throw new RefiRefused("no_rate_sheet", `rate sheet ${ctx.pricing.sheet.rate_sheet_id} is ${ctx.pricing.sheet.status} — run skipped (sev 3)`);
  const universe = loadUniverse(ctx.program, ctx.rule_set, i.loans, i.gate_facts, ctx.as_of, "proactive");
  const out: DomainEvent[] = []; const opportunities: RefiOpportunity[] = []; const reused: string[] = [];
  const byKey = new Map(i.prior_opportunities.map((p) => [idempotencyKey(p.loan_id, p.as_of_date, p.program_id), p]));
  const suppressed: Record<string, number> = {};
  const bump = (r: string) => { suppressed[r] = (suppressed[r] ?? 0) + 1; };
  for (const x of universe.excluded) if (x.reason !== "not_active") bump(x.reason);
  for (const loan of i.loans) {
    if (universe.excluded.some((x) => x.loan_id === loan.loan_id && x.reason === "not_active")) continue;
    const key = idempotencyKey(loan.loan_id, ctx.as_of, ctx.program.program_id);
    const prior = byKey.get(key); if (prior) { opportunities.push(prior); reused.push(prior.opportunity_id); continue; }
    const ex = universe.excluded.find((x) => x.loan_id === loan.loan_id);
    if (ex) {
      const opp: RefiOpportunity = { ...base({ opportunity_id: `opp-${loan.loan_id}-${ctx.as_of}-${ctx.program.program_id}`, loan_id: loan.loan_id, run_id: i.run_id, program: ctx.program, trigger_kind: i.trigger_kind, as_of: ctx.as_of, at: ctx.at, loan }), status: "suppressed", suppression_reasons: [ex.reason], gates: checkGates({ path: "proactive", transaction_type: "limited_cash_out", as_of: ctx.as_of, program: ctx.program, facts: i.gate_facts[loan.loan_id] ?? NO_GATE_FACTS, loan, schedule: ctx.schedule ?? defaultSchedule(ctx.as_of), state_determination: null }) };
      out.push(ev(events, "refi.opportunity.detected", loan.loan_id, ctx.at, { opportunity_id: opp.opportunity_id, loan_id: loan.loan_id, run_id: i.run_id, program_id: ctx.program.program_id, trigger_kind: i.trigger_kind, transaction_type: "limited_cash_out", property_state: loan.property_state, borrower_interest_rule_applies: false, as_of_date: ctx.as_of, purpose: universe.purpose }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }));
      out.push(ev(events, "refi.opportunity.suppressed", loan.loan_id, ctx.at, { opportunity_id: opp.opportunity_id, reason: ex.reason, reasons: [ex.reason], opens_on: ex.opens_on, due_at: ex.opens_on, gate: ex.reason === "premium_recapture_window" ? "FNMA_C1_1_01_PREMIUM_RECAPTURE_120" : ex.reason === "cooldown" ? "SM_REFI_RESOLICIT_COOLDOWN_90" : ex.reason === "frequency_cap" ? "SM_REFI_OFFER_FREQUENCY_CAP" : null }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }));
      opportunities.push(opp); continue;
    }
    const r = evaluateLoan(events, { ...ctx, run_id: i.run_id }, loan, i.gate_facts[loan.loan_id] ?? NO_GATE_FACTS, { trigger_kind: i.trigger_kind, path: "proactive" }, actor);
    out.push(...r.events); opportunities.push(r.opportunity);
    if (r.opportunity.status === "suppressed") for (const s of r.opportunity.suppression_reasons.slice(0, 1)) bump(s);
  }
  const detected = opportunities.filter((o) => o.status === "offer_ready").length;
  const prior = i.prior_extracts.find((x) => x.program_id === ctx.program.program_id && x.as_of_date === ctx.as_of);
  const extract = prior ?? writeFairLendingExtract(events, { run_id: i.run_id, program_id: ctx.program.program_id, as_of_date: ctx.as_of, at: ctx.at, opportunities, universe: i.loans.filter((l) => l.status === "active"), demographics: i.demographics ?? {} }, actor);
  if (!prior && extract.event) out.push(extract.event);
  const run: RefiTriggerRun = { run_id: i.run_id, program_id: ctx.program.program_id, as_of_date: ctx.as_of, rate_sheet_id: ctx.pricing.sheet.rate_sheet_id, llpa_table_id: ctx.pricing.tables[0]?.llpa_table_id ?? "unloaded", rule_set_version: ctx.rule_set.version, view_definition_hash: ctx.rule_set.view_definition_hash,
    loans_in_universe: universe.loans_in_universe, loans_evaluated: opportunities.length - reused.length, opportunities_detected: detected, suppressed_by_reason: suppressed, fair_lending_extract_document_id: extract.document_id, started_at: ctx.at, completed_at: ctx.at, agent_run_id: i.agent_run_id ?? null, trigger_kind: i.trigger_kind, purpose: universe.purpose };
  out.push(events.append({ type: "refi.trigger.run_completed", actor, occurredAt: ctx.at, aggregate: { kind: "rate_sheet", id: ctx.pricing.sheet.rate_sheet_id }, payload: { run_id: run.run_id, program_id: run.program_id, as_of_date: run.as_of_date, rate_sheet_id: run.rate_sheet_id, loans_in_universe: run.loans_in_universe, loans_evaluated: run.loans_evaluated, opportunities_detected: run.opportunities_detected, suppressed_by_reason: suppressed, reused: reused.length, fair_lending_extract_document_id: extract.document_id, rule_set_version: run.rule_set_version, origination: true, source: "origination" } }));
  return { run, opportunities, reused, extract, extract_written: !prior, events: out };
}

// ============================================================ fair-lending extract (rule 8; 31.2)
export interface DemographicCategory { readonly ethnicity?: string; readonly race?: string; readonly sex?: string; readonly age_band?: string; }
export interface FairLendingExtract { readonly document_id: string; readonly run_id: string; readonly program_id: string; readonly as_of_date: PlainDate; readonly universe: number; readonly offers: number; readonly suppressed: number; readonly by_category: Readonly<Record<string, { universe: number; offers: number; offer_rate: string }>>; readonly access_log: string; readonly written_at: string; readonly event: DomainEvent | null; }
/** Counts by HMDA demographic category where available (under the `applicant_demographics` access log); never PII; missing extract → run flagged incomplete. Written once per run. */
export function writeFairLendingExtract(events: EventStore | null, i: { run_id: string; program_id: string; as_of_date: PlainDate; at: string; opportunities: readonly RefiOpportunity[]; universe: readonly UniverseLoan[]; demographics: Readonly<Record<string, DemographicCategory>> }, actor: Actor = INTAKE_AGENT): FairLendingExtract {
  const cat = (id: string): string[] => { const d = i.demographics[id]; return d ? [`ethnicity:${d.ethnicity ?? "na"}`, `race:${d.race ?? "na"}`, `sex:${d.sex ?? "na"}`] : ["category:not_available"]; };
  const by: Record<string, { universe: number; offers: number; offer_rate: string }> = {};
  const offered = new Set(i.opportunities.filter((o) => o.status === "offer_ready").map((o) => o.loan_id));
  for (const l of i.universe) for (const c of cat(l.loan_id)) { const b = by[c] ?? { universe: 0, offers: 0, offer_rate: "0.0000" }; b.universe++; if (offered.has(l.loan_id)) b.offers++; b.offer_rate = b.universe ? (b.offers / b.universe).toFixed(4) : "0.0000"; by[c] = b; }
  const document_id = `fle-${i.program_id}-${i.as_of_date}`;
  const event = events ? events.append({ type: "refi.fair_lending_extract.written", actor, occurredAt: i.at, aggregate: { kind: "document", id: document_id }, payload: { run_id: i.run_id, program_id: i.program_id, as_of_date: i.as_of_date, extract_document_id: document_id, universe: i.universe.length, offers: offered.size, access_log: "applicant_demographics", consumer: "31.2", origination: true, source: "origination" } }) : null;
  return { document_id, run_id: i.run_id, program_id: i.program_id, as_of_date: i.as_of_date, universe: i.universe.length, offers: offered.size, suppressed: i.opportunities.filter((o) => o.status === "suppressed").length, by_category: by, access_log: "applicant_demographics", written_at: i.at, event };
}

// ============================================================ borrower request, transitions, overrides (state machine; rule 9; T3, T4, T7, T9)
export interface EscalationSink { open(input: { kind: "officer" | "human_agent" | "licensed_specialist" | "sev3"; loanId?: string; ownerRole?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string; kind: string }; }
/**
 * Borrower request ("can I refinance?" through borrower-comms, or a phone-in entered by ops): the consumer-initiated
 * path — no solicitation gates, eligibility still priced; inside the premium-recapture window the request proceeds
 * only after the partner `officer` acknowledges the modelled recapture (worked example 4; T3).
 */
export function requestOpportunity(events: EventStore, ctx: PipelineContext, loan: UniverseLoan, facts: GateFacts, r: { requested_at: string; transaction_type?: TransactionType; cash_out_requested_cents?: Cents; free_text?: string; bona_fide_need?: boolean; officer_acknowledged?: boolean }, esc: EscalationSink | null = null, actor: Actor = INTAKE_AGENT): PipelineResult & { escalation: { id: string; kind: string } | null; recapture_estimate: { premium_cents: Cents; note: string } | null } {
  const transaction_type = r.transaction_type ?? classifyRequest(r.free_text ?? "");
  const requestedAt = r.requested_at; const asOf = isoDateEt(requestedAt);
  const rec = premiumRecaptureGate({ fnma_purchase_date: facts.fnma_purchase_date, as_of: asOf, days: ctx.program.premium_recapture_suppression_days });
  const opportunity_id = `opp-${loan.loan_id}-${asOf}-${ctx.program.program_id}-req`;
  const requestedEv = ev(events, "refi.opportunity.requested", loan.loan_id, requestedAt, { opportunity_id, loan_id: loan.loan_id, requested_at: requestedAt, transaction_type, cash_out_requested_cents: String(r.cash_out_requested_cents ?? 0n), officer_acknowledgment_required: !rec.open, recapture_window_opens_on: rec.opens_on, path: "borrower_request", fcra_basis: "15 U.S.C. 1681b(a)(3)(F) available at 20.3 (consumer-initiated)" }, actor, { kind: "refi_opportunity", id: opportunity_id });
  let escalation: { id: string; kind: string } | null = null; let recapture_estimate: { premium_cents: Cents; note: string } | null = null;
  if (!rec.open) {
    recapture_estimate = { premium_cents: pctOfCents(loan.upb_cents, "0.875"), note: "premium (price − par) × UPB at purchase, less LLPAs and the 50 bps processing fee, at Fannie Mae's discretion (C1-1-01)" };
    if (esc) escalation = esc.open({ kind: "officer", loanId: loan.loan_id, payload: { opportunity_id, reason: "premium_recapture_acknowledgment", recapture_window_opens_on: rec.opens_on, modelled_recapture_cents: String(recapture_estimate.premium_cents), fnma_purchase_date: facts.fnma_purchase_date } }, actor);
    if (!r.officer_acknowledged) {
      const opp: RefiOpportunity = { ...base({ opportunity_id, loan_id: loan.loan_id, run_id: null, program: ctx.program, trigger_kind: "borrower_request", as_of: asOf, at: requestedAt, loan }), status: "requested", officer_acknowledgment_required: true, gates: checkGates({ path: "borrower_request", transaction_type, as_of: asOf, program: ctx.program, facts, loan, schedule: ctx.schedule ?? defaultSchedule(asOf), state_determination: null }) };
      return { opportunity: opp, events: [requestedEv], quote: null, escalation, recapture_estimate };
    }
  }
  const r2 = evaluateLoan(events, { ...ctx, as_of: asOf, at: requestedAt, run_id: null }, loan, facts, { trigger_kind: "borrower_request", path: "borrower_request", transaction_type, opportunity_id, ...(r.cash_out_requested_cents !== undefined ? { cash_out_requested_cents: r.cash_out_requested_cents } : {}), ...(r.bona_fide_need !== undefined ? { bona_fide_need: r.bona_fide_need } : {}) }, actor);
  return { ...r2, opportunity: { ...r2.opportunity, officer_acknowledgment_required: !rec.open }, events: [requestedEv, ...r2.events], escalation, recapture_estimate };
}
/** The LLM's only classification job on the request path: borrower free text → transaction type (never the rate, amount or fire decision). */
export const classifyRequest = (text: string): TransactionType => (/cash[- ]?out|take (some )?cash|equity out|\$\s?\d[\d,]*\s*(cash|out)/i.test(text) ? "cash_out" : "limited_cash_out");
/** 20.2's `marketing.touch.sent{opportunity_id}` confirms the first touch → `offered` (`refi.opportunity.offered{offered_at}` anchors SM_REFI_OPPORTUNITY_EXPIRY_30 and SM_REFI_OFFER_FREQUENCY_CAP; satisfies SM_REFI_OFFER_SLA_2BD). */
export function recordOffered(events: EventStore, opp: RefiOpportunity, touch: DomainEvent, actor: Actor = INTAKE_AGENT): { opportunity: RefiOpportunity; event: DomainEvent } {
  if (touch.type !== "marketing.touch.sent") throw new RangeError(`recordOffered consumes marketing.touch.sent (20.2), not ${touch.type}`);
  if ((touch.payload as { opportunity_id?: unknown }).opportunity_id !== opp.opportunity_id) throw new RangeError(`touch ${touch.id} is for another opportunity`);
  if (opp.status !== "offer_ready" && opp.status !== "offered") throw new RefiRefused("not_offer_ready", `opportunity ${opp.opportunity_id} is ${opp.status}`);
  if (opp.status === "offered") return { opportunity: opp, event: touch };
  const offered_at = touch.occurredAt;
  return { opportunity: { ...opp, status: "offered", campaign_id: (touch.payload as { campaign_id?: string }).campaign_id ?? null, offer_valid_until: addDays(isoDateEt(offered_at), 30) }, event: ev(events, "refi.opportunity.offered", opp.loan_id, offered_at, { opportunity_id: opp.opportunity_id, offered_at, touch_id: touch.id, campaign_id: (touch.payload as { campaign_id?: string }).campaign_id ?? null }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }) };
}
/** 20.3's `lead.created{opportunity_id}` links the lead → `engaged` (satisfies SM_REFI_OPPORTUNITY_EXPIRY_30). */
export function engageOpportunity(events: EventStore, opp: RefiOpportunity, lead: DomainEvent, actor: Actor = INTAKE_AGENT): { opportunity: RefiOpportunity; event: DomainEvent } {
  if (lead.type !== "lead.created") throw new RangeError(`engageOpportunity consumes lead.created (20.3), not ${lead.type}`);
  const p = lead.payload as { opportunity_id?: unknown; lead_id?: unknown };
  if (p.opportunity_id !== opp.opportunity_id) throw new RangeError(`lead ${lead.id} is not linked to ${opp.opportunity_id}`);
  if (opp.status !== "offered" && opp.status !== "offer_ready" && opp.status !== "requested") throw new RefiRefused("not_offered", `opportunity ${opp.opportunity_id} is ${opp.status}`);
  const lead_id = String(p.lead_id ?? lead.aggregate?.id ?? "");
  return { opportunity: { ...opp, status: "engaged", lead_id }, event: ev(events, "refi.opportunity.engaged", opp.loan_id, lead.occurredAt, { opportunity_id: opp.opportunity_id, lead_id, engaged_at: lead.occurredAt }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }) };
}
/** 21.1's `application.received` with `prior_loan_id` → `converted` (the application carries both ids through the hand-off). */
export function convertOpportunity(events: EventStore, opp: RefiOpportunity, a: { application_id: string; at: string }, actor: Actor = INTAKE_AGENT): { opportunity: RefiOpportunity; event: DomainEvent } {
  nonEmpty(a.application_id, "application_id");
  if (opp.status !== "engaged" && opp.status !== "offered" && opp.status !== "requested" && opp.status !== "offer_ready") throw new RefiRefused("not_convertible", `opportunity ${opp.opportunity_id} is ${opp.status}`);
  return { opportunity: { ...opp, status: "converted", application_id: a.application_id }, event: events.append({ type: "refi.opportunity.converted", actor, occurredAt: a.at, loanId: opp.loan_id, applicationId: a.application_id, aggregate: { kind: "refi_opportunity", id: opp.opportunity_id }, payload: { opportunity_id: opp.opportunity_id, application_id: a.application_id, prior_loan_id: opp.loan_id, origination: true, source: "origination" } }) };
}
/** The borrower says no → `declined` (`refi.opportunity.declined{declined_at}` arms SM_REFI_RESOLICIT_COOLDOWN_90: proactive solicitation refused for 90 days; the request path is unaffected). */
export function declineOpportunity(events: EventStore, opp: RefiOpportunity, d: { declined_at: string; reason?: string | null }, actor: Actor = INTAKE_AGENT): { opportunity: RefiOpportunity; event: DomainEvent; cooldown_until: PlainDate } {
  if (["converted", "declined", "expired", "suppressed"].includes(opp.status)) throw new RefiRefused("terminal", `opportunity ${opp.opportunity_id} is ${opp.status}`);
  const declined_on = isoDateEt(d.declined_at); const cooldown_until = addDays(declined_on, 90);
  return { opportunity: { ...opp, status: "declined" }, cooldown_until, event: ev(events, "refi.opportunity.declined", opp.loan_id, d.declined_at, { opportunity_id: opp.opportunity_id, declined_at: d.declined_at, declined_on, reason: d.reason ?? null, cooldown_until }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }) };
}
/** SM_REFI_OPPORTUNITY_EXPIRY_30 breach: `expired` (re-detection allowed next run). */
export function expireOpportunity(events: EventStore, opp: RefiOpportunity, at: string, actor: Actor = INTAKE_AGENT): { opportunity: RefiOpportunity; event: DomainEvent | null } {
  if (opp.status !== "offered" && opp.status !== "offer_ready") return { opportunity: opp, event: null };
  if (opp.offer_valid_until && isoDateEt(at) <= opp.offer_valid_until) return { opportunity: opp, event: null };
  return { opportunity: { ...opp, status: "expired" }, event: ev(events, "refi.opportunity.expired", opp.loan_id, at, { opportunity_id: opp.opportunity_id, expired_at: at, offer_valid_until: opp.offer_valid_until }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }) };
}
/** State machine: `suppressed` → `offer_ready` only by the partner `officer` with a logged reason, and never for a Fannie Mae-ownership reason (B2-1.3-04). */
export function overrideSuppression(events: EventStore, opp: RefiOpportunity, o: { by: Actor; reason: string; at: string }): { opportunity: RefiOpportunity; event: DomainEvent } {
  if (!isHuman(o.by, "officer")) throw new RefiRoleDenied(o.by, "officer", "a suppression override");
  nonEmpty(o.reason, "reason");
  if (opp.status !== "suppressed") throw new RefiRefused("not_suppressed", `opportunity ${opp.opportunity_id} is ${opp.status}`);
  if (/fannie|fnma|investor|owned by|mbs|pool/i.test(o.reason)) throw new RefiRefused("investor_reason_prohibited", "a suppression may never be overridden for a Fannie Mae-ownership reason (B2-1.3-04: no targeting of Fannie Mae borrowers)");
  if (!opp.candidate_terms || !opp.benefit_metrics) throw new RefiRefused("not_priced", `opportunity ${opp.opportunity_id} has no priced candidate to offer`);
  const overridden = { ...opp, status: "detected" as const, suppression_reasons: [] };
  const next = markOfferReady(events, overridden, o.at, o.by);
  return { opportunity: next, event: ev(events, "refi.opportunity.suppression.overridden", opp.loan_id, o.at, { opportunity_id: opp.opportunity_id, by: `${o.by.kind}:${o.by.id}`, reason: o.reason, prior_reasons: opp.suppression_reasons }, o.by, { kind: "refi_opportunity", id: opp.opportunity_id }) };
}
export interface LoanLookupPort { lookup(loanId: string): { owned: boolean; checked_at: string }; }
/** B2-1.3-02 / T9: the Loan Lookup call happens only after `engaged` and only when `requires_fnma_ownership_check=true`; it records `fnma_owned` as an eligibility fact and never alters the selection or the candidate. */
export function fnmaOwnershipCheck(events: EventStore, opp: RefiOpportunity, port: LoanLookupPort, at: string, actor: Actor = INTAKE_AGENT): { opportunity: RefiOpportunity; event: DomainEvent } {
  if (!opp.eligibility_prescreen?.requires_fnma_ownership_check) throw new RefiRefused("lookup_not_required", `opportunity ${opp.opportunity_id} has LTV ≤ 95%: no Loan Lookup call`);
  if (opp.status !== "engaged" && opp.status !== "converted") throw new RefiRefused("lookup_before_engaged", `Loan Lookup is an eligibility fact after engagement, never a selection input (opportunity is ${opp.status})`);
  const r = port.lookup(opp.loan_id);
  const eligibility_prescreen: EligibilityPrescreen = { ...opp.eligibility_prescreen, fnma_owned: r.owned, reasons: r.owned ? opp.eligibility_prescreen.reasons : [...opp.eligibility_prescreen.reasons, "ltv > 95% and not Fannie Mae-owned: re-price at ≤ 95% or withdraw (23.2 DU Owner of Existing Mortgage)"] };
  return { opportunity: { ...opp, eligibility_prescreen }, event: ev(events, "refi.opportunity.fnma_ownership.recorded", opp.loan_id, at, { opportunity_id: opp.opportunity_id, fnma_owned: r.owned, checked_at: r.checked_at, stage: opp.status, selection_unchanged: true }, actor, { kind: "refi_opportunity", id: opp.opportunity_id }) };
}

// ============================================================ decision record (AI agent design)
export interface DecisionRecord { readonly opportunity_id: string; readonly loan_id: string; readonly run_id: string | null; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly existing_terms: ExistingTerms; readonly candidate_terms: CandidateTerms | null; readonly benefit_metrics: BenefitMetrics | null; readonly gates: readonly { code: string; status: string }[]; readonly fire: boolean; readonly suppression_reasons: readonly string[]; readonly explanation_text: string; readonly confidence: number; readonly inputs_hash: string; readonly rationale: string; }
export function decisionRecord(opp: RefiOpportunity, v: { model_version: string; prompt_version: string; confidence?: number }): DecisionRecord {
  const fire = opp.status === "offer_ready" || opp.status === "offered" || opp.status === "engaged" || opp.status === "converted";
  return { opportunity_id: opp.opportunity_id, loan_id: opp.loan_id, run_id: opp.run_id, rule_set_version: opp.rule_set_version, model_version: v.model_version, prompt_version: v.prompt_version, existing_terms: opp.existing_terms, candidate_terms: opp.candidate_terms, benefit_metrics: opp.benefit_metrics, gates: opp.gates.map((g) => ({ code: g.code, status: g.status })), fire, suppression_reasons: opp.suppression_reasons, explanation_text: opp.explanation_text, confidence: v.confidence ?? 1, inputs_hash: opp.inputs_hash,
    rationale: fire ? `fire: rate_delta_bps ${opp.benefit_metrics?.rate_delta_bps ?? "n/a"}, npv ${money(opp.benefit_metrics?.npv_cents ?? 0n)}, seven-year delta ${money(opp.benefit_metrics?.seven_year_total_cost_delta_cents ?? 0n)}` : `no offer: ${opp.suppression_reasons.join(", ") || opp.status}` };
}

// ============================================================ gate facts for the evaluators (evaluators-20-1.ts)
const dateFact = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? plainDate(v) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? isoDateEt(v) : null);
const asOfFact = (f: Record<string, unknown>): PlainDate | null => dateFact(f.as_of) ?? dateFact(f.now) ?? dateFact(f.as_of_date);
export function premiumRecaptureGateFacts(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const as_of = asOfFact(f); if (!as_of) return { open: false, reason: "as_of is required" };
  const g = premiumRecaptureGate({ fnma_purchase_date: dateFact(f.fnma_purchase_date), as_of, days: typeof f.days === "number" ? f.days : 120 });
  return g.open ? { open: true } : { open: false, reason: g.reason! };
}
export function resolicitCooldownGateFacts(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const as_of = asOfFact(f); if (!as_of) return { open: false, reason: "as_of is required" };
  const g = resolicitCooldownGate({ declined_on: dateFact(f.declined_on) ?? dateFact(f.declined_at), as_of, days: typeof f.days === "number" ? f.days : 90 });
  return g.open ? { open: true } : { open: false, reason: g.reason! };
}
export function offerFrequencyCapGateFacts(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const as_of = asOfFact(f); if (!as_of) return { open: false, reason: "as_of is required" };
  const g = offerFrequencyCapGate({ offered_at: Array.isArray(f.offered_at) ? (f.offered_at as string[]) : [], as_of, max_offers_per_loan_per_12m: typeof f.max_offers_per_loan_per_12m === "number" ? f.max_offers_per_loan_per_12m : 2 });
  return g.open ? { open: true } : { open: false, reason: g.reason! };
}
export function cashoutNoteSeasoningGateFacts(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const note = dateFact(f.note_date), nn = dateFact(f.new_note_date) ?? dateFact(f.consummation_date); if (!note || !nn) return { open: false, reason: "note_date and new_note_date are required" };
  const g = cashoutNoteSeasoningGate({ note_date: note, new_note_date: nn }); return g.open ? { open: true } : { open: false, reason: g.reason! };
}
export function titleSeasoningGateFacts(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const t = dateFact(f.title_date), d = dateFact(f.disbursement_date); if (!t || !d) return { open: false, reason: "title_date and disbursement_date are required" };
  const g = titleSeasoningGate({ title_date: t, disbursement_date: d, exception: (f.exception as "inheritance" | "legal_award" | "delayed_financing" | null | undefined) ?? null }); return g.open ? { open: true } : { open: false, reason: g.reason! };
}
export function borrowerInterestGateFacts(f: Record<string, unknown>): { open: boolean; reason?: string } {
  if (f.pass === true) return { open: true };
  if (f.pass === false) return { open: false, reason: "refi.borrower_interest.determined{pass=false}: no borrower's-interest factor (M.G.L. c.183 §28C)" };
  const ec = dateFact(f.existing_consummation_date), cc = dateFact(f.candidate_consummation_date); if (!ec || !cc) return { open: false, reason: "existing_consummation_date and candidate_consummation_date are required" };
  const c = (k: string): Cents => (typeof f[k] === "bigint" ? (f[k] as bigint) : BigInt(String(f[k] ?? "0")));
  const d = borrowerInterestRule({ property_state: String(f.property_state ?? "MA"), existing_consummation_date: ec, candidate_consummation_date: cc, rules: { [String(f.property_state ?? "MA")]: MA_183_28C }, pi_delta_cents: c("pi_delta_cents"), borrower_paid_costs_cents: c("borrower_paid_costs_cents"), rate_delta_bps: Number(f.rate_delta_bps ?? 0), arm_to_fixed: f.arm_to_fixed === true, bona_fide_need: f.bona_fide_need === true, court_order: f.court_order === true, ...(typeof f.cash_proceeds_cents === "bigint" || typeof f.cash_proceeds_cents === "string" ? { cash_proceeds_cents: c("cash_proceeds_cents") } : {}) });
  return d.pass ? { open: true } : { open: false, reason: `${d.rule ?? "borrower's-interest rule"}: ${d.months_since_consummation} months since consummation and no factor` };
}
