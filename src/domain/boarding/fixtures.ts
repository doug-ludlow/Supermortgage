/** Deterministic fixtures for boarding tests and demos. */
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { makeMin } from "./min.ts";
import type { StagedLoan, FnmaPosition, MersRecord, ExternalPositions, BatchContext, Installment, HistoricalPayment } from "./types.ts";

export const PARTNER_ORG = "1000123";
export const TRANSFEROR_ORG = "1000456";

/** Monthly schedule from `first` for `n` months, and on-time receipts for the first `paidThrough` of them. */
export function history(first: PlainDate, n: number, amount: bigint, paidCount: number): { installments: Installment[]; payments: HistoricalPayment[] } {
  const installments: Installment[] = [], payments: HistoricalPayment[] = [];
  for (let i = 0; i < n; i++) {
    const due = addMonths(first, i);
    installments.push({ due_date: due, amount_cents: amount });
    if (i < paidCount) payments.push({ received_on: due, amount_cents: amount });
  }
  return { installments, payments };
}

export interface LoanOverrides extends Partial<StagedLoan> { readonly seq?: number; }

/** A clean, fully-boardable fixed-rate escrowed loan; every field can be overridden. */
export function stagedLoan(o: LoanOverrides = {}): StagedLoan {
  const seq = o.seq ?? 1;
  const pi = levelPayment(cents("259033.17"), ratePercent("6.375"), 360);   // $1,616.03 — the 1.1 worked example P&I
  const escrow = cents("412.50");
  // Schedule Jul–Oct 2026 with Jul/Aug/Sep paid on time → current as of an Oct 1 transfer.
  const h = history(D("2026-07-01"), 4, pi + escrow, 3);
  const base: StagedLoan = {
    transferor_loan_number: `TR-${String(seq).padStart(7, "0")}`,
    fnma_loan_number: String(4_000_000_000 + seq).padStart(10, "0"),
    min: makeMin(PARTNER_ORG, String(seq)),
    mers_eligible: true,
    remittance_type: "A/A",
    upb_cents: cents("245634.12"),
    next_due_date: D("2026-10-01"),
    note_rate_pct: "6.375",
    pi_cents: pi,
    escrow_payment_cents: escrow,
    maturity_date: D("2051-07-01"),
    original_term_months: 360,
    original_upb_cents: cents("259033.17"),
    instrument_date: D("2021-06-15"),
    origination_date: D("2021-06-15"),
    first_payment_date: D("2021-08-01"),
    interest_method: "30_360",
    amortization: "fixed",
    escrowed: true,
    escrow_balance_cents: cents("1842.50"),
    escrow_lines: [{ line_type: "county_tax", annual_amount_cents: cents("3200") }, { line_type: "hazard", annual_amount_cents: cents("1750") }],
    escrow_sign_consistent: true,
    last_escrow_analysis_date: D("2026-03-15"),
    late_charge_pct: "4",
    late_charge_grace_days: 15,
    deferred_principal_cents: 0n,
    forborne_principal_cents: 0n,
    nib_separated: true,
    bankruptcy: { active: false },
    foreclosure: { active: false },
    lossmit: { in_process: false },
    scra: { active: false },
    borrower: { legal_name: `Borrower ${seq}`, tin: "***-**-1234", phone: "+15125550100", email: `b${seq}@example.com`, preferred_language: "en" },
    property: { address_line1: `${seq} Main St`, city: "Austin", state: "TX", postal_code: "78701", occupancy: "owner_occupied" },
    custody: { custodian: "Bank Custodian NA", certification_status: "certified" },
    consents: { esign_evidence: true, tcpa_voice_evidence: true },
    tax_parcel_verified: true,
    hazard_policy_expires: D("2027-06-15"),
    mi: { flag: false },
    flood_determination_life_of_loan: true,
    sii: { present: false, complete: true },
    unapplied_cents: 0n,
    fair_lending_present: true,
    acp_enrolled: false,
    fees_advances_cents: 0n,
    fees_itemized: true,
    corporate_advances_cents: 0n,
    late_charges_due_cents: 0n,
    mers_investor_is_fnma: true,
    installments: h.installments,
    payments: h.payments,
  };
  const { seq: _seq, ...rest } = o;
  return { ...base, ...rest };
}

export function batchContext(o: Partial<BatchContext> = {}): BatchContext {
  return { batch_id: "B1", transfer_date: D("2026-10-01"), transferor_party_id: "P-TR", transferor_servicer_number: "123456789", partner_servicer_number: "987654321",
    rule_set_version: "boarding.dq.v1", acceptable_mers_org_ids: new Set([PARTNER_ORG, TRANSFEROR_ORG]), ...o };
}

/** In-memory stand-in for LSDU / trial balance / MERS / licensing. Positions default to "agree with the tape". */
export class FakePositions implements ExternalPositions {
  readonly fnmaRows = new Map<string, FnmaPosition>();
  readonly tb = new Map<string, bigint>();
  readonly mersRows = new Map<string, MersRecord>();
  readonly licensedStates = new Set(["TX", "CA", "FL", "NY", "IL", "OH", "PA", "GA", "NC", "AZ", "WA", "CO", "MN", "NJ", "MD"]);
  readonly platform = { fnma_loan_number: new Set<string>(), min: new Set<string>() };

  agree(loan: StagedLoan): this {
    if (loan.fnma_loan_number) this.fnmaRows.set(loan.fnma_loan_number, { fnma_loan_number: loan.fnma_loan_number, on_approved_list: true, remittance_type: loan.remittance_type as "A/A", upb_cents: loan.upb_cents ?? 0n, ...(loan.scheduled_upb_cents != null ? { scheduled_upb_cents: loan.scheduled_upb_cents } : {}) });
    this.tb.set(loan.transferor_loan_number, loan.upb_cents ?? 0n);
    if (loan.min) this.mersRows.set(loan.min, { min: loan.min, status: "Active", servicer_org_id: loan.min.slice(0, 7) });
    return this;
  }
  fnma(n: string) { return this.fnmaRows.get(n); }
  trialBalanceUpb(n: string) { return this.tb.get(n); }
  mers(min: string) { return this.mersRows.get(min); }
  licensed(state: string) { return this.licensedStates.has(state); }
  onPlatform(kind: "fnma_loan_number" | "min", value: string) { return this.platform[kind].has(value); }
}
