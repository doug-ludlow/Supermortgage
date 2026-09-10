/**
 * §16.3 tools — the spec's tool strings for process 16.3, verbatim, via
 * `defineTools("16.3", "payoff-release", defs)` from ../tools.ts (see section13.ts). Spread by ./section16.ts.
 *
 * The tools persist the spec's own tables (`release_tasks`, `recording_submissions`, `custody_requests`;
 * `lpoas` and `signing_officers` are read) and reuse `documents` (SHA-256; retention life_of_loan_plus_4y)
 * for the unsigned/executed instrument, the notary audit trail and the recorded image. Every gate reads
 * persisted state, never the caller's assertion: routeForExecution reads the checklist result and payoff
 * evidence off the `release_tasks` row, consults the `lpoas` rows through the registered evaluator
 * `16.3.lpoaRecordedForState`, and a held task stays held until a human clears the title review;
 * submitRecording requires the row's executed_at/notarized_at and delivery evidence; computePenaltyExposure
 * reads the state, deadline, payoff date and satisfaction date off the row and STATE_LIEN_RELEASE_DEADLINE's
 * persisted status, and op=post books the row's computed exposure behind `16.3.penaltyNeverPassedThrough`;
 * notifyBorrower takes the state off the row and "with the recorded image" from the `documents` row it encloses.
 * A payoff reversal is read from the loan's persisted events (ops-16-3 reversalState): `payoff.reversed` after
 * the last `loan.paid_in_full` voids the task before recording (clocks released, no instrument signed) or, after
 * recording, moves it to `post_recording_reversal` with the `attorney` escalation and the officer informed —
 * eagerly through `releaseReactors_16_3` and lazily by every task-scoped tool, which then refuses any actor but
 * the `officer` (REVERSED_PAYOFF_NEEDS_OFFICER) — no input flag decides it.
 *
 * `releaseReactors_16_3` also opens the release task from 16.2's `loan.paid_in_full` itself (Inputs: "`loan.paid_in_full`
 * → open `release_tasks`"): the state and payoff date come from the event or the `loans`/`properties` rows, the task
 * opens with `selection_pending` when the mortgagee of record is not yet known, and its `lien_release.task_opened`
 * arms STATE_LIEN_RELEASE_DEADLINE and the state clocks before any agent acts; selectReleaseInstrument later
 * refreshes the same row (`lien_release.task_updated`, no re-arming). Wire it wherever the app builds its unit of work.
 *
 * Money moves through the ledger: submitRecording posts the recording-fee entry set (Dr `recording_fee_payable` /
 * Cr `corporate_cash` borrower-funded, or Dr `release_recording_expense` with the F-1-05 claim receivable) and
 * computePenaltyExposure op=post the penalty set (Dr `release_penalty_expense`), each `fee.posted` naming its
 * `ledger_set_id`. A non-eRecording county's package goes through the `print-mail` port with a positive-pay fee
 * check (`outstanding_checks`, `disbursement.issued`) and is tracked by the mail-tracking barcode on the row.
 *
 * Emitted events (the timers in ../../domain/payoff/timers-16-3.ts name them): `lien_release.task_opened|task_updated|
 * task_open_failed|voided|post_recording_reversal`, `custody.documents.requested|received`, `lien_release.drafted|
 * prepared|execution_requested|sent_for_execution|executed|notarized|submitted|rejected|recorded|delivered|
 * delivered_to_trustee|borrower_notified|note_return_requested|note_returned` (the statutory-duty closers carry
 * `statutory_duty: "satisfied"`), `fnma.execution.returned`, `trustee.reconveyance.recorded`, `notarization.scheduled`,
 * `fee.posting_requested|posted`, `disbursement.issued`, `command.refused`.
 */
