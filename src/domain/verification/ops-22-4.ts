/**
 * §22.4 operating rules — asset, reserve and cash-to-close verification: the DU statement-dating rule (R1), owner and
 * source standards (R2), large deposits (R3), the usable amount per asset (R4), gifts (R5), reserves (R6), interested-party
 * contributions (R7), the funds-to-close worksheet and its CD reconciliation (R8), the LCOR cash-back cap (R9) and
 * subordinate financing / Community Seconds (R10), plus the virtual-currency, retirement-liquidation and departing-residence
 * rules the T-ids name. Pure functions over the application aggregate; every state change is an appended event keyed by
 * `applicationId` (origination context — src/kernel/timers/engine.ts arms 22.4's gates on it). Document freshness is never
 * recomputed here: 22.1's `document.extracted{expires_at, freshness_status}` and `assertGateOpen(FNMA_B1_1_03_CREDIT_DOCS_4M)`
 * are reused (ops-22-1.ts). Nothing here changes a figure to make a worksheet balance — every change traces to a document,
 * vendor report, fee item or borrower-requested change (AI-design guardrail).
 *
 * Events (timer subject = the application):
 *   verification.received{kind=assets, verification_id, supplier_code, report_reference_id, report_days, supplemental}   DU asset verification report (arms nothing here; 23.1 cites the reference)
 *   asset.declared{asset_id, asset_type, usable_for}                                        arms FNMA_B3_4_3_10_SALE_PROCEEDS_GATE when asset_type=proceeds_real_estate_sale
 *   asset.verified{asset_id, verification_method, verified_balance_cents, usable_cents}      satisfies the sale-proceeds gate when verification_method=settlement_statement
 *   asset.rejected{asset_id, reason∈{unverified_funds, owner_mismatch, ineligible_source}}
 *   asset.deposit.flagged_large{deposit_id, amount_cents, unsourced_cents, threshold_cents}  arms FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE
 *   asset.deposit.sourced{deposit_id, source_kind, unsourced_cents} / asset.deposit.unsourced{deposit_id, reduction_cents}
 *   gift.letter.received{gift_id, complete, missing}                                          arms FNMA_B3_4_3_04_GIFT_TRANSFER_GATE
 *   gift.transfer.verified{gift_id, transfer_amount_cents, transfer_status}                   satisfies it
 *   gift.donor.interested_party_suspected{gift_id, donor_name, matched_role} + fraud.case.candidate{owner=22.6}
 *   ipc.recorded{ipc_id, kind, amount_cents}                                                  arms FNMA_B3_4_1_02_IPC_LIMIT_GATE
 *   ipc.limit.ok{max_financing_concessions_cents} / ipc.limit.exceeded{excess_cents} / ipc.excess.reclassified{adjusted_price_cents, hand_off=21.5}
 *   ipc.undisclosed.suspected{ipc_id} + fraud.case.candidate{owner=22.6}
 *   subordinate_financing.declared{kind, eligible, reason?, cltv_milli_pct, deferred_5y_or_more} (+ delivery.sfc.queued{code=118})
 *   funds_to_close.computed{stage, cash_to_close_cents, sufficient, cash_back_ok, shortfall_cents}   arms FNMA_B2_1_3_02_LCOR_CASHBACK_GATE (LCOR)
 *   funds_to_close.reconciled{cd_version} / funds_to_close.variance{cd_version, variances}
 *   lcor.cash_back.exceeded{cash_to_borrower_cents, cap_cents, overage_cents}
 *   reserves.computed{required_cents, verified_cents, sufficient, tolerance_90pct_ok} / reserves.shortfall{shortfall_cents}
 *   assets.finalized{worksheet_id, worksheet_version, usable_closing_cents, usable_reserves_cents}   feeds 23.1 final submission, 23.3 CTC_ASSETS_CASH_TO_CLOSE, 26.3 funding
 */
import { type PlainDate, addDays, daysBetween, plainDate as D, parts } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { levelPayment, Decimal, divRound } from "../../kernel/money/index.ts";
import { AGENT, RULE_SET_VERSION, type NeedsListItem } from "./ops-22-1.ts";

export { AGENT, RULE_SET_VERSION };
export const DU_RULE_SET_VERSION = "fnma.du.12.1";

// ============================================================ types (data model)
export type Transaction = "purchase" | "refinance" | "lcor" | "cash_out";
export type Occupancy = "principal_residence" | "second_home" | "investment";
export type UsableFor = "closing" | "reserves" | "both" | "none";
export type AssetType = "checking" | "savings" | "money_market" | "cd" | "brokerage_stocks_bonds_funds" | "stock_options_vested" | "retirement" | "trust" | "life_insurance_cash_value" | "business_account" | "gift" | "gift_of_equity" | "grant" | "employer_assistance" | "community_second" | "lender_contribution" | "emd" | "sale_of_personal_asset" | "proceeds_real_estate_sale" | "secured_borrowed_funds" | "bridge_loan" | "cash_on_hand_homeready" | "virtual_currency_converted" | "rent_credit" | "trade_equity" | "sweat_equity" | "ida" | "pooled_savings" | "foreign_asset" | "stock_options_nonvested" | "unsecured_loan" | "cash_on_hand" | "cash_out_proceeds" | "other";
export type VerificationMethod = "statements" | "form_1006" | "lender_system_printout" | "du_asset_report" | "liquidation_evidence" | "gift_evidence" | "grant_evidence" | "settlement_statement" | "bill_of_sale" | "buyout_agreement" | "none";
export type AssetStatus = "declared" | "documentation_requested" | "documented" | "verified" | "rejected" | "sourced" | "usable" | "finalized" | "reverified" | "withdrawn";
export type RejectReason = "unverified_funds" | "owner_mismatch" | "ineligible_source";
export type DuValidationOutcome = "validated" | "not_validated" | "not_submitted" | "not_eligible";

export interface AssetRecord {
  readonly asset_id: string; readonly application_id: string; readonly borrower_ids: readonly string[]; readonly asset_type: AssetType;
  readonly institution_name: string | null; readonly account_last4: string | null; readonly holder_names: readonly string[]; readonly owner_match: boolean;
  readonly liquid: boolean; readonly usable_for: UsableFor; readonly declared_balance_cents: bigint; readonly verified_balance_cents: bigint | null;
  readonly haircut_bps: number; readonly secured_loan_offset_cents: bigint; readonly emd_offset_cents: bigint; readonly unsourced_deposit_offset_cents: bigint;
  readonly usable_cents: bigint; readonly verification_method: VerificationMethod; readonly statement_period_start: PlainDate | null; readonly statement_period_end: PlainDate | null;
  readonly statement_count: number; readonly du_45d_ok: boolean | null; readonly b1_1_03_expires_at: PlainDate | null; readonly du_validation_outcome: DuValidationOutcome;
  readonly du_report_reference_id: string | null; readonly evidence_document_ids: readonly string[]; readonly status: AssetStatus; readonly reject_reason: RejectReason | null;
  /** B3-4.3-01/-03: securities and retirement funds count for closing only once liquidation/receipt is documented (reserves: 100 %, no withdrawal). */
  readonly liquidation_required_for_closing: boolean; readonly liquidated_cents: bigint;
}

// ============================================================ helpers
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const sum = (xs: Iterable<bigint>): bigint => { let s = 0n; for (const x of xs) s += x; return s; };
/** `value × pct / 100` in integer cents, floored (the Guide's "% of" arithmetic on cents). */
export const pctFloor = (value: bigint, pct: bigint): bigint => (value * pct) / 100n;
/** bps of a value, floored. */
export const bpsFloor = (value: bigint, bps: bigint): bigint => (value * bps) / 10000n;
/** A ratio as an integer of thousandths of a percent, rounded half-up: 412,000 ÷ 455,268 → 90.496 % → 90496. */
export function ratioMilliPct(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return Number(divRound(numerator * 100_000n, denominator, "HALF_UP"));
}
export const fmtMilliPct = (m: number): string => `${(m / 1000).toFixed(3)}%`;
export function money(c: bigint): string {
  const neg = c < 0n; const a = neg ? -c : c; const d = a / 100n; const r = a % 100n;
  return `${neg ? "-" : ""}$${d.toLocaleString("en-US")}.${String(r).padStart(2, "0")}`;
}
const nonEmpty = (v: string | null | undefined, what: string): string => { if (!v) throw new RangeError(`${what} is required`); return v; };
let seq = 0;
const ids = (prefix: string): string => `${prefix}-${++seq}`;
const appEvent = (events: EventStore, application_id: string, type: string, payload: Record<string, unknown>, actor: Actor, occurredAt?: string): DomainEvent =>
  events.append({ type, applicationId: application_id, aggregate: { kind: "application", id: application_id }, actor, ...(occurredAt ? { occurredAt } : {}), payload: { application_id, source: "origination", rule_set_version: RULE_SET_VERSION, ...payload } });

// ============================================================ R1 — statement count and dating (B3-4.4-02; B3-4.2-01)
export const DU_MONTHLY_STATEMENT_DAYS = 45;
export const DU_QUARTERLY_STATEMENT_DAYS = 90;
export interface StatementEvidence { readonly document_id: string; readonly period_start: PlainDate; readonly period_end: PlainDate; readonly quarterly?: boolean; }
export interface StatementGate {
  readonly open: boolean; readonly floor: PlainDate; readonly quarterly_floor: PlainDate; readonly required_count: 1 | 2; readonly qualifying_document_ids: string[];
  readonly most_recent_period_end: PlainDate | null; readonly request_newer: boolean; readonly satisfied_by: "statements" | "du_validation" | null; readonly reason?: string;
}
/** Purchase: two consecutive monthly statements (60 days); limited cash-out / cash-out refinance: one (30 days). */
export const requiredStatements = (transaction: Transaction): 1 | 2 => (transaction === "purchase" ? 2 : 1);
/** The DU not-before floor is anchored to the INITIAL application date and never re-bases: Oct 19 → Sept 4 (monthly) / Jul 21 (quarterly); Oct 5 → Aug 21 / Jul 7. */
export const statementFloor = (initial_application_date: PlainDate, quarterly = false): PlainDate => addDays(initial_application_date, -(quarterly ? DU_QUARTERLY_STATEMENT_DAYS : DU_MONTHLY_STATEMENT_DAYS));
/** Two statements are consecutive when the older one ends the day before the newer one starts. */
export const consecutive = (older: StatementEvidence, newer: StatementEvidence): boolean => daysBetween(older.period_end, newer.period_start) === 1;
export function statementGate(i: { transaction: Transaction; initial_application_date: PlainDate; statements: readonly StatementEvidence[]; du_validated?: boolean }): StatementGate {
  const floor = statementFloor(i.initial_application_date), quarterly_floor = statementFloor(i.initial_application_date, true);
  const required_count = requiredStatements(i.transaction);
  if (i.du_validated) return { open: true, floor, quarterly_floor, required_count, qualifying_document_ids: [], most_recent_period_end: null, request_newer: false, satisfied_by: "du_validation" };
  const sorted = [...i.statements].sort((a, b) => (a.period_end < b.period_end ? 1 : a.period_end > b.period_end ? -1 : 0));
  const newest = sorted[0];
  if (!newest) return { open: false, floor, quarterly_floor, required_count, qualifying_document_ids: [], most_recent_period_end: null, request_newer: true, satisfied_by: null, reason: `no statement in the file; ${required_count} consecutive monthly statement(s) dated on/after ${floor} required` };
  const applicableFloor = newest.quarterly ? quarterly_floor : floor;
  if (newest.period_end < applicableFloor) return { open: false, floor, quarterly_floor, required_count, qualifying_document_ids: [], most_recent_period_end: newest.period_end, request_newer: true, satisfied_by: null, reason: `most recent statement ends ${newest.period_end} < floor ${applicableFloor} (B3-4.4-02: dated within ${newest.quarterly ? 90 : 45} days of the initial application date)` };
  if (newest.quarterly) return { open: true, floor, quarterly_floor, required_count, qualifying_document_ids: [newest.document_id], most_recent_period_end: newest.period_end, request_newer: false, satisfied_by: "statements" };
  const chain = [newest];
  for (const s of sorted.slice(1)) { if (chain.length >= required_count) break; const last = chain[chain.length - 1]!; if (!s.quarterly && consecutive(s, last)) chain.push(s); else break; }
  if (chain.length < required_count) return { open: false, floor, quarterly_floor, required_count, qualifying_document_ids: chain.map((s) => s.document_id), most_recent_period_end: newest.period_end, request_newer: false, satisfied_by: null, reason: `${chain.length} of ${required_count} consecutive monthly statements in the file (B3-4.4-02: ${required_count === 2 ? "two consecutive monthly bank statements (60 days of account activity)" : "one monthly statement (30 days of account activity)"})` };
  return { open: true, floor, quarterly_floor, required_count, qualifying_document_ids: chain.map((s) => s.document_id), most_recent_period_end: newest.period_end, request_newer: false, satisfied_by: "statements" };
}
/** The needs-list line for a statement that misses the DU floor (22.1 opens the request; `NTC_SM_NEEDS_LIST` carries it). */
export function statementRequestItem(borrower_id: string, account_last4: string | null, floor: PlainDate, required_count: 1 | 2): NeedsListItem {
  // 22.1's linked-reason rule: the DU dating floor is a freshness rule (`sm_freshness`), never a free-typed item.
  return { borrower_id, doc_class: "bank_statement", qualifier: { account_last4, months: required_count, dated_on_or_after: floor, rule: "FNMA_B3_4_4_02_ASSET_STMT_45D_GATE" }, reason_code: "sm_freshness", reason_text: `${required_count === 2 ? "two consecutive monthly" : "most recent monthly"} bank statement(s) for account …${account_last4 ?? "????"} dated on/after ${floor} (B3-4.4-02: within 45 days of the initial application date)` };
}

