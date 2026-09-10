/**
 * §1.7 tools — the spec's ten tool strings for the `lossmit-underwriter` agent, verbatim, via `defineTools("1.7", …)`
 * (spec/registry/agents.json names them; src/app/tools.test.ts refuses any other name and any duplicate, so every further
 * act of the process runs as an `op` of one of the ten — the same bus, the same guardrails). Process-owned since the
 * block moved out of ./section01.ts (its `p17` slot is empty). The code paths live in src/domain/transfers/ops-1-7.ts,
 * lossmit-inflight.ts and inbound.ts. Event vocabulary (what the §1.7 timer table keys on):
 *
 *   loadTransferorFile     transferor_lossmit_files row + lossmit.transfer.file_loaded; op=open_case → lossmit.case.opened{origin=transferor}
 *                          (+ lossmit.appeal.pending_at_transfer → REGX_1024_41K4_APPEAL_DETERMINATION_30); op=forwarded_appeal → the
 *                          transferor's post-transfer forwarding of an appeal: lossmit.appeal_window.closed{appeal_received}
 *                          (REGX_1024_41H_APPEAL_WINDOW_14) + lossmit.appeal.received (K4 clock)
 *   runCarryoverChecks     per case: lossmit.carryover.verified | .deficient (SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2 armed) + lossmit_carryover_checks rows;
 *                          op=batch → every case of the tape, then lossmit.carryover.verified{all_cases=true} (SM_LOSSMIT_FILE_VERIFY_T0 satisfied)
 *   computeDeemedDates     the (k) dates; op=boarding_facts → what BoardingService.board spreads onto loan.boarded (the (k) clock triggers);
 *                          op=seed_gates → delinquency.counters.updated{seeded_at_boarding} (REGX_1024_41F1_120_DAY_GATE seeded from transferor dates);
 *                          op=appeal_window_expired → lossmit.appeal_window.closed{expired} (only after the window end)
 *   classifyCompleteness   status under Supermortgage's criteria (completeness date unchanged — comment 41(k)(1)(i)-2)
 *   requestFromTransferor  lossmit.transferor_request.sent (SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2 satisfied); borrower never asked first
 *   evaluateOptions        transferor offer / forbearance room; op=smdu_access → smdu.case.accessible (SM_SMDU_CASE_ACCESS_T0) |
 *                          smdu.case.inaccessible + human_portal_task to fnma_portal_operator
 *   draftNotice            Notice Registry render; a denial renders only with a lossmit_reviewer approval record (1.7-T9)
 *   setForeclosureHold     foreclosure_holds row + foreclosure.hold.set; op=referral → the `foreclosure.referral` command through
 *                          REGX_1024_41K2_NO_FIRST_FILING_GATE (refused before the day after the reasonable date; 1.7-T5)
 *   honorTransferorOffer   accepted → plan_active on the original terms: lossmit.offer.closed{accepted} (REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE);
 *                          op=expire → lossmit.offer.closed{expired}, refused before the original acceptance_deadline
 *   writeDecision          agent_decisions row {case_id, deemed_received_at, completeness, timers_seeded, options_evaluated, smdu_case_id, outcome, reasons, reviewer}
 */
