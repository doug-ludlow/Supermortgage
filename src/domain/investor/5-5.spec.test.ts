// 5.5 Guaranty fee relief
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-5-guaranty-fee-relief.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("5.5-T1: Given the example loan current in October 2026, then the November bill line is $52.08 (check figure equal) and the draft is funded by Thu Nov 5, 2026 16:00 ET for the Fri Nov 6 draft (Nov 7 is a Saturday).", { todo: true });
test("5.5-T2: Given the loan four consecutive months delinquent at Mar 31, 2027, then `gfee_relief_status.predicted` is set, the bill after Fannie Mae's status shows zero, and the engine asserts `sda_status` is also active (special servicing).", { todo: true });
test("5.5-T3: Given two contractual payments during relief, then the next bill drafts two months of g-fee ($52.08 + $52.04) applied first to `outstanding_fnma_gfee`, and subsequent bills show servicer retention credits until $208.05 of servicer g-fee advances are recovered.", { todo: true });
test("5.5-T4: Given a bill total $48,210.44 vs computed $47,600.10 (variance $610.34 > $500), then an `officer` escalation opens with the per-loan variance list.", { todo: true });
test("5.5-T5: Given a regular servicing option MBS loan five months delinquent, then g-fee relief is active while P&I advances continue (documented expected divergence, no alert).", { todo: true });
test("5.5-T6: Given the g-fee draft date Jan 7, 2027 (Thursday), then funding gate = Wed Jan 6 16:00 ET; for Feb 7, 2027 (Sunday) the draft date is Fri Feb 5 and the gate Thu Feb 4.", { todo: true });
