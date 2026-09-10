/**
 * §13.1 operating paths over the pure calculators in ./gates.ts and ./ops.ts — the code that actually appends the
 * events the 13.1 timer rows arm on and are satisfied by:
 *
 * - `sweepDelinquencyCounters` — the daily `delinquency.counters.updated` (spec Inputs: "Daily … (00:05 loan timezone)
 *   recomputing `regx_days_delinquent`"; also re-run on `payment.applied/reversed`, `loan.boarded`, `loan_terms.activated`
 *   by `wireForeclosureGateReactors_13_1`). It projects `REGX_1024_41F1_120_DAY_GATE` (rule 1: open ⇔ days ≥ 121) and
 *   writes `foreclosure.gate.opened{code}` once on the 121st day and `foreclosure.gate.closed{code, reason}` when a full
 *   periodic payment moves the anchor (rule 2), each with its append-only `foreclosure_gate_evaluations` row.
 * - `assertGateOpen` — the 13.1 gate assertion the spec's satisfied column names for `foreclosure.refer` and
 *   `foreclosure.first_notice.authorize`: the 120-day gate (with the officer-recorded (f)(1)(ii)/(iii) exception ground,
 *   rule 4), the (f)(2) pre-filing application hold, the 1024.41(k)(2) reasonable-date gate, the state pre-foreclosure
 *   notice gate (NY §1304/§1306) and the "no second first notice" rule for a transfer-in (edge cases; T10).
 * - `referLoan` / `sendReferral` — the referral that satisfies `FNMA_E1202_NONPR_REFER_BY_120`: `foreclosure.referral.sent`
 *   with the `gates_snapshot` every referral message carries (Integrations), the `attorney_referrals` row and the
 *   E-1.2-02 record of the referral date on the case (`foreclosure_cases.referral_sent_at`).
 * - `authorizeFirstNotice` — `foreclosure.first_notice.authorized` (Outputs) or the refusal trail.
 * - `bankruptcyStayEnded` / `bankruptcyPetitionFiled` — the 14.x ingestion that projects `BK_362_STAY_GATE`: the gate
 *   closes on `bankruptcy.petition.filed` and opens on 14.x's `bankruptcy.stay.terminated{reason ∈ discharge, dismissal,
 *   362c3}` (a discharge with lien avoidance does not open it) or `bankruptcy.stay.relief_effective{foreclosure_blocked=false}`
 *   — "until relief/dismissal/discharge without lien avoidance" (timer table), emitted as
 *   `foreclosure.gate.opened{code=BK_362_STAY_GATE}` after validating the inbound record.
 * - `transferInForeclosureState` — a transfer-in whose transferor already made the first notice or filing carries it as
 *   `foreclosure.first_notice.filed` with evidence and sets the 7.1 statement flag from boarding (edge cases; T10).
 *
 * A refused command leaves its trail: the evaluation row, `foreclosure.gate.refused{command, code}` and the sev-1
 * Compliance Sentinel escalation (timer table breach column) — and nothing leaves for the attorney network (T8).
 */
import { type PlainDate, plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { gate120, regxDays, type GateState } from "./gates.ts";
import { gateSweep, exceptionGround, nyFirstNoticeGate, preFilingAppHold, transferredFirstFiling, refusedReferral } from "./ops.ts";

type Row = Record<string, unknown>;
export interface Record13 { readonly id: string; readonly data: Row }
/** Structural view of the app's EntityStore (src/app/tools.ts) so the domain never imports the app layer. */
export interface Store {
  get(kind: string, id: string): Record13 | undefined;
  put(kind: string, id: string, data: Row, by: Actor, now: string): Record13;
  list(kind: string, where?: (d: Row) => boolean): readonly Record13[];
}
export interface Escalations { open(input: { kind: "sev1" | "human_agent"; ownerRole?: string; loanId?: string; payload?: Row }, by: Actor): { id: string } }
export interface Deps { readonly events: EventStore; readonly store: Store; readonly escalations?: Escalations | undefined }
export interface At { readonly actor: Actor; readonly now: string }

export const GATE_120 = "REGX_1024_41F1_120_DAY_GATE";
export const GATE_F2 = "REGX_1024_41F2_PRE_FILING_APP_GATE";
export const GATE_K2 = "REGX_1024_41K2_NO_FIRST_FILING_GATE";
export const GATE_BK = "BK_362_STAY_GATE";
export const GATE_NY = "STATE_PREFC_NOTICE_GATE:NY";
export const GATE_FIRST_NOTICE_MADE = "FIRST_NOTICE_ALREADY_MADE";
export const RULE_SET_VERSION = "regx.lossmit.2013@13.1.ops.v1";
const GATE_AGENT: Actor = { kind: "system", id: "foreclosure-gates" };
export type Step = "refer" | "first_notice";
export type Ground = "default" | "due_on_sale" | "join_lienholder";

const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && v.length >= 10 ? D(v.slice(0, 10)) : null);
const dayOf = (now: string): PlainDate => D(now.slice(0, 10));
const loanRow = (d: Deps, loanId: string): Row => { const r = d.store.get("loans", loanId); if (!r) throw new RangeError(`no loans ${loanId}`); return r.data; };
const earliestUnpaid = (loan: Row): PlainDate | null => dateOf(loan.earliest_unpaid_due) ?? dateOf(loan.earliest_unpaid_due_date);
/** Rule 3: `loans.principal_residence` from origination occupancy — unknown or disputed ⇒ principal residence. */
export const principalResidence = (loan: Row): boolean => !(loan.principal_residence === false || loan.occupancy === "non_principal" || loan.occupancy_type === "investment" || loan.occupancy_type === "second_home");
const openCase = (d: Deps, loanId: string): Record13 | null => d.store.list("foreclosure_cases", (c) => c.loan_id === loanId && c.status !== "closed")[0] ?? null;
const loanEvents = (d: Deps, loanId: string, type: string): readonly DomainEvent[] => d.events.byLoan(loanId).filter((e) => e.type === type);
const lastGateEvent = (d: Deps, loanId: string, code: string): DomainEvent | null => d.events.byLoan(loanId).filter((e) => (e.type === "foreclosure.gate.opened" || e.type === "foreclosure.gate.closed") && e.payload.code === code).at(-1) ?? null;

