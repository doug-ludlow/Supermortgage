// 35.9 Default operations over time: cases progressed by the cycles and the screens — referral, milestones, docket reactions, executed breach actions, claims filed
// spec/sections/35-operations-runtime/35-9-default-operations-over-time.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness: this file's own database (src/infra/db/test-db.ts), a Runtime whose clock the tests move (a settable clock:
// the daily unit, the sweep and the demo advance all read `runtime.clock`), the FAKE ports, the post-commit folder started
// (rule 1), and the neighbours' tables the ports write when they exist — `work_items` (35.8), `cycle_runs` / `cycle_receipts`
// (35.3), `loan_servicing_configs` (35.5) — created here from those specs' Data model bullets (the columns they name) because
// their migrations are not in this tree; the port defaults probe `to_regclass` and write the same columns in production.
// Every section row the fixtures need (the retained FAKE firm, a foreclosure case at `prereferral`, advances, an MI policy) is
// seeded as the section would leave it in the entity store (`entity_records`, the kinds 13.x–15.x read), and every act runs
// through the bus (`runtime.execute`) so the sections' own tools write their rows and events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { Actor, Clock } from "../../kernel/events/index.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { plainDate as D, addDays, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { Runtime, type SweepReport } from "../../runtime/app.ts";
import { OffsetClock, advanceDemoClock, planSteps } from "../../runtime/demo-clock.ts";
import { originationDailySweep } from "../../runtime/origination.ts";
import { servicingDailySweep } from "../../runtime/servicing.ts";
import { delinquencyDailySweep } from "../../runtime/delinquency.ts";
import { createLogger } from "../../runtime/log.ts";
import type { EntityRecord } from "../../app/tools.ts";
import { EV, TIMERS_35_9, ENGINE_ACTOR, EXAMPLE_A, EXAMPLE_B, EXAMPLE_C } from "./default-35-9.ts";
import { exposureCents } from "../foreclosure/timeframes.ts";
import { unearnedPremiumCredit } from "../reo/claims.ts";
import { caseUuid } from "./default-35-9/store.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
/** A clock the tests move: the daily unit runs "on 2027-04-19" because the runtime's clock says so. */
class MovableClock implements Clock { private at: string; constructor(at: string) { this.at = at; } now(): string { return this.at; } set(iso: string): void { this.at = iso; } }
const clock = new MovableClock("2027-03-02T15:00:00.000Z");   // Tue 2027-03-02 10:00 ET
const FC_OPS: Actor = { kind: "agent", id: "foreclosure-ops" };
const OFFICER: Actor = { kind: "human", id: randomUUID(), role: "officer" };
const OPS: Actor = { kind: "human", id: randomUUID(), role: "ops_analyst" };
const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|fail/i.test(line)) process.stderr.write(line + "\n"); });

let db: Db; let runtime: Runtime;
let n = 0;
const uniq = (): string => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const count = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
const rows = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => db.query<T>(sql, params);
const events = (type: string, loanId: string) => rows<{ id: string; payload: Record<string, unknown>; actor_id: string; actor_kind: string; occurred_at: string; sequence: string }>(`SELECT id::text AS id, payload, actor_id, actor_kind::text AS actor_kind, occurred_at::text AS occurred_at, sequence::text AS sequence FROM loan_events WHERE type = $1 AND loan_id = $2::uuid ORDER BY sequence`, [type, loanId]);
const timers = (code: string, loanId: string) => rows<{ id: string; status: string; due_date: string | null; due_at: string | null; anchor_date: string }>(`SELECT id::text AS id, status::text AS status, due_date::text AS due_date, due_at::text AS due_at, anchor_date::text AS anchor_date FROM timers WHERE code = $1 AND loan_id = $2::uuid ORDER BY armed_at`, [code, loanId]);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const exec = (process: string, name: string, loanId: string, actor: Actor, input: Record<string, unknown>) => runtime.execute({ process, name, loanId, actor, input });
const settle = () => runtime.caseFolder.settle();

/** The neighbours' tables the ports write when they exist (their specs' Data model bullets; the columns those specs name). */
const NEIGHBOUR_DDL = `
CREATE TABLE IF NOT EXISTS work_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), screen_code text NOT NULL, subject_kind text NOT NULL, subject_id text NOT NULL, loan_id uuid REFERENCES loans(id), application_id uuid,
  source_kind text NOT NULL, source_id text NOT NULL, required_role text NOT NULL, status text NOT NULL DEFAULT 'open', claimed_by uuid, claimed_at timestamptz, claim_expires_at timestamptz, claim_lapses int NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL, due_at timestamptz, closed_at timestamptz, closed_by uuid, disposition text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS work_items_open_source_idx ON work_items (source_kind, source_id) WHERE status NOT IN ('closed', 'cancelled');
CREATE TABLE IF NOT EXISTS cycle_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cycle_code text NOT NULL, period_key text NOT NULL, as_of_date date NOT NULL, planned_by text NOT NULL, opened_at timestamptz NOT NULL, units_total int NOT NULL DEFAULT 0,
  units_done int NOT NULL DEFAULT 0, units_dead int NOT NULL DEFAULT 0, units_skipped int NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'planned', completed_at timestamptz, receipt_id uuid, cancelled_by text, cancelled_reason text, demo_offset_ms bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (cycle_code, period_key));
CREATE TABLE IF NOT EXISTS cycle_receipts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL UNIQUE REFERENCES cycle_runs(id), cycle_code text NOT NULL, period_key text NOT NULL, as_of_date date NOT NULL, units_total int NOT NULL, units_done int NOT NULL,
  units_dead int NOT NULL, units_skipped int NOT NULL, outcomes_sha256 char(64) NOT NULL, receipt_event_id uuid REFERENCES loan_events(id), generic_event_id uuid, emitted_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS loan_servicing_configs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loan_id uuid NOT NULL REFERENCES loans(id), effective_from date NOT NULL, time_zone text NOT NULL, time_zone_source text NOT NULL DEFAULT 'state_default',
  jurisdiction_state char(2), created_at timestamptz NOT NULL DEFAULT now());`;

test.before(async () => {
  if (skip) return;
  const raw = connect(DB_URL);
  // FLOW_DEBUG=1: every failing statement is printed with its error (a swallowed SQL error otherwise surfaces only as 25P02)
  db = process.env["FLOW_DEBUG"] ? { ...raw, query: async (sql: string, params?: readonly unknown[]) => { try { return await raw.query(sql, params); } catch (e) { process.stderr.write(`QUERY FAILED: ${sql.slice(0, 300)} :: ${(e as Error).message}\n`); throw e; } },
    tx: (fn) => raw.tx(async (q) => fn({ query: async (sql: string, params?: readonly unknown[]) => { try { return await q.query(sql, params); } catch (e) { process.stderr.write(`TX QUERY FAILED: ${sql.slice(0, 300)} :: ${(e as Error).message}\n`); throw e; } } })), dedicated: () => raw.dedicated(), end: () => raw.end() } as Db : raw;
  await db.query(NEIGHBOUR_DDL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv, reviewers: null });
  runtime.caseFolder.start();
});
test.after(async () => { if (skip) return; runtime.caseFolder.stop(); await db.end(); });

// ───────── fixtures: loans, the FAKE firm, the sections' rows as their tools leave them ─────────
async function loanFixture(state = "FL", upb = 25_000_000n, opts: { firstPaymentDate?: PlainDate; fnma?: string } = {}): Promise<Fixture> {
  return new PgLoanRepository(db).createFixture({ fnmaLoanNumber: opts.fnma ?? uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: upb, originalTermMonths: 360, firstPaymentDate: opts.firstPaymentDate ?? D("2021-09-01"), maturityDate: D("2051-08-01"), property: { line1: "1 Test St", city: "Testville", state, postalCode: "33101" } });
}
const rec = (kind: string, id: string, data: Record<string, unknown>, by = "agent:foreclosure-ops", version = 1): EntityRecord => ({ kind, id, data, version, updatedAt: clock.now(), updatedBy: by });
/** 13.6's retained FAKE firm for a state (attorney_firms + attorney_retentions as the retention lifecycle leaves them). */
async function seedFirm(state: string): Promise<string> {
  const firmId = `firm-fake-${state.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  await runtime.entities.save([
    rec("attorney_firms", firmId, { firm_id: firmId, legal_name: `FAKE Law Firm ${state}`, status: "retained", eo_expires_on: "2030-12-31", offices: [{ state }], dra_attorney_role: "retained" }),
    rec("attorney_retentions", `${firmId}:${state}`, { firm_id: firmId, jurisdiction_state: state, form200_submitted_at: "2025-01-10", form200_response: "no_objection", form200_response_at: "2025-02-01", training_completed_at: "2025-02-15", lra_executed_at: "2025-03-01", retained_from: "2025-03-01", retained_to: null, suspended_from: null }),
  ], null);
  return firmId;
}
/** A foreclosure case at `prereferral` on a loan (13.x's row, as 13.1 opens it), keyed by a `cases` row. */
async function seedForeclosureCase(f: Fixture, state: string, method: "judicial" | "non_judicial", extra: Record<string, unknown> = {}): Promise<string> {
  const c = await rows<{ id: string }>(`INSERT INTO cases (case_type, loan_id, status, owner_role, opened_at) VALUES ('foreclosure', $1::uuid, 'prereferral', 'foreclosure-ops', $2::timestamptz) RETURNING id::text AS id`, [f.loanId, clock.now()]);
  const caseId = c[0]!.id;
  await runtime.entities.save([rec("foreclosure_cases", caseId, { case_id: caseId, loan_id: f.loanId, jurisdiction_state: state, method, status: "prereferral", principal_residence: true, foreclosing_party: "partner", ...extra })], f.loanId);
  return caseId;
}
/** 13.3's referral through the bus: `attorney.message.send{op: fc.send_referral}` as foreclosure-ops (writes attorney_referrals + the case's `referred` status, emits foreclosure.referral.sent). */
async function sendReferral(f: Fixture, caseId: string, firmId: string, day = 125): Promise<{ eventId: string }> {
  const r = await exec("13.6", "attorney.message.send", f.loanId, FC_OPS, { op: "fc.send_referral", case_id: caseId, firm_id: firmId, day, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: sha("note") }, { id: "mortgage", sha256: sha("mortgage") }] });
  const sent = r.events.find((e) => e.type === "foreclosure.referral.sent");
  assert.ok(sent, "13.3 emitted foreclosure.referral.sent");
  return { eventId: sent.id };
}

// ───────── T1: the fold (rule 1) ─────────
const T1 = { f: null as unknown as Fixture, caseId: "", firmId: "", eventId: "", ready: false };
async function t1Fixture(): Promise<typeof T1> {
  if (T1.ready) return T1;
  clock.set("2027-03-02T15:00:00.000Z");
  const f = await loanFixture("FL"); const firmId = await seedFirm("FL"); const caseId = await seedForeclosureCase(f, "FL", "judicial");
  const { eventId } = await sendReferral(f, caseId, firmId);
  await settle();
  Object.assign(T1, { f, caseId, firmId, eventId, ready: true });
  return T1;
}

// ───────── the breach pass (rule 7): a referred case whose clock breaches, then the sweep ─────────
// the shared book's sweeps run without the daily pass (`dailyCase: false`): these tests assert the breach pass alone, and the daily pass would progress every other test's fixture (T9/T13/T14/T17 open their own books)
const sweepAt = async (iso: string) => { clock.set(iso); const r = await runtime.sweep(iso, { dailyCase: false }); await settle(); return r; };
const actionOfTimer = (timerId: string) => rows<{ id: string; outcome: string; action_kind: string; registry_version: number | null; command_event_id: string | null; escalation_id: string | null; refusal_code: string | null; work_item_id: string | null }>(`SELECT id::text AS id, outcome, action_kind, registry_version, command_event_id::text AS command_event_id, escalation_id::text AS escalation_id, refusal_code, work_item_id::text AS work_item_id FROM breach_actions WHERE timer_id = $1::uuid`, [timerId]);
const escalationsFor = (loanId: string) => rows<{ id: string; kind: string; owner_role: string; status: string; sla_timer_id: string | null; payload: Record<string, unknown> }>(`SELECT id::text AS id, kind, owner_role, status, sla_timer_id::text AS sla_timer_id, payload FROM escalations WHERE loan_id = $1::uuid ORDER BY opened_at`, [loanId]);

// ───────── bankruptcy fixtures (rule 6): a Chapter 13 case as 14.1 leaves it, PACER's docket as the FAKE returns it ─────────
async function seedBankruptcyCase(f: Fixture, caseNumber: string): Promise<string> {
  const c = await rows<{ id: string }>(`INSERT INTO cases (case_type, loan_id, status, owner_role, opened_at) VALUES ('bankruptcy', $1::uuid, 'active', 'bankruptcy-ops', $2::timestamptz) RETURNING id::text AS id`, [f.loanId, clock.now()]);
  const caseId = c[0]!.id;
  await runtime.entities.save([rec("bankruptcy_cases", caseId, { case_id: caseId, loan_id: f.loanId, case_number_full: caseNumber, court_id: "flmb", chapter: 13, petition_date: "2027-01-10", status: "active", stay_status: "in_effect", principal_residence: true }, "agent:bankruptcy-ops")], f.loanId);
  return caseId;
}
const pacerDockets = () => (runtime.ports.pacer as unknown as { dockets: Map<string, { seq: number; filedOn: string; kind: string; text: string }[]> }).dockets;

// ───────── loan L-B (worked examples B and C): Texas non-judicial, sale held Tue 2027-07-06 (Fannie Mae acquired), 30% BPMI, servicer_direct ─────────
const LB = { f: null as unknown as Fixture, caseId: "", firmId: "", saleEventId: "", ready: false, miCandidate: "", expenseCandidate: "" };
async function lbFixture(): Promise<typeof LB> {
  if (LB.ready) return LB;
  clock.set("2027-07-06T20:00:00.000Z");
  const f = await loanFixture("TX", 20_000_000n); const firmId = await seedFirm("TX");
  const caseId = await seedForeclosureCase(f, "TX", "non_judicial", { firm_id: firmId, status: "sale_scheduled", lpi_due_date: "2026-11-01", sale_scheduled_at: "2027-07-06" });
  const adv = (id: string, kind: string, amount: bigint, extra: Record<string, unknown> = {}) => rec("advances", `adv-${f.loanId}-${id}`, { id: `adv-${f.loanId}-${id}`, loan_id: f.loanId, kind, amount_cents: amount, paid_at: "2027-06-01", invoice_document_id: `inv-${id}`, allowable_code: null, borrower_recoverable: true, status: "outstanding", ...extra }, "agent:cashiering");
  await runtime.entities.save([
    rec("loans", f.loanId, { loan_id: f.loanId, upb_cents: 16_392_044n, note_rate_pct: "5.750", interest_paid_to: "2026-10-01", earliest_unpaid_due: "2026-11-01", state: "TX", principal_residence: true }, "agent:default-collections"),
    rec("mi_policies", `mi-${f.loanId}`, { id: `mi-${f.loanId}`, loan_id: f.loanId, insurer_code: "FAKE-MI", insurer_name: "FAKE Mortgage Insurance", coverage_pct: "30", premium_plan: "bpmi_monthly", premium_amount_cents: 9_817n, status: "active", micp_participant: false }, "agent:pmi"),
    // the advances as 15.1/9.x left them (worked example B's list; the MI premiums and the technology fee are on the ledger but excluded from the MI claim by 15.3)
    adv("tax", "taxes", 291_460n, { paid_at: "2027-01-15" }),
    adv("hazard", "hazard_premium", 106_200n, { paid_at: "2027-03-15", term_start: "2027-03-20", term_end: "2028-03-20" }),
    adv("mi", "mi_premium", 88_353n, { quantity: 9, unit_price_cents: 9_817n, service_start: "2026-11-01", service_end: "2027-07-31" }),
    adv("insp", "inspection", 18_000n, { quantity: 6, unit_price_cents: 3_000n, inspection_type: "exterior" }),
    adv("pres", "preservation", 38_500n, { preservation_code: "winterization", hometracker_bid_id: `bid-${f.loanId}-pres` }),
    adv("attyfee", "attorney_fee", 230_000n), adv("attycost", "attorney_cost", 56_500n),
    adv("tech", "technology_fee", 2_500n), adv("einv", "einvoice", 500n),
  ], f.loanId);
  // 13.3 records the sale as its own act (fc.sale_completed): foreclosure.sale.completed{sale_on: 2027-07-06, outcome: fnma_acquired}
  const r = await exec("13.6", "attorney.message.send", f.loanId, FC_OPS, { op: "fc.sale_completed", case_id: caseId, sale_on: "2027-07-06", outcome: "fnma_acquired", confirmation_required: false });
  const sale = r.events.find((e) => e.type === "foreclosure.sale.completed"); assert.ok(sale, `13.3's sale event (${r.events.map((e) => e.type).join(",")})`);
  await settle();
  Object.assign(LB, { f, caseId, firmId, saleEventId: sale.id, ready: true });
  return LB;
}

