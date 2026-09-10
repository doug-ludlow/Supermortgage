// 18.6 Reg AB / USAP attestation
// spec/sections/18-qc-audit-regulatory-reporting/18-6-reg-ab-usap-attestation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 18.6-T1 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.6-T2 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.6-T3: Given a sev-1 QC finding tagged `1122.d.4.x` (escrow refund late on 40 loans), then it appears in the exceptions list and cannot be removed without an officer disposition.", { todo: true });
// 18.6-T4 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.6-T5: Given `control_evidence.generate('2026-07-01','2027-06-30')` for a June issuer year, then evidence spans the window regardless of Supermortgage's December fiscal year.", { todo: true });
test("18.6-T6: Given a material-noncompliance determination, then the partner is notified within 1 BD and the item is in the assessment text.", { todo: true });
// 18.6-T7 — implemented in src/domain/qc-audit/qc-audit.test.ts
