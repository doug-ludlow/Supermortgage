/**
 * §22.6 process-owned tools — bus tools for 22.6 defined with `defineTools("22.6", "fraud-risk", defs)` from
 * ../tools.ts. Every tool string is one spec/registry/agents.json names for 22.6; src/app/tools.test.ts refuses the
 * rest. Spread by ./index.ts. The handlers are thin: the rules live in src/domain/verification/ops-22-6.ts; the store
 * keeps `verifications` (kind identity/ssn/ofac/fraud), `party_screenings`, `legal_presence_records`,
 * `occupancy_assessments`, `reo_discovery_checks`, `non_arms_length_assessments`, `red_flag_events`,
 * `fraud_investigations`, `sar_candidates` (migration 0083) and the `applications` fraud_hold overlay; the vendors are
 * services (`identity_vendor`, `cbsv`, `ofac_screener`, `fraud_tool`, `mers` — ports with fakes in ops-22-6.ts).
 * Guardrails encode the AI-design sentences: never files a SAR, OFAC report or Fannie Mae self-report (humans do —
 * 28.4); never discloses SAR existence or content outside the access list; never uses race/ethnicity/national
 * origin/religion/language preference or `applicant_demographics` fields as inputs (immigration status only under
 * §1002.6(b)(7)); never suggests an occupancy, relationship or data change to make a loan eligible; never contacts
 * third parties outside documented verification channels; never bypasses a `fraud_hold`; never uses biometric data
 * beyond the verification purpose or retains it past the vendor-contract period without consent.
 */
import { defineTools, compute, decision, never, needsRole, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import {
  FORBIDDEN_MODEL_INPUTS, FraudHoldBlocked, SAR_ACCESS_ROLES, ScreeningRefused, assertNoFraudHold, assertNoSarTerms, assessLegalPresence, assessNonArmsLength, assessOccupancy, closeInvestigationLoop, concludeInvestigation, decisionRecord, detectSsnDiscrepancy, discoverReo, dispositionFraudAlert, gatherEvidence,
  intakeUpstreamSignal, itppAnnualReport, logRedFlag, openInvestigation, placeHold, prepareOfacReport, prepareSarPackage, prepareSelfReportPackage, recordCbsvResult, recordFraudAlertContact, recordFraudReport, recordIdentityResult, recordPartyScreening, reconcileOccupancyReo, releaseHold, rescreenRequired, resolveAddressDiscrepancy, resolveOfacMatch, resolveReoDiscrepancy, resolveSsnDocumentarily, respondRedFlag, scrubSarTerms,
  type AlertDisposition, type AlertKind, type CbsvPort, type CbsvResponse, type Conclusion, type ContactAttempt, type ContactMethod, type FraudHold, type FraudReport, type FraudToolPort, type IdentityMethod, type IdentitySessionResult, type IdentityVendorPort, type IdentityVerification, type Investigation, type LegalPresenceInput, type ListVersion, type LoanDisposition, type MersPort,
  type OccupancySignals, type OfacCandidate, type OfacReportKind, type OfacScreenerPort, type PartyIdentity, type PartyScreening, type RedFlagResponse, type RedFlagRow, type RelationshipKind, type ReoCheck, type ReoFinding, type SarCategory, type SsnIndicator, type SsnRecord, type SsnValidationMethod,
} from "../../domain/verification/ops-22-6.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required"); return id; };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const strs = (i: ToolInput, k: string): string[] => (Array.isArray(i[k]) ? (i[k] as unknown[]).map(String) : []);
const obj = <T,>(i: ToolInput, k: string): T | null => (i[k] && typeof i[k] === "object" ? (i[k] as T) : null);
const appRecord = (rt: ToolRuntime, app: string): Record<string, unknown> => rt.store.get("applications", app)?.data ?? {};
const putApp = (rt: ToolRuntime, app: string, patch: Record<string, unknown>, ctx: CommandContext): void => { rt.store.put("applications", app, { ...appRecord(rt, app), ...patch }, ctx.actor, ctx.now); };
const holdOf = (rt: ToolRuntime, app: string): FraudHold | null => (appRecord(rt, app).fraud_hold_record as FraudHold | undefined) ?? null;
const svc = <T,>(rt: ToolRuntime, name: string): T | null => (rt.services[name] as T | undefined) ?? null;
const investigationOf = (rt: ToolRuntime, i: ToolInput): Investigation => { need(i, "investigation_id"); return rt.store.require("fraud_investigations", str(i, "investigation_id")).data as unknown as Investigation; };
const putInvestigation = (rt: ToolRuntime, inv: Investigation, ctx: CommandContext): void => { rt.store.put("fraud_investigations", inv.investigation_id, { ...inv, amount_cents: inv.amount_cents === null ? null : String(inv.amount_cents) } as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const readInvestigation = (rt: ToolRuntime, i: ToolInput): Investigation => { const d = investigationOf(rt, i) as unknown as Record<string, unknown>; return { ...(d as unknown as Investigation), amount_cents: d.amount_cents === null || d.amount_cents === undefined ? null : BigInt(String(d.amount_cents)) }; };
const demographicKeys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as Record<string, unknown>).filter((k) => FORBIDDEN_MODEL_INPUTS.some((p) => p.test(k))) : []);
const escalateTo = (rt: ToolRuntime, ctx: CommandContext, kind: "underwriting_reviewer" | "bsa_officer" | "officer" | "human_agent", app: string, payload: Record<string, unknown>, severity?: string) =>
  rt.escalations.open({ kind, applicationId: app, loanId: ctx.loanId, payload, ...(severity ? { severity } : {}) }, ctx.actor);
/** ops-22-6 refusals surface as CommandRefused with the same code and citation; a hold as FRAUD_HOLD. */
const refusing = (defs: readonly Omit<ToolDef, "process" | "agent">[]): Omit<ToolDef, "process" | "agent">[] => defs.map((d) => ({ ...d, handler: async (i, ctx, rt) => { try { return await d.handler(i, ctx, rt); } catch (e) { if (e instanceof ScreeningRefused) throw new CommandRefused(d.name, e.code, e.citation, e.message); if (e instanceof FraudHoldBlocked) throw new CommandRefused(d.name, e.code, "22.6 state machine: fraud_hold blocks submitDu / issueCD / consummate / funding.authorized", e.message); throw e; } } }));

