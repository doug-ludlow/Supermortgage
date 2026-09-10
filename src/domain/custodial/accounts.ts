/**
 * §6.1/6.2 Custodial accounts (Forms 1013/1014) — depository eligibility,
 * the account plan, form lifecycle gates, the 3-BD ineligibility notice, and
 * T&I interest disposition.
 */
import { Machine } from "../../kernel/fsm/machine.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";

export type AccountUse = "A/A" | "S/A" | "S/S";
export interface Depository { readonly name: string; readonly insured: boolean; readonly well_capitalized: boolean; readonly total_assets_cents: Cents; readonly ratings: { readonly sp_st?: string; readonly sp_lt?: string; readonly moodys_st?: string; readonly moodys_lt?: string; readonly idc?: number; readonly kbra?: string } }

const SP_ST = ["A-3", "A-2", "A-1", "A-1+"], SP_LT = ["BBB-", "BBB", "BBB+", "A-", "A", "A+", "AA-", "AA", "AA+", "AAA"];
const MO_ST = ["P-3", "P-2", "P-1"], MO_LT = ["Baa3", "Baa2", "Baa1", "A3", "A2", "A1", "Aa3", "Aa2", "Aa1", "Aaa"];
const KBRA = ["D", "E", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
const atLeast = (scale: readonly string[], v: string | undefined, floor: string) => v !== undefined && scale.indexOf(v) >= scale.indexOf(floor);
export const LARGE_BANK_ASSETS_CENTS = 3_000_000_000_000n;   // $30B

/** 6.1 rule 1 — pure eligibility test with the rule applied recorded. */
export function evaluateDepositoryEligibility(d: Depository, use: AccountUse): { eligible: boolean; rule: string } {
  if (!d.insured || !d.well_capitalized) return { eligible: false, rule: "insured ∧ well_capitalized" };
  const r = d.ratings;
  if (d.total_assets_cents >= LARGE_BANK_ASSETS_CENTS) {
    const sp = r.sp_st !== undefined ? atLeast(SP_ST, r.sp_st, "A-3") : atLeast(SP_LT, r.sp_lt, "BBB-");
    const mo = r.moodys_st !== undefined ? atLeast(MO_ST, r.moodys_st, "P-3") : atLeast(MO_LT, r.moodys_lt, "Baa3");
    return { eligible: sp || mo, rule: "≥$30B: S&P ST≥A-3|LT≥BBB- ∨ Moody's ST≥P-3|LT≥Baa3" };
  }
  const std = (r.idc ?? 0) >= 125 || atLeast(KBRA, r.kbra, "C+");
  if (std) return { eligible: true, rule: "<$30B: IDC≥125 ∨ KBRA≥C+" };
  if (use !== "S/S" && ((r.idc ?? 0) >= 75 || atLeast(KBRA, r.kbra, "C"))) return { eligible: true, rule: "<$30B A/A,S/A only: IDC≥75 ∨ KBRA≥C" };
  return { eligible: false, rule: use === "S/S" ? "<$30B S/S: IDC≥125 ∨ KBRA≥C+ required" : "<$30B: IDC≥75 ∨ KBRA≥C" };
}

export interface PlannedAccount { readonly kind: "pi" | "ti"; readonly remittance_type?: AccountUse; readonly pool_class?: "mbs" | "portfolio_mrs"; readonly is_drafting_account: boolean; }
/** 6.1 rule 2: one P&I account per remittance_type × pool_class (S/S always split), exactly one drafting account per type, plus T&I. */
export function accountPlan(portfolio: readonly { remittance_type: AccountUse; pool_class: "mbs" | "portfolio_mrs" }[]): PlannedAccount[] {
  const out: PlannedAccount[] = []; const seen = new Set<string>(); const drafting = new Set<string>();
  for (const l of portfolio) {
    const cls = l.remittance_type === "S/S" ? l.pool_class : undefined;
    const key = `${l.remittance_type}|${cls ?? ""}`; if (seen.has(key)) continue; seen.add(key);
    const isDraft = !drafting.has(l.remittance_type); if (isDraft) drafting.add(l.remittance_type);
    out.push({ kind: "pi", remittance_type: l.remittance_type, ...(cls ? { pool_class: cls } : {}), is_drafting_account: isDraft });
  }
  out.push({ kind: "ti", is_drafting_account: false });
  return out;
}
/**
 * F-1-03 (05/13/2026) titling, verbatim — P&I: "(Name of servicer), as agent, trustee, and/or bailee for the benefit of Fannie Mae
 * and/or payments of various mortgagors and/or various owners of interests in mortgage-backed securities (Custodial Account)";
 * T&I (6.2): "(Name of servicer), as agent and/or trustee for the benefit of Fannie Mae and payments of various mortgagors,
 * respectively (Custodial Account)". The 2019 Form 1013 job aid names a subservicer "(Name of Subservicer) as subservicer for
 * (Name of Master Servicer)". 6.1 rule 3 compares this string byte-for-byte to the signature card / statement header.
 */
export function titleString(servicerName: string, kind: "pi" | "ti", masterServicerName?: string): string {
  const name = masterServicerName ? `${servicerName} as subservicer for ${masterServicerName}` : servicerName;
  return kind === "pi"
    ? `${name}, as agent, trustee, and/or bailee for the benefit of Fannie Mae and/or payments of various mortgagors and/or various owners of interests in mortgage-backed securities (Custodial Account)`
    : `${name}, as agent and/or trustee for the benefit of Fannie Mae and payments of various mortgagors, respectively (Custodial Account)`;
}
/** 6.1 rule 3: the generated title is compared byte-for-byte to the depository's signature card / statement header; a mismatch is the `title_mismatch` exception. */
export function titleMatches(expected: string, observed: string): { ok: true } | { ok: false; exception: "title_mismatch"; expected: string; observed: string } {
  return expected === observed ? { ok: true } : { ok: false, exception: "title_mismatch", expected, observed };
}

export type FormStatus = "in_draft" | "pending_signatures" | "signatures_declined" | "fully_signed" | "in_effect" | "pending_replacement" | "closed_reported";
export const formMachine = new Machine<FormStatus, { effective_reached?: boolean }>({
  name: "custodial_form", initial: "in_draft", states: ["in_draft", "pending_signatures", "signatures_declined", "fully_signed", "in_effect", "pending_replacement", "closed_reported"], terminal: ["closed_reported"],
  transitions: [
    { from: "in_draft", to: "pending_signatures", on: "send" }, { from: "pending_signatures", to: "signatures_declined", on: "declined" }, { from: "signatures_declined", to: "in_draft", on: "redraft" },
    { from: "pending_signatures", to: "fully_signed", on: "signed", roles: ["officer", "docusign"] },
    { from: "fully_signed", to: "in_effect", on: "effective", guard: (t) => (t.ctx.effective_reached ? undefined : "effective date not reached") },
    { from: "in_effect", to: "pending_replacement", on: "change_requested" }, { from: "pending_replacement", to: "in_effect", on: "replacement_effective" },
    { from: ["in_draft", "pending_signatures", "signatures_declined", "fully_signed", "in_effect", "pending_replacement"], to: "closed_reported", on: "close" },
  ],
});
/** A blocked deposit opens the portal work the operator needs: a CBAM Change/Replace when the executed Form 1014 does not list the loan's remittance type (6.2-T1), a signature chase while the form is pending. */
export interface DepositGateTask { readonly kind: "human_portal_task"; readonly role: "fnma_portal_operator"; readonly action: "cbam_change_replace" | "cbam_form_signature"; readonly form_kind: "1013" | "1014"; readonly add_remittance_types: readonly AccountUse[]; }
/** Gate: deposits only into accounts whose form is in effect (and, for T&I, whose remittance types cover the loan). */
export function depositGate(form: { status: FormStatus; remittance_types?: readonly AccountUse[]; kind: "1013" | "1014" }, loanType?: AccountUse): { ok: true } | { ok: false; gate: string; reason: string; task: DepositGateTask | null } {
  const gate = form.kind === "1013" ? "FNMA_F103_FORM1013_IN_EFFECT_GATE" : "FNMA_F103_FORM1014_IN_EFFECT_GATE";
  if (form.status !== "in_effect" && form.status !== "pending_replacement") return { ok: false, gate, reason: `form status ${form.status}`, task: form.status === "pending_signatures" || form.status === "fully_signed" ? { kind: "human_portal_task", role: "fnma_portal_operator", action: "cbam_form_signature", form_kind: form.kind, add_remittance_types: [] } : null };
  if (form.kind === "1014" && loanType && form.remittance_types && !form.remittance_types.includes(loanType)) return { ok: false, gate, reason: `Form 1014 does not cover ${loanType}; Change/Replace task required`, task: { kind: "human_portal_task", role: "fnma_portal_operator", action: "cbam_change_replace", form_kind: "1014", add_remittance_types: [loanType] } };
  return { ok: true };
}
/** 6.1 rule 5: Fannie Mae must be notified within 3 Fannie business days of an ineligibility detection (17:00 ET). */
export function ineligibilityNoticeDueMs(detectedOn: PlainDate): number { return zonedEpochMs(addBusinessDays(detectedOn, 3, fannieEt), "17:00", "America/New_York"); }
/** C-1.1-01 custodial deposit for lockbox items: 2 servicer business days (6.1-T6 uses the servicer calendar). */
export function lockboxCustodialDeadline(receiptOn: PlainDate): PlainDate { return addBusinessDays(receiptOn, 2, servicer); }
export function fdicUninsuredExposure(balanceCents: Cents, ownershipCategories = 1): Cents { const e = balanceCents - 25_000_000n * BigInt(ownershipCategories); return e > 0n ? e : 0n; }

/** 6.2 rule 2 — interest disposition. */
export function disposeInterest(creditCents: Cents, adminExpenseCents: Cents, statutoryToBorrowersCents: Cents): { to_borrowers_cents: Cents; to_fees_cents: Cents; to_corporate_cents: Cents; corporate_funds_shortfall_cents: Cents } {
  const net = creditCents - adminExpenseCents - statutoryToBorrowersCents;
  return { to_borrowers_cents: statutoryToBorrowersCents, to_fees_cents: adminExpenseCents, to_corporate_cents: net >= 0n ? net : 0n, corporate_funds_shortfall_cents: net < 0n ? -net : 0n };
}
export function interestDispositionDueMs(creditedOn: PlainDate, tz = "America/New_York"): number { return zonedEpochMs(addDays(creditedOn, 30), "17:00", tz); }
/** Statutory escrow interest (3.9 formula used in 6.2-T5): round_half_up(avg_daily_balance × rate × days / 365). */
export function statutoryEscrowInterest(avgDailyBalanceCents: Cents, ratePct: string, days: number): Cents {
  return divRound(avgDailyBalanceCents * Decimal.parse(ratePct).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");
}