// ============================================================ R2 — owner and source standards (B3-4.2-01)
export const ownerMatch = (holder_names: readonly string[], borrower_names: readonly string[]): boolean => {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const holders = holder_names.map(norm); return borrower_names.some((b) => holders.includes(norm(b)));
};
export interface StatementStandard { readonly institution_named: boolean; readonly holder_named: boolean; readonly last4_present: boolean; readonly period_present: boolean; readonly transactions_listed: boolean; readonly ending_balance_present: boolean; readonly form_1006_direct_from_depository?: boolean; }
export function statementStandardsMet(s: StatementStandard, method: VerificationMethod): { met: boolean; missing: string[] } {
  const missing: string[] = [];
  if (method === "form_1006") { if (s.form_1006_direct_from_depository !== true) missing.push("Form 1006 must be requested from and sent directly by the depository (B3-4.2-01)"); return { met: missing.length === 0, missing }; }
  if (!s.institution_named) missing.push("institution name"); if (!s.holder_named) missing.push("borrower as account holder"); if (!s.last4_present) missing.push("at least the last four digits of the account number");
  if (!s.period_present) missing.push("period covered"); if (!s.transactions_listed) missing.push("all deposit and withdrawal transactions"); if (!s.ending_balance_present) missing.push("ending balance");
  return { met: missing.length === 0, missing };
}

// ============================================================ R3 — large deposits (B3-4.2-02; purchase only)
export type SourceKind = "payroll" | "government_benefit" | "tax_refund" | "transfer_verified_account" | "gift" | "grant" | "sale_of_asset" | "real_estate_proceeds" | "secured_loan" | "unsecured_loan" | "virtual_currency_exchange" | "business" | "unknown";
export type DepositStatus = "not_applicable" | "flagged" | "sourced" | "partially_sourced" | "unsourced" | "waived_refinance" | "waived_du_validated";
export const READILY_IDENTIFIABLE: readonly SourceKind[] = ["payroll", "government_benefit", "tax_refund", "transfer_verified_account"];
export interface DepositSource { readonly cents: bigint; readonly kind: SourceKind; readonly readily_identifiable?: boolean; readonly evidence_document_ids?: readonly string[]; }
export interface DepositInput { readonly deposit_id: string; readonly asset_id: string; readonly posted_on: PlainDate; readonly amount_cents: bigint; readonly description_on_statement: string; readonly sources: readonly DepositSource[]; readonly du_message_id?: string | null; readonly needed_for_transaction?: boolean; }
export interface DepositResult extends DepositInput {
  readonly readily_identifiable: boolean; readonly sourced_cents: bigint; readonly unsourced_cents: bigint; readonly large_deposit: boolean; readonly status: DepositStatus; readonly source_kind: SourceKind;
  readonly reduction_cents: bigint; readonly threshold_cents: bigint; readonly source_evidence_document_ids: string[]; readonly dti_link_liability: boolean;
}
/** "A large deposit is defined as a single deposit that exceeds 50% of the total monthly qualifying income" — $8,200.00 → $4,100.00; $7,500.00 → $3,750.00. */
export const largeDepositThreshold = (total_monthly_qualifying_income_cents: bigint): bigint => pctFloor(total_monthly_qualifying_income_cents, 50n);
export function evaluateDeposit(d: DepositInput, ctx: { transaction: Transaction; threshold_cents: bigint; du_validated?: boolean }): DepositResult {
  const sourced_cents = minBig(d.amount_cents, sum(d.sources.map((s) => s.cents)));
  const unsourced_cents = d.amount_cents - sourced_cents;
  const readily_identifiable = d.sources.some((s) => s.readily_identifiable === true || READILY_IDENTIFIABLE.includes(s.kind));
  const source_kind: SourceKind = d.sources.length ? d.sources[0]!.kind : "unknown";
  const evidence = d.sources.flatMap((s) => s.evidence_document_ids ?? []);
  const dti_link_liability = d.sources.some((s) => s.kind === "unsecured_loan" || s.kind === "secured_loan");
  const base = { ...d, readily_identifiable, sourced_cents, unsourced_cents, source_kind, threshold_cents: ctx.threshold_cents, source_evidence_document_ids: evidence, dti_link_liability };
  // Refinances: "Documentation or explanation for large deposits is not required" (a deposit that evidences a new loan still opens a 22.5 liability).
  if (ctx.transaction !== "purchase") return { ...base, large_deposit: false, status: "waived_refinance", reduction_cents: 0n };
  // DU-validated accounts: only deposits named in a DU message are tested ("If no message is issued by DU, then no documentation … is required").
  if (ctx.du_validated && !d.du_message_id) return { ...base, large_deposit: false, status: "waived_du_validated", reduction_cents: 0n };
  // "only the unsourced portion must be used to calculate whether or not it must be considered a large deposit"; "exceeds" = strictly greater.
  const large_deposit = unsourced_cents > ctx.threshold_cents;
  if (!large_deposit) return { ...base, large_deposit, status: unsourced_cents === 0n ? "sourced" : d.sources.length ? "sourced" : "not_applicable", reduction_cents: 0n };
  const needed = d.needed_for_transaction !== false;
  return { ...base, large_deposit, status: d.sources.length ? "partially_sourced" : "unsourced", reduction_cents: needed ? unsourced_cents : 0n };
}
/** Evaluate every deposit on an account, apply the unsourced reduction to the account (R4 `unsourced_deposit_offset_cents`) and emit the deposit events. */
export function evaluateDeposits(events: EventStore, asset: AssetRecord, deposits: readonly DepositInput[], ctx: { transaction: Transaction; total_monthly_qualifying_income_cents: bigint; du_validated?: boolean }, actor: Actor = AGENT): { asset: AssetRecord; deposits: DepositResult[]; threshold_cents: bigint; events: DomainEvent[] } {
  const threshold_cents = largeDepositThreshold(ctx.total_monthly_qualifying_income_cents);
  const out: DomainEvent[] = []; const results: DepositResult[] = [];
  for (const d of deposits) {
    const r = evaluateDeposit(d, { transaction: ctx.transaction, threshold_cents, ...(ctx.du_validated !== undefined ? { du_validated: ctx.du_validated } : {}) });
    results.push(r);
    if (r.large_deposit) out.push(appEvent(events, asset.application_id, "asset.deposit.flagged_large", { deposit_id: r.deposit_id, asset_id: asset.asset_id, posted_on: r.posted_on, amount_cents: r.amount_cents, unsourced_cents: r.unsourced_cents, threshold_cents, status: r.status, du_message_id: r.du_message_id ?? null }, actor));
    if (r.status === "sourced") out.push(appEvent(events, asset.application_id, "asset.deposit.sourced", { deposit_id: r.deposit_id, asset_id: asset.asset_id, source_kind: r.source_kind, sourced_cents: r.sourced_cents, unsourced_cents: r.unsourced_cents, readily_identifiable: r.readily_identifiable, source_evidence_document_ids: r.source_evidence_document_ids }, actor));
    if (r.reduction_cents > 0n) out.push(appEvent(events, asset.application_id, "asset.deposit.unsourced", { deposit_id: r.deposit_id, asset_id: asset.asset_id, reduction_cents: r.reduction_cents, unsourced_cents: r.unsourced_cents, threshold_cents }, actor));
  }
  const offset = sum(results.map((r) => r.reduction_cents));
  const next = withUsable({ ...asset, unsourced_deposit_offset_cents: offset, status: results.every((r) => r.reduction_cents === 0n) && asset.status !== "declared" && asset.status !== "documentation_requested" ? "sourced" : asset.status });
  return { asset: next, deposits: results, threshold_cents, events: out };
}

// ============================================================ R4 — usable amount per asset
/** `usable_for` by asset type: lender contribution / gift of equity / IPC → closing only; cash-out proceeds → closing only (reserves-ineligible); retirement → both. */
export function usableForType(t: AssetType, ctx: { homeready?: boolean } = {}): UsableFor {
  switch (t) {
    case "lender_contribution": case "gift_of_equity": case "emd": case "rent_credit": case "trade_equity": case "sweat_equity": case "cash_out_proceeds": case "community_second": case "sale_of_personal_asset": case "proceeds_real_estate_sale": case "bridge_loan": case "secured_borrowed_funds": return "closing";
    case "cash_on_hand_homeready": return ctx.homeready ? "closing" : "none";
    case "cash_on_hand": case "unsecured_loan": case "stock_options_nonvested": return "none";
    default: return "both";
  }
}
export const LIQUIDATION_REQUIRED_TYPES: readonly AssetType[] = ["retirement", "brokerage_stocks_bonds_funds", "stock_options_vested", "life_insurance_cash_value", "trust"];
/** `usable_cents = max(0, verified − secured_loan_offset − emd_offset − unsourced_deposit_offset) × (10000 − haircut_bps) / 10000`, floored. */
export function usableCents(a: Pick<AssetRecord, "verified_balance_cents" | "secured_loan_offset_cents" | "emd_offset_cents" | "unsourced_deposit_offset_cents" | "haircut_bps" | "usable_for">): bigint {
  if (a.usable_for === "none" || a.verified_balance_cents === null) return 0n;
  const net = maxBig(0n, a.verified_balance_cents - a.secured_loan_offset_cents - a.emd_offset_cents - a.unsourced_deposit_offset_cents);
  return (net * BigInt(10000 - a.haircut_bps)) / 10000n;
}
export const withUsable = (a: AssetRecord): AssetRecord => ({ ...a, usable_cents: usableCents(a) });

// ============================================================ asset lifecycle (declare → verify/reject)
export interface DeclareAssetInput {
  readonly asset_id?: string; readonly application_id: string; readonly borrower_ids: readonly string[]; readonly asset_type: AssetType; readonly declared_balance_cents: bigint;
  readonly institution_name?: string | null; readonly account_last4?: string | null; readonly holder_names?: readonly string[]; readonly borrower_names?: readonly string[]; readonly haircut_bps?: number; readonly homeready?: boolean;
}
export function declareAsset(events: EventStore, i: DeclareAssetInput, actor: Actor = AGENT): { asset: AssetRecord; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); if (i.declared_balance_cents < 0n) throw new RangeError("declared_balance_cents must be ≥ 0");
  const holders = i.holder_names ?? []; const usable_for = usableForType(i.asset_type, { homeready: i.homeready === true });
  const asset: AssetRecord = { asset_id: i.asset_id ?? ids("asset"), application_id: i.application_id, borrower_ids: i.borrower_ids, asset_type: i.asset_type, institution_name: i.institution_name ?? null, account_last4: i.account_last4 ?? null, holder_names: holders,
    owner_match: holders.length === 0 || ownerMatch(holders, i.borrower_names ?? []), liquid: usable_for !== "none", usable_for, declared_balance_cents: i.declared_balance_cents, verified_balance_cents: null, haircut_bps: i.haircut_bps ?? 0, secured_loan_offset_cents: 0n, emd_offset_cents: 0n, unsourced_deposit_offset_cents: 0n,
    usable_cents: 0n, verification_method: "none", statement_period_start: null, statement_period_end: null, statement_count: 0, du_45d_ok: null, b1_1_03_expires_at: null, du_validation_outcome: "not_submitted", du_report_reference_id: null, evidence_document_ids: [], status: "declared", reject_reason: null,
    liquidation_required_for_closing: LIQUIDATION_REQUIRED_TYPES.includes(i.asset_type), liquidated_cents: 0n };
  const event = appEvent(events, i.application_id, "asset.declared", { asset_id: asset.asset_id, asset_type: asset.asset_type, usable_for, declared_balance_cents: asset.declared_balance_cents, institution_name: asset.institution_name, account_last4: asset.account_last4, borrower_ids: [...i.borrower_ids] }, actor);
  return { asset, event };
}
export interface VerifyAssetInput {
  readonly verification_method: VerificationMethod; readonly verified_balance_cents: bigint; readonly evidence_document_ids: readonly string[]; readonly statements?: readonly StatementEvidence[]; readonly transaction: Transaction; readonly initial_application_date: PlainDate;
  readonly standards?: StatementStandard; readonly b1_1_03_expires_at?: PlainDate | null; readonly scheduled_note_date?: PlainDate | null; readonly du_validation_outcome?: DuValidationOutcome; readonly du_report_reference_id?: string | null; readonly emd_offset_cents?: bigint; readonly secured_loan_offset_cents?: bigint;
}
/** Guards for `verified`: owner match, statement standards, the DU 45/90-day rule with the required count, and 22.1's freshness (`expires_at ≥ scheduled_note_date` — read from `document.extracted`, never recomputed here). */
export function verifyAsset(events: EventStore, asset: AssetRecord, v: VerifyAssetInput, actor: Actor = AGENT): { asset: AssetRecord; event: DomainEvent; gate: StatementGate | null; rejected: boolean } {
  const reject = (reason: RejectReason, detail: string): { asset: AssetRecord; event: DomainEvent; gate: StatementGate | null; rejected: true } => {
    const next: AssetRecord = { ...asset, status: "rejected", reject_reason: reason, usable_cents: 0n };
    return { asset: next, event: appEvent(events, asset.application_id, "asset.rejected", { asset_id: asset.asset_id, reason, detail }, actor), gate: null, rejected: true };
  };
  if (!asset.owner_match) return reject("owner_mismatch", "no borrower among the account holders (B3-4.2-01)");
  if (asset.usable_for === "none") return reject("ineligible_source", `${asset.asset_type} is not an acceptable source of funds`);
  if (v.standards) { const s = statementStandardsMet(v.standards, v.verification_method); if (!s.met) return reject("unverified_funds", `statement standard not met: ${s.missing.join("; ")}`); }
  let gate: StatementGate | null = null;
  const depository = ["checking", "savings", "money_market", "cd", "business_account"].includes(asset.asset_type);
  if (depository && v.verification_method !== "du_asset_report") {
    gate = statementGate({ transaction: v.transaction, initial_application_date: v.initial_application_date, statements: v.statements ?? [], du_validated: v.du_validation_outcome === "validated" });
    if (!gate.open) return { asset: withUsable({ ...asset, status: "documentation_requested", du_45d_ok: false, statement_count: gate.qualifying_document_ids.length, statement_period_end: gate.most_recent_period_end }), event: appEvent(events, asset.application_id, "asset.documentation.requested", { asset_id: asset.asset_id, reason: gate.reason ?? "statement floor", floor: gate.floor, required_count: gate.required_count }, actor), gate, rejected: false };
  }
  if (v.b1_1_03_expires_at && v.scheduled_note_date && v.b1_1_03_expires_at < v.scheduled_note_date) return reject("unverified_funds", `most recent statement expired ${v.b1_1_03_expires_at} before the note date ${v.scheduled_note_date} (B1-1-03; 22.1 freshness)`);
  const stmts = [...(v.statements ?? [])].sort((a, b) => (a.period_end < b.period_end ? 1 : -1));
  const next = withUsable({ ...asset, status: "verified", verification_method: v.verification_method, verified_balance_cents: v.verified_balance_cents, evidence_document_ids: [...v.evidence_document_ids], statement_period_start: stmts.length ? stmts[stmts.length - 1]!.period_start : asset.statement_period_start, statement_period_end: stmts[0]?.period_end ?? asset.statement_period_end,
    statement_count: gate ? gate.qualifying_document_ids.length : asset.statement_count, du_45d_ok: gate ? true : asset.du_45d_ok, b1_1_03_expires_at: v.b1_1_03_expires_at ?? asset.b1_1_03_expires_at, du_validation_outcome: v.du_validation_outcome ?? asset.du_validation_outcome, du_report_reference_id: v.du_report_reference_id ?? asset.du_report_reference_id,
    emd_offset_cents: v.emd_offset_cents ?? asset.emd_offset_cents, secured_loan_offset_cents: v.secured_loan_offset_cents ?? asset.secured_loan_offset_cents });
  const event = appEvent(events, asset.application_id, "asset.verified", { asset_id: asset.asset_id, asset_type: asset.asset_type, verification_method: v.verification_method, verified_balance_cents: v.verified_balance_cents, usable_cents: next.usable_cents, usable_for: next.usable_for, statement_period_end: next.statement_period_end, du_45d_ok: next.du_45d_ok, evidence_document_ids: [...v.evidence_document_ids] }, actor);
  return { asset: next, event, gate, rejected: false };
}

