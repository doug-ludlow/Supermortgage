// 17.1 Fannie Mae transfer approval
// spec/sections/17-servicing-transfer-out/17-1-fannie-mae-transfer-approval.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 17.1-T1 — implemented in src/domain/transfers/transfers.test.ts
// 17.1-T2 — implemented in src/domain/transfers/transfers.test.ts
// 17.1-T3 — implemented in src/domain/transfers/transfers.test.ts
test("17.1-T4: Given the Quick Exchange CD20 download differs from `transfer_batch_loans` by one loan, then attestation is blocked until a new list version resolves it.", { todo: true });
test("17.1-T5: Given a `master_change_sub_retained` batch with identical payee/address/account/amount, then no goodbye run is created and an `officer` exclusion record exists.", { todo: true });
// 17.1-T6 — implemented in src/domain/transfers/transfers.test.ts
// 17.1-T7 — implemented in src/domain/transfers/transfers.test.ts
test("17.1-T8: Given a loan pays off Nov 27 after attestation, then it is flagged `withdrawn_after_attestation`, the removal is reported by BD2 and the transferee tape marks it.", { todo: true });
