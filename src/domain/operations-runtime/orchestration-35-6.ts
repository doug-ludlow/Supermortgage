/**
 * §35.6 Closing, funding and delivery orchestration — the state machine from clear-to-close through the CD,
 * consummation, funding, the hand-off from the record, delivery, purchase-advice reconciliation and the warehouse paydown
 * (spec/sections/35-operations-runtime/35-6-closing-funding-and-delivery-orchestration.md).
 *
 * One `closing_orchestrations` row per application, driven by the record and idempotent per sweep (rule 1). The state
 * machine is a FOLD over the application's log: every step (steps-35-6.ts) names the owning event that completes it
 * (`exit`), the guard the next step needs before it can be entered (`enter`), and the owning tools the pass runs while the
 * row sits on it (`actions`). Per pass, per claimed row (`FOR UPDATE SKIP LOCKED`, a five-minute wall-time lease):
 *   1. the record is folded (events newer than `last_event_sequence` and the typed rows the step needs);
 *   2. while the current step's exit holds, the step is journaled `completed` and the next one `entered` (bookkeeping —
 *      `orchestration.step.completed` satisfies SM_ORCH_STEP_STALLED_2BD; `orchestration.step.entered{clocked=true}` arms it);
 *   3. the current step's actions run — every owning command through `Runtime.execute` as the owning agent, in the owner's own
 *      unit of work, with inputs derived from the record by facts-35-6.ts (rule 2) — and the fold repeats, bounded, so a step
 *      whose completing event the actions produced is completed in the same sweep (T2, T9, T10; "same sweep" in the state machine);
 *   4. the row update, the journal entries, this process's own events and its decision record commit in ONE
 *      application-scoped unit of work — or nothing, when nothing moved (T1's second pass, T12's third).
 * The pass never appends an owning section's event (OWNER_EMITS — a contract test greps this directory), never releases a
 * wire or performs any other reserved act (HUMAN_ACTS_STAY_HUMAN), never recomputes a gate (NO_GATE_RECOMPUTE) and never
 * satisfies, extends or cancels a timer (NO_CLOCK_EDIT — the timers are satisfied by the owners' events and by the
 * `orchestration.*` receipts the kernel engine consumes like any other).
 */
import { randomUUID, createHash } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import type { ApplicationRecord } from "../../infra/db/applications.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import { EntityStore, type EntityRecord } from "../../app/tools.ts";
import { CommandRefused } from "../../app/commands.ts";
import { EscalationService } from "../../app/escalations.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { daysBetween, plainDate as D } from "../../kernel/calendar/date.ts";
import { STEPS, stepIndex, type StepDef, type StepOutcome, type Wait } from "./steps-35-6.ts";
import { executionReviewUnrecoverable } from "./facts-35-6-b.ts";
import { loadRecord, RecordGap, type OrchRecord } from "./facts-35-6.ts";
import { fakesFor } from "./fakes-35-6.ts";
import { storeDocument } from "./documents-port-35-6.ts";

export const ORCH_PROCESS = "35.6";
export const ORCH_AGENT = "disclosures";
export const ORCH_RULE_SET_VERSION = "orchestration.v1";
export const ORCH_PROMPT_VERSION = "35.6-v1";
export const ORCH_ACTOR: Actor = { kind: "agent", id: ORCH_AGENT };
/** Rule 1: the claim lease is wall time, five minutes; a pass pages 50 rows per claim. */
export const LEASE_MS = 5 * 60_000;
export const CLAIM_LIMIT = 50;
/** Rule 10: a step that fails three times is held `failed` with one ops_analyst escalation. */
export const MAX_STEP_ATTEMPTS = 3;
/** The fold is bounded: a pass advances a row through at most this many steps (a runaway step definition never spins). */
export const MAX_TRANSITIONS_PER_PASS = 8;

/** This process's own events — the only literals it appends (rule 3; the timers' triggers and satisfiers). */
export const EV = {
  opened: "orchestration.opened",
  entered: "orchestration.step.entered",
  completed: "orchestration.step.completed",
  skipped: "orchestration.step.skipped",
  held: "orchestration.held",
  released: "orchestration.released",
  snapshotBuilt: "funding_snapshot.built",
  reconciled: "orchestration.purchase.reconciled",
  exception: "orchestration.purchase.exception",
  done: "orchestration.completed",
  unwound: "orchestration.unwound",
  cancelled: "orchestration.cancelled",
  daily: "orchestration.daily.run_completed",
} as const;

export type OrchStatus = "open" | "waiting_human" | "waiting_vendor" | "waiting_borrower" | "waiting_window" | "held" | "unwinding" | "completed" | "unwound" | "cancelled";
export const TERMINAL: readonly OrchStatus[] = ["completed", "unwound", "cancelled"];

export interface OrchRow {
  readonly id: string; readonly application_id: string; readonly loan_id: string | null;
  readonly transaction_type: string | null; readonly funding_type: string | null; readonly note_form: string | null; readonly closing_type: string | null; readonly rescindable: boolean | null;
  readonly step: string; readonly status: OrchStatus; readonly waiting_on: string | null; readonly hold_reason: string | null;
  readonly scheduled_consummation_at: string | null; readonly consummation_at: string | null; readonly rescission_expires_at: string | null; readonly earliest_funding_date: string | null;
  readonly funded_at: string | null; readonly staged_at: string | null; readonly boarded_at: string | null; readonly package_frozen_at: string | null; readonly delivered_at: string | null; readonly certified_at: string | null; readonly purchased_at: string | null; readonly reconciled_at: string | null; readonly completed_at: string | null;
  readonly funding_id: string | null; readonly warehouse_advance_id: string | null; readonly delivery_id: string | null; readonly purchase_advice_id: string | null;
  readonly funding_snapshot_id: string | null; readonly purchase_reconciliation_id: string | null;
  readonly last_event_sequence: number; readonly step_attempts: number; readonly lease_holder: string | null; readonly lease_until: string | null; readonly last_pass_as_of: string | null;
  readonly opened_at: string; readonly updated_at: string;
}
type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const ts = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
function rowOf(r: Row): OrchRow {
  return { id: String(r["id"]), application_id: String(r["application_id"]), loan_id: s(r["loan_id"]), transaction_type: s(r["transaction_type"]), funding_type: s(r["funding_type"]), note_form: s(r["note_form"]), closing_type: s(r["closing_type"]), rescindable: r["rescindable"] === null || r["rescindable"] === undefined ? null : r["rescindable"] === true,
    step: String(r["step"]), status: String(r["status"]) as OrchStatus, waiting_on: s(r["waiting_on"]), hold_reason: s(r["hold_reason"]),
    scheduled_consummation_at: ts(r["scheduled_consummation_at"]), consummation_at: ts(r["consummation_at"]), rescission_expires_at: ts(r["rescission_expires_at"]), earliest_funding_date: s(r["earliest_funding_date"]),
    funded_at: ts(r["funded_at"]), staged_at: ts(r["staged_at"]), boarded_at: ts(r["boarded_at"]), package_frozen_at: ts(r["package_frozen_at"]), delivered_at: ts(r["delivered_at"]), certified_at: ts(r["certified_at"]), purchased_at: ts(r["purchased_at"]), reconciled_at: ts(r["reconciled_at"]), completed_at: ts(r["completed_at"]),
    funding_id: s(r["funding_id"]), warehouse_advance_id: s(r["warehouse_advance_id"]), delivery_id: s(r["delivery_id"]), purchase_advice_id: s(r["purchase_advice_id"]), funding_snapshot_id: s(r["funding_snapshot_id"]), purchase_reconciliation_id: s(r["purchase_reconciliation_id"]),
    last_event_sequence: Number(r["last_event_sequence"] ?? 0), step_attempts: Number(r["step_attempts"] ?? 0), lease_holder: s(r["lease_holder"]), lease_until: ts(r["lease_until"]), last_pass_as_of: ts(r["last_pass_as_of"]), opened_at: ts(r["opened_at"])!, updated_at: ts(r["updated_at"])! };
}
const ORCH_COLS = "id, application_id, loan_id, transaction_type, funding_type, note_form, closing_type, rescindable, step, status, waiting_on, hold_reason, scheduled_consummation_at, consummation_at, rescission_expires_at, earliest_funding_date::text AS earliest_funding_date, funded_at, staged_at, boarded_at, package_frozen_at, delivered_at, certified_at, purchased_at, reconciled_at, completed_at, funding_id, warehouse_advance_id, delivery_id, purchase_advice_id, funding_snapshot_id, purchase_reconciliation_id, last_event_sequence, step_attempts, lease_holder, lease_until, last_pass_as_of, opened_at, updated_at";