// ============================================================ DU asset verification reports (B3-2-02) → `verification.received{kind=assets}`
export interface AssetReportInput { readonly application_id: string; readonly borrower_id: string; readonly supplier_code: string; readonly report_reference_id: string; readonly report_days: 30 | 60 | 90 | 365; readonly accounts: readonly { institution: string; last4: string; balance_cents: bigint; period_start: PlainDate; period_end: PlainDate }[]; readonly large_deposit_messages?: readonly { du_message_id: string; institution: string; last4: string; amount_cents: bigint }[]; readonly supplemental?: boolean; readonly vendor_data_as_of: PlainDate; readonly report_document_id: string; readonly authorization_consent_id: string; readonly verification_id?: string; }
export const DU_ASSET_REPORT_SUPPLIERS = ["accountchek", "blend", "finicity", "finlocker", "plaid", "pointserv", "truv"] as const;
export interface AssetVerification { readonly verification_id: string; readonly application_id: string; readonly borrower_id: string; readonly kind: "assets"; readonly component: "assets"; readonly supplier_code: string; readonly report_reference_id: string; readonly vendor_data_as_of: PlainDate; readonly report_days: number; readonly accounts: AssetReportInput["accounts"]; readonly large_deposit_messages: NonNullable<AssetReportInput["large_deposit_messages"]>; readonly supplemental: boolean; readonly report_document_id: string; readonly authorization_consent_id: string; }
export const reportDaysFor = (transaction: Transaction, for_income = false): 30 | 60 | 365 => (for_income ? 365 : transaction === "purchase" ? 60 : 30);
export function receiveAssetReport(events: EventStore, r: AssetReportInput, actor: Actor = AGENT): { verification: AssetVerification; event: DomainEvent } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.report_reference_id, "report_reference_id"); nonEmpty(r.authorization_consent_id, "authorization_consent_id (B3-2-02: borrower authorization)");
  if (!(DU_ASSET_REPORT_SUPPLIERS as readonly string[]).includes(r.supplier_code.toLowerCase())) throw new RangeError(`${r.supplier_code} is not a DU validation service asset report supplier (00b-orig F1: ${DU_ASSET_REPORT_SUPPLIERS.join(", ")})`);
  const verification: AssetVerification = { verification_id: r.verification_id ?? ids("ver"), application_id: r.application_id, borrower_id: r.borrower_id, kind: "assets", component: "assets", supplier_code: r.supplier_code, report_reference_id: r.report_reference_id, vendor_data_as_of: r.vendor_data_as_of, report_days: r.report_days, accounts: r.accounts, large_deposit_messages: r.large_deposit_messages ?? [], supplemental: r.supplemental === true, report_document_id: r.report_document_id, authorization_consent_id: r.authorization_consent_id };
  const event = events.append({ type: "verification.received", applicationId: r.application_id, aggregate: { kind: "application", id: r.application_id }, actor, payload: { kind: "assets", verification_id: verification.verification_id, borrower_id: r.borrower_id, supplier_code: r.supplier_code, report_reference_id: r.report_reference_id, vendor_data_as_of: r.vendor_data_as_of, report_days: r.report_days, supplemental: verification.supplemental, accounts: r.accounts.length, large_deposit_messages: verification.large_deposit_messages.length, report_document_id: r.report_document_id, authorization_consent_id: r.authorization_consent_id, application_id: r.application_id } });
  return { verification, event };
}

// ============================================================ R5 — gifts (B3-4.3-04 / -05)
export type GiftKind = "personal_gift" | "gift_of_equity" | "grant" | "employer_assistance";
export type GiftStatus = "declared" | "letter_received" | "transfer_verified" | "complete" | "rejected";
export type TransferStatus = "not_transferred" | "transferred_to_borrower" | "transferred_to_closing_agent" | "at_settlement_official_check";
export type InterestedPartyCheck = "clear" | "match" | "unresolved";
export const RELATIVE_RELATIONSHIPS = ["spouse", "child", "parent", "dependent", "sibling", "grandparent", "grandchild", "aunt", "uncle", "cousin", "in_law", "adoptive", "legal_guardian", "relative_by_blood", "relative_by_marriage"] as const;
export const FAMILIAL_RELATIONSHIPS = ["domestic_partner", "relative_of_domestic_partner", "fiance", "former_relative", "long_standing_familial_like", "mentorship"] as const;
export const isAcceptableDonorRelationship = (r: string): boolean => (RELATIVE_RELATIONSHIPS as readonly string[]).includes(r) || (FAMILIAL_RELATIONSHIPS as readonly string[]).includes(r);
export interface GiftLetter { readonly letter_document_id: string; readonly donor_name: string; readonly donor_address: string | null; readonly donor_phone: string | null; readonly relationship: string; readonly amount_stated_cents: bigint; readonly amount_is_maximum: boolean; readonly no_repayment_statement: boolean; }
export interface GiftRecord {
  readonly gift_id: string; readonly application_id: string; readonly asset_id: string | null; readonly kind: GiftKind; readonly donor_name: string; readonly donor_address: string | null; readonly donor_phone: string | null; readonly relationship: string;
  readonly donor_interested_party_check: InterestedPartyCheck; readonly letter_document_id: string | null; readonly amount_stated_cents: bigint; readonly amount_is_maximum: boolean; readonly no_repayment_statement: boolean; readonly transfer_status: TransferStatus;
  readonly transfer_evidence_document_ids: readonly string[]; readonly transfer_amount_cents: bigint; readonly pooled_with_borrower: boolean; readonly shared_residency_certification_document_id: string | null; readonly usable_for: UsableFor; readonly status: GiftStatus; readonly reject_reason: string | null;
}
export function giftLetterCheck(l: GiftLetter): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!l.donor_name) missing.push("donor's name"); if (!l.donor_address) missing.push("donor's address"); if (!l.donor_phone) missing.push("donor's telephone number");
  if (!l.relationship) missing.push("relationship to the borrower"); if (l.amount_stated_cents <= 0n) missing.push("the actual or the maximum dollar amount of the gift");
  if (!l.no_repayment_statement) missing.push("the donor's statement that no repayment is expected");
  return { complete: missing.length === 0, missing };
}
/** "The donor may not be, or have any affiliation with, the builder, the developer, the real estate agent, or any other interested party to the transaction." */
export interface TransactionParty { readonly name: string; readonly role: "seller" | "builder" | "developer" | "listing_agent" | "buyer_agent" | "broker" | "affiliate" | "lender_affiliate" | "other_interested"; readonly affiliates?: readonly string[]; }
export function donorInterestedPartyCheck(donor: { name: string; affiliations?: readonly string[] }, parties: readonly TransactionParty[]): { result: InterestedPartyCheck; matched_role: string | null; matched_name: string | null } {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " "); const dn = norm(donor.name); const aff = (donor.affiliations ?? []).map(norm);
  for (const p of parties) {
    const names = [p.name, ...(p.affiliates ?? [])].map(norm);
    if (names.includes(dn) || names.some((n) => aff.includes(n))) return { result: "match", matched_role: p.role, matched_name: p.name };
  }
  return { result: parties.length ? "clear" : "unresolved", matched_role: null, matched_name: null };
}
export const giftNeedsListItem = (borrower_id: string, gift_id: string, missing: readonly string[]): NeedsListItem => ({ borrower_id, doc_class: "gift_letter", qualifier: { gift_id }, reason_code: "sm_gift_letter_incomplete", reason_text: `corrected gift letter including ${missing.join(", ")} (B3-4.3-04)` });
export interface GiftContext { readonly borrower_id: string; readonly occupancy: Occupancy; readonly parties?: readonly TransactionParty[]; readonly donor_affiliations?: readonly string[]; }
/** A gift letter lands: complete → `letter_received` and the transfer gate arms; incomplete → `letter_received` with a needs-list item; interested-party donor or investment property → `rejected` (22.6 case). */
export function receiveGiftLetter(events: EventStore, g: { gift_id?: string; application_id: string; asset_id?: string | null; kind: GiftKind }, letter: GiftLetter, ctx: GiftContext, actor: Actor = AGENT): { gift: GiftRecord; event: DomainEvent; needs_list_item: NeedsListItem | null; fraud_case: DomainEvent | null } {
  const check = giftLetterCheck(letter); const ip = donorInterestedPartyCheck({ name: letter.donor_name, ...(ctx.donor_affiliations ? { affiliations: ctx.donor_affiliations } : {}) }, ctx.parties ?? []);
  const gift_id = g.gift_id ?? ids("gift");
  let gift: GiftRecord = { gift_id, application_id: g.application_id, asset_id: g.asset_id ?? null, kind: g.kind, donor_name: letter.donor_name, donor_address: letter.donor_address, donor_phone: letter.donor_phone, relationship: letter.relationship, donor_interested_party_check: ip.result, letter_document_id: letter.letter_document_id,
    amount_stated_cents: letter.amount_stated_cents, amount_is_maximum: letter.amount_is_maximum, no_repayment_statement: letter.no_repayment_statement, transfer_status: "not_transferred", transfer_evidence_document_ids: [], transfer_amount_cents: 0n, pooled_with_borrower: false, shared_residency_certification_document_id: null,
    usable_for: g.kind === "gift_of_equity" ? "closing" : "both", status: "letter_received", reject_reason: null };
  if (ctx.occupancy === "investment") return rejectGift(events, gift, "investment_property", "Gifts are not allowed on an investment property (B3-4.3-04)", actor);
  if (ip.result === "match") return rejectGift(events, gift, "interested_party_donor", `donor ${letter.donor_name} is (or is affiliated with) the ${ip.matched_role} ${ip.matched_name} (B3-4.3-04)`, actor, ip.matched_role);
  if (g.kind === "personal_gift" && !isAcceptableDonorRelationship(letter.relationship)) return rejectGift(events, gift, "ineligible_donor", `relationship ${letter.relationship} is not a relative or familial relationship (B3-4.3-04)`, actor);
  const needs_list_item = check.complete ? null : giftNeedsListItem(ctx.borrower_id, gift_id, check.missing);
  gift = { ...gift, status: "letter_received" };
  const event = appEvent(events, g.application_id, "gift.letter.received", { gift_id, kind: g.kind, donor_name: letter.donor_name, relationship: letter.relationship, amount_stated_cents: letter.amount_stated_cents, amount_is_maximum: letter.amount_is_maximum, complete: check.complete, missing: check.missing, donor_interested_party_check: ip.result, letter_document_id: letter.letter_document_id }, actor);
  return { gift, event, needs_list_item, fraud_case: null };
}
export function rejectGift(events: EventStore, gift: GiftRecord, reason: string, detail: string, actor: Actor = AGENT, matched_role: string | null = null): { gift: GiftRecord; event: DomainEvent; needs_list_item: null; fraud_case: DomainEvent | null } {
  const next: GiftRecord = { ...gift, status: "rejected", reject_reason: reason };
  const event = appEvent(events, gift.application_id, "asset.rejected", { asset_id: gift.asset_id ?? gift.gift_id, gift_id: gift.gift_id, reason: "ineligible_source", reject_reason: reason, detail }, actor);
  let fraud_case: DomainEvent | null = null;
  if (reason === "interested_party_donor") {
    appEvent(events, gift.application_id, "gift.donor.interested_party_suspected", { gift_id: gift.gift_id, donor_name: gift.donor_name, matched_role, hand_off: "22.6" }, actor);
    fraud_case = appEvent(events, gift.application_id, "fraud.case.candidate", { gift_id: gift.gift_id, opened_by: "22.4", owner: "22.6", reason: "gift.donor.interested_party_suspected", detail }, actor);
  }
  return { gift: next, event, needs_list_item: null, fraud_case };
}
export interface GiftTransferEvidence { readonly kind: "donor_check_and_deposit_slip" | "donor_withdrawal_and_deposit_slip" | "electronic_transfer" | "donor_check_to_closing_agent" | "settlement_statement" | "official_check_at_settlement"; readonly transfer_amount_cents: bigint; readonly evidence_document_ids: readonly string[]; readonly transferred_on: PlainDate; readonly to: "borrower" | "closing_agent"; }
/** Transfer evidence per B3-4.3-04 → `transfer_verified` (usable = min(stated/maximum, transferred)). Requires a complete letter first. */
export function verifyGiftTransfer(events: EventStore, gift: GiftRecord, t: GiftTransferEvidence, actor: Actor = AGENT): { gift: GiftRecord; event: DomainEvent; usable_cents: bigint } {
  if (gift.status === "rejected") throw new RangeError(`gift ${gift.gift_id} is rejected (${gift.reject_reason})`);
  const check = giftLetterCheck({ letter_document_id: gift.letter_document_id ?? "", donor_name: gift.donor_name, donor_address: gift.donor_address, donor_phone: gift.donor_phone, relationship: gift.relationship, amount_stated_cents: gift.amount_stated_cents, amount_is_maximum: gift.amount_is_maximum, no_repayment_statement: gift.no_repayment_statement });
  if (!check.complete) throw new RangeError(`gift ${gift.gift_id}: the letter is incomplete (${check.missing.join(", ")}); transfer evidence cannot close the gate`);
  if (t.evidence_document_ids.length === 0) throw new RangeError("transfer evidence document ids are required (B3-4.3-04)");
  const transfer_status: TransferStatus = t.kind === "official_check_at_settlement" ? "at_settlement_official_check" : t.to === "closing_agent" ? "transferred_to_closing_agent" : "transferred_to_borrower";
  const usable_cents = minBig(gift.amount_stated_cents, t.transfer_amount_cents);
  const next: GiftRecord = { ...gift, status: "transfer_verified", transfer_status, transfer_amount_cents: t.transfer_amount_cents, transfer_evidence_document_ids: [...t.evidence_document_ids] };
  const event = appEvent(events, gift.application_id, "gift.transfer.verified", { gift_id: gift.gift_id, transfer_amount_cents: t.transfer_amount_cents, transfer_status, evidence_kind: t.kind, transferred_on: t.transferred_on, usable_cents, evidence_document_ids: [...t.evidence_document_ids] }, actor);
  return { gift: next, event, usable_cents };
}
/** Correct an incomplete letter (the corrected letter is a new document) — status stays `letter_received` until the transfer is evidenced. */
export function correctGiftLetter(gift: GiftRecord, letter: GiftLetter): { gift: GiftRecord; complete: boolean; missing: string[] } {
  const c = giftLetterCheck(letter);
  return { gift: { ...gift, letter_document_id: letter.letter_document_id, donor_address: letter.donor_address, donor_phone: letter.donor_phone, amount_stated_cents: letter.amount_stated_cents, amount_is_maximum: letter.amount_is_maximum, no_repayment_statement: letter.no_repayment_statement }, complete: c.complete, missing: c.missing };
}
/** Minimum borrower contribution from own funds: 5 % × price only for 2–4 unit principal residences and second homes above 80 % LTV/CLTV/HCLTV. */
export function minimumBorrowerContribution(i: { occupancy: Occupancy; units: number; ltv_milli_pct: number; cltv_milli_pct?: number; hcltv_milli_pct?: number; sales_price_cents: bigint }): bigint {
  const above80 = Math.max(i.ltv_milli_pct, i.cltv_milli_pct ?? 0, i.hcltv_milli_pct ?? 0) > 80_000;
  const applies = above80 && ((i.occupancy === "principal_residence" && i.units >= 2) || i.occupancy === "second_home");
  return applies ? pctFloor(i.sales_price_cents, 5n) : 0n;
}

