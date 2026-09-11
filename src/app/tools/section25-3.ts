/**
 * §25.3 process-owned tools — bus tools for 25.3 defined with `defineTools("25.3", "disclosure", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 25.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `disclosure` agent's rescission tools (spec "AI agent design"): determineRescindability, renderRescissionNotice,
 * deliverRescissionNotice, computeRescissionPeriod (op=compute|expire|accept_waiver|flag_extended|lapse_extended),
 * sweepInboundForRescission (op=sweep|close_allowance|record_exercise|complete_unwind), classifyInboundDocument
 * (op=classify|log_oral_candidate), writeDecision. The `funder`'s assertGateOpen(REGZ_1026_23_RESCISSION_3SBD_GATE) /
 * releaseFunding and the `closer`'s unwindClosing are 26.3/26.2 tools that call ops-25-3.ts assertDisburseAllowed.
 * Guardrails encode the paragraph: never mark a notice delivered without per-consumer evidence; never compute the period
 * from consummation alone; never release funding before `expires_at` unless a `rescission_waivers` row is accepted by
 * `officer`; never draft or suggest waiver language; never classify an inbound "I want to cancel" message as anything
 * other than a rescission candidate; never separate the new-advance and payoff disbursements for an H-9 loan.
 * State lives in the entity store (`rescission_periods`, `rescission_exercises`, `rescission_waivers`, `disclosures`);
 * every event goes through ops-25-3.ts so the 25.3 gates and clocks arm and close.
 */
