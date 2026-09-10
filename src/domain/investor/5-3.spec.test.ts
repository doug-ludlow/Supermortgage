// 5.3 Reporting liquidations (payoff/foreclosure/short sale)
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-3-reporting-liquidations-payoff-foreclosure-short-sale.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 5.3-T1 — implemented in src/domain/investor/investor.test.ts
test("5.3-T2: Given a payoff processed Mon Nov 2, 2026 (BD1), then the AC 60 deadline is Tue Nov 3 17:00 ET and, for an S/S loan, no full-month interest is charged if reported by BD2.", { todo: true });
// 5.3-T3 — implemented in src/domain/investor/investor.test.ts
// 5.3-T4 — implemented in src/domain/investor/investor.test.ts
// 5.3-T5 — implemented in src/domain/investor/investor.test.ts
test("5.3-T6: Given the AC 60 was accepted in the October period and the wire is reversed Nov 4, 2026 (after Nov 3 BD2 close), then no correction is projected, `fnma_liquidated_in_error` is set, the amount due is computed for remittance and an `officer` escalation and `qc_finding` case open.", { todo: true });
test("5.3-T7: Given a DRA \"Foreclosure Sale Held\" event from the firm feed dated Oct 14 with no matching `foreclosure.sale.held` in our system by Oct 15, then a sev-1 escalation fires and the REOgram confirmation task is pre-created due Oct 16.", { todo: true });
test("5.3-T8: Given a REOgram notice received Wed Nov 25, 2026 17:30 ET, then the confirmation task is due Mon Nov 30 (next `fannie_et` BD after Fannie Mae holidays Nov 26\u201327), with a warning at 70%.", { todo: true });
test("5.3-T9: Given `removal.liquidation.third_party.mode = event` in CIT, then the P360 liquidation event JSON is produced in `api-clve` and diffed against the production LAR 71.", { todo: true });
test("5.3-T10: Given the agent's confidence on insured status is 0.7, then the removal is held, a `human_agent` review is requested at deadline \u2212 4h, and the timer still breaches if unresolved (evidence retained).", { todo: true });
