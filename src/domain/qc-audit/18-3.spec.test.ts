// 18.3 STAR performance measurement
// spec/sections/18-qc-audit-regulatory-reporting/18-3-star-performance-measurement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 18.3-T1 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T2 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.3-T3: Given a loan transferred in on 2027-02-01, then it is excluded from T60/C60/RET_EFF for Feb and Mar 2027 but included in MOD6/PD6.", { todo: true });
// 18.3-T4 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T5 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T6 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T7 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T8 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.3-T9: Given a vendor newsletter draft citing \"STAR-level performance,\" then the confidentiality filter blocks it.", { todo: true });
