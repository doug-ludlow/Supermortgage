/**
 * §13 tools — foreclosure (`foreclosure-ops`). Every tool string is the spec's
 * verbatim; 13.3 and 13.9 name none of their own (their engines run on the
 * 13.1/13.2/13.8 tools plus §12/§16). Guardrails encode the "cannot"/"never"
 * sentences: the agent cannot open a closed gate, never sends RESUME/CERTIFY
 * while a hold is open, never marks an application complete or rejected, only
 * passes an item with evidence, never approves a rejected invoice line, never
 * files pleadings, never opens the SCRA gate and never asks a servicemember to
 * waive rights.
 */
import { defineTools, escalate, compute, never, needsRole, read, timerOps, cents, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { gate120, regxDays, stepAllowed, type Hold } from "../../domain/foreclosure/gates.ts";
import { referralEligible, type Gates } from "../../domain/foreclosure/referral.ts";
import { allowableDays, exposure, type Delay } from "../../domain/foreclosure/timeframes.ts";
import { reviewInvoice } from "../../domain/foreclosure/firms.ts";
import { classify as classifyLitigation } from "../../domain/foreclosure/litigation.ts";
import { occupancyDefault, refusedReferral, mnReferralGate, modelItemGate, maLeadPaintItem, bankruptcyScrubItem, boardingDmdc, openScraCase, protectionTail, waiverRequest, disasterHold } from "../../domain/foreclosure/ops.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const AGENT = "foreclosure-ops";
const HOLD_INSTRUCTIONS = /^(RESUME|CERTIFY_SALE)$/;
const escalationCreate = (): Omit<ToolDef, "process" | "agent"> => ({ name: "escalation.create", kind: "act", handler: escalate("officer") });
const lossmitCaseGet = (): Omit<ToolDef, "process" | "agent"> => ({ name: "lossmit.case.get", kind: "read", handler: read("lossmit_applications") });
const contactsSearch = (): Omit<ToolDef, "process" | "agent"> => ({ name: "contacts.search", kind: "read", handler: compute((i, _c, rt) => rt.store.list("contacts").filter((r) => r.data.loan_id === str(i, "loan_id") && (!str(i, "purpose") || r.data.purpose === str(i, "purpose"))).map((r) => r.data)) });
const inspectionGet = (): Omit<ToolDef, "process" | "agent"> => ({ name: "inspection.get", kind: "read", handler: read("inspections") });
const draSnapshotGet = (): Omit<ToolDef, "process" | "agent"> => ({ name: "dra.snapshot.get", kind: "read", handler: read("dra_snapshots") });
const attorneyInstructionSend = (): Omit<ToolDef, "process" | "agent"> => ({ name: "attorney.instruction.send", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "kind"); const rec = rt.store.put("attorney_instructions", str(i, "id") || `ai-${str(i, "loan_id")}-${str(i, "kind")}-${ctx.now}`, { loan_id: str(i, "loan_id"), kind: str(i, "kind"), firm_id: str(i, "firm_id") || null, sent_at: ctx.now, status: "sent", ack_due_business_days: 1 }, ctx.actor, ctx.now); ctx.events.append({ type: "attorney.instruction.sent", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { instruction_id: rec.id, kind: str(i, "kind") } }); return rec.data; }),
  guardrails: [never("NO_RESUME_WHILE_HELD", "13.2 guardrail: no RESUME/CERTIFY_SALE instruction while any hold is open", (i) => HOLD_INSTRUCTIONS.test(str(i, "kind")) && Array.isArray(i.open_holds) && (i.open_holds as unknown[]).length > 0, "release the hold through 12.x first"),
    never("GUIDE_MANDATED_ONLY", "13.6 guardrail: the agent never instructs a firm on legal strategy beyond Guide-mandated instructions", (i) => !/^(HOLD|POSTPONE_SALE|RESUME|CERTIFY_SALE|BID_INSTRUCTIONS|WITHDRAW_MOTION|REQUEST_CONTINUANCE|SCRA_STAY|STATUS_DEMAND|BK_HOLD|REFER_BACK|DOCUMENT_REQUEST)$/.test(str(i, "kind")), "hold/postpone/bid/certify and the Guide's other mandated instructions only")] });

