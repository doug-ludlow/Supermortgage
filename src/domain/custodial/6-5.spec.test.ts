// 6.5 Unidentified/unapplied funds management
// spec/sections/06-custodial-account-management/6-5-unidentified-unapplied-funds-management.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("6.5-T1: Given P = $1,842.17, receipts $1,500.00 (10/03) and $342.17 (10/20) with conditions met, then one payment is applied `credited_as_of` 2026-10-20, suspense = $0.00, both notices/statement lines produced; timer `FNMA_C1102_PARTIAL_BALANCE_30` satisfied.", { todo: true });
test("6.5-T2: Given the same first receipt and nothing by 2026-11-02, then on 2026-11-03 the $1,500.00 is returned by ACH to the originating account, `SUSP-PARTIAL-RETURN-v1` sent, status `returned`.", { todo: true });
test("6.5-T3: Given a payment $1,800.00 vs P $1,842.17 (deficiency $42.17), instrument dated 2005, `partial_count_12m = 2`, then the $50 rule applies (escrow reduced by $42.17, payment applied as of receipt) and the count becomes 3; a fourth such payment within 12 months is treated as an ordinary partial.", { todo: true });
// 6.5-T4 — implemented in src/domain/custodial/custodial.test.ts
// 6.5-T5 — implemented in src/domain/custodial/custodial.test.ts
test("6.5-T6: Given \u03a3 unapplied on a loan reaches P on a Friday, then the application is posted with `credited_as_of` Friday even if the job runs Monday (Reg Z), and the `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` timer is satisfied.", { todo: true });
// 6.5-T7 — implemented in src/domain/custodial/custodial.test.ts
test("6.5-T8: Given an item aged 90 days in `researching`, then `officer` high escalation and the partner aging report line.", { todo: true });
test("6.5-T9: Given a borrower on an AI outreach call asks for a person, then warm transfer to `human_agent` and the contact record shows `mode = ai_voice`, disclosure given, transfer time.", { todo: true });
// 6.5-T10 — implemented in src/domain/custodial/custodial.test.ts