// ============================================================ EMD (B3-4.3-09) and virtual currency (B3-4.1-04)
export interface EmdInput { readonly amount_cents: bigint; readonly paid_in: "check" | "wire" | "cashiers_check" | "virtual_currency" | "cash" | "third_party"; readonly source_account_average_two_month_balance_cents?: bigint | null; readonly cleared_on?: PlainDate | null; readonly statement_period_end?: PlainDate | null; }
export function emdCheck(e: EmdInput): { accepted: boolean; reject_reason: string | null; emd_offset_applies: boolean; gift_rules_apply: boolean } {
  if (e.paid_in === "virtual_currency") return { accepted: false, reject_reason: "Virtual currency may not be used for the deposit on the sales contract (earnest money) (B3-4.1-04)", emd_offset_applies: false, gift_rules_apply: false };
  if (e.paid_in === "cash") return { accepted: false, reject_reason: "cash-on-hand is not an acceptable source (B3-4.3-20)", emd_offset_applies: false, gift_rules_apply: false };
  if (e.source_account_average_two_month_balance_cents !== undefined && e.source_account_average_two_month_balance_cents !== null && e.source_account_average_two_month_balance_cents < e.amount_cents) return { accepted: false, reject_reason: "average balance for the past two months does not support the deposit (B3-4.3-09)", emd_offset_applies: false, gift_rules_apply: false };
  // The EMD check cleared after the statement's period end → the balance still contains the funds the CD credits as "Deposit" (R4 emd_offset).
  const emd_offset_applies = !!(e.cleared_on && e.statement_period_end && e.cleared_on > e.statement_period_end);
  return { accepted: true, reject_reason: null, emd_offset_applies, gift_rules_apply: e.paid_in === "third_party" };
}
export interface VirtualCurrencyInput { readonly balance_cents: bigint; readonly exchange_us_regulated: boolean; readonly exchanged_to_usd_evidence_document_ids?: readonly string[]; readonly settlement_deposit?: { deposit_id: string; posted_on: PlainDate; amount_cents: bigint; institution_us_regulated: boolean; exchange_statement_document_id: string } | null; }
/** "documented evidence that the virtual currency has been exchanged into U.S. dollars", "held in a U.S. or state regulated financial institution", "verified in U.S. dollars prior to the loan closing". */
export function virtualCurrencyUsable(v: VirtualCurrencyInput): { usable_cents: bigint; conditions: string[]; deposit: DepositResult | null } {
  const conditions: string[] = [];
  if (!(v.exchanged_to_usd_evidence_document_ids?.length)) conditions.push("evidence that the virtual currency has been exchanged into U.S. dollars (exchange statement)");
  if (!v.settlement_deposit || !v.settlement_deposit.institution_us_regulated) conditions.push("deposit of the proceeds into a U.S. or state regulated financial institution, verified in U.S. dollars");
  if (conditions.length) return { usable_cents: 0n, conditions, deposit: null };
  const d = v.settlement_deposit!;
  const deposit = evaluateDeposit({ deposit_id: d.deposit_id, asset_id: "", posted_on: d.posted_on, amount_cents: d.amount_cents, description_on_statement: "virtual currency exchange settlement", sources: [{ cents: d.amount_cents, kind: "virtual_currency_exchange", evidence_document_ids: [d.exchange_statement_document_id, ...(v.exchanged_to_usd_evidence_document_ids ?? [])] }] }, { transaction: "purchase", threshold_cents: 0n });
  return { usable_cents: minBig(v.balance_cents, d.amount_cents), conditions, deposit };
}

// ============================================================ retirement / securities used for closing (B3-4.3-01 / -03)
export interface RetirementUseInput { readonly vested_balance_cents: bigint; readonly vested: boolean; readonly withdrawable_regardless_of_employment: boolean; readonly needed_for_closing_cents: bigint; readonly withdrawal_fees_cents?: bigint; readonly liquidation_evidence_document_ids?: readonly string[]; }
export interface RetirementUse { readonly usable_for_reserves_cents: bigint; readonly usable_for_closing_cents: bigint; readonly withdrawal_required: boolean; readonly withdrawn_cents: bigint; readonly reserves_after_withdrawal_cents: bigint; readonly condition: { kind: "PTD"; code: "liquidation_evidence"; text: string } | null; readonly excluded_reason: string | null; }
export function retirementUse(i: RetirementUseInput): RetirementUse {
  const fees = i.withdrawal_fees_cents ?? 0n;
  if (!i.vested) return { usable_for_reserves_cents: 0n, usable_for_closing_cents: 0n, withdrawal_required: false, withdrawn_cents: 0n, reserves_after_withdrawal_cents: 0n, condition: null, excluded_reason: "funds that have not been vested are excluded (B3-4.1-01)" };
  if (!i.withdrawable_regardless_of_employment) return { usable_for_reserves_cents: i.vested_balance_cents, usable_for_closing_cents: 0n, withdrawal_required: false, withdrawn_cents: 0n, reserves_after_withdrawal_cents: i.vested_balance_cents, condition: null, excluded_reason: "hardship-only withdrawal restriction: reserves only (B3-4.3-03)" };
  if (i.needed_for_closing_cents <= 0n) return { usable_for_reserves_cents: i.vested_balance_cents, usable_for_closing_cents: 0n, withdrawal_required: false, withdrawn_cents: 0n, reserves_after_withdrawal_cents: i.vested_balance_cents, condition: null, excluded_reason: null };
  const withdrawn = minBig(i.vested_balance_cents, i.needed_for_closing_cents);
  const evidenced = (i.liquidation_evidence_document_ids?.length ?? 0) > 0;
  return { usable_for_reserves_cents: i.vested_balance_cents, usable_for_closing_cents: evidenced ? withdrawn : 0n, withdrawal_required: true, withdrawn_cents: withdrawn, reserves_after_withdrawal_cents: maxBig(0n, i.vested_balance_cents - withdrawn - fees),
    condition: evidenced ? null : { kind: "PTD", code: "liquidation_evidence", text: `evidence of the borrower's actual receipt of ${money(withdrawn)} withdrawn from the retirement account (B3-4.3-03)` }, excluded_reason: null };
}
/** B3-4.3-01: securities used for closing need liquidation evidence unless the value exceeds the amount needed by 20 % or more. */
export const securitiesLiquidationEvidenceRequired = (value_cents: bigint, needed_cents: bigint): boolean => value_cents * 100n < needed_cents * 120n;

