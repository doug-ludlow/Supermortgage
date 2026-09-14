/**
 * §33.1 rule 7 — the demo book: a deterministic 12-loan book in the `m3-v1` layout (10 owner-occupied, 1 second home,
 * 1 investment; 9 current, 1 thirty days late, 1 in an active Chapter 13, 1 with a foreclosure referral; loan 12 has no
 * supplement row; loan 7's e-mail belongs to a homegrown party with the same name in 33.1-T5) with a matching supplement.
 * Every UPB, P&I and interest figure comes from the kernel (levelPayment / scheduledUpb / monthlyInterest) so worked
 * example A reproduces exactly: loan 1 UPB $441,366.13 after 23 payments, P&I $3,069.79, T&I $612.50, FMV $605,000.00.
 * All e-mails are @example.com, phones are +1 area 555-01xx test numbers; the supplement writes some in loose forms so
 * the importer's normalization is exercised.
 */
import { Decimal } from "../../../kernel/money/decimal.ts";
import { type Cents, levelPayment, monthlyInterest, ratePercent } from "../../../kernel/money/cents.ts";
import { type PlainDate, addMonths, parts, plainDate } from "../../../kernel/calendar/date.ts";
import { scheduledUpb } from "../../leads-pricing/ops-20-1.ts";
import { writeXlsx } from "../../../infra/files/xlsx.ts";
import { M3_V1, luhnCheckDigit } from "../profiles/m3-v1.ts";

export const DEMO_PARTNER = { legal_name: "Northlight Mortgage Servicing (FAKE partner)", nmlsr_id: "1234567", servicer_number: "300012345", mers_org_id: "1000123" };
export const DEMO_AS_OF = "2026-09-01";

export type DemoLoan = {
  n: number;
  servicer_loan_number: string;
  name: string;
  email: string | null;              // normalized (lower-case) — null when the supplement has no row
  phone: string | null;              // E.164 — null when the supplement has no row
  supplement_email: string | null;   // as written on the supplement (case may differ)
  supplement_phone: string | null;   // as written on the supplement ("(602) 555-0101", "303-555-0102", …)
  first_name: string;
  last_name: string;
  occupancy: "primary" | "second_home" | "investment";
  state: string;
  original_cents: Cents;
  note_rate_pct: string;
  term_months: number;
  origination_date: string;
  first_payment_date: string;
  payments_made: number;
  upb_cents: Cents;
  pi_cents: Cents;
  ti_cents: Cents;
  next_due_date: string;
  last_payment_date: string;
  maturity_date: string;
  remaining_term_months: number;
  mers_min: string;
  /** Every tape value, keyed by the m3-v1 fact key, exactly as the tape row carries it (numbers for money/rate/int/pct cells). */
  tape: Record<string, string | number | null>;
};

type Seed = {
  n: number; first: string; last: string; email: string | null; supplement_email: string | null; supplement_phone: string | null; phone: string | null;
  address: string; city: string; state: string; zip: string; county: string;
  original: string; rate: string; closing: string; firstPayment: string;
  occupancy: "primary" | "second_home" | "investment"; propertyTypeCode: string; propertyType: string; purpose: "P" | "R";
  ti: string; appraised: string; fmv: string; bpo: string; fico: number; ficoOrig: number; dti: string;
  monthsBehind: number;                       // 0 current; 1 = thirty days late; 4 = foreclosure referral
  bk?: { chapter: string; filed: string; motion?: string };
  fcReferral?: string;
  remittance: string; pmi?: { rate: string; coverage: string; company: string };
  bedrooms: number; baths: string; sqft: number; garage: string; lot: string; zipRank: number; docType: string;
};

