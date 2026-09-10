/**
 * §12 tools — loss mitigation (`lossmit-underwriter`). Every tool string is
 * the spec's verbatim; 12.3 names none (its agent runs on the 12.2 bus) and
 * 12.7 names no agent (its two registry lookups run under the same agent as
 * 12.6). Guardrails encode the "cannot"/"never" sentences: no classification
 * of an RFA as not-an-application under 0.80 confidence, no ack after the
 * clock without an escalation, no denial without reviewer approval, no term
 * breaching a gate, no NIB with late charges, no FEMA basis without a
 * registry match, no relocation with a contribution, and settlement anomalies
 * to fraud review before funding.
 */
import { defineTools, escalate, compute, never, needsRole, noticeOps, port, read, write, readWrite, log, timerOps, ledgerPost, cents, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { classify, ackDue, completeness, type Requirement } from "../../domain/lossmit/application.ts";
import { hierarchyWalk, tier, evaluationDeadlines, reviewerRequired } from "../../domain/lossmit/evaluation.ts";
import { forbearanceTerm, forbearanceTermDates, repaymentTerms, repaymentPlan } from "../../domain/lossmit/plans.ts";
import { screen, nib, type DeferralFacts } from "../../domain/lossmit/deferral.ts";
import { waterfall, type WaterfallInputs } from "../../domain/lossmit/flexmod.ts";
import { contribution, netProceeds, negotiated } from "../../domain/lossmit/liquidation.ts";
import { rfaFlow, nprmRfa, denialNoticeContent, referralGate, repaymentBrpGate, repaymentExtension, capStructure, deferralLedger, disasterForeclosureGate, mirLookup, delegationRouting, settlementReview, liquidationHolds } from "../../domain/lossmit/ops.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const AGENT = "lossmit-underwriter";
const REVIEWER_GATE = needsRole("DENIAL_NEEDS_REVIEWER", "12.2 guardrail: no denial notice without reviewer approval", (i) => /DENIAL|INELIGIBLE|DECLINE|ADVERSE|INCOMPLETE_CLOSED|DUPLICATIVE|TPP_FAILED|REPAY_FAILED|FORB_TERMINATION/.test(str(i, "template_code")) && !i.reviewer_approval_id, ["lossmit_reviewer"], "record the lossmit_reviewer approval id first");
const TEMPLATE_ONLY = never("TEMPLATE_TEXT_ONLY", "12.x guardrail: borrower-facing text only from templates", (i) => typeof i.free_text === "string" && i.free_text.length > 0, "no free-text legal statements");
const timers = (): Omit<ToolDef, "process" | "agent"> => ({ name: "timers.*", kind: "act", handler: timerOps() });
const noticeTool = (): Omit<ToolDef, "process" | "agent"> => ({ name: "notice.render_send", kind: "act", handler: noticeOps("render_send"), guardrails: [REVIEWER_GATE, TEMPLATE_ONLY] });
const statusReport = (): Omit<ToolDef, "process" | "agent"> => ({ name: "fnma.status_code.report", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "status_code"); return ctx.events.append({ type: "investor.status_code.reported", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { status_code: str(i, "status_code"), effective_date: str(i, "effective_date") || null, reporting_month: str(i, "reporting_month") || null } }); }) });
const smduSubmitPoll = (): Omit<ToolDef, "process" | "agent"> => ({ name: "smdu.case.submit/poll", kind: "act", handler: compute(async (i, ctx, rt) => { const smdu = port(rt, "smdu") as unknown as { submit?: (c: Record<string, unknown>) => Promise<unknown>; poll?: (id: string) => Promise<unknown> }; if (i.op === "poll") { need(i, "case_id"); return smdu.poll ? smdu.poll(str(i, "case_id")) : { case_id: str(i, "case_id"), status: "unknown" }; } need(i, "loan_id", "workout"); const r = smdu.submit ? await smdu.submit({ loan_id: str(i, "loan_id"), workout: str(i, "workout"), servicer_number: str(i, "partner_servicer_number"), package: i.package ?? null }) : { submitted: true }; ctx.events.append({ type: "smdu.case.submitted", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { workout: str(i, "workout") } }); return r; }),
  guardrails: [never("SERVICER_NUMBER_REQUIRED", "12.2 guardrail: every SMDU submission carries the partner servicer number", (i) => i.op !== "poll" && !str(i, "partner_servicer_number"), "set partner_servicer_number")] });
