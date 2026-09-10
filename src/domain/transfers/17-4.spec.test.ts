// 17.4 Loss-mit in-flight transfer
// spec/sections/17-servicing-transfer-out/17-4-loss-mit-in-flight-transfer.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 17.4-T1 — implemented in src/domain/transfers/transfers.test.ts
// 17.4-T2 — implemented in src/domain/transfers/transfers.test.ts
// 17.4-T3 — implemented in src/domain/transfers/transfers.test.ts
test("17.4-T4: Given an acceptance received by Supermortgage Dec 3 for an offer expiring Dec 4, then it is forwarded Dec 3 (same day) and `SM_LOSSMIT_POST_T_FORWARD_1` is satisfied.", { todo: true });
test("17.4-T5: Given a foreclosure sale Dec 22 and a complete application received Nov 10, then a hold instruction is acknowledged by counsel before Nov 30 and `TO-11` shows the (g) gate closed.", { todo: true });
// 17.4-T6 — implemented in src/domain/transfers/transfers.test.ts
test("17.4-T7: Given an NoE received Nov 28 on a listed loan, then Supermortgage answers within the 4.1 clock after T and the transferee receives a copy.", { todo: true });
test("17.4-T8: Given a trial payment received Dec 3 for the Dec 1 due date, then it is forwarded with receipt date Dec 3 and Supermortgage records no trial failure.", { todo: true });
// 17.4-T9 — implemented in src/domain/transfers/transfers.test.ts
test("17.4-T10: Given the AI proposes a denial on Nov 29 to beat T, then the notice cannot issue without a `lossmit_reviewer` approval record, and absent approval the case is handed off undetermined.", { todo: true });
test("17.4-T11: Given a bankruptcy case with a 3002.1 payment-change notice due Dec 10, then the package flags it, counsel is instructed by Nov 30, and the trustee notice is sent by Nov 30.", { todo: true });
