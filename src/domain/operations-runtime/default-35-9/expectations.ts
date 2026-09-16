/**
 * §35.9 rule 4 — "Expectations come from the firm, the court or the default, in that order", and the per-expectation state
 * machine: expected —(daily: due_on < today)→ due —(the owning section's event for the code)→ satisfied; expected|due
 * —(attorney/officer with a reason)→ waived; any —(the case terminal or on hold)→ cancelled. Rows live in
 * `case_milestone_expectations` (mutable on the timers precedent, never deleted); every transition is an event on the loan's
 * log (`case.milestone.expected` / `.due` / `.satisfied` / `.waived`), and `case.milestone.due` is what arms
 * SM_CASE_MILESTONE_OVERDUE_5BD (anchor `due_on`), `case.milestone.satisfied` what satisfies it — the registry, not this file,
 * decides the clock. The 35.8 item a due milestone opens goes through the WorkItemsPort.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor, EventStore } from "../../../kernel/events/index.ts";
import type { TimerEngine } from "../../../kernel/timers/engine.ts";
import { addBusinessDays, servicer } from "../../../kernel/calendar/business.ts";
import { addDays, plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { DUE_TOLERANCE_DAYS, ENGINE_ACTOR, EV, FC_MILESTONE_DEFAULTS, GENERIC_MILESTONE_DEFAULTS, MILESTONE_CODE_OF, NEXT_MILESTONE, TIMERS_35_9, type CaseKind } from "../default-35-9.ts";
import type { WorkItemsPort } from "./ports.ts";

export type Basis = "firm_forecast" | "docket_order" | "jurisdiction_default" | "section_clock" | "person";
export type Method = "judicial" | "non_judicial";
export type ExpectationRow = {
  readonly id: string; readonly loan_id: string; readonly case_id: string; readonly case_kind: string; readonly milestone_code: string; readonly expected_on: string; readonly due_on: string;
  readonly basis: Basis; readonly basis_ref: string | null; readonly status: "expected" | "due" | "satisfied" | "waived" | "cancelled"; readonly satisfied_event_id: string | null; readonly work_item_id: string | null; readonly timer_id: string | null;
};
/** What the expectation functions need: the command's transaction, its event store, the clock reading and the 35.8 port. */
export interface ExpectIo { readonly q: Queryable; readonly events: EventStore; readonly now: string; readonly actor?: Actor; readonly workItems: WorkItemsPort; readonly timers?: TimerEngine }

const SEL = `id::text AS id, loan_id::text AS loan_id, case_id::text AS case_id, case_kind, milestone_code, expected_on::text AS expected_on, due_on::text AS due_on, basis, basis_ref, status, satisfied_event_id::text AS satisfied_event_id, work_item_id::text AS work_item_id, timer_id::text AS timer_id`;
export async function expectationsOf(q: Queryable, caseId: string, status?: readonly string[]): Promise<ExpectationRow[]> {
  return q.query<ExpectationRow>(`SELECT ${SEL} FROM case_milestone_expectations WHERE case_id = $1::uuid ${status ? `AND status = ANY($2::text[])` : ""} ORDER BY created_at, id`, status ? [caseId, status] : [caseId]);
}
export const openExpectation = async (q: Queryable, caseId: string, code: string): Promise<ExpectationRow | null> =>
  (await q.query<ExpectationRow>(`SELECT ${SEL} FROM case_milestone_expectations WHERE case_id = $1::uuid AND milestone_code = $2 AND status IN ('expected', 'due')`, [caseId, code]))[0] ?? null;

