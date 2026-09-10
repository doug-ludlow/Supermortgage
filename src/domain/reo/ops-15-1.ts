/**
 * §15.1 operating rules over the reogram.ts calculators: the LL-2026-05 liquidation rail
 * (rule 12 / T12), the servicer-recovery waterfall and note/PTR spread interest of the TPS worked
 * example (rule 8), the REOgram package, the three-part resale-restriction attestation and the
 * confirmation gate evaluated from facts (rules 3–4, T1/T11), the confidence hold (Agents paragraph:
 * hold and escalate before deadline − 4 h), the Property 360 notification parser, the post-sale
 * handoff tasks with the recorder-rolled deed clock (rules 5–7, T8/T9), the CRS 311/351 lines
 * (rule 8, guardrail "never remit more than amount_due_fnma"), surplus disposition (T6), the
 * failed-sale path (rule 9, T7), the F-1-08 closing statement, the E-4.1-02 elimination/rescission
 * template (rule 10), the compensatory-fee exposure record with code-313 draft matching (rule 11,
 * T3), the exception-correction proposal from `mi_policies` (T4) and the two condition-shaped
 * gates (E-4.3-01 preservation stop; P360 5-BD edit window).
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, servicer, rollForward } from "../../kernel/calendar/business.ts";
import { type Cents, centsToDecimal, ratePercent, monthlyInterest, formatCents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { EntrySetInput, LineInput } from "../../kernel/ledger/ledger.ts";
import { projectLiquidationEvent } from "../investor/ops.ts";
import { eventDeadlineMs } from "../investor/period.ts";
import type { LiquidationKind, InsuredFlag } from "../investor/liquidation.ts";
import type { ChannelMode } from "../investor/types.ts";
import { ptrInterest, lateDays, resaleRestrictionGate, deedRecordDue, insuranceCancellationDue, rescissionClocks, failedSaleDepositDue, exceptionResolutionDue, type TpsResult } from "./reogram.ts";

export type Escalation = { readonly kind: "officer" | "attorney" | "fnma_portal_operator" | "human_agent"; readonly severity?: "sev1" | "sev2" | "sev3"; readonly reason: string };
const HOUR = 3_600_000;

// ============================================================ rule 12 — LL-2026-05 liquidation rail
/** Liquidation event type: Third-Party Sale for a bidder; Government Conveyance only for FHA/VA conveyances; conventional (uninsured or MI) acquisitions are REO. */
export function liquidationEventType(kind: LiquidationKind, insured: InsuredFlag): "Third-Party Sale" | "Government Conveyance" | "REO" {
  if (kind === "third_party_sale") return "Third-Party Sale";
  return insured === "fha" || insured === "va" ? "Government Conveyance" : "REO";
}

export interface LiquidationRailInput {
  readonly mode: ChannelMode; readonly cit: boolean; readonly reogram_subsumed: boolean;
  readonly kind: LiquidationKind; readonly insured: InsuredFlag; readonly principal_cents: Cents; readonly interest_cents: Cents;
  readonly legal_date: PlainDate; readonly fnma_loan_number: string; readonly processed_at_ms?: number | null;
}
export interface LiquidationRail {
  readonly rail: "lar" | "dual" | "event";
  readonly lar_sent: boolean; readonly lar: { action_code: string; action_date: string } | null;
  readonly p360_event: Record<string, string> | null; readonly env: "api-clve" | "production" | null; readonly event_due_ms: number | null;
  /** Field-by-field differences between the two rails — 5.3's action_code/date/principal/interest diff plus `event_type` when 5.3's code-only mapping disagrees with the insured-flag mapping above. */
  readonly diff: readonly string[];
  /** The event type 5.3's projection would have sent (code-only mapping), for the diff's audit trail. */
  readonly event_type_5_3: string | null;
  /** The REOgram confirmation task stays on until Fannie Mae confirms the round-trip is subsumed (`p360.reogram.subsumed`). */
  readonly reogram_task: boolean;
}
/** Rule 12: under `mode = event` the same facts project the P360 liquidation event (to `api-clve` in CIT) instead of LAR 70/71/72; the REOgram task remains until the subsumed flag is on. */
export function liquidationRail(i: LiquidationRailInput): LiquidationRail {
  const p = projectLiquidationEvent({ mode: i.mode, kind: i.kind, insured: i.insured, principal_cents: i.principal_cents, interest_cents: i.interest_cents, legal_date: i.legal_date, fnma_loan_number: i.fnma_loan_number, cit: i.cit });
  const type15 = liquidationEventType(i.kind, i.insured);
  const type53 = p.p360_event?.["Liquidation Event Type"] ?? null;
  const event = p.p360_event === null ? null : { ...p.p360_event, "Liquidation Event Type": type15 };
  const diff = [...p.diff, ...(type53 !== null && type53 !== type15 ? ["event_type"] : [])];
  return {
    rail: i.mode === "legacy" ? "lar" : i.mode,
    lar_sent: i.mode !== "event", lar: i.mode === "event" ? null : { action_code: p.lar.action_code, action_date: p.lar.action_date },
    p360_event: event, env: p.env, event_due_ms: event === null || i.processed_at_ms === undefined || i.processed_at_ms === null ? null : eventDeadlineMs(i.processed_at_ms),
    diff, event_type_5_3: type53,
    reogram_task: i.kind === "third_party_sale" ? false : !(i.mode === "event" && i.reogram_subsumed),
  };
}

// ============================================================ rule 8 — TPS worked-example components
/** Monthly PTR interest on the UPB (worked example: $249,088.61 × 6.00% ÷ 12 = $1,245.44). */
export function monthlyPtrInterest(upb: Cents, ptrPct: string): Cents { return monthlyInterest(upb, ratePercent(ptrPct)); }
/** Daily PTR accrual shown to three decimals as the spec prints it (UPB × PTR ÷ 365 = $40.946). */
export function dailyPtrAccrual(upb: Cents, ptrPct: string): string { return "$" + centsToDecimal(upb).mul(ratePercent(ptrPct)).div(Decimal.fromInt(365)).toFixed(3); }
/**
 * The two rounded components of the F-1-20 accrual, each computed on its own: full 30/360 months (multiplied before
 * rounding) and the actual-day stub ÷ 365 (worked example: $13,699.87 + $163.78). `total_cents` is their sum, which the
 * test cross-checks against reogram.ts's single-pass `ptrInterest`.
 */
