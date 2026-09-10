/**
 * §8 tools — credit reporting (8.2 dispute mode, 8.3 overlay mode; 8.1 names
 * no tools). Tool strings verbatim from the Agents paragraphs; guardrails
 * encode the "never" sentences. Agent: `credit-reporting`.
 */
import { defineTools, escalate, compute, never, needsRole, port, str, flag, data, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Acdv, AcdvResponse, Aud } from "../../infra/integrations/credit.ts";
import { AcdvSubmitGuard, frivolousEligible, type Determination } from "../../domain/credit-reporting/disputes.ts";
import { courtesyRequest, sampleVerification, resolveSuppression, type Suppression, type Mechanism } from "../../domain/credit-reporting/suppression.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const submitGuard = new AcdvSubmitGuard();
const OFFICER_MECHANISMS = new Set<Mechanism>(["delete_account", "delete_consumer"]);

const notificationTool: Omit<ToolDef, "process" | "agent"> = { name: "eoscar.notification.*", kind: "read", handler: compute((i, _c, rt) => { const list = rt.store.list("eoscar_notifications", (d) => (!i.type || d.type === i.type) && (!i.since || String(d.received_at) >= str(i, "since"))).map((r): Record<string, unknown> => ({ ...r.data, id: r.id }));
    return { notifications: list, blocks: list.filter((n) => n.type === "Block").map((n) => ({ id: n.id, action: "omit_account_immediately_and_open_fraud_case" })) }; }) };
const audSubmit = (process: string): Omit<ToolDef, "process" | "agent"> => ({ name: process === "8.2" ? "eoscar.aud.validate/submit" : "eoscar.aud.submit", kind: "act", handler: compute(async (i, ctx, rt) => { const a = i.aud as Aud | undefined; if (!a) throw new RangeError("aud is required"); const eo = port(rt, "eoscar");
      const v = await eo.validateAud(a); if (!v.valid) return { valid: false, errors: v.errors, submitted: false };
      if (i.op === "validate") return { valid: true, errors: [], submitted: false };
      const s = await eo.submitAud(a, ctx.now); ctx.events.append({ type: "credit.aud.submitted", loanId: ctx.loanId, actor: ctx.actor, payload: { aud_id: s.audId, bureau: a.bureau } }); return { valid: true, errors: [], submitted: true, ...s }; }),
    guardrails: [never("AUD_NOT_IN_CYCLE_SUBSTITUTE", "e-OSCAR / 8.1 rule 12: an AUD may not add or create a record or substitute for in-cycle reporting", (i) => flag(i, "creates_record") || flag(i, "skip_next_cycle"), "AUDs correct; the next cycle still carries the value"),
      never("NO_REINSERTION_WITHOUT_CERT", "8.2 guardrail: never reinsert deleted data without certification", (i) => flag(i, "reinsertion") && !(flag(i, "evidence") && flag(i, "officer_approved") && flag(i, "certification")), "reinsertion needs evidence, officer approval and a certification (§1681i(a)(5)(B))")] });

