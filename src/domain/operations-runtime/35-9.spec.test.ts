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
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createLogger } from "../../runtime/log.ts";
import type { EntityRecord } from "../../app/tools.ts";
import { EV, TIMERS_35_9, ENGINE_ACTOR } from "./default-35-9.ts";
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

test("35.9-T2: Given loan L-A (Florida judicial, allowable 720, UPB 18745000¢, PTR 5.125%, LPI due 2025-03-01, one credited Chapter 13 delay of 84 days) and the firm's forecast sale 2027-11-02, when the daily unit runs on 2027-09-15, then 13.5's `comp_fee.exposure.updated` carries `actual_days = 928`, `credited_delay_days = 84`, `excess_days = 124`, `exposure_cents = 326368` and the forecast projection `452705`, and the same function returns `346164` for F-2-03 Example 1 (100,000 × 4.75% × 266 days).", { todo: true });
test("35.9-T3: Given loan L-B (UPB 16392044¢, note rate 5.750%, paid to 2026-10-01, 30% BPMI, `servicer_direct`) with a sale held 2027-07-06 and the advances listed in worked example B, when `claims.sweep` opens the MI candidate on 2027-07-07 and `claims.package` runs, then 15.3's `mi_claim_calculations` row has `interest_cents = 719817` (9 × 78545 = 706905, plus the stub 5 × 25.8231 = 129.1155 → 12912), advances 740660, `claim_amount_cents = 17852521`, `benefit_cents = 5355756`, `claim_candidates.legal_due_on = 2027-08-05`, `package_due_on = 2027-07-14`, and `case.claim.package_built` names a `documents` row with a sha256.", { todo: true });
test("35.9-T4: Given the same loan's 571 candidate, when `claims.package` runs 15.2's validation and assembly, then `expense_claims.gross_cents = 832013`, `credits_cents = 75067` (258 ÷ 365 × 106200), `net_cents = 756946`, every `expense_claim_lines` row satisfies `amount_cents = unit_price_cents × quantity`, the MI premium line has `quantity = 9` and `unit_price_cents = 9817`, and `legal_due_on = 2027-08-05`.", { todo: true });
test("35.9-T5: Given `FNMA_E3205_FIRM_ACK_2BD` breached on a referred case with no acknowledgment, when the sweep's breach pass runs, then in the same transaction an `escalations` row is opened as today, `breach_actions{outcome: executed, action_kind: message_firm, registry_version}` exists with `command_event_id` = a 13.6 `attorney.message.send{kind: ack_demand}` event, a `firm_dispatches{kind: ack_demand}` row points at an `integration_messages` row on the `law-firm` adapter, and `breach_action.executed` is logged with the decision record; a second sweep writes no second action (`timer_id` unique).", { todo: true });
test("35.9-T6: Given `FNMA_E3302_SALE_CERT_WINDOW_7_15` breached at −7 days on an uncertified sale, when the breach pass runs, then 13.2's `attorney.instruction.send{kind: postpone_sale}` ran (`attorney.instruction.sent` on the timeline, `attorney_instructions` row) and `breach_actions.outcome = executed`; given the same breach on a case under `BK_362_STAY_GATE`, then the instruction is refused, `breach_actions{outcome: refused, refusal_code: BK_362_STAY_GATE}` exists, an `attorney` escalation is open and later sweeps do not retry.", { todo: true });
test("35.9-T7: Given a code with no `breach_action_registry` row (any 3.x clock) breached, when the breach pass runs, then the escalation opens exactly as src/runtime/app.ts:270-291 does today and `breach_actions{outcome: escalated_only, escalation_id}` records it; given a `breach.recon` on a day with one `timer.breached` that has no `breach_actions` row (inserted directly in the test), then `breach_action.recon.run_completed{missing: 1}` is logged and one `compliance` escalation is open.", { todo: true });
test("35.9-T8: Given 13.1's gates open, a completed 13.4 review with outcome `refer`, a retained FAKE firm for the state and no hold, when the daily unit runs, then `case.referral.proposed` is logged, a 35.8 proposal on `foreclosure_case.refer` for `officer` exists and `SM_CASE_REFERRAL_DECISION_2BD` is armed; when an `officer` approves, then `case.referral.decided{decision: approve}` and 13.3's `foreclosure.referral.sent` are in one transaction, `attorney_referrals` has the package manifest, `firm_dispatches{kind: referral_package}` points at the outbox row, the clock is satisfied and `FNMA_E3205_FIRM_ACK_2BD` is armed; when instead a 12.1 application is received before the decision, then approval is refused and `case.referral.decided{decision: cancelled, cause: gate_closed}` is logged.", { todo: true });
test("35.9-T9: Given a referral dispatched on Mon 2027-03-01 to the FAKE firm with `first_legal` default 45 days, when the outbox drains and the sweep advances through Tue 2027-03-02, then `firm.inbound{kind: ack}` produced 13.3's `foreclosure.referral.acknowledged`, `firm_dispatches.acknowledged_at` is set with `ack_source = fake`, expectation `referral_ack` is `satisfied`, and expectation `first_legal` exists with `expected_on = 2027-04-15`, `due_on = 2027-04-18`, `basis = firm_forecast`.", { todo: true });
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