/** One append-only `foreclosure_gate_evaluations` row (0015 shape: `result ∈ {open, closed}`, the four-state gate result and the evaluator ride in `reason_code`/`inputs`). */
function evaluation(d: Deps, at: At, loanId: string, gateCode: string, step: string, result: "open" | "closed", reasonCode: string | null, inputs: Row, evaluator: string | null): string {
  const n = d.store.list("foreclosure_gate_evaluations").length + 1;
  return d.store.put("foreclosure_gate_evaluations", `fge-${loanId}-${step}-${gateCode}-${at.now}-${n}`, { loan_id: loanId, case_id: openCase(d, loanId)?.id ?? null, gate_code: gateCode, step, evaluated_at: at.now, result, reason_code: reasonCode, inputs: { ...inputs, evaluator }, rule_set_version: RULE_SET_VERSION, command_id: null, decision_id: null }, at.actor, at.now).id;
}

// ============================================================ the daily counter sweep (trigger of REGX_1024_41F1_120_DAY_GATE)
export interface SweepResult {
  readonly loan_id: string; readonly today: PlainDate; readonly regx_days_delinquent: number; readonly earliest_unpaid_due: PlainDate | null; readonly principal_residence: boolean;
  readonly state: GateState; readonly opens_on: PlainDate | null; readonly entered_delinquency: boolean; readonly counters_event_id: string; readonly events: string[]; readonly evaluation_ids: string[];
}
/**
 * Rule 1/2: `regx_days_delinquent(today) = today − earliest_unpaid_periodic_due_date` (calendar days), gate open ⇔ ≥ 121;
 * the anchor is the loan row's (FIFO crediting by 2.1/2.2 moves it; suspense does not). Appends
 * `delinquency.counters.updated{entered_delinquency}` every run (the 120-day gate arms on the run that finds the loan
 * newly delinquent) and the gate transition events with their evaluation rows only when the projection changes — the
 * opening is emitted once (T1), the closing when the anchor moves (T2). Projections land on `loans` (data model).
 */