const SEEDS: readonly Seed[] = [
  { n: 1, first: "Maria", last: "Garcia", email: "maria.garcia@example.com", supplement_email: "Maria.Garcia@example.com", supplement_phone: "(602) 555-0101", phone: "+16025550101",
    address: "1200 W Maple Ave", city: "Phoenix", state: "AZ", zip: "85013", county: "Maricopa", original: "450000.00", rate: "7.250", closing: "2024-09-20", firstPayment: "2024-11-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "612.50", appraised: "562500.00", fmv: "605000.00", bpo: "610000.00", fico: 748, ficoOrig: 741, dti: "36.20",
    monthsBehind: 0, remittance: "FNMA A/A", bedrooms: 4, baths: "2.5", sqft: 2140, garage: "2 car attached", lot: "0.19 ac", zipRank: 2, docType: "Full" },
  { n: 2, first: "James", last: "Whitfield", email: "james.whitfield@example.com", supplement_email: "james.whitfield@example.com", supplement_phone: "303-555-0102", phone: "+13035550102",
    address: "8842 Cedar Ridge Dr", city: "Denver", state: "CO", zip: "80220", county: "Denver", original: "385000.00", rate: "6.625", closing: "2023-05-12", firstPayment: "2023-07-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "548.30", appraised: "481250.00", fmv: "512000.00", bpo: "508000.00", fico: 762, ficoOrig: 755, dti: "33.80",
    monthsBehind: 0, remittance: "FNMA A/A", bedrooms: 3, baths: "2", sqft: 1860, garage: "2 car attached", lot: "0.16 ac", zipRank: 1, docType: "Full" },
  { n: 3, first: "Priya", last: "Natarajan", email: "priya.natarajan@example.com", supplement_email: "PRIYA.NATARAJAN@EXAMPLE.COM", supplement_phone: "+1 916 555 0103", phone: "+19165550103",
    address: "415 Birchwood Ln", city: "Sacramento", state: "CA", zip: "95819", county: "Sacramento", original: "520000.00", rate: "5.500", closing: "2022-08-25", firstPayment: "2022-10-01",
    occupancy: "primary", propertyTypeCode: "PU", propertyType: "PUD", purpose: "R", ti: "701.40", appraised: "650000.00", fmv: "688000.00", bpo: "690000.00", fico: 781, ficoOrig: 770, dti: "29.50",
    monthsBehind: 0, remittance: "FNMA S/A", bedrooms: 4, baths: "3", sqft: 2380, garage: "2 car attached", lot: "0.21 ac", zipRank: 1, docType: "Full" },
  { n: 4, first: "Robert", last: "Kim", email: "robert.kim@example.com", supplement_email: "robert.kim@example.com", supplement_phone: "8015550104", phone: "+18015550104",
    address: "2201 Juniper Ct Unit 12", city: "Salt Lake City", state: "UT", zip: "84106", county: "Salt Lake", original: "340000.00", rate: "7.000", closing: "2023-11-15", firstPayment: "2024-01-01",
    occupancy: "primary", propertyTypeCode: "CO", propertyType: "Condominium", purpose: "P", ti: "486.75", appraised: "400000.00", fmv: "415000.00", bpo: "412000.00", fico: 712, ficoOrig: 704, dti: "41.30",
    monthsBehind: 0, remittance: "FNMA A/A", pmi: { rate: "0.550", coverage: "25", company: "FAKE Mortgage Guaranty" }, bedrooms: 2, baths: "2", sqft: 1240, garage: "1 car garage", lot: "n/a", zipRank: 2, docType: "Full" },
  { n: 5, first: "Elena", last: "Petrova", email: "elena.petrova@example.com", supplement_email: "elena.petrova@example.com", supplement_phone: "(360) 555-0105", phone: "+13605550105",
    address: "77 Harbor View Rd", city: "Bellingham", state: "WA", zip: "98225", county: "Whatcom", original: "610000.00", rate: "6.875", closing: "2024-03-08", firstPayment: "2024-05-01",
    occupancy: "second_home", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "823.10", appraised: "815000.00", fmv: "842000.00", bpo: "838000.00", fico: 795, ficoOrig: 788, dti: "31.90",
    monthsBehind: 0, remittance: "FNMA A/A", bedrooms: 3, baths: "2.5", sqft: 2010, garage: "2 car detached", lot: "0.34 ac", zipRank: 1, docType: "Full" },
  { n: 6, first: "Marcus", last: "Bell", email: "marcus.bell@example.com", supplement_email: "marcus.bell@example.com", supplement_phone: "407-555-0106", phone: "+14075550106",
    address: "5510 Lakeshore Blvd", city: "Orlando", state: "FL", zip: "32803", county: "Orange", original: "295000.00", rate: "7.125", closing: "2023-02-17", firstPayment: "2023-04-01",
    occupancy: "investment", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "534.60", appraised: "390000.00", fmv: "402000.00", bpo: "398000.00", fico: 733, ficoOrig: 728, dti: "39.60",
    monthsBehind: 0, remittance: "FNMA S/A", bedrooms: 3, baths: "2", sqft: 1520, garage: "carport", lot: "0.17 ac", zipRank: 3, docType: "Full" },
  { n: 7, first: "Daniel", last: "Okafor", email: "daniel.okafor@example.com", supplement_email: "daniel.okafor@example.com", supplement_phone: "(702) 555-0107", phone: "+17025550107",
    address: "930 Sunset Ridge Way", city: "Las Vegas", state: "NV", zip: "89138", county: "Clark", original: "405000.00", rate: "6.750", closing: "2024-06-21", firstPayment: "2024-08-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "571.25", appraised: "506250.00", fmv: "521000.00", bpo: "518000.00", fico: 757, ficoOrig: 749, dti: "35.10",
    monthsBehind: 0, remittance: "FNMA A/A", bedrooms: 4, baths: "3", sqft: 2290, garage: "3 car attached", lot: "0.18 ac", zipRank: 2, docType: "Full" },
  { n: 8, first: "Susan", last: "Alvarez", email: "susan.alvarez@example.com", supplement_email: "susan.alvarez@example.com", supplement_phone: "512.555.0108", phone: "+15125550108",
    address: "1608 Pecan Grove St", city: "Austin", state: "TX", zip: "78745", county: "Travis", original: "372500.00", rate: "6.250", closing: "2022-11-30", firstPayment: "2023-01-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "664.90", appraised: "465625.00", fmv: "474000.00", bpo: "470000.00", fico: 668, ficoOrig: 721, dti: "44.80",
    monthsBehind: 1, remittance: "FNMA A/A", bedrooms: 3, baths: "2", sqft: 1710, garage: "2 car attached", lot: "0.15 ac", zipRank: 3, docType: "Full" },
  { n: 9, first: "Thomas", last: "Nguyen", email: "thomas.nguyen@example.com", supplement_email: "thomas.nguyen@example.com", supplement_phone: "+15205550109", phone: "+15205550109",
    address: "3025 Ironwood Dr", city: "Tucson", state: "AZ", zip: "85718", county: "Pima", original: "288000.00", rate: "5.875", closing: "2021-10-05", firstPayment: "2021-12-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "R", ti: "402.15", appraised: "360000.00", fmv: "398000.00", bpo: "395000.00", fico: 774, ficoOrig: 766, dti: "27.40",
    monthsBehind: 0, remittance: "FNMA A/A", bedrooms: 3, baths: "2", sqft: 1650, garage: "2 car attached", lot: "0.22 ac", zipRank: 1, docType: "Full" },
  { n: 10, first: "Angela", last: "Brooks", email: "angela.brooks@example.com", supplement_email: "angela.brooks@example.com", supplement_phone: "(813) 555-0110", phone: "+18135550110",
    address: "4419 Coral Way", city: "Tampa", state: "FL", zip: "33629", county: "Hillsborough", original: "330000.00", rate: "7.375", closing: "2023-08-11", firstPayment: "2023-10-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "598.40", appraised: "412500.00", fmv: "405000.00", bpo: "401000.00", fico: 611, ficoOrig: 698, dti: "47.90",
    monthsBehind: 4, fcReferral: "2026-08-14", remittance: "FNMA S/S", bedrooms: 3, baths: "2", sqft: 1580, garage: "1 car garage", lot: "0.14 ac", zipRank: 4, docType: "Full" },
  { n: 11, first: "Kevin", last: "O'Connell", email: "kevin.oconnell@example.com", supplement_email: "kevin.oconnell@example.com", supplement_phone: "719-555-0111", phone: "+17195550111",
    address: "1877 Aspen Meadow Ln", city: "Colorado Springs", state: "CO", zip: "80906", county: "El Paso", original: "356000.00", rate: "5.625", closing: "2022-04-22", firstPayment: "2022-06-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "509.80", appraised: "445000.00", fmv: "468000.00", bpo: "465000.00", fico: 642, ficoOrig: 736, dti: "42.60",
    monthsBehind: 0, bk: { chapter: "13", filed: "2026-03-10", motion: "2026-06-02" }, remittance: "FNMA A/A", bedrooms: 4, baths: "2.5", sqft: 2050, garage: "2 car attached", lot: "0.20 ac", zipRank: 2, docType: "Full" },
  { n: 12, first: "Linda", last: "Marsh", email: null, supplement_email: null, supplement_phone: null, phone: null,
    address: "640 Quail Hollow Rd", city: "Reno", state: "NV", zip: "89511", county: "Washoe", original: "298000.00", rate: "7.500", closing: "2023-09-29", firstPayment: "2023-11-01",
    occupancy: "primary", propertyTypeCode: "SF", propertyType: "Single Family", purpose: "P", ti: "455.30", appraised: "372500.00", fmv: "384000.00", bpo: "381000.00", fico: 739, ficoOrig: 731, dti: "34.70",
    monthsBehind: 0, remittance: "FNMA A/A", bedrooms: 3, baths: "2", sqft: 1690, garage: "2 car attached", lot: "0.23 ac", zipRank: 2, docType: "Full" },
];

