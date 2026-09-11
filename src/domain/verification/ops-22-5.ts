/**
 * §22.5 Liabilities, debt-to-income, qualifying payment, and debts paid at closing — the `verification` agent's
 * liability rules as small pure functions (B3-6-01 … B3-6-07; B3-2-10 tolerance through 22.2's calculators, which are
 * 23.1's check). All money is integer cents; rates are basis points; rounding is applied once, at the ratio (R1).
 *
 * Reused, never re-implemented: 22.2's `dtiTenths` / `b3210ToleranceCheck` (23.1's 45 %/3-point rule in tenths of a
 * percent) and its `credit.undisclosed_debt.found` / `credit.refresh.received{alerts_open}` events; 22.3's
 * `income.finalized{total_qualifying_cents}`; 22.1's document classes (`divorce_decree`, `support_order`,
 * `irs_installment_agreement`, `payoff_statement`) and `document.classified{doc_class}`; the kernel's `levelPayment`.
 *
 * Events (subject = application; every payload carries `application_id` so src/kernel/timers/engine.ts arms the
 * §22.5 clocks — see timers-22-5.ts):
 *   liability.declared{liability_id, liability_type, source, balance_cents}           [arms FNMA_B3_6_05_LEGAL_DOC_GATE (alimony-type), FNMA_B3_6_05_IRS_AGREEMENT_GATE (irs_installment)]
 *   liability.discovered{liability_id, source}                                          (udm_alert | refresh | du_message | deposit_sourcing | document)
 *   liability.matched_to_tradeline{liability_id, credit_tradeline_id}
 *   liability.payment_basis.selected{liability_id, payment_basis, qualifying_payment_cents, alternatives}
 *   liability.excluded{liability_id, reason, evidence_document_ids}
 *   liability.included{liability_id, payment_basis, qualifying_payment_cents}          [satisfies FNMA_B3_6_05_IRS_AGREEMENT_GATE when payment_basis=irs_agreement]
 *   liabilities.changed{dti_before, dti_after, dti_before_bps, dti_after_bps, delta_bps, tolerance_result, rule_code}
 *                                                                                       [→ 23.1 tolerance; arms SM_DU_RESUBMIT_SLA_1BD when tolerance_result=resubmission_required]
 *   qualifying_payment.computed{qp_id, version, qualifying_rate_bps, pi_cents, pitia_cents}
 *   dti.computed{dti_id, version, stage, dti_bps, du_cap_ok, liability_ids, checked_against_du, remaining_months_recomputed}
 *                                                                                       [arms FNMA_B3_6_02_DU_DTI_50_GATE; stage=final satisfies FNMA_B3_6_01_LIABILITY_RECALC_GATE;
 *                                                                                        checked_against_du=true satisfies SM_DU_RESUBMIT_SLA_1BD; remaining_months_recomputed=true satisfies FNMA_B3_6_05_10MO_REMAINING_RULE]
 *   dti.du_cap.exceeded{dti_bps, cap_bps, hand_off}                                    (23.2 restructure loop; `underwriting_reviewer` for counteroffer/denial via 21.6)
 *   debt_payoff.planned{plan_id, liability_id, mode, payoff_amount_cents, funds_to_verify_delta_cents, scheduled_note_date}   [arms FNMA_B3_6_07_PAYOFF_FUNDS_GATE; 22.4 adds the delta to funds_to_verify]
 *   debt_payoff.evidenced{plan_id, evidence}                                            [satisfies it]
 *   debt_payoff.failed{plan_id, reason}                                                 (liability re-included, DTI recomputed → liabilities.changed)
 *   liabilities.finalized{dti_id, version, dti_bps, du_cap_ok, liability_ids}          (23.1 final DU submission, 23.3 CTC, 23.4 ATR record, 28.3 HMDA) [satisfies FNMA_B3_6_02_DU_DTI_50_GATE when du_cap_ok=true]
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, parts } from "../../kernel/calendar/date.ts";
import { levelPayment, Decimal, divRound, formatCents, type Cents } from "../../kernel/money/index.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { GateResult } from "../../app/evaluator-kit.ts";
import { RULE_SET_VERSION, DU_RULE_SET_VERSION, dtiTenths, b3210ToleranceCheck, type ToleranceCheck } from "./ops-22-2.ts";

export const AGENT: Actor = { kind: "agent", id: "verification" };
export { RULE_SET_VERSION, DU_RULE_SET_VERSION };
export const FORMULAS = { qualifying_payment: "22.5.qualifying_payment.v1", dti: "22.5.dti.v1", payment_basis: "22.5.payment_basis.v1", payoff: "22.5.payoff.v1" } as const;

export class LiabilityRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, message: string) { super(message); this.name = "LiabilityRefused"; this.code = code; this.citation = citation; }
}
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const nonNeg = (v: Cents, what: string): Cents => { if (typeof v !== "bigint" || v < 0n) throw new RangeError(`${what} must be a non-negative bigint of cents`); return v; };
const emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = AGENT): DomainEvent =>
  events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, ...payload } });
const S = (c: Cents | null | undefined): string | null => (c === null || c === undefined ? null : String(c));

// ============================================================ vocabulary (data model)
export type LiabilityType = "mortgage" | "heloc" | "installment" | "revolving" | "open_30_day" | "lease_auto" | "lease_other" | "student_loan" | "alimony" | "child_support" | "separate_maintenance" | "equalization_payment" | "garnishment" | "irs_installment" | "business_debt_personal_name" | "secured_by_financial_asset" | "co_signed" | "court_assigned" | "bridge_loan" | "community_second" | "other_recurring" | "collection_judgment_lien";
export type LiabilitySource = "credit_report" | "application" | "udm_alert" | "refresh" | "borrower_disclosure" | "document" | "du_message" | "deposit_sourcing";
export type PaymentBasis = "credit_report" | "creditor_statement" | "revolving_5pct" | "student_idr_zero_documented" | "student_1pct_balance" | "student_amortizing_documented" | "deferred_letter" | "lease_full" | "legal_agreement" | "irs_agreement" | "heloc_required_payment" | "mortgage_pitia" | "rental_net_loss" | "bridge_terms" | "none";
export type ExclusionReason = "le_10_payments" | "paid_off_at_closing" | "paid_down_le_10" | "paid_by_other_12m" | "business_paid_12m_cashflow" | "secured_by_financial_asset" | "court_assigned_contingent" | "non_applicant_documented" | "voluntary_payment" | "open_30_day" | "heloc_no_payment" | "community_second_deferred_5y" | "income_reduction_elected" | "sold_before_closing" | "pending_sale_contract_cleared" | "rental_offset";
export type LiabilityStatus = "declared" | "discovered" | "matched" | "unmatched_significant" | "basis_selected" | "included" | "excluded" | "payoff_planned" | "payoff_evidenced" | "finalized" | "reopened";
export const LIABILITY_TYPES: readonly LiabilityType[] = ["mortgage", "heloc", "installment", "revolving", "open_30_day", "lease_auto", "lease_other", "student_loan", "alimony", "child_support", "separate_maintenance", "equalization_payment", "garnishment", "irs_installment", "business_debt_personal_name", "secured_by_financial_asset", "co_signed", "court_assigned", "bridge_loan", "community_second", "other_recurring", "collection_judgment_lien"];
export const LIABILITY_SOURCES: readonly LiabilitySource[] = ["credit_report", "application", "udm_alert", "refresh", "borrower_disclosure", "document", "du_message", "deposit_sourcing"];
/** Alimony-type obligations: legal-document gate (B3-6-05) and the > 10 months rule. Only the first three may reduce income instead. */
export const LEGAL_AGREEMENT_TYPES: readonly LiabilityType[] = ["alimony", "equalization_payment", "separate_maintenance", "child_support"];
export const INCOME_REDUCTION_TYPES: readonly LiabilityType[] = ["alimony", "equalization_payment", "separate_maintenance"];
/** Obligations the "more than ten monthly payments remaining" rule applies to (installment, garnishment, alimony-type); leases never (B3-6-05), IRS agreements never (included unless paid in full). */
export const TEN_MONTH_RULE_TYPES: readonly LiabilityType[] = ["installment", "garnishment", "alimony", "child_support", "separate_maintenance", "equalization_payment", "other_recurring"];
export const RETENTION_CLASS = "fnma_loan_file_life_plus_4y";

export interface Liability {
  readonly liability_id: string; readonly application_id: string; readonly borrower_ids: readonly string[]; readonly liability_type: LiabilityType; readonly creditor_name: string; readonly account_last4: string | null;
  readonly source: LiabilitySource; readonly credit_tradeline_id: string | null; readonly balance_cents: Cents; readonly reported_payment_cents: Cents | null; readonly remaining_months: number | null;
  readonly qualifying_payment_cents: Cents; readonly payment_basis: PaymentBasis; readonly include_in_dti: boolean; readonly exclusion_reason: ExclusionReason | null; readonly exclusion_evidence_document_ids: readonly string[];
  readonly significantly_affects: boolean; readonly income_reduction_elected: boolean; readonly paid_at_closing: boolean; readonly payoff_amount_cents: Cents | null; readonly payoff_source_asset_id: string | null; readonly payoff_statement_document_id: string | null;
  readonly tax_lien_indicated: boolean; readonly du_message_ids: readonly string[]; readonly status: LiabilityStatus; readonly retention_class: typeof RETENTION_CLASS;
}
export interface DeclareInput {
  readonly application_id: string; readonly borrower_ids: readonly string[]; readonly liability_type: LiabilityType; readonly creditor_name: string; readonly account_last4?: string | null; readonly source: LiabilitySource;
  readonly credit_tradeline_id?: string | null; readonly balance_cents: Cents; readonly reported_payment_cents?: Cents | null; readonly remaining_months?: number | null; readonly paid_at_closing?: boolean; readonly tax_lien_indicated?: boolean; readonly du_message_ids?: readonly string[]; readonly liability_id?: string;
}
const DISCOVERED_SOURCES: readonly LiabilitySource[] = ["udm_alert", "refresh", "du_message", "deposit_sourcing", "document"];
/** A liability from the URLA Section 2c / the credit report (`liability.declared`) or discovered later (`liability.discovered{source}`); the qualifying payment starts at the reported payment until a basis is selected. */
export function declareLiability(events: EventStore, i: DeclareInput, at: string, actor: Actor = AGENT): { liability: Liability; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.creditor_name, "creditor_name"); nonNeg(i.balance_cents, "balance_cents");
  if (!LIABILITY_TYPES.includes(i.liability_type)) throw new RangeError(`liability_type ${JSON.stringify(i.liability_type)} is not one of ${LIABILITY_TYPES.join("/")}`);
  if (!LIABILITY_SOURCES.includes(i.source)) throw new RangeError(`source ${JSON.stringify(i.source)} is not one of ${LIABILITY_SOURCES.join("/")}`);
  if (!i.borrower_ids.length) throw new RangeError("borrower_ids are required (the borrower must be obligated — non-applicant debts are never counted)");
  const discovered = DISCOVERED_SOURCES.includes(i.source);
  const liability: Liability = { liability_id: i.liability_id ?? randomUUID(), application_id: i.application_id, borrower_ids: [...i.borrower_ids], liability_type: i.liability_type, creditor_name: i.creditor_name, account_last4: i.account_last4 ?? null, source: i.source, credit_tradeline_id: i.credit_tradeline_id ?? null,
    balance_cents: i.balance_cents, reported_payment_cents: i.reported_payment_cents ?? null, remaining_months: i.remaining_months ?? null, qualifying_payment_cents: i.reported_payment_cents ?? 0n, payment_basis: "none", include_in_dti: true, exclusion_reason: null, exclusion_evidence_document_ids: [],
    significantly_affects: false, income_reduction_elected: false, paid_at_closing: i.paid_at_closing ?? false, payoff_amount_cents: null, payoff_source_asset_id: null, payoff_statement_document_id: null, tax_lien_indicated: i.tax_lien_indicated ?? false, du_message_ids: [...(i.du_message_ids ?? [])], status: discovered ? "discovered" : "declared", retention_class: RETENTION_CLASS };
  const event = emit(events, i.application_id, discovered ? "liability.discovered" : "liability.declared", { liability_id: liability.liability_id, liability_type: liability.liability_type, source: liability.source, creditor_name: liability.creditor_name, balance_cents: String(liability.balance_cents), reported_payment_cents: S(liability.reported_payment_cents), borrower_ids: [...liability.borrower_ids] }, at, actor);
  return { liability, event };
}