const valuationOrderGet = (): Omit<ToolDef, "process" | "agent"> => ({ name: "valuation.order/get", kind: "act", handler: compute((i, ctx, rt) => { if (i.op === "get") return rt.store.get("valuations", str(i, "id"))?.data ?? null; need(i, "loan_id", "kind"); const rec = rt.store.put("valuations", str(i, "id") || `val-${str(i, "loan_id")}-${ctx.now.slice(0, 10)}`, { loan_id: str(i, "loan_id"), kind: str(i, "kind"), ordered_on: ctx.now.slice(0, 10), status: "ordered" }, ctx.actor, ctx.now); ctx.events.append({ type: "valuation.ordered", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { valuation_id: rec.id, kind: str(i, "kind") } }); return rec.data; }) });
const orderGet = (name: string, store: string, eventType: string): Omit<ToolDef, "process" | "agent"> => ({ name, kind: "act", handler: compute((i, ctx, rt) => { if (i.op === "get") return rt.store.get(store, str(i, "id"))?.data ?? null; need(i, "loan_id"); const rec = rt.store.put(store, str(i, "id") || `${store}-${str(i, "loan_id")}-${ctx.now.slice(0, 10)}`, { loan_id: str(i, "loan_id"), ordered_on: ctx.now.slice(0, 10), status: "ordered" }, ctx.actor, ctx.now); ctx.events.append({ type: eventType, loanId: str(i, "loan_id"), actor: ctx.actor, payload: { id: rec.id } }); return rec.data; }) });
const holdsSet = (name: string): Omit<ToolDef, "process" | "agent"> => ({ name, kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "kind"); const op = i.op === "release" ? "released" : "active"; const rec = rt.store.put("foreclosure_holds", str(i, "id") || `hold-${str(i, "loan_id")}-${str(i, "kind")}`, { loan_id: str(i, "loan_id"), kind: str(i, "kind"), status: op, from: str(i, "from") || ctx.now.slice(0, 10), reason: str(i, "reason") || null }, ctx.actor, ctx.now); ctx.events.append({ type: op === "released" ? "foreclosure_holds.closed" : "foreclosure_holds.opened", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { kind: str(i, "kind"), hold_id: rec.id } }); return rec.data; }),
  guardrails: [never("RELEASE_NEEDS_REASON", "12.2/12.3: holds release only with a recorded reason (reviewer confirmation on appeals)", (i) => i.op === "release" && !str(i, "reason"), "set reason")] });
const attorneyInstruct = (): Omit<ToolDef, "process" | "agent"> => ({ name: "attorney.instruct", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "instruction"); return ctx.events.append({ type: "attorney.instruction.sent", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { instruction: str(i, "instruction"), due_by: addBusinessDays(D(ctx.now.slice(0, 10)), 1, federal), ack_required: true } }); }) });
const erecording = (): Omit<ToolDef, "process" | "agent"> => ({ name: "erecording.submit", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "document_id"); const p = port(rt, "erecording") as unknown as { submit?: (d: Record<string, unknown>) => Promise<unknown> } | undefined; ctx.events.append({ type: "erecording.submitted", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { document_id: str(i, "document_id") } }); return p?.submit ? p.submit({ document_id: str(i, "document_id") }) : { submitted: true }; }),
  guardrails: [needsRole("SIGNING_OFFICER_EXECUTES", "12.6/12.8: a recordable agreement is executed by signing_officer", (i) => !str(i, "officer_signature_date"), ["signing_officer"], "the executed agreement carries officer_signature_date")] });