const NO_DEMOGRAPHIC_INPUTS = never("NO_DEMOGRAPHIC_INPUTS", "22.6 guardrail; Reg B §1002.6(b); §1002.6(b)(7) permits immigration status only for rights and remedies", (i) => demographicKeys(i.signals).length > 0 || demographicKeys(i.application_data).length > 0 || demographicKeys(i.inputs).length > 0 || demographicKeys(i).length > 0 || flag(i, "use_applicant_demographics"), "never uses race/ethnicity/national origin/religion/language preference or applicant_demographics fields as inputs — refused and logged");
const NO_OCCUPANCY_COACHING = never("NO_OCCUPANCY_COACHING", "22.6 guardrail; B2-1.3-01 / A3-4-03 (an occupancy change to fit is misrepresentation)", (i) => flag(i, "suggest_occupancy_change") || flag(i, "recast_occupancy") || !!str(i, "recast_as"), "never suggests an occupancy, relationship or data change to make a loan eligible");
const NO_HOLD_BYPASS = never("NO_HOLD_BYPASS", "22.6 guardrail: never bypasses a fraud_hold", (i) => flag(i, "bypass_hold") || flag(i, "override_hold"), "a fraud_hold is released only through releaseHold on a concluded investigation (bsa_officer for OFAC)");
const NO_FILING = never("NO_SAR_FILING", "22.6 guardrail: never files a SAR, OFAC report or Fannie Mae self-report (humans do — 28.4)", (i) => flag(i, "file") || flag(i, "submit") || flag(i, "e_file"), "the agent prepares packages; the bsa_officer / officer / fnma_portal_operator file (28.4)");
const NO_SAR_DISCLOSURE = never("NO_SAR_DISCLOSURE", "31 CFR 1029.320(d); 22.6 R11", (i) => (!!str(i, "share_with_role") && !SAR_ACCESS_ROLES.includes(str(i, "share_with_role"))) || flag(i, "borrower_visible") || (typeof i.borrower_message === "string" && !scrubSarTerms(i.borrower_message).clean), "never discloses SAR existence or content to anyone outside the access list (bsa_officer, officer, qc_officer, fraud-risk)");
const NO_UNDOCUMENTED_THIRD_PARTY_CONTACT = never("NO_UNDOCUMENTED_THIRD_PARTY_CONTACT", "22.6 guardrail", (i) => str(i, "channel") === "third_party_direct" || ["employer", "seller", "donor", "third_party"].includes(str(i, "target")), "never contacts third parties (employers, sellers, donors) outside documented verification channels");
const BIOMETRIC_PURPOSE_LIMIT = never("BIOMETRIC_PURPOSE_LIMIT", "22.6 guardrail; jurisdiction_rules.biometric_consent_required", (i) => (!!str(i, "purpose") && str(i, "purpose") !== "identity_verification") || flag(i, "retain_biometrics_beyond_contract") || (flag(i, "biometric_consent_required") && !str(i, "consent_id")), "never uses biometric data beyond the verification purpose or retains it past the vendor-contract period without consent");

