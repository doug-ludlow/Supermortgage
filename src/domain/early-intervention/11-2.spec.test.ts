// 11.2 Written early intervention notice
// spec/sections/11-early-intervention-collections/11-2-written-early-intervention-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 11.2-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T5 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T6 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T7 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T8 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.2-T9: Given the assigned-contact block is missing at render, then the send is refused, auto-assignment runs (4.3) and the re-render passes.", { todo: true });
test("11.2-T10: Given no `esign` consent for `regx_ei`, then the channel is mail; given consent and an email bounce, then mail is generated the same day.", { todo: true });
test("11.2-T11: Given no QRPC by day 45, then a BSP (745 + 710) is sent with the EI notice in the same envelope, `hope_hotline_present=true`, and a `Borrower Solicitation Package` action event exists.", { todo: true });
test("11.2-T12: Given QRPC on day 30 with no resolution and no prior BSP, then a BSP is sent within 3 servicer BD; given a prior BSP exists, then none is sent and the decision cites it.", { todo: true });
test("11.2-T13: Given an investment property, then no Reg X notice leg exists but `FNMA_D2204_SOLICITATION_45` runs.", { todo: true });
test("11.2-T14: Given a DC loan inside its Reg F validation period, then the EI notice carries the \u00a71006.18(e) disclosure and no language demanding payment within the validation period (overshadowing check).", { todo: true });
test("11.2-T15: Given the print vendor fails on 2026-12-14, then the secondary vendor mails on 12-15 and the timer is satisfied; given both fail through 12-16, then a breach with `officer` escalation is recorded and the notice mails 12-17.", { todo: true });
