// 1.6 Escrow/suspense/UPB reconciliation
// spec/sections/01-boarding-servicing-transfer-in/1-6-escrow-suspense-upb-reconciliation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { loanLevelRecon, escrowSetupEvents, activeGate } from "./inbound.ts";
import { escrowContinuity } from "./reconciliation.ts";

// 1.6-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.6-T2 — implemented in src/domain/transfers/transfers.test.ts
test("1.6-T3: Given a tape UPB \u2260 trial-balance UPB for a loan, then the loan cannot board (`SM_RECON_LOAN_LEVEL_T0`).", () => {
  const r = loanLevelRecon({ upb_cents: 24_563_412n, escrow_cents: 184_250n }, { upb_cents: 24_563_413n, escrow_cents: 184_250n });
  assert.equal(r.status, "variance"); assert.deepEqual(r.variances, [{ field: "upb_cents", tape: 24_563_412n, trial_balance: 24_563_413n }]); assert.equal(r.gate, "SM_RECON_LOAN_LEVEL_T0");
  assert.equal(evaluateGate("1.6.loanReconciledBeforeBoard", { recon_status: r.status }).open, false);   // boardLoan asserts this gate
  assert.equal(evaluateGate("1.6.loanReconciledBeforeBoard", { recon_status: loanLevelRecon({ upb_cents: 1n }, { upb_cents: 1n }).status }).open, true);
});
test("1.6-T4: Given Supermortgage keeps the transferor's escrow payment and method, then no initial escrow statement timer is created and the computation year is retained.", () => {
  const kept = escrowContinuity(true, true, D("2026-10-01"));
  assert.deepEqual(kept, { initial_statement_due: null, computation_year_start: "retained" });   // no REGX_1024_17E_INITIAL_ESCROW_STMT_60 instance
  const changed = escrowContinuity(false, true, D("2026-10-01"));
  assert.equal(changed.initial_statement_due, "2026-11-30"); assert.equal(changed.computation_year_start, "2026-10-01");
});
// 1.6-T5 — implemented in src/domain/transfers/transfers.test.ts
// 1.6-T6 — implemented in src/domain/transfers/transfers.test.ts
// 1.6-T7 — implemented in src/domain/transfers/transfers.test.ts
// 1.6-T8 — implemented in src/domain/transfers/transfers.test.ts
test("1.6-T9: Given an escrowed loan boarded after Dec. 1, 2026, then Escrow Setup events exist per category and are acked before `active`.", () => {
  const evs = escrowSetupEvents({ loan_id: "L-9", escrowed: true, boarded_on: D("2026-12-02"), categories: ["tax", "hazard", "mi"] });
  assert.deepEqual(evs.map((e) => e.category), ["tax", "hazard", "mi"]); assert.ok(evs.every((e) => e.type === "EscrowSetup"));
  assert.deepEqual(activeGate(evs, ["tax", "hazard"]), { ok: false, missing: ["mi"] });
  assert.deepEqual(activeGate(evs, ["tax", "hazard", "mi"]), { ok: true, missing: [] });
  assert.equal(escrowSetupEvents({ loan_id: "L-8", escrowed: true, boarded_on: D("2026-11-02"), categories: ["tax"] }).length, 0);   // before Dec 1, 2026
});
// 1.6-T10 — implemented in src/domain/transfers/transfers.test.ts
