// 35.8 Operator work screens: the per-loan and per-application work the console lacks, each screen a bus tool with server-derived inputs, the queue and the action log
// spec/sections/35-operations-runtime/35-8-operator-work-screens.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness (35-7.spec.test.ts's): the MAIN world is this file's own database with the API server of src/runtime/server.ts
// in-process (the ops console at /ops/api), a FixedClock that starts 2026-09-14 08:00 ET (a Monday) and moves forward
// through the T-ids, the FAKE e-delivery port, and the people invited / enrolled / signed in through the real doors, their
// reviewer roles granted through 35.7's tools. Every 35.8 act runs through the console's work routes (so the staff_actions
// row of 34.1 rule 4 lands) or on the bus (`runtime.execute`); every owning-section tool is dispatched by the screen.
// T10 runs in its own world (`t10`) because its clocks are the item's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, MemoryEventStore, type Actor } from "../../kernel/events/index.ts";
import { openCondition } from "../underwriting/ops-23-2.ts";
import { CTC_ITEM_CODES } from "../underwriting/ops-23-3.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { PgLoanRepository } from "../../infra/db/loans.ts";
import { EscalationService, PgEscalationRepository } from "../../app/escalations.ts";
import { bootstrapStaffAdmin } from "../../runtime/staff/auth.ts";
import { loanCashState } from "../../runtime/servicing.ts";
import { registerScreens } from "./work-35-8/registry.ts";
import { SCREENS } from "./work-35-8/screens.ts";
import { workQueue } from "./work-35-8/items.ts";
import { A_UPB_BEFORE_CENTS, A_PAYMENT_CENTS, A_INTEREST_CENTS, A_PRINCIPAL_CENTS, A_ESCROW_CENTS, A_UPB_AFTER_CENTS, A_PI_CENTS, A_LPI_BEFORE, A_LPI_AFTER, B_UPB_RESTORED_CENTS, B_LATE_CHARGE_CENTS,
  C_UPB_CENTS, C_LATE_CHARGE_CENTS, C_RECORDING_FEE_CENTS, C_ESCROW_BALANCE_CENTS, C_INTEREST_FULL_MONTH_CENTS, C_INTEREST_PARTIAL_CENTS, C_PER_DIEM_CENTS, C_TOTAL_CENTS,
  D_GROSS_LOAN_CENTS, D_PER_DIEM_CENTS, D_PREPAID_INTEREST_CENTS, D_ESCROW_DEPOSIT_CENTS, D_HAND_FED_ESCROW_CENTS, D_LENDER_CREDITS_CENTS, D_NET_WIRE_CENTS } from "./work-35-8/figures.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
/** 2026-09-14 08:00 America/New_York (a Monday). */
const T0 = "2026-09-14T12:00:00.000Z";
const clock = new FixedClock(T0);
process.env["STAFF_EMAIL_KEY"] ??= "35.8-spec-staff-email-key";
const MIN = 60_000; const HOUR = 3_600_000;
const at = (ms: number): string => new Date(Date.parse(clock.now()) + ms).toISOString();
type Json = Record<string, unknown>;
const ENV_NONPROD = { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv;
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const CASE: Actor = { kind: "agent", id: "case" };

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });

const person = (tag: string) => ({ email: `${tag}.${R}@example.test`, name: `${tag} Person`, password: `${tag}-correct-horse-${R}` });
const ADA = person("ada");   // the bootstrap admin
const ANA = person("ana");   // ops_analyst A
const BOB = person("bob");   // ops_analyst B
const OTTO = person("otto"); // officer
const CARA = person("cara"); // compliance
const UMA = person("uma");   // ops_analyst → underwriting_reviewer (T7)
const FIN = person("fin");   // ops_analyst → funding_approver (T6)
const LIN = person("lin");   // ops_analyst → lossmit_reviewer (T13)
const HAL = person("hal");   // ops_analyst → human_agent (T13)
const FAY = person("fay");   // ops_analyst → funding_approver, the wire's preparer (T6)
const ids: Record<string, string> = {};
const sessions: Record<string, { token: string; session_id: string }> = {};

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: ENV_NONPROD, reviewers: null });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "nonprod", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  await registerScreens(runtime, db, clock.now());
});
test.after(async () => { if (!skip) await close(); });

// ---------------------------------------------------------------- helpers over the API (35-7's)
type Reply = { status: number; body: Json; headers: Headers };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, origin: string = base): Promise<Reply> {
  const r = await fetch(origin + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.35.0.8", "user-agent": "35.8-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
}
const bearer = (token: string, role?: string): Record<string, string> => ({ authorization: `Bearer ${token}`, ...(role ? { "x-staff-role": role } : {}) });
async function codeToken(email: string, origin = base): Promise<string> {
  const c = await api("POST", "/ops/api/auth/code", { email }, {}, origin); assert.equal(c.status, 200, JSON.stringify(c.body));
  const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] }, {}, origin); assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body["token"] as string;
}
async function enrol(p: { email: string; password: string }, origin = base): Promise<string> {
  const token = await codeToken(p.email, origin);
  const r = await api("POST", "/ops/api/auth/password", { token, password: p.password }, {}, origin); assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body["staff_user_id"] as string;
}
async function signIn(p: { email: string; password: string }, origin = base): Promise<{ token: string; session_id: string; staff_user_id: string }> {
  await codeToken(p.email, origin);
  const r = await api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password }, {}, origin); assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string };
}
async function bootAdmin(): Promise<void> {
  if (ids["ada"]) return;
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name }); ids["ada"] = boot.staff_user_id!;
  await enrol(ADA); sessions["ada"] = await signIn(ADA);
}
async function invite(tag: string, p: { email: string; name: string; password: string }, roles: string[]): Promise<string> {
  await bootAdmin();
  if (ids[tag]) return ids[tag]!;
  sessions["ada"] = await signIn(ADA);
  const r = await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles }, bearer(sessions["ada"]!.token)); assert.equal(r.status, 200, JSON.stringify(r.body));
  ids[tag] = await enrol(p); sessions[tag] = await signIn(p);
  return ids[tag]!;
}
const PEOPLE: Record<string, { email: string; name: string; password: string }> = { ada: ADA, ana: ANA, bob: BOB, otto: OTTO, cara: CARA, uma: UMA, fin: FIN, lin: LIN, hal: HAL, fay: FAY };
/** A fresh session for the person (the clock moves days between T-ids and 34.1 rule 5 idles a session out). */
async function fresh(tag: string): Promise<string> { sessions[tag] = await signIn(PEOPLE[tag]!); return sessions[tag]!.token; }
const adminActor = (): Actor => ({ kind: "human", id: ids["ada"]!, role: "admin" });
const asHuman = (tag: string, role: string): Actor => ({ kind: "human", id: ids[tag]!, role });
const tool = (process: string, name: string, actor: Actor, input: Json, scope: { loanId?: string; applicationId?: string } = {}) => runtime.execute({ process, name, loanId: scope.loanId ?? "", ...(scope.applicationId ? { applicationId: scope.applicationId } : {}), actor, input });
/** A 35.7 grant for the fixture: a plain role at once; an independence role requested by the admin and confirmed by CARA. */
async function grant(tag: string, role: string): Promise<void> {
  const r = await tool("35.7", "roles.grant", adminActor(), { staff_user_id: ids[tag]!, role, rationale: `fixture: ${role}` });
  const o = r.output as Json;
  if (o["status"] === "pending") { await invite("cara", CARA, ["compliance"]); await tool("35.7", "roles.grant", asHuman("cara", "compliance"), { op: "confirm", request_id: o["request_id"] }); }
}
// the work routes
const screenPath = (code: string, sub: { kind: string; id: string }): string => `/ops/api/work/screens/${code}/${sub.kind}/${sub.id}`;
async function act(tag: string, role: string, code: string, sub: { kind: string; id: string }, action: string, decision: Json, extra: Json = {}): Promise<Reply> { return api("POST", `${screenPath(code, sub)}/act`, { action, decision, ...extra }, bearer(await fresh(tag), role)); }
async function derive(tag: string, role: string, code: string, sub: { kind: string; id: string }, action: string, decision: Json): Promise<Reply> { return api("POST", `${screenPath(code, sub)}/derive`, { action, decision }, bearer(await fresh(tag), role)); }
async function read(tag: string, role: string, code: string, sub: { kind: string; id: string }): Promise<Reply> { return api("GET", screenPath(code, sub), undefined, bearer(await fresh(tag), role)); }
async function decide(tag: string, actionId: string, decision: string, reason = "reviewed"): Promise<Reply> { return api("POST", `/ops/api/work/actions/${actionId}/decide`, { decision, reason }, bearer(await fresh(tag), "officer")); }
// the record
type EventRow = { id: string; type: string; actor_kind: string; actor_id: string; actor_role: string | null; aggregate_kind: string | null; aggregate_id: string | null; loan_id: string | null; application_id: string | null; payload: Json; sequence: string; occurred_at: string };
const events = async (type: string, where = "", params: unknown[] = []): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, actor_kind::text AS actor_kind, actor_id, actor_role, aggregate_kind, aggregate_id, loan_id::text AS loan_id, application_id::text AS application_id, payload, sequence::text AS sequence, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...params]);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type TimerRow = { id: string; code: string; status: string; subject_kind: string; subject_id: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null; armed_at: string };
const timers = async (code: string, where = "", params: unknown[] = []): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT id::text AS id, code, status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at, armed_at::text AS armed_at FROM timers WHERE code = $1 ${where} ORDER BY armed_at, id`, [code, ...params]);
type ActionLogRow = { staff_user_id: string | null; session_id: string | null; route: string; method: string; subject_kind: string | null; subject_id: string | null; command: string | null; result: string; refusal_code: string | null; role: string | null; at: string };
const staffActions = async (where: string, params: unknown[] = []): Promise<ActionLogRow[]> => db.query<ActionLogRow>(`SELECT staff_user_id::text AS staff_user_id, session_id::text AS session_id, route, method, subject_kind, subject_id, command, result, refusal_code, role, at::text AS at FROM staff_actions WHERE ${where} ORDER BY at, id`, params);
/** The staff_actions row lands after the answer is sent (the console logs in `finally`); poll until `n` rows match. */
async function staffActionsAtLeast(n: number, where: string, params: unknown[] = []): Promise<ActionLogRow[]> { let rows: ActionLogRow[] = []; for (let i = 0; i < 150; i++) { rows = await staffActions(where, params); if (rows.length >= n) return rows; await new Promise((r) => setTimeout(r, 20)); } return rows; }
const workActions = async (where: string, params: unknown[] = []): Promise<Json[]> => db.query<Json>(`SELECT id::text AS id, work_item_id::text AS work_item_id, screen_code, screen_version, action_code, subject_kind, subject_id, status, refusal_code, derivation_id::text AS derivation_id, command_event_id::text AS command_event_id, agent_decision_id::text AS agent_decision_id, approval_of::text AS approval_of, input_sha256, actor_id, role, decision_payload, created_at::text AS created_at FROM work_actions WHERE ${where} ORDER BY created_at, id`, params);
const items = async (where: string, params: unknown[] = []): Promise<Json[]> => db.query<Json>(`SELECT id::text AS id, screen_code, subject_kind, subject_id, source_kind, source_id, required_role, status, claimed_by::text AS claimed_by, claim_lapses, opened_at::text AS opened_at, due_at::text AS due_at, disposition FROM work_items WHERE ${where} ORDER BY opened_at, created_at, id`, params);
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const balance = async (loanId: string, account: string): Promise<bigint> => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = $2`, [loanId, account]))[0]!.s);
/** Every string in a payload: the contract that no e-mail, phone, name or token reaches a screen (35.7-T15's pattern). */
const strings = (v: unknown, out: string[] = []): string[] => { if (typeof v === "string") out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out)); else if (v && typeof v === "object") Object.values(v as Json).forEach((x) => strings(x, out)); return out; };
/** A token is 43 characters of mixed-case base64url; a 43-character upper-case rule code (FL_69B_124_013_ANTI_COERCION_AT_APPLICATION) is not one. */
const assertIdsOnly = (payload: unknown, where: string): void => { for (const s of strings(payload)) assert.doesNotMatch(s, /@|^\+?\d{10,}$|^(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{43}$| Person$/, `${where}: no e-mail, phone, name or token: ${s}`); };

// ---------------------------------------------------------------- fixtures
type Loan = { loanId: string; partnerPartyId: string; custodial: { clearing: string; pi: string; ti: string } };
/** A serviced loan with its loan_terms row and a boarding ledger set (the UPB in `principal`, an escrow balance when given). */
async function loanFixture(o: { upbCents: bigint; firstPaymentDate: string; state?: string; escrowCreditCents?: bigint; piCents?: bigint; escrowCents?: bigint; rateBps?: number; termsFrom?: string }): Promise<Loan> {
  const f = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: `${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: o.upbCents, originalTermMonths: 360, firstPaymentDate: D(o.firstPaymentDate), maturityDate: D("2056-08-01"), property: { line1: "1 Test St", city: "Testville", state: o.state ?? "TX", postalCode: "75001" } });
  await db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, remittance_type, maturity_date, remaining_term_months, late_charge_pct_bps, late_charge_grace_days) VALUES ($1, $2::date, 'boarding', 'fixed', $3, $4, $5, true, 'A/A', '2056-08-01', 360, 5000, 15)`, [f.loanId, o.termsFrom ?? o.firstPaymentDate, o.rateBps ?? 65_000, (o.piCents ?? A_PI_CENTS).toString(), (o.escrowCents ?? A_ESCROW_CENTS).toString()]);
  const escrow = o.escrowCreditCents ?? 0n;
  await runtime.uow.run(f.loanId, (ctx) => ctx.ledger.post({ effectiveDate: D(o.termsFrom ?? o.firstPaymentDate), description: "boarding", lines: [
    { account: { scope: "loan", loanId: f.loanId, account: "principal" }, amountCents: o.upbCents, ruleRef: "1.1:boarding" },
    ...(escrow > 0n ? [{ account: { scope: "loan" as const, loanId: f.loanId, account: "escrow" as const }, amountCents: -escrow, ruleRef: "1.1:boarding" }] : []),
    { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -(o.upbCents - escrow), ruleRef: "1.1:boarding" }] }, ctx.clock.now()), { clock });
  return { loanId: f.loanId, partnerPartyId: f.partnerPartyId, custodial: f.custodial };
}
/** A received cheque on the loan (2.1 `payments.read/write{op: write}`, the 35-1 pattern) — `payments{status: received}`. */
async function receive(l: Loan, paymentId: string, amountCents: bigint, receivedOn: string): Promise<void> {
  await tool("2.1", "payments.read/write", CASHIERING, { op: "write", id: paymentId, data: { payment_id: paymentId, loan_id: l.loanId, custodial_account_id: l.custodial.clearing, channel: "lockbox", instrument: "check", amount_cents: amountCents.toString(), received_at: `${receivedOn}T15:00:00.000Z`, received_on: receivedOn, credited_as_of: receivedOn, conforming: true, designation: "contractual", payer_type: "borrower", idempotency_key: `sha256:${paymentId}`, status: "received", identification_confidence: 1 } }, { loanId: l.loanId });
}
/** A designated curtailment on a current loan (2.4 rule 2): applied the same day to principal — the second payment that changes what a proposal derived from. */
async function receiveCurtailment(l: Loan, paymentId: string, amountCents: bigint, receivedOn: string): Promise<void> {
  await tool("2.1", "payments.read/write", CASHIERING, { op: "write", id: paymentId, data: { payment_id: paymentId, loan_id: l.loanId, custodial_account_id: l.custodial.clearing, channel: "lockbox", instrument: "check", amount_cents: amountCents.toString(), curtailment_cents: amountCents.toString(), received_at: `${receivedOn}T15:00:00.000Z`, received_on: receivedOn, credited_as_of: receivedOn, conforming: true, designation: "curtailment", payer_type: "borrower", idempotency_key: `sha256:${paymentId}`, status: "received", identification_confidence: 1 } }, { loanId: l.loanId });
}
/** The daily sweep's own posting path (src/runtime/servicing.ts) for a fixture payment: the derived state, the bus, the cashiering agent. */
async function postViaSweepPath(l: Loan, paymentId: string, asOf: string): Promise<void> {
  const facts = await loanCashState(runtime, l.loanId, D(asOf));
  await tool("2.1", "payments.read/write", CASHIERING, { op: "post", id: paymentId, loan_id: l.loanId, state: facts.state, custodial: facts.custodial }, { loanId: l.loanId });
}
async function openEscalation(i: { kind: string; ownerRole: string; loanId?: string; applicationId?: string; payload: Json }, actor: Actor): Promise<string> {
  let es: EscalationService | undefined; let id = "";
  await runtime.uow.run({ ...(i.loanId ? { loanId: i.loanId } : {}), ...(i.applicationId ? { applicationId: i.applicationId } : {}) }, (ctx) => { es = new EscalationService(ctx.events, ctx.clock); id = es.open({ kind: i.kind as never, ownerRole: i.ownerRole, ...(i.loanId ? { loanId: i.loanId } : {}), ...(i.applicationId ? { applicationId: i.applicationId } : {}), payload: i.payload }, actor).id; }, { clock, commit: async (q) => { for (const e of es?.list() ?? []) await new PgEscalationRepository(q).save(e, q); } });
  return id;
}
const sweep = (o: { verify?: boolean } = {}) => runtime.sweep(clock.now(), { verify: o.verify ?? false });