// ============================================================ tradeline matching (B3-6-01)
export interface Tradeline { readonly tradeline_id: string; readonly borrower_id: string; readonly creditor_name: string; readonly account_last4?: string | null; readonly liability_type?: LiabilityType; readonly balance_cents: Cents; readonly payment_cents: Cents | null; readonly remaining_months?: number | null; readonly opened_on?: PlainDate | null; readonly repository?: string; readonly authorized_user?: boolean; readonly delinquencies_12m?: number; }
export const SIGNIFICANT_DEBT_CENTS = 100_000n;
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const tlKey = (t: Tradeline): string => `${norm(t.creditor_name)}|${t.account_last4 ?? ""}|${t.opened_on ?? ""}`;
/** Duplicates across bureaus collapse to one line; when the bureaus disagree on the payment and no statement exists the highest reported payment is used (edge case). */
export function dedupeTradelines(lines: readonly Tradeline[]): Tradeline[] {
  const by = new Map<string, Tradeline>();
  for (const t of lines) { const k = tlKey(t); const cur = by.get(k); if (!cur || (t.payment_cents ?? -1n) > (cur.payment_cents ?? -1n)) by.set(k, t); }
  return [...by.values()];
}
export interface MatchResult { readonly matched: { liability_id: string; tradeline_id: string }[]; readonly unmatched_significant: Liability[]; readonly unmatched_minor: Liability[]; readonly undisclosed: Tradeline[]; readonly authorized_user: Tradeline[]; readonly liabilities: Liability[]; }
/** Tradeline ↔ application match by creditor (and last4 when both carry it). Declared debts ≥ $1,000 with no tradeline need separate credit verification; tradelines not on the application need the borrower's reasonable explanation; authorized-user lines are not the borrower's debt. */
export function matchTradelines(events: EventStore, declared: readonly Liability[], tradelines: readonly Tradeline[], at: string, actor: Actor = AGENT, significant_cents: Cents = SIGNIFICANT_DEBT_CENTS): MatchResult {
  const lines = dedupeTradelines(tradelines);
  const used = new Set<string>();
  const matched: { liability_id: string; tradeline_id: string }[] = [], unmatched_significant: Liability[] = [], unmatched_minor: Liability[] = [], out: Liability[] = [];
  for (const l of declared) {
    const hit = lines.find((t) => !used.has(t.tradeline_id) && !t.authorized_user && l.borrower_ids.includes(t.borrower_id) && norm(t.creditor_name) === norm(l.creditor_name) && (!l.account_last4 || !t.account_last4 || l.account_last4 === t.account_last4));
    if (hit) {
      used.add(hit.tradeline_id); matched.push({ liability_id: l.liability_id, tradeline_id: hit.tradeline_id });
      const next: Liability = { ...l, credit_tradeline_id: hit.tradeline_id, balance_cents: hit.balance_cents, reported_payment_cents: hit.payment_cents, remaining_months: hit.remaining_months ?? l.remaining_months, status: "matched" };
      out.push(next); emit(events, l.application_id, "liability.matched_to_tradeline", { liability_id: l.liability_id, credit_tradeline_id: hit.tradeline_id, balance_cents: String(hit.balance_cents), reported_payment_cents: S(hit.payment_cents) }, at, actor);
    } else if (l.credit_tradeline_id) { out.push(l); }
    else if (l.balance_cents >= significant_cents) { const next: Liability = { ...l, status: "unmatched_significant" }; out.push(next); unmatched_significant.push(next); }
    else { out.push(l); unmatched_minor.push(l); }
  }
  const authorized_user = lines.filter((t) => t.authorized_user === true);
  const undisclosed = lines.filter((t) => !used.has(t.tradeline_id) && !t.authorized_user);
  return { matched, unmatched_significant, unmatched_minor, undisclosed, authorized_user, liabilities: out };
}

// ============================================================ R3 — payment basis per liability (B3-6-05)
export interface BasisEvidence {
  readonly creditor_statement_payment_cents?: Cents | null; readonly supplemental_statement_payment_cents?: Cents | null; readonly payment_letter_cents?: Cents | null;
  readonly idr_statement_document_id?: string | null; readonly idr_payment_cents?: Cents | null; readonly amortizing_payment_cents?: Cents | null; readonly amortizing_terms?: { rate_bps: number; term_months: number } | null;
  readonly heloc_required_payment_cents?: Cents | null; readonly legal_agreement_document_id?: string | null; readonly legal_agreement_payment_cents?: Cents | null;
  readonly irs_agreement_document_id?: string | null; readonly irs_agreement_status?: "approved" | "pending" | null; readonly irs_agreement_payment_cents?: Cents | null; readonly irs_paid_in_full?: boolean; readonly irs_payment_evidence_document_id?: string | null;
  readonly bridge_payment_cents?: Cents | null; readonly deferred_5y_or_more?: boolean; readonly scheduled_payment_cents?: Cents | null; readonly pitia_cents?: Cents | null; readonly rental_net_loss_cents?: Cents | null;
}
export interface BasisSelection { readonly qualifying_payment_cents: Cents; readonly payment_basis: PaymentBasis; readonly alternatives: Record<string, string>; readonly condition: string | null; readonly rationale: string; readonly formula_version: string; }
export const REVOLVING_PCT = 5n;
export const STUDENT_PCT = 1n;
/** B3-6-05: "5% of the outstanding balance" — round_half_up(balance × 5 / 100). */
export const revolving5pct = (balance_cents: Cents): Cents => divRound(nonNeg(balance_cents, "balance_cents") * REVOLVING_PCT, 100n, "HALF_UP");
/** B3-6-05: "1% of the outstanding student loan balance" — round_half_up(balance / 100). */
export const student1pct = (balance_cents: Cents): Cents => divRound(nonNeg(balance_cents, "balance_cents") * STUDENT_PCT, 100n, "HALF_UP");
/** Rate "bps" as the spec writes them — thousandths of a percent (5.875 % → 5,875; 7.050 % → 7,050); DTI bps are hundredths (38.00 % → 3,800). */
export const RATE_BPS_PER_UNIT = 100_000n;
export const bpsRate = (bps: number): Decimal => Decimal.ratio(BigInt(Math.round(bps)), RATE_BPS_PER_UNIT);
/** A fully amortizing payment from the documented repayment terms (P&I at the documented rate over the documented term). */
export const amortizingPayment = (balance_cents: Cents, rate_bps: number, term_months: number): Cents => levelPayment(nonNeg(balance_cents, "balance_cents"), bpsRate(rate_bps), term_months);
const sel = (qualifying_payment_cents: Cents, payment_basis: PaymentBasis, rationale: string, alternatives: Record<string, string> = {}, condition: string | null = null): BasisSelection => ({ qualifying_payment_cents, payment_basis, alternatives, condition, rationale, formula_version: FORMULAS.payment_basis });
const pos = (c: Cents | null | undefined): c is Cents => c !== null && c !== undefined && c > 0n;
/** Selects the cheapest *permitted* evidence path per B3-6-05; the student-loan choice records both figures (guardrail: never "optimize" beyond the Guide). */
export function selectPaymentBasis(l: Pick<Liability, "liability_type" | "balance_cents" | "reported_payment_cents">, ev: BasisEvidence = {}): BasisSelection {
  const reported = l.reported_payment_cents;
  switch (l.liability_type) {
    case "installment": case "other_recurring": case "collection_judgment_lien": case "co_signed": case "business_debt_personal_name": case "secured_by_financial_asset": case "court_assigned":
      if (pos(ev.creditor_statement_payment_cents)) return sel(ev.creditor_statement_payment_cents, "creditor_statement", "creditor statement overrides the reported payment");
      if (pos(reported)) return sel(reported, "credit_report", "reported payment (B3-6-05 installment)");
      if (pos(ev.payment_letter_cents)) return sel(ev.payment_letter_cents, "deferred_letter", "deferred installment: payment letter / forbearance agreement (B3-6-05)");
      return sel(0n, "none", "no payment reported and no payment letter", {}, "PTD: creditor payment letter or forbearance agreement stating the monthly payment at the end of the deferment (B3-6-05)");
    case "revolving":
      if (pos(reported)) return sel(reported, "credit_report", "reported minimum payment");
      if (pos(ev.supplemental_statement_payment_cents)) return sel(ev.supplemental_statement_payment_cents, "creditor_statement", "supplemental statement supports a payment of less than 5 %");
      return sel(revolving5pct(l.balance_cents), "revolving_5pct", `no minimum reported and no supplemental documentation → 5 % of ${formatCents(l.balance_cents)} (B3-6-05)`);
    case "open_30_day": return sel(0n, "none", "open 30-day account: not included in DTI; balance added to funds to verify unless paid off with proof (B3-6-05/-07)");
    case "student_loan": {
      if (pos(reported)) return sel(reported, "credit_report", "monthly student loan payment provided on the credit report (B3-6-05)");
      if (ev.idr_statement_document_id && (ev.idr_payment_cents ?? 0n) === 0n) return sel(0n, "student_idr_zero_documented", "income-driven plan documented at $0.00 by the servicer (B3-6-05)");
      if (ev.idr_statement_document_id && pos(ev.idr_payment_cents)) return sel(ev.idr_payment_cents, "creditor_statement", "income-driven plan payment per the servicer statement");
      const onePct = student1pct(l.balance_cents);
      const amort = pos(ev.amortizing_payment_cents) ? ev.amortizing_payment_cents : ev.amortizing_terms ? amortizingPayment(l.balance_cents, ev.amortizing_terms.rate_bps, ev.amortizing_terms.term_months) : null;
      const alternatives: Record<string, string> = { student_1pct_balance: String(onePct), ...(amort !== null ? { student_amortizing_documented: String(amort) } : {}) };
      if (amort !== null && amort < onePct) return sel(amort, "student_amortizing_documented", "documented amortizing payment lower than 1 % (permitted; both recorded — Q3)", alternatives);
      return sel(onePct, "student_1pct_balance", amort === null ? "no payment on the report and no documentation → 1 % of the balance; the amortizing alternative needs the repayment terms" : `1 % of the balance is the lower permitted figure (amortizing ${formatCents(amort)} recorded — "even if this amount is lower than the actual fully amortizing payment")`, alternatives, amort === null ? "PTD (optional): servicer statement with the repayment terms or an IDR statement showing the actual payment" : null);
    }
    case "heloc":
      if (pos(ev.heloc_required_payment_cents)) return sel(ev.heloc_required_payment_cents, "heloc_required_payment", "HELOC requires a P&I or interest-only payment per the statement (B3-6-05)");
      if (pos(reported)) return sel(reported, "credit_report", "HELOC payment as reported");
      return sel(0n, "none", "the HELOC does not require a payment: no recurring obligation and no equivalent payment developed (B3-6-05)");
    case "lease_auto": case "lease_other": {
      const p = pos(ev.creditor_statement_payment_cents) ? ev.creditor_statement_payment_cents : reported ?? 0n;
      return sel(p, "lease_full", "lease payments count in full regardless of the months remaining (B3-6-05)");
    }
    case "alimony": case "child_support": case "separate_maintenance": case "equalization_payment": case "garnishment": {
      const p = pos(ev.legal_agreement_payment_cents) ? ev.legal_agreement_payment_cents : reported ?? 0n;
      return sel(p, "legal_agreement", "per the decree / separation agreement / court order", {}, ev.legal_agreement_document_id ? null : "PTD: copy of the divorce decree, separation agreement, court order or equivalent confirming the amount (B3-6-05)");
    }
    case "irs_installment":
      if (ev.irs_paid_in_full) return sel(0n, "none", "the amount owed is paid in full (SEL-2026-05)");
      return sel(pos(ev.irs_agreement_payment_cents) ? ev.irs_agreement_payment_cents : reported ?? 0n, "irs_agreement", `${ev.irs_agreement_status === "pending" ? "pending application for an" : "approved"} IRS installment agreement: the monthly payment is a debt obligation unless paid in full (B3-6-05, SEL-2026-05)`, {}, ev.irs_agreement_document_id ? null : "PTD: copy of the approved IRS installment agreement (or the application) with the monthly payment and total due; evidence the borrower is current");
    case "bridge_loan": return sel(pos(ev.bridge_payment_cents) ? ev.bridge_payment_cents : reported ?? 0n, "bridge_terms", "bridge loan per its documented terms");
    case "community_second":
      if (ev.deferred_5y_or_more) return sel(0n, "none", "Community Seconds repayment deferred five years or more: no payment in DTI (B5-5.1-02)");
      return sel(pos(ev.scheduled_payment_cents) ? ev.scheduled_payment_cents : reported ?? 0n, "creditor_statement", "Community Seconds scheduled payment (deferred less than five years)");
    case "mortgage":
      if (pos(ev.rental_net_loss_cents)) return sel(ev.rental_net_loss_cents, "rental_net_loss", "other REO: net rental loss per 22.3's B3-3.8 treatment (B3-6-06)");
      return sel(pos(ev.pitia_cents) ? ev.pitia_cents : reported ?? 0n, "mortgage_pitia", "full PITIA of the other property (B3-6-06)");
  }
}
export function applyBasis(events: EventStore, l: Liability, s: BasisSelection, at: string, actor: Actor = AGENT): { liability: Liability; event: DomainEvent } {
  const liability: Liability = { ...l, qualifying_payment_cents: s.qualifying_payment_cents, payment_basis: s.payment_basis, status: "basis_selected" };
  const event = emit(events, l.application_id, "liability.payment_basis.selected", { liability_id: l.liability_id, liability_type: l.liability_type, payment_basis: s.payment_basis, qualifying_payment_cents: String(s.qualifying_payment_cents), alternatives: s.alternatives, condition: s.condition, rationale: s.rationale, formula_version: s.formula_version }, at, actor);
  return { liability, event };
}

