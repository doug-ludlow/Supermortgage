/**
 * §33.1 rule 1 — the `m3-v1` tape profile: the first partner's 118 headers (columns A–DN, header text verbatim)
 * mapped onto typed facts. Money cells become decimal-string cents (half-up to the cent), dates ISO (Excel serials
 * converted), Y/N and 1/0 booleans; a cell that cannot be read is a row exception naming the column and the row keeps
 * every other fact. Headers the profile does not know are kept verbatim under `raw`. A row is skipped only when it has
 * no servicer loan number, no property state, or no readable balance and rate — and the skip is on the report.
 * Investor columns (rule 2; 20.1 rule 7 INVESTOR_FIELDS) are marked `investor: true` so they never leave facts/raw.
 *
 * No Node/DB dependency: the parsers are pure so the importer, the console and the fixture can all use them.
 */
import { Decimal } from "../../../kernel/money/decimal.ts";
import { daysInMonth } from "../../../kernel/calendar/date.ts";
import { excelSerialToIsoDate } from "../../../infra/files/xlsx.ts";

export type FactType = "text" | "money" | "rate" | "int" | "date" | "bool" | "pct";
export type ColumnDef = { header: string; key: string; type: FactType; required?: boolean; investor?: boolean };
export type TapeProfile = { id: "m3-v1"; columns: readonly ColumnDef[]; required: readonly string[]; loanNumber: string };
/** money → decimal-string cents ("44136613"), rate → percent as decimal string ("7.250"), pct → decimal string (3 dp,
 *  as written), date → ISO "YYYY-MM-DD", bool → boolean, int → number, text → string. */
export type Fact = string | number | boolean | null;
export type RowException = {
  row: number;
  servicer_loan_number: string | null;
  code: "unreadable_cell" | "no_loan_number" | "no_state" | "no_balance_or_rate" | "supplement_orphan" | "contact_conflict" | "duplicate_row" | "implausible_value";
  column?: string;
};

const C = (header: string, key: string, type: FactType, opts: { required?: boolean; investor?: boolean } = {}): ColumnDef => ({ header, key, type, ...opts });

