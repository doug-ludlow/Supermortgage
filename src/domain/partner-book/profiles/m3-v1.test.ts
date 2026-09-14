// §33.1 rule 1 — the m3-v1 profile's parsers, header check, row mapping, skip codes and the MIN check.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  M3_V1, luhnCheckDigit, luhnValidMin, mapTapeRow, parseBool, parseDateIso, parseIntCell, parseMoneyCents, parsePctDecimal, parseRatePct, profileHeadersPresent, resolveColumns,
} from "./m3-v1.ts";

const HEADERS = M3_V1.columns.map((c) => c.header);
const idx = (header: string, nth = 0): number => { let n = 0; for (let i = 0; i < HEADERS.length; i++) if (HEADERS[i] === header && n++ === nth) return i; throw new Error(header); };
function rowWith(values: Record<string, string>): string[] {
  const row = HEADERS.map(() => "");
  for (const [h, v] of Object.entries(values)) row[idx(h)] = v;
  return row;
}
const BASE: Record<string, string> = {
  "Servicer Loan Number": "NL-100001", "Property State": "AZ", "Interest Bearing UPB": "$441,366.13", "Current Interest Rate": "7.25", "Original Prin Bal": "450,000.00",
  "Name Borrower Primary": "Maria Garcia", "Current P&I Payment Amt": "3069.79", "Current T&I Payment Amt": "612.5", "Next Due Date": "10/1/2026",
};

test("m3-v1: the profile has 118 columns in A–DN order with the tape's header texts and the platform's keys", () => {
  assert.equal(M3_V1.columns.length, 118);
  assert.equal(M3_V1.id, "m3-v1");
  assert.equal(M3_V1.loanNumber, "servicer_loan_number");
  assert.equal(HEADERS[0], "M3");
  assert.equal(HEADERS[117], "Agency & remittance type");
  assert.equal(HEADERS[12], "Interest Bearing UPB");
  for (const k of ["servicer_loan_number", "as_of_date", "lien_position", "borrower_name", "property_address", "property_city", "property_state", "property_zip", "property_county",
    "upb_cents", "deferred_upb_cents", "original_upb_cents", "note_rate_pct", "pi_cents", "ti_cents", "total_due_cents", "next_due_date", "last_payment_date", "pay_string",
    "fico_current", "fico_original", "appraised_value_cents", "bpo_value_cents", "bpo_date", "fmv_cents", "fmv_date", "occupancy", "property_type", "loan_type",
    "origination_date", "first_payment_date", "maturity_date", "original_term_months", "remaining_term_months", "arm_index", "arm_margin_pct", "arm_fixed_period_months",
    "ltv_original_pct", "ltv_current_pct", "interest_only", "balloon", "doc_type", "cash_flow_month_01", "cash_flow_month_12", "fc_referral_date", "fc_status", "bk_chapter",
    "bk_filed_date", "bk_status", "mers_min", "servicing_status", "pmi_flag", "pmi_rate_pct", "modification_flag", "prepayment_penalty_flag", "prepayment_penalty_end_date",
    "mba_delinquency_status", "mba_pay_string", "orig_maturity_date", "dti_pct", "agency_remittance_type", "investor_net_rate_pct", "servicer_name", "escrow_balance_cents", "advances_cents"]) {
    assert.ok(M3_V1.columns.some((c) => c.key === k), `key ${k}`);
  }
  const keys = M3_V1.columns.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
  for (const k of ["agency_remittance_type", "investor_net_rate_pct", "servicer_retained_rate_pct", "servicer_name", "mers_min"])
    assert.equal(M3_V1.columns.find((c) => c.key === k)?.investor, true, `${k} is an investor column`);
  assert.ok(M3_V1.required.includes("Servicer Loan Number") && M3_V1.required.includes("Interest Bearing UPB") && M3_V1.required.includes("Current Interest Rate"));
});