// ============================================================ R2 — qualifying payment (B3-6-04)
export type Product = "fixed" | "arm_3_or_less" | "arm_5" | "arm_7" | "arm_10" | "generic_arm";
export type PropertyRole = "subject_primary" | "subject_second_home" | "subject_investment" | "other_reo";
export type QualifyingRateBasis = "note_rate" | "max_first_5y" | "greater_note_plus_cap_or_fir" | "greater_note_or_fir_hpml" | "du_arm_qualifying_rate_field";
export interface RateInput { readonly product: Product; readonly note_rate_bps: number; readonly index_bps?: number | null; readonly margin_bps?: number | null; readonly first_cap_bps?: number | null; readonly max_rate_first_5y_bps?: number | null; readonly hpml_or_hpct?: boolean; readonly temporary_buydown?: { readonly year1_rate_bps: number; readonly kind: string } | null; readonly du_arm_qualifying_rate_bps?: number | null; }
export interface QualifyingRate { readonly qualifying_rate_bps: number; readonly qualifying_rate_basis: QualifyingRateBasis; readonly fully_indexed_bps: number | null; readonly buydown_ignored: boolean; readonly citation: "B3-6-04"; }
const fir = (i: RateInput): number | null => (i.index_bps === null || i.index_bps === undefined || i.margin_bps === null || i.margin_bps === undefined ? null : i.index_bps + i.margin_bps);
/** B3-6-04: fixed → note rate; ≤ 3-year ARM → max rate in the first five years; 5-year ARM → greater of note + first cap or the fully indexed rate; 7/10-year → note rate (fully indexed if HPML/HPCT); Generic ARM → the DU field when higher; buydowns are ignored. */
export function qualifyingRate(i: RateInput): QualifyingRate {
  if (!Number.isInteger(i.note_rate_bps) || i.note_rate_bps <= 0) throw new RangeError("note_rate_bps must be a positive integer");
  const buydown_ignored = !!i.temporary_buydown;
  const f = fir(i);
  const out = (qualifying_rate_bps: number, qualifying_rate_basis: QualifyingRateBasis): QualifyingRate => ({ qualifying_rate_bps, qualifying_rate_basis, fully_indexed_bps: f, buydown_ignored, citation: "B3-6-04" });
  switch (i.product) {
    case "fixed": return out(i.note_rate_bps, "note_rate");
    case "arm_3_or_less": return out(i.max_rate_first_5y_bps ?? i.note_rate_bps + (i.first_cap_bps ?? 0), "max_first_5y");
    case "arm_5": { if (i.first_cap_bps === null || i.first_cap_bps === undefined || f === null) throw new RangeError("a 5-year ARM needs first_cap_bps, index_bps and margin_bps"); return out(Math.max(i.note_rate_bps + i.first_cap_bps, f), "greater_note_plus_cap_or_fir"); }
    case "arm_7": case "arm_10": { if (i.hpml_or_hpct) { if (f === null) throw new RangeError("an HPML/HPCT 7/10-year ARM needs index_bps and margin_bps"); return out(Math.max(i.note_rate_bps, f), "greater_note_or_fir_hpml"); } return out(i.note_rate_bps, "note_rate"); }
    case "generic_arm": { if (i.du_arm_qualifying_rate_bps === null || i.du_arm_qualifying_rate_bps === undefined) throw new RangeError("a Generic ARM plan needs the DU ARM Qualifying Rate field"); return out(Math.max(i.note_rate_bps, i.du_arm_qualifying_rate_bps), "du_arm_qualifying_rate_field"); }
  }
}
/** `pi = round_half_up(L × r / (1 − (1 + r)^−n))`, r = rate / 12 at full precision (kernel levelPayment). */
export const piCents = (loan_amount_cents: Cents, rate_bps: number, term_months: number): Cents => levelPayment(nonNeg(loan_amount_cents, "loan_amount_cents"), bpsRate(rate_bps), term_months);
export interface QpInput extends RateInput { readonly application_id: string; readonly version: number; readonly property_role: PropertyRole; readonly loan_amount_cents: Cents; readonly term_months: number; readonly mi_cents?: Cents; readonly taxes_cents?: Cents; readonly hazard_cents?: Cents; readonly flood_cents?: Cents; readonly hoa_cents?: Cents; readonly coop_fee_cents?: Cents; readonly ground_rent_cents?: Cents; readonly special_assessment_cents?: Cents; readonly subordinate_payment_cents?: Cents; readonly qp_id?: string; }
export interface QualifyingPayment extends QualifyingRate { readonly qp_id: string; readonly application_id: string; readonly version: number; readonly property_role: PropertyRole; readonly loan_amount_cents: Cents; readonly note_rate_bps: number; readonly product: Product; readonly index_bps: number | null; readonly margin_bps: number | null; readonly first_cap_bps: number | null; readonly hpml_or_hpct: boolean; readonly pi_cents: Cents; readonly bought_down_pi_cents: Cents | null; readonly mi_cents: Cents; readonly taxes_cents: Cents; readonly hazard_cents: Cents; readonly flood_cents: Cents; readonly hoa_cents: Cents; readonly coop_fee_cents: Cents; readonly ground_rent_cents: Cents; readonly special_assessment_cents: Cents; readonly subordinate_payment_cents: Cents; readonly pitia_cents: Cents; readonly formula_version: string; readonly inputs: Record<string, unknown>; }
/** `pitia = pi + mi + taxes + hazard + flood + hoa + coop + ground_rent + special_assessments + subordinate_payment` at the qualifying rate (B3-6-03/-04). */
export function computeQualifyingPayment(i: QpInput): QualifyingPayment {
  nonEmpty(i.application_id, "application_id"); if (!(i.term_months > 0)) throw new RangeError("term_months must be positive");
  const r = qualifyingRate(i);
  const pi_cents = piCents(i.loan_amount_cents, r.qualifying_rate_bps, i.term_months);
  const comps = { mi_cents: i.mi_cents ?? 0n, taxes_cents: i.taxes_cents ?? 0n, hazard_cents: i.hazard_cents ?? 0n, flood_cents: i.flood_cents ?? 0n, hoa_cents: i.hoa_cents ?? 0n, coop_fee_cents: i.coop_fee_cents ?? 0n, ground_rent_cents: i.ground_rent_cents ?? 0n, special_assessment_cents: i.special_assessment_cents ?? 0n, subordinate_payment_cents: i.subordinate_payment_cents ?? 0n };
  for (const [k, v] of Object.entries(comps)) nonNeg(v, k);
  const pitia_cents = pi_cents + Object.values(comps).reduce((a, b) => a + b, 0n);
  return { ...r, qp_id: i.qp_id ?? randomUUID(), application_id: i.application_id, version: i.version, property_role: i.property_role, loan_amount_cents: i.loan_amount_cents, note_rate_bps: i.note_rate_bps, product: i.product, index_bps: i.index_bps ?? null, margin_bps: i.margin_bps ?? null, first_cap_bps: i.first_cap_bps ?? null, hpml_or_hpct: i.hpml_or_hpct === true,
    pi_cents, bought_down_pi_cents: i.temporary_buydown ? piCents(i.loan_amount_cents, i.temporary_buydown.year1_rate_bps, i.term_months) : null, ...comps, pitia_cents, formula_version: FORMULAS.qualifying_payment,
    inputs: { loan_amount_cents: String(i.loan_amount_cents), note_rate_bps: i.note_rate_bps, term_months: i.term_months, product: i.product, index_bps: i.index_bps ?? null, margin_bps: i.margin_bps ?? null, first_cap_bps: i.first_cap_bps ?? null, hpml_or_hpct: i.hpml_or_hpct === true, temporary_buydown: i.temporary_buydown ?? null, du_arm_qualifying_rate_bps: i.du_arm_qualifying_rate_bps ?? null, rule_set_version: RULE_SET_VERSION, du_rule_set_version: DU_RULE_SET_VERSION } };
}
export function recordQualifyingPayment(events: EventStore, qp: QualifyingPayment, at: string, actor: Actor = AGENT): DomainEvent {
  return emit(events, qp.application_id, "qualifying_payment.computed", { qp_id: qp.qp_id, version: qp.version, property_role: qp.property_role, product: qp.product, qualifying_rate_bps: qp.qualifying_rate_bps, qualifying_rate_basis: qp.qualifying_rate_basis, buydown_ignored: qp.buydown_ignored, pi_cents: String(qp.pi_cents), pitia_cents: String(qp.pitia_cents), formula_version: qp.formula_version }, at, actor);
}