// ============================================================ R6 — reserves (B3-4.1-01; DU findings)
export type ReserveBasis = "du_findings" | "b3_4_1_01_occupancy" | "b3_4_1_01_multiple_financed" | "employment_offer_option_2" | "nontraditional_credit";
export interface ReservesInput { readonly occupancy: Occupancy; readonly units: number; readonly transaction: Transaction; readonly dti_bps?: number; readonly qualifying_pitia_cents: bigint; readonly du_reserves_required_cents?: bigint | null; readonly other_financed_upb_cents?: readonly bigint[]; readonly financed_property_count?: number; readonly employment_offer_reserves_cents?: bigint; readonly nontraditional_credit_reserves_cents?: bigint; }
export interface ReserveCalculation { readonly basis: ReserveBasis; readonly months: number; readonly pitia_cents: bigint; readonly formula_cents: bigint; readonly du_required_cents: bigint | null; readonly other_financed_upb_cents: bigint; readonly financed_property_count: number; readonly pct_bps: number; readonly other_financed_cents: bigint; readonly additional_cents: bigint; readonly required_cents: bigint; }
export function reserveMonths(i: Pick<ReservesInput, "occupancy" | "units" | "transaction" | "dti_bps">): 0 | 2 | 6 {
  if (i.occupancy === "second_home") return 2;
  if (i.occupancy === "investment" || (i.occupancy === "principal_residence" && i.units >= 2) || (i.transaction === "cash_out" && (i.dti_bps ?? 0) > 4500)) return 6;
  return 0;
}
/** 2 % (one to four financed properties), 4 % (five to six), 6 % (seven to ten, DU only). */
export function otherFinancedPctBps(financed_property_count: number): 0 | 200 | 400 | 600 {
  if (financed_property_count <= 0) return 0; if (financed_property_count <= 4) return 200; if (financed_property_count <= 6) return 400; if (financed_property_count <= 10) return 600;
  throw new RangeError(`${financed_property_count} financed properties exceeds the DU maximum of ten (B2-2-03)`);
}
export function reservesRequired(i: ReservesInput): ReserveCalculation {
  const months = reserveMonths(i); const formula_cents = BigInt(months) * i.qualifying_pitia_cents;
  const du = i.du_reserves_required_cents ?? null; const base = maxBig(du ?? 0n, formula_cents);
  const upbs = i.other_financed_upb_cents ?? []; const other_upb = sum(upbs); const count = i.financed_property_count ?? (upbs.length ? upbs.length + 1 : 0);
  const pct_bps = upbs.length ? otherFinancedPctBps(count) : 0; const other_financed_cents = bpsFloor(other_upb, BigInt(pct_bps));
  const additional_cents = (i.employment_offer_reserves_cents ?? 0n) + (i.nontraditional_credit_reserves_cents ?? 0n);
  const basis: ReserveBasis = upbs.length ? "b3_4_1_01_multiple_financed" : i.employment_offer_reserves_cents ? "employment_offer_option_2" : i.nontraditional_credit_reserves_cents ? "nontraditional_credit" : du !== null && du >= formula_cents ? "du_findings" : "b3_4_1_01_occupancy";
  return { basis, months, pitia_cents: i.qualifying_pitia_cents, formula_cents, du_required_cents: du, other_financed_upb_cents: other_upb, financed_property_count: count, pct_bps, other_financed_cents, additional_cents, required_cents: base + other_financed_cents + additional_cents };
}
/** 23.1's B3-2-10 tolerance: verified reserves below 90 % of the findings' requirement force a resubmission; the SM gate needs the full amount. */
export function reserveTolerance(verified_cents: bigint, required_cents: bigint): { sufficient: boolean; tolerance_90pct_ok: boolean; resubmission_required: boolean; resubmission_rule: "B3_2_10_RESERVES_90PCT" | null; shortfall_cents: bigint } {
  const tolerance_90pct_ok = verified_cents * 100n >= required_cents * 90n;
  return { sufficient: verified_cents >= required_cents, tolerance_90pct_ok, resubmission_required: !tolerance_90pct_ok, resubmission_rule: tolerance_90pct_ok ? null : "B3_2_10_RESERVES_90PCT", shortfall_cents: maxBig(0n, required_cents - verified_cents) };
}
export function computeReserves(events: EventStore, i: ReservesInput & { application_id: string; verified_reserves_cents: bigint; worksheet_id?: string | null }, actor: Actor = AGENT): { calc: ReserveCalculation & { calc_id: string; verified_cents: bigint; tolerance_90pct_ok: boolean; sufficient: boolean; worksheet_id: string | null }; tolerance: ReturnType<typeof reserveTolerance>; event: DomainEvent; shortfall_event: DomainEvent | null } {
  const c = reservesRequired(i); const t = reserveTolerance(i.verified_reserves_cents, c.required_cents);
  const calc = { ...c, calc_id: ids("rsv"), verified_cents: i.verified_reserves_cents, tolerance_90pct_ok: t.tolerance_90pct_ok, sufficient: t.sufficient, worksheet_id: i.worksheet_id ?? null };
  const event = appEvent(events, i.application_id, "reserves.computed", { calc_id: calc.calc_id, basis: c.basis, months: c.months, required_cents: c.required_cents, du_required_cents: c.du_required_cents, other_financed_cents: c.other_financed_cents, pct_bps: c.pct_bps, verified_cents: i.verified_reserves_cents, sufficient: t.sufficient, tolerance_90pct_ok: t.tolerance_90pct_ok, resubmission_rule: t.resubmission_rule }, actor);
  const shortfall_event = t.sufficient ? null : appEvent(events, i.application_id, "reserves.shortfall", { calc_id: calc.calc_id, shortfall_cents: t.shortfall_cents, required_cents: c.required_cents, verified_cents: i.verified_reserves_cents, resubmission_required: t.resubmission_required, resubmission_rule: t.resubmission_rule, restructure_owner: "23.2" }, actor);
  return { calc, tolerance: t, event, shortfall_event };
}

// ============================================================ R7 — interested-party contributions (B3-4.1-02)
export type IpcKind = "financing_concession" | "sales_concession" | "common_customary_fee" | "buydown_subsidy" | "hoa_prepaid" | "lender_incentive" | "undisclosed_suspected";
export type PayerRole = "seller" | "builder" | "developer" | "agent" | "broker" | "affiliate" | "lender_as_interested_party" | "lender";
export interface IpcItem { readonly ipc_id: string; readonly application_id: string; readonly payer_party_id: string; readonly payer_role: PayerRole; readonly kind: IpcKind; readonly amount_cents: bigint; readonly disclosed_on_settlement: boolean; readonly counts_toward_limit: boolean; readonly evidence_document_ids: readonly string[]; readonly status: "declared" | "verified" | "excess_reclassified" | "rejected"; readonly hoa_months?: number; readonly funded_by_interested_party?: boolean; }
export const INTERESTED_PARTY_ROLES: readonly PayerRole[] = ["seller", "builder", "developer", "agent", "broker", "affiliate", "lender_as_interested_party"];
/** Which items count toward the financing-concession limit: financing concessions, interested-party-funded buydown subsidies, HOA prepaid ≤ 12 months; common-and-customary seller fees, gifts of equity and sales concessions do not. */
export function countsTowardLimit(i: Pick<IpcItem, "kind" | "payer_role" | "hoa_months" | "funded_by_interested_party">): boolean {
  if (!INTERESTED_PARTY_ROLES.includes(i.payer_role) && i.payer_role !== "lender") return false;
  switch (i.kind) {
    case "financing_concession": return true;
    case "buydown_subsidy": return i.funded_by_interested_party !== false;
    case "hoa_prepaid": return (i.hoa_months ?? 0) <= 12;
    default: return false;
  }
}
export function recordIpc(events: EventStore, i: Omit<IpcItem, "counts_toward_limit" | "status" | "ipc_id"> & { ipc_id?: string }, actor: Actor = AGENT): { item: IpcItem; event: DomainEvent; undisclosed: DomainEvent | null } {
  if (i.amount_cents < 0n) throw new RangeError("amount_cents must be ≥ 0");
  const item: IpcItem = { ...i, ipc_id: i.ipc_id ?? ids("ipc"), counts_toward_limit: countsTowardLimit(i), status: i.kind === "undisclosed_suspected" ? "rejected" : "declared" };
  const event = appEvent(events, i.application_id, "ipc.recorded", { ipc_id: item.ipc_id, kind: item.kind, payer_role: item.payer_role, amount_cents: item.amount_cents, counts_toward_limit: item.counts_toward_limit, disclosed_on_settlement: item.disclosed_on_settlement }, actor);
  let undisclosed: DomainEvent | null = null;
  if (item.kind === "undisclosed_suspected" || !item.disclosed_on_settlement) {
    appEvent(events, i.application_id, "ipc.undisclosed.suspected", { ipc_id: item.ipc_id, kind: item.kind, amount_cents: item.amount_cents, hand_off: "22.6", eligibility: "Mortgages with undisclosed IPCs are not eligible for sale to Fannie Mae (B3-4.1-02)" }, actor);
    undisclosed = appEvent(events, i.application_id, "fraud.case.candidate", { ipc_id: item.ipc_id, opened_by: "22.4", owner: "22.6", reason: "ipc.undisclosed.suspected" }, actor);
  }
  return { item, event, undisclosed };
}
/** Band by CLTV: principal residence / second home > 90 % → 3 %, 75.01–90 % → 6 %, ≤ 75 % → 9 %; investment → 2 % at every CLTV. */
export function ipcBandBps(cltv_milli_pct: number, occupancy: Occupancy): 200 | 300 | 600 | 900 {
  if (occupancy === "investment") return 200;
  if (cltv_milli_pct > 90_000) return 300; if (cltv_milli_pct > 75_000) return 600; return 900;
}
/** B7-1-02 standard coverage (fixed-rate > 20 years) on the LTV 24.6 rounds up to the whole percent: 80.01–85 → 12 %, 85.01–90 → 25 %, 90.01–95 → 30 %, 95.01–97 → 35 %. */
export function miCoverageBps(ltv_milli_pct: number): 0 | 1200 | 2500 | 3000 | 3500 {
  const whole = Math.ceil(ltv_milli_pct / 1000);
  if (whole <= 80) return 0; if (whole <= 85) return 1200; if (whole <= 90) return 2500; if (whole <= 95) return 3000; return 3500;
}
export interface IpcTestInput { readonly sales_price_cents: bigint; readonly appraised_value_cents: bigint; readonly loan_amount_cents: bigint; readonly subordinate_cents?: bigint; readonly occupancy: Occupancy; readonly items: readonly IpcItem[]; readonly cltv_milli_pct?: number; }
export interface IpcIteration { readonly iteration: number; readonly sales_price_cents: bigint; readonly ipc_base_cents: bigint; readonly cltv_milli_pct: number; readonly band_bps: number; readonly max_financing_concessions_cents: bigint; readonly financing_concessions_cents: bigint; readonly excess_cents: bigint; readonly adjusted_price_cents: bigint; readonly ltv_milli_pct: number; readonly mi_coverage_bps: number; }
export interface IpcTest { readonly ok: boolean; readonly iterations: IpcIteration[]; readonly financing_concessions_cents: bigint; readonly sales_concessions_cents: bigint; readonly max_financing_concessions_cents: bigint; readonly excess_cents: bigint; readonly adjusted_price_cents: bigint; readonly ltv_milli_pct: number; readonly cltv_milli_pct: number; readonly band_bps: number; readonly mi_coverage_bps: number; readonly reclassified: boolean; readonly payment_abatement: boolean; readonly undisclosed: boolean; }
export function testIpcLimits(i: IpcTestInput): IpcTest {
  const sub = i.subordinate_cents ?? 0n;
  const financing = sum(i.items.filter((x) => x.counts_toward_limit && x.status !== "rejected").map((x) => x.amount_cents));
  const declaredSales = sum(i.items.filter((x) => x.kind === "sales_concession" || x.kind === "lender_incentive").map((x) => x.amount_cents));
  const undisclosed = i.items.some((x) => x.kind === "undisclosed_suspected" || !x.disclosed_on_settlement);
  const payment_abatement = i.items.some((x) => /abatement/i.test(String(x.kind)) || (x as { payment_abatement?: boolean }).payment_abatement === true);
  const iterations: IpcIteration[] = [];
  let price = i.sales_price_cents - declaredSales; let excess = 0n; let band = 0; let lastCltv = i.cltv_milli_pct ?? 0;
  for (let n = 1; n <= 3; n++) {
    const base = minBig(price, i.appraised_value_cents);
    const cltv = n === 1 && i.cltv_milli_pct !== undefined ? i.cltv_milli_pct : ratioMilliPct(i.loan_amount_cents + sub, base);
    const b = ipcBandBps(cltv, i.occupancy);
    if (n > 1 && b === band) break;   // the band can only tighten; the re-evaluation is stable once it stops moving (at most two iterations)
    const max = bpsFloor(base, BigInt(b));
    excess = maxBig(0n, financing - max);
    const adjusted = i.sales_price_cents - declaredSales - excess; const ltv = ratioMilliPct(i.loan_amount_cents, minBig(adjusted, i.appraised_value_cents));
    iterations.push({ iteration: n, sales_price_cents: price, ipc_base_cents: base, cltv_milli_pct: cltv, band_bps: b, max_financing_concessions_cents: max, financing_concessions_cents: financing, excess_cents: excess, adjusted_price_cents: adjusted, ltv_milli_pct: ltv, mi_coverage_bps: miCoverageBps(ltv) });
    lastCltv = cltv;
    if (excess === 0n) break;
    band = b; price = adjusted;
  }
  const last = iterations[iterations.length - 1]!; const first = iterations[0]!;
  return { ok: first.excess_cents === 0n && !payment_abatement && !undisclosed, iterations, financing_concessions_cents: financing, sales_concessions_cents: declaredSales + last.excess_cents, max_financing_concessions_cents: first.max_financing_concessions_cents, excess_cents: first.excess_cents, adjusted_price_cents: first.adjusted_price_cents, ltv_milli_pct: first.ltv_milli_pct, cltv_milli_pct: lastCltv, band_bps: last.band_bps, mi_coverage_bps: first.mi_coverage_bps, reclassified: first.excess_cents > 0n, payment_abatement, undisclosed };
}
/** Run the IPC test and emit `ipc.limit.ok` (gate satisfied) or `ipc.limit.exceeded` + `ipc.excess.reclassified` (21.5 changed circumstance, 24.6 MI re-quote, 23.1 resubmission). */
export function applyIpcTest(events: EventStore, application_id: string, i: IpcTestInput, actor: Actor = AGENT): { test: IpcTest; events: DomainEvent[]; hand_offs: string[] } {
  const t = testIpcLimits(i); const out: DomainEvent[] = []; const hand_offs: string[] = [];
  if (t.payment_abatement) hand_offs.push("23.2 (loans with any type of payment abatement are not eligible)");
  if (t.ok) out.push(appEvent(events, application_id, "ipc.limit.ok", { max_financing_concessions_cents: t.max_financing_concessions_cents, financing_concessions_cents: t.financing_concessions_cents, band_bps: t.band_bps, cltv_milli_pct: t.cltv_milli_pct, ipc_base_cents: t.iterations[0]!.ipc_base_cents }, actor));
  else if (t.reclassified) {
    const last = t.iterations[t.iterations.length - 1]!;
    out.push(appEvent(events, application_id, "ipc.limit.exceeded", { max_financing_concessions_cents: t.max_financing_concessions_cents, financing_concessions_cents: t.financing_concessions_cents, excess_cents: t.excess_cents, band_bps: t.iterations[0]!.band_bps }, actor));
    out.push(appEvent(events, application_id, "ipc.excess.reclassified", { excess_cents: t.excess_cents, sales_concessions_cents: t.sales_concessions_cents, adjusted_price_cents: t.adjusted_price_cents, ltv_milli_pct: t.ltv_milli_pct, mi_coverage_bps: t.mi_coverage_bps, new_band_bps: last.band_bps, new_max_financing_concessions_cents: last.max_financing_concessions_cents, remaining_excess_cents: last.excess_cents, iterations: t.iterations.length, hand_off: ["21.5", "24.6", "23.1"], changed_circumstance: true }, actor));
    // 21.5's changed-circumstance record (rule 5(ii): the information received is the reclassification itself); 25.1's "cd"/"le" checkpoints re-run on the contract change.
    out.push(appEvent(events, application_id, "purchase_contracts.changed", { reason: "ipc_excess_reclassified", sales_price_cents: t.adjusted_price_cents, sales_concessions_cents: t.sales_concessions_cents, changed_circumstance_basis: "ipc_reclassification", owner: "21.5" }, actor));
    hand_offs.push("21.5 changed circumstance (revised LE)", `24.6 MI re-quote (coverage ${t.mi_coverage_bps / 100}% at LTV ${fmtMilliPct(t.ltv_milli_pct)})`, "23.1 resubmission");
  }
  return { test: t, events: out, hand_offs };
}
export interface IpcCure { readonly option: "cap_credit_at_maximum" | "renegotiate_price" | "remove_buydown"; readonly financing_concessions_cents: bigint; readonly sales_price_cents: bigint; readonly narrative: string; }
/** The compliant structures the agent presents (never chosen for the borrower/seller — the outcome is recorded as their decision; a term change → underwriting_reviewer counteroffer test). */
export function ipcCures(t: IpcTest, i: IpcTestInput): IpcCure[] {
  const last = t.iterations[t.iterations.length - 1]!; const buydown = sum(i.items.filter((x) => x.kind === "buydown_subsidy").map((x) => x.amount_cents));
  const cures: IpcCure[] = [{ option: "cap_credit_at_maximum", financing_concessions_cents: last.max_financing_concessions_cents, sales_price_cents: i.sales_price_cents, narrative: `cap the interested-party credit at ${money(last.max_financing_concessions_cents)} (${last.band_bps / 100}% band)` },
    { option: "renegotiate_price", financing_concessions_cents: t.financing_concessions_cents, sales_price_cents: last.adjusted_price_cents, narrative: `re-negotiate the price to ${money(last.adjusted_price_cents)} with the excess as a sales concession (LTV ${fmtMilliPct(last.ltv_milli_pct)})` }];
  if (buydown > 0n) cures.push({ option: "remove_buydown", financing_concessions_cents: t.financing_concessions_cents - buydown, sales_price_cents: i.sales_price_cents, narrative: `remove the interested-party-funded buydown (${money(buydown)})` });
  return cures;
}

