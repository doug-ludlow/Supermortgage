// 5.2 Remittance of P&I
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-2-remittance-of-p-i.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { scheduleForward } from "./remittance.ts";
import { ET, advanceTransfer, saReinstatementInterest, aaPaymentSplit, perDiemInterest } from "./ops.ts";

// 5.2-T1 — implemented in src/domain/investor/investor.test.ts
// 5.2-T2 — implemented in src/domain/investor/investor.test.ts
// 5.2-T3 — implemented in src/domain/investor/investor.test.ts
// 5.2-T4 — implemented in src/domain/investor/investor.test.ts
// 5.2-T5 — implemented in src/domain/investor/investor.test.ts
// 5.2-T6 — implemented in src/domain/investor/investor.test.ts
// 5.2-T7 — implemented in src/domain/investor/investor.test.ts
test("5.2-T8: Given the custodial balance is $3,000 short at T\u22121 16:00 ET, then an advance transfer command is issued, dual control is not required (< $250,000), and `funded` is reached before 17:00 ET; if the corporate facility is exhausted, `officer` escalation fires.", () => {
  const at = zonedEpochMs(D("2026-11-17"), "16:00", ET);                                                // T−1 16:00 ET for the Nov 18 draft
  const a = advanceTransfer({ expected_draft_cents: 1000000n, custodial_available_cents: 700000n, facility_available_cents: 5000000n, at_ms: at, draft_date: D("2026-11-18") });
  assert.equal(a.command, "advance"); assert.equal(a.amount_cents, 300000n); assert.equal(a.dual_control, false); assert.equal(a.status, "funded");
  assert.ok(a.funded_at_ms! < zonedEpochMs(D("2026-11-17"), "17:00", ET)); assert.deepEqual(a.ledger.map((l) => `${l.side} ${l.account}`), ["Dr servicer_advance_receivable", "Cr custodial_pi_cash"]);
  const x = advanceTransfer({ expected_draft_cents: 1000000n, custodial_available_cents: 700000n, facility_available_cents: 100000n, at_ms: at, draft_date: D("2026-11-18") });
  assert.equal(x.status, "escalated"); assert.equal(x.escalation, "officer"); assert.equal(x.funded_at_ms, null);
  assert.equal(advanceTransfer({ expected_draft_cents: 30000000n, custodial_available_cents: 0n, facility_available_cents: 50000000n, at_ms: at, draft_date: D("2026-11-18") }).dual_control, true);
});
// 5.2-T9 — implemented in src/domain/investor/investor.test.ts
// 5.2-T10 — implemented in src/domain/investor/investor.test.ts
// 5.2-T11 — implemented in src/domain/investor/investor.test.ts
// 5.2-T12 — implemented in src/domain/investor/investor.test.ts

test("5.2 worked examples 3–6: the S/S advance schedule, S/A reinstatement, the A/A auto-draft split and the per-diem", () => {
  const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 4);
  assert.deepEqual(s.map((m) => [m.prior_scheduled_upb_cents, m.fnma_interest_cents, m.fnma_principal_cents, m.fnma_interest_cents + m.fnma_principal_cents]), [[25000000n, 125000n, 22600n, 147600n], [24977400n, 124887n, 22723n, 147610n], [24954677n, 124773n, 22846n, 147619n], [24931831n, 124659n, 22970n, 147629n]]);
  assert.equal(s.reduce((a, m) => a + m.fnma_interest_cents + m.fnma_principal_cents, 0n), 590458n);
  assert.equal(saReinstatementInterest(19950000n, "6.000", 6), 598500n);
  const aa = aaPaymentSplit(40000000n, "6.875", "6.625", 262772n);
  assert.deepEqual(aa, { note_interest_cents: 229167n, principal_cents: 33605n, fnma_interest_cents: 220833n, servicing_fee_cents: 8334n, remittance_cents: 254438n, crs_same_day: true });
  assert.equal(perDiemInterest(19950000n, "6.000"), 3279n);
});