// the MAIN world's loan L-1 (2.1 worked example A): boarded at $250,000.00 with the August installment posted, so the September installment sees UPB $249,774.00 and LPI 2026-08-01
let L1: Loan; const L1_PAY_SEP = `pmt-L1-0903-${R}`;
const fixtureL1 = async (): Promise<Loan> => {
  if (L1) return L1;
  L1 = await loanFixture({ upbCents: 25_000_000n, firstPaymentDate: "2026-08-01" });
  await receive(L1, `pmt-L1-0801-${R}`, A_PAYMENT_CENTS, "2026-08-01"); await postViaSweepPath(L1, `pmt-L1-0801-${R}`, "2026-08-03");
  assert.equal(await balance(L1.loanId, "principal"), A_UPB_BEFORE_CENTS);   // 25,000,000 − 22,600 = 24,977,400 = $249,774.00
  assert.equal((await loanCashState(runtime, L1.loanId, D("2026-08-03"))).state.lpi_date, A_LPI_BEFORE);
  return L1;
};
const sub = (l: Loan) => ({ kind: "loan", id: l.loanId });
void HOUR; void MIN; void at; void SCREENS; void workQueue; void CASE; void items; void read; void derive; void grant;

let T1_ACTION = ""; let T3_PROPOSAL = ""; let T3_EXECUTED = "";
test("35.8-T1: Given fixture loan L-1 with a `received` cheque of 219,257¢ dated 2026-09-03, when an `ops_analyst` runs `work.screen.act{code: payment_post, action: post, decision: {payment_id}}`, then 2.1 posts interest **$1,352.94**, principal **$227.23**, escrow **$612.40** (total **$2,192.57**), UPB is **$249,546.77** and LPI 2026-09-01, the `work_derivations` row's `sources` names the `loan_installments` version and `ledger_lines.max_id` read, its `input_sha256` equals the 2.1 decision record's `inputs_snapshot_hash` and the sha-256 of the stored `work-derivation.json`, and exactly one `work_actions{status: executed}`, one `staff_actions{command: \"2.1 payments.read/write\"}` and one `work.action.executed` event exist.", { skip }, async () => {
  await invite("ana", ANA, ["ops_analyst"]);
  const l = await fixtureL1();
  clock.set("2026-09-18T14:00:00.000Z");   // the day of worked examples A and B (the R01 return is 2026-09-18)
  await receive(l, L1_PAY_SEP, A_PAYMENT_CENTS, "2026-09-03");
  assert.equal(A_PAYMENT_CENTS, 219_257n);
  const r = await act("ana", "ops_analyst", "payment_post", sub(l), "post", { payment_id: L1_PAY_SEP });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body["status"], "executed"); assert.equal(r.body["process"], "2.1"); assert.equal(r.body["tool"], "payments.read/write");
  T1_ACTION = r.body["action_id"] as string;
  const out = r.body["output"] as Json;
  // 2.1 posts interest $1,352.94, principal $227.23, escrow $612.40 (total $2,192.57)
  assert.equal(out["interest_cents"], "135294"); assert.equal(A_INTEREST_CENTS, 135_294n);
  assert.equal(out["principal_cents"], "22723"); assert.equal(A_PRINCIPAL_CENTS, 22_723n);
  assert.equal(out["escrow_cents"], "61240"); assert.equal(A_ESCROW_CENTS, 61_240n);
  assert.equal(A_INTEREST_CENTS + A_PRINCIPAL_CENTS + A_ESCROW_CENTS, A_PAYMENT_CENTS);
  // UPB $249,546.77 and LPI 2026-09-01 — from the ledger and the derived state
  assert.equal(await balance(l.loanId, "principal"), A_UPB_AFTER_CENTS); assert.equal(A_UPB_AFTER_CENTS, 24_954_677n); assert.equal(A_UPB_BEFORE_CENTS - A_PRINCIPAL_CENTS, A_UPB_AFTER_CENTS);
  const state = (await loanCashState(runtime, l.loanId, D("2026-09-18"))).state;
  assert.equal(state.upb_cents, A_UPB_AFTER_CENTS); assert.equal(state.lpi_date, A_LPI_AFTER);
  assert.equal(state.installments.find((x) => x.due_date === "2026-09-01")!.status, "satisfied");
  // the derivation: sources name the loan_installments version and ledger_lines.max_id read; input_sha256 = the 2.1 decision record's inputs_snapshot_hash = sha-256 of the stored work-derivation.json
  const [dv] = await db.query<{ sources: Json; input_sha256: string; document_id: string }>(`SELECT sources, input_sha256, document_id::text AS document_id FROM work_derivations WHERE id = $1`, [r.body["derivation_id"]]);
  assert.ok(dv, "a work_derivations row"); assert.ok("version" in (dv!.sources["loan_installments"] as Json), "sources name the loan_installments version"); assert.ok("max_id" in (dv!.sources["ledger_lines"] as Json), "sources name ledger_lines.max_id");
  assert.ok(Number((dv!.sources["loan_events"] as Json)["through_sequence"]) > 0);
  assert.equal(dv!.input_sha256, r.body["input_sha256"]);
  const [doc] = await db.query<{ sha256: string; kind: string; document: string }>(`SELECT sha256, kind, metadata->>'document' AS document FROM documents WHERE id = $1`, [dv!.document_id]);
  assert.equal(doc!.kind, "work-derivation.json"); assert.equal(sha256hex(doc!.document), dv!.input_sha256); assert.equal(doc!.sha256, dv!.input_sha256);
  const stored = JSON.parse(doc!.document) as Json; assert.equal(stored["op"], "post"); assert.equal(stored["id"], L1_PAY_SEP); assert.equal((stored["state"] as Json)["upb_cents"], "24977400", "cents as strings in the canonical input");
  const [dec] = await db.query<{ inputs_snapshot_hash: string | null; agent: string; action: string }>(`SELECT inputs_snapshot_hash, agent, action FROM agent_decisions WHERE id = $1`, [r.body["agent_decision_id"]]);
  assert.ok(dec, "the 2.1 decision record"); assert.equal(dec!.agent, "cashiering"); assert.equal(dec!.inputs_snapshot_hash, dv!.input_sha256);
  // exactly one work_actions{executed}, one staff_actions{command: "2.1 payments.read/write"}, one work.action.executed event
  const rows = await workActions(`subject_id = $1 AND status = 'executed'`, [l.loanId]); assert.equal(rows.length, 1); assert.equal(rows[0]!["id"], T1_ACTION); assert.equal(rows[0]!["agent_decision_id"], r.body["agent_decision_id"]); assert.ok(rows[0]!["command_event_id"]);
  const sa = await staffActionsAtLeast(1, `subject_kind = 'work_action' AND subject_id = $1`, [T1_ACTION]); assert.equal(sa.length, 1); assert.equal(sa[0]!.command, "2.1 payments.read/write"); assert.equal(sa[0]!.result, "ok"); assert.equal(sa[0]!.role, "ops_analyst"); assert.equal(sa[0]!.staff_user_id, ids["ana"]);
  const ex = await events("work.action.executed", "AND aggregate_id = $2", [T1_ACTION]); assert.equal(ex.length, 1); assert.equal(ex[0]!.payload["input_sha256"], dv!.input_sha256); assert.equal(ex[0]!.payload["command_event_id"], rows[0]!["command_event_id"]);
  assertIdsOnly(r.body, "the act's answer");
});

test("35.8-T2: Given the same loan, when the decision payload carries any derived field (`state`, `custodial`, `installments`, `upb_cents`) or a field outside `decision_schema`, then the act is refused `NO_CLIENT_STATE{field}` before the deriver runs, no `work_derivations` row, no event and no ledger line exist, and `work_actions{status: refused}` plus `staff_actions{result: refused}` do.", { skip }, async () => {
  const l = await fixtureL1();
  await receive(l, `pmt-L1-t2-${R}`, 1_000n, "2026-09-10");
  const before = { derivations: await count(`work_derivations WHERE subject_id = $1`, [l.loanId]), events: await count(`loan_events WHERE loan_id = $1`, [l.loanId]), lines: await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]), actions: await count(`work_actions WHERE subject_id = $1`, [l.loanId]) };
  // each derived field on its own through the dry run: refused NO_CLIENT_STATE{field} before the deriver runs — no derivation row
  for (const field of ["state", "custodial", "installments", "upb_cents"]) {
    const r = await derive("ana", "ops_analyst", "payment_post", sub(l), "post", { payment_id: `pmt-L1-t2-${R}`, [field]: field === "upb_cents" ? "1" : {} });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body["code"], "NO_CLIENT_STATE"); assert.equal(r.body["field"], field);
  }
  // an act whose payload carries a derived field and a field outside decision_schema: refused, one work_actions{refused} + staff_actions{result: refused}, nothing else
  const r = await act("ana", "ops_analyst", "payment_post", sub(l), "post", { payment_id: `pmt-L1-t2-${R}`, state: { upb_cents: "1" }, memo_to_self: "x" });
  assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body["code"], "NO_CLIENT_STATE"); assert.equal(r.body["field"], "state");
  const actionId = r.body["action_id"] as string; assert.ok(actionId);
  const after = { derivations: await count(`work_derivations WHERE subject_id = $1`, [l.loanId]), events: await count(`loan_events WHERE loan_id = $1`, [l.loanId]), lines: await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]), actions: await count(`work_actions WHERE subject_id = $1`, [l.loanId]) };
  assert.deepEqual({ ...after, actions: after.actions - 1 }, before, "no work_derivations row, no event, no ledger line — one refused row");
  const [row] = await workActions(`id = $1`, [actionId]); assert.equal(row!["status"], "refused"); assert.equal(row!["refusal_code"], "NO_CLIENT_STATE"); assert.equal(row!["derivation_id"], null);
  const sa = await staffActionsAtLeast(1, `subject_kind = 'work_action' AND subject_id = $1`, [actionId]); assert.equal(sa[0]!.result, "refused"); assert.equal(sa[0]!.refusal_code, "NO_CLIENT_STATE"); assert.equal(sa[0]!.command, "2.1 payments.read/write");
  const r2 = await derive("ana", "ops_analyst", "payment_post", sub(l), "post", { payment_id: `pmt-L1-t2-${R}`, total_cents: "5" });
  assert.equal(r2.status, 409); assert.equal(r2.body["code"], "NO_CLIENT_STATE"); assert.equal(r2.body["field"], "total_cents");
});

