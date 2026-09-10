// 7.3 ARM initial adjustment notice
// spec/sections/07-compliance-notices-disclosures/7-3-arm-initial-adjustment-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 7.3-T1 — implemented in src/domain/notices/notices.test.ts
// 7.3-T2 — implemented in src/domain/notices/notices.test.ts
test("7.3-T3: Given the latest index publication is 16 business days old, then rendering is held until a fresh value is captured.", { todo: true });
test("7.3-T4: Given a loan boarded 2026-06-01 (T\u2212183) with a transferor (d) notice image dated 2026-04-15 in the file, then status = `transferor_evidenced` and no duplicate is sent.", { todo: true });
test("7.3-T5: Given the same boarding with no evidence, then the notice is sent within 5 business days and a transferor-breach record is created.", { todo: true });
// 7.3-T6 — implemented in src/domain/notices/notices.test.ts
test("7.3-T7: Given the notice is co-mailed with the periodic statement, then it is a separate PDF with its own first page and the composer log shows two documents in one envelope.", { todo: true });
test("7.3-T8: Given a Texas property, then the (xi) block names the Texas state housing finance authority from `jurisdiction_rules`.", { todo: true });
test("7.3-T9: Given the margin is corrected on 2026-04-28 after a 2026-04-21 send, then a corrected (d) notice is sent by 2026-05-05.", { todo: true });