// ============================================================ R1 — DTI arithmetic (B3-6-02)
export const DU_MAX_DTI_BPS = 5000;
export const B3_2_10_DTI_LINE_BPS = 4500;
export const B3_2_10_DTI_INCREASE_BPS = 300;
export type DtiStage = "application" | `du_submission_${number}` | "decision_of_record" | "pre_cd" | `cd_v${number}` | "final";
/** `dti_bps = round_half_up(obligations × 10000 / income)` — 455,999 / 1,200,000 → 3,800 (38.00 %). */
export function dtiBps(obligations_cents: Cents, income_cents: Cents): number {
  if (income_cents <= 0n) throw new RangeError("income_cents must be positive");
  nonNeg(obligations_cents, "obligations_cents");
  return Number(divRound(obligations_cents * 10_000n, income_cents, "HALF_UP"));
}
/** Two decimals from bps: 3800 → "38.00", 4544 → "45.44". */
export const dtiDisplayPct = (bps: number): string => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
export interface DtiInput { readonly application_id: string; readonly version: number; readonly stage: DtiStage; readonly qualifying_income_cents: Cents; readonly income_snapshot_id?: string | null; readonly qp: Pick<QualifyingPayment, "qp_id" | "pitia_cents">; readonly other_reo_cents?: Cents; readonly liabilities: readonly Liability[]; readonly b3_2_10_check_id?: string | null; readonly du_submission_id?: string | null; readonly scheduled_note_date?: PlainDate | null; readonly remaining_months_recomputed?: boolean; readonly dti_id?: string; readonly agent_run_id?: string | null; }
export interface DtiCalculation { readonly dti_id: string; readonly application_id: string; readonly version: number; readonly stage: DtiStage; readonly income_snapshot_id: string | null; readonly qualifying_income_cents: Cents; readonly income_reductions_cents: Cents; readonly income_cents: Cents; readonly qp_id: string; readonly pitia_cents: Cents; readonly other_reo_cents: Cents; readonly liabilities_cents: Cents; readonly obligations_cents: Cents; readonly liability_ids: readonly string[]; readonly dti_bps: number; readonly dti_tenths: number; readonly dti_display_pct: string; readonly du_cap_ok: boolean; readonly b3_2_10_check_id: string | null; readonly du_submission_id: string | null; readonly scheduled_note_date: PlainDate | null; readonly remaining_months_recomputed: boolean; readonly hmda_reported: boolean; readonly formula_version: string; readonly agent_run_id: string | null; }
/** R1: obligations = subject PITIA + other REO + Σ included qualifying payments; income = qualifying income − elected alimony-type reductions. */
export function computeDti(i: DtiInput): DtiCalculation {
  nonEmpty(i.application_id, "application_id"); if (i.qualifying_income_cents <= 0n) throw new RangeError("qualifying_income_cents must be positive (22.3 income.finalized)");
  const included = i.liabilities.filter((l) => l.include_in_dti);
  const income_reductions_cents = i.liabilities.filter((l) => l.income_reduction_elected).reduce((a, l) => a + l.qualifying_payment_cents, 0n);
  const income_cents = i.qualifying_income_cents - income_reductions_cents;
  if (income_cents <= 0n) throw new RangeError("income reductions exhaust the qualifying income");
  const liabilities_cents = included.reduce((a, l) => a + l.qualifying_payment_cents, 0n);
  const other_reo_cents = i.other_reo_cents ?? 0n;
  const obligations_cents = i.qp.pitia_cents + other_reo_cents + liabilities_cents;
  const dti_bps = dtiBps(obligations_cents, income_cents);
  return { dti_id: i.dti_id ?? randomUUID(), application_id: i.application_id, version: i.version, stage: i.stage, income_snapshot_id: i.income_snapshot_id ?? null, qualifying_income_cents: i.qualifying_income_cents, income_reductions_cents, income_cents, qp_id: i.qp.qp_id, pitia_cents: i.qp.pitia_cents, other_reo_cents, liabilities_cents, obligations_cents,
    liability_ids: included.map((l) => l.liability_id).sort(), dti_bps, dti_tenths: dtiTenths(obligations_cents, income_cents), dti_display_pct: dtiDisplayPct(dti_bps), du_cap_ok: dti_bps <= DU_MAX_DTI_BPS, b3_2_10_check_id: i.b3_2_10_check_id ?? null, du_submission_id: i.du_submission_id ?? null, scheduled_note_date: i.scheduled_note_date ?? null, remaining_months_recomputed: i.remaining_months_recomputed === true, hmda_reported: false, formula_version: FORMULAS.dti, agent_run_id: i.agent_run_id ?? null };
}
/** `dti.computed{version, dti_bps, stage, du_cap_ok, checked_against_du, remaining_months_recomputed}` — the immutable version row's event. */
export function recordDti(events: EventStore, c: DtiCalculation, at: string, actor: Actor = AGENT): DomainEvent {
  return emit(events, c.application_id, "dti.computed", { dti_id: c.dti_id, version: c.version, stage: c.stage, dti_bps: c.dti_bps, dti_tenths: c.dti_tenths, dti_display_pct: c.dti_display_pct, du_cap_ok: c.du_cap_ok, obligations_cents: String(c.obligations_cents), income_cents: String(c.income_cents), qp_id: c.qp_id, liability_ids: [...c.liability_ids],
    checked_against_du: c.du_submission_id !== null || c.b3_2_10_check_id !== null, du_submission_id: c.du_submission_id, b3_2_10_check_id: c.b3_2_10_check_id, remaining_months_recomputed: c.remaining_months_recomputed, scheduled_note_date: c.scheduled_note_date, formula_version: c.formula_version }, at, actor);
}
/** FNMA_B3_6_02_DU_DTI_50_GATE: `dti_bps ≤ 5000` on the version (B3-6-02 "the maximum allowable DTI ratio is 50%"). */
export function duCapGate(f: Record<string, unknown>): GateResult {
  const bps = Number(f.dti_bps ?? NaN);
  if (!Number.isFinite(bps)) return { open: false, reason: "dti_bps is required" };
  return bps <= DU_MAX_DTI_BPS ? { open: true } : { open: false, reason: `dti ${dtiDisplayPct(bps)}% exceeds DU's 50.00% ceiling (B3-6-02) → 23.2 restructure loop / underwriting_reviewer counteroffer` };
}
export interface DuCapCheck { readonly du_cap_ok: boolean; readonly dti_bps: number; readonly cap_bps: number; readonly gate: GateResult; readonly event: DomainEvent | null; readonly hand_off: string | null; readonly escalate: "underwriting_reviewer" | null; }
/** Above 50.00 % → `dti.du_cap.exceeded` for 23.2's restructure loop and the `underwriting_reviewer` (counteroffer/denial/NOIA via 21.6). */
export function checkDuCap(events: EventStore, c: DtiCalculation, at: string, actor: Actor = AGENT): DuCapCheck {
  const gate = duCapGate({ dti_bps: c.dti_bps });
  if (gate.open) return { du_cap_ok: true, dti_bps: c.dti_bps, cap_bps: DU_MAX_DTI_BPS, gate, event: null, hand_off: null, escalate: null };
  const event = emit(events, c.application_id, "dti.du_cap.exceeded", { dti_id: c.dti_id, version: c.version, stage: c.stage, dti_bps: c.dti_bps, dti_display_pct: c.dti_display_pct, cap_bps: DU_MAX_DTI_BPS, hand_off: "23.2 restructure loop (ineligible_change in 23.1); counteroffer/denial via underwriting_reviewer (21.6)", consumers: ["23.2", "23.1", "21.6"] }, at, actor);
  return { du_cap_ok: false, dti_bps: c.dti_bps, cap_bps: DU_MAX_DTI_BPS, gate, event, hand_off: "23.2", escalate: "underwriting_reviewer" };
}