/** rule 4's default lead time for a milestone in a state and method (the SQL row's `rules.fc_milestone_defaults`, else the in-code constants). */
export async function defaultLeadDays(q: Queryable, state: string, method: Method, code: string): Promise<{ days: number; ref: string }> {
  const st = state.toUpperCase();
  const rows = await q.query<{ rules: Record<string, unknown> | null }>(`SELECT rules FROM jurisdiction_rules WHERE state = $1`, [st]).catch(() => []);
  const fromRow = (((rows[0]?.rules ?? {})["fc_milestone_defaults"] as Record<string, Record<string, number>> | undefined) ?? {})[method]?.[code];
  if (typeof fromRow === "number") return { days: fromRow, ref: `jurisdiction_rules.fc_milestone_defaults.${st}.${method}.${code}` };
  const inCode = FC_MILESTONE_DEFAULTS[st]?.[method]?.[code];
  if (typeof inCode === "number") return { days: inCode, ref: `default-35-9.FC_MILESTONE_DEFAULTS.${st}.${method}.${code}` };
  return { days: GENERIC_MILESTONE_DEFAULTS[code] ?? 30, ref: `default-35-9.GENERIC_MILESTONE_DEFAULTS.${code}` };
}
export const dueOnFor = (expectedOn: PlainDate, basis: Basis): PlainDate => addDays(expectedOn, DUE_TOLERANCE_DAYS[basis] ?? 0);

/** The armed 35.9 clock for the subject and code (best effort: the engine armed it synchronously on the event just appended). */
const armedTimerId = (io: ExpectIo, code: string): string | null => io.timers?.byCode(code).find((t) => t.status === "armed")?.id ?? null;

export interface WriteExpectationInput { readonly loan_id: string; readonly case_id: string; readonly case_kind: CaseKind | string; readonly milestone_code: string; readonly expected_on: PlainDate; readonly basis: Basis; readonly basis_ref: string | null; readonly supersede?: boolean }
/** Write (or supersede) the open expectation for a code — `case.milestone.expected`. A superseded row is `cancelled`, never deleted. */
export async function writeExpectation(io: ExpectIo, i: WriteExpectationInput): Promise<ExpectationRow> {
  const open = await openExpectation(io.q, i.case_id, i.milestone_code);
  if (open && !i.supersede) return open;
  if (open) await io.q.query(`UPDATE case_milestone_expectations SET status = 'cancelled', updated_at = $2::timestamptz WHERE id = $1::uuid`, [open.id, io.now]);
  const due_on = dueOnFor(i.expected_on, i.basis);
  const rows = await io.q.query<ExpectationRow>(
    `INSERT INTO case_milestone_expectations (loan_id, case_id, case_kind, milestone_code, expected_on, due_on, basis, basis_ref, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::date, $7, $8, 'expected', $9::timestamptz, $9::timestamptz) RETURNING ${SEL}`,
    [i.loan_id, i.case_id, i.case_kind, i.milestone_code, i.expected_on, due_on, i.basis, i.basis_ref, io.now]);
  const row = rows[0]!;
  io.events.append({ type: EV.milestoneExpected, loanId: i.loan_id, actor: io.actor ?? ENGINE_ACTOR, payload: { case_id: i.case_id, case_kind: i.case_kind, milestone_code: i.milestone_code, expected_on: i.expected_on, due_on, basis: i.basis, basis_ref: i.basis_ref, expectation_id: row.id, ...(open ? { superseded: open.id } : {}) } });
  return row;
}

/** State machine: expected | due → satisfied by the owning section's event for the code; closes the 35.8 item; the next expectation is the caller's (rule 4). */
export async function satisfyExpectation(io: ExpectIo, i: { case_id: string; milestone_code: string; satisfied_event_id: string; loan_id: string }): Promise<ExpectationRow | null> {
  const open = await openExpectation(io.q, i.case_id, i.milestone_code);
  if (!open) return null;
  await io.q.query(`UPDATE case_milestone_expectations SET status = 'satisfied', satisfied_event_id = $2::uuid, updated_at = $3::timestamptz WHERE id = $1::uuid`, [open.id, i.satisfied_event_id, io.now]);
  await io.workItems.close(io.q, { source_kind: "case_milestone", source_id: open.id, disposition: "satisfied", now: io.now });
  io.events.append({ type: EV.milestoneSatisfied, loanId: i.loan_id, actor: io.actor ?? ENGINE_ACTOR, payload: { case_id: i.case_id, milestone_code: i.milestone_code, satisfied_event_id: i.satisfied_event_id, expectation_id: open.id, was: open.status, due_on: open.due_on } });
  return { ...open, status: "satisfied", satisfied_event_id: i.satisfied_event_id };
}