export function sweepDelinquencyCounters(d: Deps, i: { loan_id: string; today?: PlainDate } & At): SweepResult {
  const loan = loanRow(d, i.loan_id); const today = i.today ?? dayOf(i.now);
  const eu = earliestUnpaid(loan); const pr = principalResidence(loan); const days = regxDays(today, eu);
  const prev = loanEvents(d, i.loan_id, "delinquency.counters.updated").at(-1);
  const prevDays = prev ? Number(prev.payload.regx_days_delinquent ?? 0) : 0;
  // "loan enters delinquency" (timer table) for the §1024.41(f)(1) gate: newly delinquent, or — state machine "`not_applicable`
  // … transitions to `closed`/`open` if occupancy becomes principal residence" — a delinquent loan newly within 1024.30(c)(2) scope.
  const entered = days > 0 && (prevDays === 0 || (prev?.payload.non_principal_residence === true && pr));
  const last = lastGateEvent(d, i.loan_id, GATE_120);
  const previous: GateState | null = last ? (last.type === "foreclosure.gate.opened" ? "open" : "closed") : null;
  const sw = gateSweep({ today, earliest_unpaid_due: eu, principal_residence: pr, previous_state: previous });
  const scope = pr && loan.reverse_mortgage !== true;
  const projection = { regx_days_delinquent: days, regx_lossmit_scope: scope, fc_120_day_open_on: eu && scope ? addDays(eu, 121) : null, fc_referral_deadline_on: eu && !pr ? addDays(eu, 120) : null };
  const counters = d.events.append({ type: "delinquency.counters.updated", loanId: i.loan_id, actor: i.actor, payload: { loan_id: i.loan_id, on: today, earliest_unpaid_due_date: eu, principal_residence: pr, non_principal_residence: !pr, entered_delinquency: entered, gate_state: sw.state, ...projection } });
  d.store.put("loans", i.loan_id, projection, i.actor, i.now);
  const evaluationIds: string[] = []; const emitted: string[] = [];
  for (const ev of sw.events) {
    const reason = ev.type === "foreclosure.gate.opened" ? "day_121_reached" : eu ? "anchor_moved" : "loan_current";
    const inputs = { regx_days_delinquent: days, earliest_unpaid_due_date: eu, today, principal_residence: pr, previous_state: previous, opens_on: sw.opens_on };
    evaluationIds.push(evaluation(d, i, i.loan_id, GATE_120, "*", ev.type === "foreclosure.gate.opened" ? "open" : "closed", reason, inputs, "13.1.preForeclosureReviewPeriodElapsed"));
    d.events.append({ type: ev.type, loanId: i.loan_id, actor: i.actor, causationId: counters.id, payload: { code: GATE_120, reason, on: today, ...inputs } });
    emitted.push(ev.type);
  }
  return { loan_id: i.loan_id, today, regx_days_delinquent: days, earliest_unpaid_due: eu, principal_residence: pr, state: sw.state, opens_on: sw.opens_on, entered_delinquency: entered, counters_event_id: counters.id, events: emitted, evaluation_ids: evaluationIds };
}
/** The 00:05 job over every delinquent (or newly current) loan — one sweep per loan id. */
export function dailyGateSweep(d: Deps, i: { loan_ids: readonly string[]; today?: PlainDate } & At): SweepResult[] {
  if (!i.loan_ids.length) throw new RangeError("loan_ids is required");
  return i.loan_ids.map((loan_id) => sweepDelinquencyCounters(d, { ...i, loan_id }));
}

// ============================================================ assertGateOpen (satisfied column of the 13.1 not-before gates)
export interface GateCheck { readonly code: string; readonly result: "open" | "closed" | "not_applicable" | "exception_open"; readonly reason: string | null; readonly opens_on: PlainDate | null; readonly evaluation_id: string }
export interface Assertion { readonly loan_id: string; readonly step: Step; readonly today: PlainDate; readonly open: boolean; readonly closed: GateCheck[]; readonly gates: GateCheck[]; readonly regx_days_delinquent: number; readonly principal_residence: boolean }
/** Rule 4: the (f)(1)(ii)/(iii) exception is an officer's record with counsel's memo — `foreclosure_exceptions` row or `foreclosure.exception.recorded` event, never an input. */
function exceptionOnFile(d: Deps, loanId: string, ground: Ground): Row | null {
  if (ground === "default") return null;
  const row = d.store.list("foreclosure_exceptions", (r) => r.loan_id === loanId && r.kind === ground)[0]?.data;
  const ev = loanEvents(d, loanId, "foreclosure.exception.recorded").find((e) => e.payload.kind === ground)?.payload;
  return row ?? ev ?? null;
}
/** §1024.41(f)(2)/(k)(2) facts from the 12.x application rows for the loan — never from the caller. */
function applicationFacts(d: Deps, loanId: string, firstNotice: PlainDate | null) {
  const apps = d.store.list("lossmit_applications", (a) => a.loan_id === loanId).map((r): Row & { id: string } => ({ ...r.data, id: r.id }));
  const complete = apps.filter((a) => /complete/.test(String(a.status ?? "")) && !/incomplete/.test(String(a.status ?? "")));
  const exits = ["ineligible_no_appeal", "appeal_denied", "all_offers_rejected", "agreement_defaulted"];
  const holding = complete.filter((a) => { const rcv = dateOf(a.complete_received_on) ?? dateOf(a.completed_on) ?? dateOf(a.received_on); return !!rcv && (firstNotice === null || rcv < firstNotice) && !exits.includes(String(a.exit ?? a.f2_exit ?? "")) && a.duplicative_41i !== true; });
  const reasonable = apps.filter((a) => /incomplete|pending/.test(String(a.status ?? "")) && !a.exit).map((a) => dateOf(a.reasonable_date)).filter((x): x is PlainDate => x !== null).sort().at(-1) ?? null;
  return { holding, reasonable_date: reasonable };
}
/**
 * The ordered 13.1 gate assertions for `refer` / `first_notice`, each with its evaluation row: no second first notice
 * after a transferor's filing (T10), `REGX_1024_41F1_120_DAY_GATE` (not applicable off scope; `exception_open` for the
 * officer-recorded ground, T6), `REGX_1024_41F2_PRE_FILING_APP_GATE` (closed until an (f)(2)(i)–(iii) exit; with an
 * ineligible determination and a 14-day appeal window it opens the day after the window, T5),
 * `REGX_1024_41K2_NO_FIRST_FILING_GATE` (the day after the acknowledged reasonable date) and, for the first notice in NY,
 * `STATE_PREFC_NOTICE_GATE:NY` (T7). Referral is unregulated by Reg X but gated here by policy (Referral vs. filing).
 */
