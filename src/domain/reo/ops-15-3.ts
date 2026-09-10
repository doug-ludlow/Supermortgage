/**
 * §15.3 operating rules over the MI-claim calculators (./mi-claim.ts): the itemized-advance shadow claim of
 * rule 4 (which advance kinds are claimable, the attorney-fee cap, the MI premiums and technology fees the
 * master policy excludes, the per-day interest at risk); the three-way insurer-identity check of rule 1 with
 * the 1 BD correction clock (T11); the direct-filing Claim for Loss package with the GSE Beneficiary as payee
 * and the weekly follow-ups of rule 6 (T2); the mandatory document package of rule 3; the NOD 25th rule of
 * master policy §53 (T4); the 36-month interest cap watch with the 30-month `officer` briefing (T12); the
 * −3 BD officer alert guardrail; MICP document-request tracking (T6); the unpaid-claim officer escalation at
 * `settlement_due_at` (T8); benefit receipt — no custodial entry when Fannie Mae is paid, a balanced
 * Dr custodial clearing / Cr fnma_remittance_payable set and a 2 BD special remittance when the servicer is
 * (T9, rule 7); the supplemental claim window (T10, rule 8); EOB reconciliation and appeal routing (T7, open
 * question 4); shortfall attribution (rule 9) and rescission routing (rule 10); the daily
 * `mi_curtailment_risk` projection row (rule 5).
 */
