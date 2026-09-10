// 16.1 Payoff statement
// spec/sections/16-payoff-lien-release/16-1-payoff-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 16.1-T1 — implemented in src/domain/payoff/payoff.test.ts
// 16.1-T2 — implemented in src/domain/payoff/payoff.test.ts
// 16.1-T3 — implemented in src/domain/payoff/payoff.test.ts
// 16.1-T4 — implemented in src/domain/payoff/payoff.test.ts
test("16.1-T5: Given an ARM rate change effective inside the window (7.2 notice), then two segments are computed and the statement prints both rates; given the change is noticed after the statement, then an updated statement issues within 1 BD.", { todo: true });
// 16.1-T6 — implemented in src/domain/payoff/payoff.test.ts
// 16.1-T7 — implemented in src/domain/payoff/payoff.test.ts
test("16.1-T8: Given a Florida property, then the statement contains no disclaimer text (checklist assertion) and a corrected statement sent at 4 p.m. the business day before payment does not supersede the original for reliance purposes.", { todo: true });
test("16.1-T9: Given a Texas title-company request on the Finance Commission form with closing date 10/15, then the figure is valid through 10/15 and a later demand for more is blocked by the engine (shortage \u2192 `servicer_absorbed`).", { todo: true });
test("16.1-T10: Given the request arrives while a $1,900 tax disbursement is scheduled for 10/20, then the escrow paragraph states the balance will be refunded and the tax bill will not be paid by the servicer after 10/15 (3.5 cut-off), and the borrower is told to pay it.", { todo: true });
test("16.1-T11: Given a Connecticut request specifying a payoff date 5 BD ahead, then the deadline is 7 BD (statutory floor) and the federal 7-BD timer governs; if breached, the `interest_forfeit_if_late` flag opens a `qc_finding`.", { todo: true });
test("16.1-T12: Given an oral AI-voice request after identity verification, then the figure equals the engine's and the call transcript shows the automation disclosure, good-through, per diem, and the offer of a written statement.", { todo: true });
test("16.1-T13: Given an agent attempts `renderStatement` with a wire-instruction version that is not the vault's active version, then the gate blocks and a `security-records` alert is raised.", { todo: true });
test("16.1-T14: Given a NIB loan maturing 06/01/2027, then `NTC_FNMA_NIB_BALANCE_NOTICE` is sent between 12/03/2026 and 01/02/2027 and, absent contact, a second between 03/18 and 04/02/2027.", { todo: true });
test("16.1-T15: Given a payment reversal on an active statement, then a recompute occurs, the updated statement goes to every prior recipient within 1 BD, and the original is retained with `superseded_by`.", { todo: true });
