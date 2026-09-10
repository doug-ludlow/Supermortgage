/**
 * A deterministic 100-loan servicing-transfer batch for demos and boarding
 * tests: what a transferor would deliver under 1.1 for a September 1, 2026
 * transfer, with the portfolio shape of a real Fannie Mae book (vintages,
 * rates, ARMs, escrow, MI, delinquency, bankruptcy, foreclosure, loss
 * mitigation, SCRA, deferred balances, eNotes) and a designed set of data
 * defects so the DQ gate has something to find.
 *
 * Every figure is derived, not typed: UPB is the original amount amortized
 * through the paid-through date at the note rate (30/360), P&I is the level
 * payment on the original terms (so HF-005 holds), scheduled UPB for S/S
 * loans is the balance as if every installment had been paid, and the
 * payment history is the schedule the balances came from. The same seed
 * always yields the same batch; `tools/gen-transfer-batch.ts` writes it to
 * fixtures/transfer-batch-demo/. All people, addresses and identifiers are
 * synthetic (TINs use the never-issued 000 area number).
 */
import { createHash } from "node:crypto";
import { plainDate as D, addMonths, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { cents, levelPayment, ratePercent, centsToDecimal } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { makeMin } from "./min.ts";
import { PARTNER_ORG, TRANSFEROR_ORG } from "./fixtures.ts";
import type { StagedLoan, FnmaPosition, MersRecord, Installment, HistoricalPayment, RemittanceType } from "./types.ts";
import type { TransferBatchData, ImageRow, FairLendingRow } from "./tape-codec.ts";

export const DEMO_BATCH = {
  batch_id: "B-DEMO-2026-09",
  transfer_date: D("2026-09-01"),
  respa_effective_date: D("2026-09-01"),
  sale_date: D("2026-08-01"),
  transferor_name: "Northline Mortgage Servicing LLC",
  transferor_servicer_number: "123456789",
  partner_servicer_number: "987654321",
  transferor_mers_org_id: TRANSFEROR_ORG,
  partner_mers_org_id: PARTNER_ORG,
  d_code: "D-2026-0917-0042",
  loan_count: 100,
  seed: 20261001,
} as const;

/** The defects the generator plants, by transferor loan number, so a test can assert the gate finds exactly these. */
export interface DesignedOutcomes { readonly hard: ReadonlyMap<string, readonly string[]>; readonly warnings: ReadonlyMap<string, readonly string[]>; }
export interface DemoBatch extends TransferBatchData { readonly designed: DesignedOutcomes; readonly coborrowers: ReadonlyMap<string, string>; }

// ───────── deterministic randomness ─────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class Rng {
  private readonly next: () => number;
  constructor(seed: number) { this.next = mulberry32(seed); }
  float(): number { return this.next(); }
  int(lo: number, hi: number): number { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
}

// ───────── amortization (30/360, half-up to the cent, the HF-005 / W-014 arithmetic) ─────────
export function monthlyInterestCents(upb: bigint, ratePct: string): bigint { return centsToDecimal(upb).mul(ratePercent(ratePct)).div(Decimal.fromInt(12)).toCents("HALF_UP"); }
/** Balance after `paid` level payments on the original terms. */
export function amortizedBalance(originalUpb: bigint, ratePct: string, term: number, paid: number): bigint {
  const pi = levelPayment(originalUpb, ratePercent(ratePct), term);
  let upb = originalUpb;
  for (let i = 0; i < paid && upb > 0n; i++) { const int = monthlyInterestCents(upb, ratePct); upb -= pi - int; }
  return upb < 0n ? 0n : upb;
}
const monthsBetween = (a: PlainDate, b: PlainDate): number => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

// ───────── synthetic people and places ─────────
const FIRST = ["Maria", "James", "Ana", "Robert", "Linda", "Carlos", "Patricia", "Michael", "Jennifer", "David", "Sofia", "William", "Elizabeth", "Daniel", "Aisha", "Joseph", "Nguyen", "Priya", "Thomas", "Grace", "Samuel", "Rosa", "Kevin", "Hannah", "Luis", "Emily", "Marcus", "Olivia", "Ahmed", "Chloe"];
const LAST = ["Garcia", "Johnson", "Martinez", "Smith", "Nguyen", "Williams", "Rodriguez", "Brown", "Patel", "Davis", "Lopez", "Miller", "Kim", "Wilson", "Hernandez", "Anderson", "Okafor", "Thomas", "Chen", "Moore", "Reyes", "Jackson", "Singh", "White", "Torres", "Harris", "Ali", "Clark", "Flores", "Lewis"];
const STREETS = ["Maple Ave", "Oak St", "Cedar Ln", "Elm Dr", "Lakeview Rd", "Ridge Ct", "Sunset Blvd", "Willow Way", "Pine St", "Harbor Dr", "Meadow Ln", "Birch Rd", "Summit Ave", "River Rd", "Prairie Dr"];
const CITIES: Record<string, readonly [string, string][]> = {
  TX: [["Austin", "78701"], ["Houston", "77002"], ["Dallas", "75201"], ["San Antonio", "78205"]], CA: [["Sacramento", "95814"], ["Fresno", "93721"], ["Riverside", "92501"]], FL: [["Tampa", "33602"], ["Orlando", "32801"], ["Jacksonville", "32202"]],
  NY: [["Rochester", "14604"], ["Albany", "12207"]], IL: [["Naperville", "60540"], ["Peoria", "61602"]], OH: [["Columbus", "43215"], ["Cincinnati", "45202"]], PA: [["Pittsburgh", "15222"], ["Allentown", "18101"]], GA: [["Atlanta", "30303"], ["Savannah", "31401"]],
  NC: [["Charlotte", "28202"], ["Raleigh", "27601"]], AZ: [["Phoenix", "85004"], ["Tucson", "85701"]], WA: [["Tacoma", "98402"], ["Spokane", "99201"]], CO: [["Denver", "80202"], ["Aurora", "80012"]], MN: [["St. Paul", "55101"]], NJ: [["Newark", "07102"]], MD: [["Baltimore", "21202"]],
  NV: [["Reno", "89501"]],
};
const STATE_WEIGHTS: readonly [string, number][] = [["TX", 18], ["CA", 14], ["FL", 14], ["NY", 6], ["IL", 6], ["OH", 6], ["PA", 6], ["GA", 6], ["NC", 6], ["AZ", 5], ["WA", 4], ["CO", 4], ["MN", 2], ["NJ", 2], ["MD", 2]];
const pickState = (rng: Rng): string => { const total = STATE_WEIGHTS.reduce((s, [, w]) => s + w, 0); let r = rng.float() * total; for (const [st, w] of STATE_WEIGHTS) { r -= w; if (r < 0) return st; } return "TX"; };

// ───────── the designed portfolio ─────────
const ARM_SEQS = new Set([21, 24, 28, 33, 37, 48, 55, 59, 67, 74, 82, 87]);
const MI_SEQS = new Set([4, 11, 17, 25, 29, 38, 54, 63]);
const DELINQUENT_30 = new Set([20, 31, 44, 53, 62, 71, 79, 86, 90, 100]);
const DELINQUENT_60 = new Set([22, 36, 64, 88, 93]);
const DELINQUENT_90 = new Map<number, number>([[91, 5], [92, 4], [95, 3]]);   // months unpaid
const BK = new Map<number, { chapter: string; case_number: string; filed_on: PlainDate }>([[88, { chapter: "13", case_number: "26-31882", filed_on: D("2026-03-14") }], [89, { chapter: "7", case_number: "26-40217", filed_on: D("2026-06-02") }]]);
const FC = new Map<number, { referral_date: PlainDate; attorney: string }>([[91, { referral_date: D("2026-04-15"), attorney: "Hallmark & Reyes LLP" }], [92, { referral_date: D("2026-05-22"), attorney: "Carver Default Services" }]]);
const LOSSMIT = new Map<number, { application_status: string; received_on: PlainDate | null }>([[42, { application_status: "incomplete", received_on: null }], [95, { application_status: "complete_under_review", received_on: D("2026-07-19") }], [96, { application_status: "trial_period_plan", received_on: D("2026-04-03") }]]);
const NIB = new Map<number, { deferred: string; forborne: string }>([[40, { deferred: "18450.00", forborne: "0" }], [41, { deferred: "9120.55", forborne: "0" }], [43, { deferred: "0", forborne: "22300.00" }]]);
const ENOTE = new Set([98, 99]);
const UNREGISTERED_MIN = new Set([5, 6]);
const NON_MERS = new Set([15]);
const SII = new Map<number, boolean>([[45, false], [46, true], [47, true]]);   // present → complete?

/** Identifier numbering, so several copies of the batch can coexist on one platform (HF-017): loan-number prefix, Fannie Mae number base, MIN sequence base. */
export interface DemoNumbering { readonly prefix?: string; readonly fnma_base?: number; readonly min_sequence_base?: number; }

export function generateDemoBatch(seed: number = DEMO_BATCH.seed, numbering: DemoNumbering = {}): DemoBatch {
  const rng = new Rng(seed);
  const T = DEMO_BATCH.transfer_date;
  const loans: StagedLoan[] = []; const fnma: FnmaPosition[] = []; const mers: MersRecord[] = []; const trialBalance: TransferBatchData["trialBalance"][number][] = [];
  const images: ImageRow[] = []; const fairLending: FairLendingRow[] = []; const coborrowers = new Map<string, string>();
  const hard = new Map<string, string[]>(); const warnings = new Map<string, string[]>();
  const flag = (m: Map<string, string[]>, n: string, code: string): void => { const a = m.get(n); if (a) a.push(code); else m.set(n, [code]); };

  for (let seq = 1; seq <= DEMO_BATCH.loan_count; seq++) {
    const n = `${numbering.prefix ?? "TR"}-${String(seq).padStart(7, "0")}`;
    const fnmaNo = String((numbering.fnma_base ?? 4_100_000_000) + seq * 7);
    // vintage and terms
    const origYear = [8, 57].includes(seq) ? 2024 : rng.int(2015, 2025); const origMonth = origYear === 2025 ? rng.int(1, 6) : rng.int(1, 12);
    const origination = D(`${origYear}-${String(origMonth).padStart(2, "0")}-${String(rng.int(2, 27)).padStart(2, "0")}`);
    const firstPayment = addMonths(D(`${origYear}-${String(origMonth).padStart(2, "0")}-01`), 2);
    const term = rng.chance(0.85) ? 360 : rng.chance(0.65) ? 180 : 240;
    const isArm = ARM_SEQS.has(seq);
    // note rates in eighths by vintage (what a book originated 2015–2025 looks like); ARMs a quarter below fixed
    const eighths = (lo: number, hi: number): string[] => { const out: string[] = []; for (let r = lo; r <= hi + 1e-9; r += 0.125) out.push(r.toFixed(3)); return out; };
    const band = origYear <= 2019 ? eighths(3.75, 5.0) : origYear <= 2021 ? eighths(2.75, 3.5) : origYear === 2022 ? eighths(4.5, 6.5) : eighths(6.0, 7.5);
    const noteRate = seq === 97 ? "6.500" : (Number(rng.pick(band)) - (isArm ? 0.25 : 0)).toFixed(3);
    const value = rng.int(150_000, 1_100_000);
    const ltv = MI_SEQS.has(seq) ? rng.int(85, 97) : rng.int(55, 80);
    const originalUpb = cents(String(Math.round((value * ltv) / 100 / 50) * 50));
    const pi = levelPayment(originalUpb, ratePercent(noteRate), term);
    // schedule and delinquency
    const missed = DELINQUENT_90.get(seq) ?? (DELINQUENT_60.has(seq) ? 2 : DELINQUENT_30.has(seq) ? 1 : 0);
    const nextDue = addMonths(T, -missed);
    const paidCount = monthsBetween(firstPayment, nextDue);
    const upb = amortizedBalance(originalUpb, noteRate, term, paidCount);
    const scheduledUpb = amortizedBalance(originalUpb, noteRate, term, monthsBetween(firstPayment, T));
    const maturity = addMonths(firstPayment, term - 1);
    // escrow
    const state = seq === 34 ? "NV" : pickState(rng);
    const escrowed = seq === 58 || !rng.chance(0.15);
    const taxRate = state === "TX" || state === "NJ" || state === "IL" ? rng.int(180, 240) : rng.int(70, 140);   // bps of value per year
    const lines: { line_type: string; annual_amount_cents: bigint; next_due_date?: PlainDate }[] = escrowed
      ? [{ line_type: "county_tax", annual_amount_cents: cents(String(Math.round((value * taxRate) / 10_000))), next_due_date: D(state === "TX" ? "2027-01-31" : "2026-12-10") },
         { line_type: "hazard", annual_amount_cents: cents(String(rng.int(900, 2600))), next_due_date: addDays(T, rng.int(40, 330)) },
         ...(rng.chance(0.12) ? [{ line_type: "flood", annual_amount_cents: cents(String(rng.int(450, 1400))) }] : []),
         ...(MI_SEQS.has(seq) ? [{ line_type: "mi", annual_amount_cents: cents(String(Math.round(Number(originalUpb) / 100 * 0.0055)))}] : [])]
      : [];
    const annual = lines.reduce((s, l) => s + l.annual_amount_cents, 0n);
    const escrowPayment = annual === 0n ? 0n : (annual + 6n) / 12n;
    const escrowBalance = !escrowed ? 0n : seq % 17 === 0 ? -(escrowPayment * BigInt(rng.int(1, 3))) : escrowPayment * BigInt(rng.int(0, 5)) + BigInt(rng.int(0, 9999));
    const installmentAmount = pi + escrowPayment;
    const installments: Installment[] = []; const payments: HistoricalPayment[] = [];
    const scheduleStart = addMonths(T, -23);
    for (let i = 0; i < 24; i++) {
      const due = addMonths(scheduleStart, i);
      if (seq === 73 && (i === 9 || i === 10)) continue;                 // W-014: a two-month gap in the transferor's history (> 62 days)
      installments.push({ due_date: due, amount_cents: installmentAmount });
      if (due < nextDue) payments.push({ received_on: addDays(due, rng.int(-3, 12)), amount_cents: installmentAmount });
    }
    // identity, contact, property
    const first = rng.pick(FIRST), last = rng.pick(LAST);
    const [city, zip] = rng.pick(CITIES[state]!);
    const language = [12, 27, 68].includes(seq) ? null : rng.chance(0.06) ? "es" : "en";
    const noContact = seq === 3 || seq === 66;
    const min = NON_MERS.has(seq) || UNREGISTERED_MIN.has(seq) ? null : makeMin(TRANSFEROR_ORG, String((numbering.min_sequence_base ?? 0) + seq));
    const badMin = seq === 13 && min ? min.slice(0, 17) + String((Number(min[17]) + 1) % 10) : null;
    const bk = BK.get(seq); const fc = FC.get(seq); const lm = LOSSMIT.get(seq); const nib = NIB.get(seq); const sii = SII.get(seq);
    const loan: StagedLoan = {
      transferor_loan_number: n, fnma_loan_number: fnmaNo, min: badMin ?? min, mers_eligible: !NON_MERS.has(seq),
      remittance_type: (seq % 20 < 12 ? "A/A" : seq % 20 < 17 ? "S/A" : "S/S") as RemittanceType,
      upb_cents: upb, ...(seq % 20 >= 17 ? { scheduled_upb_cents: scheduledUpb } : {}), next_due_date: nextDue, note_rate_pct: noteRate, pi_cents: pi, escrow_payment_cents: escrowPayment,
      maturity_date: maturity, original_term_months: term, original_upb_cents: originalUpb, instrument_date: origination, origination_date: origination, first_payment_date: firstPayment,
      interest_method: rng.chance(0.9) ? "30_360" : "actual_365", amortization: isArm ? "arm" : "fixed",
      ...(isArm ? { arm: { index: "SOFR_30D_AVG", margin_bps: seq === 21 ? null : rng.pick([275, 300]), initial_cap_bps: rng.pick([200, 500]), periodic_cap_bps: 100, lifetime_cap_bps: 500, lookback_days: 45, next_change_date: D(`${rng.int(2027, 2029)}-${String(rng.int(1, 12)).padStart(2, "0")}-01`) } } : {}),
      escrowed, escrow_balance_cents: escrowBalance, escrow_lines: lines, escrow_sign_consistent: seq !== 58,
      last_escrow_analysis_date: !escrowed ? null : [50, 51, 52].includes(seq) ? addMonths(T, -15) : addDays(T, -rng.int(30, 330)),
      late_charge_pct: rng.pick(["4", "5", "5", "5"]), late_charge_grace_days: 15,
      deferred_principal_cents: nib ? cents(nib.deferred) : 0n, forborne_principal_cents: nib ? cents(nib.forborne) : 0n, nib_separated: true,
      bankruptcy: bk ? { active: true, ...bk } : { active: false },
      foreclosure: fc ? { active: true, ...fc } : { active: false },
      lossmit: lm ? { in_process: true, ...lm } : { in_process: false },
      scra: seq === 97 ? { active: true, rate_cap_reason: "Active duty orders on file; 6% cap applied 2026-03-01" } : { active: false },
      borrower: { legal_name: `${first} ${last}`, tin: `000-${String(rng.int(10, 99))}-${String(rng.int(1000, 9999))}`, ...(noContact ? {} : { phone: `+1${rng.int(201, 989)}555${String(rng.int(100, 999))}${rng.int(0, 9)}`, ...(rng.chance(0.8) ? { email: `${first.toLowerCase()}.${last.toLowerCase()}${seq}@example.test` } : {}) }), ...(language ? { preferred_language: language } : {}) },
      property: { address_line1: `${rng.int(100, 9899)} ${rng.pick(STREETS)}`, city, state, postal_code: zip, occupancy: rng.chance(0.88) ? "owner_occupied" : rng.chance(0.5) ? "second_home" : "investment" },
      custody: ENOTE.has(seq) ? { enote_evault_ref: `EV-${String(seq).padStart(6, "0")}` } : { custodian: "Bank Custodian NA", certification_status: rng.chance(0.93) ? "certified" : "pending" },
      consents: { esign_evidence: !rng.chance(0.1), tcpa_voice_evidence: !rng.chance(0.15) },
      tax_parcel_verified: seq !== 9, hazard_policy_expires: [18, 77].includes(seq) ? addDays(T, 14) : addDays(T, rng.int(45, 360)),
      mi: MI_SEQS.has(seq) ? { flag: true, ...(seq === 25 ? {} : { certificate_number: `MI-${rng.int(100000, 999999)}` }) } : { flag: false },
      flood_determination_life_of_loan: seq !== 30,
      sii: sii === undefined ? { present: false, complete: true } : { present: true, complete: sii },
      unapplied_cents: seq === 61 ? installmentAmount + 1500n : rng.chance(0.05) ? BigInt(rng.int(500, 40000)) : 0n,
      fair_lending_present: !(origination >= "2023-03-01" && [8, 57].includes(seq)) && !(origination < "2023-03-01" && rng.chance(0.5)),
      acp_enrolled: seq === 70,
      fees_advances_cents: seq === 80 ? cents("315.00") : rng.chance(0.07) ? BigInt(rng.int(2500, 60000)) : 0n, fees_itemized: seq !== 80,
      corporate_advances_cents: fc || bk ? BigInt(rng.int(80000, 420000)) : 0n, late_charges_due_cents: missed > 0 ? (pi * 5n) / 100n * BigInt(missed) : 0n,
      mers_investor_is_fnma: badMin || !min ? null : seq !== 85,
      installments, payments,
      ...(seq % 5 === 0 ? { last_principal_applied_cents: pi - monthlyInterestCents(upb, noteRate) + (seq === 75 ? 1n : 0n) } : {}),
    };
    loans.push(loan);
    if (rng.chance(0.3)) coborrowers.set(n, `${rng.pick(FIRST)} ${last}`);
    // external positions the gate compares against
    fnma.push({ fnma_loan_number: fnmaNo, on_approved_list: true, remittance_type: loan.remittance_type as RemittanceType, upb_cents: seq === 7 ? upb + 1n : upb, ...(loan.remittance_type === "S/S" ? { scheduled_upb_cents: scheduledUpb } : {}) });
    trialBalance.push({ transferor_loan_number: n, fnma_loan_number: fnmaNo, upb_cents: upb });
    if (min) mers.push({ min, status: "Active", servicer_org_id: TRANSFEROR_ORG, investor_org_id: seq === 85 ? "1009999" : "1000001" });
    for (const doc of ["note", "mortgage", "title_policy", ...(rng.chance(0.2) ? ["allonge"] : []), ...(nib ? ["deferral_agreement"] : [])]) {
      const filename = `${n}_${doc}.pdf`;
      images.push({ transferor_loan_number: n, document_type: doc, filename, sha256: createHash("sha256").update(`${seed}:${filename}`).digest("hex") });
    }
    if (loan.fair_lending_present) fairLending.push({ transferor_loan_number: n, ethnicity: rng.pick(["Not Hispanic or Latino", "Hispanic or Latino", "Not provided"]), race: rng.pick(["White", "Black or African American", "Asian", "American Indian or Alaska Native", "Not provided"]), sex: rng.pick(["Female", "Male", "Not provided"]), age: String(rng.int(24, 78)), preferred_language: language ?? "" });
    // the designed outcomes
    if (seq === 7) flag(hard, n, "HF-003");
    if (seq === 13) flag(hard, n, "HF-008");
    if (seq === 21) flag(hard, n, "HF-006");
    if (seq === 34) flag(hard, n, "HF-020");
    if (seq === 42) flag(hard, n, "HF-011");
    if (seq === 58) flag(hard, n, "HF-007");
    if (noContact) flag(warnings, n, "W-001");
    if (!loan.consents.esign_evidence) flag(warnings, n, "W-002");
    if (!loan.consents.tcpa_voice_evidence) flag(warnings, n, "W-003");
    if (seq === 9) flag(warnings, n, "W-004");
    if ([18, 77].includes(seq)) flag(warnings, n, "W-005");
    if (seq === 25) flag(warnings, n, "W-006");
    if (seq === 30) flag(warnings, n, "W-007");
    if (seq === 45) flag(warnings, n, "W-008");
    if ([50, 51, 52].includes(seq)) flag(warnings, n, "W-009");
    if (seq === 61) flag(warnings, n, "W-010");
    if (origination >= "2023-03-01" && !loan.fair_lending_present) flag(warnings, n, "W-011");
    if (!language) flag(warnings, n, "W-012");
    if (seq === 70) flag(warnings, n, "W-013");
    if (seq === 73 || seq === 75) flag(warnings, n, "W-014");
    if (seq === 80) flag(warnings, n, "W-015");
    if (seq === 85) flag(warnings, n, "W-016");
  }
  return { loans, fnma, trialBalance, mers, images, fairLending, coborrowers, designed: { hard, warnings } };
}