/** The 118 columns A–DN in tape order; header text verbatim from the partner's layout. */
export const M3_V1_COLUMNS: readonly ColumnDef[] = [
  C("M3", "m3", "text"),                                                                 // A
  C("As of Date", "as_of_date", "date"),                                                 // B
  C("Servicer Loan Number", "servicer_loan_number", "text", { required: true }),         // C
  C("Lien Position", "lien_position", "text"),                                           // D
  C("Name Borrower Primary", "borrower_name", "text", { required: true }),               // E
  C("Property Address", "property_address", "text", { required: true }),                 // F
  C("Property City", "property_city", "text", { required: true }),                       // G
  C("Property State", "property_state", "text", { required: true }),                     // H
  C("Property Zip Code", "property_zip", "text", { required: true }),                    // I
  C("County", "property_county", "text"),                                                // J
  C("Zip Toxic Ranking", "zip_toxic_ranking", "int"),                                    // K
  C("Original Prin Bal", "original_upb_cents", "money", { required: true }),             // L
  C("Interest Bearing UPB", "upb_cents", "money", { required: true }),                   // M
  C("UPB Deferred", "deferred_upb_cents", "money"),                                      // N
  C("Total UPB", "total_upb_cents", "money"),                                            // O
  C("Original Interest Rate", "original_note_rate_pct", "rate"),                         // P
  C("Current Interest Rate", "note_rate_pct", "rate", { required: true }),               // Q
  C("Servicer Retained Interest Rate", "servicer_retained_rate_pct", "rate", { investor: true }), // R
  C("Investor Net Interest Rate", "investor_net_rate_pct", "rate", { investor: true }),  // S
  C("Current P&I Payment Amt", "pi_cents", "money", { required: true }),                 // T
  C("Current T&I Payment Amt", "ti_cents", "money"),                                     // U
  C("Total Due", "total_due_cents", "money"),                                            // V
  C("IPD", "interest_paid_to_date", "date"),                                             // W
  C("Next Due Date", "next_due_date", "date", { required: true }),                       // X
  C("Last Payment Date", "last_payment_date", "date"),                                   // Y
  C("Pay String", "pay_string", "text"),                                                 // Z
  C("Current Fico", "fico_current", "int"),                                              // AA
  C("Current Fico Date", "fico_current_date", "date"),                                   // AB
  C("Original Fico", "fico_original", "int"),                                            // AC
  C("GMC Purpose Code", "gmc_purpose_code", "text"),                                     // AD
  C("Orig Appraised Value", "appraised_value_cents", "money"),                           // AE
  C("Most Recent BPO", "bpo_value_cents", "money"),                                      // AF
  C("Most Recent BPO Date", "bpo_date", "date"),                                         // AG
  C("Original Occupancy Code", "original_occupancy_code", "text"),                       // AH
  C("Current Occupancy", "occupancy", "text"),                                           // AI (the tape's text)
  C("Property Type Code", "property_type_code", "text"),                                 // AJ
  C("Mortgage Loan Type", "loan_type", "text"),                                          // AK
  C("Date Maturity", "maturity_date", "date", { required: true }),                       // AL
  C("Date Payment Due First", "first_payment_date", "date", { required: true }),         // AM
  C("Orig Date Closing", "origination_date", "date", { required: true }),                // AN
  C("ARM Index Type", "arm_index", "text"),                                              // AO
  C("Margin", "arm_margin_pct", "rate"),                                                 // AP
  C("ARM Fixed Period (mo)", "arm_fixed_period_months", "int"),                          // AQ
  C("ARM Payment Adj Period", "arm_payment_adj_period_months", "int"),                   // AR
  C("Arm Interest Rate Ceiling", "arm_rate_ceiling_pct", "rate"),                        // AS (cap)
  C("Arm Interest Rate Floor", "arm_rate_floor_pct", "rate"),                            // AT (cap)
  C("ARM Adj Freq", "arm_adj_freq_months", "int"),                                       // AU
  C("ARM Neg Ind", "arm_neg_am", "bool"),                                                // AV
  C("Orig LTV", "ltv_original_pct", "pct"),                                              // AW
  C("Current FMV", "fmv_cents", "money"),                                                // AX
  C("Current FMV Date", "fmv_date", "date"),                                             // AY
  C("Current CLTV", "cltv_current_pct", "pct"),                                          // AZ
  C("Current LTV", "ltv_current_pct", "pct"),                                            // BA
  C("Interest Only", "interest_only", "bool"),                                           // BB
  C("Balloon", "balloon", "bool"),                                                       // BC
  C("Term", "original_term_months", "int", { required: true }),                          // BD
  C("Calc Term", "remaining_term_months", "int"),                                        // BE
  C("Doc Type", "doc_type", "text"),                                                     // BF
  C("Cash Flow Month 01", "cash_flow_month_01", "money"),                                // BG
  C("Cash Flow Month 02", "cash_flow_month_02", "money"),                                // BH
  C("Cash Flow Month 03", "cash_flow_month_03", "money"),                                // BI
  C("Cash Flow Month 04", "cash_flow_month_04", "money"),                                // BJ
  C("Cash Flow Month 05", "cash_flow_month_05", "money"),                                // BK
  C("Cash Flow Month 06", "cash_flow_month_06", "money"),                                // BL
  C("Cash Flow Month 07", "cash_flow_month_07", "money"),                                // BM
  C("Cash Flow Month 08", "cash_flow_month_08", "money"),                                // BN
  C("Cash Flow Month 09", "cash_flow_month_09", "money"),                                // BO
  C("Cash Flow Month 10", "cash_flow_month_10", "money"),                                // BP
  C("Cash Flow Month 11", "cash_flow_month_11", "money"),                                // BQ
  C("Cash Flow Month 12 (Most Recent Month)", "cash_flow_month_12", "money"),            // BR
  C("Foreclosure Ind", "fc_status", "bool"),                                             // BS (the tape's Y/N indicator)
  C("FCL Date Refrd Atty", "fc_referral_date", "date"),                                  // BT
  C("FCL Date Sale Scheduled", "fc_sale_scheduled_date", "date"),                        // BU
  C("FCL Date Sale Held", "fc_sale_held_date", "date"),                                  // BV
  C("Active Bankruptcy Ind", "bk_status", "bool"),                                       // BW (the tape's Y/N indicator)
  C("BK Chapter Code", "bk_chapter", "text"),                                            // BX
  C("BK Date Filed", "bk_filed_date", "date"),                                           // BY
  C("BK Motion for Relief Date", "bk_motion_for_relief_date", "date"),                   // BZ
  C("BK Discharged Ind", "bk_discharged", "bool"),                                       // CA
  C("BK Borrower Discharged Date", "bk_discharged_date", "date"),                        // CB
  C("BK Borrower Dismis Date", "bk_dismissed_date", "date"),                             // CC
  C("MERS ID", "mers_min", "text", { investor: true }),                                  // CD
  C("Servicing Status", "servicing_status", "text"),                                     // CE
  C("Preemptive Servicing Status", "preemptive_servicing_status", "text"),               // CF
  C("Current GMC Value", "gmc_value_cents", "money"),                                    // CG
  C("Servicer", "servicer_name", "text", { investor: true }),                            // CH
  C("PMI Flag", "pmi_flag", "bool"),                                                     // CI
  C("PMI Insurance Rate", "pmi_rate_pct", "rate"),                                       // CJ
  C("PMI Home Owner Insurance Payment Percent", "pmi_homeowner_payment_pct", "pct"),     // CK
  C("PMI Percent Covered", "pmi_coverage_pct", "pct"),                                   // CL
  C("PMI Insurance Company", "pmi_company", "text"),                                     // CM
  C("Current Occupancy", "occupancy_current", "text"),                                   // CN (the tape repeats the header; second occurrence)
  C("Property Type", "property_type", "text"),                                           // CO
  C("Prop Bedrooms", "property_bedrooms", "int"),                                        // CP
  C("Prop Baths", "property_baths", "pct"),                                              // CQ (decimal: 2.5 baths)
  C("Prop Sq. Ft.", "property_sqft", "int"),                                             // CR
  C("Prop Garaged Parking", "property_garage", "text"),                                  // CS
  C("Prop Lot Size", "property_lot_size", "text"),                                       // CT
  C("Srv Contact Expected", "contact_expected_date", "date"),                            // CU
  C("Srv Last Contact Date", "last_contact_date", "date"),                               // CV
  C("SRV Accrued Interest Balance", "accrued_interest_cents", "money"),                  // CW
  C("SRV Total Corporate Advance Balance", "advances_cents", "money"),                   // CX
  C("SRV Recoverable Corporate Advance Balance", "recoverable_advances_cents", "money"), // CY
  C("SRV Non-Recoverable Corporate Advance Balance", "non_recoverable_advances_cents", "money"), // CZ
  C("SRV Asset Escrow Balance", "escrow_balance_cents", "money"),                        // DA
  C("SRV Asset Escrow Advances", "escrow_advances_cents", "money"),                      // DB
  C("Total Reconciled Passthrough & Other Expenses", "reconciled_passthrough_expenses_cents", "money", { investor: true }), // DC
  C("Total Reconciled Advances", "reconciled_advances_cents", "money", { investor: true }), // DD
  C("Reconciled Net CF", "reconciled_net_cash_flow_cents", "money", { investor: true }), // DE
  C("Modification Flag", "modification_flag", "bool"),                                   // DF
  C("Prepayment Penalty Ind", "prepayment_penalty_flag", "bool"),                        // DG
  C("Prepayment Desc", "prepayment_penalty_desc", "text"),                               // DH
  C("Prepay Period", "prepayment_penalty_end_date", "date"),                             // DI
  C("MBA Delinquency Status", "mba_delinquency_status", "text"),                         // DJ
  C("MBA Pay String", "mba_pay_string", "text"),                                         // DK
  C("Orig Maturity Date", "orig_maturity_date", "date"),                                 // DL
  C("DTI", "dti_pct", "pct"),                                                            // DM
  C("Agency & remittance type", "agency_remittance_type", "text", { investor: true }),   // DN
];