export const TOOLS_22_6: readonly ToolDef[] = defineTools("22.6", "fraud-risk", refusing([
  // R1: document + liveness + face match + data match through the identity vendor (or a scripted session result); identity.verified / .inconclusive (arms SM_IDENTITY_RETRY_2BD) / .failed.
  { name: "verifyIdentity", kind: "act", handler: compute(async (i, ctx, rt) => {
      need(i, "borrower_id"); const app = appOf(i, ctx); const method = (str(i, "method") || "remote_doc_biometric") as IdentityMethod;
      if (!["remote_doc_biometric", "supervised_remote", "in_person_notary"].includes(method)) throw new RangeError("method must be remote_doc_biometric / supervised_remote / in_person_notary");
      const scripted = obj<IdentitySessionResult>(i, "result"); const vendor = svc<IdentityVendorPort>(rt, "identity_vendor");
      if (!scripted && !vendor) throw new RangeError("result (session) or the identity_vendor service is required");
      const result = scripted ?? (await vendor!.verify({ borrower_id: str(i, "borrower_id"), method, consent_id: str(i, "consent_id") || null }));
      const a = appRecord(rt, app); const borrower_ids = strs(i, "borrower_ids").length ? strs(i, "borrower_ids") : strs(a as ToolInput, "borrower_ids");
      const verified = rt.store.list("verifications", (d) => d.application_id === app && d.kind === "identity" && d.outcome === "verified").map((r) => String(r.data.borrower_id));
      const scheduled_note_date = optDate(i, "scheduled_note_date") ?? (typeof a.scheduled_note_date === "string" ? D(a.scheduled_note_date) : null);
      const r = recordIdentityResult(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), method, result, at: at(i, "at", ctx), scheduled_note_date, borrower_ids, verified_borrower_ids: verified }, ctx.actor);
      rt.store.put("verifications", r.verification.verification_id, { ...r.verification }, ctx.actor, ctx.now);
      if (r.verification.outcome === "inconclusive" && method !== "remote_doc_biometric") escalateTo(rt, ctx, "human_agent", app, { borrower_id: str(i, "borrower_id"), reason: "second identity method inconclusive — assisted session", retry_due: r.verification.retry_due }, "sev-3");
      return { verification: r.verification satisfies IdentityVerification, outcome: r.verification.outcome, level: r.verification.identity_level, retry_due: r.verification.retry_due, all_borrowers_verified: r.all_borrowers_verified, gate: r.gate, events: r.events.map((e) => e.type) }; }),
    guardrails: [BIOMETRIC_PURPOSE_LIMIT, NO_DEMOGRAPHIC_INPUTS] },
  // R2: op=detect opens the discrepancy (arms FNMA_B2_2_01_SSN_VALIDATION_GATE); op=documentary is ladder step (1).
  { name: "resolveSsn", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "borrower_id"); const app = appOf(i, ctx); const key = `${app}:${str(i, "borrower_id")}`; const op = str(i, "op") || "detect";
      if (op === "detect") { need(i, "indicator"); const r = detectSsnDiscrepancy(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), indicator: str(i, "indicator") as SsnIndicator, detail: obj<Record<string, unknown>>(i, "detail") ?? {}, at: at(i, "at", ctx) }, ctx.actor); rt.store.put("ssn_records", key, { ...r.record, fee_cents: String(r.record.fee_cents) }, ctx.actor, ctx.now); return { record: r.record, event: r.event.type, next: "documentary" }; }
      if (op === "documentary") { const rec = { ...(rt.store.require("ssn_records", key).data as unknown as SsnRecord), fee_cents: 0n }; const r = resolveSsnDocumentarily(ctx.events, rec, { documents: (i.documents as { document_id: string; doc_class: string; name_matches: boolean }[] | undefined) ?? [], at: at(i, "at", ctx) }, ctx.actor); rt.store.put("ssn_records", key, { ...r.record, fee_cents: String(r.record.fee_cents) }, ctx.actor, ctx.now); return { record: r.record, event: r.event?.type ?? null, next: r.next }; }
      throw new RangeError(`op ${op} is not one of detect/documentary`); }) },
  // R2 ladder step (2): the SSA CBSV Web Service ($2.25 per request; signed SSA-89 in SM's possession first) — ssn.validated{cbsv_web_service, sfc_162_required} or ssn.validation.failed → 21.6 with underwriting_reviewer.
  { name: "orderCbsv", kind: "act", handler: compute(async (i, ctx, rt) => {
      need(i, "borrower_id", "ssa_89_document_id"); const app = appOf(i, ctx); const key = `${app}:${str(i, "borrower_id")}`;
      const stored = rt.store.require("ssn_records", key).data as unknown as Record<string, unknown>; const rec: SsnRecord = { ...(stored as unknown as SsnRecord), fee_cents: BigInt(String(stored.fee_cents ?? "0")) };
      const scripted = obj<CbsvResponse>(i, "response"); const port = svc<CbsvPort>(rt, "cbsv");
      if (!scripted && !port) throw new RangeError("response or the cbsv service is required");
      const response = scripted ?? (await port!.verify({ borrower_id: str(i, "borrower_id"), name: str(i, "name"), date_of_birth: D(str(i, "date_of_birth") || "1988-01-01"), ssn_hash: str(i, "ssn_hash"), ssa_89_document_id: str(i, "ssa_89_document_id") }));
      const r = recordCbsvResult(ctx.events, rec, { method: (str(i, "method") || "cbsv_web_service") as Exclude<SsnValidationMethod, "not_required">, ssa_89_document_id: str(i, "ssa_89_document_id"), response, discrepancy_persists: flag(i, "discrepancy_persists"), at: at(i, "at", ctx) }, ctx.actor);
      rt.store.put("ssn_records", key, { ...r.record, fee_cents: String(r.record.fee_cents) }, ctx.actor, ctx.now);
      if (r.escalation) escalateTo(rt, ctx, r.escalation.kind, app, { borrower_id: str(i, "borrower_id"), reason: r.escalation.reason, route: "21.6 decline" });
      return { record: r.record, eligible: r.eligible, sfc_162_required: r.record.sfc_162_required, fee_cents: r.record.fee_cents, event: r.event.type, escalated_to: r.escalation?.kind ?? null }; }),
    guardrails: [never("CBSV_NEEDS_SIGNED_SSA_89", "SSA CBSV user agreement (00b-orig N3): physical possession of the signed Form SSA-89 before requesting verifications", (i) => i.borrower_id !== undefined && !str(i, "ssa_89_document_id"), "a CBSV request needs the signed SSA-89 on file")] },
  // R3: the B2-2-02 determination with the Reg B §1002.6(b)(7) rationale; arms/opens FNMA_B2_2_02_LEGAL_PRESENCE_GATE; a condition opens when not established.
  { name: "assessLegalPresence", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "borrower_id", "status_declared", "scheduled_note_date"); const app = appOf(i, ctx);
      const policy = obj<{ pending_renewal_accepted: boolean }>(i, "policy") ?? { pending_renewal_accepted: (rt.store.get("partner_policy", "legal_presence")?.data.pending_renewal_accepted as boolean | undefined) ?? false };
      const input: LegalPresenceInput = { application_id: app, borrower_id: str(i, "borrower_id"), status_declared: str(i, "status_declared") as LegalPresenceInput["status_declared"], evidence_kind: (str(i, "evidence_kind") || "other") as LegalPresenceInput["evidence_kind"], evidence_document_id: str(i, "evidence_document_id") || null, evidence_expires_on: optDate(i, "evidence_expires_on"), scheduled_note_date: D(str(i, "scheduled_note_date")), renewal_receipt_present: flag(i, "renewal_receipt_present"), policy, at: at(i, "at", ctx) };
      const r = assessLegalPresence(ctx.events, input, ctx.actor);
      rt.store.put("legal_presence_records", r.record.record_id, { ...r.record }, ctx.actor, ctx.now);
      if (r.condition) rt.store.put("conditions", `${r.record.record_id}-lp`, { application_id: app, source: "22.6", borrower_id: input.borrower_id, kind: r.condition.kind, text: r.condition.text, status: "proposed", clear_by: "before_consummate" }, ctx.actor, ctx.now);
      if (r.record.assessment !== "legally_present") escalateTo(rt, ctx, "underwriting_reviewer", app, { borrower_id: input.borrower_id, assessment: r.record.assessment, regb_6b7_rationale: r.record.regb_6b7_rationale });
      return { record: r.record, gate: r.gate, condition: r.condition, events: r.events.map((e) => e.type) }; }),
    guardrails: [NO_DEMOGRAPHIC_INPUTS] },
  // R4: op=screen screens one party against the pinned SLS versions (party.screened / ofac.potential_match); op=rescreen_check applies the list-version and pre-consummation rule.
  { name: "screenParty", kind: "act", handler: compute(async (i, ctx, rt) => {
      const op = str(i, "op") || "screen"; const app = appOf(i, ctx);
      if (op === "rescreen_check") { need(i, "checkpoint", "checkpoint_on", "last_screen_on", "last_list_published_on", "latest_list_published_on"); return rescreenRequired({ last_screen_on: D(str(i, "last_screen_on")), last_list_published_on: D(str(i, "last_list_published_on")), latest_list_published_on: D(str(i, "latest_list_published_on")), checkpoint: str(i, "checkpoint") as "pre_consummation" | "funding" | "party_change", checkpoint_on: D(str(i, "checkpoint_on")) }); }
      need(i, "party_id", "party_role", "name");
      const party: PartyIdentity = { party_id: str(i, "party_id"), party_role: str(i, "party_role") as PartyIdentity["party_role"], name: str(i, "name"), date_of_birth: optDate(i, "date_of_birth"), nationality: str(i, "nationality") || null, id_numbers: strs(i, "id_numbers"), entity: flag(i, "entity") };
      const lists = (i.lists as ListVersion[] | undefined) ?? (rt.store.list("ofac_lists").map((r) => r.data as unknown as ListVersion)); if (!lists.length) throw new RangeError("lists[] (SLS list versions) are required");
      const scripted = i.candidates as OfacCandidate[] | undefined; const screener = svc<OfacScreenerPort>(rt, "ofac_screener");
      if (!scripted && !screener) throw new RangeError("candidates[] or the ofac_screener service is required");
      const candidates = scripted ?? (await screener!.screen(party, lists)).candidates;
      const others: Record<string, PartyScreening["result"]> = {}; for (const r of [...rt.store.list("party_screenings", (d) => d.application_id === app && d.party_id !== party.party_id)].sort((a, b) => String(a.data.screened_at).localeCompare(String(b.data.screened_at)))) others[String(r.data.party_id)] = r.data.result as PartyScreening["result"];
      const r = recordPartyScreening(ctx.events, { application_id: app, party, lists, candidates, at: at(i, "at", ctx), other_party_results: others }, ctx.actor);
      rt.store.put("party_screenings", r.screening.screening_id, { ...r.screening }, ctx.actor, ctx.now);
      return { screening: r.screening, result: r.screening.result, list_version: r.screening.list_versions.ofac_sdn, list_stale: r.screening.list_stale, all_parties_clear: r.all_parties_clear, events: r.events.map((e) => e.type) }; }) },
  // R4: false positive with ≥ 2 non-name identifiers recorded, or a true match → rejected / blocked, 28.4's trigger, fraud.hold.placed, bsa_officer escalation; the borrower hears only that the transaction cannot proceed.
  { name: "resolveOfacMatch", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "screening_id", "disposition"); const app = appOf(i, ctx);
      const s = rt.store.require("party_screenings", str(i, "screening_id")).data as unknown as PartyScreening;
      const bp = obj<{ description: string; value_cents: unknown; held_by: string }>(i, "blocked_property");
      const r = resolveOfacMatch(ctx.events, s, { disposition: str(i, "disposition") as "false_positive" | "true_match", identifiers_compared: (i.identifiers_compared as never[] | undefined) ?? [], ...(str(i, "action") ? { action: str(i, "action") as "rejected" | "blocked" } : {}), blocked_property: bp ? { description: bp.description, value_cents: cents(bp.value_cents), held_by: bp.held_by } : null, at: at(i, "at", ctx), memo_document_id: str(i, "memo_document_id") || null }, ctx.actor);
      rt.store.put("party_screenings", s.screening_id, { ...r.screening }, ctx.actor, ctx.now);
      if (r.hold) { putApp(rt, app, { fraud_hold: true, fraud_hold_reason: r.hold.reason, fraud_hold_record: r.hold }, ctx); escalateTo(rt, ctx, "bsa_officer", app, { screening_id: s.screening_id, party_id: s.party_id, report_kind: r.report_kind, report_due_on: r.report_due_on, retention_class: "ofac_records_10y" }, "sev-1"); }
      return { screening: r.screening, result: r.screening.result, report_kind: r.report_kind, report_due_on: r.report_due_on, hold: r.hold, borrower_statement: r.borrower_statement, events: r.events.map((e) => e.type) }; }),
    guardrails: [NO_HOLD_BYPASS, NO_SAR_DISCLOSURE] },
  // R5: §1681c-1(h) contact — fraud_alert.contact.completed (opens FCRA_605A_H_ALERT_CONTACT_GATE; pass its id to 22.2's detectFraudAlerts op=clear) or .attempted (3 attempts / 5 business days → 21.6 NOIA path).
  { name: "contactForFraudAlert", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "borrower_id", "alert_kind", "method", "outcome"); const app = appOf(i, ctx);
      const attempts = rt.store.list("fraud_alert_contacts", (d) => d.application_id === app && d.borrower_id === str(i, "borrower_id"));
      const contact: ContactAttempt = { method: str(i, "method") as ContactMethod, number_called: str(i, "number_called") || null, outcome: str(i, "outcome") as ContactAttempt["outcome"], automation_disclosed: i.automation_disclosed === undefined ? true : flag(i, "automation_disclosed"), identity_verified: flag(i, "identity_verified"), signed_statement_returned: flag(i, "signed_statement_returned") };
      const r = recordFraudAlertContact(ctx.events, { application_id: app, alert: { borrower_id: str(i, "borrower_id"), kind: str(i, "alert_kind") as AlertKind, contact_phone: str(i, "contact_phone") || null, designated_method: (str(i, "designated_method") || null) as ContactMethod | null, credit_header_phones: strs(i, "credit_header_phones") }, contact, at: at(i, "at", ctx), attempt_no: attempts.length + 1, first_attempt_on: attempts.length ? D(String(attempts[0]!.data.contacted_on)) : null }, ctx.actor);
      rt.store.put("fraud_alert_contacts", `${app}:${str(i, "borrower_id")}:${attempts.length + 1}`, { application_id: app, borrower_id: str(i, "borrower_id"), attempt_no: attempts.length + 1, contacted_on: (r.event.payload as { contacted_at: string }).contacted_at.slice(0, 10), satisfies: r.satisfies, method: contact.method, outcome: contact.outcome }, ctx.actor, ctx.now);
      if (r.route_to_21_6) escalateTo(rt, ctx, "underwriting_reviewer", app, { borrower_id: str(i, "borrower_id"), reason: "borrower unreachable for the §605A(h) contact — NOIA / incomplete path (21.6)", unreachable_deadline: r.unreachable_deadline });
      return { satisfies_gate: r.satisfies, reason: r.reason, contact_completed_event_id: r.satisfies ? r.event.id : null, event: r.event.type, attempt_no: attempts.length + 1, unreachable_deadline: r.unreachable_deadline, route_to_21_6: r.route_to_21_6 }; }),
    guardrails: [NO_UNDOCUMENTED_THIRD_PARTY_CONTACT, never("AI_DISCLOSURE_AND_TCPA", "22.6 R5: AI voice with automation disclosure and TCPA-compliant purpose", (i) => str(i, "method") === "ai_voice" && (i.automation_disclosed === false || flag(i, "tcpa_consent_missing")), "an AI-voice contact carries the automation disclosure and needs TCPA consent")] },
  // §1022.82: reasonable belief by a (c)(2) method; the confirmed address is queued for furnishing at boarding (30.4).
  { name: "resolveAddressDiscrepancy", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "borrower_id", "application_address"); const app = appOf(i, ctx);
      const r = resolveAddressDiscrepancy(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), application_address: str(i, "application_address"), sources: (i.sources as never[] | undefined) ?? [], at: at(i, "at", ctx) }, ctx.actor);
      rt.store.put("furnishing_queue", `${app}:${str(i, "borrower_id")}:address`, { application_id: app, borrower_id: str(i, "borrower_id"), ...r.furnishing, resolved_event_id: r.event.id }, ctx.actor, ctx.now);
      return { confirmed_address: r.confirmed_address, matched_sources: r.matched_sources, furnishing: r.furnishing, event: r.event.type }; }) },
  // Fraud tool: op=run orders the report (fraud_tool.report.received; fraud_tool.cleared when no high alert); op=disposition dispositions an alert with evidence.
  { name: "runFraudTool", kind: "act", handler: compute(async (i, ctx, rt) => {
      const op = str(i, "op") || "run"; const app = appOf(i, ctx);
      if (op === "disposition") { need(i, "report_id", "alert_id", "disposition", "rationale"); const rep = rt.store.require("fraud_reports", str(i, "report_id")).data as unknown as FraudReport; const r = dispositionFraudAlert(ctx.events, rep, { alert_id: str(i, "alert_id"), disposition: str(i, "disposition") as AlertDisposition, evidence_document_ids: strs(i, "evidence_document_ids"), rationale: str(i, "rationale"), at: at(i, "at", ctx) }, ctx.actor); rt.store.put("fraud_reports", rep.report_id, { ...r.report }, ctx.actor, ctx.now); return { report_id: rep.report_id, high_open: r.high_open, investigation_required: r.investigation_required, events: r.events.map((e) => e.type) }; }
      const scripted = obj<Omit<FraudReport, "run_at">>(i, "report"); const port = svc<FraudToolPort>(rt, "fraud_tool");
      if (!scripted && !port) throw new RangeError("report or the fraud_tool service is required");
      const parties = (i.parties as PartyIdentity[] | undefined) ?? []; const raw = scripted ?? (await port!.run({ application_id: app, parties, refresh: flag(i, "refresh") }));
      const report: FraudReport = { ...raw, run_at: at(i, "at", ctx) };
      const r = recordFraudReport(ctx.events, { application_id: app, report, scheduled_consummation_date: optDate(i, "scheduled_consummation_date") }, ctx.actor);
      rt.store.put("fraud_reports", report.report_id, { ...report, application_id: app }, ctx.actor, ctx.now);
      return { report_id: report.report_id, vendor: report.vendor, score: report.score, high_open: r.high_open, events: r.events.map((e) => e.type) }; }),
    guardrails: [NO_DEMOGRAPHIC_INPUTS] },
  // R7: the weighted signal score → consistent / needs_explanation / inconsistent (→ investigation opens; hold; 22.5 excludes the rent); reconciles SM_OCCUPANCY_REO_GATE with the REO status.
  { name: "scoreOccupancy", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "declared_occupancy", "signals"); const app = appOf(i, ctx);
      const r = assessOccupancy(ctx.events, { application_id: app, declared_occupancy: str(i, "declared_occupancy") as "primary" | "second_home" | "investment", signals: i.signals as OccupancySignals, at: at(i, "at", ctx), explanation_document_id: str(i, "explanation_document_id") || null }, ctx.actor);
      rt.store.put("occupancy_assessments", r.assessment.assessment_id, { ...r.assessment }, ctx.actor, ctx.now);
      let investigation: Investigation | null = null;
      if (r.next === "open_investigation" && i.open_investigation !== false) { const inv = openInvestigation(ctx.events, { application_id: app, triggers: [r.assessment.assessment_id], hypotheses: ["occupancy_misrepresentation"], at: at(i, "at", ctx) }, ctx.actor); investigation = inv.investigation; putInvestigation(rt, inv.investigation, ctx); if (inv.hold) putApp(rt, app, { fraud_hold: true, fraud_hold_reason: inv.hold.reason, fraud_hold_record: inv.hold }, ctx); }
      const reo = rt.store.list("reo_discovery_checks", (d) => d.application_id === app).map((x) => String(x.data.status)); const reo_status = reo.find((s) => s === "discrepancy_open") ?? reo[0] ?? "clear";
      const g = reconcileOccupancyReo(ctx.events, { application_id: app, occupancy_conclusion: r.assessment.conclusion, explanation_resolved: flag(i, "explanation_resolved"), reo_status: reo_status as ReoCheck["status"], at: at(i, "at", ctx) }, ctx.actor);
      return { assessment: r.assessment, score: r.assessment.risk_score, conclusion: r.assessment.conclusion, next: r.next, rent_excluded_until_b3_3_8: r.rent_excluded_until_b3_3_8, investigation_id: investigation?.investigation_id ?? null, gate: g.gate, blocks_ctc: !g.gate.open }; }),
    guardrails: [NO_DEMOGRAPHIC_INPUTS, NO_OCCUPANCY_COACHING] },
  // R8: op=discover compares the sources (tradelines, MERS MIN search, public records, assessor, servicing book, DU) to the REO schedule; op=resolve adds the property (22.5 PITIA, 23.2 count, 22.4 reserves, 23.1 resubmit) or documents it as not the borrower's.
  { name: "discoverReo", kind: "write", handler: compute(async (i, ctx, rt) => {
      const op = str(i, "op") || "discover"; const app = appOf(i, ctx);
      if (op === "resolve") { need(i, "check_id", "resolution"); const check = rt.store.require("reo_discovery_checks", str(i, "check_id")).data as unknown as ReoCheck; const p = obj<{ address: string; upb_cents: unknown; pitia: { pi_cents: unknown; taxes_cents: unknown; insurance_cents: unknown; hoa_cents?: unknown }; rental?: boolean }>(i, "property");
        const r = resolveReoDiscrepancy(ctx.events, check, { resolution: str(i, "resolution") as "added_to_reo" | "not_borrower", evidence_document_ids: strs(i, "evidence_document_ids"), property: p ? { address: p.address, upb_cents: cents(p.upb_cents), pitia: { pi_cents: cents(p.pitia?.pi_cents), taxes_cents: cents(p.pitia?.taxes_cents), insurance_cents: cents(p.pitia?.insurance_cents), hoa_cents: cents(p.pitia?.hoa_cents) }, rental: p.rental ?? false } : null, financed_property_count_before: Number(i.financed_property_count_before ?? 1), at: at(i, "at", ctx), repeat_pattern: flag(i, "repeat_pattern") }, ctx.actor);
        rt.store.put("reo_discovery_checks", check.check_id, { ...r.check }, ctx.actor, ctx.now);
        const occ = rt.store.list("occupancy_assessments", (d) => d.application_id === app).at(-1)?.data.conclusion as ReoCheck["status"] | undefined;
        const g = reconcileOccupancyReo(ctx.events, { application_id: app, occupancy_conclusion: (occ as never) ?? null, reo_status: r.check.status, at: at(i, "at", ctx) }, ctx.actor);
        return { check: r.check, status: r.check.status, handoffs: r.handoffs, misstatement: r.misstatement, gate: g.gate, event: r.event.type }; }
      need(i, "borrower_id"); const findings: ReoFinding[] = ((i.findings as ReoFinding[] | undefined) ?? []).map((f) => ({ ...f, upb_cents: f.upb_cents === undefined || f.upb_cents === null ? null : cents(f.upb_cents) }));
      const mers = svc<MersPort>(rt, "mers"); if (mers && str(i, "borrower_name")) for (const m of await mers.minSearch({ borrower_name: str(i, "borrower_name"), ssn_hash: str(i, "ssn_hash") })) if (!findings.some((f) => f.min === m.min)) findings.push({ source: "mers_lookup", description: m.property, min: m.min, vested_name: m.vested_name, on_reo_schedule: strs(i, "reo_schedule_addresses").includes(m.property) });
      const r = discoverReo(ctx.events, { application_id: app, borrower_id: str(i, "borrower_id"), findings, at: at(i, "at", ctx) }, ctx.actor);
      rt.store.put("reo_discovery_checks", r.check.check_id, { ...r.check, findings: r.check.findings.map((f) => ({ ...f, upb_cents: f.upb_cents === null || f.upb_cents === undefined ? null : String(f.upb_cents) })) }, ctx.actor, ctx.now);
      return { check: r.check, status: r.check.status, undisclosed_count: r.check.undisclosed_count, event: r.event?.type ?? null }; }) },
  // R9: B2-1.3-01 — relationship, new construction, occupancy → eligible; gift of equity → value acceptance blocked (24.1) and excluded from the IPC test (22.4); never re-cast occupancy.
  { name: "assessNonArmsLength", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "relationship_kind", "occupancy"); const app = appOf(i, ctx);
      const r = assessNonArmsLength(ctx.events, { application_id: app, relationship_kind: str(i, "relationship_kind") as RelationshipKind, property_new_construction: flag(i, "property_new_construction"), occupancy: str(i, "occupancy") as "primary" | "second_home" | "investment", gift_of_equity_cents: cents(i.gift_of_equity_cents), purchase_price_cents: i.purchase_price_cents === undefined ? null : cents(i.purchase_price_cents), true_occupancy_primary_evidence: flag(i, "true_occupancy_primary_evidence"), at: at(i, "at", ctx) }, ctx.actor);
      rt.store.put("non_arms_length_assessments", r.assessment.assessment_id, { ...r.assessment, gift_of_equity_cents: String(r.assessment.gift_of_equity_cents) }, ctx.actor, ctx.now);
      if (!r.assessment.eligible) escalateTo(rt, ctx, "underwriting_reviewer", app, { assessment_id: r.assessment.assessment_id, disposition: r.assessment.disposition, rule: "B2-1.3-01" });
      return { assessment: r.assessment, eligible: r.assessment.eligible, value_acceptance_blocked: r.assessment.value_acceptance_blocked, disposition: r.assessment.disposition, handoffs: r.handoffs, events: r.events.map((e) => e.type) }; }),
    guardrails: [NO_OCCUPANCY_COACHING] },
  // R6: op=log records a red_flag_events row (arms RED_FLAGS_681_RESPONSE_1BD); op=intake maps an upstream event; op=respond records the response; op=report renders the ITPP annual report.
  { name: "logRedFlag", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "log";
      if (op === "respond") { need(i, "event_id", "response"); const row = rt.store.require("red_flag_events", str(i, "event_id")).data as unknown as RedFlagRow; const r = respondRedFlag(ctx.events, row, { response: str(i, "response") as RedFlagResponse, responded_at: at(i, "responded_at", ctx), resolution: obj<Record<string, unknown>>(i, "resolution") ?? {}, case_id: str(i, "case_id") || null }, ctx.actor); rt.store.put("red_flag_events", row.event_id, { ...r.row }, ctx.actor, ctx.now); return { row: r.row, within_sla: r.within_sla, response_hours: r.row.response_hours, event: r.event.type }; }
      if (op === "report") { need(i, "from", "to"); const rows = rt.store.list("red_flag_events", (d) => !str(i, "application_id") || d.application_id === str(i, "application_id")).map((x) => x.data as unknown as RedFlagRow); return itppAnnualReport(rows, { from: D(str(i, "from")), to: D(str(i, "to")) }, at(i, "as_of", ctx)); }
      if (op === "intake") { need(i, "event_id"); const e = ctx.events.all().find((x) => x.id === str(i, "event_id")); if (!e) throw new RangeError(`event ${str(i, "event_id")} not found`); const r = intakeUpstreamSignal(ctx.events, e, ctx.actor); if (r.red_flag) rt.store.put("red_flag_events", r.red_flag.row.event_id, { ...r.red_flag.row }, ctx.actor, ctx.now); return { red_flag_event_id: r.red_flag?.row.event_id ?? null, category: r.red_flag?.row.category ?? null, address_discrepancy: r.address_discrepancy?.type ?? null, investigation_candidate: r.investigation_candidate }; }
      need(i, "red_flag_code"); const app = appOf(i, ctx);
      const r = logRedFlag(ctx.events, { application_id: app, red_flag_code: str(i, "red_flag_code"), detected_at: at(i, "detected_at", ctx), detected_by: str(i, "detected_by") || `${ctx.actor.kind}:${ctx.actor.id}`, detail: obj<Record<string, unknown>>(i, "detail") ?? {}, ...(str(i, "category") ? { category: str(i, "category") as RedFlagRow["category"] } : {}) }, ctx.actor);
      rt.store.put("red_flag_events", r.row.event_id, { ...r.row }, ctx.actor, ctx.now);
      return { row: r.row, event_id: r.row.event_id, response_due_on: r.row.response_due_on, event: r.event.type }; }) },
  // R10: investigation.opened (arms SM_FRAUD_INVESTIGATION_10BD; fraud.hold.placed) over the shared cases{case_type=fraud}.
  { name: "openInvestigation", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "triggers", "hypotheses"); const app = appOf(i, ctx);
      const r = openInvestigation(ctx.events, { application_id: app, triggers: strs(i, "triggers"), hypotheses: strs(i, "hypotheses"), at: at(i, "at", ctx), case_id: str(i, "case_id") || null, place_hold: i.place_hold === undefined ? true : flag(i, "place_hold"), ofac_event: flag(i, "ofac_event") }, ctx.actor);
      putInvestigation(rt, r.investigation, ctx); rt.store.put("cases", r.investigation.case_id, { case_type: "fraud", application_id: app, status: "open", owner_role: "bsa_officer", opened_at: r.investigation.opened_at }, ctx.actor, ctx.now);
      if (r.hold) putApp(rt, app, { fraud_hold: true, fraud_hold_reason: r.hold.reason, fraud_hold_case_id: r.investigation.case_id, fraud_hold_record: r.hold }, ctx);
      return { investigation: r.investigation, investigation_id: r.investigation.investigation_id, case_id: r.investigation.case_id, due_on: r.investigation.due_on, hold: r.hold, events: r.events.map((e) => e.type) }; }),
    guardrails: [NO_HOLD_BYPASS] },
  // R10: evidence and hypothesis updates through documented channels only.
  { name: "gatherEvidence", kind: "write", handler: compute((i, ctx, rt) => {
      const inv = readInvestigation(rt, i); need(i, "evidence_document_ids");
      const r = gatherEvidence(ctx.events, inv, { evidence_document_ids: strs(i, "evidence_document_ids"), hypothesis_updates: (i.hypothesis_updates as never[] | undefined) ?? [], channel: (str(i, "channel") || "documented_verification_channel") as "documented_verification_channel" | "borrower_via_app" | "third_party_direct", at: at(i, "at", ctx) }, ctx.actor);
      putInvestigation(rt, r.investigation, ctx); return { investigation: r.investigation, event: r.event.type }; }),
    guardrails: [NO_UNDOCUMENTED_THIRD_PARTY_CONTACT] },
  // R10: the conclusion inside the 10-business-day box; sar_detection_date = the conclusion date; hands 28.4 its triggers; a decline routes to 21.6 with underwriting_reviewer and scrubbed reasons.
  { name: "concludeInvestigation", kind: "act", handler: compute((i, ctx, rt) => {
      const inv = readInvestigation(rt, i); need(i, "conclusion", "loan_disposition", "rationale", "amount_cents");
      const r = concludeInvestigation(ctx.events, inv, { conclusion: str(i, "conclusion") as Conclusion, at: at(i, "at", ctx), subject_identified: i.subject_identified === undefined ? true : flag(i, "subject_identified"), amount_cents: cents(i.amount_cents), sar_category: (str(i, "sar_category") || null) as SarCategory | null, loan_disposition: str(i, "loan_disposition") as LoanDisposition, fnma_delivered_or_committed: flag(i, "fnma_delivered_or_committed"), rationale: str(i, "rationale"), reviewer_id: str(i, "reviewer_id") || null }, ctx.actor);
      putInvestigation(rt, r.investigation, ctx);
      if (r.escalation) escalateTo(rt, ctx, r.escalation.kind, inv.application_id, { investigation_id: inv.investigation_id, reason: r.escalation.reason, decline_reasons: r.decline_reasons });
      if (r.investigation.sar_candidate) escalateTo(rt, ctx, "bsa_officer", inv.application_id, { investigation_id: inv.investigation_id, sar_detection_date: r.investigation.sar_detection_date, package_due_on: r.deadlines?.package_due_on ?? null, filing_due_on: r.deadlines?.sar.filing_due_on ?? null }, "sev-2");
      return { investigation: r.investigation, sar_candidate: r.investigation.sar_candidate, sar_detection_date: r.investigation.sar_detection_date, fnma_self_report_candidate: r.investigation.fnma_self_report_candidate, deadlines: r.deadlines, decline_reasons: r.decline_reasons, events: r.events.map((e) => e.type) }; }),
    guardrails: [NO_SAR_DISCLOSURE] },
  // R10/R11: the SAR package for the bsa_officer — prepared, never filed; access limited to the list.
  { name: "prepareSarPackage", kind: "act", handler: compute((i, ctx, rt) => {
      const inv = readInvestigation(rt, i); need(i, "narrative_draft_document_id");
      const r = prepareSarPackage(ctx.events, inv, { narrative_draft_document_id: str(i, "narrative_draft_document_id"), exhibit_document_ids: strs(i, "exhibit_document_ids"), at: at(i, "at", ctx) }, ctx.actor);
      rt.store.put("sar_candidates", r.candidate.candidate_id, { ...r.candidate, amount_cents: String(r.candidate.amount_cents) }, ctx.actor, ctx.now); putInvestigation(rt, r.investigation, ctx);
      const esc = escalateTo(rt, ctx, r.escalation.kind, inv.application_id, r.escalation.payload, r.escalation.severity);
      return { candidate: r.candidate, candidate_id: r.candidate.candidate_id, filing_due_on: r.candidate.filing_due_on, outer_limit_on: r.candidate.outer_limit_on, on_time: r.on_time, escalation_id: esc.id, sent_to: "bsa_officer", event: r.event.type }; }),
    guardrails: [NO_FILING, NO_SAR_DISCLOSURE] },
  // A3-4-03: the Loan Quality Connect self-report package for the officer / fnma_portal_operator (18.5's element list) — prepared, never submitted.
  { name: "prepareSelfReportPackage", kind: "act", handler: compute((i, ctx, rt) => {
      const inv = readInvestigation(rt, i); need(i, "package_document_id");
      const r = prepareSelfReportPackage(ctx.events, inv, { content: obj<Record<string, unknown>>(i, "content") ?? {}, package_document_id: str(i, "package_document_id"), at: at(i, "at", ctx) }, ctx.actor);
      const esc = escalateTo(rt, ctx, r.escalation.kind, inv.application_id, r.escalation.payload);
      return { due_on: r.due_on, missing_elements: r.missing_elements, escalation_id: esc.id, sent_to: "officer", event: r.event.type }; }),
    guardrails: [NO_FILING, NO_SAR_DISCLOSURE] },
  // 31 CFR 501.603/.604: the ORS report package for the bsa_officer within 10 business_days_federal — prepared, never filed.
  { name: "prepareOfacReport", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "screening_id", "kind", "event_on", "package_document_id"); const app = appOf(i, ctx);
      const r = prepareOfacReport(ctx.events, { application_id: app, screening_id: str(i, "screening_id"), kind: str(i, "kind") as OfacReportKind, event_on: D(str(i, "event_on")), content: obj<Record<string, unknown>>(i, "content") ?? {}, package_document_id: str(i, "package_document_id"), at: at(i, "at", ctx) }, ctx.actor);
      const esc = escalateTo(rt, ctx, r.escalation.kind, app, r.escalation.payload, "sev-1");
      return { due_on: r.due_on, missing_elements: r.missing_elements, escalation_id: esc.id, sent_to: "bsa_officer", event: r.event.type }; }),
    guardrails: [NO_FILING] },
  // State machine: fraud.hold.placed overlays any state; op=check asserts a command against the hold (submitDu / issueCD / consummate / funding.authorized refuse).
  { name: "placeHold", kind: "act", handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx);
      if (str(i, "op") === "check") { need(i, "command"); const h = holdOf(rt, app); assertNoFraudHold(h, str(i, "command")); return { command: str(i, "command"), blocked: false, fraud_hold: h?.fraud_hold ?? false }; }
      need(i, "reason");
      const r = placeHold(ctx.events, { application_id: app, reason: str(i, "reason") as FraudHold["reason"], case_id: str(i, "case_id") || null, at: at(i, "at", ctx), detail: obj<Record<string, unknown>>(i, "detail") ?? {} }, ctx.actor);
      putApp(rt, app, { fraud_hold: true, fraud_hold_reason: r.hold.reason, fraud_hold_case_id: r.hold.case_id, fraud_hold_record: r.hold }, ctx);
      return { hold: r.hold, blocks: r.hold.blocks, event: r.event.type }; }),
    guardrails: [NO_HOLD_BYPASS] },
  // State machine: released only on a concluded investigation (the bsa_officer for OFAC matches).
  { name: "releaseHold", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "rationale"); const app = appOf(i, ctx); const hold = holdOf(rt, app); if (!hold) throw new RangeError(`no fraud_hold on application ${app}`);
      const invRow = str(i, "investigation_id") ? readInvestigation(rt, i) : rt.store.list("fraud_investigations", (d) => d.application_id === app && d.case_id === hold.case_id).at(-1)?.data as unknown as Investigation | undefined;
      const r = releaseHold(ctx.events, hold, { investigation: invRow ? { investigation_id: invRow.investigation_id, status: invRow.status, conclusion: invRow.conclusion } : null, actor: ctx.actor, at: at(i, "at", ctx), rationale: str(i, "rationale") });
      putApp(rt, app, { fraud_hold: false, fraud_hold_reason: null, fraud_hold_case_id: null, fraud_hold_record: null }, ctx);
      const loop = invRow && str(i, "return_event_id") ? (() => { const e = ctx.events.all().find((x) => x.id === str(i, "return_event_id")); return e ? closeInvestigationLoop(ctx.events, invRow, e, ctx.actor) : null; })() : null;
      if (loop) putInvestigation(rt, loop.investigation, ctx);
      return { released: r.released, event: r.event.type, investigation_status: loop?.investigation.status ?? invRow?.status ?? null }; }),
    guardrails: [NO_HOLD_BYPASS, needsRole("OFAC_HOLD_RELEASE_BSA_OFFICER", "22.6 state machine: fraud_hold released by the fraud-risk agent's concluded investigation (or bsa_officer for OFAC matches)", (i) => str(i, "hold_reason") === "ofac_match_true" || flag(i, "ofac"), ["bsa_officer"], "an OFAC hold is released only by the bsa_officer")] },
  // The decision record every screening act carries (rule_set_version / model_version / prompt_version / rationale / confidence); op=scan_borrower_text applies the R11 scrub before 21.6 renders.
  { name: "writeDecision", kind: "write", handler: compute((i, ctx) => {
      if (str(i, "op") === "scan_borrower_text") { need(i, "text"); assertNoSarTerms(str(i, "text")); return { clean: true, text: str(i, "text") }; }
      need(i, "action", "rationale");
      const rec = str(i, "model_version") && str(i, "prompt_version") ? decisionRecord({ application_id: appOf(i, ctx), subject: obj<{ kind: string; id: string }>(i, "subject") ?? { kind: "application", id: appOf(i, ctx) }, screening_results: obj<Record<string, unknown>>(i, "screening_results") ?? {}, identity_scores: obj<Record<string, unknown>>(i, "identity_scores") ?? {}, ssn_resolution_path: str(i, "ssn_resolution_path") || null, occupancy: obj<{ signals: unknown; score: number | null }>(i, "occupancy"), reo_findings: i.reo_findings ?? null, non_arms_length: i.non_arms_length ?? null, red_flags: i.red_flags ?? null, investigation: i.investigation ?? null, sar_candidate_rationale: str(i, "sar_candidate_rationale") || null, model_version: str(i, "model_version"), prompt_version: str(i, "prompt_version"), rationale: str(i, "rationale"), confidence: Number(i.confidence ?? 1) }) : null;
      decision()({ ...i, rule_set_version: str(i, "rule_set_version") || (rec?.rule_set_version ?? "22.6/2026-09-10"), ...(rec ? { subject: rec.subject } : {}) }, ctx);
      return { recorded: true, record: rec }; }),
    guardrails: [NO_DEMOGRAPHIC_INPUTS, NO_SAR_DISCLOSURE] },
]));
