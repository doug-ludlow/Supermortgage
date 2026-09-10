// 6.3 Monthly P&I reconciliation (Form 496)
// spec/sections/06-custodial-account-management/6-3-monthly-p-i-reconciliation-form-496.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 6.3-T1 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T2 — implemented in src/domain/custodial/custodial.test.ts
test("6.3-T3: Given completion on 2026-11-13 16:00, then timer `satisfied`; given no completion by 2026-11-13 17:00, then `breached`, `officer` critical escalation, partner notice, Sentinel report line.", { todo: true });
// 6.3-T4 — implemented in src/domain/custodial/custodial.test.ts
test("6.3-T5: Given an unmatched bank debit of $8,500.00 (BAI2 451) not in Draft Notifications/CRS reports, then severity critical, `fraud` case opened, bank contacted same day, funding tier evaluated, `officer` escalation.", { todo: true });
// 6.3-T6 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T7 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T8 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T9 — implemented in src/domain/custodial/custodial.test.ts
test("6.3-T10: Given the statement file's 49-record total \u2260 \u03a3 16 records, then `control_total_mismatch`, statement quarantined, bank re-request logged, daily recon closes with the item.", { todo: true });
test("6.3-T11: Given the reviewer run detects an item without a loan number, then status `rework`, not `approved`.", { todo: true });
test("6.3-T12: Given `custodial.form496.human_approval = on` and no officer action in 3 BD after review, then reminder escalation; the 45-day timer is unaffected (it is satisfied only by `completed`).", { todo: true });
test("6.3-T13: Given a payment reversal posted 11/20 for a 10/28 receipt after the October form is completed, then the October form is unchanged, the November Section III carries the item with `first_seen_on = 10/28` (aging 23+ days).", { todo: true });
test("6.3-T14: Given LL-2026-05 A/A auto-draft flag on, then L1 logic switches and Form 472 timers are not started for A/A.", { todo: true });