test("m3-v1: money parses dollars, grouping, parenthesized and trailing-minus negatives, half-up to the cent", () => {
  assert.equal(parseMoneyCents("$441,366.13"), "44136613");
  assert.equal(parseMoneyCents("441366.13"), "44136613");
  assert.equal(parseMoneyCents("(1,234.50)"), "-123450");
  assert.equal(parseMoneyCents("-1234.5"), "-123450");
  assert.equal(parseMoneyCents("1,234.50-"), "-123450");
  assert.equal(parseMoneyCents("$ -12.00"), "-1200");
  assert.equal(parseMoneyCents("3069.7889"), "306979");
  assert.equal(parseMoneyCents("3069.785"), "306979");
  assert.equal(parseMoneyCents("3069.784"), "306978");
  assert.equal(parseMoneyCents("612.5"), "61250");
  assert.equal(parseMoneyCents("450000"), "45000000");
  assert.equal(parseMoneyCents("0"), "0");
  assert.equal(parseMoneyCents("(0.00)"), "0");
  assert.equal(parseMoneyCents(".5"), "50");
  assert.equal(parseMoneyCents(""), null);
  assert.equal(parseMoneyCents("N/A"), null);
  assert.equal(parseMoneyCents("12.3.4"), null);
  assert.equal(parseMoneyCents("$"), null);
});

test("m3-v1: dates parse ISO, m/d/yyyy, yyyymmdd and Excel serials (1900 system with the Lotus bug)", () => {
  assert.equal(parseDateIso("2026-10-01"), "2026-10-01");
  assert.equal(parseDateIso("2026-10-01T00:00:00Z"), "2026-10-01");
  assert.equal(parseDateIso("10/1/2026"), "2026-10-01");
  assert.equal(parseDateIso("09/20/2024"), "2024-09-20");
  assert.equal(parseDateIso("9-20-2024"), "2024-09-20");
  assert.equal(parseDateIso("9/20/24"), "2024-09-20");
  assert.equal(parseDateIso("20240920"), "2024-09-20");
  assert.equal(parseDateIso("2024/09/20"), "2024-09-20");
  assert.equal(parseDateIso("25569"), "1970-01-01");
  assert.equal(parseDateIso("45920"), "2025-09-20");
  assert.equal(parseDateIso("45920.5"), "2025-09-20");
  assert.equal(parseDateIso("60"), "1900-02-29");
  assert.equal(parseDateIso("61"), "1900-03-01");
  assert.equal(parseDateIso("1"), "1900-01-01");
  assert.equal(parseDateIso("2026-02-30"), null);
  assert.equal(parseDateIso("13/1/2026"), null);
  assert.equal(parseDateIso("yesterday"), null);
  assert.equal(parseDateIso(""), null);
});

test("m3-v1: rates read percent text, a % sign and a ≤ 1 decimal fraction, always to 3 dp", () => {
  assert.equal(parseRatePct("7.25"), "7.250");
  assert.equal(parseRatePct("7.250%"), "7.250");
  assert.equal(parseRatePct("0.0725"), "7.250");
  assert.equal(parseRatePct("0.05875"), "5.875");
  assert.equal(parseRatePct("5.875"), "5.875");
  assert.equal(parseRatePct("6.1245"), "6.125");
  assert.equal(parseRatePct("0"), "0.000");
  assert.equal(parseRatePct(" 6.5 % "), "6.500");
  assert.equal(parseRatePct("-1"), null);
  assert.equal(parseRatePct("seven"), null);
  assert.equal(parseRatePct(""), null);
  assert.equal(parsePctDecimal("80.00"), "80.000");
  assert.equal(parsePctDecimal("80%"), "80.000");
  assert.equal(parsePctDecimal("2.5"), "2.500");
  assert.equal(parsePctDecimal("x"), null);
});