// ============================================================ B3-2-10 tolerance (23.1's rule; 22.2's calculators) → liabilities.changed
export type ToleranceOutcome = "resubmission_required" | "within_tolerance";
export interface ToleranceResult { readonly rule_code: "B3_2_10_DTI_45_OR_3PT"; readonly dti_before_bps: number; readonly dti_after_bps: number; readonly delta_bps: number; readonly exceeds_45: boolean; readonly increase_3_points: boolean; readonly result: ToleranceOutcome; readonly check_23_1: ToleranceCheck; readonly citation: "B3-2-10"; }
/** Resubmit when the recalculated DTI exceeds 45.00 % or rises 3 or more points (in bps); 23.1's tenths-based check (22.2 `b3210ToleranceCheck`) must agree. */
export function toleranceResult(before: DtiCalculation, after: DtiCalculation): ToleranceResult {
  const delta_bps = after.dti_bps - before.dti_bps;
  const exceeds_45 = after.dti_bps > B3_2_10_DTI_LINE_BPS, increase_3_points = delta_bps >= B3_2_10_DTI_INCREASE_BPS;
  const check_23_1 = b3210ToleranceCheck(dtiTenths(before.obligations_cents, before.income_cents), dtiTenths(after.obligations_cents, after.income_cents));
  const result: ToleranceOutcome = exceeds_45 || increase_3_points ? "resubmission_required" : "within_tolerance";
  if ((check_23_1.result === "resubmission required") !== (result === "resubmission_required")) throw new RangeError(`22.5 bps tolerance (${result}) disagrees with 23.1's tenths check (${check_23_1.result}) — formula versions out of step`);
  return { rule_code: "B3_2_10_DTI_45_OR_3PT", dti_before_bps: before.dti_bps, dti_after_bps: after.dti_bps, delta_bps, exceeds_45, increase_3_points, result, check_23_1, citation: "B3-2-10" };
}
/** `liabilities.changed{dti_before, dti_after, …, tolerance_result}` hands 23.1 the tolerance decision (its `du_resubmission_checks` row); a required resubmission arms SM_DU_RESUBMIT_SLA_1BD (+1 business_days_creditor). */
export function notifyTolerance(events: EventStore, before: DtiCalculation, after: DtiCalculation, i: { at: string; trigger: string; liability_id?: string | null }, actor: Actor = AGENT): { tolerance: ToleranceResult; event: DomainEvent } {
  if (before.application_id !== after.application_id) throw new RangeError("before/after versions belong to different applications");
  const tolerance = toleranceResult(before, after);
  const event = emit(events, after.application_id, "liabilities.changed", { trigger: i.trigger, liability_id: i.liability_id ?? null, dti_before: before.dti_display_pct, dti_after: after.dti_display_pct, dti_before_bps: before.dti_bps, dti_after_bps: after.dti_bps, delta_bps: tolerance.delta_bps, dti_before_tenths: tolerance.check_23_1.previous_dti_tenths, dti_after_tenths: tolerance.check_23_1.new_dti_tenths,
    tolerance_result: tolerance.result, rule_code: tolerance.rule_code, exceeds_45: tolerance.exceeds_45, increase_3_points: tolerance.increase_3_points, dti_version_before: before.version, dti_version_after: after.version, liability_ids_before: [...before.liability_ids], liability_ids_after: [...after.liability_ids], tolerance_check_for: "23.1", changed_at: i.at }, i.at, actor);
  return { tolerance, event };
}

// ============================================================ alimony election (B3-6-05) — never for child support
export interface AlimonyTreatments { readonly as_liability: { obligations_cents: Cents; income_cents: Cents; dti_bps: number }; readonly income_reduction: { obligations_cents: Cents; income_cents: Cents; dti_bps: number }; readonly recommended: "income_reduction" | "as_liability"; readonly permitted: boolean; readonly citation: "B3-6-05"; }
/** Both computations (Q2: the lower DTI is recommended and both are recorded); `permitted = false` for child support / garnishments. */
export function alimonyTreatments(l: Pick<Liability, "liability_type" | "qualifying_payment_cents">, base: { obligations_without_cents: Cents; income_cents: Cents }): AlimonyTreatments {
  const p = l.qualifying_payment_cents;
  const as_liability = { obligations_cents: base.obligations_without_cents + p, income_cents: base.income_cents, dti_bps: dtiBps(base.obligations_without_cents + p, base.income_cents) };
  const income_reduction = { obligations_cents: base.obligations_without_cents, income_cents: base.income_cents - p, dti_bps: dtiBps(base.obligations_without_cents, base.income_cents - p) };
  const permitted = INCOME_REDUCTION_TYPES.includes(l.liability_type);
  return { as_liability, income_reduction, recommended: permitted && income_reduction.dti_bps < as_liability.dti_bps ? "income_reduction" : "as_liability", permitted, citation: "B3-6-05" };
}
/** The election: alimony / equalization / separate maintenance may reduce income in lieu of the debt; child support has no such option (refused). */
export function electIncomeReduction(events: EventStore, l: Liability, elect: boolean, i: { at: string; legal_agreement_document_id: string | null; rationale: string }, actor: Actor = AGENT): { liability: Liability; event: DomainEvent | null } {
  if (elect && !INCOME_REDUCTION_TYPES.includes(l.liability_type)) throw new LiabilityRefused("ALIMONY_ELECTION_NOT_FOR_CHILD_SUPPORT", "B3-6-05 (the income-reduction option covers alimony, equalization payments and separate maintenance — not child support)", `${l.liability_type} cannot reduce qualifying income; it stays a monthly debt obligation`);
  if (elect && !i.legal_agreement_document_id) throw new LiabilityRefused("NO_EXCLUSION_WITHOUT_EVIDENCE", "B3-6-05 (decree / separation agreement / court order confirming the amount)", "the income-reduction election needs the legal agreement in the file");
  if (!elect) return { liability: { ...l, income_reduction_elected: false, include_in_dti: true, exclusion_reason: null, status: "included" }, event: null };
  const liability: Liability = { ...l, income_reduction_elected: true, include_in_dti: false, exclusion_reason: "income_reduction_elected", exclusion_evidence_document_ids: [i.legal_agreement_document_id!], status: "excluded" };
  const event = emit(events, l.application_id, "liability.excluded", { liability_id: l.liability_id, liability_type: l.liability_type, reason: "income_reduction_elected", qualifying_payment_cents: String(l.qualifying_payment_cents), evidence_document_ids: [i.legal_agreement_document_id], rationale: i.rationale, du_submitted_as: "income reduced, not the liability" }, i.at, actor);
  return { liability, event };
}

// ============================================================ R4 — remaining months and the ≤ 10-payment rule (B3-6-05)
export const TEN_MONTHS = 10;
export const SIGNIFICANTLY_AFFECTS_PAYMENT_PCT = 15;
export const SIGNIFICANTLY_AFFECTS_UTILIZATION_PCT = 80;
const monthIndex = (d: PlainDate): number => { const p = parts(d); return p.y * 12 + (p.m - 1); };
/** Monthly payments due after the note date through the order's last payment month: note Wed Nov 18, 2026, order ending Aug 2027 → Dec 2026 … Aug 2027 = 9. */
export function paymentsRemaining(note_date: PlainDate, last_payment_month: PlainDate): number { return Math.max(0, monthIndex(last_payment_month) - monthIndex(note_date)); }
/** `remaining_months = creditor-stated remaining payments`, else `ceil(balance / payment)`; a documented end date counts payments after the note date. */
export function remainingMonths(l: Pick<Liability, "remaining_months" | "balance_cents" | "qualifying_payment_cents">, opts: { note_date?: PlainDate | null; last_payment_month?: PlainDate | null } = {}): number | null {
  if (opts.note_date && opts.last_payment_month) return paymentsRemaining(opts.note_date, opts.last_payment_month);
  if (l.remaining_months !== null && l.remaining_months !== undefined) return l.remaining_months;
  if (l.qualifying_payment_cents > 0n) return Number(divRound(l.balance_cents, l.qualifying_payment_cents, "CEIL"));
  return null;
}
/** Q4 policy: payment > 15 % of qualifying income or revolving utilization > 80 %. */
export function significantlyAffects(i: { payment_cents: Cents; qualifying_income_cents: Cents; revolving_utilization_pct?: number | null }): boolean {
  if (i.qualifying_income_cents <= 0n) throw new RangeError("qualifying_income_cents must be positive");
  return i.payment_cents * 100n > BigInt(SIGNIFICANTLY_AFFECTS_PAYMENT_PCT) * i.qualifying_income_cents || (i.revolving_utilization_pct ?? 0) > SIGNIFICANTLY_AFFECTS_UTILIZATION_PCT;
}
export interface TenMonthResult { readonly applies: boolean; readonly remaining_months: number | null; readonly include: boolean; readonly exclusion_reason: "le_10_payments" | null; readonly why: string; readonly citation: "B3-6-05"; }
/** "more than ten monthly payments remaining" → included; ≤ 10 → excluded unless it "significantly affects the borrower's ability to meet their credit obligations". */
export function tenMonthRule(l: Pick<Liability, "liability_type" | "significantly_affects">, remaining: number | null): TenMonthResult {
  if (!TEN_MONTH_RULE_TYPES.includes(l.liability_type)) return { applies: false, remaining_months: remaining, include: true, exclusion_reason: null, why: `${l.liability_type}: the ten-month rule does not apply`, citation: "B3-6-05" };
  if (remaining === null) return { applies: true, remaining_months: null, include: true, exclusion_reason: null, why: "remaining payments unknown → included until a creditor statement is obtained", citation: "B3-6-05" };
  if (remaining > TEN_MONTHS) return { applies: true, remaining_months: remaining, include: true, exclusion_reason: null, why: `${remaining} payments remaining > 10 → included`, citation: "B3-6-05" };
  if (l.significantly_affects) return { applies: true, remaining_months: remaining, include: true, exclusion_reason: null, why: `${remaining} payments remaining ≤ 10 but the debt significantly affects the borrower's ability to meet credit obligations → included`, citation: "B3-6-05" };
  return { applies: true, remaining_months: remaining, include: false, exclusion_reason: "le_10_payments", why: `${remaining} payments remaining ≤ 10 and not significant → excluded`, citation: "B3-6-05" };
}
/** FNMA_B3_6_05_10MO_REMAINING_RULE (gate): every ten-month-type liability's inclusion agrees with the rule recomputed as of the scheduled note date. */
export function tenMonthRemainingRule(f: Record<string, unknown>): GateResult {
  const note = typeof f.scheduled_note_date === "string" ? f.scheduled_note_date : null;
  const asOf = typeof f.recomputed_as_of === "string" ? f.recomputed_as_of : null;
  if (!note) return { open: false, reason: "scheduled_note_date is required (closing.scheduled)" };
  if (asOf !== note) return { open: false, reason: `remaining_months last recomputed as of ${asOf ?? "never"}, scheduled note date is ${note} → recompute (a closing move re-counts every ≤ 10-payment exclusion)` };
  const rows = Array.isArray(f.liabilities) ? (f.liabilities as { liability_type: LiabilityType; remaining_months: number | null; include_in_dti: boolean; significantly_affects?: boolean }[]) : [];
  const wrong = rows.filter((r) => { const t = tenMonthRule({ liability_type: r.liability_type, significantly_affects: r.significantly_affects === true }, r.remaining_months); return t.applies && t.include !== r.include_in_dti; });
  return wrong.length ? { open: false, reason: `${wrong.length} liabilit${wrong.length === 1 ? "y" : "ies"} disagree with the ten-month rule as of ${note} → liabilities.changed` } : { open: true };
}

