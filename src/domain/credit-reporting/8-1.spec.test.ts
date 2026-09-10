// 8.1 Furnish tradeline (Metro 2)
// spec/sections/08-credit-reporting/8-1-furnish-tradeline-metro-2.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { scheduledUpbAfter } from "../notices/ops.ts";
import { ackRejectLoop, fdcpaCycleInclusion, cycleFiles } from "./ops.ts";
import type { Metro2Snapshot } from "./types.ts";
const snap = (loan: string): Metro2Snapshot => ({ loan_id: loan, as_of: D("2027-01-31"), account_status: "11", payment_rating: null, special_comment: "", current_balance_cents: 29306394n, amount_past_due_cents: 0n, scheduled_monthly_payment_cents: 245955n, actual_payment_cents: 245955n, original_loan_amount_cents: 30000000n, original_charge_off_cents: 0n, days_past_due: 0, dofd: null, date_opened: D("2025-02-14"), date_closed: null, date_of_last_payment: D("2027-01-01"), terms_duration: 360, interest_type: "F", php: "0000000000000000000000BB", k3: { agency_identifier: "01", fnma_loan_number: "1234567890", min: "100012345678901234" }, k4: null, consumers: [{ party_id: "A", segment: "base", ecoa: "1", cii: "", ccc: "", special_comment: "" }], final_reported: false, derivation: [] });

// 8.1-T1 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T2 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T3 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T4 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T5 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T6 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T7 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T8 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T9 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T10 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T11 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.1-T12: (ack/reject loop) Given Experian's Metric Report lists 12 rejected records for invalid MIN, then `metro2_ack_items` rows exist, the agent corrects the MIN from `loans`, resubmits/AUDs within 5 BD, and the items resolve.", () => {
  const rejects = Array.from({ length: 12 }, (_, i) => ({ line: 100 + i, code: "INVALID_MIN", message: "Mortgage Identification Number invalid", loan_id: `L-${i + 1}`, field: "min" }));
  const loans = Object.fromEntries(rejects.map((r, i) => [r.loan_id, { min: `10001234567890${String(1000 + i).slice(-4)}`, fnma_loan_number: `12345678${String(10 + i)}` }]));
  const open = ackRejectLoop({ bureau: "experian", file_id: "F-2027-09-EXP", received_on: D("2027-10-05"), rejects, loans });
  assert.equal(open.items.length, 12); assert.ok(open.items.every((i) => i.classification === "data" && i.status === "corrected" && i.correction!.field === "min" && i.correction!.source === "loans"));
  assert.equal(open.resubmit_by, "2027-10-13");   // 5 servicer BD: Columbus Day Oct 11 closed assert.equal(open.via, "aud"); assert.equal(open.resolved, false);
  const done = ackRejectLoop({ bureau: "experian", file_id: "F-2027-09-EXP", received_on: D("2027-10-05"), rejects, loans, resubmitted_on: D("2027-10-08") });
  assert.equal(done.resolved, true); assert.deepEqual(done.unresolved, []); assert.ok(done.items.every((i) => i.status === "resolved"));
});
// 8.1-T13 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T14 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T15 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T16 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.1-T17: (FDCPA gate) Given a loan boarded in default with no contact yet, then it is omitted from the cycle until a live contact or 14 days after a validation notice without undeliverability.", () => {
  const noContact = fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: null, validation_notice_sent_on: null, undeliverable_on: null }, cycle_as_of: D("2027-01-31") });
  assert.equal(noContact.include, false); assert.equal(noContact.omit_reason, "fdcpa_pre_furnishing_gate"); assert.equal(noContact.php_char_for_omitted_month, "D");
  const live = fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: D("2027-01-20"), validation_notice_sent_on: null, undeliverable_on: null }, cycle_as_of: D("2027-01-31") });
  assert.equal(live.include, true); assert.equal(live.gate_opens_on, "2027-01-20");
  const letter = fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: null, validation_notice_sent_on: D("2027-01-10"), undeliverable_on: null }, cycle_as_of: D("2027-01-31") });
  assert.equal(letter.gate_opens_on, "2027-01-24"); assert.equal(letter.include, true);                    // 14 days after the validation notice, no undeliverability
  assert.equal(fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: null, validation_notice_sent_on: D("2027-01-10"), undeliverable_on: D("2027-01-15") }, cycle_as_of: D("2027-01-31") }).include, false);
});
test("8.1-T18: (four bureaus) Given any cycle, then exactly four files exist and Innovis is not skipped.", () => {
  const config = { equifax: { program_identifier: "EFX-PROG", subscriber_code: "EFX123", file_naming: "SM_{cycle}_{bureau}.m2" }, experian: { program_identifier: "EXP-PROG", subscriber_code: "EXP123", file_naming: "SM_{cycle}_{bureau}.m2" }, transunion: { program_identifier: "TU-PROG", subscriber_code: "TU123", file_naming: "SM_{cycle}_{bureau}.m2" }, innovis: { program_identifier: "INV-PROG", subscriber_code: "INV123", file_naming: "SM_{cycle}_{bureau}.m2" } };
  const files = cycleFiles({ cycle_id: "2027-01", snapshots: [snap("SM-1001"), snap("SM-1002")], config });
  assert.equal(files.length, 4); assert.deepEqual(files.map((f) => f.bureau).sort(), ["equifax", "experian", "innovis", "transunion"]);
  assert.ok(files.some((f) => f.bureau === "innovis" && f.header.identification_number === "INV123"));
  assert.ok(files.every((f) => f.header.record_count === 2 && f.trailer.total_base_records === 2 && JSON.stringify(f.records) === JSON.stringify(files[0]!.records)));
  assert.equal(files.find((f) => f.bureau === "innovis")!.file_name, "SM_2027-01_innovis.m2");
});
// 8.1-T19 — implemented in src/domain/credit-reporting/credit-reporting.test.ts

test("8.1 rule 13 worked example: $300,000.00 at 6.250% → P&I $1,847.15, escrow $612.40, PITI $2,459.55; UPB $293,063.94 after payment #23, $292,743.16 after the August payment; deferral $11,082.90 + $3,674.40 = $14,757.30", () => {
  assert.equal(levelPayment(30000000n, ratePercent("6.25"), 360), 184715n); assert.equal(184715n + 61240n, 245955n);
  assert.equal(scheduledUpbAfter(30000000n, "6.250", 184715n, 23), 29306394n);
  assert.equal(scheduledUpbAfter(29306394n, "6.250", 184715n, 1), 29274316n);
  assert.equal(184715n * 6n, 1108290n); assert.equal(61240n * 6n, 367440n); assert.equal(1108290n + 367440n, 1475730n);
});
