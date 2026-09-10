/**
 * §8 tools — credit reporting (8.2 dispute mode, 8.3 overlay mode; 8.1 names
 * no tools in spec/registry/agents.json — its cycle mechanics run as domain
 * operations in src/domain/credit-reporting/ops.ts with the same officer
 * gate). Tool strings verbatim from the Agents paragraphs; guardrails encode
 * the "never"/"require officer" sentences. Agent: `credit-reporting`.
 *
 * Officer approvals are checked against the *actor's role* (`needsRole`), never
 * against a flag the caller asserts: an agent cannot satisfy "requires officer"
 * by passing `officer_approved: true`. Identity-theft releases are checked
 * against the *stored* suppression's reason, not the caller's input.
 */
import { defineTools, escalate, compute, never, needsRole, port, str, flag, data, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { requireOfficer } from "../roles.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import type { Acdv, AcdvResponse, Aud } from "../../infra/integrations/credit.ts";
import { AcdvSubmitGuard, frivolousEligible, ACDV_NO_RESPONSE_STATUS, type Determination } from "../../domain/credit-reporting/disputes.ts";
import { DisputeCaseRunner, VERIFIED_RESPONSE_CODE } from "../../domain/credit-reporting/ops-8-2.ts";
import { sampleVerification, resolveSuppression, type Suppression, type Mechanism, type UrgentOverlayKind } from "../../domain/credit-reporting/suppression.ts";
import { OverlayRunner, type DeceasedEvidenceKind } from "../../domain/credit-reporting/ops-8-3.ts";
import type { Bureau } from "../../domain/credit-reporting/disputes.ts";

/** The 8.3 overlay engine over the tool runtime (ops-8-3.ts): the record store, the escalation service and the command clock. */
const overlays = (ctx: { events: CommandContext["events"]; actor: CommandContext["actor"]; now: string }, rt: ToolRuntime): OverlayRunner => new OverlayRunner({ events: ctx.events, actor: ctx.actor, store: rt.store, escalations: rt.escalations, now: () => ctx.now });

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const submitGuard = new AcdvSubmitGuard();
const OFFICER_MECHANISMS = new Set<Mechanism>(["delete_account", "delete_consumer"]);
const DELETE_DETERMINATIONS = new Set<string>(["deleted_account", "deleted_consumer"]);
/** The domain's `identity_theft` reason and the spec's `identity_theft_block` / `identity_theft_report` vocabulary (8.3 data model). */
const isIdentityTheftReason = (r: string): boolean => r === "identity_theft" || r.startsWith("identity_theft_");
/** A delete response by determination or by the Metro 2 codes it carries (DA/DF account status, ECOA Z) — 8.2 rule 4. */
const isDeleteResponse = (i: ToolInput): boolean => {
  if (DELETE_DETERMINATIONS.has(str(i, "determination"))) return true;
  const r = i.response as Partial<AcdvResponse> | undefined; const f = r?.accountFields ?? {};
  return ["DA", "DF"].includes(String(f.account_status ?? "")) || String(f.ecoa ?? f.ecoa_code ?? "") === "Z";
};
const dofdOf = (a: Aud): string | null => { const v = a.fields["date_of_first_delinquency"] ?? a.fields["dofd"]; return v && v !== "00000000" ? v : null; };

const notificationTool: Omit<ToolDef, "process" | "agent"> = { name: "eoscar.notification.*", kind: "read", handler: compute((i, _c, rt) => { const list = rt.store.list("eoscar_notifications", (d) => (!i.type || d.type === i.type) && (!i.since || String(d.received_at) >= str(i, "since"))).map((r): Record<string, unknown> => ({ ...r.data, id: r.id }));
    return { notifications: list, blocks: list.filter((n) => n.type === "Block").map((n) => ({ id: n.id, action: "omit_account_immediately_and_open_fraud_case" })) }; }) };
/** `eoscar.aud.submitted` is the event the registry rows wait on (FCRA_1681S2A2_CORRECTION_PROMPT_BD2, FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2, SM_CR_OVERLAY_URGENT_AUD_BD2); an AUD carrying a DOFD also satisfies FCRA_1681S2A5_DOFD_90 (`credit.dofd.furnished{via=aud}`). */
const audSubmit = (process: string): Omit<ToolDef, "process" | "agent"> => ({ name: process === "8.2" ? "eoscar.aud.validate/submit" : "eoscar.aud.submit", kind: "act", handler: compute(async (i, ctx, rt) => { const a = i.aud as Aud | undefined; if (!a) throw new RangeError("aud is required"); const eo = port(rt, "eoscar");
      const v = await eo.validateAud(a); if (!v.valid) return { valid: false, errors: v.errors, submitted: false };
      if (i.op === "validate") return { valid: true, errors: [], submitted: false };
      const s = await eo.submitAud(a, ctx.now);
      ctx.events.append({ type: "eoscar.aud.submitted", loanId: ctx.loanId, actor: ctx.actor, payload: { aud_id: s.audId, bureau: a.bureau, account_number: a.accountNumber, reason: a.reason, submitted_at: s.submittedAt, fields: Object.keys(a.fields) } });
      const dofd = dofdOf(a); if (dofd) ctx.events.append({ type: "credit.dofd.furnished", loanId: ctx.loanId, actor: ctx.actor, payload: { via: "aud", dofd, aud_id: s.audId } });
      return { valid: true, errors: [], submitted: true, ...s }; }),
    guardrails: [never("AUD_NOT_IN_CYCLE_SUBSTITUTE", "e-OSCAR / 8.1 rule 12: an AUD may not add or create a record or substitute for in-cycle reporting", (i) => flag(i, "creates_record") || flag(i, "skip_next_cycle"), "AUDs correct; the next cycle still carries the value"),
      needsRole("REINSERTION_NEEDS_OFFICER", "8.2 rule 5 / §1681i(a)(5)(B): reinsertion of previously deleted data requires officer approval", (i) => flag(i, "reinsertion"), ["officer"], "reinsertion is an officer decision"),
      never("NO_REINSERTION_WITHOUT_CERT", "8.2 guardrail: never reinsert deleted data without certification", (i) => flag(i, "reinsertion") && !(str(i, "evidence_document_id") && str(i, "certification_document_id")), "reinsertion needs a `credit_reporting_corrections` row with evidence and a BRR/certification document (§1681i(a)(5)(B))")] });

// ---- 8.2 disputes -----------------------------------------------------------
const p82 = defineTools("8.2", "credit-reporting", [
  { name: "eoscar.acdv.find/view/validate/submit", kind: "act", handler: compute(async (i, ctx, rt) => { const eo = port(rt, "eoscar"); const op = str(i, "op") || "find";
      switch (op) {
        // 8.2 intake: `/acdvreq/vX/find` (PENDING-SENDREQUEST, last 7 days) → `credit.dispute.acdv.received` per new control number + `eoscar.poll.succeeded` (ops-8-2.ts pollAcdvs; the poll failure/alarm path lives there too)
        case "find": { const byAccount = (i.loan_id_by_account as Record<string, string> | undefined) ?? {}; const poll = await new DisputeCaseRunner(ctx.events, ctx.actor).pollAcdvs(eo, { now: ctx.now, ...(str(i, "since") ? { since: str(i, "since") } : {}), loan_id_for: (a) => byAccount[a.accountNumber] ?? ctx.loanId, ...(str(i, "next_cycle_transmit_on") ? { next_cycle_transmit_on: D(str(i, "next_cycle_transmit_on")) } : {}) });
          return { acdvs: poll.ok ? await eo.findAcdvs(str(i, "since") || "1970-01-01T00:00:00Z") : [], poll }; }
        case "view": { need(i, "control_number"); const a: Acdv = await eo.viewAcdv(str(i, "control_number")); submitGuard.view(a.controlNumber); new DisputeCaseRunner(ctx.events, ctx.actor).acdvViewed({ control_number: a.controlNumber, images_downloaded: a.images.length, at: ctx.now }); return a; }
        case "validate": { const r = i.response as AcdvResponse | undefined; if (!r) throw new RangeError("response is required"); return eo.validateAcdvResponse(r); }
        case "submit": { const r = i.response as AcdvResponse | undefined; if (!r) throw new RangeError("response is required"); if (!submitGuard.canSubmit(r.controlNumber)) throw new RangeError(`ACDV ${r.controlNumber} must be viewed before a response is submitted`); const v = await eo.validateAcdvResponse(r); if (!v.valid) throw new RangeError(`ACDV response invalid: ${v.errors.join("; ")}`);
          const s = await eo.submitAcdvResponse(r, ctx.now);
          // `credit.dispute.acdv.responded` (RESOLVED-SENDINGTOAGENCY — the three ACDV clocks) and `credit.dispute.responded{determination}` (FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2 on a data-changing outcome) via ops-8-2.ts
          const fan = new DisputeCaseRunner(ctx.events, ctx.actor).acdvResponded({ control_number: r.controlNumber, response_code: r.responseCode, determination: (str(i, "determination") || null) as Determination | null, submitted_at: s.submittedAt, fields_changed: Array.isArray(i.fields_changed) ? (i.fields_changed as string[]) : [] });
          return { ...s, eoscar_status: "RESOLVED-SENDINGTOAGENCY", ...fan }; }
        default: throw new RangeError(`op ${op} is not one of find/view/validate/submit`);
      } }),
    guardrails: [never("VERIFIED_NEEDS_EVIDENCE", "8.2 guardrail: never respond \"verified\" without evidence rows", (i) => i.op === "submit" && (str(i, "determination") === "verified_as_reported" || (!str(i, "determination") && (i.response as Partial<AcdvResponse> | undefined)?.responseCode === VERIFIED_RESPONSE_CODE)) && !(Array.isArray(i.evidence_ids) && (i.evidence_ids as unknown[]).length > 0), "a verified response (determination or the \"accurate as reported\" response code) needs ≥1 relied-upon credit_dispute_evidence row"),
      never("ACDV_NEVER_FRIVOLOUS", "8.2 guardrail: never deem an ACDV frivolous", (i) => str(i, "determination") === "frivolous", "frivolous determinations exist only for direct disputes"),
      needsRole("DELETE_NEEDS_OFFICER", "8.2 rule 4: delete responses (DA/DF, ECOA Z) require officer approval", (i) => i.op === "submit" && isDeleteResponse(i), ["officer"], "deletions are officer decisions — the actor submitting a delete must be an officer"),
      never("DUE_DATE_NEVER_LAPSES", "8.2 guardrail: never let a due date lapse (a best-available modify/delete response with a follow-up correction is preferred to silence); 8.2-T3", (i) => i.op === "submit" && ((i.response as Partial<AcdvResponse> | undefined)?.responseCode === ACDV_NO_RESPONSE_STATUS || str(i, "eoscar_status") === ACDV_NO_RESPONSE_STATUS || flag(i, "no_response")), `${ACDV_NO_RESPONSE_STATUS} is never submitted; submit the best-available response and follow up with a correction`),
      never("ORAL_FOLLOWUP_DISCLOSES_AUTOMATION", "8.2 guardrail: disclose automation in any oral follow-up (baseline §8 item 6)", (i) => str(i, "follow_up_channel") === "oral" && i.automation_disclosed !== true, "an oral follow-up must disclose that the caller is automated"),
      never("NO_COLLECTION_NO_THIRD_PARTIES", "8.2 guardrail: never contact the consumer's employer or third parties; never use the dispute to collect", (i) => flag(i, "contact_third_party") || flag(i, "collection_request"), "disputes are investigated, not used to collect or to contact third parties")] },
  audSubmit("8.2"),
  notificationTool,
]);

// ---- 8.3 overlays -----------------------------------------------------------
const urgentKind = (i: ToolInput): UrgentOverlayKind | null => {
  const reason = str(i, "reason");
  if (isIdentityTheftReason(reason)) return "identity_theft_block";
  if (reason === "scra" && flag(i, "adverse_change")) return "scra_adverse_correction";
  if (reason === "deceased" && flag(i, "in_error")) return "deceased_in_error";
  return null;
};
const p83 = defineTools("8.3", "credit-reporting", [
  { name: "credit.suppression.create/release", kind: "write", handler: compute((i, ctx, rt) => { const op = str(i, "op") || "create";
      // ---- 8.3 overlay-engine ops (ops-8-3.ts): the inbound records the rows arm on and the sweeps/reviews that satisfy them
      if (op === "ingest_noe") { const ev = ctx.events.all().find((e) => e.id === str(i, "event_id") && e.type === "case.noe.opened"); if (!ev) throw new RangeError(`event_id must name a case.noe.opened event (${str(i, "event_id") || "missing"})`); return overlays(ctx, rt).ingestNoeOpened(ev, Array.isArray(i.scope) ? { scope: (i.scope as string[]).map((d) => D(d)) } : {}); }
      if (op === "noe_closed") { need(i, "id", "closed_on", "outcome"); return overlays(ctx, rt).noeClosed({ suppression_id: str(i, "id"), closed_on: D(str(i, "closed_on")), outcome: str(i, "outcome") as "error_found" | "no_error", continuing_disagreement: flag(i, "continuing_disagreement") }); }
      if (op === "expire") return { expired: overlays(ctx, rt).expireNoeBars(D(str(i, "today") || ctx.now.slice(0, 10))) };       // RESPA_2605E3_QWR_SUPPRESS_60 / REGX_1024_35I_CREDIT_SUPPRESS_60 "expiry"
      if (op === "confirm_deceased") { need(i, "party_id", "confirmed_on", "evidence_kind", "evidence_document_id"); return overlays(ctx, rt).confirmDeceased({ loan_id: ctx.loanId, party_id: str(i, "party_id"), confirmed_on: D(str(i, "confirmed_on")), evidence_kind: str(i, "evidence_kind") as DeceasedEvidenceKind, evidence_document_id: str(i, "evidence_document_id"), ...(str(i, "trigger_event_id") ? { trigger_event_id: str(i, "trigger_event_id") } : {}) }); }
      if (op === "deceased_in_error") { need(i, "id", "proof_of_life_document_id"); return overlays(ctx, rt).deceasedInError({ suppression_id: str(i, "id"), proof_of_life_document_id: str(i, "proof_of_life_document_id") }); }
      if (op === "ingest_block") { need(i, "party_id", "control_number", "cra", "received_at"); return overlays(ctx, rt).ingestBlockNotice({ loan_id: ctx.loanId, party_id: str(i, "party_id"), control_number: str(i, "control_number"), cra: str(i, "cra") as Bureau, received_at: str(i, "received_at"), ...(str(i, "identity_theft_report_id") ? { identity_theft_report_id: str(i, "identity_theft_report_id") } : {}), never_liable: flag(i, "never_liable") }); }
      if (op === "review") { need(i, "id", "reviewed_on"); const dk = i.docket as { status: "open" | "dismissed" | "discharged"; event_on: string | null; order_document_id: string | null } | undefined; return overlays(ctx, rt).reviewSuppression({ suppression_id: str(i, "id"), reviewed_on: D(str(i, "reviewed_on")), ...(dk ? { docket: { status: dk.status, event_on: dk.event_on ? D(dk.event_on) : null, order_document_id: dk.order_document_id ?? null } } : {}) }); }
      if (op === "release") {
        need(i, "id");
        const cur = rt.store.get("credit_reporting_suppressions", str(i, "id")); if (!cur) throw new RangeError(`no suppression ${str(i, "id")}`);
        const storedReason = String(cur.data.reason ?? "");
        const identityTheft = isIdentityTheftReason(storedReason) || isIdentityTheftReason(str(i, "reason"));
        if (identityTheft) {                                                      // 8.3 guardrail: identity-theft releases require `officer`, checked on the stored row
          requireOfficer(ctx.actor, `release of identity-theft suppression ${cur.id}`);
          need(i, "evidence_document_id");                                        // FCRA_1681C2_IDTHEFT_BLOCK_GATE: "until officer release with evidence" (BRR / CRA block rescission)
        }
        const rec = rt.store.put("credit_reporting_suppressions", cur.id, { status: "released", ends_on: str(i, "ends_on") || ctx.now.slice(0, 10), released_by: ctx.actor.id, released_reason: str(i, "released_reason") || str(i, "rationale") || null, release_evidence_document_id: str(i, "evidence_document_id") || null }, ctx.actor, ctx.now);
        ctx.events.append({ type: "credit.suppression.released", loanId: ctx.loanId, actor: ctx.actor, payload: { id: rec.id, reason: storedReason, released_by: ctx.actor.id } });
        if (identityTheft) ctx.events.append({ type: "credit.identity_theft.released", loanId: ctx.loanId, actor: ctx.actor, payload: { id: rec.id, by: "officer", officer_id: ctx.actor.id, evidence_document_id: str(i, "evidence_document_id") } });
        return { id: rec.id, released: true, reason: storedReason };
      }
      if (str(i, "reason") === "courtesy_request") return overlays(ctx, rt).logCourtesyRequest({ loan_id: ctx.loanId, party_id: (i.party_id as string | undefined) ?? null, channel: str(i, "channel") || "ai_voice", ...(str(i, "utterance") ? { utterance: str(i, "utterance") } : {}) });   // 8.3-T12: logged and answered, never a suppression
      need(i, "reason", "mechanism", "trigger_event_id", "evidence_document_id");
      const s: Suppression = { reason: str(i, "reason") as Suppression["reason"], mechanism: str(i, "mechanism") as Mechanism, party_id: (i.party_id as string | undefined) ?? null, starts_on: D(str(i, "starts_on") || ctx.now.slice(0, 10)), ends_on: i.ends_on ? D(str(i, "ends_on")) : null, codes: Array.isArray(i.codes) ? (i.codes as string[]) : [] };
      const rec = rt.store.put("credit_reporting_suppressions", str(i, "id") || `sup-${ctx.now}`, { ...s, loan_id: ctx.loanId, status: "active", trigger_event_id: str(i, "trigger_event_id"), evidence_document_id: str(i, "evidence_document_id"), created_by: `${ctx.actor.kind}:${ctx.actor.id}`, created_at: ctx.now, ...(str(i, "phase") ? { phase: str(i, "phase") } : {}), ...(i.chapter !== undefined ? { chapter: Number(i.chapter) } : {}), ...(str(i, "discharge_order_document_id") ? { discharge_order_document_id: str(i, "discharge_order_document_id") } : {}), ...(str(i, "case_id") ? { case_id: str(i, "case_id") } : {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "credit.suppression.created", loanId: ctx.loanId, actor: ctx.actor, payload: { id: rec.id, reason: s.reason, mechanism: s.mechanism, party_id: s.party_id, created_at: ctx.now, trigger_event_id: str(i, "trigger_event_id"), evidence_document_id: str(i, "evidence_document_id") } });
      const urgent = urgentKind(i);
      if (urgent) ctx.events.append({ type: "credit.overlay.urgent", loanId: ctx.loanId, actor: ctx.actor, payload: { kind: urgent, suppression_id: rec.id, party_id: s.party_id, event: ctx.now } });   // SM_CR_OVERLAY_URGENT_AUD_BD2 trigger
      const all = rt.store.list("credit_reporting_suppressions", (d) => (d.loan_id === undefined || d.loan_id === ctx.loanId) && d.status !== "released").map((r) => r.data as unknown as Suppression);
      return { id: rec.id, ...s, urgent_aud: urgent, resolved: resolveSuppression(all, s.starts_on, s.party_id ?? undefined) }; }),
    guardrails: [never("NO_COURTESY_SUPPRESSION", "8.3 guardrail: the agent may not create \"courtesy\" suppressions on request — accuracy governs", (i) => (str(i, "op") || "create") === "create" && str(i, "reason") === "courtesy_request" && flag(i, "force"), "a borrower's request is logged and answered, never a suppression"),
      never("SUPPRESSION_NEEDS_EVENT_AND_EVIDENCE", "8.3 guardrail: no suppression without a triggering event and evidence", (i) => (str(i, "op") || "create") === "create" && str(i, "reason") !== "courtesy_request" && !(str(i, "trigger_event_id") && str(i, "evidence_document_id")), "a suppression cites its trigger_event_id and evidence_document_id"),
      needsRole("DELETE_NEEDS_OFFICER", "8.3 guardrail: delete_account/delete_consumer and identity-theft releases require officer", (i) => OFFICER_MECHANISMS.has(str(i, "mechanism") as Mechanism) || (str(i, "op") === "release" && isIdentityTheftReason(str(i, "reason"))), ["officer"], "deletions and identity-theft releases are officer decisions"),
      // keyed on what the overlay *does* (CII E / delete_account / a discharged phase), not only on an optional `phase` input a caller can omit
      never("CH7_DISCHARGE_NEEDS_ORDER", "8.3 guardrail: a Chapter 7 discharge zero-balance overlay requires the discharge order document", (i) => (str(i, "op") || "create") === "create" && str(i, "reason").startsWith("bankruptcy") && (str(i, "phase") === "discharged" || str(i, "phase") === "ch7_discharged" || str(i, "mechanism") === "delete_account" || (Array.isArray(i.codes) && (i.codes as unknown[]).some((c) => c === "CII E" || c === "CII H"))) && !i.discharge_order_document_id, "attach the discharge order"),
      needsRole("SCRA_ADVERSE_NEEDS_OFFICER", "8.3 guardrail: SCRA adverse changes during the gate require officer", (i) => str(i, "reason") === "scra" && flag(i, "adverse_change"), ["officer"], "adverse changes during SCRA relief need an officer's not-solely-by-reason-of rationale")] },
  { name: "bankruptcy.state.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "party_id"); return rt.store.get("bankruptcy_states", str(i, "party_id"))?.data ?? null; }) },
  { name: "scra.case.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "party_id"); return rt.store.get("scra_cases", str(i, "party_id"))?.data ?? null; }) },
  { name: "disaster.case.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "loan_id"); return rt.store.get("disaster_cases", str(i, "loan_id"))?.data ?? null; }) },
  { name: "borrowers.get", kind: "read", handler: compute((i, _c, rt) => { need(i, "loan_id"); return rt.store.list("borrowers", (d) => d.loan_id === i.loan_id).map((r) => ({ id: r.id, ...r.data })); }) },
  { name: "documents.search", kind: "read", handler: compute((i, _c, rt) => rt.store.list("documents", (d) => (!i.loan_id || d.loan_id === i.loan_id) && (!i.kind || d.kind === i.kind)).map((r) => ({ id: r.id, ...r.data }))) },
  audSubmit("8.3"),
  notificationTool,
  { name: "accuracy.control.run", kind: "write", handler: compute((i, ctx, rt) => { need(i, "control_id"); const cid = str(i, "control_id");
      const result = cid === "E-III-d" ? sampleVerification(Number(i.cycle_records ?? 0), Number(i.matched ?? 0), Number(i.sampled ?? 0)) : { sample_size: 0, match_rate: 1, escalate: flag(i, "breach") };
      const variances = Array.isArray(i.variances) ? (i.variances as Record<string, unknown>[]) : [];   // field-level variances the qc-audit re-derivation found (8.3-T13)
      const rec = rt.store.put("accuracy_control_runs", `${cid}-${ctx.now}`, { control_id: cid, run_at: ctx.now, result, variances, escalation: result.escalate ? "officer" : null }, ctx.actor, ctx.now);
      if (result.escalate) rt.escalations.open({ kind: "officer", ...(str(i, "cycle_id") ? {} : { loanId: ctx.loanId }), payload: { task: "accuracy_program_control_breach", control_id: cid, cycle_id: str(i, "cycle_id") || null, match_rate: result.match_rate, sample_size: result.sample_size, sampled: Number(i.sampled ?? 0), matched: Number(i.matched ?? 0), variances } }, ctx.actor);   // Appendix E III(d): match < 99.5% → `officer` with the variances
      // Subject = the cycle when one is named (SM_APPX_E_SAMPLE_VERIFY_MONTHLY is armed by `credit.cycle.validated` on the cycle), else the loan.
      ctx.events.append({ type: "accuracy_program.control_run", ...(str(i, "cycle_id") ? { aggregate: { kind: "metro2_cycle", id: str(i, "cycle_id") } } : { loanId: ctx.loanId }), actor: ctx.actor, payload: { control_id: cid, cycle_id: str(i, "cycle_id") || null, escalate: result.escalate, match_rate: result.match_rate, sample_size: result.sample_size } }); return { id: rec.id, ...rec.data }; }) },
  { name: "escalation.file", kind: "act", handler: escalate("officer"), decision: (i) => ({ action: "escalation.file", rationale: str(i, "reason") || "credit-reporting overlay escalation" }) },
]);

export const SECTION_08_TOOLS: readonly ToolDef[] = [...p82, ...p83];
export const isDetermination = (v: unknown): v is Determination => typeof v === "string" && ["verified_as_reported", "modified", "deleted_account", "deleted_consumer", "unverifiable", "frivolous"].includes(v);
export const frivolousAllowed = frivolousEligible;
export const dataOf = data;
export const suppressionRows = rows;
