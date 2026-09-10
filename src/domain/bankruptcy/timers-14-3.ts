/**
 * §14.3 timer satisfaction overrides: for every 14.3 registry row whose "Satisfied by"
 * column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides, so these win the merge.
 *
 * Event shapes are the ones the platform emits, checked by 14-3.spec.test.ts against the events the 14.3 tools
 * append (eventMatches + defaultAnchorResolver, and a TimerEngine over this registry):
 *  - the Notice Registry's `notice.sent` carries the template code as `template` (src/notices/service.ts `emit`:
 *    `{ notice_id, template, channels, sent_at }`);
 *  - 14.1 publishes phase changes as `bankruptcy.status.changed{to}` and the petition as `bankruptcy.petition.filed{chapter,
 *    petition_date, fnma_delinquency_days, …}` — neither carries the §1024.39(c) qualifiers the spec's trigger columns add
 *    (`regx_days_delinquent > 0` at the petition, loss-mit available, no FDCPA cease; "after discharge (no reaffirmation) on a
 *    delinquent loan"; "next payment due date after the event"), and cashiering's `payment.received` carries `delinquent`
 *    but no discharge facts. Those facts are 14.3 rule 6's decision (ops-14-3.ts earlyInterventionEvaluation), which
 *    bankruptcy-ops publishes through bk.statement_mode.set as `bankruptcy.early_intervention.evaluated{trigger, required,
 *    timer, …}` with the registry row's anchor in the payload — so the four §1024.39(c) rows arm on that event, never on
 *    a payload field the emitter does not carry;
 *  - requests.classify emits the spec's `bankruptcy.statement_request.received{kind, from, received_at, document_id,
 *    in_writing, at_exclusive_address}` and, for a written request for statements that ends an exemption, the derived
 *    `bankruptcy.statement_resumption.scheduled{basis, resume_statement_due_by, …}` (ops-14-3.ts statementResumption) that
 *    bk.statement_mode.set also emits for a reaffirmation and the other exemption-ending events — one event for the
 *    row's two spec triggers (the registry grammar holds one pattern per row);
 *  - bk.statement_mode.set emits `bankruptcy.statement_mode.set{mode, …}` and `bankruptcy.addressing.decided{basis_present}`;
 *  - 11.1's counter job emits `loan.delinquency.window_opened{due_date, principal_residence, live_due_at, notice_due_at}`
 *    (src/domain/early-intervention/ops.ts counterRun) — the "clocks re-armed" event, with no bankruptcy flag.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

const EI_EVENT = "bankruptcy.early_intervention.evaluated";
const EI_SENT = "`notice.sent{template=NTC_REGX_39B_EARLY_INTERVENTION_BK}`";

export function applySatisfiedOverrides_14_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- early intervention in bankruptcy (§1024.39(c)) — the rule-6 decision event (ops-14-3.ts earlyInterventionEvaluation via bk.statement_mode.set).
  // `notice.sent{template=…}` is the send event; "no payment request" is enforced at render (checklist block REGX_39C1_NO_PAYMENT_REQUEST), so a sent notice never carries one.
  o("REGX_1024_39C1_BK_WRITTEN_NOTICE_45", { trigger: `\`${EI_EVENT}{trigger=petition, required=true, timer=REGX_1024_39C1_BK_WRITTEN_NOTICE_45}\``, anchorField: "petition_date", offset: "45 calendar_days", satisfied: EI_SENT,
    why: "§14.3 timer table: '`bankruptcy.petition.filed` with `regx_days_delinquent > 0` at the petition, loss-mit available, no FDCPA cease' → '`NTC_REGX_39B_EARLY_INTERVENTION_BK` sent (borrower or counsel)' by the 45th day after the petition (fixture 2026-09-08 + 45 = 2026-10-23; 14.3-T7). 14.1's `bankruptcy.petition.filed` carries `fnma_delinquency_days` but neither the Reg X delinquency nor the loss-mit/FDCPA facts, so the row arms on rule 6's decision (`earlyInterventionAtPetition`: required only with regx_days_delinquent > 0, an available option — comment 39(c)(1)(ii)-1 — and no §805(c) cease), published by bk.statement_mode.set with `petition_date` as the anchor; the Notice Registry's `notice.sent` names the code as `template`; no payment request (§1024.39(c)(1)(iii)(A)–(B)) is a render-time block." });
  o("REGX_1024_39B_BK_LATER_DELINQUENCY_45", { trigger: `\`${EI_EVENT}{trigger=later_delinquency, required=true, timer=REGX_1024_39B_BK_LATER_DELINQUENCY_45}\``, anchorField: "unpaid_due_date", offset: "45 calendar_days", satisfied: EI_SENT,
    why: "§14.3 timer table: '`delinquency.day45.reached` (post-petition ledger or contractual for ch. 7) during the case, no prior notice this case' → 'notice sent (once per case)' — 11.2's day-45 crossing is not an emitted event on a bankruptcy loan (11.x's `loan.delinquency.window_opened` carries no case facts and 11.x is gated by 14.1's stay gates), so the row arms on rule 6's decision (`laterDelinquencyDuringCase`: refused once the case's one notice went out — §1024.39(c)(1)(iii)(C); comment 39(c)(2)-1), anchored on the unpaid due date: +45 calendar days is the 45th day of delinquency under the 11.x convention (day 1 = the day after the due date; 14.3-T7: Feb-1-2027 unpaid → 2027-03-18) — the spec's 'day 1 of delinquency' + 45 would be day 46; satisfied by the Registry's `notice.sent{template}`." });
  o("REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE", { trigger: `\`${EI_EVENT}{trigger=discharge_payment, required=true, timer=REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE}\``, anchorField: "next_due_date", offset: "45 calendar_days", satisfied: EI_SENT,
    why: "§14.3 timer table: 'first `payment.received` after discharge (no reaffirmation) on a delinquent loan' → 'written notice (no payment request)' — offset 'per 11.2 (45 days of delinquency measured from the next due date)'. Cashiering's `payment.received` carries `delinquent` but no discharge/reaffirmation facts (14.1 case record), so the row arms on rule 6's decision (`postDischargePayment`: payment on/after the discharge, no reaffirmation, delinquent) with `next_due_date` as the anchor and 11.2's 45 calendar days as the offset (14.3-T10: paid 2027-02-03 → next due 2027-03-01 → 2027-04-15); live contact never resumes (§1024.39(c)(2)(ii)); satisfied by the Registry's `notice.sent{template}`." });
  o("REGX_1024_39C2_RESUME_GATE", { trigger: `\`${EI_EVENT}{trigger=resume, required=true, timer=REGX_1024_39C2_RESUME_GATE}\``, anchorField: "resume_from_due_date", evaluator: "14.3.earlyInterventionResumeGate", satisfied: "`loan.delinquency.window_opened`",
    why: "§14.3 timer table: '`bankruptcy.case.dismissed/closed` or `bankruptcy.reaffirmation.approved`' → 'next payment due date after the event' → '11.1/11.2 clocks re-armed from that due date'. 14.1's `bankruptcy.status.changed{to=dismissed}` / `bankruptcy.case.dismissed{dismissed_on}` carry no due-date facts, so the gate arms on rule 6's decision (`earlyInterventionResume`: 14.3-T9 dismissed 2027-06-05 → 2027-07-01; live by 2027-08-06, notice by 2027-08-15; never for a discharge without reaffirmation — (c)(2)(ii)) whose payload is the `14.3.earlyInterventionResumeGate` facts (§1024.39(c)(2)(i): open after the due date), and is satisfied by 11.1's counter job re-opening the windows — `loan.delinquency.window_opened` as src/domain/early-intervention/ops.ts counterRun emits it (no `after_bk_resume` flag exists; a window opened before the dismissal cannot satisfy a gate armed after it)." });
  // ---- statements (§1026.41(e)(5)/(f)) — bk.statement_mode.set emits `bankruptcy.statement_mode.set{mode}`; the transition is computed by ops-14-3.ts transitionAfterEvent / ceaseRequest / resumeRequest / statementResumption
  o("REGZ_1026_41E5_CEASE_EFFECTIVE_0", { trigger: "`bankruptcy.statement_request.received{kind=cease, in_writing=true}`", satisfied: "`bankruptcy.statement_mode.set{mode=exempt_cease_request}`",
    why: "§14.3 timer table: a written cease request 'at the exclusive address (or from counsel)' is effective on receipt (comment 41(e)(5)-3) → '`mode=exempt_cease_request` recorded same day'; a request received elsewhere is honoured anyway and logged (rule 5). requests.classify emits the event with `in_writing=true` only for a written, verified request." });
  o("REGZ_1026_41E5II_RESUME_NEXT_CYCLE", { trigger: "`bankruptcy.statement_resumption.scheduled{basis∈{written_request, reaffirmation}}`", anchorField: "resume_statement_due_by", offset: "0", satisfied: "`notice.sent{template∈{NTC_REGZ_41_STMT_BK7_11, NTC_REGZ_41_STMT_BK12_13, NTC_REGZ_41_STMT_STD}}`",
    why: "§14.3 timer table: '`bankruptcy.statement_request.received{resume}` or `bankruptcy.reaffirmation.*`' → 'statement sent' at the next cycle with the single-statement exemption available (§1026.41(e)(5)(ii), (iv)). The registry grammar holds one trigger per row and the request event carries no cycle geometry, so both spec triggers publish `bankruptcy.statement_resumption.scheduled` (ops-14-3.ts statementResumption): requests.classify at receipt of a written request for statements (`basis=written_request`), bk.statement_mode.set when the reaffirmation is recorded (`basis=reaffirmation`); `resume_statement_due_by` is the statement that must go out after the skippable cycle (14.3-T5: request 2027-03-03 → the statement due by 2027-03-20 skippable, the next one due by 2027-04-20) — satisfied by the Registry's `notice.sent{template}` for the H-30(E)/(F)/(A) statement variants." });
  o("SM_BK_STATEMENT_MODE_SYNC_1BD", { satisfied: "`bankruptcy.statement_mode.set`", why: "§14.3 timer table: '`bk_statement_status` updated' within 1 `business_days_servicer` of `bankruptcy.status.changed` — the bk.statement_mode.set tool's event." });
  o("SM_BK_COUNSEL_ROUTE_CONFIRM_5BD", { satisfied: "`bankruptcy.addressing.decided{basis_present=true}`", why: "§14.3 timer table: '`addressing` decided with basis' within 5 `business_days_servicer` of the attorney's appearance (rule 4 precedence: order/local rule, counsel's instruction, Reg F §1006.6(b)(2), debtor of record — ops-14-3.ts addressingDecision)." });
}