// ---- 12.1 acknowledge application ---------------------------------------------
const p121 = defineTools("12.1", AGENT, [
  { name: "lossmit.application.open/update", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const kind = classify({ has_evaluative_info: flag(i, "has_evaluative_info"), confidence: Number(i.confidence ?? 1) }); const received = optDate(i, "received_on") ?? D(ctx.now.slice(0, 10));
      if (kind === "rfa_only" && i.op !== "update") { const r = rfaFlow({ utterance: str(i, "utterance"), has_evaluative_info: false, confidence: Number(i.confidence ?? 1), state: str(i, "state") }); ctx.events.append({ type: "lossmit.rfa.received", loanId: str(i, "loan_id"), actor: ctx.actor, payload: r }); return { ...r, classification: kind }; }
      const rec = rt.store.put("lossmit_applications", str(i, "id") || `lma-${str(i, "loan_id")}-${received}`, { loan_id: str(i, "loan_id"), status: str(i, "status") || "incomplete", received_on: received, ack_due: ackDue(received).due_on, regime: str(i, "regime") || "2013", ...((i.changes as Record<string, unknown> | undefined) ?? {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: i.op === "update" ? "lossmit.application.status_changed" : "lossmit.application.received", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { application_id: rec.id, status: rec.data.status } }); return rec.data; }),
    guardrails: [never("RFA_CONFIDENCE_FLOOR", "12.1 guardrail: may not classify an RFA as not-an-application when confidence <0.80", (i) => i.classify_as === "rfa_only" && Number(i.confidence ?? 1) < 0.8, "confidence below 0.80 → treat as an application")] },
  { name: "documents.classify_extract", kind: "read", handler: compute((i, ctx, rt) => { need(i, "document_id"); const ai = (rt.services.documentAi as { classify?: (id: string) => Promise<unknown> } | undefined); if (!ai?.classify || flag(i, "ai_unavailable")) return rt.escalations.open({ kind: "human_portal_task", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { checklist: "12.1 completeness determination", document_id: str(i, "document_id"), reason: "document AI unavailable" } }, ctx.actor); return ai.classify(str(i, "document_id")); }) },
  { name: "requirements.compute", kind: "read", handler: compute((i) => { const reqs = (i.requirements as Requirement[] | undefined) ?? []; return { ...completeness(reqs), already_in_file: reqs.filter((r) => r.status === "received" || r.status === "verified").map((r) => r.item) }; }),
    guardrails: [never("NO_RE_REQUEST", "12.1 guardrail: never asks for documents already in the file", (i) => { const reqs = (i.requirements as Requirement[] | undefined) ?? []; const ask = (i.request_items as string[] | undefined) ?? []; return ask.some((a) => reqs.some((r) => r.item === a && r.status !== "missing" && r.status !== "stale")); }, "drop items already received/verified"),
      never("WAIVER_NEEDS_CATALOG_RULE", "12.1 guardrail: may not mark an item waived without a catalog waiver rule", (i) => Array.isArray(i.waive_items) && (i.waive_items as unknown[]).length > 0 && !str(i, "catalog_waiver_rule"), "cite the lossmit_requirement_catalog waiver rule")] },
  { name: "calendar.federal_bd", kind: "read", handler: compute((i) => ({ date: addBusinessDays(date(i, "from"), num(i, "n") || 5, federal), calendar: "federal" })) },
  noticeTool(),
  { name: "contacts.log", kind: "write", handler: log("contacts", "contact.attempted") },
  { name: "timers.start", kind: "act", handler: timerOps(),
    guardrails: [never("NO_LATE_ACK_WITHOUT_ESCALATION", "12.1 guardrail: never issues an ack after the clock without an escalations row", (i) => flag(i, "ack_after_deadline") && !str(i, "escalation_id"), "open the officer sev-1 escalation first")] },
  holdsSet("foreclosure_holds.set"),
  statusReport(),
  { name: "sii.lookup", kind: "read", handler: read("sii_records") },
  { name: "transfer.lossmit_file.get", kind: "read", handler: read("transfer_lossmit_files") },
]);