// ============================================================ R8 — funds-to-close worksheet and CD reconciliation (§1026.38(i))
export type WorksheetStage = "application" | "le" | "du_findings" | "pre_cd" | `cd_v${number}` | "pre_consummation" | "final";
export interface WorksheetInputs {
  readonly stage: WorksheetStage; readonly transaction: Transaction; readonly sales_price_cents: bigint; readonly appraised_value_cents: bigint | null; readonly loan_amount_cents: bigint; readonly financed_mi_cents?: bigint; readonly payoffs_cents?: bigint;
  readonly total_closing_costs_cents: bigint; readonly costs_paid_before_closing_cents?: bigint; readonly costs_financed_cents?: bigint; readonly down_payment_cents?: bigint; readonly emd_cents?: bigint; readonly seller_credits_cents?: bigint; readonly lender_credit_premium_cents?: bigint;
  readonly lender_contribution_cents?: bigint; readonly gift_at_closing_cents?: bigint; readonly grant_cents?: bigint; readonly community_second_cents?: bigint; readonly other_credits_cents?: bigint; readonly principal_curtailment_cents?: bigint; readonly reserves_required_cents: bigint;
}
export interface Worksheet extends WorksheetInputs {
  readonly worksheet_id: string; readonly application_id: string; readonly version: number; readonly computed_at: string | null; readonly cash_to_close_cents: bigint; readonly cash_to_borrower_cents: bigint; readonly cash_back_cap_cents: bigint | null; readonly cash_back_ok: boolean;
  readonly funds_to_verify_cents: bigint; readonly verified_usable_closing_cents: bigint; readonly verified_usable_reserves_cents: bigint; readonly sufficient: boolean; readonly shortfall_cents: bigint; readonly reserves_shortfall_cents: bigint;
  readonly cd_disclosure_id: string | null; readonly cd_cash_to_close_cents: bigint | null; readonly reconciled_to_cd: boolean; readonly variances: Variance[]; readonly agent_run_id: string | null;
}
export const downPayment = (sales_price_cents: bigint, loan_amount_cents: bigint): bigint => maxBig(0n, sales_price_cents - loan_amount_cents);
/** Purchase: `cash_to_close = down_payment + total_closing_costs − paid_before_closing − financed − emd − seller_credits − lender_credit − gifts_at_closing − grants/community_second − other_credits`. */
export function cashToClose(w: WorksheetInputs): bigint {
  if (w.transaction !== "purchase") return -lcorCashBack({ loan_amount_cents: w.loan_amount_cents, payoffs_cents: w.payoffs_cents ?? 0n, total_closing_costs_cents: w.total_closing_costs_cents, credits_cents: (w.seller_credits_cents ?? 0n) + (w.lender_credit_premium_cents ?? 0n) + (w.other_credits_cents ?? 0n), principal_curtailment_cents: w.principal_curtailment_cents ?? 0n }).cash_to_borrower_cents;
  const dp = w.down_payment_cents ?? downPayment(w.sales_price_cents, w.loan_amount_cents);
  return dp + w.total_closing_costs_cents - (w.costs_paid_before_closing_cents ?? 0n) - (w.costs_financed_cents ?? 0n) - (w.emd_cents ?? 0n) - (w.seller_credits_cents ?? 0n) - (w.lender_credit_premium_cents ?? 0n) - (w.lender_contribution_cents ?? 0n) - (w.gift_at_closing_cents ?? 0n) - (w.grant_cents ?? 0n) - (w.community_second_cents ?? 0n) - (w.other_credits_cents ?? 0n);
}
export interface Sufficiency { readonly usable_closing_cents: bigint; readonly usable_reserves_after_closing_cents: bigint; readonly funds_to_verify_cents: bigint; readonly sufficient: boolean; readonly shortfall_cents: bigint; readonly reserves_shortfall_cents: bigint; }
export type UsableAsset = Pick<AssetRecord, "usable_cents" | "usable_for" | "status"> & Partial<Pick<AssetRecord, "liquidation_required_for_closing" | "liquidated_cents" | "asset_id">>;
/** `sufficient = Σ usable_closing ≥ max(cash_to_close, 0) AND Σ usable_reserves_after_closing ≥ reserves_required`; only verified/usable/finalized assets count. */
export function sufficiency(assets: readonly UsableAsset[], cash_to_close_cents: bigint, reserves_required_cents: bigint): Sufficiency {
  const live = assets.filter((a) => ["verified", "sourced", "usable", "finalized", "reverified"].includes(a.status));
  const need = maxBig(0n, cash_to_close_cents);
  const closingOf = (a: UsableAsset): bigint => (a.liquidation_required_for_closing ? minBig(a.usable_cents, a.liquidated_cents ?? 0n) : a.usable_cents);
  const closingEligible = live.filter((a) => a.usable_for === "closing" || a.usable_for === "both");
  const usable_closing_cents = sum(closingEligible.map(closingOf));
  const bothLiquid = sum(live.filter((a) => a.usable_for === "both").map(closingOf));
  const bothNotLiquidated = sum(live.filter((a) => a.usable_for === "both").map((a) => a.usable_cents - closingOf(a)));
  const reservesOnly = sum(live.filter((a) => a.usable_for === "reserves").map((a) => a.usable_cents));
  const usable_reserves_after_closing_cents = maxBig(0n, bothLiquid - need) + bothNotLiquidated + reservesOnly;
  const shortfall_cents = maxBig(0n, need - usable_closing_cents); const reserves_shortfall_cents = maxBig(0n, reserves_required_cents - usable_reserves_after_closing_cents);
  return { usable_closing_cents, usable_reserves_after_closing_cents, funds_to_verify_cents: need + reserves_required_cents, sufficient: shortfall_cents === 0n && reserves_shortfall_cents === 0n, shortfall_cents, reserves_shortfall_cents };
}
export function buildWorksheet(events: EventStore, i: WorksheetInputs & { application_id: string; assets: readonly UsableAsset[]; version?: number; worksheet_id?: string; computed_at?: string | null; agent_run_id?: string | null }, actor: Actor = AGENT): { worksheet: Worksheet; event: DomainEvent; cash_back: LcorCashBack | null; exceeded_event: DomainEvent | null } {
  const ctc = cashToClose(i); const s = sufficiency(i.assets, ctc, i.reserves_required_cents);
  const lcor = i.transaction === "lcor" ? lcorCashBack({ loan_amount_cents: i.loan_amount_cents, payoffs_cents: i.payoffs_cents ?? 0n, total_closing_costs_cents: i.total_closing_costs_cents, credits_cents: (i.seller_credits_cents ?? 0n) + (i.lender_credit_premium_cents ?? 0n) + (i.other_credits_cents ?? 0n), principal_curtailment_cents: i.principal_curtailment_cents ?? 0n }) : null;
  const worksheet: Worksheet = { ...i, worksheet_id: i.worksheet_id ?? ids("ws"), version: i.version ?? 1, computed_at: i.computed_at ?? null, cash_to_close_cents: ctc, cash_to_borrower_cents: maxBig(0n, -ctc), cash_back_cap_cents: lcor?.cap_cents ?? null, cash_back_ok: lcor ? lcor.cash_back_ok : true,
    funds_to_verify_cents: s.funds_to_verify_cents, verified_usable_closing_cents: s.usable_closing_cents, verified_usable_reserves_cents: s.usable_reserves_after_closing_cents, sufficient: s.sufficient, shortfall_cents: s.shortfall_cents, reserves_shortfall_cents: s.reserves_shortfall_cents,
    cd_disclosure_id: null, cd_cash_to_close_cents: null, reconciled_to_cd: false, variances: [], agent_run_id: i.agent_run_id ?? null };
  const event = appEvent(events, i.application_id, "funds_to_close.computed", { worksheet_id: worksheet.worksheet_id, version: worksheet.version, stage: i.stage, transaction: i.transaction, cash_to_close_cents: ctc, cash_to_borrower_cents: worksheet.cash_to_borrower_cents, cash_back_cap_cents: worksheet.cash_back_cap_cents, cash_back_ok: worksheet.cash_back_ok, funds_to_verify_cents: s.funds_to_verify_cents, verified_usable_closing_cents: s.usable_closing_cents, verified_usable_reserves_cents: s.usable_reserves_after_closing_cents, sufficient: s.sufficient, shortfall_cents: s.shortfall_cents, reserves_shortfall_cents: s.reserves_shortfall_cents, reserves_required_cents: i.reserves_required_cents }, actor);
  const exceeded_event = lcor && !lcor.cash_back_ok ? appEvent(events, i.application_id, "lcor.cash_back.exceeded", { worksheet_id: worksheet.worksheet_id, cash_to_borrower_cents: lcor.cash_to_borrower_cents, cap_cents: lcor.cap_cents, overage_cents: lcor.overage_cents, cures: lcorCures(lcor, i.loan_amount_cents) }, actor) : null;
  return { worksheet, event, cash_back: lcor, exceeded_event };
}
export interface CdLine { readonly section: string; readonly label: string; readonly cents: bigint; }
export interface Variance { readonly section: string; readonly label: string; readonly worksheet_cents: bigint | null; readonly cd_cents: bigint | null; readonly delta_cents: bigint; readonly text: string; }
const signed = (c: bigint): string => `${c < 0n ? "−" : "+"}${money(c < 0n ? -c : c)}`;
/** `reconciled_to_cd = (worksheet.cash_to_close == cd.cash_to_close)`; variances itemized per CD line ("B. Title – settlement fee +$100.00") and routed to 25.2 — the worksheet never overrides the CD. */
export function reconcileToCd(events: EventStore, w: Worksheet, cd: { cd_disclosure_id: string; cd_version: number; cash_to_close_cents: bigint; lines?: readonly CdLine[] }, worksheet_lines: readonly CdLine[] = [], actor: Actor = AGENT): { worksheet: Worksheet; reconciled: boolean; variances: Variance[]; event: DomainEvent } {
  const reconciled = w.cash_to_close_cents === cd.cash_to_close_cents;
  const variances: Variance[] = [];
  if (!reconciled) {
    const key = (l: CdLine) => `${l.section}|${l.label}`; const wm = new Map(worksheet_lines.map((l) => [key(l), l])); const cm = new Map((cd.lines ?? []).map((l) => [key(l), l]));
    for (const [k, c] of cm) { const m = wm.get(k); const delta = c.cents - (m?.cents ?? 0n); if (delta !== 0n) variances.push({ section: c.section, label: c.label, worksheet_cents: m?.cents ?? null, cd_cents: c.cents, delta_cents: delta, text: `${c.section}. ${c.label} ${signed(delta)}` }); }
    for (const [k, m] of wm) if (!cm.has(k)) variances.push({ section: m.section, label: m.label, worksheet_cents: m.cents, cd_cents: null, delta_cents: -m.cents, text: `${m.section}. ${m.label} ${signed(-m.cents)}` });
    if (!variances.length) variances.push({ section: "Cash to Close", label: "total", worksheet_cents: w.cash_to_close_cents, cd_cents: cd.cash_to_close_cents, delta_cents: cd.cash_to_close_cents - w.cash_to_close_cents, text: `Cash to Close ${signed(cd.cash_to_close_cents - w.cash_to_close_cents)}` });
  }
  const worksheet: Worksheet = { ...w, cd_disclosure_id: cd.cd_disclosure_id, cd_cash_to_close_cents: cd.cash_to_close_cents, reconciled_to_cd: reconciled, variances, stage: `cd_v${cd.cd_version}` };
  const event = reconciled
    ? appEvent(events, w.application_id, "funds_to_close.reconciled", { worksheet_id: w.worksheet_id, cd_version: cd.cd_version, cd_disclosure_id: cd.cd_disclosure_id, cash_to_close_cents: cd.cash_to_close_cents, sufficient: w.sufficient, cash_back_ok: w.cash_back_ok }, actor)
    : appEvent(events, w.application_id, "funds_to_close.variance", { worksheet_id: w.worksheet_id, cd_version: cd.cd_version, cd_disclosure_id: cd.cd_disclosure_id, worksheet_cash_to_close_cents: w.cash_to_close_cents, cd_cash_to_close_cents: cd.cash_to_close_cents, variances: variances.map((v) => v.text), variance_detail: variances.map((v) => ({ ...v, worksheet_cents: v.worksheet_cents === null ? null : String(v.worksheet_cents), cd_cents: v.cd_cents === null ? null : String(v.cd_cents), delta_cents: String(v.delta_cents) })), routed_to: "25.2" }, actor);
  return { worksheet, reconciled, variances, event };
}
/** Prepaid interest at the CD's convention (rate in thousandths of a percent: 6.375 % = 6375n): per diem = loan × rate ÷ 365, rounded half-up at the total — $412,000 × 6.375 % ÷ 365 × 13 = $935.47; $560,000 × 6.125 % ÷ 365 × 19 = $1,785.48 (per diem $93.97). */
export const prepaidInterest = (loan_amount_cents: bigint, rate_milli_pct: bigint, days: number): bigint => divRound(loan_amount_cents * rate_milli_pct * BigInt(days), 100_000n * 365n, "HALF_UP");
export const perDiemInterest = (loan_amount_cents: bigint, rate_milli_pct: bigint): bigint => divRound(loan_amount_cents * rate_milli_pct, 100_000n * 365n, "HALF_UP");
/** Initial escrow deposit at closing (30.3's aggregate analysis provides it; the sum of the CD's "Other Costs" lines must equal line J − loan costs). */
export const otherCosts = (parts_: readonly bigint[]): bigint => sum(parts_);