export const M3_V1: TapeProfile = {
  id: "m3-v1",
  columns: M3_V1_COLUMNS,
  required: M3_V1_COLUMNS.filter((c) => c.required).map((c) => c.header),
  loanNumber: "servicer_loan_number",
};

/** Header texts compare trimmed, whitespace-collapsed and case-insensitively (a partner's export drifts in case and padding, never in words). */
export function normalizeHeader(h: string): string { return h.trim().replace(/\s+/g, " ").toLowerCase(); }

// ───────── parsers (pure; null = unreadable; "" is handled by the caller as an empty cell) ─────────

/** "$441,366.13" | "441366.13" | "(1,234.50)" | "1,234.50-" → "44136613" / "-123450"; half-up to the cent; null when unreadable. */
export function parseMoneyCents(cell: string): string | null {
  let s = cell.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.endsWith("-")) { neg = true; s = s.slice(0, -1).trim(); }
  if (s.startsWith("-")) { neg = true; s = s.slice(1).trim(); }
  else if (s.startsWith("+")) s = s.slice(1).trim();
  if (s.startsWith("$")) s = s.slice(1).trim();
  if (s.startsWith("-")) { neg = true; s = s.slice(1).trim(); }
  s = s.replace(/,/g, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const int = m[1] ?? "", frac = m[2] ?? "";
  if (int === "" && frac === "") return null;
  let cents = BigInt(int || "0") * 100n + BigInt((frac + "00").slice(0, 2));
  if (frac.length > 2 && (frac.charCodeAt(2) - 48) >= 5) cents += 1n;   // half-up to the cent
  if (cents === 0n) return "0";
  return (neg ? "-" : "") + cents.toString();
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
function isoOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** ISO (with or without a time), yyyy/mm/dd, m/d/yyyy, m-d-yyyy, m/d/yy (pivot 50), yyyymmdd, Excel serial text → "YYYY-MM-DD"; null when unreadable. */
export function parseDateIso(cell: string): string | null {
  const s = cell.trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[T ].*)?$/.exec(s))) return isoOf(Number(m[3]), Number(m[1]), Number(m[2]));
  if ((m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/.exec(s))) { const yy = Number(m[3]); return isoOf(yy < 50 ? 2000 + yy : 1900 + yy, Number(m[1]), Number(m[2])); }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^(\d{1,7})(?:\.\d*)?$/.exec(s))) {
    const serial = Number(m[1]);
    if (serial < 1 || serial > 2_958_465) return null;             // 1900-01-01 … 9999-12-31
    return excelSerialToIsoDate(serial);
  }
  return null;
}