let DEAD_ITEM = "";
test("35.8-T3: Given the posted payment of T1 and an R01 return, when an `ops_analyst` acts on `payment_reverse.reverse{payment_id, reason: returned_item, return_code: R01}`, then no ledger line is written, `work_actions{status: proposed}` and `work.action.proposed` exist, the item is `waiting_approval` and `SM_WORK_APPROVAL_1BD` is armed on `proposed_at`; when the same analyst calls `work.action.decide{approved}` then `SAME_PERSON`; when a distinct `officer` approves, then 2.1's mirror set restores UPB to **$249,774.00** and LPI to 2026-08-01, 2.7 assesses the late charge **$79.01** on the 2026-09-01 installment, the executed row carries `approval_of` = the proposal, `work_approvals` has one row, `agent_decisions.approved_by` names both people, and the timer is satisfied.", { skip }, async () => {
  await invite("otto", OTTO, ["officer"]);
  const l = await fixtureL1();
  // the R01 return's dead letter opens a `dead_letter` item that maps to the reversal screen (rule 8); the analyst claims it
  await db.query(`INSERT INTO integration_messages (adapter, direction, idempotency_key, status, payload_summary, error, attempts, loan_id, last_attempt_at, created_at) VALUES ('nacha', 'in', $1, 'dead', '{"return_code":"R01"}'::jsonb, 'R01 insufficient funds', 3, $2, $3::timestamptz, $3::timestamptz)`, [`ach-return-${R}`, l.loanId, clock.now()]);
  await sweep();
  const [item] = await items(`source_kind = 'dead_letter' AND loan_id = $1`, [l.loanId]); assert.ok(item, "the dead letter's item"); assert.equal(item!["screen_code"], "payment_reverse"); DEAD_ITEM = item!["id"] as string;
  const claim = await api("POST", `/ops/api/work/items/${DEAD_ITEM}/claim`, {}, bearer(await fresh("ana"), "ops_analyst")); assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const linesBefore = await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]);
  const r = await act("ana", "ops_analyst", "payment_reverse", sub(l), "reverse", { payment_id: L1_PAY_SEP, reason: "returned_item", return_code: "R01", nsf_fee: false }, { work_item_id: DEAD_ITEM });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "proposed"); assert.equal(r.body["money"], true);
  T3_PROPOSAL = r.body["action_id"] as string;
  assert.equal(await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]), linesBefore, "no ledger line is written by a proposal");
  const [prop] = await workActions(`id = $1`, [T3_PROPOSAL]); assert.equal(prop!["status"], "proposed");
  const proposed = await events("work.action.proposed", "AND aggregate_id = $2", [T3_PROPOSAL]); assert.equal(proposed.length, 1); assert.equal(proposed[0]!.payload["proposed_at"], clock.now());
  const [it] = await items(`id = $1`, [DEAD_ITEM]); assert.equal(it!["status"], "waiting_approval");
  const armed = await timers("SM_WORK_APPROVAL_1BD", "AND subject_id = $2", [T3_PROPOSAL]); assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.anchor_date, "2026-09-18");
  // the same analyst may not approve: SAME_PERSON (the analyst holds no officer role either — the route's gate comes first, so the check is on the bus)
  await assert.rejects(tool("35.8", "work.action.decide", asHuman("ana", "officer"), { action_id: T3_PROPOSAL, decision: "approved" }, { loanId: l.loanId }), (e: Error & { code?: string }) => e.code === "SAME_PERSON");
  // a distinct officer approves: 2.1's mirror set restores UPB $249,774.00 and LPI 2026-08-01; 2.7 assesses the late charge $79.01
  const ok = await decide("otto", T3_PROPOSAL, "approved", "R01 return confirmed");
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body["decision"], "approved"); T3_EXECUTED = ok.body["executed_action_id"] as string;
  assert.equal(await balance(l.loanId, "principal"), B_UPB_RESTORED_CENTS); assert.equal(B_UPB_RESTORED_CENTS, 24_977_400n);
  const rev = await events("payment.reversed", "AND loan_id = $2", [l.loanId]); assert.equal(rev.length, 1); assert.equal(rev[0]!.payload["restored_upb_cents"], "24977400"); assert.equal(rev[0]!.payload["restored_lpi_date"], A_LPI_BEFORE); assert.equal(rev[0]!.payload["return_code"], "R01");
  const state = (await loanCashState(runtime, l.loanId, D("2026-09-18"))).state;
  assert.equal(state.upb_cents, B_UPB_RESTORED_CENTS); assert.equal(state.installments.find((x) => x.due_date === "2026-09-01")!.status, "due");
  const fee = (await db.query<{ data: Json }>(`SELECT data FROM entity_records WHERE kind = 'fees' AND loan_id = $1 ORDER BY version DESC LIMIT 1`, [l.loanId]))[0]; assert.ok(fee, "2.7's late charge record");
  assert.equal(fee!.data["amount_cents"], "7901"); assert.equal(B_LATE_CHARGE_CENTS, 7_901n); assert.equal(fee!.data["installment_due_date"], "2026-09-01"); assert.equal(fee!.data["fee_type"], "late_charge");
  assert.equal(A_PI_CENTS * 5n / 100n, 7_900n, "158,017 × 5% = 7,900.85 → 7,901 half-up once");
  const [exec] = await workActions(`id = $1`, [T3_EXECUTED]); assert.equal(exec!["status"], "executed"); assert.equal(exec!["approval_of"], T3_PROPOSAL); assert.equal(exec!["actor_id"], ids["otto"]);
  const [prop2] = await workActions(`id = $1`, [T3_PROPOSAL]); assert.equal(prop2!["status"], "approved");
  assert.equal(await count(`work_approvals WHERE work_action_id = $1`, [T3_PROPOSAL]), 1);
  const [appr] = await db.query<{ approver_actor_id: string; proposer_actor_id: string; decision: string; executed_action_id: string }>(`SELECT approver_actor_id, proposer_actor_id, decision, executed_action_id::text AS executed_action_id FROM work_approvals WHERE work_action_id = $1`, [T3_PROPOSAL]);
  assert.deepEqual([appr!.approver_actor_id, appr!.proposer_actor_id, appr!.decision, appr!.executed_action_id], [ids["otto"], ids["ana"], "approved", T3_EXECUTED]);
  const [dec] = await db.query<{ approved_by: string | null; approved_role: string | null }>(`SELECT approved_by, approved_role FROM agent_decisions WHERE id = $1`, [exec!["agent_decision_id"]]);
  assert.ok(dec!.approved_by!.includes(ids["ana"]!) && dec!.approved_by!.includes(ids["otto"]!), `approved_by names both people: ${dec!.approved_by}`); assert.equal(dec!.approved_role, "officer");
  const sat = await timers("SM_WORK_APPROVAL_1BD", "AND subject_id = $2", [T3_PROPOSAL]); assert.equal(sat[0]!.status, "satisfied");
  const [it2] = await items(`id = $1`, [DEAD_ITEM]); assert.equal(it2!["status"], "closed"); assert.equal(it2!["disposition"], "approved");
  const sa = await staffActionsAtLeast(1, `subject_kind = 'work_action' AND subject_id = $1`, [T3_PROPOSAL]); assert.ok(sa.some((x) => x.command === "2.1 payments.read/write" && x.role === "officer"), "the approval's staff_actions row names the owning tool and the officer");
});

test("35.8-T4: Given a `proposed` reversal, when a second payment posts on the loan before the officer approves, then the approval's re-derivation differs, the act is refused `STALE_DERIVATION{proposal_sha256, current_sha256}`, the proposal is `declined` with that code, nothing is posted, and the item returns to `claimed`.", { skip }, async () => {
  await invite("bob", BOB, ["ops_analyst"]);
  const l = await fixtureL1();
  clock.set("2026-09-21T14:00:00.000Z");
  // a posted cheque, its reversal proposed, then a second payment posts before the officer approves
  const pay2 = `pmt-L1-t4a-${R}`; await receive(l, pay2, A_PAYMENT_CENTS, "2026-09-20");
  const post = await act("ana", "ops_analyst", "payment_post", sub(l), "post", { payment_id: pay2 }); assert.equal(post.status, 200, JSON.stringify(post.body));
  const prop = await act("ana", "ops_analyst", "payment_reverse", sub(l), "reverse", { payment_id: pay2, reason: "duplicate" });
  assert.equal(prop.status, 200, JSON.stringify(prop.body)); assert.equal(prop.body["status"], "proposed"); const proposalId = prop.body["action_id"] as string;
  const pay3 = `pmt-L1-t4b-${R}`; await receiveCurtailment(l, pay3, 100_000n, "2026-09-21");
  const post3 = await act("bob", "ops_analyst", "payment_post", sub(l), "post", { payment_id: pay3 }); assert.equal(post3.status, 200, JSON.stringify(post3.body)); assert.equal((post3.body["output"] as Json)["outcome"], "curtailment");
  const linesBefore = await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]);
  const r = await decide("otto", proposalId, "approved");
  assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body["code"], "STALE_DERIVATION");
  assert.equal(r.body["proposal_sha256"], prop.body["input_sha256"]); assert.ok(r.body["current_sha256"] && r.body["current_sha256"] !== r.body["proposal_sha256"], "the re-derivation differs");
  assert.equal(await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]), linesBefore, "nothing is posted");
  const [p] = await workActions(`id = $1`, [proposalId]); assert.equal(p!["status"], "declined"); assert.equal(p!["refusal_code"], "STALE_DERIVATION");
  assert.equal(await count(`work_actions WHERE approval_of = $1`, [proposalId]), 0);
  const [appr] = await db.query<{ decision: string; reason: string }>(`SELECT decision, reason FROM work_approvals WHERE work_action_id = $1`, [proposalId]); assert.deepEqual([appr!.decision, appr!.reason], ["declined", "STALE_DERIVATION"]);
  // an item under the proposal returns to `claimed`: a manual item claimed by the analyst carries a fresh proposal
  const open = await api("POST", "/ops/api/work/items", { screen_code: "payment_reverse", subject: sub(l), required_role: "ops_analyst", reason: "T4" }, bearer(await fresh("ana"), "ops_analyst")); assert.equal(open.status, 200, JSON.stringify(open.body));
  const itemId = (open.body["item"] as Json)["id"] as string;
  assert.equal((await api("POST", `/ops/api/work/items/${itemId}/claim`, {}, bearer(await fresh("ana"), "ops_analyst"))).status, 200);
  const prop2 = await act("ana", "ops_analyst", "payment_reverse", sub(l), "reverse", { payment_id: pay2, reason: "duplicate" }, { work_item_id: itemId }); assert.equal(prop2.status, 200, JSON.stringify(prop2.body));
  assert.equal((await items(`id = $1`, [itemId]))[0]!["status"], "waiting_approval");
  const pay4 = `pmt-L1-t4c-${R}`; await receiveCurtailment(l, pay4, 50_000n, "2026-09-21"); assert.equal((await act("bob", "ops_analyst", "payment_post", sub(l), "post", { payment_id: pay4 })).status, 200);
  const r2 = await decide("otto", prop2.body["action_id"] as string, "approved"); assert.equal(r2.status, 409); assert.equal(r2.body["code"], "STALE_DERIVATION");
  assert.equal((await items(`id = $1`, [itemId]))[0]!["status"], "claimed", "the item returns to claimed for a fresh proposal");
});

test("35.8-T5: Given 16.1 worked example A's loan (UPB **$248,310.55**, 6.500%, LPI 09/01/2026, late charge **$82.17**, release fee **$34.00**), when the borrower's request for good-through 2026-10-15 is acted through `payoff_quote.quote`, then the components are **$1,345.02** (September) and **$619.08** (14 October days), per diem **$44.22**, total **$250,390.82**, every figure came from the ledger and `loan_terms` (the decision payload has no cents field), two `work.screen.derive` calls on the same ledger snapshot return one `input_sha256`, and a decision naming `total_cents` is refused `NO_CLIENT_STATE{total_cents}`.", { skip }, async () => {
  clock.set("2026-09-22T14:00:00.000Z");
  // 16.1 worked example A's loan: Ohio, UPB $248,310.55 in the ledger, 6.500% in loan_terms, LPI 09/01/2026 (the next installment due 2026-10-01), late charge $82.17 on the record, escrow balance $2,412.90
  const l = await loanFixture({ upbCents: C_UPB_CENTS, firstPaymentDate: "2026-10-01", state: "OH", escrowCreditCents: C_ESCROW_BALANCE_CENTS, piCents: 156_940n, escrowCents: 40_000n });
  assert.equal(C_UPB_CENTS, 24_831_055n); assert.equal(C_ESCROW_BALANCE_CENTS, 241_290n);
  await runtime.entities.save([{ kind: "fees", id: `fee-lc-${R}`, data: { loan_id: l.loanId, fee_type: "late_charge", installment_due_date: "2026-08-01", amount_cents: "8217", state: "assessed", assessed_on: "2026-08-17", grace_end_on: "2026-08-16", collected_cents: "0" }, version: 1, updatedAt: clock.now(), updatedBy: "agent:cashiering" }], { loanId: l.loanId });
  assert.equal(C_LATE_CHARGE_CENTS, 8_217n); assert.equal(C_RECORDING_FEE_CENTS, 3_400n);
  // the county release recording fee is 16.x's data on the record (`jurisdiction_rules` keyed by state), read by the deriver — never a constant of 35.8's
  await runtime.entities.save([{ kind: "jurisdiction_rules", id: "OH", data: { state: "OH", payoff: { release_recording_fee_cents: "3400", source: "16.1 worked example A [UNVERIFIED]" } }, version: 1, updatedAt: clock.now(), updatedBy: "agent:payoff" }], {});
  const decision = { requester_kind: "borrower", good_through: "2026-10-15", delivery: "portal" };
  const d1 = await derive("ana", "ops_analyst", "payoff_quote", sub(l), "quote", decision); assert.equal(d1.status, 200, JSON.stringify(d1.body));
  const d2 = await derive("ana", "ops_analyst", "payoff_quote", sub(l), "quote", decision); assert.equal(d2.status, 200);
  assert.equal(d1.body["input_sha256"], d2.body["input_sha256"], "two derives on the same ledger snapshot yield one input_sha256");
  const input = d1.body["input"] as Json;
  assert.equal(input["upb_cents"], "24831055"); assert.equal(input["rate_pct"], "6.500"); assert.equal(input["lpi_due"], "2026-09-01"); assert.equal(input["late_charges_cents"], "8217"); assert.equal(input["recording_fee_cents"], "3400"); assert.equal(input["escrow_balance_cents"], "241290"); assert.equal(input["state"], "OH");
  assert.ok(!Object.keys(decision).some((k) => /_cents$/.test(k)), "the decision payload has no cents field");
  const r = await act("ana", "ops_analyst", "payoff_quote", sub(l), "quote", decision);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "executed"); assert.equal(r.body["tool"], "computePayoffQuote");
  const out = r.body["output"] as Json;
  assert.equal(out["interest_full_months_cents"], "134502"); assert.equal(C_INTEREST_FULL_MONTH_CENTS, 134_502n);
  assert.equal(out["interest_partial_cents"], "61908"); assert.equal(C_INTEREST_PARTIAL_CENTS, 61_908n);
  assert.equal(out["per_diem_cents"], "4422"); assert.equal(C_PER_DIEM_CENTS, 4_422n);
  assert.equal(out["total_cents"], "25039082"); assert.equal(C_TOTAL_CENTS, 25_039_082n);
  assert.equal(C_UPB_CENTS + C_INTEREST_FULL_MONTH_CENTS + C_INTEREST_PARTIAL_CENTS + C_LATE_CHARGE_CENTS + C_RECORDING_FEE_CENTS, C_TOTAL_CENTS, "the escrow balance is refunded separately, never netted");
  assert.equal(r.body["input_sha256"], d1.body["input_sha256"], "the act's input is the dry run's");
  const bad = await act("ana", "ops_analyst", "payoff_quote", sub(l), "quote", { ...decision, total_cents: "1" });
  assert.equal(bad.status, 409, JSON.stringify(bad.body)); assert.equal(bad.body["code"], "NO_CLIENT_STATE"); assert.equal(bad.body["field"], "total_cents");
});

