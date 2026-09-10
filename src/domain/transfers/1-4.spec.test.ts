// 1.4 Document custody verification
// spec/sections/01-boarding-servicing-transfer-in/1-4-document-custody-verification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 1.4-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T2 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T3 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T4 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T5 — implemented in src/domain/transfers/transfers.test.ts
test("1.4-T6: Given an eNote whose eRegistry Servicing Agent \u2260 Supermortgage Org ID on Oct. 1, then the timer breaches and the payoff command for that loan is blocked with reason `enote_servicing_agent_mismatch`.", { todo: true });
test("1.4-T7: Given the agent's forecast shows 400 of 5,000 loans unrecertified at Feb. 15, 2027, then an extension request draft exists by Mar. 1, 2027 and an `officer` task is open.", { todo: true });
// 1.4-T8 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T9 — implemented in src/domain/transfers/transfers.test.ts
