// 14.2 Payment change notices (Rule 3002.1)
// spec/sections/14-bankruptcy/14-2-payment-change-notices-rule-3002-1.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 14.2-T1 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.2-T2 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.2-T3 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.2-T4 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
test("14.2-T5: Given a $60 inspection-only batch with no other items, then the batch waits until day 90 and files then (before day 180) even though Fannie Mae's fee is not claimable.", { todo: true });
// 14.2-T6 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.2-T7 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.2-T8 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
test("14.2-T9: Given the same notice but the 2031-06-01 installment unpaid, then the response states \"not current,\" itemizes 2031-06-01 with its amount, attaches the Part 4 history, and the (g)(4) window timer starts on service.", { todo: true });
test("14.2-T10: Given a (b)(4) motion docketed 2026-10-28, then the November amount is held at $2,699.22 and the change applies only per the court's order.", { todo: true });
// 14.2-T11 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
test("14.2-T12: Given a relief order entered while the case remains open, then filings continue (policy) and the decision record cites 14.2-Q2.", { todo: true });
test("14.2-T13: Given an ARM change effective 2027-02-01 with the Reg Z notice generated 2026-11-20, then the 410S-1 (Part 2, notice attached) is filed by 2026-11-27 and the deadline 2027-01-11 is satisfied.", { todo: true });
test("14.2-T14: Given two changes for 2027-03-01 (ARM and escrow) detected on different days, then a single superseding 410S-1 with Parts 1 and 2 is filed and the first is marked `superseded`.", { todo: true });