// ============================================================ R9 — LCOR cash back (B2-1.3-02, 10/08/2025)
export const LCOR_CASH_BACK_FLOOR_CENTS = 200_000n;
export interface LcorCashBack { readonly cash_to_borrower_cents: bigint; readonly cap_cents: bigint; readonly cash_back_ok: boolean; readonly overage_cents: bigint; }
/** `cap = max(1 % × loan_amount, $2,000)`; `cash_to_borrower = loan − payoffs − total_closing_costs + credits − principal_curtailment`. */
export function lcorCashBack(i: { loan_amount_cents: bigint; payoffs_cents: bigint; total_closing_costs_cents: bigint; credits_cents?: bigint; principal_curtailment_cents?: bigint }): LcorCashBack {
  const cap_cents = maxBig(pctFloor(i.loan_amount_cents, 1n), LCOR_CASH_BACK_FLOOR_CENTS);
  const cash_to_borrower_cents = i.loan_amount_cents - i.payoffs_cents - i.total_closing_costs_cents + (i.credits_cents ?? 0n) - (i.principal_curtailment_cents ?? 0n);
  return { cash_to_borrower_cents, cap_cents, cash_back_ok: cash_to_borrower_cents <= cap_cents, overage_cents: maxBig(0n, cash_to_borrower_cents - cap_cents) };
}
export interface LcorCures { readonly principal_curtailment: { curtailment_cents: bigint; cash_to_borrower_after_cents: bigint; upb_after_funding_cents: bigint } | null; readonly loan_reduction: { new_loan_amount_cents: bigint; decrease_cents: bigint; decrease_bps: number; within_5pct_tolerance: boolean; corrected_cd_required: true } | null; }
/** Cure A: curtail by the overage at closing (UPB after funding = loan − curtailment); cure B: reduce the loan by the overage rounded up to the dollar (≤ 5 % decrease is within 23.1's tolerance). */
export function lcorCures(r: LcorCashBack, loan_amount_cents: bigint): LcorCures {
  if (r.cash_back_ok) return { principal_curtailment: null, loan_reduction: null };
  const dec = ((r.overage_cents + 99n) / 100n) * 100n; const nl = loan_amount_cents - dec; const decrease_bps = Number(divRound(dec * 10000n, loan_amount_cents, "HALF_UP"));
  return { principal_curtailment: { curtailment_cents: r.overage_cents, cash_to_borrower_after_cents: r.cash_to_borrower_cents - r.overage_cents, upb_after_funding_cents: loan_amount_cents - r.overage_cents }, loan_reduction: { new_loan_amount_cents: nl, decrease_cents: dec, decrease_bps, within_5pct_tolerance: decrease_bps <= 500, corrected_cd_required: true } };
}
export const monthlyPI = (loan_amount_cents: bigint, rate: string, term_months: number): bigint => levelPayment(loan_amount_cents, Decimal.parse(rate), term_months);
/** Record the curtailment cure on a worksheet: `principal_curtailment_cents` flows to 26.3/27.1 postings; cash_back_ok re-tested. */
export function recordCurtailment(events: EventStore, w: Worksheet, curtailment_cents: bigint, actor: Actor = AGENT): { worksheet: Worksheet; cash_back: LcorCashBack; event: DomainEvent } {
  if (curtailment_cents <= 0n) throw new RangeError("curtailment_cents must be > 0");
  const cb = lcorCashBack({ loan_amount_cents: w.loan_amount_cents, payoffs_cents: w.payoffs_cents ?? 0n, total_closing_costs_cents: w.total_closing_costs_cents, credits_cents: (w.seller_credits_cents ?? 0n) + (w.lender_credit_premium_cents ?? 0n) + (w.other_credits_cents ?? 0n), principal_curtailment_cents: curtailment_cents });
  const worksheet: Worksheet = { ...w, version: w.version + 1, principal_curtailment_cents: curtailment_cents, cash_to_close_cents: -cb.cash_to_borrower_cents, cash_to_borrower_cents: maxBig(0n, cb.cash_to_borrower_cents), cash_back_cap_cents: cb.cap_cents, cash_back_ok: cb.cash_back_ok };
  const event = appEvent(events, w.application_id, "funds_to_close.computed", { worksheet_id: w.worksheet_id, version: worksheet.version, stage: w.stage, transaction: w.transaction, cash_to_close_cents: worksheet.cash_to_close_cents, cash_to_borrower_cents: worksheet.cash_to_borrower_cents, cash_back_cap_cents: cb.cap_cents, cash_back_ok: cb.cash_back_ok, principal_curtailment_cents: curtailment_cents, cure: "principal_curtailment", upb_after_funding_cents: w.loan_amount_cents - curtailment_cents, sufficient: w.sufficient, shortfall_cents: w.shortfall_cents }, actor);
  return { worksheet, cash_back: cb, event };
}

// ============================================================ R10 — subordinate financing / Community Seconds (B2-1.2-02/-03, B5-5.1-02)
export const COMMUNITY_SECONDS_MAX_CLTV_MILLI = 105_000;
export const SFC_COMMUNITY_SECONDS = 118;
export type ProviderKind = "federal_agency" | "state_or_local_government" | "nonprofit_501c3" | "employer" | "fhlb" | "property_seller" | "interested_party" | "other";
export const ELIGIBLE_CS_PROVIDERS: readonly ProviderKind[] = ["federal_agency", "state_or_local_government", "nonprofit_501c3", "employer", "fhlb"];
export function cltvMilliPct(i: { first_lien_cents: bigint; drawn_heloc_cents?: bigint; closed_end_subordinate_cents?: bigint; sales_price_cents: bigint | null; appraised_value_cents: bigint | null }): number {
  const den = i.sales_price_cents !== null && i.appraised_value_cents !== null ? minBig(i.sales_price_cents, i.appraised_value_cents) : (i.sales_price_cents ?? i.appraised_value_cents);
  if (den === null) throw new RangeError("sales price or appraised value required");
  return ratioMilliPct(i.first_lien_cents + (i.drawn_heloc_cents ?? 0n) + (i.closed_end_subordinate_cents ?? 0n), den);
}
/** HCLTV is computed only when a HELOC exists (full line amount). */
export function hcltvMilliPct(i: { first_lien_cents: bigint; heloc_line_cents: bigint | null; closed_end_subordinate_cents?: bigint; sales_price_cents: bigint | null; appraised_value_cents: bigint | null }): number | null {
  if (i.heloc_line_cents === null) return null;
  return cltvMilliPct({ first_lien_cents: i.first_lien_cents, drawn_heloc_cents: i.heloc_line_cents, ...(i.closed_end_subordinate_cents !== undefined ? { closed_end_subordinate_cents: i.closed_end_subordinate_cents } : {}), sales_price_cents: i.sales_price_cents, appraised_value_cents: i.appraised_value_cents });
}
export interface CommunitySecondInput { readonly amount_cents: bigint; readonly provider_name: string; readonly provider_kind: ProviderKind; readonly repayment: "fully_amortizing" | "deferred" | "deferred_entire_term" | "forgivable"; readonly deferral_years?: number | null; readonly first_lien_cents: bigint; readonly sales_price_cents: bigint; readonly appraised_value_cents: bigint; readonly occupancy: Occupancy; readonly independent_cltv_cap_milli?: number | null; readonly shared_appreciation?: boolean; readonly seller_credit_cents?: bigint; }
export interface CommunitySecond { readonly eligible: boolean; readonly ineligible_reason: "ineligible_provider" | "cltv_exceeds_105" | "shared_appreciation_not_community_second" | null; readonly cltv_milli_pct: number; readonly cltv_cap_milli: number; readonly cltv_ok: boolean; readonly deferred_5y_or_more: boolean; readonly sfc_codes: number[]; readonly ipc_band_bps: number; readonly max_financing_concessions_cents: bigint; readonly seller_credit_within_band: boolean | null; }
export function communitySecond(i: CommunitySecondInput): CommunitySecond {
  const cltv = cltvMilliPct({ first_lien_cents: i.first_lien_cents, closed_end_subordinate_cents: i.amount_cents, sales_price_cents: i.sales_price_cents, appraised_value_cents: i.appraised_value_cents });
  const cap = i.independent_cltv_cap_milli ?? COMMUNITY_SECONDS_MAX_CLTV_MILLI; const cltv_ok = cltv <= cap;
  const providerOk = ELIGIBLE_CS_PROVIDERS.includes(i.provider_kind);
  const deferred_5y_or_more = i.repayment === "deferred_entire_term" || i.repayment === "forgivable" || (i.repayment === "deferred" && (i.deferral_years ?? 0) >= 5);
  const reason: CommunitySecond["ineligible_reason"] = !providerOk ? "ineligible_provider" : i.shared_appreciation ? "shared_appreciation_not_community_second" : !cltv_ok ? "cltv_exceeds_105" : null;
  const band = ipcBandBps(cltv, i.occupancy); const max = bpsFloor(minBig(i.sales_price_cents, i.appraised_value_cents), BigInt(band));
  return { eligible: reason === null, ineligible_reason: reason, cltv_milli_pct: cltv, cltv_cap_milli: cap, cltv_ok, deferred_5y_or_more, sfc_codes: reason === null ? [SFC_COMMUNITY_SECONDS] : [], ipc_band_bps: band, max_financing_concessions_cents: max, seller_credit_within_band: i.seller_credit_cents === undefined ? null : i.seller_credit_cents <= max };
}
export function declareSubordinateFinancing(events: EventStore, application_id: string, i: CommunitySecondInput, actor: Actor = AGENT): { result: CommunitySecond; event: DomainEvent; sfc_event: DomainEvent | null; hand_offs: string[] } {
  const r = communitySecond(i);
  const event = appEvent(events, application_id, "subordinate_financing.declared", { kind: "community_second", provider_name: i.provider_name, provider_kind: i.provider_kind, amount_cents: i.amount_cents, eligible: r.eligible, reason: r.ineligible_reason, cltv_milli_pct: r.cltv_milli_pct, cltv_ok: r.cltv_ok, deferred_5y_or_more: r.deferred_5y_or_more, ipc_band_bps: r.ipc_band_bps, sfc_codes: r.sfc_codes, consumers: ["24.4", "22.5", "29.3"] }, actor);
  const sfc_event = r.eligible ? appEvent(events, application_id, "delivery.sfc.queued", { code: SFC_COMMUNITY_SECONDS, reason: "Community Seconds (B5-5.1-02)", amount_cents: i.amount_cents }, actor) : null;
  const hand_offs = r.eligible ? ["24.4 subordination", `22.5 DTI (deferred_5y_or_more=${r.deferred_5y_or_more})`, "29.3 SFC 118"] : ["23.2 restructure (ineligible subordinate financing)", "21.5 revised LE"];
  return { result: r, event, sfc_event, hand_offs };
}

// ============================================================ departing residence — anticipated sales proceeds (B3-4.3-10)
export function anticipatedSalesProceeds(i: { sales_price_cents?: bigint | null; listing_price_cents?: bigint | null; sales_costs_cents: bigint; liens_cents: bigint }): { estimated_proceeds_cents: bigint; basis: "sales_price" | "listing_price_90pct" } {
  if (i.sales_price_cents !== undefined && i.sales_price_cents !== null) return { estimated_proceeds_cents: maxBig(0n, i.sales_price_cents - (i.sales_costs_cents + i.liens_cents)), basis: "sales_price" };
  if (i.listing_price_cents === undefined || i.listing_price_cents === null) throw new RangeError("sales price or listing price required");
  return { estimated_proceeds_cents: maxBig(0n, pctFloor(i.listing_price_cents, 90n) - i.liens_cents), basis: "listing_price_90pct" };
}
export interface SaleProceedsGate { readonly open: boolean; readonly blocks: readonly string[]; readonly fallbacks: readonly string[]; readonly reason?: string; }
/** The settlement statement of the departing residence must be received "before, or simultaneously with" the subject settlement. */
export function saleProceedsGate(i: { subject_closing_date: PlainDate; sale_settlement_date: PlainDate | null; settlement_statement_document_id: string | null }): SaleProceedsGate {
  const fallbacks = ["bridge loan (22.5 qualifying payment)", "other verified funds", "reschedule the subject closing"];
  if (!i.settlement_statement_document_id || !i.sale_settlement_date) return { open: false, blocks: ["funding.authorized"], fallbacks, reason: `settlement statement of the departing residence not received; required before or simultaneously with the ${i.subject_closing_date} settlement (B3-4.3-10)` };
  if (i.sale_settlement_date > i.subject_closing_date) return { open: false, blocks: ["funding.authorized"], fallbacks, reason: `departing residence settles ${i.sale_settlement_date}, after the subject settlement ${i.subject_closing_date} (B3-4.3-10)` };
  return { open: true, blocks: [], fallbacks: [] };
}