export function ptrInterestComponents(upb: Cents, ptrPct: string, from: PlainDate, to: PlainDate): { months_full: number; stub_days: number; months_cents: Cents; stub_cents: Cents; total_cents: Cents } {
  const whole = ptrInterest(upb, ptrPct, from, to);
  const rate = ratePercent(ptrPct); const u = centsToDecimal(upb).mul(Decimal.fromInt(100));
  const months = u.mul(rate).div(Decimal.fromInt(12)).mul(Decimal.fromInt(whole.months_full)).toScaledInt(0, "HALF_UP");
  const stub = u.mul(rate).div(Decimal.fromInt(365)).mul(Decimal.fromInt(whole.stub_days)).toScaledInt(0, "HALF_UP");
  return { months_full: whole.months_full, stub_days: whole.stub_days, months_cents: months, stub_cents: stub, total_cents: months + stub };
}
/** Note-rate / PTR spread interest for the servicer's own account: note-rate accrual less PTR accrual over the same period (each component half-up at cents). */
export function spreadInterest(upb: Cents, notePct: string, ptrPct: string, from: PlainDate, to: PlainDate): Cents { return ptrInterest(upb, notePct, from, to).cents - ptrInterest(upb, ptrPct, from, to).cents; }

export interface AdvanceItem { readonly kind: "taxes" | "hazard" | "mi_premium" | "inspection" | "preservation" | "attorney_fee" | "costs"; readonly unit_cents: Cents; readonly quantity: number; }
export interface AdvanceLine { readonly kind: AdvanceItem["kind"]; readonly cents: Cents; }
/** Unrecovered reimbursable advances in E-3.3-05 total-debt order (the order the items are listed in). */
export function unrecoveredAdvances(items: readonly AdvanceItem[]): { lines: readonly AdvanceLine[]; total_cents: Cents } {
  const lines = items.map((a) => ({ kind: a.kind, cents: a.unit_cents * BigInt(a.quantity) }));
  return { lines, total_cents: lines.reduce((s, l) => s + l.cents, 0n) };
}
export interface RecoveryWaterfall {
  readonly servicer_recovery_cents: Cents; readonly applied: readonly { kind: AdvanceItem["kind"]; applied_cents: Cents; remaining_cents: Cents }[];
  readonly claim_571_advances_cents: Cents; readonly spread_interest_written_off_cents: Cents; readonly surplus_cents: Cents;
}
/** Rule 8: recovery = min(gross − due, unrecovered advances) applied FIFO to reimbursable advances; spread interest is never recovered (written off); surplus goes per state law, never to Fannie Mae. */
export function recoveryWaterfall(i: { gross_proceeds_cents: Cents; amount_due_fnma_cents: Cents; advances: readonly AdvanceItem[]; spread_interest_cents: Cents }): RecoveryWaterfall {
  const adv = unrecoveredAdvances(i.advances);
  const available = i.gross_proceeds_cents - i.amount_due_fnma_cents;
  const recovery = available < 0n ? 0n : available < adv.total_cents ? available : adv.total_cents;
  let left = recovery;
  const applied = adv.lines.map((l) => { const a = left < l.cents ? left : l.cents; left -= a; return { kind: l.kind, applied_cents: a, remaining_cents: l.cents - a }; });
  return { servicer_recovery_cents: recovery, applied, claim_571_advances_cents: adv.total_cents - recovery, spread_interest_written_off_cents: i.spread_interest_cents, surplus_cents: available < 0n ? 0n : available - recovery };
}

/** The bidder's payment receipts the TPS case records (spec §Inputs: `tps.proceeds.received`, `tps.deposit.received`): the final payment completes the sale and starts the 5 `fannie_et` BD remittance clock (E-3.5-02). */
export function tpsProceedsReceipt(i: { kind: "final_payment" | "deposit"; received_on: PlainDate; amount_cents: Cents; completion_date?: PlainDate | null }, cal: Calendar = fannieEt): { event: "tps.proceeds.received" | "tps.deposit.received"; remit_due: PlainDate | null; completion_date: PlainDate | null; tps_status: "proceeds_received" | "awaiting_final_payment"; timer: "FNMA_E3502_TPS_PROCEEDS_5BD" | null } {
  if (i.kind === "deposit") return { event: "tps.deposit.received", remit_due: null, completion_date: null, tps_status: "awaiting_final_payment", timer: null };
  return { event: "tps.proceeds.received", remit_due: addBusinessDays(i.received_on, 5, cal), completion_date: i.completion_date ?? i.received_on, tps_status: "proceeds_received", timer: "FNMA_E3502_TPS_PROCEEDS_5BD" };
}

/** Escrow-type advances (taxes, hazard, MI premiums) are relieved from `escrow_advance`; corporate-type (inspections, preservation, attorney fees, costs) from `corporate_advance`. */
export const advanceAccount = (kind: AdvanceItem["kind"]): "escrow_advance" | "corporate_advance" => (kind === "taxes" || kind === "hazard" || kind === "mi_premium" ? "escrow_advance" : "corporate_advance");
/**
 * Spec Outputs / ledger: proceeds Dr `custodial_pi_cash` Cr `fnma_remittance_payable` (amount due Fannie Mae; the kernel's
 * corporate `fnma_payable`), Dr corporate cash Cr `corporate_advances`/`escrow_advances` for `servicer_recovery` (relieving the
 * loan's advance accounts in E-3.3-05 order) and surplus Dr custodial Cr `surplus_payable` (held in the loan's
 * `suspense_unapplied` until distributed per applicable law — the kernel has no surplus_payable account). Every set balances and
 * carries its F-1-20 `rule_ref`; nothing is ever remitted to Fannie Mae beyond `amount_due_fnma`.
 */
