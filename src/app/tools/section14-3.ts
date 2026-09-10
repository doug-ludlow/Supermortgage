/**
 * §14.3 tools — the spec's tool strings for process 14.3, verbatim, via
 * `defineTools("14.3", "bankruptcy-ops", defs)` from ../tools.ts (see section13.ts). Spread by ./section14.ts.
 * Guardrails encode the spec's sentences: no exemption without a linked evidence document (the document must be on
 * file — `bk_statement_status.basis_document_id` references `documents`); no `standard` variant while any consumer is
 * a debtor or discharged (unless reaffirmed and the rescission window lapsed) — judged on the case state the store holds
 * (open `bankruptcy_cases` rows, a discharge, the loan's prior `bk_statement_status`), never only on a caller-supplied
 * flag; the LLM never alters figures; a cease request is never inferred from a phone call; statements are never
 * suppressed for returned mail; escalations go to attorney / human_agent / officer — none to Fannie Mae.
 * Rendering and sending belong to 7.1's `disclosures` agent (spec: "`disclosures` (7.1) renders, checks and sends").
 *
 * Events (the §14.3 timers arm on these — src/domain/bankruptcy/timers-14-3.ts):
 *  - `bankruptcy.statement_mode.set{mode, …}` / `bankruptcy.addressing.decided{basis_present}` from bk.statement_mode.set;
 *  - `bankruptcy.early_intervention.evaluated{trigger, required, timer, deadline, …}` — the rule-6 decision (petition /
 *    later delinquency / post-discharge payment / resume after dismissal-closure-reaffirmation) with the timer's anchor;
 *  - `bankruptcy.statement_request.received{kind, from, received_at, document_id, in_writing, at_exclusive_address, …}` from
 *    requests.classify, plus `bankruptcy.statement_resumption.scheduled{basis, resume_statement_due_by, …}` when a written
 *    request for statements (requests.classify) or a reaffirmation / plan amendment / payment after a surrender SOI /
 *    dismissal (bk.statement_mode.set, `resume_basis`) ends an exemption.
 */
