/**
 * §2.1 process-owned tools — additional bus tools for 2.1 defined with `defineTools("2.1", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section02.ts). Every tool string must be one
 * spec/registry/agents.json names for 2.1; src/app/tools.test.ts refuses the rest (and refuses a duplicate
 * `<process> <name>`), so every 2.1 tool string already lives in ./section02.ts and this file extends one of them:
 * `postReceivedPayment` is `payments.read/write{op=post}` — the 2.1 posting run for one received payment through the
 * Allocation Engine (src/domain/cashiering/allocation.ts) and the 2.2 partial-payment rules (partials.ts / ops.ts):
 *
 *   applied            the rule-8 entry sets (receipt · allocation · cash split) posted through the unit of work's ledger,
 *                      the payment row `posted` with its allocations, `payment.applied` per installment and `payment.posted`
 *                      (the satisfier 2.7's reminder cancellation and 32.8's Thread read).
 *   partial (n = 0)    2.2 rule 3: the four-condition test (`decidePartial`) — a portal submission carries the borrower's own
 *                      instruction to apply it (`commitment=portal_note`), so the partial is held (`suspense_items.open`,
 *                      `suspense.item.created{partial_payment}` arms FNMA_C1102_PARTIAL_BALANCE_30), the receipt is parked in
 *                      `suspense_unapplied`, the payment row is `held` and `balance_needed_cents` names the remainder.
 *
 * Nothing here decides a money figure: the engine's plan is the allocation; the state the caller passes is the loan's
 * cash state as the runtime builds it from `loan_terms`, `loans`, the ledger and the payment rows (src/runtime/servicing.ts).
 * docs/ux/BACKEND-DELTAS.md (32.8) records this delta.
 */