// ---- 12.2 complete-application evaluation ---------------------------------------
const p122 = defineTools("12.2", AGENT, [
  { name: "lossmit.evaluation.*", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "application_id"); const complete = date(i, "complete_on"); const t = tier(complete, optDate(i, "sale_on")); const provided = optDate(i, "provided_on") ?? complete;
      const dl = evaluationDeadlines(complete, provided, t, str(i, "state") || undefined); const outcome = str(i, "outcome") || "pending";
      const rec = rt.store.put("lossmit_evaluations", str(i, "id") || `eval-${str(i, "application_id")}`, { loan_id: str(i, "loan_id"), application_id: str(i, "application_id"), tier: t, outcome, decision_due: dl.decision_due, accept_by: dl.accept_by, appeal_rights: dl.appeal_rights, reviewer_required: reviewerRequired({ denial: outcome === "denied", ineligible: outcome === "ineligible", duplicative: flag(i, "duplicative"), discretionary_c2ii: flag(i, "discretionary_c2ii"), reg_b_adverse: flag(i, "reg_b_adverse") }), source: str(i, "source") || "rules_engine" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "lossmit.evaluation.decided", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { evaluation_id: rec.id, outcome, tier: t } }); return rec.data; }),
    guardrails: [never("ENGINE_OUTPUT_ONLY", "12.2 guardrail: outcomes must equal the rules engine/SMDU output", (i) => str(i, "source") === "model", "the model may not override a decision"),
      never("CATALOG_REASON_CODES", "12.2 guardrail: reason codes only from the catalog", (i) => typeof i.reason_code === "string" && !/^(FNMA|REGX|SM)_[A-Z0-9_]+$/.test(str(i, "reason_code")), "use a catalog reason code")] },
  { name: "hierarchy.walk", kind: "read", handler: compute((i) => hierarchyWalk({ can_reinstate: flag(i, "can_reinstate"), hardship_temporary_unresolved: flag(i, "hardship_temporary_unresolved"), can_afford_repayment: flag(i, "can_afford_repayment"), deferral_eligible: flag(i, "deferral_eligible"), flexmod_eligible: flag(i, "flexmod_eligible"), liquidation_requested: flag(i, "liquidation_requested") })) },
  smduSubmitPoll(),
  { name: "valuation.order", kind: "act", handler: valuationOrderGet().handler },
  { name: "mi.decision.get", kind: "read", handler: read("mi_decisions") },
  { name: "credit.report.pull", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "permissible_purpose"); const p = rt.services.creditBureau as { pull?: (r: Record<string, unknown>) => Promise<unknown> } | undefined; ctx.events.append({ type: "credit.report.pulled", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { purpose: str(i, "permissible_purpose") } }); return p?.pull ? p.pull({ loan_id: str(i, "loan_id") }) : { pulled: true }; }) },
  { name: "notice.render_send", kind: "act", handler: compute((i, ctx, rt) => { if (str(i, "template_code").includes("DENIAL")) { const c = denialNoticeContent({ investor: str(i, "investor") || "Fannie Mae", option: str(i, "option"), criterion: str(i, "criterion"), reviewer_approval_id: (i.reviewer_approval_id as string | undefined) ?? null }); if (!c.mailing_allowed) throw new RangeError(c.refusal!); } return noticeOps("render_send")(i, ctx, rt); }), guardrails: [REVIEWER_GATE, TEMPLATE_ONLY, never("OFFER_TERMS_FROM_CALCULATOR", "12.2 guardrail: no offer terms outside SMDU-returned or calculator-produced values", (i) => flag(i, "terms_hand_entered"), "terms come from SMDU or the calculator")] },
  holdsSet("foreclosure_holds.set/release"),
  attorneyInstruct(),
  timers(),
  { name: "escalation.file", kind: "act", handler: escalate("lossmit_reviewer") },
]);

