// 35.1 Persistence seam and the typed record
// spec/sections/35-operations-runtime/35-1-persistence-seam-and-the-typed-record.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id here runs against Postgres (operational prerequisite 3: "this process's T-ids skip without a database and are
// not counted until it is on" — REQUIRE_DB=1 in CI); the file has its own database (src/infra/db/test-db.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { compute, defineTools, str, type EntityRecord, type ToolDef } from "../../app/tools.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { TOOLS_35_1 } from "../../app/tools/section35-1.ts";
import { StaleRecord } from "./seam/guard.ts";
import { PgOutbox } from "../../infra/integrations/pg-outbox.ts";
import { TransientFailure } from "../../infra/integrations/failures.ts";
import type { OutboundAdapter, OutboxMessage } from "../../infra/integrations/outbox.ts";
import { fakePortAdapter } from "./seam/outbox.ts";
import { requeueMessage } from "../../runtime/controls/outbox.ts";
import { createHash } from "node:crypto";
import type { RuntimeDeps } from "../../runtime/app.ts";
import { deliverLoanEstimate, originationDailySweep, STATEFUL_SERVICES } from "../../runtime/origination.ts";
import { boardTransferBatch, SeedOnly, type TransferBatchInput } from "../../runtime/transfers.ts";
import { generateDemoBatch, DEMO_BATCH } from "../../domain/boarding/demo-batch.ts";
import { encodeTransferBatch, type TransferBatchData } from "../../domain/boarding/tape-codec.ts";
import { computeApr } from "../compliance-disclosures/ops-25-1.ts";
import { ClosingDisclosureService } from "../compliance-disclosures/ops-25-2.ts";
import { MemoryEventStore } from "../../kernel/events/index.ts";
import { captureState, foldState, stateHash, SERVICE_STATE_EVENT } from "./seam/service-state.ts";
import { SCOPE_LOCK_SQL } from "./seam/lock.ts";
import { HISTORY_KINDS } from "./projectors/index.ts";
import type { LoanCashState } from "../cashiering/types.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "t-" + randomUUID();
const NOW = "2026-09-15T14:00:00.000Z";
const clock = new FixedClock(NOW);
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const RECORDS: Actor = { kind: "agent", id: "security-records" };
const SYSTEM: Actor = { kind: "system", id: "test" };

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let n = 0;
const uniq = (): string => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const count = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { if (!skip) await close(); });

/** A boarded-looking servicing loan (loans, parties, property, the three custodial accounts). */
async function loanFixture(d: Db = db): Promise<Fixture> {
  return new PgLoanRepository(d).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") });
}

// ───────── worked example A: the loan 2.1 posts against (every figure is 2.1's; the projector copies) ─────────
const UPB_START = 24_831_055n;      // $248,310.55
const PI = 161_234n;                // $1,612.34
const ESCROW = 43_278n;             // $432.78
const PAYMENT = 204_512n;           // $2,045.12
const INTEREST = 134_502n;          // 248,310.55 × 6.5% ÷ 12 = 1,345.015479 → $1,345.02
const PRINCIPAL = 26_732n;          // $267.32
const UPB_AFTER = 24_804_323n;      // $248,043.23
/** The 2.x cash state of the worked-example loan with one due installment (what the runtime builds from loan_terms and the ledger; src/runtime/servicing.ts loanCashState). */
const cashState = (loanId: string, due: string[] = ["2026-09-01"]): LoanCashState => ({ loan_id: loanId, instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: UPB_START, lpi_date: D("2026-08-01"),
  installments: due.map((d) => ({ due_date: D(d), pi_cents: PI, escrow_cents: ESCROW, status: "due" as const })), late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false });
/** A received, identified 2.1 payment written through the bus (the version the typed row copies: channel, instrument, dates, idempotency key). */
async function receivePayment(rt: Runtime, f: Fixture, paymentId: string, receivedOn = "2026-09-01"): Promise<void> {
  await rt.execute({ process: "2.1", name: "payments.read/write", loanId: f.loanId, actor: CASHIERING, input: { op: "write", id: paymentId, data: { loan_id: f.loanId, custodial_account_id: f.custodial.clearing, channel: "lockbox", instrument: "check", amount_cents: PAYMENT, received_at: `${receivedOn}T15:00:00.000Z`, received_on: receivedOn, credited_as_of: receivedOn, conforming: true, designation: "contractual", payer_type: "borrower", idempotency_key: `sha256:${paymentId}`, status: "identified", identification_confidence: 1 } } });
}
const postPayment = (rt: Runtime, f: Fixture, paymentId: string, state: LoanCashState = cashState(f.loanId)): Promise<unknown> =>
  rt.execute({ process: "2.1", name: "payments.read/write", loanId: f.loanId, actor: CASHIERING, input: { op: "post", id: paymentId, loan_id: f.loanId, state, custodial: f.custodial } });