// ---- 8.2 disputes -----------------------------------------------------------
const p82 = defineTools("8.2", "credit-reporting", [
  { name: "eoscar.acdv.find/view/validate/submit", kind: "act", handler: compute(async (i, ctx, rt) => { const eo = port(rt, "eoscar"); const op = str(i, "op") || "find";
      switch (op) {
        case "find": return { acdvs: await eo.findAcdvs(str(i, "since") || "1970-01-01T00:00:00Z") };
        case "view": { need(i, "control_number"); const a: Acdv = await eo.viewAcdv(str(i, "control_number")); submitGuard.view(a.controlNumber); return a; }
        case "validate": { const r = i.response as AcdvResponse | undefined; if (!r) throw new RangeError("response is required"); return eo.validateAcdvResponse(r); }
        case "submit": { const r = i.response as AcdvResponse | undefined; if (!r) throw new RangeError("response is required"); if (!submitGuard.canSubmit(r.controlNumber)) throw new RangeError(`ACDV ${r.controlNumber} must be viewed before a response is submitted`); const v = await eo.validateAcdvResponse(r); if (!v.valid) throw new RangeError(`ACDV response invalid: ${v.errors.join("; ")}`);
          const s = await eo.submitAcdvResponse(r, ctx.now); ctx.events.append({ type: "credit.dispute.acdv.responded", loanId: ctx.loanId, actor: ctx.actor, payload: { control_number: r.controlNumber, response_code: r.responseCode } }); return s; }
        default: throw new RangeError(`op ${op} is not one of find/view/validate/submit`);
      } }),
    guardrails: [never("VERIFIED_NEEDS_EVIDENCE", "8.2 guardrail: never respond \"verified\" without evidence rows", (i) => i.op === "submit" && str(i, "determination") === "verified_as_reported" && !(Array.isArray(i.evidence_ids) && (i.evidence_ids as unknown[]).length > 0), "a verified response needs evidence rows"),
      never("ACDV_NEVER_FRIVOLOUS", "8.2 guardrail: never deem an ACDV frivolous", (i) => str(i, "determination") === "frivolous", "frivolous determinations exist only for direct disputes"),
      needsRole("DELETE_NEEDS_OFFICER", "8.2 rule 4: delete responses (DA/DF, ECOA Z) require officer approval", (i) => ["deleted_account", "deleted_consumer"].includes(str(i, "determination")) && !flag(i, "officer_approved"), ["officer"], "deletions are officer decisions"),
      never("NO_COLLECTION_NO_THIRD_PARTIES", "8.2 guardrail: never contact the consumer's employer or third parties; never use the dispute to collect", (i) => flag(i, "contact_third_party") || flag(i, "collection_request"), "disputes are investigated, not used to collect or to contact third parties")] },
  audSubmit("8.2"),
  notificationTool,
]);

