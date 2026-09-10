// 5.1 Loan Activity Report (LAR) submission
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-1-loan-activity-report-lar-submission.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 5.1-T1 — implemented in src/domain/investor/investor.test.ts
// 5.1-T2 — implemented in src/domain/investor/investor.test.ts
// 5.1-T3 — implemented in src/domain/investor/investor.test.ts
test("5.1-T4: Given a hard reject \"LPI mismatch\" received 2026-10-14 09:40 ET, when triage finds a ledger posting error, then a Section 2 correction, a superseding event with a new sequence and the same period are accepted before BD1 of the next month; head-of-line blocking prevents later events for that loan from being sent first.", { todo: true });
test("5.1-T5: Given a payoff LAR accepted in October 2026 and the error discovered 2026-11-05, then no correction is projected, a `qc_finding` case opens, and the remit/advance amount is computed.", { todo: true });
test("5.1-T6: Given `investor_reporting.escrow.deposit.mode=dual`, when an escrow deposit posts, then JSON goes to `api-clve` and no LAR is created (escrow has no LAR); when `mode=event` on 2026-12-01, the JSON goes to production and must be submitted by 03:00 ET next BD.", { todo: true });
test("5.1-T7: Given a bulk file still unacknowledged at BD2 14:00 ET, then the adapter re-sends once and, failing an ack by 14:30, opens a `human_portal_task` with the file, due 15:00 ET.", { todo: true });
// 5.1-T8 — implemented in src/domain/investor/investor.test.ts
// 5.1-T9 — implemented in src/domain/investor/investor.test.ts
// 5.1-T10 — implemented in src/domain/investor/investor.test.ts
test("5.1-T11: Given the agent is disabled, then the exception queue is worked by a human with identical decision-record fields and all timers still fire.", { todo: true });
test("5.1-T12: Given a soft reject on interest where Fannie Mae's expected interest ignores a mid-month curtailment, then the agent produces a Master Servicing package with pay history and the event closes `accepted_as_is` at period close with the decision record attached.", { todo: true });