export function assertGateOpen(d: Deps, i: { loan_id: string; step: Step; today?: PlainDate; ground?: Ground } & At): Assertion {
  const loan = loanRow(d, i.loan_id); const today = i.today ?? dayOf(i.now); const ground = i.ground ?? "default";
  const eu = earliestUnpaid(loan); const pr = principalResidence(loan); const days = regxDays(today, eu);
  const filed = loanEvents(d, i.loan_id, "foreclosure.first_notice.filed").at(-1) ?? null;
  const firstNoticeOn = filed ? dateOf(filed.payload.filed_on) ?? dayOf(filed.occurredAt) : dateOf(openCase(d, i.loan_id)?.data.first_notice_filed_at);
  const gates: GateCheck[] = [];
  const push = (code: string, result: GateCheck["result"], reason: string | null, opensOn: PlainDate | null, inputs: Row, evaluator: string | null): void => {
    const id = evaluation(d, i, i.loan_id, code, i.step, result === "closed" ? "closed" : "open", result === "closed" ? code : result === "open" ? null : result === "exception_open" ? `exception_open:${ground}` : "not_applicable", inputs, evaluator);
    gates.push({ code, result, reason, opens_on: opensOn, evaluation_id: id });
  };
  if (i.step === "first_notice") {
    const made = filed !== null || loan.first_notice_or_filing_made === true;
    push(GATE_FIRST_NOTICE_MADE, made ? "closed" : "open", made ? `the first notice or filing was already made${firstNoticeOn ? ` on ${firstNoticeOn}` : ""}${filed?.payload.carried_from_transferor ? " by the transferor (carried at boarding, 1.3)" : ""} — comment 41(f)-1: there is no second "first notice" (13.1 edge cases; T10)` : null, null, { first_notice_filed_on: firstNoticeOn, carried_from_transferor: filed?.payload.carried_from_transferor ?? false }, null);
  }
  const exc = exceptionOnFile(d, i.loan_id, ground);
  const ex = ground !== "default" && eu ? exceptionGround({ ground, recorded_by_role: String(exc?.recorded_by_role ?? ""), counsel_memo_document_id: (exc?.counsel_memo_document_id as string | undefined) ?? null, today, earliest_unpaid_due: eu, principal_residence: pr }) : null;
  const g = gate120(today, eu, pr, ex?.allowed ? (ground as "due_on_sale" | "join_lienholder") : null);
  const inputs120 = { regx_days_delinquent: days, non_principal_residence: !pr, earliest_unpaid_due_date: eu, today, ground, exception_recorded_by_role: exc?.recorded_by_role ?? null, counsel_memo_document_id: exc?.counsel_memo_document_id ?? null };
  if (!pr) push(GATE_120, "not_applicable", null, null, inputs120, "13.1.preForeclosureReviewPeriodElapsed");
  else if (ex?.allowed && i.step === "first_notice") push(GATE_120, "exception_open", null, null, inputs120, "13.1.preForeclosureReviewPeriodElapsed");
  else if (ground !== "default" && !ex?.allowed) push(GATE_120, "closed", ex?.refusal ?? `no officer-recorded ${ground} exception with counsel's memo on file (rule 4)`, g.opens_on, inputs120, "13.1.preForeclosureReviewPeriodElapsed");
  else push(GATE_120, g.state === "open" ? "open" : "closed", g.state === "open" ? null : `loan is ${days} days delinquent; no referral/first notice before day 121 (§1024.41(f)(1)${g.opens_on ? `; opens ${g.opens_on}` : ""})`, g.opens_on, inputs120, "13.1.preForeclosureReviewPeriodElapsed");
  const apps = applicationFacts(d, i.loan_id, firstNoticeOn);
  const hold = apps.holding.at(-1) ?? null;
  if (hold && eu) {
    const det = dateOf(hold.determination_sent_on); const rcv = dateOf(hold.complete_received_on) ?? dateOf(hold.completed_on) ?? dateOf(hold.received_on)!;
    const f2 = det ? preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: rcv, determination_sent_on: det, appeal_available: hold.appeal_available !== false, appeal_denied_on: dateOf(hold.appeal_denied_on), referral_attempt_on: today }) : null;
    const closed = f2 ? f2.state === "closed" : true;
    push(GATE_F2, closed ? "closed" : "open", closed ? (f2?.refusal ?? `complete application ${hold.id} received ${rcv} before the first notice: no referral/first notice until an (f)(2)(i)–(iii) exit`) : null, f2?.opens_on ?? null, { application_id: hold.id, complete_received_on: rcv, determination_sent_on: det, appeal_available: hold.appeal_available !== false, appeal_denied_on: dateOf(hold.appeal_denied_on), day_of_attempt: days }, "13.1.preFilingAppGateOpen");
  } else push(GATE_F2, "open", null, null, { complete_app_before_first_notice: false }, "13.1.preFilingAppGateOpen");
  if (apps.reasonable_date) push(GATE_K2, today > apps.reasonable_date ? "open" : "closed", today > apps.reasonable_date ? null : `no first notice/filing before the reasonable date ${apps.reasonable_date} on the incomplete-application acknowledgment (§1024.41(k)(2))`, addDays(apps.reasonable_date, 1), { today, reasonable_date: apps.reasonable_date }, "1.7.noFirstFilingBeforeReasonableDate");
  if (i.step === "first_notice" && String(loan.state ?? "").toUpperCase() === "NY" && eu) {
    const ny = nyFirstNoticeGate({ today, earliest_unpaid_due: eu, s1304_mailed_on: dateOf(loan.s1304_mailed_on), s1306_filed: loan.s1306_filed === true });
    push(GATE_NY, ny.first_notice_allowed ? "open" : "closed", ny.refusal, ny.opens_on, { s1304_mailed_on: dateOf(loan.s1304_mailed_on), s1306_filed: loan.s1306_filed === true, today }, null);
  }
  const closed = gates.filter((x) => x.result === "closed");
  return { loan_id: i.loan_id, step: i.step, today, open: closed.length === 0, closed, gates, regx_days_delinquent: days, principal_residence: pr };
}
export interface Refusal { readonly refused: true; readonly code: string; readonly reason: string; readonly opens_on: PlainDate | null; readonly event_id: string; readonly escalation_id: string | null; readonly attorney_message_sent: false }
/** The refusal trail of the timer table's breach column: `foreclosure.gate.refused{command, code}`, sev 1 → Compliance Sentinel, no attorney message. */
function refuse(d: Deps, at: At, a: Assertion, command: string): Refusal {
  const first = a.closed[0]!;
  const r = refusedReferral({ gate: first.code, opens_on: first.opens_on, attempted_on: a.today, actor: at.actor.id });
  const ev = d.events.append({ type: "foreclosure.gate.refused", loanId: a.loan_id, actor: at.actor, payload: { command, code: first.code, gate: first.code, step: a.step, reason: first.reason, opens_on: first.opens_on, attempted_on: a.today, closed: a.closed.map((x) => x.code), evaluation_ids: a.gates.map((x) => x.evaluation_id) } });
  const esc = d.escalations?.open({ kind: "sev1", ownerRole: "compliance_sentinel", loanId: a.loan_id, payload: { reason: r.escalation.reason, gate: first.code, step: a.step, command } }, at.actor) ?? null;
  return { refused: true, code: first.code, reason: first.reason ?? "closed", opens_on: first.opens_on, event_id: ev.id, escalation_id: esc?.id ?? null, attorney_message_sent: false };
}

