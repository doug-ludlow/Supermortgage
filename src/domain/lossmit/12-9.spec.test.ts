// 12.9 Short sale / Mortgage Release (DIL)
// spec/sections/12-loss-mitigation/12-9-short-sale-mortgage-release-dil.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("12.9-T1: Given a complete BRP and an initial offer received 2026-10-05 (loan 8 months delinquent), when processed, then the acknowledgment is sent by 2026-10-12 (5 BD), the valuation is ordered on eligibility, and the approval/counter/decline is sent by 2026-11-04 (30 days).", { todo: true });
// 12.9-T2 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T3: (reserves >$50,000) case routed non-delegated with the assets field populated; no delegated approval issued.", { todo: true });
// 12.9-T4 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.9-T5 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T6: (settlement review) CD shows a $2,000 payment to the borrower beyond the $7,500 incentive \u2192 funding blocked; fraud review.", { todo: true });
// 12.9-T7 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.9-T8 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T9: (lease option) borrower in active Chapter 13 \u2192 12-month lease refused; 3-month transition allowed (principal residence).", { todo: true });
test("12.9-T10: (holds) during the listing period 13.x motion for judgment is refused (41(g)(3)-1); after approval, sale refused for 60 days; CA loan \u2192 NOD rescission task within 5 BD.", { todo: true });
// 12.9-T11 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.9-T12: (Military Indulgence) DMDC-verified active duty with pre-service loan \u2192 indulgence case, 6% cap applied retroactively (13.9), late charges after call-up waived, status 32, quarterly contact timer.", { todo: true });
