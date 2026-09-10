// 14.1 Bankruptcy monitoring & Proof of Claim
// spec/sections/14-bankruptcy/14-1-bankruptcy-monitoring-proof-of-claim.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("14.1-T1: Given an EBN notice for fixture BK-13-A received 2026-09-09 10:00, when ingested, then `stay_gates` show all blocks within 5 minutes, `FNMA_E2_1_03_SUSPEND_COLLECTION_0` is satisfied, and a scheduled D2-2-02 call for 2026-09-09 14:00 is cancelled.", { todo: true });
test("14.1-T2: Given the PCL party search returns a same-surname debtor with a different SSN4, then no case is opened, the notice is rejected with a decision record, and gates are released.", { todo: true });
// 14.1-T3 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.1-T4 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
test("14.1-T5: Given the Sept-1 installment's grace ends 2026-09-16 (post-petition), then no late charge is assessed and the claim's fees are $450.84.", { todo: true });
test("14.1-T6: Given a conversion order on 2027-02-03, then a new 70-day POC timer is due 2027-04-14 and the Chapter 13 ledgers are frozen.", { todo: true });
// 14.1-T7 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.1-T8 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
// 14.1-T9 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
test("14.1-T10: Given Chapter 7 example C, when $2,699.22 is received 2026-10-05, then it applies to the 2026-05-01 installment; after discharge 2026-12-15 the loan enters discharge-injunction mode and the 13.x breach letter uses the informational variant.", { todo: true });
// 14.1-T11 — implemented in src/domain/bankruptcy/bankruptcy.test.ts
test("14.1-T12: Given a plan proposing an arrearage of $9,800.00 and a 6-year cure, then an objection package is produced (variance > $50; cure > 60 months) before the docketed objection deadline.", { todo: true });
test("14.1-T13: Given a plan that bifurcates a $325,000 claim on an investment property, then `bankruptcy.cramdown.requested` fires, the Form 20 package is ready within 1 BD, no Form 3179 is created, and the SMDU reporting task is created only after confirmation.", { todo: true });
test("14.1-T14: Given a relief order entered 2027-04-20, then `foreclosure_blocked` remains true until 2027-05-04 and `assertGateOpen` blocks a referral on 2027-05-01.", { todo: true });
test("14.1-T15: Given a foreclosure sale held 2027-03-03 and a petition dated 2027-03-02 discovered 2027-03-10, then the Bankruptcy Notification Template is sent by 2027-03-12 and counsel is engaged the same day.", { todo: true });
test("14.1-T16: Given the case is dismissed 2027-06-05 with $9,500.00 of arrearage cured through the trustee, then the contract-terms view shows the cured amounts applied FIFO to May\u2013Aug 2026, suspended late charges are waived, and 13.x receives `bankruptcy.case.dismissed`.", { todo: true });
test("14.1-T17: Given a counsel document request at 15:00 Friday 2026-10-16, then the fulfilment deadline is Wednesday 2026-10-21 (3 servicer business days).", { todo: true });
test("14.1-T18: Given an MFR relief order on 2027-04-20, then the expense claim is due by 2027-06-19 and the invoice lines match $1,350 (MFR), $1,225 (POC & plan review), $325 (410A).", { todo: true });
