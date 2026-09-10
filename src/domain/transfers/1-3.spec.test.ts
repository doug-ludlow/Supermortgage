// 1.3 RESPA transfer notices (goodbye/hello)
// spec/sections/01-boarding-servicing-transfer-in/1-3-respa-transfer-notices-goodbye-hello.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 1.3-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T2 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T3 — implemented in src/domain/transfers/transfers.test.ts
test("1.3-T4: Given a rendered notice missing the transferor's toll-free number, then the run cannot be released.", { todo: true });
// 1.3-T5 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T6 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T7 — implemented in src/domain/transfers/transfers.test.ts
test("1.3-T8: Given a returned hello notice, then a skip-trace order exists within 5 servicer business days and the original proof of mailing remains linked.", { todo: true });
test("1.3-T9: Given an ACP-enrolled borrower, then the notice is addressed to the ACP substitute address only.", { todo: true });
test("1.3-T10: Given a master-servicer-only change with identical payee/address/account/amount, then no notices are generated and an `officer` approval record documents the exclusion.", { todo: true });
