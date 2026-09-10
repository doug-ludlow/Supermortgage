// 1.5 MERS transfer of servicing/beneficial rights
// spec/sections/01-boarding-servicing-transfer-in/1-5-mers-transfer-of-servicing-beneficial-rights.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { cents } from "../../kernel/money/cents.ts";
import { BoardingService } from "../boarding/service.ts";
import { stagedLoan, batchContext, FakePositions } from "../boarding/fixtures.ts";
import { tosExpectations, ingestMersAcknowledgement, registrationFeeAccrual, MERS_REGISTRATION_FEE_CENTS } from "./inbound.ts";

// 1.5-T1 — implemented in src/domain/transfers/transfers.test.ts
test("1.5-T2: Given a `servicing_sale_with_sub` batch, then TOS pending notices are expected from the seller and confirmation timers (7 days [UNVERIFIED]) are created per MIN.", () => {
  const t = tosExpectations({ type: "servicing_sale_with_sub", mins: ["100012300000000015", "100012300000000023"], pending_received_on: D("2026-09-29") });
  assert.equal(t.tos_expected, true); assert.deepEqual(t.confirmations.map((c) => c.confirm_by), ["2026-10-06", "2026-10-06"]);   // MERS_PROC_TOS_CONFIRM_7 per MIN
  assert.equal(tosExpectations({ type: "master_to_sub", mins: ["x"] }).tos_expected, false);
});
// 1.5-T3 — implemented in src/domain/transfers/transfers.test.ts
test("1.5-T4: Given 10 rejected MINs in the acknowledgment file, then 10 boarding exceptions are open and the batch report shows 99.8% accepted.", () => {
  const results = Array.from({ length: 5000 }, (_, i) => (i < 10 ? { min: `MIN-${i}`, accepted: false, reason: "MIN inactive" } : { min: `MIN-${i}`, accepted: true }));
  const r = ingestMersAcknowledgement(results);
  assert.deepEqual([r.accepted, r.rejected, r.accepted_pct, r.exceptions.length], [4990, 10, 99.8, 10]);
  assert.deepEqual(r.exceptions[0], { min: "MIN-0", kind: "mers_rejected", reason: "MIN inactive" });
});
// 1.5-T5 — implemented in src/domain/transfers/transfers.test.ts
// 1.5-T6 — implemented in src/domain/transfers/transfers.test.ts
// 1.5-T7 — implemented in src/domain/transfers/transfers.test.ts
test("1.5-T8: Given a MIN with investor \u2260 Fannie Mae, then boarding proceeds with `W-016` and a partner query.", () => {
  const clock = new FixedClock("2026-09-17T02:00:00.000Z"); const events = new MemoryEventStore(clock); const ext = new FakePositions();
  const svc = new BoardingService({ events, ledger: new MemoryLedger(), ext, clock, clearingAccountId: "CUST-CLEARING" }); svc.openBatch(batchContext({ transfer_date: D("2026-10-01") }));
  const loan = stagedLoan({ mers_investor_is_fnma: false }); ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(bl!.status, "validated");                                       // boarding proceeds
  assert.equal(bl!.validations.find((v) => v.code === "W-016")!.result, "fail");
  assert.ok(svc.openWarnings(bl!).some((v) => v.code === "W-016"));
  const q = svc.partnerQuery(bl!.id);                                          // partner query carries the warning (seller/partner corrects, B8-7-01)
  assert.ok(q.items.some((i) => i.rule_code === "W-016"));
  clock.set("2026-10-01T14:00:00.000Z");
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 1);
});

// 1.5 rule 5: MERS transfers are free; registrations are $24.95 accrued to the partner's MERS invoice, never to the borrower.
test("1.5 worked example: a $24.95 MOM registration accrues to the partner's MERS invoice, never to the borrower", () => {
  assert.equal(MERS_REGISTRATION_FEE_CENTS, cents("24.95"));
  assert.deepEqual(registrationFeeAccrual("100012300000000015", "partner-1"), { min: "100012300000000015", amount_cents: 2_495n, bill_to: "partner:partner-1:mers_invoice", borrower_charge: false });
});