function parsePlainDecimal(s: string): Decimal | null {
  const t = s.replace(/,/g, "").trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const fixed = t.startsWith(".") ? "0" + t : t.startsWith("-.") ? "-0" + t.slice(1) : t.startsWith("+.") ? "0" + t.slice(1) : t;
  return Decimal.parse(fixed.endsWith(".") ? fixed.slice(0, -1) : fixed.replace(/^\+/, ""));
}

/** "7.25" | "7.250%" | "0.0725" (≤ 1 without a % sign → ×100) → "7.250" (3 dp, half-up); null when unreadable or negative. */
export function parseRatePct(cell: string): string | null {
  let s = cell.trim();
  if (!s) return null;
  const hasPct = s.endsWith("%");
  if (hasPct) s = s.slice(0, -1).trim();
  let d = parsePlainDecimal(s);
  if (d === null || d.isNegative()) return null;
  if (!hasPct && d.cmp(Decimal.ONE) <= 0) d = d.mul(Decimal.fromInt(100));
  return d.toFixed(3, "HALF_UP");
}

/** A percentage or plain decimal as written ("80.00" | "80%" | "2.5") → 3 dp decimal string; never rescaled. */
export function parsePctDecimal(cell: string): string | null {
  let s = cell.trim();
  if (!s) return null;
  if (s.endsWith("%")) s = s.slice(0, -1).trim();
  const d = parsePlainDecimal(s);
  return d === null ? null : d.toFixed(3, "HALF_UP");
}

/** "748" | "748.0" | "1,200" → number; null when unreadable. */
export function parseIntCell(cell: string): number | null {
  const s = cell.trim().replace(/,/g, "");
  if (!s) return null;
  const m = /^([+-]?\d+)(?:\.0*)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Y/N, YES/NO, 1/0, TRUE/FALSE, T/F (case-insensitive) → boolean; null when unreadable. */
export function parseBool(cell: string): boolean | null {
  const s = cell.trim().toUpperCase();
  if (!s) return null;
  if (["Y", "YES", "1", "TRUE", "T"].includes(s)) return true;
  if (["N", "NO", "0", "FALSE", "F"].includes(s)) return false;
  return null;
}

export function parseCell(type: FactType, cell: string): Fact {
  switch (type) {
    case "text": return cell.trim();
    case "money": return parseMoneyCents(cell);
    case "rate": return parseRatePct(cell);
    case "pct": return parsePctDecimal(cell);
    case "int": return parseIntCell(cell);
    case "date": return parseDateIso(cell);
    case "bool": return parseBool(cell);
  }
}

/** Luhn check digit (mod 10) for a digit string — the MERS MIN's 18th digit over the first 17. */
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  let dbl = true;                                   // the rightmost digit of `digits` is doubled (it sits next to the check digit)
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return (10 - (sum % 10)) % 10;
}