/** Rule 6: the pass owns 30.2's hand-off once its row has reached `funded` (or beyond); an application whose row is still upstream (or has none) funds through the demo/legacy path the fixtures use. */
export function orchestrationOwnsHandoff(row: OrchRow): boolean { return stepIndex(row.step) >= stepIndex("funded") || row.status === "completed" || environmentOf35_6() === "production"; }
const environmentOf35_6 = (): string => process.env["ENVIRONMENT"] ?? "nonprod";
export async function orchestrationByApplication(q: Queryable, applicationId: string): Promise<OrchRow | null> {
  const rows = await q.query<Row>(`SELECT ${ORCH_COLS} FROM closing_orchestrations WHERE application_id = $1`, [applicationId]);
  return rows[0] ? rowOf(rows[0]) : null;
}

// ───────────────────────────── the journal ─────────────────────────────
export type JournalKind = "entered" | "command_run" | "command_refused" | "command_failed" | "waiting" | "completed" | "skipped" | "held" | "released" | "unwound" | "cancelled";
export interface JournalEntry {
  readonly step: string; readonly kind: JournalKind; readonly clocked?: boolean; readonly waiting_on?: string | null; readonly trigger_event_id?: string | null;
  readonly command?: { process: string; name: string; op?: string | null } | null; readonly actor?: Actor | null; readonly decision_id?: string | null;
  readonly refusal_code?: string | null; readonly error_class?: string | null; readonly detail?: Record<string, unknown>;
}
/** A journal `detail` carries ids, dates and cents-strings only (never a name, TIN or account): bigints become strings; nested objects are kept to their scalar leaves. */
export function journalDetail(v: unknown): Record<string, unknown> {
  const scrub = (x: unknown): unknown => typeof x === "bigint" ? x.toString() : Array.isArray(x) ? x.map(scrub) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, scrub(y)])) : x;
  return (scrub(v ?? {}) as Record<string, unknown>);
}

/** The command-run helper a step's actions use: idempotent by the caller's `done` predicate, journaled, with the owner's agent as the actor (rule 3). */
export interface CommandRun {
  readonly process: string; readonly name: string; readonly input: Record<string, unknown>; readonly actor: Actor;
  /** Already on the record → the command is not run again (PASS_IS_IDEMPOTENT); the journal gets nothing. */
  readonly done?: boolean;
  /** `detail` for the journal (sources, ids, cents strings). */
  readonly detail?: Record<string, unknown>;
  /** A read tool needs no scope lock on the loan; a command after `loan.staged` is scoped to both ids. */
  readonly scope?: { loanId?: string | null };
}
export class StepHalt extends Error {
  readonly outcome: StepOutcome;
  constructor(outcome: StepOutcome) { super(`step halted: ${JSON.stringify(outcome)}`); this.name = "StepHalt"; this.outcome = outcome; }
}

export interface StepContext {
  readonly rt: Runtime; readonly rec: OrchRecord; readonly row: OrchRow; readonly now: string; readonly runId: string | null;
  readonly journal: JournalEntry[];
  /** The fakes this process owns (the RON session feed, the settlement agent, the portal operator, the eVault, the carrier). */
  readonly fakes: ReturnType<typeof fakesFor>;
  /** Run one owning command through the bus (its own unit of work, the owner's agent); returns the output. Refusals and failures halt the step and are journaled. */
  run<T = Record<string, unknown>>(c: CommandRun): Promise<T>;
  /** Re-read the record after the owning commands wrote (the fold sees their events and rows). */
  refresh(): Promise<OrchRecord>;
  /** Halt the step: wait on a person, a vendor, the borrower or a statutory window; or hold. */
  halt(outcome: StepOutcome): never;
}

// ───────────────────────────── the pass ─────────────────────────────
export interface PassOptions { readonly runId?: string | null; readonly limit?: number; readonly applicationId?: string; readonly holder?: string; readonly budgetMs?: number; }
export interface PassRowReport { readonly application_id: string; readonly orchestration_id: string; readonly from: string; readonly to: string; readonly status: OrchStatus; readonly waiting_on: string | null; readonly commands: number; readonly journal: number; readonly wrote: boolean; readonly error?: string }
export interface PassReport { readonly at: string; readonly discovered: number; readonly claimed: number; readonly rows: readonly PassRowReport[]; readonly wrote: number; readonly line: string }

/** Rule 1 / rule 10: `orchestration.pass{as_of}` — discovery, the claim loop and one bounded step advance per claimed row, each row in its own unit of work. Never throws for a row's failure (journaled `command_failed`); throws only when the claim itself cannot run. */
export async function runOrchestrationPass(rt: Runtime, nowIso: string, opts: PassOptions = {}): Promise<PassReport> {
  const holder = opts.holder ?? rt.instanceId;
  const runId = opts.runId ?? rt.sweepRunId ?? null;
  const discovered = opts.applicationId ? (await discoverApplication(rt, opts.applicationId, nowIso)) : await discover(rt, nowIso, opts.limit ?? CLAIM_LIMIT);
  const rows: PassRowReport[] = [];
  const started = Date.now();
  // rule 10: pages of 50 per claim until the budget (60 s of the sweep's) has elapsed. A row's lease is held until the pass
  // ends (T12: a row is claimed by exactly one pass, once — a page released row by row would be claimed again by this pass's next page).
  const leased: string[] = [];
  try {
    for (let page = 0; page < 20; page++) {
      const claimed = await claim(rt, holder, opts.limit ?? CLAIM_LIMIT, opts.applicationId ?? null, nowIso);
      if (!claimed.length) break;
      leased.push(...claimed.map((r) => r.id));
      for (const row of claimed) {
        if (Date.now() - started > (opts.budgetMs ?? PASS_BUDGET_MS)) continue;
        try { rows.push(await processRow(rt, row, nowIso, runId)); }
        catch (e) { rows.push({ application_id: row.application_id, orchestration_id: row.id, from: row.step, to: row.step, status: row.status, waiting_on: row.waiting_on, commands: 0, journal: 0, wrote: false, error: e instanceof Error ? e.message : String(e) }); rt.logger?.error("35.6 orchestration row failed outside a step", { application_id: row.application_id, error: e instanceof Error ? e.message : String(e) }); }
      }
      if (opts.applicationId || claimed.length < (opts.limit ?? CLAIM_LIMIT) || Date.now() - started > (opts.budgetMs ?? PASS_BUDGET_MS)) break;
    }
  } finally { await releaseLeases(rt, holder, leased); }
  const wrote = rows.filter((r) => r.wrote).length;
  return { at: nowIso, discovered, claimed: rows.length, rows, wrote, line: `orchestration ${nowIso}: discovered=${discovered} claimed=${rows.length} wrote=${wrote}${rows.filter((r) => r.error).length ? ` errors=${rows.filter((r) => r.error).length}` : ""}` };
}
/** Rule 10: the pass pages rows until 60 s of the sweep's budget have elapsed. */
export const PASS_BUDGET_MS = 60_000;