export function tpsProceedsLedgerSets(i: { loan_id: string; custodial_account_id: string; effective_date: PlainDate; amount_due_fnma_cents: Cents; servicer_recovery_cents: Cents; surplus_cents: Cents; applied?: readonly { kind: AdvanceItem["kind"]; applied_cents: Cents }[] | null }): readonly EntrySetInput[] {
  const sets: EntrySetInput[] = [];
  const cust = (account: "custodial_pi_cash", cents: Cents, ruleRef: string): LineInput => ({ account: { scope: "custodial", custodialAccountId: i.custodial_account_id, account }, amountCents: cents, ruleRef });
  if (i.amount_due_fnma_cents > 0n) sets.push({ effectiveDate: i.effective_date, description: `TPS proceeds — amount due Fannie Mae (F-1-20; CRS 311/351)`, lines: [cust("custodial_pi_cash", i.amount_due_fnma_cents, "15.1.F-1-20.amount_due_fnma"), { account: { scope: "corporate", account: "fnma_payable" }, amountCents: -i.amount_due_fnma_cents, ruleRef: "15.1.F-1-20.amount_due_fnma", memo: "fnma_remittance_payable" }] });
  if (i.servicer_recovery_cents > 0n) {
    const applied = (i.applied ?? []).filter((a) => a.applied_cents > 0n);
    const byAccount = new Map<"escrow_advance" | "corporate_advance", Cents>();
    for (const a of applied) byAccount.set(advanceAccount(a.kind), (byAccount.get(advanceAccount(a.kind)) ?? 0n) + a.applied_cents);
    const appliedTotal = [...byAccount.values()].reduce((s, c) => s + c, 0n);
    if (appliedTotal !== i.servicer_recovery_cents) byAccount.set("corporate_advance", (byAccount.get("corporate_advance") ?? 0n) + (i.servicer_recovery_cents - appliedTotal));
    const lines: LineInput[] = [{ account: { scope: "corporate", account: "corporate_cash" }, amountCents: i.servicer_recovery_cents, ruleRef: "15.1.F-1-20.servicer_recovery" }];
    for (const [account, cents] of byAccount) if (cents !== 0n) lines.push({ account: { scope: "loan", loanId: i.loan_id, account }, amountCents: -cents, ruleRef: "15.1.F-1-20.servicer_recovery", memo: `${account}s relieved (E-3.3-05 total-debt order)` });
    sets.push({ effectiveDate: i.effective_date, description: `TPS proceeds — servicer recovery of unrecovered advances (F-1-20; E-3.3-05)`, lines });
  }
  if (i.surplus_cents > 0n) sets.push({ effectiveDate: i.effective_date, description: `TPS proceeds — surplus payable per applicable law (E-3.5-02; never remitted to Fannie Mae)`, lines: [cust("custodial_pi_cash", i.surplus_cents, "15.1.F-1-20.surplus"), { account: { scope: "loan", loanId: i.loan_id, account: "suspense_unapplied" }, amountCents: -i.surplus_cents, ruleRef: "15.1.F-1-20.surplus", memo: "surplus_payable (distributed per applicable law)" }] });
  return sets;
}

/** CRS lines for the TPS remittance: 311 for the amount due (less any curtailment portion, which travels as 351). The remittance can never exceed `amount_due_fnma`. */
export function crsBatchLines(i: { amount_due_fnma_cents: Cents; curtailment_cents?: Cents | null; remit_cents?: Cents | null }): { lines: readonly { code: "311" | "351"; cents: Cents }[]; total_cents: Cents; refusal: string | null } {
  const total = i.remit_cents ?? i.amount_due_fnma_cents;
  if (total > i.amount_due_fnma_cents) return { lines: [], total_cents: 0n, refusal: `REMIT_EXCEEDS_AMOUNT_DUE: ${formatCents(total)} > amount_due_fnma ${formatCents(i.amount_due_fnma_cents)} (15.1 guardrail)` };
  const curt = i.curtailment_cents ?? 0n;
  const lines: { code: "311" | "351"; cents: Cents }[] = [{ code: "311", cents: total - curt }];
  if (curt > 0n) lines.push({ code: "351", cents: curt });
  return { lines, total_cents: total, refusal: null };
}

export type SurplusDisposition = "none" | "junior_lien" | "borrower" | "court_registry";
/** Rule 8 / T6: the surplus over `amount_due_fnma` and the servicer's recovery is distributed per applicable law (`jurisdiction_rules`) — junior liens, then the borrower, or the court registry where the state requires it — and is never remitted to Fannie Mae. */
export function surplusDisposition(i: { surplus_cents: Cents; jurisdiction_rules: { state: string; surplus_order?: readonly SurplusDisposition[]; court_registry_required?: boolean }; junior_liens_present: boolean }): { disposition: SurplusDisposition; cents: Cents; remitted_to_fnma_cents: 0n; rule_ref: string } {
  if (i.surplus_cents <= 0n) return { disposition: "none", cents: 0n, remitted_to_fnma_cents: 0n, rule_ref: "F-1-20: no surplus" };
  if (i.jurisdiction_rules.court_registry_required) return { disposition: "court_registry", cents: i.surplus_cents, remitted_to_fnma_cents: 0n, rule_ref: `jurisdiction_rules[${i.jurisdiction_rules.state}]: surplus deposited with the court registry` };
  const order = i.jurisdiction_rules.surplus_order ?? ["junior_lien", "borrower"];
  const disposition = order.find((d) => d === "borrower" || (d === "junior_lien" && i.junior_liens_present) || d === "court_registry") ?? "borrower";
  return { disposition, cents: i.surplus_cents, remitted_to_fnma_cents: 0n, rule_ref: `jurisdiction_rules[${i.jurisdiction_rules.state}]: ${order.join(" → ")} (E-3.5-02 "distributed in accordance with applicable law")` };
}

/** F-1-08: the closing statement goes to SF CPM the same day the 311 is remitted (`remitted_on` is the remittance's settlement date), with the breakdown through the sale date. */
export function closingStatement(i: { tps: TpsResult; upb_cents: Cents; servicing_fees_cents: Cents; advances_cents: Cents; other_cents: Cents; remitted_on: PlainDate }): { recipient: "sf_cpm"; send_by: PlainDate; on_time: boolean; timer: "FNMA_F108_TPS_CLOSING_STMT_SAME_DAY"; breakdown: { principal_cents: Cents; interest_cents: Cents; servicing_fees_cents: Cents; advances_cents: Cents; other_cents: Cents; amount_due_fnma_cents: Cents; servicer_recovery_cents: Cents; surplus_cents: Cents } } {
  return { recipient: "sf_cpm", send_by: i.remitted_on, on_time: i.remitted_on <= i.tps.settle_by, timer: "FNMA_F108_TPS_CLOSING_STMT_SAME_DAY", breakdown: { principal_cents: i.upb_cents, interest_cents: i.tps.ptr_interest_cents, servicing_fees_cents: i.servicing_fees_cents, advances_cents: i.advances_cents, other_cents: i.other_cents, amount_due_fnma_cents: i.tps.amount_due_fnma_cents, servicer_recovery_cents: i.tps.servicer_recovery_cents, surplus_cents: i.tps.surplus_cents } };
}

/** Rule 9 / T7: a failed third-party sale — the bidder's deposit goes to Fannie Mae (311) within 5 BD of discovery, the TPS case parks in `sale_failed` and the foreclosure case reopens for re-sale; over-remitted amounts come back through a 571 claim / IRT. */
export function failedThirdPartySale(i: { discovered_on: PlainDate; deposit_cents: Cents; over_remitted_cents?: Cents | null }, cal: Calendar = fannieEt): { deposit_remit_due: PlainDate; crs: { code: "311"; cents: Cents; kind: "tps_deposit" }; tps_status: "sale_failed"; foreclosure_case: { status: "reopened"; reason: string }; refund_request: { route: "571_claim_or_irt"; cents: Cents } | null } {
  const over = i.over_remitted_cents ?? 0n;
  return {
    deposit_remit_due: failedSaleDepositDue(i.discovered_on, cal), crs: { code: "311", cents: i.deposit_cents, kind: "tps_deposit" }, tps_status: "sale_failed",
    foreclosure_case: { status: "reopened", reason: "third-party sale failed to finalize — re-sale under Section 13 (E-3.5-02)" },
    refund_request: over > 0n ? { route: "571_claim_or_irt", cents: over } : null,
  };
}