// ---- 13.1 120-day prohibition ------------------------------------------------------
const p131 = defineTools("13.1", AGENT, [
  { name: "loan.get", kind: "read", handler: read("loans") },
  { name: "delinquency.counters.get", kind: "read", handler: compute((i) => { const eu = optDate(i, "earliest_unpaid_due"); const today = optDate(i, "today") ?? D(new Date().toISOString().slice(0, 10)); return { regx_days_delinquent: regxDays(today, eu), earliest_unpaid_due: eu }; }) },
  lossmitCaseGet(),
  contactsSearch(),
  inspectionGet(),
  { name: "foreclosure.gates.evaluate", kind: "read", handler: compute((i, ctx) => { need(i, "loan_id"); const occ = occupancyDefault({ occupancy: (str(i, "occupancy") || "unknown") as "unknown", model_conclusion: (i.model_conclusion as { non_principal: boolean; confidence: number } | undefined) ?? null }); const today = optDate(i, "today") ?? D(ctx.now.slice(0, 10));
      const g = gate120(today, optDate(i, "earliest_unpaid_due"), occ.treated_as === "principal_residence", (i.exception as "due_on_sale" | undefined) ?? null); const refused = flag(i, "attempt_referral") && g.state === "closed" ? refusedReferral({ gate: "REGX_1024_41F1_120_DAY_GATE", opens_on: g.opens_on ?? null, attempted_on: today, actor: ctx.actor.id }) : null;
      if (refused) ctx.events.append({ type: refused.event.type, loanId: str(i, "loan_id"), actor: ctx.actor, payload: refused.event }); return { occupancy: occ, gate_120: g, refused }; }),
    guardrails: [never("CANNOT_OPEN_GATE", "13.1 guardrail: the agent cannot open a closed gate; it can only add evidence that changes an input", (i) => flag(i, "force_open"), "add evidence instead")] },
  escalationCreate(),
]);

// ---- 13.2 dual tracking --------------------------------------------------------------
const p132 = defineTools("13.2", AGENT, [
  { ...lossmitCaseGet(), guardrails: [never("NO_APP_STATUS_CHANGE", "13.2 guardrail: the agent cannot mark an application complete or rejected — only 12.x can", (i) => i.op === "write" && /complete|rejected/.test(str(i, "status")), "12.x owns application status")] },
  { name: "foreclosure.case.get", kind: "read", handler: compute((i, _c, rt) => { const c = rt.store.get("foreclosure_cases", str(i, "id"))?.data ?? null; const holds = (i.holds as Hold[] | undefined) ?? []; return { case: c, step_allowed: str(i, "step") ? stepAllowed(str(i, "step"), holds) : null }; }) },
  attorneyInstructionSend(),
  { name: "attorney.instruction.status", kind: "read", handler: read("attorney_instructions") },
  draSnapshotGet(),
  { name: "timer.create", kind: "act", handler: timerOps() },
  { ...escalationCreate(), handler: escalate("attorney") },
]);