/** Discovery: an application whose log carries `application.trid_received` and the first step's prerequisites (the LE received, the borrowers' standing blanket authorization), no `loans` row yet and no orchestration row — one row at `credit_ordered` (T1); an application whose credit the hosted flows already ordered is discovered too (the fold skips what the log already carries). The proper `orchestration.opened` is journaled at `clear_to_close` (state machine). */
async function discover(rt: Runtime, nowIso: string, limit: number): Promise<number> {
  const rows = await rt.db.query<{ application_id: string }>(
    `SELECT DISTINCT e.application_id::text AS application_id FROM loan_events e JOIN applications a ON a.id = e.application_id LEFT JOIN closing_orchestrations o ON o.application_id = a.id
      WHERE e.type = 'application.trid_received' AND o.id IS NULL AND a.loan_id IS NULL
        AND EXISTS (SELECT 1 FROM loan_events le WHERE le.application_id = a.id AND le.type = 'disclosure.le.received')
        AND EXISTS (SELECT 1 FROM consents c WHERE c.application_id = a.id AND c.kind = 'blanket_verification_authorization' AND c.standing AND (c.status IS NULL OR c.status = 'active'))
      ORDER BY 1 LIMIT $1`, [limit]);
  let n = 0;
  for (const r of rows) n += await discoverApplication(rt, r.application_id, nowIso);
  return n;
}
/** `orchestration.open{application_id}` and the sweep's discovery: one row at the first step (ALREADY_OPEN when a row exists); the fold advances it through every step the log has already completed on the first pass. */
export async function discoverApplication(rt: Runtime, applicationId: string, nowIso: string): Promise<number> {
  const existing = await orchestrationByApplication(rt.db, applicationId);
  if (existing) return 0;
  const app = await rt.applications.get(applicationId);
  if (!app) throw new RangeError(`no application ${applicationId}`);
  const rec = await loadRecord(rt, app);
  if (!rec.has("application.trid_received")) throw new RangeError(`application ${applicationId} has no application.trid_received on its log (21.1's six items open the credit order)`);
  const first = STEPS[0]!;
  const id = randomUUID();
  const clocked = first.clocked?.(rec) ?? true;
  try {
    await rt.uow.run({ applicationId }, async (ctx) => {
      ctx.events.append({ type: EV.entered, applicationId, aggregate: { kind: "closing_orchestration", id }, actor: ORCH_ACTOR, payload: { orchestration_id: id, application_id: applicationId, step: first.name, clocked, waiting_on: null, entered_at: ctx.clock.now() } });
      ctx.decide(decisionOf({ orchestration_id: id, application_id: applicationId, loan_id: null, step: first.name, action: "entered", command: null, trigger_event_id: null, sources_sha256: rec.sourcesHash(), rationale: `application discovered from application.trid_received; entered ${first.name}` }));
      return id;
    }, { clock: rt.clock, before: async (q) => {
    // a concurrent `orchestration.open` or pass may have inserted the row since the check above: the unique application_id decides, and the loser's event and decision roll back with its unit of work
    const ins = await q.query<{ id: string }>(`INSERT INTO closing_orchestrations (id, application_id, transaction_type, step, status, last_event_sequence, opened_at, updated_at) VALUES ($1, $2, $3, $4, 'open', 0, $5, $5) ON CONFLICT (application_id) DO NOTHING RETURNING id`, [id, applicationId, app.transaction_type ?? null, first.name, nowIso]);
    if (!ins.length) throw new AlreadyOpen(applicationId);
    await q.query(`INSERT INTO closing_orchestration_steps (orchestration_id, application_id, step, kind, clocked, actor_kind, actor_id, trigger_event_id, detail, sweep_run_id, created_at) VALUES ($1, $2, $3, 'entered', $4, 'agent', $5, $6, $7::jsonb, $8, clock_timestamp())`,
      [id, applicationId, first.name, clocked, ORCH_AGENT, rec.last("application.trid_received")?.id ?? null, JSON.stringify({ discovered_at: nowIso }), rt.sweepRunId]);
    } });
  } catch (e) { if (e instanceof AlreadyOpen) return 0; throw e; }
  return 1;
}
class AlreadyOpen extends Error { constructor(applicationId: string) { super(`orchestration already open for ${applicationId}`); this.name = "AlreadyOpen"; } }

/** The claim (rule 1, 35.3 rule 6's executor pattern): open rows whose lease is free and that no pass has claimed at this sweep instant (`last_pass_as_of < as_of` — T12: a row is claimed by exactly one pass per sweep), `FOR UPDATE SKIP LOCKED`, leased to this holder for five minutes of WALL time (`now()` in SQL, never the demo clock) in one short transaction that commits before the rows are processed. */
async function claim(rt: Runtime, holder: string, limit: number, applicationId: string | null, asOf: string): Promise<OrchRow[]> {
  return rt.db.tx(async (q) => {
    const rows = await q.query<Row>(
      `SELECT ${ORCH_COLS} FROM closing_orchestrations WHERE status NOT IN ('completed', 'unwound', 'cancelled') AND (lease_until IS NULL OR lease_until < now()) AND (last_pass_as_of IS NULL OR last_pass_as_of < $2::timestamptz) ${applicationId ? "AND application_id = $3" : ""} ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT $1`,
      applicationId ? [limit, asOf, applicationId] : [limit, asOf]);
    if (!rows.length) return [];
    await q.query(`UPDATE closing_orchestrations SET lease_holder = $2, lease_until = now() + ($3::int * interval '1 millisecond'), last_pass_as_of = $4::timestamptz WHERE id = ANY($1::uuid[])`, [rows.map((r) => String(r["id"])), holder, LEASE_MS, asOf]);
    return rows.map(rowOf);
  });
}
async function releaseLeases(rt: Runtime, holder: string, ids: readonly string[]): Promise<void> { if (ids.length) await rt.db.query(`UPDATE closing_orchestrations SET lease_holder = NULL, lease_until = NULL WHERE id = ANY($1::uuid[]) AND lease_holder = $2`, [ids, holder]).catch(() => undefined); }

/** Holds a new owner's fact may clear — the Off-path paragraph: "`held` —(`orchestration.release`, `ops_analyst`; or the condition clears)→ the same step" for a money mismatch, a closed gate and a vendor `unavailable`; the figures are never adjusted (rule 7): a corrected statement is the settlement agent's new fact and the step compares again. `failed` and `warehouse_kickout` are a person's release only. */
const AUTO_RELEASE_HOLDS = ["gate_closed", "money_mismatch", "unavailable"];
interface Pending { step: string; status: OrchStatus; waiting_on: string | null; hold_reason: string | null; attempts: number; patch: Record<string, unknown>; events: { type: string; payload: Record<string, unknown> }[]; journal: JournalEntry[]; commands: number; escalations: { kind: string; ownerRole: string; severity: string; payload: Record<string, unknown> }[]; actions: string[]; entered: Set<string> }

/** A row is due when the record carries a fact newer than `last_event_sequence`, or when its wait is one that time or a poll resolves (an open row, a vendor, a statutory window, a person a FAKE fills); a borrower's wait and a hold are not due (rule 1: "a pass with no new fact and no due wait writes nothing"). */
export function rowDue(rt: Runtime, row: OrchRow, newest: number): boolean {
  if (newest > row.last_event_sequence) return true;
  if (row.status === "open" || row.status === "waiting_vendor" || row.status === "waiting_window" || row.status === "unwinding") return true;
  // a person's wait is due only when THIS process's FAKE fills the role (the settlement agent, the portal operator, the notary); the FAKE reviewers (35.7 / reviewers.ts) act through their own events, which the pass folds
  if (row.status === "waiting_human") return fakesFor(rt).fills(row.waiting_on ?? "");
  return false;
}