// ============================================================ rules 3–4 — REOgram package and gates
export interface ResaleEvidence { readonly restriction: string | null; readonly notices_provided: boolean | null; readonly restriction_agreement_complied: boolean | null; readonly termination_actions_completed: boolean | null; }
export interface ResaleAttestation {
  readonly restriction: string; readonly applies: boolean;
  readonly notices_provided: boolean | null; readonly compliance_with_restriction_agreement: boolean | null; readonly termination_actions_completed: boolean | null;
  readonly missing: readonly string[]; readonly blocked: boolean; readonly escalate: "attorney" | null;
}
/**
 * E-4.1-01: by confirming, the servicer represents that (1) all required resale-restriction notices were provided, (2) the
 * foreclosure/Mortgage Release complied with any restriction agreement, and (3) actions terminating resale restrictions
 * were completed — three separate checkbox evidences; any one missing closes SM_RESALE_RESTRICTION_NOTICES (rule 4).
 */
export function resaleRestrictionAttestation(e: ResaleEvidence): ResaleAttestation {
  const restriction = e.restriction ?? "none";
  if (restriction === "none") return { restriction, applies: false, notices_provided: null, compliance_with_restriction_agreement: null, termination_actions_completed: null, missing: [], blocked: false, escalate: null };
  const missing: string[] = [];
  if (e.notices_provided !== true) missing.push("notices_provided");
  if (e.restriction_agreement_complied !== true) missing.push("compliance_with_restriction_agreement");
  if (e.termination_actions_completed !== true) missing.push("termination_actions_completed");
  const blocked = resaleRestrictionGate(restriction, e.notices_provided === true).blocked || missing.length > 0;
  return { restriction, applies: true, notices_provided: e.notices_provided, compliance_with_restriction_agreement: e.restriction_agreement_complied, termination_actions_completed: e.termination_actions_completed, missing, blocked, escalate: blocked ? "attorney" : null };
}

const boolOrNull = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
/** The MI data check behind the confirmation guardrail: the indicator must be known and an insured loan carries company, certificate and coverage % (from `mi_policies`). */
export function miDataCheck(f: Record<string, unknown>): { ok: boolean; missing: readonly string[] } {
  const ind = boolOrNull(f.mi_indicator);
  if (ind === null) return { ok: false, missing: ["mi_indicator"] };
  if (!ind) return { ok: true, missing: [] };
  const missing = (["mi_company", "mi_certificate", "mi_coverage_pct"] as const).filter((k) => typeof f[k] !== "string" || (f[k] as string) === "");
  return { ok: missing.length === 0, missing };
}
/**
 * Rule 4 / guardrail: "never confirm a REOgram without the resale-restriction gate and MI data check" — evaluated from the
 * facts supplied (a flat facts bag or the built package's fields). Refuses by omission: an unknown restriction status or
 * MI indicator closes the gate; nothing the caller leaves out is presumed satisfied (`assertGateOpen(loanId, 'SM_RESALE_RESTRICTION_NOTICES')`).
 */
export function reogramConfirmGate(f: Record<string, unknown>): { open: boolean; reason: string | null; gates_checked: readonly ["SM_RESALE_RESTRICTION_NOTICES", "MI_DATA_CHECK"]; attestation: ResaleAttestation | null } {
  const gates = ["SM_RESALE_RESTRICTION_NOTICES", "MI_DATA_CHECK"] as const;
  const att = f.resale_restriction_attestation as Partial<ResaleAttestation> | undefined;
  const restriction = typeof f.resale_restriction === "string" ? f.resale_restriction : typeof att?.restriction === "string" ? att.restriction : null;
  if (restriction === null) return { open: false, reason: "SM_RESALE_RESTRICTION_NOTICES not evaluated: properties.resale_restriction is unknown — supply the resale-restriction facts before confirming (E-4.1-01 representation)", gates_checked: gates, attestation: null };
  const attestation = resaleRestrictionAttestation({ restriction, notices_provided: boolOrNull(f.resale_notice_evidence ?? att?.notices_provided), restriction_agreement_complied: boolOrNull(f.restriction_agreement_complied ?? att?.compliance_with_restriction_agreement), termination_actions_completed: boolOrNull(f.termination_actions_completed ?? att?.termination_actions_completed) });
  if (attestation.blocked) return { open: false, reason: `SM_RESALE_RESTRICTION_NOTICES closed for ${restriction}: ${attestation.missing.join(", ")} unevidenced — escalate to attorney before confirming (rule 4)`, gates_checked: gates, attestation };
  const mi = miDataCheck(f);
  if (!mi.ok) return { open: false, reason: `MI_DATA_CHECK failed: ${mi.missing.join(", ")} missing — correct from mi_policies before confirming (rule 3)`, gates_checked: gates, attestation };
  return { open: true, reason: null, gates_checked: gates, attestation };
}

/** Rule 2 / T2: the confirmation warning fires at 70% of the receipt → due window (rounded to the millisecond; reogram.ts's `warningAt` floors a float product and lands 1 ms short on a 47.5 h window). */
export function confirmationWarning(receivedMs: number, dueMs: number, pct = 0.7): { warning_at_ms: number; window_ms: number; elapsed_pct: number } {
  return { warning_at_ms: receivedMs + Math.round((dueMs - receivedMs) * pct), window_ms: dueMs - receivedMs, elapsed_pct: pct };
}

/** Agents paragraph: confidence < 0.9 on purchaser type, bid amount or vesting date → hold and escalate (`human_agent` review) before deadline − 4 h. */
export function confidenceHold(f: { confidence: number | null; deadline_ms: number; fields: readonly string[] }): { held: boolean; review: { role: "human_agent"; request_at_ms: number; deadline_ms: number; fields: readonly string[] } | null } {
  const held = f.confidence !== null && f.confidence < 0.9;
  return { held, review: held ? { role: "human_agent", request_at_ms: f.deadline_ms - 4 * HOUR, deadline_ms: f.deadline_ms, fields: f.fields } : null };
}

/**
 * Rule 4: the gate is defined on the records — `properties.resale_restriction` and `mi_policies` — not on whatever the caller
 * supplies. Stored facts win; a supplied fact that contradicts a stored one is a conflict the confirmation is refused on.
 */