// ---- 12.4 forbearance plan --------------------------------------------------------
const p124 = defineTools("12.4", AGENT, [
  { name: "workout_plan.*", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id"); if (i.op === "referral_check") return referralGate({ plan_status: str(i, "plan_status") as "active", terminated_reason: (i.terminated_reason as "failed_terms" | undefined) ?? null, terminated_on: optDate(i, "terminated_on"), today: D(ctx.now.slice(0, 10)) });
      const term = forbearanceTerm({ requested_months: num(i, "requested_months") || 0, cumulative_months: num(i, "cumulative_months") || 0, months_delinquent_at_start: num(i, "months_delinquent_at_start") || 0, mbs_months_to_maturity: (i.mbs_months_to_maturity as number | undefined) ?? null, combined_months: num(i, "combined_months") || 0 });
      const start = date(i, "start_on"); const dates = forbearanceTermDates(start, term.months);
      const rec = rt.store.put("workout_plans", str(i, "id") || `wp-${str(i, "loan_id")}-${start}`, { loan_id: str(i, "loan_id"), kind: "forbearance", status: str(i, "status") || "active", months: term.months, term_start: dates.start, term_end: dates.end, capped_by: term.capped_by ?? null, preexpiry_outreach_scheduled: true }, ctx.actor, ctx.now);
      ctx.events.append({ type: "workout_plan.activated", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { plan_id: rec.id, term_end: dates.end } }); return rec.data; }),
    guardrails: [never("NO_TERM_BREACHING_GATE", "12.4 guardrail: cannot create a term breaching any gate", (i) => num(i, "requested_months") > 3 && !flag(i, "fnma_exception_approved"), "increments are ≤3 months (LL-2026-01) without an exception"),
      never("MITIGATING_CHECK_BEFORE_TERMINATION", "12.4 guardrail: cannot terminate for a missed reduced payment without the mitigating-circumstances check", (i) => str(i, "status") === "terminated" && str(i, "terminated_reason") === "failed_terms" && !flag(i, "mitigating_circumstances_checked"), "log the mitigating-circumstances check first"),
      never("DILIGENCE_SUSPENSION_C2III", "12.4 guardrail: cannot suspend diligence unless the (c)(2)(iii) conditions are met", (i) => flag(i, "suspend_diligence") && !flag(i, "c2iii_conditions_met"), "short-term plan on an incomplete application with the required notice")] },
  { name: "calendar.months", kind: "read", handler: compute((i) => forbearanceTermDates(date(i, "start_on"), num(i, "months") || 1)) },
  { name: "delinquency.project", kind: "read", handler: compute((i) => ({ projected_months_delinquent_at_term_end: (num(i, "months_delinquent") || 0) + (num(i, "term_months") || 0), within_12: (num(i, "months_delinquent") || 0) + (num(i, "term_months") || 0) <= 12 })) },
  noticeTool(),
  { name: "fees.suppress", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const rec = rt.store.put("fee_suppressions", str(i, "id") || `sup-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), kind: "late_charge", from: str(i, "from") || ctx.now.slice(0, 10), reason: str(i, "reason") || "workout plan active" }, ctx.actor, ctx.now); return rec.data; }) },
  statusReport(),
  { name: "exception_request.prepare", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "basis"); const rec = rt.store.put("fnma_exception_requests", str(i, "id") || `exc-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), basis: str(i, "basis"), status: "prepared", requested_months: num(i, "requested_months") || null }, ctx.actor, ctx.now); return rt.escalations.open({ kind: "human_portal_task", loanId: str(i, "loan_id"), payload: { exception_request_id: rec.id, submit_via: "fnma_portal_operator" } }, ctx.actor); }) },
  { name: "contacts.*", kind: "write", handler: compute((i, ctx, rt) => { if (i.op === "list") return rt.store.list("contacts").filter((r) => r.data.loan_id === str(i, "loan_id")).map((r) => r.data); need(i, "loan_id", "mode", "purpose"); const rec = rt.store.put("contacts", str(i, "id") || `ct-${str(i, "loan_id")}-${ctx.now}`, { loan_id: str(i, "loan_id"), mode: str(i, "mode"), purpose: str(i, "purpose"), direction: str(i, "direction") || "outbound", attempted_at: ctx.now, result: str(i, "result") || null }, ctx.actor, ctx.now); ctx.events.append({ type: "contact.attempted", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { purpose: str(i, "purpose"), mode: str(i, "mode") } }); return rec.data; }) },
  timers(),
]);