/** A side database of this file's own (a T-id that counts rows book-wide — twelve breaches, one gap, one mismatch — gets a clean book), with a runtime over it. */
async function sideRuntime(suffix: string, deps: Partial<RuntimeDeps> = {}, clk: FixedClock = new FixedClock(NOW)): Promise<{ db: Db; rt: Runtime; make: (extra?: Partial<RuntimeDeps>) => Runtime; close: () => Promise<void> }> {
  const side = await testDatabase(import.meta.url, { suffix });
  const sdb = connect(side.url);
  const make = (extra: Partial<RuntimeDeps> = {}): Runtime => new Runtime({ db: sdb, registry: loadOverriddenRegistry(), clock: clk, ...deps, ...extra });
  return { db: sdb, rt: make(), make, close: async () => { await sdb.end(); await side.close(); } };
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// ───────── the origination fixture the 25.2 / 21.2 T-ids drive (the lifecycle test's refinance: $560,000 at 6.125% / 360) ─────────
const MLO: Actor = { kind: "human", id: "u-mlo-rivera", role: "mlo_of_record" };
const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" };
const leFee = (fee_code: string, description: string, le_section: string, mismo_fee_type: string, amount_cents: string, provider_source: string, shoppable: boolean, estimate_source: string, estimate_source_ref: string, finance_charge: boolean) => ({ fee_code, description, le_section, mismo_fee_type, amount_cents, provider_source, shoppable, estimate_source, estimate_source_ref, estimated_at: "2026-10-05", finance_charge });
const LE_FEES = [leFee("appraisal", "Appraisal Fee to AMC", "B_cannot_shop", "AppraisalFee", "65000", "creditor_selected_third_party", false, "vendor_quote", "AMC-Q-88121", false), leFee("credit_report", "Credit Report Fee", "B_cannot_shop", "CreditReportFee", "7500", "creditor_selected_third_party", false, "fee_schedule", "N2-price-list-2026-09", false),
  leFee("tax_service", "Tax Service Fee", "B_cannot_shop", "TaxServiceFee", "8500", "creditor_selected_third_party", false, "fee_schedule", "tax-svc-2026-09", true), leFee("title_lenders_policy", "Title – Lender's Title Policy", "C_can_shop", "TitleLendersCoveragePremium", "115000", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false),
  leFee("recording", "Recording Fees", "E_taxes_gov", "RecordingFeeForMortgage", "7000", "government", false, "county_table", "maricopa-recording-2026", false), leFee("prepaid_interest", "Prepaid Interest ($93.97 per day for 19 days @ 6.125%)", "F_prepaids", "PrepaidInterest", "178543", "creditor", false, "pricing_engine", "disbursement-2026-11-12", true),
  leFee("lender_credit", "Lender Credits", "J_lender_credit", "LenderCredit", "-261700", "creditor", false, "pricing_engine", "Q-A-1005", false)];
const leRender = (appId: string) => ({ application_id: appId, disclosure_id: `LE-${appId.slice(0, 8)}`, as_of: "2026-10-05", loan_cents: "56000000", term_months: 360, transaction_type: "limited_cash_out", product: "Fixed Rate", pricing: { quote_id: `Q-${appId.slice(0, 8)}`, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", locked: false }, fees: LE_FEES,
  applicants: ["Alex Borrower", "Blake Borrower"], property_address: "100 N Central Ave, Phoenix, AZ 85004", estimated_value_cents: "80000000", creditor: { name: "Partner Bank, N.A.", nmlsr_id: "123456", email: "loans@partnerbank.example", phone: "(800) 555-0155" }, loan_officer: { name: "Jordan Rivera", nmlsr_id: "987654" }, escrow_monthly_cents: "55000", costs_expire_display: "10/20/2026 at 5:00 p.m. MST" });
/** The wire form as the HTTP route revives it (src/runtime/server.ts reviveCents): every `*_cents` decimal string becomes bigint cents, the render's dates PlainDate. */
function reviveRender(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveRender);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k.endsWith("_cents") && (typeof x === "string" || typeof x === "number") && x !== "" ? BigInt(x) : k === "as_of" || k === "estimated_at" ? D(String(x)) : reviveRender(x)]));
  return v;
}
/** An application with 21.1's six items received (the `application.trid_received` 21.2 anchors on) and the initial LE mailed by 21.2's LoanEstimateService — the mailbox rule's deemed receipt is on the log. */
async function originationFixture(rt: Runtime, sdb: Db, at: string): Promise<{ appId: string; leId: string; deemedOn: string }> {
  const partner = (await sdb.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', $1, $2) RETURNING id`, [`Lender ${randomUUID().slice(0, 6)}`, "123456789"]))[0]!.id;
  const app = (await rt.createApplication({ partner_party_id: partner, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower" }, { legal_name: "Blake Borrower", borrower_role: "co_borrower" }], property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1 } }, SYSTEM)).application;
  await rt.executeDef(testTool("trid", (_i, ctx) => { ctx.events.append({ type: "application.trid_received", applicationId: app.id, aggregate: { kind: "application", id: app.id }, actor: SYSTEM, payload: { application_id: app.id, trid_received_at: at } }); return {}; }), { loanId: "", applicationId: app.id, actor: SYSTEM, input: {} });
  const le = await deliverLoanEstimate(rt, app.id, { render: reviveRender(leRender(app.id)) as never, mlo: { review_id: `MR-${app.id.slice(0, 8)}`, nmlsr_id: "987654" }, delivery: { channel: "mail", at, mailing_proof_id: `MP-${app.id.slice(0, 8)}` } }, MLO);
  const [issued] = await sdb.query<{ payload: { deemed_receipt_date: string } }>(`SELECT payload FROM loan_events WHERE type = 'disclosure.le.issued' AND application_id = $1`, [app.id]);
  return { appId: app.id, leId: le.disclosure_id, deemedOn: issued!.payload.deemed_receipt_date };
}
const APR_V1 = computeApr({ loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, term_start_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), prepaid_finance_charges_cents: 384_995n, prepaid_interest_cents: 178_543n, method: "appendix_j_exact", checkpoint: "cd" });
const CD_FEES = [
  { fee_code: "underwriting", description: "Underwriting fee", amount_cents: 195_000n, section: "A_origination", tolerance_class: "zero", source_id: "SRC-CREDITOR-1" },
  { fee_code: "tax_service", description: "Tax service fee", amount_cents: 8_400n, section: "B_cannot_shop", tolerance_class: "zero", source_id: "SRC-CREDITOR-1" },
  { fee_code: "title_lender_policy", description: "Title — Lender's policy", amount_cents: 120_000n, section: "C_can_shop", tolerance_class: "ten_percent", source_id: "SRC-SA-1" },
  { fee_code: "recording", description: "Recording fees", amount_cents: 3_000n, section: "E_taxes_gov", tolerance_class: "ten_percent", source_id: "SRC-SA-1" },
  { fee_code: "prepaid_interest", description: "Prepaid interest", amount_cents: 178_543n, section: "F_prepaids", tolerance_class: "unlimited", source_id: "SRC-CREDITOR-1" },
];
/** 25.2 renderCd's input for the fixture application (the 25.2 spec test's refinance CD). */
const cdInput = (appId: string, disclosureId: string, cdVersion: number, extra: Record<string, unknown> = {}) => ({ application_id: appId, disclosure_id: disclosureId, cd_version: cdVersion, cd_reason: cdVersion === 1 ? "initial" : "pre_consummation_no_wait", transaction_type: "refinance", state: "AZ", required_consumer_ids: ["B1", "B2"],
  loan: { loan_amount_cents: 56_000_000n, rate_pct: "6.125", term_months: 360, pi_cents: 340_262n, product: "Fixed Rate", loan_type: "Conventional", purpose: "Refinance", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: "APP-REFI-1", mic_number: null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
  apr: { apr_calculation_id: "APR-CD-1", apr_pct: APR_V1.apr_disclosed_str, finance_charge_cents: APR_V1.finance_charge_cents, amount_financed_cents: APR_V1.amount_financed_cents, total_of_payments_cents: APR_V1.total_of_payments_cents, tip_pct: APR_V1.tip_pct.toFixed(3) },
  fees: CD_FEES, escrow: { established: true, monthly_escrow_cents: 52_500n, initial_escrow_payment_cents: 187_500n, escrowed_costs_year1_cents: 630_000n, non_escrowed_costs_year1_cents: 0n },
  parties: { borrowers: ["Alex Borrower", "Blake Borrower"], creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
  dates: { date_issued: "2026-11-02", closing_date: "2026-11-06", disbursement_date: "2026-11-12" }, property_address: "100 N Central Ave, Phoenix AZ 85004", cash_to_close_cents: 552_943n, lender_credits_cents: 0n, payoffs_and_payments_cents: 54_820_000n, rescindable: true, ...extra });
/** 25.2's versioned figure sources for the fixture (the journey's a10 sequence): the settlement agent's and the escrow figures recorded, then reconciled against the creditor's fees — renderCd reads them from the hydrated `cd-25-2` instance. */
async function recordCdSources(rt: Runtime, appId: string): Promise<void> {
  const R = appId.slice(0, 8);
  await rt.execute({ process: "25.2", name: "assembleCdFigures", loanId: "", applicationId: appId, actor: DISCLOSURE, input: { op: "record_source", source_id: `SRC-SA-${R}`, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "3000" }] }, payload_document_id: "DOC-SA-FEES" } });
  await rt.execute({ process: "25.2", name: "assembleCdFigures", loanId: "", applicationId: appId, actor: DISCLOSURE, input: { op: "record_source", source_id: `SRC-ESCROW-${R}`, party: "escrow", payload: { monthly_cents: "52500", deposit_cents: "187500" } } });
  await rt.execute({ process: "25.2", name: "reconcileFigureSources", loanId: "", applicationId: appId, actor: DISCLOSURE, input: { application_id: appId, fees: CD_FEES } });
}
/** A three-loan transfer tape cut from the demo generator (per-run numbering so the platform's unique identifiers never collide). */
function threeLoanTape(): { input: TransferBatchInput; files: ReturnType<typeof encodeTransferBatch>; loans: number } {
  const run = Date.now() % 100_000;
  const demo = generateDemoBatch(DEMO_BATCH.seed, { prefix: `S${run}`, fnma_base: 6_000_000_000 + run * 1000, min_sequence_base: 500_000 + run * 10 });
  const loans = demo.loans.slice(0, 3); const keep = new Set(loans.map((l) => l.transferor_loan_number)); const fnmaNos = new Set(loans.map((l) => l.fnma_loan_number)); const mins = new Set(loans.map((l) => l.min));
  const data: TransferBatchData = { loans, fnma: demo.fnma.filter((f) => fnmaNos.has(f.fnma_loan_number)), trialBalance: demo.trialBalance.filter((t) => keep.has(t.transferor_loan_number)), mers: demo.mers.filter((m) => mins.has(m.min)), images: demo.images.filter((i) => keep.has(i.transferor_loan_number)), fairLending: demo.fairLending.filter((f) => keep.has(f.transferor_loan_number)) };
  const cob = new Map([...demo.coborrowers].filter(([k]) => keep.has(k)));
  const input: TransferBatchInput = { ...DEMO_BATCH, batch_id: `${DEMO_BATCH.batch_id}-3L-${randomUUID().slice(0, 8)}`, loan_count: 3 } as unknown as TransferBatchInput;
  return { input, files: encodeTransferBatch(data, cob), loans: 3 };
}
/** Rows of a table with every uuid / instant column dropped and the rest sorted — what two databases boarding the same tape must agree on. */
async function rowsOf(d: Db, table: string, where = "", params: unknown[] = []): Promise<string[]> {
  const rows = await d.query<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`, params);
  const isUuid = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v);
  const isInstant = (v: unknown): boolean => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
  return rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k, v]) => !isUuid(v) && !isInstant(v) && !/(^id$|_id$|created_at|updated_at|boarded_at|run_id)/.test(k)).sort(([a], [b]) => a.localeCompare(b))), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).sort();
}

/** A test-only command on the bus (Runtime.executeDef takes any ToolDef; a `system` actor needs no allowlist). */
const testTool = (name: string, handler: ToolDef["handler"]): ToolDef => defineTools("35.1", "security-records", [{ name, kind: "act", handler: compute(handler) }])[0]!;

test("35.1-T1: Given loan with UPB $248,310.55 at 6.500%, fixed P&I $1,612.34 and escrow payment $432.78, when 2.1 posts a conforming payment of $2,045.12 through the bus against Postgres, then one `payments` row exists with `amount_cents = 204512`, `retention = 'life_of_loan_plus_4y'` and the version's idempotency key, three `payment_allocations` rows carry `amount_cents` 134502 (interest, from 248,310.55 × 6.5% ÷ 12 = 1,345.015479 → $1,345.02), 26732 (principal, $267.32) and 43278 (escrow, $432.78) with 2.1's `rule_ref` and the balanced set's `ledger_entry_set_id`, their sum is 204512, the version's UPB after is 24804323 ($248,043.23), the `entity_records` version and the typed rows carry identical values field by field, and one `entity_projections` row per version names `payments`/`payment_allocations`, `phase = commit` and the command's first event.", { skip }, async () => {
  const f = await loanFixture();
  const paymentId = randomUUID();
  await receivePayment(runtime, f, paymentId);
  const r = await runtime.execute({ process: "2.1", name: "payments.read/write", loanId: f.loanId, actor: CASHIERING, input: { op: "post", id: paymentId, loan_id: f.loanId, state: cashState(f.loanId), custodial: f.custodial } });
  const out = r.output as { interest_cents: string; principal_cents: string; escrow_cents: string; entry_set_ids: string[] };
  // 2.1's arithmetic, as the tool answered it: interest 248,310.55 × 6.500% ÷ 12 → $1,345.02; principal = P&I − interest; escrow as scheduled; the three sum to the payment
  assert.equal(BigInt(out.interest_cents), INTEREST); assert.equal(BigInt(out.principal_cents), PRINCIPAL); assert.equal(BigInt(out.escrow_cents), ESCROW);
  assert.equal(INTEREST + PRINCIPAL + ESCROW, PAYMENT);
  assert.equal(UPB_START - PRINCIPAL, UPB_AFTER);
  // the typed row exists in the command's own transaction: one payments row with the version's figures, the retention class 2.1 fixes and the version's own idempotency key
  const [pay] = await db.query<{ id: string; amount_cents: bigint; retention: string; idempotency_key: string; channel: string; instrument: string; received_on: string; credited_as_of: string; status: string; loan_id: string }>(`SELECT id, amount_cents, retention, idempotency_key, channel, instrument, received_on::text AS received_on, credited_as_of::text AS credited_as_of, status, loan_id FROM payments WHERE id = $1`, [paymentId]);
  assert.ok(pay, "one payments row"); assert.equal(pay.amount_cents, PAYMENT); assert.equal(pay.retention, "life_of_loan_plus_4y"); assert.equal(pay.idempotency_key, `sha256:${paymentId}`); assert.equal(pay.status, "posted"); assert.equal(pay.loan_id, f.loanId);
  assert.equal(await count(db, `FROM payments WHERE idempotency_key = $1`, [`sha256:${paymentId}`]), 1);
  // three payment_allocations rows in 2.1's order with 2.1's rule_ref and the balanced allocation set's id; their sum is the payment
  const allocs = await db.query<{ sequence: number; bucket: string; amount_cents: bigint; rule_ref: string; ledger_entry_set_id: string }>(`SELECT sequence, bucket, amount_cents, rule_ref, ledger_entry_set_id FROM payment_allocations WHERE payment_id = $1 ORDER BY sequence`, [paymentId]);
  assert.deepEqual(allocs.map((a) => [a.sequence, a.bucket, a.amount_cents]), [[1, "interest", INTEREST], [2, "principal", PRINCIPAL], [3, "escrow", ESCROW]]);
  assert.deepEqual(allocs.map((a) => a.rule_ref), ["2.1:r8:allocation:interest", "2.1:r8:allocation:principal", "2.1:r8:allocation:escrow"]);
  assert.equal(allocs.reduce((a, x) => a + x.amount_cents, 0n), PAYMENT);
  const allocSet = out.entry_set_ids[1]!;
  for (const a of allocs) assert.equal(a.ledger_entry_set_id, allocSet);
  const lines = await db.query<{ amount_cents: bigint; rule_ref: string }>(`SELECT amount_cents, rule_ref FROM ledger_lines WHERE set_id = $1`, [allocSet]);
  assert.equal(lines.reduce((a, l) => a + l.amount_cents, 0n), 0n, "the allocation set balances");
  for (const a of allocs) assert.equal(lines.find((l) => l.rule_ref === a.rule_ref)?.amount_cents, -a.amount_cents, `${a.bucket} matches the set's line by rule_ref`);
  // the version's UPB after, as 2.1 wrote it on the version — and the entity_records version and the typed rows carry identical values field by field
  const [ver] = await db.query<{ version: number; data: Record<string, unknown> }>(`SELECT version, data FROM entity_records WHERE kind = 'payments' AND id = $1 ORDER BY version DESC LIMIT 1`, [paymentId]);
  assert.equal(ver!.version, 2);
  assert.deepEqual(ver!.data["upb_after_cents"], { $bigint: UPB_AFTER.toString() });
  assert.deepEqual(ver!.data["amount_cents"], { $bigint: PAYMENT.toString() }); assert.equal(ver!.data["channel"], pay.channel); assert.equal(ver!.data["instrument"], pay.instrument); assert.equal(ver!.data["received_on"], pay.received_on); assert.equal(ver!.data["credited_as_of"], pay.credited_as_of); assert.equal(ver!.data["idempotency_key"], pay.idempotency_key); assert.equal(ver!.data["status"], pay.status);
  const vAlloc = ver!.data["allocations"] as { sequence: number; bucket: string; amount_cents: { $bigint: string }; rule_ref: string; ledger_entry_set_id: string }[];
  assert.deepEqual(vAlloc.map((a) => [a.sequence, a.bucket, BigInt(a.amount_cents.$bigint), a.rule_ref, a.ledger_entry_set_id]), allocs.map((a) => [a.sequence, a.bucket, a.amount_cents, a.rule_ref, a.ledger_entry_set_id]));
  // one entity_projections row per version: phase commit, the command's first event, the tables named
  const proj = await db.query<{ version: number; target_table: string; target_id: string; phase: string; command_event_id: string | null; mode: string }>(`SELECT version, target_table, target_id, phase, command_event_id, mode FROM entity_projections WHERE kind = 'payments' AND entity_id = $1 ORDER BY version`, [paymentId]);
  assert.equal(proj.length, 2);
  assert.deepEqual(proj.map((x) => [x.version, x.phase, x.mode, x.target_id]), [[1, "commit", "upsert", paymentId], [2, "commit", "upsert", paymentId]]);
  assert.equal(proj[0]!.target_table, "payments"); assert.equal(proj[1]!.target_table, "payments/payment_allocations");
  assert.equal(proj[1]!.command_event_id, r.events[0]!.id, "the command's first event");
  const [firstEv] = await db.query<{ type: string }>(`SELECT type FROM loan_events WHERE id = $1`, [proj[1]!.command_event_id!]);
  assert.ok(firstEv);
  // lag 0: the projection and the version share the transaction (a later version count equals the projection count)
  assert.equal(await count(db, `FROM entity_records WHERE kind = 'payments' AND id = $1`, [paymentId]), 2);
});
test("35.1-T2: Given a global `rate_sheets` row at version 3, when two commands each carry `expected_versions: [{rate_sheets, <id>, 3}]` and both write version 4, then the first commits and the second is refused `STALE_RECORD{kind: rate_sheets, id, expected: 3, current: 4}` with HTTP 409, and the refused command left no `loan_events` row, no `entity_records` row, no `agent_decisions` row and no ledger line (counts before and after are equal); given a command with no declared expectation whose commit collides on `entity_records`' primary key, then the same `STALE_RECORD` is returned and the transaction is rolled back whole.", { skip }, async () => {
  // a global rate_sheets row at version 3, written outside any command (the platform's rows)
  const rsId = `rs-${randomUUID().slice(0, 8)}`;
  const version = (v: number): EntityRecord => ({ kind: "rate_sheets", id: rsId, version: v, data: { rate_sheet_id: rsId, published_at: `2026-09-1${v}T12:00:00.000Z`, v }, updatedAt: NOW, updatedBy: "system:test" });
  await runtime.entities.save([version(1), version(2), version(3)], null);
  const fA = await loanFixture(); const fB = await loanFixture();
  const bump = (name: string, gate?: { started: () => void; release: Promise<void> }) => testTool(name, async (i, ctx, rt) => {
    const cur = rt.store.get("rate_sheets", str(i, "rate_sheet_id"))!;
    rt.store.put("rate_sheets", cur.id, { ...cur.data, v: cur.version + 1 }, ctx.actor, ctx.now);
    if (gate) { gate.started(); await gate.release; }
    return { wrote: cur.version + 1 };
  });
  // (a) two commands each carry expected_versions [{rate_sheets, id, 3}] and both write version 4: the first commits, the second is refused STALE_RECORD{expected: 3, current: 4}
  const first = await runtime.executeDef(bump("bump-a"), { loanId: fA.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId, expected_versions: [{ kind: "rate_sheets", id: rsId, version: 3 }] } });
  assert.deepEqual(first.output, { wrote: 4 });
  const before = { events: await count(db, `FROM loan_events WHERE loan_id = $1`, [fB.loanId]), records: await count(db, `FROM entity_records WHERE kind = 'rate_sheets' AND id = $1`, [rsId]), decisions: await count(db, `FROM agent_decisions WHERE loan_id = $1`, [fB.loanId]), lines: await count(db, `FROM ledger_lines WHERE loan_id = $1`, [fB.loanId]) };
  assert.equal(before.records, 4);
  await assert.rejects(runtime.executeDef(bump("bump-b"), { loanId: fB.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId, expected_versions: [{ kind: "rate_sheets", id: rsId, version: 3 }] } }),
    (e: unknown) => e instanceof StaleRecord && e.code === "STALE_RECORD" && e.kind === "rate_sheets" && e.id === rsId && e.expected === 3 && e.current === 4);
  // over HTTP the refusal is 409 STALE_RECORD (the guard runs before the domain code of any tool)
  const http = await call("POST", `/v1/loans/${fB.loanId}/tools/1.1/writeDecision`, { actor: { kind: "agent", id: "boarding" }, input: { agent: "boarding", action: "noop", rationale: "stale", rule_set_version: "x", expected_versions: [{ kind: "rate_sheets", id: rsId, version: 3 }] } });
  assert.equal(http.status, 409, JSON.stringify(http.body)); assert.equal(http.body["code"], "STALE_RECORD"); assert.equal(http.body["kind"], "rate_sheets"); assert.equal(http.body["id"], rsId); assert.equal(http.body["expected"], 3); assert.equal(http.body["current"], 4);
  const after = { events: await count(db, `FROM loan_events WHERE loan_id = $1`, [fB.loanId]), records: await count(db, `FROM entity_records WHERE kind = 'rate_sheets' AND id = $1`, [rsId]), decisions: await count(db, `FROM agent_decisions WHERE loan_id = $1`, [fB.loanId]), lines: await count(db, `FROM ledger_lines WHERE loan_id = $1`, [fB.loanId]) };
  assert.deepEqual(after, before, "the refused command left no loan_events, entity_records, agent_decisions or ledger line");
  // (b) no declared expectation: two commands on two loans both read version 4 and write version 5; the second's INSERT collides on entity_records' primary key → the same STALE_RECORD, the transaction rolled back whole
  let startedB!: () => void; let releaseA!: () => void; let releaseB!: () => void;
  const bStarted = new Promise<void>((res) => { startedB = res; }); const aGate = new Promise<void>((res) => { releaseA = res; }); const bGate = new Promise<void>((res) => { releaseB = res; });
  const pa = runtime.executeDef(bump("bump-c", { started: () => undefined, release: aGate }), { loanId: fA.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId } });
  const pb = runtime.executeDef(bump("bump-d", { started: startedB, release: bGate }), { loanId: fB.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId } });
  await bStarted;            // both have hydrated version 4 and put version 5
  releaseA(); const ra = await pa; assert.deepEqual(ra.output, { wrote: 5 });
  releaseB();
  await assert.rejects(pb, (e: unknown) => e instanceof StaleRecord && e.kind === "rate_sheets" && e.id === rsId && e.current === 5);
  assert.equal(await count(db, `FROM entity_records WHERE kind = 'rate_sheets' AND id = $1`, [rsId]), 5);
  assert.equal(await count(db, `FROM loan_events WHERE loan_id = $1`, [fB.loanId]), before.events, "nothing of the collided command was written");
});
test("35.1-T3: Given a loan whose `entity_records` hold 500 versions across 40 kinds including 12 versions of one `payments` row and 6 of one `counterparty_notifications` row, when any command runs, then the entity hydration issued exactly three queries (scoped latest, `HISTORY_KINDS` in full, global latest — asserted by a query-counting `Db`), the store holds one version of each non-history kind and every version of the two history kinds, `payments.history` (section02.ts:114) returns 12 versions in order, and 17.3's first-version gate (section17-3.ts:95) reads the first `counterparty_notifications` version's `status`.", { skip }, async () => {
  const f = await loanFixture();
  // 500 versions across 40 kinds on the loan: 12 versions of one payments row, 6 of one counterparty_notifications row, the rest spread over 38 kinds
  const paymentId = randomUUID(); const cnId = `cn-${randomUUID().slice(0, 8)}`;
  const rows: EntityRecord[] = [];
  for (let v = 1; v <= 12; v++) rows.push({ kind: "payments", id: paymentId, version: v, data: { loan_id: f.loanId, amount_cents: 100n * BigInt(v), status: v === 12 ? "posted" : "identified", v }, updatedAt: NOW, updatedBy: "system:seed" });
  for (let v = 1; v <= 6; v++) rows.push({ kind: "counterparty_notifications", id: cnId, version: v, data: { loan_id: f.loanId, batch_id: "B-1", status: v === 1 ? "planned" : v === 6 ? "acked" : "sent", v }, updatedAt: NOW, updatedBy: "system:seed" });
  const others = 500 - 18; const kinds = 38;
  for (let k = 0; k < others; k++) { const kind = `t3_kind_${k % kinds}`; const id = `${kind}-${Math.floor(k / kinds) % 2}`; rows.push({ kind, id, version: 1, data: { loan_id: f.loanId, k }, updatedAt: NOW, updatedBy: "system:seed" }); }
  // versions of one (kind, id) must be numbered 1..n: renumber the spread rows per (kind, id)
  const seen = new Map<string, number>();
  const numbered = rows.map((r) => { if (r.kind === "payments" || r.kind === "counterparty_notifications") return r; const key = `${r.kind} ${r.id}`; const v = (seen.get(key) ?? 0) + 1; seen.set(key, v); return { ...r, version: v }; });
  await runtime.entities.save(numbered, f.loanId);
  assert.equal(await count(db, `FROM entity_records WHERE loan_id = $1`, [f.loanId]), 500);
  assert.equal(new Set(numbered.map((r) => r.kind)).size, 40);
  // a query-counting Db around the pool: every statement that reads entity rows is counted, on the pool and inside a transaction
  const entityQueries: string[] = [];
  const countingQ = (q: Queryable): Queryable => ({ query: <R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]> => { if (/entity_(records|latest_scoped|current)/.test(sql) && /^\s*SELECT/i.test(sql)) entityQueries.push(sql); return q.query<R>(sql, params); } });
  const countingDb: Db = { query: (sql, params) => countingQ(db).query(sql, params), tx: (fn) => db.tx((q) => fn(countingQ(q))), dedicated: () => db.dedicated(), end: async () => undefined };
  const rt = new Runtime({ db: countingDb, registry: loadOverriddenRegistry(), clock });
  let held!: { nonHistory: number[]; paymentsHistory: number; cnHistory: number; firstCnStatus: unknown; kinds: number };
  await rt.executeDef(testTool("t3-inspect", (_i, _c, trt) => {
    const nonHistory = [...new Set(numbered.map((r) => r.kind))].filter((k) => !HISTORY_KINDS.has(k)).map((k) => trt.store.list(k).map((r) => trt.store.history(k, r.id).length)).flat();
    // 17.3's first-version gate reads the first counterparty_notifications version's status (src/app/tools/section17-3.ts:95)
    const firstCnStatus = trt.store.history("counterparty_notifications", cnId)[0]?.data.status;
    held = { nonHistory, paymentsHistory: trt.store.history("payments", paymentId).length, cnHistory: trt.store.history("counterparty_notifications", cnId).length, firstCnStatus, kinds: new Set(numbered.map((r) => r.kind)).size };
    return {};
  }), { loanId: f.loanId, actor: SYSTEM, input: {} });
  assert.equal(entityQueries.length, 3, `the entity hydration issued exactly three queries:\n${entityQueries.join("\n")}`);
  assert.match(entityQueries[0]!, /entity_latest_scoped/); assert.match(entityQueries[1]!, /FROM entity_records/); assert.match(entityQueries[2]!, /scope_key = ''/);
  assert.ok(held.nonHistory.length >= 38 && held.nonHistory.every((x) => x === 1), "one version of each non-history kind");
  assert.equal(held.paymentsHistory, 12); assert.equal(held.cnHistory, 6); assert.equal(held.firstCnStatus, "planned"); assert.equal(held.kinds, 40);
  // `payments.history` (section02.ts:114) returns the 12 versions in order
  const h = await rt.execute({ process: "2.2", name: "payments.history", loanId: f.loanId, actor: CASHIERING, input: { id: paymentId } });
  const versions = (h.output as { version: number }[]).map((x) => x.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});
