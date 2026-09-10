// 10.2 Automatic termination @78% LTV
// spec/sections/10-pmi-administration/10-2-automatic-termination-78-ltv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("10.2-T1: Given the worked loan current on 2035-07-01, when the sweep runs 2035-07-01 00:30, then `mi.terminated` effective 2035-07-01, LAR 89 `\u202689 0 <loan> 53 070135`, insurer message queued, escrow interim analysis requested, timers `HPA_4904A_TERMINATION_NOTICE_30` (due 2035-07-31) and `HPA_4902F1_REFUND_45` (due 2035-08-15) started.", { todo: true });
test("10.2-T2: Given the June 2035 installment unpaid on 2035-06-30, then status `deferred_not_current`, `NTC_HPA_4904B_AUTO_NOT_CURRENT` sent by 2035-07-31; when June and July are paid 2035-07-20, then termination effective 2035-08-01.", { todo: true });
test("10.2-T3: Given July paid 2035-08-03 (Scenario C), then effective 2035-09-01 and the not-current notice referenced the June installment only.", { todo: true });
// 10.2-T4 — implemented in src/domain/pmi/pmi.test.ts
// 10.2-T5 — implemented in src/domain/pmi/pmi.test.ts
test("10.2-T6: Given the sweep did not run (job failure) on the scheduled date, then `HPA_4902B_AUTO_TERMINATE_0` breaches next sweep and `officer` sev-1 opens with the affected loan list.", { todo: true });
test("10.2-T7: Given the effective date 2035-07-01 and LAR 89 not acked by BD2 Aug 2035 15:00 ET, then timer breach and a `human_portal_task` for single-LAR entry.", { todo: true });
test("10.2-T8: Given a periodic statement generated for the 2035-08-01 installment still including the MI escrow component, then the statement command is blocked by `HPA_4902E_STOP_PREMIUM_30` and an alert opens.", { todo: true });
// 10.2-T9 — implemented in src/domain/pmi/pmi.test.ts
// 10.2-T10 — implemented in src/domain/pmi/pmi.test.ts
test("10.2-T11: Given a NY loan whose actual UPB falls to 74.9% of original appraised value while its payment history fails the 30-day test, then the NY gate stops MI charges to the borrower and an `officer` escalation records the corporate premium carry.", { todo: true });