test("35.9-T11: Given an open Chapter 13 case and `FakePacer.dockets` holding two new entries (`plan_confirmed` and a free-text objection), when `bk_docket_sync_daily` and then the daily unit run, then two `bankruptcy.docket.event.received{source: pcl}` events exist, `docket_reactions` has one row `{reaction_kind: status_change, needs_human: false}` with 14.1's `bankruptcy.status.changed` as `command_event_id` and `applied_at` set, and one row `{needs_human: true}` with a 35.8 item on `bankruptcy_case.docket` for `attorney`; `SM_DOCKET_REACTION_1BD` was armed and is satisfied by `case.docket.reacted`.", { todo: true });
test("35.9-T12: Given a docket entry 14.1's classifier scores at 0.62, when `docket.react` runs, then no 14.1 write occurs, the reaction is `needs_human` and the entry's `applied_at` stays null until the `attorney` decides on the screen; given a `trustee_payment_received` entry naming an amount, then the reaction is `needs_human` regardless of confidence and no ledger line exists (the application is 35.8-T14's officer act).", { todo: true });
test("35.9-T13: Given the fixture book with three open foreclosure cases, one bankruptcy case, one claim candidate and two open early-intervention windows, when the sweep runs once after 05:30 ET, then 35.3's `cycle_runs` show `bk_docket_sync_daily`, `default_case_daily`, `claims_sweep_daily` and `dra_import_daily` for the day with receipts, one `default_case_daily_runs` row exists with `loans_scanned = 7`, `outcome = completed` and a stored report document, `default_case.daily.run_completed` and `breach_action.recon.run_completed` are logged once, and `SM_DEFAULT_CASE_DAILY` and `SM_BREACH_ACTION_RECON_DAILY` are re-armed for the next day; a second sweep the same day writes no second run (`as_of_date` unique).", { todo: true });
test("35.9-T14: Given the demo clock advanced 30 days over the fixture, then one `default_case_daily_runs` row per crossed day exists in date order, every expectation whose `due_on` fell in the window was marked `due` on that day (its `case.milestone.due` carries that `as_of_date`), the FAKE firm's milestone reports were folded on their forecast dates, and the same rows are produced by 30 hosted sweeps on consecutive days (the contract test compares the two runs' `case_timelines` and `case_milestone_expectations` by `(case_id, milestone_code, status, expected_on, due_on)`).", { todo: true });
test("35.9-T15: Given any command of this process, then the ledger and every money column of the sections' rows before and after are identical (contract test over `ledger_lines`, `advances`, `expense_claims`, `mi_claims`, `comp_fee_bills`), an input carrying `amount_cents`, `benefit_cents` or `exposure_cents` is refused `NO_MONEY_FIELD`, an attempt to register a `breach_action_registry` row whose `action_kind` the `cited_text` does not name is refused `ACTION_MATCHES_CITED_TEXT`, and a `compliance` registration without `officer` confirmation is refused.", { todo: true });
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

test("35.9-T17: Given loan L-B boarded on the hosted runtime with 35.5's `loan_installments` (the installment due 2026-10-01 left `due`), a `loan_servicing_configs.time_zone` of America/Phoenix, no `regx_ei_windows` row and no hand-fed state, when the demo clock advances from 2026-10-01 to 2026-11-06 with 35.3 planning `delinquency_counters` after `cashiering_daily` each day, then `cycle_runs` holds one `delinquency_counters` run per crossed day with `period_key` equal to that day and a `cycle_receipts` row each, 11.1's `loan.delinquency.window_opened{due_date: \"2026-10-01\"}` is on L-B's log exactly once with the counter's actor `{agent, default-collections}` (delinquency.ts:26), a `regx_ei_windows` row is open for it, `REGX_1024_39A_LIVE_CONTACT_36` is armed on that window with `due_at` on the 36th day of delinquency as 11.1's row computes it in the loan's zone, `loan.delinquency.day_reached` is logged for each 11.1 milestone on the loan-local date, `default_case_daily` selected L-B from the open window on the day it opened, and running the same day's unit twice adds no event (35.3 rule 3).", { todo: true });
