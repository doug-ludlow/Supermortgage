// 7.6 Payoff statement
// spec/sections/07-compliance-notices-disclosures/7-6-payoff-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 7.6-T1 — implemented in src/domain/notices/notices.test.ts
test("7.6-T2: Given the same request by mail received by the scanning vendor 2026-10-13, then the clock starts 2026-10-13 (vendor receipt date, not postmark).", { todo: true });
// 7.6-T3 — implemented in src/domain/notices/notices.test.ts
// 7.6-T4 — implemented in src/domain/notices/notices.test.ts
test("7.6-T5: Given an oral request by AI voice, then a quote is given per 16.1, no \u00a71026.36(c)(3) timer starts, and the borrower is offered a one-click written request; given the click, then the timer starts at the click time.", { todo: true });
// 7.6-T6 — implemented in src/domain/notices/notices.test.ts
// 7.6-T7 — implemented in src/domain/notices/notices.test.ts
// 7.6-T8 — implemented in src/domain/notices/notices.test.ts
test("7.6-T9: Given an escrow tax disbursement advance posted after the statement but before the good-through date, then an updated statement is issued the same day and the original is marked superseded.", { todo: true });
test("7.6-T10: Given a confirmed successor requests a payoff, then it is a consumer request (no authorization needed) and the statement is delivered to the successor.", { todo: true });
test("7.6-T11: Given a NoE alleging an inaccurate payoff, then the 4.1 NoE case links to the `payoff_requests` row and the statement hash under investigation.", { todo: true });
