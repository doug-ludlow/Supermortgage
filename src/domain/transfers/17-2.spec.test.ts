// 17.2 RESPA goodbye notice
// spec/sections/17-servicing-transfer-out/17-2-respa-goodbye-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 17.2-T1 — implemented in src/domain/transfers/transfers.test.ts
// 17.2-T2 — implemented in src/domain/transfers/transfers.test.ts
test("17.2-T3: Given a rendered notice missing the transferee's toll-free number, then release is refused.", { todo: true });
// 17.2-T4 — implemented in src/domain/transfers/transfers.test.ts
// 17.2-T5 — implemented in src/domain/transfers/transfers.test.ts
test("17.2-T6: Given a payment returned to the payor, then `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` exists naming the transferee.", { todo: true });
// 17.2-T7 — implemented in src/domain/transfers/transfers.test.ts
// 17.2-T8 — implemented in src/domain/transfers/transfers.test.ts
test("17.2-T9: Given a `master_change_sub_retained` batch, then no goodbye run exists and the exclusion record is present.", { todo: true });
test("17.2-T10: Given the transfer is cancelled Nov 20 after mailing, then a corrective notice is mailed by Nov 27 and the goodbye timer is cancelled with reason `transfer_cancelled`.", { todo: true });