import { defineTools, compute, decision, never, needsRole, str, num, flag, cents, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { ToolRuntime } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { determineRescindability, recordApplicability, rescissionNoticePayload, recordNoticeDelivery, computeRescissionPeriod, startPeriod, expirePeriod, acceptRescissionWaiver, flagExtendedRight, lapseExtendedRight, sweepChannels, confirmNotRescinded, closeMailAllowance, recordExercise, unwindChecklist, completeUnwind, classifyInboundDocument, logOralCandidate, rescissionIdFor, servicingHandoffFields, templateCodeFor,
  type RescindabilityInput, type RescissionConsumer, type ExistingLoan, type Rescindability, type RescissionPeriod, type NoticeDelivery, type MaterialDisclosureDelivery, type RescissionForm, type WaiverStatementInput, type InboundChannel, type InboundItem, type ExerciseInput, type RescissionExercise, type UnwindEvidence, type LapseReason, type CreditorDesignation } from "../../domain/compliance-disclosures/ops-25-3.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`25.3 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("25.3 tool needs application_id (every 25.3 event carries it so the rescission clocks arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => D(str(i, k));
const tzOf = (i: ToolInput): string => str(i, "time_zone") || "America/Phoenix";
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const periodOf = (rt: ToolRuntime, application_id: string): RescissionPeriod => { const r = rt.store.get("rescission_periods", rescissionIdFor(application_id)); if (!r) throw new RangeError(`no rescission_periods row for ${application_id} — run determineRescindability / computeRescissionPeriod first`); return r.data as unknown as RescissionPeriod; };
const rescindabilityOf = (rt: ToolRuntime, application_id: string): Rescindability | null => { const r = rt.store.get("rescission_periods", rescissionIdFor(application_id)); return r ? ((r.data.rescindability as Rescindability | undefined) ?? null) : null; };
const putPeriod = (rt: ToolRuntime, ctx: CommandContext, p: RescissionPeriod, extra: Record<string, unknown> = {}): void => { rt.store.put("rescission_periods", p.rescission_id, { ...(p as unknown as Record<string, unknown>), ...extra }, ctx.actor, ctx.now); };
const CANCEL = /\b(cancel|rescind|rescission)\b/i;

export const TOOLS_25_3: readonly ToolDef[] = defineTools("25.3", "disclosure", [
  { name: "determineRescindability", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "transaction_type", "consumers", "partner_id", "amount_financed_cents");
      const application_id = appOf(i, ctx);
      const existing = i.existing_loan ? bigints(i.existing_loan as ExistingLoan, ["upb_cents", "earned_unpaid_finance_charge_cents", "refinancing_costs_cents"]) : null;
      const input: RescindabilityInput = { application_id, transaction_type: str(i, "transaction_type") as RescindabilityInput["transaction_type"], consumers: list<RescissionConsumer>(i, "consumers"), partner_id: str(i, "partner_id"), predecessor_creditor_ids: list<string>(i, "predecessor_creditor_ids"), existing_loan: existing, amount_financed_cents: cents(i.amount_financed_cents), state_agency_creditor: flag(i, "state_agency_creditor") };
      const r = determineRescindability(input);
      const ev = recordApplicability(ctx.events, r, ctx.actor, ctx.now);
      const period = computeRescissionPeriod({ application_id, rescindability: r, consummation_at: null, time_zone: tzOf(i), notice_deliveries: [], material_disclosures: [], material_disclosures_accurate: true });
      putPeriod(rt, ctx, period, { rescindability: r });
      return { ...r, rescindable_amount_cents: r.rescindable_amount_cents, status: period.status, event_id: ev.id }; }),
    guardrails: [never("NO_SEPARATE_H9_DISBURSEMENT", "25.3 guardrails: never separate the new-advance and payoff disbursements for an H-9 loan (decision 25.3-Q3)", (i) => i.separate_disbursements === true || i.escrow_exempt_portion === true || i.partial_release === true, "the entire disbursement (payoff and new advance) is held until expiry; no escrow disbursement of the exempt portion")] },
  { name: "renderRescissionNotice", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "form", "consumer_id", "consumer_name", "transaction_date", "creditor_name", "designated_address", "property_address");
      const form = str(i, "form") as RescissionForm; const application_id = appOf(i, ctx);
      const period = rt.store.get("rescission_periods", rescissionIdFor(application_id))?.data as unknown as RescissionPeriod | undefined;
      const expires_on = i.expires_on ? dateIn(i, "expires_on") : period?.expires_on ?? null;
      const creditor: CreditorDesignation = { creditor_name: str(i, "creditor_name"), designated_address: str(i, "designated_address"), designated_email: (i.designated_email as string | undefined) ?? null, designated_fax: (i.designated_fax as string | undefined) ?? null };
      const payload = rescissionNoticePayload({ form, consumer_id: str(i, "consumer_id"), consumer_name: str(i, "consumer_name"), transaction_date: dateIn(i, "transaction_date"), expires_on, creditor, rescindable_amount_cents: i.rescindable_amount_cents !== undefined ? cents(i.rescindable_amount_cents) : period ? rescindabilityOf(rt, application_id)?.rescindable_amount_cents ?? null : null, property_address: str(i, "property_address"), copies: i.copies === undefined ? 2 : num(i, "copies") });
      const template_code = templateCodeFor(form);
      const rendered = rt.notices ? rt.notices.render({ templateCode: template_code, loanId: (i.loan_id as string | undefined) ?? ctx.loanId, recipients: [], payload, asOf: D(str(i, "as_of") || ctx.now.slice(0, 10)) }) : null;
      const id = `${application_id}:${form}:${str(i, "consumer_id")}:${ctx.now}`;
      rt.store.put("disclosures", id, { application_id, kind: form === "h9" ? "rescission_h9" : "rescission_h8", consumer_id: str(i, "consumer_id"), status: "rendered", rendered_at: ctx.now, template_code, payload, retention_class: "regz_cd_5y" }, ctx.actor, ctx.now);
      return { disclosure_id: id, template_code, payload, ...(rendered ? { notice: rendered } : {}) }; }),
    guardrails: [never("NO_WAIVER_LANGUAGE", "25.3 guardrails: never draft or suggest waiver language (§1026.23(e) 'Printed forms for this purpose are prohibited')", (i) => i.form === "waiver" || i.include_waiver_text === true || i.waiver_language !== undefined || i.suggest_waiver === true, "the notice is the Appendix H model form only; the portal offers a blank field with no template wording for a consumer's own emergency statement"),
      never("H9_ONLY_SAME_CREDITOR", "§1026.23(f)(2); comment 23(f)-4: only a refinancing by the original creditor uses H-9", (i) => i.form === "h9" && i.original_creditor_match === false, "an H-9 on a loan whose prior creditor was different is a defective notice (edge case: extended_3y and legal review) — render H-8")] },
  { name: "deliverRescissionNotice", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "consumer_id", "delivered_at", "channel", "copies");
      const application_id = appOf(i, ctx);
      const d: NoticeDelivery = { consumer_id: str(i, "consumer_id"), delivered_at: str(i, "delivered_at"), channel: str(i, "channel") as NoticeDelivery["channel"], copies: num(i, "copies"), evidence_document_id: (i.evidence_document_id as string | undefined) ?? null, esign_consent_id: (i.esign_consent_id as string | undefined) ?? null, form: (str(i, "form") || "h8") as RescissionForm };
      const r = recordNoticeDelivery(ctx.events, application_id, d, tzOf(i), ctx.actor);
      const id = `${application_id}:${r.delivery.kind}:${d.consumer_id}:${d.delivered_at}`;
      rt.store.put("disclosures", id, { application_id, kind: r.delivery.kind, consumer_id: d.consumer_id, status: "delivered", delivered_at: d.delivered_at, delivery_channel: d.channel, copies: d.copies, receipt_evidence: d.channel === "in_person" ? "in_person" : d.channel === "courier" ? "courier" : "esign_confirmed", evidence_document_id: d.evidence_document_id, esign_consent_id: d.esign_consent_id ?? null, retention_class: "regz_cd_5y" }, ctx.actor, ctx.now);
      return { disclosure_id: id, delivery: r.delivery, event_id: r.event.id }; }),
    guardrails: [never("NOTICE_DELIVERY_EVIDENCE", "25.3 guardrails: never mark a notice delivered without per-consumer evidence", (i) => i.consumer_id !== undefined && !i.evidence_document_id, "per-consumer evidence (signing-session audit trail, courier signed receipt, e-delivery certificate) is required; the mailbox rule is not used for the rescission notice"),
      never("NO_ORAL_RECEIPT", "25.3 Integrations: 'delivery is what counts — the platform requires evidence'", (i) => i.evidence_kind === "oral" || i.oral_confirmation === true, "an oral confirmation is not delivery evidence")] },
  { name: "computeRescissionPeriod", kind: "act", handler: compute((i, ctx, rt) => {
      const application_id = appOf(i, ctx); const op = (i.op as string | undefined) ?? "compute";
      if (op === "accept_waiver") {
        need(i, "waiver");
        const period = periodOf(rt, application_id);
        const w = i.waiver as WaiverStatementInput;
        const r = acceptRescissionWaiver(ctx.events, period, { ...w, rescission_id: period.rescission_id }, ctx.actor, str(i, "accepted_at") || ctx.now);
        rt.store.put("rescission_waivers", r.waiver.waiver_id, { ...r.waiver, application_id }, ctx.actor, ctx.now);
        putPeriod(rt, ctx, r.period);
        return { waiver: r.waiver, status: r.period.status, funding_release_at: r.period.funding_release_at, event_ids: r.events.map((e) => e.id) };
      }
      if (op === "expire") { const period = periodOf(rt, application_id); const ev = expirePeriod(ctx.events, period, str(i, "now") || ctx.now, ctx.actor); if (ev) putPeriod(rt, ctx, { ...period, status: period.status === "running" ? "expired_not_rescinded" : period.status }); return { expired: !!ev, event_id: ev?.id ?? null }; }
      if (op === "flag_extended") { need(i, "reason"); const period = periodOf(rt, application_id); const ev = flagExtendedRight(ctx.events, period, str(i, "reason"), ctx.actor, ctx.now); rt.escalations.open({ kind: "officer", applicationId: application_id, payload: { reason: `rescission right extended to ${String(ev.payload.extended_expires_at)}: ${str(i, "reason")}` } }, ctx.actor); putPeriod(rt, ctx, { ...period, status: "extended_3y", extended_expires_at: ev.payload.extended_expires_at as PlainDate }); return { status: "extended_3y", rescission_extended_until: ev.payload.extended_expires_at, event_id: ev.id }; }
      if (op === "lapse_extended") { need(i, "reason"); const period = periodOf(rt, application_id); const ev = lapseExtendedRight(ctx.events, period, str(i, "reason") as LapseReason, str(i, "at") || ctx.now, ctx.actor); putPeriod(rt, ctx, { ...period, extended_expires_at: null }); return { lapsed: true, event_id: ev.id }; }
      need(i, "consummation_at", "notice_deliveries", "material_disclosures");
      const r = rescindabilityOf(rt, application_id); if (!r) throw new RangeError("determineRescindability first (applicability, form and the consumers entitled to rescind)");
      const period = computeRescissionPeriod({ application_id, rescindability: r, consummation_at: str(i, "consummation_at"), time_zone: tzOf(i), notice_deliveries: list<NoticeDelivery>(i, "notice_deliveries"), material_disclosures: list<MaterialDisclosureDelivery>(i, "material_disclosures"), material_disclosures_accurate: i.material_disclosures_accurate === undefined ? true : flag(i, "material_disclosures_accurate"), now: ctx.now });
      const ev = startPeriod(ctx.events, period, ctx.actor, ctx.now);
      putPeriod(rt, ctx, period);
      return { ...period, handoff: servicingHandoffFields(period), event_id: ev?.id ?? null }; }),
    guardrails: [never("PERIOD_NOT_FROM_CONSUMMATION_ALONE", "25.3 guardrails: never compute the period from consummation alone (§1026.23(a)(3)(i) 'whichever occurs last')", (i) => i.from_consummation_only === true || i.anchor === "consummation" || (i.consummation_at !== undefined && i.notice_deliveries === undefined && i.material_disclosures === undefined && (i.op === undefined || i.op === "compute")), "the period starts at the latest of consummation, delivery of the notice to each consumer and delivery of all material disclosures — pass notice_deliveries and material_disclosures"),
      needsRole("WAIVER_ACCEPTED_BY_OFFICER", "25.3 guardrails: never release funding before `expires_at` unless a `rescission_waivers` row is accepted by `officer`", (i) => i.op === "accept_waiver", ["officer"], "the partner officer accepts or rejects a waiver within 4 hours; the agent never suggests one"),
      never("NO_WAIVER_SUGGESTION", "25.3 'Waiver': the agent never suggests a waiver", (i) => i.suggest_waiver === true || i.op === "draft_waiver", "no waiver drafting or suggestion path exists")] },
  { name: "sweepInboundForRescission", kind: "act", handler: compute((i, ctx, rt) => {
      const application_id = appOf(i, ctx); const op = (i.op as string | undefined) ?? "sweep";
      if (op === "record_exercise") {
        need(i, "exercise_id", "consumer_id", "method", "received_at", "document_id");
        const period = periodOf(rt, application_id);
        const x: ExerciseInput = { exercise_id: str(i, "exercise_id"), application_id, consumer_id: str(i, "consumer_id"), method: str(i, "method") as ExerciseInput["method"], received_at: str(i, "received_at"), postmark_date: i.postmark_date ? dateIn(i, "postmark_date") : null, document_id: str(i, "document_id"), written: i.written === undefined ? true : flag(i, "written"), disbursed_at: (i.disbursed_at as string | undefined) ?? null };
        const r = recordExercise(ctx.events, period, x, ctx.actor);
        const checklist = r.exercise.valid ? unwindChecklist(r.exercise, { disbursed: !!x.disbursed_at, enote_registered: flag(i, "enote_registered"), security_instrument_recorded: flag(i, "security_instrument_recorded"), purchased_by_fnma: flag(i, "purchased_by_fnma") }) : [];
        rt.store.put("rescission_exercises", r.exercise.exercise_id, { ...r.exercise, checklist }, ctx.actor, ctx.now);
        putPeriod(rt, ctx, r.period);
        if (r.exercise.valid) rt.escalations.open({ kind: "officer", applicationId: application_id, payload: { reason: `rescission exercised by ${x.consumer_id}; refund due ${r.exercise.refund_due_at}`, checklist } }, ctx.actor);
        return { exercise: r.exercise, checklist, status: r.period.status, event_ids: r.events.map((e) => e.id) };
      }
      if (op === "complete_unwind") {
        need(i, "exercise_id", "money_returned_at", "security_terminated_at");
        const row = rt.store.require("rescission_exercises", str(i, "exercise_id")).data as unknown as RescissionExercise;
        const ev: UnwindEvidence = { completed_at: str(i, "completed_at") || ctx.now, money_returned_at: str(i, "money_returned_at"), security_terminated_at: str(i, "security_terminated_at"), release_document_id: (i.release_document_id as string | undefined) ?? null, enote_reversal_ref: (i.enote_reversal_ref as string | undefined) ?? null, refund_ledger_set_id: (i.refund_ledger_set_id as string | undefined) ?? null, signed_off_by: ctx.actor };
        const r = completeUnwind(ctx.events, row, ev);
        rt.store.put("rescission_exercises", r.exercise.exercise_id, { ...r.exercise }, ctx.actor, ctx.now);
        return { exercise: r.exercise, event_id: r.event.id };
      }
      if (op === "close_allowance") { const period = periodOf(rt, application_id); const ev = closeMailAllowance(ctx.events, period, str(i, "closed_at") || ctx.now, list<string>(i, "notices_received"), ctx.actor); return { closed: true, event_id: ev.id }; }
      need(i, "swept_at", "channels_checked");
      const period = periodOf(rt, application_id);
      if (!period.expires_at || !period.expires_on) throw new RangeError("the period has not started — nothing to sweep against");
      const sweep = sweepChannels({ rescission_id: period.rescission_id, expires_at: period.expires_at, expires_on: period.expires_on, swept_at: str(i, "swept_at"), time_zone: period.time_zone, channels_checked: list<InboundChannel>(i, "channels_checked"), items: list<InboundItem>(i, "items"), borrower_confirmation_at: (i.borrower_confirmation_at as string | undefined) ?? null });
      const r = confirmNotRescinded(ctx.events, period, sweep, ctx.actor);
      putPeriod(rt, ctx, r.period);
      return { sweep, status: r.period.status, reasonably_satisfied_at: r.period.reasonably_satisfied_at, funding_release_at: r.period.funding_release_at, event_ids: r.events.map((e) => e.id) }; }),
    guardrails: [never("NO_RELEASE_BEFORE_EXPIRY", "25.3 guardrails: never release funding before `expires_at` unless a `rescission_waivers` row is accepted by `officer`", (i) => i.release_funding === true || i.force_satisfied === true || i.reasonably_satisfied_at !== undefined, "reasonable satisfaction is derived from the sweep (sweepChannels), never asserted; funding release is the funder's act after `rescission.confirmed_not_rescinded`"),
      never("BORROWER_ACK_NOT_A_CONDITION", "25.3 'Confirmation of non-rescission practice': the optional e-acknowledgement is never a condition of funding and never described as a waiver", (i) => i.require_borrower_confirmation === true || i.treat_confirmation_as_waiver === true, "the borrower's 'I have not cancelled' acknowledgement only adds `borrower_confirmation` to satisfaction_basis"),
      needsRole("UNWIND_SIGNOFF_OFFICER", "25.3 automation class: the partner `officer` signs off on a rescission unwind", (i) => i.op === "complete_unwind", ["officer"], "unwind completion (money returned; security interest terminated) is recorded under officer sign-off")] },
  { name: "classifyInboundDocument", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "text", "channel");
      const application_id = appOf(i, ctx);
      const c = classifyInboundDocument({ text: str(i, "text"), channel: str(i, "channel") as InboundChannel });
      if ((i.op as string | undefined) === "log_oral_candidate" || (c.classification === "rescission_notice_candidate" && c.oral)) {
        const period = periodOf(rt, application_id);
        const r = logOralCandidate(ctx.events, period, str(i, "received_at") || ctx.now, str(i, "text"), ctx.actor);
        putPeriod(rt, ctx, period, { funding_hold_through: r.response.funding_hold_through, candidate_logged_at: r.response.logged_at });
        const esc = rt.escalations.open({ kind: "human_agent", applicationId: application_id, payload: { reason: "oral cancellation — tell the consumer how to exercise in writing before midnight", send_form_by: r.response.send_form_by, deadline: r.response.exercise_deadline_text } }, ctx.actor);
        return { ...c, response: r.response, escalation_id: esc.id, event_id: r.event.id };
      }
      if (c.human_review) { const esc = rt.escalations.open({ kind: "human_agent", applicationId: application_id, payload: { reason: "ambiguous inbound document — possible rescission notice", text: str(i, "text") } }, ctx.actor); return { ...c, escalation_id: esc.id }; }
      return c; }),
    guardrails: [never("CANCEL_IS_ALWAYS_A_CANDIDATE", "25.3 guardrails: never classify an inbound \"I want to cancel\" message as anything other than a rescission candidate (even if oral)", (i) => typeof i.override_classification === "string" && i.override_classification !== "rescission_notice_candidate" && CANCEL.test(str(i, "text")), "an oral statement is not a valid exercise, but it triggers a human contact to tell the consumer how to exercise in writing before midnight")] },
  { name: "writeDecision", kind: "write", handler: decision() },
]);