export function gateFactsFromRecords(i: { supplied: Record<string, unknown>; property: Record<string, unknown> | null; mi_policy: Record<string, unknown> | null; package: Record<string, unknown> | null }): { facts: Record<string, unknown>; sources: readonly string[]; conflicts: readonly string[] } {
  const facts: Record<string, unknown> = { ...(i.package ?? {}), ...i.supplied };
  const sources: string[] = []; const conflicts: string[] = [];
  const take = (key: string, value: unknown, source: string): void => {
    if (value === undefined || value === null) return;
    const before = facts[key];
    if (before !== undefined && before !== null && String(before) !== String(value)) conflicts.push(`${key}: supplied ${String(before)} ≠ ${source} ${String(value)}`);
    facts[key] = value; if (!sources.includes(source)) sources.push(source);
  };
  if (i.property) take("resale_restriction", i.property.resale_restriction, "properties");
  if (i.mi_policy) {
    const active = i.mi_policy.status === undefined || !/cancelled|terminated/.test(String(i.mi_policy.status));
    take("mi_indicator", active, "mi_policies");
    if (active) { take("mi_company", i.mi_policy.company ?? i.mi_policy.insurer_name, "mi_policies"); take("mi_certificate", i.mi_policy.certificate ?? i.mi_policy.certificate_number, "mi_policies"); take("mi_coverage_pct", i.mi_policy.coverage_pct === undefined ? undefined : String(i.mi_policy.coverage_pct), "mi_policies"); }
  }
  return { facts, sources, conflicts };
}

export interface ReogramPackageInput {
  readonly fnma_loan_number: string; readonly servicer_loan_number: string; readonly borrower_names: readonly string[];
  readonly property: { address: string; unit?: string | null; city: string; county: string; state: string; zip: string; property_type: string };
  readonly mi: { indicator: boolean; company?: string | null; certificate?: string | null; coverage_pct?: string | null };
  readonly attorney: string; readonly legal_date: PlainDate; readonly purchaser: "fnma" | "third_party"; readonly successful_bid_cents: Cents | null;
  readonly occupancy: string; readonly keys_lockbox: string | null; readonly preservation_vendor: string | null; readonly hoa_utility_notes: string | null;
  readonly resale_restriction: string | null; readonly resale_notice_evidence: boolean;
  readonly restriction_agreement_complied?: boolean | null; readonly termination_actions_completed?: boolean | null;
  readonly known_exceptions?: readonly { code: string; text: string; proposed_override?: string | null }[];
}
export interface ReogramPackage { readonly fields: Record<string, unknown>; readonly gates_checked: readonly string[]; readonly mi_data_ok: boolean; readonly missing: readonly string[]; readonly blocked: boolean; readonly attestation: ResaleAttestation; readonly escalation: Escalation | null; }
/** Rule 3: the portal task carries the full package; rule 4 / guardrail: no confirmation without the resale-restriction gate (three evidences) and the MI data check. */
export function reogramPackage(i: ReogramPackageInput): ReogramPackage {
  const missing: string[] = [];
  if (i.mi.indicator) for (const k of ["company", "certificate", "coverage_pct"] as const) if (!i.mi[k]) missing.push(`mi_${k}`);
  if (i.successful_bid_cents === null) missing.push("successful_bid");
  const att = resaleRestrictionAttestation({ restriction: i.resale_restriction, notices_provided: i.resale_notice_evidence, restriction_agreement_complied: i.restriction_agreement_complied ?? null, termination_actions_completed: i.termination_actions_completed ?? null });
  const miOk = !i.mi.indicator || missing.every((m) => !m.startsWith("mi_"));
  const blocked = att.blocked || !miOk;
  const escalation: Escalation | null = att.blocked ? { kind: "attorney", severity: "sev2", reason: `resale restriction ${i.resale_restriction}: ${att.missing.join(", ")} unevidenced — SM_RESALE_RESTRICTION_NOTICES gate closed (E-4.1-01 representation under the partner's servicer number)` }
    : !miOk ? { kind: "fnma_portal_operator", reason: `MI data incomplete (${missing.filter((m) => m.startsWith("mi_")).join(", ")}) — correct from mi_policies before confirming` } : null;
  return {
    fields: {
      fnma_loan_number: i.fnma_loan_number, servicer_loan_number: i.servicer_loan_number, borrower_names: i.borrower_names,
      property_address: i.property.address, unit: i.property.unit ?? null, city: i.property.city, county: i.property.county, state: i.property.state, zip: i.property.zip, property_type: i.property.property_type,
      mi_indicator: i.mi.indicator, mi_company: i.mi.company ?? null, mi_certificate: i.mi.certificate ?? null, mi_coverage_pct: i.mi.coverage_pct ?? null,
      attorney: i.attorney, legal_date: i.legal_date, purchaser: i.purchaser, successful_bid_cents: i.successful_bid_cents,
      occupancy: i.occupancy, keys_lockbox: i.keys_lockbox, preservation_vendor: i.preservation_vendor, hoa_utility_notes: i.hoa_utility_notes,
      resale_restriction: att.restriction,
      resale_restriction_attestation: { restriction: att.restriction, notices_provided: att.applies ? att.notices_provided : true, compliance_with_restriction_agreement: att.applies ? att.compliance_with_restriction_agreement : true, termination_actions_completed: att.applies ? att.termination_actions_completed : true },
      known_exceptions: i.known_exceptions ?? [],
    },
    gates_checked: ["SM_RESALE_RESTRICTION_NOTICES", "MI_DATA_CHECK"], mi_data_ok: miOk, missing, blocked, attestation: att, escalation,
  };
}

