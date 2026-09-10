// 16.3 Lien release / satisfaction recording
// spec/sections/16-payoff-lien-release/16-3-lien-release-satisfaction-recording.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 16.3-T1 — implemented in src/domain/payoff/payoff.test.ts
// 16.3-T2 — implemented in src/domain/payoff/payoff.test.ts
// 16.3-T3 — implemented in src/domain/payoff/payoff.test.ts
// 16.3-T4 — implemented in src/domain/payoff/payoff.test.ts
// 16.3-T5 — implemented in src/domain/payoff/payoff.test.ts
// 16.3-T6 — implemented in src/domain/payoff/payoff.test.ts
test("16.3-T7: Given a recorder rejection for a missing legal description, then the package is corrected and resubmitted within 2 BD and the original deadline is unchanged.", { todo: true });
test("16.3-T8: Given a county without eRecording, then a paper package with a positive-pay fee check is mailed within the policy window and tracked; recording confirmation is chased at 30 days.", { todo: true });
test("16.3-T9: Given the loan's mortgagee of record is a prior lender with no recorded assignment, then the task is held, an `attorney` escalation opens immediately, and the statutory timer keeps running with exposure reported.", { todo: true });
test("16.3-T10: Given a CA release fee of $45.00 disclosed on the payoff statement and permitted by the DOT, then the fee posts to `recording_fee_payable` and is paid to the trustee/recorder; given a state where the borrower cannot be charged on a portfolio loan, then the cost posts to corporate expense and an F-1-05 claim is prepared within the 60-day window.", { todo: true });
test("16.3-T11: Given a payoff reversed on 10/28 before execution, then the task is voided and no instrument is signed; given reversal after recording, then an `attorney` escalation opens and no borrower charge occurs.", { todo: true });
test("16.3-T12: Given an agent attempts to execute without a passed checklist, then the command is rejected and logged.", { todo: true });