// ============================================================ finalization → `assets.finalized`
export function finalizeAssets(events: EventStore, i: { application_id: string; worksheet: Worksheet; assets: readonly AssetRecord[]; reserves_required_cents: bigint; gifts?: readonly GiftRecord[] }, actor: Actor = AGENT): { assets: AssetRecord[]; event: DomainEvent } {
  const w = i.worksheet;
  if (!w.sufficient) throw new RangeError(`worksheet ${w.worksheet_id} v${w.version}: sufficient=false (shortfall ${money(w.shortfall_cents)}, reserves shortfall ${money(w.reserves_shortfall_cents)})`);
  if (!w.cash_back_ok) throw new RangeError(`worksheet ${w.worksheet_id}: LCOR cash back exceeds the cap (B2-1.3-02)`);
  const pending = i.assets.filter((a) => !["verified", "sourced", "usable", "finalized", "reverified", "withdrawn", "rejected"].includes(a.status));
  if (pending.length) throw new RangeError(`assets not verified: ${pending.map((a) => `${a.asset_id}:${a.status}`).join(", ")}`);
  const openGifts = (i.gifts ?? []).filter((g) => g.status !== "rejected" && g.status !== "transfer_verified" && g.status !== "complete");
  if (openGifts.length) throw new RangeError(`gift transfer not verified: ${openGifts.map((g) => g.gift_id).join(", ")} (FNMA_B3_4_3_04_GIFT_TRANSFER_GATE)`);
  const assets = i.assets.map((a) => (a.status === "rejected" || a.status === "withdrawn" ? a : { ...a, status: "finalized" as const }));
  const event = appEvent(events, i.application_id, "assets.finalized", { worksheet_id: w.worksheet_id, worksheet_version: w.version, cash_to_close_cents: w.cash_to_close_cents, usable_closing_cents: w.verified_usable_closing_cents, usable_reserves_cents: w.verified_usable_reserves_cents, reserves_required_cents: i.reserves_required_cents, reconciled_to_cd: w.reconciled_to_cd, cash_back_ok: w.cash_back_ok, assets: assets.filter((a) => a.status === "finalized").map((a) => ({ asset_id: a.asset_id, asset_type: a.asset_type, usable_cents: String(a.usable_cents), usable_for: a.usable_for, verification_method: a.verification_method, du_report_reference_id: a.du_report_reference_id })), consumers: ["23.1", "23.3", "26.3", "23.4"] }, actor);
  return { assets, event };
}

// ============================================================ gate evaluation (evaluators-22-4.ts; tools call assertAssetGateOpen)
export type AssetGateCode = "FNMA_B3_4_4_02_ASSET_STMT_45D_GATE" | "FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE" | "FNMA_B3_4_3_04_GIFT_TRANSFER_GATE" | "FNMA_B3_4_3_10_SALE_PROCEEDS_GATE" | "FNMA_B3_4_1_02_IPC_LIMIT_GATE" | "FNMA_B2_1_3_02_LCOR_CASHBACK_GATE" | "SM_CASH_TO_CLOSE_RECONCILED_GATE" | "SM_RESERVES_VERIFIED_GATE";
export interface GateResult { readonly open: boolean; readonly reason?: string; }
export const ASSET_GATE_CITATION: Record<AssetGateCode, string> = {
  FNMA_B3_4_4_02_ASSET_STMT_45D_GATE: "B3-4.4-02: monthly bank statements dated within 45 days of the initial loan application date (quarterly 90); two consecutive (purchase) / one (refinance)",
  FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE: "B3-4.2-02: a large deposit needed for the transaction must be sourced or the verified funds reduced by the undocumented portion",
  FNMA_B3_4_3_04_GIFT_TRANSFER_GATE: "B3-4.3-04: gift transfer evidence before or at settlement",
  FNMA_B3_4_3_10_SALE_PROCEEDS_GATE: "B3-4.3-10: settlement statement of the departing residence before, or simultaneously with, the subject settlement",
  FNMA_B3_4_1_02_IPC_LIMIT_GATE: "B3-4.1-02: financing concessions within 3/6/9 % (2 % investment) of the lower of price or appraised value",
  FNMA_B2_1_3_02_LCOR_CASHBACK_GATE: "B2-1.3-02: cash back ≤ the greater of 1 % of the loan amount or $2,000",
  SM_CASH_TO_CLOSE_RECONCILED_GATE: "Reg Z §1026.38(i): the CD's Cash to Close equals the verified-funds worksheet to the cent; funds sufficient",
  SM_RESERVES_VERIFIED_GATE: "B3-4.1-01 / DU findings: verified usable reserves ≥ reserves required",
};
export class AssetGateClosed extends Error { readonly code: AssetGateCode; readonly citation: string; readonly applicationId: string; constructor(code: AssetGateCode, applicationId: string, reason: string) { super(`${code} closed for ${applicationId}: ${reason}`); this.name = "AssetGateClosed"; this.code = code; this.citation = ASSET_GATE_CITATION[code]; this.applicationId = applicationId; } }
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const big = (v: unknown, dflt = 0n): bigint => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? dflt : BigInt(String(v)));
export function assetGateResult(code: AssetGateCode, f: Record<string, unknown>): GateResult {
  switch (code) {
    case "FNMA_B3_4_4_02_ASSET_STMT_45D_GATE": {
      const app = f.initial_application_date ?? f.application_date; if (!isDate(app)) return { open: false, reason: "initial application_date is required" };
      const g = statementGate({ transaction: (f.transaction as Transaction | undefined) ?? "purchase", initial_application_date: D(app), statements: (f.statements as StatementEvidence[] | undefined) ?? [], du_validated: f.du_validated === true });
      return g.open ? { open: true } : { open: false, reason: g.reason! };
    }
    case "FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE": {
      if (f.transaction !== undefined && f.transaction !== "purchase") return { open: true };
      const deposits = (f.deposits as DepositResult[] | undefined) ?? [];
      const unresolved = deposits.filter((d) => d.large_deposit && !["sourced", "waived_du_validated", "waived_refinance"].includes(d.status) && !(d.reduction_cents > 0n && f.sufficient === true));
      return unresolved.length ? { open: false, reason: `large deposit(s) ${unresolved.map((d) => `${d.deposit_id} (${money(d.unsourced_cents)} unsourced)`).join(", ")} not sourced and the reduced funds are not sufficient` } : { open: true };
    }
    case "FNMA_B3_4_3_04_GIFT_TRANSFER_GATE": {
      const gifts = (f.gifts as Pick<GiftRecord, "gift_id" | "status">[] | undefined) ?? [];
      const open = gifts.filter((g) => g.status !== "rejected" && g.status !== "transfer_verified" && g.status !== "complete");
      return open.length ? { open: false, reason: `gift(s) ${open.map((g) => `${g.gift_id}:${g.status}`).join(", ")} without transfer evidence` } : { open: true };
    }
    case "FNMA_B3_4_3_10_SALE_PROCEEDS_GATE": {
      if (!isDate(f.subject_closing_date)) return { open: false, reason: "subject_closing_date (closings.scheduled_at) is required" };
      const g = saleProceedsGate({ subject_closing_date: D(f.subject_closing_date), sale_settlement_date: isDate(f.sale_settlement_date) ? D(f.sale_settlement_date) : null, settlement_statement_document_id: typeof f.settlement_statement_document_id === "string" && f.settlement_statement_document_id ? f.settlement_statement_document_id : null });
      return g.open ? { open: true } : { open: false, reason: g.reason! };
    }
    case "FNMA_B3_4_1_02_IPC_LIMIT_GATE": {
      if (typeof f.ok === "boolean") return f.ok ? { open: true } : { open: false, reason: "financing concessions exceed the band maximum (excess reclassified)" };
      if (f.sales_price_cents === undefined) return { open: false, reason: "IPC test inputs (price, appraised value, loan amount, items) are required" };
      const t = testIpcLimits({ sales_price_cents: big(f.sales_price_cents), appraised_value_cents: big(f.appraised_value_cents), loan_amount_cents: big(f.loan_amount_cents), subordinate_cents: big(f.subordinate_cents), occupancy: (f.occupancy as Occupancy | undefined) ?? "principal_residence", items: (f.items as IpcItem[] | undefined) ?? [] });
      return t.ok ? { open: true } : { open: false, reason: `financing concessions ${money(t.financing_concessions_cents)} exceed ${money(t.max_financing_concessions_cents)} (${t.iterations[0]!.band_bps / 100}% band) by ${money(t.excess_cents)}` };
    }
    case "FNMA_B2_1_3_02_LCOR_CASHBACK_GATE": {
      if (f.transaction !== undefined && f.transaction !== "lcor") return { open: true };
      if (typeof f.cash_back_ok === "boolean") return f.cash_back_ok ? { open: true } : { open: false, reason: "cash to borrower exceeds max(1 % × loan amount, $2,000)" };
      if (f.loan_amount_cents === undefined) return { open: false, reason: "loan_amount_cents, payoffs_cents and total_closing_costs_cents are required" };
      const r = lcorCashBack({ loan_amount_cents: big(f.loan_amount_cents), payoffs_cents: big(f.payoffs_cents), total_closing_costs_cents: big(f.total_closing_costs_cents), credits_cents: big(f.credits_cents), principal_curtailment_cents: big(f.principal_curtailment_cents) });
      return r.cash_back_ok ? { open: true } : { open: false, reason: `cash to borrower ${money(r.cash_to_borrower_cents)} > cap ${money(r.cap_cents)} by ${money(r.overage_cents)}` };
    }
    case "SM_CASH_TO_CLOSE_RECONCILED_GATE": {
      const w = (f.worksheet as Partial<Worksheet> | undefined) ?? f;
      const reasons: string[] = [];
      if (w.reconciled_to_cd !== true) reasons.push("latest worksheet not reconciled to the CD");
      if (w.sufficient !== true) reasons.push("funds not sufficient");
      if (f.all_assets_usable === false) reasons.push("assets not all verified/usable");
      if (f.reserves_ok === false) reasons.push("reserves below required");
      if (w.cash_back_ok === false) reasons.push("LCOR cash back exceeds the cap");
      return reasons.length ? { open: false, reason: reasons.join("; ") } : { open: true };
    }
    case "SM_RESERVES_VERIFIED_GATE": {
      const v = big(f.verified_cents ?? f.verified_usable_reserves_cents), r = big(f.required_cents ?? f.reserves_required_cents);
      return v >= r ? { open: true } : { open: false, reason: `verified reserves ${money(v)} < required ${money(r)} (${reserveTolerance(v, r).tolerance_90pct_ok ? "within 23.1's 90 % tolerance — no resubmission, gate still closed" : "below 90 % — B3_2_10_RESERVES_90PCT resubmission"})` };
    }
  }
}
export function assertAssetGateOpen(applicationId: string, code: AssetGateCode, facts: Record<string, unknown>): void {
  nonEmpty(applicationId, "applicationId");
  const r = assetGateResult(code, facts);
  if (!r.open) throw new AssetGateClosed(code, applicationId, r.reason ?? "closed");
}

// ============================================================ decision record (agent_decisions)
export function assetDecisionRecord(d: { application_id: string; worksheet_version: number | null; assets?: readonly Pick<AssetRecord, "asset_id" | "usable_cents" | "secured_loan_offset_cents" | "emd_offset_cents" | "unsourced_deposit_offset_cents">[]; deposits?: readonly Pick<DepositResult, "deposit_id" | "status" | "source_evidence_document_ids">[]; gifts?: readonly Pick<GiftRecord, "gift_id" | "status" | "donor_interested_party_check">[]; ipcs?: readonly Pick<IpcIteration, "iteration" | "band_bps" | "max_financing_concessions_cents" | "excess_cents">[]; reserves?: Partial<ReserveCalculation> | null; cd_reconciliation?: { reconciled_to_cd: boolean; variances: readonly string[] } | null; action: string; rationale: string; confidence: number | null; model_version: string; prompt_version: string; escalation_id?: string | null }): Record<string, unknown> {
  const s = (v: unknown): unknown => (typeof v === "bigint" ? String(v) : Array.isArray(v) ? v.map(s) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, s(x)])) : v);
  return s({ application_id: d.application_id, worksheet_version: d.worksheet_version, assets: d.assets ?? [], deposits: d.deposits ?? [], gifts: d.gifts ?? [], ipcs: d.ipcs ?? [], reserves: d.reserves ?? null, cd_reconciliation: d.cd_reconciliation ?? null, action: d.action, rationale: d.rationale, confidence: d.confidence, rule_set_version: RULE_SET_VERSION, du_rule_set_version: DU_RULE_SET_VERSION, model_version: d.model_version, prompt_version: d.prompt_version, escalation_id: d.escalation_id ?? null }) as Record<string, unknown>;
}
export { parts };
