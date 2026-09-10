// 7.1 Periodic statement
// spec/sections/07-compliance-notices-disclosures/7-1-periodic-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 7.1-T1 — implemented in src/domain/notices/notices.test.ts
// 7.1-T2 — implemented in src/domain/notices/notices.test.ts
// 7.1-T3 — implemented in src/domain/notices/notices.test.ts
test("7.1-T4: Given an active Flex Mod trial with TPP payment $2,100.00, then amount due = $2,100.00 and the explanation shows both $2,100.00 and the contractual $2,946.79; application per contract.", { todo: true });
test("7.1-T5: Given a Chapter 13 case opened Oct 5, then the Nov cycle may use the single-statement exemption and the Dec cycle renders `NTC_REGZ_41_STMT_BK12_13` with post-petition amount due and pre-petition arrearage figures and no late-fee language.", { todo: true });
test("7.1-T6: Given a written cease request received Oct 12 from the debtor's attorney, then `statement.cycle.exempt` is recorded with the image as evidence and no statement is sent for cycles after Oct 12; given a later written request for statements, then statements resume the next cycle.", { todo: true });
test("7.1-T7: Given charge-off approved Nov 3, then `NTC_REGZ_41E6_CHARGEOFF_SUSPENSION` is sent by Dec 3 with the exact title and seven items; given a fee assessed Jan 10, then statements resume and the fee is reversed.", { todo: true });
test("7.1-T8: Given the October payment unpaid on Oct 17 and no forbearance, then the Oct 17 statement carries the D2-2-03 panel and `FNMA_D2_2_03_PAYMENT_REMINDER_20` is satisfied; given the statement is held, then a standalone reminder is sent by Oct 20.", { todo: true });
// 7.1-T9 — implemented in src/domain/notices/notices.test.ts
// 7.1-T10 — implemented in src/domain/notices/notices.test.ts
test("7.1-T11: Given a checklist `block` failure (missing toll-free number), then the statement is held, cannot be sent, and an ops alert fires within 5 minutes.", { todo: true });
test("7.1-T12: Given e-delivery consent active and the availability email hard-bounces, then a paper statement is mailed within 1 business day and the consent is flagged `suspect`.", { todo: true });
test("7.1-T13: Given tax year 2026 interest received $23,412.55 and Jan 1 UPB $371,048.86, then the 1098 shows box 1 $23,412.55, box 2 $371,048.86, is furnished by Jan 31, 2027 and e-filed by Mar 31, 2027; given electronic furnishing, then it remains accessible through Oct 15, 2027.", { todo: true });
test("7.1-T14: Given a confirmed successor without an executed acknowledgment, then no statement is addressed to the successor; given the acknowledgment executed, then the successor is added as a recipient on the next cycle.", { todo: true });
test("7.1-T15: Given transfer-out effective Dec 1, then no statement is generated for the Dec 1 cycle and the Nov statement references the goodbye notice.", { todo: true });
