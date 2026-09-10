// 16.4 MERS deactivation
// spec/sections/16-payoff-lien-release/16-4-mers-deactivation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 16.4-T1 — implemented in src/domain/payoff/payoff.test.ts
// 16.4-T2 — implemented in src/domain/payoff/payoff.test.ts
// 16.4-T3 — implemented in src/domain/payoff/payoff.test.ts
test("16.4-T4: Given a MERS reject (MIN not found under Supermortgage's Org ID), then the exception is opened, the Subservicer designation is checked (1.5) and the transaction is resubmitted within 1 BD.", { todo: true });
// 16.4-T5 — implemented in src/domain/payoff/payoff.test.ts
// 16.4-T6 — implemented in src/domain/payoff/payoff.test.ts
test("16.4-T7: Given the November MRE lists an active MIN for a loan paid off and released in August, then a QA finding opens with sev-1 and the deactivation is submitted the same day.", { todo: true });
test("16.4-T8: Given the MERS batch channel is down on 12/22 with a 12/25 deadline, then the escalation fires at deadline \u2212 5 days and a manual MERS OnLine task is created for the `officer`-authorized operator.", { todo: true });
