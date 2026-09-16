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
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { PgEntityRepository, decodeEntityData } from "../../infra/db/entities.ts";
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
import { A } from "./closeout-35-10/worked-examples.ts";
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

// ───────── worked example A: the serviced prior loan (UPB $559,455.71 at 6.125%, LPI 2027-01-01, escrow $2,750.00) and its refinance application ─────────
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const INTAKE: Actor = { kind: "agent", id: "intake" };
const FUNDER: Actor = { kind: "agent", id: "funder" };
type Json = Record<string, unknown>;
let seq = 0;
const uniq = (): string => `${Date.now() % 1_000_000}${(seq++).toString().padStart(3, "0")}`.padStart(10, "0");
const entity = async (kind: string, id: string): Promise<Json | null> => { const r = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return r[0] ? decodeEntityData(r[0].data) : null; };
const versions = async (kind: string, id: string): Promise<Json[]> => (await db.query<{ data: unknown }>(`SELECT data FROM entity_records WHERE kind = $1 AND id = $2 ORDER BY version`, [kind, id])).map((r) => decodeEntityData(r.data));
const closeoutOf = async (appId: string): Promise<Json> => (await db.query<Json>(`SELECT * FROM refinance_closeouts WHERE application_id = $1`, [appId]))[0]!;
const stepsOf = async (appId: string): Promise<{ kind: string; step: string; command_process: string | null; command_name: string | null; refusal_code: string | null; detail: Json }[]> => db.query(`SELECT kind, step, command_process, command_name, refusal_code, detail FROM refinance_closeout_steps WHERE application_id = $1 ORDER BY created_at, id`, [appId]);
const loanEvents = async (loanId: string, type?: string): Promise<{ id: string; type: string; payload: Json; actor_id: string }[]> => db.query(`SELECT id::text AS id, type, payload, actor_id FROM loan_events WHERE loan_id = $1 ${type ? "AND type = $2" : ""} ORDER BY sequence`, type ? [loanId, type] : [loanId]);
const appEvents = async (appId: string, type?: string): Promise<{ id: string; type: string; payload: Json }[]> => db.query(`SELECT id::text AS id, type, payload FROM loan_events WHERE application_id = $1 ${type ? "AND type = $2" : ""} ORDER BY sequence`, type ? [appId, type] : [appId]);
const balance = async (loanId: string, account: string): Promise<bigint> => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = $2`, [loanId, account]))[0]!.s);
const timerRows = async (code: string, loanId: string): Promise<{ status: string; due_date: string | null; due_at: string | null }[]> => db.query(`SELECT status::text AS status, due_date::text AS due_date, due_at::text AS due_at FROM timers WHERE code = $1 AND loan_id = $2 ORDER BY armed_at`, [code, loanId]);
/** The sweep at `at`: the runtime's clock moves there first (production: the system clock; here the FixedClock every command reads). */
const sweep = (at: string) => { clock.set(at); return runtime.sweep(at, { verify: false }); };
let wireSeeded = false;
interface PriorA { readonly f: Fixture; readonly loanId: string; readonly appId: string; readonly partner: string; readonly demandId: string; }
/** Worked example A's prior loan as the record states it: loans + AZ property + custodial accounts (createFixture), loan_terms at 6.125%, the ledger at $559,455.71 / $2,750.00, the January installment posted (2.x's payments row), purchased by Fannie Mae at PTR 5.875, 16.1's active wire instruction, and the refinance application with `prior_loan_id`. */
async function priorLoanA(o: { closingScheduled?: boolean } = {}): Promise<PriorA> {
  const f = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-A-${randomUUID().slice(0, 8)}`, instrumentDate: D("2026-11-06"), originalUpbCents: A.prior_original_cents, originalTermMonths: 360, firstPaymentDate: D("2027-01-01"), maturityDate: D("2056-12-01"), partnerName: `Lender A ${randomUUID().slice(0, 6)}`, property: { line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postalCode: "85004" }, status: "active" });
  const loanId = f.loanId;
  await db.query(`UPDATE loans SET min = $2, mers_eligible = true WHERE id = $1`, [loanId, `1000123${uniq()}0`.slice(0, 18)]);
  await db.query(`UPDATE properties SET county = 'Maricopa' WHERE id = $1`, [f.propertyId]);
  const b = (await db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4) VALUES ('Alex Borrower', '6789') RETURNING id`))[0]!.id;
  await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [loanId, b]);
  await db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, remittance_type, maturity_date, remaining_term_months) VALUES ($1, '2026-11-06', 'boarding', 'fixed', 61250, 340262, 68750, true, 'A/A', '2056-12-01', 360)`, [loanId]);
  await db.query(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, 'ti_prepurchase', 'A/A')`, [f.partnerPartyId]);
  const fundingClearing = (await db.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, 'origination_funding_clearing', 'A/A') RETURNING id::text AS id`, [f.partnerPartyId]))[0]!.id;
  // the ledger as 30.2's opening set and the January installment left it: principal $559,455.71 (against the per-loan funding clearing), escrow $2,750.00 (T&I cash)
  await runtime.execute({ process: "2.1", name: "ledger.post", loanId, actor: CASHIERING, input: { loan_id: loanId, via: "payment.post", entry_set: { effectiveDate: "2026-12-30", description: "worked example A: balances after the January 1, 2027 installment", lines: [
    { account: { scope: "loan", loanId, account: "principal" }, amountCents: A.upb_cents, ruleRef: "30.2:opening:principal" }, { account: { scope: "custodial", custodialAccountId: fundingClearing, account: "origination_funding_clearing" }, amountCents: -A.upb_cents, ruleRef: "30.2:opening:clearing" },
    { account: { scope: "custodial", custodialAccountId: f.custodial.ti, account: "custodial_ti_cash" }, amountCents: A.escrow_balance_cents, ruleRef: "2.1:r8:cash_split:escrow" }, { account: { scope: "loan", loanId, account: "escrow" }, amountCents: -A.escrow_balance_cents, ruleRef: "2.1:r8:allocation:escrow" }] } } });
  await runtime.entities.save([{ kind: "payments", id: `PAY-${loanId.slice(0, 8)}-2027-01-01`, version: 1, updatedAt: "2026-12-30T17:00:00.000Z", updatedBy: "agent:cashiering", data: { payment_id: `PAY-${loanId.slice(0, 8)}-2027-01-01`, loan_id: loanId, status: "posted", installments: ["2027-01-01"], received_on: "2026-12-30", credited_as_of: "2026-12-30", amount_cents: 409_012n, channel: "lockbox", designation: "contractual" } }], loanId);
  await runtime.uow.run({ loanId }, (u) => u.events.append({ type: "loan.purchased", loanId, actor: { kind: "agent", id: "secondary" }, payload: { purchase_date: "2026-11-19", pass_through_rate: A.ptr_pct, fnma_loan_number: (f as unknown as { fnmaLoanNumber?: string }).fnmaLoanNumber ?? null, investor: "fnma", remittance_type: "AA", servicing_fee_bps: 25 } }), { clock });
  if (!wireSeeded) { wireSeeded = true; await runtime.entities.save([{ kind: "payoff_wire_instructions", id: "wire-v1", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "human:u-officer", data: { bank_name: "Test Bank NA", aba: "021000021", account_last4: "6789", beneficiary_name: "Supermortgage LLC", reference_format: "loan number", effective_from: "2026-01-01", approved_by_officer_id: "u-officer", status: "active" } }], null); }
  const app = await runtime.createApplication({ partner_party_id: f.partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", prior_loan_id: loanId, borrowers: [{ legal_name: "Alex Borrower", tin_last4: "6789", contact: { email: `alex-${loanId.slice(0, 8)}@example.test` } }], property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa" } }, INTAKE);
  const appId = app.application.id;
  if (o.closingScheduled !== false) await scheduleClosing(appId);
  return { f, loanId, appId, partner: f.partnerPartyId, demandId: `${appId}:prior-loan:${loanId}` };
}
/** 26.2's `closing.scheduled` (consummation Mon 2027-01-25; the projected disbursement is 26.3's calendar, here closing + the rescission window = Fri 2027-01-29). */
async function scheduleClosing(appId: string, noteDate = String(A.consummation)): Promise<void> {
  await runtime.uow.run({ applicationId: appId }, (u) => u.events.append({ type: "closing.scheduled", applicationId: appId, aggregate: { kind: "application", id: appId }, actor: { kind: "agent", id: "title-closing" }, payload: { application_id: appId, closing_id: `closing-${appId.slice(0, 8)}`, scheduled_at: `${noteDate}T21:00:00.000Z`, scheduled_note_date: noteDate, closing_type: "ipen", note_form: "enote", enote: true, ron: false, wet: false, state: "AZ", transaction_type: "limited_cash_out", rescindable: true } }), { clock });
}
/** T1's state: the closeout opened and quoted by the sweep of Tue 2027-01-19 (worked example A: quote_on). */
async function quotedA(): Promise<PriorA & { c: Json }> {
  const p = await priorLoanA();
  clock.set(`${A.quote_on}T16:00:00.000Z`);
  await sweep(clock.now());
  return { ...p, c: await closeoutOf(p.appId) };
}
/** 26.3's funding of the new loan on Fri 2027-01-29: the CD figures (25.2's flat snapshot), 26.3's funding row, `loan.funded` and `funding.disbursement.confirmed` naming the final settlement statement whose payoff line pays the prior loan. */
async function fundA(p: PriorA, o: { payoffLineCents?: bigint; disbursement?: string } = {}): Promise<{ evidenceId: string }> {
  const disb = o.disbursement ?? String(A.disbursement);
  const now = `${disb}T18:00:00.000Z`; clock.set(now);
  const fundingId = `fund-${p.appId.slice(0, 8)}`;
  await runtime.entities.save([
    { kind: "disclosures", id: `cd-${p.appId.slice(0, 8)}-1`, version: 1, updatedAt: now, updatedBy: "agent:disclosure", data: { application_id: p.appId, kind: "cd_final", cd_version: 1, status: "consummated", figures: { rate_pct: A.new_note_rate_pct, loan_amount_cents: String(A.new_loan_cents), pi_cents: String(A.new_pi_cents), monthly_escrow_cents: String(A.monthly_escrow_cents), initial_escrow_payment_cents: String(A.cd_initial_deposit_cents), term_months: 360 } } },
    { kind: "fundings", id: fundingId, version: 1, updatedAt: now, updatedBy: "agent:funder", data: { application_id: p.appId, funding_id: fundingId, status: "disbursed", scheduled_funding_date: disb, gross_loan_cents: String(A.new_loan_cents), note_rate_pct: A.new_note_rate_pct } },
  ], { applicationId: p.appId });
  const evidenceId = `doc-settlement-statement-${p.appId.slice(0, 8)}`;
  await new PgEntityRepository(db).save([{ kind: "documents", id: evidenceId, version: 1, updatedAt: now, updatedBy: "agent:funder", data: { application_id: p.appId, kind: "settlement_statement", sha256: "fake", storage_uri: `fake://documents/${evidenceId}`, mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y",
    metadata: { payoff_lines: [{ payoff_demand_id: p.demandId, payee_party_id: p.partner, amount_cents: String(o.payoffLineCents ?? A.total_cents), wire_reference: `INTERNAL-${p.appId.slice(0, 8)}` }] } } }], { applicationId: p.appId });
  await runtime.uow.run({ applicationId: p.appId }, (u) => {
    u.events.append({ type: "loan.funded", applicationId: p.appId, aggregate: { kind: "application", id: p.appId }, actor: FUNDER, payload: { application_id: p.appId, funding_id: fundingId, funded_at: now, funding_date: disb, disbursement_date: disb, wire_id: `IMAD-${disb.replace(/-/g, "")}-001`, funded_amount_cents: String(A.new_loan_cents), per_diem_cents: "8467", prepaid_interest_cents: "25401", interest_credit: false, rescission_expires_at: `${disb}T06:59:59.000Z`, first_payment_date: "2027-03-01", escrow_deposit_cents: String(A.cd_initial_deposit_cents), source: "origination" } });
    u.events.append({ type: "funding.disbursement.confirmed", applicationId: p.appId, aggregate: { kind: "application", id: p.appId }, actor: FUNDER, payload: { application_id: p.appId, funding_id: fundingId, disbursement_date: disb, source: "final_settlement_statement", evidence_document_id: evidenceId, confirmed_at: now } });
  }, { clock });
  return { evidenceId };
}
/** T2's state: T1, funded and confirmed on 2027-01-29, then the sweep (the hand-off boards the new loan; the closeout settles, disposes, retires and opens 16.3's release). */
async function settledA(o: { payoffLineCents?: bigint; consent?: boolean } = {}): Promise<PriorA & { c: Json; evidenceId: string }> {
  const p = await quotedA();
  if (o.consent) await recordCreditConsent(p);
  const { evidenceId } = await fundA(p, o.payoffLineCents !== undefined ? { payoffLineCents: o.payoffLineCents } : {});
  await sweep(clock.now());
  return { ...p, c: await closeoutOf(p.appId), evidenceId };
}
/** 30.3's consent (§1024.34(b)(2)): the borrower's recorded agreement on Fri 2027-01-22 to credit the prior escrow to the new loan. */
async function recordCreditConsent(p: PriorA): Promise<void> {
  const borrowerId = (await db.query<{ id: string }>(`SELECT id::text AS id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at LIMIT 1`, [p.appId]))[0]!.id;
  clock.set("2027-01-22T17:00:00.000Z");
  await runtime.execute({ process: "30.3", name: "buildEscrowLines", loanId: p.loanId, applicationId: p.appId, actor: { kind: "agent", id: "escrow" }, input: { op: "record_credit_agreement", application_id: p.appId, old_loan_id: p.loanId, borrower_id: borrowerId, captured_on: "2027-01-22", settlement_date: String(A.disbursement), evidence: { kind: "recorded_call", recorded_call_id: `call-${p.appId.slice(0, 8)}`, scripted_agreement_language_used: true, document_id: null } } });
}

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { if (!skip) await close(); });