// ───────── the daily pass (Trigger & frequency; rule 2): a fresh "book" per test — its own database, runtime and clock ─────────
// T9, T13, T14 and T17 each need a book nobody else has touched (T13 counts the universe; T14 compares two runs of one fixture;
// T17 boards one loan with no hand-fed state), so each opens its own database from the migrated template (test-db.ts `suffix`),
// applies the neighbours' DDL and starts a Runtime whose clock it moves. The shared harness above keeps the sweep's daily pass
// off (`dailyCase: false`) so the breach tests never progress another test's fixture.
interface Book { readonly db: Db; readonly runtime: Runtime; readonly clock: MovableClock; readonly url: string; close(): Promise<void> }
async function openBook(suffix: string, startIso: string): Promise<Book> {
  const t = await testDatabase(import.meta.url, { suffix });
  if (t.skip) throw new Error(t.skip);
  const bdb = connect(t.url);
  await bdb.query(NEIGHBOUR_DDL);
  const bclock = new MovableClock(startIso);
  const brt = new Runtime({ db: bdb, registry: loadOverriddenRegistry(), clock: bclock, logger, environment: "nonprod", env: { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv, reviewers: null });
  brt.caseFolder.start();
  return { db: bdb, runtime: brt, clock: bclock, url: t.url, close: async () => { brt.caseFolder.stop(); await bdb.end(); await t.close(); } };
}
const bexec = (b: Book, process: string, name: string, loanId: string, actor: Actor, input: Record<string, unknown>) => b.runtime.execute({ process, name, loanId, actor, input });
const brows = <T extends Record<string, unknown>>(b: Book, sql: string, params: unknown[] = []) => b.db.query<T>(sql, params);
const bcount = (b: Book, sql: string, params: unknown[] = []) => count(b.db, sql, params);
const brec = (b: Book, kind: string, id: string, data: Record<string, unknown>, by = "agent:foreclosure-ops"): EntityRecord => ({ kind, id, data, version: 1, updatedAt: b.clock.now(), updatedBy: by });
async function bookLoan(b: Book, state: string, opts: { firstPaymentDate?: PlainDate; principalResidence?: boolean } = {}): Promise<Fixture> {
  return new PgLoanRepository(b.db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: opts.firstPaymentDate ?? D("2021-09-01"), maturityDate: D("2051-08-01"), property: { line1: "1 Test St", city: "Testville", state, postalCode: "33101" } });
}
async function bookFirm(b: Book, state: string): Promise<string> {
  const firmId = `firm-fake-${state.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  await b.runtime.entities.save([
    brec(b, "attorney_firms", firmId, { firm_id: firmId, legal_name: `FAKE Law Firm ${state}`, status: "retained", eo_expires_on: "2030-12-31", offices: [{ state }], dra_attorney_role: "retained" }),
    brec(b, "attorney_retentions", `${firmId}:${state}`, { firm_id: firmId, jurisdiction_state: state, form200_submitted_at: "2025-01-10", form200_response: "no_objection", form200_response_at: "2025-02-01", training_completed_at: "2025-02-15", lra_executed_at: "2025-03-01", retained_from: "2025-03-01", retained_to: null, suspended_from: null }),
  ], null);
  return firmId;
}
/** A foreclosure case at `prereferral`: the `cases` row (rule 2's universe) and 13.x's store row. `withCasesRow: false` seeds the store row only. */
async function bookForeclosureCase(b: Book, f: Fixture, state: string, method: "judicial" | "non_judicial", extra: Record<string, unknown> = {}, withCasesRow = true): Promise<string> {
  const caseId = withCasesRow
    ? (await brows<{ id: string }>(b, `INSERT INTO cases (case_type, loan_id, status, owner_role, opened_at) VALUES ('foreclosure', $1::uuid, 'prereferral', 'foreclosure-ops', $2::timestamptz) RETURNING id::text AS id`, [f.loanId, b.clock.now()]))[0]!.id
    : randomUUID();
  await b.runtime.entities.save([brec(b, "foreclosure_cases", caseId, { case_id: caseId, loan_id: f.loanId, jurisdiction_state: state, method, status: "prereferral", principal_residence: true, foreclosing_party: "partner", ...extra })], f.loanId);
  return caseId;
}
/** 13.3's referral through the bus, then (when `dispatch`) 35.9's `firm.dispatch{kind: referral_package}` to the FAKE firm — the outbox row the sweep drains. */
async function bookReferral(b: Book, f: Fixture, caseId: string, firmId: string, dispatch: boolean): Promise<{ eventId: string; dispatchId: string | null }> {
  const r = await bexec(b, "13.6", "attorney.message.send", f.loanId, FC_OPS, { op: "fc.send_referral", case_id: caseId, firm_id: firmId, day: 125, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: sha("note") }, { id: "mortgage", sha256: sha("mortgage") }] });
  const sent = r.events.find((e) => e.type === "foreclosure.referral.sent"); assert.ok(sent, "13.3 emitted foreclosure.referral.sent");
  let dispatchId: string | null = null;
  if (dispatch) { const d = (await bexec(b, "35.9", "firm.dispatch", f.loanId, FC_OPS, { loan_id: f.loanId, case_id: caseId, firm_id: firmId, kind: "referral_package", owning_event_id: sent.id })).output as { dispatch_id: string }; dispatchId = d.dispatch_id; }
  await b.runtime.caseFolder.settle();
  return { eventId: sent.id, dispatchId };
}
async function bookBankruptcyCase(b: Book, f: Fixture, caseNumber: string): Promise<string> {
  const c = await brows<{ id: string }>(b, `INSERT INTO cases (case_type, loan_id, status, owner_role, opened_at) VALUES ('bankruptcy', $1::uuid, 'active', 'bankruptcy-ops', $2::timestamptz) RETURNING id::text AS id`, [f.loanId, b.clock.now()]);
  const caseId = c[0]!.id;
  await b.runtime.entities.save([brec(b, "bankruptcy_cases", caseId, { case_id: caseId, loan_id: f.loanId, case_number_full: caseNumber, court_id: "flmb", chapter: 13, petition_date: "2027-01-10", status: "active", stay_status: "in_effect", principal_residence: true }, "agent:bankruptcy-ops")], f.loanId);
  return caseId;
}
/** 11.1's open early-intervention window as the counter leaves it (the `regx_ei_windows` row rule 2's universe reads). */
async function bookEiWindow(b: Book, f: Fixture, dueDate: string): Promise<void> {
  await b.db.query(`INSERT INTO regx_ei_windows (loan_id, due_date, principal_residence, live_due_at, notice_due_at, live_status, notice_status) VALUES ($1::uuid, $2::date, true, ($2::date + 36)::timestamptz, ($2::date + 45)::timestamptz, 'open', 'open')`, [f.loanId, dueDate]);
}
/** One sweep minute as the hosted runtime runs it (main.ts `sweep`: the origination and servicing daily sweeps, then Runtime.sweep — whose 35.9 pass runs 11.1's counter as the `delinquency_counters` unit — then the counter's once-per-loan-day catch-up, then the folder settled). */
async function hostedSweep(b: Book, iso: string): Promise<SweepReport> {
  b.clock.set(iso);
  await originationDailySweep(b.runtime, iso); await servicingDailySweep(b.runtime, iso);
  const r = await b.runtime.sweep(iso);
  await delinquencyDailySweep(b.runtime, iso, undefined, { oncePerDay: true });
  await b.runtime.caseFolder.settle();
  return r;
}
const expectationRows = (b: Book) => brows<{ loan_id: string; milestone_code: string; status: string; expected_on: string; due_on: string; basis: string }>(b, `SELECT loan_id::text AS loan_id, milestone_code, status, expected_on::text AS expected_on, due_on::text AS due_on, basis FROM case_milestone_expectations ORDER BY loan_id, milestone_code, expected_on, status`);
const timelineRows = (b: Book) => brows<{ loan_id: string; event_type: string; occurred_on: string; status_before: string | null; status_after: string | null; milestone_code: string | null; source: string }>(b, `SELECT loan_id::text AS loan_id, event_type, occurred_on::text AS occurred_on, status_before, status_after, milestone_code, source FROM case_timelines ORDER BY loan_id, event_sequence`);

test("35.9-T1: Given a boarded loan whose 13.3 `foreclosure.referral.sent` was committed on 2027-03-02, when the seam's post-commit hook and then `case.progress` run, then exactly one `case_timelines` row exists for that event (`event_id` unique; the second fold writes nothing) with `case_kind = foreclosure`, `status_before = prereferral`, `status_after = referred`, and `case.timeline{loan_id}` returns the loan's rows in `event_sequence` order with the case's current status.", { skip }, async () => {
  const { f, caseId, eventId } = await t1Fixture();
  // the seam's post-commit hook folded 13.3's commit: exactly one row for the event, the case's kind and status before/after
  const first = await rows<{ case_kind: string; status_before: string | null; status_after: string | null; case_id: string; event_sequence: string; source: string }>(`SELECT case_kind, status_before, status_after, case_id::text AS case_id, event_sequence::text AS event_sequence, source FROM case_timelines WHERE event_id = $1::uuid`, [eventId]);
  assert.equal(first.length, 1, "one case_timelines row per event (event_id unique)");
  assert.equal(first[0]!.case_kind, "foreclosure"); assert.equal(first[0]!.status_before, "prereferral"); assert.equal(first[0]!.status_after, "referred"); assert.equal(first[0]!.case_id, caseUuid(caseId)); assert.equal(first[0]!.source, "section");
  assert.equal(await count(db, `FROM loan_events WHERE type = $1 AND payload->>'event_id' = $2`, [EV.timelineAppended, eventId]), 1, "case.timeline.appended once");
  // then case.progress: the second fold writes nothing
  const before = await count(db, `FROM case_timelines WHERE loan_id = $1::uuid`, [f.loanId]);
  const r = await exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-03-02" });
  const out = r.output as { events_folded: number; steps: Record<string, { ran: boolean }> };
  assert.equal(out.events_folded, 0, "the second fold writes nothing"); assert.equal(out.steps["fold"]!.ran, true);
  await settle();
  assert.equal(await count(db, `FROM case_timelines WHERE loan_id = $1::uuid`, [f.loanId]), before);
  assert.equal(await count(db, `FROM case_timelines WHERE event_id = $1::uuid`, [eventId]), 1);
  // case.timeline{loan_id}: the loan's rows in event_sequence order with the case's current status
  const t = (await exec("35.9", "case.timeline", f.loanId, OPS, { loan_id: f.loanId })).output as { rows: { event_sequence: string; event_type: string; case_id: string }[]; cases: { case_id: string; current_status: string | null; case_kind: string }[] };
  const seqs = t.rows.map((x) => Number(x.event_sequence));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "rows in event_sequence order");
  assert.ok(t.rows.some((x) => x.event_type === "foreclosure.referral.sent"));
  const c = t.cases.find((x) => x.case_id === caseUuid(caseId))!;
  assert.equal(c.case_kind, "foreclosure"); assert.equal(c.current_status, "referred", "the case's current status is 13.3's row");
});

test("35.9-T2: Given loan L-A (Florida judicial, allowable 720, UPB 18745000¢, PTR 5.125%, LPI due 2025-03-01, one credited Chapter 13 delay of 84 days) and the firm's forecast sale 2027-11-02, when the daily unit runs on 2027-09-15, then 13.5's `comp_fee.exposure.updated` carries `actual_days = 928`, `credited_delay_days = 84`, `excess_days = 124`, `exposure_cents = 326368` and the forecast projection `452705`, and the same function returns `346164` for F-2-03 Example 1 (100,000 × 4.75% × 266 days).", { skip }, async () => {
  // loan L-A: Florida judicial, allowable 720, UPB 18745000¢, PTR 5.125%, LPI due 2025-03-01, the Chapter 13 delay 2026-02-10 → 2026-05-05 (code 67 reported and accepted: 84 credited), the firm's forecast sale 2027-11-02
  clock.set("2027-09-15T14:00:00.000Z");
  const f = await loanFixture("FL", 18_745_000n); const firmId = await seedFirm("FL");
  const caseId = await seedForeclosureCase(f, "FL", "judicial", { firm_id: firmId, status: "sale_scheduled", lpi_due_date: "2025-03-01", referral_sent_at: "2025-09-01", sale_scheduled_at: "2027-11-02" });
  await runtime.entities.save([
    rec("fc_timeframe_tracking", caseId, { case_id: caseId, loan_id: f.loanId, state: "FL", county: null, nyc: false, method_used: "judicial", method_preferred: "judicial", lpi_due_date: "2025-03-01", allowable_days: 720, exhibit_version: "2025-06-18", referral_sent_at: "2025-09-01", firm_id: firmId, sale_held_at: null, actual_days: null, credited_delay_days: 84, excess_days: 0, exposure_cents: null, exposure_as_of: null, status: "over_allowable", upb_cents: "18745000", ptr_pct: "5.125" }, "agent:foreclosure-ops"),
    rec("fc_delay_credits", `credit-${caseId}-bk13`, { id: `credit-${caseId}-bk13`, case_id: caseId, loan_id: f.loanId, category: "bk13", status_code_reported: "67", begin_on: "2026-02-10", end_on: "2026-05-05", actual_days: 84, cap_days: 125, credited_days: 84, reported_timely: true, report_ack_id: "ack-67" }, "agent:foreclosure-ops"),
  ], f.loanId);
  const r = (await exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-09-15" })).output as { steps: Record<string, { ran: boolean; detail?: Record<string, unknown>; error?: string }> };
  assert.equal(r.steps["exposure"]!.ran, true, JSON.stringify(r.steps["exposure"]));
  await settle();
  const ev = (await events("comp_fee.exposure.updated", f.loanId)).filter((e) => e.payload["basis"] === "daily_projection");
  assert.equal(ev.length, 1, "13.5's comp_fee.exposure.updated, once for the day"); assert.equal(ev[0]!.actor_id, "foreclosure-ops");
  const p = ev[0]!.payload as { actual_days: number; credited_delay_days: number; excess_days: number; exposure_cents: string; forecast: { sale_on: string; actual_days: number; excess_days: number; exposure_cents: string } };
  assert.equal(p.actual_days, 928); assert.equal(p.credited_delay_days, 84); assert.equal(p.excess_days, 124);
  assert.equal(BigInt(p.exposure_cents), 326_368n);                    // worked example A: 26.32003… × 124 = 3,263.6842… → $3,263.68
  assert.equal(BigInt(p.exposure_cents), EXAMPLE_A.today.exposure_cents);
  assert.equal(p.forecast.sale_on, "2027-11-02"); assert.equal(p.forecast.actual_days, 976); assert.equal(p.forecast.excess_days, 172);
  assert.equal(BigInt(p.forecast.exposure_cents), 452_705n);           // the firm's forecast sale: $4,527.05
  assert.equal(BigInt(p.forecast.exposure_cents), EXAMPLE_A.forecast.exposure_cents);
  // the tracking row carries the day's projection (13.5's row, written by 13.5's method)
  const t = (await rows<{ actual_days: string; excess_days: string; exposure_cents: string; exposure_as_of: string; updated_by: string }>(`SELECT data->>'actual_days' AS actual_days, data->>'excess_days' AS excess_days, data->>'exposure_cents' AS exposure_cents, data->>'exposure_as_of' AS exposure_as_of, updated_by FROM entity_current WHERE kind = 'fc_timeframe_tracking' AND id = $1`, [caseId]))[0]!;
  assert.equal(t.actual_days, "928"); assert.equal(t.excess_days, "124"); assert.equal(t.exposure_cents, "326368"); assert.equal(t.exposure_as_of, "2027-09-15"); assert.equal(t.updated_by, "agent:foreclosure-ops");
  // the same function reproduces F-2-03 Example 1 (13.5's figure) and the example's per-diem inputs
  assert.equal(exposureCents(10_000_000n, "4.75", 266), 346_164n);
  assert.equal(exposureCents(EXAMPLE_A.f203_example_1.upb_cents, EXAMPLE_A.f203_example_1.ptr_pct, EXAMPLE_A.f203_example_1.excess_days), EXAMPLE_A.f203_example_1.exposure_cents);
  assert.equal(exposureCents(18_745_000n, "5.125", 124), 326_368n); assert.equal(exposureCents(18_745_000n, "5.125", 172), 452_705n);
  assert.equal(EXAMPLE_A.upb_cents, 18_745_000n);                       // UPB $187,450.00
  // the 70% mark and the exhaustion date as the example states them (13.5's thresholds over allowable + credits)
  assert.equal(Math.ceil(0.7 * (720 + 84)), 563); assert.equal(addDays(D("2025-03-01"), 563), "2026-09-15"); assert.equal(addDays(D("2025-03-01"), 720 + 84 + 1), "2027-05-15");
  // a second run the same day re-emits nothing
  await exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-09-15" });
  assert.equal((await events("comp_fee.exposure.updated", f.loanId)).filter((e) => e.payload["basis"] === "daily_projection").length, 1);
});

test("35.9-T3: Given loan L-B (UPB 16392044¢, note rate 5.750%, paid to 2026-10-01, 30% BPMI, `servicer_direct`) with a sale held 2027-07-06 and the advances listed in worked example B, when `claims.sweep` opens the MI candidate on 2027-07-07 and `claims.package` runs, then 15.3's `mi_claim_calculations` row has `interest_cents = 719817` (9 × 78545 = 706905, plus the stub 5 × 25.8231 = 129.1155 → 12912), advances 740660, `claim_amount_cents = 17852521`, `benefit_cents = 5355756`, `claim_candidates.legal_due_on = 2027-08-05`, `package_due_on = 2027-07-14`, and `case.claim.package_built` names a `documents` row with a sha256.", { skip }, async () => {
  const { f, caseId } = await lbFixture();
  // claims.sweep on Wed 2027-07-07 opens the MI candidate (and the 571 candidate T4 packages) from the timeline's sale milestone
  clock.set("2027-07-07T14:00:00.000Z");
  const swept = (await exec("35.9", "claims.sweep", f.loanId, FC_OPS, { loan_id: f.loanId, as_of_date: "2027-07-07" })).output as { opened: { candidate_id: string; claim_kind: string; legal_due_on: string; legal_due_source: string | null; package_due_on: string }[] };
  await settle();
  const mi = swept.opened.find((c) => c.claim_kind === "mi_claim")!; const exp = swept.opened.find((c) => c.claim_kind === "expense_571")!;
  assert.ok(mi && exp, JSON.stringify(swept));
  assert.equal(mi.legal_due_on, "2027-08-05", "the earlier of MI_MP_CLAIM_FILE_60 (2027-09-04) and FNMA_F106_MI_DIRECT_FILE_30 (2027-08-05) governs"); assert.equal(mi.legal_due_source, "FNMA_F106_MI_DIRECT_FILE_30");
  assert.equal(mi.package_due_on, "2027-07-14");
  const clocks60 = (await timers("MI_MP_CLAIM_FILE_60", f.loanId)).filter((t) => t.status === "armed"); assert.equal(clocks60.length, 1); assert.equal(clocks60[0]!.due_date, "2027-09-04");
  const clocks30 = (await timers("FNMA_F106_MI_DIRECT_FILE_30", f.loanId)).filter((t) => t.status === "armed"); assert.equal(clocks30.length, 1); assert.equal(clocks30[0]!.due_date, "2027-08-05");
  const cand = (await rows<{ legal_due_on: string; package_due_on: string; status: string; claim_id: string; milestone_date: string; case_id: string }>(`SELECT legal_due_on::text AS legal_due_on, package_due_on::text AS package_due_on, status, claim_id, milestone_date::text AS milestone_date, case_id::text AS case_id FROM claim_candidates WHERE id = $1::uuid`, [mi.candidate_id]))[0]!;
  assert.equal(cand.legal_due_on, "2027-08-05"); assert.equal(cand.package_due_on, "2027-07-14"); assert.equal(cand.status, "opened"); assert.equal(cand.milestone_date, "2027-07-06"); assert.equal(cand.case_id, caseUuid(caseId));
  assert.equal((await timers(TIMERS_35_9.claimPackage, f.loanId)).filter((t) => t.status === "armed").length, 2, "SM_CLAIM_PACKAGE_5BD armed per candidate opened");
  // claims.package: 15.3's shadow claim (its figures), its package, the document with a sha256
  const built = (await exec("35.9", "claims.package", f.loanId, FC_OPS, { candidate_id: mi.candidate_id })).output as { claim_id: string; document_id: string; sha256: string; claim_amount_cents: string; benefit_cents: string };
  await settle();
  const calc = (await rows<{ data: Record<string, unknown> }>(`SELECT data FROM entity_current WHERE kind = 'mi_claim_calculations' AND data->>'claim_id' = $1 ORDER BY version DESC LIMIT 1`, [built.claim_id]))[0]!.data;
  const big = (v: unknown): bigint => BigInt(String(typeof v === "object" && v !== null && "$bigint" in (v as object) ? (v as { $bigint: string }).$bigint : v));
  assert.equal(big(calc["interest_cents"]), 719_817n);                       // 9 × $785.45 = $7,069.05 + the 5-day stub $129.12 = $7,198.17
  assert.equal(big(calc["monthly_interest_cents"]), 78_545n); assert.equal(Number(calc["stub_days"]), 5); assert.equal(big(calc["stub_cents"]), 12_912n); assert.equal(big(calc["monthly_interest_cents"]) * 9n, 706_905n);
  assert.equal(big(calc["claim_amount_cents"]), 17_852_521n);               // $178,525.21 = 163,920.44 + 7,198.17 + 7,406.60
  assert.equal(big(calc["claim_amount_cents"]) - 16_392_044n - 719_817n, 740_660n, "claimable advances $7,406.60");
  assert.equal(big(calc["benefit_cents"]), 5_355_756n);                      // 30% × 178,525.21 = 53,557.563 → $53,557.56
  assert.equal(big(calc["claim_amount_cents"]), EXAMPLE_B.claim_amount_cents); assert.equal(big(calc["benefit_cents"]), EXAMPLE_B.benefit_cents); assert.equal(big(calc["interest_cents"]), EXAMPLE_B.interest_cents);
  assert.equal(EXAMPLE_B.advances.taxes_cents + EXAMPLE_B.advances.hazard_premium_cents + EXAMPLE_B.advances.inspections_cents + EXAMPLE_B.advances.preservation_cents + EXAMPLE_B.advances.attorney_total_cents, 740_660n);
  assert.equal(EXAMPLE_B.advances.attorney_fee_cents + EXAMPLE_B.advances.attorney_costs_cents, 286_500n); assert.ok(286_500n < 600_000n, "attorney cap: min($6,000.00, 5% × UPB = $8,196.02) = $6,000.00");
  assert.equal(16_392_044n * 5n / 100n + (16_392_044n * 5n % 100n >= 50n ? 1n : 0n), 819_602n); assert.equal(EXAMPLE_B.advances.five_pct_upb_cents, 819_602n); assert.equal(EXAMPLE_B.advances.attorney_cap_cents, 600_000n);
  assert.equal(EXAMPLE_B.advances.inspection_unit_cents * 6n, 18_000n); assert.equal(EXAMPLE_B.upb_cents, 16_392_044n);
  const lines = calc["lines"] as { kind: string; claimable: boolean }[]; assert.ok(lines.some((l) => l.kind === "mi_premium" && !l.claimable) && lines.some((l) => l.kind === "technology_fee" && !l.claimable), "MI premiums and technology fees excluded");
  assert.equal(BigInt(built.claim_amount_cents), 17_852_521n); assert.equal(BigInt(built.benefit_cents), 5_355_756n);
  // case.claim.package_built names a documents row with a sha256; the candidate is package_built; the 5-BD clock is satisfied
  const pb = (await events(EV.claimPackageBuilt, f.loanId)).filter((e) => e.payload["candidate_id"] === mi.candidate_id);
  assert.equal(pb.length, 1); assert.equal(pb[0]!.payload["document_id"], built.document_id); assert.equal(pb[0]!.payload["sha256"], built.sha256);
  const doc = (await rows<{ sha256: string; retention_class: string; kind: string }>(`SELECT sha256, retention_class::text AS retention_class, kind FROM documents WHERE id = $1::uuid`, [built.document_id]))[0]!;
  assert.equal(doc.sha256, built.sha256); assert.match(doc.sha256, /^[0-9a-f]{64}$/); assert.equal(doc.retention_class, "fnma_reporting_7y"); assert.equal(doc.kind, "mi_claim_package");
  assert.equal((await rows<{ status: string; package_document_id: string }>(`SELECT status, package_document_id::text AS package_document_id FROM claim_candidates WHERE id = $1::uuid`, [mi.candidate_id]))[0]!.status, "package_built");
  assert.equal((await rows<{ status: string; package_id: string | null }>(`SELECT data->>'status' AS status, data->>'package_id' AS package_id FROM entity_current WHERE kind = 'mi_claims' AND id = $1`, [built.claim_id]))[0]!.status, "docs_pending", "15.3's own package state");
  Object.assign(LB, { miCandidate: mi.candidate_id, expenseCandidate: exp.candidate_id });
});

test("35.9-T4: Given the same loan's 571 candidate, when `claims.package` runs 15.2's validation and assembly, then `expense_claims.gross_cents = 832013`, `credits_cents = 75067` (258 ÷ 365 × 106200), `net_cents = 756946`, every `expense_claim_lines` row satisfies `amount_cents = unit_price_cents × quantity`, the MI premium line has `quantity = 9` and `unit_price_cents = 9817`, and `legal_due_on = 2027-08-05`.", { skip }, async () => {
  const { f, expenseCandidate } = await lbFixture();
  assert.ok(expenseCandidate, "T3 opened the 571 candidate");
  clock.set("2027-07-08T14:00:00.000Z");
  const cand = (await rows<{ legal_due_on: string; status: string }>(`SELECT legal_due_on::text AS legal_due_on, status FROM claim_candidates WHERE id = $1::uuid`, [expenseCandidate]))[0]!;
  assert.equal(cand.legal_due_on, "2027-08-05", "FNMA_F106_MI_EXPENSE_FINAL_30 (MI-insured: 30 days) governs, earlier than the 60-day 2027-09-04");
  assert.equal((await timers("FNMA_F106_MI_EXPENSE_FINAL_30", f.loanId)).filter((t) => t.status === "armed")[0]?.due_date, "2027-08-05");
  const built = (await exec("35.9", "claims.package", f.loanId, FC_OPS, { candidate_id: expenseCandidate })).output as { claim_id: string; document_id: string; sha256: string; gross_cents: string; net_cents: string };
  await settle();
  const claim = (await rows<{ data: Record<string, unknown> }>(`SELECT data FROM entity_current WHERE kind = 'expense_claims' AND id = $1`, [built.claim_id]))[0]!.data;
  const big = (v: unknown): bigint => BigInt(String(typeof v === "object" && v !== null && "$bigint" in (v as object) ? (v as { $bigint: string }).$bigint : v));
  assert.equal(big(claim["gross"]), 832_013n);                                // $8,320.13 = 2,914.60 + 1,062.00 + 883.53 + 180.00 + 385.00 + 2,300.00 + 565.00 + 30.00
  assert.equal(big(claim["net"]), 756_946n);                                  // $7,569.46 = 8,320.13 − 750.67
  assert.equal(big(claim["gross"]) - big(claim["net"]), 75_067n);            // credits_cents = $750.67 (258 ÷ 365 × 1,062.00)
  const credits = claim["credits"] as { kind: string; amount_cents: unknown }[];
  assert.equal(credits.length, 1); assert.equal(credits[0]!.kind, "hazard_refund"); assert.equal(big(credits[0]!.amount_cents), 75_067n);
  assert.equal(unearnedPremiumCredit(106_200n, D("2027-03-20"), D("2028-03-20"), D("2027-07-05")), 75_067n, "15.2's function: 258 unearned days from the sale date");
  assert.equal(daysBetween(D("2027-07-06"), D("2028-03-20")), 258);
  assert.equal(claim["status"], "package_ready", JSON.stringify(claim["exceptions"]));
  // every line satisfies amount_cents = unit_price_cents × quantity (the lines this process derived from the advances rows, one per row; the MI premium line 9 × $98.17)
  const decision = claim["lines"] as { advance_id: string; code: string; amount: unknown; validation: string }[];
  assert.equal(decision.length, 9, decision.map((l) => `${l.code}:${l.validation}`).join(","));
  for (const l of decision) assert.equal(l.validation, "pass", `${l.code}: ${JSON.stringify(l)}`);
  const byAdvance = new Map(decision.map((l) => [l.advance_id, big(l.amount)]));
  const advances = await rows<{ id: string; amount: string; quantity: string | null; unit: string | null }>(`SELECT id, data->'amount_cents'->>'$bigint' AS amount, data->>'quantity' AS quantity, data->'unit_price_cents'->>'$bigint' AS unit FROM entity_current WHERE kind = 'advances' AND data->>'loan_id' = $1`, [f.loanId]);
  for (const a of advances) {
    const quantity = Number(a.quantity ?? 1); const unit = a.unit !== null ? BigInt(a.unit) : BigInt(a.amount) / BigInt(quantity);
    assert.equal(byAdvance.get(a.id), unit * BigInt(quantity), `${a.id}: amount_cents = unit_price_cents × quantity`);
  }
  const mi = advances.find((a) => a.id.endsWith("-mi"))!; assert.equal(mi.quantity, "9"); assert.equal(mi.unit, "9817"); assert.equal(byAdvance.get(mi.id), 88_353n);   // 9 × $98.17 = $883.53
  assert.equal(byAdvance.get(advances.find((a) => a.id.endsWith("-tech"))!.id)! + byAdvance.get(advances.find((a) => a.id.endsWith("-einv"))!.id)!, 3_000n);   // technology + e-invoice $30.00
  assert.equal(EXAMPLE_C.gross_cents, 832_013n); assert.equal(EXAMPLE_C.credits_cents, 75_067n); assert.equal(EXAMPLE_C.net_cents, 756_946n); assert.equal(EXAMPLE_C.lines.mi_premiums_cents, 88_353n); assert.equal(EXAMPLE_C.lines.mi_premium_unit_cents, 9_817n);
  assert.equal(EXAMPLE_C.lines.taxes_cents + EXAMPLE_C.lines.hazard_premium_cents + EXAMPLE_C.lines.mi_premiums_cents + EXAMPLE_C.lines.inspections_cents + EXAMPLE_C.lines.preservation_cents + EXAMPLE_C.lines.attorney_fee_cents + EXAMPLE_C.lines.costs_cents + EXAMPLE_C.lines.technology_cents, 832_013n);
  const pb = (await events(EV.claimPackageBuilt, f.loanId)).filter((e) => e.payload["candidate_id"] === expenseCandidate);
  assert.equal(pb.length, 1); assert.equal(BigInt(String(pb[0]!.payload["gross_cents"])), 832_013n); assert.match(String(pb[0]!.payload["sha256"]), /^[0-9a-f]{64}$/);
  assert.equal((await rows<{ status: string }>(`SELECT status FROM claim_candidates WHERE id = $1::uuid`, [expenseCandidate]))[0]!.status, "package_built");
});

test("35.9-T5: Given `FNMA_E3205_FIRM_ACK_2BD` breached on a referred case with no acknowledgment, when the sweep's breach pass runs, then in the same transaction an `escalations` row is opened as today, `breach_actions{outcome: executed, action_kind: message_firm, registry_version}` exists with `command_event_id` = a 13.6 `attorney.message.send{kind: ack_demand}` event, a `firm_dispatches{kind: ack_demand}` row points at an `integration_messages` row on the `law-firm` adapter, and `breach_action.executed` is logged with the decision record; a second sweep writes no second action (`timer_id` unique).", { skip }, async () => {
  // a referred case (13.3's referral on Tue 2027-03-02) the firm never acknowledges: FNMA_E3205_FIRM_ACK_2BD (sent_at + 2 servicer business days) breaches on the 5th
  clock.set("2027-03-02T15:00:00.000Z");
  const f = await loanFixture("FL"); const firmId = await seedFirm("FL"); const caseId = await seedForeclosureCase(f, "FL", "judicial");
  await sendReferral(f, caseId, firmId);
  await settle();
  const armed = (await timers("FNMA_E3205_FIRM_ACK_2BD", f.loanId)).filter((t) => t.status === "armed");
  assert.equal(armed.length, 1); assert.equal(armed[0]!.due_date, "2027-03-04");
  const timerId = armed[0]!.id;
  const report = await sweepAt("2027-03-05T15:00:00.000Z");
  assert.ok(report.breaches.some((b) => b.timer_id === timerId), "the breach pass evaluated the clock");
  // in the same transaction: the escalation the pass opens today …
  const esc = (await escalationsFor(f.loanId)).filter((e) => e.sla_timer_id === timerId);
  assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "sev2"); assert.equal(esc[0]!.payload["timer_code"], "FNMA_E3205_FIRM_ACK_2BD");
  // … the breach_actions row: executed, message_firm, the registry version, the 13.6 command event
  const a = await actionOfTimer(timerId);
  assert.equal(a.length, 1); assert.equal(a[0]!.outcome, "executed"); assert.equal(a[0]!.action_kind, "message_firm"); assert.equal(a[0]!.registry_version, 1); assert.equal(a[0]!.escalation_id, esc[0]!.id);
  const cmd = await rows<{ type: string; payload: Record<string, unknown>; actor_id: string }>(`SELECT type, payload, actor_id FROM loan_events WHERE id = $1::uuid`, [a[0]!.command_event_id!]);
  assert.equal(cmd[0]!.type, "attorney.message.sent"); assert.equal(cmd[0]!.payload["kind"], "ack_demand"); assert.equal(cmd[0]!.payload["firm_id"], firmId); assert.equal(cmd[0]!.actor_id, "foreclosure-ops");
  assert.equal(await count(db, `FROM loan_events WHERE type = 'firm.scorecard.noted' AND loan_id = $1::uuid`, [f.loanId]), 1, "13.6's scorecard note");
  // the dispatch row points at the outbox row on the law-firm adapter
  const d = await rows<{ kind: string; firm_id: string; integration_message_id: string; adapter: string; idempotency_key: string; status: string }>(`SELECT d.kind, d.firm_id, d.integration_message_id::text AS integration_message_id, m.adapter, m.idempotency_key, m.status FROM firm_dispatches d JOIN integration_messages m ON m.id = d.integration_message_id WHERE d.loan_id = $1::uuid AND d.kind = 'ack_demand'`, [f.loanId]);
  assert.equal(d.length, 1); assert.equal(d[0]!.adapter, "law-firm"); assert.equal(d[0]!.firm_id, firmId); assert.match(d[0]!.idempotency_key, /^firm:.*:ack_demand:/);
  // breach_action.executed with the decision record
  const ex = (await events(EV.breachActionExecuted, f.loanId)).filter((e) => e.payload["timer_id"] === timerId);
  assert.equal(ex.length, 1); assert.equal(ex[0]!.payload["outcome"], "executed"); assert.equal(ex[0]!.payload["action_kind"], "message_firm");
  const dec = await rows<{ action: string; rule_code: string; rule_set_version: string; subject_id: string }>(`SELECT action, rule_code, rule_set_version, subject_id FROM agent_decisions WHERE loan_id = $1::uuid AND action = 'breach.execute:message_firm' AND subject_id = $2`, [f.loanId, timerId]);
  assert.equal(dec.length, 1); assert.equal(dec[0]!.rule_code, "FNMA_E3205_FIRM_ACK_2BD"); assert.equal(dec[0]!.rule_set_version, "default-ops.v1"); assert.equal(dec[0]!.subject_id, timerId);
  // a second sweep writes no second action (timer_id unique)
  await sweepAt("2027-03-05T15:01:00.000Z");
  assert.equal((await actionOfTimer(timerId)).length, 1);
  assert.equal(await count(db, `FROM firm_dispatches WHERE loan_id = $1::uuid AND kind = 'ack_demand'`, [f.loanId]), 1);
});

test("35.9-T6: Given `FNMA_E3302_SALE_CERT_WINDOW_7_15` breached at −7 days on an uncertified sale, when the breach pass runs, then 13.2's `attorney.instruction.send{kind: postpone_sale}` ran (`attorney.instruction.sent` on the timeline, `attorney_instructions` row) and `breach_actions.outcome = executed`; given the same breach on a case under `BK_362_STAY_GATE`, then the instruction is refused, `breach_actions{outcome: refused, refusal_code: BK_362_STAY_GATE}` exists, an `attorney` escalation is open and later sweeps do not retry.", { skip }, async () => {
  // an uncertified sale scheduled by the firm for Mon 2027-05-10: FNMA_E3302_SALE_CERT_WINDOW_7_15 closes at −7 (2027-05-03)
  clock.set("2027-03-02T15:00:00.000Z");
  const f = await loanFixture("FL"); const firmId = await seedFirm("FL"); const caseId = await seedForeclosureCase(f, "FL", "judicial");
  await sendReferral(f, caseId, firmId);
  clock.set("2027-04-01T15:00:00.000Z");
  await exec("13.2", "attorney.instruction.status", f.loanId, FC_OPS, { op: "firm_message", kind: "SALE_SCHEDULED", loan_id: f.loanId, case_id: caseId, firm_id: firmId, sale_at: "2027-05-10", method: "judicial" });
  await settle();
  const armed = (await timers("FNMA_E3302_SALE_CERT_WINDOW_7_15", f.loanId)).filter((t) => t.status === "armed");
  assert.equal(armed.length, 1); assert.equal(armed[0]!.due_date, "2027-05-03");
  const timerId = armed[0]!.id;
  await sweepAt("2027-05-04T15:00:00.000Z");
  const a = await actionOfTimer(timerId);
  assert.equal(a.length, 1); assert.equal(a[0]!.outcome, "executed", JSON.stringify(a[0])); assert.equal(a[0]!.action_kind, "instruct_firm");
  const sent = (await events("attorney.instruction.sent", f.loanId)).filter((e) => e.payload["kind"] === "POSTPONE_SALE");
  assert.equal(sent.length, 1, "13.2's attorney.instruction.send{kind: postpone_sale} ran"); assert.equal(a[0]!.command_event_id, sent[0]!.id);
  assert.equal(await count(db, `FROM case_timelines WHERE loan_id = $1::uuid AND event_id = $2::uuid`, [f.loanId, sent[0]!.id]), 1, "attorney.instruction.sent on the timeline");
  const instr = await rows<{ kind: string; status: string }>(`SELECT data->>'kind' AS kind, data->>'status' AS status FROM entity_current WHERE kind = 'attorney_instructions' AND data->>'loan_id' = $1 AND data->>'kind' = 'POSTPONE_SALE'`, [f.loanId]);
  assert.equal(instr.length, 1, "the attorney_instructions row"); assert.equal(instr[0]!.status, "sent");
  assert.equal((await events("foreclosure.sale.postpone_instructed", f.loanId)).length, 1);
  // the same breach on a case under the automatic stay: 13.1's gate refuses the instruction, nothing is sent, and later sweeps do not retry
  const g = await loanFixture("FL"); const caseB = await seedForeclosureCase(g, "FL", "judicial");
  clock.set("2027-03-02T15:00:00.000Z"); await sendReferral(g, caseB, firmId);
  clock.set("2027-04-01T15:00:00.000Z");
  await runtime.entities.save([rec("foreclosure_holds", `hold-${g.loanId}-bk_stay`, { id: `hold-${g.loanId}-bk_stay`, loan_id: g.loanId, case_id: caseB, kind: "bk_stay", status: "active", scope: ["refer", "first_notice", "judgment_motion", "sale_schedule", "sale_conduct", "eviction"], rule_citation: "11 U.S.C. §362(a)", opened_at: clock.now() }, "agent:bankruptcy-ops")], g.loanId);
  await exec("13.2", "attorney.instruction.status", g.loanId, FC_OPS, { op: "firm_message", kind: "SALE_SCHEDULED", loan_id: g.loanId, case_id: caseB, firm_id: firmId, sale_at: "2027-05-10", method: "judicial" });
  await settle();
  const armedB = (await timers("FNMA_E3302_SALE_CERT_WINDOW_7_15", g.loanId)).filter((t) => t.status === "armed");
  assert.equal(armedB.length, 1);
  await sweepAt("2027-05-04T15:00:00.000Z");
  const b = await actionOfTimer(armedB[0]!.id);
  assert.equal(b.length, 1); assert.equal(b[0]!.outcome, "refused"); assert.equal(b[0]!.refusal_code, "BK_362_STAY_GATE"); assert.equal(b[0]!.command_event_id, null);
  assert.equal((await events("attorney.instruction.sent", g.loanId)).length, 0, "the instruction was not sent");
  assert.ok((await events("foreclosure.gate.refused", g.loanId)).some((e) => e.payload["code"] === "BK_362_STAY_GATE"), "13.x's refusal on the log");
  const att = (await escalationsFor(g.loanId)).filter((e) => e.kind === "attorney" && e.status === "open" && e.payload["refusal_code"] === "BK_362_STAY_GATE");
  assert.equal(att.length, 1, "an attorney escalation is open");
  await sweepAt("2027-05-05T15:00:00.000Z"); await sweepAt("2027-05-06T15:00:00.000Z");
  assert.equal((await actionOfTimer(armedB[0]!.id)).length, 1, "later sweeps do not retry (one action per breach instance)");
  assert.equal((await events("attorney.instruction.sent", g.loanId)).length, 0);
});

test("35.9-T7: Given a code with no `breach_action_registry` row (any 3.x clock) breached, when the breach pass runs, then the escalation opens exactly as src/runtime/app.ts:270-291 does today and `breach_actions{outcome: escalated_only, escalation_id}` records it; given a `breach.recon` on a day with one `timer.breached` that has no `breach_actions` row (inserted directly in the test), then `breach_action.recon.run_completed{missing: 1}` is logged and one `compliance` escalation is open.", { skip }, async () => {
  // a 3.x clock (REGX_1024_17G_INITIAL_STMT_45) with no breach_action_registry row, armed on a loan and past due
  assert.equal(await count(db, `FROM breach_action_registry WHERE timer_code = 'REGX_1024_17G_INITIAL_STMT_45'`), 0);
  clock.set("2027-06-01T15:00:00.000Z");
  const f = await loanFixture("FL");
  const ev = await runtime.uow.run({ loanId: f.loanId }, (ctx) => ctx.events.append({ type: "escrow.initial_statement.required", loanId: f.loanId, actor: { kind: "agent", id: "escrow" }, payload: { loan_id: f.loanId, reason: "settlement", settlement_date: "2027-04-01" } }), { clock });
  const armed = (await timers("REGX_1024_17G_INITIAL_STMT_45", f.loanId)).filter((t) => t.status === "armed");
  assert.equal(armed.length, 1, `the 3.x clock armed (${ev.events.map((e) => e.type).join(",")})`); assert.equal(armed[0]!.due_date, "2027-05-16");
  const timerId = armed[0]!.id;
  const before = await count(db, `FROM escalations`);
  await sweepAt("2027-06-01T15:05:00.000Z");
  // the escalation opens exactly as the pass does today (sev<n>, the row's escalate-to role, the timer payload) …
  const esc = (await escalationsFor(f.loanId)).filter((e) => e.sla_timer_id === timerId);
  assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "sev2"); assert.equal(esc[0]!.owner_role, "escrow"); assert.equal(esc[0]!.payload["timer_code"], "REGX_1024_17G_INITIAL_STMT_45"); assert.equal(esc[0]!.payload["timer_id"], timerId);
  assert.ok((await count(db, `FROM escalations`)) > before);
  // … and breach_actions records it as escalated_only with that escalation
  const a = await actionOfTimer(timerId);
  assert.equal(a.length, 1); assert.equal(a[0]!.outcome, "escalated_only"); assert.equal(a[0]!.escalation_id, esc[0]!.id); assert.equal(a[0]!.command_event_id, null); assert.equal(a[0]!.registry_version, null);
  // the reconciliation: a timer.breached of the day inserted directly with no breach_actions row → missing: 1 and one compliance escalation
  const t2 = await rows<{ id: string }>(`INSERT INTO timers (code, subject_kind, subject_id, loan_id, armed_at, armed_by_event_id, anchor_date, due_at, status, breached_at) VALUES ('REGX_1024_17G_INITIAL_STMT_45', 'loan', $1::text, $1::uuid, $2::timestamptz, $3::uuid, '2027-04-01', $2::timestamptz, 'breached', $2::timestamptz) RETURNING id::text AS id`, [f.loanId, clock.now(), ev.events[0]!.id]);
  await db.query(`INSERT INTO loan_events (id, type, occurred_at, loan_id, actor_kind, actor_id, payload) VALUES (gen_random_uuid(), 'timer.breached', $1::timestamptz, $2::uuid, 'system', 'test-inserted', $3::jsonb)`, [clock.now(), f.loanId, JSON.stringify({ code: "REGX_1024_17G_INITIAL_STMT_45", timer_id: t2[0]!.id, severity: 2, escalate_to: ["escrow"], breach: "inserted directly" })]);
  // the next day's reconciliation counts the day's breaches (every timer.breached since the previous receipt): the inserted one has no action row
  clock.set("2027-06-02T13:00:00.000Z");
  const complianceBefore = await count(db, `FROM escalations WHERE owner_role = 'compliance' AND status = 'open' AND payload->>'as_of_date' = '2027-06-02'`);
  const r = (await exec("35.9", "breach.recon", "", OPS, { as_of_date: "2027-06-02" })).output as { missing: number; breaches: number; escalated_only: number; escalation_id: string | null; already?: boolean };
  assert.equal(r.already, false); assert.equal(r.missing, 1); assert.ok(r.breaches >= 2); assert.ok(r.escalated_only >= 1);
  const receipts = await rows<{ payload: Record<string, unknown> }>(`SELECT payload FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = '2027-06-02' ORDER BY sequence DESC LIMIT 1`, [EV.breachReconCompleted]);
  assert.equal(receipts[0]!.payload["missing"], 1);
  assert.equal(await count(db, `FROM escalations WHERE owner_role = 'compliance' AND status = 'open' AND payload->>'as_of_date' = '2027-06-02'`), complianceBefore + 1, "one compliance escalation");
  // once per day: a second reconciliation the same day writes nothing more
  const again = (await exec("35.9", "breach.recon", "", OPS, { as_of_date: "2027-06-02" })).output as { already?: boolean };
  assert.equal(again.already, true); assert.equal(await count(db, `FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = '2027-06-02'`, [EV.breachReconCompleted]), 1);
});

test("35.9-T8: Given 13.1's gates open, a completed 13.4 review with outcome `refer`, a retained FAKE firm for the state and no hold, when the daily unit runs, then `case.referral.proposed` is logged, a 35.8 proposal on `foreclosure_case.refer` for `officer` exists and `SM_CASE_REFERRAL_DECISION_2BD` is armed; when an `officer` approves, then `case.referral.decided{decision: approve}` and 13.3's `foreclosure.referral.sent` are in one transaction, `attorney_referrals` has the package manifest, `firm_dispatches{kind: referral_package}` points at the outbox row, the clock is satisfied and `FNMA_E3205_FIRM_ACK_2BD` is armed; when instead a 12.1 application is received before the decision, then approval is refused and `case.referral.decided{decision: cancelled, cause: gate_closed}` is logged.", { skip }, async () => {
  // 13.1's gates open on Tue 2027-03-02 (day 152 of delinquency, principal residence, package ready, a fresh DMDC certificate, no hold), a completed 13.4 review `refer`, a retained FAKE firm for FL
  clock.set("2027-03-02T15:00:00.000Z");
  const f = await loanFixture("FL"); const firmId = await seedFirm("FL");
  const pkg = await rows<{ id: string }>(`INSERT INTO documents (loan_id, kind, sha256, byte_size, storage_uri, retention_class) VALUES ($1::uuid, 'referral_package', $2, 12, 'mem://test/package', 'court_record_7y') RETURNING id::text AS id`, [f.loanId, sha("package")]);
  const caseId = await seedForeclosureCase(f, "FL", "judicial", { referral_package_document_id: pkg[0]!.id });
  await runtime.entities.save([
    rec("loans", f.loanId, { loan_id: f.loanId, earliest_unpaid_due: "2026-10-01", principal_residence: true, state: "FL", mortgagee_of_record: "Test Partner Servicing LLC", counters_as_of: "2027-03-02" }, "agent:default-collections"),
    rec("note_custody", `nc-${f.loanId}`, { loan_id: f.loanId, image_received_at: "2027-02-20", image_document_id: pkg[0]!.id, image_sha256: sha("package") }, "agent:security-records"),
    rec("scra_verifications", `scra-${f.loanId}`, { id: `scra-${f.loanId}`, loan_id: f.loanId, requested_at: "2027-02-25T12:00:00.000Z", method: "dmdc_single", status_date: "2027-02-25", on_active_duty: "N", certificate_id: "CERT-FAKE-1", purpose: "prereferral" }, "agent:foreclosure-ops"),
    rec("prereferral_reviews", `prr-${f.loanId}`, { id: `prr-${f.loanId}`, loan_id: f.loanId, case_id: caseId, started_at: "2027-02-20T12:00:00.000Z", completed_at: "2027-02-27T12:00:00.000Z", outcome: "refer", checklist: {}, valid_for_referral: true, reviewer_role: "foreclosure-ops" }, "agent:foreclosure-ops"),
  ], f.loanId);
  // the daily unit proposes
  const r = (await exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-03-02" })).output as { steps: Record<string, { ran: boolean; detail?: Record<string, unknown>; error?: string }> };
  assert.equal(r.steps["referral"]!.ran, true, JSON.stringify(r.steps["referral"])); assert.equal(r.steps["referral"]!.detail!["proposed"], true, JSON.stringify(r.steps["referral"]!.detail));
  await settle();
  const proposed = await events(EV.referralProposed, f.loanId);
  assert.equal(proposed.length, 1); assert.equal(proposed[0]!.payload["case_id"], caseId);
  // the firm is one 13.6 retains for FL (several FAKE firms are retained for FL in this database by now; the one seeded here is among them)
  const proposedFirm = String(proposed[0]!.payload["firm_id"]);
  const retention = await rows<{ state: string; retained_from: string | null; status: string }>(`SELECT r.data->>'jurisdiction_state' AS state, r.data->>'retained_from' AS retained_from, f.data->>'status' AS status FROM entity_current r JOIN entity_current f ON f.kind = 'attorney_firms' AND f.id = r.data->>'firm_id' WHERE r.kind = 'attorney_retentions' AND r.data->>'firm_id' = $1`, [proposedFirm]);
  assert.equal(retention.length, 1); assert.equal(retention[0]!.state, "FL"); assert.equal(retention[0]!.status, "retained"); assert.ok(retention[0]!.retained_from);
  assert.ok([firmId, proposedFirm].includes(proposedFirm)); assert.ok(Array.isArray(proposed[0]!.payload["gates"]) && (proposed[0]!.payload["gates"] as string[]).includes("REGX_1024_41F1_120_DAY_GATE"));
  const items = await rows<{ screen_code: string; required_role: string; status: string; source_kind: string; source_id: string }>(`SELECT screen_code, required_role, status, source_kind, source_id FROM work_items WHERE loan_id = $1::uuid AND source_kind = 'approval_pending'`, [f.loanId]);
  assert.equal(items.length, 1, "a 35.8 proposal"); assert.equal(items[0]!.screen_code, "foreclosure_case"); assert.equal(items[0]!.required_role, "officer"); assert.equal(items[0]!.source_id, `${caseId}:refer`); assert.equal(items[0]!.status, "open");
  const armed = (await timers(TIMERS_35_9.referralDecision, f.loanId)).filter((t) => t.status === "armed");
  assert.equal(armed.length, 1, "SM_CASE_REFERRAL_DECISION_2BD armed"); assert.equal(armed[0]!.due_date, addBusinessDays(D("2027-03-02"), 2, servicer));
  // a second daily run proposes nothing more
  const r2 = (await exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-03-02" })).output as { steps: Record<string, { detail?: Record<string, unknown> }> };
  assert.equal(r2.steps["referral"]!.detail!["proposal"], "open"); assert.equal((await events(EV.referralProposed, f.loanId)).length, 1);
  // the officer approves: decided{approve} and 13.3's foreclosure.referral.sent in one transaction
  clock.set("2027-03-03T15:00:00.000Z");
  const ok = await exec("35.9", "case.refer", f.loanId, OFFICER, { op: "decide", decision: "approve", case_id: caseId, reason: "eligible; package complete" });
  const types = ok.events.map((e) => e.type);
  assert.ok(types.includes(EV.referralDecided) && types.includes("foreclosure.referral.sent"), `one transaction: ${types.join(",")}`);
  const decided = (await events(EV.referralDecided, f.loanId)).filter((e) => e.payload["decision"] === "approve");
  assert.equal(decided.length, 1); assert.equal(decided[0]!.actor_kind, "human"); assert.equal(decided[0]!.actor_id, OFFICER.id);
  const sentEv = (await events("foreclosure.referral.sent", f.loanId))[0]!;
  assert.equal(decided[0]!.payload["referral_event_id"], sentEv.id);
  const referral = await rows<{ manifest: unknown; firm_id: string }>(`SELECT data->'package_manifest' AS manifest, data->>'firm_id' AS firm_id FROM entity_current WHERE kind = 'attorney_referrals' AND data->>'case_id' = $1`, [caseId]);
  assert.equal(referral.length, 1, "attorney_referrals has the package manifest"); assert.ok(referral[0]!.manifest && typeof referral[0]!.manifest === "object"); assert.equal(referral[0]!.firm_id, proposedFirm);
  assert.equal((await rows<{ status: string }>(`SELECT data->>'status' AS status FROM entity_current WHERE kind = 'foreclosure_cases' AND id = $1`, [caseId]))[0]!.status, "referred");
  const d = await rows<{ kind: string; integration_message_id: string; adapter: string; status: string; owning_event_id: string }>(`SELECT d.kind, d.integration_message_id::text AS integration_message_id, m.adapter, m.status, d.owning_event_id::text AS owning_event_id FROM firm_dispatches d JOIN integration_messages m ON m.id = d.integration_message_id WHERE d.loan_id = $1::uuid AND d.kind = 'referral_package'`, [f.loanId]);
  assert.equal(d.length, 1); assert.equal(d[0]!.adapter, "law-firm"); assert.equal(d[0]!.status, "queued"); assert.equal(d[0]!.owning_event_id, sentEv.id);
  const clockRow = (await rows<{ status: string }>(`SELECT status::text AS status FROM timers WHERE id = $1::uuid`, [armed[0]!.id]))[0]!;
  assert.ok(clockRow.status === "satisfied" || clockRow.status === "satisfied_late", `the decision clock is satisfied (${clockRow.status})`);
  assert.equal((await timers("FNMA_E3205_FIRM_ACK_2BD", f.loanId)).filter((t) => t.status === "armed").length, 1, "FNMA_E3205_FIRM_ACK_2BD armed");
  assert.equal((await rows<{ status: string }>(`SELECT status FROM work_items WHERE loan_id = $1::uuid AND source_kind = 'approval_pending'`, [f.loanId]))[0]!.status, "closed");
  // instead: a 12.1 application received before the decision closes the pre-filing gate — the approval is refused and the proposal cancelled
  const g = await loanFixture("FL"); const case2 = await seedForeclosureCase(g, "FL", "judicial", { referral_package_document_id: pkg[0]!.id });
  clock.set("2027-03-02T15:00:00.000Z");
  await runtime.entities.save([
    rec("loans", g.loanId, { loan_id: g.loanId, earliest_unpaid_due: "2026-10-01", principal_residence: true, state: "FL", mortgagee_of_record: "Test Partner Servicing LLC" }, "agent:default-collections"),
    rec("note_custody", `nc-${g.loanId}`, { loan_id: g.loanId, image_received_at: "2027-02-20", image_document_id: pkg[0]!.id, image_sha256: sha("package") }, "agent:security-records"),
    rec("scra_verifications", `scra-${g.loanId}`, { id: `scra-${g.loanId}`, loan_id: g.loanId, requested_at: "2027-02-25T12:00:00.000Z", method: "dmdc_single", status_date: "2027-02-25", on_active_duty: "N", certificate_id: "CERT-FAKE-2", purpose: "prereferral" }, "agent:foreclosure-ops"),
    rec("prereferral_reviews", `prr-${g.loanId}`, { id: `prr-${g.loanId}`, loan_id: g.loanId, case_id: case2, started_at: "2027-02-20T12:00:00.000Z", completed_at: "2027-02-27T12:00:00.000Z", outcome: "refer", checklist: {}, valid_for_referral: true, reviewer_role: "foreclosure-ops" }, "agent:foreclosure-ops"),
  ], g.loanId);
  await exec("35.9", "case.progress", g.loanId, OPS, { loan_id: g.loanId, as_of_date: "2027-03-02" });
  assert.equal((await events(EV.referralProposed, g.loanId)).length, 1);
  // 12.1's application (facially complete on a principal-residence loan) and 12.2's pre-filing hold row, as their tools leave them
  await runtime.entities.save([
    rec("lossmit_applications", `lm-${g.loanId}`, { id: `lm-${g.loanId}`, loan_id: g.loanId, status: "complete", received_on: "2027-03-02", complete_received_on: "2027-03-02", principal_residence: true }, "agent:lossmit-underwriter"),
    rec("foreclosure_holds", `hold-${g.loanId}-regx_f2`, { id: `hold-${g.loanId}-regx_f2`, loan_id: g.loanId, kind: "regx_f2_prefiling", status: "active", scope: ["refer", "first_notice"], rule_citation: "12 CFR 1024.41(f)(2)", opened_at: clock.now() }, "agent:lossmit-underwriter"),
  ], g.loanId);
  clock.set("2027-03-03T15:00:00.000Z");
  const refused = (await exec("35.9", "case.refer", g.loanId, OFFICER, { op: "decide", decision: "approve", case_id: case2 })).output as { decision: string; cause: string; blocked_by: string[] };
  assert.equal(refused.decision, "cancelled"); assert.equal(refused.cause, "gate_closed"); assert.ok(refused.blocked_by.some((b) => /REGX_1024_41F2_PRE_FILING_APP_GATE|HOLD:regx_f2_prefiling/.test(b)), refused.blocked_by.join(","));
  const cancelled = (await events(EV.referralDecided, g.loanId)).filter((e) => e.payload["decision"] === "cancelled");
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0]!.payload["cause"], "gate_closed");
  assert.equal((await events("foreclosure.referral.sent", g.loanId)).length, 0, "nothing was sent");
  assert.ok((await events("foreclosure.gate.refused", g.loanId)).length >= 1, "13.1's refusal is on the log");
  assert.equal(await count(db, `FROM firm_dispatches WHERE loan_id = $1::uuid`, [g.loanId]), 0);
});

test("35.9-T9: Given a referral dispatched on Mon 2027-03-01 to the FAKE firm with `first_legal` default 45 days, when the outbox drains and the sweep advances through Tue 2027-03-02, then `firm.inbound{kind: ack}` produced 13.3's `foreclosure.referral.acknowledged`, `firm_dispatches.acknowledged_at` is set with `ack_source = fake`, expectation `referral_ack` is `satisfied`, and expectation `first_legal` exists with `expected_on = 2027-04-15`, `due_on = 2027-04-18`, `basis = firm_forecast`.", { skip }, async () => {
  // Mon 2027-03-01 10:00 ET: a FL judicial case referred (13.3) and dispatched to the FAKE firm (35.9 firm.dispatch → the outbox row on `law-firm`)
  const b = await openBook("_t9", "2027-03-01T15:00:00.000Z");
  try {
    const f = await bookLoan(b, "FL"); const firmId = await bookFirm(b, "FL"); const caseId = await bookForeclosureCase(b, f, "FL", "judicial");
    const { eventId, dispatchId } = await bookReferral(b, f, caseId, firmId, true);
    const queued = await brows<{ status: string; adapter: string }>(b, `SELECT status, adapter FROM integration_messages WHERE id = (SELECT integration_message_id FROM firm_dispatches WHERE id = $1::uuid)`, [dispatchId]);
    assert.equal(queued[0]!.adapter, "law-firm"); assert.equal(queued[0]!.status, "queued", "the dispatch waits for the drain");
    // the expectations rule 4 writes on foreclosure.referral.sent: referral_ack (section clock) and first_legal from the jurisdiction default (45 days → 2027-04-15, due 04-18)
    const before = await expectationRows(b);
    assert.deepEqual(before.map((e) => [e.milestone_code, e.status, e.basis, e.expected_on, e.due_on]), [["first_legal", "expected", "jurisdiction_default", "2027-04-15", "2027-04-18"], ["referral_ack", "expected", "section_clock", "2027-03-03", "2027-03-03"]]);
    // the sweep of Mon 2027-03-01 after 05:30 ET drains the outbox (the FAKE accepts the referral package) and runs the day's units: the ack is not due yet (1 servicer business day)
    const day1 = await hostedSweep(b, "2027-03-01T15:05:00.000Z");
    assert.equal(day1.outbox_dispatch?.sent, 1, "the drain delivered the referral package");
    const sent = await brows<{ sent_at: string | null; acknowledged_at: string | null }>(b, `SELECT sent_at::text AS sent_at, acknowledged_at::text AS acknowledged_at FROM firm_dispatches WHERE id = $1::uuid`, [dispatchId]);
    assert.ok(sent[0]!.sent_at, "sent_at stamped by the completion hook"); assert.equal(sent[0]!.acknowledged_at, null);
    assert.equal(await bcount(b, `FROM loan_events WHERE type = 'foreclosure.referral.acknowledged' AND loan_id = $1::uuid`, [f.loanId]), 0);
    // Tue 2027-03-02: the daily unit's firm step ingests the FAKE's ack (firm.inbound{kind: ack}) → 13.3's foreclosure.referral.acknowledged
    const day2 = await hostedSweep(b, "2027-03-02T15:05:00.000Z");
    assert.equal(day2.default_case_daily?.already, false); assert.equal(day2.default_case_daily?.outcome, "completed");
    const inbound = await brows<{ payload: Record<string, unknown> }>(b, `SELECT payload FROM loan_events WHERE type = $1 AND loan_id = $2::uuid AND payload->>'kind' = 'ack'`, [EV.firmInboundReceived, f.loanId]);
    assert.equal(inbound.length, 1, "firm.inbound{kind: ack} once"); assert.equal(inbound[0]!.payload["dispatch_id"], dispatchId);
    const acked = await brows<{ id: string; actor_id: string; payload: Record<string, unknown> }>(b, `SELECT id::text AS id, actor_id, payload FROM loan_events WHERE type = 'foreclosure.referral.acknowledged' AND loan_id = $1::uuid`, [f.loanId]);
    assert.equal(acked.length, 1, "13.3's foreclosure.referral.acknowledged"); assert.equal(inbound[0]!.payload["owning_event_id"], acked[0]!.id, "the owning event is 13.3's");
    const d = (await brows<{ acknowledged_at: string | null; ack_source: string | null; ack_event_id: string | null; owning_event_id: string }>(b, `SELECT acknowledged_at::text AS acknowledged_at, ack_source, ack_event_id::text AS ack_event_id, owning_event_id::text AS owning_event_id FROM firm_dispatches WHERE id = $1::uuid`, [dispatchId]))[0]!;
    assert.ok(d.acknowledged_at, "acknowledged_at set"); assert.equal(d.ack_source, "fake"); assert.equal(d.owning_event_id, eventId);
    // referral_ack satisfied; first_legal now from the firm's forecast (basis firm_forecast, expected 2027-04-15 = referral + 45, due 04-18 = +3 calendar days), the default superseded
    const after = await expectationRows(b);
    const ack = after.filter((e) => e.milestone_code === "referral_ack"); assert.equal(ack.length, 1); assert.equal(ack[0]!.status, "satisfied");
    const fl = after.filter((e) => e.milestone_code === "first_legal" && e.status === "expected");
    assert.equal(fl.length, 1, "one open first_legal expectation"); assert.equal(fl[0]!.expected_on, "2027-04-15"); assert.equal(fl[0]!.due_on, "2027-04-18"); assert.equal(fl[0]!.basis, "firm_forecast");
    assert.ok(after.some((e) => e.milestone_code === "first_legal" && e.basis === "jurisdiction_default" && e.status === "cancelled"), "the default expectation was superseded");
  } finally { await b.close(); }
});

test("35.9-T10: Given expectation `first_legal` with `due_on = 2027-04-18` and no milestone recorded, when the daily unit runs on 2027-04-19, then its status is `due`, `case.milestone.due` is logged, one 35.8 `work_items` row exists with `source_kind = case_milestone`, `screen_code = foreclosure_case`, `required_role = attorney`, and `SM_CASE_MILESTONE_OVERDUE_5BD` is armed with `due_at` = 2027-04-18 + 5 servicer business days; when 13.3's `foreclosure.milestone.recorded{code: first_legal, source: dra}` is folded, then the expectation is `satisfied`, the item closes, the clock is satisfied and the next expectation is written.", { skip }, async () => {
  const { f, caseId, firmId } = await t1Fixture();
  // the expectation `first_legal` with due_on = 2027-04-18 (a firm forecast of 2027-04-15: due_on = expected_on + 3 calendar days, rule 4)
  clock.set("2027-03-03T15:00:00.000Z");
  // the firm acknowledged the referral on 2027-03-03 (13.3's ACK ingest): `referral_ack` is satisfied, so the only open expectation is first_legal
  await exec("13.2", "attorney.instruction.status", f.loanId, FC_OPS, { op: "firm_message", kind: "ACK", loan_id: f.loanId, case_id: caseId, firm_id: firmId, referral_id: `ref-${caseId}-2027-03-02`, complete: true, missing: [], acknowledged_on: "2027-03-03" });
  await settle();
  assert.equal((await rows<{ status: string }>(`SELECT status FROM case_milestone_expectations WHERE case_id = $1::uuid AND milestone_code = 'referral_ack' ORDER BY created_at DESC LIMIT 1`, [caseUuid(caseId)]))[0]!.status, "satisfied");
  await exec("35.9", "case.milestone.expect", f.loanId, FC_OPS, { loan_id: f.loanId, case_id: caseId, milestone_code: "first_legal", expected_on: "2027-04-15", basis: "firm_forecast", basis_ref: "fake-ack-1", supersede: true });
  await settle();
  const exp = (await rows<{ id: string; status: string; due_on: string; expected_on: string }>(`SELECT id::text AS id, status, due_on::text AS due_on, expected_on::text AS expected_on FROM case_milestone_expectations WHERE case_id = $1::uuid AND milestone_code = 'first_legal' AND status IN ('expected', 'due')`, [caseUuid(caseId)]))[0]!;
  assert.equal(exp.due_on, "2027-04-18"); assert.equal(exp.status, "expected");
  // the daily unit on 2027-04-19 (no milestone recorded)
  clock.set("2027-04-19T14:00:00.000Z");   // Mon 2027-04-19 10:00 ET
  const r = (await exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-04-19" })).output as { milestones_due: number };
  assert.equal(r.milestones_due, 1);
  const due = (await rows<{ status: string; work_item_id: string | null; timer_id: string | null }>(`SELECT status, work_item_id::text AS work_item_id, timer_id::text AS timer_id FROM case_milestone_expectations WHERE id = $1::uuid`, [exp.id]))[0]!;
  assert.equal(due.status, "due");
  const dueEv = await events(EV.milestoneDue, f.loanId);
  assert.equal(dueEv.length, 1); assert.equal(dueEv[0]!.payload["milestone_code"], "first_legal"); assert.equal(dueEv[0]!.payload["due_on"], "2027-04-18"); assert.equal(dueEv[0]!.payload["as_of_date"], "2027-04-19");
  const items = await rows<{ id: string; source_kind: string; screen_code: string; required_role: string; status: string }>(`SELECT id::text AS id, source_kind, screen_code, required_role, status FROM work_items WHERE source_id = $1`, [exp.id]);
  assert.equal(items.length, 1, "one 35.8 work_items row"); assert.equal(items[0]!.source_kind, "case_milestone"); assert.equal(items[0]!.screen_code, "foreclosure_case"); assert.equal(items[0]!.required_role, "attorney"); assert.equal(items[0]!.status, "open");
  assert.equal(due.work_item_id, items[0]!.id);
  const armed = (await timers(TIMERS_35_9.milestoneOverdue, f.loanId)).filter((t) => t.status === "armed");
  assert.equal(armed.length, 1, "SM_CASE_MILESTONE_OVERDUE_5BD armed");
  assert.equal(armed[0]!.anchor_date, "2027-04-18");
  assert.equal(armed[0]!.due_date, addBusinessDays(D("2027-04-18"), 5, servicer), "due_at = 2027-04-18 + 5 servicer business days");
  assert.equal(due.timer_id, armed[0]!.id);
  // 13.3's foreclosure.milestone.recorded{code: first_legal, source: dra} folded (the DRA import's ingest through 13.3's own tool)
  clock.set("2027-04-20T14:00:00.000Z");
  await exec("13.2", "attorney.instruction.status", f.loanId, FC_OPS, { op: "firm_message", kind: "MILESTONE", loan_id: f.loanId, case_id: caseId, firm_id: firmId, code: "FIRST_LEGAL", occurred_on: "2027-04-19", source: "dra" });
  await settle();
  const after = (await rows<{ status: string; satisfied_event_id: string | null }>(`SELECT status, satisfied_event_id::text AS satisfied_event_id FROM case_milestone_expectations WHERE id = $1::uuid`, [exp.id]))[0]!;
  assert.equal(after.status, "satisfied");
  const recorded = await events("foreclosure.milestone.recorded", f.loanId);
  assert.equal(after.satisfied_event_id, recorded[recorded.length - 1]!.id, "satisfied by 13.3's event");
  assert.equal((await rows<{ status: string }>(`SELECT status FROM work_items WHERE id = $1::uuid`, [items[0]!.id]))[0]!.status, "closed", "the item closes");
  const clockRow = (await rows<{ status: string }>(`SELECT status::text AS status FROM timers WHERE id = $1::uuid`, [armed[0]!.id]))[0]!;
  assert.ok(clockRow.status === "satisfied" || clockRow.status === "satisfied_late", `the clock is satisfied (${clockRow.status})`);
  assert.equal((await events(EV.milestoneSatisfied, f.loanId)).filter((e) => e.payload["milestone_code"] === "first_legal").length, 1);
  // the next expectation is written (FL judicial: first_legal → service_complete, jurisdiction default from the recorded date)
  const next = await rows<{ milestone_code: string; status: string; basis: string; expected_on: string }>(`SELECT milestone_code, status, basis, expected_on::text AS expected_on FROM case_milestone_expectations WHERE case_id = $1::uuid AND milestone_code = 'service_complete' AND status = 'expected'`, [caseUuid(caseId)]);
  assert.equal(next.length, 1); assert.equal(next[0]!.basis, "jurisdiction_default"); assert.equal(next[0]!.expected_on, addDays(D("2027-04-19"), 60));
});

test("35.9-T11: Given an open Chapter 13 case and `FakePacer.dockets` holding two new entries (`plan_confirmed` and a free-text objection), when `bk_docket_sync_daily` and then the daily unit run, then two `bankruptcy.docket.event.received{source: pcl}` events exist, `docket_reactions` has one row `{reaction_kind: status_change, needs_human: false}` with 14.1's `bankruptcy.status.changed` as `command_event_id` and `applied_at` set, and one row `{needs_human: true}` with a 35.8 item on `bankruptcy_case.docket` for `attorney`; `SM_DOCKET_REACTION_1BD` was armed and is satisfied by `case.docket.reacted`.", { skip }, async () => {
  clock.set("2027-04-05T15:00:00.000Z");
  const f = await loanFixture("FL"); const caseNumber = `3:27-bk-${uniq().slice(-5)}`; const caseId = await seedBankruptcyCase(f, caseNumber);
  pacerDockets().set(caseNumber, [{ seq: 11, filedOn: "2027-04-01", kind: "plan_confirmed", text: "Order confirming Chapter 13 plan" }, { seq: 12, filedOn: "2027-04-02", kind: "text", text: "Objection to claim 4-1 filed by the debtor" }]);
  // bk_docket_sync_daily: the sync ingests both entries; 14.1 applies the structured one it allows
  const sync = (await exec("35.9", "docket.sync", f.loanId, FC_OPS, { loan_id: f.loanId, case_id: caseId })).output as { entries: number; applied: string[]; stored: string[]; synced: boolean };
  assert.equal(sync.entries, 2); assert.equal(sync.synced, true); assert.deepEqual(sync.applied, [`dk-${f.loanId}-11`]); assert.deepEqual(sync.stored, [`dk-${f.loanId}-12`]);
  await settle();
  const received = await events("bankruptcy.docket.event.received", f.loanId);
  assert.equal(received.length, 2, "two bankruptcy.docket.event.received{source: pcl}"); for (const e of received) assert.equal(e.payload["source"], "pcl");
  const armed = (await timers(TIMERS_35_9.docketReaction, f.loanId));
  assert.ok(armed.length >= 1, "SM_DOCKET_REACTION_1BD was armed");
  // the daily unit reacts to the entry the sync stored
  const r = (await exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-04-05" })).output as { steps: Record<string, { detail?: Record<string, unknown>; error?: string }> };
  assert.deepEqual(r.steps["docket"]!.detail!["deferred"], [`dk-${f.loanId}-12`], JSON.stringify(r.steps["docket"]));
  await settle();
  const reactions = await rows<{ docket_event_id: string; reaction_kind: string; needs_human: boolean; command_event_id: string | null; classification: string; work_item_id: string | null }>(`SELECT docket_event_id, reaction_kind, needs_human, command_event_id::text AS command_event_id, classification, work_item_id::text AS work_item_id FROM docket_reactions WHERE loan_id = $1::uuid ORDER BY docket_event_id`, [f.loanId]);
  assert.equal(reactions.length, 2);
  const det = reactions.find((x) => x.docket_event_id === `dk-${f.loanId}-11`)!; const hum = reactions.find((x) => x.docket_event_id === `dk-${f.loanId}-12`)!;
  assert.equal(det.reaction_kind, "status_change"); assert.equal(det.needs_human, false);
  const cmd = (await rows<{ type: string; payload: Record<string, unknown>; actor_id: string }>(`SELECT type, payload, actor_id FROM loan_events WHERE id = $1::uuid`, [det.command_event_id!]))[0]!;
  assert.equal(cmd.type, "bankruptcy.status.changed"); assert.equal(cmd.payload["to"], "plan_confirmed"); assert.equal(cmd.actor_id, "bankruptcy-ops");
  const entry = (await rows<{ applied_at: string | null; updated_by: string }>(`SELECT data->>'applied_at' AS applied_at, updated_by FROM entity_current WHERE kind = 'bankruptcy_docket_events' AND id = $1`, [`dk-${f.loanId}-11`]))[0]!;
  assert.ok(entry.applied_at, "14.1 set applied_at"); assert.equal(entry.updated_by, "agent:bankruptcy-ops");
  assert.equal(hum.needs_human, true); assert.equal(hum.classification, "objection_to_claim");
  const item = (await rows<{ screen_code: string; required_role: string; status: string }>(`SELECT screen_code, required_role, status FROM work_items WHERE id = $1::uuid`, [hum.work_item_id!]))[0]!;
  assert.equal(item.screen_code, "bankruptcy_case"); assert.equal(item.required_role, "attorney"); assert.equal(item.status, "open");
  const reacted = await events(EV.docketReacted, f.loanId);
  assert.equal(reacted.length, 2);
  const clocks = await timers(TIMERS_35_9.docketReaction, f.loanId);
  assert.ok(clocks.some((t) => t.status === "satisfied" || t.status === "satisfied_late"), `satisfied by case.docket.reacted (${clocks.map((t) => t.status).join(",")})`);
  assert.equal(clocks.filter((t) => t.status === "armed").length, 0);
  Object.assign(BK, { f, caseId, caseNumber });
});
const BK = { f: null as unknown as Fixture, caseId: "", caseNumber: "" };

test("35.9-T12: Given a docket entry 14.1's classifier scores at 0.62, when `docket.react` runs, then no 14.1 write occurs, the reaction is `needs_human` and the entry's `applied_at` stays null until the `attorney` decides on the screen; given a `trustee_payment_received` entry naming an amount, then the reaction is `needs_human` regardless of confidence and no ledger line exists (the application is 35.8-T14's officer act).", { skip }, async () => {
  clock.set("2027-04-06T15:00:00.000Z");
  const f = await loanFixture("FL"); const caseNumber = `3:27-bk-${uniq().slice(-5)}`; const caseId = await seedBankruptcyCase(f, caseNumber);
  // a free-text entry 14.1's classifier scores at 0.62 (the FAKE classifier over its text), and a trustee payment naming an amount
  pacerDockets().set(caseNumber, [{ seq: 21, filedOn: "2027-04-03", kind: "text", text: "Objection to confirmation filed by creditor" }, { seq: 22, filedOn: "2027-04-04", kind: "trustee_payment_received", text: "Trustee disbursement $1,234.56 received" }]);
  await exec("35.9", "docket.sync", f.loanId, FC_OPS, { loan_id: f.loanId, case_id: caseId });
  const eventsBefore = await count(db, `FROM loan_events WHERE loan_id = $1::uuid AND type LIKE 'bankruptcy.%' AND type <> 'bankruptcy.docket.event.received'`, [f.loanId]);
  const ledgerBefore = await count(db, `FROM ledger_lines`);
  const r1 = (await exec("35.9", "docket.react", f.loanId, FC_OPS, { loan_id: f.loanId, docket_event_id: `dk-${f.loanId}-21` })).output as { needs_human: boolean; confidence: number; classification: string; command_event_id: string | null };
  assert.equal(r1.needs_human, true); assert.equal(r1.confidence, 0.62); assert.equal(r1.classification, "objection_to_claim"); assert.equal(r1.command_event_id, null);
  await settle();
  assert.equal(await count(db, `FROM loan_events WHERE loan_id = $1::uuid AND type LIKE 'bankruptcy.%' AND type <> 'bankruptcy.docket.event.received'`, [f.loanId]), eventsBefore, "no 14.1 write");
  const e21 = (await rows<{ applied_at: string | null; version: number }>(`SELECT data->>'applied_at' AS applied_at, version FROM entity_current WHERE kind = 'bankruptcy_docket_events' AND id = $1`, [`dk-${f.loanId}-21`]))[0]!;
  assert.equal(e21.applied_at, null, "applied_at stays null until the attorney decides"); assert.equal(e21.version, 1);
  const item = (await rows<{ required_role: string; status: string }>(`SELECT required_role, status FROM work_items WHERE source_id = $1`, [`docket:dk-${f.loanId}-21`]))[0]!;
  assert.equal(item.required_role, "attorney"); assert.equal(item.status, "open");
  // the trustee payment: needs_human regardless of confidence, no ledger line
  const r2 = (await exec("35.9", "docket.react", f.loanId, FC_OPS, { loan_id: f.loanId, docket_event_id: `dk-${f.loanId}-22` })).output as { needs_human: boolean; reaction_kind: string; command_event_id: string | null };
  assert.equal(r2.needs_human, true); assert.equal(r2.reaction_kind, "none"); assert.equal(r2.command_event_id, null);
  await settle();
  assert.equal(await count(db, `FROM ledger_lines`), ledgerBefore, "no ledger line (the application is 35.8-T14's officer act)");
  assert.equal((await rows<{ applied_at: string | null }>(`SELECT data->>'applied_at' AS applied_at FROM entity_current WHERE kind = 'bankruptcy_docket_events' AND id = $1`, [`dk-${f.loanId}-22`]))[0]!.applied_at, null);
  // the attorney decides on the screen: the deterministic class counsel names is applied through 14.1 and applied_at is set by 14.1
  const ATTY: Actor = { kind: "human", id: randomUUID(), role: "attorney" };
  const r3 = (await exec("35.9", "docket.react", f.loanId, ATTY, { loan_id: f.loanId, docket_event_id: `dk-${f.loanId}-21`, classification: "plan_confirmed" })).output as { needs_human: boolean; command_event_id: string | null };
  assert.equal(r3.needs_human, false); assert.ok(r3.command_event_id);
  const after = (await rows<{ applied_at: string | null; updated_by: string }>(`SELECT data->>'applied_at' AS applied_at, updated_by FROM entity_current WHERE kind = 'bankruptcy_docket_events' AND id = $1`, [`dk-${f.loanId}-21`]))[0]!;
  assert.ok(after.applied_at); assert.equal(after.updated_by, `human:${ATTY.id}`);
});

test("35.9-T13: Given the fixture book with three open foreclosure cases, one bankruptcy case, one claim candidate and two open early-intervention windows, when the sweep runs once after 05:30 ET, then 35.3's `cycle_runs` show `bk_docket_sync_daily`, `default_case_daily`, `claims_sweep_daily` and `dra_import_daily` for the day with receipts, one `default_case_daily_runs` row exists with `loans_scanned = 7`, `outcome = completed` and a stored report document, `default_case.daily.run_completed` and `breach_action.recon.run_completed` are logged once, and `SM_DEFAULT_CASE_DAILY` and `SM_BREACH_ACTION_RECON_DAILY` are re-armed for the next day; a second sweep the same day writes no second run (`as_of_date` unique).", { skip }, async () => {
  // the fixture book (Tue 2027-03-02): three open foreclosure cases, one bankruptcy case, one claim candidate on its own loan, two open early-intervention windows — seven loans
  const b = await openBook("_t13", "2027-03-02T09:00:00.000Z");   // 04:00 ET
  try {
    const firm = await bookFirm(b, "FL");
    const fc = [] as Fixture[];
    for (const state of ["FL", "FL", "TX"] as const) { const f = await bookLoan(b, state); await bookForeclosureCase(b, f, state, state === "TX" ? "non_judicial" : "judicial"); fc.push(f); }
    await bookReferral(b, fc[0]!, (await brows<{ id: string }>(b, `SELECT id::text AS id FROM cases WHERE loan_id = $1::uuid`, [fc[0]!.loanId]))[0]!.id, firm, true);
    const bk = await bookLoan(b, "FL"); await bookBankruptcyCase(b, bk, "6:27-bk-01001");
    // the claim candidate: a TX case whose sale 13.3 recorded (fc.sale_completed), the candidate as claims.sweep leaves it once packaged
    const cl = await bookLoan(b, "TX"); const clCase = await bookForeclosureCase(b, cl, "TX", "non_judicial", { status: "sale_scheduled", lpi_due_date: "2026-06-01", sale_scheduled_at: "2027-02-16" }, false);
    const sale = (await bexec(b, "13.6", "attorney.message.send", cl.loanId, FC_OPS, { op: "fc.sale_completed", case_id: clCase, sale_on: "2027-02-16", outcome: "fnma_acquired", confirmation_required: false })).events.find((e) => e.type === "foreclosure.sale.completed");
    assert.ok(sale); await b.runtime.caseFolder.settle();
    await b.db.query(`INSERT INTO claim_candidates (loan_id, case_id, claim_kind, milestone_event_id, milestone_kind, milestone_date, legal_due_on, package_due_on, status, opened_at, created_at, updated_at) VALUES ($1::uuid, $2::uuid, 'expense_571', $3::uuid, 'sale_completed', '2027-02-16', '2027-04-17', '2027-02-23', 'package_built', $4::timestamptz, $4::timestamptz, $4::timestamptz)`, [cl.loanId, caseUuid(clCase), sale.id, b.clock.now()]);
    const ei = [await bookLoan(b, "AZ"), await bookLoan(b, "AZ")];
    await bookEiWindow(b, ei[0]!, "2027-02-01"); await bookEiWindow(b, ei[1]!, "2027-02-01");
    assert.equal(await bcount(b, `FROM cases WHERE closed_at IS NULL AND case_type = 'foreclosure'`), 3); assert.equal(await bcount(b, `FROM cases WHERE closed_at IS NULL AND case_type = 'bankruptcy'`), 1);
    // a sweep before 05:30 ET runs no daily pass
    const early = await hostedSweep(b, "2027-03-02T09:30:00.000Z");
    assert.equal(early.default_case_daily, null, "not due before 05:30 ET"); assert.equal(await bcount(b, `FROM default_case_daily_runs`), 0);
    // the sweep once after 05:30 ET
    const r = await hostedSweep(b, "2027-03-02T10:45:00.000Z");   // 05:45 ET
    assert.ok(r.default_case_daily, "the daily pass ran"); assert.equal(r.default_case_daily!.already, false); assert.equal(r.default_case_daily!.outcome, "completed", JSON.stringify(r.default_case_daily!.cycles.flatMap((c) => c.units.filter((u) => u.outcome.status === "failed"))));
    assert.ok(r.passes.some((p) => p.name === "default_case.daily"), "logged as a pass"); assert.ok(r.passes.findIndex((p) => p.name === "default_case.daily") < r.passes.findIndex((p) => p.name === "timers.breach"), "before the breach pass");
    // 35.3's cycle_runs for the day with receipts
    const runs = await brows<{ cycle_code: string; period_key: string; status: string; units_total: number; units_done: number; receipts: string }>(b, `SELECT r.cycle_code, r.period_key, r.status, r.units_total, r.units_done, count(c.id)::text AS receipts FROM cycle_runs r LEFT JOIN cycle_receipts c ON c.run_id = r.id WHERE r.as_of_date = '2027-03-02' GROUP BY r.id ORDER BY r.cycle_code`);
    for (const code of ["bk_docket_sync_daily", "default_case_daily", "claims_sweep_daily", "dra_import_daily"]) {
      const run = runs.find((x) => x.cycle_code === code); assert.ok(run, `cycle_runs has ${code}`);
      assert.equal(run.period_key, "2027-03-02"); assert.equal(run.status, "completed"); assert.equal(run.receipts, "1", `${code} has its receipt`);
    }
    assert.equal(runs.find((x) => x.cycle_code === "default_case_daily")!.units_done, 7); assert.equal(runs.find((x) => x.cycle_code === "bk_docket_sync_daily")!.units_total, 1);
    for (const [code, ev] of [["bk_docket_sync_daily", EV.docketSyncRunCompleted], ["claims_sweep_daily", EV.claimsSweepRunCompleted], ["dra_import_daily", EV.draImportRunCompleted], ["delinquency_counters", EV.countersRunCompleted]] as const)
      assert.equal(await bcount(b, `FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = '2027-03-02'`, [ev]), 1, `${code} elected its receipt ${ev}`);
    // one default_case_daily_runs row: loans_scanned 7, completed, the stored report
    const rows13 = await brows<{ loans_scanned: number; outcome: string; report_document_id: string | null; receipt_event_id: string | null; cycle_run_ids: string[] }>(b, `SELECT loans_scanned, outcome, report_document_id::text AS report_document_id, receipt_event_id::text AS receipt_event_id, cycle_run_ids::text[] AS cycle_run_ids FROM default_case_daily_runs`);
    assert.equal(rows13.length, 1); assert.equal(rows13[0]!.loans_scanned, 7); assert.equal(rows13[0]!.outcome, "completed"); assert.equal(rows13[0]!.cycle_run_ids.length, 5);
    const doc = await brows<{ kind: string; retention_class: string; byte_size: number; sha256: string }>(b, `SELECT kind, retention_class::text AS retention_class, byte_size, sha256 FROM documents WHERE id = $1::uuid`, [rows13[0]!.report_document_id]);
    assert.equal(doc.length, 1, "a stored report document"); assert.equal(doc[0]!.kind, "default_case_daily_report"); assert.equal(doc[0]!.retention_class, "corporate_7y"); assert.ok(doc[0]!.byte_size > 0);
    // the receipts, once each; the two global clocks re-armed for the next day
    assert.equal(await bcount(b, `FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = '2027-03-02'`, [EV.dailyRunCompleted]), 1);
    assert.equal(await bcount(b, `FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = '2027-03-02'`, [EV.breachReconCompleted]), 1);
    assert.equal((await brows<{ id: string }>(b, `SELECT id::text AS id FROM loan_events WHERE id = $1::uuid AND type = $2`, [rows13[0]!.receipt_event_id, EV.dailyRunCompleted])).length, 1, "the run row points at its receipt");
    for (const code of [TIMERS_35_9.daily, TIMERS_35_9.recon]) {
      const armed = await brows<{ due_date: string; subject_kind: string }>(b, `SELECT due_date::text AS due_date, subject_kind::text AS subject_kind FROM timers WHERE code = $1 AND status = 'armed'`, [code]);
      assert.equal(armed.length, 1, `${code} armed`); assert.equal(armed[0]!.due_date, "2027-03-03", `${code} re-armed for the next day`); assert.equal(armed[0]!.subject_kind, "global");
    }
    // a second sweep the same day writes no second run (as_of_date unique)
    const again = await hostedSweep(b, "2027-03-02T12:00:00.000Z");
    assert.equal(again.default_case_daily?.already, true);
    assert.equal(await bcount(b, `FROM default_case_daily_runs`), 1); assert.equal(await bcount(b, `FROM loan_events WHERE type = $1`, [EV.dailyRunCompleted]), 1);
    assert.equal(await bcount(b, `FROM cycle_runs WHERE as_of_date = '2027-03-02'`), 5, "no second cycle run either");
  } finally { await b.close(); }
});

test("35.9-T14: Given the demo clock advanced 30 days over the fixture, then one `default_case_daily_runs` row per crossed day exists in date order, every expectation whose `due_on` fell in the window was marked `due` on that day (its `case.milestone.due` carries that `as_of_date`), the FAKE firm's milestone reports were folded on their forecast dates, and the same rows are produced by 30 hosted sweeps on consecutive days (the contract test compares the two runs' `case_timelines` and `case_milestone_expectations` by `(case_id, milestone_code, status, expected_on, due_on)`).", { skip }, async () => {
  // one fixture, two books: case A (FL judicial) referred Wed 2027-02-10 and dispatched to the FAKE firm (its FIRST_LEGAL report falls on 2027-03-27, inside the window);
  // case B (FL judicial) referred the same day and never dispatched (its default first_legal expectation, expected 03-27 / due 03-30, falls due inside the window and nobody reports it)
  const START = "2027-03-02T15:00:00.000Z", END = "2027-04-01T15:00:00.000Z";   // Tue 2027-03-02 10:00 ET → Thu 2027-04-01 11:00 ET: 30 crossed days
  async function fixture(b: Book): Promise<Record<string, string>> {
    b.clock.set("2027-02-10T15:00:00.000Z");
    const firm = await bookFirm(b, "FL"); const labels: Record<string, string> = {};
    const a = await bookLoan(b, "FL"); const ca = await bookForeclosureCase(b, a, "FL", "judicial"); await bookReferral(b, a, ca, firm, true); labels[a.loanId] = "A";
    const bb = await bookLoan(b, "FL"); const cb = await bookForeclosureCase(b, bb, "FL", "judicial"); await bookReferral(b, bb, cb, firm, false); labels[bb.loanId] = "B";
    b.clock.set(START);
    return labels;
  }
  const demo = await openBook("_t14_demo", START); const hosted = await openBook("_t14_hosted", START);
  try {
    const labelsDemo = await fixture(demo); const labelsHosted = await fixture(hosted);
    // the demo clock advanced 30 days (src/runtime/demo-clock.ts: one sweep minute per crossed day at noon ET, then the target)
    const offset = new OffsetClock(demo.clock);
    const demoRt = new Runtime({ db: demo.db, registry: loadOverriddenRegistry(), clock: offset, logger, environment: "nonprod", env: { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv, reviewers: null });
    demoRt.caseFolder.start();
    const adv = await advanceDemoClock({ runtime: demoRt, clock: offset, actor: "human:test" }, { to: END, budget_ms: 600_000 });
    await demoRt.caseFolder.settle(); demoRt.caseFolder.stop();
    assert.equal(adv.complete, true); assert.equal(adv.days_crossed, 30); assert.equal(adv.steps.length, 30);
    // one default_case_daily_runs row per crossed day, in date order
    const runs = await brows<{ as_of_date: string; outcome: string }>(demo, `SELECT as_of_date::text AS as_of_date, outcome FROM default_case_daily_runs ORDER BY created_at`);
    assert.equal(runs.length, 30, "one run per crossed day");
    assert.deepEqual(runs.map((r) => r.as_of_date), Array.from({ length: 30 }, (_, i) => addDays(D("2027-03-03"), i)), "in date order, 2027-03-03 … 2027-04-01");
    assert.ok(runs.every((r) => r.outcome === "completed"), `every run completed (${runs.filter((r) => r.outcome !== "completed").map((r) => `${r.as_of_date}:${r.outcome}`).join(",")})`);
    // every expectation whose due_on fell in the window was marked due on the day the unit found it past due (due_on + 1: rule 4 marks `due_on < as_of_date`), its case.milestone.due carrying that as_of_date
    const exps = await expectationRows(demo);
    const inWindow = exps.filter((e) => e.due_on >= "2027-03-02" && e.due_on < "2027-04-01" && e.status !== "cancelled" && e.status !== "satisfied");
    assert.ok(inWindow.length >= 1, "at least one expectation fell due in the window (case B's first_legal)");
    for (const e of inWindow) {
      assert.equal(e.status, "due", `${labelsDemo[e.loan_id]} ${e.milestone_code} is due`);
      const dueEv = await brows<{ payload: Record<string, unknown> }>(demo, `SELECT payload FROM loan_events WHERE type = $1 AND loan_id = $2::uuid AND payload->>'milestone_code' = $3`, [EV.milestoneDue, e.loan_id, e.milestone_code]);
      assert.equal(dueEv.length, 1); assert.equal(dueEv[0]!.payload["as_of_date"], addDays(D(e.due_on), 1), `marked on the day after ${e.due_on}`); assert.equal(dueEv[0]!.payload["due_on"], e.due_on);
    }
    const bFirst = exps.find((e) => labelsDemo[e.loan_id] === "B" && e.milestone_code === "first_legal" && e.status === "due");
    assert.ok(bFirst, "case B's first_legal (jurisdiction default, due 2027-03-30) is due"); assert.equal(bFirst.due_on, "2027-03-30");
    // the FAKE firm's reports folded on their forecast dates: case A's ack on Thu 02-11 (ingested on the first run, the ack's own date kept by 13.3) and FIRST_LEGAL on 2027-03-27
    const aLoan = Object.keys(labelsDemo).find((k) => labelsDemo[k] === "A")!;
    const tl = (await timelineRows(demo)).filter((r) => r.loan_id === aLoan);
    const fl = tl.filter((r) => r.event_type === "foreclosure.milestone.recorded");
    assert.equal(fl.length, 1, "FIRST_LEGAL recorded once"); assert.equal(fl[0]!.occurred_on, "2027-03-27", "on its forecast date"); assert.equal(fl[0]!.source, "firm");
    assert.ok(tl.some((r) => r.event_type === "foreclosure.referral.acknowledged"), "the ack folded");
    const aExp = exps.filter((e) => e.loan_id === aLoan);
    assert.ok(aExp.some((e) => e.milestone_code === "first_legal" && e.status === "satisfied" && e.basis === "firm_forecast"), "case A's first_legal satisfied by the firm's report");
    assert.ok(aExp.some((e) => e.milestone_code === "service_complete" && e.status === "expected"), "the next expectation written");
    // 30 hosted sweeps on consecutive days at the same instants produce the same rows
    for (const step of planSteps(START, END)) await hostedSweep(hosted, step.at);
    const relabel = <T extends { loan_id: string }>(rows: T[], labels: Record<string, string>) => rows.map(({ loan_id, ...rest }) => ({ loan: labels[loan_id], ...rest }));
    const key = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).sort();
    assert.deepEqual(key(relabel(await expectationRows(hosted), labelsHosted)), key(relabel(exps, labelsDemo)), "case_milestone_expectations by (case, milestone_code, status, expected_on, due_on)");
    const strip = (rows: Awaited<ReturnType<typeof timelineRows>>, labels: Record<string, string>) => relabel(rows, labels).map((r) => ({ loan: r.loan, event_type: r.event_type, occurred_on: r.occurred_on, status_before: r.status_before, status_after: r.status_after, milestone_code: r.milestone_code, source: r.source }));
    assert.deepEqual(key(strip(await timelineRows(hosted), labelsHosted)), key(strip(await timelineRows(demo), labelsDemo)), "case_timelines agree");
    assert.equal(await bcount(hosted, `FROM default_case_daily_runs`), 30);
  } finally { await demo.close(); await hosted.close(); }
});

test("35.9-T15: Given any command of this process, then the ledger and every money column of the sections' rows before and after are identical (contract test over `ledger_lines`, `advances`, `expense_claims`, `mi_claims`, `comp_fee_bills`), an input carrying `amount_cents`, `benefit_cents` or `exposure_cents` is refused `NO_MONEY_FIELD`, an attempt to register a `breach_action_registry` row whose `action_kind` the `cited_text` does not name is refused `ACTION_MATCHES_CITED_TEXT`, and a `compliance` registration without `officer` confirmation is refused.", { skip }, async () => {
  // the contract: the ledger and every money column of the sections' rows are identical before and after each 35.9 command
  clock.set("2027-07-01T15:00:00.000Z");
  const f = await loanFixture("TX"); const firmId = await seedFirm("TX"); const caseId = await seedForeclosureCase(f, "TX", "non_judicial");
  await runtime.entities.save([
    rec("advances", `adv-${f.loanId}-tax`, { id: `adv-${f.loanId}-tax`, loan_id: f.loanId, kind: "taxes", amount_cents: 291_460n, paid_at: "2027-01-15", invoice_document_id: "inv-tax", allowable_code: "TAX", borrower_recoverable: true, status: "outstanding" }, "agent:cashiering"),
    rec("comp_fee_bills", `bill-${f.loanId}`, { bill_id: `bill-${f.loanId}`, loan_id: f.loanId, period: "2027-06", amount_cents: 12_345n, upb_cents: 16_392_044n, days_billed: 10 }, "agent:foreclosure-ops"),
    rec("mi_claims", `mi-${f.loanId}`, { id: `mi-${f.loanId}`, loan_id: f.loanId, status: "opened", expected_benefit_cents: 5_355_756n, filer: "servicer_direct" }, "agent:claims-reo"),
    rec("expense_claims", `claim-${f.loanId}`, { id: `claim-${f.loanId}`, loan_id: f.loanId, status: "draft", gross: 832_013n, net: 756_946n, credits: [] }, "agent:claims-reo"),
  ], f.loanId);
  await sendReferral(f, caseId, firmId); await settle();
  const money = async () => ({
    ledger: (await rows<{ c: string; s: string }>(`SELECT count(*)::text AS c, coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines`))[0],
    kinds: await rows<{ kind: string; versions: string; fingerprint: string }>(`SELECT kind, count(*)::text AS versions, md5(string_agg(data::text, '|' ORDER BY id, version)) AS fingerprint FROM entity_records WHERE kind IN ('advances', 'expense_claims', 'mi_claims', 'comp_fee_bills') AND loan_id = $1 GROUP BY kind ORDER BY kind`, [f.loanId]),
  });
  const commands: { name: string; input: Record<string, unknown>; actor?: Actor }[] = [
    { name: "case.timeline", input: { loan_id: f.loanId } },
    { name: "case.progress", input: { loan_id: f.loanId, as_of_date: "2027-07-01" } },
    { name: "case.milestone.expect", input: { loan_id: f.loanId, case_id: caseId, milestone_code: "first_legal", expected_on: "2027-08-15", basis: "person", basis_ref: "the contract test" }, actor: FC_OPS },
    { name: "firm.dispatch", input: { loan_id: f.loanId, case_id: caseId, kind: "message", payload: { subject: "contract test" } }, actor: FC_OPS },
    { name: "case.milestone.record", input: { loan_id: f.loanId, case_id: caseId, milestone_code: "TITLE_ORDERED", occurred_on: "2027-07-01", source: "firm" }, actor: FC_OPS },
    { name: "claims.sweep", input: { loan_id: f.loanId, as_of_date: "2027-07-01" }, actor: FC_OPS },
    { name: "firm.inbound", input: { loan_id: f.loanId, firm_id: firmId, kind: "milestone", case_id: caseId, payload: { code: "TITLE_REVIEWED", occurred_on: "2027-07-01" } }, actor: FC_OPS },
    { name: "breach.recon", input: { as_of_date: "2027-07-01" } },
  ];
  for (const c of commands) {
    const before = await money();
    await exec("35.9", c.name, c.name === "breach.recon" ? "" : f.loanId, c.actor ?? OPS, c.input);
    await settle();
    assert.deepEqual(await money(), before, `${c.name} moved no money column and no ledger line`);
  }
  // NO_MONEY_FIELD: an input carrying amount_cents, benefit_cents or exposure_cents is refused
  for (const key of ["amount_cents", "benefit_cents", "exposure_cents"]) {
    await assert.rejects(exec("35.9", "case.milestone.expect", f.loanId, FC_OPS, { loan_id: f.loanId, case_id: caseId, milestone_code: "judgment", expected_on: "2027-09-01", basis: "person", [key]: "100" }), (e: Error) => /NO_MONEY_FIELD/.test(e.message));
    await assert.rejects(exec("35.9", "case.progress", f.loanId, OPS, { loan_id: f.loanId, as_of_date: "2027-07-01", changes: { [key]: 1n } }), (e: Error) => /NO_MONEY_FIELD/.test(e.message));
  }
  // ACTION_MATCHES_CITED_TEXT: a registration whose action_kind the cited_text does not name is refused (compliance with an officer's confirmation, otherwise well-formed)
  const COMPLIANCE: Actor = { kind: "human", id: randomUUID(), role: "compliance" };
  const approval = { approvals: [{ id: OFFICER.id, role: "officer" }] };
  await assert.rejects(exec("35.9", "breach.execute", "", COMPLIANCE, { op: "register", timer_code: "SM_BK_DOCKET_SYNC_1BD", action_kind: "instruct_firm", action_spec: { process: "13.2", tool: "attorney.instruction.send" }, ...approval }), (e: Error) => /ACTION_MATCHES_CITED_TEXT/.test(e.message));
  await assert.rejects(exec("35.9", "breach.execute", "", COMPLIANCE, { op: "register", timer_code: "SM_BK_DOCKET_SYNC_1BD", action_kind: "cancel_clock", action_spec: {}, ...approval }), (e: Error) => /NO_CLOCK_EDIT/.test(e.message));
  // a compliance registration without officer confirmation is refused; with it, the row is re-versioned (the cited text names the sync)
  await assert.rejects(exec("35.9", "breach.execute", "", COMPLIANCE, { op: "register", timer_code: "SM_BK_DOCKET_SYNC_1BD", action_kind: "run_tool", action_spec: { process: "35.9", tool: "docket.sync", input_derivation: "docketSyncFromCase" } }), (e: Error) => /REGISTRATION_NEEDS_OFFICER_CONFIRMATION/.test(e.message));
  await assert.rejects(exec("35.9", "breach.execute", "", OPS, { op: "register", timer_code: "SM_BK_DOCKET_SYNC_1BD", action_kind: "run_tool", action_spec: {}, ...approval }), (e: Error) => /REGISTRY_CHANGE_IS_COMPLIANCE|ROLE/.test(e.message));
  const ok = (await exec("35.9", "breach.execute", "", COMPLIANCE, { op: "register", timer_code: "SM_BK_DOCKET_SYNC_1BD", action_kind: "run_tool", action_spec: { process: "35.9", tool: "docket.sync", input_derivation: "docketSyncFromCase" }, ...approval })).output as { version: number };
  assert.equal(ok.version, 2);
  assert.equal((await rows<{ version: number; cited_text: string }>(`SELECT version, cited_text FROM breach_action_registry WHERE timer_code = 'SM_BK_DOCKET_SYNC_1BD'`))[0]!.version, 2);
  assert.equal(await count(db, `FROM breach_action_registry`), 9, "re-versioned, never a second row");
});

const LA = { f: null as Fixture | null, caseId: "", firmId: "" };
test("35.9-T16: Given the timeline of loan L-A at any point, then no row of this process changed `foreclosure_cases.status` (the only writers of that column are 13.x tools — asserted by the `loan_events` actor and `agent_decisions.agent` on every transition), and a 13.x status the expectation map has no edge for (a test-injected `closed_cancelled` from `prereferral`) logs `case.status.unexpected` and opens an `ops_analyst` work item without altering the section's row.", { skip }, async () => {
  // loan L-A: a Florida judicial case referred by 13.3 (its own tool, its own status write), read by this process's fold
  clock.set("2027-03-02T15:00:00.000Z");
  const f = await loanFixture("FL", 18_745_000n); const firmId = await seedFirm("FL"); const caseId = await seedForeclosureCase(f, "FL", "judicial", { lpi_due_date: "2025-03-01" });
  await sendReferral(f, caseId, firmId);
  await settle();
  // every status transition on the timeline was a 13.x tool's commit: the event's actor is the section's agent and its decision record is the 13.x tool's, never 35.9's
  const transitions = await rows<{ event_id: string; status_before: string | null; status_after: string | null; actor_kind: string; actor_id: string; occurred_at: string }>(`SELECT t.event_id::text AS event_id, t.status_before, t.status_after, e.actor_kind::text AS actor_kind, e.actor_id, e.occurred_at::text AS occurred_at FROM case_timelines t JOIN loan_events e ON e.id = t.event_id WHERE t.loan_id = $1::uuid AND t.status_before IS DISTINCT FROM t.status_after ORDER BY t.event_sequence`, [f.loanId]);
  assert.ok(transitions.length >= 1);
  for (const tr of transitions) assert.equal(`${tr.actor_kind}:${tr.actor_id}`, "agent:foreclosure-ops", "the transition's event is the section's agent's");
  // the decision records behind those commands are the 13.x tools' (rule set 13.x, action the 13.x tool), one per transition at least; the 35.9 decisions on the loan are folds only
  const sectionDecisions = await rows<{ action: string; rule_set_version: string; agent: string }>(`SELECT action, rule_set_version, agent FROM agent_decisions WHERE loan_id = $1::uuid AND rule_set_version LIKE '13.%' ORDER BY created_at`, [f.loanId]);
  assert.ok(sectionDecisions.length >= transitions.length, "a 13.x decision record per transition");
  for (const d of sectionDecisions) { assert.equal(d.agent, "foreclosure-ops"); assert.match(d.action, /^attorney\./); }
  const ownDecisions = await rows<{ action: string }>(`SELECT action FROM agent_decisions WHERE loan_id = $1::uuid AND rule_set_version IN ('default-ops.v1', '35.9@tools.v1')`, [f.loanId]);
  for (const d of ownDecisions) assert.match(d.action, /^case\.timeline\.fold$|^case\.progress$|^case\.milestone\./, `a 35.9 decision never names a status write (${d.action})`);
  // no version of the section's row was written by this process: every foreclosure_cases version (after the fixture's seed) coincides with a 13.x event on the timeline, written by the section's agent
  const versions = await rows<{ version: number; updated_by: string; status: string; updated_at: string }>(`SELECT version, updated_by, data->>'status' AS status, updated_at::text AS updated_at FROM entity_records WHERE kind = 'foreclosure_cases' AND id = $1 ORDER BY version`, [caseId]);
  assert.ok(versions.length >= 2, "the seed and 13.3's referral");
  for (const v of versions.slice(1)) {
    assert.equal(v.updated_by, "agent:foreclosure-ops");
    const at = await count(db, `FROM case_timelines t JOIN loan_events e ON e.id = t.event_id WHERE t.loan_id = $1::uuid AND e.occurred_at = $2::timestamptz AND e.actor_id = 'foreclosure-ops' AND t.event_type LIKE 'foreclosure.%'`, [f.loanId, v.updated_at]);
    assert.ok(at >= 1, `foreclosure_cases v${v.version} (${v.status}) was written by a 13.x command on the timeline`);
  }
  // a 13.x status the expectation map has no edge for: a test-injected closed_cancelled from prereferral on a second case
  const f2 = await loanFixture("FL"); const case2 = await seedForeclosureCase(f2, "FL", "judicial");
  await runtime.entities.save([rec("foreclosure_cases", case2, { case_id: case2, loan_id: f2.loanId, jurisdiction_state: "FL", method: "judicial", status: "closed_cancelled", principal_residence: true }, "agent:test-injected", 2)], f2.loanId);
  await runtime.uow.run({ loanId: f2.loanId }, (ctx) => ctx.events.append({ type: "foreclosure.sale.cancelled", loanId: f2.loanId, aggregate: { kind: "case", id: case2 }, actor: { kind: "agent", id: "test-injected" }, payload: { loan_id: f2.loanId, case_id: case2, reason: "test-injected" } }), { clock });
  await settle();
  const unexpected = await events(EV.statusUnexpected, f2.loanId);
  assert.equal(unexpected.length, 1); assert.equal(unexpected[0]!.payload["from"], "prereferral"); assert.equal(unexpected[0]!.payload["to"], "closed_cancelled"); assert.equal(unexpected[0]!.payload["case_id"], caseUuid(case2));
  const item = await rows<{ required_role: string; status: string; screen_code: string }>(`SELECT required_role, status, screen_code FROM work_items WHERE id = $1::uuid`, [String(unexpected[0]!.payload["work_item_id"])]);
  assert.equal(item.length, 1); assert.equal(item[0]!.required_role, "ops_analyst"); assert.equal(item[0]!.status, "open");
  // the section's row is untouched: still the injected status, still the injected writer, no new version
  const v2 = await rows<{ version: number; updated_by: string; status: string }>(`SELECT version, updated_by, data->>'status' AS status FROM entity_current WHERE kind = 'foreclosure_cases' AND id = $1`, [case2]);
  assert.equal(v2[0]!.version, 2); assert.equal(v2[0]!.status, "closed_cancelled"); assert.equal(v2[0]!.updated_by, "agent:test-injected");
  assert.equal((await rows<{ status_before: string; status_after: string }>(`SELECT status_before, status_after FROM case_timelines WHERE loan_id = $1::uuid`, [f2.loanId]))[0]!.status_after, "closed_cancelled");
  Object.assign(LA, { f, caseId, firmId });
});

test("35.9-T17: Given loan L-B boarded on the hosted runtime with 35.5's `loan_installments` (the installment due 2026-10-01 left `due`), a `loan_servicing_configs.time_zone` of America/Phoenix, no `regx_ei_windows` row and no hand-fed state, when the demo clock advances from 2026-10-01 to 2026-11-06 with 35.3 planning `delinquency_counters` after `cashiering_daily` each day, then `cycle_runs` holds one `delinquency_counters` run per crossed day with `period_key` equal to that day and a `cycle_receipts` row each, 11.1's `loan.delinquency.window_opened{due_date: \"2026-10-01\"}` is on L-B's log exactly once with the counter's actor `{agent, default-collections}` (delinquency.ts:26), a `regx_ei_windows` row is open for it, `REGX_1024_39A_LIVE_CONTACT_36` is armed on that window with `due_at` on the 36th day of delinquency as 11.1's row computes it in the loan's zone, `loan.delinquency.day_reached` is logged for each 11.1 milestone on the loan-local date, `default_case_daily` selected L-B from the open window on the day it opened, and running the same day's unit twice adds no event (35.3 rule 3).", { skip }, async () => {
  // loan L-B boarded on the hosted runtime: 35.5's installment due 2026-10-01 left `due`, a Phoenix servicing config, no regx_ei_windows row, nothing hand-fed
  const b = await openBook("_t17", "2026-10-01T16:00:00.000Z");   // Thu 2026-10-01 12:00 ET / 09:00 Phoenix
  try {
    const lb = await bookLoan(b, "TX", { firstPaymentDate: D("2026-10-01") });
    await b.db.query(`INSERT INTO loan_installments (loan_id, due_date, pi_cents, interest_cents, principal_cents, escrow_cents, status) VALUES ($1::uuid, '2026-10-01', 161234, 134502, 26732, 43278, 'due')`, [lb.loanId]);
    await b.db.query(`INSERT INTO loan_servicing_configs (loan_id, effective_from, time_zone, time_zone_source, jurisdiction_state) VALUES ($1::uuid, '2026-01-01', 'America/Phoenix', 'state_default', 'TX')`, [lb.loanId]);
    assert.equal(await bcount(b, `FROM regx_ei_windows WHERE loan_id = $1::uuid`, [lb.loanId]), 0);
    // the demo clock advances 2026-10-01 → 2026-11-06 (36 crossed days; each step's sweep plans delinquency_counters before default_case_daily)
    const offset = new OffsetClock(b.clock);
    const rt = new Runtime({ db: b.db, registry: loadOverriddenRegistry(), clock: offset, logger, environment: "nonprod", env: { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv, reviewers: null });
    rt.caseFolder.start();
    const adv = await advanceDemoClock({ runtime: rt, clock: offset, actor: "human:test" }, { to: "2026-11-06T20:00:00.000Z", budget_ms: 600_000 });   // 13:00 Phoenix on day 36
    await rt.caseFolder.settle();
    assert.equal(adv.complete, true); assert.equal(adv.days_crossed, 36);
    // cycle_runs: one delinquency_counters run per crossed day, period_key = the day, a cycle_receipts row each
    const runs = await brows<{ period_key: string; as_of_date: string; status: string; units_done: number; units_skipped: number; receipts: string }>(b, `SELECT r.period_key, r.as_of_date::text AS as_of_date, r.status, r.units_done, r.units_skipped, count(c.id)::text AS receipts FROM cycle_runs r LEFT JOIN cycle_receipts c ON c.run_id = r.id WHERE r.cycle_code = 'delinquency_counters' GROUP BY r.id ORDER BY r.as_of_date`);
    assert.equal(runs.length, 36, "one run per crossed day");
    assert.deepEqual(runs.map((r) => r.period_key), Array.from({ length: 36 }, (_, i) => addDays(D("2026-10-02"), i)));
    assert.ok(runs.every((r) => r.period_key === r.as_of_date && r.status === "completed" && r.receipts === "1"), "period_key = the day, completed, one receipt each");
    assert.ok(runs.every((r) => r.units_done === 1 && r.units_skipped === 0), `the unit did the day's work each day (${runs.map((r) => `${r.as_of_date}:${r.units_done}/${r.units_skipped}`).join(",")})`);
    // the counter's row for L-B carries the loan's zone (35.5 rule 9)
    const unit = (await brows<{ payload: Record<string, unknown> }>(b, `SELECT payload FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = '2026-10-02'`, [EV.countersRunCompleted]))[0]!;
    assert.equal(unit.payload["units_done"], 1);
    assert.equal(await bcount(b, `FROM loan_events WHERE type = $1`, [EV.countersRunCompleted]), 36);
    // 11.1's window opened exactly once, by the counter's actor
    const opened = await brows<{ actor_kind: string; actor_id: string; payload: Record<string, unknown>; occurred_at: string }>(b, `SELECT actor_kind, actor_id, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = 'loan.delinquency.window_opened' AND loan_id = $1::uuid`, [lb.loanId]);
    assert.equal(opened.length, 1, "window_opened once"); assert.equal(opened[0]!.payload["due_date"], "2026-10-01"); assert.equal(opened[0]!.actor_kind, "agent"); assert.equal(opened[0]!.actor_id, "default-collections");
    const win = await brows<{ live_status: string; due_date: string; live_due_at: string }>(b, `SELECT live_status, due_date::text AS due_date, live_due_at::text AS live_due_at FROM regx_ei_windows WHERE loan_id = $1::uuid`, [lb.loanId]);
    assert.equal(win.length, 1); assert.equal(win[0]!.live_status, "open"); assert.equal(win[0]!.due_date, "2026-10-01");
    // REGX_1024_39A_LIVE_CONTACT_36 armed on the window, due on the 36th day of delinquency (2026-11-06) as 11.1's row computes it
    const live = await brows<{ status: string; due_date: string; anchor_date: string; due_at: string }>(b, `SELECT status::text AS status, due_date::text AS due_date, anchor_date::text AS anchor_date, due_at::text AS due_at FROM timers WHERE code = 'REGX_1024_39A_LIVE_CONTACT_36' AND loan_id = $1::uuid`, [lb.loanId]);
    assert.equal(live.length, 1, "one live-contact clock"); assert.equal(live[0]!.anchor_date, "2026-10-01"); assert.equal(live[0]!.due_date, "2026-11-06"); assert.equal(live[0]!.status, "armed", "still armed at 13:00 Phoenix on day 36");
    // loan.delinquency.day_reached for each 11.1 milestone in the window, on the loan-local date
    const reached = await brows<{ payload: Record<string, unknown> }>(b, `SELECT payload FROM loan_events WHERE type = 'loan.delinquency.day_reached' AND loan_id = $1::uuid ORDER BY sequence`, [lb.loanId]);
    assert.deepEqual(reached.map((r) => [Number(r.payload["day"]), r.payload["on"]]), [[16, "2026-10-17"], [20, "2026-10-21"], [30, "2026-10-31"], [36, "2026-11-06"]]);
    assert.equal(await bcount(b, `FROM loan_events WHERE type = 'delinquency.counters.updated' AND loan_id = $1::uuid AND payload->>'on' = '2026-11-06'`, [lb.loanId]), 1, "13.1's counters once for the day (35.3 rule 3)");
    // default_case_daily selected L-B from the open window on the day it opened (its unit's decision record on 2026-10-02)
    const selected = await brows<{ subject_id: string }>(b, `SELECT subject_id FROM agent_decisions WHERE loan_id = $1::uuid AND action = 'case.progress' AND subject_id = '2026-10-02'`, [lb.loanId]);
    assert.equal(selected.length, 1, "case.progress ran for L-B on 2026-10-02");
    assert.equal(await bcount(b, `FROM agent_decisions WHERE loan_id = $1::uuid AND action = 'case.progress' AND subject_id = '2026-10-01'`, [lb.loanId]), 0, "not before the window opened");
    // running the same day's unit twice adds no event (35.3 rule 3): the counters unit and the daily unit for 2026-11-06 again
    const domainEvents = () => bcount(b, `FROM loan_events WHERE loan_id = $1::uuid AND type NOT LIKE 'command.%'`, [lb.loanId]);
    const before = await domainEvents();
    const again = await delinquencyDailySweep(rt, "2026-11-06T20:30:00.000Z", [lb.loanId], { oncePerDay: true });
    assert.deepEqual(again.skipped, [{ loan_id: lb.loanId, reason: "already_ran_today" }]);
    await bexec(b, "35.9", "case.progress", lb.loanId, OPS, { loan_id: lb.loanId, as_of_date: "2026-11-06" });
    await rt.caseFolder.settle();
    const middle = await domainEvents();
    await bexec(b, "35.9", "case.progress", lb.loanId, OPS, { loan_id: lb.loanId, as_of_date: "2026-11-06" });
    await rt.caseFolder.settle();
    assert.equal(await domainEvents(), middle, "the second run of the day's unit adds no event"); assert.equal(middle, before, "nor did the first re-run");
    rt.caseFolder.stop();
  } finally { await b.close(); }
});