import { defineTools, compute, read, never, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { statementModeGuard, classifyRequest, resumeRequest, earlyInterventionEvaluation, earlyInterventionRecord, statementResumption, reaffirmationRescissionEnds, isStatementMode, STATEMENT_MODES, EI_EVENT, RESUMPTION_EVENT, type RequestFrom, type RequestChannel, type EiInput, type StatementMode, type Chapter, type ResumptionBasis } from "../../domain/bankruptcy/ops-14-3.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const opt = (i: ToolInput, k: string): string | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : String(i[k]));
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
const AGENT = "bankruptcy-ops";
const ESCALATION_KINDS: readonly EscalationKind[] = ["attorney", "human_agent", "officer", "human_portal_task", "signing_officer", "lossmit_reviewer", "fraud_officer", "sev1", "sev2", "sev3", "sev4"];
const RESUME_BASES: readonly ResumptionBasis[] = ["written_request", "reaffirmation", "plan_amended_to_pay", "payment_after_soi_surrender", "dismissal", "revived_case"];
const CHAPTERS: readonly Chapter[] = ["7", "11", "12", "13"];
/** An input that would change figures: a write op, a changes/data document or figure overrides. */
const altersFigures = (i: ToolInput): boolean => i.op === "write" || i.changes !== undefined || i.figure_overrides !== undefined || i.data !== undefined;
const isExempt = (m: string): boolean => m.startsWith("exempt_");

// ---- case state the guardrails are judged on ----------------------------------------------------------------------------------------------
/** What the store knows about the loan's bankruptcy: 14.1's `bankruptcy_cases` rows and the loan's prior `bk_statement_status`. */
interface CaseState { readonly prior: Record<string, unknown> | null; readonly open_case: Record<string, unknown> | null; readonly discharged: boolean; readonly reaffirmation_pending: boolean; readonly dismissed_without_discharge: boolean; readonly chapter: Chapter | null; readonly reaffirmation_filed_on: PlainDate | null; readonly discharge_on: PlainDate | null; readonly cases: number; }
const CASE_ENDED = /^(dismissed|closed|withdrawn|ended_dismissal|ended_closed)$/;
const DISMISSED = /^(dismissed|withdrawn|ended_dismissal)$/;
function caseState(rt: ToolRuntime, loanId: string, statusId: string, asOf: PlainDate): CaseState {
  const prior = rt.store.get("bk_statement_status", statusId)?.data ?? rt.store.list("bk_statement_status", (d) => d.loan_id === loanId)[0]?.data ?? null;
  const cases = rt.store.list("bankruptcy_cases", (d) => d.loan_id === loanId).map((r) => r.data);
  const openCase = cases.find((c) => !CASE_ENDED.test(String(c.status ?? "open")) && !c.dismissal_at && !c.closed_at) ?? null;
  const reaffOf = (c: Record<string, unknown>) => { const r = obj(c.reaffirmation); return r ? dateOf(r.filed_on ?? r.filed_at ?? r.date) : null; };
  // discharged personal liability: 14.1 records `debt_discharged`; a discharge date without a reaffirmation on record means the same
  const discharged = cases.some((c) => c.debt_discharged === true || (Boolean(c.discharge_at ?? c.discharge_date) && c.debt_discharged !== false && reaffOf(c) === null)) || prior?.debt_discharged === true;
  const src = openCase ?? cases.find((c) => reaffOf(c) !== null) ?? cases.find((c) => Boolean(c.discharge_at ?? c.discharge_date)) ?? cases.at(-1) ?? null;
  const chapter = src && CHAPTERS.includes(String(src.chapter) as Chapter) ? (String(src.chapter) as Chapter) : null;
  const reaffFiled = src ? reaffOf(src) : null; const dischargeOn = src ? dateOf(src.discharge_at ?? src.discharge_date) : null;
  // a reaffirming consumer is still a debtor until the §524(c)(4) window lapses (rule 1(e)); a dismissal without discharge ends the debtor status (rule 1(f))
  const reaffirmationPending = reaffFiled !== null && (dischargeOn === null || !(reaffirmationRescissionEnds(reaffFiled, dischargeOn) < asOf));
  const dismissedWithoutDischarge = cases.length > 0 && openCase === null && !discharged && reaffFiled === null && cases.some((c) => Boolean(c.dismissal_at) || DISMISSED.test(String(c.status ?? "")));
  return { prior, open_case: openCase, discharged, reaffirmation_pending: reaffirmationPending, dismissed_without_discharge: dismissedWithoutDischarge, chapter, reaffirmation_filed_on: reaffFiled, discharge_on: dischargeOn, cases: cases.length };
}
const chapterOf = (i: ToolInput, st: CaseState): Chapter | null => (CHAPTERS.includes(str(i, "chapter") as Chapter) ? (str(i, "chapter") as Chapter) : st.chapter);

/** rule 6 facts → the `bankruptcy.early_intervention.evaluated` input (trigger defaults to `petition` when `petition_on` is supplied). */
function eiInput(ei: Record<string, unknown>): EiInput {
  const trigger = String(ei.trigger ?? (ei.petition_on ? "petition" : ""));
  const on = (k: string): PlainDate => { const d = dateOf(ei[k]); if (!d) throw new RangeError(`early_intervention.${k} is required for trigger=${trigger}`); return d; };
  const dueDay = ei.due_day !== undefined ? Number(ei.due_day) : undefined;
  switch (trigger) {
    case "petition": return { trigger, petition_on: on("petition_on"), regx_days_delinquent_at_petition: Number(ei.regx_days_delinquent_at_petition ?? 0), lossmit_available: ei.lossmit_available !== false, fdcpa_cease_on_file: ei.fdcpa_cease_on_file === true, prior_notice_this_case: ei.prior_notice_this_case === true, attorney_of_record: ei.attorney_of_record === true };
    case "later_delinquency": return { trigger, unpaid_due_date: on("unpaid_due_date"), once_per_case_satisfied: ei.once_per_case_satisfied === true || ei.prior_notice_this_case === true, attorney_of_record: ei.attorney_of_record === true };
    case "discharge_payment": return { trigger, discharge_on: on("discharge_on"), reaffirmed: ei.reaffirmed === true, payment_received_on: on("payment_received_on"), payment_cents: BigInt(String(ei.payment_cents ?? "0")), delinquent: ei.delinquent === true, attorney_of_record: ei.attorney_of_record === true, ...(dueDay !== undefined ? { due_day: dueDay } : {}) };
    case "resume": { const status = String(ei.status ?? "dismissed"); if (!/^(dismissed|closed|reaffirmed)$/.test(status)) throw new RangeError(`early_intervention.status ${status} is not one of dismissed/closed/reaffirmed (§1024.39(c)(2)(i))`);
      return { trigger, event_on: on("event_on"), status: status as "dismissed", debt_discharged: ei.debt_discharged === true, reaffirmed: ei.reaffirmed === true, ...(dueDay !== undefined ? { due_day: dueDay } : {}) }; }
    default: throw new RangeError(`early_intervention.trigger ${trigger || "(missing)"} is not one of petition/later_delinquency/discharge_payment/resume`);
  }
}

export const TOOLS_14_3: readonly ToolDef[] = defineTools("14.3", AGENT, [
  // rule 1 / state machine: bankruptcy-ops sets `mode`/`addressing` from docket facts (spec enum = bk_statement_status CHECK); the event satisfies SM_BK_STATEMENT_MODE_SYNC_1BD and (for a cease) REGZ_1026_41E5_CEASE_EFFECTIVE_0.
  // The decision record's `early_intervention {required, deadline, recipient}` is persisted to `bk_early_intervention` and published as the event the §1024.39(c) timers arm on.
  { name: "bk.statement_mode.set", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "mode"); const mode = str(i, "mode"); if (!isStatementMode(mode)) throw new RangeError(`mode ${mode} is not one of ${STATEMENT_MODES.join("/")} (14.3 data model; bk_statement_status.mode CHECK)`);
      const loanId = str(i, "loan_id"); const statusId = str(i, "id") || `bkss-${loanId}`; const effective = str(i, "effective_on") || ctx.now.slice(0, 10);
      const st = caseState(rt, loanId, statusId, D(effective));
      // guardrail: no `standard` while any consumer is a debtor or discharged — judged on the case state (open case, discharge, pending reaffirmation, the loan's prior mode), not the caller's flag alone.
      const priorNonStandard = st.prior !== null && String(st.prior.mode) !== "standard";
      const dismissedWithoutDischarge = flag(i, "dismissed_without_discharge") || st.dismissed_without_discharge;
      const debtorOrDischarged = flag(i, "debtor_or_discharged") || flag(i, "debt_discharged") || st.open_case !== null || st.discharged || st.reaffirmation_pending || (priorNonStandard && !dismissedWithoutDischarge);
      // a final reaffirmation: the §524(c)(4) window (later of discharge and filing + 60) lapsed as of the effective date — from the case record, or asserted by the caller when the record does not contradict it (an open case has no discharge yet, so the window cannot have lapsed)
      const reaffirmedFinal = (st.reaffirmation_filed_on !== null && st.discharge_on !== null && reaffirmationRescissionEnds(st.reaffirmation_filed_on, st.discharge_on) < D(effective)) || (flag(i, "reaffirmed") && flag(i, "rescission_window_lapsed") && st.open_case === null && !st.reaffirmation_pending);
      const g = statementModeGuard({ mode, basis_document_id: opt(i, "basis_document_id"), debtor_or_discharged: debtorOrDischarged, reaffirmed: reaffirmedFinal || flag(i, "reaffirmed"), rescission_window_lapsed: reaffirmedFinal, reason: opt(i, "reason") });
      if (!g.allowed) throw new RangeError(`${g.refusal} — case state: ${st.open_case ? "open case" : st.discharged ? "discharged" : st.reaffirmation_pending ? "reaffirmation inside the §524(c)(4) window" : priorNonStandard ? `prior mode ${String(st.prior!.mode)}` : "caller flag"}`);
      if (mode === "standard" && priorNonStandard && !reaffirmedFinal && !opt(i, "basis_event_id")) throw new RangeError("standard after a non-standard mode needs basis_event_id — the dismissal (without discharge) event that ends the debtor status (rule 1(f); decision record exemption_basis.event_id)");
      // guardrail: no exemption without a linked evidence document — and the document must be on file (bk_statement_status.basis_document_id references documents).
      if (isExempt(mode)) { const doc = rt.store.get("documents", str(i, "basis_document_id")); if (!doc) throw new RangeError(`basis_document_id ${str(i, "basis_document_id")} is not a document on file — link the written request image, plan, order or statement of intention before recording ${mode} (14.3 guardrail)`); }
      const rec = rt.store.put("bk_statement_status", statusId, { loan_id: loanId, case_id: opt(i, "case_id"), mode, basis_document_id: opt(i, "basis_document_id"), basis_event_id: opt(i, "basis_event_id"), exclusive_address_used: flag(i, "exclusive_address_used"), last_request: obj(i.last_request), addressing: str(i, "addressing") || "debtor", addressing_basis: opt(i, "addressing_basis"), single_statement_used_for_cycle: opt(i, "single_statement_used_for_cycle"), resume_from_cycle: opt(i, "resume_from_cycle"), debt_discharged: flag(i, "debt_discharged") || st.discharged, reaffirmed: flag(i, "reaffirmed"), effective_on: effective, updated_at: ctx.now }, ctx.actor, ctx.now);
      ctx.events.append({ type: "bankruptcy.statement_mode.set", loanId, aggregate: { kind: "bk_statement_status", id: rec.id }, actor: ctx.actor, payload: { mode, mode_before: st.prior ? String(st.prior.mode) : null, basis_document_id: opt(i, "basis_document_id"), basis_event_id: opt(i, "basis_event_id"), addressing: rec.data.addressing, effective_on: effective, single_statement_used_for_cycle: opt(i, "single_statement_used_for_cycle"), debtor_or_discharged: debtorOrDischarged } });
      if (str(i, "addressing")) ctx.events.append({ type: "bankruptcy.addressing.decided", loanId, actor: ctx.actor, payload: { addressing: str(i, "addressing"), basis: opt(i, "addressing_basis"), basis_present: Boolean(opt(i, "addressing_basis")) } });
      // rule 6: the early-intervention overlay decision → bk_early_intervention row + the event the §1024.39(c) timers arm on
      const ei = obj(i.early_intervention); let earlyIntervention: Record<string, unknown> | null = null;
      if (ei) {
        const e = earlyInterventionEvaluation(eiInput(ei)); const caseId = opt(i, "case_id") ?? loanId;
        let row: Record<string, unknown> | null = null;
        if (e.writes_row) { const r = earlyInterventionRecord({ case_id: caseId, loan_id: loanId, decision: e.decision, notice_id: typeof ei.notice_id === "string" ? ei.notice_id : null, sent_at: typeof ei.sent_at === "string" ? ei.sent_at : null }); row = rt.store.put("bk_early_intervention", r.case_id, r, ctx.actor, ctx.now).data; }
        ctx.events.append({ type: EI_EVENT, loanId, aggregate: { kind: "bk_early_intervention", id: caseId }, actor: ctx.actor, payload: { ...e.payload, case_id: caseId, ...(row ? { once_per_case_satisfied: row.once_per_case_satisfied } : {}) } });
        earlyIntervention = row ?? e.payload;
      }
      // rule 1 / rule 5: an exemption ending on a reaffirmation, plan amendment, payment after a surrender SOI, dismissal or revived case → the resumption event (a written request was published at receipt by requests.classify)
      const basis = str(i, "resume_basis") as ResumptionBasis; let resumption: Record<string, unknown> | null = null;
      if (basis) {
        if (!RESUME_BASES.includes(basis)) throw new RangeError(`resume_basis ${basis} is not one of ${RESUME_BASES.join("/")}`);
        const before = (str(i, "mode_before") || (st.prior ? String(st.prior.mode) : "")) as StatementMode;
        if (!isStatementMode(before)) throw new RangeError("mode_before (or a prior bk_statement_status row) is required with resume_basis — the exemption the event ends");
        resumption = statementResumption({ basis, event_on: D(effective), mode_before: before, mode_after: mode, rendered_for_open_cycle: flag(i, "rendered_for_open_cycle"), ...(i.due_day !== undefined ? { due_day: Number(i.due_day) } : {}) });
        if (resumption && basis !== "written_request") ctx.events.append({ type: RESUMPTION_EVENT, loanId, aggregate: { kind: "bk_statement_status", id: rec.id }, actor: ctx.actor, payload: { ...resumption, basis_document_id: opt(i, "basis_document_id"), basis_event_id: opt(i, "basis_event_id") } });
      }
      return { ...rec.data, early_intervention: earlyIntervention, resumption }; }),
    guardrails: [never("EXEMPTION_NEEDS_EVIDENCE", "14.3 guardrail: no exemption without a linked evidence document (written request image, plan, order, SOI)", (i) => /^exempt_/.test(str(i, "mode")) && !str(i, "basis_document_id"), "link the basis document before recording an exemption"),
      never("NO_STANDARD_WHILE_DEBTOR", "14.3 guardrail: no `standard` variant while any consumer is a debtor or discharged (unless reaffirmed and the §524(c)(4) rescission window lapsed)", (i) => str(i, "mode") === "standard" && (flag(i, "debtor_or_discharged") || flag(i, "debt_discharged")) && !(flag(i, "reaffirmed") && flag(i, "rescission_window_lapsed")), "modified_ch7_11 / modified_ch12_13 until reaffirmation is final or the case is dismissed without discharge"),
      never("NO_SUPPRESSION_FOR_RETURNED_MAIL", "14.3 guardrail: statements are never suppressed for returned mail", (i) => str(i, "reason") === "returned_mail", "address research (4.x); the counsel-addressed copy continues")] },
  // rule 2/3: the (f)(3) figures come from the 14.1 ledger views with the snapshot hash. `op=read` (default) lists/gets the view; `op=verify` checks
  // figures an agent is about to merge against the stored view and refuses any difference — the LLM never alters figures, and any write-shaped input is refused.
  { name: "bk.ledger_views.read", kind: "read", handler: compute((i, ctx, rt) => {
      if (altersFigures(i)) throw new RangeError("bk.ledger_views.read is read-only — the LLM never alters figures; corrections go through 14.1's ledger tools");
      const op = str(i, "op") || "read"; const view = read("bankruptcy_ledger_views")(i, ctx, rt);
      if (op === "read") return view;
      if (op === "verify") {
        need(i, "id", "figures"); const stored = obj(view); if (!stored) throw new RangeError(`bankruptcy_ledger_views ${str(i, "id")} not found`);
        const figures = obj(i.figures) ?? {}; const diffs = Object.keys(figures).filter((k) => String(stored[k]) !== String(figures[k]));
        if (diffs.length) throw new RangeError(`figures differ from bankruptcy_ledger_views ${str(i, "id")} for ${diffs.join(", ")} — the LLM never alters figures; re-read the view`);
        return { verified: true, id: str(i, "id"), ledger_view_hash: stored.ledger_view_hash ?? stored.snapshot_hash ?? null, figures };
      }
      throw new RangeError(`op ${op} is not one of read/verify`); }),
    guardrails: [never("LLM_NEVER_ALTERS_FIGURES", "14.3 guardrail: the LLM never alters figures", altersFigures, "figures come from bankruptcy_ledger_views (14.1) with the snapshot hash; corrections go through 14.1's ledger tools")] },
  // rule 4: docket facts (attorney appearance, orders, plan treatment, SOI) feed addressing and the variant.
  { name: "docket.read", kind: "read", handler: read("bankruptcy_docket_events") },
  // rule 5: LLM classification of inbound letters as cease/resume/other with confidence; human verification < 0.90; never from a phone call.
  // A written request for statements that ends an exemption publishes `bankruptcy.statement_resumption.scheduled` at receipt (REGZ_1026_41E5II_RESUME_NEXT_CYCLE).
  { name: "requests.classify", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "channel", "kind"); const loanId = str(i, "loan_id");
      const r = classifyRequest({ channel: str(i, "channel") as RequestChannel, kind: str(i, "kind") as "cease", confidence: Number.isFinite(num(i, "confidence")) ? num(i, "confidence") : 0, from: (str(i, "from") || "debtor") as RequestFrom, at_exclusive_address: flag(i, "at_exclusive_address") });
      if (r.refusal) throw new RangeError(r.refusal);
      const receivedAt = str(i, "received_at") || ctx.now; const receivedOn = D(receivedAt.slice(0, 10));
      const st = caseState(rt, loanId, str(i, "status_id") || `bkss-${loanId}`, receivedOn);
      // a written request for statements: the exemption it ends (the loan's recorded mode; assumed a cease-request exemption when nothing is recorded), the skippable cycle and the statement that must go out (rule 5; comment 41(f)(3)-3)
      let resumption: ReturnType<typeof statementResumption> = null; let resume: ReturnType<typeof resumeRequest> | null = null; let notExempt = false;
      if (r.effective && r.kind === "resume") {
        const before = (str(i, "mode_before") || (st.prior ? String(st.prior.mode) : "exempt_cease_request")) as StatementMode;
        if (!isStatementMode(before)) throw new RangeError(`mode_before ${before} is not one of ${STATEMENT_MODES.join("/")}`);
        if (isExempt(before)) {
          resume = resumeRequest({ received_on: receivedOn, from: (str(i, "from") || "debtor") as RequestFrom, in_writing: true, chapter: chapterOf(i, st) ?? "13", court_order_cease: before === "exempt_court_order", rendered_for_open_cycle: flag(i, "rendered_for_open_cycle"), exempt_since: dateOf(st.prior?.effective_on) ?? receivedOn, ...(i.due_day !== undefined ? { due_day: Number(i.due_day) } : {}) });
          if (resume.honoured) resumption = statementResumption({ basis: "written_request", event_on: receivedOn, mode_before: before, mode_after: resume.mode_after, rendered_for_open_cycle: flag(i, "rendered_for_open_cycle"), ...(i.due_day !== undefined ? { due_day: Number(i.due_day) } : {}) });
        } else notExempt = true;
      }
      const anchor = resumption ? { ends_exemption: true, mode_after: resumption.mode_after, skippable_statement_due_by: resumption.skippable_statement_due_by, resume_statement_due_by: resumption.resume_statement_due_by, first_statement_activity_from: resume?.first_statement_activity_from ?? null } : resume ? { ends_exemption: false, refusal: resume.refusal } : notExempt ? { ends_exemption: false, refusal: "statements are not exempt on this loan — the request is logged; nothing resumes (the most recent written request controls, comment 41(e)(5)-2)" } : {};
      const rec = rt.store.put("bankruptcy_statement_requests", str(i, "id") || `bkreq-${loanId}-${receivedAt}`, { loan_id: loanId, kind: r.kind, from: str(i, "from") || "debtor", channel: str(i, "channel"), received_at: receivedAt, document_id: opt(i, "document_id"), confidence: num(i, "confidence"), in_writing: r.in_writing, at_exclusive_address: flag(i, "at_exclusive_address"), logged_off_address: r.logged_off_address, status: r.human_verification ? "pending_human_verification" : r.effective ? "effective" : "logged", ...anchor }, ctx.actor, ctx.now);
      if (r.human_verification) rt.escalations.open({ kind: "human_agent", loanId, payload: { request_id: rec.id, kind: r.kind, confidence: num(i, "confidence"), reason: "classification below 0.90 — verify the letter before it takes effect (14.3 rule 5)" } }, ctx.actor);
      if (r.effective) ctx.events.append({ type: "bankruptcy.statement_request.received", loanId, aggregate: { kind: "bankruptcy_statement_requests", id: rec.id }, actor: ctx.actor, payload: { kind: r.kind, from: str(i, "from") || "debtor", received_at: receivedAt, document_id: opt(i, "document_id"), in_writing: true, at_exclusive_address: flag(i, "at_exclusive_address"), ...anchor } });
      if (resumption) ctx.events.append({ type: RESUMPTION_EVENT, loanId, aggregate: { kind: "bankruptcy_statement_requests", id: rec.id }, actor: ctx.actor, payload: { ...resumption, request_id: rec.id, document_id: opt(i, "document_id"), from: str(i, "from") || "debtor" } });
      return { ...r, request_id: rec.id, status: rec.data.status, resumption }; }),
    guardrails: [never("NO_CEASE_FROM_PHONE_CALL", "14.3 guardrail: a cease request is never inferred from a phone call (writing required — a call is answered with instructions for a written request; an authenticated portal message counts as writing)", (i) => str(i, "channel") === "phone" && /^(cease|resume)$/.test(str(i, "kind")), "log the call and send the written-request instructions"),
      never("NO_REQUEST_WITHOUT_IMAGE", "14.3 rule 5: the request image is the exemption evidence", (i) => str(i, "kind") === "cease" && str(i, "channel") !== "phone" && !str(i, "document_id"), "attach the letter / portal message as document_id")] },
  // escalations: attorney when an order/instruction conflicts with (f) or local rules restrict debtor contact; human_agent on request; officer for a portfolio-wide suppression; none to Fannie Mae.
  { name: "escalation.file", kind: "act", handler: compute((i, ctx, rt) => {
      const scope = str(i, "scope") || "loan"; const requested = str(i, "kind");
      const kind: EscalationKind = scope === "portfolio" ? "officer" : (ESCALATION_KINDS as readonly string[]).includes(requested) ? (requested as EscalationKind) : "attorney";
      return rt.escalations.open({ kind, loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: (i.payload as Record<string, unknown> | undefined) ?? { reason: i.reason ?? null, scope, conflict: i.conflict ?? null }, ...(typeof i.severity === "string" ? { severity: i.severity } : {}), ...(typeof i.case_id === "string" ? { caseId: i.case_id } : {}) }, ctx.actor); }),
    guardrails: [never("NONE_TO_FANNIE_MAE", "14.3 escalations: attorney / human_agent / officer — none to Fannie Mae", (i) => str(i, "kind") === "fnma_portal_operator" || str(i, "kind") === "human_portal_task" || flag(i, "to_fannie_mae"), "statement/communication decisions in bankruptcy are the servicer's; nothing is filed with Fannie Mae")] },
]);