test("35.8-T6: Given the lifecycle fixture's orchestration at step `funding_authorized` (gross **$560,000.00**, per diem **$93.97**, prepaid interest **$1,785.43**, escrow deposit **$2,062.50** from the consummated CD per 35.6 rule 7a, lender credits **$700.00**), when a `funding_approver` acts on `funding_release.release{funding_id, wire_id}`, then the derived `evaluateFundingConditions` passed from the record, the wire released is **$556,852.07** (55,685,207 cents), 26.3's `funding.authorized` and the release event are keyed by the application, and the same act by the staff user who prepared the wire is refused `FOUR_EYES`; given a blocking condition on the record, then `GATE_CLOSED{codes}` and no release.", { skip }, async () => {
  await invite("fin", FIN, ["ops_analyst"]); await grant("fin", "funding_approver");
  await invite("fay", FAY, ["ops_analyst"]); await grant("fay", "funding_approver");
  const l = await fixtureL1(); const back = "2026-09-22T16:00:00.000Z";
  // the lifecycle fixture (src/runtime/lifecycle.test.ts a13) on the bus: the funder opens the funding on the consummation, builds the worksheet from the consummated CD, reconciles, evaluates, authorizes, prepares the wire
  const app = await runtime.createApplication({ partner_party_id: l.partnerPartyId, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Applicant Six" }] }, { kind: "system", id: "test" }); const appId = app.application.id; const sub6 = { kind: "application", id: appId };
  const FUNDER: Actor = { kind: "agent", id: "funder" }; const FUNDING_ID = `F-${R}`; const WIRE_ID = `W-${R}`; const AGENT_PARTY = "P-ESCROW-AZ-1";
  const EST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-05:00`).toISOString(); const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();
  const f26 = (name: string, input: Json, actor: Actor = FUNDER) => tool("26.3", name, actor, input, { applicationId: appId });
  try {
    clock.set(EST("2026-11-11", "11:00"));
    const open = await f26("computeDates", { op: "open", funding_id: FUNDING_ID, state: "AZ", transaction_type: "limited_cash_out", time_zone: "America/Phoenix", consummation_at: MST("2026-11-06", "14:26"), review_completed_on: "2026-11-09", partner_id: "partner-1", partner_loan_number: "PL-1001", gross_loan_cents: "56000000", note_rate_pct: "6.125", note_first_payment_date: "2027-01-01" });
    const cal = (open.output as Json)["calendar"] as Json; assert.equal(cal["earliest_funding_date"], "2026-11-12"); assert.equal(cal["funding_type"], "dry");
    // 35.6 rule 7a: the escrow deposit is the consummated CD's initial escrow payment — $2,062.50 on the record, never 26.3's hand-fed $1,665.00
    await runtime.entities.save([{ kind: "closing_disclosures", id: `CD-${R}`, data: { application_id: appId, version: 1, status: "consummated", figures: { gross_loan_cents: "56000000", prepaid_interest_cents: "178543", initial_escrow_deposit_cents: "206250", lender_credits_cents: "70000" } }, version: 1, updatedAt: clock.now(), updatedBy: "system:test" }], { applicationId: appId });
    const cd = (await runtime.entities.load({ applicationId: appId })).find((r) => r.kind === "closing_disclosures")!.data; const cdFigures = cd["figures"] as Json;
    assert.equal(cdFigures["initial_escrow_deposit_cents"], "206250"); assert.equal(D_ESCROW_DEPOSIT_CENTS, 206_250n); assert.equal(D_HAND_FED_ESCROW_CENTS, 166_500n); assert.notEqual(cdFigures["initial_escrow_deposit_cents"], D_HAND_FED_ESCROW_CENTS.toString());
    await f26("buildFundingWorksheet", { funding_id: FUNDING_ID, version: 1, cd_version: 1, gross_loan_cents: cdFigures["gross_loan_cents"], prepaid_interest_cents: cdFigures["prepaid_interest_cents"], escrow_deposit_cents: cdFigures["initial_escrow_deposit_cents"], lender_credits_cents: cdFigures["lender_credits_cents"] });
    assert.equal(D_GROSS_LOAN_CENTS, 56_000_000n); assert.equal(D_PREPAID_INTEREST_CENTS, 178_543n); assert.equal(D_LENDER_CREDITS_CENTS, 70_000n); assert.equal(D_PER_DIEM_CENTS, 9_397n);
    assert.equal((D_GROSS_LOAN_CENTS * 6125n + 50_000n) / 100_000n / 365n, 9_397n, "per diem 560,000.00 × 0.06125 ÷ 365 = 93.9726 → $93.97"); assert.equal(19n * D_PER_DIEM_CENTS, D_PREPAID_INTEREST_CENTS, "prepaid interest 19 days × $93.97 = $1,785.43");
    assert.equal(D_GROSS_LOAN_CENTS - D_PREPAID_INTEREST_CENTS - D_ESCROW_DEPOSIT_CENTS + D_LENDER_CREDITS_CENTS, D_NET_WIRE_CENTS); assert.equal(D_NET_WIRE_CENTS, 55_685_207n);
    const rec = await f26("reconcileToSettlementStatement", { funding_id: FUNDING_ID, worksheet_id: `${FUNDING_ID}:ws:1`, agent_requested_net_cents: "55685207" }); assert.equal(((rec.output as Json)["item"] as Json)["status"], "pass");
    clock.set(EST("2026-11-12", "08:05"));
    const FACTS = (as_of: string): Json => ({ as_of, funding: { funding_type: "dry", transaction_type: "limited_cash_out", disbursement_date: "2026-11-12", release_date: "2026-11-12", note_date: "2026-11-06", authorized: false },
      loan: { ltv_pct: 70, sfha: false, project: false, enote: true, tx_50a6: false, record_before_fund: false }, execution: { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true }, cd: { consummated_version: 1, delivered_with_receipt: true, signed_copy_in_documents: true }, identity: { all_signers_proofed: true },
      rescission: { status: "expired_not_rescinded", expires_at: "2026-11-11T07:00:00.000Z", reasonably_satisfied_at: "2026-11-11T15:00:00.000Z", waiver_id: null, now: as_of }, hazard: { hazard_status: "verified", effective_date: "2026-11-12", transaction_type: "refinance", policy_in_force: true },
      title: { cpl_open: true, commitment_open: true }, vvoe: { verified_on: "2026-11-04", self_employed: false }, credit_refresh_open: true, compliance_disburse_open: true, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [], wire: { verified_at: "2026-11-03T15:00:00.000Z", blocks_disbursement: false, callback_number_source: "alta_registry", as_of },
      payoffs: [{ liability_id: "L-PRIOR", status: "received", good_through_date: "2026-11-13" }], first_payment: { first_payment_date: "2027-01-01" }, audit_trail_open: true, enote: { registered: true, secured_party_set: true }, qc_hold: false, commitment: { active: true, expires_on: "2026-12-07" }, worksheet: { reconciled: true }, fraud: { fraud_hold: false, ofac_clear: true } });
    const conditions = await f26("evaluateFundingConditions", { funding_id: FUNDING_ID, facts: FACTS(clock.now()) }); assert.equal((conditions.output as Json)["passed"], true, JSON.stringify((conditions.output as Json)["blocking_codes"]));
    clock.set(EST("2026-11-12", "08:12"));
    await f26("requestWarehouseAdvance", { funding_id: FUNDING_ID, conditions: conditions.output, rescission: (FACTS(clock.now()) as Json)["rescission"], fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] });
    assert.equal(await count(`loan_events WHERE application_id = $1 AND type = 'funding.authorized' AND loan_id IS NULL`, [appId]), 1, "26.3's funding.authorized keyed by the application");
    await f26("requestWarehouseAdvance", { funding_id: FUNDING_ID, op: "advance_approved", advance_id: `ADV-${R}` });
    clock.set(EST("2026-11-12", "08:20"));
    const VERIFIED_WIRE = { verification_id: `WV-${R}`, beneficiary_party_id: AGENT_PARTY, beneficiary_name: "Escrow Co Trust Account", instructions_hash: "h-verified", verified_at: "2026-11-03T15:00:00.000Z", expires_at: "2026-12-03T15:00:00.000Z", blocks_disbursement: false, change_detected_at: null, callback_number_source: "alta_registry", cpl_agent_party_id: AGENT_PARTY, ofac_screen_ref: "OFAC-1", ofac_clear: true };
    const wire = await f26("prepareWire", { funding_id: FUNDING_ID, wire_id: WIRE_ID, record: VERIFIED_WIRE, instructions_hash: VERIFIED_WIRE.instructions_hash, instructions_source: "verified_record", value_date: "2026-11-12", prepared_at: clock.now(), run_id: "run-funder-1", editors: [ids["fay"]!], borrower_last_name: "Six", property_short: "100 N Central Ave, Phoenix AZ", funding_account_ref_hash: "sha256:funding", closing_documents: [] });
    assert.equal(BigInt(String(((wire.output as Json)["wire"] as Json)["amount_cents"])), D_NET_WIRE_CENTS, "the wire is the worksheet's net");
    // the record's funding-condition facts (26.x keeps them; the deriver runs 26.3 evaluateFundingConditions over them, never over the person's payload) — first with a blocking condition
    const facts = (extra: Json, version: number) => runtime.entities.save([{ kind: "funding_facts", id: FUNDING_ID, data: { ...FACTS(clock.now()), ...extra, application_id: appId }, version, updatedAt: clock.now(), updatedBy: "system:test" }], { applicationId: appId });
    await facts({ fraud: { fraud_hold: true, ofac_clear: true } }, 1);
    clock.set(EST("2026-11-12", "09:30"));
    const closed = await act("fin", "funding_approver", "funding_release", sub6, "release", { funding_id: FUNDING_ID, wire_id: WIRE_ID });
    assert.equal(closed.status, 409, JSON.stringify(closed.body)); assert.equal(closed.body["code"], "GATE_CLOSED"); assert.ok(Array.isArray(closed.body["codes"]) && (closed.body["codes"] as string[]).length >= 1, "GATE_CLOSED{codes}");
    assert.equal(await count(`loan_events WHERE application_id = $1 AND type LIKE 'funding.wire.%release%'`, [appId]), 0, "no release");
    // the record cleared: the staff user who prepared the wire (an editor) is refused by 26.3's four-eyes rule
    await facts({}, 2);
    const same = await act("fay", "funding_approver", "funding_release", sub6, "release", { funding_id: FUNDING_ID, wire_id: WIRE_ID });
    assert.equal(same.status, 409, JSON.stringify(same.body)); assert.equal(same.body["code"], "FOUR_EYES"); assert.equal(same.body["cause"], "RELEASE_BY_EDITOR");
    const [refusedRow] = await workActions(`id = $1`, [same.body["action_id"]]); assert.equal(refusedRow!["status"], "refused"); assert.equal(refusedRow!["refusal_code"], "RELEASE_BY_EDITOR");
    // a distinct funding_approver releases $556,852.07
    clock.set(EST("2026-11-12", "09:40"));
    const r = await act("fin", "funding_approver", "funding_release", sub6, "release", { funding_id: FUNDING_ID, wire_id: WIRE_ID });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "executed"); assert.equal(r.body["tool"], "prepareWire");
    assertIdsOnly(r.body, "the funding_release act answer");   // 26.3's wire carries a beneficiary name and free text; the screen answer carries neither
    const out = r.body["output"] as Json; const w = out["wire"] as Json; assert.equal(w["status"], "released"); assert.ok(!("beneficiary_name_on_wire" in w) && !("originator_to_beneficiary_info" in w), "the wire's free text is not on the screen"); assert.equal(w["amount_cents"], "55685207"); assert.equal(BigInt(w["amount_cents"] as string), D_NET_WIRE_CENTS);
    const input = JSON.parse((await db.query<{ document: string }>(`SELECT metadata->>'document' AS document FROM documents WHERE id = $1`, [r.body["document_id"]]))[0]!.document) as Json;
    assert.equal((input["conditions"] as Json)["passed"], true, "the derived evaluateFundingConditions passed from the record"); assert.equal(input["op"], "release"); assert.ok(!("amount_cents" in { funding_id: FUNDING_ID, wire_id: WIRE_ID }), "the person never typed a figure");
    const release = await db.query<{ type: string; application_id: string | null; loan_id: string | null }>(`SELECT type, application_id::text AS application_id, loan_id::text AS loan_id FROM loan_events WHERE application_id = $1 AND type LIKE 'funding.%' AND type LIKE '%release%'`, [appId]);
    assert.ok(release.length >= 1, "the release event"); for (const e of release) { assert.equal(e.application_id, appId); assert.equal(e.loan_id, null); }
  } finally { clock.set(back); }
});
test("35.8-T7: Given an application with two open 23.3 conditions, when an `underwriting_reviewer` acts on `conditions.clear{condition_id, evidence_document_id}` for each and then `conditions.ctc`, then `condition.cleared` ×2 and `clear_to_close.issued` exist with the staff user as actor, 35.6's orchestration opens on the CTC, and the same three acts by an `ops_analyst` session are refused `ROLE_REQUIRED{underwriting_reviewer}` before any read of the condition rows (contract: the refusal precedes the projection query in the action log's timing and no derivation row exists).", { skip }, async () => {
  await invite("uma", UMA, ["ops_analyst"]); await grant("uma", "underwriting_reviewer");
  const l = await fixtureL1();
  const app = await runtime.createApplication({ partner_party_id: l.partnerPartyId, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "Applicant Seven" }] }, { kind: "system", id: "test" }); const appId = app.application.id; const sub7 = { kind: "application", id: appId };
  // two open 23.3 conditions on the record (23.2's openCondition, the DU income template: a pay stub and a W-2) and the conditional approval of record
  const mem = new MemoryEventStore(clock);
  const cond = (n: number) => openCondition(mem, { application_id: appId, submission_id: "SUB-1", template_code: "COND_DU_VERIFY_INCOME_BASE", category: "income", stage: "ptd", text: "Your lender needs your most recent pay stub covering 30 days and your W-2 for the most recent year.", internal_text: `DU V100${n}`, du_message_id: `V100${n}`, evidence_kinds: ["paystub", "w2"], auto_clear_rule: "B3-3.2-01/DU:paystub_30d_w2_1y", requires_role: null, opened_at: clock.now(), message_ids: [`V100${n}`] }).condition;   // 23.2 keys the condition id on the DU message: two messages, two conditions
  const c1 = cond(1); const c2 = cond(2); const decisionId = `CD-${R}`;
  const decision = { decision_id: decisionId, application_id: appId, kind: "conditional_approval", du_submission_id: "SUB-1", interpretation_id: null, risk_assessment: { tier: "standard" }, inputs_hash: "sha256:fixture", evidence_document_ids: [], rule_set_versions: {}, model_version: "deterministic", prompt_version: "23.3-v1", rationale: "fixture", confidence: 1, conditions_snapshot: [], reviewer_id: null, reviewer_action: "none", reviewer_at: null, decided_at: clock.now(), decided_by: "agent:underwriter", valid_until: "2026-12-31", validity_component: "credit", status: "active", regb_notice_kind: "none", notice_id: null, ctc_at: null, ctc_checklist_id: null, ptf_cleared_at: null, reopen_cause: null, note_date: "2026-10-15", du_used: { qualifying_income_cents: "1200000" }, verified: { income_cents: "1200000" } };
  await runtime.entities.save([{ kind: "conditions", id: c1.condition_id, data: c1 as unknown as Json, version: 1, updatedAt: clock.now(), updatedBy: "agent:underwriter" }, { kind: "conditions", id: c2.condition_id, data: c2 as unknown as Json, version: 1, updatedAt: clock.now(), updatedBy: "agent:underwriter" }, { kind: "credit_decisions", id: decisionId, data: decision, version: 1, updatedAt: clock.now(), updatedBy: "agent:underwriter" }], { applicationId: appId });
  const doc = async (kind: string, metadata: Json): Promise<string> => (await db.query<{ id: string }>(`INSERT INTO documents (application_id, kind, sha256, byte_size, storage_uri, mime_type, metadata) VALUES ($1, $2, $3, 10, $4, 'application/pdf', $5::jsonb) RETURNING id::text AS id`, [appId, kind, sha256hex(`${kind}-${randomUUID()}`), `fake-blob://${randomUUID()}`, JSON.stringify(metadata)]))[0]!.id;
  const paystub = await doc("paystub", { document_date: "2026-09-20", classified_at: clock.now(), is_credit_document: true, verification_id: "ver-inc-1" });
  await doc("w2", { document_date: "2026-01-31", tax_year: 2025, classified_at: clock.now(), is_credit_document: true, verification_id: "ver-w2-2025" });
  for (const code of CTC_ITEM_CODES) if (!["CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_DECISION_VALID", "CTC_REGB_TIMING"].includes(code)) await doc("ctc_evidence", { ctc_item: code, classified_at: clock.now() });
  // an ops_analyst session: ROLE_REQUIRED{underwriting_reviewer} before any read of the condition rows — no derivation row, the refusal in the action log
  for (const [action, decisionPayload] of [["clear", { condition_id: c1.condition_id, evidence_document_id: paystub }], ["clear", { condition_id: c2.condition_id, evidence_document_id: paystub }], ["ctc", {}]] as const) {
    const r = await act("ana", "ops_analyst", "conditions", sub7, action, decisionPayload as Json);
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body["code"], "ROLE_REQUIRED"); assert.equal(r.body["role"], "underwriting_reviewer"); assert.ok((r.body["held"] as string[]).includes("ops_analyst")); assert.deepEqual(r.body["act_as"], []);
    const [row] = await workActions(`id = $1`, [r.body["action_id"]]); assert.equal(row!["status"], "refused"); assert.equal(row!["refusal_code"], "ROLE_REQUIRED"); assert.equal(row!["derivation_id"], null);
    const sa = await staffActionsAtLeast(1, `subject_kind = 'work_action' AND subject_id = $1`, [r.body["action_id"]]); assert.equal(sa[0]!.result, "refused"); assert.equal(sa[0]!.refusal_code, "ROLE_REQUIRED"); assert.equal(sa[0]!.role, "ops_analyst");
  }
  assert.equal(await count(`work_derivations WHERE subject_id = $1`, [appId]), 0, "no derivation row: the refusal precedes the projection query");
  // the underwriting_reviewer clears both and issues the CTC: condition.cleared ×2 and clear_to_close.issued with the staff user as actor
  for (const c of [c1, c2]) { const r = await act("uma", "underwriting_reviewer", "conditions", sub7, "clear", { condition_id: c.condition_id, evidence_document_id: paystub, note: "pay stub and W-2 on file" }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["tool"], "clearCondition"); }
  const cleared = await events("condition.cleared", "AND application_id = $2", [appId]); assert.equal(cleared.length, 2); for (const e of cleared) { assert.equal(e.actor_kind, "human"); assert.equal(e.actor_id, ids["uma"]); }
  const ctc = await act("uma", "underwriting_reviewer", "conditions", sub7, "ctc", {}); assert.equal(ctc.status, 200, JSON.stringify(ctc.body)); assert.equal(ctc.body["tool"], "issueClearToClose");
  const issued = await events("clear_to_close.issued", "AND application_id = $2", [appId]); assert.equal(issued.length, 1); assert.equal(issued[0]!.actor_id, ids["uma"]); assert.equal(issued[0]!.payload["passed"], true);
  const input = JSON.parse((await db.query<{ document: string }>(`SELECT metadata->>'document' AS document FROM documents WHERE id = $1`, [ctc.body["document_id"]]))[0]!.document) as Json;
  assert.equal(((input["checklist"] as Json)["passed"]), true, "23.3's runCtcChecklist ran in the deriver"); assert.equal(Object.keys(input).includes("decision"), true);
  // 35.6's orchestration opens on the CTC (through the port: the seam's literal until 35.6's tool lands)
  const opened = await events("orchestration.opened", "AND application_id = $2", [appId]); assert.equal(opened.length, 1); assert.equal(opened[0]!.payload["cause"], "clear_to_close.issued");
  const screen = await read("uma", "underwriting_reviewer", "funding_release", sub7); assert.equal(screen.status, 200, JSON.stringify(screen.body)); assert.equal(((screen.body["projection"] as Json)["orchestration"] as Json)["orchestration_id"], opened[0]!.payload["orchestration_id"]);
  assertIdsOnly(screen.body, "the funding_release screen");
});

let T8_ITEMS: Json[] = []; let APP_ID = "";
test("35.8-T8: Given the console's five item kinds on the fixture book plus one 35.3 `job.unit.dead`, one 35.6 `orchestration.held` and one proposal of T3, when `work.queue{role: ops_analyst}` runs, then every row carries a `screen_code` per rule 8, `required_role`, `opened_at` and `due_at`, the five console kinds match `GET /api/queue` for the same role row for row, each source has exactly one open item (a second sweep opens none), and `SM_WORK_ITEM_AGE_2BD` is armed on each item's `opened_at`.", { skip }, async () => {
  const l = await fixtureL1();
  clock.set("2026-09-23T13:00:00.000Z");
  // the console's five item kinds on the fixture book, each at its own instant
  const escId = await openEscalation({ kind: "sev3", ownerRole: "ops_analyst", loanId: l.loanId, payload: { process: "2.1", kind: "partial_payment", timer_code: "FNMA_C1102_PARTIAL_BALANCE_30" } }, { kind: "system", id: "sweep" });
  clock.set(at(MIN));
  await db.query(`INSERT INTO human_portal_tasks (kind, adapter, owner_role, loan_id, package, status, opened_at) VALUES ('manual_status_code', 'fnma_servicing_events', 'fnma_portal_operator', $1, '{"code":"09"}'::jsonb, 'open', $2::timestamptz)`, [l.loanId, clock.now()]);
  clock.set(at(MIN));
  const [tpl] = await db.query<{ code: string; version: string }>(`SELECT code, version FROM notice_templates ORDER BY code LIMIT 1`).catch(() => [] as { code: string; version: string }[]);
  if (tpl) await db.query(`INSERT INTO notices (template_code, template_version, loan_id, payload_hash, payload, status, held_reason, produced_at) VALUES ($1, $2, $3, 'sha256:held', '{}'::jsonb, 'held', 'address_unverified', $4::timestamptz)`, [tpl.code, tpl.version, l.loanId, clock.now()]);
  clock.set(at(MIN));
  const [anyEvent] = await db.query<{ id: string }>(`SELECT id::text AS id FROM loan_events WHERE loan_id = $1 ORDER BY sequence LIMIT 1`, [l.loanId]);
  // a breached 16.x clock (a code 16.1 owns outright — a shared code belongs to the lowest-numbered section, spec_lint_names)
  const payoffCode = runtime.registry.all().find((x) => x.process.startsWith("16.") && runtime.registry.get(x.code)?.process.startsWith("16."))!.code;
  const [breachedTimer] = await db.query<{ id: string }>(`INSERT INTO timers (code, subject_kind, subject_id, loan_id, armed_at, armed_by_event_id, anchor_date, due_date, due_at, status, breached_at) VALUES ($4, 'loan', $1::text, $1::uuid, $2::timestamptz, $3::uuid, '2026-09-10', '2026-09-21', $2::timestamptz, 'breached', $2::timestamptz) RETURNING id::text AS id`, [l.loanId, clock.now(), anyEvent!.id, payoffCode]);
  clock.set(at(MIN));
  // 35.3's dead unit and 35.6's held step as their event literals on the seam; the proposal as `approval_pending`
  await runtime.uow.run(l.loanId, (ctx) => ctx.events.append({ type: "job.unit.dead", loanId: l.loanId, aggregate: { kind: "job_unit", id: `unit-${R}` }, actor: { kind: "system", id: "cycles-35-3" }, payload: { unit_id: `unit-${R}`, job_code: "cashiering.post", role: "ops_analyst", screen_code: "payment_post", attempts: 3 } }), { clock });
  clock.set(at(MIN));
  const app = await runtime.createApplication({ partner_party_id: l.partnerPartyId, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "Applicant Person" }] }, { kind: "system", id: "test" }); APP_ID = app.application.id;
  await runtime.uow.run({ applicationId: APP_ID }, (ctx) => ctx.events.append({ type: "orchestration.held", applicationId: APP_ID, aggregate: { kind: "closing_orchestration", id: `orch-${R}` }, actor: { kind: "system", id: "closing-35-6" }, payload: { orchestration_id: `orch-${R}`, step: "funding_authorized", waiting_on: "funding_approver", role: "funding_approver" } }), { clock });
  clock.set(at(MIN));
  const prop = await api("POST", `${screenPath("payoff_quote", sub(l))}/propose`, { action: "quote", decision: { requester_kind: "borrower", good_through: "2026-10-15", delivery: "portal" } }, bearer(await fresh("ana"), "ops_analyst")); assert.equal(prop.status, 200, JSON.stringify(prop.body)); assert.equal(prop.body["status"], "proposed");
  clock.set(at(MIN));
  const s1 = await sweep(); assert.ok(s1.work_breaches && s1.work_breaches.queue.opened >= 5, `the queue pass opened the items: ${JSON.stringify(s1.work_breaches)}`);
  const q = await api("GET", "/ops/api/work/queue?role=ops_analyst", undefined, bearer(await fresh("ana"), "ops_analyst")); assert.equal(q.status, 200, JSON.stringify(q.body));
  const rows = q.body["items"] as Json[]; assert.ok(rows.length >= 4, JSON.stringify(rows));
  for (const r of rows) { for (const k of ["screen_code", "required_role", "opened_at", "due_at", "source_kind", "source_id", "status"]) assert.ok(k in r, `${k} on every row`); assert.ok((SCREENS.map((s) => s.code) as string[]).includes(r["screen_code"] as string) || r["screen_code"] === "escalation", `screen_code per rule 8: ${String(r["screen_code"])}`); }
  const bySource = (kind: string, id?: string): Json => { const r = rows.find((x) => x["source_kind"] === kind && (!id || x["source_id"] === id)); assert.ok(r, `${kind} ${id ?? ""} in the queue: ${JSON.stringify(rows.map((x) => [x["source_kind"], x["source_id"], x["screen_code"]]))}`); return r!; };
  assert.equal(bySource("escalation", escId)["screen_code"], "payment_post"); assert.equal(bySource("breached_timer", breachedTimer!.id)["screen_code"], "payoff_quote"); assert.equal(bySource("dead_letter")["screen_code"], "payment_reverse");
  const all = await items(`status NOT IN ('closed', 'cancelled')`);
  assert.equal((all.find((x) => x["source_kind"] === "job_dead") as Json)["screen_code"], "payment_post"); assert.equal((all.find((x) => x["source_kind"] === "orchestration_held") as Json)["screen_code"], "funding_release"); assert.equal((all.find((x) => x["source_kind"] === "orchestration_held") as Json)["required_role"], "funding_approver");
  assert.ok(all.some((x) => x["source_kind"] === "approval_pending" && x["source_id"] === prop.body["action_id"] && x["required_role"] === "officer"), "the proposal is an approval_pending item");
  // the five console kinds match GET /api/queue for the same role row for row
  const console = await api("GET", "/ops/api/queue?role=ops_analyst", undefined, bearer(await fresh("ana"), "ops_analyst")); assert.equal(console.status, 200);
  // the console still lists this process's own clocks and their escalations (SM_WORK_*); those are the queue's bookkeeping, never its sources (items.ts isOwnBookkeeping)
  const consoleAll = console.body as unknown as Json[];
  // …and a breached clock whose breach escalation is on the console rides with the escalation's item (items.ts collectSources: one source, one item)
  const escalatedClocks = new Set(consoleAll.filter((c) => c["kind"] === "escalation").map((c) => String((c["detail"] as Json | undefined)?.["timer_id"] ?? "")));
  const consoleRows = consoleAll.filter((c) => !(c["kind"] === "breached_timer" && (/^SM_WORK_/.test(String(c["title"])) || escalatedClocks.has(String(c["id"])))) && !(c["kind"] === "escalation" && /^SM_WORK_/.test(String((c["detail"] as Json | undefined)?.["timer_code"] ?? ""))));
  const five = rows.filter((r) => ["escalation", "portal_task", "held_notice", "dead_letter", "breached_timer"].includes(r["source_kind"] as string));
  const missing = five.filter((r) => !consoleRows.some((c) => c["id"] === r["source_id"]));
  const missingTimers = missing.length ? await db.query<Json>(`SELECT id::text AS id, code, status::text AS status, breached_at::text AS breached_at FROM timers WHERE id::text = ANY($1::text[])`, [missing.map((r) => r["source_id"])]) : [];
  assert.deepEqual(five.map((r) => `${String(r["source_kind"])}:${String(r["source_id"])}`), consoleRows.map((r) => `${String(r["kind"])}:${String(r["id"])}`), `mine=${five.length} console=${consoleRows.length} missing=${JSON.stringify(missing.map((r) => [r["source_kind"], r["source_id"], r["screen_code"]]))} timers=${JSON.stringify(missingTimers)}`);
  // each source has exactly one open item; a second sweep opens none
  const dup = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM (SELECT source_kind, source_id FROM work_items WHERE status NOT IN ('closed', 'cancelled') GROUP BY 1, 2 HAVING count(*) > 1) d`); assert.equal(dup[0]!.n, "0");
  const s2 = await sweep(); const newest = await db.query<Json>(`SELECT source_kind, source_id, screen_code, required_role, opened_at::text AS opened_at, created_at::text AS created_at FROM work_items ORDER BY created_at DESC LIMIT 3`);
  assert.equal(s2.work_breaches!.queue.opened, 0, `a second sweep opens none: ${JSON.stringify(newest)} breaches=${JSON.stringify(s2.breaches)}`);
  // SM_WORK_ITEM_AGE_2BD armed on each item's opened_at
  for (const it of all) { const t = await timers("SM_WORK_ITEM_AGE_2BD", "AND subject_kind = 'work_item' AND subject_id = $2", [it["id"]]); assert.equal(t.length, 1, `AGE_2BD on ${String(it["source_kind"])}`); assert.ok(["armed", "breached"].includes(t[0]!.status)); assert.equal(t[0]!.anchor_date, String(it["opened_at"]).slice(0, 10)); }
  T8_ITEMS = all; assertIdsOnly(q.body, "the queue");
});

test("35.8-T9: Given an open item, when analyst A claims it and analyst B claims it, then B is refused `CLAIMED_BY_OTHER{staff_user_id}` carrying A's id and no name; when 4 hours pass on the demo clock without A releasing, then `SM_WORK_ITEM_CLAIM_4H` breaches, the breach handler emits `work.item.claim_expired{lapses: 1}` and the item is `open`; after the third lapse an `ops_analyst` escalation exists and none before.", { skip }, async () => {
  const item = T8_ITEMS.find((x) => x["source_kind"] === "escalation" && x["required_role"] === "ops_analyst")!; assert.ok(item, "an analyst's escalation item from T8"); const id = item["id"] as string;   // the analyst's item, whatever order the rows come in
  const a = await api("POST", `/ops/api/work/items/${id}/claim`, {}, bearer(await fresh("ana"), "ops_analyst")); assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await api("POST", `/ops/api/work/items/${id}/claim`, {}, bearer(await fresh("bob"), "ops_analyst"));
  assert.equal(b.status, 409, JSON.stringify(b.body)); assert.equal(b.body["code"], "CLAIMED_BY_OTHER"); assert.equal(b.body["staff_user_id"], ids["ana"]); assertIdsOnly(b.body, "CLAIMED_BY_OTHER");
  assert.ok(!JSON.stringify(b.body).includes(ANA.name), "the id, never the name");
  const escalationsFor = () => count(`escalations WHERE payload->>'work_item_id' = $1 AND owner_role = 'ops_analyst'`, [id]);
  for (let lapse = 1; lapse <= 3; lapse++) {
    if (lapse > 1) assert.equal((await api("POST", `/ops/api/work/items/${id}/claim`, {}, bearer(await fresh("ana"), "ops_analyst"))).status, 200);
    clock.set(at(4 * HOUR + MIN));
    assert.equal(await escalationsFor(), 0, `no ops_analyst escalation before the third lapse (lapse ${lapse})`);
    const s = await sweep();
    const breached = await timers("SM_WORK_ITEM_CLAIM_4H", "AND subject_id = $2 AND status = 'breached'", [id]); assert.equal(breached.length, lapse, "the claim clock breaches through the engine");
    assert.equal(s.work_breaches!.claims_lapsed, 1, JSON.stringify(s.work_breaches));
    const exp = await events("work.item.claim_expired", "AND aggregate_id = $2", [id]); assert.equal(exp.length, lapse); assert.equal(exp[lapse - 1]!.payload["lapses"], lapse);
    const [row] = await items(`id = $1`, [id]); assert.equal(row!["status"], "open"); assert.equal(row!["claim_lapses"], lapse); assert.equal(row!["claimed_by"], null);
  }
  assert.equal(await escalationsFor(), 1, "the third lapse opens the ops_analyst escalation");
});

test("35.8-T10: Given an item opened 2026-09-14 (Monday) and left open, when the sweep crosses 2026-09-16 17:00 servicer time, then `SM_WORK_ITEM_AGE_2BD` breaches to a sev 2 `ops_analyst` escalation; when it crosses 2026-09-21, then `SM_WORK_ITEM_AGE_5BD` breaches to a sev 1 `officer` escalation and `role.queue.unstaffed{role}` is emitted; when the item is closed on 2026-09-15, then neither arms past `satisfied`.", { skip }, async () => {
  const t = await testDatabase(import.meta.url, { suffix: "t10" }); const wdb = connect(t.url); const wclock = new FixedClock("2026-09-14T13:00:00.000Z");   // Monday 09:00 ET
  const rt = new Runtime({ db: wdb, registry: loadOverriddenRegistry(), clock: wclock, logger, environment: "nonprod", env: ENV_NONPROD, reviewers: null });
  const server = createApiServer({ runtime: rt, apiToken: TOKEN, logger, borrower: { environment: "nonprod", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  const wbase = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  try {
    const boot = await bootstrapStaffAdmin(rt, `ada10.${R}@example.test`, { legal_name: "Ada Ten" }); await enrol({ email: `ada10.${R}@example.test`, password: `ada10-correct-horse-${R}` }, wbase); const ada = await signIn({ email: `ada10.${R}@example.test`, password: `ada10-correct-horse-${R}` }, wbase); void boot;
    const p = { email: `ann10.${R}@example.test`, password: `ann10-correct-horse-${R}` };
    assert.equal((await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: "Ann Ten", roles: ["ops_analyst"] }, bearer(ada.token), wbase)).status, 200);
    await enrol(p, wbase); const ann = await signIn(p, wbase);
    const f = await new PgLoanRepository(wdb).createFixture({ fnmaLoanNumber: `${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2026-08-01"), maturityDate: D("2056-08-01") });
    const open = async (): Promise<string> => { const r = await api("POST", "/ops/api/work/items", { screen_code: "payment_post", subject: { kind: "loan", id: f.loanId }, required_role: "ops_analyst", reason: "T10" }, bearer(ann.token, "ops_analyst"), wbase); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body["item"] as Json)["id"] as string; };
    const aged = await open(); const closedSoon = await open();
    const wtimers = (code: string, subjectId: string) => wdb.query<TimerRow>(`SELECT id::text AS id, code, status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at, armed_at::text AS armed_at FROM timers WHERE code = $1 AND subject_id = $2 ORDER BY armed_at`, [code, subjectId]);
    const [two] = await wtimers("SM_WORK_ITEM_AGE_2BD", aged); const [five] = await wtimers("SM_WORK_ITEM_AGE_5BD", aged);
    assert.equal(two!.anchor_date, "2026-09-14"); assert.equal(two!.due_date, "2026-09-16"); assert.equal(two!.due_at, "2026-09-16 21:00:00+00", "17:00 servicer time"); assert.equal(five!.due_date, "2026-09-21");
    // the second item is closed on 2026-09-15: neither clock arms past satisfied
    wclock.set("2026-09-15T14:00:00.000Z");
    const ann2 = await signIn(p, wbase);
    assert.equal((await api("POST", `/ops/api/work/items/${closedSoon}/close`, { disposition: "worked", reason: "done" }, bearer(ann2.token, "ops_analyst"), wbase)).status, 200);
    for (const code of ["SM_WORK_ITEM_AGE_2BD", "SM_WORK_ITEM_AGE_5BD"]) { const [tm] = await wtimers(code, closedSoon); assert.equal(tm!.status, "satisfied", `${code} satisfied by work.item.closed`); }
    // the sweep crosses 2026-09-16 17:00 servicer time → SM_WORK_ITEM_AGE_2BD breaches to a sev 2 ops_analyst escalation
    wclock.set("2026-09-16T20:59:00.000Z"); await rt.sweep(wclock.now(), { verify: false });
    assert.equal((await wtimers("SM_WORK_ITEM_AGE_2BD", aged))[0]!.status, "armed", "not before 17:00");
    wclock.set("2026-09-16T21:01:00.000Z"); await rt.sweep(wclock.now(), { verify: false });
    assert.equal((await wtimers("SM_WORK_ITEM_AGE_2BD", aged))[0]!.status, "breached");
    const [e2] = await wdb.query<{ kind: string; owner_role: string; severity: string }>(`SELECT kind, owner_role, severity FROM escalations WHERE payload->>'timer_id' = $1`, [two!.id]); assert.ok(e2, "the sev 2 escalation"); assert.deepEqual([e2!.kind, e2!.owner_role, e2!.severity], ["sev2", "ops_analyst", "2"]);
    assert.equal((await wtimers("SM_WORK_ITEM_AGE_5BD", aged))[0]!.status, "armed");
    // 2026-09-21 → SM_WORK_ITEM_AGE_5BD breaches to a sev 1 officer escalation and role.queue.unstaffed{role} is emitted
    wclock.set("2026-09-21T21:01:00.000Z"); await rt.sweep(wclock.now(), { verify: false });
    assert.equal((await wtimers("SM_WORK_ITEM_AGE_5BD", aged))[0]!.status, "breached");
    const [e5] = await wdb.query<{ kind: string; owner_role: string; severity: string }>(`SELECT kind, owner_role, severity FROM escalations WHERE payload->>'timer_id' = $1`, [five!.id]); assert.ok(e5, "the sev 1 escalation"); assert.deepEqual([e5!.kind, e5!.owner_role, e5!.severity], ["sev1", "officer", "1"]);
    const un = await wdb.query<{ payload: Json }>(`SELECT payload FROM loan_events WHERE type = 'role.queue.unstaffed' AND payload->'item_ids' ? $1`, [aged]); assert.equal(un.length, 1); assert.equal(un[0]!.payload["role"], "ops_analyst"); assert.equal(un[0]!.payload["count"], 1);
    for (const code of ["SM_WORK_ITEM_AGE_2BD", "SM_WORK_ITEM_AGE_5BD"]) assert.equal((await wtimers(code, closedSoon))[0]!.status, "satisfied");
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }); await wdb.end(); await t.close(); }
});

