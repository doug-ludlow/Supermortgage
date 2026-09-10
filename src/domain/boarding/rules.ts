/**
 * The 1.1 data-quality gate: hard rules HF-001…HF-020 (cannot board) and
 * warnings W-001…W-016 (boards with an open exception). Each rule is a pure
 * function of the staged loan and the external positions, returning a
 * `RuleResult` with expected/actual so the transferor query and the
 * exception queue can show both values (1.1-T2: "lists both values in cents").
 *
 * `money_field` marks rules whose failure is on a money field — those are
 * never agent-corrected and any waiver needs an `officer`.
 */
import { addMonths, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { absDiff, cents, levelPayment, monthlyInterest, ratePercent, centsToDecimal } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { isValidMin, minOrgId } from "./min.ts";
import type { StagedLoan, BatchContext, ExternalPositions, RuleResult, Severity } from "./types.ts";

export interface RuleInput {
  readonly loan: StagedLoan;
  readonly batch: BatchContext;
  readonly ext: ExternalPositions;
  /** Counts of fnma_loan_number / MIN across the batch for HF-017. */
  readonly batchCounts: { readonly loanNumbers: ReadonlyMap<string, number>; readonly mins: ReadonlyMap<string, number> };
}

export interface Rule {
  readonly code: string;
  readonly severity: Severity;
  readonly money_field: boolean;
  readonly title: string;
  readonly check: (i: RuleInput) => Omit<RuleResult, "code" | "severity" | "money_field">;
}

const pass = () => ({ result: "pass" as const });
const fail = (message: string, expected?: unknown, actual?: unknown) => ({ result: "fail" as const, message, expected, actual });
const missing = (v: unknown) => v === null || v === undefined || v === "";

export const PI_TOLERANCE_CENTS = 1n;
export const NEXT_DUE_LOOKBACK_MONTHS = 12;

export const HARD_RULES: readonly Rule[] = [
  { code: "HF-001", severity: "hard", money_field: false, title: "Fannie Mae loan number valid and on approved list / LSDU position",
    check: ({ loan, ext }) => {
      if (!loan.fnma_loan_number || !/^\d{10}$/.test(loan.fnma_loan_number)) return fail("fnma_loan_number must be 10 digits", "10 digits", loan.fnma_loan_number);
      const pos = ext.fnma(loan.fnma_loan_number);
      if (!pos) return fail("not in transferor's LSDU position", "position row", null);
      if (!pos.on_approved_list) return fail("not on the Fannie Mae-approved loan list", true, false);
      return pass();
    } },
  { code: "HF-002", severity: "hard", money_field: false, title: "Remittance type valid and equals Fannie Mae position",
    check: ({ loan, ext }) => {
      if (loan.remittance_type !== "A/A" && loan.remittance_type !== "S/A" && loan.remittance_type !== "S/S") return fail("remittance type not in {A/A, S/A, S/S}", ["A/A", "S/A", "S/S"], loan.remittance_type);
      const pos = loan.fnma_loan_number ? ext.fnma(loan.fnma_loan_number) : undefined;
      if (pos && pos.remittance_type !== loan.remittance_type) return fail("remittance type ≠ Fannie Mae position", pos.remittance_type, loan.remittance_type);
      return pass();
    } },
  { code: "HF-003", severity: "hard", money_field: true, title: "UPB equals trial balance and Fannie Mae position (cents)",
    check: ({ loan, ext }) => {
      if (loan.upb_cents === null) return fail("UPB missing", "cents", null);
      const tb = ext.trialBalanceUpb(loan.transferor_loan_number);
      if (tb !== undefined && tb !== loan.upb_cents) return fail("tape UPB ≠ trial-balance UPB", { trial_balance_cents: tb.toString() }, { tape_cents: loan.upb_cents.toString() });
      const pos = loan.fnma_loan_number ? ext.fnma(loan.fnma_loan_number) : undefined;
      if (pos) {
        const fnmaUpb = loan.remittance_type === "S/S" ? (pos.scheduled_upb_cents ?? pos.upb_cents) : pos.upb_cents;
        const tapeUpb = loan.remittance_type === "S/S" ? (loan.scheduled_upb_cents ?? loan.upb_cents) : loan.upb_cents;
        if (fnmaUpb !== tapeUpb) return fail("tape UPB ≠ Fannie Mae position UPB", { fnma_position_cents: fnmaUpb.toString() }, { tape_cents: tapeUpb.toString() });
      }
      return pass();
    } },
  { code: "HF-004", severity: "hard", money_field: false, title: "Next due date present and not older than 12 months before transfer",
    check: ({ loan, batch }) => {
      if (!loan.next_due_date) return fail("next due date missing", "date", null);
      const floor = addMonths(batch.transfer_date, -NEXT_DUE_LOOKBACK_MONTHS);
      if (loan.next_due_date < floor) return fail("next due date < transfer_date − 12 months", `≥ ${floor}`, loan.next_due_date);
      return pass();
    } },
  { code: "HF-005", severity: "hard", money_field: true, title: "Core terms present; fixed-rate P&I recomputes within $0.01",
    check: ({ loan }) => {
      const req: [string, unknown][] = [["note_rate_pct", loan.note_rate_pct], ["pi_cents", loan.pi_cents], ["maturity_date", loan.maturity_date], ["original_term_months", loan.original_term_months], ["interest_method", loan.interest_method]];
      const gaps = req.filter(([, v]) => missing(v)).map(([k]) => k);
      if (gaps.length) return fail(`missing ${gaps.join(", ")}`, req.map(([k]) => k), gaps);
      if (loan.amortization === "fixed" && loan.original_upb_cents !== null) {
        const expected = levelPayment(loan.original_upb_cents, ratePercent(loan.note_rate_pct!), loan.original_term_months!);
        if (absDiff(expected, loan.pi_cents!) > PI_TOLERANCE_CENTS) return fail("fixed-rate P&I recomputation off by > $0.01", { recomputed_cents: expected.toString() }, { tape_pi_cents: loan.pi_cents!.toString() });
      }
      return pass();
    } },
  { code: "HF-006", severity: "hard", money_field: false, title: "ARM loan has index, margin, caps, look-back and next change date",
    check: ({ loan }) => {
      if (loan.amortization !== "arm") return pass();
      const a = loan.arm ?? {};
      const gaps = (["index", "margin_bps", "initial_cap_bps", "periodic_cap_bps", "lifetime_cap_bps", "lookback_days", "next_change_date"] as const).filter((k) => missing(a[k]));
      return gaps.length ? fail(`ARM missing ${gaps.join(", ")}`, "all ARM fields", gaps) : pass();
    } },
  { code: "HF-007", severity: "hard", money_field: true, title: "Escrow flag consistent with lines and balance sign",
    check: ({ loan }) => {
      if (loan.escrowed && loan.escrow_lines.length === 0) return fail("escrow flag true with no escrow lines", "≥1 line", 0);
      if (!loan.escrow_sign_consistent) return fail("escrow balance sign contradicts escrow history", "consistent", { balance_cents: loan.escrow_balance_cents.toString() });
      return pass();
    } },
  { code: "HF-008", severity: "hard", money_field: false, title: "MIN check digit, Active status, servicer Org ID",
    check: ({ loan, batch, ext }) => {
      if (!loan.min) return pass();
      if (!isValidMin(loan.min)) return fail("MIN fails Mod-10 check digit", "valid 18-digit MIN", loan.min);
      const rec = ext.mers(loan.min);
      if (rec && rec.status !== "Active") return fail("MIN not Active on MERS", "Active", rec.status);
      const org = rec?.servicer_org_id ?? minOrgId(loan.min);
      if (!batch.acceptable_mers_org_ids.has(org)) return fail("MERS servicer Org ID ≠ partner/transferor", [...batch.acceptable_mers_org_ids], org);
      return pass();
    } },
  { code: "HF-009", severity: "hard", money_field: false, title: "Bankruptcy flag has chapter, case number, filing date",
    check: ({ loan }) => {
      if (!loan.bankruptcy.active) return pass();
      const gaps = (["chapter", "case_number", "filed_on"] as const).filter((k) => missing(loan.bankruptcy[k]));
      return gaps.length ? fail(`bankruptcy missing ${gaps.join(", ")}`, "chapter/case_number/filed_on", gaps) : pass();
    } },
  { code: "HF-010", severity: "hard", money_field: false, title: "Foreclosure flag has referral date and attorney",
    check: ({ loan }) => {
      if (!loan.foreclosure.active) return pass();
      const gaps = (["referral_date", "attorney"] as const).filter((k) => missing(loan.foreclosure[k]));
      return gaps.length ? fail(`foreclosure missing ${gaps.join(", ")}`, "referral_date/attorney", gaps) : pass();
    } },
  { code: "HF-011", severity: "hard", money_field: false, title: "Loss-mit in process has application status and received date",
    check: ({ loan }) => {
      if (!loan.lossmit.in_process) return pass();
      const gaps = (["application_status", "received_on"] as const).filter((k) => missing(loan.lossmit[k]));
      return gaps.length ? fail(`loss mitigation missing ${gaps.join(", ")}`, "application_status/received_on", gaps) : pass();
    } },
  { code: "HF-012", severity: "hard", money_field: false, title: "SCRA flag with rate > 6% has a cap reason",
    check: ({ loan }) => {
      if (!loan.scra.active || !loan.note_rate_pct) return pass();
      if (Decimal.parse(loan.note_rate_pct).cmp(Decimal.parse("6")) > 0 && missing(loan.scra.rate_cap_reason)) return fail("SCRA active, rate > 6% and no cap reason", "rate ≤ 6% or reason", loan.note_rate_pct);
      return pass();
    } },
  { code: "HF-013", severity: "hard", money_field: false, title: "Borrower legal name and TIN present",
    check: ({ loan }) => {
      const gaps = (["legal_name", "tin"] as const).filter((k) => missing(loan.borrower[k]));
      return gaps.length ? fail(`borrower missing ${gaps.join(", ")}`, "legal_name/tin", gaps) : pass();
    } },
  { code: "HF-014", severity: "hard", money_field: false, title: "Property address and state present",
    check: ({ loan }) => {
      const gaps = (["address_line1", "state"] as const).filter((k) => missing(loan.property[k]));
      return gaps.length ? fail(`property missing ${gaps.join(", ")}`, "address_line1/state", gaps) : pass();
    } },
  { code: "HF-015", severity: "hard", money_field: false, title: "Late-charge percentage and grace days present",
    check: ({ loan }) => (missing(loan.late_charge_pct) || missing(loan.late_charge_grace_days)) ? fail("late charge % or grace days missing", "pct + grace days", { pct: loan.late_charge_pct, grace: loan.late_charge_grace_days }) : pass() },
  { code: "HF-016", severity: "hard", money_field: true, title: "Deferred/forborne balances separated from interest-bearing UPB",
    check: ({ loan }) => ((loan.deferred_principal_cents > 0n || loan.forborne_principal_cents > 0n) && !loan.nib_separated)
      ? fail("deferred/forborne balances not separated from interest-bearing UPB", "separated", { deferred: loan.deferred_principal_cents.toString(), forborne: loan.forborne_principal_cents.toString() }) : pass() },
  { code: "HF-017", severity: "hard", money_field: false, title: "No duplicate fnma_loan_number / MIN in batch or platform",
    check: ({ loan, ext, batchCounts }) => {
      if (loan.fnma_loan_number && ((batchCounts.loanNumbers.get(loan.fnma_loan_number) ?? 0) > 1 || ext.onPlatform("fnma_loan_number", loan.fnma_loan_number))) return fail("duplicate fnma_loan_number", "unique", loan.fnma_loan_number);
      if (loan.min && ((batchCounts.mins.get(loan.min) ?? 0) > 1 || ext.onPlatform("min", loan.min))) return fail("duplicate MIN", "unique", loan.min);
      return pass();
    } },
  { code: "HF-018", severity: "hard", money_field: false, title: "Custody record present (custodian/certification or eNote eVault)",
    check: ({ loan }) => (!loan.custody || (missing(loan.custody.custodian) && missing(loan.custody.enote_evault_ref))) ? fail("no custody record", "custodian+certification or eVault ref", loan.custody) : pass() },
  { code: "HF-020", severity: "hard", money_field: false, title: "Property state covered by a Supermortgage servicer license",
    check: ({ loan, ext }) => (loan.property.state && !ext.licensed(loan.property.state)) ? fail("property state not covered by a servicer license", "licensed", loan.property.state) : pass() },
];

export const WARNING_RULES: readonly Rule[] = [
  { code: "W-001", severity: "warning", money_field: false, title: "Phone/email present", check: ({ loan }) => (missing(loan.borrower.phone) && missing(loan.borrower.email)) ? fail("no phone or email") : pass() },
  { code: "W-002", severity: "warning", money_field: false, title: "E-SIGN consent evidence", check: ({ loan }) => loan.consents.esign_evidence ? pass() : fail("E-SIGN consent evidence missing") },
  { code: "W-003", severity: "warning", money_field: false, title: "TCPA consent evidence", check: ({ loan }) => loan.consents.tcpa_voice_evidence ? pass() : fail("TCPA consent evidence missing") },
  { code: "W-004", severity: "warning", money_field: false, title: "Tax parcel verified", check: ({ loan }) => loan.tax_parcel_verified ? pass() : fail("tax parcel unverified") },
  { code: "W-005", severity: "warning", money_field: false, title: "Hazard policy expires ≥ 30 days after transfer",
    check: ({ loan, batch }) => (loan.hazard_policy_expires && loan.hazard_policy_expires < addDays(batch.transfer_date, 30)) ? fail("hazard policy expires < 30 days after transfer", `≥ ${addDays(batch.transfer_date, 30)}`, loan.hazard_policy_expires) : pass() },
  { code: "W-006", severity: "warning", money_field: false, title: "MI certificate number", check: ({ loan }) => (loan.mi.flag && missing(loan.mi.certificate_number)) ? fail("MI flag without certificate number") : pass() },
  { code: "W-007", severity: "warning", money_field: false, title: "Life-of-loan flood determination", check: ({ loan }) => loan.flood_determination_life_of_loan ? pass() : fail("flood determination lacks life-of-loan contract evidence") },
  { code: "W-008", severity: "warning", money_field: false, title: "Successor-in-interest data complete", check: ({ loan }) => (loan.sii.present && !loan.sii.complete) ? fail("successor-in-interest data incomplete") : pass() },
  { code: "W-009", severity: "warning", money_field: false, title: "Escrow analysis within 12 months",
    check: ({ loan, batch }) => (loan.escrowed && (!loan.last_escrow_analysis_date || loan.last_escrow_analysis_date < addMonths(batch.transfer_date, -12))) ? fail("last escrow analysis > 12 months old", `≥ ${addMonths(batch.transfer_date, -12)}`, loan.last_escrow_analysis_date) : pass() },
  { code: "W-010", severity: "warning", money_field: true, title: "Unapplied funds below one full payment",
    check: ({ loan }) => { const p = (loan.pi_cents ?? 0n) + loan.escrow_payment_cents; return (p > 0n && loan.unapplied_cents >= p) ? fail("unapplied funds ≥ 1 full payment", `< ${p}`, loan.unapplied_cents.toString()) : pass(); } },
  { code: "W-011", severity: "warning", money_field: false, title: "Fair-lending data for originations ≥ 2023-03-01",
    check: ({ loan }) => (loan.origination_date && loan.origination_date >= "2023-03-01" && !loan.fair_lending_present) ? fail("fair-lending data missing for origination ≥ 2023-03-01") : pass() },
  { code: "W-012", severity: "warning", money_field: false, title: "Preferred language", check: ({ loan }) => missing(loan.borrower.preferred_language) ? fail("preferred language missing") : pass() },
  { code: "W-013", severity: "warning", money_field: false, title: "ACP enrollment flagged", check: ({ loan }) => loan.acp_enrolled ? fail("Address Confidentiality Program enrollment — restrict address handling") : pass() },
  { code: "W-014", severity: "warning", money_field: false, title: "Payment history continuity and interest-method consistency",
    check: ({ loan }) => {
      const sched = [...loan.installments].sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
      for (let i = 1; i < sched.length; i++) if (daysBetween(sched[i - 1]!.due_date, sched[i]!.due_date) > 62) return fail("payment history gap > 1 month", "monthly", `${sched[i - 1]!.due_date} → ${sched[i]!.due_date}`);
      if (loan.last_principal_applied_cents != null && loan.upb_cents !== null && loan.pi_cents !== null && loan.note_rate_pct) {
        const expectedPrincipal = loan.pi_cents - monthlyInterest(loan.upb_cents, ratePercent(loan.note_rate_pct));
        if (expectedPrincipal !== loan.last_principal_applied_cents) return fail("interest-method review (30/360 vs actual): transferor principal split differs", { expected_principal_cents: expectedPrincipal.toString() }, { transferor_principal_cents: loan.last_principal_applied_cents.toString() });
      }
      return pass();
    } },
  { code: "W-015", severity: "warning", money_field: true, title: "Fees/advances itemized", check: ({ loan }) => (loan.fees_advances_cents > 0n && !loan.fees_itemized) ? fail("fees/advances without itemization (A2-7-03)", "itemized", loan.fees_advances_cents.toString()) : pass() },
  { code: "W-016", severity: "warning", money_field: false, title: "MERS investor/note-owner is Fannie Mae", check: ({ loan }) => (loan.min && loan.mers_investor_is_fnma === false) ? fail("MERS investor/note-owner field ≠ Fannie Mae") : pass() },
];

export const ALL_RULES: readonly Rule[] = [...HARD_RULES, ...WARNING_RULES];
export const RULE_SET_VERSION = "boarding.dq.v1";

export function runRules(input: RuleInput, rules: readonly Rule[] = ALL_RULES): RuleResult[] {
  return rules.map((r) => ({ code: r.code, severity: r.severity, money_field: r.money_field, ...r.check(input) }));
}

/** Convenience for reports: the cents figure a rule compared, formatted for a transferor query. */
export function describeCents(c: bigint): string { return `${c.toString()} cents (${centsToDecimal(c).toFixed(2)})`; }
export { cents };
