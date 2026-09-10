import { test } from "node:test";
import assert from "node:assert/strict";
import { Machine } from "./machine.ts";
import { MemoryLedger, UnbalancedEntrySet } from "../ledger/ledger.ts";
import { plainDate as D } from "../calendar/date.ts";

type S = "staged" | "validated" | "exception" | "boarded";
const m = new Machine<S, { hardFailures: number }>({
  name: "test",
  initial: "staged",
  states: ["staged", "validated", "exception", "boarded"],
  terminal: ["boarded"],
  transitions: [
    { from: "staged", to: "validated", on: "validate", guard: (t) => (t.ctx.hardFailures === 0 ? undefined : `${t.ctx.hardFailures} open hard failures`) },
    { from: "staged", to: "exception", on: "validate", guard: (t) => (t.ctx.hardFailures > 0 ? undefined : "no failures") },
    { from: "exception", to: "validated", on: "waive", roles: ["officer"] },
    { from: "validated", to: "boarded", on: "board" },
  ],
});

test("machine routes by guard and enforces roles", () => {
  const agent = { kind: "agent" as const, id: "boarding" };
  const officer = { kind: "human" as const, id: "u1", role: "officer" };
  assert.deepEqual(m.attempt("staged", "validate", agent, { hardFailures: 0 }), { ok: true, from: "staged", to: "validated", on: "validate" });
  assert.deepEqual(m.attempt("staged", "validate", agent, { hardFailures: 2 }), { ok: true, from: "staged", to: "exception", on: "validate" });
  const denied = m.attempt("exception", "waive", agent, { hardFailures: 1 });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.code, "ROLE_DENIED");
  assert.equal(m.attempt("exception", "waive", officer, { hardFailures: 1 }).ok, true);
  const term = m.attempt("boarded", "board", agent, { hardFailures: 0 });
  assert.equal(term.ok, false); if (!term.ok) assert.equal(term.code, "TERMINAL");
  const none = m.attempt("staged", "board", agent, { hardFailures: 0 });
  assert.equal(none.ok, false); if (!none.ok) assert.equal(none.code, "NO_TRANSITION");
});

test("ledger refuses unbalanced sets and reverses instead of editing", () => {
  const l = new MemoryLedger();
  const loan = (account: "principal" | "interest_due" | "suspense_unapplied") => ({ scope: "loan" as const, loanId: "L1", account });
  const cash = { scope: "custodial" as const, custodialAccountId: "C1", account: "clearing_cash" as const };
  assert.throws(() => l.post({ effectiveDate: D("2026-10-01"), description: "bad", lines: [
    { account: cash, amountCents: 100n, ruleRef: "t" }, { account: loan("principal"), amountCents: -99n, ruleRef: "t" }] }), UnbalancedEntrySet);
  const set = l.post({ effectiveDate: D("2026-10-01"), description: "payment", lines: [
    { account: cash, amountCents: 161603n, ruleRef: "2.1:receipt" },
    { account: loan("interest_due"), amountCents: -130493n, ruleRef: "F-1-09:order_1999plus:interest" },
    { account: loan("principal"), amountCents: -31110n, ruleRef: "F-1-09:order_1999plus:principal" },
  ] });
  assert.equal(l.balance(cash), 161603n);
  assert.equal(l.balance(loan("principal")), -31110n);
  const rev = l.reverse(set.id, D("2026-10-05"), "NSF return");
  assert.equal(rev.reversesSetId, set.id);
  assert.equal(l.balance(cash), 0n);
  assert.equal(l.balance(loan("principal")), 0n);
  assert.equal(l.balance(cash, D("2026-10-03")), 161603n); // as-of balances see only what was effective by then
  assert.equal(l.sets().length, 2);
});