test("35.8-T11: Given a day with T1's executed act, T2's refusal, T3's proposal and approval, when `work.log.recon{as_of_date}` runs, then `actions_checked = 4`, `orphans = 0`, `stale_screens = 0`, `work_log_recon_runs` has one row with a report document, and `work.log.recon.run_completed` satisfies and re-arms `SM_WORK_LOG_RECON_DAILY` on the global subject; given an executed `work_actions` row whose `staff_actions` row is deleted in the test fixture, then `orphans = 1` and a sev 3 `compliance` escalation names the action id.", { skip }, async () => {
  await invite("cara", CARA, ["compliance"]);
  const recon = async (asOf: string): Promise<Reply> => api("POST", "/ops/api/work/recon", { as_of_date: asOf }, bearer(await fresh("cara"), "compliance"));
  // the day of T1's executed act, T2's refusal, T3's proposal and approval
  const r = await recon("2026-09-18"); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body["actions_checked"], 4, JSON.stringify(r.body)); assert.equal(r.body["orphans"], 0, JSON.stringify(r.body)); assert.equal(r.body["stale_screens"], 0);
  const runs = await db.query<{ id: string; report_document_id: string | null; actions_checked: number; orphans: number }>(`SELECT id::text AS id, report_document_id::text AS report_document_id, actions_checked, orphans FROM work_log_recon_runs WHERE id = $1`, [r.body["run_id"]]); assert.equal(runs.length, 1); assert.ok(runs[0]!.report_document_id); assert.equal(runs[0]!.actions_checked, 4);
  const [doc] = await db.query<{ kind: string; sha256: string; document: string }>(`SELECT kind, sha256, metadata->>'document' AS document FROM documents WHERE id = $1`, [runs[0]!.report_document_id]); assert.equal(doc!.kind, "work-log-recon.json"); assert.equal(sha256hex(doc!.document), doc!.sha256);
  const done = await events("work.log.recon.run_completed", "AND payload->>'run_id' = $2", [runs[0]!.id]); assert.equal(done.length, 1); assert.equal(done[0]!.payload["actions_checked"], 4);
  // the global clock: armed on the global subject by the first run, satisfied and re-armed by the next
  const g1 = await timers("SM_WORK_LOG_RECON_DAILY"); assert.ok(g1.length >= 1); assert.ok(g1.every((x) => x.subject_kind === "global"));
  const armedBefore = g1.filter((x) => x.status === "armed"); assert.equal(armedBefore.length, 1);
  clock.set(at(24 * HOUR));
  const r2 = await recon("2026-09-24"); assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const g2 = await timers("SM_WORK_LOG_RECON_DAILY"); assert.equal(g2.find((x) => x.id === armedBefore[0]!.id)!.status, "satisfied"); assert.equal(g2.filter((x) => x.status === "armed").length, 1, "re-armed on the global subject");
  // an executed row whose staff_actions row is deleted in the fixture → orphans = 1 and a sev 3 compliance escalation names the action id
  await db.query(`ALTER TABLE staff_actions DISABLE TRIGGER staff_actions_immutable`);
  await db.query(`DELETE FROM staff_actions WHERE subject_kind = 'work_action' AND subject_id = $1`, [T1_ACTION]);
  await db.query(`ALTER TABLE staff_actions ENABLE TRIGGER staff_actions_immutable`);
  const r3 = await recon("2026-09-18"); assert.equal(r3.status, 200, JSON.stringify(r3.body)); assert.equal(r3.body["orphans"], 1); assert.deepEqual(r3.body["orphan_action_ids"], [T1_ACTION]);
  const [esc] = await db.query<{ kind: string; owner_role: string; payload: Json }>(`SELECT kind, owner_role, payload FROM escalations WHERE id = $1`, [r3.body["escalation_id"]]); assert.equal(esc!.kind, "sev3"); assert.equal(esc!.owner_role, "compliance"); assert.deepEqual(esc!.payload["orphan_action_ids"], [T1_ACTION]);
});