// ---- 12.5 repayment plan ----------------------------------------------------------
const p125 = defineTools("12.5", AGENT, [
  { name: "workout_plan.*", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const gate = repaymentBrpGate({ days_delinquent: num(i, "days_delinquent") || 0, term_months: num(i, "term_months") || 0, brp_complete: flag(i, "brp_complete"), qrpc: flag(i, "qrpc") }); if (!gate.allowed) throw new RangeError(gate.refusal!);
      const ext = repaymentExtension({ term_months: num(i, "term_months") || 0, fnma_approval_id: (i.fnma_approval_id as string | undefined) ?? null }); const terms = repaymentTerms(cents(i.arrears_cents), cents(i.contractual_cents), num(i, "term_months") || 1); if (!terms.allowed) throw new RangeError(`expected total ${terms.total_monthly_cents} exceeds 150% of the contractual payment (FNMA_D23202_REPAY_PAYMENT_CAP_150)`);
      const rec = rt.store.put("workout_plans", str(i, "id") || `rp-${str(i, "loan_id")}-${str(i, "start_on")}`, { loan_id: str(i, "loan_id"), kind: "repayment_plan", status: ext.status === "extension_pending" ? "extension_pending" : str(i, "status") || "active", months: terms.months, installment_cents: terms.installment_cents, total_monthly_cents: terms.total_monthly_cents, pct_of_contractual: terms.pct_of_contractual, f116_package: ext.package, fnma_approval_id: (i.fnma_approval_id as string | undefined) ?? null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "workout_plan.activated", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { plan_id: rec.id, kind: "repayment_plan" } }); return rec.data; }),
    guardrails: [never("TERM_OVER_12_NEEDS_APPROVAL", "12.5 guardrail: cannot set a term >12 without an approval id", (i) => num(i, "term_months") > 12 && str(i, "status") === "active" && !str(i, "fnma_approval_id"), "the plan stays extension_pending until the approval id is recorded"),
      never("NO_INSTALLMENT_OVERRIDE", "12.5 guardrail: the agent cannot alter installment math", (i) => i.installment_cents !== undefined, "installments come from calc.repayment_schedule")] },
  { name: "ledger.arrears", kind: "read", handler: compute((i) => { const inst = cents(i.piti_cents) * BigInt(num(i, "unpaid_installments") || 0); const lc = cents(i.late_charge_cents) * BigInt(num(i, "late_charges") || 0); return { installments_cents: inst, late_charges_cents: lc, total_cents: inst + lc }; }) },
  { name: "calc.repayment_schedule", kind: "read", handler: compute((i) => (i.months ? repaymentTerms(cents(i.arrears_cents), cents(i.contractual_cents), num(i, "months")) : repaymentPlan(cents(i.arrears_cents), cents(i.contractual_cents), i.capacity_cents === undefined ? null : cents(i.capacity_cents)))) },
  { name: "fees.suppress/waive", kind: "write", handler: compute((i, ctx, rt) => { const op = i.op === "waive" ? "waived" : "suppressed"; const rec = rt.store.put("fees", str(i, "fee_id") || `fee-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), status: op, reason: str(i, "reason"), by: ctx.actor.id }, ctx.actor, ctx.now); return rec.data; }),
    guardrails: [never("WAIVE_ONLY_ON_COMPLETION", "12.5 guardrail: cannot waive late charges outside the rule", (i) => i.op === "waive" && str(i, "reason") !== "D2-3.2-02", "plan-period charges are waived on completion with reason D2-3.2-02")] },
  noticeTool(),
  statusReport(),
  { name: "fnma.f116_package.prepare", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "term_months"); const rec = rt.store.put("fnma_exception_requests", str(i, "id") || `f116-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), form: "F-1-16", requested_months: num(i, "term_months"), status: "prepared" }, ctx.actor, ctx.now); return rec.data; }) },
  timers(),
]);

// ---- 12.6 payment deferral ----------------------------------------------------------
const p126 = defineTools("12.6", AGENT, [
  { name: "deferral.screen", kind: "read", handler: compute((i, ctx, rt) => { const f = i.facts as DeferralFacts | undefined; if (!f) throw new RangeError("facts are required"); const s = screen(f); if (!s.eligible) rt.escalations.open({ kind: "lossmit_reviewer", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { determination: "ineligible", reason: s.reason, next: s.next } }, ctx.actor); return { ...s, cap: capStructure({ prior_deferred_months: f.cumulative_deferred_months, requested_months: f.months_delinquent }) }; }) },
  { name: "ledger.arrears_breakdown", kind: "read", handler: compute((i) => deferralLedger({ pi_cents: cents(i.pi_cents), months_deferred: num(i, "months_deferred") || 0, escrow_advances_cents: cents(i.escrow_advances_cents), servicing_advances_cents: cents(i.servicing_advances_cents), late_charges_cents: cents(i.late_charges_cents), scheduled_ib_upb_cents: cents(i.scheduled_ib_upb_cents) })),
    guardrails: [never("NIB_EXCLUDES_LATE_CHARGES", "12.6 guardrail: cannot include late charges or escrow shortage in the NIB", (i) => flag(i, "include_late_charges_in_nib") || flag(i, "include_escrow_shortage_in_nib"), "NIB = deferred P&I + eligible advances only")] },
  { name: "escrow.analysis.run", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id"); return ctx.events.append({ type: "escrow.analysis.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { reason: "12.6 deferral (B-1-01)" } }); }) },
  { ...smduSubmitPoll(), name: "smdu.case.submit" },
  { name: "investor.report_contractual_payments", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "months_deferred"); return ctx.events.append({ type: "investor.contractual_payments.reported", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { months: num(i, "months_deferred"), nib_cents: cents(i.nib_cents) } }); }),
    guardrails: [never("COMPLETION_NEEDS_ACK", "12.6 guardrail: cannot complete without the LAR/event ack and, where required, the contractual payment", (i) => flag(i, "complete") && (!flag(i, "lar_acked") || (flag(i, "contractual_payment_required") && !flag(i, "contractual_payment_received"))), "wait for the 5.x ack / contractual payment")] },
  noticeTool(),
  { name: "esign.send", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "document_id"); const p = rt.services.esign as { send?: (d: Record<string, unknown>) => Promise<unknown> } | undefined; ctx.events.append({ type: "esign.sent", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { document_id: str(i, "document_id") } }); return p?.send ? p.send({ document_id: str(i, "document_id") }) : { sent: true }; }) },
  erecording(),
  { name: "custodian.deliver", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "document"); return ctx.events.append({ type: "custodian.delivery.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { document: str(i, "document"), certified_copy: flag(i, "certified_copy") } }); }) },
  timers(),
]);

