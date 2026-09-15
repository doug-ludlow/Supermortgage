// 32.3 E5 / SQ-06: the identity card's residence answers → 23.5 writeResidence's input (residence.ts); no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddressLine, postalDigits, residenceInput } from "./residence.ts";

test("32.3 E5: a one-line address parses into the parts a Current residence can carry — a bare street line stays a street line; city, state and ZIP when they are there; the wire's lengths", () => {
  assert.deepEqual(parseAddressLine("22 Elm St"), { address_line_text: "22 Elm St" });
  assert.deepEqual(parseAddressLine("100 N Central Ave, Phoenix, AZ 85004"), { address_line_text: "100 N Central Ave", city_name: "Phoenix", state_code: "AZ", postal_code: "85004", country_code: "US" });
  assert.deepEqual(parseAddressLine("9 Saguaro Way, Apt 4, Phoenix, az 85018-1234"), { address_line_text: "9 Saguaro Way", city_name: "Apt 4, Phoenix", state_code: "AZ", postal_code: "850181234", country_code: "US" });
  assert.deepEqual(parseAddressLine("14 Elm St, Phoenix"), { address_line_text: "14 Elm St", city_name: "Phoenix" });
  assert.deepEqual(parseAddressLine(""), {});
  assert.equal(parseAddressLine(`${"x".repeat(60)}, Phoenix, AZ 85004`).address_line_text!.length, 50);
  assert.equal(postalDigits("85004"), "85004"); assert.equal(postalDigits("85004-1234"), "850041234"); assert.equal(postalDigits("8500"), null);
});

test("32.3 E5 / T32: the residence input — the option id becomes the DU basis, the rent travels only with Rent (bigint cents as a decimal string), the months are whole and bounded, a Prior row needs its own address", () => {
  assert.deepEqual(residenceInput("Current", { basis_option: "rent", monthly_rent_cents: "210000", months: "14" }, { address_line_text: "22 Elm St" }), { residency_type: "Current", residency_basis: "Rent", monthly_rent_cents: "210000", duration_months: 14, address_line_text: "22 Elm St" });
  assert.deepEqual(residenceInput("Current", { basis_option: "own", monthly_rent_cents: "", months: "36" }, {}), { residency_type: "Current", residency_basis: "Own", duration_months: 36 });
  // Living rent-free with a rent typed anyway: the basis wins and the row carries no rent (CHECK du_residences_rent_iff_rent_basis)
  assert.deepEqual(residenceInput("Current", { basis_option: "living_rent_free", monthly_rent_cents: "50000", months: "3" }, {}), { residency_type: "Current", residency_basis: "LivingRentFree", duration_months: 3 });
  assert.throws(() => residenceInput("Current", { basis_option: "rent", monthly_rent_cents: "", months: "14" }, {}), /monthly_rent_cents is required/);
  assert.throws(() => residenceInput("Current", { basis_option: "rent", monthly_rent_cents: "2100.00", months: "14" }, {}), /decimal string of cents/);
  assert.throws(() => residenceInput("Current", { basis_option: "mortgage", monthly_rent_cents: "", months: "14" }, {}), /residency_basis must be one of/);
  assert.throws(() => residenceInput("Current", { basis_option: "own", monthly_rent_cents: "", months: "1000" }, {}), /whole number of months/);
  assert.throws(() => residenceInput("Current", { basis_option: "own", monthly_rent_cents: "", months: "1.5" }, {}), /whole number of months/);
  const prior = { address_line_text: "8 Mesa Dr", city_name: "Tempe", state_code: "AZ", postal_code: "85281", country_code: "US" };
  assert.deepEqual(residenceInput("Prior", { basis_option: "rent", monthly_rent_cents: "165000", months: "22" }, prior), { residency_type: "Prior", residency_basis: "Rent", monthly_rent_cents: "165000", duration_months: 22, ...prior });
  assert.throws(() => residenceInput("Prior", { basis_option: "own", monthly_rent_cents: "", months: "22" }, { address_line_text: "8 Mesa Dr", city_name: "Tempe", state_code: "AZ" }), /its own street address, city, state and ZIP/);
});