test("35.8-T12: Given the bus registry loaded with 2.1's `payments.read/write` declaring `moneyFields` and the registered `payment_reverse` screen version, when the registry is changed in a test to add a role to the tool's `humanRoles`, then the next reconciliation reports `stale_screens = 1`, `work.screen.read` lists the screen's actions as `available: false, needs: re-registration`, `work.screen.act` answers `SCREEN_STALE{code, version}`, and after `work_screen_versions` gains version + 1 the actions are available again.", { skip }, async () => {
  const l = await fixtureL1();
  const def = runtime.tool("2.1", "payments.read/write") as unknown as { humanRoles?: string[] };
  const before = await db.query<{ version: number }>(`SELECT version FROM work_screen_versions WHERE code = 'payment_reverse' ORDER BY version DESC LIMIT 1`); const v0 = before[0]!.version;
  const original = def.humanRoles;
  // the registry changed in a test: a role added to the tool's humanRoles
  Object.assign(def, { humanRoles: [...new Set([...(original ?? ["ops_analyst", "officer", "attorney", "human_agent"]), "compliance"])] });
  try {
    clock.set(at(HOUR));
    const r = await api("POST", "/ops/api/work/recon", { as_of_date: "2026-09-25" }, bearer(await fresh("cara"), "compliance")); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body["stale_screens"], 1); assert.ok((r.body["stale_codes"] as string[]).includes("payment_reverse"));
    const rd = await read("ana", "ops_analyst", "payment_reverse", sub(l)); assert.equal(rd.status, 200, JSON.stringify(rd.body)); assert.equal(rd.body["stale"], true);
    for (const a of rd.body["actions"] as Json[]) { assert.equal(a["available"], false); assert.equal(a["needs"], "re-registration"); }
    const bad = await act("ana", "ops_analyst", "payment_reverse", sub(l), "reverse", { payment_id: L1_PAY_SEP, reason: "duplicate" });
    assert.equal(bad.status, 409, JSON.stringify(bad.body)); assert.equal(bad.body["code"], "SCREEN_STALE"); assert.equal(bad.body["version"], v0); assert.equal(bad.body["screen_code"], "payment_reverse");
    // work_screen_versions gains version + 1: the actions are available again
    const reg = await registerScreens(runtime, db, clock.now()); assert.ok(reg.written.includes("payment_reverse"));
    const after = await db.query<{ version: number }>(`SELECT version FROM work_screen_versions WHERE code = 'payment_reverse' ORDER BY version DESC LIMIT 1`); assert.equal(after[0]!.version, v0 + 1);
    const rd2 = await read("ana", "ops_analyst", "payment_reverse", sub(l)); assert.equal(rd2.body["stale"], false); assert.ok((rd2.body["actions"] as Json[]).every((a) => a["available"] === true));
    const ok = await api("POST", "/ops/api/work/recon", { as_of_date: "2026-09-25" }, bearer(await fresh("cara"), "compliance")); assert.equal(ok.body["stale_screens"], 0);
  } finally { if (original === undefined) delete def.humanRoles; else def.humanRoles = original; await registerScreens(runtime, db, clock.now()); }
});