// ---- 12.7 disaster payment deferral (no agent named; runs under 12.6's) ---------------
const p127 = defineTools("12.7", AGENT, [
  { name: "disaster.registry.lookup", kind: "read", handler: compute((i, _c, rt) => { need(i, "county_fips"); const rows = rt.store.list("disaster_registry").filter((r) => r.data.county_fips === str(i, "county_fips") && r.data.fema_ia === true); return { match: rows.length > 0, events: rows.map((r) => r.data) }; }),
    guardrails: [never("FEMA_BASIS_NEEDS_MATCH", "12.7 guardrail: cannot assert a FEMA basis without a registry match", (i) => flag(i, "assert_fema_basis") && !flag(i, "registry_match"), "look the county up first")] },
  { name: "insurance.claim.get", kind: "read", handler: read("insurance_claims") },
]);

// ---- 12.8 Flex Modification -------------------------------------------------------------
const p128 = defineTools("12.8", AGENT, [
  { name: "flexmod.waterfall", kind: "read", handler: compute((i, ctx, rt) => { const w = i.inputs as WaterfallInputs | undefined; if (!w) throw new RangeError("inputs are required"); const mir = mirLookup((i.mir_table as { effective: PlainDate; rate_pct: string }[] | undefined) ?? [{ effective: D("2000-01-01"), rate_pct: w.mir_pct }], optDate(i, "evaluation_on") ?? D(ctx.now.slice(0, 10))); if (mir.refusal) { rt.escalations.open({ kind: "officer", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { reason: mir.escalation!.reason }, severity: "sev2" }, ctx.actor); throw new RangeError(mir.refusal); } return waterfall({ ...w, mir_pct: mir.rate_pct! }); }),
    guardrails: [never("LLM_NEVER_COMPUTES_TERMS", "12.8 guardrail: the LLM never computes terms — it calls the waterfall", (i) => i.proposed_terms !== undefined, "terms come only from the waterfall"), never("FRESH_VALUATION", "12.8 guardrail: no TPP offer without a fresh valuation and escrow analysis", (i) => flag(i, "for_tpp_offer") && (num(i, "valuation_age_days") > 90 || !flag(i, "escrow_analysis_done")), "valuation ≤90 days and an escrow analysis first")] },
  valuationOrderGet(),
]);