// ---- 8.3 overlays -----------------------------------------------------------
const p83 = defineTools("8.3", "credit-reporting", [
  { name: "credit.suppression.create/release", kind: "write", handler: compute((i, ctx, rt) => { const op = str(i, "op") || "create";
      if (op === "release") { need(i, "id"); const rec = rt.store.put("credit_reporting_suppressions", str(i, "id"), { ends_on: str(i, "ends_on") || ctx.now.slice(0, 10), released_by: ctx.actor.id }, ctx.actor, ctx.now); ctx.events.append({ type: "credit.suppression.released", loanId: ctx.loanId, actor: ctx.actor, payload: { id: rec.id } }); return { id: rec.id, released: true }; }
      if (str(i, "reason") === "courtesy_request") return courtesyRequest();
      need(i, "reason", "mechanism", "trigger_event_id", "evidence_document_id");
      const s: Suppression = { reason: str(i, "reason") as Suppression["reason"], mechanism: str(i, "mechanism") as Mechanism, party_id: (i.party_id as string | undefined) ?? null, starts_on: D(str(i, "starts_on") || ctx.now.slice(0, 10)), ends_on: i.ends_on ? D(str(i, "ends_on")) : null, codes: Array.isArray(i.codes) ? (i.codes as string[]) : [] };
      const rec = rt.store.put("credit_reporting_suppressions", str(i, "id") || `sup-${ctx.now}`, { ...s, trigger_event_id: str(i, "trigger_event_id"), evidence_document_id: str(i, "evidence_document_id") }, ctx.actor, ctx.now);
      ctx.events.append({ type: "credit.suppression.created", loanId: ctx.loanId, actor: ctx.actor, payload: { id: rec.id, reason: s.reason, mechanism: s.mechanism } });
      const all = rt.store.list("credit_reporting_suppressions", (d) => d.loan_id === undefined || d.loan_id === ctx.loanId).map((r) => r.data as unknown as Suppression);
      return { id: rec.id, ...s, resolved: resolveSuppression(all, s.starts_on, s.party_id ?? undefined) }; }),
    guardrails: [never("NO_COURTESY_SUPPRESSION", "8.3 guardrail: the agent may not create \"courtesy\" suppressions on request — accuracy governs", (i) => (str(i, "op") || "create") === "create" && str(i, "reason") === "courtesy_request" && flag(i, "force"), "a borrower's request is logged and answered, never a suppression"),
      needsRole("DELETE_NEEDS_OFFICER", "8.3 guardrail: delete_account/delete_consumer and identity-theft releases require officer", (i) => (OFFICER_MECHANISMS.has(str(i, "mechanism") as Mechanism) || (str(i, "op") === "release" && str(i, "reason") === "identity_theft")) && !flag(i, "officer_approved"), ["officer"], "deletions and identity-theft releases are officer decisions"),
      never("CH7_DISCHARGE_NEEDS_ORDER", "8.3 guardrail: a Chapter 7 discharge zero-balance overlay requires the discharge order document", (i) => str(i, "reason") === "bankruptcy" && str(i, "phase") === "discharged" && !i.discharge_order_document_id, "attach the discharge order"),
      needsRole("SCRA_ADVERSE_NEEDS_OFFICER", "8.3 guardrail: SCRA adverse changes during the gate require officer", (i) => str(i, "reason") === "scra" && flag(i, "adverse_change") && !flag(i, "officer_approved"), ["officer"], "adverse changes during SCRA relief need an officer's not-solely-by-reason-of rationale")] },
  { name: "bankruptcy.state.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "party_id"); return rt.store.get("bankruptcy_states", str(i, "party_id"))?.data ?? null; }) },
  { name: "scra.case.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "party_id"); return rt.store.get("scra_cases", str(i, "party_id"))?.data ?? null; }) },
  { name: "disaster.case.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "loan_id"); return rt.store.get("disaster_cases", str(i, "loan_id"))?.data ?? null; }) },
  { name: "borrowers.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "loan_id"); return rt.store.list("borrowers", (d) => d.loan_id === i.loan_id).map((r) => ({ id: r.id, ...r.data })); }) },
  { name: "documents.search", kind: "read", handler: compute((i, _c, rt) => rt.store.list("documents", (d) => (!i.loan_id || d.loan_id === i.loan_id) && (!i.kind || d.kind === i.kind)).map((r) => ({ id: r.id, ...r.data }))) },
  audSubmit("8.3"),
  notificationTool,
  { name: "accuracy.control.run", kind: "write", handler: compute((i, ctx, rt) => { need(i, "control_id"); const cid = str(i, "control_id");
      const result = cid === "E-III-d" ? sampleVerification(Number(i.cycle_records ?? 0), Number(i.matched ?? 0), Number(i.sampled ?? 0)) : { sample_size: 0, match_rate: 1, escalate: flag(i, "breach") };
      const rec = rt.store.put("accuracy_control_runs", `${cid}-${ctx.now}`, { control_id: cid, run_at: ctx.now, result, escalation: result.escalate ? "officer" : null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "accuracy_program.control_run", loanId: ctx.loanId, actor: ctx.actor, payload: { control_id: cid, escalate: result.escalate } }); return { id: rec.id, ...rec.data }; }) },
  { name: "escalation.file", kind: "act", handler: escalate("officer"), decision: (i) => ({ action: "escalation.file", rationale: str(i, "reason") || "credit-reporting overlay escalation" }) },
]);

export const SECTION_08_TOOLS: readonly ToolDef[] = [...p82, ...p83];
export const isDetermination = (v: unknown): v is Determination => typeof v === "string" && ["verified_as_reported", "modified", "deleted_account", "deleted_consumer", "unverifiable", "frivolous"].includes(v);
export const frivolousAllowed = frivolousEligible;
export const dataOf = data;