// ---- 13.4 prereferral review ---------------------------------------------------------
const p134 = defineTools("13.4", AGENT, [
  lossmitCaseGet(),
  contactsSearch(),
  { name: "notices.search", kind: "read", handler: compute((i, _c, rt) => rt.store.list("notices").filter((r) => r.data.loan_id === str(i, "loan_id") && (!str(i, "template_code") || r.data.template_code === str(i, "template_code"))).map((r) => r.data)) },
  inspectionGet(),
  { name: "dmdc.verify", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "loan_id"); const dmdc = rt.ports.dmdc as unknown as { verify?: (r: Record<string, unknown>) => Promise<unknown> } | undefined; const r = dmdc?.verify ? await dmdc.verify({ loan_id: str(i, "loan_id") }) : { status: "N", certificate_id: null }; ctx.events.append({ type: "dmdc.verification.completed", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { purpose: str(i, "purpose") || "pre_referral", result: r } }); return r; }) },
  { name: "bk.scrub", kind: "read", handler: compute((i) => bankruptcyScrubItem({ pacer_hit: flag(i, "pacer_hit"), case_number: (i.case_number as string | undefined) ?? null })) },
  { name: "title.status.get", kind: "read", handler: read("title_orders") },
  { name: "custodian.request", kind: "act", handler: compute((i, ctx) => { need(i, "loan_id", "documents"); return ctx.events.append({ type: "custodian.document.requested", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { documents: i.documents } }); }) },
  { name: "mi.status.get", kind: "read", handler: read("mi_policies") },
  { name: "insurance.status.get", kind: "read", handler: read("insurance_policies") },
  { name: "disaster.lookup", kind: "read", handler: compute((i, _c, rt) => { need(i, "county_fips"); const rows = rt.store.list("disaster_registry").filter((r) => r.data.county_fips === str(i, "county_fips") && r.data.fema_ia === true); const hold = disasterHold({ fema_ia: rows.length > 0, inspection_damage: flag(i, "inspection_damage"), review_completed_on: optDate(i, "review_completed_on") ?? D("2000-01-01"), request: (i.request as Record<string, unknown> | undefined) ?? null, fnma_approval_id: (i.fnma_approval_id as string | undefined) ?? null }); return { fema_ia: rows.length > 0, events: rows.map((r) => r.data), hold }; }),
    guardrails: [never("ITEM_PASS_NEEDS_EVIDENCE", "13.4 guardrail: an item may be pass only with attached evidence", (i) => str(i, "item_result") === "pass" && !str(i, "evidence_document_id"), "attach the evidence document"),
      never("LOW_CONFIDENCE_TO_HUMAN", "13.4 guardrail: model-evaluated items below 0.85 route to human_agent verification", (i) => str(i, "item_result") === "pass" && typeof i.confidence === "number" && !modelItemGate({ item: str(i, "item"), confidence: num(i, "confidence"), human_resolved: flag(i, "human_resolved") }).review_can_complete, "open the verification task"),
      never("MA_LEAD_PAINT", "13.4/F-1-08: MA needs the lead-paint citation search", (i) => str(i, "state") === "MA" && flag(i, "complete_review") && !maLeadPaintItem({ state: "MA", citation_search_document_id: (i.citation_search_document_id as string | undefined) ?? null }).passed, "evidence the citation search"),
      never("NO_FC_RECOMMENDATION_WITHOUT_OUTREACH", "13.4 guardrail: never send a disaster request recommending foreclosure where QRPC was never achieved unless the D2-2-02 cadence was met", (i) => str(i, "recommendation") === "foreclose" && !flag(i, "qrpc_achieved") && !flag(i, "d2202_cadence_met"), "Fannie Mae will ask for the outreach log")] },
]);