// ============================================================ referral (satisfies FNMA_E1202_NONPR_REFER_BY_120)
export interface ReferralSent { readonly sent: true; readonly referral_id: string; readonly case_id: string; readonly firm_id: string; readonly referred_on: PlainDate; readonly day: number; readonly principal_residence: boolean; readonly event_id: string }
/**
 * E-1.2-02: foreclosure "is considered to have begun on the date when the servicer refers the matter to a law firm" and
 * the referral date is kept in the loan file (`foreclosure_cases.referral_sent_at`); the referral message carries the
 * `gates_snapshot` (Integrations) in `attorney_referrals.data_snapshot`. Appends `foreclosure.referral.sent`, which
 * satisfies `FNMA_E1202_NONPR_REFER_BY_120` (and the 13.3 referral timers). Callers assert the gates first (`referLoan`
 * or `foreclosure.gates.evaluate{attempt_referral}`); a principal-residence loan inside day 120 is refused here too.
 */
export function sendReferral(d: Deps, i: { loan_id: string; firm_id: string; gates_snapshot: readonly unknown[]; package_manifest?: Row | undefined; today?: PlainDate } & At): ReferralSent {
  if (!i.firm_id) throw new RangeError("firm_id is required (E-1.2-02: referral to a law firm)");
  if (!i.gates_snapshot.length) throw new RangeError("gates_snapshot is required: every referral message carries the gate evaluations (13.1 Integrations)");
  const loan = loanRow(d, i.loan_id); const today = i.today ?? dayOf(i.now);
  const eu = earliestUnpaid(loan); const pr = principalResidence(loan); const days = regxDays(today, eu);
  if (pr && gate120(today, eu, pr, null).state !== "open") throw new RangeError(`${GATE_120} closed: day ${days} of a principal-residence delinquency — no referral before day 121 (E-1.2-02; §1024.41(f)(1) by policy)`);
  const existing = openCase(d, i.loan_id);
  const caseId = existing?.id ?? `fc-${i.loan_id}-${today}`;
  d.store.put("foreclosure_cases", caseId, { ...(existing ? {} : { case_id: caseId, loan_id: i.loan_id, jurisdiction_state: String(loan.state ?? ""), lpi_due_date: eu, principal_residence: pr }), firm_id: i.firm_id, referral_sent_at: i.now, status: "referred" }, i.actor, i.now);
  const referralId = `ref-${i.loan_id}-${today}`;
  d.store.put("attorney_referrals", referralId, { case_id: caseId, loan_id: i.loan_id, firm_id: i.firm_id, package_manifest: i.package_manifest ?? {}, data_snapshot: { gates_snapshot: i.gates_snapshot, regx_days_delinquent: days, earliest_unpaid_due_date: eu, principal_residence: pr }, sent_at: i.now, ack_at: null, ack_complete: null, missing_items: null }, i.actor, i.now);
  const ev = d.events.append({ type: "foreclosure.referral.sent", loanId: i.loan_id, aggregate: { kind: "case", id: caseId }, actor: i.actor, payload: { loan_id: i.loan_id, referral_id: referralId, case_id: caseId, firm_id: i.firm_id, referred_on: today, regx_days_delinquent: days, principal_residence: pr, gates_snapshot: i.gates_snapshot } });
  return { sent: true, referral_id: referralId, case_id: caseId, firm_id: i.firm_id, referred_on: today, day: days, principal_residence: pr, event_id: ev.id };
}
/** `foreclosure.refer`: assert the 13.1 gates, then send — or leave the refusal trail (T8) with nothing sent. */
export function referLoan(d: Deps, i: { loan_id: string; firm_id: string; today?: PlainDate; package_manifest?: Row | undefined } & At): ReferralSent | (Refusal & { assertion: Assertion }) {
  const a = assertGateOpen(d, { ...i, step: "refer" });
  if (!a.open) return { ...refuse(d, i, a, "foreclosure.refer"), assertion: a };
  return sendReferral(d, { ...i, gates_snapshot: a.gates });
}

