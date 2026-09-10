// 7.2 ARM interest rate adjustment notice
// spec/sections/07-compliance-notices-disclosures/7-2-arm-interest-rate-adjustment-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 7.2-T1 — implemented in src/domain/notices/notices.test.ts
// 7.2-T2 — implemented in src/domain/notices/notices.test.ts
// 7.2-T3 — implemented in src/domain/notices/notices.test.ts
// 7.2-T4 — implemented in src/domain/notices/notices.test.ts
// 7.2-T5 — implemented in src/domain/notices/notices.test.ts
// 7.2-T6 — implemented in src/domain/notices/notices.test.ts
// 7.2-T7 — implemented in src/domain/notices/notices.test.ts
test("7.2-T8: Given a rate change with an unchanged payment (payment-cap plan), then `NTC_FNMA_C2_1_02_RATE_CHANGE` is sent \u2265 25 days before the change date and no Reg Z (c) notice is generated.", { todo: true });
test("7.2-T9: Given a 2-1 temporary buydown stepping on 2027-01-01, then `NTC_FNMA_C2_1_02_BUYDOWN_STEP_90` is sent by 2026-10-03.", { todo: true });
test("7.2-T10: Given a boarding margin error discovered (2.750 booked as 3.250) after two adjustments, then re-amortization yields the overcharge, a cash refund is issued (combined error > $1.00), the correction notice is sent, the correction is reported only after `irr_discussed_at` is set, and both are complete within 60 days.", { todo: true });
test("7.2-T11: Given an FDCPA 805(c) notice on file, then no `NTC_REGZ_20C_ARM_ADJ` is generated and the Fannie Mae informational notice is sent instead, with the decision record citing (c)(1)(ii)(C).", { todo: true });
test("7.2-T12: Given the NY Fed API returns HTTP 5xx for 2 days, then the capture timer alerts, the fallback source is used with dual-control evidence, and the calculation proceeds on the correct index date.", { todo: true });
test("7.2-T13: Given a Chapter 13 debtor, then `payment.change.scheduled` reaches 14.2 at least 60 days before the new payment and the 3002.1 notice is filed \u2265 21 days before.", { todo: true });
test("7.2-T14: Given e-delivery consent for `arm_notices`, then the notice is emailed/posted within the window; given no consent, then it is mailed; SMS-only is never used.", { todo: true });