/** expected | due → waived by an attorney or officer with a reason (State machine). */
export async function waiveExpectation(io: ExpectIo, i: { case_id: string; milestone_code: string; loan_id: string; by: Actor; staff_user_id: string | null; reason: string }): Promise<ExpectationRow | null> {
  const open = await openExpectation(io.q, i.case_id, i.milestone_code);
  if (!open) return null;
  await io.q.query(`UPDATE case_milestone_expectations SET status = 'waived', waived_by = $2::uuid, waiver_reason = $3, updated_at = $4::timestamptz WHERE id = $1::uuid`, [open.id, i.staff_user_id, i.reason, io.now]);
  await io.workItems.close(io.q, { source_kind: "case_milestone", source_id: open.id, disposition: "waived", now: io.now });
  io.events.append({ type: EV.milestoneWaived, loanId: i.loan_id, actor: i.by, payload: { case_id: i.case_id, milestone_code: i.milestone_code, by: `${i.by.kind}:${i.by.id}`, role: i.by.role ?? null, reason: i.reason, expectation_id: open.id } });
  return { ...open, status: "waived" };
}

/** any → cancelled when the case's status makes the milestone moot (terminal or on hold). */
export async function cancelExpectations(io: ExpectIo, i: { case_id: string; loan_id: string; cause: string }): Promise<number> {
  const open = await expectationsOf(io.q, i.case_id, ["expected", "due"]);
  for (const e of open) {
    await io.q.query(`UPDATE case_milestone_expectations SET status = 'cancelled', updated_at = $2::timestamptz WHERE id = $1::uuid`, [e.id, io.now]);
    await io.workItems.close(io.q, { source_kind: "case_milestone", source_id: e.id, disposition: `cancelled:${i.cause}`, now: io.now });
  }
  return open.length;
}

/** The daily unit (rule 2 step d): `expected` with `due_on` < today (or `expected_on` < today for a docket order) → `due`. */
export async function markDue(io: ExpectIo, i: { loan_id: string; as_of_date: PlainDate; screen_code_of: (caseKind: string) => string }): Promise<ExpectationRow[]> {
  const rows = await io.q.query<ExpectationRow>(`SELECT ${SEL} FROM case_milestone_expectations WHERE loan_id = $1::uuid AND status = 'expected' AND ((basis = 'docket_order' AND expected_on < $2::date) OR due_on < $2::date) ORDER BY due_on, created_at`, [i.loan_id, i.as_of_date]);
  const out: ExpectationRow[] = [];
  for (const e of rows) {
    const work_item_id = await io.workItems.open(io.q, { screen_code: i.screen_code_of(e.case_kind), subject_kind: "loan", subject_id: e.loan_id, loan_id: e.loan_id, source_kind: "case_milestone", source_id: e.id, required_role: "attorney", now: io.now, due_at: null });
    io.events.append({ type: EV.milestoneDue, loanId: e.loan_id, actor: io.actor ?? ENGINE_ACTOR, payload: { case_id: e.case_id, case_kind: e.case_kind, milestone_code: e.milestone_code, due_on: e.due_on, basis: e.basis, work_item_id, as_of_date: i.as_of_date, expectation_id: e.id } });
    const timer_id = armedTimerId(io, TIMERS_35_9.milestoneOverdue);
    await io.q.query(`UPDATE case_milestone_expectations SET status = 'due', work_item_id = $2::uuid, timer_id = $3::uuid, updated_at = $4::timestamptz WHERE id = $1::uuid`, [e.id, work_item_id, timer_id, io.now]);
    out.push({ ...e, status: "due", work_item_id, timer_id });
  }
  return out;
}

