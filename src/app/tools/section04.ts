/**
 * §4 tools — customer service and borrower communications (4.1, 4.3). Tool
 * strings verbatim from the Agents paragraphs; guardrails encode the
 * "cannot" sentences (4.2/4.4/4.5 name no tools).
 */
import { defineTools, read, write, escalate, timerOps, compute, never, str, flag, data, type ToolDef } from "../tools.ts";
import { evaluateGate } from "../evaluators.ts";
import { handleUtterance } from "../../domain/servicing-requests/ops.ts";
import { callbackRequest } from "../../domain/servicing-requests/ops.ts";

const p41: ToolDef[] = defineTools("4.1", "borrower-comms", [
  { name: "documents.search", kind: "read", handler: compute((i, _c, rt) => rt.store.list("documents", (d) => (!i.loan_id || d.loan_id === i.loan_id) && (!i.kind || d.kind === i.kind)).map((r) => ({ id: r.id, ...r.data, snapshot_version: r.version }))) },
  { name: "contacts.list", kind: "read", handler: read("contacts") },
  { name: "jurisdiction_rules.get", kind: "read", handler: compute((i, _c, rt) => rt.store.get("jurisdiction_rules", str(i, "state"))?.data ?? null) },
  { name: "timer.list", kind: "act", handler: timerOps(), guardrails: [never("LIST_ONLY", "4.1 tool set: timers are read on the NoE path; satisfaction is event-driven", (i) => i.op === "arm" || i.op === "cancel", "timer.list is read-only on the NoE path")] },
]);

const p43: ToolDef[] = defineTools("4.3", "borrower-comms", [
  { name: "lossmit_facts.get", kind: "read", handler: compute((i, _c, rt) => rt.store.get("lossmit_facts", str(i, "loan_id"))?.data ?? null) },
  { name: "payments.history", kind: "read", handler: compute((i, _c, rt) => rt.store.history("payments", str(i, "id")).map((r) => ({ version: r.version, ...r.data }))) },
  { name: "lossmit.documents.list", kind: "read", handler: compute((i, _c, rt) => rt.store.list("lossmit_documents", (d) => d.loan_id === i.loan_id).map((r) => ({ id: r.id, ...r.data }))) },
  { name: "lossmit.application.status", kind: "read", handler: compute((i, _c, rt) => { const f = rt.store.get("lossmit_facts", str(i, "loan_id"))?.data; return f ? { status: f.application_status ?? null, complete_at: f.complete_at ?? null, reasonable_date: f.reasonable_date ?? null } : null; }) },
  { name: "timer.list", kind: "act", handler: timerOps(), guardrails: [never("LIST_ONLY", "4.3 tool set: loss-mit deadlines are read, never armed or cancelled here", (i) => i.op === "arm" || i.op === "cancel", "timer.list is read-only in continuity mode")] },
  { name: "foreclosure.gates.get", kind: "read", handler: compute((i) => { const f = (i.facts as Record<string, unknown> | undefined) ?? {}; return { day_121: evaluateGate("13.1.preForeclosureReviewPeriodElapsed", f), trial_performing: evaluateGate("13.2.trialPerformingNoSale", f), rendered: "we may refer to foreclosure no earlier than day 121, and not while a complete application is pending" }; }) },
  { name: "callback.schedule", kind: "write", handler: compute((i, ctx, rt) => { const r = callbackRequest({ called_at_local: str(i, "called_at_local") || ctx.now.slice(0, 16), staffed_from: str(i, "staffed_from") || "08:00", staffed_to: str(i, "staffed_to") || "20:00" }); const rec = rt.store.put("callback_requests", str(i, "id") || `cb-${ctx.now}`, { ...data(i), live_contact_due: r.live_contact_due }, ctx.actor, ctx.now); ctx.events.append({ type: "callback_requests.created", loanId: ctx.loanId, actor: ctx.actor, payload: { id: rec.id, live_contact_due: r.live_contact_due } }); return { ...r, id: rec.id }; }) },
  { name: "human.transfer", kind: "act", handler: escalate("human_agent"), decision: (i) => ({ action: "human.transfer", rationale: str(i, "reason") || "borrower asked for a person (warm transfer)", ...(i.utterance ? { ruleCode: handleUtterance(str(i, "utterance")).human_transfer_requested ? "human_transfer_requested=true" : "policy_trigger" } : {}) }) },
  { name: "lossmit.intake.start", kind: "write", handler: write("lossmit_applications", "lossmit.application.received"), guardrails: [never("NO_REREQUEST", "4.3 rule 6 / §1024.41(b)(1): documents already held are never re-requested", (i) => flag(i, "rerequest_held_documents"), "documents already held are pushed to the evaluator, not re-requested")] },
  { name: "contact.log", kind: "write", handler: write("contacts", "contact.logged"), guardrails: [never("FACTS_FROM_VIEW", "4.3 rule 5: the AI may not state a deadline or option not present in lossmit_facts", (i) => data(i).stated_deadline_not_in_view === true || data(i).stated_option_not_in_view === true, "a stated deadline/option is not in lossmit_facts")] },
]);

export const SECTION_04_TOOLS: readonly ToolDef[] = [...p41, ...p43];