// ---- 13.5 timeframes -------------------------------------------------------------------
const p135 = defineTools("13.5", AGENT, [
  { name: "fc.timeframe.get", kind: "read", handler: compute((i) => { need(i, "state", "lpi_due", "sale_on"); const allowable = num(i, "allowable_override") || allowableDays(str(i, "state"), str(i, "county") || undefined); return { allowable, ...exposure({ lpi_due: date(i, "lpi_due"), sale_on: date(i, "sale_on"), allowable, delays: (i.delays as Delay[] | undefined) ?? [], upb_cents: cents(i.upb_cents), ptr_pct: str(i, "ptr_pct") || "0" }) }; }),
    guardrails: [never("NO_MODEL_CREDITS", "13.5 guardrail: exposure math is code; the model cannot add credits", (i) => i.extra_credit_days !== undefined, "credits come from reported status codes only")] },
  { name: "status.history.get", kind: "read", handler: read("delinquency_status_history") },
  draSnapshotGet(),
  attorneyInstructionSend(),
  { name: "documents.bundle", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "document_ids"); const rec = rt.store.put("document_bundles", str(i, "id") || `bundle-${str(i, "loan_id")}-${ctx.now}`, { loan_id: str(i, "loan_id"), document_ids: i.document_ids, purpose: str(i, "purpose") || "comp_fee_rebuttal", status: "drafted" }, ctx.actor, ctx.now); return rec.data; }),
    guardrails: [needsRole("OFFICER_SIGNS_REBUTTAL", "13.5 guardrail: rebuttals are officer-signed", (i) => str(i, "purpose") === "comp_fee_rebuttal" && flag(i, "submit"), ["officer"], "the officer certifies Fannie Mae performance-management correspondence")] },
  { name: "fnma_connect.report.pull", kind: "act", handler: compute(async (i, ctx, rt) => { need(i, "report"); const p = rt.ports.connect as unknown as { pull?: (r: string) => Promise<unknown> } | undefined; if (!p?.pull) return rt.escalations.open({ kind: "human_portal_task", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { report: str(i, "report"), reason: "Fannie Mae Connect pull is portal-only" } }, ctx.actor); return p.pull(str(i, "report")); }) },
]);

// ---- 13.6 law-firm management -------------------------------------------------------------
const p136 = defineTools("13.6", AGENT, [
  { name: "firm.get", kind: "read", handler: read("attorney_firms") },
  { name: "documents.extract", kind: "read", handler: compute((i, ctx, rt) => { need(i, "document_id"); const ai = rt.services.documentAi as { extract?: (id: string, kind: string) => Promise<unknown> } | undefined; if (!ai?.extract) return rt.escalations.open({ kind: "human_portal_task", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { document_id: str(i, "document_id"), kind: str(i, "kind") || "invoice", reason: "document AI unavailable" } }, ctx.actor); return ai.extract(str(i, "document_id"), str(i, "kind") || "invoice"); }) },
  { name: "fee_schedule.get", kind: "read", handler: read("attorney_fee_schedules") },
  { name: "invoice.review", kind: "write", moneyFields: ["allowable_cents", "previously_paid_cents"], handler: compute((i, ctx, rt) => { need(i, "invoice_id", "method", "milestone"); const r = reviewInvoice({ method: str(i, "method") as "non_judicial", milestone: str(i, "milestone"), allowable_cents: cents(i.allowable_cents), previously_paid_cents: cents(i.previously_paid_cents), costs: (i.costs as { kind: string; cents: bigint; receipt: boolean }[] | undefined) ?? [], ...(i.tech_fee_cents !== undefined ? { tech_fee_cents: cents(i.tech_fee_cents) } : {}), continuance_caused_by_servicer: flag(i, "continuance_caused_by_servicer") }); const rec = rt.store.put("attorney_invoices", str(i, "invoice_id"), { ...r, status: "reviewed" }, ctx.actor, ctx.now); ctx.events.append({ type: "firm.invoice.reviewed", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { invoice_id: rec.id, fee_approved_cents: r.fee_approved_cents } }); return rec.data; }),
    guardrails: [never("NO_APPROVE_REJECTED_LINE", "13.6 guardrail: the model cannot approve an invoice line the rules reject", (i) => Array.isArray(i.override_approve) && (i.override_approve as unknown[]).length > 0, "rejected lines stay rejected; excess fees route to SF CPM")] },
  { name: "dra.snapshot.import", kind: "act", handler: compute((i, ctx, rt) => { need(i, "firm_id", "as_of"); const rec = rt.store.put("dra_snapshots", str(i, "id") || `dra-${str(i, "firm_id")}-${str(i, "as_of")}`, { firm_id: str(i, "firm_id"), as_of: str(i, "as_of"), rows: (i.rows as unknown[] | undefined) ?? [] }, ctx.actor, ctx.now); ctx.events.append({ type: "dra.snapshot.imported", loanId: ctx.loanId, actor: ctx.actor, payload: { snapshot_id: rec.id, rows: ((i.rows as unknown[] | undefined) ?? []).length } }); return rec.data; }) },
  { name: "attorney.message.send", kind: "act", handler: compute((i, ctx) => { need(i, "firm_id", "subject"); return ctx.events.append({ type: "attorney.message.sent", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { firm_id: str(i, "firm_id"), subject: str(i, "subject") } }); }),
    guardrails: [needsRole("OFFICER_DECIDES_SUSPENSION", "13.6 guardrail: suspension/termination decisions are officer decisions", (i) => /suspend|terminat/i.test(str(i, "subject")), ["officer"], "the AI prepares the package; the officer decides"),
      never("NO_LEGAL_STRATEGY", "13.6 guardrail: litigation instructions are the attorney's domain", (i) => flag(i, "legal_strategy"), "route to the attorney")] },
]);

