// 1.7 Loss-mit in-flight transfer handling
// spec/sections/01-boarding-servicing-transfer-in/1-7-loss-mit-in-flight-transfer-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 1.7-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T2 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T3 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T4 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T5 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T6 — implemented in src/domain/transfers/transfers.test.ts
test("1.7-T7: Given a transferor file missing the application's received date, then `CO-02` fails, a transferor request is sent within 2 business days, and no borrower request is made before the transferor fails to respond.", { todo: true });
// 1.7-T8 — implemented in src/domain/transfers/transfers.test.ts
test("1.7-T9: Given the AI proposes a denial, then the determination notice cannot be sent without a `lossmit_reviewer` approval record.", { todo: true });
test("1.7-T10: Given `regx.lossmit.2024nprm` is switched on for new cases, then inherited cases keep `deemed_received_at` and their existing timers are cancelled with reason `rule_set_change` and re-issued under the new definitions.", { todo: true });
