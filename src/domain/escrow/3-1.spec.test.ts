// 3.1 Initial escrow account statement
// spec/sections/03-escrow-administration/3-1-initial-escrow-account-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("3.1-T1: Given a loan boarded 10 days after settlement with originator statement evidence dated at settlement, when boarding completes, then status = `satisfied_by_originator` and no timer instance is created.", { todo: true });
test("3.1-T2: Given no evidence and settlement 2026-09-01, when boarded 2026-09-15, then timer due 2026-10-16 23:59 (property TZ) and a statement is sent by then; `loan_events` has `escrow.statement.sent`.", { todo: true });
// 3.1-T3 — implemented in src/domain/escrow/escrow.test.ts
test("3.1-T4: Given settlement 2026-08-10 and boarding 2026-10-01 with no evidence, when boarded, then the statement is sent within 1 business day and the timer is recorded `breached` with `waiver_reason='inherited_from_originator'` and a `qc_finding` case exists.", { todo: true });
test("3.1-T5: Given a transfer-in effective 2026-11-01 where the new escrow payment differs by $0.01, when transfer completes, then `REGX_1024_17E_TRANSFER_INITIAL_STMT_60` is due 2026-12-31 and `computation_year_start` = 2026-11-01.", { todo: true });
test("3.1-T6: Given a waiver revocation on 2026-10-05 (3.8), when the account is established, then `REGX_1024_17G_INITIAL_STMT_45` due 2026-11-19 and an Escrow Setup investor event is queued before any deposit event.", { todo: true });
test("3.1-T7: Given valid E-SIGN consent for class `escrow_statements`, when sent, then channel = electronic with receipt evidence; given consent revoked the day before, then channel = mail.", { todo: true });
test("3.1-T8: Given a biweekly loan, when analyzed, then the trial balance has 26 rows and the per-period escrow amount \u00d7 26 = annual disbursements \u00b1 $0.26.", { todo: true });
test("3.1-T9: Given the print vendor rejects the file, when retried 3\u00d7 and still failing 2 days before due, then an in-house mail fallback is used and an escalation sev-3 is logged.", { todo: true });