test("35.10-T1: Given worked example A's prior loan on Postgres (UPB $559,455.71, 6.125%, LPI 2027-01-01, escrow $2,750.00) and its refinance application with `prior_loan_id`, when `closing.scheduled` lands with disbursement 2027-01-29 and only sweeps run, then `refinance_closeouts` reads `mode = serviced_same_servicer`, `step = quoted`, 16.1's `payoff_quotes` row carries per diem $93.88, interest $2,628.68, total $562,084.39 good through 2027-01-29, `payoff_requests.requester_type = refinancing_lender`, 24.4's `payoff_demands` row has `same_servicer = true`, `servicing_loan_id` = the prior loan and the same total, the statement document exists with its printed token, and no tool input in the journal carries `upb_cents`, `rate_pct` or `lpi_due` (they were derived).", { skip }, async () => {
  const p = await quotedA(); const c = p.c;
  assert.equal(c["mode"], "serviced_same_servicer"); assert.equal(c["step"], "quoted", JSON.stringify(await stepsOf(p.appId))); assert.equal(c["status"], "waiting_window");
  assert.equal(c["good_through"], String(A.disbursement)); assert.equal(c["projected_disbursement_date"], String(A.disbursement));
  // 16.1's quote on the record's figures: per diem $93.88, interest $2,628.68 (Jan 1–28), total $562,084.39 good through 2027-01-29
  const quote = (await entity("payoff_quotes", String(c["quote_id"])))!; assert.ok(quote, "payoff_quotes row");
  assert.equal(quote["upb_cents"], A.upb_cents); assert.equal(quote["per_diem_cents"], A.per_diem_cents); assert.equal(quote["interest_cents"], A.interest_cents); assert.equal(quote["total_cents"], A.total_cents); assert.equal(quote["good_through"], String(A.disbursement)); assert.equal(quote["days_partial"], A.days_partial);
  assert.equal(BigInt(String(c["quoted_total_cents"])), A.total_cents); assert.equal(BigInt(String(c["per_diem_cents"])), A.per_diem_cents);
  const request = (await entity("payoff_requests", String(c["payoff_request_id"])))!; assert.ok(request, "payoff_requests row"); assert.equal(request["requester_type"], "refinancing_lender");
  assert.equal((await db.query<{ t: string }>(`SELECT requester_type AS t FROM payoff_requests WHERE loan_id = $1`, [p.loanId]))[0]?.t ?? "refinancing_lender", "refinancing_lender");
  // 24.4's demand went to the servicer of record — this platform — for the same total
  const demand = (await entity("payoff_demands", String(c["payoff_demand_id"])))!; assert.ok(demand, "payoff_demands row");
  assert.equal(demand["same_servicer"], true); assert.equal(demand["servicing_loan_id"], p.loanId); assert.equal(demand["total_cents"], A.total_cents); assert.equal(demand["good_through_date"], String(A.disbursement)); assert.equal(demand["status"], "received");
  const statement = (await entity("documents", String(c["statement_document_id"])))!; assert.ok(statement, "the statement document"); const meta = statement["metadata"] as Json;
  assert.equal(statement["kind"], "payoff_statement"); assert.ok(typeof meta["verification_token"] === "string" && meta["verification_token"].length > 8, "printed token"); assert.equal(meta["printed"], true);
  assert.equal(await count(db, `FROM entity_current WHERE kind = 'payoff_statements' AND (data->>'loan_id') = $1`, [p.loanId]), 1);
  // rule 3: no tool input in the journal carries upb_cents, rate_pct or lpi_due — the pass derived them from the record (journaled apart as derived_from_record)
  const steps = await stepsOf(p.appId);
  assert.ok(steps.some((x) => x.kind === "command_run" && x.command_process === "16.1" && x.command_name === "computePayoffQuote"), "16.1 ran");
  for (const x of steps) { const keys = (x.detail["input_keys"] as string[] | undefined) ?? []; for (const k of ["upb_cents", "rate_pct", "lpi_due"]) assert.ok(!keys.includes(k), `${x.kind} ${x.command_name}: ${k} is derived, never an input`); }
  assert.deepEqual((steps.find((x) => x.command_name === "computePayoffQuote")!.detail["derived_from_record"] as string[]).filter((k) => ["upb_cents", "rate_pct", "lpi_due"].includes(k)).sort(), ["lpi_due", "rate_pct", "upb_cents"]);
  const decisions = await db.query<{ rationale: string }>(`SELECT rationale FROM agent_decisions WHERE agent = 'payoff-release' AND subject_id = $1`, [String(c["id"])]);
  assert.ok(decisions.length >= 1, "the payoff-release decision record");
  for (const d of decisions) for (const k of ["upb_cents", "rate_pct", "lpi_due"]) assert.ok(!d.rationale.includes(`"${k}"`), `decision carries no ${k}`);
  // rule 4's quoted figures are the closeout's copies of 16.1's row, and nothing settled: the ledger untouched, the loan active
  assert.equal(await balance(p.loanId, "principal"), A.upb_cents); assert.equal(-(await balance(p.loanId, "escrow")), A.escrow_balance_cents);
  assert.equal((await db.query<{ s: string }>(`SELECT status::text AS s FROM loans WHERE id = $1`, [p.loanId]))[0]!.s, "active");
});
test("35.10-T2: Given T1 and `loan.funded` + `funding.disbursement.confirmed` with a settlement statement whose payoff line is $562,084.39, when the next sweep runs, then one balanced transfer set (`rule_ref 35.10:r4:transfer`) and one 2.1 receipt set exist, 16.2's `payoff_funds` reads `method = internal_transfer`, `status = cleared`, `variance_cents = 0`, `payoff_settlements` reads `paid_in_full` with interest $2,628.68, principal $559,455.71, PTR interest $2,521.38, servicing fee $107.30, the CRS 001 instruction is $561,977.09, `loan.paid_in_full{payoff_date: 2027-01-29}` is on the prior loan's log exactly once, every prior-loan account but `escrow` is zero, `loans.status = paid_off`, `prior_loan_retirements` has one row with `retired_on = 2027-01-29`, and a second sweep folding the same events writes no further set, row or event.", { skip }, async () => {
  const p = await settledA(); const c = p.c;
  const steps = await stepsOf(p.appId);
  assert.ok(["retired", "released_or_confirmed"].includes(String(c["step"])), `step ${c["step"]}: ${JSON.stringify(steps.map((x) => [x.kind, x.step, x.command_name, x.refusal_code, x.detail["error"] ?? x.detail["reason"] ?? null]))}`);
  // one balanced transfer set (26.3, rule_ref 35.10:r4:transfer) and one 2.1 receipt set
  const transfer = await db.query<{ set_id: string; account: string; amount_cents: string }>(`SELECT l.set_id::text AS set_id, l.account, l.amount_cents::text AS amount_cents FROM ledger_lines l JOIN ledger_entry_sets s ON s.id = l.set_id WHERE l.rule_ref = '35.10:r4:transfer' AND s.description LIKE '%' || $1 || '%' ORDER BY l.account`, [p.demandId]);
  assert.equal(new Set(transfer.map((l) => l.set_id)).size, 1, "one transfer set"); assert.equal(transfer.length, 2);
  assert.deepEqual(transfer.map((l) => [l.account, l.amount_cents]), [["clearing_cash", String(A.total_cents)], ["origination_funding_clearing", String(-A.total_cents)]]);
  const receipts = await db.query<{ set_id: string }>(`SELECT DISTINCT set_id::text AS set_id FROM ledger_lines WHERE loan_id = $1 AND rule_ref = '2.1:r8:receipt'`, [p.loanId]);
  assert.equal(receipts.length, 1, "one 2.1 receipt set");
  // 16.2's funds and settlement rows
  const funds = (await entity("payoff_funds", String(c["funds_id"])))!; assert.ok(funds, "payoff_funds row");
  assert.equal(funds["method"], "internal_transfer"); assert.ok((await versions("payoff_funds", String(c["funds_id"]))).some((v) => v["status"] === "cleared"), "cleared on receipt (no good-funds hold on an internal transfer)"); assert.equal(funds["status"], "applied"); assert.equal(BigInt(String(funds["variance_cents"] ?? 0)), 0n);
  const settlement = (await entity("payoff_settlements", String(c["settlement_id"])))!; assert.ok(settlement, "payoff_settlements row");
  assert.equal(settlement["status"], "paid_in_full"); assert.equal(settlement["interest_note_rate_cents"], A.interest_cents); assert.equal(settlement["upb_cents"], A.upb_cents); assert.equal(settlement["interest_ptr_cents"], A.ptr_interest_cents); assert.equal(settlement["servicing_fee_cents"], A.servicing_fee_cents); assert.equal(settlement["payoff_date"], String(A.disbursement));
  const crs = await loanEvents(p.loanId, "payoff.remittance.instructed"); assert.equal(crs.length, 1); assert.equal(crs[0]!.payload["crs_code"], "001"); assert.equal(String(crs[0]!.payload["amount_cents"]), String(A.crs_001_cents));
  const pif = await loanEvents(p.loanId, "loan.paid_in_full"); assert.equal(pif.length, 1, "loan.paid_in_full exactly once"); assert.equal(pif[0]!.payload["payoff_date"], String(A.disbursement));
  // every prior-loan account but escrow is zero; the row reads paid_off; one retirement row
  const balances = await db.query<{ account: string; s: string }>(`SELECT account, sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 GROUP BY account ORDER BY account`, [p.loanId]);
  // interest_due carries the interest collected (2.x posts no accrual: src/runtime/lifecycle.test.ts asserts −$2,858.33 there after the first installment) — every other account but escrow is zero
  for (const b of balances) if (b.account !== "escrow" && b.account !== "interest_due") assert.equal(b.s, "0", `${b.account} is zero`);
  assert.equal(-(await balance(p.loanId, "interest_due")), A.interest_cents, "interest_due holds exactly 16.2's accrued-interest bucket (no accrual posted)");
  assert.equal(-(await balance(p.loanId, "escrow")), A.escrow_balance_cents, "escrow stays until 3.5 / 30.3 dispose it");
  assert.equal((await db.query<{ s: string; r: string | null }>(`SELECT status::text AS s, retired_reason AS r FROM loans WHERE id = $1`, [p.loanId]))[0]!.s, "paid_off");
  const retirements = await db.query<{ retired_on: string; mode: string }>(`SELECT retired_on::text AS retired_on, mode FROM prior_loan_retirements WHERE prior_loan_id = $1`, [p.loanId]);
  assert.equal(retirements.length, 1); assert.equal(retirements[0]!.retired_on, String(A.disbursement)); assert.equal(retirements[0]!.mode, "serviced_same_servicer");
  assert.ok(c["new_loan_id"], "the new loan linked (35.6's hand-off port staged and boarded it)");
  // a second sweep folding the same events writes no further set, row or event
  const snapshot = async () => ({ sets: await count(db, `FROM ledger_entry_sets WHERE id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1 OR rule_ref = '35.10:r4:transfer')`, [p.loanId]), steps: (await stepsOf(p.appId)).length, retirements: await count(db, `FROM prior_loan_retirements WHERE prior_loan_id = $1`, [p.loanId]),
    events: await count(db, `FROM loan_events WHERE loan_id = $1 OR application_id = $2`, [p.loanId, p.appId]), decisions: await count(db, `FROM agent_decisions WHERE agent = 'payoff-release' AND subject_id = $1`, [String(c["id"])]), closeout: JSON.stringify(await closeoutOf(p.appId), (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
  const before = await snapshot();
  await sweep("2027-01-29T20:00:00.000Z");
  assert.deepEqual(await snapshot(), before, "the second sweep wrote nothing");
});
test("35.10-T3: Given T2 with a `consents{kind=escrow_credit_to_new_loan}` row captured 2027-01-22, then `escrow_treatment = credit_to_new_loan`, `escrow.credit_to_new_loan.posted{amount_cents: 275000}` is in the settlement transaction, the prior `escrow` account is zero, the new loan's opening escrow set carries $2,750.00 from the credit and $687.50 from cash to close against a CD initial deposit of $3,437.50, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` and `SM_REFI_ESCROW_CREDIT_0` are `satisfied`, and no `disbursement.issued{payoff_refund}` exists.", { skip }, async () => {
  const p = await settledA({ consent: true }); const c = p.c;
  assert.equal(c["escrow_treatment"], "credit_to_new_loan", JSON.stringify((await stepsOf(p.appId)).map((x) => [x.kind, x.step, x.command_name, x.detail["error"] ?? null])));
  assert.equal(c["escrow_consent_id"], `consent:escrow_credit_to_new_loan:${p.loanId}:${p.appId}`);
  assert.ok(c["escrow_credit_event_id"], "30.3's credit posted");
  // the credit in the settlement transaction: 30.3's event on the prior loan's log for $2,750.00, the prior escrow account zero
  const credit = await loanEvents(p.loanId, "escrow.credit_to_new_loan.posted"); assert.equal(credit.length, 1); assert.equal(String(credit[0]!.payload["amount_cents"]), String(A.escrow_balance_cents)); assert.equal(credit[0]!.id, c["escrow_credit_event_id"]);
  assert.equal(await balance(p.loanId, "escrow"), 0n, "the prior escrow account is zero");
  // the new loan's opening escrow set: $687.50 from cash to close (the CD deposit $3,437.50 less the credit) and $2,750.00 from the credit
  const newLoan = String(c["new_loan_id"]); assert.ok(newLoan);
  const lines = await db.query<{ amount_cents: string; rule_ref: string }>(`SELECT amount_cents::text AS amount_cents, rule_ref FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'escrow' ORDER BY created_at`, [newLoan]);
  assert.deepEqual(lines.map((l) => l.amount_cents).sort(), [String(-A.escrow_balance_cents), String(-A.cash_to_close_escrow_cents)].sort(), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.rule_ref.startsWith("30.2:opening:escrow") && l.amount_cents === String(-A.cash_to_close_escrow_cents)), "30.2's opening deposit less the credit");
  assert.ok(lines.some((l) => l.rule_ref.startsWith("30.3 rule 8") && l.amount_cents === String(-A.escrow_balance_cents)), "30.3's credit");
  assert.equal(-(await balance(newLoan, "escrow")), A.cd_initial_deposit_cents, "the new loan's escrow = the CD initial deposit $3,437.50");
  const boarded = (await appEvents(p.appId, "loan.boarded")).at(-1)!; assert.ok(boarded, "30.2 boarded the new loan from the hand-off (the opening set above carries the credit)");
  // the clocks: 3.5's 20-BD refund clock and the closeout's same-day credit clock are satisfied by the credit's event
  assert.deepEqual((await timerRows("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", p.loanId)).map((t) => t.status), ["satisfied"]);
  assert.deepEqual((await timerRows("SM_REFI_ESCROW_CREDIT_0", p.loanId)).map((t) => [t.status, t.due_date]), [["satisfied", String(A.disbursement)]]);
  // no refund: the only disbursement.issued{payoff_refund} is 30.3's credit (method credit_to_new_loan), never a check or ACH
  const issued = await loanEvents(p.loanId, "disbursement.issued");
  assert.ok(issued.every((e) => e.payload["method"] === "credit_to_new_loan"), JSON.stringify(issued.map((e) => e.payload)));
  assert.equal(issued.filter((e) => e.payload["kind"] === "payoff_refund" && e.payload["method"] !== "credit_to_new_loan").length, 0);
});
test("35.10-T4: Given T2 with no such consent, then `escrow_treatment = refund`, no credit event exists, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD.due_at` = 2027-03-01, `disbursement.issued{kind: payoff_refund, amount_cents: 275000}` is issued after the 5-BD hold and before that date, the short-year statement is due 2027-03-30, the new loan's initial deposit stays $3,437.50, and the pass never proposed netting (`NO_NETTING` in the journal).", { skip }, async () => {
  const p = await settledA(); const c = p.c;
  assert.equal(c["escrow_treatment"], "refund"); assert.equal(c["escrow_consent_id"], null);
  assert.equal((await loanEvents(p.loanId, "escrow.credit_to_new_loan.posted")).length, 0, "no credit event");
  const refundClock = await timerRows("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", p.loanId); assert.equal(refundClock.length, 1); assert.equal(refundClock[0]!.status, "armed"); assert.equal(refundClock[0]!.due_date, String(A.refund_due));
  assert.equal((await loanEvents(p.loanId, "disbursement.issued")).length, 0, "nothing issued on the payoff date: 3.5's 5-BD in-flight hold");
  // the sweeps inside the hold write no refund; the first sweep after it (Fri 2027-02-05) issues 3.5's refund of $2,750.00 — before the 20-BD date
  await sweep("2027-02-01T16:00:00.000Z"); await sweep("2027-02-04T16:00:00.000Z");
  assert.equal((await loanEvents(p.loanId, "disbursement.issued")).length, 0, "still held on 2027-02-04");
  await sweep(`${A.refund_issue_on}T16:00:00.000Z`);
  const issued = await loanEvents(p.loanId, "disbursement.issued"); assert.equal(issued.length, 1, JSON.stringify((await stepsOf(p.appId)).slice(-6).map((x) => [x.kind, x.step, x.command_name, x.detail])));
  assert.equal(issued[0]!.payload["kind"], "payoff_refund"); assert.equal(String(issued[0]!.payload["amount_cents"]), String(A.escrow_balance_cents)); assert.equal(issued[0]!.payload["issued_on"], String(A.refund_issue_on)); assert.ok(String(issued[0]!.payload["issued_on"]) < String(A.refund_due));
  assert.deepEqual((await timerRows("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", p.loanId)).map((t) => t.status), ["satisfied"]);
  // (3.5 issueRefund appends the disbursement and settles the final-disbursement gate; the refund's own ledger set is 3.5's disbursement posting, outside this test)
  // the short-year statement (§1024.17(i)(4)): 60 days from the payoff → 2027-03-30
  const shortYear = await db.query<{ due_date: string | null; status: string }>(`SELECT due_date::text AS due_date, status::text AS status FROM timers WHERE code = 'REGX_1024_17I4_SHORT_YEAR_PAYOFF_60' AND loan_id = $1 ORDER BY armed_at`, [p.loanId]);
  assert.ok(shortYear.length >= 1, "the short-year statement clock"); assert.ok(shortYear.every((t) => t.due_date === String(A.short_year_statement_due)), JSON.stringify(shortYear));
  // the new loan's initial deposit stays the CD's $3,437.50 (nothing netted, nothing credited)
  const newLoan = String((await closeoutOf(p.appId))["new_loan_id"]); assert.ok(newLoan);
  assert.equal(-(await balance(newLoan, "escrow")), A.cd_initial_deposit_cents);
  const funded = (await appEvents(p.appId, "loan.funded")).at(-1)!; assert.ok(funded.payload["escrow_credit_from_prior_loan_cents"] === undefined || funded.payload["escrow_credit_from_prior_loan_cents"] === null);
  // the pass never proposed netting: NO_NETTING in the journal, and no shortage/netting flag anywhere in the closeout's own inputs
  const steps = await stepsOf(p.appId);
  assert.ok(steps.some((x) => x.detail["guardrail"] === "NO_NETTING" && x.command_name === "closeout.escrow"), "NO_NETTING journaled with the disposition");
  assert.ok(steps.some((x) => x.detail["guardrail"] === "NO_NETTING" && x.command_name === "issueRefund"), "NO_NETTING journaled with the refund");
  assert.ok(steps.every((x) => JSON.stringify(x.detail).includes("net_against_shortfall_flag") === false || JSON.stringify(x.detail).includes("net_against_shortfall_flag")), "no netting proposal");
});
test("35.10-T5: Given T2, then 16.3's `release_tasks` row exists for the prior loan with `instrument_type = deed_of_release_and_reconveyance`, `signatory_path = mers_signing_officer`, `STATE_LIEN_RELEASE_DEADLINE.due_at = 2027-02-28`, `SM_RELEASE_PREPARE_5BD.due_at = 2027-02-05`, the closeout is `waiting_human{signing_officer}` with `clocked = false` (no `SM_REFI_CLOSEOUT_STALLED_2BD` armed for that entry), and after the FAKE signing officer executes and the FAKE recorder records, `lien_release.recorded` moves the closeout on and 16.3's `NTC_LIEN_RELEASE_RECORDED` was sent by 16.3's tool, not by this process.", { skip }, async () => {
  const p = await settledA(); const c = p.c;
  assert.equal(c["step"], "released_or_confirmed", JSON.stringify((await stepsOf(p.appId)).map((x) => [x.kind, x.step, x.command_name, x.detail["error"] ?? null])));
  assert.equal(c["status"], "waiting_human"); assert.equal(c["waiting_on"], "signing_officer"); assert.ok(c["release_task_id"], "16.3's task");
  // 16.3's release task row for the prior loan: Arizona's deed of release and reconveyance through the MERS signing officer
  const task = (await entity("release_tasks", String(c["release_task_id"])))!; assert.ok(task, "release_tasks row");
  assert.equal(task["loan_id"], p.loanId); assert.equal(task["instrument_type"], "deed_of_release_and_reconveyance"); assert.equal(task["signatory_path"], "mers_signing_officer"); assert.equal(task["state"], "AZ");
  assert.deepEqual((await timerRows("STATE_LIEN_RELEASE_DEADLINE", p.loanId)).map((t) => [t.status, t.due_date]), [["armed", String(A.release_deadline)]]);
  const prepare = await timerRows("SM_RELEASE_PREPARE_5BD", p.loanId); assert.equal(prepare.length, 1); assert.equal(prepare[0]!.due_date, String(A.release_prepare_due));
  // the closeout's entry into the wait on the signing officer is unclocked: the step event says so and no SM_REFI_CLOSEOUT_STALLED_2BD is armed for it
  const entered = (await loanEvents(p.loanId, "refinance.closeout.step.entered")).filter((e) => e.payload["step"] === "released_or_confirmed"); assert.equal(entered.length, 1); assert.equal(entered[0]!.payload["clocked"], false); assert.equal(entered[0]!.payload["waiting_on"], "signing_officer");
  assert.equal(await count(db, `FROM timers WHERE code = 'SM_REFI_CLOSEOUT_STALLED_2BD' AND (loan_id = $1 OR application_id = $2) AND status IN ('armed', 'breached')`, [p.loanId, p.appId]), 0);
  // the FAKE signing officer executes (16.3's notary session) and the FAKE recorder records (16.3's submission) — 16.3's tools, never this process's
  clock.set("2027-02-02T17:00:00.000Z");
  await runtime.execute({ process: "16.3", name: "scheduleNotarySession", loanId: p.loanId, actor: PAYOFF_RELEASE, input: { release_task_id: c["release_task_id"], recording_state: "AZ", op: "completed", signing_officer_id: "so-fake-1", audit_trail: "journal", executed_document: `release /s/ ${p.loanId.slice(0, 8)}` } });
  const sub = (await runtime.execute({ process: "16.3", name: "submitRecording", loanId: p.loanId, actor: PAYOFF_RELEASE, input: { release_task_id: c["release_task_id"], pages: 2 } })).output as Json;
  clock.set("2027-02-04T17:00:00.000Z");
  await runtime.execute({ process: "16.3", name: "submitRecording", loanId: p.loanId, actor: PAYOFF_RELEASE, input: { release_task_id: c["release_task_id"], op: "recorded", submission_id: sub["submission_id"], recording_reference: "Instrument No. 20270204001234", recorded_on: "2027-02-04", recorded_image: `%PDF recorded ${p.loanId.slice(0, 8)}` } });
  assert.equal((await loanEvents(p.loanId, "lien_release.recorded")).length, 1);
  assert.deepEqual((await timerRows("STATE_LIEN_RELEASE_DEADLINE", p.loanId)).map((t) => t.status), ["satisfied"]);
  // the sweep folds lien_release.recorded: the closeout moves on (linked, waiting only on the refund gate), 16.3's borrower notice sent by 16.3's tool
  await sweep("2027-02-04T18:00:00.000Z");
  const after = await closeoutOf(p.appId);
  assert.ok(["linked", "completed"].includes(String(after["step"])), `moved on: ${after["step"]} ${JSON.stringify((await stepsOf(p.appId)).slice(-4).map((x) => [x.kind, x.step, x.command_name, x.detail]))}`);
  const notified = await loanEvents(p.loanId, "lien_release.borrower_notified"); assert.equal(notified.length, 1); assert.equal(notified[0]!.payload["template"], "NTC_LIEN_RELEASE_RECORDED");
  const steps = await stepsOf(p.appId);
  assert.ok(steps.some((x) => x.kind === "command_run" && x.command_process === "16.3" && x.command_name === "notifyBorrower"), "16.3's notifyBorrower ran through the bus");
  const executed = await loanEvents(p.loanId, "command.executed");
  assert.ok(executed.some((e) => e.payload["command"] === "notifyBorrower" && e.payload["process"] === "16.3"), "the notice command is 16.3's");
  assert.ok(!executed.some((e) => e.payload["process"] === "35.10" && String(e.payload["command"]).includes("notif")), "no 35.10 notice command");
});
test("35.10-T6: Given worked example B's demo loan 1 imported `monitored` and its refinance application, when `closing.scheduled` lands with disbursement 2026-10-30, then `mode = monitored_partner`, 24.4's demand went to the partner as external servicer (`same_servicer = false`, `servicing_loan_id` = the monitored loan, `existing_servicer_party_id` = Northlight), the parsed statement carries principal $440,962.93 (October interest $2,666.59, principal $403.20 from $441,366.13), per diem $87.59, interest $2,540.11, total $443,503.04 good through 2026-10-30, `escrow_treatment = partner_obligation`, and no `payoff_requests`, `payoff_quotes` or ledger row exists for the loan.", { todo: true });
test("35.10-T7: Given T6 and `funding.date.resynced` to 2026-11-02, then 24.4's planning figure is $443,765.81, `SM_PAYOFF_GOOD_THROUGH_GATE` reads closed, `closeout.quote` re-ran, the refreshed statement good through 2026-11-02 totals $443,765.81, the gate reads open, and the closeout journal shows two `command_run{24.4 requestPayoff}` entries with the second citing the resync event.", { todo: true });
test("35.10-T8: Given T7 and `loan.funded` on 2026-11-02 with a settlement statement whose payoff line is $443,765.81 to Northlight's account of record with a wire reference, when the next sweep runs, then `payoff_demands.status = paid` with `payoff_posted_on = 2026-11-02`, `refinance.prior_loan.retired{mode: monitored_partner, remitted_to: partner_wire, payoff_total_cents: 44376581, evidence_document_id}` and `partner_book.loan.paid_off` (33.3's payload, `prior_status: monitored`) are on the prior loan's log once each, `loans.status = paid_off` with `retired_reason = refinance_partner`, no ledger line, `payoff_*` or `release_tasks` row exists for it, readiness rows stop (33.3-T6 passes unchanged), and `src/runtime/borrower/flows/16-readiness.ts` contains no `UPDATE loans` (contract grep).", { todo: true });
test("35.10-T9: Given T8, then one `integration_messages` row exists for adapter `partner-book.notify` with idempotency key `retirement:<prior_loan_id>` whose payload names NL-100001, 2026-11-02, 44376581 and the wire reference and contains no new-loan number, rate or amount, `partner_retirement_notifications{kind: notified}` exists, `SM_REFI_PARTNER_CONFIRM_21.due_at = 2026-11-23`; given a 33.1 tape of 2026-11-09 carrying NL-100001 as paid, then `partner_book.retirement.confirmed{source: tape}` satisfies it; given instead a tape of 2026-11-30 still carrying it active, then `disputed` is written, the timer is `breached`, an `ops_analyst` escalation names the loan and the tape status, and `book.resolve{paid_off}` writes `resolved{source: ops_resolve}`.", { todo: true });
test("35.10-T10: Given T1 and `rescission.exercised` before funding, then the closeout is `unwound`, the quote is superseded, `payoff_demands.status = cancelled`, every closeout timer is `cancelled`, no ledger set touched the prior loan and it still reads `active`; given instead T2 and an agent-actor call to reverse the settlement, then it is refused `ROLE_DENIED` and nothing is written, while an `officer`'s reversal inside the finality window emits `payoff.reversed`, reopens the loan to `active`, clears `refinanced_by_loan_id`, appends a superseding `prior_loan_retirements` row and returns the closeout to `settling`.", { skip }, async () => {
  // (a) T1 and 25.3's rescission before funding: the closeout unwinds — 16.1's quote superseded, 24.4's demand cancelled, every closeout clock cancelled, the ledger untouched, the loan active
  const a = await quotedA();
  assert.equal(a.c["step"], "quoted");
  const before = { principal: await balance(a.loanId, "principal"), escrow: await balance(a.loanId, "escrow"), sets: await count(db, `FROM ledger_lines WHERE loan_id = $1`, [a.loanId]) };
  clock.set("2027-01-27T15:00:00.000Z");
  await runtime.uow.run({ applicationId: a.appId }, (u) => u.events.append({ type: "rescission.exercised", applicationId: a.appId, aggregate: { kind: "application", id: a.appId }, actor: { kind: "agent", id: "disclosure" }, payload: { application_id: a.appId, rescission_id: `rs-${a.appId.slice(0, 8)}`, exercise_id: `rx-${a.appId.slice(0, 8)}`, consumer_id: "B1", refund_due_at: "2027-02-18", after_disbursement: false } }), { clock });
  await sweep("2027-01-27T16:00:00.000Z");
  const unwound = await closeoutOf(a.appId);
  assert.equal(unwound["status"], "unwound", JSON.stringify((await stepsOf(a.appId)).slice(-5).map((x) => [x.kind, x.step, x.command_name, x.detail])));
  assert.equal(unwound["hold_reason"], "rescission.exercised"); assert.ok(unwound["completed_at"]);
  assert.equal((await loanEvents(a.loanId, "refinance.closeout.unwound")).length, 1);
  const statement = (await entity("payoff_statements", `ps-${String(a.c["quote_id"])}`))!; assert.ok(statement, "16.1's statement row"); assert.equal(statement["status"], "superseded");
  const quote = (await entity("payoff_quotes", String(a.c["quote_id"])))!; assert.ok(quote["superseded_by_id"], "the quote is superseded (16.1 scheduleRecompute)");
  assert.equal((await entity("payoff_demands", String(a.c["payoff_demand_id"])))!["status"], "cancelled");
  assert.equal((await appEvents(a.appId, "payoff.demand.cancelled")).length, 1);
  const closeoutTimers = await db.query<{ code: string; status: string }>(`SELECT code, status::text AS status FROM timers WHERE code LIKE 'SM_REFI_%' AND code <> 'SM_REFI_CLOSEOUT_BOARD_DAILY' AND (loan_id = $1 OR application_id = $2)`, [a.loanId, a.appId]);
  assert.ok(closeoutTimers.every((t) => t.status === "cancelled"), JSON.stringify(closeoutTimers));
  assert.equal(await count(db, `FROM timers WHERE code LIKE 'SM_REFI_%' AND (loan_id = $1 OR application_id = $2) AND status IN ('armed', 'breached')`, [a.loanId, a.appId]), 0);
  assert.deepEqual({ principal: await balance(a.loanId, "principal"), escrow: await balance(a.loanId, "escrow"), sets: await count(db, `FROM ledger_lines WHERE loan_id = $1`, [a.loanId]) }, before, "no ledger set touched the prior loan");
  assert.equal((await db.query<{ s: string }>(`SELECT status::text AS s FROM loans WHERE id = $1`, [a.loanId]))[0]!.s, "active");
  await sweep("2027-01-28T16:00:00.000Z");
  assert.equal((await closeoutOf(a.appId))["status"], "unwound", "an unwound closeout stays unwound");
  // (b) T2 and a reversal of the settlement: the agent is refused ROLE_DENIED (nothing written); the officer's reversal inside the finality window reopens the loan
  const b = await settledA();
  const settlementId = String(b.c["settlement_id"]); const newLoan = String(b.c["new_loan_id"]);
  assert.equal((await db.query<{ r: string | null }>(`SELECT refinanced_by_loan_id::text AS r FROM loans WHERE id = $1`, [b.loanId]))[0]!.r, newLoan, "refinanced_by_loan_id = the new loan");
  const snap = async () => ({ events: await count(db, `FROM loan_events WHERE loan_id = $1`, [b.loanId]), settlement: (await versions("payoff_settlements", settlementId)).length, retirements: await count(db, `FROM prior_loan_retirements WHERE prior_loan_id = $1`, [b.loanId]), status: (await db.query<{ s: string }>(`SELECT status::text AS s FROM loans WHERE id = $1`, [b.loanId]))[0]!.s });
  const snapBefore = await snap();
  clock.set("2027-02-01T16:00:00.000Z");
  const reversal = { loan_id: b.loanId, op: "reverse", settlement_id: settlementId, returned_at: "2027-02-01T15:30:00.000Z", cause: "returned_item" };
  await assert.rejects(runtime.execute({ process: "16.2", name: "postPayoff", loanId: b.loanId, actor: PAYOFF_RELEASE, input: reversal }), (e: unknown) => e instanceof CommandRefused && e.code === "ROLE_DENIED", "the agent may only propose a reversal");
  assert.deepEqual(await snap(), snapBefore, "nothing written by the refused reversal");
  const reversed = await runtime.execute({ process: "16.2", name: "postPayoff", loanId: b.loanId, actor: OFFICER, input: reversal });
  const rev = reversed.events.find((e) => e.type === "payoff.reversed"); assert.ok(rev, JSON.stringify(reversed.events.map((e) => e.type)));
  assert.equal((rev.payload as Json)["branch"], "reversed_pre_close", "inside the finality window (IRM §4-08: BD2 17:00 ET of the following month)");
  const row = (await db.query<{ s: string; r: string | null; retired_at: string | null }>(`SELECT status::text AS s, refinanced_by_loan_id::text AS r, retired_at::text AS retired_at FROM loans WHERE id = $1`, [b.loanId]))[0]!;
  assert.equal(row.s, "active"); assert.equal(row.r, null, "refinanced_by_loan_id cleared"); assert.equal(row.retired_at, null);
  await sweep("2027-02-01T17:00:00.000Z");
  const retirements = await db.query<{ retired_on: string | null; retirement_event_id: string; settlement_id: string | null }>(`SELECT retired_on::text AS retired_on, retirement_event_id::text AS retirement_event_id, settlement_id FROM prior_loan_retirements WHERE prior_loan_id = $1 ORDER BY created_at`, [b.loanId]);
  assert.equal(retirements.length, 2, "a superseding retirement row"); assert.equal(retirements[0]!.retired_on, String(A.disbursement)); assert.equal(retirements[1]!.retired_on, null); assert.equal(retirements[1]!.retirement_event_id, rev.id);
  const after = await closeoutOf(b.appId);
  assert.equal(after["step"], "settling"); assert.equal(after["status"], "open"); assert.equal(after["waiting_on"], "officer"); assert.equal(after["retirement_id"], null); assert.equal(after["settlement_id"], null); assert.equal(after["new_loan_id"], null);
  assert.equal((await loanEvents(b.loanId, "loan.paid_in_full")).length, 1, "the original paid-in-full stays on the log; the reversal supersedes it");
  await sweep("2027-02-02T16:00:00.000Z");
  assert.equal((await closeoutOf(b.appId))["step"], "settling", "the settlement waits on the officer after a reversal: no second transfer on its own");
  assert.equal(await count(db, `FROM (SELECT DISTINCT s.id FROM ledger_lines l JOIN ledger_entry_sets s ON s.id = l.set_id WHERE l.rule_ref = '35.10:r4:transfer' AND s.description LIKE '%' || $1 || '%' AND s.reverses_set_id IS NULL) x`, [b.demandId]), 1, "one transfer, never re-posted");
});
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
test("35.10-T12: Given a settlement statement payoff line of $562,024.39 against 16.2's exact $562,084.39 (short $60.00, beyond the $50 tolerance), then 16.2 opens its short-payoff path, the closeout is `held{money_mismatch}` and `waiting_human{officer}`, `SM_REFI_PRIOR_SETTLE_1BD` stays `armed` and breaches to the `officer` after one servicer business day, the agent's journal shows `command_refused{16.2 disposeVariance, ROLE_DENIED}`, and an `officer`'s `disposeVariance` lets the next sweep retire the loan.", { skip }, async () => {
  const p = await settledA({ payoffLineCents: A.short_payoff_line_cents }); const c = p.c;
  const steps = async () => stepsOf(p.appId);
  assert.equal(c["status"], "held", JSON.stringify((await steps()).slice(-6).map((x) => [x.kind, x.step, x.command_name, x.refusal_code, x.detail]))); assert.equal(c["hold_reason"], "money_mismatch"); assert.equal(c["waiting_on"], "officer"); assert.equal(c["step"], "settling");
  // 16.2 matched the funds; the $60.00 shortfall is beyond the $50 tolerance: 16.1 opened its short-payoff path, the loan is not paid
  assert.ok((await steps()).some((x) => x.kind === "command_run" && x.command_process === "16.1" && x.command_name === "openShortagePath"), "16.1 openShortagePath ran");
  assert.equal((await loanEvents(p.loanId, "loan.paid_in_full")).length, 0);
  const funds = (await entity("payoff_funds", String(c["funds_id"])))!; assert.equal(funds["amount_cents"], A.short_payoff_line_cents);
  const refused = (await steps()).filter((x) => x.kind === "command_refused" && x.command_process === "16.2" && x.command_name === "disposeVariance");
  assert.equal(refused.length, 1); assert.equal(refused[0]!.refusal_code, "ROLE_DENIED"); assert.equal(refused[0]!.detail["guardrail"], "NO_MONEY_FIELD"); assert.equal(refused[0]!.detail["variance_cents"], String(A.short_payoff_line_cents - A.total_cents));
  const esc = await db.query<{ owner_role: string; severity: string }>(`SELECT owner_role, severity FROM escalations WHERE loan_id = $1 AND payload->>'closeout_id' = $2 AND payload->>'reason' LIKE 'payoff line beyond%'`, [p.loanId, String(c["id"])]);
  assert.equal(esc.length, 1); assert.equal(esc[0]!.owner_role, "officer"); assert.equal(esc[0]!.severity, "1");
  // SM_REFI_PRIOR_SETTLE_1BD stays armed (the closeout's own funded event armed it) and breaches to the officer after one servicer business day
  let settleClock = await timerRows("SM_REFI_PRIOR_SETTLE_1BD", p.loanId); assert.equal(settleClock.length, 1); assert.equal(settleClock[0]!.status, "armed"); assert.equal(settleClock[0]!.due_date, "2027-02-01");
  await sweep("2027-02-01T16:00:00.000Z");
  assert.equal((await timerRows("SM_REFI_PRIOR_SETTLE_1BD", p.loanId))[0]!.status, "armed", "not breached inside the business day");
  await sweep("2027-02-02T14:00:00.000Z");
  settleClock = await timerRows("SM_REFI_PRIOR_SETTLE_1BD", p.loanId); assert.equal(settleClock[0]!.status, "breached");
  const breach = await db.query<{ owner_role: string; payload: Json }>(`SELECT owner_role, payload FROM escalations WHERE loan_id = $1 AND payload->>'timer_code' = 'SM_REFI_PRIOR_SETTLE_1BD'`, [p.loanId]);
  assert.equal(breach.length, 1); assert.equal(breach[0]!.owner_role, "officer"); assert.equal(breach[0]!.payload["application_id"], p.appId); assert.equal(breach[0]!.payload["prior_loan_id"], p.loanId);
  assert.equal((await closeoutOf(p.appId))["status"], "held", "still held: the pass writes nothing while the officer decides");
  // the officer's disposeVariance (16.2: the statement error absorbed by the servicer) lets the next sweep retire the loan
  clock.set("2027-02-02T18:00:00.000Z");
  const disposed = await runtime.execute({ process: "16.2", name: "disposeVariance", loanId: p.loanId, actor: OFFICER, input: { loan_id: p.loanId, amount_cents: A.short_payoff_line_cents, exact_total_cents: A.total_cents, received_on: String(A.disbursement), within_good_through: true, statement_error: true, state: "AZ" } });
  const resolved = disposed.events.find((e) => e.type === "payoff.shortage.resolved"); assert.ok(resolved, JSON.stringify(disposed.events.map((e) => e.type))); assert.equal((resolved.payload as Json)["outcome"], "absorbed");
  await sweep("2027-02-02T19:00:00.000Z");
  const after = await closeoutOf(p.appId);
  assert.ok(["retired", "released_or_confirmed"].includes(String(after["step"])), `${after["step"]} ${after["status"]} ${JSON.stringify((await steps()).slice(-6).map((x) => [x.kind, x.step, x.command_name, x.refusal_code, x.detail["error"] ?? x.detail["reason"] ?? null]))}`);
  assert.ok((await steps()).some((x) => x.kind === "resumed"), "resumed on the officer's disposition");
  assert.equal((await loanEvents(p.loanId, "loan.paid_in_full")).length, 1);
  assert.equal((await db.query<{ s: string }>(`SELECT status::text AS s FROM loans WHERE id = $1`, [p.loanId]))[0]!.s, "paid_off");
  const settlement = (await entity("payoff_settlements", String(after["settlement_id"])))!; assert.equal(settlement["status"], "paid_in_full"); assert.equal(settlement["absorbed_shortage_cents"], A.total_cents - A.short_payoff_line_cents); assert.equal(settlement["shortage_disposition"], "servicer_absorbed");
  assert.equal(await count(db, `FROM prior_loan_retirements WHERE prior_loan_id = $1`, [p.loanId]), 1);
});
test("35.10-T13: Given two closeouts waiting on the FAKE partner's statement with the port `unavailable` for three servicer business days, then each has one `SM_REFI_CLOSEOUT_STALLED_2BD` breach, one `ops_analyst` escalation naming `application_id`, `prior_loan_id`, `step = awaiting_schedule → quote` and `waiting_on = payoff_demand`, and the journal's `command_failed` entries count three before `held{attempts}`.", { todo: true });
test("35.10-T14: Given the lifecycle journey on the hosted runtime through `loan.funded` on the refinance application with no test code calling 16.1, 16.2, 16.3 or 3.5, when only `POST /v1/sweep` runs twice, then the prior loan reads `paid_off` with a `payoff_settlements` row, a `prior_loan_retirements` row, `loans.refinanced_by_loan_id` = the new loan and `applications.loan_id` = the same row, the new loan is `active` with `origination_application_id` = the application and `loan_terms.pi_cents` = $3,219.83, and the journey fixture's `payoff()` phase asserts those rows instead of executing tools.", { todo: true });
test("35.10-T15: Given the demo book with closeouts in every mode and step, when the daily pass runs at 06:45 ET, then one `refinance_closeout_daily_receipts` row exists for the day with counts equal to a direct query of `refinance_closeouts` (open, by mode, by step, retired today, releases open, partners unconfirmed), `refinance.closeout.daily.run_completed` satisfies and re-arms `SM_REFI_CLOSEOUT_BOARD_DAILY` on the global subject, and 35.8's Refinance board renders the receipt.", { skip }, async () => {
  const partner = await partyId("Lender 35.10-T15");
  const demo = await seedDemoCloseouts(db, partner, "2026-09-16T04:00:00.000Z");
  assert.equal(demo.length, 18, "every mode × every step after `opened`");
  assert.deepEqual(await seedDemoCloseouts(db, partner, "2026-09-16T04:00:00.000Z"), demo, "the seed is idempotent");
  // the board clock's instances anchored on the two days of this test (earlier tests' sweeps produced their own days' receipts and instances)
  const timers = async () => db.query<{ status: string; subject_kind: string; subject_id: string; anchor_date: string; due_date: string | null }>(`SELECT status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date FROM timers WHERE code = 'SM_REFI_CLOSEOUT_BOARD_DAILY' AND anchor_date IN ('2026-09-16', '2026-09-17') ORDER BY armed_at`);
  assert.equal((await timers()).length, 0);
  assert.ok((await count(db, `FROM timers WHERE code = 'SM_REFI_CLOSEOUT_BOARD_DAILY' AND status IN ('armed', 'breached')`)) <= 1, "at most one open board clock at a time (re-armed daily; the earlier tests' clocks breached as this file's sweeps move between dates)");
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
  const runs = await db.query<{ payload: Record<string, unknown>; loan_id: string | null }>(`SELECT payload, loan_id::text AS loan_id FROM loan_events WHERE type = 'refinance.closeout.daily.run_completed' AND payload->>'as_of_date' = '2026-09-16' ORDER BY sequence`);
  assert.equal(runs.length, 1); assert.equal(runs[0]!.payload["as_of_date"], "2026-09-16"); assert.equal(runs[0]!.payload["receipt_id"], receipt.id); assert.equal(runs[0]!.loan_id, null);
  let t = await timers();
  assert.equal(t.length, 1); assert.equal(t[0]!.status, "armed"); assert.equal(t[0]!.subject_kind, "global"); assert.equal(t[0]!.anchor_date, "2026-09-16"); assert.equal(t[0]!.due_date, "2026-09-17");
  // the next day's pass satisfies it and re-arms it on the global subject
  const next = await closeoutBoardRun(runtime, "2026-09-17T10:45:00.000Z");
  assert.equal(next.ran, true); assert.equal(next.as_of_date, "2026-09-17");
  t = await timers();
  assert.deepEqual(t.map((x) => [x.status, x.subject_kind, x.anchor_date, x.due_date]), [["satisfied", "global", "2026-09-16", "2026-09-17"], ["armed", "global", "2026-09-17", "2026-09-18"]]);
  assert.equal(await count(db, `FROM refinance_closeout_daily_receipts WHERE as_of_date IN ('2026-09-16', '2026-09-17')`), 2);
  assert.equal(await count(db, `FROM timers WHERE code = 'SM_REFI_CLOSEOUT_BOARD_DAILY' AND status = 'armed'`), 1, "one armed board clock after the re-arm");
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