test("m3-v1: booleans and integers", () => {
  for (const t of ["Y", "y", "YES", "1", "TRUE", "true", "T"]) assert.equal(parseBool(t), true, t);
  for (const f of ["N", "n", "NO", "0", "FALSE", "false", "F"]) assert.equal(parseBool(f), false, f);
  assert.equal(parseBool("maybe"), null);
  assert.equal(parseBool(""), null);
  assert.equal(parseIntCell("748"), 748);
  assert.equal(parseIntCell("748.0"), 748);
  assert.equal(parseIntCell("1,200"), 1200);
  assert.equal(parseIntCell("748.5"), null);
  assert.equal(parseIntCell("abc"), null);
});

test("m3-v1: the header check names the missing required columns and tolerates case and padding", () => {
  assert.deepEqual(profileHeadersPresent(M3_V1, HEADERS), { ok: true, missing: [] });
  assert.deepEqual(profileHeadersPresent(M3_V1, HEADERS.map((h) => `  ${h.toUpperCase()} `)), { ok: true, missing: [] });
  const without = HEADERS.filter((h) => h !== "Interest Bearing UPB" && h !== "Current Interest Rate");
  const r = profileHeadersPresent(M3_V1, without);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["Interest Bearing UPB", "Current Interest Rate"]);
  assert.equal(profileHeadersPresent(M3_V1, ["Loan", "Balance"]).ok, false);
});

test("m3-v1: a full row maps every key typed; the repeated 'Current Occupancy' header maps in order; unknown headers land in raw", () => {
  const values: Record<string, string> = { ...BASE, "As of Date": "45901", "Current Fico": "748", "PMI Flag": "N", "Interest Only": "0", "MERS ID": "100012300000000015", "Orig LTV": "80.00", "DTI": "38.5" };
  const row = rowWith(values);
  row[idx("Current Occupancy", 0)] = "Owner Occupied";
  row[idx("Current Occupancy", 1)] = "Owner";
  const headers = [...HEADERS, "Partner Note", "Partner Note"];
  const r = mapTapeRow(M3_V1, headers, [...row, "hello", "again"], 2);
  assert.equal(r.skip, null);
  assert.deepEqual(r.exceptions, []);
  assert.equal(Object.keys(r.facts).length, 118);
  assert.equal(r.facts["servicer_loan_number"], "NL-100001");
  assert.equal(r.facts["upb_cents"], "44136613");
  assert.equal(r.facts["original_upb_cents"], "45000000");
  assert.equal(r.facts["note_rate_pct"], "7.250");
  assert.equal(r.facts["pi_cents"], "306979");
  assert.equal(r.facts["ti_cents"], "61250");
  assert.equal(r.facts["next_due_date"], "2026-10-01");
  assert.equal(r.facts["as_of_date"], "2025-09-01");
  assert.equal(r.facts["fico_current"], 748);
  assert.equal(r.facts["pmi_flag"], false);
  assert.equal(r.facts["interest_only"], false);
  assert.equal(r.facts["occupancy"], "Owner Occupied");
  assert.equal(r.facts["occupancy_current"], "Owner");
  assert.equal(r.facts["ltv_original_pct"], "80.000");
  assert.equal(r.facts["dti_pct"], "38.500");
  assert.equal(r.facts["mers_min"], "100012300000000015");
  assert.equal(r.facts["bk_chapter"], null, "an empty cell is null, not an exception");
  assert.deepEqual(r.raw, { "Partner Note": "hello", "Partner Note (2)": "again" });
  const cols = resolveColumns(M3_V1, ["Current Occupancy", "Current Occupancy", "Nope"]);
  assert.deepEqual(cols.map((c) => c?.key ?? null), ["occupancy", "occupancy_current", null]);
});

test("m3-v1: an unreadable cell is a row exception naming the column and the row keeps every other fact", () => {
  const row = rowWith({ ...BASE, "Current Fico": "n/a", "Most Recent BPO Date": "soon" });
  const r = mapTapeRow(M3_V1, HEADERS, row, 5);
  assert.equal(r.skip, null);
  assert.deepEqual(r.exceptions, [
    { row: 5, servicer_loan_number: "NL-100001", code: "unreadable_cell", column: "Current Fico" },
    { row: 5, servicer_loan_number: "NL-100001", code: "unreadable_cell", column: "Most Recent BPO Date" },
  ]);
  assert.equal(r.facts["fico_current"], null);
  assert.equal(r.facts["bpo_date"], null);
  assert.equal(r.facts["upb_cents"], "44136613");
  assert.equal(r.facts["note_rate_pct"], "7.250");
  assert.equal(r.facts["borrower_name"], "Maria Garcia");
});