// ============================================================ exclusions with the Guide-named evidence (B3-6-05)
export interface ExclusionEvidence {
  readonly evidence_document_ids?: readonly string[]; readonly canceled_checks_months?: number; readonly payer_delinquencies_12m?: number; readonly company_checks_months?: number; readonly cash_flow_deducted?: boolean;
  readonly loan_instrument_document_id?: string | null; readonly court_order_document_id?: string | null; readonly executed_sales_contract_document_id?: string | null; readonly contingencies_cleared?: boolean; readonly settlement_statement_document_id?: string | null;
  readonly remaining_months?: number | null; readonly note_date?: PlainDate | null; readonly last_payment_month?: PlainDate | null; readonly qualifying_income_cents?: Cents | null; readonly revolving_utilization_pct?: number | null; readonly deferred_5y_or_more?: boolean; readonly rental_offset_income_id?: string | null;
}
export interface ExclusionResult { readonly liability: Liability; readonly include_in_dti: boolean; readonly exclusion_reason: ExclusionReason | null; readonly why: string; readonly funds_to_verify_delta_cents: Cents; readonly citation: string; }
export const EVIDENCE_FOR: Partial<Record<ExclusionReason, string>> = {
  paid_by_other_12m: "the most recent 12 months' canceled checks (or bank statements) from the other party with no delinquent payments",
  business_paid_12m_cashflow: "12 months of canceled company checks, no delinquency, and 22.3's cash-flow analysis taking the payment into consideration",
  secured_by_financial_asset: "a copy of the loan instrument showing the borrower's financial asset as collateral",
  court_assigned_contingent: "the court order assigning the debt to the other party (the creditor did not release the borrower)",
  non_applicant_documented: "supporting documentation that the debt does not belong to the borrower",
  voluntary_payment: "documentation that no written legal agreement requires the payment",
  sold_before_closing: "the settlement statement for the sale of the current residence",
  pending_sale_contract_cleared: "the executed sales contract for the current residence and confirmation that financing contingencies have been cleared",
  rental_offset: "22.3's B3-3.8 rental analysis for the property",
};
const docs = (ev: ExclusionEvidence): string[] => [...(ev.evidence_document_ids ?? []), ...[ev.loan_instrument_document_id, ev.court_order_document_id, ev.executed_sales_contract_document_id, ev.settlement_statement_document_id].filter((x): x is string => typeof x === "string" && x !== "")];
const refuse = (reason: ExclusionReason, detail: string): never => { throw new LiabilityRefused("NO_EXCLUSION_WITHOUT_EVIDENCE", `B3-6-05 (${EVIDENCE_FOR[reason] ?? reason})`, `cannot exclude as ${reason}: ${detail}`); };
/** Decides inclusion / exclusion for one liability. Throws NO_EXCLUSION_WITHOUT_EVIDENCE when the Guide-named evidence is absent; returns `include_in_dti = true` when the evidence exists but disqualifies (a 30-day late, a cash-flow analysis that did not deduct the payment). */
export function evaluateExclusion(l: Liability, reason: ExclusionReason, ev: ExclusionEvidence = {}): ExclusionResult {
  const ids = docs(ev);
  const excluded = (why: string, funds_to_verify_delta_cents: Cents = 0n, citation = "B3-6-05"): ExclusionResult => ({ liability: { ...l, include_in_dti: false, exclusion_reason: reason, exclusion_evidence_document_ids: ids, status: "excluded" }, include_in_dti: false, exclusion_reason: reason, why, funds_to_verify_delta_cents, citation });
  const included = (why: string, citation = "B3-6-05"): ExclusionResult => ({ liability: { ...l, include_in_dti: true, exclusion_reason: null, exclusion_evidence_document_ids: ids, status: "included" }, include_in_dti: true, exclusion_reason: null, why, funds_to_verify_delta_cents: 0n, citation });
  switch (reason) {
    case "le_10_payments": {
      const remaining = ev.remaining_months ?? remainingMonths(l, { note_date: ev.note_date ?? null, last_payment_month: ev.last_payment_month ?? null });
      const sig = l.significantly_affects || (ev.qualifying_income_cents ? significantlyAffects({ payment_cents: l.qualifying_payment_cents, qualifying_income_cents: ev.qualifying_income_cents, revolving_utilization_pct: ev.revolving_utilization_pct ?? null }) : false);
      const t = tenMonthRule({ liability_type: l.liability_type, significantly_affects: sig }, remaining);
      const base: Liability = { ...l, remaining_months: remaining, significantly_affects: sig };
      return t.include ? { ...included(t.why), liability: { ...base, include_in_dti: true, exclusion_reason: null, status: "included" } } : { ...excluded(t.why), liability: { ...base, include_in_dti: false, exclusion_reason: "le_10_payments", status: "excluded" } };
    }
    case "paid_by_other_12m": {
      if (!ids.length || (ev.canceled_checks_months ?? 0) < 12) return refuse(reason, `${ev.canceled_checks_months ?? 0} months of the other party's canceled checks / statements on file (12 required)`);
      return (ev.payer_delinquencies_12m ?? 0) > 0 ? included(`${ev.payer_delinquencies_12m} delinquent payment(s) in the 12-month history → not excludable`) : excluded("12-month third-party payment history with no delinquent payments");
    }
    case "business_paid_12m_cashflow": {
      if (!ids.length || (ev.company_checks_months ?? 0) < 12) return refuse(reason, `${ev.company_checks_months ?? 0} months of canceled company checks on file (12 required)`);
      if ((ev.payer_delinquencies_12m ?? 0) > 0) return included("the account has a delinquency → the personal-name business debt stays in DTI");
      return ev.cash_flow_deducted ? excluded("12 months' company checks, no delinquency, and 22.3's cash-flow analysis took the payment into consideration") : included("22.3's cash-flow analysis did not deduct the payment → included (B3-6-05: the analysis must take the obligation into consideration)");
    }
    case "secured_by_financial_asset": return ev.loan_instrument_document_id ? excluded("loan secured by the borrower's financial asset per the loan instrument") : refuse(reason, "no loan instrument on file");
    case "court_assigned_contingent": return ev.court_order_document_id ? excluded("contingent liability under a court-ordered assignment; the borrower is not required to count it") : refuse(reason, "no court order on file");
    case "non_applicant_documented": return ids.length ? excluded("documented as not the borrower's debt (non-applicant account)") : refuse(reason, "no documentation that the debt is not the borrower's");
    case "voluntary_payment": return ids.length ? excluded("voluntary payment with no written legal agreement") : refuse(reason, "no documentation that the payment is voluntary");
    case "heloc_no_payment": return l.liability_type === "heloc" && l.qualifying_payment_cents === 0n ? excluded("the HELOC requires no payment: no equivalent payment is developed") : included("the HELOC requires a payment → included");
    case "community_second_deferred_5y": return ev.deferred_5y_or_more ? excluded("Community Seconds repayment deferred five years or more", 0n, "B5-5.1-02") : included("deferral shorter than five years → the scheduled payment is included", "B5-5.1-02");
    case "open_30_day": return l.liability_type === "open_30_day" ? excluded(`open 30-day account: balance ${formatCents(l.balance_cents)} added to funds to verify (22.4) unless paid off with proof`, l.balance_cents, "B3-6-05/-07") : included("not an open 30-day account");
    case "sold_before_closing": return ev.settlement_statement_document_id ? excluded("current residence sold before closing per the settlement statement", 0n, "B3-6-06") : refuse(reason, "no settlement statement for the sale");
    case "pending_sale_contract_cleared": return ev.executed_sales_contract_document_id && ev.contingencies_cleared ? excluded("executed sales contract with financing contingencies cleared in writing", 0n, "B3-6-06") : refuse(reason, ev.executed_sales_contract_document_id ? "financing contingencies not confirmed cleared → both PITIAs count" : "no executed sales contract");
    case "rental_offset": return ev.rental_offset_income_id ? excluded("net rental treatment per 22.3 (B3-3.8) carries this property", 0n, "B3-6-06") : refuse(reason, "no 22.3 rental analysis");
    case "income_reduction_elected": throw new LiabilityRefused("USE_ELECT_INCOME_REDUCTION", "B3-6-05", "the alimony income-reduction election is recorded through electIncomeReduction");
    case "paid_off_at_closing": case "paid_down_le_10": throw new LiabilityRefused("USE_PLAN_PAYOFF", "B3-6-07", "payoff / paydown exclusions are recorded through planPayoff");
  }
}
export function recordExclusion(events: EventStore, r: ExclusionResult, at: string, actor: Actor = AGENT): DomainEvent {
  const l = r.liability;
  return r.include_in_dti
    ? emit(events, l.application_id, "liability.included", { liability_id: l.liability_id, liability_type: l.liability_type, payment_basis: l.payment_basis, qualifying_payment_cents: String(l.qualifying_payment_cents), why: r.why, citation: r.citation }, at, actor)
    : emit(events, l.application_id, "liability.excluded", { liability_id: l.liability_id, liability_type: l.liability_type, reason: r.exclusion_reason, qualifying_payment_cents: String(l.qualifying_payment_cents), evidence_document_ids: [...l.exclusion_evidence_document_ids], why: r.why, funds_to_verify_delta_cents: String(r.funds_to_verify_delta_cents), citation: r.citation }, at, actor);
}
/** The IRS-agreement liability is `included{payment_basis=irs_agreement}` (satisfies FNMA_B3_6_05_IRS_AGREEMENT_GATE) unless paid in full; a Notice of Federal Tax Lien in the subject county routes to 24.4 first. */
export function includeLiability(events: EventStore, l: Liability, at: string, actor: Actor = AGENT, why = "included as a recurring monthly debt obligation"): { liability: Liability; event: DomainEvent } {
  if (l.liability_type === "irs_installment" && l.tax_lien_indicated) throw new LiabilityRefused("TAX_LIEN_ROUTES_TO_24_4", "B3-6-05 / SEL-2026-05 (no indication that a Notice of Federal Tax Lien has been filed in the county in which the subject property is located)", "a filed lien → 24.4 payoff/subordination; the payment stays in DTI if not paid in full but the liability cannot finalize");
  const liability: Liability = { ...l, include_in_dti: true, exclusion_reason: null, status: "included" };
  const event = emit(events, l.application_id, "liability.included", { liability_id: l.liability_id, liability_type: l.liability_type, payment_basis: l.payment_basis, qualifying_payment_cents: String(l.qualifying_payment_cents), why, citation: "B3-6-05" }, at, actor);
  return { liability, event };
}