import { type PlainDate, plainDate, addDays, addMonths, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { type Cents, monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { EntrySetInput, CustodialAccount } from "../../kernel/ledger/ledger.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { filer, miClaimClocks, shadowClaim, docRequestDue, eobVariance, curtailmentRisk, interestCapBriefing, nodExcludedInterest, unpaidEscalationOn, type ShadowClaim, type CurtailmentRiskInput } from "./mi-claim.ts";

export type LiquidationType = "fcl_fnma" | "fcl_third_party" | "short_sale" | "mortgage_release" | "redemption_expired";
export type Filer = "fnma_micp" | "servicer_direct";

// ============================================================ rule 4 — itemized shadow claim
/** Advance kinds as they sit in `advances`/`expense_claims` (15.2); the master policy decides which are claimable. */
export type AdvanceKind = "taxes" | "hazard_premium" | "flood_premium" | "hazard_refund" | "hoa" | "inspection" | "preservation" | "attorney_fee" | "attorney_cost" | "eviction_cost" | "mi_premium" | "technology_fee" | "other";
export interface ClaimAdvance { readonly advance_id: string; readonly kind: AdvanceKind; readonly amount_cents: Cents; }
/** One row of `mi_claim_calculations.advances` jsonb. */
export interface ClaimAdvanceLine extends ClaimAdvance { readonly claimable: boolean; readonly cap_reason: string | null; }

const EXCLUDED: ReadonlySet<AdvanceKind> = new Set<AdvanceKind>(["mi_premium", "technology_fee", "other"]);
const sum = (xs: readonly ClaimAdvance[], ...kinds: AdvanceKind[]): Cents => xs.filter((a) => kinds.includes(a.kind)).reduce((s, a) => s + a.amount_cents, 0n);
const excludedReason = (kind: AdvanceKind): string => kind === "mi_premium" ? "MI premiums are not a claimable advance (master policy §56)" : kind === "technology_fee" ? "technology fees are not a claimable advance (master policy §56)" : "not an enumerated advance category";

export interface ItemizedShadowInput {
  readonly upb_cents: Cents; readonly note_rate_pct: string; readonly interest_paid_to: PlainDate; readonly anchor: PlainDate; readonly default_date: PlainDate;
  readonly advances: readonly ClaimAdvance[]; readonly credits_cents: Cents; readonly coverage_pct: string; readonly net_proceeds_cents?: Cents | null;
}
export interface ItemizedShadowClaim extends ShadowClaim {
  readonly lines: readonly ClaimAdvanceLine[];
  readonly monthly_interest_cents: Cents; readonly stub_days: number; readonly stub_cents: Cents; readonly daily_interest_cents: Cents;
  readonly taxes_cents: Cents; readonly hazard_net_cents: Cents; readonly hoa_cents: Cents; readonly preservation_inspection_cents: Cents; readonly attorney_fees_costs_cents: Cents;
  readonly excluded_cents: Cents; readonly loss_cents: Cents | null; readonly settlement_option: "percentage" | "third_party_sale";
}

/** Rule 4: one day's note-rate interest, rounded to cents — the per-excess-day amount at risk in the curtailment monitor ($42.65/day for L15). */
export function dailyInterestAtRisk(upb: Cents, noteRatePct: string): Cents {
  return Decimal.fromBigInt(upb).mul(ratePercent(noteRatePct)).div(Decimal.fromInt(365)).toScaledInt(0, "HALF_UP");
}
/** Rule 4 / T4: the same daily rate kept to 4 decimal places of a dollar, as hundredths of a cent (UPB × rate ÷ 365 — $42.6522 for L15 → 426522n), the figure the master-policy exclusion is quoted at. */
export function dailyInterestRate4dp(upb: Cents, noteRatePct: string): bigint {
  return Decimal.fromBigInt(upb).mul(ratePercent(noteRatePct)).div(Decimal.fromInt(365)).toScaledInt(2, "HALF_UP");
}

/**
 * Rule 4 over the itemized advance ledger: taxes/assessments + hazard/flood premiums net of refunds + HOA +
 * preservation/inspections + attorney fees & costs (capped) are claimable; MI premiums and technology fees
 * are excluded. Returns the calculator's result plus the `advances` jsonb lines and the interest decomposition.
 */
export function shadowClaimItemized(i: ItemizedShadowInput): ItemizedShadowClaim {
  const taxes = sum(i.advances, "taxes"), hazard = sum(i.advances, "hazard_premium", "flood_premium"), refund = sum(i.advances, "hazard_refund");
  const hoa = sum(i.advances, "hoa"), presInsp = sum(i.advances, "inspection", "preservation"), attorney = sum(i.advances, "attorney_fee", "attorney_cost", "eviction_cost");
  const s = shadowClaim({ upb_cents: i.upb_cents, note_rate_pct: i.note_rate_pct, interest_paid_to: i.interest_paid_to, anchor: i.anchor, default_date: i.default_date,
    taxes_cents: taxes, hazard_cents: hazard, hazard_refund_cents: refund, hoa_cents: hoa, preservation_inspection_cents: presInsp, attorney_fees_costs_cents: attorney,
    credits_cents: i.credits_cents, coverage_pct: i.coverage_pct, net_proceeds_cents: i.net_proceeds_cents ?? null });
  const attorneyOverCap = attorney > s.attorney_cap_cents;
  const lines: ClaimAdvanceLine[] = i.advances.map((a) => {
    if (EXCLUDED.has(a.kind)) return { ...a, claimable: false, cap_reason: excludedReason(a.kind) };
    if (a.kind === "hazard_refund") return { ...a, claimable: true, cap_reason: "refund netted against hazard/flood premiums" };
    if ((a.kind === "attorney_fee" || a.kind === "attorney_cost" || a.kind === "eviction_cost") && attorneyOverCap) return { ...a, claimable: true, cap_reason: `attorney fees and costs capped at ${s.attorney_cap_cents} cents (${i.upb_cents >= 20_000_000n ? "3% of UPB" : "lesser of $6,000 or 5% of UPB"}, master policy §56(e))` };
    return { ...a, claimable: true, cap_reason: null };
  });
  const monthly = monthlyInterest(i.upb_cents, ratePercent(i.note_rate_pct));
  const stub = s.interest_cents - monthly * BigInt(s.interest_months);
  const stubDays = s.capped ? 0 : daysBetween(addMonths(i.interest_paid_to, s.interest_months), i.anchor);
  const net = i.net_proceeds_cents ?? null;
  return { ...s, lines, monthly_interest_cents: monthly, stub_days: stubDays, stub_cents: stub, daily_interest_cents: dailyInterestAtRisk(i.upb_cents, i.note_rate_pct),
    taxes_cents: taxes, hazard_net_cents: hazard - refund, hoa_cents: hoa, preservation_inspection_cents: presInsp, attorney_fees_costs_cents: attorney,
    excluded_cents: i.advances.filter((a) => EXCLUDED.has(a.kind)).reduce((t, a) => t + a.amount_cents, 0n), loss_cents: net === null ? null : s.claim_amount_cents - net, settlement_option: net === null ? "percentage" : "third_party_sale" };
}

// ============================================================ rule 1 / T11 — insurer identity validated three ways
export type InsurerSource = "mi_policies" | "reogram" | "micp";
export interface InsurerIdentityInput {
  /** `mi_policies.insurer_code` — the policy of record (Section 10) */
  readonly policy_insurer_code: string;
  /** the MI company field on the REOgram case (15.1, editable 5 BD) and the MICP claim record, when observed */
  readonly reogram_insurer_code?: string | null; readonly micp_insurer_code?: string | null;
  readonly found_on: PlainDate; readonly cal?: Calendar;
}
export interface InsurerIdentityCheck {
  readonly mismatch: boolean;
  readonly sources: readonly { readonly source: InsurerSource; readonly insurer_code: string | null; readonly agrees: boolean }[];
  /** where the correction is submitted: the REOgram MI fields (P360) and/or a MICP message to Fannie Mae */
  readonly correction_targets: readonly ("reogram" | "micp")[];
  readonly detection_date: PlainDate; readonly correction_due_at: PlainDate | null;
  readonly timer: "FNMA_E4501_MICP_DATA_CORRECTION_1BD"; readonly breach: "sev2"; readonly refusal: string | null;
}
const norm = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === "" ? null : s.trim().toUpperCase());
/** Rule 1 (E-4.5-01): the insurer identity is validated against mi_policies, the REOgram MI fields and the MICP claim record; any mismatch → correction within 1 BD, routing waits. */
export function validateInsurerIdentity(i: InsurerIdentityInput): InsurerIdentityCheck {
  const policy = norm(i.policy_insurer_code);
  const sources = ([["mi_policies", policy], ["reogram", norm(i.reogram_insurer_code)], ["micp", norm(i.micp_insurer_code)]] as const)
    .map(([source, code]) => ({ source, insurer_code: code, agrees: code === null || code === policy }));
  const bad = sources.filter((s) => !s.agrees);
  const mismatch = bad.length > 0;
  return { mismatch, sources, correction_targets: bad.map((s) => s.source as "reogram" | "micp"), detection_date: i.found_on, correction_due_at: mismatch ? addBusinessDays(i.found_on, 1, i.cal ?? fannieEt) : null,
    timer: "FNMA_E4501_MICP_DATA_CORRECTION_1BD", breach: "sev2",
    refusal: mismatch ? `insurer identity mismatch: mi_policies says ${policy}, ${bad.map((s) => `${s.source} shows ${s.insurer_code}`).join(", ")} — submit the correction within 1 BD (${i.found_on} → ${addBusinessDays(i.found_on, 1, i.cal ?? fannieEt)}) and re-evaluate the routing (15.3 rule 1; E-4.5-01)` : null };
}

// ============================================================ rule 3 — mandatory package
export type DocKind = "claim_form" | "payment_history" | "servicing_notes" | "collection_chronology" | "borrower_correspondence" | "valuation" | "bidding_instructions" | "foreclosure_deed" | "dil_approval" | "tps_evidence" | "short_payoff_approval" | "settlement_statement" | "property_preservation_invoices" | "tax_bills" | "insurance_evidence" | "hoa_statements" | "attorney_invoices" | "eviction_costs" | "origination_file_item" | "other";

/** Rule 3: the mandatory package by liquidation type and route; the insurer's Claim for Loss form only on the direct path; origination-file items never by default. */
export function mandatoryDocumentKinds(liquidationType: LiquidationType, route: Filer, opts: { servicer_counsel_eviction?: boolean } = {}): readonly DocKind[] {
  const base: DocKind[] = ["payment_history", "servicing_notes", "collection_chronology", "borrower_correspondence", "valuation", "property_preservation_invoices", "tax_bills", "insurance_evidence", "hoa_statements", "attorney_invoices"];
  const byType: Record<LiquidationType, DocKind[]> = { fcl_fnma: ["bidding_instructions", "foreclosure_deed"], fcl_third_party: ["bidding_instructions", "tps_evidence", "settlement_statement"], redemption_expired: ["bidding_instructions", "foreclosure_deed"], mortgage_release: ["dil_approval", "foreclosure_deed"], short_sale: ["short_payoff_approval", "settlement_statement"] };
  const out: DocKind[] = [...(route === "servicer_direct" ? ["claim_form" as DocKind] : []), ...base, ...byType[liquidationType]];
  if (opts.servicer_counsel_eviction) out.push("eviction_costs");
  return out;
}

/** Guardrail: origination-file documents leave only on an insurer request. */
export function originationItemsAllowed(i: { doc_kinds: readonly string[]; insurer_requested_kinds?: readonly string[] | null }): { allowed: boolean; refusal: string | null } {
  const requested = new Set(i.insurer_requested_kinds ?? []);
  const bad = i.doc_kinds.filter((k) => k === "origination_file_item" && !requested.has(k));
  return { allowed: bad.length === 0, refusal: bad.length ? "origination-file items are uploaded only on the insurer's request (15.3 rule 3 / guardrail)" : null };
}

// ============================================================ rule 6 / T2 — direct filing
export interface DirectClaimInput {
  readonly insurer_code: string; readonly micp_participant: boolean; readonly micp_effective: PlainDate | null; readonly liquidation_type: LiquidationType; readonly liquidation_date: PlainDate;
  /** master-policy anchor (sale / DIL / TPS close) and the F-1-06 expense anchor (redemption expiry / docket entry where applicable) */
  readonly claim_anchor_date: PlainDate; readonly expense_anchor_date: PlainDate;
  readonly claim_form_id?: string | null; readonly filed_on?: PlainDate | null; readonly paid_on?: PlainDate | null; readonly horizon_weeks?: number; readonly claim_filing_days?: number; readonly cal?: Calendar;
}
export interface DirectClaimPackage { readonly form: string; readonly payee: "Fannie Mae"; readonly payee_role: "GSE Beneficiary"; readonly payee_instruction: string; readonly documents: readonly DocKind[]; }
export interface DirectClaimPlan {
  readonly filer: Filer; readonly claim_filing_deadline: PlainDate; readonly direct_file_due_at: PlainDate; readonly package: DirectClaimPackage | null;
  readonly followups: { readonly timer: "SM_MI_SETTLEMENT_FOLLOWUP_7"; readonly every_days: 7; readonly schedule: readonly PlainDate[] };
}

/** Rule 6 (F-1-06): a non-participant is filed directly within 30 days of the anchor on the insurer's Claim for Loss form, payable to the GSE Beneficiary, with weekly follow-ups after filing until paid. */
export function directClaimPackage(i: DirectClaimInput): DirectClaimPlan {
  const route = filer({ micp_participant: i.micp_participant, micp_effective: i.micp_effective, liquidation_date: i.liquidation_date });
  const clocks = miClaimClocks(i.claim_anchor_date, i.expense_anchor_date, i.claim_filing_days ?? 60, i.cal ?? fannieEt);
  const pkg: DirectClaimPackage | null = route === "servicer_direct"
    ? { form: i.claim_form_id ?? `${i.insurer_code} Claim for Loss`, payee: "Fannie Mae", payee_role: "GSE Beneficiary", payee_instruction: "pay the Insurance Benefit to Fannie Mae as GSE Beneficiary per SF CPM payee instructions (E-4.5-01; master policy §42(c))", documents: mandatoryDocumentKinds(i.liquidation_type, "servicer_direct") }
    : null;
  const schedule: PlainDate[] = [];
  if (route === "servicer_direct" && i.filed_on) {
    const end = i.paid_on ?? addDays(i.filed_on, 7 * (i.horizon_weeks ?? 8));
    for (let d = addDays(i.filed_on, 7); d < end; d = addDays(d, 7)) schedule.push(d);
  }
  return { filer: route, claim_filing_deadline: clocks.claim_filing_deadline, direct_file_due_at: clocks.direct_file_due, package: pkg, followups: { timer: "SM_MI_SETTLEMENT_FOLLOWUP_7", every_days: 7, schedule } };
}

// ============================================================ T4 / master policy §53 — the NOD 25th rule
/** Master policy §53: the Notice of Default is due "no later than the 25th day of the month in which the Borrower's second consecutive missed payment remains unpaid". */
export function nodDueDate(secondMissedPaymentDue: PlainDate): PlainDate { const { y, m } = parts(secondMissedPaymentDue); return ymd(y, m, 25); }

export interface NodLateness { readonly nod_due: PlainDate; readonly reported_on: PlainDate; readonly days: number; readonly daily_rate_4dp: bigint; readonly excluded_interest_cents: Cents; readonly attribution: "servicer_caused" | null; readonly timer: "MI_MP_NOD_25TH"; readonly breach: "sev1" | null; }
/** T4 / rule 5: a late NOD excludes the interest between the 25th and the actual notice — the curtailment monitor's projection and its attribution. */
export function nodLateness(i: { second_missed_payment_due: PlainDate; reported_on: PlainDate; upb_cents: Cents; note_rate_pct: string }): NodLateness {
  const due = nodDueDate(i.second_missed_payment_due);
  const x = nodExcludedInterest(i.upb_cents, i.note_rate_pct, due, i.reported_on);
  return { nod_due: due, reported_on: i.reported_on, days: x.days, daily_rate_4dp: dailyInterestRate4dp(i.upb_cents, i.note_rate_pct), excluded_interest_cents: x.cents, attribution: x.attribution, timer: "MI_MP_NOD_25TH", breach: x.days > 0 ? "sev1" : null };
}

// ============================================================ T12 — 36-month interest cap watch
export interface InterestCapInput {
  /** first day of unpaid interest (the paid-to date); 36 accrual months are covered from here */
  readonly accrual_from: PlainDate; readonly as_of: PlainDate; readonly upb_cents: Cents; readonly note_rate_pct: string;
  /** the first unpaid due date — the MI_MP_INTEREST_CAP_36M anchor (`default date`); defaults to the installment after the paid-to date */
  readonly default_date?: PlainDate | null;
  readonly resolved: boolean; readonly judicial: boolean; readonly projected_resolution_on?: PlainDate | null; readonly cap_months?: number;
}
export interface InterestCapBriefing { readonly kind: "officer"; readonly timer: "MI_MP_INTEREST_CAP_36M"; readonly cap_date: PlainDate; readonly timer_not_after: PlainDate; readonly months_accrued: number; readonly cap_months_remaining: number; readonly monthly_interest_cents: Cents; readonly projected_resolution_on: PlainDate | null; readonly projected_uninsured_months: number; readonly projected_uninsured_interest_cents: Cents; readonly reason: string; }

/**
 * Master policy: interest and advances are covered for no more than 36 months. `cap_date` is the last covered
 * accrual date (paid-to + 36 months — the 36 unpaid installments from the default date); `timer_not_after` is
 * the registry anchor (first unpaid due date + 36 months — the first uninsured installment). At 30 months on an
 * unresolved foreclosure the `officer` gets both dates and the projected uninsured interest.
 */
export function interestCapWatch(i: InterestCapInput): { months_accrued: number; cap_date: PlainDate; timer_not_after: PlainDate; cap_months_remaining: number; briefing: InterestCapBriefing | null } {
  const cap = i.cap_months ?? 36;
  let months = 0; let cursor = i.accrual_from;
  while (addMonths(cursor, 1) <= i.as_of) { cursor = addMonths(cursor, 1); months++; }
  const capDate = addMonths(i.accrual_from, cap);
  const notAfter = addMonths(i.default_date ?? addMonths(i.accrual_from, 1), cap);
  const remaining = Math.max(0, cap - months);
  if (i.resolved || !interestCapBriefing(months)) return { months_accrued: months, cap_date: capDate, timer_not_after: notAfter, cap_months_remaining: remaining, briefing: null };
  const monthly = monthlyInterest(i.upb_cents, ratePercent(i.note_rate_pct));
  const proj = i.projected_resolution_on ?? null;
  let uninsuredMonths = 0;
  if (proj && proj > capDate) { let c = capDate; while (addMonths(c, 1) <= proj) { c = addMonths(c, 1); uninsuredMonths++; } if (c < proj) uninsuredMonths++; }
  return { months_accrued: months, cap_date: capDate, timer_not_after: notAfter, cap_months_remaining: remaining, briefing: { kind: "officer", timer: "MI_MP_INTEREST_CAP_36M", cap_date: capDate, timer_not_after: notAfter, months_accrued: months, cap_months_remaining: remaining, monthly_interest_cents: monthly, projected_resolution_on: proj, projected_uninsured_months: uninsuredMonths, projected_uninsured_interest_cents: monthly * BigInt(uninsuredMonths),
    reason: `interest accrual reached ${months} months on an unresolved ${i.judicial ? "judicial" : "non-judicial"} foreclosure; the master policy covers interest and advances for no more than ${cap} months — cap date ${capDate} (first uninsured installment ${notAfter})${proj ? `, projected resolution ${proj} leaves ${uninsuredMonths} uninsured month(s)` : ", no projected resolution date"}` } };
}

// ============================================================ guardrail — officer alert at −3 BD
/** Guardrail: never let `micp_docs_due_at` pass without an `officer` alert at −3 BD. */
export function micpDocsOfficerAlert(i: { micp_docs_due_at: PlainDate; today: PlainDate; uploaded: boolean; officer_alerted: boolean; cal?: Calendar }): { alert_on: PlainDate; alert_required: boolean; breached: boolean; refusal: string | null } {
  const alertOn = addBusinessDays(i.micp_docs_due_at, -3, i.cal ?? fannieEt);
  const required = !i.uploaded && i.today >= alertOn && !i.officer_alerted;
  const breached = !i.uploaded && i.today > i.micp_docs_due_at;
  return { alert_on: alertOn, alert_required: required, breached, refusal: required ? `micp_docs_due_at ${i.micp_docs_due_at} is within 3 BD (alert point ${alertOn}) and the package is not uploaded — raise the officer alert (15.3 guardrail; E-4.5-01 liability)` : null };
}

// ============================================================ T6 — MICP document requests
export interface DocRequest { readonly request_id: string; readonly doc_kind: DocKind | string; readonly requested_on: PlainDate; readonly micp_due_date: PlainDate | null; readonly potential_denial_date?: PlainDate | null; readonly uploaded_on?: PlainDate | null; }
export interface TrackedDocRequest extends DocRequest { readonly due_at: PlainDate; readonly status: "open" | "uploaded" | "uploaded_late" | "breached"; readonly breach: "sev1" | null; readonly timer: "SM_MICP_DOC_REQUEST_DUE"; }
/** Timer row: the task is due the earlier of the MICP Due Date and 5 BD; breach is sev-1 (lack of activity could result in a denial) and a late upload keeps the breach on record. */
export function trackDocRequests(i: { requests: readonly DocRequest[]; today: PlainDate; cal?: Calendar }): TrackedDocRequest[] {
  return i.requests.map((r) => {
    const due = docRequestDue(r.requested_on, r.micp_due_date, i.cal ?? fannieEt);
    const late = r.uploaded_on ? r.uploaded_on > due : i.today > due;
    const status: TrackedDocRequest["status"] = r.uploaded_on ? (late ? "uploaded_late" : "uploaded") : late ? "breached" : "open";
    return { ...r, due_at: due, status, breach: late ? "sev1" : null, timer: "SM_MICP_DOC_REQUEST_DUE" };
  });
}

// ============================================================ T8 / rule 6 — unpaid at settlement_due_at
export interface FollowupEntry { readonly on: PlainDate; readonly note: string; }
export interface InsurerResponse { readonly on: PlainDate; readonly response: string; }
export interface UnpaidClaimEscalation {
  readonly kind: "officer"; readonly severity: "sev1"; readonly timer: "MI_MP_SETTLEMENT_60";
  readonly perfected_at: PlainDate; readonly documentation_complete_date: PlainDate; readonly settlement_due_at: PlainDate; readonly days_past_due: number;
  readonly followup_log: readonly FollowupEntry[]; readonly followup_dates: readonly PlainDate[]; readonly insurer_responses: readonly InsurerResponse[]; readonly reason: string;
}
/** Rule 6 / F-1-06 "Ensuring Timely Settlement": unpaid by `settlement_due_at` (perfected + 60) → `officer` with the documentation-complete date, follow-up dates and the insurer's responses; Fannie Mae may require the partner to advance the claim amount (A1-3-02). */
export function unpaidClaimEscalation(i: { perfected_at: PlainDate; today: PlainDate; paid: boolean; settlement_days?: number; followup_log?: readonly FollowupEntry[]; insurer_responses?: readonly InsurerResponse[] }): { settlement_due_at: PlainDate; escalation: UnpaidClaimEscalation | null } {
  const due = i.settlement_days === undefined ? unpaidEscalationOn(i.perfected_at) : addDays(i.perfected_at, i.settlement_days);
  if (i.paid || i.today < due) return { settlement_due_at: due, escalation: null };
  const log = [...(i.followup_log ?? [])].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  return { settlement_due_at: due, escalation: { kind: "officer", severity: "sev1", timer: "MI_MP_SETTLEMENT_60", perfected_at: i.perfected_at, documentation_complete_date: i.perfected_at, settlement_due_at: due, days_past_due: daysBetween(due, i.today),
    followup_log: log, followup_dates: log.map((f) => f.on), insurer_responses: i.insurer_responses ?? [],
    reason: `claim perfected ${i.perfected_at} is unpaid at settlement_due_at ${due} (${i.settlement_days ?? 60}-day Claim Settlement Period, master policy §1) — Fannie Mae may require the servicer to advance the claim amount (F-1-06; A1-3-02)` } };
}

// ============================================================ T9 / rule 7 — proceeds
export type BenefitPayee = "fnma" | "servicer";
export interface BenefitReceiptInput { readonly claim_id: string; readonly loan_id: string; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly payee: BenefitPayee; readonly custodial_account_id?: string; readonly net_against_advances?: boolean; readonly cal?: Calendar; }
export interface BenefitReceipt {
  readonly payee: BenefitPayee; readonly custodial_entry: boolean; readonly next_status: "closed" | "remit_pending";
  readonly remit_by: PlainDate | null; readonly timer: "SM_MI_PROCEEDS_REMIT_2BD" | null;
  readonly remittance: { readonly kind: "special"; readonly crs_code: "316"; readonly crs_code_verified: false; readonly payee: "Fannie Mae"; readonly amount_cents: Cents } | null;
  readonly ledger: EntrySetInput | null; readonly netting_allowed: false; readonly refusal: string | null;
}
export const MI_BENEFIT_REMIT_RULE = "15.3 rule 7 (F-1-06; E-4.5-01): servicer-received MI benefit → Dr custodial/clearing Cr fnma_remittance_payable → CRS special remittance within 2 business_days_fannie_et";
/** Rule 7: Fannie Mae-filed claims are paid to Fannie Mae — no custodial entry, record the EOB and close; a benefit that lands with the servicer is booked Dr clearing / Cr fnma_remittance_payable and remitted in full as a special remittance within 2 BD — never netted against advances. */
export function benefitReceipt(i: BenefitReceiptInput): BenefitReceipt {
  if (i.payee === "fnma") return { payee: "fnma", custodial_entry: false, next_status: "closed", remit_by: null, timer: null, remittance: null, ledger: null, netting_allowed: false, refusal: null };
  const remitBy = addBusinessDays(i.received_on, 2, i.cal ?? fannieEt);
  const ledger: EntrySetInput = { effectiveDate: i.received_on, description: `MI claim ${i.claim_id} benefit received by the servicer — payable to Fannie Mae (special remittance by ${remitBy})`,
    lines: [
      { account: { scope: "custodial", custodialAccountId: i.custodial_account_id ?? "custodial-clearing", account: "clearing_cash" }, amountCents: i.amount_cents, ruleRef: MI_BENEFIT_REMIT_RULE, memo: "Dr custodial/clearing — MI benefit wire" },
      // the custodial liability the 5.2 CRS draft flow debits (db/migrations/0024_ledger_accounts.sql: custodial `fnma_remittance_payable`) — the kernel's
      // CustodialAccount union predates the 0024 account rows, so the account name is asserted against the migration's row, not the union
      { account: { scope: "custodial", custodialAccountId: i.custodial_account_id ?? "custodial-clearing", account: "fnma_remittance_payable" as CustodialAccount }, amountCents: -i.amount_cents, ruleRef: MI_BENEFIT_REMIT_RULE, memo: "Cr fnma_remittance_payable — full benefit, never netted against advances" },
    ] };
  return { payee: "servicer", custodial_entry: true, next_status: "remit_pending", remit_by: remitBy, timer: "SM_MI_PROCEEDS_REMIT_2BD",
    remittance: { kind: "special", crs_code: "316", crs_code_verified: false, payee: "Fannie Mae", amount_cents: i.amount_cents }, ledger, netting_allowed: false,
    refusal: i.net_against_advances ? "a benefit received by the servicer is remitted in full within 2 BD and never netted against advances (15.3 rule 7 / edge cases)" : null };
}

// ============================================================ T10 / rule 8 — supplemental claims
export interface PostClaimAdvance extends ClaimAdvance { readonly paid_on: PlainDate; }
export interface SupplementalClaimPlan {
  readonly timer: "MI_MP_SUPPLEMENTAL_90"; readonly supplemental_due_at: PlainDate; readonly upload_by: PlainDate; readonly route: Filer;
  readonly items: readonly ClaimAdvanceLine[]; readonly amount_cents: Cents; readonly needed: boolean;
  /** `pending_sweep`: no post-claim advances so far, but the advances ledger has not been swept through `upload_by` — the 90-day clock stays open */
  readonly result: "filed_by_fnma_from_upload" | "servicer_files" | "none_needed" | "pending_sweep";
  readonly advances_swept_through: PlainDate | null;
  readonly documents: readonly DocKind[]; readonly basis: string;
}
const supplementalDoc = (k: AdvanceKind): DocKind => k === "eviction_cost" ? "eviction_costs" : k === "taxes" ? "tax_bills" : k === "hoa" ? "hoa_statements" : k === "attorney_fee" || k === "attorney_cost" ? "attorney_invoices" : k === "hazard_premium" || k === "flood_premium" ? "insurance_evidence" : "property_preservation_invoices";
/**
 * Rule 8 (master policy §62(f); E-4.3-04): post-claim advances go in a supplemental claim before anchor + 90; for MICP loans Fannie Mae
 * files it from our upload, due `supplemental_due_at − 10 BD`. "None needed" is a finding, not an assertion: it is reached only once the
 * advances ledger (15.2) has been swept through the upload-by date and still holds no post-claim advance — before that the window stays open.
 */
export function supplementalClaimPlan(i: { claim_anchor_date: PlainDate; route: Filer; post_claim_advances: readonly PostClaimAdvance[]; advances_swept_through?: PlainDate | null; supplemental_days?: number; cal?: Calendar }): SupplementalClaimPlan {
  const dueAt = addDays(i.claim_anchor_date, i.supplemental_days ?? 90);
  const uploadBy = i.route === "fnma_micp" ? addBusinessDays(dueAt, -10, i.cal ?? fannieEt) : dueAt;
  const items: ClaimAdvanceLine[] = i.post_claim_advances.map((a) => EXCLUDED.has(a.kind) ? { ...a, claimable: false, cap_reason: excludedReason(a.kind) } : { ...a, claimable: true, cap_reason: a.kind === "eviction_cost" ? "servicer-counsel eviction costs (E-4.3-04)" : null });
  const claimable = items.filter((x) => x.claimable);
  const amount = claimable.reduce((s, x) => s + x.amount_cents, 0n);
  const needed = amount > 0n;
  const swept = i.advances_swept_through ?? null;
  const sweptThroughUploadBy = swept !== null && swept >= uploadBy;
  const documents = [...new Set(claimable.map((x) => supplementalDoc(x.kind)))];
  const result: SupplementalClaimPlan["result"] = needed ? (i.route === "fnma_micp" ? "filed_by_fnma_from_upload" : "servicer_files") : sweptThroughUploadBy ? "none_needed" : "pending_sweep";
  return { timer: "MI_MP_SUPPLEMENTAL_90", supplemental_due_at: dueAt, upload_by: uploadBy, route: i.route, items, amount_cents: amount, needed, result, advances_swept_through: swept, documents,
    basis: needed ? `${claimable.length} post-claim advance(s) totalling ${amount} cents → supplemental claim within 90 days of ${i.claim_anchor_date} (${dueAt})${i.route === "fnma_micp" ? `; upload by ${uploadBy} (−10 fannie_et BD) so Fannie Mae files from MICP` : `; file with the insurer by ${dueAt}`}`
      : result === "none_needed" ? `no claimable post-claim advance in the advances ledger swept through ${swept} (≥ upload-by ${uploadBy}) — none needed`
      : `no post-claim advance so far, but the advances ledger is swept only through ${swept ?? "(never)"} — before upload-by ${uploadBy}; the 90-day window stays open` };
}

// ============================================================ T7 / rule 4 — EOB reconciliation and appeals
export interface EobCurtailment { readonly reason: string; readonly amount_cents: Cents; }
export interface EobReconciliation { readonly variance_cents: Cents; readonly analyze: boolean; readonly attorney_within_cap: boolean | null; readonly curtailments: readonly (EobCurtailment & { readonly disputed: boolean; readonly basis: string })[]; readonly appeal: { readonly draft: boolean; readonly amount_cents: Cents; readonly exhibits: readonly string[] } | null; }
/** Rule 4: variances > $250 or > 0.5% are analyzed; an attorney-fee-cap curtailment is disputed only when the itemized shadow shows our fees and costs within the §56(e) cap — then the appeal is drafted with the cap exhibit and invoices. */
export function reconcileEob(i: { shadow: ItemizedShadowClaim | ShadowClaim; eob_benefit_cents: Cents; curtailments: readonly EobCurtailment[] }): EobReconciliation {
  const v = eobVariance(i.shadow.benefit_cents, i.eob_benefit_cents);
  // the plain calculator already clamps attorney fees to the cap, so only the itemized shadow can verify the cap
  const attorneyWithinCap: boolean | null = "attorney_fees_costs_cents" in i.shadow && typeof (i.shadow as ItemizedShadowClaim).attorney_fees_costs_cents === "bigint"
    ? (i.shadow as ItemizedShadowClaim).attorney_fees_costs_cents <= i.shadow.attorney_cap_cents : null;
  const rows = i.curtailments.map((c) => {
    const feeCap = /attorney fee/i.test(c.reason) && /cap/i.test(c.reason);
    const disputed = feeCap && attorneyWithinCap === true;
    return { ...c, disputed, basis: disputed ? `our attorney fees and costs are within the master policy §56(e) cap of ${i.shadow.attorney_cap_cents} cents` : feeCap ? (attorneyWithinCap === false ? "fees exceeded the cap — accept" : "cannot verify the fee cap without the itemized shadow calculation (computeShadowClaim) — review before disputing") : "review against timeline and servicing evidence" };
  });
  const disputed = rows.filter((r) => r.disputed);
  const amount = disputed.reduce((s, r) => s + r.amount_cents, 0n);
  return { variance_cents: v.variance_cents, analyze: v.analyze, attorney_within_cap: attorneyWithinCap, curtailments: rows, appeal: v.analyze && disputed.length ? { draft: true, amount_cents: amount, exhibits: ["attorney_fee_cap_exhibit", "attorney_invoices", "shadow_claim_calculation"] } : null };
}

export type AppealReason = "curtailment" | "denial" | "rescission";
export const APPEAL_HUMAN_REVIEW_OVER_CENTS = 1_000_000n;
/**
 * Open question 4 / rule 10: the agent drafts and files appeals ≤ $10,000; a `human_agent` reviewer approves above; rescissions go to the
 * `officer` repurchase path unless rescission relief is evidenced — and a rescission dispute that is appealed also goes to the `attorney`
 * (agents paragraph: `attorney` for rescission disputes, conveyance defects).
 */
export function appealRouting(i: { reason: AppealReason; amount_cents: Cents; rescission_relief_evidenced?: boolean }): { route: "appeal" | "officer_repurchase_path"; drafted_by: "agent"; approval: "agent" | "human_agent" | "officer"; attorney_review: boolean; refusal: string | null } {
  if (i.reason === "rescission" && !i.rescission_relief_evidenced) return { route: "officer_repurchase_path", drafted_by: "agent", approval: "officer", attorney_review: false, refusal: "a rescission for origination misrepresentation is the 5.6/Selling Guide repurchase path (officer), not an appeal by this process, unless rescission-relief eligibility is evidenced (rule 10)" };
  return { route: "appeal", drafted_by: "agent", approval: i.amount_cents > APPEAL_HUMAN_REVIEW_OVER_CENTS ? "human_agent" : "agent", attorney_review: i.reason === "rescission", refusal: null };
}

export type AppealStatus = "ready_to_file" | "awaiting_human_agent_review" | "approved" | "filed";
/**
 * Guardrail on every path that files an appeal (draftAppeal{submit}, draftAppeal{op=file}, the operator's MICP result): an appeal
 * over $10,000 is filed only once a `human_agent` (or `officer`) has approved it, or when the filer is that reviewer.
 */
export function appealSubmissionCheck(i: { amount_cents: Cents; approval: "agent" | "human_agent" | "officer"; status: AppealStatus | string; actor_is_reviewer: boolean }): { allowed: boolean; refusal: string | null } {
  if (i.status === "filed") return { allowed: false, refusal: "the appeal is already filed" };
  if (i.amount_cents <= APPEAL_HUMAN_REVIEW_OVER_CENTS || i.approval === "agent") return { allowed: true, refusal: null };
  if (i.status === "approved" || i.actor_is_reviewer) return { allowed: true, refusal: null };
  return { allowed: false, refusal: `appeal of ${i.amount_cents} cents (> $10,000) is ${i.status} — a human_agent reviewer approves it (draftAppeal{op=approve}) before it is filed or recorded as filed (15.3 guardrail; open question 4)` };
}

// ============================================================ rule 9 — shortfall attribution
export type ShortfallCause = "late_nod" | "late_documents" | "missing_expense_request" | "foreclosure_delay" | "improper_conveyance" | "premium_netting" | "insurer_error" | "property_condition" | "other";
export const SERVICER_CAUSES: ReadonlySet<ShortfallCause> = new Set<ShortfallCause>(["late_nod", "late_documents", "missing_expense_request", "foreclosure_delay", "improper_conveyance", "premium_netting"]);
export interface ShortfallAttribution { readonly attribution: "servicer_caused" | "insurer_other"; readonly servicer_caused_shortfall_cents: Cents; readonly exposure: "A1-3-02" | null; readonly memo_account: "contingent_make_whole_fnma" | null; readonly rule_ref: string; readonly next: "make_whole_exposure" | "appeal_or_accept" | "timeline_evidence_review"; readonly escalate_to: "attorney" | null; readonly refusal: string | null; }
/** Which timeline the guardrail's "timeline evidence review" reads for each servicer cause (rule 9). */
export const SHORTFALL_TIMELINE: Readonly<Record<ShortfallCause, string>> = {
  late_nod: "default-reporting timeline (NOD due the 25th vs reported; master policy §53)", late_documents: "MICP document requests / uploads vs micp_docs_due_at and request due dates", missing_expense_request: "571 final expense request vs the 30-day F-1-06 anchor (15.2)",
  foreclosure_delay: "13.x foreclosure timeline vs the state allowable frame and documented delays (court, bankruptcy, mediation)", improper_conveyance: "conveyance chronology (deed, REOgram, title) — conveyance defects go to the attorney", premium_netting: "MI premium / claim benefit netting chronology",
  insurer_error: "insurer's EOB and correspondence", property_condition: "9.8/9.9 inspection and preservation history", other: "claim file chronology",
};
/**
 * Rule 9: servicer-caused shortfalls (late NOD, late documents, missing expense request, undocumented foreclosure delay, improper conveyance,
 * premium netting) book an A1-3-02 exposure on the `contingent_make_whole_fnma` memo until demanded. Guardrail (agents paragraph, unqualified):
 * "never concede a curtailment as servicer-caused without the timeline evidence review" — every servicer cause needs the review of its
 * timeline first; a foreclosure delay with diligence evidenced is the insurer's to bear; conveyance defects are referred to the `attorney`.
 */
export function attributeShortfall(i: { cause: ShortfallCause; amount_cents: Cents; timeline_evidence_reviewed: boolean; diligence_evidenced?: boolean }): ShortfallAttribution {
  const ruleRef = "15.3 rule 9 / E-4.5-01 reimbursement; A1-3-02 make-whole (memo contingent_make_whole_fnma until demanded, then 5.6 booking)";
  const attorney = i.cause === "improper_conveyance" ? "attorney" as const : null;
  if (SERVICER_CAUSES.has(i.cause) && !i.timeline_evidence_reviewed) return { attribution: "insurer_other", servicer_caused_shortfall_cents: 0n, exposure: null, memo_account: null, rule_ref: ruleRef, next: "timeline_evidence_review", escalate_to: attorney, refusal: `never concede a curtailment as servicer-caused without the timeline evidence review (15.3 guardrail) — review the ${SHORTFALL_TIMELINE[i.cause]} first` };
  const servicer = SERVICER_CAUSES.has(i.cause) && !(i.cause === "foreclosure_delay" && i.diligence_evidenced);
  return { attribution: servicer ? "servicer_caused" : "insurer_other", servicer_caused_shortfall_cents: servicer ? i.amount_cents : 0n, exposure: servicer ? "A1-3-02" : null, memo_account: servicer ? "contingent_make_whole_fnma" : null, rule_ref: ruleRef, next: servicer ? "make_whole_exposure" : "appeal_or_accept", escalate_to: attorney, refusal: null };
}

// ============================================================ rule 5 — curtailment monitor task and the daily projection row
/**
 * Rule 5: score ≥ 0.6 opens the `foreclosure-ops` diligent-servicing evidence task (the same evidence feeds the A1-4.2-02 rebuttal).
 * The shared calculator (./mi-claim.ts curtailmentRisk) scores NOD lateness, foreclosure excess days, the 36-month cap, property
 * condition, premium gaps and document readiness; rule 5 also names "monthly status gaps" (master policy §53 monthly updates) — a
 * missing status report for the current cycle adds 0.2 here, the same weight as a premium gap.
 */
export function curtailmentMonitor(i: CurtailmentRiskInput & { upb_cents: Cents; note_rate_pct: string; status_reports_current?: boolean }): ReturnType<typeof curtailmentRisk> & { status_gap: boolean; daily_interest_at_risk_cents: Cents; excess_interest_at_risk_cents: Cents; task: { owner: "foreclosure-ops"; kind: "diligent_servicing_evidence" } | null } {
  const base = curtailmentRisk(i);
  const statusGap = i.status_reports_current === false;
  const score = Math.min(1, Math.round((base.score + (statusGap ? 0.2 : 0)) * 100) / 100);
  const r = { ...base, score, diligence_task: score >= 0.6 };
  const daily = dailyInterestAtRisk(i.upb_cents, i.note_rate_pct);
  return { ...r, status_gap: statusGap, daily_interest_at_risk_cents: daily, excess_interest_at_risk_cents: daily * BigInt(r.projected_excess_days), task: r.diligence_task ? { owner: "foreclosure-ops", kind: "diligent_servicing_evidence" } : null };
}

/** One `mi_curtailment_risk` row (daily projection per delinquent MI-insured loan), columns as the data model names them. */
export interface MiCurtailmentRiskRow {
  readonly loan_id: string; readonly as_of: PlainDate; readonly nod_on_time: boolean; readonly status_reports_current: boolean;
  readonly fcl_days_used: number; readonly fcl_days_allowable: number; readonly allowable_delays_days: number; readonly projected_excess_days: number;
  readonly interest_months_accrued: number; readonly cap_months_remaining: number; readonly property_condition_flags: number; readonly docs_ready_pct: number; readonly risk_score: number;
}
export function curtailmentRiskRow(i: { loan_id: string; as_of: PlainDate; nod_late_days: number; status_reports_current: boolean; fcl_days_used: number; fcl_days_allowable: number; allowable_delays: number; interest_months: number; cap_months?: number; property_condition_flags: number; docs_ready_pct: number; premium_gap: boolean; upb_cents: Cents; note_rate_pct: string }): { row: MiCurtailmentRiskRow; monitor: ReturnType<typeof curtailmentMonitor> } {
  const monitor = curtailmentMonitor({ nod_late_days: i.nod_late_days, fcl_days_used: i.fcl_days_used, fcl_days_allowable: i.fcl_days_allowable, allowable_delays: i.allowable_delays, interest_months: i.interest_months, property_condition_flags: i.property_condition_flags, premium_gap: i.premium_gap, docs_ready: i.docs_ready_pct >= 100, upb_cents: i.upb_cents, note_rate_pct: i.note_rate_pct, status_reports_current: i.status_reports_current });
  const row: MiCurtailmentRiskRow = { loan_id: i.loan_id, as_of: i.as_of, nod_on_time: i.nod_late_days <= 0, status_reports_current: i.status_reports_current, fcl_days_used: i.fcl_days_used, fcl_days_allowable: i.fcl_days_allowable, allowable_delays_days: i.allowable_delays, projected_excess_days: monitor.projected_excess_days,
    interest_months_accrued: i.interest_months, cap_months_remaining: Math.max(0, (i.cap_months ?? 36) - i.interest_months), property_condition_flags: i.property_condition_flags, docs_ready_pct: i.docs_ready_pct, risk_score: monitor.score };
  return { row, monitor };
}

// ============================================================ data model — `mi_claim_events` rows (db/migrations/0036_mi_claim_events.sql)
/** The thirteen case-event kinds the spec's data model and the 0036 CHECK constraint enumerate. */
export const MI_CLAIM_EVENT_KINDS = ["filed", "doc_requested", "doc_uploaded", "message", "perfected", "eob_received", "paid", "curtailed", "denied", "rescinded", "appealed", "supplemental_filed", "closed"] as const;
export type MiClaimEventKind = (typeof MI_CLAIM_EVENT_KINDS)[number];
export type MiClaimEventSource = "micp" | "insurer" | "fnma" | "servicer" | "agent";
export interface MiClaimEventRow {
  readonly claim_id: string; readonly loan_id: string; readonly kind: MiClaimEventKind; readonly occurred_at: string; readonly source: MiClaimEventSource;
  readonly filer: Filer | null; readonly micp_request_id: string | null; readonly claim_document_id: string | null; readonly document_id: string | null;
  readonly amount_cents: Cents | null; readonly paid_to: BenefitPayee | null; readonly reason: string | null; readonly payload: Record<string, unknown>;
  readonly actor_kind: Actor["kind"]; readonly actor_id: string;
}
/** One append-only `mi_claim_events` row, columns as 0036 names them; follow-ups and insurer responses are `message` rows with a direction in the payload. */
export function miClaimEventRow(i: { claim_id: string; loan_id: string; kind: MiClaimEventKind; occurred_on: PlainDate | string; source: MiClaimEventSource; actor: Actor; filer?: Filer | null; micp_request_id?: string | null; claim_document_id?: string | null; document_id?: string | null; amount_cents?: Cents | null; paid_to?: BenefitPayee | null; reason?: string | null; payload?: Record<string, unknown> }): MiClaimEventRow {
  if (!(MI_CLAIM_EVENT_KINDS as readonly string[]).includes(i.kind)) throw new RangeError(`mi_claim_events.kind ${i.kind} is not one of ${MI_CLAIM_EVENT_KINDS.join(", ")}`);
  const at = String(i.occurred_on);
  return { claim_id: i.claim_id, loan_id: i.loan_id, kind: i.kind, occurred_at: /T/.test(at) ? at : `${at}T00:00:00.000Z`, source: i.source, filer: i.filer ?? null, micp_request_id: i.micp_request_id ?? null, claim_document_id: i.claim_document_id ?? null, document_id: i.document_id ?? null,
    amount_cents: i.amount_cents ?? null, paid_to: i.paid_to ?? null, reason: i.reason ?? null, payload: i.payload ?? {}, actor_kind: i.actor.kind, actor_id: i.actor.id };
}

// ============================================================ rule 1 — `mi_master_policy_terms` (Participants Exhibit + master-policy parameters)
export interface MasterPolicyTerms {
  readonly id: string; readonly insurer_code: string; readonly policy_form?: string | null; readonly effective_from: PlainDate | string; readonly effective_to?: PlainDate | string | null;
  readonly claim_filing_days?: number; readonly late_deny_days?: number; readonly settlement_days?: number; readonly supplemental_days?: number; readonly interest_advance_cap_months?: number;
  readonly appeal_days?: number | null; readonly micp_participant: boolean; readonly micp_effective_date?: PlainDate | string | null;
}
export interface ResolvedTerms { readonly terms_id: string | null; readonly source: "mi_master_policy_terms" | "agent_input"; readonly micp_participant: boolean; readonly micp_effective_date: PlainDate | null; readonly claim_filing_days: number; readonly late_deny_days: number; readonly settlement_days: number; readonly supplemental_days: number; readonly interest_advance_cap_months: number; readonly appeal_days: number; readonly input_disagrees: string | null; }
/** Rule 1: the loaded master-policy terms version in force on the liquidation date governs the filer test and the day counts; the agent's Participants-Exhibit reading only fills a gap (operational prerequisite 2). */
export function resolveMasterPolicyTerms(i: { insurer_code: string; liquidation_date: PlainDate; terms: readonly MasterPolicyTerms[]; input: { micp_participant: boolean; micp_effective_date: PlainDate | null; claim_filing_days?: number | null; appeal_days?: number | null } }): ResolvedTerms {
  const code = i.insurer_code.trim().toUpperCase();
  const row = i.terms.filter((t) => t.insurer_code.trim().toUpperCase() === code && String(t.effective_from) <= i.liquidation_date && (t.effective_to === undefined || t.effective_to === null || String(t.effective_to) >= i.liquidation_date)).sort((a, b) => (String(a.effective_from) < String(b.effective_from) ? 1 : -1))[0];
  if (!row) return { terms_id: null, source: "agent_input", micp_participant: i.input.micp_participant, micp_effective_date: i.input.micp_effective_date, claim_filing_days: i.input.claim_filing_days ?? 60, late_deny_days: 120, settlement_days: 60, supplemental_days: 90, interest_advance_cap_months: 36, appeal_days: i.input.appeal_days ?? 30, input_disagrees: null };
  const eff = row.micp_effective_date ? plainDate(String(row.micp_effective_date)) : null;
  const disagree: string[] = [];
  if (row.micp_participant !== i.input.micp_participant) disagree.push(`micp_participant input ${i.input.micp_participant} vs terms ${row.micp_participant}`);
  if (i.input.micp_effective_date && eff && i.input.micp_effective_date !== eff) disagree.push(`micp_effective_date input ${i.input.micp_effective_date} vs terms ${eff}`);
  return { terms_id: row.id, source: "mi_master_policy_terms", micp_participant: row.micp_participant, micp_effective_date: eff, claim_filing_days: row.claim_filing_days ?? 60, late_deny_days: row.late_deny_days ?? 120, settlement_days: row.settlement_days ?? 60, supplemental_days: row.supplemental_days ?? 90, interest_advance_cap_months: row.interest_advance_cap_months ?? 36, appeal_days: row.appeal_days ?? i.input.appeal_days ?? 30, input_disagrees: disagree.length ? disagree.join("; ") : null };
}

// ============================================================ data model — `mi_claim_calculations` row (0017 columns) from the itemized shadow
export interface MiClaimCalculationRow {
  readonly claim_id: string; readonly version: number; readonly as_of: PlainDate; readonly upb_cents: Cents; readonly interest_from: PlainDate; readonly interest_to: PlainDate; readonly interest_rate_bps: number; readonly interest_cents: Cents;
  readonly interest_months_capped: boolean; readonly advances: readonly ClaimAdvanceLine[]; readonly attorney_fee_cap_cents: Cents; readonly credits: readonly { kind: string; amount_cents: Cents }[]; readonly claim_amount_cents: Cents;
  readonly coverage_pct: string; readonly benefit_cents: Cents; readonly net_proceeds_cents: Cents | null; readonly loss_cents: Cents | null; readonly method_notes: string;
}
/** The versioned shadow computation as the table stores it: interest window, rate in bps, the advances jsonb lines, credits, caps and the method notes (open question 3). */
export function calculationRow(i: { claim_id: string; version: number; as_of: PlainDate; input: ItemizedShadowInput; shadow: ItemizedShadowClaim; cap_months?: number; cap_gate_note?: string | null }): MiClaimCalculationRow {
  const cap = i.cap_months ?? 36;
  const interestTo = i.shadow.capped ? addMonths(i.input.interest_paid_to, cap) : i.input.anchor;
  const bps = Number(Decimal.parse(i.input.note_rate_pct).mul(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP"));
  const credits = i.input.credits_cents === 0n ? [] : [{ kind: "credits", amount_cents: i.input.credits_cents }];
  const notes = [`interest: ${i.shadow.interest_months} whole month(s) at round(UPB × rate ÷ 12) = ${i.shadow.monthly_interest_cents}¢/month${i.shadow.capped ? ` (capped at ${cap} months from the default date ${i.input.default_date})` : ` + ${i.shadow.stub_days} stub day(s) at UPB × rate ÷ 365 (4 dp) = ${i.shadow.stub_cents}¢`}`,
    `attorney fees and costs ${i.shadow.attorney_fees_costs_cents}¢ vs cap ${i.shadow.attorney_cap_cents}¢ (${i.input.upb_cents >= 20_000_000n ? "3% of UPB" : "lesser of $6,000 or 5% of UPB"}, master policy §56(e))`,
    `excluded: MI premiums and technology fees ${i.shadow.excluded_cents}¢`, `benefit = round_half_up(claim_amount × ${i.input.coverage_pct}%)${i.shadow.settlement_option === "third_party_sale" ? "; TPS option: min(percentage benefit, claim_amount − net_proceeds)" : ""}`,
    ...(i.cap_gate_note ? [i.cap_gate_note] : [])];
  return { claim_id: i.claim_id, version: i.version, as_of: i.as_of, upb_cents: i.input.upb_cents, interest_from: i.input.interest_paid_to, interest_to: interestTo, interest_rate_bps: bps, interest_cents: i.shadow.interest_cents, interest_months_capped: i.shadow.capped,
    advances: i.shadow.lines, attorney_fee_cap_cents: i.shadow.attorney_cap_cents, credits, claim_amount_cents: i.shadow.claim_amount_cents, coverage_pct: i.input.coverage_pct, benefit_cents: i.shadow.benefit_cents, net_proceeds_cents: i.input.net_proceeds_cents ?? null, loss_cents: i.shadow.loss_cents, method_notes: notes.join("; ") };
}

// ============================================================ master policy §53 — the MI default watch and the insurer's default-report acceptances (T4; MI_MP_NOD_25TH / MI_MP_STATUS_MONTHLY_25TH / MI_MP_INTEREST_CAP_36M)
export interface MiDefaultStart { readonly first_unpaid_due_date: PlainDate; readonly second_missed_payment_due: PlainDate; readonly missed_payments: 2; readonly nod_due: PlainDate; readonly report_due_on: PlainDate; readonly first_status_due: PlainDate; readonly interest_cap_not_after: PlainDate; }
/**
 * The loan enters MI default when the second consecutive missed payment remains unpaid (master policy §53): the NOD is due the 25th of that
 * month, monthly status updates follow on the 25th, and interest/advances are covered for 36 months from the default (first unpaid) date.
 * Either the first unpaid due date or the second missed payment's due date fixes the other (consecutive monthly installments).
 */
export function miDefaultStart(i: { first_unpaid_due_date?: PlainDate | null; second_missed_payment_due?: PlainDate | null; cap_months?: number }): MiDefaultStart {
  const first = i.first_unpaid_due_date ?? (i.second_missed_payment_due ? addMonths(i.second_missed_payment_due, -1) : null);
  const second = i.second_missed_payment_due ?? (first ? addMonths(first, 1) : null);
  if (!first || !second) throw new RangeError("the MI default watch needs first_unpaid_due_date or second_missed_payment_due");
  if (addMonths(first, 1) !== second) throw new RangeError(`second_missed_payment_due ${second} is not the installment after first_unpaid_due_date ${first} — the missed payments must be consecutive (master policy §53)`);
  const nodDue = nodDueDate(second);
  return { first_unpaid_due_date: first, second_missed_payment_due: second, missed_payments: 2, nod_due: nodDue, report_due_on: nodDue, first_status_due: addMonths(nodDue, 1), interest_cap_not_after: addMonths(first, i.cap_months ?? 36) };
}

export type DefaultReportKind = "nod" | "monthly_status";
/** One default-reporting record as the insurer channel (portal/EDI acknowledgment) returns it — the inbound integration record the monitor ingests. */
export interface DefaultReportRecord { readonly kind: DefaultReportKind | string; readonly due_on: PlainDate | string; readonly reported_on?: PlainDate | string | null; readonly accepted_on?: PlainDate | string | null; readonly insurer_ref?: string | null; readonly period?: string | null; }
export interface IngestedDefaultReport { readonly key: string; readonly kind: DefaultReportKind; readonly period: string; readonly due_on: PlainDate; readonly reported_on: PlainDate | null; readonly accepted_on: PlainDate | null; readonly insurer_ref: string | null; readonly accepted: boolean; readonly late: boolean; readonly days_late: number; readonly excluded_interest_cents: Cents; readonly report_due_on: PlainDate; }
const isoDate = (v: unknown, what: string): PlainDate => { const s = String(v ?? ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError(`${what} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(v)}`); return plainDate(s); };
/**
 * Validates and normalizes the insurer's NOD / monthly-status records (kind, dates in order, the 25th rule for the due date) and projects the
 * lateness: days after the due date until the report was accepted (rule 5: interest/advances for that gap are excluded — T4: 5 days = $213.26).
 * `report_due_on` is the cycle anchor MI_MP_STATUS_MONTHLY_25TH re-arms from (the next update is due one month after this report's due date).
 */
export function ingestDefaultReports(i: { records: readonly DefaultReportRecord[]; upb_cents: Cents; note_rate_pct: string }): IngestedDefaultReport[] {
  return i.records.map((r) => {
    if (r.kind !== "nod" && r.kind !== "monthly_status") throw new RangeError(`default report kind ${String(r.kind)} is not nod | monthly_status`);
    const due = isoDate(r.due_on, "due_on");
    if (parts(due).d !== 25) throw new RangeError(`default report due_on ${due} is not the 25th (master policy §53: NOD by the 25th of the month of the second missed payment; monthly updates on the 25th)`);
    const reported = r.reported_on === undefined || r.reported_on === null || r.reported_on === "" ? null : isoDate(r.reported_on, "reported_on");
    const accepted = r.accepted_on === undefined || r.accepted_on === null || r.accepted_on === "" ? null : isoDate(r.accepted_on, "accepted_on");
    if (reported && accepted && accepted < reported) throw new RangeError(`default report accepted_on ${accepted} precedes reported_on ${reported}`);
    const effective = accepted ?? reported;
    const daysLate = effective ? Math.max(0, daysBetween(due, effective)) : 0;
    const x = daysLate > 0 ? nodExcludedInterest(i.upb_cents, i.note_rate_pct, due, effective!) : { days: 0, cents: 0n };
    const period = r.period ?? due.slice(0, 7);
    return { key: `${r.kind}-${period}`, kind: r.kind, period, due_on: due, reported_on: reported, accepted_on: accepted, insurer_ref: r.insurer_ref ?? null, accepted: accepted !== null, late: daysLate > 0, days_late: daysLate, excluded_interest_cents: r.kind === "nod" ? x.cents : 0n, report_due_on: due };
  });
}
/** `mi_curtailment_risk.status_reports_current`: the report due on the latest 25th at or before `as_of` (NOD or monthly update) has been accepted. */
export function statusReportsCurrent(i: { reports: readonly Pick<IngestedDefaultReport, "due_on" | "accepted">[]; nod_due: PlainDate; as_of: PlainDate }): boolean {
  if (i.as_of < i.nod_due) return true;
  let cycle = i.nod_due;
  while (addMonths(cycle, 1) <= i.as_of) cycle = addMonths(cycle, 1);
  return i.reports.some((r) => r.due_on === cycle && r.accepted);
}

// ============================================================ 36-month interest cap gate facts (MI_MP_INTEREST_CAP_36M — evaluator 15.3.interestWithinCap)
/** Facts for the `15.3.interestWithinCap` gate: interest is claimable through the day before the first uninsured installment (`first_unpaid_due_date + cap months`). */
export function interestCapFacts(i: { first_unpaid_due_date: PlainDate; interest_to: PlainDate; cap_months?: number }): { first_unpaid_due_date: PlainDate; interest_to: PlainDate; cap_months: number; not_after: PlainDate } {
  return { first_unpaid_due_date: i.first_unpaid_due_date, interest_to: i.interest_to, cap_months: i.cap_months ?? 36, not_after: addMonths(i.first_unpaid_due_date, i.cap_months ?? 36) };
}

// ============================================================ rule 7 — the CRS special remittance settlement (SM_MI_PROCEEDS_REMIT_2BD closes on it)
export interface RemittanceSettlement { readonly code: string; readonly amount_cents: Cents; readonly settled_on: PlainDate; readonly confirmation_id: string | null; readonly on_time: boolean; readonly remit_by: PlainDate | null; }
/** The CRS confirmation the special remittance settled on is validated against what was drafted (code, full amount — never netted) before the 2 BD clock closes. */
export function remittanceSettlement(i: { drafted: { crs_code: string; amount_cents: Cents } | null; remit_by: PlainDate | null; code: string; amount_cents: Cents; settled_on: PlainDate; confirmation_id?: string | null }): RemittanceSettlement {
  if (!i.drafted) throw new RangeError("no special remittance was drafted for this claim — record the servicer-received benefit first (reconcileEob{paid_to=servicer})");
  if (i.code !== i.drafted.crs_code) throw new RangeError(`CRS settlement code ${i.code} does not match the drafted special remittance code ${i.drafted.crs_code}`);
  if (i.amount_cents !== i.drafted.amount_cents) throw new RangeError(`CRS settlement of ${i.amount_cents} cents does not match the drafted ${i.drafted.amount_cents} cents — the full benefit is remitted, never netted against advances (15.3 rule 7)`);
  return { code: i.code, amount_cents: i.amount_cents, settled_on: i.settled_on, confirmation_id: i.confirmation_id ?? null, on_time: i.remit_by === null || i.settled_on <= i.remit_by, remit_by: i.remit_by };
}