// ============================================================ first notice authorization
export interface FirstNoticeAuthorized { readonly allowed: true; readonly ground: Ground; readonly on: PlainDate; readonly event_id: string; readonly gates: GateCheck[] }
/** `foreclosure.first_notice.authorize{ground}`: allowed only through `assertGateOpen` (T5–T7, T10); emits `foreclosure.first_notice.authorized` (Outputs; the firm's `first_notice.authorized=false` until then). */
export function authorizeFirstNotice(d: Deps, i: { loan_id: string; today?: PlainDate; ground?: Ground } & At): FirstNoticeAuthorized | (Refusal & { assertion: Assertion }) {
  const a = assertGateOpen(d, { ...i, step: "first_notice" });
  if (!a.open) return { ...refuse(d, i, a, `foreclosure.first_notice.authorize{ground=${i.ground ?? "default"}}`), assertion: a };
  const ev = d.events.append({ type: "foreclosure.first_notice.authorized", loanId: i.loan_id, actor: i.actor, payload: { loan_id: i.loan_id, ground: i.ground ?? "default", on: a.today, regx_days_delinquent: a.regx_days_delinquent, gates_cleared: a.gates.map((g) => ({ code: g.code, result: g.result, evaluation_id: g.evaluation_id })) } });
  return { allowed: true, ground: i.ground ?? "default", on: a.today, event_id: ev.id, gates: a.gates };
}