// ---- 13.7 litigation --------------------------------------------------------------------------
const p137 = defineTools("13.7", AGENT, [
  { name: "documents.extract", kind: "read", handler: compute((i, ctx, rt) => { need(i, "document_id"); const ai = rt.services.documentAi as { extract?: (id: string, kind: string) => Promise<unknown> } | undefined; if (!ai?.extract) return rt.escalations.open({ kind: "attorney", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { document_id: str(i, "document_id"), reason: "pleading extraction unavailable — attorney review" } }, ctx.actor); return ai.extract(str(i, "document_id"), "pleading"); }) },
  { name: "litigation.classify", kind: "read", handler: compute((i, ctx, rt) => { const r = classifyLitigation({ damages_against_fnma: flag(i, "damages_against_fnma"), attacks_validity_priority_enforceability: flag(i, "attacks_validity_priority_enforceability"), enumerated_risk: flag(i, "enumerated_risk"), damages_claim: flag(i, "damages_claim"), confidence: Number(i.confidence ?? 1) }); rt.escalations.open({ kind: "attorney", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, payload: { classification: r, reason: "classification confirmation" } }, ctx.actor); return r; }),
    guardrails: [never("NEVER_STATE_FNMA_POSITION", "13.7 guardrail: the agent never states Fannie Mae's position", (i) => typeof i.fnma_position === "string", "positions come from the officer/Fannie Mae"),
      never("ENV_CLEARED_NEEDS_HUMAN_EVIDENCE", "13.7 guardrail: environmental 'cleared' requires human-reviewed evidence", (i) => str(i, "environmental_status") === "cleared" && !str(i, "reviewer_evidence_document_id"), "attorney or licensed inspector report")] },
  { name: "foreclosure.case.get", kind: "read", handler: read("foreclosure_cases") },
  { name: "attorney.message.send", kind: "act", handler: compute((i, ctx) => { need(i, "firm_id", "subject"); return ctx.events.append({ type: "attorney.message.sent", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { firm_id: str(i, "firm_id"), subject: str(i, "subject") } }); }),
    guardrails: [never("NEVER_FILES_PLEADINGS", "13.7 guardrail: the agent never files pleadings or communicates positions to courts/opposing counsel", (i) => /^(file_pleading|court|opposing_counsel)$/.test(str(i, "recipient_kind")), "attorney only")] },
]);

