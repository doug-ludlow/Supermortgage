// 18.5 Mortgage fraud reporting
// spec/sections/18-qc-audit-regulatory-reporting/18-5-mortgage-fraud-reporting.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 18.5-T1 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.5-T2 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.5-T3 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.5-T4 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.5-T5 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.5-T6: Given the agent proposes a determination with confidence 0.95, then the case still requires the fraud officer's recorded determination before any report is drafted for signature.", { todo: true });
test("18.5-T7: Given a validated QC finding affecting 620 loans, then `FNMA_A3201_BREACH_SELF_REPORT_60` starts from the later of quarter-end or discovery.", { todo: true });
// 18.5-T8 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.5-T9 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.5-T10: Given quarterly fairness stats showing flag rates 4.1% vs 2.0% by protected class, then a finding opens for rule review (routed via counsel).", { todo: true });