// ============================================================ gates over legal documents and IRS agreements
/** FNMA_B3_6_05_LEGAL_DOC_GATE: decree / separation agreement / court order in the file confirming the amount. */
export function legalDocGate(f: Record<string, unknown>): GateResult {
  const type = String(f.liability_type ?? "");
  if (!LEGAL_AGREEMENT_TYPES.includes(type as LiabilityType) && type !== "garnishment") return { open: true };
  const doc = typeof f.legal_agreement_document_id === "string" && f.legal_agreement_document_id;
  if (!doc) return { open: false, reason: `${type}: no divorce decree / separation agreement / court order in the file (B3-6-05) → blocks liabilities.finalized` };
  return f.amount_confirmed === true ? { open: true } : { open: false, reason: `${type}: the document does not confirm the obligation amount` };
}
/** FNMA_B3_6_05_IRS_AGREEMENT_GATE: approved agreement + evidence of current payments (or the pending application); no lien indicated in the subject county; payment included unless paid in full. */
export function irsAgreementGate(f: Record<string, unknown>): GateResult {
  if (f.tax_lien_indicated === true) return { open: false, reason: "a Notice of Federal Tax Lien is indicated in the subject property's county → 24.4 lien payoff/subordination path; the loan cannot finalize until the lien is paid or subordinated (B3-6-05, SEL-2026-05)" };
  const status = String(f.agreement_status ?? "");
  const doc = typeof f.agreement_document_id === "string" && f.agreement_document_id !== "";
  if (status === "approved") { if (!doc) return { open: false, reason: "copy of the approved IRS installment agreement (terms, monthly payment, total due) required" }; if (!(typeof f.payment_evidence_document_id === "string" && f.payment_evidence_document_id)) return { open: false, reason: "evidence the borrower is current on the installment plan required" }; }
  else if (status === "pending") { if (!doc) return { open: false, reason: "copy of the application for the installment agreement (terms, monthly payment, total due) required" }; }
  else return { open: false, reason: "agreement_status must be approved or pending" };
  if (f.paid_in_full === true) return { open: true };
  return f.include_in_dti === true && f.payment_basis === "irs_agreement" ? { open: true } : { open: false, reason: "the monthly payment must be included in DTI with payment_basis = irs_agreement unless the amount owed is paid in full" };
}

// ============================================================ R5 / B3-6-07 — debts paid off or paid down at or before closing
export type PayoffMode = "pay_off_before_closing" | "pay_off_at_closing" | "pay_down_to_le_10" | "pay_down_revolving";
export type PayoffEvidence = "payoff_statement_before_closing" | "settlement_statement_line" | "creditor_letter_remaining_payments" | "zero_balance_statement";
export type PayoffStatus = "proposed" | "approved" | "evidenced" | "failed";
export interface DebtPayoffPlan { readonly plan_id: string; readonly application_id: string; readonly liability_id: string; readonly mode: PayoffMode; readonly amount_cents: Cents; readonly funds_source_asset_id: string | null; readonly funds_verified_in_addition: boolean; readonly evidence: PayoffEvidence | null; readonly evidence_document_id: string | null; readonly reviewer_required: boolean; readonly status: PayoffStatus; readonly scheduled_note_date: PlainDate | null; readonly rationale: string; readonly formula_version: string; }
export const Q1_EXCLUDED_PAYMENTS_INCOME_PCT = 10;
export const Q1_PAYOFF_LIQUID_PCT = 50;
/** `target_balance = 10 × payment`; `paydown = balance − target` (the creditor's payoff letter governs interest accrual). */
export const paydownTarget = (payment_cents: Cents): Cents => BigInt(TEN_MONTHS) * nonNeg(payment_cents, "payment_cents");
export function payoffAmount(l: Pick<Liability, "liability_type" | "balance_cents" | "qualifying_payment_cents">, mode: PayoffMode): Cents {
  if (mode === "pay_down_to_le_10") { if (l.liability_type !== "installment") throw new RangeError("pay_down_to_le_10 applies to installment loans"); const t = paydownTarget(l.qualifying_payment_cents); return l.balance_cents > t ? l.balance_cents - t : 0n; }
  return l.balance_cents;
}
/** Q1: `underwriting_reviewer` when the excluded payments exceed 10 % of qualifying income or the payoff consumes more than 50 % of verified liquid assets after closing. */
export function reviewerRequired(i: { excluded_payments_cents: Cents; qualifying_income_cents: Cents; payoff_cents: Cents; post_closing_liquid_cents?: Cents | null }): boolean {
  if (i.qualifying_income_cents <= 0n) throw new RangeError("qualifying_income_cents must be positive");
  const byIncome = i.excluded_payments_cents * 100n > BigInt(Q1_EXCLUDED_PAYMENTS_INCOME_PCT) * i.qualifying_income_cents;
  const byLiquid = i.post_closing_liquid_cents !== null && i.post_closing_liquid_cents !== undefined && i.payoff_cents * 100n > BigInt(Q1_PAYOFF_LIQUID_PCT) * i.post_closing_liquid_cents;
  return byIncome || byLiquid;
}
export interface PlanPayoffInput { readonly mode: PayoffMode; readonly funds_source_asset_id?: string | null; readonly funds_verified_in_addition: boolean; readonly scheduled_note_date: PlainDate | null; readonly qualifying_income_cents: Cents; readonly post_closing_liquid_cents?: Cents | null; readonly excluded_payments_cents?: Cents | null; readonly credit_use_rationale: string; readonly at: string; readonly plan_id?: string; }
export interface PlanPayoffResult { readonly plan: DebtPayoffPlan; readonly liability: Liability; readonly funds_to_verify_delta_cents: Cents; readonly account_closure_condition: null; readonly reviewer_required: boolean; readonly event: DomainEvent; }
/** B3-6-07: a revolving balance paid off at/before closing drops its payment (no closure required); an installment paid down to ≤ 10 payments drops out; the funds are verified in addition to closing costs and reserves (22.4 `funds_to_verify += payoff`). */
export function planPayoff(events: EventStore, l: Liability, i: PlanPayoffInput, actor: Actor = AGENT): PlanPayoffResult {
  nonEmpty(i.credit_use_rationale, "credit_use_rationale (B3-6-07 'carefully evaluated' — the borrower's history of credit use)");
  if (i.mode === "pay_down_revolving" && l.liability_type !== "revolving") throw new RangeError("pay_down_revolving applies to revolving accounts");
  const amount_cents = payoffAmount(l, i.mode);
  if (amount_cents <= 0n) throw new RangeError("nothing to pay: the balance is already at or below the target");
  if (!i.funds_verified_in_addition) throw new LiabilityRefused("PAYOFF_FUNDS_NOT_IN_ADDITION", "B3-6-07 (verified funds must be in addition to any funds required for closing costs and reserves)", `${formatCents(amount_cents)} must be verified over and above 22.4's cash to close and reserves before the payment is excluded`);
  const reason: ExclusionReason = i.mode === "pay_down_to_le_10" ? "paid_down_le_10" : "paid_off_at_closing";
  const reviewer_required = reviewerRequired({ excluded_payments_cents: (i.excluded_payments_cents ?? 0n) + l.qualifying_payment_cents, qualifying_income_cents: i.qualifying_income_cents, payoff_cents: amount_cents, post_closing_liquid_cents: i.post_closing_liquid_cents ?? null });
  const plan: DebtPayoffPlan = { plan_id: i.plan_id ?? randomUUID(), application_id: l.application_id, liability_id: l.liability_id, mode: i.mode, amount_cents, funds_source_asset_id: i.funds_source_asset_id ?? null, funds_verified_in_addition: true, evidence: null, evidence_document_id: null, reviewer_required, status: reviewer_required ? "proposed" : "approved", scheduled_note_date: i.scheduled_note_date, rationale: i.credit_use_rationale, formula_version: FORMULAS.payoff };
  const liability: Liability = { ...l, include_in_dti: false, exclusion_reason: reason, paid_at_closing: true, payoff_amount_cents: amount_cents, payoff_source_asset_id: plan.funds_source_asset_id, status: "payoff_planned" };
  const event = emit(events, l.application_id, "debt_payoff.planned", { plan_id: plan.plan_id, liability_id: l.liability_id, liability_type: l.liability_type, mode: i.mode, exclusion_reason: reason, payoff_amount_cents: String(amount_cents), excluded_payment_cents: String(l.qualifying_payment_cents), funds_to_verify_delta_cents: String(amount_cents), funds_verified_in_addition: true, funds_source_asset_id: plan.funds_source_asset_id, scheduled_note_date: i.scheduled_note_date, reviewer_required, account_closure_required: false, consumers: ["22.4 funds_to_verify", "26.3 settlement statement"], citation: "B3-6-07" }, i.at, actor);
  return { plan, liability, funds_to_verify_delta_cents: amount_cents, account_closure_condition: null, reviewer_required, event };
}
export interface PayoffEvidenceInput { readonly settlement_statement_document_id?: string | null; readonly settlement_statement_shows_payoff?: boolean; readonly payoff_statement_document_id?: string | null; readonly zero_balance_document_id?: string | null; readonly creditor_letter_document_id?: string | null; readonly verified_funds_in_addition_cents?: Cents | null; readonly at: string; }
export interface EvidencePayoffResult { readonly plan: DebtPayoffPlan; readonly liability: Liability; readonly gate: GateResult; readonly event: DomainEvent; readonly re_included: boolean; readonly blocks: "funding.authorized" | null; }
/** FNMA_B3_6_07_PAYOFF_FUNDS_GATE facts for one plan (or a list under `plans`): funds ≥ payoff in addition, and at closing the settlement-statement line or a pre-closing payoff statement / zero-balance evidence. */
export function payoffFundsGate(f: Record<string, unknown>): GateResult {
  const plans = Array.isArray(f.plans) ? (f.plans as Record<string, unknown>[]) : [f];
  for (const p of plans) {
    const amount = BigInt(String(p.payoff_amount_cents ?? p.amount_cents ?? "0"));
    const funds = p.verified_funds_in_addition_cents === undefined || p.verified_funds_in_addition_cents === null ? null : BigInt(String(p.verified_funds_in_addition_cents));
    if (p.funds_verified_in_addition !== true && (funds === null || funds < amount)) return { open: false, reason: `verified funds in addition to cash to close and reserves (${funds === null ? "none" : formatCents(funds)}) < payoff ${formatCents(amount)} (B3-6-07) → liability re-included, DTI recomputed` };
    const evidenced = p.settlement_statement_shows_payoff === true || (typeof p.payoff_statement_document_id === "string" && p.payoff_statement_document_id !== "") || (typeof p.zero_balance_document_id === "string" && p.zero_balance_document_id !== "") || (typeof p.creditor_letter_document_id === "string" && p.creditor_letter_document_id !== "");
    if (!evidenced) return { open: false, reason: `payoff ${formatCents(amount)} not yet on the settlement statement and no pre-closing payoff statement / zero-balance evidence → blocks funding.authorized (26.3)` };
  }
  return { open: true };
}
/** The settlement statement (or a pre-closing payoff/zero-balance statement) evidences the plan → `debt_payoff.evidenced`; an omitted payoff → `debt_payoff.failed`, the liability is re-included and the DTI recomputed. */
export function evidencePayoff(events: EventStore, plan: DebtPayoffPlan, l: Liability, ev: PayoffEvidenceInput, actor: Actor = AGENT): EvidencePayoffResult {
  const gate = payoffFundsGate({ payoff_amount_cents: String(plan.amount_cents), funds_verified_in_addition: plan.funds_verified_in_addition && (ev.verified_funds_in_addition_cents === undefined || ev.verified_funds_in_addition_cents === null), verified_funds_in_addition_cents: ev.verified_funds_in_addition_cents === undefined || ev.verified_funds_in_addition_cents === null ? null : String(ev.verified_funds_in_addition_cents), settlement_statement_shows_payoff: ev.settlement_statement_shows_payoff === true, payoff_statement_document_id: ev.payoff_statement_document_id ?? null, zero_balance_document_id: ev.zero_balance_document_id ?? null, creditor_letter_document_id: ev.creditor_letter_document_id ?? null });
  if (gate.open) {
    const evidence: PayoffEvidence = ev.settlement_statement_shows_payoff ? "settlement_statement_line" : ev.creditor_letter_document_id ? "creditor_letter_remaining_payments" : ev.zero_balance_document_id ? "zero_balance_statement" : "payoff_statement_before_closing";
    const doc = (ev.settlement_statement_shows_payoff ? ev.settlement_statement_document_id : null) ?? ev.payoff_statement_document_id ?? ev.zero_balance_document_id ?? ev.creditor_letter_document_id ?? null;
    const next: DebtPayoffPlan = { ...plan, status: "evidenced", evidence, evidence_document_id: doc };
    const liability: Liability = { ...l, payoff_statement_document_id: doc, status: "payoff_evidenced" };
    const event = emit(events, plan.application_id, "debt_payoff.evidenced", { plan_id: plan.plan_id, liability_id: plan.liability_id, mode: plan.mode, payoff_amount_cents: String(plan.amount_cents), evidence, evidence_document_id: doc, citation: "B3-6-07" }, ev.at, actor);
    return { plan: next, liability, gate, event, re_included: false, blocks: null };
  }
  const next: DebtPayoffPlan = { ...plan, status: "failed" };
  const liability: Liability = { ...l, include_in_dti: true, exclusion_reason: null, paid_at_closing: false, payoff_amount_cents: null, status: "reopened" };
  const event = emit(events, plan.application_id, "debt_payoff.failed", { plan_id: plan.plan_id, liability_id: plan.liability_id, mode: plan.mode, payoff_amount_cents: String(plan.amount_cents), reason: gate.reason, re_included_payment_cents: String(l.qualifying_payment_cents), blocks: "funding.authorized", next: "recompute DTI with the payment included → liabilities.changed (23.1)", citation: "B3-6-07" }, ev.at, actor);
  return { plan: next, liability, gate, event, re_included: true, blocks: "funding.authorized" };
}