// ---- the reactions the fold runs (rule 4's first sentence, in order: the firm, the court, the default) --------------------
export interface CaseFacts { readonly loan_id: string; readonly case_id: string; readonly case_kind: CaseKind; readonly state: string; readonly method: Method }

/** On `foreclosure.referral.sent`: `referral_ack` (sent + 2 servicer business days, section_clock) and `first_legal` (jurisdiction_default). */
export async function onReferralSent(io: ExpectIo, c: CaseFacts, i: { sent_on: PlainDate; ack_clock_ref: string | null }): Promise<void> {
  await writeExpectation(io, { ...c, milestone_code: "referral_ack", expected_on: addBusinessDays(i.sent_on, 2, servicer), basis: "section_clock", basis_ref: i.ack_clock_ref ?? "FNMA_E3205_FIRM_ACK_2BD" });
  const d = await defaultLeadDays(io.q, c.state, c.method, "first_legal");
  await writeExpectation(io, { ...c, milestone_code: "first_legal", expected_on: addDays(i.sent_on, d.days), basis: "jurisdiction_default", basis_ref: d.ref });
}
/** On the firm's acknowledgment: satisfy `referral_ack`; a forecast first-legal date replaces the default (basis firm_forecast). */
export async function onReferralAcknowledged(io: ExpectIo, c: CaseFacts, i: { event_id: string; forecast_first_legal_on: PlainDate | null; forecast_ref: string | null }): Promise<void> {
  await satisfyExpectation(io, { ...c, milestone_code: "referral_ack", satisfied_event_id: i.event_id });
  if (i.forecast_first_legal_on) await writeExpectation(io, { ...c, milestone_code: "first_legal", expected_on: i.forecast_first_legal_on, basis: "firm_forecast", basis_ref: i.forecast_ref ?? i.event_id, supersede: true });
}
/** On `foreclosure.milestone.recorded{code, occurred_on}` (from the firm, the DRA or the docket): satisfy and write the next one from the latest `occurred_on`. */
export async function onMilestoneRecorded(io: ExpectIo, c: CaseFacts, i: { event_id: string; code: string; occurred_on: PlainDate; forecast_next_on?: PlainDate | null; source: string }): Promise<{ satisfied: string | null; next: string | null }> {
  const code = MILESTONE_CODE_OF[i.code.toUpperCase()] ?? i.code.toLowerCase();
  const satisfied = await satisfyExpectation(io, { ...c, milestone_code: code, satisfied_event_id: i.event_id });
  const next = NEXT_MILESTONE[c.method][code] ?? null;
  if (next) {
    if (i.forecast_next_on) await writeExpectation(io, { ...c, milestone_code: next, expected_on: i.forecast_next_on, basis: "firm_forecast", basis_ref: i.event_id, supersede: true });
    else { const d = await defaultLeadDays(io.q, c.state, c.method, next); await writeExpectation(io, { ...c, milestone_code: next, expected_on: addDays(i.occurred_on, d.days), basis: "jurisdiction_default", basis_ref: d.ref }); }
  }
  return { satisfied: satisfied ? code : null, next };
}
/** A docket order with a date replaces a default (rule 4: "a docket order with a date (`docket_order`) replaces a default"). */
export async function onDocketOrder(io: ExpectIo, c: CaseFacts, i: { milestone_code: string; ordered_on: PlainDate; docket_ref: string }): Promise<void> {
  await writeExpectation(io, { ...c, milestone_code: i.milestone_code, expected_on: i.ordered_on, basis: "docket_order", basis_ref: i.docket_ref, supersede: true });
}
export const expectationDate = (s: unknown): PlainDate | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? D(s.slice(0, 10)) : null);