import { cents, str, num, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { LateChargeOps } from "../../domain/cashiering/ops-2-7.ts";
import { PgLedgerRepository } from "../../infra/db/ledger.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { graceEndFor } from "../../domain/cashiering/latecharges.ts";
import type { AccountRef, LoanAccount, CustodialAccount } from "../../kernel/ledger/ledger.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { allocate } from "../../domain/cashiering/allocation.ts";
import { decidePartial, type PartialContext } from "../../domain/cashiering/partials.ts";
import { CashieringOps } from "../../domain/cashiering/ops.ts";
import type { Designation, LoanCashState } from "../../domain/cashiering/types.ts";

const s = (c: Cents): string => c.toString();

/** `payments.read/write{op=post, id, loan_id, state, custodial:{clearing, pi, ti}, days_delinquent?}` — see the header. */
export function postReceivedPayment(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const id = str(i, "id") || str(i, "payment_id"); const rec = rt.store.get("payments", id); if (!rec) throw new RangeError(`no payment ${id} on this loan`);
  const pay = rec.data; const status = String(pay.status ?? "");
  if (status !== "received" && status !== "identified") throw new RangeError(`payment ${id} is ${status || "unknown"}, not received/identified`);
  const state = i.state as LoanCashState | undefined; if (!state) throw new RangeError("post needs the loan's cash state");
  const custodial = (i.custodial ?? {}) as { clearing?: string; pi?: string; ti?: string };
  if (!custodial.clearing || !custodial.pi || !custodial.ti) throw new RangeError("post needs custodial {clearing, pi, ti} account ids");
  const loanId = String(pay.loan_id ?? ctx.loanId); const amount = cents(pay.amount_cents); const receivedOn = D(String(pay.received_on)); const creditedAsOf = D(String(pay.credited_as_of ?? pay.received_on));
  const designation = String(pay.designation ?? "contractual") as Designation;
  const plan = allocate(state, { payment_id: id, amount_cents: amount, received_on: receivedOn, credited_as_of: creditedAsOf, designation, ...(pay.curtailment_cents !== undefined ? { curtailment_cents: cents(pay.curtailment_cents) } : {}) });
  const loanAcct = (account: LoanAccount): AccountRef => ({ scope: "loan", loanId, account }); const cust = (custodialAccountId: string, account: CustodialAccount): AccountRef => ({ scope: "custodial", custodialAccountId, account });
  const post = (description: string, lines: { account: AccountRef; amountCents: Cents; ruleRef: string }[]) => ctx.ledger.post({ effectiveDate: creditedAsOf, description, lines }, ctx.now);
  const receipt = post(`receipt ${id}`, [{ account: cust(custodial.clearing, "clearing_cash"), amountCents: amount, ruleRef: "2.1:r8:receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -amount, ruleRef: "2.1:r8:receipt" }]);
  // posted when an installment applied — or when the item is a designated curtailment on a current loan (2.4 rule 2 / F-1-09: applied the
  // same day with no installment, allocation outcome `curtailment`, exactly as CashieringService.post does); only a true partial (n = 0 and
  // nothing designated) takes the 2.2 hold below. A set carries no zero-amount line (the ledger refuses one), so an all-curtailment
  // allocation posts principal and its cash split alone.
  if (plan.installments.length || plan.curtailment_cents > 0n) {
    const nonzero = (lines: { account: AccountRef; amountCents: Cents; ruleRef: string }[]) => lines.filter((l) => l.amountCents !== 0n);
    const interest = plan.installments.reduce((a, x) => a + x.interest_cents, 0n), principal = plan.installments.reduce((a, x) => a + x.principal_cents, 0n), escrow = plan.installments.reduce((a, x) => a + x.escrow_cents, 0n);
    const applied = interest + principal + escrow + plan.late_charge_cents + plan.curtailment_cents;
    const alloc = post(`allocation ${id}`, nonzero([{ account: loanAcct("suspense_unapplied"), amountCents: applied, ruleRef: "2.1:r8:allocation" }, { account: loanAcct("interest_due"), amountCents: -interest, ruleRef: "2.1:r8:allocation:interest" }, { account: loanAcct("principal"), amountCents: -(principal + plan.curtailment_cents), ruleRef: "2.1:r8:allocation:principal" }, { account: loanAcct("escrow"), amountCents: -escrow, ruleRef: "2.1:r8:allocation:escrow" }, ...(plan.late_charge_cents > 0n ? [{ account: loanAcct("late_charges"), amountCents: -plan.late_charge_cents, ruleRef: "2.1:r8:allocation:late_charge" }] : [])]));
    const split = post(`cash split ${id}`, nonzero([{ account: cust(custodial.pi, "custodial_pi_cash"), amountCents: interest + principal + plan.curtailment_cents + plan.late_charge_cents, ruleRef: "2.1:r8:cash_split:pi" }, { account: cust(custodial.ti, "custodial_ti_cash"), amountCents: escrow, ruleRef: "2.1:r8:cash_split:escrow" }, { account: cust(custodial.clearing, "clearing_cash"), amountCents: -(applied), ruleRef: "2.1:r8:cash_split" }]));
    const installments = plan.installments.map((x) => x.due_date);
    const upbAfter = plan.installments.length ? plan.installments[plan.installments.length - 1]!.upb_after_cents : plan.next.upb_cents;
    // 35.1 worked example A / rule 3: the version carries the allocation rows 2.1 stamped (bucket, cents, rule_ref, the balanced set) and the UPB after, so the `payment_allocations` projector copies and never computes
    const firstDue = plan.installments[0]?.due_date ?? null;
    const allocations = ([["interest", interest, "2.1:r8:allocation:interest"], ["principal", principal, "2.1:r8:allocation:principal"], ["escrow", escrow, "2.1:r8:allocation:escrow"], ["late_charge", plan.late_charge_cents, "2.1:r8:allocation:late_charge"], ["curtailment", plan.curtailment_cents, "2.1:r8:allocation:principal"]] as const)
      .filter(([, c]) => c !== 0n).map(([bucket, amount_cents, rule_ref], k) => ({ sequence: k + 1, bucket, amount_cents, rule_ref, ledger_entry_set_id: alloc.id, installment_due_date: firstDue, credited_as_of: creditedAsOf }));
    rt.store.put("payments", id, { ...pay, status: "posted", allocation_outcome: plan.outcome, installments, credited_as_of: creditedAsOf, allocation: { interest_cents: s(interest), principal_cents: s(principal), escrow_cents: s(escrow), late_charge_cents: s(plan.late_charge_cents), curtailment_cents: s(plan.curtailment_cents), to_suspense_cents: s(plan.to_suspense_cents) }, allocations, upb_after_cents: upbAfter, ledger_entry_set_ids: [receipt.id, alloc.id, split.id], posted_at: ctx.now }, ctx.actor, ctx.now);
    for (const x of plan.installments) ctx.events.append({ type: "payment.applied", loanId, aggregate: { kind: "payment", id }, actor: ctx.actor, payload: { payment_id: id, installment_due_date: x.due_date, due_date: x.due_date, interest_cents: s(x.interest_cents), principal_cents: s(x.principal_cents), escrow_cents: s(x.escrow_cents), upb_after_cents: s(x.upb_after_cents), credited_as_of: creditedAsOf, kind: x.kind, full_periodic_payment: true, allocation_outcome: plan.outcome } });
    ctx.events.append({ type: "payment.posted", loanId, aggregate: { kind: "payment", id }, actor: ctx.actor, payload: { payment_id: id, loan_id: loanId, outcome: plan.outcome, amount_cents: s(amount), received_on: receivedOn, credited_as_of: creditedAsOf, channel: pay.channel ?? null, installments, interest_cents: s(interest), principal_cents: s(principal), escrow_cents: s(escrow), late_charge_cents: s(plan.late_charge_cents), curtailment_cents: s(plan.curtailment_cents), upb_after_cents: s(plan.installments.length ? plan.installments[plan.installments.length - 1]!.upb_after_cents : plan.next.upb_cents), rule_path: plan.rule_path.join(" → "), ledger_entry_set_ids: [receipt.id, alloc.id, split.id] } });
    return { payment_id: id, outcome: plan.outcome, installments, interest_cents: s(interest), principal_cents: s(principal), escrow_cents: s(escrow), to_suspense_cents: s(plan.to_suspense_cents), entry_set_ids: [receipt.id, alloc.id, split.id] };
  }
  // n = 0: the 2.2 partial path — the receipt stays parked in suspense_unapplied; the item opens under rule 3
  const oldest = state.installments.filter((x) => x.status === "due").sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  const P = oldest ? oldest.pi_cents + oldest.escrow_cents : 0n;
  const pctx: PartialContext = { state, days_delinquent: num(i, "days_delinquent") || 0, commitment: String(pay.channel ?? "") === "portal" || str(i, "commitment_kind") ? { kind: (str(i, "commitment_kind") || "portal_note") as "portal_note", stated_date: null } : null, received_on: receivedOn, amount_cents: amount, payment_id: id, rail: String(pay.channel ?? "").startsWith("ach") || String(pay.channel ?? "") === "portal" ? "ach_credit" : "check" };
  const decision = decidePartial(pctx);
  const item = new CashieringOps({ events: ctx.events, clock: { now: () => ctx.now }, actor: ctx.actor }).openPartial(pctx, decision);
  const remaining = P > amount ? P - amount : 0n;
  rt.store.put("suspense_items", item.id, { id: item.id, loan_id: loanId, payment_id: id, amount_cents: s(item.amount_cents), received_on: item.received_on, reason_code: item.reason_code, status: item.status, partial_commitment_due_on: item.partial_commitment_due_on, rule_path: item.rule_path, decision_cite: item.decision_cite ?? null, return_rail: item.return_rail ?? null, installment_due_date: oldest?.due_date ?? null, periodic_payment_cents: s(P), balance_needed_cents: s(remaining), receipt_entry_set_id: receipt.id }, ctx.actor, ctx.now);
  rt.store.put("payments", id, { ...pay, status: "held", allocation_outcome: plan.outcome, suspense_item_id: item.id, balance_needed_cents: s(remaining), ledger_entry_set_ids: [receipt.id] }, ctx.actor, ctx.now);
  return { payment_id: id, outcome: plan.outcome, installments: [] as PlainDate[], suspense_item_id: item.id, suspense_status: item.status, balance_needed_cents: s(remaining), partial_commitment_due_on: item.partial_commitment_due_on, entry_set_ids: [receipt.id] };
}

export const TOOLS_2_1: readonly ToolDef[] = [];

/**
 * `payments.read/write{op=reverse, id, loan_id, state, custodial, reason, return_code?, nsf_fee?, run_on?}` — 2.1 rule 9's
 * Reversal Engine for a posted payment on the bus (35.8 worked example B names it: "2.1 `payments.read/write{op: reverse}`
 * posts the mirror set"): the rule-8 entry sets the posting run wrote (receipt · allocation · cash split) come back out in
 * reverse order as mirror sets (`ctx.ledger.reverse`, the 2.3 return precedent in section2-3.ts handleReturn), the payment
 * row is `reversed` with the mirror ids, the installments it satisfied are due again, UPB and LPI are what they were before
 * the posting, and 2.7's re-evaluation runs in the same command: an installment now unpaid past its grace end is assessed
 * (LateChargeOps.assess — once-only, credited-funds and overlay rules inside; the P&I basis, half-up once). Nothing here
 * decides a figure: the mirror is the ledger's, the late charge is 2.7's, the state is the caller's derived cash state.
 */
export async function reverseReceivedPayment(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const id = str(i, "id") || str(i, "payment_id"); const rec = rt.store.get("payments", id); if (!rec) throw new RangeError(`no payment ${id} on this loan`);
  const pay = rec.data; const status = String(pay.status ?? "");
  if (status !== "posted") throw new RangeError(`payment ${id} is ${status || "unknown"}, not posted`);
  const state = i.state as LoanCashState | undefined; if (!state) throw new RangeError("reverse needs the loan's cash state");
  const reason = str(i, "reason") || "correction"; const code = str(i, "return_code") || null;
  if (code && !/^R\d{2}$/.test(code)) throw new RangeError("return_code must be a Nacha return reason code (R01 …)");
  const runOn = D(str(i, "run_on") || ctx.now.slice(0, 10)); const loanId = String(pay.loan_id ?? ctx.loanId);
  const sets = Array.isArray(pay.ledger_entry_set_ids) ? [...(pay.ledger_entry_set_ids as string[])].reverse() : [];
  const why = `${reason}${code ? ` ${code}` : ""} (${id})`;
  // the receipt and allocation sets carry loan lines and are hydrated with the loan; the cash split set (custodial lines only) is read by id from the record and mirrored line for line
  const db = rt.services["db"] as Queryable | undefined;
  const mirror: string[] = [];
  for (const setId of sets) {
    if (ctx.ledger.sets().some((x) => x.id === setId)) { mirror.push(ctx.ledger.reverse(setId, runOn, why, ctx.now).id); continue; }
    const orig = db ? await new PgLedgerRepository(db).setById(setId) : null; if (!orig) throw new RangeError(`no entry set ${setId}`);
    mirror.push(ctx.ledger.post({ effectiveDate: runOn, description: `REVERSAL of ${orig.description}: ${why}`, reversesSetId: setId, lines: orig.lines.map((l) => ({ account: l.account, amountCents: -l.amountCents, ruleRef: l.ruleRef, memo: `reversal: ${why}` })) }, ctx.now).id);
  }
  const alloc = (pay.allocation ?? {}) as Record<string, unknown>;
  const principalApplied = cents(alloc.principal_cents ?? 0) + cents(alloc.curtailment_cents ?? 0);
  const restoredUpb = state.upb_cents + principalApplied;
  const dueAgain = (Array.isArray(pay.installments) ? (pay.installments as string[]) : []).map((d) => D(d));
  const stillSatisfied = state.installments.filter((x) => x.status === "satisfied" && x.satisfied_by_payment_id !== id).map((x) => x.due_date).sort();
  const restoredLpi = stillSatisfied.at(-1) ?? (dueAgain.length ? addMonths(dueAgain[0]!, -1) : state.lpi_date);
  rt.store.put("payments", id, { ...pay, status: "reversed", reversal: { reason, return_code: code, reversed_at: ctx.now, reversed_on: runOn, entry_set_ids: mirror, nsf_fee: i.nsf_fee === true } }, ctx.actor, ctx.now);
  ctx.events.append({ type: "payment.reversed", loanId, aggregate: { kind: "payment", id }, actor: ctx.actor, payload: { payment_id: id, loan_id: loanId, reason, return_code: code, reversed_on: runOn, amount_cents: s(cents(pay.amount_cents)), mirror_entry_set_ids: mirror, reversed_entry_set_ids: sets, installments: dueAgain, restored_upb_cents: s(restoredUpb), restored_lpi_date: restoredLpi, nsf_fee_requested: reason === "returned_item" && i.nsf_fee === true, nsf_fee_assessed: false } });   // the reversal assesses no NSF fee itself: 2.7's fee op does, on its own rule, when the servicer asks
  // 2.1 rule 9 / 35.8 worked example B: 2.7's re-evaluation in the same command — the installments due again, assessed when their grace end has passed
  const after: LoanCashState = { ...state, upb_cents: restoredUpb, lpi_date: restoredLpi, installments: state.installments.map((x) => (x.satisfied_by_payment_id === id ? { due_date: x.due_date, pi_cents: x.pi_cents, escrow_cents: x.escrow_cents, status: "due" as const } : x)) };
  const lc = new LateChargeOps({ events: ctx.events, clock: { now: () => ctx.now }, actor: ctx.actor });
  const assessed: Record<string, unknown>[] = [];
  for (const due of dueAgain) {
    if (graceEndFor(after, due) >= runOn) continue;
    const r = lc.assess({ state: after, installment_due_date: due, run_on: runOn, unposted_receipts_on_or_before_grace: 0 });
    if (r.outcome === "assessed" || r.outcome === "accrued_suspended") { const fee = Object.fromEntries(Object.entries({ ...r.fee, loan_id: loanId }).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])); rt.store.put("fees", r.fee.id, fee, ctx.actor, ctx.now); assessed.push(fee); }
  }
  return { payment_id: id, status: "reversed", reason, return_code: code, mirror_entry_set_ids: mirror, restored_upb_cents: s(restoredUpb), restored_lpi_date: restoredLpi, installments_due_again: dueAgain, late_charges_assessed: assessed };
}
