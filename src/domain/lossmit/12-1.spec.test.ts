// 12.1 Acknowledge loss-mit application
// spec/sections/12-loss-mitigation/12-1-acknowledge-loss-mit-application.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 12.1-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T2 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T3 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.1-T4: (facially complete) all listed items received 2026-10-01 \u2192 `facially_complete_at=2026-10-01`; verification finds a stale paystub \u2192 supplemental request 2026-10-02 with date \u22652026-10-09; `foreclosure_holds{kind=regx_f2_prefiling}` active throughout; borrower complies 2026-10-07 \u2192 `deemed_complete_date=2026-10-01`, `complete_at=2026-10-07`; (c)(3) notice by 2026-10-14.", { todo: true });
// 12.1-T5 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T6 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T7 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.1-T8: (RFA only) call \"what programs do you have?\" with no financial info \u2192 `rfa_only`, no ack timer, CA SPOC assignment (4.3) and solicitation package sent; when the borrower later says \"my income dropped by half,\" application opens with that date.", { todo: true });
test("12.1-T9: (AI outage) document AI unavailable for 3 days \u2192 human checklist task completes the determination on day 4; ack on time; incident logged.", { todo: true });
test("12.1-T10: (CA per-document ack) each of three separate uploads on a CA loan receives an acknowledgment within 5 business days.", { todo: true });
test("12.1-T11: (NPRM flag) with `2024nprm`, an oral RFA received 40 days before a sale opens a review cycle and sets a `foreclosure_holds{kind=lm_review_cycle}` hold; with `2013`, it does not.", { todo: true });
test("12.1-T12: (breach) ack not produced by day 5 (simulated print failure) \u2192 escalation `officer` sev-1 created at 00:05 day 6, ack re-sent, NoE-risk flag set on the loan.", { todo: true });