// ---- 13.8 SCRA foreclosure protection -----------------------------------------------------------
const p138 = defineTools("13.8", AGENT, [
  { name: "dmdc.batch.prepare", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_ids"); const ids = i.loan_ids as string[]; const rec = rt.store.put("dmdc_batches", str(i, "id") || `dmdc-${ctx.now}`, { loan_ids: ids, purpose: str(i, "purpose") || "periodic", status: "prepared", rows: ids.length }, ctx.actor, ctx.now); return rec.data; }) },
  { name: "dmdc.results.import", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id", "results"); const r = boardingDmdc({ boarded_on: optDate(i, "boarded_on") ?? D(ctx.now.slice(0, 10)), results: i.results as Parameters<typeof boardingDmdc>[0]["results"] }); const rec = rt.store.put("dmdc_verifications", str(i, "id") || `dmdcv-${str(i, "loan_id")}-${ctx.now}`, { loan_id: str(i, "loan_id"), ...r }, ctx.actor, ctx.now); ctx.events.append({ type: "dmdc.verification.completed", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { verification_id: rec.id, purpose: str(i, "purpose") || "boarding" } }); return rec.data; }) },
  { name: "scra.case.get/open/close", kind: "write", handler: compute((i, ctx, rt) => { need(i, "loan_id"); const op = str(i, "op") || "get";
      if (op === "get") return rt.store.get("scra_cases", str(i, "id") || `scra-${str(i, "loan_id")}`)?.data ?? null;
      if (op === "open") { const r = openScraCase({ dmdc_status: (str(i, "dmdc_status") || "N") as "Y", origination_on: date(i, "origination_on"), service_begin_on: date(i, "service_begin_on"), verified_on: optDate(i, "verified_on") ?? D(ctx.now.slice(0, 10)), late_charges_since_service_cents: cents(i.late_charges_since_service_cents) }); if (!r.opened) throw new RangeError(r.refusal!); const rec = rt.store.put("scra_cases", str(i, "id") || `scra-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), status: "open", gate: r.gate, status_code: r.status_code, service_begin_on: str(i, "service_begin_on") }, ctx.actor, ctx.now); ctx.events.append({ type: "scra.case.opened", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { case_id: rec.id } }); return { ...rec.data, ...r }; }
      if (op === "close") { need(i, "service_end_on"); const tail = protectionTail(date(i, "service_end_on")); const rec = rt.store.put("scra_cases", str(i, "id") || `scra-${str(i, "loan_id")}`, { loan_id: str(i, "loan_id"), status: "tail", protection_ends_on: tail.protection_ends_on, gate_opens_on: tail.gate_opens_on }, ctx.actor, ctx.now); ctx.events.append({ type: "scra.period.ended", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { case_id: rec.id, ...tail } }); return rec.data; }
      throw new RangeError(`op ${op} is not one of get/open/close`); }),
    guardrails: [never("CANNOT_OPEN_GATE", "13.8 guardrail: the agent cannot open a gate; only tail expiry, a court order at Fannie Mae's direction, or an attorney-reviewed §3918 agreement can", (i) => flag(i, "open_gate") && !flag(i, "court_order_at_fnma_direction") && !flag(i, "section_3918_agreement_reviewed"), "wait for the tail or the attorney"),
      never("NEVER_SEEK_WAIVER", "13.8 guardrail: the agent never asks a servicemember to waive rights (D2-3.4-01)", (i) => flag(i, "solicit_waiver") || waiverRequest({ borrower_asks_to_waive: flag(i, "borrower_asks_to_waive") }).accepted, "route to the attorney"),
      needsRole("AFFIDAVIT_SIGNING_OFFICER", "13.8 guardrail: affidavits are executed only by a signing_officer after the recorded records review", (i) => str(i, "op") === "affidavit", ["signing_officer"], "checklist: certificate ids, dates, party matching, no conflicting assertions")] },
]);

export const SECTION_13_TOOLS: readonly ToolDef[] = [...p131, ...p132, ...p134, ...p135, ...p136, ...p137, ...p138];
export const unused = { referralEligible: referralEligible as (o: "refer", g: Gates) => unknown, mnReferralGate };