// ============================================================ BK_362_STAY_GATE projection from the 14.x feed
const STAY_END_REASONS = ["discharge", "dismissal", "362c3"] as const;
export interface StayProjection { readonly opened: boolean; readonly reason: string | null; readonly refusal: string | null; readonly event_id: string | null }
/** `bankruptcy.petition.filed` → the stay gate closes for every step (`foreclosure.gate.closed{code=BK_362_STAY_GATE}`); the timer arms on the same event. */
export function bankruptcyPetitionFiled(d: Deps, i: { loan_id: string; event: DomainEvent } & At): { closed: boolean; event_id: string | null } {
  if (i.event.type !== "bankruptcy.petition.filed") throw new RangeError(`bankruptcyPetitionFiled: unexpected ${i.event.type}`);
  const last = lastGateEvent(d, i.loan_id, GATE_BK);
  if (last?.type === "foreclosure.gate.closed" && last.payload.source_event_id === i.event.id) return { closed: true, event_id: last.id };
  const inputs = { source_event_id: i.event.id, source_event_type: i.event.type, chapter: i.event.payload.chapter ?? null, petition_date: i.event.payload.petition_date ?? null };
  evaluation(d, i, i.loan_id, GATE_BK, "*", "closed", "petition_filed", inputs, null);
  const ev = d.events.append({ type: "foreclosure.gate.closed", loanId: i.loan_id, actor: i.actor, causationId: i.event.id, payload: { code: GATE_BK, reason: "petition_filed", on: dayOf(i.event.occurredAt), ...inputs } });
  return { closed: true, event_id: ev.id };
}
/**
 * The 14.x stay-end ingestion: validates the inbound record — `bankruptcy.stay.terminated{reason ∈ discharge, dismissal,
 * 362c3}` (a discharge under a plan treating the lien by avoidance does not open the gate: "without lien avoidance") or
 * `bankruptcy.stay.relief_effective{foreclosure_blocked=false}` (relief order effective after the Rule 4001(a)(3) stay)
 * — and appends `foreclosure.gate.opened{code=BK_362_STAY_GATE}`, which satisfies the gate timer. Anything else is
 * recorded as a refusal (no gate opens on `bankruptcy.stay.extended`, a plan modification, or a discharge with lien avoidance).
 */
export function bankruptcyStayEnded(d: Deps, i: { loan_id: string; event: DomainEvent } & At): StayProjection {
  const p = i.event.payload; let reason: string | null = null; let refusal: string | null = null;
  if (i.event.type === "bankruptcy.stay.terminated") {
    const r = String(p.reason ?? "");
    if (!(STAY_END_REASONS as readonly string[]).includes(r)) refusal = `stay termination reason "${r}" is not relief/dismissal/discharge (13.1 timer table)`;
    else if (r === "discharge") {
      const bk = d.store.list("bankruptcy_cases", (c) => c.loan_id === i.loan_id).map((c) => c.data).at(-1);
      if (p.treatment === "lien_avoidance" || p.lien_avoided === true || bk?.treatment === "lien_avoidance" || bk?.lien_avoided === true) refusal = "discharge with lien avoidance: the lien no longer supports foreclosure — gate stays closed (13.1 timer table: 'discharge without lien avoidance'; 14.x)";
      else reason = r;
    } else reason = r;
  } else if (i.event.type === "bankruptcy.stay.relief_effective") {
    if (p.foreclosure_blocked === false) reason = "relief_from_stay"; else refusal = "relief order not yet effective (foreclosure_blocked≠false; Fed. R. Bankr. P. 4001(a)(3))";
  } else throw new RangeError(`bankruptcyStayEnded: unexpected ${i.event.type}`);
  const inputs = { source_event_id: i.event.id, source_event_type: i.event.type, reason: reason ?? String(p.reason ?? ""), statute: p.statute ?? null };
  if (refusal) { evaluation(d, i, i.loan_id, GATE_BK, "*", "closed", GATE_BK, { ...inputs, refusal }, null); return { opened: false, reason: null, refusal, event_id: null }; }
  const last = lastGateEvent(d, i.loan_id, GATE_BK);
  if (last?.type === "foreclosure.gate.opened" && last.payload.source_event_id === i.event.id) return { opened: true, reason, refusal: null, event_id: last.id };
  evaluation(d, i, i.loan_id, GATE_BK, "*", "open", reason, inputs, null);
  const ev = d.events.append({ type: "foreclosure.gate.opened", loanId: i.loan_id, actor: i.actor, causationId: i.event.id, payload: { code: GATE_BK, on: dayOf(i.event.occurredAt), ...inputs, reason } });
  return { opened: true, reason, refusal: null, event_id: ev.id };
}

