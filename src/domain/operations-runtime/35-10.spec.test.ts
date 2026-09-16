// 35.10 The refinance close of the loop: the prior loan's payoff quote, settlement and ledger zeroing, lien release, escrow disposition and retirement — whether Supermortgage services it or a partner does — the partner's notification and the new loan linked, replacing the status flip
// spec/sections/35-operations-runtime/35-10-the-refinance-close-of-the-loop.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id here runs against Postgres (the closeout's tables, 16.x/24.4's rows and the timers are read from the record —
// 35.1's seam; REQUIRE_DB=1 in CI); the file has its own database (src/infra/db/test-db.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { CommandRefused } from "../../app/commands.ts";
import { TOOLS_35_10 } from "../../app/tools/section35-10.ts";
import { closeoutBoardRun, PAYOFF_RELEASE } from "../../runtime/refinance-closeout.ts";
import { seedDemoCloseouts } from "./closeout-35-10/demo.ts";
import { renderRefinanceBoard, type BoardRow } from "./closeout-35-10/board.ts";
import { boardCounts, receiptFor } from "./closeout-35-10/repo.ts";
import type { ReceiptCounts } from "./closeout-35-10/types.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "t-" + randomUUID();
const NOW = "2026-09-15T14:00:00.000Z";
const clock = new FixedClock(NOW);
const OPS_ANALYST: Actor = { kind: "human", id: "ops-1", role: "ops_analyst" };
const OFFICER: Actor = { kind: "human", id: "officer-1", role: "officer" };

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
const count = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const partyId = async (name: string): Promise<string> => (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', $1, $2) RETURNING id::text AS id`, [name, String(100_000_000 + Math.floor(Math.random() * 899_999_999))]))[0]!.id;
/** Every non-test TypeScript source under src/ (the contract greps of T8 and T11). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...sourceFiles(p)); else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p); }
  return out;
}
const SRC = fileURLToPath(new URL("../../", import.meta.url));

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { if (!skip) await close(); });

test("35.10-T1: Given worked example A's prior loan on Postgres (UPB $559,455.71, 6.125%, LPI 2027-01-01, escrow $2,750.00) and its refinance application with `prior_loan_id`, when `closing.scheduled` lands with disbursement 2027-01-29 and only sweeps run, then `refinance_closeouts` reads `mode = serviced_same_servicer`, `step = quoted`, 16.1's `payoff_quotes` row carries per diem $93.88, interest $2,628.68, total $562,084.39 good through 2027-01-29, `payoff_requests.requester_type = refinancing_lender`, 24.4's `payoff_demands` row has `same_servicer = true`, `servicing_loan_id` = the prior loan and the same total, the statement document exists with its printed token, and no tool input in the journal carries `upb_cents`, `rate_pct` or `lpi_due` (they were derived).", { todo: true });
test("35.10-T2: Given T1 and `loan.funded` + `funding.disbursement.confirmed` with a settlement statement whose payoff line is $562,084.39, when the next sweep runs, then one balanced transfer set (`rule_ref 35.10:r4:transfer`) and one 2.1 receipt set exist, 16.2's `payoff_funds` reads `method = internal_transfer`, `status = cleared`, `variance_cents = 0`, `payoff_settlements` reads `paid_in_full` with interest $2,628.68, principal $559,455.71, PTR interest $2,521.38, servicing fee $107.30, the CRS 001 instruction is $561,977.09, `loan.paid_in_full{payoff_date: 2027-01-29}` is on the prior loan's log exactly once, every prior-loan account but `escrow` is zero, `loans.status = paid_off`, `prior_loan_retirements` has one row with `retired_on = 2027-01-29`, and a second sweep folding the same events writes no further set, row or event.", { todo: true });
test("35.10-T3: Given T2 with a `consents{kind=escrow_credit_to_new_loan}` row captured 2027-01-22, then `escrow_treatment = credit_to_new_loan`, `escrow.credit_to_new_loan.posted{amount_cents: 275000}` is in the settlement transaction, the prior `escrow` account is zero, the new loan's opening escrow set carries $2,750.00 from the credit and $687.50 from cash to close against a CD initial deposit of $3,437.50, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` and `SM_REFI_ESCROW_CREDIT_0` are `satisfied`, and no `disbursement.issued{payoff_refund}` exists.", { todo: true });
test("35.10-T4: Given T2 with no such consent, then `escrow_treatment = refund`, no credit event exists, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD.due_at` = 2027-03-01, `disbursement.issued{kind: payoff_refund, amount_cents: 275000}` is issued after the 5-BD hold and before that date, the short-year statement is due 2027-03-30, the new loan's initial deposit stays $3,437.50, and the pass never proposed netting (`NO_NETTING` in the journal).", { todo: true });
test("35.10-T5: Given T2, then 16.3's `release_tasks` row exists for the prior loan with `instrument_type = deed_of_release_and_reconveyance`, `signatory_path = mers_signing_officer`, `STATE_LIEN_RELEASE_DEADLINE.due_at = 2027-02-28`, `SM_RELEASE_PREPARE_5BD.due_at = 2027-02-05`, the closeout is `waiting_human{signing_officer}` with `clocked = false` (no `SM_REFI_CLOSEOUT_STALLED_2BD` armed for that entry), and after the FAKE signing officer executes and the FAKE recorder records, `lien_release.recorded` moves the closeout on and 16.3's `NTC_LIEN_RELEASE_RECORDED` was sent by 16.3's tool, not by this process.", { todo: true });
test("35.10-T6: Given worked example B's demo loan 1 imported `monitored` and its refinance application, when `closing.scheduled` lands with disbursement 2026-10-30, then `mode = monitored_partner`, 24.4's demand went to the partner as external servicer (`same_servicer = false`, `servicing_loan_id` = the monitored loan, `existing_servicer_party_id` = Northlight), the parsed statement carries principal $440,962.93 (October interest $2,666.59, principal $403.20 from $441,366.13), per diem $87.59, interest $2,540.11, total $443,503.04 good through 2026-10-30, `escrow_treatment = partner_obligation`, and no `payoff_requests`, `payoff_quotes` or ledger row exists for the loan.", { todo: true });
test("35.10-T7: Given T6 and `funding.date.resynced` to 2026-11-02, then 24.4's planning figure is $443,765.81, `SM_PAYOFF_GOOD_THROUGH_GATE` reads closed, `closeout.quote` re-ran, the refreshed statement good through 2026-11-02 totals $443,765.81, the gate reads open, and the closeout journal shows two `command_run{24.4 requestPayoff}` entries with the second citing the resync event.", { todo: true });
test("35.10-T8: Given T7 and `loan.funded` on 2026-11-02 with a settlement statement whose payoff line is $443,765.81 to Northlight's account of record with a wire reference, when the next sweep runs, then `payoff_demands.status = paid` with `payoff_posted_on = 2026-11-02`, `refinance.prior_loan.retired{mode: monitored_partner, remitted_to: partner_wire, payoff_total_cents: 44376581, evidence_document_id}` and `partner_book.loan.paid_off` (33.3's payload, `prior_status: monitored`) are on the prior loan's log once each, `loans.status = paid_off` with `retired_reason = refinance_partner`, no ledger line, `payoff_*` or `release_tasks` row exists for it, readiness rows stop (33.3-T6 passes unchanged), and `src/runtime/borrower/flows/16-readiness.ts` contains no `UPDATE loans` (contract grep).", { todo: true });
test("35.10-T9: Given T8, then one `integration_messages` row exists for adapter `partner-book.notify` with idempotency key `retirement:<prior_loan_id>` whose payload names NL-100001, 2026-11-02, 44376581 and the wire reference and contains no new-loan number, rate or amount, `partner_retirement_notifications{kind: notified}` exists, `SM_REFI_PARTNER_CONFIRM_21.due_at = 2026-11-23`; given a 33.1 tape of 2026-11-09 carrying NL-100001 as paid, then `partner_book.retirement.confirmed{source: tape}` satisfies it; given instead a tape of 2026-11-30 still carrying it active, then `disputed` is written, the timer is `breached`, an `ops_analyst` escalation names the loan and the tape status, and `book.resolve{paid_off}` writes `resolved{source: ops_resolve}`.", { todo: true });
test("35.10-T10: Given T1 and `rescission.exercised` before funding, then the closeout is `unwound`, the quote is superseded, `payoff_demands.status = cancelled`, every closeout timer is `cancelled`, no ledger set touched the prior loan and it still reads `active`; given instead T2 and an agent-actor call to reverse the settlement, then it is refused `ROLE_DENIED` and nothing is written, while an `officer`'s reversal inside the finality window emits `payoff.reversed`, reopens the loan to `active`, clears `refinanced_by_loan_id`, appends a superseding `prior_loan_retirements` row and returns the closeout to `settling`.", { todo: true });
test("35.10-T11: Given a closeout at `settling` with no `loan.paid_in_full` on the prior loan, when `closeout.retire` is called by any actor, then it is refused `NO_SETTLEMENT` and no row or event is written; given a hosted call to any `closeout.*` tool carrying `upb_cents`, `total_cents` or `buckets`, then it is refused `NO_CLIENT_STATE`; and a contract test finds no `UPDATE loans SET status` in `src/` outside `src/infra/db/loans.ts` (the 35.1 projector).", { skip }, async () => {
  // a closeout at `settling` (the demo book's serviced row: no loan.paid_in_full, no settlement, no funds) — the retire step is refused NO_SETTLEMENT by the bus's guardrail before the handler runs, so the transaction never opens a write
  const partner = await partyId("Lender 35.10-T11");
  const demo = await seedDemoCloseouts(db, partner, NOW);
  const settling = demo.find((d) => d.mode === "serviced_same_servicer" && d.step === "settling")!;
  assert.equal(await count(db, `FROM loan_events WHERE loan_id = $1 AND type = 'loan.paid_in_full'`, [settling.prior_loan_id]), 0);
  const snapshot = async () => ({
    events: await count(db, `FROM loan_events`), steps: await count(db, `FROM refinance_closeout_steps`), retirements: await count(db, `FROM prior_loan_retirements`), timers: await count(db, `FROM timers`),
    decisions: await count(db, `FROM agent_decisions`), entities: await count(db, `FROM entity_records`), ledger: await count(db, `FROM ledger_entry_sets`),
    row: (await db.query<{ step: string; status: string; updated_at: string; retirement_id: string | null }>(`SELECT step, status, updated_at::text AS updated_at, retirement_id FROM refinance_closeouts WHERE application_id = $1`, [settling.application_id]))[0]!,
    loan: (await db.query<{ status: string }>(`SELECT status::text AS status FROM loans WHERE id = $1`, [settling.prior_loan_id]))[0]!.status,
  });
  const before = await snapshot();
  assert.equal(before.row.step, "settling"); assert.equal(before.loan, "active");
  for (const actor of [PAYOFF_RELEASE, OFFICER, OPS_ANALYST]) {
    await assert.rejects(runtime.execute({ process: "35.10", name: "closeout.retire", loanId: settling.prior_loan_id, applicationId: settling.application_id, actor, input: { application_id: settling.application_id } }),
      (e: unknown) => e instanceof CommandRefused && e.code === "NO_SETTLEMENT", `${actor.kind}:${actor.id} is refused NO_SETTLEMENT`);
    assert.deepEqual(await snapshot(), before, `${actor.kind}:${actor.id}: no row or event is written`);
  }
  // a hosted call to any closeout.* tool carrying a figure or a record fact is refused NO_CLIENT_STATE (35.10 rule 3): the pass derives them
  const closeoutTools = TOOLS_35_10.filter((t) => t.name.startsWith("closeout."));
  assert.equal(closeoutTools.length, 12);
  for (const t of closeoutTools) for (const key of ["upb_cents", "total_cents", "buckets"]) {
    const actor = t.humanOnly ? OPS_ANALYST : PAYOFF_RELEASE;
    const r = await call("POST", `/v1/applications/${settling.application_id}/tools/35.10/${t.name}`, { actor, input: { [key]: key === "buckets" ? { principal_cents: "1" } : "1" } });
    assert.equal(r.status, 409, `${t.name}{${key}}: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "NO_CLIENT_STATE", `${t.name}{${key}}`);
  }
  assert.deepEqual(await snapshot(), before, "the refused hosted calls wrote nothing");
  // contract: no `UPDATE loans SET status` in src/ outside the 35.1 projector (src/infra/db/loans.ts) — the status flip 33.3 used to run is gone; the projector owns loans.status
  const offenders = sourceFiles(SRC).filter((f) => !f.endsWith("/infra/db/loans.ts") && /UPDATE\s+loans\s+SET\s+status/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "UPDATE loans SET status appears only in src/infra/db/loans.ts");
  assert.match(readFileSync(join(SRC, "infra/db/loans.ts"), "utf8"), /UPDATE loans SET status = 'paid_off'/, "the projector flips loans.status");
});
test("35.10-T12: Given a settlement statement payoff line of $562,024.39 against 16.2's exact $562,084.39 (short $60.00, beyond the $50 tolerance), then 16.2 opens its short-payoff path, the closeout is `held{money_mismatch}` and `waiting_human{officer}`, `SM_REFI_PRIOR_SETTLE_1BD` stays `armed` and breaches to the `officer` after one servicer business day, the agent's journal shows `command_refused{16.2 disposeVariance, ROLE_DENIED}`, and an `officer`'s `disposeVariance` lets the next sweep retire the loan.", { todo: true });
test("35.10-T13: Given two closeouts waiting on the FAKE partner's statement with the port `unavailable` for three servicer business days, then each has one `SM_REFI_CLOSEOUT_STALLED_2BD` breach, one `ops_analyst` escalation naming `application_id`, `prior_loan_id`, `step = awaiting_schedule → quote` and `waiting_on = payoff_demand`, and the journal's `command_failed` entries count three before `held{attempts}`.", { todo: true });
test("35.10-T14: Given the lifecycle journey on the hosted runtime through `loan.funded` on the refinance application with no test code calling 16.1, 16.2, 16.3 or 3.5, when only `POST /v1/sweep` runs twice, then the prior loan reads `paid_off` with a `payoff_settlements` row, a `prior_loan_retirements` row, `loans.refinanced_by_loan_id` = the new loan and `applications.loan_id` = the same row, the new loan is `active` with `origination_application_id` = the application and `loan_terms.pi_cents` = $3,219.83, and the journey fixture's `payoff()` phase asserts those rows instead of executing tools.", { todo: true });
test("35.10-T15: Given the demo book with closeouts in every mode and step, when the daily pass runs at 06:45 ET, then one `refinance_closeout_daily_receipts` row exists for the day with counts equal to a direct query of `refinance_closeouts` (open, by mode, by step, retired today, releases open, partners unconfirmed), `refinance.closeout.daily.run_completed` satisfies and re-arms `SM_REFI_CLOSEOUT_BOARD_DAILY` on the global subject, and 35.8's Refinance board renders the receipt.", { skip }, async () => {
  const partner = await partyId("Lender 35.10-T15");
  const demo = await seedDemoCloseouts(db, partner, "2026-09-16T04:00:00.000Z");
  assert.equal(demo.length, 18, "every mode × every step after `opened`");
  assert.deepEqual(await seedDemoCloseouts(db, partner, "2026-09-16T04:00:00.000Z"), demo, "the seed is idempotent");
  const timers = async () => db.query<{ status: string; subject_kind: string; subject_id: string; anchor_date: string; due_date: string | null }>(`SELECT status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date FROM timers WHERE code = 'SM_REFI_CLOSEOUT_BOARD_DAILY' ORDER BY armed_at`);
  assert.equal((await timers()).length, 0);
  // 06:44 ET (10:44Z in September): the sweep's board pass does not run yet
  const early = await runtime.sweep("2026-09-16T10:44:00.000Z", { verify: false });
  assert.equal(early.refinance_board?.ran, false, JSON.stringify(early.refinance_board));
  assert.equal(await receiptFor(db, D("2026-09-16")), null);
  // 06:45 ET: the daily pass produces the day's receipt once — a second sweep the same day writes nothing more
  const daily = await runtime.sweep("2026-09-16T10:45:00.000Z", { verify: false });
  assert.equal(daily.refinance_board?.ran, true, JSON.stringify(daily.refinance_board));
  assert.equal(daily.refinance_board?.as_of_date, "2026-09-16");
  const again = await runtime.sweep("2026-09-16T12:00:00.000Z", { verify: false });
  assert.equal(again.refinance_board?.ran, false); assert.equal(again.refinance_board?.reason, "already ran today");
  assert.equal(await count(db, `FROM refinance_closeout_daily_receipts WHERE as_of_date = '2026-09-16'`), 1);
  const receipt = (await receiptFor(db, D("2026-09-16")))!;
  // the receipt's counts equal a direct query of refinance_closeouts (open, by mode, by step, retired today, releases open, partners unconfirmed)
  const direct: ReceiptCounts = await boardCounts(db, D("2026-09-16"));
  const counts = (c: ReceiptCounts): ReceiptCounts => ({ open: c.open, by_mode: c.by_mode, by_step: c.by_step, waiting_human: c.waiting_human, waiting_vendor: c.waiting_vendor, waiting_partner: c.waiting_partner, held: c.held, retired_today: c.retired_today, completed_today: c.completed_today, unwound_today: c.unwound_today, releases_open: c.releases_open, partner_unconfirmed: c.partner_unconfirmed, oldest_open_step: c.oldest_open_step, oldest_open_days: c.oldest_open_days });
  assert.deepEqual(counts(receipt), counts(direct));
  const openRows = await db.query<{ mode: string; step: string }>(`SELECT mode, step FROM refinance_closeouts WHERE status NOT IN ('completed', 'unwound', 'cancelled')`);
  assert.equal(receipt.open, openRows.length);
  assert.equal(receipt.by_mode["serviced_same_servicer"], openRows.filter((r) => r.mode === "serviced_same_servicer").length);
  assert.equal(receipt.by_mode["monitored_partner"], openRows.filter((r) => r.mode === "monitored_partner").length);
  for (const step of new Set(openRows.map((r) => r.step))) assert.equal(receipt.by_step[step], openRows.filter((r) => r.step === step).length, step);
  assert.equal(receipt.releases_open, openRows.filter((r) => r.mode === "serviced_same_servicer" && r.step === "released_or_confirmed").length);
  assert.equal(receipt.partner_unconfirmed, openRows.filter((r) => r.mode === "monitored_partner" && r.step === "released_or_confirmed").length);
  assert.equal(receipt.retired_today, await count(db, `FROM prior_loan_retirements WHERE retired_on = '2026-09-16'`));
  assert.ok(receipt.open >= 12, `the demo book's open closeouts are counted (${receipt.open})`);
  // the receipt's report document is on the record; `refinance.closeout.daily.run_completed` is a global event and arms SM_REFI_CLOSEOUT_BOARD_DAILY on the global subject
  assert.equal(receipt.report_document_id, "doc-refinance-board-2026-09-16");
  assert.equal(await count(db, `FROM entity_records WHERE kind = 'documents' AND id = $1`, [receipt.report_document_id]), 1);
  const runs = await db.query<{ payload: Record<string, unknown>; loan_id: string | null }>(`SELECT payload, loan_id::text AS loan_id FROM loan_events WHERE type = 'refinance.closeout.daily.run_completed' ORDER BY sequence`);
  assert.equal(runs.length, 1); assert.equal(runs[0]!.payload["as_of_date"], "2026-09-16"); assert.equal(runs[0]!.payload["receipt_id"], receipt.id); assert.equal(runs[0]!.loan_id, null);
  let t = await timers();
  assert.equal(t.length, 1); assert.equal(t[0]!.status, "armed"); assert.equal(t[0]!.subject_kind, "global"); assert.equal(t[0]!.anchor_date, "2026-09-16"); assert.equal(t[0]!.due_date, "2026-09-17");
  // the next day's pass satisfies it and re-arms it on the global subject
  const next = await closeoutBoardRun(runtime, "2026-09-17T10:45:00.000Z");
  assert.equal(next.ran, true); assert.equal(next.as_of_date, "2026-09-17");
  t = await timers();
  assert.deepEqual(t.map((x) => [x.status, x.subject_kind, x.anchor_date, x.due_date]), [["satisfied", "global", "2026-09-16", "2026-09-17"], ["armed", "global", "2026-09-17", "2026-09-18"]]);
  assert.equal(await count(db, `FROM refinance_closeout_daily_receipts`), 2);
  // 35.8's Refinance board renders the receipt (closeout-35-10/board.ts is the renderer the work screen calls): the counts and one line per open closeout
  const rows = (await db.query<Record<string, unknown>>(`SELECT application_id::text AS application_id, prior_loan_id::text AS prior_loan_id, mode, step, status, waiting_on, opened_at::text AS opened_at, good_through::text AS good_through, disbursement_date::text AS disbursement_date FROM refinance_closeouts WHERE status NOT IN ('completed', 'unwound', 'cancelled') ORDER BY opened_at, application_id`)) as unknown as BoardRow[];
  const board = renderRefinanceBoard(receipt.as_of_date, receipt, rows);
  assert.match(board, /^REFINANCE BOARD — 2026-09-16\n/);
  assert.match(board, new RegExp(`^open ${receipt.open} \\| by mode monitored_partner=${receipt.by_mode["monitored_partner"]} serviced_same_servicer=${receipt.by_mode["serviced_same_servicer"]} \\| by step `, "m"));
  assert.match(board, new RegExp(`^releases open ${receipt.releases_open} \\| partners unconfirmed ${receipt.partner_unconfirmed} \\| oldest open `, "m"));
  for (const r of rows) assert.ok(board.includes(`${r.application_id.slice(0, 8)} | ${r.prior_loan_id.slice(0, 8)} | ${r.mode} | ${r.step} | ${r.status}`), `${r.mode}/${r.step} is on the board`);
  const doc = (await db.query<{ data: Record<string, unknown> }>(`SELECT data FROM entity_records WHERE kind = 'documents' AND id = $1 ORDER BY version DESC LIMIT 1`, [receipt.report_document_id]))[0]!.data;
  assert.equal(doc["kind"], "refinance_closeout_daily_receipt");
});