test("35.8-T13: Given a 12.2 loss-mitigation evaluation with outcome `deny`, when a `human_agent` acts on `lossmit_decision.decide{request_id, disposition: deny, denial_reasons}`, then 12.2's own routing sends the denial to `lossmit_reviewer` (the `SM_LM_REVIEWER_DENIAL_APPROVAL_2BD` clock arms) and no denial notice is sent by the screen; when the `lossmit_reviewer` approves through the same screen, then 12.2's denial event and notice exist with both actors and the screen wrote no notice code of its own (contract: no notice row has `producer = '35.8'`).", { skip }, async () => {
  await invite("hal", HAL, ["ops_analyst"]); await grant("hal", "human_agent");
  await invite("lin", LIN, ["ops_analyst"]); await grant("lin", "lossmit_reviewer");
  clock.set(at(HOUR));
  const l = await loanFixture({ upbCents: 25_000_000n, firstPaymentDate: "2026-08-01", state: "TX" }); const sub13 = sub(l);
  // the borrower party the denial notice is addressed to (never on a screen: the deriver reads it, the notice tool prints it)
  const [party] = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', 'Borrower Thirteen', '{}'::jsonb) RETURNING id::text AS id`);
  const [b] = await db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, party_id) VALUES ('Borrower Thirteen', '1313', $1) RETURNING id::text AS id`, [party!.id]);
  await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [l.loanId, b!.id]);
  // 12.2's evaluation on the record with the outcome the engine reached
  const evalId = `eval-13-${R}`; const LOSSMIT: Actor = { kind: "agent", id: "lossmit-underwriter" };
  await tool("12.2", "lossmit.evaluation.*", LOSSMIT, { op: "start", id: evalId, loan_id: l.loanId, complete_on: "2026-09-01", state: "TX", option: "flex_mod", basis: "complete_application" }, { loanId: l.loanId });
  const noticesBefore = await count(`notices WHERE loan_id = $1`, [l.loanId]);
  // the human_agent decides `deny`: 12.2's own routing sends the denial to the lossmit_reviewer — the clock arms, no notice is sent by the screen
  const deny = await act("hal", "human_agent", "lossmit_decision", sub13, "decide", { request_id: evalId, disposition: "deny", denial_reasons: ["AFFORD_REPAY_150"] });
  assert.equal(deny.status, 200, JSON.stringify(deny.body)); assert.equal(deny.body["tool"], "lossmit.evaluation.*"); const dOut = deny.body["output"] as Json; assert.equal(dOut["status"], "reviewer_pending"); assert.equal(dOut["has_denial"], true);
  const sla = await timers("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD", "AND loan_id = $2", [l.loanId]); assert.equal(sla.length, 1, JSON.stringify({ all: await timers("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD"), out: dOut, events: (await db.query<Json>(`SELECT type, loan_id::text AS loan_id, payload FROM loan_events WHERE loan_id = $1 AND type LIKE 'lossmit.%'`, [l.loanId])) })); assert.equal(sla[0]!.status, "armed");
  assert.equal(await count(`notices WHERE loan_id = $1`, [l.loanId]), noticesBefore, "no denial notice is sent by the screen");
  const drafted = await events("lossmit.evaluation.decision_drafted", "AND loan_id = $2", [l.loanId]); assert.equal(drafted.length, 1); assert.equal(drafted[0]!.actor_id, ids["hal"]); assert.equal(drafted[0]!.payload["has_denial"], true);
  // the lossmit_reviewer approves through the same screen; the denial notice is 12.2's own, dispatched as an action
  const review = await act("lin", "lossmit_reviewer", "lossmit_decision", sub13, "review", { request_id: evalId, decision: "approved" });
  assert.equal(review.status, 200, JSON.stringify(review.body)); const rOut = review.body["output"] as Json; assert.equal(rOut["status"], "decided"); assert.ok(rOut["reviewer_approval_id"]);
  assert.equal((await timers("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD", "AND loan_id = $2", [l.loanId]))[0]!.status, "satisfied");
  const reviewed = await db.query<{ type: string; actor_id: string }>(`SELECT type, actor_id FROM loan_events WHERE loan_id = $1 AND type LIKE 'lossmit.evaluation.%' AND actor_id = $2`, [l.loanId, ids["lin"]]); assert.ok(reviewed.length >= 1, "12.2's decision event by the reviewer");
  const notify = await act("lin", "lossmit_reviewer", "lossmit_decision", sub13, "notify", { request_id: evalId });
  assert.equal(notify.status, 200, JSON.stringify(notify.body)); assert.equal(notify.body["process"], "12.2"); assert.equal(notify.body["tool"], "notice.render_send"); assertIdsOnly(notify.body, "the lossmit_decision notify answer");
  // 12.2's notice is the Notice Registry's (src/notices/service.ts: `notice.rendered` then `notice.sent` on the loan, the rendered notice in the runtime's notice memory); the screen wrote none of its own
  const noticeEvents = await db.query<{ type: string; actor_id: string; payload: Json }>(`SELECT type, actor_id, payload FROM loan_events WHERE loan_id = $1 AND type IN ('notice.rendered', 'notice.sent', 'notice.held') ORDER BY sequence`, [l.loanId]);
  const denialNotice = noticeEvents.filter((e) => e.payload["template"] === "NTC_REGX_41C1_DENIAL");
  assert.ok(denialNotice.some((e) => e.type === "notice.rendered"), `12.2's denial notice rendered: ${JSON.stringify(noticeEvents.map((e) => [e.type, e.payload["template"]]))} out=${JSON.stringify(notify.body["output"])}`);
  assert.ok(denialNotice.some((e) => e.type === "notice.sent"), "12.2's denial notice sent");
  assert.ok([...runtime.noticeMemory.values()].some((n) => n.templateCode === "NTC_REGX_41C1_DENIAL" && n.loanId === l.loanId), "the rendered notice is in the registry's memory");
  assert.equal(await count(`notices WHERE loan_id = $1 AND payload->>'producer' = '35.8'`, [l.loanId]), 0, "no notice row has producer = 35.8");
  // 35.2's artifact layer persists every rendered notice on the registry's own deferred write (src/runtime/servicing.ts persistNotice's note): the rows the loan gained are 12.2's denial notice, never a row of this process's
  const noticeRows = await db.query<{ template_code: string; payload: Json }>(`SELECT template_code, payload FROM notices WHERE loan_id = $1 ORDER BY produced_at`, [l.loanId]);
  assert.equal(noticeRows.length - noticesBefore, 1, "one notice row: 12.2's denial, persisted by the registry's sink"); assert.equal(noticeRows.at(-1)!.template_code, "NTC_REGX_41C1_DENIAL", "the screen wrote no notice row of its own");
  for (const e of noticeEvents) assert.notEqual(e.payload["producer"], "35.8", "no notice event names 35.8 as its producer");
  const commands = await staffActionsAtLeast(3, `subject_kind = 'work_action' AND subject_id = ANY($1::text[])`, [[deny.body["action_id"], review.body["action_id"], notify.body["action_id"]]]);
  assert.deepEqual(commands.map((x) => x.command).sort(), ["12.2 lossmit.evaluation.*", "12.2 lossmit.evaluation.*", "12.2 notice.render_send"]);
  assert.deepEqual([...new Set(commands.map((x) => x.staff_user_id))].sort(), [ids["hal"], ids["lin"]].sort(), "both actors");
  assertIdsOnly(deny.body, "the decide answer"); assertIdsOnly(review.body, "the review answer");
});
test("35.8-T14: Given a 14.1 bankruptcy case and a trustee cheque of 150,000¢ received 2026-09-10, when an `ops_analyst` acts on `bankruptcy_case.apply_trustee{case_id, amount_cents: \"150000\", received_on}`, then the act is `proposed` (money) and the ledger is untouched; when an `officer` approves, then 14.1's `bk.ledger.apply_trustee` posts a balanced set with `rule_ref` and the `amount_cents` in the derivation equals the person's figure (the one decision field the person is the source of), and `state`, `ledger_snapshot` and `plan` in the input came from the record.", { skip }, async () => {
  clock.set(at(HOUR));
  const l = await loanFixture({ upbCents: 26_000_000n, firstPaymentDate: "2026-08-01" }); const sub14 = sub(l); const caseId = `BK-14-${R}`;
  // 14.1's case on the record: the ledgers, the plan (schedule, note), the claim
  const schedule = [{ due: "2026-09-01", payment_number: 62, pi_cents: "158017", escrow_cents: "61240", amount_cents: "219257" }, { due: "2026-10-01", payment_number: 63, pi_cents: "158017", escrow_cents: "61240", amount_cents: "219257" }];
  const plan = { schedule, note: { original_upb_cents: "26000000", rate_pct: "6.500", term_months: 360, pi_cents: "158017" }, designation: "post-petition" };
  const claim = { total_cents: "438514", components: [{ component: "interest", installment_due: "2026-07-01", cents: "140833" }, { component: "principal", installment_due: "2026-07-01", cents: "17184" }, { component: "interest", installment_due: "2026-08-01", cents: "140740" }, { component: "principal", installment_due: "2026-08-01", cents: "17277" }, { component: "escrow_deficiency", installment_due: null, cents: "122480" }] };
  const ledgers = { prepetition_arrearage_cents: "438514", postpetition: [{ due: "2026-09-01", amount_cents: "219257", paid_cents: "0" }, { due: "2026-10-01", amount_cents: "219257", paid_cents: "0" }], postpetition_suspense_cents: "0" };
  await runtime.entities.save([{ kind: "bankruptcy_cases", id: caseId, data: { loan_id: l.loanId, case_id: caseId, chapter: "13", status: "active", case_number_full: "26-12345-ABC", conduit_district: true, plan_designation: "post-petition", ledgers, plan, claim }, version: 1, updatedAt: clock.now(), updatedBy: "agent:bankruptcy-ops" }], { loanId: l.loanId });
  const linesBefore = await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]);
  // the trustee cheque of 150,000¢ received 2026-09-10 — the one figure the person is the source of; the act is money: proposed
  const prop = await act("ana", "ops_analyst", "bankruptcy_case", sub14, "apply_trustee", { case_id: caseId, amount_cents: "150000", received_on: "2026-09-10" });
  assert.equal(prop.status, 200, JSON.stringify(prop.body)); assert.equal(prop.body["status"], "proposed"); assert.equal(prop.body["money"], true); assert.equal(prop.body["tool"], "bk.ledger.apply_trustee");
  assert.equal(await count(`ledger_lines WHERE loan_id = $1`, [l.loanId]), linesBefore, "the ledger is untouched");
  const derivation = JSON.parse((await db.query<{ document: string }>(`SELECT metadata->>'document' AS document FROM documents WHERE id = $1`, [prop.body["document_id"]]))[0]!.document) as Json;
  assert.equal(derivation["amount_cents"], "150000", "the amount in the derivation equals the person's figure");
  assert.deepEqual(derivation["plan"], plan, "plan from the record"); assert.equal((derivation["ledger_snapshot"] as Json)["prepetition_arrearage_cents"], "438514"); assert.deepEqual((derivation["ledgers"] as Json)["postpetition"], ledgers.postpetition);
  assert.equal((derivation["state"] as Json)["upb_cents"], "26000000", "state from the ledger"); assert.equal(derivation["case_number_full"], "26-12345-ABC");
  // a distinct officer approves: 14.1 posts a balanced set with rule_ref
  const ok = await decide("otto", prop.body["action_id"] as string, "approved", "trustee voucher verified");
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body["decision"], "approved");
  const sets = await db.query<{ set_id: string; sum: string; n: string; refs: string[] }>(`SELECT set_id::text AS set_id, sum(amount_cents)::text AS sum, count(*)::text AS n, array_agg(rule_ref) AS refs FROM ledger_lines WHERE set_id IN (SELECT DISTINCT set_id FROM ledger_lines WHERE loan_id = $1 AND rule_ref LIKE '14.1:%') GROUP BY set_id`, [l.loanId]);
  assert.ok(sets.length >= 1, "14.1's postings"); for (const st of sets) { assert.equal(st.sum, "0", `balanced set ${st.set_id}`); assert.ok(st.refs.every((r) => r.startsWith("14.1:")), "every line carries 14.1's rule_ref"); }
  assert.ok((await count(`ledger_lines WHERE loan_id = $1 AND account = 'bk_trustee_clearing'`, [l.loanId])) >= 1, "posted to bk_trustee_clearing");
  const [executed] = await workActions(`id = $1`, [ok.body["executed_action_id"]]); assert.equal(executed!["status"], "executed"); assert.equal(executed!["approval_of"], prop.body["action_id"]);
  assertIdsOnly(prop.body, "the proposal answer");
});

