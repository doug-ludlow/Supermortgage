// 18.2 Fannie Mae MORA reviews
// spec/sections/18-qc-audit-regulatory-reporting/18-2-fannie-mae-mora-reviews.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 18.2-T1 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.2-T2: Given a loan with a bankruptcy and a foreclosure referral, when the package compiles, then the PDF contains the header fields, collection history, workout summary, BK log, FC log with E-3.2-15 comparison, expense support and the timer appendix, and the manifest hash matches the stored document.", { todo: true });
// 18.2-T3 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.2-T4 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.2-T5 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.2-T6: Given a remedy demand received with the report, then Section 5.x `FNMA_A1302_APPEAL1_60` starts and the exam record links the repurchase case.", { todo: true });
// 18.2-T7 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.2-T8: Given a subpoena, then `SM_EXAM_LITIGATION_HOLD` blocks retention purges for the scoped loans (verified by attempting a purge job).", { todo: true });
// 18.2-T9 — implemented in src/domain/qc-audit/qc-audit.test.ts