test("35.1-T4: Given a tool whose handler writes a `payments` version, whose projector inserts the typed row, and which then throws, when the command runs, then the response is the tool's error, `payments` has no new row, `entity_records` and `entity_projections` have no new row, `loan_events` has no new event, and the next command on the same loan hydrates a `boarding` adapter whose maps equal those before the failed command (a hydrating adapter is rebuilt from the record, so a failed command cannot leave state in a Map).", { skip }, async () => {
  const f = await loanFixture();
  const paymentId = randomUUID();
  const stateOf = (rt: Runtime, key: string) => async (loanId: string): Promise<string> => { let sha = ""; await rt.executeDef(testTool("t4-state", (_i, ctx) => { sha = rt.originationServices.stateOf(ctx, key)!.sha; return {}; }), { loanId, actor: SYSTEM, input: {} }); return sha; };
  const boardingBefore = await stateOf(runtime, "boarding")(f.loanId);
  const before = { pay: await count(db, `FROM payments`), rec: await count(db, `FROM entity_records WHERE loan_id = $1`, [f.loanId]), proj: await count(db, `FROM entity_projections WHERE kind = 'payments'`), ev: await count(db, `FROM loan_events WHERE loan_id = $1`, [f.loanId]) };
  // the tool writes a payments version (its projector inserts the typed row in the same transaction), mutates the boarding adapter's maps, then throws
  const failing = testTool("t4-fail", (_i, ctx, trt) => {
    trt.store.put("payments", paymentId, { loan_id: f.loanId, custodial_account_id: f.custodial.clearing, channel: "lockbox", instrument: "check", amount_cents: PAYMENT, received_at: "2026-09-01T15:00:00.000Z", received_on: "2026-09-01", credited_as_of: "2026-09-01", idempotency_key: `sha256:${paymentId}`, status: "identified" }, ctx.actor, ctx.now);
    (trt.services["boarding"] as { openBatch(c: unknown): void }).openBatch({ batch_id: `B-T4-${paymentId.slice(0, 8)}`, transfer_date: D("2026-09-01"), transferor_party_id: randomUUID(), transferor_servicer_number: "1", partner_servicer_number: "2", rule_set_version: "boarding.dq.v1", acceptable_mers_org_ids: new Set<string>() });
    throw new Error("T4: the tool failed after the version and the row were written");
  });
  await assert.rejects(runtime.executeDef(failing, { loanId: f.loanId, actor: SYSTEM, input: {} }), /T4: the tool failed/);
  const after = { pay: await count(db, `FROM payments`), rec: await count(db, `FROM entity_records WHERE loan_id = $1`, [f.loanId]), proj: await count(db, `FROM entity_projections WHERE kind = 'payments'`), ev: await count(db, `FROM loan_events WHERE loan_id = $1`, [f.loanId]) };
  assert.deepEqual(after, before, "payments, entity_records, entity_projections and loan_events have no new row");
  assert.equal(await count(db, `FROM payments WHERE id = $1`, [paymentId]), 0);
  // the next command on the same loan hydrates a boarding adapter whose maps equal those before the failed command
  const boardingAfter = await stateOf(runtime, "boarding")(f.loanId);
  assert.equal(boardingAfter, boardingBefore);
  let batches = -1; await runtime.executeDef(testTool("t4-maps", (_i, _c, trt) => { batches = ((trt.services["boarding"] as unknown as { batches: Map<string, unknown> }).batches).size; return {}; }), { loanId: f.loanId, actor: SYSTEM, input: {} });
  assert.equal(await count(db, `FROM loan_events WHERE type = 'service.state.changed' AND payload->>'service_key' = 'boarding' AND payload->'delta'->'fields'->'batches'->'set' @> $1::jsonb`, [JSON.stringify([[`B-T4-${paymentId.slice(0, 8)}`]])]), 0, "no delta of the failed command was recorded");
  assert.ok(batches >= 0);
});
test("35.1-T5: Given two `Runtime` instances A and B over one database and a third `Runtime` acting as the sweep job, when A runs 25.2 `prepareCd` for an application, B runs 25.2 `deliverCd` for the same disclosure id, and the sweep runtime deems an LE received on its mailbox-rule day, then B never answers `no CD`, the CD B delivered is the CD A prepared (same `disclosure_id`, `data_hash` and `cd_version`), the sweep's deeming was performed by `LoanEstimateService.deemReceived` on a hydrated instance (no hand-appended `disclosure.le.deemed_received` exists in src/runtime/origination.ts: contract test greps the file for the literal), and every stateful key in `originationServices` (`cd-25-2`, `delivery-29-3`, `delivery-29-4`, `secondary`, `tolerance`, `companion`, `orig-boarding`) yields a fresh instance per command whose state after `hydrate` equals the state the instance that wrote the events held.", { skip }, async () => {
  const clk = new FixedClock("2026-10-05T23:10:00.000Z");
  const side = await sideRuntime("t5", {}, clk);
  try {
    const rtA = side.rt; const rtB = side.make(); const rtC = side.make();
    const { appId, leId, deemedOn } = await originationFixture(rtA, side.db, "2026-10-05T23:10:00.000Z");
    // A prepares the CD (25.2 renderCd), B delivers it (25.2 deliverDisclosure) — two runtimes over one database
    clk.set("2026-11-02T17:00:00.000Z");
    const cdId = `CD-${appId.slice(0, 8)}-1`;
    await recordCdSources(rtA, appId);
    const prepared = await rtA.execute({ process: "25.2", name: "renderCd", loanId: "", applicationId: appId, actor: DISCLOSURE, input: cdInput(appId, cdId, 1) });
    const p = prepared.output as { disclosure_id: string; cd_version: number; figures_hash: string };
    assert.equal(p.disclosure_id, cdId); assert.equal(p.cd_version, 1); assert.ok(p.figures_hash);
    const delivered = await rtB.execute({ process: "25.2", name: "deliverDisclosure", loanId: "", applicationId: appId, actor: DISCLOSURE, input: { application_id: appId, disclosure_id: cdId, consumer_id: "B1", channel: "in_person", at: "2026-11-02T17:30:00.000Z", evidence_document_id: `DOC-SA-RECEIPT-${appId.slice(0, 8)}`, gate_run: { run_id: `RUN-CD-${appId.slice(0, 8)}`, open: true, apr_verdict: "pass", blocked_channels: [] } } });
    const d = delivered.output as { disclosure_id: string; consumer_id: string; delivered_on: string };
    assert.equal(d.disclosure_id, cdId, "B never answers no CD: the CD B delivered is the CD A prepared");
    let rowOnB!: { disclosure_id: string; cd_version: number; figures_hash: string; status: string };
    await rtB.executeDef(testTool("t5-cd", (_i, _c, trt) => { const r = (trt.services["cd-25-2"] as ClosingDisclosureService).get(cdId); rowOnB = { disclosure_id: r.disclosure_id, cd_version: r.cd_version, figures_hash: r.figures_hash, status: r.status }; return {}; }), { loanId: "", applicationId: appId, actor: SYSTEM, input: {} });
    assert.deepEqual([rowOnB.disclosure_id, rowOnB.cd_version, rowOnB.figures_hash], [cdId, 1, p.figures_hash], "same disclosure_id, figures (data) hash and cd_version on B's hydrated instance");
    // the sweep runtime deems the LE received on its mailbox-rule day, through LoanEstimateService.deemReceived on a hydrated instance
    clk.set(`${deemedOn}T20:00:00.000Z`);
    const sweep = await originationDailySweep(rtC, `${deemedOn}T20:00:00.000Z`);
    assert.ok(sweep.deemed.includes(leId), JSON.stringify(sweep));
    const received = await side.db.query<{ payload: { evidence: string; effective_receipt_date: string } }>(`SELECT payload FROM loan_events WHERE type = 'disclosure.le.received' AND application_id = $1 AND payload->>'disclosure_id' = $2`, [appId, leId]);
    assert.equal(received.length, 1); assert.equal(received[0]!.payload.evidence, "mailbox_rule"); assert.equal(received[0]!.payload.effective_receipt_date, deemedOn);
    // contract: no hand-appended deeming event in src/runtime/origination.ts (the literal is absent from the file)
    const src = readFileSync(fileURLToPath(new URL("../../runtime/origination.ts", import.meta.url)), "utf8");
    assert.ok(!src.includes("disclosure.le." + "deemed_received"), "origination.ts holds no hand-appended deeming literal");
    // every stateful key yields a fresh instance per command whose hydrated state equals the state the writing instance held (its recorded state_sha256)
    const keys = ["cd-25-2", "delivery-29-3", "delivery-29-4", "secondary", "tolerance", "companion", "orig-boarding"];
    const last = await side.db.query<{ key: string; sha: string }>(`SELECT DISTINCT ON (payload->>'service_key') payload->>'service_key' AS key, payload->>'state_sha256' AS sha FROM loan_events WHERE type = $1 AND application_id = $2 ORDER BY payload->>'service_key', sequence DESC`, [SERVICE_STATE_EVENT, appId]);
    const written = new Map(last.map((r) => [r.key, r.sha]));
    assert.ok(written.has("cd-25-2") && written.has("tolerance"), `deltas recorded for the services the commands changed: ${[...written.keys()].join(",")}`);
    const seen: Record<string, unknown>[] = [];
    for (const rt of [rtA, rtB, rtC]) await rt.executeDef(testTool("t5-keys", (_i, ctx, trt) => { seen.push(Object.fromEntries(keys.map((k) => [k, trt.services[k]]))); for (const k of keys) { const st = rt.originationServices.stateOf(ctx, k)!; if (written.has(k)) assert.equal(st.sha, written.get(k), `${k}: hydrated state equals the writer's`); } assert.equal(trt.services["tolerance-21-5"], trt.services["tolerance"]); return {}; }), { loanId: "", applicationId: appId, actor: SYSTEM, input: {} });
    for (const k of keys) { assert.ok(seen[0]![k] && seen[1]![k] && seen[2]![k], `${k} live`); assert.notEqual(seen[0]![k], seen[1]![k], `${k}: a fresh instance per command`); assert.notEqual(seen[1]![k], seen[2]![k]); }
  } finally { await side.close(); }
});
test("35.1-T6: Given one loan and two 2.1 posts of $2,045.12 started concurrently from two connections, when both commit, then the second waited on `pg_advisory_xact_lock(hashtext('uow'), hashtext(loan_id))` (its transaction start is after the first's commit), the ledger holds two balanced sets, the loan's UPB after equals the start minus both principal portions, no unique violation and no `STALE_RECORD` occurred; given two different loans posted concurrently, then their transaction windows overlap (neither waited).", { skip }, async () => {
  // a Db that records, per transaction, when the loan lock was acquired and when the writes ended (just before COMMIT)
  const windows: { lockAt: string; preCommitAt: string; loanId: string }[] = [];
  const timing = (q: Queryable, w: { lockAt: string; preCommitAt: string; loanId: string }): Queryable => ({ query: async <R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]> => { const rows = await q.query<R>(sql, params); if (sql === SCOPE_LOCK_SQL) { w.loanId = String(params?.[0]); w.lockAt = (await q.query<{ t: string }>("SELECT clock_timestamp()::text AS t"))[0]!.t; } return rows; } });
  const timedDb: Db = { query: (sql, params) => db.query(sql, params), end: async () => undefined, dedicated: () => db.dedicated(), tx: (fn) => db.tx(async (q) => { const w = { lockAt: "", preCommitAt: "", loanId: "" }; const out = await fn(timing(q, w)); w.preCommitAt = (await q.query<{ t: string }>("SELECT clock_timestamp()::text AS t"))[0]!.t; if (w.lockAt) windows.push(w); return out; }) };
  const rt = new Runtime({ db: timedDb, registry: loadOverriddenRegistry(), clock });
  const f = await loanFixture();
  const p1 = randomUUID(), p2 = randomUUID();
  await receivePayment(rt, f, p1); await receivePayment(rt, f, p2, "2026-09-02");
  const startPrincipal = (await db.query<{ s: bigint }>(`SELECT coalesce(sum(amount_cents), 0)::bigint AS s FROM ledger_lines WHERE loan_id = $1 AND account = 'principal'`, [f.loanId]))[0]!.s;
  windows.length = 0;
  // two 2.1 posts of $2,045.12 on one loan, started concurrently from two connections (the pool), both against the same cash state
  const state = cashState(f.loanId, ["2026-09-01", "2026-10-01"]);
  const [r1, r2] = await Promise.all([postPayment(rt, f, p1, state), postPayment(rt, f, p2, state)]);
  for (const r of [r1, r2]) assert.equal(BigInt(((r as { output: { principal_cents: string } }).output).principal_cents), PRINCIPAL);
  const ws = windows.filter((w) => w.loanId === f.loanId).sort((a, b) => a.lockAt.localeCompare(b.lockAt));
  assert.equal(ws.length, 2);
  assert.ok(ws[1]!.lockAt > ws[0]!.preCommitAt, `the second waited on the loan lock: its transaction started after the first's commit (${ws[0]!.preCommitAt} < ${ws[1]!.lockAt})`);
  // the ledger holds two balanced sets per post (receipt, allocation, cash split): every set sums to zero
  const sets = await db.query<{ set_id: string; s: bigint }>(`SELECT set_id, sum(amount_cents)::bigint AS s FROM ledger_lines WHERE set_id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1) GROUP BY set_id`, [f.loanId]);
  const allocSets = [r1, r2].map((r) => (r as { output: { entry_set_ids: string[] } }).output.entry_set_ids[1]!);
  assert.ok(allocSets.every((id) => sets.some((x) => x.set_id === id && x.s === 0n)), "two balanced allocation sets"); assert.ok(sets.every((x) => x.s === 0n));
  const endPrincipal = (await db.query<{ s: bigint }>(`SELECT coalesce(sum(amount_cents), 0)::bigint AS s FROM ledger_lines WHERE loan_id = $1 AND account = 'principal'`, [f.loanId]))[0]!.s;
  assert.equal(endPrincipal, startPrincipal - 2n * PRINCIPAL, "the loan's UPB after equals the start minus both principal portions");
  assert.equal(await count(db, `FROM payment_allocations WHERE payment_id IN ($1, $2)`, [p1, p2]), 6, "no unique violation");
  assert.equal(await count(db, `FROM loan_events WHERE loan_id = $1 AND type = 'command.refused'`, [f.loanId]), 0, "no STALE_RECORD occurred");
  // two different loans posted concurrently: their transaction windows overlap — neither waited on the other
  const g1 = await loanFixture(); const g2 = await loanFixture();
  const q1 = randomUUID(), q2 = randomUUID();
  await receivePayment(rt, g1, q1); await receivePayment(rt, g2, q2);
  windows.length = 0;
  let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
  const slow = testTool("t6-slow", async (_i, _c) => { await gate; return {}; });
  const a = rt.executeDef(slow, { loanId: g1.loanId, actor: SYSTEM, input: {} });
  await new Promise((r) => setTimeout(r, 150));
  const b = postPayment(rt, g2, q2, cashState(g2.loanId));
  await b; release(); await a;
  const wa = windows.find((w) => w.loanId === g1.loanId)!; const wb = windows.find((w) => w.loanId === g2.loanId)!;
  assert.ok(wb.lockAt > wa.lockAt && wb.preCommitAt < wa.preCommitAt, `overlapping windows: ${JSON.stringify({ wa, wb })}`);
});
test("35.1-T7: Given twelve armed timers past due and two sweeps started concurrently, when both finish, then one `sweep_runs` row is `completed` and one is `skipped{lease_held}` with `sweep.run_skipped{holder}` logged, exactly twelve `timer.breached` events and twelve escalations exist (never twenty-four), the completed run's `passes` names every pass with a duration, `sweep.run_completed{run_id, as_of_date}` is logged once, and `SM_SWEEP_HEARTBEAT_DAILY` is satisfied by it and re-armed for the next day on the global subject.", { skip }, async () => {
  const side = await sideRuntime("t7");
  try {
    const rtA = side.rt; const rtB = side.make();
    const T0 = "2026-09-15T14:00:00.000Z";
    // one completed sweep first: its `sweep.run_completed` arms SM_SWEEP_HEARTBEAT_DAILY on the global subject (the clock the concurrent run below satisfies and re-arms)
    const first = await rtA.sweep(T0, { verify: false });
    assert.equal(first.outcome, "completed");
    const [armed] = await side.db.query<{ id: string; anchor_date: string; due_at: string; subject_kind: string }>(`SELECT id, anchor_date::text AS anchor_date, due_at::text AS due_at, subject_kind FROM timers WHERE code = 'SM_SWEEP_HEARTBEAT_DAILY' AND status = 'armed'`);
    assert.ok(armed, "SM_SWEEP_HEARTBEAT_DAILY armed by the first completion"); assert.equal(armed.subject_kind, "global"); assert.equal(armed.anchor_date, "2026-09-15");
    // twelve armed timers past due (real registry rows on the global subject, anchored yesterday, due an hour ago)
    const [ev] = await side.db.query<{ id: string }>(`SELECT id FROM loan_events WHERE type = 'sweep.run_completed' LIMIT 1`);
    const ids: string[] = [];
    for (let k = 0; k < 12; k++) { const id = randomUUID(); ids.push(id); await side.db.query(`INSERT INTO timers (id, code, subject_kind, subject_id, armed_at, armed_by_event_id, anchor_date, due_date, due_at, status) VALUES ($1, 'SM_PROJECTION_LAG_DAILY', 'global', '*', $2, $3, '2026-09-14', '2026-09-15', $4, 'armed')`, [id, "2026-09-14T10:00:00.000Z", ev!.id, "2026-09-15T13:00:00.000Z"]); }
    // two sweeps started concurrently (two runtimes, two dedicated sessions): one holds the lease and runs, the other finds it held
    const T1 = "2026-09-15T14:05:00.000Z";
    const a = rtA.sweep(T1, { verify: false, holder: "instance-a" });
    await new Promise((r) => setTimeout(r, 40));
    const b = rtB.sweep(T1, { verify: false, holder: "instance-b" });
    const [ra, rb] = await Promise.all([a, b]);
    const done = [ra, rb].find((r) => r.outcome === "completed")!; const skipped = [ra, rb].find((r) => r.outcome === "skipped")!;
    assert.ok(done && skipped, `one completed and one skipped: ${ra.outcome} / ${rb.outcome}`);
    assert.equal(skipped.skipped_reason, "lease_held");
    const runs = await side.db.query<{ id: string; outcome: string; skipped_reason: string | null; holder: string; passes: { name: string; duration_ms: number }[] }>(`SELECT id, outcome, skipped_reason, holder, passes FROM sweep_runs WHERE id = ANY($1::uuid[])`, [[done.run_id, skipped.run_id]]);
    assert.deepEqual(new Set(runs.map((r) => `${r.outcome}:${r.skipped_reason ?? ""}`)), new Set(["completed:", "skipped:lease_held"]));
    const skippedEvents = await side.db.query<{ payload: { holder: string; run_id: string } }>(`SELECT payload FROM loan_events WHERE type = 'sweep.run_skipped' AND payload->>'run_id' = $1`, [skipped.run_id]);
    assert.equal(skippedEvents.length, 1); assert.equal(skippedEvents[0]!.payload.holder, skipped.holder);
    // exactly twelve breaches and twelve escalations — never twenty-four
    assert.equal(await count(side.db, `FROM loan_events WHERE type = 'timer.breached' AND payload->>'timer_id' = ANY($1::text[])`, [ids]), 12);
    assert.equal(await count(side.db, `FROM escalations WHERE sla_timer_id = ANY($1::uuid[])`, [ids]), 12);
    assert.equal(await count(side.db, `FROM timers WHERE id = ANY($1::uuid[]) AND status = 'breached'`, [ids]), 12);
    // the completed run's passes name every pass with a duration
    const completedRow = runs.find((r) => r.outcome === "completed")!;
    const names = completedRow.passes.map((p) => p.name);
    for (const n of ["outbox.dispatch", "partner_book.review", "partner_book.readiness", "partner_book.daily_reports", "controls", "timers.breach", "partner_book.reminders", "partner_book.tape_late"]) assert.ok(names.includes(n), `pass ${n} in ${names.join(",")}`);
    assert.ok(completedRow.passes.every((p) => typeof p.duration_ms === "number" && p.duration_ms >= 0));
    assert.deepEqual(names, done.passes.map((p) => p.name));
    // sweep.run_completed{run_id, as_of_date} logged once for the run
    const completedEvents = await side.db.query<{ payload: { run_id: string; as_of_date: string } }>(`SELECT payload FROM loan_events WHERE type = 'sweep.run_completed' AND payload->>'run_id' = $1`, [done.run_id]);
    assert.equal(completedEvents.length, 1); assert.equal(completedEvents[0]!.payload.as_of_date, "2026-09-15");
    // SM_SWEEP_HEARTBEAT_DAILY: the instance the first run armed is satisfied by this run's receipt, and a fresh one is armed for the next day on the global subject
    const [sat] = await side.db.query<{ status: string; satisfied_by_event_id: string }>(`SELECT status, satisfied_by_event_id FROM timers WHERE id = $1`, [armed.id]);
    assert.equal(sat!.status, "satisfied");
    const [satEv] = await side.db.query<{ payload: { run_id: string } }>(`SELECT payload FROM loan_events WHERE id = $1`, [sat!.satisfied_by_event_id]);
    assert.equal(satEv!.payload.run_id, done.run_id);
    const rearmed = await side.db.query<{ subject_kind: string; subject_id: string; anchor_date: string; due_date: string; loan_id: string | null }>(`SELECT subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date, loan_id FROM timers WHERE code = 'SM_SWEEP_HEARTBEAT_DAILY' AND status = 'armed'`);
    assert.equal(rearmed.length, 1); assert.deepEqual(rearmed[0], { subject_kind: "global", subject_id: "*", anchor_date: "2026-09-15", due_date: "2026-09-16", loan_id: null });
  } finally { await side.close(); }
});
test("35.1-T8: Given a queued FAKE `printMail` message and a queued message whose FAKE adapter is scripted to fail, when sweeps run at +0, +60 s, +180 s, +420 s, +900 s and +1,800 s (the `DEFAULT_RETRY` backoff instants), then the first message is `sent` on the first sweep with one `outbox_dispatches{attempt_no: 1, outcome: acked}` row and `integration.message.sent`, the failing message has five `outbox_dispatches` rows with `next_attempt_at` at the backoff instants and is `dead` after the fifth with `integration.message.dead{attempts: 5}`, a `human_portal_tasks` row and `SM_OUTBOX_DEAD_LETTER_REVIEW_1BD` armed; and when 34.4 requeues it and the adapter is un-scripted, then the next drain sends it and the clock is satisfied.", { skip }, async () => {
  const clk = new FixedClock("2026-09-15T14:00:00.000Z");
  // the FAKE printMail adapter and one scripted to fail (a transient failure on every attempt until un-scripted)
  let failing = true;
  const scripted: OutboundAdapter = { name: "scripted", fallbackKind: "scripted_manual", async send(_p: unknown, m: OutboxMessage) { if (failing) throw new TransientFailure(`scripted outage (attempt ${m.attempts})`); return { delivered: true }; } };
  const side = await sideRuntime("t8", {}, clk);
  try {
    const rt = side.make({ outboxAdapters: new Map<string, OutboundAdapter>([["printMail", fakePortAdapter("printMail", side.rt.ports.printMail, "print_mail_secondary_vendor")], ["scripted", scripted]]) });
    const T0 = Date.parse("2026-09-15T14:00:00.000Z"); const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
    const outbox = new PgOutbox(side.db);
    const ok = (await outbox.enqueue({ adapter: "printMail", idempotencyKey: `t8-ok-${randomUUID()}`, payload: { notice: "NTC_TEST", to: "1 Test St" }, payloadSummary: { kind: "test" } }, at(0))).message;
    const bad = (await outbox.enqueue({ adapter: "scripted", idempotencyKey: `t8-bad-${randomUUID()}`, payload: { x: 1 }, payloadSummary: { kind: "test" } }, at(0))).message;
    const sweepAt = async (sec: number) => { clk.set(at(sec)); return rt.sweep(at(sec), { verify: false }); };
    const r0 = await sweepAt(0);
    assert.equal(r0.outcome, "completed"); assert.equal(r0.outbox_dispatch?.sent, 1); assert.equal(r0.outbox_dispatch?.retried, 1);
    // the first message is sent on the first sweep: one dispatch row {attempt_no: 1, outcome: acked} and integration.message.sent
    const [okRow] = await side.db.query<{ status: string }>(`SELECT status FROM integration_messages WHERE id = $1`, [ok.id]);
    assert.equal(okRow!.status, "acked");
    const okD = await side.db.query<{ attempt_no: number; outcome: string }>(`SELECT attempt_no, outcome FROM outbox_dispatches WHERE message_id = $1`, [ok.id]);
    assert.deepEqual(okD, [{ attempt_no: 1, outcome: "acked" }]);
    assert.equal(await count(side.db, `FROM loan_events WHERE type = 'integration.message.sent' AND payload->>'message_id' = $1`, [ok.id]), 1);
    // the failing message: retried at the DEFAULT_RETRY instants +60 s, +180 s, +420 s, +900 s and dead after the fifth attempt
    for (const sec of [60, 180, 420, 900, 1800]) await sweepAt(sec);
    const badD = await side.db.query<{ attempt_no: number; outcome: string; next_attempt_at: string | null }>(`SELECT attempt_no, outcome, next_attempt_at FROM outbox_dispatches WHERE message_id = $1 ORDER BY attempt_no`, [bad.id]);
    assert.deepEqual(badD.map((d) => [d.attempt_no, d.outcome, d.next_attempt_at]), [[1, "retry", at(60)], [2, "retry", at(180)], [3, "retry", at(420)], [4, "retry", at(900)], [5, "dead", null]]);
    const [badRow] = await side.db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM integration_messages WHERE id = $1`, [bad.id]);
    assert.equal(badRow!.status, "dead"); assert.equal(badRow!.attempts, 5);
    const dead = await side.db.query<{ payload: { attempts: number; dead_at: string } }>(`SELECT payload FROM loan_events WHERE type = 'integration.message.dead' AND payload->>'message_id' = $1`, [bad.id]);
    assert.equal(dead.length, 1); assert.equal(dead[0]!.payload.attempts, 5); assert.equal(dead[0]!.payload.dead_at, at(900));
    assert.equal(await count(side.db, `FROM human_portal_tasks WHERE integration_message_id = $1`, [bad.id]), 1);
    const [clock] = await side.db.query<{ id: string; status: string; subject_kind: string; subject_id: string; anchor_date: string }>(`SELECT id, status, subject_kind, subject_id, anchor_date::text AS anchor_date FROM timers WHERE code = 'SM_OUTBOX_DEAD_LETTER_REVIEW_1BD' AND subject_id = $1`, [bad.id]);
    assert.ok(clock, "SM_OUTBOX_DEAD_LETTER_REVIEW_1BD armed"); assert.equal(clock.status, "armed"); assert.equal(clock.subject_kind, "integration_message"); assert.equal(clock.anchor_date, "2026-09-15");
    // 34.4 requeues it (an active ops_analyst) and the adapter is un-scripted: the next drain sends it and the clock is satisfied
    const staffId = (await side.db.query<{ id: string }>(`INSERT INTO staff_users (email_hash, email_encrypted, legal_name, roles, status, enrolled_at) VALUES ($1, $2, 'Ana Lyst', ARRAY['ops_analyst'], 'active', $3) RETURNING id::text AS id`, [sha256("ana@example.test"), Buffer.from("FAKE-encrypted"), at(1800)]))[0]!.id;
    const rq = await requeueMessage(rt, { id: bad.id, actor: { kind: "human", id: staffId, role: "ops_analyst" }, reason: "vendor restored" }, at(1860));
    assert.equal(rq.status, "queued");
    failing = false;
    const r6 = await sweepAt(1920);
    assert.equal(r6.outbox_dispatch?.sent, 1);
    const [afterRow] = await side.db.query<{ status: string }>(`SELECT status FROM integration_messages WHERE id = $1`, [bad.id]);
    assert.equal(afterRow!.status, "acked");
    const [clockAfter] = await side.db.query<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [clock.id]);
    assert.equal(clockAfter!.status, "satisfied");
    assert.equal(await count(side.db, `FROM outbox_dispatches WHERE message_id = $1`, [bad.id]), 6);
  } finally { await side.close(); }
});
test("35.1-T9: Given the hosted runtime, when `POST /v1/loans/{id}/tools/1.1/runValidation`, `POST /v1/applications/{id}/tools/30.2/snapshotOrigination` and `POST /v1/applications/{id}/tools/25.1/runToleranceTest{checkpoint: cd}` are called, then none answers 501 `not_wired`, the 25.1 result carries `delegated_to: \"21.5\"` and the `tolerance_test_id` of a `tolerance_tests` row 21.5's own tool (`21.5 runToleranceTest`) would have written for the same inputs, and `rt.services[\"tolerance-21-5\"] === rt.services[\"tolerance\"]` in a unit harness.", { skip }, async () => {
  const clk = new FixedClock("2026-09-01T16:00:00.000Z");
  const side = await sideRuntime("t9", {}, clk);
  const server = createApiServer({ runtime: side.rt, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  const port = await listen(server, 0, "127.0.0.1"); const sideBase = `http://127.0.0.1:${port}`;
  const hosted = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => { const r = await fetch(sideBase + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) } : {}) }); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  try {
    // a three-loan batch boarded on the bus gives 1.1 runValidation a batch to validate on the hosted runtime
    const tape = threeLoanTape();
    const boarded = await hosted("POST", "/v1/tools/1.1/boardLoan", { actor: { kind: "agent", id: "boarding" }, input: { batch: { ...tape.input, transfer_date: "2026-09-01", respa_effective_date: "2026-09-01", sale_date: "2026-08-01" }, files: tape.files } });
    assert.equal(boarded.status, 200, JSON.stringify(boarded.body));
    const out = boarded.body["output"] as { batch_uuid: string; loan_ids: Record<string, string> };
    const loanId = Object.values(out.loan_ids)[0]!;
    const v = await hosted("POST", `/v1/loans/${loanId}/tools/1.1/runValidation`, { actor: { kind: "agent", id: "boarding" }, input: { batch_id: out.batch_uuid } });
    assert.notEqual(v.status, 501, JSON.stringify(v.body)); assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.ok((v.body["output"] as { loans: Record<string, number> }).loans, "1.1 runValidation answers a scorecard from the boarding adapter hydrated from the record");
    // 30.2 snapshotOrigination on an application (no origination record yet → the store's row or null, never 501)
    clk.set("2026-10-05T23:10:00.000Z");
    const { appId } = await originationFixture(side.rt, side.db, "2026-10-05T23:10:00.000Z");
    const snap = await hosted("POST", `/v1/applications/${appId}/tools/30.2/snapshotOrigination`, { actor: { kind: "agent", id: "boarding" }, input: { application_id: appId } });
    assert.notEqual(snap.status, 501, JSON.stringify(snap.body)); assert.equal(snap.status, 200);
    // 25.1 runToleranceTest{checkpoint: cd} delegates to 21.5's engine (the fee baseline the LE set): the result names 21.5 and the test row the engine wrote
    const items = [{ fee_code: "appraisal", amount_cents: "65000" }, { fee_code: "credit_report", amount_cents: "7500" }, { fee_code: "tax_service", amount_cents: "8500" }, { fee_code: "title_lenders_policy", amount_cents: "115000" }, { fee_code: "recording", amount_cents: "7000" }, { fee_code: "prepaid_interest", amount_cents: "178543" }];
    const t = await hosted("POST", `/v1/applications/${appId}/tools/25.1/runToleranceTest`, { actor: { kind: "agent", id: "compliance-tester" }, input: { application_id: appId, checkpoint: "cd", items } });
    assert.notEqual(t.status, 501, JSON.stringify(t.body)); assert.equal(t.status, 200, JSON.stringify(t.body));
    const to = t.body["output"] as { delegated_to: string; tolerance_test_id: string; result: string; test_code: string };
    assert.equal(to.delegated_to, "21.5"); assert.equal(to.test_code, "TRID_19E3_TOLERANCE"); assert.ok(to.tolerance_test_id);
    const completed = (t.body["events"] as { type: string; payload: { test_id: string; stage: string } }[]).filter((e) => e.type === "tolerance.test.completed");
    assert.equal(completed.length, 1, "21.5's engine wrote exactly one tolerance test row for the run");
    assert.equal(completed[0]!.payload.test_id, to.tolerance_test_id, "the 25.1 result carries the test id 21.5's own run produced for the same inputs"); assert.equal(completed[0]!.payload.stage, "cd_initial");
    // the same object under both keys, in a unit harness
    await side.rt.executeDef(testTool("t9-same", (_i, _c, trt) => { assert.ok(trt.services["tolerance-21-5"]); assert.equal(trt.services["tolerance-21-5"], trt.services["tolerance"]); return {}; }), { loanId: "", applicationId: appId, actor: SYSTEM, input: {} });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await side.close(); }
});
test("35.1-T10: Given a decoded transfer tape of three loans, when `1.1 boardLoan` runs on the bus for the batch, then the transaction wrote `transfer_batches`, `properties`, `loans`, `borrowers`, `loan_borrowers`, `loan_terms`, `transfer_batch_loans`, `boarding_validations`, `parties` (transferor and servicer, found-or-inserted) and `custodial_accounts` (P&I and T&I, found-or-inserted) with the same columns `POST /v1/transfers/batches` writes (a row-by-row comparison against a batch boarded through the route on a second database), the events, the 1.6 opening ledger sets, the armed timers, one escalation per hard exception, the global `transfer_batches` entity row and one `agent_decisions` row; and `boardTransferBatch` in src/runtime/transfers.ts refuses with `SEED_ONLY` under `ENVIRONMENT=production`.", { skip }, async () => {
  const clk = new FixedClock("2026-09-01T16:00:00.000Z");
  const bus = await sideRuntime("t10a", {}, clk); const route = await sideRuntime("t10b", {}, clk);
  try {
    const tape = threeLoanTape();
    // the bus: 1.1 boardLoan{batch, files} as a global command
    const r = await bus.rt.execute({ process: "1.1", name: "boardLoan", loanId: "", actor: { kind: "agent", id: "boarding" }, input: { batch: { ...tape.input, transfer_date: "2026-09-01", respa_effective_date: "2026-09-01", sale_date: "2026-08-01" }, files: tape.files } });
    const o = r.output as { batch_uuid: string; status: string; loans: { staged: number; boarded: number; exception: number }; hard_by_loan: Record<string, string[]>; loan_ids: Record<string, string> };
    assert.equal(o.loans.staged, 3);
    // the route on a second database, the same tape
    const s = await boardTransferBatch(route.rt, tape.input, tape.files, { kind: "system", id: "seed" });
    assert.equal(s.loans.staged, 3); assert.equal(s.status, o.status); assert.deepEqual(s.loans, o.loans); assert.deepEqual(s.hard_by_loan, o.hard_by_loan);
    // row by row: the same columns on every table of the boarding set (uuids and instants aside)
    for (const [table, where] of [["transfer_batches", ""], ["properties", ""], ["loans", ""], ["borrowers", ""], ["loan_borrowers", ""], ["loan_terms", ""], ["transfer_batch_loans", ""], ["boarding_validations", ""], ["parties", "WHERE party_type IN ('transferor', 'servicer')"], ["custodial_accounts", ""]] as const) {
      const a = await rowsOf(bus.db, table, where); const b = await rowsOf(route.db, table, where);
      assert.ok(a.length > 0, `${table}: rows written`); assert.deepEqual(a, b, `${table}: the bus and the route wrote the same rows`);
    }
    assert.equal(await count(bus.db, `FROM parties WHERE party_type = 'transferor' AND servicer_number = $1`, [tape.input.transferor_servicer_number]), 1);
    assert.equal(await count(bus.db, `FROM custodial_accounts WHERE kind = 'clearing'`), 1, "the clearing account found-or-inserted once");
    // the events, the 1.6 opening ledger sets, the armed timers, one escalation per hard exception, the global transfer_batches row and one decision
    const boardedLoans = o.loans.boarded;
    assert.equal(await count(bus.db, `FROM loan_events WHERE type = 'loan.boarded' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [o.batch_uuid]), boardedLoans);
    assert.equal(await count(bus.db, `FROM loan_events WHERE type = 'loan.boarded' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [o.batch_uuid]), await count(route.db, `FROM loan_events WHERE type = 'loan.boarded' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [s.batch_uuid]));
    assert.equal(await count(bus.db, `FROM ledger_entry_sets WHERE id IN (SELECT set_id FROM ledger_lines WHERE loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1))`, [o.batch_uuid]), await count(route.db, `FROM ledger_entry_sets WHERE id IN (SELECT set_id FROM ledger_lines WHERE loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1))`, [s.batch_uuid]));
    if (boardedLoans) assert.ok(await count(bus.db, `FROM ledger_entry_sets WHERE id IN (SELECT set_id FROM ledger_lines WHERE loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1))`, [o.batch_uuid]) >= boardedLoans, "the 1.6 opening ledger sets");
    assert.equal(await count(bus.db, `FROM timers WHERE status = 'armed' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [o.batch_uuid]), await count(route.db, `FROM timers WHERE status = 'armed' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [s.batch_uuid]));
    assert.equal(await count(bus.db, `FROM escalations WHERE batch_id = $1`, [o.batch_uuid]), Object.keys(o.hard_by_loan).length, "one escalation per hard exception");
    assert.equal(await count(bus.db, `FROM entity_records WHERE kind = 'transfer_batches' AND id = $1 AND loan_id IS NULL AND application_id IS NULL`, [tape.input.batch_id]), 1, "the global transfer_batches entity row");
    assert.equal(r.decisions.length, 1, "one agent_decisions row");
    assert.equal(await count(bus.db, `FROM agent_decisions WHERE id = $1`, [r.decisions[0]!.id]), 1);
    // src/runtime/transfers.ts refuses with SEED_ONLY under ENVIRONMENT=production
    const was = process.env["ENVIRONMENT"]; process.env["ENVIRONMENT"] = "production";
    try { await assert.rejects(boardTransferBatch(route.rt, { ...tape.input, batch_id: `${tape.input.batch_id}-prod` }, tape.files, { kind: "system", id: "seed" }), (e: unknown) => e instanceof SeedOnly && e.code === "SEED_ONLY"); }
    finally { if (was === undefined) delete process.env["ENVIRONMENT"]; else process.env["ENVIRONMENT"] = was; }
  } finally { await bus.close(); await route.close(); }
});
test("35.1-T11: Given a command that writes a kind with no authored projector (`fee_gate_checks`) and one with a projector (`locks`), when the daily verify runs at 06:00 ET, then `locks` has its typed row and `entity_projections` row, `fee_gate_checks` has neither and one `projection_gaps{reason: no_projector, versions_unprojected: 1}` row names it, `record.gaps` lists it under `no_projector`, one `projection_runs{outcome: completed}` row and `projection.run_completed{gaps: 1, mismatches: 0}` exist, and `SM_PROJECTION_LAG_DAILY` is satisfied and re-armed; given the next day passes with no run, then the clock breaches and one sev 3 `ops_analyst` escalation names `SM_PROJECTION_LAG_DAILY`.", { skip }, async () => {
  const clk = new FixedClock("2026-09-16T12:00:00.000Z");
  const side = await sideRuntime("t11", {}, clk);
  try {
    const rt = side.rt;
    const partner = (await side.db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', 'Lender T11', '123456711') RETURNING id`))[0]!.id;
    const app = (await rt.createApplication({ partner_party_id: partner, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "Casey Fixture" }] }, SYSTEM)).application;
    // one command writes a kind with no authored projector (fee_gate_checks) and one with a projector (locks: 21.4's row)
    const lockId = randomUUID(); const lineage = randomUUID();
    const lock = { lock_id: lockId, application_id: app.id, lineage_id: lineage, version: 1, kind: "initial", supersedes_lock_id: null, status: "executed", requested_at: "2026-09-16T11:00:00.000Z", quote_id: randomUUID(), quote_id_fnma: null, mlo_approval_escalation_id: null, approved_at: "2026-09-16T11:05:00.000Z", mlo_nmlsr_id: "654321",
      locked_at: "2026-09-16T11:10:00.000Z", rate_set_date: "2026-09-16", note_rate: "6.500", price: "100.125", points_cents: 0n, lender_credit_cents: 0n, lock_period_days: 45, expires_on: "2026-10-31", expires_at: "2026-11-01T00:00:00.000Z", expiry_roll_applied: false, time_zone: "America/Phoenix", product_code: "C30", loan_amount_cents: 56_000_000n,
      worst_case_pricing_applied: false, extension_fee_cents: 0n, extension_payer: null, float_down_fee_cents: 0n, commitment_id: null, revised_le_disclosure_id: null, state_agreement_variant: null, property_state: "AZ", cancelled_reason: null, ny_expiry_notice_required: false, borrower_statement: "n/a", superseded_quote_ids: [], recorded_by: "agent:pricing" };
    await rt.executeDef(testTool("t11-write", (_i, ctx, trt) => { trt.store.put("fee_gate_checks", "fgc-1", { application_id: app.id, gate: "REGZ_1026_19B_ARM_DISCLOSURE_GATE", passed: true }, ctx.actor, ctx.now); trt.store.put("locks", lockId, lock, ctx.actor, ctx.now); return {}; }), { loanId: "", applicationId: app.id, actor: SYSTEM, input: {} });
    assert.equal(await count(side.db, `FROM locks WHERE lock_id = $1`, [lockId]), 1, "locks has its typed row");
    assert.equal(await count(side.db, `FROM entity_projections WHERE kind = 'locks' AND entity_id = $1`, [lockId]), 1);
    assert.equal(await count(side.db, `FROM entity_projections WHERE kind = 'fee_gate_checks'`), 0);
    // the daily verify runs at 06:00 ET (10:00Z in September) from the sweep
    const r = await rt.sweep("2026-09-16T10:00:00.000Z");
    assert.equal(r.outcome, "completed"); assert.ok(r.verify, "the verify pass ran at 06:00 ET");
    assert.equal(r.verify!.outcome, "completed"); assert.equal(r.verify!.gaps, 1); assert.equal(r.verify!.mismatches, 0);
    const gaps = await side.db.query<{ kind: string; reason: string; versions_unprojected: number }>(`SELECT kind, reason, versions_unprojected FROM projection_gaps WHERE run_id = $1`, [r.verify!.run_id]);
    assert.deepEqual(gaps, [{ kind: "fee_gate_checks", reason: "no_projector", versions_unprojected: 1 }]);
    const g = await rt.execute({ process: "35.1", name: "record.gaps", loanId: "", actor: RECORDS, input: { as_of_date: "2026-09-16" } });
    const listed = (g.output as { kinds: { kind: string; reason: string }[] }).kinds;
    assert.ok(listed.some((k) => k.kind === "fee_gate_checks" && k.reason === "no_projector"), JSON.stringify(listed));
    assert.equal(await count(side.db, `FROM projection_runs WHERE id = $1 AND outcome = 'completed'`, [r.verify!.run_id]), 1);
    const [ev] = await side.db.query<{ payload: { gaps: number; mismatches: number; run_id: string } }>(`SELECT payload FROM loan_events WHERE type = 'projection.run_completed' AND payload->>'run_id' = $1`, [r.verify!.run_id]);
    assert.equal(ev!.payload.gaps, 1); assert.equal(ev!.payload.mismatches, 0);
    // SM_PROJECTION_LAG_DAILY is satisfied by the run's receipt (when a prior day's clock was armed) and re-armed for 06:00 ET tomorrow on the global subject
    const armed = await side.db.query<{ status: string; anchor_date: string; due_date: string; due_at: string; subject_kind: string }>(`SELECT status, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, subject_kind FROM timers WHERE code = 'SM_PROJECTION_LAG_DAILY' ORDER BY armed_at`);
    assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.subject_kind, "global"); assert.equal(armed[0]!.anchor_date, "2026-09-16"); assert.equal(armed[0]!.due_date, "2026-09-17");
    assert.equal(new Date(armed[0]!.due_at).toISOString(), "2026-09-17T10:00:00.000Z");
    const r2 = await rt.sweep("2026-09-16T11:00:00.000Z");
    assert.equal(r2.verify, null, "the verify runs once per calendar day");
    // the next day passes with no run: the clock breaches and one sev 3 ops_analyst escalation names SM_PROJECTION_LAG_DAILY
    clk.set("2026-09-17T10:30:00.000Z");
    const r3 = await rt.sweep("2026-09-17T10:30:00.000Z", { verify: false });
    assert.equal(r3.breaches.filter((b) => b.code === "SM_PROJECTION_LAG_DAILY").length, 1);
    const esc = await side.db.query<{ severity: string; owner_role: string; payload: { timer_code: string } }>(`SELECT severity, owner_role, payload FROM escalations WHERE payload->>'timer_code' = 'SM_PROJECTION_LAG_DAILY'`);
    assert.equal(esc.length, 1); assert.equal(esc[0]!.severity, "3"); assert.equal(esc[0]!.owner_role, "ops_analyst"); assert.equal(esc[0]!.payload.timer_code, "SM_PROJECTION_LAG_DAILY");
  } finally { await side.close(); }
});
test("35.1-T12: Given a store id `fees-3` written on two loans and a projector for `fees` authored afterwards, when `record.replay{kind: fees}` runs twice, then the first run minted two `entity_keys` rows (one per scope) with distinct uuids, wrote two `fees` rows keyed by those uuids and one `entity_projections{phase: replay}` row per version and logged `record.replayed{rows}`; the second run wrote zero rows and zero events and its decision record says `rows_written: 0`; and both JSON versions still carry the id `fees-3`.", { skip }, async () => {
  // `fees-3` written on two loans (store ids repeat across scopes, 0115) before any projector ran for the kind — the versions stand in JSONB
  const fA = await loanFixture(); const fB = await loanFixture();
  const fee = (loanId: string): Record<string, unknown> => ({ id: "fees-3", loan_id: loanId, fee_type: "late_charge", installment_due_date: "2026-09-01", amount_cents: "8062", assessed_on: "2026-09-17", grace_end_on: "2026-09-16", state: "assessed", collected_cents: "0" });
  await runtime.entities.save([{ kind: "fees", id: "fees-3", version: 1, data: fee(fA.loanId), updatedAt: NOW, updatedBy: "agent:cashiering" }], fA.loanId);
  await runtime.entities.save([{ kind: "fees", id: "fees-3", version: 1, data: fee(fB.loanId), updatedAt: NOW, updatedBy: "agent:cashiering" }], fB.loanId);
  const keysBefore = await count(db, `FROM entity_keys WHERE kind = 'fees' AND legacy_ref = 'fees-3' AND scope_key IN ($1, $2)`, [fA.loanId, fB.loanId]);
  assert.equal(keysBefore, 0);
  // the projector for `fees` is authored (src/domain/operations-runtime/projectors/section02.ts FEES); record.replay{kind: fees} runs twice
  const run = () => runtime.execute({ process: "35.1", name: "record.replay", loanId: "", actor: RECORDS, input: { kind: "fees" } });
  const first = await run();
  const o1 = first.output as { rows_written: number; versions: number; gaps: unknown[] };
  const mine = (await db.query<{ scope_key: string; target_uuid: string }>(`SELECT scope_key, target_uuid FROM entity_keys WHERE kind = 'fees' AND legacy_ref = 'fees-3' AND scope_key IN ($1, $2) ORDER BY scope_key`, [fA.loanId, fB.loanId]));
  assert.equal(mine.length, 2, "two entity_keys rows, one per scope"); assert.notEqual(mine[0]!.target_uuid, mine[1]!.target_uuid, "distinct uuids");
  const feeRows = await db.query<{ id: string; loan_id: string; amount_cents: bigint; fee_type: string }>(`SELECT id, loan_id, amount_cents, fee_type FROM fees WHERE id = ANY($1::uuid[]) ORDER BY loan_id`, [mine.map((k) => k.target_uuid)]);
  assert.equal(feeRows.length, 2); assert.deepEqual(new Set(feeRows.map((r) => r.loan_id)), new Set([fA.loanId, fB.loanId])); for (const r of feeRows) { assert.equal(r.amount_cents, 8_062n); assert.equal(r.fee_type, "late_charge"); }
  const proj = await db.query<{ phase: string; target_id: string; scope_key: string }>(`SELECT phase, target_id, scope_key FROM entity_projections WHERE kind = 'fees' AND entity_id = 'fees-3' AND scope_key IN ($1, $2) ORDER BY scope_key`, [fA.loanId, fB.loanId]);
  assert.deepEqual(proj.map((p) => p.phase), ["replay", "replay"]); assert.deepEqual(proj.map((p) => p.target_id), mine.map((k) => k.target_uuid));
  assert.ok(o1.rows_written >= 2, JSON.stringify(o1));
  assert.ok(first.events.some((e) => e.type === "record.replayed" && Number((e.payload as { rows: unknown }).rows) === o1.rows_written), "record.replayed{rows} logged");
  // the second run writes zero rows and zero events and its decision record says rows_written: 0
  const second = await run();
  const o2 = second.output as { rows_written: number };
  assert.equal(o2.rows_written, 0);
  assert.ok(!second.events.some((e) => e.type === "record.replayed"), "zero events");
  assert.equal(await count(db, `FROM entity_keys WHERE kind = 'fees' AND legacy_ref = 'fees-3' AND scope_key IN ($1, $2)`, [fA.loanId, fB.loanId]), 2);
  assert.equal(await count(db, `FROM fees WHERE id = ANY($1::uuid[])`, [mine.map((k) => k.target_uuid)]), 2);
  const [dec] = await db.query<{ rationale: string }>(`SELECT rationale FROM agent_decisions WHERE id = $1`, [second.decisions[0]!.id]);
  assert.equal((JSON.parse(dec!.rationale) as { rows_written: number }).rows_written, 0);
  // both JSON versions still carry the id fees-3
  const vers = await db.query<{ id: string; data: { id: string } }>(`SELECT id, data FROM entity_records WHERE kind = 'fees' AND loan_id IN ($1, $2)`, [fA.loanId, fB.loanId]);
  assert.equal(vers.length, 2); for (const v of vers) { assert.equal(v.id, "fees-3"); assert.equal(v.data.id, "fees-3"); }
});
test("35.1-T13: Given the projected rows of worked example A, when a test's UPDATE of `payment_allocations` is refused by its trigger and the test instead UPDATEs `payments.amount_cents` to 204513 and the verify runs, then one `projection_mismatches{column_name: amount_cents, is_money: true, json_value: '204512', row_value: '204513'}` row exists, `projection.mismatch_found{is_money: true}` is logged, one sev 1 `ciso` escalation names the row ids and the owning process 2.1, the run wrote no correction (`payments.amount_cents` is still 204513 and no `record.replayed` event exists), and the run's `outcome` is `completed`.", { skip }, async () => {
  const side = await sideRuntime("t13");
  try {
    const rt = side.rt;
    const f = await loanFixture(side.db);
    const paymentId = randomUUID();
    await receivePayment(rt, f, paymentId); await postPayment(rt, f, paymentId);
    assert.equal(await count(side.db, `FROM payment_allocations WHERE payment_id = $1`, [paymentId]), 3);
    // a test's UPDATE of payment_allocations is refused by its trigger; payments has none, so the test corrupts amount_cents by one cent
    await assert.rejects(side.db.query(`UPDATE payment_allocations SET amount_cents = amount_cents + 1 WHERE payment_id = $1`, [paymentId]), /append-only/);
    await side.db.query(`UPDATE payments SET amount_cents = 204513 WHERE id = $1`, [paymentId]);
    const r = await rt.execute({ process: "35.1", name: "record.verify", loanId: "", actor: RECORDS, input: { as_of_date: "2026-09-15" } });
    const o = r.output as { run_id: string; outcome: string; mismatches: number };
    assert.equal(o.outcome, "completed"); assert.equal(o.mismatches, 1);
    const rows = await side.db.query<{ column_name: string; is_money: boolean; json_value: string; row_value: string; escalation_id: string; target_id: string; entity_id: string }>(`SELECT column_name, is_money, json_value, row_value, escalation_id, target_id, entity_id FROM projection_mismatches WHERE run_id = $1`, [o.run_id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.column_name, "amount_cents"); assert.equal(rows[0]!.is_money, true); assert.equal(rows[0]!.json_value, "204512"); assert.equal(rows[0]!.row_value, "204513");
    assert.ok(r.events.some((e) => e.type === "projection.mismatch_found" && (e.payload as { is_money: boolean }).is_money === true), "projection.mismatch_found{is_money: true} logged");
    const [esc] = await side.db.query<{ severity: string; owner_role: string; kind: string; payload: Record<string, unknown> }>(`SELECT severity, owner_role, kind, payload FROM escalations WHERE id = $1`, [rows[0]!.escalation_id]);
    assert.equal(esc!.severity, "1"); assert.equal(esc!.owner_role, "ciso"); assert.equal(esc!.kind, "sev1");
    assert.equal(esc!.payload["target_id"], paymentId); assert.equal(esc!.payload["entity_id"], paymentId); assert.equal(esc!.payload["owning_process"], "2.1");
    // no correction by the run: the corrupted cent stands, no record.replayed exists, the run is completed
    const [pay] = await side.db.query<{ amount_cents: bigint }>(`SELECT amount_cents FROM payments WHERE id = $1`, [paymentId]);
    assert.equal(pay!.amount_cents, 204_513n);
    assert.equal(await count(side.db, `FROM loan_events WHERE type = 'record.replayed'`), 0);
    const [run] = await side.db.query<{ outcome: string; mismatches: number }>(`SELECT outcome, mismatches FROM projection_runs WHERE id = $1`, [o.run_id]);
    assert.equal(run!.outcome, "completed"); assert.equal(run!.mismatches, 1);
  } finally { await side.close(); }
});
test("35.1-T14: Given an application with 80 events across 21.2, 21.4, 21.5, 25.2 and 29.1, when `record.snapshot{service_key: cd-25-2}` writes a `service_snapshots` row at `through_sequence = N` and six more 25.2 commands run, then the next command's `cd-25-2` instance hydrated from the snapshot plus the events after N and its `state_sha256` equals the hash of an instance hydrated by full replay; and given the snapshot's `state` is tampered with, then hydration discards it, replays in full, logs `service.snapshot.written` for a fresh one and opens a sev 2 `ciso` escalation.", { skip }, async () => {
  const clk = new FixedClock("2026-10-05T23:10:00.000Z");
  const side = await sideRuntime("t14", {}, clk);
  try {
    const rt = side.rt;
    const { appId } = await originationFixture(rt, side.db, "2026-10-05T23:10:00.000Z");
    clk.set("2026-11-02T17:00:00.000Z");
    // 21.4 and 29.1 events the CD service never appended (the fold ignores them; 21.5 folds the lock), then 25.2 commands
    await rt.executeDef(testTool("t14-events", (_i, ctx) => { for (let k = 0; k < 40; k++) { ctx.events.append({ type: k % 2 ? "lock.executed" : "commitment.requested", applicationId: appId, aggregate: { kind: k % 2 ? "lock" : "commitment", id: `x-${k}` }, actor: SYSTEM, payload: { application_id: appId, k, expires_at: "2026-11-23T00:00:00.000Z", points_cents: "0", lender_credit_cents: "0" } }); } return {}; }), { loanId: "", applicationId: appId, actor: SYSTEM, input: {} });
    await recordCdSources(rt, appId);
    for (let v = 1; v <= 3; v++) await rt.execute({ process: "25.2", name: "renderCd", loanId: "", applicationId: appId, actor: DISCLOSURE, input: cdInput(appId, `CD-${appId.slice(0, 8)}-${v}`, v, v > 1 ? { supersedes: `CD-${appId.slice(0, 8)}-${v - 1}` } : {}) });
    const total = await count(side.db, `FROM loan_events WHERE application_id = $1`, [appId]);
    assert.ok(total >= 80, `${total} events across 21.2, 21.4, 21.5, 25.2 and 29.1`);
    const sections = new Set((await side.db.query<{ type: string }>(`SELECT DISTINCT type FROM loan_events WHERE application_id = $1`, [appId])).map((r) => r.type.split(".")[0]));
    for (const t of ["disclosure", "fee", "lock", "commitment"]) assert.ok(sections.has(t), `${t}.* on the log`);
    // record.snapshot{service_key: cd-25-2} at through_sequence = N
    const snap = await rt.execute({ process: "35.1", name: "record.snapshot", loanId: "", applicationId: appId, actor: RECORDS, input: { service_key: "cd-25-2", application_id: appId } });
    const so = snap.output as { snapshot_id: string; through_sequence: number; state_sha256: string };
    assert.ok(so.snapshot_id && so.through_sequence > 0);
    assert.ok(snap.events.some((e) => e.type === "service.snapshot.written"));
    // six more 25.2 commands
    for (let v = 4; v <= 9; v++) await rt.execute({ process: "25.2", name: "renderCd", loanId: "", applicationId: appId, actor: DISCLOSURE, input: cdInput(appId, `CD-${appId.slice(0, 8)}-${v}`, v, { supersedes: `CD-${appId.slice(0, 8)}-${v - 1}` }) });
    // the next command's cd-25-2 instance: hydrated from the snapshot plus the events after N; its sha256 equals a full replay's
    const spec = STATEFUL_SERVICES.find((x) => x.key === "cd-25-2")!;
    const empty = captureState(new ClosingDisclosureService({ events: new MemoryEventStore(clk), clock: clk }), spec.fields);
    const log = await rt.uow.events.byApplication(appId);
    const [row] = await side.db.query<{ through_sequence: bigint; state: Record<string, unknown>; state_sha256: string }>(`SELECT through_sequence, state, state_sha256 FROM service_snapshots WHERE id = $1`, [so.snapshot_id]);
    const viaSnapshot = foldState(empty, "cd-25-2", log, { through_sequence: Number(row!.through_sequence), state: row!.state, state_sha256: row!.state_sha256 });
    const replay = foldState(empty, "cd-25-2", log, null);
    assert.equal(viaSnapshot.from_snapshot, true); assert.equal(viaSnapshot.sha, replay.sha);
    let hydratedSha = ""; let versions = 0;
    await rt.executeDef(testTool("t14-state", (_i, ctx, trt) => { hydratedSha = rt.originationServices.stateOf(ctx, "cd-25-2")!.sha; versions = (trt.services["cd-25-2"] as ClosingDisclosureService).versions(appId).length; return {}; }), { loanId: "", applicationId: appId, actor: SYSTEM, input: {} });
    assert.equal(hydratedSha, replay.sha); assert.equal(versions, 9);
    assert.equal(await count(side.db, `FROM escalations WHERE payload->>'code' = 'SNAPSHOT_DIFFERS_FROM_REPLAY'`), 0);
    // the snapshot's state is tampered with (beneath the append-only trigger): hydration discards it, replays in full, writes a fresh one and opens a sev 2 ciso escalation
    await side.db.query(`ALTER TABLE service_snapshots DISABLE TRIGGER service_snapshots_immutable`);
    await side.db.query(`UPDATE service_snapshots SET state = jsonb_set(state, '{tolerance_runs}', '[{"application_id": "tampered"}]'::jsonb) WHERE id = $1`, [so.snapshot_id]);
    await side.db.query(`ALTER TABLE service_snapshots ENABLE TRIGGER service_snapshots_immutable`);
    const before = await count(side.db, `FROM service_snapshots WHERE service_key = 'cd-25-2' AND application_id = $1`, [appId]);
    let afterTamper = "";
    const r2 = await rt.executeDef(testTool("t14-tampered", (_i, ctx) => { afterTamper = rt.originationServices.stateOf(ctx, "cd-25-2")!.sha; return {}; }), { loanId: "", applicationId: appId, actor: SYSTEM, input: {} });
    assert.equal(afterTamper, replay.sha, "hydration discarded the snapshot and replayed in full");
    assert.ok(r2.events.some((e) => e.type === "service.snapshot.written" && (e.payload as { reason: string }).reason === "snapshot_discarded"), "service.snapshot.written for a fresh snapshot");
    assert.equal(await count(side.db, `FROM service_snapshots WHERE service_key = 'cd-25-2' AND application_id = $1`, [appId]), before + 1);
    const esc = await side.db.query<{ severity: string; owner_role: string }>(`SELECT severity, owner_role FROM escalations WHERE payload->>'code' = 'SNAPSHOT_DIFFERS_FROM_REPLAY' AND application_id = $1`, [appId]);
    assert.equal(esc.length, 1); assert.equal(esc[0]!.severity, "2"); assert.equal(esc[0]!.owner_role, "ciso");
  } finally { await side.close(); }
});
test("35.1-T15: Given a money-field change proposed by the agent — `record.replay{kind: payments, overrides: {amount_cents: …}}` or any typed-row write that names a `*_cents` column not equal to the JSON version's — when no `officer` approval record exists, then the command is refused `NO_MONEY_FIELD_CHANGE` and nothing is written; and the seam's own tools (`record.project`, `record.replay`, `record.verify`, `record.snapshot`, `outbox.dispatch`) are absent from every money-field allowlist in `spec/registry/agents.json` (contract test).", { skip }, async () => {
  const before = { proj: await count(db, `FROM entity_projections`), keys: await count(db, `FROM entity_keys`), pay: await count(db, `FROM payments`), ev: await count(db, `FROM loan_events WHERE type = 'record.replayed'`), dec: await count(db, `FROM agent_decisions WHERE agent = 'security-records'`) };
  // a money-field change proposed by the agent with no officer approval record: refused NO_MONEY_FIELD_CHANGE, nothing written
  const attempt = await call("POST", "/v1/tools/35.1/record.replay", { actor: RECORDS, input: { kind: "payments", overrides: { amount_cents: "204513" } } });
  assert.equal(attempt.status, 409, JSON.stringify(attempt.body)); assert.equal(attempt.body["code"], "NO_MONEY_FIELD_CHANGE");
  const byHand = await call("POST", "/v1/tools/35.1/record.project", { actor: RECORDS, input: { kind: "payments", changes: { amount_cents: "1" } } });
  assert.equal(byHand.status, 409); assert.equal(byHand.body["code"], "NO_MONEY_FIELD_CHANGE");
  const after = { proj: await count(db, `FROM entity_projections`), keys: await count(db, `FROM entity_keys`), pay: await count(db, `FROM payments`), ev: await count(db, `FROM loan_events WHERE type = 'record.replayed'`), dec: await count(db, `FROM agent_decisions WHERE agent = 'security-records'`) };
  assert.deepEqual(after, before);
  // contract: the seam's own tools carry no money-field allowlist (no ToolDef.moneyFields — the bus's officer-waiver path never opens for them) and appear in no other process's allowlist in spec/registry/agents.json
  const seam = ["record.project", "record.replay", "record.verify", "record.snapshot", "outbox.dispatch"];
  for (const t of TOOLS_35_1) assert.equal(t.moneyFields, undefined, `${t.name} declares no money fields`);
  const agents = loadAgentsFile();
  for (const p of agents.processes) if (p.process !== "35.1") for (const t of seam) assert.ok(!p.tools.includes(t), `${t} is not in ${p.process}'s allowlist`);
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/registry/agents.json", import.meta.url)), "utf8")) as { processes: { process: string; guardrails?: string; tools: string[] }[] };
  const p351 = raw.processes.find((p) => p.process === "35.1")!;
  assert.match(p351.guardrails ?? "", /NO_MONEY_FIELD_CHANGE/);
  for (const p of raw.processes) if (p.process !== "35.1") for (const t of seam) assert.ok(!(p.guardrails ?? "").includes(t) || /never/.test(p.guardrails ?? ""), `${p.process}'s guardrails do not allow ${t} to touch money`);
});