test("35.8-T15: Given any screen action, then no `ledger_lines` row has `rule_ref LIKE '35.8%'`, no `notices` row was produced by this process, no `timers` row was written by it (contract test over every `work.*` tool: the timer, notice and ledger tables before and after each tool differ only by rows the dispatched owning tool wrote), and every `work.screen.act`, `work.item.claim`, `work.item.close` and `work.action.decide` by an agent actor is refused `HUMAN_ONLY_ACT`.", { skip }, async () => {
  const l = await fixtureL1();
  clock.set(at(HOUR));
  const fingerprint = async () => ({ lines35: await count(`ledger_lines WHERE rule_ref LIKE '35.8%'`), notices: await count(`notices`), timers: (await db.query<{ id: string; code: string; armed_by: string | null }>(`SELECT t.id::text AS id, t.code, e.type AS armed_by FROM timers t LEFT JOIN loan_events e ON e.id = t.armed_by_event_id`)).map((x) => `${x.id}:${x.code}:${x.armed_by ?? ""}`), lines: await count(`ledger_lines`) });
  const ownTimer = (line: string): boolean => line.split(":")[1]!.startsWith("SM_WORK_") || !(line.split(":")[2] ?? "").startsWith("work.");
  const check = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    const b = await fingerprint(); await fn(); const a = await fingerprint();
    assert.equal(a.lines35, 0, `${name}: no ledger_lines row has rule_ref LIKE '35.8%'`);
    assert.equal(a.notices, b.notices, `${name}: no notices row was produced by this process`);
    const added = a.timers.filter((x) => !b.timers.includes(x)); assert.ok(added.every(ownTimer), `${name}: no timers row written by 35.8 beyond the registry's own SM_WORK_* clocks: ${added.join(", ")}`);
    if (!["work.screen.act", "work.action.decide"].includes(name)) assert.equal(a.lines, b.lines, `${name}: no ledger line`);
  };
  const analyst = asHuman("ana", "ops_analyst"); const pay = `pmt-L1-t15-${R}`; await receiveCurtailment(l, pay, 25_000n, "2026-09-25");
  let itemId = ""; let proposalId = "";
  await check("work.queue", () => tool("35.8", "work.queue", analyst, { role: "ops_analyst" }));
  await check("work.item.open", async () => { const r = await tool("35.8", "work.item.open", analyst, { screen_code: "payment_post", subject: sub(l), required_role: "ops_analyst", reason: "T15" }); itemId = ((r.output as Json)["item"] as Json)["id"] as string; });
  await check("work.item.claim", () => tool("35.8", "work.item.claim", analyst, { item_id: itemId }));
  await check("work.item.release", () => tool("35.8", "work.item.release", analyst, { item_id: itemId }));
  await check("work.screen.read", () => tool("35.8", "work.screen.read", analyst, { code: "payment_post", subject: sub(l) }, { loanId: l.loanId }));
  await check("work.screen.derive", () => tool("35.8", "work.screen.derive", analyst, { code: "payment_post", action: "post", subject: sub(l), decision: { payment_id: pay } }, { loanId: l.loanId }));
  await check("work.screen.act", () => tool("35.8", "work.screen.act", analyst, { code: "payment_post", action: "post", subject: sub(l), decision: { payment_id: pay } }, { loanId: l.loanId }));
  await check("work.action.propose", async () => { const r = await tool("35.8", "work.action.propose", CASE, { code: "payment_reverse", action: "reverse", subject: sub(l), decision: { payment_id: pay, reason: "duplicate" }, rationale: "the agent proposes; an officer decides" }, { loanId: l.loanId }); proposalId = (r.output as Json)["action_id"] as string; });
  await check("work.action.decide", () => tool("35.8", "work.action.decide", asHuman("otto", "officer"), { action_id: proposalId, decision: "declined", reason: "T15" }, { loanId: l.loanId }));
  await check("work.item.close", () => tool("35.8", "work.item.close", analyst, { item_id: itemId, disposition: "worked" }));
  await check("work.item.cancel", async () => { const r = await tool("35.8", "work.item.open", analyst, { screen_code: "payment_post", subject: sub(l), required_role: "ops_analyst", reason: "T15 cancel" }); await tool("35.8", "work.item.cancel", analyst, { item_id: ((r.output as Json)["item"] as Json)["id"], reason: "source gone" }); });
  await check("work.log.recon", () => tool("35.8", "work.log.recon", asHuman("cara", "compliance"), { as_of_date: "2026-09-25" }));
  // every work.screen.act, work.item.claim, work.item.close and work.action.decide by an agent actor is refused HUMAN_ONLY_ACT
  const r = await tool("35.8", "work.item.open", analyst, { screen_code: "payment_post", subject: sub(l), required_role: "ops_analyst", reason: "T15 agent" }); const agentItem = ((r.output as Json)["item"] as Json)["id"] as string;
  for (const [name, input] of [["work.screen.act", { code: "payment_post", action: "post", subject: sub(l), decision: { payment_id: pay } }], ["work.item.claim", { item_id: agentItem }], ["work.item.close", { item_id: agentItem, disposition: "worked" }], ["work.action.decide", { action_id: proposalId, decision: "approved" }]] as const)
    await assert.rejects(tool("35.8", name, CASE, input as Json, { loanId: l.loanId }), (e: Error & { code?: string }) => e.code === "HUMAN_ONLY_ACT", `${name} by an agent is HUMAN_ONLY_ACT`);
});

test("35.8-T16: Given a money-field change proposed by the agent — `work.action.propose` for `payment_reverse.reverse` or any decision payload naming a `*_cents` field the person is not the source of — when no `officer` approval record exists, then the command is refused and nothing is written beyond the proposal row; the `case` agent's `work.action.propose` never yields an `executed` row without a `work_approvals{decision: approved}` row by a human `officer`.", { skip }, async () => {
  const l = await fixtureL1();
  clock.set(at(HOUR));
  const posted = (await db.query<{ id: string }>(`SELECT id FROM entity_records WHERE kind = 'payments' AND loan_id = $1 AND data->>'status' = 'posted' ORDER BY version DESC LIMIT 1`, [l.loanId]))[0]!.id;
  const before = await count(`work_actions WHERE subject_id = $1`, [l.loanId]);
  const r = await tool("35.8", "work.action.propose", CASE, { code: "payment_reverse", action: "reverse", subject: sub(l), decision: { payment_id: posted, reason: "misapplied" }, rationale: "2.1's allocation plan says misapplied" }, { loanId: l.loanId });
  const o = r.output as Json; assert.equal(o["status"], "proposed"); const proposalId = o["action_id"] as string;
  assert.equal(await count(`work_actions WHERE subject_id = $1`, [l.loanId]), before + 1, "nothing is written beyond the proposal row");
  assert.equal(await count(`work_actions WHERE approval_of = $1`, [proposalId]), 0); assert.equal(await count(`work_approvals WHERE work_action_id = $1`, [proposalId]), 0);
  // the agent may not execute it: the command is refused
  await assert.rejects(tool("35.8", "work.action.decide", CASE, { action_id: proposalId, decision: "approved" }, { loanId: l.loanId }), (e: Error & { code?: string }) => e.code === "HUMAN_ONLY_ACT");
  await assert.rejects(tool("35.8", "work.screen.act", CASE, { code: "payment_reverse", action: "reverse", subject: sub(l), decision: { payment_id: posted, reason: "misapplied" } }, { loanId: l.loanId }), (e: Error & { code?: string }) => e.code === "HUMAN_ONLY_ACT");
  // a decision payload naming a *_cents field the person is not the source of is refused
  await assert.rejects(tool("35.8", "work.action.propose", CASE, { code: "payment_reverse", action: "reverse", subject: sub(l), decision: { payment_id: posted, reason: "misapplied", amount_cents: "1" } }, { loanId: l.loanId }), (e: Error & { code?: string; extra?: Json }) => e.code === "NO_CLIENT_STATE" && e.extra?.["field"] === "amount_cents");
  assert.equal(await count(`work_actions WHERE approval_of = $1`, [proposalId]), 0);
  // the invariant over the whole record: no executed row from a proposal without a work_approvals{decision: approved} row by a human officer
  const executedFromProposals = await db.query<{ id: string; approval_of: string; approver: string | null; decision: string | null; role: string | null }>(`SELECT a.id::text AS id, a.approval_of::text AS approval_of, ap.approver_staff_user_id::text AS approver, ap.decision, ap.role FROM work_actions a LEFT JOIN work_approvals ap ON ap.work_action_id = a.approval_of WHERE a.status = 'executed' AND a.approval_of IS NOT NULL`);
  assert.ok(executedFromProposals.length >= 1);
  for (const x of executedFromProposals) { assert.equal(x.decision, "approved"); assert.equal(x.role, "officer"); assert.ok(x.approver, "a human officer"); }
  assert.equal(await count(`work_actions a WHERE a.status = 'executed' AND a.approval_of IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_approvals ap WHERE ap.work_action_id = a.approval_of AND ap.decision = 'approved' AND ap.approver_staff_user_id IS NOT NULL)`), 0);
  const proposals = await db.query<{ id: string; status: string; actor_id: string }>(`SELECT id::text AS id, status, actor_id FROM work_actions WHERE actor_id = 'agent:case'`);
  assert.ok(proposals.length >= 2); assert.ok(proposals.every((p) => p.status !== "executed"), "the case agent's rows are never executed");
});