test("m3-v1: skip codes — no loan number, no state, no readable balance or rate — and the skip is on the report", () => {
  const noLoan = mapTapeRow(M3_V1, HEADERS, rowWith({ ...BASE, "Servicer Loan Number": "  " }), 3);
  assert.equal(noLoan.skip, "no_loan_number");
  assert.deepEqual(noLoan.exceptions, [{ row: 3, servicer_loan_number: null, code: "no_loan_number" }]);
  const noState = mapTapeRow(M3_V1, HEADERS, rowWith({ ...BASE, "Property State": "" }), 4);
  assert.equal(noState.skip, "no_state");
  assert.deepEqual(noState.exceptions, [{ row: 4, servicer_loan_number: "NL-100001", code: "no_state" }]);
  const noUpb = mapTapeRow(M3_V1, HEADERS, rowWith({ ...BASE, "Interest Bearing UPB": "unknown" }), 6);
  assert.equal(noUpb.skip, "no_balance_or_rate");
  assert.deepEqual(noUpb.exceptions.map((e) => e.code), ["unreadable_cell", "no_balance_or_rate"]);
  const noRate = mapTapeRow(M3_V1, HEADERS, rowWith({ ...BASE, "Current Interest Rate": "" }), 7);
  assert.equal(noRate.skip, "no_balance_or_rate");
  assert.equal(noRate.facts["upb_cents"], "44136613", "the skipped row still carries its readable facts");
  const shortRow = mapTapeRow(M3_V1, HEADERS, ["M3", "2026-09-01", "NL-9"], 8);
  assert.equal(shortRow.skip, "no_state");
});

test("m3-v1: implausible values load with an exception naming the column (rate above 25 %, UPB above original by more than 10 %)", () => {
  const hot = mapTapeRow(M3_V1, HEADERS, rowWith({ ...BASE, "Current Interest Rate": "72.5" }), 9);
  assert.equal(hot.skip, null);
  assert.deepEqual(hot.exceptions, [{ row: 9, servicer_loan_number: "NL-100001", code: "implausible_value", column: "Current Interest Rate" }]);
  const fat = mapTapeRow(M3_V1, HEADERS, rowWith({ ...BASE, "Interest Bearing UPB": "500,000.00" }), 10);
  assert.deepEqual(fat.exceptions, [{ row: 10, servicer_loan_number: "NL-100001", code: "implausible_value", column: "Interest Bearing UPB" }]);
  const fine = mapTapeRow(M3_V1, HEADERS, rowWith({ ...BASE, "Interest Bearing UPB": "495,000.00" }), 11);
  assert.deepEqual(fine.exceptions, []);
});

test("m3-v1: luhnValidMin accepts an 18-digit MIN with a valid check digit and nothing else", () => {
  const body = "10001230000000001";
  const min = body + String(luhnCheckDigit(body));
  assert.equal(min.length, 18);
  assert.equal(luhnValidMin(min), true);
  assert.equal(luhnValidMin(body + String((luhnCheckDigit(body) + 1) % 10)), false);
  assert.equal(luhnValidMin("79927398713"), false, "Luhn-valid but not 18 digits");
  assert.equal(luhnValidMin("1000123000000000150"), false);
  assert.equal(luhnValidMin("10001230000000001X"), false);
  assert.equal(luhnValidMin(""), false);
  assert.equal(luhnCheckDigit("7992739871"), 3, "the classic Luhn example");
  assert.equal(luhnValidMin("000000000000000000"), true, "all zeros satisfies mod 10");
});
