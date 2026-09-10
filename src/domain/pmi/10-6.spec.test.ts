// 10.6 Denial notice
// spec/sections/10-pmi-administration/10-6-denial-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 10.6-T1 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T2 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T3 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T4 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T5 — implemented in src/domain/pmi/pmi.test.ts
test("10.6-T6: Given an MN loan and a request missing the property-occupancy confirmation, then `NTC_MI_INFO_REQUEST` is sent within 30 days of receipt and the MN timer is satisfied.", { todo: true });
// 10.6-T7 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T8 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T9 — implemented in src/domain/pmi/pmi.test.ts
test("10.6-T10: Given 10% monthly QC sampling, then sampled denials are marked and the QC findings feed `qc_finding` cases.", { todo: true });
