// 16.2 Remit payoff proceeds to Fannie Mae
// spec/sections/16-payoff-lien-release/16-2-remit-payoff-proceeds-to-fannie-mae.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 16.2-T1 — implemented in src/domain/payoff/payoff.test.ts
// 16.2-T2 — implemented in src/domain/payoff/payoff.test.ts
// 16.2-T3 — implemented in src/domain/payoff/payoff.test.ts
// 16.2-T4 — implemented in src/domain/payoff/payoff.test.ts
// 16.2-T5 — implemented in src/domain/payoff/payoff.test.ts
// 16.2-T6 — implemented in src/domain/payoff/payoff.test.ts
// 16.2-T7 — implemented in src/domain/payoff/payoff.test.ts
// 16.2-T8 — implemented in src/domain/payoff/payoff.test.ts
test("16.2-T9: Given Fannie Mae advanced $1,250.00 of taxes recovered in the payoff, then a special remittance for $1,250.00 is instructed by 11/15/2026 and excluded from the CRS 001 amount.", { todo: true });
test("16.2-T10: Given the CRS batch missed the 16:00 ET cut-off on 10/16, then the draft settles 10/20, the timer breaches with sev-1, and the late-fee exposure is logged for the 6.3 reconciliation.", { todo: true });
test("16.2-T11: Given an autodraft scheduled 10/20 on a loan paid off 10/16, then the authorization is terminated 10/16 and, if a debit still occurs, the funds are refunded within 10 BD as `post_payoff_receipt`.", { todo: true });
test("16.2-T12: Given a NoE alleging the payoff statement understated the balance and caused a shortage, then 4.1's clocks run, the shortage is `servicer_absorbed`, and the response cites the statement hash.", { todo: true });