import { defineTools, write, decision, noticeOps, compute, guard, never, str, num, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { deemedReceived, transfereeAckDue, transfereeEvaluationDue, transfereeAppealDue, honorTransferorOffer, forbearanceCarryover, documentRequestOrder, firstFilingGate } from "../../domain/transfers/lossmit-inflight.ts";
import { verifyCarryover, requestFromTransferor as sendTransferorRequest, honorTransferorOfferCase, type TransferorLossmitFile, type InheritedOffer } from "../../domain/transfers/inbound.ts";
import { inflightBoardingFacts, openInheritedCase, seedDelinquencyCounters, verifyBatchCarryover, smduCaseAccessChecked, closeAppealWindow, expireTransferorOffer, foreclosureReferralGate, type StagedLossmit, type BatchCarryoverCase, type SmduCaseRecord } from "../../domain/transfers/ops-1-7.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const today = (i: ToolInput, ctx: { now: string }, k = "today"): PlainDate => D(str(i, k) || ctx.now.slice(0, 10));
const loanOf = (i: ToolInput, ctx: { loanId: string }): string => str(i, "loan_id") || ctx.loanId;
const putChecks = (rt: Parameters<Parameters<typeof compute>[0]>[2], ctx: { actor: Parameters<typeof rt.store.put>[3]; now: string }, caseId: string, checks: readonly { code: string; title: string; result: string }[]): void => {
  for (const c of checks) rt.store.put("lossmit_carryover_checks", `${caseId}:${c.code}:${ctx.now}`, { case_id: caseId, check_code: `${c.code} ${c.title}`, result: c.result, requested_from_transferor_at: null, resolved_at: null }, ctx.actor, ctx.now);
};

export const TOOLS_1_7: readonly ToolDef[] = defineTools("1.7", "lossmit-underwriter", [
  { name: "loadTransferorFile", kind: "write", handler: compute((i, ctx, rt) => {
      switch (i.op ?? "load") {
        case "load": return write("transferor_lossmit_files", "lossmit.transfer.file_loaded")(i, ctx, rt);
        // `loan.boarded{lossmit_in_process=true}` → `lossmit` case with origin='transferor' (1.7 inputs / data model `cases`).
        case "open_case": { need(i, "case_id", "transfer_date"); const r = openInheritedCase(ctx.events, { case_id: str(i, "case_id"), loan_id: loanOf(i, ctx), batch_id: str(i, "batch_id"), transfer_date: D(str(i, "transfer_date")), lossmit: (i.lossmit as StagedLossmit | undefined) ?? { in_process: true, inherited_file: (i.file as TransferorLossmitFile | undefined) ?? null } }, ctx.actor);
          rt.store.put("cases", r.case_id, { case_id: r.case_id, case_type: "lossmit", loan_id: loanOf(i, ctx), origin: "transferor", status: r.status, transferor_received_at: r.facts.transferor_received_at, subject_to_1024_41_at_transferor: r.facts.prior_1024_41_subject, completeness_status: r.facts.completeness_status, complete_at: r.facts.complete_at, transferor_ack_sent_at: r.facts.transferor_ack_sent_on, transferor_reasonable_date: r.facts.transferor_reasonable_date, appeal_received_at: r.facts.appeal_received_at, deemed_received_at: r.facts.deemed_received_at, forbearance_history: r.facts.forbearance_history, smdu_case_id: r.facts.smdu_case_id }, ctx.actor, ctx.now);
          return { case_id: r.case_id, status: r.status, facts: r.facts, appeal_determination_due: r.appeal?.determination_due ?? null }; }
        // Transferor SFTP daily forwarding (or a direct submission): an appeal against the transferor's denial, timely by its receipt date (comment 41(k)(4)-1).
        case "forwarded_appeal": { need(i, "case_id", "transfer_date", "appeal_window_end", "received_on"); return closeAppealWindow(ctx.events, { case_id: str(i, "case_id"), loan_id: loanOf(i, ctx), transfer_date: D(str(i, "transfer_date")), appeal_window_end: D(str(i, "appeal_window_end")) }, { kind: "appeal_received", received_on: D(str(i, "received_on")), received_by: i.received_by === "transferee" ? "transferee" : "transferor" }, ctx.actor); }
        default: throw new RangeError(`loadTransferorFile op ${str(i, "op")} is not one of load/open_case/forwarded_appeal`);
      } }) },
  // "verifies each inherited file": the CO-01…CO-10 checks on the transferor's file, emitting `lossmit.carryover.verified` / `.deficient` (SM_LOSSMIT_FILE_VERIFY_T0 / SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2), plus the carry-over gates.
  { name: "runCarryoverChecks", kind: "act", handler: compute((i, ctx, rt) => {
      const boardedOn = D(str(i, "boarded_on") || str(i, "transfer_date") || ctx.now.slice(0, 10));
      if (i.op === "batch") {                                                    // every case of the lossmit tape; the batch roll-up closes SM_LOSSMIT_FILE_VERIFY_T0
        need(i, "batch_id", "transfer_date"); const cases = (i.cases as readonly BatchCarryoverCase[] | undefined) ?? [];
        const r = verifyBatchCarryover(ctx.events, { batch_id: str(i, "batch_id"), transfer_date: D(str(i, "transfer_date")) }, cases, boardedOn, ctx.actor);
        for (const c of r.results) putChecks(rt, ctx, c.case_id, c.checks);
        return { batch_id: r.batch_id, verified: r.verified, deficient: r.deficient, results: r.results.map((c) => ({ case_id: c.case_id, status: c.status, failed: c.failed, transferor_request_due: c.transferor_request_due })) };
      }
      const file = (i.file as TransferorLossmitFile | null | undefined);
      const checks = file !== undefined && str(i, "case_id") ? verifyCarryover(ctx.events, { case_id: str(i, "case_id"), loan_id: loanOf(i, ctx) }, file, boardedOn, ctx.actor) : null;
      if (checks) putChecks(rt, ctx, str(i, "case_id"), checks.checks);
      return { ...(checks ? { status: checks.status, checks: checks.checks, failed: checks.failed, transferor_request_due: checks.transferor_request_due, borrower_request_allowed: checks.borrower_request_allowed, ask_order: checks.ask_order } : {}),
        forbearance: forbearanceCarryover(num(i, "cumulative_forbearance_months") || 0, num(i, "requested_months") || 0), first_filing: firstFilingGate(i.reasonable_date ? D(str(i, "reasonable_date")) : null, today(i, ctx)), document_request_order: documentRequestOrder(flag(i, "transferor_failed")) }; }) },
  { name: "computeDeemedDates", kind: "act", handler: compute((i, ctx) => {
      switch (i.op ?? "dates") {
        case "dates": { need(i, "transfer_date"); const T = D(str(i, "transfer_date")); const atT = flag(i, "subject_at_transferor"); return { deemed_received: deemedReceived(D(str(i, "transferor_received_on") || str(i, "transfer_date")), atT, T), ack_due: transfereeAckDue(T, atT), evaluation_due: transfereeEvaluationDue(T), ...(i.appeal_received_on ? { appeal_due: transfereeAppealDue(T, D(str(i, "appeal_received_on"))) } : {}) }; }
        // The `loan.boarded` facts the (k) clocks arm on — the same computation BoardingService.board spreads onto the event.
        case "boarding_facts": { need(i, "transfer_date"); return inflightBoardingFacts((i.lossmit as StagedLossmit | undefined) ?? { in_process: true, inherited_file: (i.file as TransferorLossmitFile | undefined) ?? null }, D(str(i, "transfer_date"))); }
        // REGX_1024_41F1_120_DAY_GATE "seeded from transferor dates": the boarded loan's §1024.31 counter as of the transfer date.
        case "seed_gates": { const boarded = (i.boarded as DomainEvent | undefined) ?? ctx.events.ofType("loan.boarded").filter((e) => e.loanId === loanOf(i, ctx)).at(-1); if (!boarded) throw new RangeError(`no loan.boarded for ${loanOf(i, ctx)} to seed the 13.1/13.2 gates from`); const e = seedDelinquencyCounters(ctx.events, boarded, ctx.actor); return { seeded: e !== null, event_id: e?.id ?? null, regx_days_delinquent: boarded.payload.regx_days_delinquent ?? null }; }
        // REGX_1024_41H_APPEAL_WINDOW_14 expiry sweep: closes only after the window end (no breach; case not closed before expiry).
        case "appeal_window_expired": { need(i, "case_id", "transfer_date", "appeal_window_end"); return closeAppealWindow(ctx.events, { case_id: str(i, "case_id"), loan_id: loanOf(i, ctx), transfer_date: D(str(i, "transfer_date")), appeal_window_end: D(str(i, "appeal_window_end")) }, { kind: "expired", today: today(i, ctx) }, ctx.actor); }
        default: throw new RangeError(`computeDeemedDates op ${str(i, "op")} is not one of dates/boarding_facts/seed_gates/appeal_window_expired`);
      } }) },
  { name: "classifyCompleteness", kind: "act", handler: compute((i) => { const missing = ((i.required as readonly string[]) ?? []).filter((d) => !((i.received as readonly string[]) ?? []).includes(d)); return { status: missing.length ? "incomplete" : "complete", missing }; }) },
  // `lossmit.transferor_request.sent` (SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2 satisfaction): the transferor is asked first; the borrower only after the transferor fails to produce.
  { name: "requestFromTransferor", kind: "write", handler: compute((i, ctx, rt) => { need(i, "case_id"); const req = sendTransferorRequest(ctx.events, { case_id: str(i, "case_id"), loan_id: loanOf(i, ctx) }, Array.isArray(i.items) ? (i.items as string[]).map(String) : [], D(str(i, "sent_on") || ctx.now.slice(0, 10)), ctx.actor);
      rt.store.put("transferor_document_requests", req.request_id, { case_id: str(i, "case_id"), ...req, ...data(i) }, ctx.actor, ctx.now); return req; }),
    guardrails: [never("TRANSFEROR_BEFORE_BORROWER", "1.7 state machine / comment 41(k)(1)(i)-1: the borrower is not asked until the transferor has failed to produce", (i) => flag(i, "ask_borrower") && !flag(i, "transferor_failed"), "ask the transferor first; borrower contact only after the transferor fails to respond")] },
  { name: "evaluateOptions", kind: "act", handler: compute((i, ctx, rt) => {
      // SM_SMDU_CASE_ACCESS_T0: the inherited SMDU case answers under the partner's servicer number before any evaluation is submitted through it.
      if (i.op === "smdu_access") { need(i, "case_id", "smdu_case_id", "partner_servicer_number", "transfer_date"); return smduCaseAccessChecked(ctx.events, rt.escalations, { case_id: str(i, "case_id"), loan_id: loanOf(i, ctx), smdu_case_id: str(i, "smdu_case_id"), partner_servicer_number: str(i, "partner_servicer_number"), transfer_date: D(str(i, "transfer_date")), record: (i.record as SmduCaseRecord | null | undefined) ?? null, fnma_loan_number: (i.fnma_loan_number as string | undefined) ?? null }, today(i, ctx), ctx.actor); }
      return { transferor_offer: i.accepted_on && i.accept_by ? honorTransferorOffer(D(str(i, "accepted_on")), D(str(i, "accept_by"))) : "none", forbearance: forbearanceCarryover(num(i, "cumulative_forbearance_months") || 0, num(i, "requested_months") || 0) }; }) },
  { name: "draftNotice", kind: "act", handler: noticeOps("render"),
    // 1.7-T9: an AI-proposed denial cannot go out without a `lossmit_reviewer` approval record (the reviewer's decision id rides on the render).
    guardrails: [guard("DENIAL_NEEDS_LOSSMIT_REVIEWER", "1.7 agent design: `lossmit_reviewer` approves every denial/ineligibility and every appeal determination (personnel different from the evaluator)", (i, ctx) => /DENIAL|DENIED/.test(str(i, "template_code")) && ctx.actor.kind !== "human" && !str(i, "reviewer_approval_id") ? "a denial notice renders only with reviewer_approval_id — the lossmit_reviewer's approval record" : undefined)] },
  { name: "setForeclosureHold", kind: "write", handler: compute((i, ctx, rt) => {
      // The `foreclosure.referral` / first-filing command: REGX_1024_41K2_NO_FIRST_FILING_GATE is asserted from the acknowledgment's reasonable date, never a caller flag.
      if (i.op === "referral") { const g = foreclosureReferralGate(ctx.events, loanOf(i, ctx), today(i, ctx)); ctx.events.append({ type: "foreclosure.referral.gate_checked", loanId: loanOf(i, ctx), actor: ctx.actor, payload: { gate: g.gate, open: g.no_first_filing_41k2, reasonable_date: g.reasonable_date, allowed_from: g.allowed_from, checked_on: today(i, ctx) } }); return { ok: true, gates: { no_first_filing_41k2: g.no_first_filing_41k2 }, reasonable_date: g.reasonable_date, allowed_from: g.allowed_from, source: g.source }; }
      return write("foreclosure_holds", "foreclosure.hold.set")(i, ctx, rt); }),
    guardrails: [guard("REGX_1024_41K2_NO_FIRST_FILING_GATE", "§1024.41(k)(2)(ii)(A) / 1.7 timer table: no first notice or filing until a date after the reasonable date disclosed on the incomplete-application acknowledgment — `assertGateOpen` in `foreclosure.referral`; command refused", (i, ctx) => { if (i.op !== "referral") return undefined; const g = foreclosureReferralGate(ctx.events, loanOf(i, ctx), today(i, ctx)); return g.no_first_filing_41k2 ? undefined : `REGX_1024_41K2_NO_FIRST_FILING_GATE closed: no first notice/filing before ${g.allowed_from} (reasonable date ${g.reasonable_date} on the ${g.source} acknowledgment)`; })] },
  // 1.7-T4 / (k)(5): the transferor's offer is honored on its terms; with the case and offer the tool records `accepted` → `plan_active`.
  { name: "honorTransferorOffer", kind: "act", handler: compute((i, ctx) => {
      if (i.op === "expire") { need(i, "case_id", "acceptance_deadline"); return expireTransferorOffer(ctx.events, { case_id: str(i, "case_id"), loan_id: loanOf(i, ctx), option: str(i, "option"), acceptance_deadline: D(str(i, "acceptance_deadline")) }, today(i, ctx), ctx.actor); }
      need(i, "accepted_on", "accept_by"); const decisionOut = honorTransferorOffer(D(str(i, "accepted_on")), D(str(i, "accept_by")));
      if (!i.offer || !str(i, "case_id")) return { decision: decisionOut };
      const r = honorTransferorOfferCase({ case_id: str(i, "case_id"), status: ((i.status as string | undefined) ?? "offer_pending_acceptance") as "offer_pending_acceptance", offer: i.offer as InheritedOffer }, { accepted_on: D(str(i, "accepted_on")), received_by: ((i.received_by as string | undefined) ?? "transferee") as "transferor" | "transferee" });
      ctx.events.append({ type: "lossmit.offer.closed", loanId: loanOf(i, ctx), aggregate: { kind: "case", id: r.case_id }, actor: ctx.actor, payload: { case_id: r.case_id, outcome: r.honored ? "accepted" : "expired", status: r.status, option: r.option, re_underwritten: false } });
      return { decision: decisionOut, ...r }; }),
    guardrails: [never("NO_REUNDERWRITE", "1.7 rule 7 / comment 41(k)(5)-1: Supermortgage does not re-underwrite a transferor offer the borrower timely accepts", (i) => flag(i, "re_underwrite"), "a timely accepted transferor offer is honored on its original terms")] },
  { name: "writeDecision", kind: "act", handler: decision() },
]);
