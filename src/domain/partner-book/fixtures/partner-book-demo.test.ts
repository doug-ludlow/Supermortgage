// §33.1 rule 7 / worked example A — the demo book maps through m3-v1 with zero exceptions and loan 1 lands exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readXlsx } from "../../../infra/files/xlsx.ts";
import { M3_V1, luhnValidMin, mapTapeRow, profileHeadersPresent } from "../profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook } from "./partner-book-demo.ts";

test("partner-book demo: 12 rows × 118 columns map through m3-v1 with zero exceptions", () => {
  const book = demoBook();
  assert.equal(book.loans.length, 12);
  assert.equal(book.tapeRows.length, 13);
  for (const r of book.tapeRows) assert.equal(r.length, 118);
  const headers = book.tapeRows[0] as string[];
  assert.deepEqual(profileHeadersPresent(M3_V1, headers), { ok: true, missing: [] });
  const seen = new Set<string>();
  book.tapeRows.slice(1).forEach((row, i) => {
    const r = mapTapeRow(M3_V1, headers, row.map((v) => (v === null ? "" : String(v))), i + 2);
    assert.equal(r.skip, null, `row ${i + 2}`);
    assert.deepEqual(r.exceptions, [], `row ${i + 2}`);
    assert.deepEqual(r.raw, {});
    assert.equal(r.facts["servicer_loan_number"], `NL-${100001 + i}`);
    assert.ok(luhnValidMin(String(r.facts["mers_min"])), `row ${i + 2} MIN`);
    assert.ok(["AZ", "CA", "CO", "UT", "TX", "FL", "WA", "NV"].includes(String(r.facts["property_state"])));
    seen.add(String(r.facts["servicer_loan_number"]));
  });
  assert.equal(seen.size, 12, "no duplicate servicer loan numbers");
  // The mix rule 7 asks for.
  const occ = book.loans.map((l) => l.occupancy);
  assert.equal(occ.filter((o) => o === "primary").length, 10);
  assert.equal(occ.filter((o) => o === "second_home").length, 1);
  assert.equal(occ.filter((o) => o === "investment").length, 1);
  assert.equal(book.loans[4]?.occupancy, "second_home");
  assert.equal(book.loans[5]?.occupancy, "investment");
  assert.equal(book.loans[7]?.tape["mba_delinquency_status"], "30");
  assert.ok(String(book.loans[7]?.tape["pay_string"]).endsWith("3"));
  assert.equal(book.loans[9]?.tape["fc_referral_date"], "2026-08-14");
  assert.equal(book.loans[10]?.tape["bk_chapter"], "13");
  assert.equal(book.loans[10]?.tape["bk_status"], "Y");
  assert.equal(book.loans[8]?.note_rate_pct, "5.875");
  assert.equal(book.loans[8]?.next_due_date, "2026-10-01");
  assert.equal(book.loans[6]?.email, "daniel.okafor@example.com");
  assert.equal(book.loans[6]?.name, "Daniel Okafor");
  assert.equal(book.loans[11]?.email, null);
  assert.equal(book.loans[11]?.phone, null);
  for (const l of book.loans) {
    if (l.email) assert.ok(l.email.endsWith("@example.com"), l.email);
    if (l.phone) assert.match(l.phone, /^\+1\d{3}55501\d{2}$/);
    assert.equal(l.tape["servicing_status"], "Active");
    assert.equal(l.tape["servicer_name"], DEMO_PARTNER.legal_name);
    assert.equal(l.tape["as_of_date"], DEMO_AS_OF);
  }
});

test("partner-book demo: the supplement has 11 rows (loan 12 has none) in the agreed columns", () => {
  const book = demoBook();
  const lines = book.supplement.trim().split(/\r?\n/);
  assert.equal(lines[0], "servicer_loan_number,borrower_email,borrower_phone,borrower_name");
  assert.equal(lines.length, 12);
  assert.ok(!book.supplement.includes("NL-100012"));
  assert.ok(lines.some((l) => l.startsWith("NL-100007,daniel.okafor@example.com,") && l.endsWith(",Daniel Okafor")));
  assert.ok(lines.some((l) => l.includes('"(602) 555-0101"') || l.includes("(602) 555-0101")));
});

test("partner-book demo: the xlsx tape reads back and loan 1 lands exactly per worked example A", () => {
  const book = demoBook();
  const { sheets } = readXlsx(book.tape);
  const rows = sheets[0]?.rows ?? [];
  assert.equal(rows.length, 13);
  const headers = rows[0] ?? [];
  assert.equal(headers.length, 118);
  const r = mapTapeRow(M3_V1, headers, rows[1] ?? [], 2);
  assert.equal(r.skip, null);
  assert.deepEqual(r.exceptions, []);
  assert.equal(r.facts["servicer_loan_number"], "NL-100001");
  assert.equal(r.facts["borrower_name"], "Maria Garcia");
  assert.equal(r.facts["property_address"], "1200 W Maple Ave");
  assert.equal(r.facts["property_city"], "Phoenix");
  assert.equal(r.facts["property_state"], "AZ");
  assert.equal(r.facts["property_zip"], "85013");
  assert.equal(r.facts["property_county"], "Maricopa");
  assert.equal(r.facts["original_upb_cents"], "45000000");
  assert.equal(r.facts["upb_cents"], "44136613");          // $441,366.13 after 23 payments
  assert.equal(r.facts["pi_cents"], "306979");             // $3,069.79
  assert.equal(r.facts["ti_cents"], "61250");              // $612.50
  assert.equal(r.facts["fmv_cents"], "60500000");          // $605,000.00
  assert.equal(r.facts["fmv_date"], "2026-08-31");
  assert.equal(r.facts["bpo_value_cents"], "61000000");
  assert.equal(r.facts["bpo_date"], "2026-06-15");
  assert.equal(r.facts["note_rate_pct"], "7.250");
  assert.equal(r.facts["next_due_date"], "2026-10-01");
  assert.equal(r.facts["last_payment_date"], "2026-09-01");
  assert.equal(r.facts["origination_date"], "2024-09-20");
  assert.equal(r.facts["first_payment_date"], "2024-11-01");
  assert.equal(r.facts["maturity_date"], "2054-10-01");
  assert.equal(r.facts["original_term_months"], 360);
  assert.equal(r.facts["remaining_term_months"], 337);
  assert.equal(r.facts["fico_current"], 748);
  assert.equal(r.facts["pay_string"], "000000000000");
  assert.equal(r.facts["occupancy"], "Owner Occupied");
  assert.equal(r.facts["property_type"], "Single Family");
  assert.equal(r.facts["loan_type"], "Conventional");
  assert.equal(r.facts["agency_remittance_type"], "FNMA A/A");
  assert.equal(r.facts["interest_only"], false);
  assert.equal(r.facts["pmi_flag"], false);
  assert.equal(r.facts["cash_flow_month_12"], "368229");   // P&I + T&I
  assert.ok(luhnValidMin(String(r.facts["mers_min"])));
  assert.equal(String(r.facts["mers_min"]).length, 18);
  assert.ok(String(r.facts["mers_min"]).startsWith(DEMO_PARTNER.mers_org_id));
  const loan1 = book.loans[0]!;
  assert.equal(loan1.payments_made, 23);
  assert.equal(loan1.upb_cents, 44136613n);
  assert.equal(loan1.pi_cents, 306979n);
  assert.equal(loan1.ti_cents, 61250n);
  assert.equal(loan1.mers_min, r.facts["mers_min"]);
  assert.equal(demoBook().tape.length, book.tape.length, "deterministic");
});