// ============================================================ transfer-in (edge cases; T10)
export interface TransferorForeclosureFile { readonly first_notice_filed_at: PlainDate | null; readonly first_notice_evidence_document_id?: string | null; readonly first_notice_kind?: string | null; readonly state_prefc_notice_sent: boolean; readonly lpi_due: PlainDate }
/**
 * A transfer-in mid-delinquency (1.3): counters seed from the transferor's earliest unpaid due date, never the transfer
 * date; a first notice or filing the transferor made carries as `foreclosure.first_notice.filed` **with evidence** (no
 * evidence, no filing), no second "first notice" is authorized (`assertGateOpen`) and the 1026.41(d)(8) statement flag
 * (7.1) is true from boarding. The (k)(2) gate arms from 1.3's `loan.boarded` (see timers-13-1.ts).
 */
export function transferInForeclosureState(d: Deps, i: { loan_id: string; boarded_on: PlainDate; transferor: TransferorForeclosureFile } & At): ReturnType<typeof transferredFirstFiling> & { loan_id: string; case_id: string | null; events: string[] } {
  const t = i.transferor;
  if (t.first_notice_filed_at && !t.first_notice_evidence_document_id) throw new RangeError("a transferor first notice/filing needs its evidence document (13.1 edge cases: 'carries as foreclosure.first_notice.filed with evidence')");
  if (t.first_notice_filed_at && t.first_notice_filed_at > i.boarded_on) throw new RangeError(`transferor first filing ${t.first_notice_filed_at} is after boarding ${i.boarded_on}`);
  const loan = loanRow(d, i.loan_id);
  const r = transferredFirstFiling({ transferor_first_notice_filed_at: t.first_notice_filed_at, transferor_state_prefc_notice_sent: t.state_prefc_notice_sent, transferor_lpi_due: t.lpi_due });
  d.store.put("loans", i.loan_id, { earliest_unpaid_due: t.lpi_due, first_notice_or_filing_made: r.statement_flag_from_boarding, fc_first_notice_filed_at: t.first_notice_filed_at, fc_timeframe_lpi_due: r.timeframe_lpi_due }, i.actor, i.now);
  const events: string[] = []; let caseId: string | null = null;
  if (t.first_notice_filed_at) {
    caseId = openCase(d, i.loan_id)?.id ?? `fc-${i.loan_id}-transfer-in`;
    d.store.put("foreclosure_cases", caseId, { case_id: caseId, loan_id: i.loan_id, jurisdiction_state: String(loan.state ?? ""), status: "first_notice_made", first_notice_filed_at: t.first_notice_filed_at, first_notice_kind: t.first_notice_kind ?? null, lpi_due_date: t.lpi_due, transferred_in: true, first_notice_evidence_document_id: t.first_notice_evidence_document_id }, i.actor, i.now);
    d.events.append({ type: "foreclosure.first_notice.filed", loanId: i.loan_id, aggregate: { kind: "case", id: caseId }, actor: i.actor, payload: { loan_id: i.loan_id, case_id: caseId, filed_on: t.first_notice_filed_at, first_notice_kind: t.first_notice_kind ?? null, carried_from_transferor: true, evidence_document_id: t.first_notice_evidence_document_id, boarded_on: i.boarded_on, statement_flag_1026_41d8: true } });
    events.push("foreclosure.first_notice.filed");
  }
  return { ...r, loan_id: i.loan_id, case_id: caseId, events };
}

// ============================================================ reactors
/**
 * Event-driven re-projection (spec Inputs): the counters re-sweep on `payment.applied` / `payment.reversed` (anchor
 * changes), `loan.boarded` (seeded counters, 1.3) and `loan_terms.activated` (a modification cures delinquency); the stay
 * gate closes on `bankruptcy.petition.filed` and opens on 14.x's stay-end events. Returns the unsubscribe function.
 */
export function wireForeclosureGateReactors_13_1(d: Deps): () => void {
  const at = (e: DomainEvent): At => ({ actor: GATE_AGENT, now: e.occurredAt });
  const resweep = (e: DomainEvent): void => { if (e.loanId && d.store.get("loans", e.loanId)) sweepDelinquencyCounters(d, { loan_id: e.loanId, ...at(e) }); };
  const offs = [
    ...["payment.applied", "payment.reversed", "loan.boarded", "loan_terms.activated"].map((t) => d.events.subscribe(t, resweep)),
    d.events.subscribe("bankruptcy.petition.filed", (e) => { if (e.loanId) bankruptcyPetitionFiled(d, { loan_id: e.loanId, event: e, ...at(e) }); }),
    d.events.subscribe("bankruptcy.stay.terminated", (e) => { if (e.loanId) bankruptcyStayEnded(d, { loan_id: e.loanId, event: e, ...at(e) }); }),
    d.events.subscribe("bankruptcy.stay.relief_effective", (e) => { if (e.loanId) bankruptcyStayEnded(d, { loan_id: e.loanId, event: e, ...at(e) }); }),
  ];
  return () => { for (const off of offs) off(); };
}