// ============================================================ R9 — final consistency (FNMA_B3_6_01_LIABILITY_RECALC_GATE) and liabilities.finalized
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((x, n) => x === [...b].sort()[n]);
/** FNMA_B3_6_01_LIABILITY_RECALC_GATE: the latest `final` version carries the current included set and current terms, was computed after the last liability/term change, and matches the final DU submission's liability set. */
export function liabilityRecalcGate(f: Record<string, unknown>): GateResult {
  const fin = f.final_version as { stage?: string; liability_ids?: string[]; qp_id?: string; computed_at?: string; pi_cents?: string } | null | undefined;
  if (!fin || fin.stage !== "final") return { open: false, reason: "no dti_calculations version at stage final → agent recomputes (blocks consummate, sev 2)" };
  const current = Array.isArray(f.current_included_liability_ids) ? (f.current_included_liability_ids as string[]) : [];
  if (!sameSet(fin.liability_ids ?? [], current)) return { open: false, reason: "the final DTI version's liability set differs from the current included set → new final version and 23.1 resubmission required" };
  if (typeof f.current_qp_id === "string" && f.current_qp_id !== fin.qp_id) return { open: false, reason: "the final DTI version was computed on superseded terms (qp_id) → recompute" };
  if (typeof f.last_change_at === "string" && typeof fin.computed_at === "string" && Date.parse(fin.computed_at) < Date.parse(f.last_change_at)) return { open: false, reason: `a liability/term change at ${f.last_change_at} post-dates the final version (${fin.computed_at}) → recompute` };
  if (Array.isArray(f.du_final_liability_ids) && !sameSet(fin.liability_ids ?? [], f.du_final_liability_ids as string[])) return { open: false, reason: "the final DU submission's liability set differs from the final DTI version (23.1 FNMA_B3_2_10_DU_FINAL_MATCH_GATE)" };
  if (typeof f.cd_final_pi_cents === "string" && typeof fin.pi_cents === "string" && f.cd_final_pi_cents !== fin.pi_cents) return { open: false, reason: `CD-final P&I ${formatCents(BigInt(f.cd_final_pi_cents))} ≠ qualifying P&I ${formatCents(BigInt(fin.pi_cents))} (25.2 CD_PI_MATCH)` };
  return { open: true };
}
export interface FinalizeInput { readonly calc: DtiCalculation; readonly liabilities: readonly Liability[]; readonly qp: QualifyingPayment; readonly du_final_liability_ids: readonly string[]; readonly cd_final_pi_cents: Cents; readonly legal_doc_gate: GateResult; readonly irs_gate: GateResult; readonly payoff_gate: GateResult; readonly last_change_at: string | null; readonly at: string; }
/** Terminal for the process: `liabilities.finalized` + `dti.final` with `du_cap_ok = true` (feeds 23.1's final DU submission, 23.3 CTC, 23.4 ATR, 28.3 HMDA). */
export function finalizeLiabilities(events: EventStore, i: FinalizeInput, actor: Actor = AGENT): { liabilities: Liability[]; calc: DtiCalculation; event: DomainEvent } {
  if (!i.calc.du_cap_ok) throw new LiabilityRefused("FNMA_B3_6_02_DU_DTI_50_GATE", "B3-6-02", `dti ${i.calc.dti_display_pct}% exceeds 50.00%`);
  const gate = liabilityRecalcGate({ final_version: { stage: i.calc.stage, liability_ids: [...i.calc.liability_ids], qp_id: i.calc.qp_id, computed_at: i.at, pi_cents: String(i.qp.pi_cents) }, current_included_liability_ids: i.liabilities.filter((l) => l.include_in_dti).map((l) => l.liability_id), current_qp_id: i.qp.qp_id, du_final_liability_ids: [...i.du_final_liability_ids], cd_final_pi_cents: String(i.cd_final_pi_cents), last_change_at: i.last_change_at ?? undefined });
  if (!gate.open) throw new LiabilityRefused("FNMA_B3_6_01_LIABILITY_RECALC_GATE", "22.5 timers and gates", gate.reason ?? "closed");
  for (const [code, g] of [["FNMA_B3_6_05_LEGAL_DOC_GATE", i.legal_doc_gate], ["FNMA_B3_6_05_IRS_AGREEMENT_GATE", i.irs_gate], ["FNMA_B3_6_07_PAYOFF_FUNDS_GATE", i.payoff_gate]] as const) if (!g.open) throw new LiabilityRefused(code, "22.5 timers and gates", g.reason ?? "closed");
  const liabilities = i.liabilities.map((l) => ({ ...l, status: "finalized" as const }));
  const event = emit(events, i.calc.application_id, "liabilities.finalized", { dti_id: i.calc.dti_id, version: i.calc.version, stage: i.calc.stage, dti_bps: i.calc.dti_bps, dti_display_pct: i.calc.dti_display_pct, du_cap_ok: i.calc.du_cap_ok, obligations_cents: String(i.calc.obligations_cents), income_cents: String(i.calc.income_cents), liability_ids: [...i.calc.liability_ids], qp_id: i.qp.qp_id, pi_cents: String(i.qp.pi_cents),
    liabilities: liabilities.map((l) => ({ liability_id: l.liability_id, liability_type: l.liability_type, payment_basis: l.payment_basis, qualifying_payment_cents: String(l.qualifying_payment_cents), include_in_dti: l.include_in_dti, exclusion_reason: l.exclusion_reason, evidence_document_ids: [...l.exclusion_evidence_document_ids] })),
    atr_record_types: ["credit_report", "court_order", "irs_agreement", "creditor_statement"], consumers: ["23.1 final DU submission", "23.3 CTC", "23.4 ATR record (§1026.43(c)(2)(vi)–(vii))", "28.3 HMDA §1003.4(a)(23)"], rule_set_version: RULE_SET_VERSION }, i.at, actor);
  return { liabilities, calc: i.calc, event };
}

// ============================================================ decision record (AI design)
export function decisionRecord(i: { application_id: string; calc: DtiCalculation; liabilities: readonly Liability[]; qp: QualifyingPayment; tolerance_result?: ToleranceOutcome | null; rationale: string; confidence: number; model_version: string; prompt_version: string }): Record<string, unknown> {
  nonEmpty(i.rationale, "rationale"); if (!(i.confidence >= 0 && i.confidence <= 1)) throw new RangeError("confidence must be in [0, 1]");
  return { application_id: i.application_id, dti_version: i.calc.version, dti_id: i.calc.dti_id, stage: i.calc.stage, dti_bps: i.calc.dti_bps, dti_display_pct: i.calc.dti_display_pct, du_cap_ok: i.calc.du_cap_ok, obligations_cents: String(i.calc.obligations_cents), income_cents: String(i.calc.income_cents),
    liabilities: i.liabilities.map((l) => ({ liability_id: l.liability_id, liability_type: l.liability_type, payment_basis: l.payment_basis, qualifying_payment_cents: String(l.qualifying_payment_cents), include_in_dti: l.include_in_dti, exclusion_reason: l.exclusion_reason, evidence_document_ids: [...l.exclusion_evidence_document_ids], income_reduction_elected: l.income_reduction_elected, paid_at_closing: l.paid_at_closing })),
    qualifying_payment_inputs: i.qp.inputs, qualifying_rate_bps: i.qp.qualifying_rate_bps, qualifying_rate_basis: i.qp.qualifying_rate_basis, pi_cents: String(i.qp.pi_cents), pitia_cents: String(i.qp.pitia_cents), tolerance_result: i.tolerance_result ?? null,
    rule_set_version: RULE_SET_VERSION, du_rule_set_version: DU_RULE_SET_VERSION, formula_version: { dti: i.calc.formula_version, qualifying_payment: i.qp.formula_version }, model_version: i.model_version, prompt_version: i.prompt_version, rationale: i.rationale, confidence: i.confidence };
}