// ---- 12.9 short sale / Mortgage Release -----------------------------------------------------
const p129 = defineTools("12.9", AGENT, [
  { name: "liquidation.case.*", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id"); if (i.op === "hold_check") return liquidationHolds({ phase: str(i, "phase") as "listing", approved_on: optDate(i, "approved_on"), state: str(i, "state"), today: D(ctx.now.slice(0, 10)), requested: str(i, "requested") as "sale" });
      const rec = rt.store.put("liquidation_cases", str(i, "id") || `liq-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), kind: str(i, "kind") || "short_sale", status: str(i, "status") || "open", ...((i.changes as Record<string, unknown> | undefined) ?? {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "liquidation.case.status_changed", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { case_id: rec.id, status: rec.data.status } }); return rec.data; }),
    guardrails: [never("APPROVAL_FROM_SMDU_ONLY", "12.9 guardrail: no approval outside SMDU's decision/Fannie Mae approval", (i) => str(i, "status") === "approved" && !str(i, "smdu_decision_id") && !str(i, "fnma_approval_id"), "record the SMDU decision or Fannie Mae approval"),
      never("DEED_NEEDS_TITLE_AND_INSPECTION", "12.9 guardrail: no deed acceptance without title verification and inspection", (i) => str(i, "status") === "deed_accepted" && !(flag(i, "title_verified") && flag(i, "inspection_done")), "order title and inspection first")] },
  { name: "ratio.compute", kind: "read", handler: compute((i) => { const p = cents(i.price_cents), v = cents(i.value_cents); return { ratio_pct: v > 0n ? ((p * 10000n) / v).toString().replace(/(\d{2})$/, ".$1") : null }; }) },
  { name: "contribution.compute", kind: "read", handler: compute((i) => ({ ...contribution(cents(i.reserves_cents), cents(i.piti_cents), cents(i.deficiency_cents)), negotiated: i.offer_cents === undefined ? null : negotiated(contribution(cents(i.reserves_cents), cents(i.piti_cents), cents(i.deficiency_cents)).request_cents, cents(i.offer_cents)) })),
    guardrails: [never("NO_RELOCATION_WITH_CONTRIBUTION", "12.9 guardrail: no relocation payment when a contribution is required", (i) => flag(i, "relocation_requested") && contribution(cents(i.reserves_cents), cents(i.piti_cents), cents(i.deficiency_cents)).required && !str(i, "fnma_approval_id"), "absent Fannie Mae approval")] },
  valuationOrderGet(),
  orderGet("title.order/get", "title_orders", "title.ordered"),
  orderGet("inspection.order/get", "inspection_orders", "inspection.ordered"),
  smduSubmitPoll(),
  { name: "offer.evaluate", kind: "read", handler: compute((i) => { const np = netProceeds(cents(i.price_cents), { commission: cents(i.commission_cents), prorations: cents(i.prorations_cents), transfer_taxes: cents(i.transfer_taxes_cents), title_settlement: cents(i.title_settlement_cents), seller_attorney: cents(i.seller_attorney_cents), hoa_past_due: cents(i.hoa_past_due_cents), subordinate_liens: cents(i.subordinate_liens_cents), relocation: cents(i.relocation_cents) }); return { ...np, routing: delegationRouting({ reserves_cents: cents(i.reserves_cents), net_proceeds_within_parameters: flag(i, "within_parameters"), mi_non_delegated: flag(i, "mi_non_delegated") }) }; }) },
  noticeTool(),
  { name: "closing.instructions.send", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "closing_agent_id"); return ctx.events.append({ type: "closing.instructions.sent", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { closing_agent_id: str(i, "closing_agent_id"), relocation_cents: cents(i.relocation_cents) } }); }) },
  { name: "settlement.review", kind: "read", handler: compute((i, ctx, rt) => { const r = settlementReview({ cd_lines: (i.cd_lines as Parameters<typeof settlementReview>[0]["cd_lines"] | undefined) ?? [], relocation_cents: cents(i.relocation_cents) }); if (r.escalation) rt.escalations.open({ kind: "fraud_officer", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { finding: r.finding, excess_cents: r.excess_cents }, severity: "sev2" }, ctx.actor); return r; }),
    guardrails: [never("FUNDING_BLOCKED_ON_ANOMALY", "12.9 guardrail: settlement anomalies → fraud review before funding", (i) => flag(i, "authorize_funding") && (flag(i, "related_party_buyer") || flag(i, "undisclosed_payment")), "qc-audit/officer fraud review first")] },
  erecording(),
  { name: "lien_release.request", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id"); return ctx.events.append({ type: "lien_release.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { basis: str(i, "basis") || "mortgage_release" } }); }) },
  { name: "mi.claim.prepare", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const rec = rt.store.put("mi_claims", str(i, "id") || `mic-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), status: "prepared", kind: str(i, "kind") || "short_sale" }, ctx.actor, ctx.now); return rec.data; }) },
  { name: "reogram.watch", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id"); return ctx.events.append({ type: "reogram.watch.started", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { since: ctx.now } }); }) },
  timers(),
  attorneyInstruct(),
]);

export const SECTION_12_TOOLS: readonly ToolDef[] = [...p121, ...p122, ...p124, ...p125, ...p126, ...p127, ...p128, ...p129];
export const unusedHelpers = { write, readWrite, ledgerPost, nib, disasterForeclosureGate };