export type P360CaseKind = "reogram" | "third_party_sale";
export interface P360NotificationCase { readonly p360_case_id: string; readonly servicer_loan_number: string | null; readonly queue: "potential" | "exception" | "confirmed" | null; readonly kind: P360CaseKind; }
/** The daily Property 360 notification e-mail (REOgram queues, or TPS case creation): case ids, queue, kind and servicer loan numbers, parsed — never scraped. */
export function parseP360Notification(i: { subject: string; body: string; received_at: string }): { queue: "potential" | "exception" | "confirmed" | null; kind: P360CaseKind; cases: readonly P360NotificationCase[]; notification_received_at: string; portal_task_type: "p360.reogram.confirm" | "p360.reogram.exception" | "p360.tps.update_upload" } {
  const q = (s: string): "potential" | "exception" | "confirmed" | null => { const m = /\b(potential|exceptions?|confirmed)\b/i.exec(s); return m ? (m[1]!.toLowerCase().startsWith("exception") ? "exception" : (m[1]!.toLowerCase() as "potential" | "confirmed")) : null; };
  const kind: P360CaseKind = /\b(TPS|third[- ]party sale|liquidation reconciliation)\b/i.test(i.subject) ? "third_party_sale" : "reogram";
  const subjectQueue = q(i.subject);
  const cases = [...i.body.matchAll(/case\s*(?:id)?\s*[:#]?\s*([A-Z0-9-]{4,})(?:[^\n]*?servicer\s*loan\s*(?:number|no\.?|#)?\s*[:#]?\s*(\d{6,}))?(?:[^\n]*?queue\s*[:#]?\s*(potential|exceptions?|confirmed))?/gi)]
    .map((m) => ({ p360_case_id: m[1]!, servicer_loan_number: m[2] ?? null, queue: m[3] ? q(m[3]) : subjectQueue, kind }));
  const portal_task_type = kind === "third_party_sale" ? "p360.tps.update_upload" : (cases.some((c) => c.queue === "exception") || subjectQueue === "exception") ? "p360.reogram.exception" : "p360.reogram.confirm";
  return { queue: subjectQueue, kind, cases, notification_received_at: i.received_at, portal_task_type };
}

export interface ExceptionCorrection {
  readonly field: "mi_company" | "mi_certificate" | "mi_coverage_pct" | "other"; readonly p360_value: string | null; readonly proposed_value: string | null;
  readonly evidence: { source: "mi_policies"; mi_policy_id: string; company: string; certificate: string; coverage_pct: string } | null;
  readonly action: "edit_in_p360" | "override_with_evidence" | "source_system_correction" | "escalate_npdc"; readonly resolution_due: PlainDate; readonly escalation: Escalation | null;
}
/** T4 / rule 3: an MI exception ("MI company mismatch") is resolved within 3 fannie_et BD with a correction proposed from `mi_policies` and its evidence — edited in P360 inside the 5-BD window, overridden with evidence (≤2 attempts) or corrected in the source system. */
export function proposeExceptionCorrection(i: { exception: { code: string; text: string; overridable?: boolean; attempts?: number }; raised_on: PlainDate; p360_value: string | null; mi_policy: { id: string; company: string; certificate: string; coverage_pct: string } | null; confirmed_on?: PlainDate | null }, cal: Calendar = fannieEt): ExceptionCorrection {
  const t = i.exception.text.toLowerCase();
  const field: ExceptionCorrection["field"] = /mi company|insurer|mi provider/.test(t) ? "mi_company" : /certificate/.test(t) ? "mi_certificate" : /coverage/.test(t) ? "mi_coverage_pct" : "other";
  const proposed = i.mi_policy === null || field === "other" ? null : field === "mi_company" ? i.mi_policy.company : field === "mi_certificate" ? i.mi_policy.certificate : i.mi_policy.coverage_pct;
  const evidence = i.mi_policy === null || field === "other" ? null : { source: "mi_policies" as const, mi_policy_id: i.mi_policy.id, company: i.mi_policy.company, certificate: i.mi_policy.certificate, coverage_pct: i.mi_policy.coverage_pct };
  const inEditWindow = i.confirmed_on !== undefined && i.confirmed_on !== null && i.raised_on <= addBusinessDays(i.confirmed_on, 5, cal);
  const action: ExceptionCorrection["action"] = evidence === null ? "escalate_npdc" : inEditWindow ? "edit_in_p360" : i.exception.overridable && (i.exception.attempts ?? 0) < 2 ? "override_with_evidence" : "source_system_correction";
  return { field, p360_value: i.p360_value, proposed_value: proposed, evidence, action, resolution_due: exceptionResolutionDue(i.raised_on, cal), escalation: action === "escalate_npdc" ? { kind: "fnma_portal_operator", reason: `exception ${i.exception.code} has no mi_policies evidence — escalate to npdc_reogram@fanniemae.com` } : null };
}

// ============================================================ rules 5–7 — handoff tasks
export type HandoffKind = "hazard_cancel" | "flood_cancel" | "lpi_cancel" | "mortgagee_interest_removal" | "refund_capture" | "deed_record" | "title_curative" | "eviction_docs" | "recovery_firm_info" | "utilities_note" | "hoa_note" | "keys_vendor_contact" | "preservation_stop" | "cpm_issue_report";
export interface HandoffTask { readonly kind: HandoffKind; readonly due_at: PlainDate; readonly owner: "agent" | "fnma_portal_operator" | "attorney" | "vendor"; readonly timer: string | null; }
export type ForeclosedInNameOf = "servicer" | "fnma" | "mers_assignee";
/** Rule 5 / E-4.2-01: when foreclosed in the servicer's (or a MERS assignee's) name the deed to Fannie Mae is submitted the day after the sale — the next recording day, rolled to the next servicer business day when the recorder is closed (registry offset "+1 calendar_days (rolled to the next servicer business day)"). */
export function deedRecordDueRolled(legalDate: PlainDate, inNameOf: ForeclosedInNameOf, cal: Calendar = servicer): { due: PlainDate; task: "record_deed" | "obtain_recorded_copy_30"; rolled: boolean } {
  const base = deedRecordDue(legalDate, inNameOf === "fnma" ? "fnma" : "servicer");
  if (base.task !== "record_deed") return { due: base.due, task: base.task, rolled: false };
  const due = rollForward(base.due, cal);
  return { due, task: base.task, rolled: due !== base.due };
}
/** Rules 5–7: the post-sale handoff set with its clocks — insurance by day 14 (E-4.4-01/03), deed next recording day when foreclosed in the servicer's name and marketable title within 30 days on every sale (E-4.2-01), preservation stop at the legal date (E-4.3-01; TPS: at completion). */
export function handoffTasks(i: { legal_date: PlainDate; acquisition: "fnma" | "third_party"; foreclosed_in_name_of: ForeclosedInNameOf; flood_policy: boolean; lpi_policy: boolean; tps_completion_date?: PlainDate | null }): readonly HandoffTask[] {
  const insDue = i.acquisition === "third_party" ? (i.tps_completion_date ? insuranceCancellationDue(i.tps_completion_date) : null) : insuranceCancellationDue(i.legal_date);
  const tasks: HandoffTask[] = [];
  if (insDue) {
    tasks.push({ kind: "hazard_cancel", due_at: insDue, owner: "agent", timer: i.acquisition === "third_party" ? "FNMA_E3502_TPS_INSURANCE_CANCEL_14" : "FNMA_E4401_HAZARD_CANCEL_14" });
    if (i.flood_policy) tasks.push({ kind: "flood_cancel", due_at: insDue, owner: "agent", timer: i.acquisition === "third_party" ? "FNMA_E3502_TPS_INSURANCE_CANCEL_14" : "FNMA_E4403_FLOOD_CANCEL_14" });
    if (i.lpi_policy) tasks.push({ kind: "lpi_cancel", due_at: i.legal_date, owner: "agent", timer: null });
    tasks.push({ kind: "refund_capture", due_at: addDays(insDue, 30), owner: "agent", timer: null });
  }
  if (i.acquisition === "fnma") {
    const deed = deedRecordDueRolled(i.legal_date, i.foreclosed_in_name_of);
    if (deed.task === "record_deed") tasks.push({ kind: "deed_record", due_at: deed.due, owner: "attorney", timer: "FNMA_E4201_DEED_RECORD_NEXT_DAY" });
    tasks.push({ kind: "title_curative", due_at: addDays(i.legal_date, 30), owner: "attorney", timer: "SM_TITLE_MARKETABLE_30" });
    tasks.push({ kind: "preservation_stop", due_at: i.legal_date, owner: "agent", timer: "FNMA_E4301_PRESERVATION_STOP" });
    tasks.push({ kind: "keys_vendor_contact", due_at: i.legal_date, owner: "vendor", timer: null }, { kind: "hoa_note", due_at: i.legal_date, owner: "agent", timer: null }, { kind: "utilities_note", due_at: i.legal_date, owner: "agent", timer: null });
  } else if (i.tps_completion_date) tasks.push({ kind: "preservation_stop", due_at: i.tps_completion_date, owner: "agent", timer: null });
  return tasks;
}
/** On-request handoffs: recovery-firm policy/inspection information and eviction documents within 3 BD of the request (E-4.4-01, E-4.3-04). */
export function requestedDocumentsDue(requestedOn: PlainDate, kind: "recovery_firm_info" | "eviction_docs", cal: Calendar = fannieEt): HandoffTask {
  return { kind, due_at: addBusinessDays(requestedOn, 3, cal), owner: kind === "eviction_docs" ? "attorney" : "agent", timer: kind === "eviction_docs" ? "FNMA_E4304_EVICTION_DOCS_3BD" : "FNMA_E4401_RECOVERY_FIRM_INFO_3BD" };
}
/** The event a completed handoff task emits — the one its timer row is satisfied by. */
export function handoffCompletionEvent(kind: HandoffKind): { type: string; payload: Record<string, unknown> } {
  switch (kind) {
    case "deed_record": return { type: "deed.submitted_for_recording", payload: {} };
    case "title_curative": return { type: "deed.recorded", payload: { title_curative_clear: true } };
    case "eviction_docs": return { type: "fnma.request.fulfilled", payload: { kind: "eviction_documents" } };
    case "recovery_firm_info": return { type: "fnma.request.fulfilled", payload: { kind: "property_recovery" } };
    case "mortgagee_interest_removal": return { type: "insurance.mortgagee_removal.requested", payload: {} };
    case "hazard_cancel": case "lpi_cancel": return { type: "insurance.cancellation.requested", payload: { policy_kind: kind === "lpi_cancel" ? "lpi" : "hazard" } };
    case "flood_cancel": return { type: "flood.cancellation.requested", payload: { policy_kind: "flood" } };
    case "preservation_stop": return { type: "preservation.stop_work.confirmed", payload: {} };
    default: return { type: "reo.handoff.completed", payload: { kind } };
  }
}
/** Rule 7 / T9: a carrier refusal (Fannie Mae not the named insured) → mortgagee-interest removal request and a flagged comment for the final claim (E-4.4-01/02). */
export function carrierRefusal(refusedOn: PlainDate): { task: HandoffTask; final_claim_comment: string; claim_flag: { kind: "carrier_refused_refund"; rule: "E-4.4-02" } } {
  return { task: { kind: "mortgagee_interest_removal", due_at: addDays(refusedOn, 14), owner: "agent", timer: null }, final_claim_comment: "carrier refused cancellation/refund — Fannie Mae not the named insured; mortgagee-interest removal requested (E-4.4-01); no unearned-premium refund expected — state so on the final expense request (E-4.4-02)", claim_flag: { kind: "carrier_refused_refund", rule: "E-4.4-02" } };
}

/** Rule 6 / guardrail: a post-sale preservation order on Fannie Mae-acquired property is refused; an emergency order on SF CPM direction is allowed but flagged non-reimbursable by default; a third-party sale keeps Matrix preservation until completion (E-4.3-01; E-3.5-02). */
export function postSalePreservationOrder(f: { acquirer: "fannie_mae" | "third_party"; tps_completed: boolean; sf_cpm_directed: boolean; ordered_on: PlainDate }): { allowed: boolean; reason: string | null; nonreimbursable: boolean; task: HandoffTask | null } {
  const r = postSalePreservationAllowed({ acquirer: f.acquirer, sale_completed: true, tps_completed: f.tps_completed, sf_cpm_directed: f.sf_cpm_directed });
  return { ...r, task: r.allowed && f.acquirer === "fannie_mae" ? { kind: "cpm_issue_report", due_at: f.ordered_on, owner: "agent", timer: null } : null };
}
/** PTFA (12 U.S.C. §5220 note): a bona fide tenant identified after acquisition on the servicer-counsel path gets a 90-day notice to vacate and the lease honored; on Fannie Mae-managed property the information goes to Fannie Mae's eviction counsel. */
export function tenantIdentified(i: { bona_fide: boolean; vacate_date: PlainDate | null; servicer_counsel_path: boolean; lease_end?: PlainDate | null }): { event: "property.tenant.identified"; payload: { bona_fide: boolean; post_acquisition: true; vacate_date: PlainDate | null; lease_end: PlainDate | null; path: "servicer_counsel" | "fnma_vendor" }; notice_serve_by: PlainDate | null; timer: "PTFA_TENANT_NOTICE_90" | null; occupancy_status: "tenant_bona_fide" | "tenant" } {
  const path = i.servicer_counsel_path ? "servicer_counsel" : "fnma_vendor";
  const clock = i.bona_fide && i.servicer_counsel_path && i.vacate_date !== null;
  return { event: "property.tenant.identified", payload: { bona_fide: i.bona_fide, post_acquisition: true, vacate_date: i.vacate_date, lease_end: i.lease_end ?? null, path }, notice_serve_by: clock ? addDays(i.vacate_date!, -90) : null, timer: clock ? "PTFA_TENANT_NOTICE_90" : null, occupancy_status: i.bona_fide ? "tenant_bona_fide" : "tenant" };
}

// ============================================================ rule 10 — elimination / rescission template
export type RescissionReason = "sale_set_aside" | "bk_stay_violation" | "scra" | "title_defect" | "wrong_loan" | "reinstated_pre_sale" | "other";
export interface EliminationTemplate {
  readonly rows: { loan_id: string; fnma_loan_number: string; property_address: string; requested_action: "elimination" | "rescission" | "both"; reason_code: RescissionReason; reason_text: string; supporting_document_ids: readonly string[] };
  readonly submit_due: PlainDate; readonly submitted_by: "fnma_portal_operator"; readonly channel: "email_excel_template"; readonly portal_task_type: "elimination_rescission.submit";
  readonly on_approval: { reintegrate_within_hours: 24; title_steps_within_days: 2 }; readonly refo_fees_reimbursable: boolean; readonly fees_nonreimbursable_reason: "e4102_rescission" | null;
}
/** Rule 10 / E-4.1-02: template within 5 days of identification; re-add within 24 h and title steps within 2 days of approval; servicer-caused re-foreclosure fees are non-reimbursable. */
export function eliminationTemplate(i: { loan_id: string; fnma_loan_number: string; property_address: string; kind: "elimination" | "rescission" | "both"; reason_code: RescissionReason; reason_text: string; identified_on: PlainDate; supporting_document_ids: readonly string[]; servicer_caused: boolean }): EliminationTemplate {
  const clocks = rescissionClocks(i.identified_on, null);
  return {
    rows: { loan_id: i.loan_id, fnma_loan_number: i.fnma_loan_number, property_address: i.property_address, requested_action: i.kind, reason_code: i.reason_code, reason_text: i.reason_text, supporting_document_ids: i.supporting_document_ids },
    submit_due: clocks.template_due, submitted_by: "fnma_portal_operator", channel: "email_excel_template", portal_task_type: "elimination_rescission.submit",
    on_approval: { reintegrate_within_hours: 24, title_steps_within_days: 2 },
    refo_fees_reimbursable: !i.servicer_caused, fees_nonreimbursable_reason: i.servicer_caused ? "e4102_rescission" : null,
  };
}

/**
 * Rule 10 / state machine: on approval the loan is re-activated within 24 h — `sda_status`, escrow and statements resume, the
 * delinquency and foreclosure cases reopen, the REO case parks in `rescinded`, and when the LAR removal was accepted a 5.x re-add
 * request goes to `readd_requests@fanniemae.com` (a `fnma_portal_operator` e-mail task). The resumptions themselves run in 5.4/3.x/7.x
 * off `loan.reactivated`; this is the record of what was ordered.
 */
export function rescissionReactivation(i: { lar_removal_accepted: boolean; action_code?: string | null }): { resumes: readonly ["sda_status", "escrow", "statements"]; reopen: readonly ["delinquency", "foreclosure"]; reo_case_status: "rescinded"; readd_request: { required: boolean; mailbox: "readd_requests@fanniemae.com"; task_type: "fnma.readd_request.email"; action_code: string | null }; events: readonly string[] } {
  return { resumes: ["sda_status", "escrow", "statements"], reopen: ["delinquency", "foreclosure"], reo_case_status: "rescinded", readd_request: { required: i.lar_removal_accepted, mailbox: "readd_requests@fanniemae.com", task_type: "fnma.readd_request.email", action_code: i.action_code ?? null }, events: ["loan.reactivated", "sda_status.resumed", "delinquency.case.reopened", "foreclosure.case.reopened"] };
}

// ============================================================ rule 11 — compensatory-fee exposure
export interface CompFeeExposureRecord { readonly kind: "comp_fee_exposure"; readonly rule: "A1-4.2-02"; readonly due_on: PlainDate; readonly confirmed_on: PlainDate; readonly late_days: number; readonly crs_code: "313"; readonly rebuttal_evidence: string | null; readonly status: "open"; readonly matched_draft_id: null; }
/** Rule 11 / T3: late business days after `confirm_due_at`; a late confirmation books an exposure record (code 313 draft matched to it), a sev-1 and an `officer` notification with the reasonable-explanation evidence for the rebuttal. */
export function compFeeExposure(i: { due_on: PlainDate; confirmed_on: PlainDate; explanation?: string | null }, cal: Calendar = fannieEt): { late_days: number; exposure: boolean; crs_code: "313" | null; escalation: Escalation | null; rebuttal_evidence: string | null; record: CompFeeExposureRecord | null } {
  const late = lateDays(i.due_on, i.confirmed_on, cal);
  if (late === 0) return { late_days: 0, exposure: false, crs_code: null, escalation: null, rebuttal_evidence: null, record: null };
  return {
    late_days: late, exposure: true, crs_code: "313", escalation: { kind: "officer", severity: "sev1", reason: `REOgram confirmed ${late} business day(s) after the 1-BD deadline — compensatory-fee exposure (A1-4.2-02; CRS 313)` }, rebuttal_evidence: i.explanation ?? null,
    record: { kind: "comp_fee_exposure", rule: "A1-4.2-02", due_on: i.due_on, confirmed_on: i.confirmed_on, late_days: late, crs_code: "313", rebuttal_evidence: i.explanation ?? null, status: "open", matched_draft_id: null },
  };
}
/** Rule 11: an inbound CRS 313 ("Delayed REOgram Notification Fees") draft is matched to the loan's open exposure record for reconciliation; an unmatched draft is disputed through the `officer` rebuttal path. */
export function matchCode313Draft(draft: { draft_id: string; fnma_loan_number: string; amount_cents: Cents; draft_date: PlainDate }, exposures: readonly { id: string; fnma_loan_number: string | null; late_days: number; status: string }[]): { matched: boolean; exposure_id: string | null; disposition: "matched_reconcile" | "unmatched_dispute"; rebuttal_route: "officer"; amount_cents: Cents } {
  const x = exposures.find((e) => e.fnma_loan_number === draft.fnma_loan_number && e.status === "open" && e.late_days > 0);
  return { matched: x !== undefined, exposure_id: x?.id ?? null, disposition: x ? "matched_reconcile" : "unmatched_dispute", rebuttal_route: "officer", amount_cents: draft.amount_cents };
}

// ============================================================ gates
/** E-4.3-01: no servicer preservation after the sale / court-order vesting on Fannie Mae-acquired property (redemption periods included); TPS: until completion; emergency orders only on SF CPM direction. */
export function postSalePreservationAllowed(f: { acquirer: "fannie_mae" | "third_party" | null; sale_completed: boolean; tps_completed: boolean; sf_cpm_directed: boolean }): { allowed: boolean; reason: string | null; nonreimbursable: boolean } {
  if (!f.sale_completed || f.acquirer === null) return { allowed: true, reason: null, nonreimbursable: false };
  if (f.acquirer === "third_party") return f.tps_completed ? { allowed: false, reason: "third-party sale completed — buyer owns the property (E-3.5-02)", nonreimbursable: true } : { allowed: true, reason: null, nonreimbursable: false };
  if (f.sf_cpm_directed) return { allowed: true, reason: "emergency order on SF CPM direction after the sale (E-4.3-01)", nonreimbursable: true };
  return { allowed: false, reason: "FNMA_E4301_PRESERVATION_STOP: property preservation ceased at the foreclosure sale / court-order vesting regardless of title transfer (E-4.3-01)", nonreimbursable: true };
}
/** P360: confirmed-case fields stay editable for 5 business days after confirmation; later edits go to SF CPM through a human. */
export function reogramEditWindow(confirmedOn: PlainDate, today: PlainDate, cal: Calendar = fannieEt): { ends_on: PlainDate; open: boolean; route: "p360_edit" | "sf_cpm_human" } {
  const ends = addBusinessDays(confirmedOn, 5, cal);
  return { ends_on: ends, open: today <= ends, route: today <= ends ? "p360_edit" : "sf_cpm_human" };
}
