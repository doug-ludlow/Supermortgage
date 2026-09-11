/**
 * §28.4 process-owned tools — bus tools for 28.4 defined with `defineTools("28.4", "fraud-risk", defs)` from
 * ../tools.ts. Every tool string is one spec/registry/agents.json names for 28.4; src/app/tools.test.ts refuses the
 * rest. Spread by ./index.ts. The handlers are thin: the rules live in src/domain/qc-hmda/ops-28-4.ts; the store keeps
 * `fraud_cases` (the shared cases{case_type='fraud'} row + the 28.4 payload), `sars`, `sar_decisions`, `ofac_hits`,
 * `ofac_reports`, `fnma_fraud_reports`, `identity_theft_requests`, `bsa_program` (migration 0102) and the
 * `applications` fraud_hold overlay 22.6 defined (0083) that 23.1/25.2/26.x/27.x assert through assertNoFraudHold.
 * The vendors are 22.6's services (`ofac_screener`, `fraud_tool`, `identity_vendor`, `cbsv`, `mers`) — none added here.
 * Guardrails encode the AI-design sentences: never files a SAR, OFAC report or Fannie Mae report (human acts only —
 * the `file` / `submit` ops are human-only and role-gated); never sets `initial_detection_at` without officer review
 * (recommendTriage op=record is the bsa_officer's); never tells a borrower or any party that a SAR or investigation
 * exists (interview questions and every borrower-visible string are scanned); never uses the SAR compartment for
 * production decisions (denial reasons come from the 21.6 taxonomy); never contacts law enforcement without the
 * officer except the immediate-attention protocol; never uses `applicant_demographics`; never bypasses the hold.
 */