/** One row, one pass, ONE unit of work: fold → transitions → actions (every owning command a savepoint on the row's transaction through the command view) → persist the row, the journal, the events and the decision — or nothing. Exported for `orchestration.step{op: retry}` and the tests. */
export async function processRow(rt: Runtime, row: OrchRow, nowIso: string, runId: string | null): Promise<PassRowReport> {
  const app = await rt.applications.get(row.application_id);
  if (!app) throw new RangeError(`no application ${row.application_id}`);
  const p: Pending = { step: row.step, status: row.status, waiting_on: row.waiting_on, hold_reason: row.hold_reason, attempts: row.step_attempts, patch: {}, events: [], journal: [], commands: 0, escalations: [], actions: [], entered: new Set() };
  if (TERMINAL.includes(row.status)) return report(row, p, false);
  // the cheap pre-check outside the transaction: a row with nothing new and no due wait is not even locked
  const newestOutside = Number((await rt.db.query<{ s: string }>(`SELECT coalesce(max(sequence), 0)::text AS s FROM loan_events WHERE application_id = $1 OR ($2::uuid IS NOT NULL AND loan_id = $2)`, [row.application_id, row.loan_id ?? app.loan_id ?? null]))[0]!.s);
  if (!rowDue(rt, row, newestOutside)) return report(row, p, false);
  const nested: DomainEvent[] = [];
  let loanIdAtStart = row.loan_id ?? app.loan_id ?? null;
  let wrote = false;
  let escalations: EscalationService | undefined;
  let recOut: OrchRecord | null = null;
  let stale = false;
  await rt.uow.run({ applicationId: row.application_id, ...(loanIdAtStart ? { loanId: loanIdAtStart } : {}) }, async (ctx) => {
    const view = rt.commandView(ctx.q!, nested);
    // the row as it is NOW, locked for this transaction: the claimed snapshot is stale when a person held, released or unwound the row in between (their write wins; this pass skips)
    const fresh = (await ctx.q!.query<Row>(`SELECT ${ORCH_COLS} FROM closing_orchestrations WHERE id = $1 FOR UPDATE`, [row.id])).map(rowOf)[0];
    if (!fresh || fresh.status !== row.status || fresh.step !== row.step || fresh.hold_reason !== row.hold_reason || fresh.updated_at !== row.updated_at) { stale = true; recOut = await loadRecord(view, app, loanIdAtStart); return; }
    let rec = await loadRecord(view, app, loanIdAtStart);
    // a substantive new fact: an owner's event, never this process's own bookkeeping or the platform's reactions to it
    const substantive = rec.after(row.last_event_sequence).some((e) => !NOT_A_FACT.some((prefix) => e.type.startsWith(prefix)));
    p.entered = new Set((await ctx.q!.query<{ step: string }>(`SELECT step FROM closing_orchestration_steps WHERE orchestration_id = $1 AND kind = 'entered'`, [row.id])).map((r) => r.step));
    if (row.status === "held") {
      if (!(substantive && row.hold_reason && AUTO_RELEASE_HOLDS.includes(row.hold_reason))) { recOut = rec; return; }
      p.status = "open"; p.hold_reason = null; p.waiting_on = null; p.journal.push({ step: row.step, kind: "released", detail: { by: "pass", reason: "new facts after " + row.hold_reason } }); p.events.push({ type: EV.released, payload: { step: row.step, by: "pass", hold_reason: row.hold_reason } });
    }
    const fakes = fakesFor(rt);
    const runCommand = async <T,>(c: CommandRun): Promise<T> => {
      if (c.done) return undefined as T;
      const loanId = c.scope?.loanId === undefined ? (rec.loanId ?? "") : (c.scope.loanId ?? "");
      try {
        const r = await view.execute({ process: c.process, name: c.name, loanId, applicationId: row.application_id, actor: c.actor, input: c.input, run: { runId: runId ? `sweep:${runId}` : `pass:${randomUUID()}`, modelVersion: "deterministic", promptVersion: ORCH_PROMPT_VERSION, confidence: 1 } });
        p.commands += 1;
        p.journal.push({ step: p.step, kind: "command_run", command: { process: c.process, name: c.name, op: typeof c.input["op"] === "string" ? c.input["op"] : null }, actor: c.actor, decision_id: r.decisions[0]?.id ?? null, trigger_event_id: r.event?.id ?? null, detail: journalDetail({ ...(c.detail ?? {}), events: r.events.map((e) => e.type) }) });
        return r.output as T;
      } catch (e) {
        // an owner's refusal (the bus's CommandRefused, or the owner's own gate/refusal class carrying a code — 22.2 CreditGateClosed, 25.1 ComplianceGateBlocked, 25.2 CdRefused, 26.3 FundingRefused …) holds the row on that gate; anything else is a failure the step retries
        const code = refusalCode(e);
        if (code) { const validations = (e as { validations?: { code: string; result: string; severity: string; message?: string; resolved?: boolean }[] }).validations; p.journal.push({ step: p.step, kind: "command_refused", command: { process: c.process, name: c.name, op: typeof c.input["op"] === "string" ? c.input["op"] : null }, actor: c.actor, refusal_code: code, detail: journalDetail({ ...(c.detail ?? {}), reason: (e as Error).message.slice(0, 500), ...(Array.isArray(validations) ? { failures: validations.filter((v) => v.result === "fail" && !v.resolved).map((v) => `${v.code}: ${v.message ?? ""}`.slice(0, 300)) } : {}) }) }); throw new StepHalt({ hold: { reason: "gate_closed", gate: code, detail: { command: `${c.process} ${c.name}`, reason: (e as Error).message.slice(0, 500) } } }); }
        throw e;
      }
    };
    const sctx: StepContext = { rt: view, rec, row, now: nowIso, runId, journal: p.journal, fakes, run: runCommand, refresh: async () => { rec = await loadRecord(view, app, rec.loanId ?? (await view.applications.get(app.id))?.loan_id ?? loanIdAtStart); (sctx as { rec: OrchRecord }).rec = rec; return rec; }, halt: (o) => { throw new StepHalt(o); } };
    // rule 10: one step's actions are one savepoint on the row's transaction — a command that throws rolls back every command the step ran before it (nothing else of that unit of work is written); a refusal (StepHalt) keeps what ran and holds; three failures hold the row `failed` — the same block for a step and for the `unwinding` step (rule 11)
    const runActions = async (def: StepDef): Promise<StepOutcome> => {
      let outcome: StepOutcome = {};
      const mark = { journal: p.journal.length, events: p.events.length, nested: nested.length, commands: p.commands, escalations: p.escalations.length };
      const actions = def.actions!;
      try { await view.db.tx(async () => { try { outcome = (await actions(sctx)) ?? {}; } catch (e) {
        if (e instanceof StepHalt) { outcome = e.outcome; return; }
        // a fact the record does not carry yet (facts-35-6.ts RecordGap): the row waits on the owner named by the gap — open, clocked (the stall clock backstops the owner's own) — and journals the gap once
        if (e instanceof RecordGap) { if (row.waiting_on !== e.path || row.status !== "open") p.journal.push({ step: p.step, kind: "waiting", waiting_on: e.path, detail: { gap: e.path, reason: e.message.slice(0, 500) } }); outcome = { wait: { status: "open", waiting_on: e.path, clocked: true } }; return; }
        throw e; } }); }
      catch (e) {
        {
          p.journal.length = mark.journal; p.events.length = mark.events; nested.length = mark.nested; p.commands = mark.commands; p.escalations.length = mark.escalations;
          const cls = e instanceof Error ? e.name || e.constructor.name : typeof e;
          const unavailable = /unavailable|PortUnavailable|ECONN|outage/i.test(cls + " " + (e instanceof Error ? e.message : ""));
          if (process.env["ORCH_DEBUG"]) console.error("35.6 step failed", { application_id: row.application_id, step: p.step }, e);
          p.journal.push({ step: p.step, kind: "command_failed", error_class: cls, detail: { message: (e instanceof Error ? e.message : String(e)).slice(0, 500) } });
          p.attempts += 1;
          if (unavailable) outcome = { hold: { reason: "unavailable", detail: { error_class: cls } } };
          else if (p.attempts >= MAX_STEP_ATTEMPTS) outcome = { hold: { reason: "failed", detail: { error_class: cls, attempts: p.attempts } } };
          else outcome = { wait: { status: "open", waiting_on: null, clocked: true }, retry: true };
          rt.logger?.warn("35.6 step command failed", { application_id: row.application_id, step: p.step, error_class: cls, attempts: p.attempts });
        }
      }
      return outcome;
    };
    // an unwinding row folds the owners' unwind events (26.3's completion closes it `unwound`) and writes like any other pass
    if (row.status === "unwinding") await foldUnwind(sctx, p, runActions);
    else for (let i = 0; i < MAX_TRANSITIONS_PER_PASS; i++) {
      const def = stepDef(p.step);
      const off = offPath(rec, p.step);
      if (off) { applyOffPath(p, off); if (off.kind === "unwinding") await foldUnwind(sctx, p, runActions); break; }
      const exitEv = def.exit(rec);
      if (exitEv) {
        const next = STEPS[stepIndex(def.name) + 1];
        if (!next) { complete(p, def, exitEv, rec, nowIso); break; }
        const wait = next.enter?.(rec, sctx) ?? null;
        if (wait) { setWait(p, wait); break; }
        complete(p, def, exitEv, rec, nowIso);
        if (next.name === "clear_to_close") p.events.push({ type: EV.opened, payload: { orchestration_id: row.id, application_id: row.application_id, transaction_type: rec.transactionType(), funding_type: rec.fundingType(), note_form: rec.noteForm() } });
        enter(p, next, rec, nowIso);
        if (next.terminal) { p.status = "completed"; p.patch["completed_at"] = nowIso; p.events.push({ type: EV.done, payload: { orchestration_id: row.id, loan_id: rec.loanId, purchased_at: rec.last("loan.purchased")?.occurredAt ?? null } }); break; }
        continue;
      }
      if (!def.actions || p.actions.includes(def.name)) { if (!def.actions && p.status === "open") { const w = def.idleWait?.(rec) ?? null; if (w) setWait(p, w); } break; }
      p.actions.push(def.name);
      const outcome = await runActions(def);
      if (outcome.hold) { hold(p, outcome.hold, rec); break; }
      if (outcome.wait) setWait(p, outcome.wait); else { p.status = "open"; p.waiting_on = null; }
      if (outcome.retry) break;
      rec = await sctx.refresh();
      if (!def.exit(rec) && !offPath(rec, p.step)) break;
    }
    if (p.commands > 0 && p.journal.every((j) => j.kind !== "command_failed")) p.attempts = 0;
    recOut = rec;
    const changed = p.journal.length > 0 || p.events.length > 0 || p.step !== row.step || p.status !== row.status || p.waiting_on !== row.waiting_on || p.hold_reason !== row.hold_reason || Object.keys(p.patch).length > 0 || p.attempts !== row.step_attempts;
    if (!changed) return;
    wrote = true;
    const loanId = rec.loanId ?? row.loan_id ?? null;
    escalations = new EscalationService(ctx.events, ctx.clock);
    for (const e of p.events) ctx.events.append({ type: e.type, applicationId: row.application_id, ...(loanId ? { loanId } : {}), aggregate: { kind: "closing_orchestration", id: row.id }, actor: ORCH_ACTOR, payload: { orchestration_id: row.id, application_id: row.application_id, ...(loanId ? { loan_id: loanId } : {}), ...e.payload } });
    // one open escalation per (step, reason, gate): a hold re-applied on the same gate re-uses the person's open item
    for (const esc of p.escalations) {
      const dup = await ctx.q!.query(`SELECT 1 FROM escalations WHERE application_id = $1 AND completed_at IS NULL AND owner_role = $2 AND payload->>'orchestration_step' = $3 AND payload->>'reason' = $4 AND payload->>'gate' IS NOT DISTINCT FROM $5`, [row.application_id, esc.ownerRole, String(esc.payload["orchestration_step"] ?? ""), String(esc.payload["reason"] ?? ""), esc.payload["gate"] === null || esc.payload["gate"] === undefined ? null : String(esc.payload["gate"])]);
      if (dup.length) continue;
      escalations.open({ kind: esc.kind as "officer", ownerRole: esc.ownerRole, applicationId: row.application_id, ...(loanId ? { loanId } : {}), severity: esc.severity, payload: esc.payload }, ORCH_ACTOR);
    }
    const last = p.journal.at(-1);
    // the decision record names every owning command this pass ran and the sources each command's facts were read from (rule 7: the item's source event id or row in the decision record)
    const ran = p.journal.filter((j) => j.kind === "command_run").map((j) => `${j.command!.process} ${j.command!.name}${j.command!.op ? `{${j.command!.op}}` : ""}`);
    const sourced = p.journal.filter((j) => j.kind === "command_run" && j.detail?.["sources"]).map((j) => ({ command: `${j.command!.process} ${j.command!.name}`, sources: j.detail!["sources"] }));
    ctx.decide(decisionOf({ orchestration_id: row.id, application_id: row.application_id, loan_id: loanId, step: p.step, action: actionOf(p), command: last?.command ?? null, trigger_event_id: last?.trigger_event_id ?? null, sources_sha256: rec.sourcesHash(), rationale: `${row.step} → ${p.step} (${p.status}${p.waiting_on ? ` on ${p.waiting_on}` : ""}); ${p.commands} owning command(s) run${ran.length ? `: ${ran.join(", ")}` : ""}; ${p.journal.map((j) => j.kind).join(",")}${sourced.length ? `; sources ${JSON.stringify(sourced)}` : ""}` }));
  }, { clock: rt.clock, commit: async (q, info) => {
    const rec = recOut!;
    const seq = Math.max(rec.lastSequence(), ...info.events.map((e) => e.sequence), ...nested.map((e) => e.sequence));
    if (!wrote) { if (seq !== row.last_event_sequence) await q.query(`UPDATE closing_orchestrations SET last_event_sequence = $2 WHERE id = $1`, [row.id, seq]); return; }
    const loanId = rec.loanId ?? row.loan_id ?? null;
    const decisionId = (await q.query<{ id: string }>(`SELECT id FROM agent_decisions WHERE application_id = $1 AND agent = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [row.application_id, ORCH_AGENT]))[0]?.id ?? null;
    for (const j of p.journal) {
      await q.query(`INSERT INTO closing_orchestration_steps (orchestration_id, application_id, loan_id, step, kind, clocked, waiting_on, trigger_event_id, command_process, command_name, command_op, actor_kind, actor_id, actor_role, decision_id, refusal_code, error_class, detail, sweep_run_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, clock_timestamp())`,
        [row.id, row.application_id, loanId, j.step, j.kind, j.clocked ?? false, j.waiting_on ?? null, j.trigger_event_id ?? null, j.command?.process ?? null, j.command?.name ?? null, j.command?.op ?? null, j.actor?.kind ?? "agent", j.actor?.id ?? ORCH_AGENT, j.actor?.role ?? null, j.decision_id ?? (j.kind === "command_run" ? null : decisionId), j.refusal_code ?? null, j.error_class ?? null, JSON.stringify(j.detail ?? {}), runId]);
    }
    for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
    const sets: string[] = ["step = $2", "status = $3", "waiting_on = $4", "hold_reason = $5", "last_event_sequence = $6", "step_attempts = $7", "updated_at = date_trunc('milliseconds', clock_timestamp())"];
    const params: unknown[] = [row.id, p.step, p.status, p.waiting_on, p.hold_reason, seq, p.attempts];
    const patch = { ...p.patch, ...(loanId && !row.loan_id ? { loan_id: loanId } : {}), ...(rec.transactionType() && !row.transaction_type ? { transaction_type: rec.transactionType() } : {}), ...(rec.fundingType() && !row.funding_type ? { funding_type: rec.fundingType() } : {}), ...(rec.noteForm() && !row.note_form ? { note_form: rec.noteForm() } : {}), ...(rec.closingType() && !row.closing_type ? { closing_type: rec.closingType() } : {}) };
    for (const [k, v] of Object.entries(patch)) { if (!/^[a-z_]+$/.test(k)) continue; params.push(v); sets.push(`${k} = $${params.length}`); }
    await q.query(`UPDATE closing_orchestrations SET ${sets.join(", ")} WHERE id = $1`, params);
  } });
  if (nested.length) rt.uow.notifyCommitted(nested);
  if (stale) rt.logger?.info("35.6 row changed under the claim; skipped", { application_id: row.application_id, step: row.step });
  return report(row, p, wrote);
}
/** Event types that are never "a new fact" for a held row: this process's own bookkeeping, the platform's reactions to it and the sweep's clocks. */
const NOT_A_FACT: readonly string[] = ["orchestration.", "escalation.", "timer.", "command.", "card.", "conversation.", "thread.", "session.", "message."];

/** The gate or refusal code an owner's error carries: the bus's CommandRefused, or a domain class named *Refused / *Closed / *Blocked with a `code` (the gate code the row holds on). */
export function refusalCode(e: unknown): string | null {
  if (e instanceof CommandRefused) return e.code;
  if (!(e instanceof Error)) return null;
  const code = (e as { code?: unknown }).code; const gate = (e as { gate?: unknown }).gate;
  if (!/Refused|Closed|Blocked$/.test(e.name)) return null;
  return typeof gate === "string" && gate ? gate : typeof code === "string" && code ? code : null;
}
function stepDef(name: string): StepDef { const d = STEPS.find((x) => x.name === name); if (!d) throw new RangeError(`35.6: unknown step ${name}`); return d; }
function complete(p: Pending, def: StepDef, ev: DomainEvent, rec: OrchRecord, now: string): void {
  p.journal.push({ step: def.name, kind: "completed", trigger_event_id: ev.id, detail: { trigger: ev.type, sequence: ev.sequence } });
  p.events.push({ type: EV.completed, payload: { step: def.name, completed_at: now, trigger_event_id: ev.id, trigger_event: ev.type } });
  Object.assign(p.patch, def.onComplete?.(rec, ev) ?? {});
}
/** Rule 1: a step is entered exactly once per orchestration (the unique index); re-entry after a hold or a reschedule is `released`, not a second `entered`. */
function enter(p: Pending, def: StepDef, rec: OrchRecord, now: string): void {
  const wait = def.entryWait?.(rec) ?? null;
  const clocked = wait ? wait.clocked !== false && wait.status !== "waiting_borrower" && wait.status !== "waiting_window" : (def.clocked?.(rec) ?? true);
  p.step = def.name; p.status = wait?.status ?? "open"; p.waiting_on = wait?.waiting_on ?? null; p.hold_reason = null; p.attempts = 0;
  const again = p.entered.has(def.name);
  p.journal.push({ step: def.name, kind: again ? "released" : "entered", clocked, waiting_on: p.waiting_on, ...(again ? { detail: { re_entry: true } } : {}) });
  p.events.push({ type: again ? EV.released : EV.entered, payload: { step: def.name, clocked, waiting_on: p.waiting_on, entered_at: now, ...(again ? { by: "pass", re_entry: true } : {}) } });
  p.entered.add(def.name);
  Object.assign(p.patch, def.onEnter?.(rec) ?? {});
}
function setWait(p: Pending, w: Wait): void { p.status = w.status; p.waiting_on = w.waiting_on ?? null; }
function hold(p: Pending, h: NonNullable<StepOutcome["hold"]>, rec: OrchRecord): void {
  p.status = "held"; p.hold_reason = h.reason; p.waiting_on = h.reason === "money_mismatch" || h.reason === "warehouse_kickout" ? "officer" : h.reason === "failed" || h.reason === "unavailable" ? "ops_analyst" : h.gate ?? null;
  p.journal.push({ step: p.step, kind: "held", waiting_on: p.waiting_on, detail: journalDetail({ reason: h.reason, gate: h.gate ?? null, ...(h.detail ?? {}) }) });
  p.events.push({ type: EV.held, payload: { step: p.step, reason: h.reason, gate: h.gate ?? null, detail: journalDetail(h.detail ?? {}) } });
  const owner = h.reason === "money_mismatch" || h.reason === "warehouse_kickout" ? "officer" : "ops_analyst";
  p.escalations.push({ kind: owner, ownerRole: owner, severity: h.reason === "failed" || h.reason === "money_mismatch" ? "sev2" : "sev3", payload: { orchestration_step: p.step, reason: h.reason, gate: h.gate ?? null, application_id: rec.app.id, ...journalDetail(h.detail ?? {}) } });
}
interface OffPath { kind: "cancelled" | "unwinding"; reason: string; ev: DomainEvent }
function offPath(rec: OrchRecord, step: string): OffPath | null {
  const idx = stepIndex(step);
  if (idx < stepIndex("clear_to_close")) { const c = rec.last("application.withdrawn") ?? rec.last("adverse_decision.handed_off"); if (c) return { kind: "cancelled", reason: c.type, ev: c }; }
  if (idx < stepIndex("funded") && !rec.has("loan.funded")) {
    const u = rec.last("rescission.exercised") ?? rec.last("funding.cancelled") ?? rec.last("closing.execution_review.failed", executionReviewUnrecoverable) ?? rec.last("orchestration.unwind.requested");
    if (u) return { kind: "unwinding", reason: u.type, ev: u };
  }
  return null;
}
function applyOffPath(p: Pending, off: OffPath): void {
  if (off.kind === "cancelled") { p.status = "cancelled"; p.waiting_on = null; p.journal.push({ step: p.step, kind: "cancelled", trigger_event_id: off.ev.id, detail: { reason: off.reason } }); p.events.push({ type: EV.cancelled, payload: { reason: off.reason, step: p.step } }); return; }
  p.status = "unwinding"; p.waiting_on = "26.3"; p.journal.push({ step: p.step, kind: "unwound", trigger_event_id: off.ev.id, detail: { reason: off.reason, stage: "opened" } });
}
/** Rule 11: the unwind is the owners' work in the owners' order — 26.3 openUnwind (and 26.4's MIN reversal) run once through the `unwinding` step's actions; `funding.unwind.completed` closes the row `unwound`. */
async function foldUnwind(sctx: StepContext, p: Pending, runActions: (def: StepDef) => Promise<StepOutcome>): Promise<void> {
  const rec = sctx.rec;
  const done = rec.last("funding.unwind.completed");
  if (done) { p.status = "unwound"; p.waiting_on = null; p.journal.push({ step: p.step, kind: "unwound", trigger_event_id: done.id, detail: { stage: "completed", outcome: (done.payload as Row)["outcome"] ?? null } }); p.events.push({ type: EV.unwound, payload: { reason: (rec.last("rescission.exercised") ?? rec.last("funding.cancelled"))?.type ?? "unwind", step: p.step } }); return; }
  const unwindDef = STEPS.find((x) => x.name === "unwinding");
  if (!unwindDef?.actions) return;
  // the unwinding step's actions run under the same savepoint, attempt count and hold rules as any step (rule 10) — a held unwind is the ops_analyst's; released, the row is `unwinding` again
  const outcome = await runActions(unwindDef);
  if (outcome.hold) { hold(p, outcome.hold, rec); return; }
  // a gap or a retry inside the unwind keeps the row `unwinding` (the board reads the truth; the next pass folds again without re-opening the off-path) — the gap's owner rides on waiting_on
  p.status = "unwinding"; p.waiting_on = outcome.wait?.waiting_on ?? "26.3";
}

function report(row: OrchRow, p: Pending, wrote: boolean): PassRowReport { return { application_id: row.application_id, orchestration_id: row.id, from: row.step, to: p.step, status: p.status, waiting_on: p.waiting_on, commands: p.commands, journal: p.journal.length, wrote }; }
function actionOf(p: Pending): string {
  const kinds = new Set(p.journal.map((j) => j.kind));
  if (kinds.has("held")) return "held"; if (kinds.has("released")) return "released"; if (kinds.has("unwound")) return "unwound"; if (p.status === "completed") return "reconciled";
  if (kinds.has("command_run")) return "ran"; if (kinds.has("entered")) return "entered"; return "waited";
}

// ───────────────────────────── decision record ─────────────────────────────
export const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");
/** The AI agent design's decision record: {orchestration_id, application_id, loan_id?, step, action, command, trigger_event_id, sources_sha256, rule_set_version: orchestration.v1, model_version: deterministic, prompt_version: 35.6-v1, confidence: 1, rationale}. */
export function decisionOf(d: { orchestration_id: string; application_id: string; loan_id: string | null; step: string; action: string; command: { process: string; name: string; op?: string | null } | null; trigger_event_id: string | null; sources_sha256: string; rationale: string }) {
  const record = { ...d, command: d.command ? { process: d.command.process, name: d.command.name, op: d.command.op ?? null } : null, rule_set_version: ORCH_RULE_SET_VERSION, model_version: "deterministic", prompt_version: ORCH_PROMPT_VERSION, confidence: 1 };
  return { agent: ORCH_AGENT, action: `orchestration.${d.action}`, rationale: JSON.stringify(record), ruleSetVersion: ORCH_RULE_SET_VERSION, subject: { kind: "closing_orchestration", id: d.orchestration_id }, ruleCode: "35.6", modelVersion: "deterministic", promptVersion: ORCH_PROMPT_VERSION, confidence: 1 };
}

// ───────────────────────────── human commands (35.8's screens): hold, release, unwind ─────────────────────────────
export async function holdOrchestration(rt: Runtime, applicationId: string, reason: string, by: Actor, nowIso: string): Promise<OrchRow> {
  const row = await orchestrationByApplication(rt.db, applicationId); if (!row) throw new RangeError(`no orchestration for application ${applicationId}`);
  if (TERMINAL.includes(row.status)) throw new RangeError(`orchestration ${row.id} is ${row.status}`);
  if (row.status === "held") return row;
  await writeHuman(rt, row, { status: "held", hold_reason: reason, waiting_on: "ops_analyst" }, { step: row.step, kind: "held", actor: by, waiting_on: "ops_analyst", detail: { reason, by: `${by.kind}:${by.id}` } }, { type: EV.held, payload: { step: row.step, reason, detail: { by: `${by.kind}:${by.id}` } } }, nowIso);
  return (await orchestrationByApplication(rt.db, applicationId))!;
}
export async function releaseOrchestration(rt: Runtime, applicationId: string, by: Actor, nowIso: string): Promise<OrchRow> {
  const row = await orchestrationByApplication(rt.db, applicationId); if (!row) throw new RangeError(`no orchestration for application ${applicationId}`);
  if (row.status !== "held") throw new RangeError(`orchestration ${row.id} is not held (${row.status})`);
  await writeHuman(rt, row, { status: "open", hold_reason: null, waiting_on: null, step_attempts: 0 }, { step: row.step, kind: "released", actor: by, detail: { hold_reason: row.hold_reason, by: `${by.kind}:${by.id}` } }, { type: EV.released, payload: { step: row.step, by: `${by.kind}:${by.id}`, hold_reason: row.hold_reason } }, nowIso);
  return (await orchestrationByApplication(rt.db, applicationId))!;
}
/** `orchestration.unwind{reason}` — an officer's act (rule 11): the row goes `unwinding` and the next pass runs 26.3's openUnwind; a funded loan is never unwound here (30.2's row is the servicing record). */
export async function unwindOrchestration(rt: Runtime, applicationId: string, reason: string, by: Actor, nowIso: string): Promise<OrchRow> {
  const row = await orchestrationByApplication(rt.db, applicationId); if (!row) throw new RangeError(`no orchestration for application ${applicationId}`);
  if (stepIndex(row.step) >= stepIndex("funded") || row.loan_id) throw new RangeError("after loan.funded there is no unwind — 30.2's row is the servicing record and a rescission-period error there is 25.3's remediation (rule 11)");
  await writeHuman(rt, row, { status: "unwinding", waiting_on: "26.3", hold_reason: null }, { step: row.step, kind: "unwound", actor: by, detail: { reason, stage: "requested", by: `${by.kind}:${by.id}` } }, { type: "orchestration.unwind.requested", payload: { step: row.step, reason, by: `${by.kind}:${by.id}` } }, nowIso);
  return (await orchestrationByApplication(rt.db, applicationId))!;
}
async function writeHuman(rt: Runtime, row: OrchRow, patch: Record<string, unknown>, j: JournalEntry, ev: { type: string; payload: Record<string, unknown> }, nowIso: string): Promise<void> {
  const loanId = row.loan_id;
  await rt.uow.run({ applicationId: row.application_id, ...(loanId ? { loanId } : {}) }, (ctx) => {
    ctx.events.append({ type: ev.type, applicationId: row.application_id, ...(loanId ? { loanId } : {}), aggregate: { kind: "closing_orchestration", id: row.id }, actor: j.actor ?? ORCH_ACTOR, payload: { orchestration_id: row.id, application_id: row.application_id, ...ev.payload } });
    ctx.decide(decisionOf({ orchestration_id: row.id, application_id: row.application_id, loan_id: loanId, step: row.step, action: j.kind === "held" ? "held" : j.kind === "released" ? "released" : "unwound", command: null, trigger_event_id: null, sources_sha256: sha256(JSON.stringify(patch)), rationale: `${j.kind} by ${j.actor?.kind}:${j.actor?.id}: ${String(j.detail?.["reason"] ?? j.detail?.["hold_reason"] ?? "")}` }));
    return null;
  }, { clock: rt.clock, commit: async (q) => {
    await q.query(`INSERT INTO closing_orchestration_steps (orchestration_id, application_id, loan_id, step, kind, waiting_on, actor_kind, actor_id, actor_role, detail, sweep_run_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, clock_timestamp())`, [row.id, row.application_id, loanId, j.step, j.kind, j.waiting_on ?? null, j.actor?.kind ?? "agent", j.actor?.id ?? ORCH_AGENT, j.actor?.role ?? null, JSON.stringify(j.detail ?? {}), rt.sweepRunId]);
    const sets = ["updated_at = $2"]; const params: unknown[] = [row.id, nowIso];
    for (const [k, v] of Object.entries(patch)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    await q.query(`UPDATE closing_orchestrations SET ${sets.join(", ")} WHERE id = $1`, params);
  } });
}

// ───────────────────────────── the board and the daily receipt ─────────────────────────────
export interface BoardRow { readonly application_id: string; readonly loan_id: string | null; readonly step: string; readonly status: OrchStatus; readonly waiting_on: string | null; readonly hold_reason: string | null; readonly next_clock: { code: string; due: string | null } | null; readonly advance_dwell_days: number | null; readonly waiting_for: string | null; readonly opened_at: string; readonly updated_at: string }
/** `orchestration.board`: every open orchestration with its step, status, waiting_on, the owning clock next due and the advance's dwell day (35.8's Closing screen). */
export async function orchestrationBoard(q: Queryable, nowIso: string): Promise<BoardRow[]> {
  const rows = await q.query<Row>(`SELECT ${ORCH_COLS} FROM closing_orchestrations WHERE status NOT IN ('completed', 'unwound', 'cancelled') ORDER BY opened_at`);
  const out: BoardRow[] = [];
  const today = wallClock(Date.parse(nowIso), "America/New_York").date;
  for (const r of rows.map(rowOf)) {
    const t = (await q.query<{ code: string; due: string | null }>(`SELECT code, coalesce(due_at::text, due_date::text) AS due FROM timers WHERE status IN ('armed', 'breached') AND (application_id = $1 OR ($2::uuid IS NOT NULL AND loan_id = $2)) ORDER BY coalesce(due_at, due_date::timestamptz) NULLS LAST LIMIT 1`, [r.application_id, r.loan_id]))[0] ?? null;
    const adv = r.warehouse_advance_id ? (await q.query<{ advance_date: string | null; status: string | null }>(`SELECT data->>'advance_date' AS advance_date, data->>'status' AS status FROM entity_current WHERE kind = 'warehouse_advances' AND id = $1`, [r.warehouse_advance_id]))[0] ?? null : null;
    const dwell = adv?.advance_date && adv.status !== "repaid" ? daysBetween(D(adv.advance_date), today) : null;
    out.push({ application_id: r.application_id, loan_id: r.loan_id, step: r.step, status: r.status, waiting_on: r.waiting_on, hold_reason: r.hold_reason, next_clock: t ? { code: t.code, due: t.due } : null, advance_dwell_days: dwell, waiting_for: r.status === "waiting_human" ? `person:${r.waiting_on}` : r.status === "waiting_vendor" ? `vendor:${r.waiting_on}` : r.status === "waiting_borrower" ? "borrower" : r.status === "waiting_window" ? `window:${r.waiting_on}` : null, opened_at: r.opened_at, updated_at: r.updated_at });
  }
  return out;
}
export interface DailyReceipt { readonly as_of_date: string; readonly open: number; readonly waiting_human: number; readonly waiting_vendor: number; readonly waiting_borrower: number; readonly waiting_window: number; readonly held: number; readonly completed_today: number; readonly unwound_today: number; readonly fixture_used_today: number; readonly oldest_open_step: string | null; readonly oldest_open_days: number | null; readonly by_waiting_on: Record<string, number>; readonly report_document_id: string | null; readonly ran: boolean }
/** Rule 10: `orchestration.pass{op: daily_receipt}` — one `orchestration_daily_receipts` row per platform day, the board stored as a 35.2 document, `orchestration.daily.run_completed` (SM_ORCH_OPEN_BOOK_DAILY's receipt; idempotent per day). */
export async function dailyReceipt(rt: Runtime, nowIso: string): Promise<DailyReceipt> {
  const asOf = wallClock(Date.parse(nowIso), "America/New_York").date;
  const existing = (await rt.db.query<Row>(`SELECT * FROM orchestration_daily_receipts WHERE as_of_date = $1`, [asOf]))[0];
  if (existing) return { ...(existing as unknown as DailyReceipt), as_of_date: asOf, by_waiting_on: (existing["by_waiting_on"] as Record<string, number>) ?? {}, ran: false };
  const counts = (await rt.db.query<{ status: string; c: string }>(`SELECT status, count(*)::text AS c FROM closing_orchestrations GROUP BY status`)).reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: Number(r.c) }), {});
  const byWaiting = (await rt.db.query<{ w: string; c: string }>(`SELECT coalesce(waiting_on, '') AS w, count(*)::text AS c FROM closing_orchestrations WHERE status NOT IN ('completed', 'unwound', 'cancelled') AND waiting_on IS NOT NULL GROUP BY 1`)).reduce<Record<string, number>>((m, r) => ({ ...m, [r.w]: Number(r.c) }), {});
  const dayStart = etDayStart(asOf);
  const completedToday = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM closing_orchestrations WHERE status = 'completed' AND completed_at >= $1::timestamptz`, [dayStart]))[0]!.c);
  const unwoundToday = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM closing_orchestrations WHERE status = 'unwound' AND updated_at >= $1::timestamptz`, [dayStart]))[0]!.c);
  const fixtureToday = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM funding_snapshots WHERE fixture_used AND built_at >= $1::timestamptz`, [dayStart]))[0]!.c);
  const oldest = (await rt.db.query<{ step: string; opened_at: string }>(`SELECT step, opened_at::text AS opened_at FROM closing_orchestrations WHERE status NOT IN ('completed', 'unwound', 'cancelled') ORDER BY opened_at LIMIT 1`))[0] ?? null;
  const board = await orchestrationBoard(rt.db, nowIso);
  const open = board.length;
  const receipt = { as_of_date: asOf, open, waiting_human: counts["waiting_human"] ?? 0, waiting_vendor: counts["waiting_vendor"] ?? 0, waiting_borrower: counts["waiting_borrower"] ?? 0, waiting_window: counts["waiting_window"] ?? 0, held: counts["held"] ?? 0, completed_today: completedToday, unwound_today: unwoundToday, fixture_used_today: fixtureToday, oldest_open_step: oldest?.step ?? null, oldest_open_days: oldest ? daysBetween(wallClock(Date.parse(oldest.opened_at), "America/New_York").date, asOf) : null, by_waiting_on: byWaiting };
  let documentId: string | null = null;
  await rt.uow.run({}, (ctx) => { ctx.events.append({ type: EV.daily, aggregate: { kind: "orchestration_daily_receipt", id: asOf }, actor: ORCH_ACTOR, payload: { as_of_date: asOf, open: receipt.open, waiting_human: receipt.waiting_human, waiting_vendor: receipt.waiting_vendor, waiting_borrower: receipt.waiting_borrower, waiting_window: receipt.waiting_window, held: receipt.held, completed_today: receipt.completed_today, fixture_used_today: receipt.fixture_used_today } }); return null; },
    { clock: rt.clock, before: async (q) => {
      documentId = await storeDocument(q, { kind: "closing_board_daily", application_id: null, loan_id: null, text: JSON.stringify({ as_of_date: asOf, receipt, board }), retention_class: "corporate_7y", source: "35.6 orchestration.pass{op: daily_receipt}", now: nowIso });
      await q.query(`INSERT INTO orchestration_daily_receipts (as_of_date, open, waiting_human, waiting_vendor, waiting_borrower, waiting_window, held, completed_today, unwound_today, fixture_used_today, oldest_open_step, oldest_open_days, by_waiting_on, report_document_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
        [asOf, receipt.open, receipt.waiting_human, receipt.waiting_vendor, receipt.waiting_borrower, receipt.waiting_window, receipt.held, receipt.completed_today, receipt.unwound_today, receipt.fixture_used_today, receipt.oldest_open_step, receipt.oldest_open_days, JSON.stringify(receipt.by_waiting_on), documentId]);
    } });
  return { ...receipt, report_document_id: documentId, ran: true };
}
/** The daily receipt runs once per platform day at/after 06:00 ET (35.3's `closing_orchestration_daily` cycle; the sweep runs it here until 35.3's registry owns the schedule). */
/** The receipt is due when the registry's clock says so: SM_ORCH_OPEN_BOOK_DAILY's armed instance (timers-35-6.ts: +1 calendar day, 06:30 ET, re-armed by each `orchestration.daily.run_completed`) has reached its due instant; with no instance yet (the first day) the receipt runs once. Never a time of day in service code. */
export async function dailyReceiptDue(rt: Runtime, nowIso: string): Promise<boolean> {
  const wc = wallClock(Date.parse(nowIso), "America/New_York");
  const armed = (await rt.db.query<{ due_at: string | Date | null }>(`SELECT due_at FROM timers WHERE code = 'SM_ORCH_OPEN_BOOK_DAILY' AND status = 'armed' ORDER BY armed_at DESC LIMIT 1`))[0];
  if (armed) { const due = armed.due_at === null ? null : new Date(armed.due_at).toISOString(); return due !== null && due <= nowIso && !(await rt.db.query(`SELECT 1 FROM orchestration_daily_receipts WHERE as_of_date = $1`, [wc.date])).length; }
  return !(await rt.db.query(`SELECT 1 FROM orchestration_daily_receipts LIMIT 1`)).length;
}
/** The start of a platform day (ET, the named calendar's zone) as an instant — DST-aware, never a fixed offset. */
function etDayStart(date: string): string {
  const guess = Date.parse(`${date}T05:00:00.000Z`);
  for (const t of [guess, guess - 3_600_000, guess + 3_600_000]) { const wc = wallClock(t, "America/New_York"); if (wc.date === date && wc.hour === 0 && wc.minute === 0) return new Date(t).toISOString(); }
  return new Date(guess).toISOString();
}
/** The breach pass's context for a 35.6 clock (registry: "the escalation names application_id, step, waiting_on"): the row the timer's application is on. */
export async function orchestrationBreachContext(rt: Runtime, instance: { code: string; applicationId?: string; loanId?: string }): Promise<Record<string, unknown>> {
  if (!instance.code.startsWith("SM_ORCH_")) return {};
  const row = instance.applicationId ? await orchestrationByApplication(rt.db, instance.applicationId) : instance.loanId ? (await rt.db.query<Row>(`SELECT ${ORCH_COLS} FROM closing_orchestrations WHERE loan_id = $1`, [instance.loanId])).map(rowOf)[0] ?? null : null;
  return row ? { application_id: row.application_id, orchestration_id: row.id, step: row.step, waiting_on: row.waiting_on, status: row.status } : {};
}

export type { OrchRecord, StepDef, StepOutcome, Wait, EntityRecord, EntityStore, ApplicationRecord };