import { defineTools, compute, noticeOps, never, needsRole, guard, port, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime, type EntityRecord, type EntityStore } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { assertGate } from "../evaluators.ts";
import { hasRole } from "../roles.ts";
import type { EscalationService } from "../escalations.ts";
import { SYSTEM, type Actor, type DomainEvent, type EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/index.ts";
import { plainDate as D, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { selectInstrument, lpoaGate, draftInstrument, custodyRequest, releaseChecklist, executionCommand, recorderReject, recordingSubmission, recordedRelease, recorderFee, releaseFeePosting, penaltyPosting, fnmaExecutionPackage, borrowerNotification, penaltyExposureReport, njCancellationNotice, openReleaseTask, taskOpenedPayload, releaseRule, sha256, fundsAnchor, statutoryDutyEvent, reversalState, payoffReversal, ledgerEntrySet, paperRecordingPackage, type MortgageeOfRecord, type SecurityInstrument, type SignatoryPath, type ChecklistItem, type LpoaRow, type Selection, type OpenedTask, type ReversalState } from "../../domain/payoff/ops-16-3.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const today = (i: ToolInput, ctx: { now: string }): PlainDate => optDate(i, "today") ?? D(ctx.now.slice(0, 10));
const S = (d: Record<string, unknown> | undefined, k: string): string => String(d?.[k] ?? "");
const dateOf = (d: Record<string, unknown> | undefined, k: string): PlainDate | null => (d && typeof d[k] === "string" && d[k] !== "" ? D(String(d[k]).slice(0, 10)) : null);
const AGENT = "payoff-release";
const NOTICE_BY_OP: Record<string, string> = { release_recorded: "NTC_LIEN_RELEASE_RECORDED", nj_cancellation_right: "NTC_NJ_CANCELLATION_RIGHT", enote_paper_copy: "NTC_ENOTE_PAPER_COPY", note_returned: "NTC_NOTE_RETURNED" };
const DELIVERY_OPS = ["trustee_delivery", "settlement_agent_delivery"];
const OPENING_STATES = ["opened", "awaiting_custody_docs", "held"];
/** Deed-of-trust practice states (default security instrument when 16.2's event and the loan row are silent; only CA/WA/CO change the instrument). */
const DOT_STATES = new Set(["CA", "WA", "CO", "TX", "AZ", "VA", "MD", "NC", "DC", "OR", "NV", "UT", "ID", "MT", "AK", "TN", "MO", "MS", "WV", "NE", "NM"]);
const REVERSAL_CITATION = "16.3 guardrail: no release for a loan with `payoff_reversed` or open `fnma_liquidated_in_error` without `officer` approval";

/** A handler-level refusal on *persisted* state: logged as `command.refused` (the bus logs guardrail refusals the same way) and thrown as CommandRefused. */
function refuse(ctx: CommandContext, loanId: string, command: string, code: string, citation: string, reason: string, extra: Record<string, unknown> = {}): never {
  ctx.events.append({ type: "command.refused", loanId, actor: ctx.actor, payload: { command, code, citation, reason, ...extra } });
  throw new CommandRefused(command, code, citation, reason);
}
const task = (rt: ToolRuntime, i: ToolInput) => rt.store.require("release_tasks", str(i, "release_task_id"));
const loanOf = (i: ToolInput, ctx: CommandContext, row?: { data: Record<string, unknown> }): string => str(i, "loan_id") || (row ? S(row.data, "loan_id") : "") || ctx.loanId;
const lpoaRows = (i: ToolInput, store: EntityStore): LpoaRow[] => (Array.isArray(i.lpoas) ? (i.lpoas as LpoaRow[]) : store.list("lpoas").map((r) => ({ state: S(r.data, "state"), status: S(r.data, "status"), scope: (r.data.scope as string[] | undefined) ?? null })));
/** `documents` row: SHA-256 of the content, retention life_of_loan_plus_4y (spec data model: "Reuse documents"). */
function putDocument(rt: ToolRuntime, ctx: CommandContext, loanId: string, kind: string, content: string, metadata: Record<string, unknown>): { id: string; sha256: string } {
  const hash = sha256(content); const id = `doc-${kind}-${hash.slice(0, 16)}`;
  rt.store.put("documents", id, { loan_id: loanId, kind, sha256: hash, byte_size: Buffer.byteLength(content), storage_uri: `store://documents/${id}`, mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y", metadata }, ctx.actor, ctx.now);
  return { id, sha256: hash };
}
const selectionOf = (d: Record<string, unknown>): Pick<Selection, "instrument_type" | "executes_in_name_of" | "signatory_path" | "recites"> => ({ instrument_type: S(d, "instrument_type") as Selection["instrument_type"], executes_in_name_of: (d.executes_in_name_of as Selection["executes_in_name_of"]) ?? null, signatory_path: (d.signatory_path as SignatoryPath | null) ?? null, recites: (d.recites as Selection["recites"] | undefined) ?? { mers_as_nominee: false, min: null, fnma_loan_number: null } });

// ───────────────────────────── the reaction context (tools and the event reactors share it) ─────────────────────────────
interface Rx { readonly events: EventStore; readonly timers: TimerEngine | null; readonly store: EntityStore; readonly escalations: EscalationService; readonly actor: Actor; readonly now: string; }
const rxOf = (ctx: CommandContext, rt: ToolRuntime): Rx => ({ events: ctx.events, timers: ctx.timers, store: rt.store, escalations: rt.escalations, actor: ctx.actor, now: ctx.now });
const armed = (t: { status: string }): boolean => t.status === "armed" || t.status === "breached";

// ───────────────────────────── opening the task (`loan.paid_in_full` → `release_tasks`) ─────────────────────────────
interface OpenFacts {
  readonly loan_id: string; readonly state: string; readonly county: string | null; readonly payoff_on: PlainDate; readonly funds_received_on: PlainDate | null; readonly funds_kind: string | null; readonly funds_cleared_on: PlainDate | null;
  readonly settlement_id: string | null; readonly release_kind: string; readonly recording_office_id: string | null; readonly security_instrument: SecurityInstrument; readonly mortgagee_of_record: MortgageeOfRecord | null;
  readonly min_active: boolean; readonly mers_registered: boolean; readonly substitution_permitted?: boolean; readonly confidence?: number; readonly min: string | null; readonly fnma_loan_number: string | null; readonly mortgagee_kind: "bank" | "nonbank" | null;
  readonly original_note_required: boolean; readonly borrower_requested_note: boolean; readonly recorder_requires_original: boolean; readonly payoff_evidence_document_id: string | null; readonly lpoas: LpoaRow[];
  readonly release_task_id: string | null; readonly opened_by: "agent" | "payoff_event"; readonly source_event_id: string | null;
}
/**
 * One `release_tasks` row per recording office. A first open emits `lien_release.task_opened` (the clocks arm on its computed
 * anchors); a later selection on the same task refreshes the rule-1 fields and emits `lien_release.task_updated` (nothing
 * re-arms), retiring the CA trustee-delivery / NJ nonbank clocks the refreshed facts rule out. A voided task re-opens when a
 * cured payoff is re-posted.
 */
function openTask(f: OpenFacts, rx: Rx): { rec: EntityRecord; opened: OpenedTask; sel: Selection | null; created: boolean; escalation_id: string | null } {
  const opened = openReleaseTask({ state: f.state, payoff_on: f.payoff_on, original_note_required: f.original_note_required, borrower_requested_note: f.borrower_requested_note, recorder_requires_original: f.recorder_requires_original });
  const sel = f.mortgagee_of_record ? selectInstrument({ state: f.state, security_instrument: f.security_instrument, mortgagee_of_record: f.mortgagee_of_record, min_active: f.min_active, lpoas: f.lpoas, ...(f.substitution_permitted !== undefined ? { substitution_permitted: f.substitution_permitted } : {}), mers_registered: f.mers_registered, ...(f.confidence !== undefined ? { confidence: f.confidence } : {}), min: f.min, fnma_loan_number: f.fnma_loan_number, deadline_at: opened.deadline_at, discovered_on: D(rx.now.slice(0, 10)) }) : null;
  const id = f.release_task_id || `rt-${f.loan_id}-${f.county ?? f.state}-${f.payoff_on}`;
  const prev = rx.store.get("release_tasks", id); const reopen = !!prev && S(prev.data, "status") === "void"; const created = !prev || reopen;
  const fa = fundsAnchor({ funds_received_on: f.funds_received_on ?? f.payoff_on, funds_kind: f.funds_kind, cleared_on: f.funds_cleared_on });
  const status = sel?.status === "held" ? "held" : opened.status;
  const keepStatus = !!prev && !reopen && !OPENING_STATES.includes(S(prev.data, "status"));
  const rec = rx.store.put("release_tasks", id, { loan_id: f.loan_id, settlement_id: f.settlement_id ?? prev?.data.settlement_id ?? null, release_kind: f.release_kind, state: f.state, county: f.county, recording_office_id: f.recording_office_id ?? prev?.data.recording_office_id ?? null, security_instrument: f.security_instrument, instrument_type: sel?.instrument_type ?? null, mortgagee_of_record: sel?.mortgagee_of_record ?? null, mortgagee_kind: f.mortgagee_kind, signatory_path: sel?.signatory_path ?? null, recording_path: sel?.recording_path ?? null, executes_in_name_of: sel?.executes_in_name_of ?? null, recites: sel?.recites ?? { mers_as_nominee: false, min: f.min, fnma_loan_number: f.fnma_loan_number }, min: f.min, fnma_loan_number: f.fnma_loan_number, selection_pending: sel === null, opened_by: created ? f.opened_by : prev!.data.opened_by, payoff_on: f.payoff_on, funds_received_on: f.funds_received_on ?? f.payoff_on, funds_kind: f.funds_kind, funds_cleared_on: f.funds_cleared_on, md_delivery_anchor: fa.anchor, funds_anchor_basis: fa.basis, deadline_at: opened.deadline_at, statutory_anchor: opened.statutory_anchor, satisfied_by: opened.satisfied_by, original_note_required: opened.original_note_required, custody_in_parallel: opened.custody_in_parallel, timers: opened.timers, payoff_evidence_document_id: f.payoff_evidence_document_id ?? prev?.data.payoff_evidence_document_id ?? null, ...(keepStatus ? {} : { status }), hold_reason: sel?.hold_reason ?? null, corrective_action: sel?.corrective_action ?? null, review_by: sel?.review_by ?? null, lpoa_gate_open: sel?.lpoa_gate_open ?? null, ...(created ? { penalty_exposure_cents: 0n, reversal: null, reversal_event_id: null, opened_at: rx.now } : {}) }, rx.actor, rx.now);
  const needsEscalation = !!sel?.escalation && sel.status === "held" && (created || S(prev!.data, "hold_reason") !== sel.hold_reason);
  const escalation = needsEscalation ? rx.escalations.open({ kind: sel!.escalation!.kind, loanId: f.loan_id, ...(sel!.escalation!.severity ? { severity: sel!.escalation!.severity } : {}), payload: { release_task_id: rec.id, reason: sel!.escalation!.reason, corrective_action: sel!.corrective_action, review_by: sel!.review_by, statutory_clock: "running", deadline_at: opened.deadline_at } }, rx.actor) : null;
  const payload = taskOpenedPayload({ release_task_id: rec.id, state: f.state, county: f.county, payoff_on: f.payoff_on, funds_received_on: f.funds_received_on, funds_kind: f.funds_kind, funds_cleared_on: f.funds_cleared_on, mortgagee_kind: f.mortgagee_kind, task: opened, sel, opened_by: f.opened_by });
  rx.events.append({ type: created ? "lien_release.task_opened" : "lien_release.task_updated", loanId: f.loan_id, actor: rx.actor, ...(f.source_event_id ? { causationId: f.source_event_id } : {}), payload });
  if (!created && rx.timers) {
    // the refreshed facts retire clocks the opening armed on conservative defaults (CA request-to-trustee → substitution recorded directly; NJ nonbank → bank)
    const retire: Record<string, string> = {}; const prevPath = S(prev!.data, "recording_path"), prevKind = S(prev!.data, "mortgagee_kind");
    if (prevPath === "trustee_third_party" && sel && sel.recording_path !== "trustee_third_party") retire.CA_CC2941_TRUSTEE_DELIVERY_30 = `recording path ${sel.recording_path}: the substitution/direct variant records without a trustee delivery (decision 2)`;
    if (prevKind === "nonbank" && f.mortgagee_kind === "bank") retire.NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10 = "mortgagee is a bank: N.J.S.A. 46:18-11.2's 10-day notice applies to nonbank mortgagees";
    for (const t of rx.timers.forSubject("loan", f.loan_id)) if (armed(t) && retire[t.code]) rx.timers.cancel(t.id, retire[t.code]!, rx.actor);
  }
  return { rec, opened, sel, created, escalation_id: escalation?.id ?? null };
}
const pick = (...vals: unknown[]): string | null => { for (const v of vals) if (typeof v === "string" && v.trim()) return v; return null; };
/** The facts the payoff event and the loan/property rows carry for the automatic open; `missing` names what neither has. */
function factsFromPayoff(e: DomainEvent, store: EntityStore): { facts: OpenFacts } | { missing: string } {
  const p = e.payload as Record<string, unknown>; const loanId = e.loanId ?? "";
  if (!loanId) return { missing: "loan_id" };
  const loan = store.get("loans", loanId)?.data ?? {}; const property = pick(loan.property_id) ? store.get("properties", String(loan.property_id))?.data ?? {} : {};
  const state = pick(p.state, p.property_state, loan.property_state, loan.state, property.state); if (!state) return { missing: "state" };
  const payoffOn = pick(p.payoff_date, p.payoff_on); if (!payoffOn) return { missing: "payoff_date" };
  const min = pick(p.min, loan.min); const min_active = typeof loan.min_active === "boolean" ? loan.min_active : typeof p.min_active === "boolean" ? p.min_active : !!min;
  const stated = pick(p.mortgagee_of_record, loan.mortgagee_of_record) as MortgageeOfRecord | null;
  const kind = pick(p.mortgagee_kind, loan.mortgagee_kind) as "bank" | "nonbank" | null;
  const received = pick(p.funds_received_on), cleared = pick(p.funds_cleared_on, p.cleared_on);
  return { facts: { loan_id: loanId, state, county: pick(p.county, loan.county, property.county), payoff_on: D(payoffOn), funds_received_on: received ? D(received) : null, funds_kind: pick(p.funds_kind, p.method), funds_cleared_on: cleared ? D(cleared) : null, settlement_id: pick(p.settlement_id), release_kind: pick(p.release_kind) ?? "full", recording_office_id: pick(loan.recording_office_id, property.recording_office_id), security_instrument: (pick(p.security_instrument, loan.security_instrument) ?? (DOT_STATES.has(state) ? "deed_of_trust" : "mortgage")) as SecurityInstrument, mortgagee_of_record: stated ?? (min && min_active ? "mers" : null), min_active, mers_registered: !!min, min, fnma_loan_number: pick(p.fnma_loan_number, loan.fnma_loan_number), mortgagee_kind: kind ?? (state === "NJ" ? "nonbank" : null), original_note_required: p.original_note_required === true, borrower_requested_note: p.borrower_requested_note === true, recorder_requires_original: false, payoff_evidence_document_id: pick(p.payoff_evidence_document_id, p.settlement_id), lpoas: lpoaRows({}, store), release_task_id: null, opened_by: "payoff_event", source_event_id: e.id } };
}
function factsFromInput(i: ToolInput, rt: ToolRuntime): OpenFacts {
  need(i, "loan_id", "state", "security_instrument", "mortgagee_of_record", "payoff_on");
  return { loan_id: str(i, "loan_id"), state: str(i, "state"), county: str(i, "county") || null, payoff_on: date(i, "payoff_on"), funds_received_on: optDate(i, "funds_received_on"), funds_kind: str(i, "funds_kind") || null, funds_cleared_on: optDate(i, "funds_cleared_on"), settlement_id: str(i, "settlement_id") || null, release_kind: str(i, "release_kind") || "full", recording_office_id: str(i, "recording_office_id") || null, security_instrument: str(i, "security_instrument") as SecurityInstrument, mortgagee_of_record: str(i, "mortgagee_of_record") as MortgageeOfRecord, min_active: flag(i, "min_active"), mers_registered: flag(i, "mers_registered"), ...(typeof i.substitution_permitted === "boolean" ? { substitution_permitted: i.substitution_permitted } : {}), ...(typeof i.confidence === "number" ? { confidence: num(i, "confidence") } : {}), min: (i.min as string | undefined) ?? null, fnma_loan_number: (i.fnma_loan_number as string | undefined) ?? null, mortgagee_kind: (str(i, "mortgagee_kind") || null) as "bank" | "nonbank" | null, original_note_required: flag(i, "original_note_required"), borrower_requested_note: flag(i, "borrower_requested_note"), recorder_requires_original: flag(i, "recorder_requires_original"), payoff_evidence_document_id: str(i, "payoff_evidence_document_id") || str(i, "settlement_id") || null, lpoas: lpoaRows(i, rt.store), release_task_id: str(i, "release_task_id") || null, opened_by: "agent", source_event_id: null };
}

// ───────────────────────────── payoff reversal (inputs / T11) on persisted state ─────────────────────────────
/** Apply 16.2's `payoff.reversed` to one task exactly once: void before recording (instrument never signed; every 16.3 clock released), `post_recording_reversal` after (attorney sev-1, officer informed, borrower-notice clocks released; no borrower charge either way). */
function reconcileReversal(row: EntityRecord, rx: Rx): { state: ReversalState; applied: ReturnType<typeof payoffReversal> | null; row: EntityRecord } {
  const loanId = S(row.data, "loan_id"); const rs = reversalState(rx.events.byLoan(loanId));
  if (!rs.reversed || row.data.reversal_event_id === rs.reversal_event_id) return { state: rs, applied: null, row };
  const r = payoffReversal({ reversed_on: rs.reversed_on!, executed_at: dateOf(row.data, "executed_at"), submitted_at: dateOf(row.data, "submitted_at"), recorded_at: dateOf(row.data, "recorded_at") });
  const rec = rx.store.put("release_tasks", row.id, { status: r.task_status, status_before_reversal: S(row.data, "status"), reversal: { ...r, reversed_on: rs.reversed_on, cause: rs.cause, fnma_liquidated_in_error: rs.fnma_liquidated_in_error_open }, reversal_event_id: rs.reversal_event_id, reversed_on: rs.reversed_on, borrower_charge_cents: 0n, ...(r.task_status === "post_recording_reversal" ? { loan_serviced_as: r.loan_serviced_as, borrower_notice_hold: true } : {}) }, rx.actor, rx.now);
  const attorney = r.escalation ? rx.escalations.open({ kind: r.escalation.kind, loanId, ...(r.escalation.severity ? { severity: r.escalation.severity } : {}), payload: { release_task_id: row.id, reason: r.escalation.reason, action: r.action, loan_serviced_as: r.loan_serviced_as, borrower_charge_cents: 0n } }, rx.actor) : null;
  const officer = r.officer_informed ? rx.escalations.open({ kind: "officer", loanId, severity: "sev2", payload: { release_task_id: row.id, reason: `payoff reversed ${rs.reversed_on} (${rs.cause ?? "cause not stated"}): release task ${r.status} — ${r.action}` } }, rx.actor) : null;
  const released: string[] = [];
  if (rx.timers) for (const t of rx.timers.forSubject("loan", loanId)) if (armed(t) && r.timers_released.includes(t.code)) { rx.timers.cancel(t.id, `payoff reversed ${rs.reversed_on}: release task ${r.task_status} (16.3-T11)`, rx.actor); released.push(t.code); }
  rx.events.append({ type: r.event, loanId, actor: rx.actor, ...(rs.reversal_event_id ? { causationId: rs.reversal_event_id } : {}), payload: { release_task_id: row.id, status: r.task_status, branch: r.status, reversed_on: rs.reversed_on, instrument_signed: r.instrument_signed, borrower_charge_cents: 0n, attorney_escalation_id: attorney?.id ?? null, officer_escalation_id: officer?.id ?? null, timers_released: released, action: r.action } });
  return { state: rs, applied: r, row: rec };
}
/** Every task-scoped tool: settle any reversal on the persisted events first, then refuse anyone but the officer on a reversed / liquidated-in-error payoff. */
const taskRow = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime, command: string): EntityRecord => { const row = task(rt, i); return assertPayoffStands(row, loanOf(i, ctx, row), ctx, rt, command)!; };
function assertPayoffStands(row: EntityRecord | null, loanId: string, ctx: CommandContext, rt: ToolRuntime, command: string): EntityRecord | null {
  const r = row ? reconcileReversal(row, rxOf(ctx, rt)) : { state: reversalState(ctx.events.byLoan(loanId)), applied: null, row: null };
  if ((r.state.reversed || r.state.fnma_liquidated_in_error_open) && !hasRole(ctx.actor, ["officer"])) refuse(ctx, loanId, command, "REVERSED_PAYOFF_NEEDS_OFFICER", REVERSAL_CITATION, `the payoff was reversed ${r.state.reversed_on ?? ""}${r.state.fnma_liquidated_in_error_open ? " (fnma_liquidated_in_error open)" : ""}; release task ${row ? S(r.row!.data, "status") : "not opened"} — officer approval required to proceed`, { release_task_id: row?.id ?? null, reversal_event_id: r.state.reversal_event_id, task_status: row ? S(r.row!.data, "status") : null });
  return r.row;
}

/**
 * The module's event reactors (the pattern of ./section18-6.ts; wired wherever the app builds its unit of work, and by
 * 16-3.spec.test.ts on its bus): 16.2's `loan.paid_in_full` opens the release task itself so STATE_LIEN_RELEASE_DEADLINE
 * and the state clocks arm on the payoff with no agent action (a loan whose state is on neither the event nor the
 * `loans`/`properties` rows gets an ops escalation and `lien_release.task_open_failed` instead), and `payoff.reversed`
 * voids / attorney-routes every task of the loan at once (reconcileReversal). Returns the unsubscribe function.
 */
export function releaseReactors_16_3(deps: { events: EventStore; timers?: TimerEngine | null; store: EntityStore; escalations: EscalationService }): () => void {
  const rx = (now: string): Rx => ({ events: deps.events, timers: deps.timers ?? null, store: deps.store, escalations: deps.escalations, actor: SYSTEM, now });
  const offPaid = deps.events.subscribe("loan.paid_in_full", (e) => {
    const loanId = e.loanId ?? ""; const payoffOn = String(e.payload.payoff_date ?? e.payload.payoff_on ?? "");
    if (loanId && deps.store.list("release_tasks", (d) => d.loan_id === loanId && d.payoff_on === payoffOn && d.status !== "void").length) return;   // the agent opened it first
    const f = factsFromPayoff(e, deps.store);
    if ("missing" in f) {
      const esc = deps.escalations.open({ kind: "sev2", ownerRole: "ops_analyst", ...(loanId ? { loanId } : {}), payload: { reason: `release task not opened from loan.paid_in_full: ${f.missing} is on neither the event nor the loan/property rows — open it with selectReleaseInstrument; STATE_LIEN_RELEASE_DEADLINE is unarmed until then`, source_event_id: e.id } }, SYSTEM);
      deps.events.append({ type: "lien_release.task_open_failed", ...(loanId ? { loanId } : {}), actor: SYSTEM, causationId: e.id, payload: { missing: f.missing, escalation_id: esc.id } });
      return;
    }
    openTask(f.facts, rx(e.occurredAt));
  });
  const offReversed = deps.events.subscribe("payoff.reversed", (e) => { for (const row of deps.store.list("release_tasks", (d) => d.loan_id === e.loanId)) reconcileReversal(row, rx(e.occurredAt)); });
  return () => { offPaid(); offReversed(); };
}

const REVERSED_NEEDS_OFFICER = needsRole("REVERSED_PAYOFF_NEEDS_OFFICER", REVERSAL_CITATION, (i) => flag(i, "payoff_reversed") || flag(i, "fnma_liquidated_in_error_open"), ["officer"], "the payoff is reversed or a liquidated-in-error correction is open");
const AGENT_NEVER_SIGNS = never("AGENT_NEVER_SIGNS", "16.3 guardrail: the agent never signs", (i) => flag(i, "sign") || flag(i, "execute") || str(i, "signer") === "agent" || str(i, "signing_officer_id") === "agent", "execution is a signing_officer act; the agent routes the package and records the platform's completion evidence");
const TEMPLATE_ONLY = never("TEMPLATE_ONLY", "docs/ARCHITECTURE.md: borrower-facing text only from templates", (i) => typeof i.body === "string" || typeof i.free_text === "string", "render the registered template; no free text to the borrower");
const NO_BORROWER_CHARGE_OUTSIDE_C1205 = never("NO_BORROWER_CHARGE_OUTSIDE_C1205", "16.3 guardrail: no borrower charge outside C-1.2-05", (i) => flag(i, "charge_borrower") && !releaseFeePosting({ state: str(i, "state") || "XX", fee_cents: cents(i.fee_cents), fee_kind: (str(i, "fee_kind") || "recording") as "recording", disclosed_on_statement: flag(i, "disclosed_on_statement"), permitted_by_security_instrument: flag(i, "permitted_by_security_instrument"), c1205_conditions: flag(i, "c1205_conditions"), payoff_on: D("2000-01-01") }).chargeable, "the four C-1.2-05 conditions, the security instrument, the state cap and the payoff-statement disclosure must all hold");

export const TOOLS_16_3: readonly ToolDef[] = defineTools("16.3", AGENT, [
  // rule 1 / inputs — `loan.paid_in_full` → open the release task: instrument, mortgagee of record and signatory path from the title chain; the state-keyed clocks arm from `lien_release.task_opened` (an already auto-opened task is refreshed: `lien_release.task_updated`)
  { name: "selectReleaseInstrument", kind: "act", handler: compute((i, ctx, rt) => {
      const f = factsFromInput(i, rt);
      assertPayoffStands(null, f.loan_id, ctx, rt, "selectReleaseInstrument");
      const o = openTask(f, rxOf(ctx, rt)); const rec = o.rec; const sel = o.sel!;
      return { release_task_id: rec.id, ...sel, task: o.opened, created: o.created, lpoa: sel.mortgagee_of_record === "fannie_mae" ? lpoaGate(f.state, f.lpoas) : null, escalation_id: o.escalation_id, md_delivery_anchor: rec.data.md_delivery_anchor, funds_anchor_basis: rec.data.funds_anchor_basis }; }),
    guardrails: [REVERSED_NEEDS_OFFICER] },
  // rule 2 — Form 2009 to the document custodian on payoff day when originals are required; op=received ingests the custodian's return
  { name: "requestCustodyDocuments", kind: "act", handler: compute(async (i, ctx, rt) => {
      if (str(i, "op") === "received") { need(i, "custody_request_id", "received_on");
        const row = rt.store.require("custody_requests", str(i, "custody_request_id")); const loanId = loanOf(i, ctx, row); const receivedOn = date(i, "received_on");
        const rec = rt.store.put("custody_requests", row.id, { status: "received", received_at: ctx.now, received_on: receivedOn }, ctx.actor, ctx.now);
        for (const t of rt.store.list("release_tasks", (d) => d.loan_id === loanId && d.status === "awaiting_custody_docs")) rt.store.put("release_tasks", t.id, { status: "opened", custody_request_id: rec.id, originals_received_on: receivedOn }, ctx.actor, ctx.now);
        ctx.events.append({ type: "custody.documents.received", loanId, actor: ctx.actor, payload: { custody_request_id: rec.id, received_on: receivedOn, documents: rec.data.documents_requested } });
        return { custody_request_id: rec.id, status: "received", received_on: receivedOn }; }
      need(i, "loan_id", "state", "payoff_on");
      assertPayoffStands(str(i, "release_task_id") ? rt.store.get("release_tasks", str(i, "release_task_id")) ?? null : null, str(i, "loan_id"), ctx, rt, "requestCustodyDocuments");
      const sentOn = today(i, ctx);
      const r = custodyRequest({ state: str(i, "state"), payoff_on: date(i, "payoff_on"), original_note_required: flag(i, "original_note_required"), borrower_requested_note: flag(i, "borrower_requested_note"), recorder_requires_original: flag(i, "recorder_requires_original"), sent_on: sentOn });
      if (!r.required) return { ...r, requested: false };
      const custodian = rt.ports.custodian; const sent = custodian ? await custodian.requestDocuments(str(i, "fnma_loan_number") || str(i, "loan_id"), "2009", r.documents, ctx.now) : null;
      const rec = rt.store.put("custody_requests", str(i, "id") || `cr-${str(i, "loan_id")}-${sentOn}`, { loan_id: str(i, "loan_id"), custodian_id: str(i, "custodian_id") || null, form: "2009", documents_requested: r.documents, sent_at: ctx.now, sent_on: sentOn, status: "requested", custodian_request_id: sent?.requestId ?? null, expected_by: sent?.expectedBy ?? r.return_monitor_by }, ctx.actor, ctx.now);
      if (str(i, "release_task_id") && rt.store.get("release_tasks", str(i, "release_task_id"))) rt.store.put("release_tasks", str(i, "release_task_id"), { custody_request_id: rec.id }, ctx.actor, ctx.now);
      ctx.events.append({ type: "custody.documents.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { custody_request_id: rec.id, form: "2009", documents: r.documents, sent_at: sentOn, sent_on_time: r.sent_on_time, return_monitor_by: r.return_monitor_by } });
      return { ...r, requested: true, custody_request_id: rec.id, sent_on: sentOn }; }) },
  // rule 1(a)/3 — template merge into the unsigned instrument (`documents`, hashed); discrepancies are resolved against the recorded image and flagged, never invented
  { name: "draftReleaseInstrument", kind: "act", handler: compute((i, ctx, rt) => { need(i, "release_task_id", "borrower_names", "property_address", "original_recording_reference", "original_recording_date");
      const row = taskRow(i, ctx, rt, "draftReleaseInstrument"); const loanId = loanOf(i, ctx, row); const d = row.data;
      if (d.selection_pending === true) refuse(ctx, loanId, "draftReleaseInstrument", "SELECTION_PENDING", "16.3 rule 1: instrument and signatory selection precedes drafting", "the task was opened from the payoff event without a mortgagee of record; run selectReleaseInstrument first", { release_task_id: row.id });
      const inst = draftInstrument(selectionOf(d), { state: S(d, "state"), county: str(i, "county") || S(d, "county") || "", borrower_names: i.borrower_names as string[], property_address: str(i, "property_address"), apn: str(i, "apn") || null, original_recording_reference: str(i, "original_recording_reference"), original_recording_date: date(i, "original_recording_date"), legal_description: str(i, "legal_description") || null, original_lender: str(i, "original_lender") || "the original lender", partner_name: str(i, "partner_name") || "the partner", return_to: str(i, "return_to") || "Supermortgage, Lien Release, PO Box 1, Testville TX 75001" });
      const doc = putDocument(rt, ctx, loanId, "release_instrument_unsigned", inst.text, { release_task_id: row.id, instrument_type: d.instrument_type, legal_description_source: str(i, "legal_description_source") || "recorded_instrument_image", discrepancies_flagged: (i.discrepancies as unknown[] | undefined) ?? [] });
      rt.store.put("release_tasks", row.id, { document_id: doc.id, instrument_sha256: doc.sha256, drafted_at: ctx.now }, ctx.actor, ctx.now);
      ctx.events.append({ type: "lien_release.drafted", loanId, actor: ctx.actor, payload: { release_task_id: row.id, document_id: doc.id, sha256: doc.sha256, recites_min: inst.recites_min, recites_fnma_loan_number: inst.recites_fnma_loan_number, discrepancies: (i.discrepancies as unknown[] | undefined) ?? [] } });
      return { release_task_id: row.id, document_id: doc.id, ...inst }; }),
    guardrails: [never("NEVER_INVENT", "16.3 Agents: the LLM may resolve name/legal-description discrepancies against the recorded instrument image and flag, never invent", (i) => flag(i, "invented") || /^(model|llm|inferred|generated)$/i.test(str(i, "legal_description_source")) || /^(model|llm|inferred|generated)$/i.test(str(i, "borrower_names_source")), "transcribe from the recorded instrument image and flag the discrepancy"), REVERSED_NEEDS_OFFICER] },
  // rule 3 — machine-checked content checklist, persisted on the task; a pass moves the task to `prepared` and emits `lien_release.prepared`
  { name: "runReleaseChecklist", kind: "write", handler: compute((i, ctx, rt) => { need(i, "release_task_id");
      const row = taskRow(i, ctx, rt, "runReleaseChecklist"); const loanId = loanOf(i, ctx, row);
      const r = releaseChecklist({ present: ((i.present as Partial<Record<ChecklistItem, boolean>> | undefined) ?? {}), county_requires_legal_description: flag(i, "county_requires_legal_description"), mers: i.mers === undefined ? S(row.data, "mortgagee_of_record") === "mers" : flag(i, "mers") });
      const held = S(row.data, "status") === "held";
      const rec = rt.store.put("release_tasks", row.id, { checklist: { ...r, checked_at: ctx.now }, ...(r.passed ? { prepared_at: ctx.now, ...(held ? {} : { status: "prepared" }) } : {}) }, ctx.actor, ctx.now);
      if (r.passed) ctx.events.append({ type: "lien_release.prepared", loanId, actor: ctx.actor, payload: { release_task_id: row.id, signatory_path: S(row.data, "signatory_path") || null, prepared_at: ctx.now, checklist_passed: true } });
      return { release_task_id: row.id, ...r, status: S(rec.data, "status") }; }),
    guardrails: [never("CHECKLIST_IS_MACHINE_CHECKED", "16.3 rule 3: the content checklist is machine-checked before execution", (i) => flag(i, "force_pass") || flag(i, "override_failed_items"), "an item passes only on the instrument's content, never by assertion")] },
  // rule 4 / T5 / T12 — the package goes to the signing_officer (or SF CPM / partner) only on the persisted checklist pass and payoff evidence; the LPOA gate reads `lpoas`; the agent never signs
  { name: "routeForExecution", kind: "act", handler: compute((i, ctx, rt) => { need(i, "release_task_id");
      const row = taskRow(i, ctx, rt, "routeForExecution"); const loanId = loanOf(i, ctx, row); const d = row.data; const op = str(i, "op") || "route";
      if (op === "title_review_cleared") { rt.store.put("release_tasks", row.id, { review_cleared_at: ctx.now, review_cleared_by: `${ctx.actor.kind}:${ctx.actor.id}`, status: (d.checklist as { passed?: boolean } | undefined)?.passed ? "prepared" : "opened" }, ctx.actor, ctx.now); ctx.events.append({ type: "lien_release.review_cleared", loanId, actor: ctx.actor, payload: { release_task_id: row.id } }); return { release_task_id: row.id, status: "opened" }; }
      if (op === "fnma_returned") { need(i, "returned_on", "executed_document");
        const doc = putDocument(rt, ctx, loanId, "release_instrument_executed", str(i, "executed_document"), { release_task_id: row.id, executed_by: "fannie_mae_sf_cpm" }); const returnedOn = date(i, "returned_on");
        rt.store.put("release_tasks", row.id, { executed_at: returnedOn, executed_document_id: doc.id, executed_document_sha256: doc.sha256, notarized_at: returnedOn, status: "notarized" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "fnma.execution.returned", loanId, actor: ctx.actor, payload: { release_task_id: row.id, returned_on: returnedOn, document_id: doc.id } });
        ctx.events.append({ type: "lien_release.executed", loanId, actor: ctx.actor, payload: { release_task_id: row.id, signatory_path: "fnma_execution", executed_at: returnedOn, executed_document_sha256: doc.sha256 } });
        return { release_task_id: row.id, status: "notarized", executed_at: returnedOn, document_id: doc.id }; }
      const checklist = d.checklist as { passed?: boolean } | undefined;
      const cmd = executionCommand({ checklist_passed: checklist?.passed === true, payoff_evidence_document_id: (d.payoff_evidence_document_id as string | null | undefined) ?? null, actor: `${ctx.actor.kind}:${ctx.actor.id}`, attempted_at: ctx.now, agent_signs: flag(i, "sign"), hold_reason: S(d, "hold_reason") || (S(d, "status") === "held" ? "held" : null), review_cleared: !!d.review_cleared_at });
      if (!cmd.accepted) refuse(ctx, loanId, "routeForExecution", cmd.refusal.code, cmd.refusal.citation, cmd.refusal.reason, { release_task_id: row.id, checklist_passed: checklist?.passed ?? null, payoff_evidence_document_id: d.payoff_evidence_document_id ?? null });
      let path = (S(d, "signatory_path") || str(i, "signatory_path")) as SignatoryPath;
      const pkg = { release_task_id: row.id, payoff_evidence_document_id: S(d, "payoff_evidence_document_id"), authority_certificate_id: (i.authority_certificate_id as string | undefined) ?? null, instrument_document_id: (d.document_id as string | null | undefined) ?? null, recorder_rules: (i.recorder_rules as unknown) ?? null };
      let gateClosed: string | null = null;
      if (path === "lpoa_attorney_in_fact") {
        const g = lpoaGate(S(d, "state"), lpoaRows(i, rt.store));
        ctx.events.append({ type: "lien_release.execution_requested", loanId, actor: ctx.actor, payload: { release_task_id: row.id, signatory_path: path, path: "lpoa", lpoa_status: g.lpoa_status } });
        try { assertGate("16.3.lpoaRecordedForState", g.facts); } catch (e) { gateClosed = (e as Error).message; path = "fnma_execution"; }
      }
      if (path === "fnma_execution") {
        const f = fnmaExecutionPackage({ state: S(d, "state"), prepared_on: optDate(i, "prepared_on") ?? (d.prepared_at ? D(String(d.prepared_at).slice(0, 10)) : today(i, ctx)), lpoa_recorded: false, original_required: flag(i, "original_required"), fnma_loan_number: S(d, "fnma_loan_number") || str(i, "fnma_loan_number"), sent_on: today(i, ctx) });
        const msg = rt.store.put("integration_messages", `sfcpm-${row.id}-${ctx.now}`, { channel: f.channel, to: f.to, reason: f.reason, package: f.package, release_task_id: row.id, sent_at: ctx.now, follow_up_by: f.follow_up_by }, ctx.actor, ctx.now);
        rt.store.put("release_tasks", row.id, { status: "sent_to_fnma", signatory_path: "fnma_execution", sent_to_fnma_at: ctx.now, lpoa_gate_open: false }, ctx.actor, ctx.now);
        ctx.events.append({ type: "lien_release.sent_for_execution", loanId, actor: ctx.actor, payload: { path: "fnma", release_task_id: row.id, message_id: msg.id, sent_at: today(i, ctx), follow_up_by: f.follow_up_by, channel: f.channel } });
        return { release_task_id: row.id, status: "sent_to_fnma", blocked_by_gate: gateClosed !== null, gate_reason: gateClosed, ...f, message_id: msg.id };
      }
      ctx.events.append({ type: cmd.event.type, loanId, actor: ctx.actor, payload: { release_task_id: row.id, signatory_path: path, path: path === "mers_signing_officer" ? "mers" : path === "partner_officer" ? "partner" : "lpoa" } });
      const esc = rt.escalations.open({ kind: "signing_officer", loanId, payload: { ...pkg, signatory_path: path, reason: cmd.escalation.reason } }, ctx.actor);
      const partner = path === "partner_officer" ? rt.escalations.open({ kind: "officer", loanId, payload: { ...pkg, reason: "partner-executed document" } }, ctx.actor) : null;
      const status = path === "partner_officer" ? "sent_to_partner" : "awaiting_execution";
      rt.store.put("release_tasks", row.id, { status, execution_requested_at: ctx.now, signing_officer_escalation_id: esc.id }, ctx.actor, ctx.now);
      return { release_task_id: row.id, status, escalation_id: esc.id, partner_escalation_id: partner?.id ?? null, package: pkg }; }),
    guardrails: [AGENT_NEVER_SIGNS, REVERSED_NEEDS_OFFICER,
      never("HOLD_UNTIL_TITLE_REVIEW", "16.3 guardrail: confidence < 0.9 on mortgagee-of-record → hold and attorney/title review before deadline − 15 days", (i) => ((typeof i.confidence === "number" && num(i, "confidence") < 0.9) || (typeof i.mortgagee_confidence === "number" && num(i, "mortgagee_confidence") < 0.9)) && !flag(i, "title_review_cleared"), "the attorney/title review must clear the mortgagee of record first (op=title_review_cleared by the attorney or officer)"),
      needsRole("TITLE_REVIEW_CLEARED_BY_HUMAN", "16.3 guardrail: attorney/title review clears a held task", (i) => str(i, "op") === "title_review_cleared", ["attorney", "officer"], "only the attorney or officer clears a title-review hold")] },
  // rule 4 — wet-ink or e-sign; in-person or RON per the recording state's rules; op=completed records the platform's execution and notarization evidence (`documents`)
  { name: "scheduleNotarySession", kind: "act", handler: compute((i, ctx, rt) => { need(i, "release_task_id", "recording_state");
      const row = taskRow(i, ctx, rt, "scheduleNotarySession"); const loanId = loanOf(i, ctx, row); const d = row.data;
      if (str(i, "op") === "completed") { need(i, "signing_officer_id", "audit_trail", "executed_document");
        const officer = rt.store.get("signing_officers", str(i, "signing_officer_id")); const on = today(i, ctx);
        const authorityOk = officer ? (!officer.data.valid_to || String(officer.data.valid_to) >= on) && String(officer.data.valid_from ?? "0000-01-01") <= on : null;
        if (authorityOk === false) refuse(ctx, loanId, "scheduleNotarySession", "SIGNING_AUTHORITY_EXPIRED", "16.3 rule 4: the signing_officer signs under a valid resolution/LPOA authority", `signing officer ${str(i, "signing_officer_id")} authority is outside its validity window`, { release_task_id: row.id });
        const audit = putDocument(rt, ctx, loanId, "notary_audit_trail", str(i, "audit_trail"), { release_task_id: row.id, fields: ["signer_identity", "ip", "timestamps", "notary_journal"] });
        const exec = putDocument(rt, ctx, loanId, "release_instrument_executed", str(i, "executed_document"), { release_task_id: row.id, signing_officer_id: str(i, "signing_officer_id") });
        const session = (d.notary_session as Record<string, unknown> | undefined) ?? {}; const ron = session.mode === "ron";
        rt.store.put("release_tasks", row.id, { executed_at: on, notarized_at: on, ron, signing_officer_id: str(i, "signing_officer_id"), executed_document_id: exec.id, executed_document_sha256: exec.sha256, notary_audit_trail_document_id: audit.id, authority_verified: authorityOk, status: "notarized", notary_session: { ...session, status: "completed" } }, ctx.actor, ctx.now);
        ctx.events.append({ type: "lien_release.executed", loanId, actor: ctx.actor, payload: { release_task_id: row.id, signatory_path: S(d, "signatory_path"), executed_at: on, signing_officer_id: str(i, "signing_officer_id"), executed_document_sha256: exec.sha256 } });
        ctx.events.append({ type: "lien_release.notarized", loanId, actor: ctx.actor, payload: { release_task_id: row.id, notarized_at: on, ron, audit_trail_document_id: audit.id } });
        return { release_task_id: row.id, status: "notarized", executed_at: on, notarized_at: on, ron, executed_document_id: exec.id, audit_trail_document_id: audit.id, authority_verified: authorityOk }; }
      const ron = flag(i, "ron") && flag(i, "ron_accepted"); const esign = flag(i, "esign") && flag(i, "esign_accepted");
      const session = { recording_state: str(i, "recording_state"), mode: ron ? "ron" : "in_person", signature: esign ? "esign" : "wet_ink", signing_officer_id: str(i, "signing_officer_id") || null, scheduled_for: str(i, "scheduled_for") || null, audit_trail: ["signer_identity", "ip", "timestamps", "notary_journal"], status: "scheduled" };
      rt.store.put("release_tasks", row.id, { notary_session: session, ron }, ctx.actor, ctx.now);
      ctx.events.append({ type: "notarization.scheduled", loanId, actor: ctx.actor, payload: { release_task_id: row.id, mode: session.mode, signature: session.signature } });
      return { release_task_id: row.id, ...session }; }),
    guardrails: [never("RECORDING_STATE_RON_RULES", "16.3 rule 4: RON/e-sign per jurisdiction_rules.release.ron_accepted/esign_accepted for the recording state", (i) => (flag(i, "ron") && i.ron_accepted === false) || (flag(i, "esign") && i.esign_accepted === false), "the recording state or county does not accept that mode; use in-person / wet-ink"), AGENT_NEVER_SIGNS] },
  // rule 5 / rule 6 / rule 7 — eRecord where covered, else the paper package through print-mail with a positive-pay fee check (fee posted to the ledger under C-1.2-05); op=recorded hashes the recorded image; trustee and settlement-agent deliveries require evidence and close the statutory duty where the statute is satisfied by delivery
  { name: "submitRecording", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "release_task_id");
      const row = taskRow(i, ctx, rt, "submitRecording"); const loanId = loanOf(i, ctx, row); const d = row.data; const op = str(i, "op") || "record"; const now = today(i, ctx); const state = S(d, "state") || str(i, "state");
      const dutyEvent = statutoryDutyEvent(state); const cite = releaseRule(state).cite;
      const statutoryTimer = () => { const t = ctx.timers.forSubject("loan", loanId).filter((x) => x.code === "STATE_LIEN_RELEASE_DEADLINE").at(-1); return t ? { id: t.id, status: t.status } : null; };
      if (op === "trustee_delivery") { need(i, "delivery_evidence_document_id");
        if (!d.executed_at) refuse(ctx, loanId, "submitRecording", "EXECUTED_FIRST", "16.3 state machine: `delivered_to_trustee` follows `executed`", "the request for full reconveyance must be executed before delivery", { release_task_id: row.id });
        const closes = dutyEvent === "lien_release.delivered_to_trustee";
        rt.store.put("release_tasks", row.id, { status: "delivered_to_trustee", delivered_to_trustee_on: now, delivery_evidence_document_id: str(i, "delivery_evidence_document_id"), statute_satisfied_by_delivery: closes, ...(closes ? { statutory_duty_satisfied_on: now, statutory_duty_satisfied_by: "delivery_to_trustee" } : {}) }, ctx.actor, ctx.now);
        // Cal. Civ. Code §2941(b)(1)(A): the beneficiary's 30-day duty is delivery of the note, DOT and reconveyance request to the trustee — the statutory clock closes here; the trustee's 21 days run on CA_CC2941_TRUSTEE_RECORD_21
        ctx.events.append({ type: "lien_release.delivered_to_trustee", loanId, actor: ctx.actor, payload: { release_task_id: row.id, state, delivered_on: now, evidence_document_id: str(i, "delivery_evidence_document_id"), contents: ["original_note", "original_deed_of_trust", "request_for_full_reconveyance"], statutory_duty: closes ? "satisfied" : "pending", cite } });
        return { release_task_id: row.id, status: "delivered_to_trustee", delivered_on: now, trustee_record_by: 21, statutory_duty: closes ? "satisfied" : "pending", statutory_timer: statutoryTimer() }; }
      if (op === "settlement_agent_delivery") { need(i, "delivery_evidence_document_id");
        if (!d.executed_at || !d.notarized_at) refuse(ctx, loanId, "submitRecording", "EXECUTED_AND_NOTARIZED_FIRST", "16.3 state machine: delivery follows `notarized`", "the release must be executed and notarized before delivery to the settlement agent", { release_task_id: row.id });
        const byDelivery = dutyEvent === "lien_release.delivered";
        rt.store.put("release_tasks", row.id, { status: "delivered", delivered_on: now, delivery_evidence_document_id: str(i, "delivery_evidence_document_id"), statute_satisfied_by_delivery: byDelivery, ...(byDelivery ? { statutory_duty_satisfied_on: now, statutory_duty_satisfied_by: "delivery_to_settlement_agent" } : {}) }, ctx.actor, ctx.now);
        // MA G.L. c.183 §55 / Md. Real Prop. §7-106: delivery with evidence satisfies the statute — the engine satisfies STATE_LIEN_RELEASE_DEADLINE on this event (registry: "or `delivered` where the statute is satisfied by delivery"); recording stays monitored
        ctx.events.append({ type: "lien_release.delivered", loanId, actor: ctx.actor, payload: { release_task_id: row.id, state, to: "settlement_agent", delivered_on: now, evidence_document_id: str(i, "delivery_evidence_document_id"), statute_satisfied_by_delivery: byDelivery, statutory_duty: byDelivery ? "satisfied" : "pending", cite } });
        // WE3: "the agent records it" — the executed original handed to the disbursing agent is the submission for recording; SM_RECORDING_CONFIRM_30 monitors from delivery (+30 → 11/20 for a 10/21 delivery)
        ctx.events.append({ type: "lien_release.submitted", loanId, actor: ctx.actor, payload: { release_task_id: row.id, submission_id: null, channel: "settlement_agent", attempt: Number(d.attempts ?? 0) + 1, resubmission: false, submitted_at: now, submitted_on: now, state, tracked_by: "delivery_evidence", tracking_id: str(i, "delivery_evidence_document_id") } });
        return { release_task_id: row.id, status: "delivered", to: "settlement_agent", delivered_on: now, statute_satisfied_by_delivery: byDelivery, statutory_duty: byDelivery ? "satisfied" : "pending", statutory_timer: statutoryTimer() }; }
      if (op === "recorded" || op === "trustee_recorded") { need(i, "recording_reference", "recorded_on", "recorded_image");
        const rr = recordedRelease({ state, recorded_on: date(i, "recorded_on"), recording_reference: str(i, "recording_reference"), image: str(i, "recorded_image"), deadline_at: D(S(d, "deadline_at")), via: op === "trustee_recorded" ? "trustee" : ((str(i, "via") || "erecord") as "erecord") });
        const doc = putDocument(rt, ctx, loanId, "recorded_release_image", str(i, "recorded_image"), { release_task_id: row.id, recording_reference: rr.event.payload.recording_reference, recorded_at: rr.event.payload.recorded_at });
        if (str(i, "submission_id") && rt.store.get("recording_submissions", str(i, "submission_id"))) rt.store.put("recording_submissions", str(i, "submission_id"), { status: "recorded", recorded_at: rr.event.payload.recorded_at, recording_reference: rr.event.payload.recording_reference, image_document_id: doc.id }, ctx.actor, ctx.now);
        rt.store.put("release_tasks", row.id, { status: rr.status, recorded_at: rr.event.payload.recorded_at, recording_reference: rr.event.payload.recording_reference, recorded_document_id: doc.id, recorded_image_sha256: rr.recorded_image_sha256, days_late: rr.days_late, ...(d.statutory_duty_satisfied_on ? {} : { statutory_duty_satisfied_on: rr.event.payload.recorded_at, statutory_duty_satisfied_by: "recording" }) }, ctx.actor, ctx.now);
        if (op === "trustee_recorded") ctx.events.append({ type: "trustee.reconveyance.recorded", loanId, actor: ctx.actor, payload: { release_task_id: row.id, state, recorded_at: rr.event.payload.recorded_at, recording_reference: rr.event.payload.recording_reference } });
        ctx.events.append({ type: rr.event.type, loanId, actor: ctx.actor, payload: { ...rr.event.payload, release_task_id: row.id, recorded_document_id: doc.id, statutory_duty: "satisfied", cite } });
        return { release_task_id: row.id, ...rr, recorded_document_id: doc.id, statutory_timer: statutoryTimer() }; }
      // op=record: submit to the recorder (eRecord or paper); fee posting under C-1.2-05 (rule 7) to the ledger; the paper package via print-mail with a positive-pay fee check, tracked by barcode (rule 5 / T8)
      if (!d.executed_at || !d.notarized_at) refuse(ctx, loanId, "submitRecording", "EXECUTED_AND_NOTARIZED_FIRST", "16.3 state machine: `submitted` follows `notarized`", "the instrument must be executed and notarized before submission", { release_task_id: row.id, executed_at: d.executed_at ?? null, notarized_at: d.notarized_at ?? null });
      const county = S(d, "county") || str(i, "county"); const payoffOn = D(S(d, "payoff_on")); const deadlineAt = D(S(d, "deadline_at"));
      const pages = Number(i.pages ?? 2);
      const fee = i.fee_cents !== undefined && i.fee_cents !== null && i.fee_cents !== "" ? cents(i.fee_cents) : recorderFee({ state, pages }).fee_cents;
      const posting = releaseFeePosting({ state, fee_cents: fee, fee_kind: (str(i, "fee_kind") || "recording") as "recording", disclosed_on_statement: flag(i, "disclosed_on_statement"), permitted_by_security_instrument: flag(i, "permitted_by_security_instrument"), c1205_conditions: flag(i, "c1205_conditions"), payoff_on: payoffOn, ...(typeof i.fee_pass_through_allowed === "boolean" ? { fee_pass_through_allowed: i.fee_pass_through_allowed } : {}), ...(i.borrower_collected_cents !== undefined ? { borrower_collected_cents: cents(i.borrower_collected_cents) } : {}) });
      if (flag(i, "charge_borrower") && !posting.chargeable) refuse(ctx, loanId, "submitRecording", "NO_BORROWER_CHARGE_OUTSIDE_C1205", "16.3 guardrail: no borrower charge outside C-1.2-05", "the fee is not chargeable to the borrower; it posts to corporate expense", { release_task_id: row.id });
      const requested = ctx.events.append({ type: "fee.posting_requested", loanId, actor: ctx.actor, payload: { ...posting.event.payload, release_task_id: row.id, postings: posting.postings } });
      // Outputs "Ledger": Dr recording_fee_payable / Cr corporate_cash (borrower-funded) or Dr release_recording_expense (corporate; F-1-05 claim receivable where eligible) — booked as one balanced set before `fee.posted`
      const set = fee > 0n ? ctx.ledger.post(ledgerEntrySet(posting.postings, { loan_id: loanId, effective_on: now, description: `16.3 ${posting.event.payload.kind} ${state}${county ? ` ${county}` : ""} ${row.id}: ${posting.charge_target === "borrower" ? "borrower-funded (C-1.2-05)" : `corporate expense${posting.f105_claim ? " with F-1-05 claim" : ""}`}`, source_event_id: requested.id }), ctx.now) : null;
      if (set) ctx.events.append({ type: "fee.posted", loanId, actor: ctx.actor, payload: { ...posting.event.payload, release_task_id: row.id, ledger_set_id: set.id, postings: posting.postings, f105_claim: posting.f105_claim } });
      const er = rt.ports.erecording; const covered = er ? await er.countyCovered(state, county) : flag(i, "erecord_covered");
      const plan = recordingSubmission({ payoff_on: payoffOn, deadline_at: deadlineAt, erecord_covered: covered, secondary_covered: flag(i, "secondary_covered"), fee_cents: fee, submitted_on: now, today: now });
      const attempt = Math.max(1, Number(i.attempt ?? (Number(d.attempts ?? 0) + 1))); const sid = str(i, "id") || `rs-${row.id}-${attempt}`;
      let vendor: { packageId: string; status: string } | null = null;
      if (er && plan.channel !== "paper_mail" && plan.channel !== "walk_in") { const p = await er.createPackage({ releaseTaskId: row.id, attempt, county, state, documentSha256: S(d, "executed_document_sha256") || str(i, "document_sha256") }, ctx.now); vendor = await er.submit(p.packageId, ctx.now); }
      let paper: ReturnType<typeof paperRecordingPackage> | null = null; let mail: { jobId: string; status: string } | null = null;
      if (plan.channel === "paper_mail") {
        const office = S(d, "recording_office_id") ? rt.store.get("recording_offices", S(d, "recording_office_id")) : undefined;
        paper = paperRecordingPackage({ submission_id: sid, recorder_name: str(i, "recorder_name") || S(office?.data, "name") || `${county || state} County Recorder`, recorder_address: str(i, "recorder_address") || S(office?.data, "address") || `${county || state} County Recorder, ${state}`, fee_cents: fee, pages, submitted_on: now });
        mail = await port(rt, "printMail").submit(paper.mail_job, ctx.now);
        // the fee check on positive pay (6.4 `outstanding_checks`; a paid check with no issued record is 6.4-T7's exception) — corporate-funded; the borrower's collection already sits in recording_fee_payable
        rt.store.put("outstanding_checks", paper.check.check_number, { ...paper.check, loan_id: loanId, release_task_id: row.id, submission_id: sid, purpose: "recording_fee", custodial_account_id: null, status: "outstanding", positive_pay_status: "issued_sent", mail_job_id: mail.jobId }, ctx.actor, ctx.now);
        ctx.events.append({ type: "disbursement.issued", loanId, actor: ctx.actor, payload: { instrument: "check", check_number: paper.check.check_number, amount_cents: fee, payee: paper.check.payee, positive_pay: true, purpose: "recording_fee", submission_id: sid, mail_job_id: mail.jobId } });
      }
      const tracking_id = vendor?.packageId ?? paper?.mail_tracking_barcode ?? (plan.channel === "walk_in" ? str(i, "local_agent_receipt_id") || null : null);
      const rec = rt.store.put("recording_submissions", sid, { release_task_id: row.id, channel: plan.channel, vendor_package_id: vendor?.packageId ?? null, pria_version: plan.channel === "paper_mail" || plan.channel === "walk_in" ? null : "2.4.2", submitted_at: ctx.now, submitted_on: now, status: "submitted", fees_cents: fee, fee_postings: posting.postings, fee_charge_target: posting.charge_target, fee_ledger_set_id: set?.id ?? null, f105_claim: posting.f105_claim, fee_check: paper ? { positive_pay: true, amount_cents: fee, check_number: paper.check.check_number } : null, package: plan.package, tracked_by: plan.tracked_by, tracking_id, mail_job_id: mail?.jobId ?? null, mail_job_status: mail?.status ?? null, mail_tracking_barcode: paper?.mail_tracking_barcode ?? null, attempt }, ctx.actor, ctx.now);
      rt.store.put("release_tasks", row.id, { status: "submitted", submitted_at: now, submission_id: rec.id, attempts: attempt }, ctx.actor, ctx.now);
      ctx.events.append({ type: "lien_release.submitted", loanId, actor: ctx.actor, payload: { release_task_id: row.id, submission_id: rec.id, channel: plan.channel, attempt, resubmission: attempt > 1, submitted_at: now, submitted_on: now, state, tracked_by: plan.tracked_by, tracking_id, statutory_deadline_unchanged: deadlineAt } });
      return { ...rec.data, submission_id: rec.id, plan, fee: posting, ledger_set_id: set?.id ?? null, vendor, mail, paper }; }),
    guardrails: [never("DELIVERY_NEEDS_EVIDENCE", "16.3 rule 6: delivery *with evidence* satisfies the timer (WE2 courier evidence; WE3 settlement-agent delivery evidence)", (i) => DELIVERY_OPS.includes(str(i, "op")) && !str(i, "delivery_evidence_document_id"), "attach the delivery-evidence document (courier receipt / settlement-agent acknowledgment)"), NO_BORROWER_CHARGE_OUTSIDE_C1205, REVERSED_NEEDS_OFFICER] },
  // rule 5 / T7 — fix within 2 BD; the statutory deadline never moves; repeated rejects to the attorney
  { name: "handleRecorderReject", kind: "act", handler: compute((i, ctx, rt) => { need(i, "release_task_id", "reject_code", "rejected_on");
      const row = taskRow(i, ctx, rt, "handleRecorderReject"); const loanId = loanOf(i, ctx, row); const d = row.data;
      const r = recorderReject({ rejected_on: date(i, "rejected_on"), reject_code: str(i, "reject_code"), deadline_at: D(S(d, "deadline_at")), prior_rejects: Number(i.prior_rejects ?? d.rejects ?? 0), attempt: Math.max(1, Number(i.attempt ?? d.attempts ?? 1)) });
      const sid = str(i, "submission_id") || S(d, "submission_id");
      if (sid && rt.store.get("recording_submissions", sid)) rt.store.put("recording_submissions", sid, { status: "rejected", reject_code: str(i, "reject_code"), reject_text: str(i, "reject_text") || null }, ctx.actor, ctx.now);
      rt.store.put("release_tasks", row.id, { status: "rejected", rejects: Number(d.rejects ?? 0) + 1, fix_by: r.fix_by }, ctx.actor, ctx.now);
      ctx.events.append({ type: "lien_release.rejected", loanId, actor: ctx.actor, payload: { release_task_id: row.id, submission_id: sid || null, reject_code: str(i, "reject_code"), rejected_on: date(i, "rejected_on"), fix_by: r.fix_by, deadline_at: r.deadline_at, resubmission_attempt: r.resubmission_attempt } });
      const esc = r.escalation ? rt.escalations.open({ kind: r.escalation.kind, loanId, ...(r.escalation.severity ? { severity: r.escalation.severity } : {}), payload: { reason: r.escalation.reason, release_task_id: row.id } }, ctx.actor) : null;
      return { release_task_id: row.id, ...r, escalation_id: esc?.id ?? null }; }) },
  // rule 8 — NTC_LIEN_RELEASE_RECORDED with the recorded image (the `documents` row the row names, enclosed); NJ right-to-demand (day count computed from the dates); eNote paper copy; note-return cover letter; op=note_return_requested starts the NY 45-day clock. State comes off the release task, never the caller.
  { name: "notifyBorrower", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "loan_id", "op"); const op = str(i, "op"); const loanId = str(i, "loan_id"); const on = today(i, ctx);
      const rid = str(i, "release_task_id"); const found = rid ? rt.store.get("release_tasks", rid) ?? null : null;
      const row = assertPayoffStands(found, loanId, ctx, rt, "notifyBorrower");
      const state = row ? S(row.data, "state") : str(i, "state") || "XX";
      if (op === "note_return_requested") { need(i, "requested_on"); ctx.events.append({ type: "lien_release.note_return_requested", loanId, actor: ctx.actor, payload: { state, requested_on: date(i, "requested_on"), requested_by: str(i, "requested_by") || "borrower", release_task_id: row?.id ?? null } }); return { state, requested_on: date(i, "requested_on"), timer: state === "NY" ? "NY_RPAPL1921_NOTE_RETURN_45" : null }; }
      const template = NOTICE_BY_OP[op]; if (!template) throw new RangeError(`op ${op} is not one of ${Object.keys(NOTICE_BY_OP).join("/")}/note_return_requested`);
      let enclosure: { document_id: string; sha256: string; kind: string } | null = null;
      if (op === "release_recorded") {
        // "with the recorded image": the enclosure is the `documents` row the release task recorded (kind recorded_release_image), never a caller's string
        const docId = str(i, "recorded_document_id") || S(row?.data, "recorded_document_id"); const doc = docId ? rt.store.get("documents", docId) : undefined;
        if (!doc || S(doc.data, "kind") !== "recorded_release_image" || (row && S(row.data, "recorded_document_id") && S(row.data, "recorded_document_id") !== docId)) refuse(ctx, loanId, "notifyBorrower", "RECORDED_IMAGE_REQUIRED", "16.3 rule 8: NTC_LIEN_RELEASE_RECORDED always carries the recorded image (FL §701.04(2) mandatory)", `no recorded_release_image document ${docId || "(none)"} for the task; record the release first (submitRecording op=recorded)`, { release_task_id: row?.id ?? null, recorded_document_id: docId || null });
        enclosure = { document_id: doc.id, sha256: S(doc.data, "sha256"), kind: "recorded_release_image" };
      }
      const recordedOn = op === "release_recorded" ? dateOf(row?.data, "recorded_at") ?? date(i, "recorded_on") : null;
      const plan = op === "release_recorded" ? borrowerNotification({ state, recorded_on: recordedOn!, consent_on_file: flag(i, "consent_on_file"), enote: flag(i, "enote"), note_requested_on: optDate(i, "note_requested_on"), note_received_on: optDate(i, "note_received_on") }) : op === "nj_cancellation_right" ? njCancellationNotice({ payoff_on: dateOf(row?.data, "payoff_on") ?? date(i, "payoff_on"), nonbank: true, fee_cents: cents(i.fee_cents), notice_date: on }) : null;
      const requestedOn = optDate(i, "requested_on"); const payoffOn = dateOf(row?.data, "payoff_on") ?? optDate(i, "payoff_on");
      const computed = op === "release_recorded" ? { recorded_image_attached: enclosure !== null, recorded_document_id: enclosure!.document_id, enclosures: [enclosure], state, florida: state === "FL", recorded_date: recordedOn, ...(S(row?.data, "recording_reference") ? { recording_reference: S(row?.data, "recording_reference") } : {}), ...(payoffOn ? { payoff_date: payoffOn } : {}) }
        : op === "nj_cancellation_right" ? { state, notice_date: on, payoff_date: payoffOn, days_after_payoff: daysBetween(payoffOn!, on), cancellation_fee_cents: cents(i.fee_cents) }
        : op === "note_returned" ? { state, notice_date: on, ...(requestedOn ? { requested_on: requestedOn, days_after_request: daysBetween(requestedOn, on) } : {}) } : { state, notice_date: on };
      const payload = { ...((i.payload as Record<string, unknown> | undefined) ?? {}), ...computed };
      const notice = await noticeOps("render_send")({ ...i, template_code: template, loan_id: loanId, payload }, ctx, rt);
      if (op === "note_returned" || op === "enote_paper_copy") ctx.events.append({ type: "lien_release.note_returned", loanId, actor: ctx.actor, payload: { state, template, marked: op === "enote_paper_copy" ? "Copy / Paid-In-Full" : "Paid in Full", returned_on: on, release_task_id: row?.id ?? null } });
      else ctx.events.append({ type: "lien_release.borrower_notified", loanId, actor: ctx.actor, payload: { state, template, notified_on: on, release_task_id: row?.id ?? null, ...(op === "release_recorded" ? { recorded_document_id: enclosure!.document_id, enclosure_document_ids: [enclosure!.document_id], florida: state === "FL" } : {}) } });
      if (row) rt.store.put("release_tasks", row.id, op === "release_recorded" ? { borrower_notified_at: on, status: "borrower_notified", borrower_notice_id: (notice as { id?: string }).id ?? null } : op === "note_returned" || op === "enote_paper_copy" ? { note_returned_at: on } : {}, ctx.actor, ctx.now);
      return { template, plan, payload: computed, notice, state, release_task_id: row?.id ?? null }; }),
    guardrails: [TEMPLATE_ONLY, never("RECORDED_IMAGE_REQUIRED", "16.3 rule 8: NTC_LIEN_RELEASE_RECORDED always carries the recorded image (FL §701.04(2) mandatory)", (i) => str(i, "op") === "release_recorded" && !str(i, "recorded_document_id") && !str(i, "release_task_id"), "name the release task (its recorded_document_id is enclosed) or the recorded instrument image document")] },
  // rule 9 — daily exposure for breached tasks off the persisted row and STATE_LIEN_RELEASE_DEADLINE's status (compliance-sentinel; officer informed); op=post books the row's computed exposure as corporate expense behind SM_RELEASE_PENALTY_NONPASS_GATE (F-1-09)
  { name: "computePenaltyExposure", kind: "act", handler: compute((i, ctx, rt) => { const op = str(i, "op") || "report"; const found = str(i, "release_task_id") ? rt.store.get("release_tasks", str(i, "release_task_id")) ?? null : null; const loanId = loanOf(i, ctx, found ?? undefined);
      const row = found ? reconcileReversal(found, rxOf(ctx, rt)).row : null; const d = row?.data;
      if (!row) need(i, "state", "deadline_at");
      const state = d ? S(d, "state") : str(i, "state"); const deadlineAt = d ? D(S(d, "deadline_at")) : date(i, "deadline_at");
      const ignored = d ? (["state", "deadline_at", "payoff_on", "satisfied_on"] as const).filter((k) => i[k] !== undefined && i[k] !== null && i[k] !== "" && String(i[k]) !== S(d, k === "deadline_at" ? "deadline_at" : k === "satisfied_on" ? "statutory_duty_satisfied_on" : k)) : [];
      const timerInst = ctx.timers.forSubject("loan", loanId).filter((t) => t.code === "STATE_LIEN_RELEASE_DEADLINE").at(-1) ?? null;
      if (op === "post") { need(i, "charge_target");
        // the amount is the row's computed exposure (rule 9); a different caller amount is a money-field waiver — officer only
        const rowCents = d ? cents(d.penalty_exposure_cents) : null; const given = i.penalty_cents !== undefined && i.penalty_cents !== null && i.penalty_cents !== "" ? cents(i.penalty_cents) : null;
        if (rowCents !== null && given !== null && given !== rowCents && !hasRole(ctx.actor, ["officer"])) refuse(ctx, loanId, "computePenaltyExposure", "PENALTY_AMOUNT_IS_COMPUTED", "16.3 rule 9 / CLAUDE.md: penalty_exposure_cents is computed from the matrix; money fields are waived by the officer only", `penalty_cents ${given} differs from the row's computed exposure ${rowCents}`, { release_task_id: row!.id });
        const penalty = rowCents !== null && (given === null || !hasRole(ctx.actor, ["officer"])) ? rowCents : (given ?? 0n);
        const pp = penaltyPosting({ state, penalty_cents: penalty, charge_target: str(i, "charge_target"), as_of: today(i, ctx) });
        const requested = ctx.events.append({ type: pp.event.type, loanId, actor: ctx.actor, payload: { ...pp.event.payload, release_task_id: row?.id ?? null } });
        if (!pp.allowed) refuse(ctx, loanId, "computePenaltyExposure", "SM_RELEASE_PENALTY_NONPASS_GATE", "F-1-09: the servicer must not pass on to the borrower or to Fannie Mae any penalty fee it has to pay for late release processing", pp.refusal ?? "refused", { release_task_id: row?.id ?? null });
        // Outputs "Ledger": penalties Dr release_penalty_expense / Cr corporate_cash — never to loan accounts; `fee.posted` (the gate's satisfying event) only after the set is booked
        const set = ctx.ledger.post(ledgerEntrySet(pp.postings, { loan_id: loanId, effective_on: today(i, ctx), description: `16.3 late-release penalty ${state} ${row?.id ?? loanId}: corporate expense (F-1-09)`, source_event_id: requested.id }), ctx.now);
        if (row) rt.store.put("release_tasks", row.id, { penalty_postings: [...((row.data.penalty_postings as unknown[] | undefined) ?? []), { as_of: today(i, ctx), postings: pp.postings, ledger_set_id: set.id, amount_cents: penalty }] }, ctx.actor, ctx.now);
        ctx.events.append({ type: "fee.posted", loanId, actor: ctx.actor, payload: { kind: "release_penalty", charge_target: "corporate_expense", amount_cents: penalty, postings: pp.postings, ledger_set_id: set.id, release_task_id: row?.id ?? null } });
        return { ...pp, posted: true, ledger_set_id: set.id, penalty_cents: penalty }; }
      if (d && (S(d, "status") === "void")) return { release_task_id: row!.id, breached: false, penalty_exposure_cents: 0n, attorney_fee_exposure: false, basis: `task void (payoff reversed ${S(d, "reversed_on")}): no release duty`, severity: null, timer: "STATE_LIEN_RELEASE_DEADLINE", timer_status: timerInst?.status ?? null, escalation_id: null, inputs_ignored: ignored };
      const satisfiedOn = d ? dateOf(d, "statutory_duty_satisfied_on") ?? dateOf(d, "recorded_at") ?? (S(d, "satisfied_by") === "delivery" ? dateOf(d, "delivered_on") : S(d, "satisfied_by") === "trustee_delivery" ? dateOf(d, "delivered_to_trustee_on") : null) : optDate(i, "satisfied_on");
      const noticeGivenOn = optDate(i, "notice_given_on") ?? dateOf(d, "penalty_notice_given_on"); const writtenRequestOn = optDate(i, "written_request_on") ?? dateOf(d, "penalty_written_request_on");
      const r = penaltyExposureReport({ state, payoff_on: d ? dateOf(d, "payoff_on") : optDate(i, "payoff_on"), deadline_at: deadlineAt, as_of: today(i, ctx), satisfied_on: satisfiedOn, notice_given_on: noticeGivenOn, written_request_on: writtenRequestOn, timer_breached: timerInst ? timerInst.status === "breached" || timerInst.status === "satisfied_late" : false });
      let escalationId: string | null = null;
      if (row) { const first = r.breached && !row.data.penalty_officer_notified_at; if (first) escalationId = rt.escalations.open({ kind: "officer", loanId, severity: "sev1", payload: { release_task_id: row.id, reason: `STATE_LIEN_RELEASE_DEADLINE breached ${r.days_late} day(s): exposure ${r.penalty_exposure_cents} (${r.basis}); corporate expense, never passed to the borrower or Fannie Mae (F-1-09)` } }, ctx.actor).id; rt.store.put("release_tasks", row.id, { penalty_exposure_cents: r.penalty_exposure_cents, penalty_exposure_as_of: today(i, ctx), penalty_exposure_basis: r.basis, ...(noticeGivenOn ? { penalty_notice_given_on: noticeGivenOn } : {}), ...(writtenRequestOn ? { penalty_written_request_on: writtenRequestOn } : {}), ...(r.breached && !["recorded", "trustee_recorded", "borrower_notified", "closed", "post_recording_reversal"].includes(S(row.data, "status")) ? { status: "penalty_exposure" } : {}), ...(first ? { penalty_officer_notified_at: ctx.now } : {}) }, ctx.actor, ctx.now); }
      return { ...r, release_task_id: row?.id ?? null, state, deadline_at: deadlineAt, satisfied_on: satisfiedOn, timer_status: timerInst?.status ?? null, escalation_id: escalationId, inputs_ignored: ignored }; }),
    decision: (i) => (str(i, "op") === "post" ? { action: "computePenaltyExposure:post", rationale: str(i, "rationale") || "late-release penalty booked as corporate expense (F-1-09)", subject: { kind: "release_task", id: str(i, "release_task_id") || "n/a" }, ruleCode: "F-1-09" } : null),
    guardrails: [guard("SM_RELEASE_PENALTY_NONPASS_GATE", "F-1-09: the servicer must not pass on to the borrower or to Fannie Mae any penalty fee it has to pay because it failed to process the release and satisfaction documents within the required time frame", (i) => { if (str(i, "op") !== "post") return undefined; try { assertGate("16.3.penaltyNeverPassedThrough", { penalty_charge_target: str(i, "charge_target") }); return undefined; } catch (e) { return (e as Error).message; } })] },
  // decision record: {release_task_id, state, county, instrument_type, mortgagee_of_record, signatory_path, evidence[], deadline_at, checklist_results, submission_channel, rationale, confidence}
  { name: "recordDecision", kind: "act", handler: compute((i, ctx) => { need(i, "release_task_id", "rationale");
      const evidence = Array.isArray(i.evidence) ? (i.evidence as string[]) : [];
      const record = { release_task_id: str(i, "release_task_id"), state: str(i, "state") || null, county: str(i, "county") || null, instrument_type: str(i, "instrument_type") || null, mortgagee_of_record: str(i, "mortgagee_of_record") || null, signatory_path: str(i, "signatory_path") || null, evidence, deadline_at: str(i, "deadline_at") || null, checklist_results: (i.checklist_results as unknown) ?? null, submission_channel: str(i, "submission_channel") || null, rationale: str(i, "rationale"), confidence: typeof i.confidence === "number" ? num(i, "confidence") : null };
      ctx.decide({ agent: AGENT, action: str(i, "action") || "release.decision", rationale: record.rationale, ruleSetVersion: str(i, "rule_set_version") || "16.3@tools.v1", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, subject: { kind: "release_task", id: record.release_task_id }, evidenceDocumentIds: evidence, ...(record.confidence !== null ? { confidence: record.confidence } : {}), ...(typeof i.rule_code === "string" ? { ruleCode: i.rule_code } : {}) });
      return { recorded: true, record }; }),
    decision: (i) => ({ action: "recordDecision", rationale: str(i, "rationale"), subject: { kind: "release_task", id: str(i, "release_task_id") }, evidenceDocumentIds: Array.isArray(i.evidence) ? (i.evidence as string[]) : [] }) },
]);