import { defineTools, compute, never, needsRole, humanWhen, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { FORBIDDEN_MODEL_INPUTS, FraudHoldBlocked, assertNoFraudHold, recordPartyScreening, type ListVersion, type OfacScreenerPort, type PartyIdentity, type OfacCandidate } from "../../domain/verification/ops-22-6.ts";
import {
  ScreeningRefused, aggregateSignals, signalFromEvent, openFraudCase, applyProductionHold, releaseProductionHold, assertNoProductionHold, recordStep, interviewQuestionAllowed, INTERVIEW_DISCLOSURE, buildTimeline, assessScheme, computeAmount,
  recordTriage, notifyLawEnforcement, closeCase, draftNarrative, draftSar, officerSarDecision, fileSar, acknowledgeSar, rejectSar, scheduleContinuingReview, querySars, subpoenaForSarMaterial, SAR_COMPARTMENT_ROLES,
  recordOfacHit, dispositionOfacHit, unblockProperty, submitOfacReport, ofacListRefresh, screenCounterparty, ofacClearBeforeFundingGate,
  openFnmaFraudReport, approveFnmaReport, submitFnmaReport, receiveIdentityTheftRequest, fulfilIdentityTheftRequest, fraudRiskDecisionRecord, scanForSarTerms,
  type FraudCase, type Sar, type SarDecision, type OfacHit, type OfacReportKind, type FnmaFraudReport, type IdentityTheftRequest, type Signal, type SchemeHypothesis, type InvestigationStep, type TriageInput, type DispositionInput, type ExclusionList, type ClaimProof, type DeclineGround, type SarFiler, type FilingChannel, type OfacList,
} from "../../domain/qc-hmda/ops-28-4.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const strs = (i: ToolInput, k: string): string[] => (Array.isArray(i[k]) ? (i[k] as unknown[]).map(String) : []);
const obj = <T,>(i: ToolInput, k: string): T | null => (i[k] && typeof i[k] === "object" ? (i[k] as T) : null);
const svc = <T,>(rt: ToolRuntime, name: string): T | null => (rt.services[name] as T | undefined) ?? null;
const demographicKeys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as Record<string, unknown>).filter((k) => FORBIDDEN_MODEL_INPUTS.some((p) => p.test(k))) : []);
const withBig = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));
const appRecord = (rt: ToolRuntime, app: string): Record<string, unknown> => rt.store.get("applications", app)?.data ?? {};
const putApp = (rt: ToolRuntime, app: string, patch: Record<string, unknown>, ctx: CommandContext): void => { rt.store.put("applications", app, { ...appRecord(rt, app), ...patch }, ctx.actor, ctx.now); };
const caseOf = (rt: ToolRuntime, i: ToolInput): FraudCase => { need(i, "case_id"); const d = rt.store.require("fraud_cases", str(i, "case_id")).data as unknown as Record<string, unknown>; return { ...(d as unknown as FraudCase), amount_cents: BigInt(String(d.amount_cents ?? "0")) }; };
const putCase = (rt: ToolRuntime, c: FraudCase, ctx: CommandContext): void => { rt.store.put("fraud_cases", c.case_id, withBig({ ...c, case_type: "fraud" }), ctx.actor, ctx.now); };
const sarOf = (rt: ToolRuntime, i: ToolInput): Sar => { need(i, "sar_id"); return rt.store.require("sars", str(i, "sar_id")).data as unknown as Sar; };
const putSar = (rt: ToolRuntime, s: Sar, ctx: CommandContext): void => { rt.store.put("sars", s.sar_id, { ...s } as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const putDecision = (rt: ToolRuntime, d: SarDecision, ctx: CommandContext): void => { rt.store.put("sar_decisions", d.decision_id, { ...d } as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const hitOf = (rt: ToolRuntime, i: ToolInput): OfacHit => { need(i, "hit_id"); const d = rt.store.require("ofac_hits", str(i, "hit_id")).data as unknown as Record<string, unknown>; const bp = d.blocked_property as Record<string, unknown> | null; const rtx = d.rejected_transaction as Record<string, unknown> | null;
  return { ...(d as unknown as OfacHit), blocked_property: bp ? { ...(bp as unknown as NonNullable<OfacHit["blocked_property"]>), value_cents: BigInt(String(bp.value_cents)) } : null, rejected_transaction: rtx ? { ...(rtx as unknown as NonNullable<OfacHit["rejected_transaction"]>), value_cents: BigInt(String(rtx.value_cents)) } : null }; };
const putHit = (rt: ToolRuntime, h: OfacHit, ctx: CommandContext): void => { rt.store.put("ofac_hits", h.hit_id, { ...h, blocked_property: h.blocked_property ? withBig(h.blocked_property) : null, rejected_transaction: h.rejected_transaction ? withBig(h.rejected_transaction) : null } as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const reportOf = (rt: ToolRuntime, i: ToolInput): FnmaFraudReport => { need(i, "report_id"); return rt.store.require("fnma_fraud_reports", str(i, "report_id")).data as unknown as FnmaFraudReport; };
const putReport = (rt: ToolRuntime, r: FnmaFraudReport, ctx: CommandContext): void => { rt.store.put("fnma_fraud_reports", r.report_id, { ...r } as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const requestOf = (rt: ToolRuntime, i: ToolInput): IdentityTheftRequest => { need(i, "request_id"); const d = rt.store.require("identity_theft_requests", str(i, "request_id")).data as unknown as Record<string, unknown>; return { ...(d as unknown as IdentityTheftRequest), charge_cents: BigInt(String(d.charge_cents ?? "0")) }; };
const putRequest = (rt: ToolRuntime, r: IdentityTheftRequest, ctx: CommandContext): void => { rt.store.put("identity_theft_requests", r.request_id, withBig({ ...r }), ctx.actor, ctx.now); };
const escalateTo = (rt: ToolRuntime, ctx: CommandContext, kind: EscalationKind, c: Pick<FraudCase, "case_id" | "application_id" | "loan_id"> | null, payload: Record<string, unknown>, severity?: string) =>
  rt.escalations.open({ kind, ...(c?.application_id ? { applicationId: c.application_id } : {}), loanId: c?.loan_id ?? ctx.loanId, ...(c ? { caseId: c.case_id } : {}), payload, ...(severity ? { severity } : {}) }, ctx.actor);
const timersFor = (ctx: CommandContext, codes: readonly string[]) => Object.fromEntries(codes.map((code) => [code, ctx.timers.byCode(code).at(-1) ?? null]).map(([code, t]) => [code as string, t ? { status: (t as { status: string }).status, due_date: (t as { dueDate?: string }).dueDate ?? null } : null]));
/** ops-28-4 refusals surface as CommandRefused with the same code and citation; a hold as FRAUD_HOLD. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof ScreeningRefused) throw new CommandRefused(d.name, e.code, e.citation, e.message); if (e instanceof FraudHoldBlocked) throw new CommandRefused(d.name, "FRAUD_HOLD", "22.6 / 28.4 SM_FRAUD_PRODUCTION_HOLD", e.message); throw e; } } }));

const NO_DEMOGRAPHIC_INPUTS = never("NO_DEMOGRAPHIC_INPUTS", "28.4 guardrail: never uses `applicant_demographics`; 31.2 monitors flag rates by protected-class proxies", (i) => demographicKeys(i.signals).length > 0 || demographicKeys(i.inputs).length > 0 || demographicKeys(i).length > 0 || strs(i, "reads").some((r) => /applicant_demographics/i.test(r)), "applicant_demographics and protected-class fields are never inputs to the fraud-risk agent");
const NO_HOLD_BYPASS = never("NO_HOLD_BYPASS", "28.4 rule 1 / timer table SM_FRAUD_PRODUCTION_HOLD; 22.6 guardrail", (i) => flag(i, "bypass_hold") || flag(i, "override_hold") || flag(i, "bypass") || flag(i, "funder_override"), "a production hold or the OFAC funding gate is never bypassed — the hold releases on `not_suspicious` or a chosen decision path; the gate opens on a fresh clear screen");
const NO_FILING_BY_AGENT = humanWhen("FILING_IS_HUMAN_ACT", "28.4 automation class (b): nothing is filed without the human decision; guardrail: never files a SAR, OFAC report or Fannie Mae report", (i) => ["file", "submit", "decide", "approve", "unblock"].includes(str(i, "op")) || flag(i, "file") || flag(i, "submit") || flag(i, "e_file"), "the agent drafts; the bsa_officer files the SAR and OFAC reports, the partner officer approves and the fnma_portal_operator submits the Fannie Mae report");
const NO_SAR_DISCLOSURE = never("NO_SAR_DISCLOSURE", "31 CFR 1029.320(d); 28.4 rule 9 (sar_confidentiality_acl)", (i) => (!!str(i, "share_with_role") && !SAR_COMPARTMENT_ROLES.includes(str(i, "share_with_role"))) || flag(i, "borrower_visible") || (typeof i.borrower_message === "string" && !scanForSarTerms(i.borrower_message).clean), "never tells a borrower or any party that a SAR or investigation exists; SAR existence, drafts, filings and BSA IDs stay in the compartment");
const NO_UNDOCUMENTED_THIRD_PARTY_CONTACT = never("NO_UNDOCUMENTED_THIRD_PARTY_CONTACT", "28.4 worked example 1 / 22.6 guardrail: independent verifications through documented channels (directory listing, payroll vendor, written VOE)", (i) => str(i, "channel") === "third_party_direct", "third parties are reached only through documented verification channels");
const INTERVIEW_DISCLOSED = never("INTERVIEW_NEEDS_DISCLOSURE", "28.4 AI design: AI voice interviews disclose automation and are recorded under consent rules; interviews are verification questions, not accusations", (i) => Array.isArray(i.questions) && (i.automation_disclosed !== true || (flag(i, "recorded") && !str(i, "consent_id")) || (i.questions as unknown[]).some((q) => !interviewQuestionAllowed(String(q)).allowed)), "disclose the automation, record only under consent, and ask verification questions that never reveal an investigation or a SAR");
const LE_NEEDS_OFFICER = needsRole("LE_CONTACT_NEEDS_OFFICER", "28.4 guardrail: never contacts law enforcement without the officer except the immediate-attention protocol (officer paged simultaneously)", (i) => str(i, "op") === "notify_le" && !flag(i, "officer_paged"), ["bsa_officer"], "law enforcement is notified by the bsa_officer, or under the immediate-attention protocol with the officer paged");
const TRIAGE_RECORD_IS_OFFICER = needsRole("TRIAGE_NEEDS_OFFICER_REVIEW", "28.4 guardrail: never sets `initial_detection_at` without officer review; rule 2: reviewed by the bsa_officer", (i) => str(i, "op") === "record" && !obj(i, "officer_review"), ["bsa_officer"], "the triage decision is recorded by the bsa_officer, or by the agent with the officer's completed review attached");

export const TOOLS_28_4: readonly ToolDef[] = defineTools("28.4", "fraud-risk", refusing([
  // Rule 1: signals (given, or derived from named upstream events — 28.1/28.2 referrals, 26.3 wire-fraud, 22.x screening, 22.2 alerts, 29.4 breach notices) → weighted score and the case decision.
  { name: "aggregateSignals", kind: "read", guardrails: [NO_DEMOGRAPHIC_INPUTS], handler: compute((i, ctx) => {
      const given = (Array.isArray(i.signals) ? (i.signals as Signal[]) : []);
      const ids = new Set(strs(i, "event_ids"));
      const derived = ctx.events.all().filter((e) => ids.has(e.id)).map(signalFromEvent).filter((s): s is Signal => s !== null);
      const signals = [...given, ...derived];
      if (!signals.length) throw new RangeError("signals or event_ids are required");
      const agg = aggregateSignals(signals, typeof i.threshold === "number" ? i.threshold : undefined);
      return { ...agg, signals, hypotheses: assessScheme(signals).hypotheses };
    }) },
  // Rule 1 / worked example 1: the case opens on the shared cases row; an open application takes the production hold (22.6's fraud_hold overlay).
  { name: "openCase", kind: "act", guardrails: [NO_DEMOGRAPHIC_INPUTS], handler: compute((i, ctx, rt) => {
      need(i, "partner_id", "opened_by"); const application_id = str(i, "application_id") || ctx.applicationId || null; const loan_id = str(i, "loan_id") || null;
      const app = application_id ? appRecord(rt, application_id) : {};
      const application_open = i.application_open === undefined ? !!application_id && app.status !== "closed" && app.status !== "denied" && app.status !== "withdrawn" : flag(i, "application_open");
      const r = openFraudCase(ctx.events, { application_id, loan_id, partner_id: str(i, "partner_id"), opened_by: str(i, "opened_by"), signals: (Array.isArray(i.signals) ? (i.signals as Signal[]) : []), scheme_hypotheses: strs(i, "scheme_hypotheses") as SchemeHypothesis[], subjects: (Array.isArray(i.subjects) ? (i.subjects as { party_id: string; role: string }[]) : []), amount_cents: cents(i.amount_cents), application_open, at: at(i, "at", ctx), case_id: str(i, "case_id") || null }, ctx.actor);
      putCase(rt, r.fraud_case, ctx); rt.store.put("cases", r.fraud_case.case_id, { case_type: "fraud", status: "open", opened_at: r.fraud_case.opened_at, application_id, loan_id }, ctx.actor, ctx.now);
      if (r.fraud_case.hold && application_id) putApp(rt, application_id, { fraud_hold: true, fraud_hold_reason: "investigation_open", fraud_hold_case_id: r.fraud_case.case_id, fraud_hold_placed_at: r.fraud_case.opened_at, fraud_hold_record: r.fraud_case.hold }, ctx);
      return { ...withBig({ ...r.fraud_case }), score: r.aggregate.score, reasons: r.aggregate.reasons, timers: timersFor(ctx, ["SM_FRAUD_TRIAGE_SLA_10", "SM_FRAUD_PRODUCTION_HOLD"]) };
    }) },
  // SM_FRAUD_PRODUCTION_HOLD: apply (default), release{path, rationale}, check{command} — issueCD / consummate / disburse / submitDelivery refuse while the hold is on; never bypassed.
  { name: "applyHold", kind: "act", guardrails: [NO_HOLD_BYPASS], humanRoles: ["bsa_officer", "officer", "funding_approver", "underwriting_reviewer", "ops_analyst"], handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i); const op = str(i, "op") || "apply";
      if (op === "check") { need(i, "command"); assertNoProductionHold(c, str(i, "command")); if (c.application_id) assertNoFraudHold(appRecord(rt, c.application_id) as { fraud_hold: boolean; reason?: string | null }, str(i, "command")); return { command: str(i, "command"), blocked: false }; }
      if (op === "release") { need(i, "rationale", "path"); const r = releaseProductionHold(ctx.events, c, { rationale: str(i, "rationale"), path: str(i, "path") as "not_suspicious" | "decision_path_chosen", at: at(i, "at", ctx) }, ctx.actor); putCase(rt, r.fraud_case, ctx); if (c.application_id) putApp(rt, c.application_id, { fraud_hold: false, fraud_hold_reason: null, fraud_hold_case_id: null, fraud_hold_record: null }, ctx); return { released: true, hold_timer: timersFor(ctx, ["SM_FRAUD_PRODUCTION_HOLD"]) }; }
      const h = applyProductionHold(ctx.events, c, at(i, "at", ctx), ctx.actor); const next: FraudCase = { ...c, production_hold: true, hold: h.hold }; putCase(rt, next, ctx);
      if (c.application_id) putApp(rt, c.application_id, { fraud_hold: true, fraud_hold_reason: "investigation_open", fraud_hold_case_id: c.case_id, fraud_hold_placed_at: h.hold.placed_at, fraud_hold_record: h.hold }, ctx);
      return { fraud_hold: true, blocks: h.hold.blocks, case_id: c.case_id };
    }) },
  // Investigation steps with evidence refs (the decision record's investigation_steps): document re-examination …
  { name: "reexamineDocuments", kind: "write", handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i); need(i, "result"); const docs = strs(i, "document_ids"); if (!docs.length) throw new RangeError("document_ids are required");
      const r = recordStep(ctx.events, c, { tool: "reexamineDocuments", source: str(i, "source") || "22.1 document_integrity_checks + independent source", result: str(i, "result"), evidence_refs: docs, at: at(i, "at", ctx) }, ctx.actor); putCase(rt, r.fraud_case, ctx);
      return { case_id: c.case_id, steps: r.fraud_case.steps.length, triage_status: r.fraud_case.triage_status };
    }) },
  // … independent verification through a documented channel (directory listing, payroll vendor, written VOE) — never a direct third-party contact.
  { name: "orderIndependentVerification", kind: "act", guardrails: [NO_UNDOCUMENTED_THIRD_PARTY_CONTACT], handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i); need(i, "kind", "result"); const refs = strs(i, "evidence_refs"); if (!refs.length) throw new RangeError("evidence_refs are required");
      const r = recordStep(ctx.events, c, { tool: "orderIndependentVerification", source: `${str(i, "kind")} via ${str(i, "channel") || "documented_verification_channel"}`, result: str(i, "result"), evidence_refs: refs, at: at(i, "at", ctx) }, ctx.actor); putCase(rt, r.fraud_case, ctx);
      return { case_id: c.case_id, kind: str(i, "kind"), steps: r.fraud_case.steps.length };
    }) },
  // OFAC / exclusion-list screening: screen (default — 22.6's recordPartyScreening through the ofac_screener port; potential candidates become ofac_hits), refresh (the daily SLS refresh tick), counterparty (FHFA SCP / GSA SAM / HUD LDP at onboarding).
  { name: "screenParty", kind: "act", handler: compute(async (i, ctx, rt) => {
      const op = str(i, "op") || "screen";
      if (op === "refresh") { need(i, "owner", "date"); const e = ofacListRefresh(ctx.events, { owner: str(i, "owner"), date: D(str(i, "date")), succeeded: i.succeeded !== false, list_versions: obj<Record<string, string>>(i, "list_versions") ?? {}, open_applications: typeof i.open_applications === "number" ? i.open_applications : 0, parties_rescreened: typeof i.parties_rescreened === "number" ? i.parties_rescreened : 0, error: str(i, "error") || null, at: at(i, "at", ctx) }); return { type: e.type, date: str(i, "date"), timer: timersFor(ctx, ["SM_OFAC_LIST_REFRESH_DAILY"]) }; }
      if (op === "counterparty") { need(i, "party_id", "party_kind"); const r = screenCounterparty(ctx.events, { party_id: str(i, "party_id"), party_kind: str(i, "party_kind"), list_versions: (obj<Record<ExclusionList, string>>(i, "list_versions") ?? ({} as Record<ExclusionList, string>)), hits: (Array.isArray(i.hits) ? (i.hits as { list: ExclusionList; entry: string }[]) : []), application_id: str(i, "application_id") || null, at: at(i, "at", ctx) }, ctx.actor); rt.store.put("counterparty_screenings", r.screening.screening_id, { ...r.screening } as unknown as Record<string, unknown>, ctx.actor, ctx.now); return { ...r.screening, red_flag: r.red_flag }; }
      need(i, "party_id"); const application_id = str(i, "application_id") || ctx.applicationId || ""; if (!application_id) throw new RangeError("application_id is required");
      const party = obj<PartyIdentity>(i, "party") ?? { party_id: str(i, "party_id"), party_role: (str(i, "party_role") || "borrower") as PartyIdentity["party_role"], name: str(i, "name") || str(i, "party_id") };
      const lists = (Array.isArray(i.lists) ? (i.lists as ListVersion[]) : []); if (!lists.length) throw new RangeError("lists (SLS list versions) are required");
      const scripted = Array.isArray(i.candidates) ? (i.candidates as OfacCandidate[]) : null; const screener = svc<OfacScreenerPort>(rt, "ofac_screener");
      if (!scripted && !screener) throw new RangeError("candidates or the ofac_screener service is required");
      const candidates = scripted ?? (await screener!.screen(party, lists)).candidates;
      const r = recordPartyScreening(ctx.events, { application_id, party, lists, candidates, at: at(i, "at", ctx), other_party_results: obj<Record<string, "clear" | "potential_match" | "match_resolved_false" | "match_true">>(i, "other_party_results") ?? {} }, ctx.actor);
      rt.store.put("party_screenings", r.screening.screening_id, { ...r.screening } as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      const hits: OfacHit[] = [];
      if (r.screening.result === "potential_match") for (const cnd of candidates) { const h = recordOfacHit(ctx.events, { screening_id: r.screening.screening_id, party_id: party.party_id, application_id, list: (cnd.list === "ofac_sdn" ? "sdn" : "non_sdn_consolidated") as OfacList, entry_uid: String((cnd as unknown as Record<string, unknown>).entry_uid ?? cnd.sdn_name), match_score: Number(cnd.score ?? 90), match_fields: strs(cnd as unknown as ToolInput, "matched_fields"), at: at(i, "at", ctx) }, ctx.actor); putHit(rt, h.hit, ctx); hits.push(h.hit); }
      if (str(i, "case_id")) { const c = caseOf(rt, i); const st = recordStep(ctx.events, c, { tool: "screenParty", source: `OFAC SLS ${lists.map((l) => l.version).join("/")}`, result: r.screening.result, evidence_refs: [r.screening.screening_id], at: at(i, "at", ctx) }, ctx.actor); putCase(rt, st.fraud_case, ctx); }
      return { screening_id: r.screening.screening_id, result: r.screening.result, all_parties_clear: r.all_parties_clear, hits: hits.map((h) => ({ hit_id: h.hit_id, match_score: h.match_score, disposition: h.disposition })) };
    }) },
  // Rule 6: false_positive with a written analysis (bsa_officer above the auto-clear score) or confirmed_match (bsa_officer) → blocked property / rejected transaction, the 10-business-day ORS clock and the blocked-funds posting.
  { name: "analyzeOfacMatch", kind: "act", guardrails: [NO_HOLD_BYPASS], handler: compute((i, ctx, rt) => {
      const hit = hitOf(rt, i); need(i, "disposition", "analysis");
      const bp = obj<{ description: string; value_cents: unknown; location: string; account_ref: string }>(i, "blocked_property"); const rtx = obj<{ description: string; value_cents: unknown; counterparties: string[] }>(i, "rejected_transaction");
      const input: DispositionInput = { disposition: str(i, "disposition") as DispositionInput["disposition"], analysis: str(i, "analysis"), at: at(i, "at", ctx), blocked_property: bp ? { description: bp.description, value_cents: cents(bp.value_cents), location: bp.location, account_ref: bp.account_ref } : null, rejected_transaction: rtx ? { description: rtx.description, value_cents: cents(rtx.value_cents), counterparties: rtx.counterparties ?? [] } : null };
      const r = dispositionOfacHit(ctx.events, hit, input, ctx.actor); putHit(rt, r.hit, ctx);
      if (r.ledger) ctx.ledger.post(r.ledger, ctx.now);
      if (r.report_kind) escalateTo(rt, ctx, "bsa_officer", { case_id: hit.hit_id, application_id: hit.application_id, loan_id: hit.loan_id }, { hit_id: hit.hit_id, report_kind: r.report_kind, report_due_on: r.report_due_on, channel: "ORS" }, "sev-1");
      return { hit_id: hit.hit_id, disposition: r.hit.disposition, report_kind: r.report_kind, report_due_on: r.report_due_on, retention_until: r.hit.retention_until, ledger_posted: !!r.ledger, timers: timersFor(ctx, ["OFAC_501_603_BLOCKED_REPORT_10BD", "OFAC_501_604_REJECTED_REPORT_10BD", "OFAC_501_603_ANNUAL_BLOCKED_0930"]) };
    }) },
  // Borrower interview through the app/voice: automation disclosed, consent for recording, verification questions only; a request for a person → human_agent.
  { name: "interviewBorrower", kind: "act", guardrails: [INTERVIEW_DISCLOSED, NO_SAR_DISCLOSURE], handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i); const questions = strs(i, "questions"); if (!questions.length) throw new RangeError("questions are required");
      if (i.automation_disclosed !== true) throw new RangeError("automation_disclosed must be true");
      let escalation_id: string | null = null;
      if (flag(i, "borrower_requests_human")) escalation_id = escalateTo(rt, ctx, "human_agent", c, { case_id: c.case_id, reason: "borrower asked to speak to a person during a verification interview" }).id;
      const r = recordStep(ctx.events, c, { tool: "interviewBorrower", source: `borrower via ${str(i, "channel") || "app"} (automation disclosed)`, result: str(i, "result") || "interview recorded", evidence_refs: strs(i, "evidence_refs").length ? strs(i, "evidence_refs") : [`interview:${c.case_id}:${ctx.now}`], at: at(i, "at", ctx) }, ctx.actor); putCase(rt, r.fraud_case, ctx);
      return { case_id: c.case_id, disclosure: INTERVIEW_DISCLOSURE, questions: questions.length, escalation_id };
    }) },
  { name: "buildTimeline", kind: "read", handler: compute((i, ctx, rt) => { const c = caseOf(rt, i); return { case_id: c.case_id, timeline: buildTimeline(c, (Array.isArray(i.extra) ? (i.extra as { at: string; what: string; evidence_refs?: string[] }[]) : [])) }; }) },
  { name: "assessScheme", kind: "read", guardrails: [NO_DEMOGRAPHIC_INPUTS], handler: compute((i, ctx, rt) => { const signals = Array.isArray(i.signals) ? (i.signals as Signal[]) : str(i, "case_id") ? caseOf(rt, i).signals : []; if (!signals.length) throw new RangeError("signals or case_id are required"); const steps = str(i, "case_id") ? caseOf(rt, i).steps : (Array.isArray(i.steps) ? (i.steps as InvestigationStep[]) : []); return assessScheme(signals, steps); }) },
  { name: "computeAmount", kind: "read", handler: compute((i) => { need(i, "kind"); const r = computeAmount({ kind: str(i, "kind") as "origination" | "aml", loan_amount_cents: i.loan_amount_cents === undefined ? null : cents(i.loan_amount_cents), transaction_amount_cents: i.transaction_amount_cents === undefined ? null : cents(i.transaction_amount_cents), subject_identified: flag(i, "subject_identified"), activity_is_crime: flag(i, "activity_is_crime") }); return { ...r, amount_cents: String(r.amount_cents) }; }) },
  // Rule 2: recommend (default — the agent's recommendation to the bsa_officer), record (the officer's triage: suspicious_determined sets the immutable anchor; not_suspicious releases the hold), close (needs a sar_decisions row).
  { name: "recommendTriage", kind: "act", guardrails: [TRIAGE_RECORD_IS_OFFICER, NO_DEMOGRAPHIC_INPUTS], handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i); const op = str(i, "op") || "recommend"; need(i, "rationale");
      if (op === "close") { const decision = str(i, "decision_id") ? (rt.store.get("sar_decisions", str(i, "decision_id"))?.data as unknown as SarDecision | undefined) ?? null : null; const r = closeCase(ctx.events, c, { sar_decision: decision, at: at(i, "at", ctx), outcome: str(i, "outcome") || str(i, "rationale") }, ctx.actor); putCase(rt, r.fraud_case, ctx); if (c.application_id) putApp(rt, c.application_id, { fraud_hold: false, fraud_hold_reason: null, fraud_hold_case_id: null, fraud_hold_record: null }, ctx); return { case_id: c.case_id, triage_status: r.fraud_case.triage_status, closed_at: r.fraud_case.closed_at }; }
      if (op === "record") {
        need(i, "decision");
        const input: TriageInput = { decision: str(i, "decision") as TriageInput["decision"], rationale: str(i, "rationale"), at: at(i, "at", ctx), ...(i.subject_identified !== undefined ? { subject_identified: flag(i, "subject_identified") } : {}), requires_immediate_attention: flag(i, "requires_immediate_attention"), officer_review: obj<{ escalation_id: string; officer_id: string; at: string }>(i, "officer_review"), facts_first_assembled_on: optDate(i, "facts_first_assembled_on"), fnma_reasonable_basis: flag(i, "fnma_reasonable_basis") };
        const r = recordTriage(ctx.events, c, input, ctx.actor); let fc = r.fraud_case;
        if (fc.triage_status === "not_suspicious" && fc.production_hold) { const rel = releaseProductionHold(ctx.events, fc, { rationale: str(i, "rationale"), at: at(i, "at", ctx), path: "not_suspicious" }, ctx.actor); fc = rel.fraud_case; if (c.application_id) putApp(rt, c.application_id, { fraud_hold: false, fraud_hold_reason: null, fraud_hold_case_id: null, fraud_hold_record: null }, ctx); }
        putCase(rt, fc, ctx);
        return { case_id: c.case_id, triage_status: fc.triage_status, initial_detection_at: fc.initial_detection_at, subject_identified: fc.subject_identified, within_sla: r.within_sla, sar: r.sar, production_hold: fc.production_hold, timers: timersFor(ctx, ["SM_FRAUD_TRIAGE_SLA_10", "BSA_1029_320_SAR_30", "BSA_1029_320_SAR_60_NO_SUBJECT", "BSA_1029_320_IMMEDIATE_LE_NOTICE", "SM_FRAUD_PRODUCTION_HOLD"]) };
      }
      need(i, "recommendation"); const rec = str(i, "recommendation"); if (rec !== "suspicious_determined" && rec !== "not_suspicious") throw new RangeError("recommendation is suspicious_determined or not_suspicious");
      const esc = escalateTo(rt, ctx, "bsa_officer", c, { case_id: c.case_id, recommendation: rec, rationale: str(i, "rationale"), triage_due_on: c.triage_due_on, confidence: typeof i.confidence === "number" ? i.confidence : null }, "sev-2");
      ctx.events.append({ type: "fraud.case.triage.recommended", ...(c.application_id ? { applicationId: c.application_id } : {}), ...(c.loan_id ? { loanId: c.loan_id } : {}), actor: ctx.actor, payload: { case_id: c.case_id, application_id: c.application_id, recommendation: rec, escalation_id: esc.id, source: "origination" } });
      return { case_id: c.case_id, recommendation: rec, escalation_id: esc.id, triage_due_on: c.triage_due_on };
    }) },
  // The SAR inside the compartment: draft (default; agent), decide (bsa_officer: file / no_file), file (bsa_officer only — the agent's attempt is refused), acknowledge, reject, query (access outside sar_confidentiality_acl is denied and logged).
  { name: "draftSarPackage", kind: "act", guardrails: [NO_FILING_BY_AGENT, NO_SAR_DISCLOSURE], humanRoles: ["bsa_officer", "officer", "ops_analyst"], handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "draft"; const when = at(i, "at", ctx);
      if (op === "query") { const rows = querySars(ctx.events, ctx.actor, { filing_orgs: (strs(i, "filing_orgs").length ? strs(i, "filing_orgs") : ["partner", "sm"]) as ("partner" | "sm")[], actor_org: (str(i, "actor_org") || "other") as "partner" | "sm" | "other", joint_filing: flag(i, "joint_filing"), same_corporate_structure: flag(i, "same_corporate_structure") }, rt.store.list("sars").map((r) => r.data as unknown as Sar), when); return { sars: rows.map((s) => ({ sar_id: s.sar_id, status: s.status, due_on: s.due_on, bsa_id: s.bsa_id })) }; }
      if (op === "draft") {
        const c = caseOf(rt, i); need(i, "filing_org_ein_ref", "narrative_document_id", "narrative_hash");
        const prior = str(i, "continuing_activity_of") ? (rt.store.require("sars", str(i, "continuing_activity_of")).data as unknown as Sar) : null;
        const r = draftSar(ctx.events, c, { filer: (str(i, "filer") || "partner") as SarFiler, filing_org_ein_ref: str(i, "filing_org_ein_ref"), subjects: (Array.isArray(i.subjects) ? (i.subjects as Record<string, unknown>[]) : []), activity: obj<Record<string, unknown>>(i, "activity") ?? {}, narrative_document_id: str(i, "narrative_document_id"), narrative_hash: str(i, "narrative_hash"), supporting_documents: strs(i, "supporting_documents"), filing_channel: (str(i, "filing_channel") || "discrete") as FilingChannel, continuing_activity_of: prior, at: when }, ctx.actor);
        putSar(rt, r.sar, ctx); const esc = escalateTo(rt, ctx, "bsa_officer", c, r.escalation.payload, "sev-2");
        return { sar_id: r.sar.sar_id, status: r.sar.status, due_on: r.sar.due_on, outer_limit_on: r.sar.outer_limit_on, officer_decision_due_on: r.sar.officer_decision_due_on, continuing_activity_of: r.sar.continuing_activity_of, escalation_id: esc.id, timers: timersFor(ctx, ["SM_BSA_OFFICER_SAR_DECISION_SLA_5", "BSA_1029_320_SAR_30", "BSA_1029_320_SAR_60_NO_SUBJECT", "BSA_1029_320_SAR_CONTINUING_120"]) };
      }
      const sar = sarOf(rt, i); const c = rt.store.require("fraud_cases", sar.case_id).data as unknown as FraudCase;
      if (op === "decide") { need(i, "decision", "rationale"); const r = officerSarDecision(ctx.events, c, sar, { decision: str(i, "decision") as "file" | "no_file", rationale: str(i, "rationale"), narrative_edited: flag(i, "narrative_edited"), at: when }, ctx.actor); putSar(rt, r.sar, ctx); putDecision(rt, r.decision, ctx); return { sar_id: sar.sar_id, status: r.sar.status, decision_id: r.decision.decision_id, decision: r.decision.decision, timers: timersFor(ctx, ["SM_BSA_OFFICER_SAR_DECISION_SLA_5", "BSA_1029_320_SAR_CONTINUING_120"]) }; }
      if (op === "file") { const r = fileSar(ctx.events, c, sar, { at: when, filing_channel: (str(i, "filing_channel") || sar.filing_channel) as FilingChannel, amended_from_bsa_id: str(i, "amended_from_bsa_id") || null }, ctx.actor); putSar(rt, r.sar, ctx); return { sar_id: sar.sar_id, status: r.sar.status, filed_on: r.sar.filed_on, late: r.late, late_filing_memo_required: r.late_filing_memo_required, retention_until: r.sar.retention_until, timers: timersFor(ctx, ["BSA_1029_320_SAR_30", "BSA_1029_320_SAR_60_NO_SUBJECT", "BSA_1029_320_SAR_CONTINUING_120", "BSA_1029_320C_SAR_RETENTION_5Y"]) }; }
      if (op === "acknowledge") { need(i, "bsa_id"); const r = acknowledgeSar(ctx.events, c, sar, { bsa_id: str(i, "bsa_id"), activity_continues: flag(i, "activity_continues"), at: when }, ctx.actor); putSar(rt, r.sar, ctx); return { sar_id: sar.sar_id, status: r.sar.status, bsa_id: r.sar.bsa_id, timers: timersFor(ctx, ["BSA_1029_320_SAR_CONTINUING_120"]) }; }
      if (op === "reject") { const r = rejectSar(ctx.events, c, sar, { validation_errors: strs(i, "validation_errors"), at: when }, ctx.actor); putSar(rt, r.sar, ctx); return { sar_id: sar.sar_id, status: r.sar.status, refile_by: r.refile_by, original_due_on: sar.due_on }; }
      throw new RangeError(`op ${op} is not one of draft/decide/file/acknowledge/reject/query`);
    }) },
  // Part V narrative from the case facts (who/what/when/where/why/how); only the document id and hash leave the compartment.
  { name: "draftNarrative", kind: "act", guardrails: [NO_SAR_DISCLOSURE], handler: compute((i, ctx, rt) => {
      const c = caseOf(rt, i); const elements = obj<Record<string, string>>(i, "elements") ?? {}; need(i, "narrative_document_id");
      const r = draftNarrative(c, elements);
      if (r.missing_elements.length) throw new ScreeningRefused("NARRATIVE_INCOMPLETE", "31 CFR 1029.320(b)(2); 28.4 AI design: who/what/when/where/why/how", `missing ${r.missing_elements.join(", ")}`);
      ctx.events.append({ type: "sar.narrative.drafted", ...(c.application_id ? { applicationId: c.application_id } : {}), ...(c.loan_id ? { loanId: c.loan_id } : {}), actor: ctx.actor, payload: { case_id: c.case_id, application_id: c.application_id, narrative_document_id: str(i, "narrative_document_id"), narrative_hash: r.narrative_hash, elements: Object.keys(r.elements), acl: "sar_confidentiality_acl", source: "origination" } });
      return { case_id: c.case_id, narrative_document_id: str(i, "narrative_document_id"), narrative_hash: r.narrative_hash, elements: Object.keys(r.elements) };
    }) },
  // OFAC reports: draft (default; the agent's package for the bsa_officer), submit (bsa_officer via ORS — sets retention_until on an unblocking report), unblock (bsa_officer records the licence / delisting).
  { name: "draftOfacReport", kind: "act", guardrails: [NO_FILING_BY_AGENT], humanRoles: ["bsa_officer", "officer", "ops_analyst"], handler: compute((i, ctx, rt) => {
      const hit = hitOf(rt, i); const op = str(i, "op") || "draft"; const when = at(i, "at", ctx); need(i, "kind");
      const kind = str(i, "kind") as OfacReportKind;
      if (op === "unblock") { need(i, "unblocked_on", "authority"); const r = unblockProperty(ctx.events, hit, { unblocked_on: D(str(i, "unblocked_on")), authority: str(i, "authority"), at: when }, ctx.actor); putHit(rt, r.hit, ctx); return { hit_id: hit.hit_id, unblocked_on: r.hit.unblocked_on, report_due_on: r.report_due_on, timers: timersFor(ctx, ["OFAC_501_603_UNBLOCKING_REPORT_10BD"]) }; }
      if (op === "submit") { need(i, "ors_reference", "content_document_id"); const r = submitOfacReport(ctx.events, hit, { kind, ors_reference: str(i, "ors_reference"), content_document_id: str(i, "content_document_id"), at: when, due_on: optDate(i, "due_on") }, ctx.actor); putHit(rt, r.hit, ctx); rt.store.put("ofac_reports", r.report.report_id, { ...r.report } as unknown as Record<string, unknown>, ctx.actor, ctx.now); return { report_id: r.report.report_id, kind, submitted_on: r.report.submitted_on, due_on: r.report.due_on, late: r.report.late, retention_until: r.hit.retention_until, timers: timersFor(ctx, ["OFAC_501_603_BLOCKED_REPORT_10BD", "OFAC_501_603_UNBLOCKING_REPORT_10BD", "OFAC_501_604_REJECTED_REPORT_10BD", "OFAC_501_603_ANNUAL_BLOCKED_0930"]) }; }
      need(i, "content_document_id");
      const due_on = kind === "blocked_initial" && hit.blocked_property ? hit.blocked_property.blocked_on : kind === "rejected_transaction" && hit.rejected_transaction ? hit.rejected_transaction.rejected_on : kind === "unblocking" ? hit.unblocked_on : null;
      ctx.events.append({ type: "ofac.report.drafted", ...(hit.application_id ? { applicationId: hit.application_id } : {}), ...(hit.loan_id ? { loanId: hit.loan_id } : {}), actor: ctx.actor, payload: { hit_id: hit.hit_id, kind, content_document_id: str(i, "content_document_id"), event_on: due_on, channel: "ORS (bsa_officer submits)", source: "origination" } });
      const esc = escalateTo(rt, ctx, "bsa_officer", { case_id: hit.hit_id, application_id: hit.application_id, loan_id: hit.loan_id }, { hit_id: hit.hit_id, kind, content_document_id: str(i, "content_document_id") }, "sev-1");
      return { hit_id: hit.hit_id, kind, drafted: true, escalation_id: esc.id };
    }) },
  // Fannie Mae A3-4-03: draft (default; channel by Q4 → partner officer), approve (officer), submit (fnma_portal_operator; LQC reference stored; after due_on a breach).
  { name: "draftFnmaReport", kind: "act", guardrails: [NO_FILING_BY_AGENT, NO_SAR_DISCLOSURE], humanRoles: ["officer", "fnma_portal_operator", "ops_analyst"], handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "draft"; const when = at(i, "at", ctx);
      if (op === "draft") {
        const c = caseOf(rt, i); need(i, "synopsis_document_id", "reasonable_basis_on");
        const r = openFnmaFraudReport(ctx.events, c, { reasonable_basis_on: D(str(i, "reasonable_basis_on")), delivered_or_committed: flag(i, "delivered_or_committed"), third_party_scheme: flag(i, "third_party_scheme"), partner_elects: flag(i, "partner_elects"), fnma_loan_number: str(i, "fnma_loan_number") || null, synopsis_document_id: str(i, "synopsis_document_id"), documents: strs(i, "documents"), at: when }, ctx.actor);
        putCase(rt, r.fraud_case, ctx); if (r.report) putReport(rt, r.report, ctx); const esc = r.escalation ? escalateTo(rt, ctx, "officer", c, r.escalation.payload, "sev-2") : null;
        return { report_id: r.report?.report_id ?? null, channel: r.report?.channel ?? null, due_on: r.report?.due_on ?? null, submit_by_policy: r.report?.submit_by_policy ?? null, escalation_id: esc?.id ?? null, timers: timersFor(ctx, ["FNMA_A3_4_03_FRAUD_SELF_REPORT_30"]) };
      }
      const r0 = reportOf(rt, i); const c = rt.store.require("fraud_cases", r0.case_id).data as unknown as FraudCase;
      if (op === "approve") { const r = approveFnmaReport(ctx.events, c, r0, { at: when }, ctx.actor); putReport(rt, r.report, ctx); const esc = escalateTo(rt, ctx, "human_portal_task", c, { report_id: r0.report_id, channel: r0.channel, due_on: r0.due_on, submit_by_policy: r0.submit_by_policy }); return { report_id: r0.report_id, status: r.report.status, operator_task_id: esc.id }; }
      if (op === "submit") { need(i, "reference"); const r = submitFnmaReport(ctx.events, c, r0, { reference: str(i, "reference"), at: when }, ctx.actor); putReport(rt, r.report, ctx); return { report_id: r0.report_id, status: r.report.status, reference: r.report.reference, submitted_on: r.report.submitted_on, due_on: r0.due_on, late: r.late, timers: timersFor(ctx, ["FNMA_A3_4_03_FRAUD_SELF_REPORT_30"]) }; }
      throw new RangeError(`op ${op} is not one of draft/approve/submit`);
    }) },
  // FCRA §609(e): receive (default — verified with identity proof + police report / FTC affidavit), fulfil (records provided without charge, or a documented (e)(5) decline).
  { name: "draftVictimRecordsPackage", kind: "act", guardrails: [never("VICTIM_RECORDS_WITHOUT_CHARGE", "15 U.S.C. 1681g(e)(1): \"without charge\"", (i) => cents(i.charge_cents) !== 0n, "application and transaction records are provided to the victim without charge")], handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "receive"; const when = at(i, "at", ctx);
      if (op === "fulfil" || op === "fulfill") { const r0 = requestOf(rt, i); need(i, "outcome"); const r = fulfilIdentityTheftRequest(ctx.events, r0, { outcome: str(i, "outcome") as "records_provided" | "declined_e5", document_ids: strs(i, "document_ids"), declined_reason: (str(i, "declined_reason") || null) as DeclineGround | null, charge_cents: 0n, at: when }, ctx.actor); putRequest(rt, r.request, ctx); return { request_id: r0.request_id, status: r.request.status, on_time: r.on_time, due_on: r0.due_on, timers: timersFor(ctx, ["FCRA_609E_VICTIM_RECORDS_30"]) }; }
      need(i, "requester", "received_on", "claim_proof");
      const r = receiveIdentityTheftRequest(ctx.events, { requester: str(i, "requester") as "victim" | "law_enforcement", application_id: str(i, "application_id") || ctx.applicationId || null, loan_id: str(i, "loan_id") || null, received_on: D(str(i, "received_on")), identity_proof: str(i, "identity_proof") || null, claim_proof: str(i, "claim_proof") as ClaimProof, at: when }, ctx.actor);
      putRequest(rt, r.request, ctx);
      return { request_id: r.request.request_id, verified: r.request.verified, due_on: r.request.due_on, timers: timersFor(ctx, ["FCRA_609E_VICTIM_RECORDS_30"]) };
    }) },
  // Continuing activity (policy): the 90-day review from filed_on; the continuing SAR is due +120 (BSA_1029_320_SAR_CONTINUING_120 arms on the acknowledgement).
  { name: "scheduleContinuingReview", kind: "act", handler: compute((i, ctx, rt) => {
      const sar = sarOf(rt, i); const c = rt.store.require("fraud_cases", sar.case_id).data as unknown as FraudCase;
      const r = scheduleContinuingReview(ctx.events, c, sar, { at: at(i, "at", ctx), ...(str(i, "rationale") ? { rationale: str(i, "rationale") } : {}) }, ctx.actor); putDecision(rt, r.decision, ctx);
      return { sar_id: sar.sar_id, decision_id: r.decision.decision_id, review_due_on: r.review_due_on, continuing_due_on: r.continuing_due_on, timers: timersFor(ctx, ["BSA_1029_320_SAR_CONTINUING_120"]) };
    }) },
  // Escalations: bsa_officer (triage confirmation; SAR decision; OFAC dispositions; subpoenas), partner officer (Fannie Mae reports; program approvals), fnma_portal_operator, underwriting_reviewer (denials via 21.6), human_agent; op=subpoena → "decline to produce" + FinCEN notification task; op=notify_le → the immediate-attention protocol.
  { name: "openOfficerEscalation", kind: "act", guardrails: [LE_NEEDS_OFFICER, NO_SAR_DISCLOSURE], handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "escalate"; const when = at(i, "at", ctx);
      if (op === "subpoena") { need(i, "subpoena_id", "issuer"); const r = subpoenaForSarMaterial(ctx.events, { subpoena_id: str(i, "subpoena_id"), issuer: str(i, "issuer"), received_at: when }, ctx.actor); const esc = escalateTo(rt, ctx, "bsa_officer", null, { ...r.tasks[0]!.payload, task: "notify_fincen", response: r.response }, "sev-1"); return { response: r.response, fincen_notification_task_id: esc.id, owner_role: "bsa_officer", with_counsel: true }; }
      if (op === "notify_le") { const c = caseOf(rt, i); need(i, "agency"); const r = notifyLawEnforcement(ctx.events, c, { agency: str(i, "agency"), method: "telephone", at: when, officer_paged: flag(i, "officer_paged") }, ctx.actor); putCase(rt, r.fraud_case, ctx); if (flag(i, "officer_paged")) escalateTo(rt, ctx, "bsa_officer", c, { case_id: c.case_id, reason: "immediate-attention protocol: law enforcement notified; officer paged simultaneously" }, "sev-1"); return { case_id: c.case_id, notified_at: r.fraud_case.law_enforcement_notified_at, timers: timersFor(ctx, ["BSA_1029_320_IMMEDIATE_LE_NOTICE"]) }; }
      need(i, "kind"); const kind = str(i, "kind"); if (!["bsa_officer", "officer", "fnma_portal_operator", "underwriting_reviewer", "human_agent", "qc_officer"].includes(kind)) throw new RangeError(`kind ${kind} is not a 28.4 escalation role`);
      const c = str(i, "case_id") ? caseOf(rt, i) : null;
      const esc = escalateTo(rt, ctx, (kind === "fnma_portal_operator" ? "human_portal_task" : kind) as EscalationKind, c, { ...(obj<Record<string, unknown>>(i, "payload") ?? {}), case_id: c?.case_id ?? null, reason: str(i, "reason") || null }, str(i, "severity") || undefined);
      return { escalation_id: esc.id, kind, owner_role: esc.ownerRole };
    }) },
  // The decision record: investigation steps with evidence refs, rule_set_versions (bsa.1029; ofac.501; fnma.selling.2026-09-02; fcra.681), model/prompt versions, inputs_hash, the officer review, no applicant_demographics reads.
  { name: "writeDecision", kind: "write", guardrails: [NO_DEMOGRAPHIC_INPUTS], handler: compute((i, ctx) => {
      need(i, "case_id", "rationale", "model_version", "prompt_version");
      const rec = fraudRiskDecisionRecord({ case_id: str(i, "case_id"), signals: (Array.isArray(i.signals) ? (i.signals as Signal[]) : []), investigation_steps: (Array.isArray(i.investigation_steps) ? (i.investigation_steps as InvestigationStep[]) : []), scheme_assessment: obj<ReturnType<typeof assessScheme>>(i, "scheme_assessment") ?? assessScheme((Array.isArray(i.signals) ? (i.signals as Signal[]) : [])), amount_cents: cents(i.amount_cents), triage_recommendation: (str(i, "triage_recommendation") || "not_suspicious") as "suspicious_determined" | "not_suspicious", rationale: str(i, "rationale"), confidence: typeof i.confidence === "number" ? i.confidence : NaN, officer_review: obj<{ escalation_id: string; decision: string; at: string }>(i, "officer_review"), sar: obj<{ drafted_at: string; narrative_hash: string }>(i, "sar"), timers: strs(i, "timers"), model_version: str(i, "model_version"), prompt_version: str(i, "prompt_version"), inputs: obj<Record<string, unknown>>(i, "inputs") ?? {}, reads: strs(i, "reads"), ...(str(i, "inputs_hash") ? { inputs_hash: str(i, "inputs_hash") } : {}) });
      ctx.decide({ agent: "fraud-risk", action: `triage:${rec.triage_recommendation}`, rationale: rec.rationale, ruleSetVersion: Object.values(rec.rule_set_versions).join(";"), ...(ctx.applicationId ? { applicationId: ctx.applicationId } : {}), loanId: ctx.loanId, subject: { kind: "fraud_case", id: rec.case_id }, evidenceDocumentIds: rec.investigation_steps.flatMap((s) => s.evidence_refs), confidence: rec.confidence, modelVersion: rec.model_version, promptVersion: rec.prompt_version });
      return { recorded: true, case_id: rec.case_id, inputs_hash: rec.inputs_hash, rule_set_versions: rec.rule_set_versions, steps: rec.investigation_steps.length };
    }), decision: () => null },
]));
export const ofacGate = ofacClearBeforeFundingGate;
export type { Actor };