const AS_OF = plainDate(DEMO_AS_OF);
const cents = (dollars: string): Cents => Decimal.parse(dollars).toCents("HALF_UP");
const dollars = (c: Cents): number => Number(c) / 100;                       // the tape carries dollars as numeric cells
const pctOf = (num: Cents, den: Cents): number => Number(Decimal.ratio(num * 100n, den).toFixed(2, "HALF_UP"));
const monthsInclusive = (from: PlainDate, to: PlainDate): number => { const a = parts(from), b = parts(to); return (b.y - a.y) * 12 + (b.m - a.m) + 1; };
const OCCUPANCY_TEXT = { primary: "Owner Occupied", second_home: "Second Home", investment: "Investment" } as const;
const OCCUPANCY_CODE = { primary: "O", second_home: "S", investment: "I" } as const;
const OCCUPANCY_SHORT = { primary: "Owner", second_home: "Second", investment: "Investor" } as const;

/** MERS MIN: the partner's 7-digit org id, a 10-digit sequence, and the Luhn check digit (always valid — the importer keeps it as loans.min). */
export function demoMin(n: number): string {
  const body = DEMO_PARTNER.mers_org_id + String(1_000_000 + n).padStart(10, "0");
  return body + String(luhnCheckDigit(body));
}

function buildLoan(s: Seed): DemoLoan {
  const original = cents(s.original);
  const first = plainDate(s.firstPayment);
  const term = 360;
  const pi = levelPayment(original, ratePercent(s.rate), term);
  const ti = cents(s.ti);
  // Payments made through the as-of date: a current loan paid the as-of month's installment; a delinquent loan stopped `monthsBehind` months earlier.
  const lastPaidDue = addMonths(AS_OF, -s.monthsBehind);
  const paymentsMade = monthsInclusive(first, lastPaidDue);
  const upb = scheduledUpb(original, s.rate, term, paymentsMade);
  const nextDue = addMonths(lastPaidDue, 1);
  const maturity = addMonths(first, term - 1);
  const remaining = term - paymentsMade;
  const accrued = monthlyInterest(upb, ratePercent(s.rate));
  const fmv = cents(s.fmv), appraised = cents(s.appraised), bpo = cents(s.bpo);
  const monthly = pi + ti;
  const totalDue = monthly * BigInt(s.monthsBehind + 1);                       // the as-of month's installment plus every missed one
  const payStr = (codes: readonly string[]): string => { const arr = Array(12).fill("0"); for (let i = 0; i < s.monthsBehind && i < 12; i++) arr[11 - i] = codes[Math.min(s.monthsBehind - 1 - i, codes.length - 1)]; return arr.join(""); };
  const payString = payStr(["3", "6", "9", "F"]);                              // the partner's notation: 3 = 30 days, 6 = 60, 9 = 90, F = 120+/foreclosure
  const mbaPayString = payStr(["1", "2", "3", "F"]);                           // MBA notation: 1 = 30 days, 2 = 60, 3 = 90, F = foreclosure
  const mbaStatus = s.bk ? "BK" : s.fcReferral ? "FC" : s.monthsBehind === 0 ? "C" : String(30 * s.monthsBehind);
  const cashFlow: Record<string, number> = {};
  for (let m = 1; m <= 12; m++) cashFlow[`cash_flow_month_${String(m).padStart(2, "0")}`] = 12 - m < s.monthsBehind ? 0 : dollars(monthly);
  const advances = s.fcReferral ? cents("1850.00") : s.monthsBehind > 0 ? cents("125.00") : 0n;
  const escrowBalance = ti * BigInt(((parts(AS_OF).m + 3) % 12) + 1);          // a plausible cushion: a few months of T&I
  const min = demoMin(s.n);
  const tape: Record<string, string | number | null> = {
    m3: "M3", as_of_date: DEMO_AS_OF, servicer_loan_number: `NL-${100000 + s.n}`, lien_position: "1", borrower_name: `${s.first} ${s.last}`,
    property_address: s.address, property_city: s.city, property_state: s.state, property_zip: s.zip, property_county: s.county, zip_toxic_ranking: s.zipRank,
    original_upb_cents: dollars(original), upb_cents: dollars(upb), deferred_upb_cents: 0, total_upb_cents: dollars(upb),
    original_note_rate_pct: Number(s.rate), note_rate_pct: Number(s.rate), servicer_retained_rate_pct: 0.25, investor_net_rate_pct: Number(Decimal.parse(s.rate).sub(Decimal.parse("0.25")).toFixed(3)),
    pi_cents: dollars(pi), ti_cents: dollars(ti), total_due_cents: dollars(totalDue), interest_paid_to_date: lastPaidDue, next_due_date: nextDue, last_payment_date: lastPaidDue,
    pay_string: payString, fico_current: s.fico, fico_current_date: "2026-08-15", fico_original: s.ficoOrig, gmc_purpose_code: s.purpose,
    appraised_value_cents: dollars(appraised), bpo_value_cents: dollars(bpo), bpo_date: "2026-06-15", original_occupancy_code: OCCUPANCY_CODE[s.occupancy], occupancy: OCCUPANCY_TEXT[s.occupancy],
    property_type_code: s.propertyTypeCode, loan_type: "Conventional", maturity_date: maturity, first_payment_date: s.firstPayment, origination_date: s.closing,
    arm_index: "NONE", arm_margin_pct: 0, arm_fixed_period_months: 0, arm_payment_adj_period_months: 0, arm_rate_ceiling_pct: 0, arm_rate_floor_pct: 0, arm_adj_freq_months: 0, arm_neg_am: "N",
    ltv_original_pct: pctOf(original, appraised), fmv_cents: dollars(fmv), fmv_date: "2026-08-31", cltv_current_pct: pctOf(upb, fmv), ltv_current_pct: pctOf(upb, fmv),
    interest_only: "N", balloon: "N", original_term_months: term, remaining_term_months: remaining, doc_type: s.docType,
    ...cashFlow,
    fc_status: s.fcReferral ? "Y" : "N", fc_referral_date: s.fcReferral ?? null, fc_sale_scheduled_date: null, fc_sale_held_date: null,
    bk_status: s.bk ? "Y" : "N", bk_chapter: s.bk?.chapter ?? null, bk_filed_date: s.bk?.filed ?? null, bk_motion_for_relief_date: s.bk?.motion ?? null, bk_discharged: "N", bk_discharged_date: null, bk_dismissed_date: null,
    mers_min: min, servicing_status: "Active", preemptive_servicing_status: s.fcReferral ? "Foreclosure" : s.bk ? "Bankruptcy" : s.monthsBehind > 0 ? "Collections" : "Performing",
    gmc_value_cents: dollars(fmv), servicer_name: DEMO_PARTNER.legal_name,
    pmi_flag: s.pmi ? "Y" : "N", pmi_rate_pct: s.pmi ? Number(s.pmi.rate) : 0, pmi_homeowner_payment_pct: s.pmi ? 100 : 0, pmi_coverage_pct: s.pmi ? Number(s.pmi.coverage) : 0, pmi_company: s.pmi?.company ?? "None",
    occupancy_current: OCCUPANCY_SHORT[s.occupancy], property_type: s.propertyType, property_bedrooms: s.bedrooms, property_baths: Number(s.baths), property_sqft: s.sqft, property_garage: s.garage, property_lot_size: s.lot,
    contact_expected_date: "2026-09-15", last_contact_date: "2026-08-20",
    accrued_interest_cents: dollars(accrued), advances_cents: dollars(advances), recoverable_advances_cents: dollars(advances), non_recoverable_advances_cents: 0,
    escrow_balance_cents: dollars(escrowBalance), escrow_advances_cents: 0,
    reconciled_passthrough_expenses_cents: 0, reconciled_advances_cents: dollars(advances), reconciled_net_cash_flow_cents: dollars(monthly * BigInt(12 - s.monthsBehind)),
    modification_flag: "N", prepayment_penalty_flag: "N", prepayment_penalty_desc: "None", prepayment_penalty_end_date: null,
    mba_delinquency_status: mbaStatus, mba_pay_string: mbaPayString, orig_maturity_date: maturity, dti_pct: Number(s.dti), agency_remittance_type: s.remittance,
  };
  return {
    n: s.n, servicer_loan_number: `NL-${100000 + s.n}`, name: `${s.first} ${s.last}`, email: s.email, phone: s.phone, supplement_email: s.supplement_email, supplement_phone: s.supplement_phone,
    first_name: s.first, last_name: s.last, occupancy: s.occupancy, state: s.state, original_cents: original, note_rate_pct: s.rate, term_months: term,
    origination_date: s.closing, first_payment_date: s.firstPayment, payments_made: paymentsMade, upb_cents: upb, pi_cents: pi, ti_cents: ti,
    next_due_date: nextDue, last_payment_date: lastPaidDue, maturity_date: maturity, remaining_term_months: remaining, mers_min: min, tape,
  };
}

const csvField = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function demoBook(): { loans: DemoLoan[]; tapeRows: (string | number | null)[][]; tape: Uint8Array; supplement: string } {
  const loans = SEEDS.map(buildLoan);
  const headerRow = M3_V1.columns.map((c) => c.header);
  const tapeRows: (string | number | null)[][] = [headerRow, ...loans.map((l) => M3_V1.columns.map((c) => l.tape[c.key] ?? null))];
  const tape = writeXlsx(tapeRows, "M3");
  const supplement = ["servicer_loan_number,borrower_email,borrower_phone,borrower_name",
    ...loans.filter((l) => l.supplement_email !== null || l.supplement_phone !== null)
      .map((l) => [l.servicer_loan_number, l.supplement_email ?? "", l.supplement_phone ?? "", l.name].map(csvField).join(",")),
  ].join("\r\n") + "\r\n";
  return { loans, tapeRows, tape, supplement };
}