/** 18 digits and a valid Luhn check digit (the MERS MIN: 7-digit org id, 10-digit sequence, check digit). */
export function luhnValidMin(s: string): boolean {
  const t = s.trim();
  if (!/^\d{18}$/.test(t)) return false;
  return luhnCheckDigit(t.slice(0, 17)) === t.charCodeAt(17) - 48;
}

// ───────── header presence and row mapping ─────────

export function profileHeadersPresent(profile: TapeProfile, headers: readonly string[]): { ok: boolean; missing: string[] } {
  const present = new Set(headers.map(normalizeHeader));
  const missing = profile.required.filter((h) => !present.has(normalizeHeader(h)));
  return { ok: missing.length === 0, missing };
}

/**
 * Resolve each tape header to a profile column by normalized text; a header the tape repeats ("Current Occupancy")
 * takes the profile's columns of that text in order, so the n-th occurrence maps to the n-th definition.
 */
export function resolveColumns(profile: TapeProfile, headers: readonly string[]): (ColumnDef | null)[] {
  const byHeader = new Map<string, ColumnDef[]>();
  for (const c of profile.columns) {
    const k = normalizeHeader(c.header);
    const list = byHeader.get(k) ?? [];
    list.push(c);
    byHeader.set(k, list);
  }
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const k = normalizeHeader(h);
    const list = byHeader.get(k);
    if (!list) return null;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return list[Math.min(n, list.length - 1)] ?? null;
  });
}

const MAX_PLAUSIBLE_RATE = Decimal.parse("25");

/** Rule 1: map one tape row; every profile key is present in `facts` (null when the tape lacks the header or the cell is empty). */
export function mapTapeRow(profile: TapeProfile, headers: readonly string[], row: readonly string[], rowNo: number):
  { facts: Record<string, Fact>; raw: Record<string, string>; exceptions: RowException[]; skip: RowException["code"] | null } {
  const cols = resolveColumns(profile, headers);
  const facts: Record<string, Fact> = {};
  for (const c of profile.columns) facts[c.key] = null;
  const raw: Record<string, string> = {};
  const unreadable: string[] = [];
  headers.forEach((header, i) => {
    const cell = row[i] ?? "";
    const col = cols[i];
    if (!col) {
      const h = header.trim();
      let key = h || `column_${i + 1}`;
      if (key in raw) { let n = 2; while (`${key} (${n})` in raw) n++; key = `${key} (${n})`; }
      raw[key] = cell;
      return;
    }
    if (cell.trim() === "") { facts[col.key] = null; return; }
    const v = parseCell(col.type, cell);
    if (v === null) { unreadable.push(col.header); facts[col.key] = null; return; }
    facts[col.key] = v;
  });
  const loanNo = typeof facts[profile.loanNumber] === "string" && (facts[profile.loanNumber] as string).trim() !== "" ? (facts[profile.loanNumber] as string).trim() : null;
  const exceptions: RowException[] = unreadable.map((column) => ({ row: rowNo, servicer_loan_number: loanNo, code: "unreadable_cell", column }));
  let skip: RowException["code"] | null = null;
  if (loanNo === null) skip = "no_loan_number";
  else if (typeof facts["property_state"] !== "string" || facts["property_state"].trim() === "") skip = "no_state";
  else if (facts["upb_cents"] === null || facts["note_rate_pct"] === null) skip = "no_balance_or_rate";
  if (skip) exceptions.push({ row: rowNo, servicer_loan_number: loanNo, code: skip });
  else {
    // Edge cases: a rate above 25 % or a UPB above the original principal by more than 10 % load with `implausible_value` naming the column.
    const rate = facts["note_rate_pct"];
    if (typeof rate === "string" && Decimal.parse(rate).cmp(MAX_PLAUSIBLE_RATE) > 0)
      exceptions.push({ row: rowNo, servicer_loan_number: loanNo, code: "implausible_value", column: "Current Interest Rate" });
    const upb = facts["upb_cents"], orig = facts["original_upb_cents"];
    if (typeof upb === "string" && typeof orig === "string" && BigInt(orig) > 0n && BigInt(upb) * 10n > BigInt(orig) * 11n)
      exceptions.push({ row: rowNo, servicer_loan_number: loanNo, code: "implausible_value", column: "Interest Bearing UPB" });
  }
  return { facts, raw, exceptions, skip };
}
