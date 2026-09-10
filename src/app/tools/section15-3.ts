/**
 * §15.3 tools — MI claim filing (`claims-reo`). Every tool string is the spec's verbatim
 * (`routeMiClaim`, `computeShadowClaim`, `assembleMiPackage`, `openPortalTask`, `fileDirectClaim`,
 * `trackDocRequests`, `reconcileEob`, `scoreCurtailmentRisk`, `draftAppeal`, `attributeShortfall`,
 * `recordDecision`). Guardrails encode the spec's sentences: never let `micp_docs_due_at` pass without an
 * `officer` alert at −3 BD (the daily MICP dashboard check raises it); never upload origination-file documents
 * unless requested; never concede a curtailment as servicer-caused without the timeline evidence review (every
 * servicer cause, not only foreclosure delays); appeals over $10,000 are approved by a `human_agent` reviewer before
 * any path files them (draftAppeal{submit | op=file}, the operator's MICP result); rescissions go to the `officer`
 * (disputes with rescission-relief evidence also to the `attorney`); direct claims are payable to Fannie Mae only;
 * proceeds are never netted against advances; a routing cannot skip an unresolved insurer-identity mismatch; the
 * shadow reconciled to an EOB is the stored, versioned `mi_claim_calculations` row — never an agent-supplied figure.
 *
 * Events this process emits (the section's timers arm on / are satisfied by them — src/domain/reo/timers-15-3.ts):
 *   routeMiClaim      mi_claims.opened · mi_claims.data_mismatch.detected · mi_claims.data_correction.submitted · mi_claims.routed ·
 *                     claim.milestone.reached{mi_insured=true} (F-1-06 expense anchor moved to the redemption expiry / docket entry)
 *   assembleMiPackage mi_claims.package.assembled · mi.claim.supplemental.closed{result=none_needed}
 *   openPortalTask    (op=record_result) mi_claims.package.uploaded · mi.claim.supplemental.closed{result=filed} ·
 *                     micp.document_request.fulfilled · mi.claim.appeal.filed · micp.message.replied
 *   fileDirectClaim   mi.claim.filed{route=servicer_direct} · mi.claim.acknowledged · mi.claim.filing.tasked ·
 *                     (op=followup) mi.claim.followup.logged · (op=record_response) mi.claim.insurer_response.logged · mi.claim.perfected
 *   trackDocRequests  micp.document_request.observed · micp.document_request.fulfilled · mi.claim.filed{route=fnma_micp} · mi.claim.perfected
 *   reconcileEob      mi.claim.eob_received · mi.claim.decision.received · mi.claim.benefit_received{payee} · remittance.special.drafted{kind=mi_benefit} ·
 *                     (op=record_remittance) remittance.special.settled{code, kind=mi_benefit}
 *   scoreCurtailmentRisk mi.default.started · mi.default_report.accepted{kind} · foreclosure.sale.scheduled{mi_insured=true} · mi_curtailment_risk.projected
 *   draftAppeal       mi.claim.appeal.approved · mi.claim.appeal.filed · attributeShortfall mi.claim.shortfall.attributed
 * Every step also appends its `mi_claim_events` row (kinds per db/migrations/0036_mi_claim_events.sql).
 * MICP is UI-only: uploads, doc-request responses, messages and appeals are `fnma_portal_task`s whose structured
 * results the operator records back through `openPortalTask{op=record_result}` / `trackDocRequests`. Spread by ./section15.ts.
 *
 * Recurring rows (SM_MI_SETTLEMENT_FOLLOWUP_7, MI_MP_STATUS_MONTHLY_25TH) are closed by the tool that performs the satisfying act and
 * re-armed for the next cycle explicitly: the kernel engine re-arms a recurring timer inside the very loop that satisfies it
 * (src/kernel/timers/engine.ts onEvent — the re-armed instance is visited in the same pass, matches the same event and re-arms again
 * without end), so the satisfying event is never appended while an armed instance of the recurring row can match it (the pattern
 * src/app/tools/section19-3.ts uses; reported as a kernel defect).
 */
import { defineTools, escalate, compute, decision, never, needsRole, read, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { hasRole } from "../roles.ts";
import { evaluateGate } from "../evaluators.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { SYSTEM, type DomainEvent } from "../../kernel/events/index.ts";
import type { TimerRegistry, TimerInstance } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { filer, miClaimClocks, unpaidEscalationOn, supplementalUploadDue } from "../../domain/reo/mi-claim.ts";
import { shadowClaimItemized, directClaimPackage, mandatoryDocumentKinds, originationItemsAllowed, micpDocsOfficerAlert, trackDocRequests, reconcileEob, appealRouting, appealSubmissionCheck, attributeShortfall, curtailmentRiskRow, interestCapWatch, validateInsurerIdentity, unpaidClaimEscalation, benefitReceipt, supplementalClaimPlan,
  miClaimEventRow, resolveMasterPolicyTerms, calculationRow, miDefaultStart, ingestDefaultReports, statusReportsCurrent, interestCapFacts, remittanceSettlement, SERVICER_CAUSES,
  type ClaimAdvance, type PostClaimAdvance, type LiquidationType, type DocRequest, type ShortfallCause, type AppealReason, type ItemizedShadowClaim, type ItemizedShadowInput, type Filer, type FollowupEntry, type InsurerResponse, type BenefitPayee, type MasterPolicyTerms, type DefaultReportRecord, type MiClaimEventKind, type MiClaimEventSource } from "../../domain/reo/ops-15-3.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const today = (i: ToolInput, now: string): PlainDate => optDate(i, "today") ?? D(now.slice(0, 10));
const loanOf = (i: ToolInput, ctx: CommandContext): string => (i.loan_id as string | undefined) ?? ctx.loanId;
const claimIdOf = (i: ToolInput): string => str(i, "claim_id") || `mic-${str(i, "loan_id")}`;
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const identityMismatch = (i: ToolInput): boolean => validateInsurerIdentity({ policy_insurer_code: str(i, "insurer_code"), reogram_insurer_code: str(i, "reogram_insurer_code") || null, micp_insurer_code: str(i, "micp_insurer_code") || null, found_on: D("2026-01-01") }).mismatch;
const AGENT = "claims-reo";
const PROCESS = "15.3";
const MICP_TASKS = /^micp\.(docs\.upload|doc_request\.respond|message\.reply|appeal\.submit)$|^insurer_portal\./;
const REVIEWERS = ["human_agent", "officer"] as const;

/** A store-dependent refusal from inside a handler: the same `command.refused` event the bus writes for a guardrail, then the typed error (nothing is persisted). */
const refuse = (ctx: CommandContext, command: string, code: string, citation: string, reason: string, loanId: string): never => {
  ctx.events.append({ type: "command.refused", loanId, actor: ctx.actor, payload: { command, code, citation, reason, subject_id: null } });
  throw new CommandRefused(command, code, citation, reason);
};
/** One append-only `mi_claim_events` row (0036 columns) beside the domain event. */
const claimEvent = (rt: ToolRuntime, ctx: CommandContext, i: { claim_id: string; loan_id: string; kind: MiClaimEventKind; on: PlainDate | string; source: MiClaimEventSource; filer?: Filer | null; micp_request_id?: string | null; amount_cents?: bigint | null; paid_to?: BenefitPayee | null; reason?: string | null; payload?: Record<string, unknown> }) => {
  const n = rt.store.list("mi_claim_events", (d) => d.claim_id === i.claim_id).length + 1;
  const row = miClaimEventRow({ claim_id: i.claim_id, loan_id: i.loan_id, kind: i.kind, occurred_on: i.on, source: i.source, actor: ctx.actor, filer: i.filer ?? null, micp_request_id: i.micp_request_id ?? null, amount_cents: i.amount_cents ?? null, paid_to: i.paid_to ?? null, reason: i.reason ?? null, payload: i.payload ?? {} });
  return rt.store.put("mi_claim_events", `${i.claim_id}-ev${n}`, { ...row }, ctx.actor, ctx.now);
};
const messages = (rt: ToolRuntime, claimId: string, direction: "outbound" | "inbound") => rt.store.list("mi_claim_events", (d) => d.claim_id === claimId && d.kind === "message" && (d.payload as Record<string, unknown>).direction === direction).map((r) => r.data.payload as Record<string, unknown>);

// ---- recurring rows: closed by the tool that performs the satisfying act, re-armed explicitly (file header) ----
let REGISTRY: TimerRegistry | null = null;
const registry = (): TimerRegistry => (REGISTRY ??= loadOverriddenRegistry());
const openInstances = (ctx: CommandContext, code: string, loanId: string): TimerInstance[] => ctx.timers.byCode(code).filter((t) => t.loanId === loanId && (t.status === "armed" || t.status === "breached"));
const closeRecurring = (ctx: CommandContext, code: string, loanId: string): TimerInstance[] => {
  const closed = openInstances(ctx, code, loanId);
  for (const inst of closed) { inst.status = inst.status === "breached" ? "satisfied_late" : "satisfied"; inst.satisfiedAt = ctx.now; }
  return closed;
};
const recordSatisfied = (ctx: CommandContext, closed: readonly TimerInstance[], e: DomainEvent): void => {
  for (const inst of closed) { inst.satisfiedByEventId = e.id; ctx.events.append({ type: "timer.satisfied", ...(inst.loanId ? { loanId: inst.loanId } : {}), actor: SYSTEM, causationId: e.id, payload: { code: inst.code, timer_id: inst.id, late: inst.status === "satisfied_late", satisfied_by: e.type } }); }
};
const rearm = (ctx: CommandContext, code: string, trigger: DomainEvent): TimerInstance | null => { const def = registry().get(code); return def ? ctx.timers.arm(def, trigger) : null; };
const cancelOpen = (ctx: CommandContext, code: string, loanId: string, reason: string): string[] => { const ids: string[] = []; for (const inst of openInstances(ctx, code, loanId)) { ctx.timers.cancel(inst.id, reason, ctx.actor); ids.push(inst.id); } return ids; };

export const TOOLS_15_3: readonly ToolDef[] = defineTools(PROCESS, AGENT, [
  // rule 1/2 — the liquidation fact opens the claim (master-policy clocks run from it), the three-way insurer identity check, the filer from the
  // loaded master-policy terms (Participants Exhibit + effective date; the agent's reading only fills a gap), the deadline derivations (T1, T3, T11)
  { name: "routeMiClaim", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "insurer_code", "liquidation_date", "claim_anchor_date");
      const loanId = str(i, "loan_id"); const claimId = claimIdOf(i); const now = today(i, ctx.now);
      const prev = rt.store.get("mi_claims", claimId)?.data;
      const liquidationDate = date(i, "liquidation_date"); const anchor = date(i, "claim_anchor_date"); const expenseAnchor = optDate(i, "expense_anchor_date") ?? anchor;
      const terms = resolveMasterPolicyTerms({ insurer_code: str(i, "insurer_code"), liquidation_date: liquidationDate, terms: rt.store.list("mi_master_policy_terms").map((r) => ({ id: r.id, ...(r.data as Omit<MasterPolicyTerms, "id">) })),
        input: { micp_participant: flag(i, "micp_participant"), micp_effective_date: optDate(i, "micp_effective_date"), claim_filing_days: i.claim_filing_days === undefined ? null : Number(i.claim_filing_days), appeal_days: i.appeal_days === undefined ? null : Number(i.appeal_days) } });
      const deadline = addDays(anchor, terms.claim_filing_days); const lateDenyAt = addDays(anchor, terms.late_deny_days); const supplementalDue = addDays(anchor, terms.supplemental_days);
      if (!prev) {
        // state `opened` (liquidation fact): the master-policy clocks count from the sale "regardless of" anything (§64(b)) — an identity hold does not stop them
        rt.store.put("mi_claims", claimId, { loan_id: loanId, insurer_code: str(i, "insurer_code"), liquidation_type: str(i, "liquidation_type") || null, liquidation_date: liquidationDate, claim_anchor_date: anchor, master_policy_terms_id: terms.terms_id, terms_source: terms.source, claim_filing_deadline: deadline, late_deny_at: lateDenyAt, supplemental_due_at: supplementalDue, filer: null, status: "opened", opened_on: now }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi_claims.opened", loanId, actor: ctx.actor, payload: { claim_id: claimId, loan_id: loanId, insurer_code: str(i, "insurer_code"), liquidation_type: str(i, "liquidation_type") || null, liquidation_date: liquidationDate, claim_anchor_date: anchor, claim_filing_deadline: deadline, late_deny_at: lateDenyAt, supplemental_due_at: supplementalDue, claim_filing_days: terms.claim_filing_days, late_deny_days: terms.late_deny_days, supplemental_days: terms.supplemental_days, master_policy_terms_id: terms.terms_id, terms_source: terms.source } });
      }
      const check = validateInsurerIdentity({ policy_insurer_code: str(i, "insurer_code"), reogram_insurer_code: str(i, "reogram_insurer_code") || null, micp_insurer_code: str(i, "micp_insurer_code") || null, found_on: now });
      const correctionOn = optDate(i, "correction_submitted_on");
      if (check.mismatch && !correctionOn) {
        // rule 1: any mismatch → FNMA_E4501_MICP_DATA_CORRECTION_1BD; the routing waits for the correction (T11)
        const task = rt.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", loanId, severity: "sev2", payload: { task_type: check.correction_targets.includes("micp") ? "micp.message.reply" : "p360.reogram.mi_fields.edit", claim_id: claimId, correction: { field: "mi_company", to: str(i, "insurer_code"), sources: check.sources }, due_at: check.correction_due_at, timer: check.timer, reason: check.refusal } }, ctx.actor);
        const rec = rt.store.put("mi_claims", claimId, { filer: null, status: "data_correction_pending", identity_check: check, mismatch_detected_on: now, correction_due_at: check.correction_due_at, correction_task_id: task.id }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi_claims.data_mismatch.detected", loanId, actor: ctx.actor, payload: { claim_id: claimId, detection_date: now, correction_due_at: check.correction_due_at, sources: check.sources, correction_targets: check.correction_targets, task_id: task.id } });
        return { ...rec.data, correction_task: task };
      }
      if (correctionOn) {
        const dueAt = (prev?.correction_due_at as string | undefined) ?? check.correction_due_at ?? null;
        ctx.events.append({ type: "mi_claims.data_correction.submitted", loanId, actor: ctx.actor, payload: { claim_id: claimId, submitted_on: correctionOn, correction_due_at: dueAt, on_time: dueAt ? correctionOn <= dueAt : null, insurer_code: str(i, "insurer_code"), channel: str(i, "correction_channel") || "micp_message" } });
      }
      const route = filer({ micp_participant: terms.micp_participant, micp_effective: terms.micp_effective_date, liquidation_date: liquidationDate });
      const clocks = miClaimClocks(anchor, expenseAnchor, terms.claim_filing_days);
      const rec = rt.store.put("mi_claims", claimId, { loan_id: loanId, insurer_code: str(i, "insurer_code"), filer: route, micp_participant: terms.micp_participant, micp_effective_date: terms.micp_effective_date, master_policy_terms_id: terms.terms_id, terms_source: terms.source, terms_input_disagrees: terms.input_disagrees, liquidation_type: str(i, "liquidation_type") || null, liquidation_date: liquidationDate, claim_anchor_date: anchor, direct_file_anchor_date: expenseAnchor,
        claim_filing_deadline: clocks.claim_filing_deadline, late_deny_at: lateDenyAt, micp_docs_due_at: route === "fnma_micp" ? clocks.micp_docs_due : null, officer_alert_on: route === "fnma_micp" ? addBusinessDays(clocks.micp_docs_due, -3, fannieEt) : null, direct_file_due_at: route === "servicer_direct" ? clocks.direct_file_due : null, internal_target: clocks.internal_target, supplemental_due_at: supplementalDue, supplemental_upload_by: route === "fnma_micp" ? supplementalUploadDue(supplementalDue) : supplementalDue,
        settlement_days: terms.settlement_days, appeal_days: terms.appeal_days, status: "routed", re_evaluated: Boolean(correctionOn), correction_submitted_on: correctionOn, routed_on: now }, ctx.actor, ctx.now);
      ctx.events.append({ type: "mi_claims.routed", loanId, actor: ctx.actor, payload: { claim_id: claimId, route, claim_anchor_date: anchor, claim_filing_deadline: clocks.claim_filing_deadline, late_deny_at: lateDenyAt, micp_docs_due_at: route === "fnma_micp" ? clocks.micp_docs_due : null, direct_file_anchor_date: expenseAnchor, direct_file_due_at: route === "servicer_direct" ? clocks.direct_file_due : null, internal_target: clocks.internal_target, supplemental_due_at: supplementalDue, master_policy_terms_id: terms.terms_id, re_evaluated: Boolean(correctionOn) } });
      // jurisdiction override (rule 2): the F-1-06 anchor moved to the redemption expiry / docket entry — the milestone 15.2's FNMA_F106_MI_EXPENSE_FINAL_30 counts from (T3)
      if (expenseAnchor !== anchor && !(prev?.expense_milestone_emitted_on)) {
        const kind = str(i, "expense_anchor_kind") || (flag(i, "court_order") ? "docket_entry" : "redemption_expired");
        ctx.events.append({ type: "claim.milestone.reached", loanId, actor: ctx.actor, payload: { claim_id: claimId, kind, mi_insured: true, milestone_date: expenseAnchor, legal_date: anchor, liquidation_type: str(i, "liquidation_type") || null, direct_file_due_at: clocks.direct_file_due, expense_final_due_at: clocks.direct_file_due, source: "15.3 routeMiClaim — F-1-06 direct-filing / expense anchor moved to the redemption expiry or docket entry" } });
        rt.store.put("mi_claims", claimId, { expense_milestone_emitted_on: now, expense_anchor_kind: kind }, ctx.actor, ctx.now);
      }
      return rt.store.get("mi_claims", claimId)!.data; }),
    guardrails: [never("ROUTE_PAST_UNRESOLVED_MISMATCH", "15.3 rule 1: the insurer identity is validated three ways (mi_policies, REOgram MI fields, MICP record); any mismatch → FNMA_E4501_MICP_DATA_CORRECTION_1BD", (i) => identityMismatch(i) && flag(i, "force_route"), "the correction is submitted within 1 BD and the routing re-evaluated — the agent cannot route past an unresolved mismatch")] },
  // rule 4 — the versioned shadow computation, stored with the mi_claim_calculations columns; the 36-month cap gate is asserted on the interest-to date
  { name: "computeShadowClaim", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "claim_id", "upb_cents", "note_rate_pct", "interest_paid_to", "anchor", "coverage_pct");
      const claimId = str(i, "claim_id"); const paidTo = date(i, "interest_paid_to");
      const input: ItemizedShadowInput = { upb_cents: cents(i.upb_cents), note_rate_pct: str(i, "note_rate_pct"), interest_paid_to: paidTo, anchor: date(i, "anchor"), default_date: optDate(i, "default_date") ?? addMonths(paidTo, 1), advances: list<ClaimAdvance>(i.advances), credits_cents: cents(i.credits_cents), coverage_pct: str(i, "coverage_pct"), net_proceeds_cents: i.net_proceeds_cents === undefined ? null : cents(i.net_proceeds_cents) };
      const s = shadowClaimItemized(input);
      const capFacts = interestCapFacts({ first_unpaid_due_date: input.default_date, interest_to: input.anchor });
      const gate = evaluateGate("15.3.interestWithinCap", capFacts);
      const version = rt.store.list("mi_claim_calculations", (d) => d.claim_id === claimId).length + 1;
      const row = calculationRow({ claim_id: claimId, version, as_of: today(i, ctx.now), input, shadow: s, cap_gate_note: gate.open ? `MI_MP_INTEREST_CAP_36M open: interest to ${input.anchor} is before the first uninsured installment ${capFacts.not_after}` : `MI_MP_INTEREST_CAP_36M closed: ${gate.reason ?? "past the cap"}` });
      const rec = rt.store.put("mi_claim_calculations", `${claimId}-v${version}`, { ...s, ...row, interest_cap_gate: { timer: "MI_MP_INTEREST_CAP_36M", open: gate.open, reason: gate.reason ?? null, not_after: capFacts.not_after } }, ctx.actor, ctx.now);
      rt.store.put("mi_claims", claimId, { shadow_calc_version: version, expected_benefit_cents: s.benefit_cents, settlement_option: s.settlement_option }, ctx.actor, ctx.now);
      return rec.data; }),
    guardrails: [never("CAP_IS_CODE", "15.3 rule 4: the attorney-fee cap and the 36-month interest cap are computed by code; the agent cannot override them", (i) => i.attorney_cap_override_cents !== undefined || i.interest_cap_months_override !== undefined, "caps come from mi_master_policy_terms")] },
  // rule 3 / rule 8 — the mandatory package with manifest hashes; `kind: supplemental` plans the post-claim package (T10); "none needed" only once the advances ledger is swept through upload-by
  { name: "assembleMiPackage", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "claim_id", "loan_id", "liquidation_type", "route");
      const claimId = str(i, "claim_id"); const loanId = str(i, "loan_id"); const route = str(i, "route") as Filer;
      const docs = list<{ id: string; doc_kind: string; sha256: string }>(i.documents);
      const claim = rt.store.get("mi_claims", claimId)?.data;
      if ((str(i, "kind") || "initial") === "supplemental") {
        const anchor = optDate(i, "claim_anchor_date") ?? (claim?.claim_anchor_date ? D(String(claim.claim_anchor_date)) : null);
        if (!anchor) throw new RangeError("a supplemental package needs claim_anchor_date (or a routed mi_claims row)");
        const plan = supplementalClaimPlan({ claim_anchor_date: anchor, route, post_claim_advances: list<PostClaimAdvance>(i.post_claim_advances), advances_swept_through: optDate(i, "advances_swept_through"), ...(claim?.supplemental_days ? { supplemental_days: Number(claim.supplemental_days) } : {}) });
        const rec = rt.store.put("mi_claim_packages", `${claimId}-supplemental-${ctx.now}`, { claim_id: claimId, loan_id: loanId, kind: "supplemental", manifest: docs.map((d) => ({ id: d.id, doc_kind: d.doc_kind, sha256: d.sha256 })), ...plan, complete: plan.documents.every((k) => docs.some((d) => d.doc_kind === k)) }, ctx.actor, ctx.now);
        if (plan.result === "none_needed") ctx.events.append({ type: "mi.claim.supplemental.closed", loanId, actor: ctx.actor, payload: { claim_id: claimId, result: "none_needed", supplemental_due_at: plan.supplemental_due_at, advances_swept_through: plan.advances_swept_through, basis: plan.basis } });
        else if (plan.needed) ctx.events.append({ type: "mi_claims.package.assembled", loanId, actor: ctx.actor, payload: { claim_id: claimId, package_id: rec.id, kind: "supplemental", amount_cents: plan.amount_cents, supplemental_due_at: plan.supplemental_due_at, upload_by: plan.upload_by, complete: rec.data.complete } });
        rt.store.put("mi_claims", claimId, { status: plan.needed ? "supplemental_pending" : (claim?.status as string | undefined) ?? "routed", supplemental_due_at: plan.supplemental_due_at, supplemental_upload_by: plan.upload_by, supplemental_result: plan.result }, ctx.actor, ctx.now);
        return rec.data;
      }
      const mandatory = mandatoryDocumentKinds(str(i, "liquidation_type") as LiquidationType, route, { servicer_counsel_eviction: flag(i, "servicer_counsel_eviction") });
      const present = new Set(docs.map((d) => d.doc_kind));
      const missing = mandatory.filter((k) => !present.has(k));
      const rec = rt.store.put("mi_claim_packages", `${claimId}-pkg-${ctx.now}`, { claim_id: claimId, loan_id: loanId, kind: "initial", route, manifest: docs.map((d) => ({ id: d.id, doc_kind: d.doc_kind, sha256: d.sha256 })), mandatory, missing, complete: missing.length === 0 }, ctx.actor, ctx.now);
      rt.store.put("mi_claims", claimId, { status: "docs_pending", package_id: rec.id }, ctx.actor, ctx.now);
      ctx.events.append({ type: "mi_claims.package.assembled", loanId, actor: ctx.actor, payload: { claim_id: claimId, package_id: rec.id, kind: "initial", route, complete: missing.length === 0, missing } });
      return rec.data; }),
    guardrails: [never("NO_ORIGINATION_FILE_UNLESS_REQUESTED", "15.3 guardrail: never upload origination-file documents unless requested", (i) => !originationItemsAllowed({ doc_kinds: list<{ doc_kind: string }>(i.documents).map((d) => d.doc_kind), insurer_requested_kinds: list<string>(i.insurer_requested_kinds) }).allowed, "origination-file items only on the insurer's request")] },
  // MICP is UI-only: `op=open` (default) hands the operator a task; `op=record_result` records the operator's structured result — the upload,
  // doc-request fulfilment, appeal submission or message — which is what the MICP-side timers are satisfied by
  { name: "openPortalTask", kind: "act", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "open";
      if (op === "record_result") {
        need(i, "claim_id", "task_type");
        const claimId = str(i, "claim_id"); const loanId = loanOf(i, ctx); const taskType = str(i, "task_type");
        const on = optDate(i, "uploaded_at") ?? optDate(i, "submitted_at") ?? today(i, ctx.now);
        const claim = rt.store.get("mi_claims", claimId)?.data;
        switch (taskType) {
          case "micp.docs.upload": {
            const pkg = str(i, "package_id") ? rt.store.get("mi_claim_packages", str(i, "package_id"))?.data : undefined;
            const kind = str(i, "package_kind") || (pkg?.kind as string | undefined) || "initial";
            const complete = pkg ? Boolean(pkg.complete) : flag(i, "mandatory_complete");
            const route = (claim?.filer as Filer | null | undefined) ?? (str(i, "route") as Filer) ?? "fnma_micp";
            const docsDue = claim?.micp_docs_due_at ? D(String(claim.micp_docs_due_at)) : optDate(i, "micp_docs_due_at");
            const late = kind === "initial" && docsDue !== null && on > docsDue;
            rt.store.put("mi_claims", claimId, kind === "supplemental" ? { supplemental_uploaded_at: on, status: "supplemental_settled_pending" } : { package_uploaded_at: on, status: complete ? "docs_uploaded" : "docs_pending" }, ctx.actor, ctx.now);
            ctx.events.append({ type: "mi_claims.package.uploaded", loanId, actor: ctx.actor, payload: { claim_id: claimId, route, kind, package_id: str(i, "package_id") || null, mandatory_complete: complete, uploaded_at: on, micp_request_ids: list<string>(i.micp_request_ids), uploaded_by: ctx.actor.id, late } });
            claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: kind === "supplemental" ? "supplemental_filed" : "doc_uploaded", on, source: "micp", filer: route, amount_cents: kind === "supplemental" ? (pkg?.amount_cents as bigint | undefined) ?? cents(i.amount_cents) : null, payload: { package_id: str(i, "package_id") || null, package_kind: kind, mandatory_complete: complete, late, micp_request_ids: list<string>(i.micp_request_ids) } });
            if (kind === "supplemental") ctx.events.append({ type: "mi.claim.supplemental.closed", loanId, actor: ctx.actor, payload: { claim_id: claimId, result: "filed", uploaded_at: on, amount_cents: (pkg?.amount_cents as bigint | undefined) ?? cents(i.amount_cents), filed_by: route === "fnma_micp" ? "fannie_mae_from_upload" : "servicer" } });
            const officer = late ? rt.escalations.open({ kind: "officer", loanId, severity: "sev1", payload: { claim_id: claimId, micp_docs_due_at: docsDue, uploaded_at: on, reason: "MICP documents uploaded after micp_docs_due_at — E-4.5-01 liability for a claim denied, delayed or curtailed by late documents" } }, ctx.actor) : null;
            return { claim_id: claimId, kind, uploaded_at: on, mandatory_complete: complete, late, officer_escalation: officer };
          }
          case "micp.doc_request.respond": {
            need(i, "micp_request_id");
            const key = `${claimId}-${str(i, "micp_request_id")}`; const doc = rt.store.get("mi_claim_documents", key)?.data;
            const dueAt = doc?.due_at ? D(String(doc.due_at)) : optDate(i, "due_at");
            const late = dueAt !== null && on > dueAt;
            rt.store.put("mi_claim_documents", key, { claim_id: claimId, micp_request_id: str(i, "micp_request_id"), uploaded_at: on, uploaded_by: ctx.actor.id, status: late ? "uploaded_late" : "uploaded" }, ctx.actor, ctx.now);
            ctx.events.append({ type: "micp.document_request.fulfilled", loanId, actor: ctx.actor, payload: { claim_id: claimId, micp_request_id: str(i, "micp_request_id"), uploaded_at: on, due_at: dueAt, late } });
            claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "doc_uploaded", on, source: "micp", micp_request_id: str(i, "micp_request_id"), payload: { due_at: dueAt, late, doc_kind: doc?.doc_kind ?? null } });
            return { claim_id: claimId, micp_request_id: str(i, "micp_request_id"), uploaded_at: on, late };
          }
          case "micp.appeal.submit": {
            need(i, "appeal_id");
            const appeal = rt.store.get("mi_claim_appeals", str(i, "appeal_id"))?.data;
            if (!appeal) throw new RangeError(`no appeal ${str(i, "appeal_id")} — draft it first (draftAppeal)`);
            if (appeal.status === "filed") throw new RangeError(`appeal ${str(i, "appeal_id")} is already filed (${String(appeal.filed_at)})`);
            // guardrail on every filing path: over $10,000 the human_agent reviewer approves before the operator's MICP result is recorded
            const check = appealSubmissionCheck({ amount_cents: cents(appeal.amount_cents), approval: appeal.approval as "agent" | "human_agent" | "officer", status: String(appeal.status), actor_is_reviewer: hasRole(ctx.actor, REVIEWERS) });
            if (!check.allowed) refuse(ctx, "openPortalTask", "APPEAL_OVER_10K_HUMAN_REVIEW", "15.3 guardrail: appeals are drafted by the agent and approved by a human_agent reviewer when the amount > $10,000", check.refusal!, loanId);
            rt.store.put("mi_claim_appeals", str(i, "appeal_id"), { status: "filed", filed_at: on, via: "micp", filed_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
            rt.store.put("mi_claims", claimId, { status: "appeal" }, ctx.actor, ctx.now);
            ctx.events.append({ type: "mi.claim.appeal.filed", loanId, actor: ctx.actor, payload: { claim_id: claimId, appeal_id: str(i, "appeal_id"), filed_at: on, via: "micp", amount_cents: cents(appeal.amount_cents), approved_by: (appeal.approved_by as string | undefined) ?? (appeal.approval === "agent" ? "agent" : `${ctx.actor.kind}:${ctx.actor.id}`) } });
            claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "appealed", on, source: "micp", amount_cents: cents(appeal.amount_cents), reason: String(appeal.reason ?? ""), payload: { appeal_id: str(i, "appeal_id"), via: "micp" } });
            return { claim_id: claimId, appeal_id: str(i, "appeal_id"), filed_at: on };
          }
          case "micp.message.reply": {
            ctx.events.append({ type: "micp.message.replied", loanId, actor: ctx.actor, payload: { claim_id: claimId, thread_id: str(i, "thread_id") || null, replied_at: on } });
            claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "message", on, source: "micp", payload: { direction: "outbound", channel: "micp_message", thread_id: str(i, "thread_id") || null, note: str(i, "note") || null } });
            return { claim_id: claimId, replied_at: on };
          }
          default: throw new RangeError(`task_type ${taskType} has no recordable MICP result`);
        }
      }
      need(i, "claim_id", "task_type");
      const alert = str(i, "micp_docs_due_at") && str(i, "task_type") === "micp.docs.upload" ? micpDocsOfficerAlert({ micp_docs_due_at: date(i, "micp_docs_due_at"), today: today(i, ctx.now), uploaded: flag(i, "uploaded"), officer_alerted: flag(i, "officer_alerted") }) : null;
      const officer = alert && alert.alert_required ? rt.escalations.open({ kind: "officer", loanId: loanOf(i, ctx), severity: "sev1", payload: { claim_id: str(i, "claim_id"), micp_docs_due_at: str(i, "micp_docs_due_at"), alert_on: alert.alert_on, reason: "MICP documents not uploaded 3 BD before micp_docs_due_at (E-4.5-01 liability)" } }, ctx.actor) : null;
      const task = escalate("human_portal_task")({ ...i, kind: "human_portal_task", owner_role: "fnma_portal_operator", payload: { task_type: str(i, "task_type"), claim_id: str(i, "claim_id"), micp_request_id: str(i, "micp_request_id") || null, due_at: str(i, "due_at") || str(i, "micp_docs_due_at") || null, package_id: str(i, "package_id") || null, potential_denial_date: str(i, "potential_denial_date") || null, officer_alert_id: officer ? officer.id : null } }, ctx, rt);
      return { task, officer_alert: officer }; }),
    guardrails: [never("PORTAL_TASK_TYPES", "15.3 integrations: MICP human_portal_task types are micp.docs.upload, micp.doc_request.respond, micp.message.reply, micp.appeal.submit (no scraping)", (i) => str(i, "task_type") !== "" && !MICP_TASKS.test(str(i, "task_type")), "use one of the four MICP task types")] },
  // rule 6 — direct filing for non-participants via the insurer adapter (portal/EDI/e-mail), payable to Fannie Mae; `filed` only on the insurer's acknowledgment;
  // op=record_acknowledgment (operator result), op=followup (weekly log until paid — closes and re-arms SM_MI_SETTLEMENT_FOLLOWUP_7), op=record_response (insurer responses; perfection)
  { name: "fileDirectClaim", kind: "act", handler: compute(async (i, ctx, rt) => {
      const op = str(i, "op") || "file";
      const claimId = str(i, "claim_id"); const loanId = loanOf(i, ctx); const now = today(i, ctx.now);
      if (op === "followup") {
        need(i, "claim_id");
        const claim = rt.store.get("mi_claims", claimId)?.data ?? {};
        const entry: FollowupEntry = { on: now, note: str(i, "note") || "follow-up with the insurer on claim settlement (F-1-06 Ensuring Timely Settlement)" };
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "message", on: now, source: "servicer", filer: "servicer_direct", payload: { direction: "outbound", message_kind: "followup", on: now, note: entry.note, insurer_contact: str(i, "insurer_contact") || null } });
        // the recurring row: close the open cycle first (kernel re-arm loop — file header), append the log, re-arm the next cycle from it unless paid
        const closed = closeRecurring(ctx, "SM_MI_SETTLEMENT_FOLLOWUP_7", loanId);
        const e = ctx.events.append({ type: "mi.claim.followup.logged", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", on: now, note: entry.note, followup_from: now, next_followup_on: addDays(now, 7) } });
        recordSatisfied(ctx, closed, e);
        const paid = flag(i, "paid") || Boolean(claim.paid_at);
        const next = paid ? null : rearm(ctx, "SM_MI_SETTLEMENT_FOLLOWUP_7", e);
        return { claim_id: claimId, logged: entry, next_followup_on: paid ? null : addDays(now, 7), timer: { code: "SM_MI_SETTLEMENT_FOLLOWUP_7", closed: closed.map((t) => ({ id: t.id, status: t.status })), rearmed: next ? { id: next.id, due_date: next.dueDate ?? null, anchor_date: next.anchorDate } : null } };
      }
      if (op === "record_acknowledgment") {
        need(i, "claim_id", "acknowledgment_id");
        const filedAt = optDate(i, "filed_at") ?? now;
        rt.store.put("mi_claims", claimId, { status: "filed", filed_at: filedAt, acknowledgment_id: str(i, "acknowledgment_id") }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.filed", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", filed_at: filedAt, followup_from: filedAt, acknowledgment_id: str(i, "acknowledgment_id"), filed_by: "servicer" } });
        ctx.events.append({ type: "mi.claim.acknowledged", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", acknowledgment_id: str(i, "acknowledgment_id"), acknowledged_on: now } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "filed", on: filedAt, source: "insurer", filer: "servicer_direct", payload: { acknowledgment_id: str(i, "acknowledgment_id"), acknowledged_on: now } });
        return { claim_id: claimId, status: "filed", filed_at: filedAt };
      }
      if (op === "record_response") {
        need(i, "claim_id", "response");
        const resp: InsurerResponse = { on: now, response: str(i, "response") };
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "message", on: now, source: "insurer", filer: "servicer_direct", payload: { direction: "inbound", message_kind: "insurer_response", on: now, response: resp.response } });
        ctx.events.append({ type: "mi.claim.insurer_response.logged", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", ...resp } });
        const perfected = optDate(i, "perfected_at");
        if (perfected && !rt.store.get("mi_claims", claimId)?.data.perfected_at) {
          const settlementDays = Number(rt.store.get("mi_claims", claimId)?.data.settlement_days ?? 60);
          const settlementDue = settlementDays === 60 ? unpaidEscalationOn(perfected) : addDays(perfected, settlementDays);
          rt.store.put("mi_claims", claimId, { status: "perfected", perfected_at: perfected, settlement_due_at: settlementDue }, ctx.actor, ctx.now);
          ctx.events.append({ type: "mi.claim.perfected", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", perfected_at: perfected, settlement_due_at: settlementDue } });
          claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "perfected", on: perfected, source: "insurer", filer: "servicer_direct", payload: { settlement_due_at: settlementDue, documentation_complete_date: perfected } });
        }
        return { claim_id: claimId, response: resp, perfected_at: perfected };
      }
      need(i, "claim_id", "loan_id", "insurer_code", "liquidation_type", "liquidation_date", "claim_anchor_date");
      const plan = directClaimPackage({ insurer_code: str(i, "insurer_code"), micp_participant: flag(i, "micp_participant"), micp_effective: optDate(i, "micp_effective_date"), liquidation_type: str(i, "liquidation_type") as LiquidationType, liquidation_date: date(i, "liquidation_date"), claim_anchor_date: date(i, "claim_anchor_date"), expense_anchor_date: optDate(i, "expense_anchor_date") ?? date(i, "claim_anchor_date"), claim_form_id: str(i, "claim_form_id") || null, filed_on: now });
      if (plan.filer !== "servicer_direct") throw new RangeError(`claim ${claimId} routes to fnma_micp — Fannie Mae files through MICP; the servicer files directly only for non-participants (E-4.5-01)`);
      // insurer adapter (portal/EDI/e-mail per insurer); without one the filing is an operator task with proof of transmission — not yet `filed`
      const adapter = rt.ports.mi;
      const filed = adapter && str(i, "certificate") ? await adapter.fileClaim(str(i, "certificate"), claimId, [{ form: plan.package!.form, payee: plan.package!.payee, payee_instruction: plan.package!.payee_instruction, package_id: str(i, "package_id") || null, documents: plan.package!.documents }], ctx.now) : null;
      const ack = filed ? { acknowledgment_id: filed.claimId, status: filed.status, duplicate: filed.duplicate } : null;
      if (ack) {
        rt.store.put("mi_claims", claimId, { status: "filed", filed_at: now, acknowledgment_id: ack.acknowledgment_id, direct_file_due_at: plan.direct_file_due_at }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.filed", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", filed_at: now, followup_from: now, payee: plan.package!.payee, direct_file_due_at: plan.direct_file_due_at, followup_every_days: plan.followups.every_days, acknowledgment_id: ack.acknowledgment_id, filed_by: "servicer" } });
        ctx.events.append({ type: "mi.claim.acknowledged", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", acknowledgment_id: ack.acknowledgment_id, acknowledged_on: now } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "filed", on: now, source: "insurer", filer: "servicer_direct", payload: { acknowledgment_id: ack.acknowledgment_id, via: "adapter", form: plan.package!.form, payee: plan.package!.payee } });
      }
      const portalTask = ack ? null : rt.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", loanId, payload: { task_type: `insurer_portal.${str(i, "insurer_code").toLowerCase()}.file_claim`, claim_id: claimId, form: plan.package!.form, payee_instruction: plan.package!.payee_instruction, documents: plan.package!.documents, due_at: plan.direct_file_due_at, record_with: "fileDirectClaim{op=record_acknowledgment}" } }, ctx.actor);
      if (portalTask) {
        rt.store.put("mi_claims", claimId, { status: "docs_pending", filing_task_id: portalTask.id, direct_file_due_at: plan.direct_file_due_at }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.filing.tasked", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "servicer_direct", task_id: portalTask.id, direct_file_due_at: plan.direct_file_due_at } });
      }
      return { ...plan, status: ack ? "filed" : "docs_pending", acknowledgment: ack, portal_task: portalTask }; }),
    guardrails: [never("PAYEE_IS_FNMA", "15.3 rule 6 / E-4.5-01: file primary MI claims ensuring proceeds route directly to Fannie Mae (GSE Beneficiary)", (i) => str(i, "payee") !== "" && !/fannie\s*mae/i.test(str(i, "payee")), "the payee is Fannie Mae per SF CPM payee instructions"),
      never("DIRECT_ONLY_FOR_NON_PARTICIPANTS", "15.3 rule 1: Fannie Mae files when the insurer participates in MICP and the liquidation date is on/after its effective date", (i) => (str(i, "op") || "file") === "file" && flag(i, "micp_participant") && str(i, "micp_effective_date") !== "" && str(i, "liquidation_date") !== "" && str(i, "liquidation_date") >= str(i, "micp_effective_date"), "upload documents to MICP instead")] },
  // the daily MICP dashboard check (T6, T8): document requests (earlier of the Due Date and 5 BD; sev-1 on breach, late uploads keep the breach), the MICP claim
  // status observed by the operator (filed_by_fnma / perfected), the unpaid-at-settlement_due_at officer escalation, and the −3 BD officer alert guardrail
  { name: "trackDocRequests", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "claim_id");
      const claimId = str(i, "claim_id"); const loanId = loanOf(i, ctx); const now = today(i, ctx.now);
      const raw = list<Record<string, unknown>>(i.requests);
      for (const r of raw) if (!r.request_id || !r.requested_on) throw new RangeError("each MICP document request needs request_id and requested_on");
      const rows = trackDocRequests({ requests: raw.map((r) => ({ request_id: String(r.request_id), doc_kind: String(r.doc_kind ?? "other"), requested_on: D(String(r.requested_on)), micp_due_date: r.micp_due_date ? D(String(r.micp_due_date)) : null, potential_denial_date: r.potential_denial_date ? D(String(r.potential_denial_date)) : null, uploaded_on: r.uploaded_on ? D(String(r.uploaded_on)) : null }) satisfies DocRequest), today: now });
      const breaches = [];
      for (const r of rows) {
        const key = `${claimId}-${r.request_id}`; const prev = rt.store.get("mi_claim_documents", key)?.data;
        const rec = rt.store.put("mi_claim_documents", key, { claim_id: claimId, doc_kind: r.doc_kind, micp_request_id: r.request_id, requested_at: r.requested_on, due_at: r.due_at, potential_denial_date: r.potential_denial_date ?? null, uploaded_at: r.uploaded_on ?? null, status: r.status }, ctx.actor, ctx.now);
        if (!prev) {
          ctx.events.append({ type: "micp.document_request.observed", loanId, actor: ctx.actor, payload: { claim_id: claimId, micp_request_id: r.request_id, doc_kind: r.doc_kind, requested_on: r.requested_on, micp_due_at: r.due_at, potential_denial_date: r.potential_denial_date ?? null } });
          claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "doc_requested", on: r.requested_on, source: "micp", micp_request_id: r.request_id, payload: { doc_kind: r.doc_kind, due_at: r.due_at, micp_due_date: r.micp_due_date, potential_denial_date: r.potential_denial_date ?? null } });
        }
        if (r.uploaded_on && !prev?.uploaded_at) {
          ctx.events.append({ type: "micp.document_request.fulfilled", loanId, actor: ctx.actor, payload: { claim_id: claimId, micp_request_id: r.request_id, uploaded_at: r.uploaded_on, due_at: r.due_at, late: r.status === "uploaded_late" } });
          claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "doc_uploaded", on: r.uploaded_on, source: "micp", micp_request_id: r.request_id, payload: { doc_kind: r.doc_kind, due_at: r.due_at, late: r.status === "uploaded_late" } });
        }
        if (r.breach && !rec.data.breach_escalation_id) {
          const e = rt.escalations.open({ kind: "sev1", loanId, payload: { claim_id: claimId, micp_request_id: r.request_id, due_at: r.due_at, uploaded_at: r.uploaded_on ?? null, timer: r.timer, reason: r.uploaded_on ? "MICP document request fulfilled after its due date — sev-1 on record (lack of activity could result in a denial)" : "MICP document request past due — lack of activity could result in a denial" } }, ctx.actor);
          rt.store.put("mi_claim_documents", key, { breach_escalation_id: e.id }, ctx.actor, ctx.now); breaches.push(e);
        }
      }
      // the MICP claim status the operator observed on the dashboard (fnma_micp path): filed_by_fnma → `mi.claim.filed`; perfected → `mi.claim.perfected`
      const claim = rt.store.get("mi_claims", claimId)?.data ?? {};
      const observed = str(i, "micp_claim_status");
      if (observed === "filed_by_fnma" && !claim.filed_at) {
        const filedAt = optDate(i, "filed_at") ?? now;
        rt.store.put("mi_claims", claimId, { status: "filed_by_fnma", filed_at: filedAt }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.filed", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: "fnma_micp", filed_by: "fannie_mae", filed_at: filedAt, observed_in: "micp", observed_on: now } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "filed", on: filedAt, source: "fnma", filer: "fnma_micp", payload: { observed_in: "micp", observed_on: now } });
      }
      const perfected = optDate(i, "perfected_at") ?? (claim.perfected_at ? D(String(claim.perfected_at)) : null);
      if (perfected && !claim.perfected_at) {
        const settlementDays = Number(claim.settlement_days ?? 60);
        const settlementDue = settlementDays === 60 ? unpaidEscalationOn(perfected) : addDays(perfected, settlementDays);
        rt.store.put("mi_claims", claimId, { status: "perfected", perfected_at: perfected, settlement_due_at: settlementDue }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.perfected", loanId, actor: ctx.actor, payload: { claim_id: claimId, route: (claim.filer as string | undefined) ?? "fnma_micp", perfected_at: perfected, settlement_due_at: settlementDue, observed_in: "micp" } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "perfected", on: perfected, source: "micp", filer: (claim.filer as Filer | undefined) ?? "fnma_micp", payload: { settlement_due_at: settlementDue, observed_in: "micp" } });
      }
      // T8 — unpaid by settlement_due_at → officer with the documentation-complete date, follow-up dates and insurer responses (F-1-06; A1-3-02)
      const followups = [...messages(rt, claimId, "outbound").filter((m) => m.message_kind === "followup").map((m) => ({ on: D(String(m.on)), note: String(m.note) })), ...list<FollowupEntry>(i.followup_log)];
      const responses = [...messages(rt, claimId, "inbound").map((m) => ({ on: D(String(m.on)), response: String(m.response) })), ...list<InsurerResponse>(i.insurer_responses)];
      const unpaidCheck = perfected ? unpaidClaimEscalation({ perfected_at: perfected, today: now, paid: flag(i, "paid") || Boolean(claim.paid_at), settlement_days: Number(claim.settlement_days ?? 60), followup_log: followups, insurer_responses: responses }) : null;
      const unpaid = unpaidCheck?.escalation && !claim.unpaid_escalation_id ? rt.escalations.open({ kind: "officer", loanId, severity: "sev1", payload: { claim_id: claimId, ...unpaidCheck.escalation } }, ctx.actor) : null;
      if (unpaid) rt.store.put("mi_claims", claimId, { status: "advance_demand_risk", unpaid_escalation_id: unpaid.id }, ctx.actor, ctx.now);
      // guardrail — never let micp_docs_due_at pass without an officer alert at −3 BD: the daily check raises it whether or not anyone opened the upload task
      const docsDue = optDate(i, "micp_docs_due_at") ?? (claim.micp_docs_due_at ? D(String(claim.micp_docs_due_at)) : null);
      const alert = docsDue ? micpDocsOfficerAlert({ micp_docs_due_at: docsDue, today: now, uploaded: Boolean(claim.package_uploaded_at) || flag(i, "package_uploaded"), officer_alerted: Boolean(claim.officer_alert_id) }) : null;
      const officerAlert = alert?.alert_required ? rt.escalations.open({ kind: "officer", loanId, severity: "sev1", payload: { claim_id: claimId, micp_docs_due_at: docsDue, alert_on: alert.alert_on, breached: alert.breached, reason: alert.refusal } }, ctx.actor) : null;
      if (officerAlert) rt.store.put("mi_claims", claimId, { officer_alert_id: officerAlert.id, officer_alerted_on: now }, ctx.actor, ctx.now);
      return { requests: rows, breaches, micp_claim_status: observed || null, perfected_at: perfected, settlement_due_at: unpaidCheck?.settlement_due_at ?? null, unpaid_escalation: unpaid, officer_alert: officerAlert, alert_on: alert?.alert_on ?? null }; }) },
  // rule 4 / T7 / rule 7 / T9 — the stored shadow vs the EOB (variances > $250 or > 0.5% analyzed; disputed curtailments drafted for appeal); the insurer decision arms the
  // appeal window; the benefit is recorded for either payee — Fannie Mae: record and close; servicer: Dr clearing / Cr fnma_remittance_payable and a 2 BD special remittance;
  // op=record_remittance ingests the CRS confirmation that settles the special remittance (SM_MI_PROCEEDS_REMIT_2BD)
  { name: "reconcileEob", kind: "write", handler: compute((i, ctx, rt) => {
      const claimId = str(i, "claim_id"); const loanId = loanOf(i, ctx); const now = today(i, ctx.now);
      if ((str(i, "op") || "reconcile") === "record_remittance") {
        need(i, "claim_id", "code", "amount_cents", "settled_on");
        const claim = rt.store.get("mi_claims", claimId)?.data ?? {};
        const drafted = claim.remittance_drafted as { crs_code: string; amount_cents: bigint } | undefined;
        const r = remittanceSettlement({ drafted: drafted ?? null, remit_by: claim.remit_by ? D(String(claim.remit_by)) : null, code: str(i, "code"), amount_cents: cents(i.amount_cents), settled_on: date(i, "settled_on"), confirmation_id: str(i, "confirmation_id") || null });
        rt.store.put("mi_claims", claimId, { status: "closed", remitted_on: r.settled_on, remittance_confirmation_id: r.confirmation_id, remitted_on_time: r.on_time }, ctx.actor, ctx.now);
        ctx.events.append({ type: "remittance.special.settled", loanId, actor: ctx.actor, payload: { kind: "mi_benefit", code: r.code, amount_cents: r.amount_cents, settled_on: r.settled_on, loan_id: loanId, claim_id: claimId, confirmation_id: r.confirmation_id, on_time: r.on_time, remit_by: r.remit_by } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "closed", on: r.settled_on, source: "fnma", amount_cents: r.amount_cents, paid_to: "fnma", payload: { special_remittance: { code: r.code, confirmation_id: r.confirmation_id, on_time: r.on_time, remit_by: r.remit_by }, state: "remitted → closed" } });
        return { claim_id: claimId, ...r, status: "closed" };
      }
      need(i, "claim_id", "eob_benefit_cents");
      // the shadow reconciled is the stored, versioned calculation — never an agent-supplied figure (the decision record carries shadow_calc_version)
      const calcs = [...rt.store.list("mi_claim_calculations", (d) => d.claim_id === claimId)].sort((a, b) => Number(a.data.version) - Number(b.data.version));
      const calc = calcs.at(-1);
      if (!calc) throw new RangeError(`no shadow calculation for claim ${claimId} — run computeShadowClaim first`);
      const shadow = calc.data as unknown as ItemizedShadowClaim;
      const r = reconcileEob({ shadow, eob_benefit_cents: cents(i.eob_benefit_cents), curtailments: list<{ reason: string; amount_cents: unknown }>(i.curtailments).map((c) => ({ reason: c.reason, amount_cents: cents(c.amount_cents) })) });
      ctx.events.append({ type: "mi.claim.eob_received", loanId, actor: ctx.actor, payload: { claim_id: claimId, eob_benefit_cents: cents(i.eob_benefit_cents), shadow_benefit_cents: shadow.benefit_cents, shadow_calc_version: Number(calc.data.version), variance_cents: r.variance_cents, analyze: r.analyze, curtailments: r.curtailments.length, received_on: now } });
      claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "eob_received", on: now, source: "insurer", amount_cents: cents(i.eob_benefit_cents), payload: { shadow_calc_version: Number(calc.data.version), shadow_benefit_cents: shadow.benefit_cents, variance_cents: r.variance_cents, analyze: r.analyze, curtailments: r.curtailments } });
      const outcome: AppealReason | null = flag(i, "rescinded") ? "rescission" : flag(i, "denied") ? "denial" : r.curtailments.length ? "curtailment" : null;
      const claimRow = rt.store.get("mi_claims", claimId)?.data ?? {};
      const appealDays = Number(i.appeal_days ?? claimRow.appeal_days ?? 30);
      if (outcome) {
        const status = outcome === "curtailment" ? "curtailed" : outcome === "denial" ? "denied" : "rescinded";
        const curtailed = r.curtailments.reduce((s, c) => s + c.amount_cents, 0n);
        rt.store.put("mi_claims", claimId, { status, curtailment_cents: curtailed, curtailment_reasons: r.curtailments, denial_reason: str(i, "denial_reason") || null, rescission_flag: outcome === "rescission" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.decision.received", loanId, actor: ctx.actor, payload: { claim_id: claimId, outcome, notice_date: now, appeal_days: appealDays, appeal_due_at: addDays(now, appealDays), disputed_cents: r.appeal?.amount_cents ?? 0n, appeal_draft: r.appeal !== null } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: status, on: now, source: "insurer", amount_cents: outcome === "curtailment" ? curtailed : cents(i.eob_benefit_cents), reason: outcome === "curtailment" ? r.curtailments.map((c) => c.reason).join("; ") : str(i, "denial_reason") || outcome, payload: { appeal_due_at: addDays(now, appealDays), disputed_cents: r.appeal?.amount_cents ?? 0n } });
        // rule 10: a rescission goes to the officer (5.6 repurchase path) — the appeal window still runs for a rescission-relief dispute
        if (outcome === "rescission") rt.escalations.open({ kind: "officer", loanId, payload: { claim_id: claimId, reason: "MI rescission notice — 5.6/Selling Guide repurchase path unless the servicing file evidences rescission-relief eligibility (36/60-month rules), then appeal (rule 10)", appeal_due_at: addDays(now, appealDays) } }, ctx.actor);
      }
      const payee = (str(i, "paid_to") || (flag(i, "paid_to_servicer") ? "servicer" : "")) as BenefitPayee | "";
      let receipt = null;
      if (payee === "fnma" || payee === "servicer") {
        const receivedOn = optDate(i, "received_on") ?? now;
        receipt = benefitReceipt({ claim_id: claimId, loan_id: loanId, amount_cents: i.paid_benefit_cents === undefined ? cents(i.eob_benefit_cents) : cents(i.paid_benefit_cents), received_on: receivedOn, payee, custodial_account_id: str(i, "custodial_account_id") || "custodial-clearing", net_against_advances: flag(i, "net_against_advances") });
        const set = receipt.ledger ? ctx.ledger.post(receipt.ledger, ctx.now) : null;
        const amount = receipt.remittance?.amount_cents ?? (i.paid_benefit_cents === undefined ? cents(i.eob_benefit_cents) : cents(i.paid_benefit_cents));
        rt.store.put("mi_claims", claimId, { paid_benefit_cents: amount, paid_at: receivedOn, paid_to: payee, status: receipt.next_status, remit_by: receipt.remit_by, ledger_set_id: set?.id ?? null, remittance_drafted: receipt.remittance ? { crs_code: receipt.remittance.crs_code, amount_cents: receipt.remittance.amount_cents } : null }, ctx.actor, ctx.now);
        // 'until paid': the weekly follow-up cycle of a direct claim ends with the benefit
        const followupsEnded = cancelOpen(ctx, "SM_MI_SETTLEMENT_FOLLOWUP_7", loanId, `benefit of ${amount} cents received by ${payee} on ${receivedOn} — weekly follow-ups end (F-1-06 Ensuring Timely Settlement)`);
        ctx.events.append({ type: "mi.claim.benefit_received", loanId, actor: ctx.actor, payload: { claim_id: claimId, payee, amount_cents: amount, received_on: receivedOn, custodial_entry: receipt.custodial_entry, remit_by: receipt.remit_by, timer: receipt.timer, followups_ended: followupsEnded } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "paid", on: receivedOn, source: payee === "fnma" ? "fnma" : "servicer", amount_cents: amount, paid_to: payee, payload: { custodial_entry: receipt.custodial_entry, ledger_set_id: set?.id ?? null, remit_by: receipt.remit_by } });
        if (receipt.remittance && set) ctx.events.append({ type: "remittance.special.drafted", loanId, actor: ctx.actor, payload: { claim_id: claimId, kind: "mi_benefit", code: receipt.remittance.crs_code, code_verified: receipt.remittance.crs_code_verified, payee: receipt.remittance.payee, amount_cents: receipt.remittance.amount_cents, remit_by: receipt.remit_by, ledger_set_id: set.id, netted: false } });
        if (receipt.next_status === "closed") claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "closed", on: receivedOn, source: "fnma", amount_cents: amount, paid_to: "fnma", payload: { basis: "benefit paid to Fannie Mae — no custodial entry; EOB recorded (rule 7)" } });
      }
      return { ...r, shadow_calc_version: Number(calc.data.version), decision_outcome: outcome, receipt }; }),
    guardrails: [never("NEVER_NET_PROCEEDS", "15.3 edge case: a benefit received by the servicer is remitted within 2 BD and never netted against advances", (i) => flag(i, "net_against_advances"), "special remittance of the full benefit (SM_MI_PROCEEDS_REMIT_2BD)")] },
  // rule 5 — the daily curtailment monitor: opens the MI default watch (master policy §53) when the second consecutive missed payment is unpaid, ingests the insurer's
  // NOD / monthly-status acceptances (closing MI_MP_NOD_25TH, rolling MI_MP_STATUS_MONTHLY_25TH), observes 13.x's scheduled sale and asserts the premium-paid-through
  // gate, asserts the 36-month cap gate, writes the `mi_curtailment_risk` projection row; ≥ 0.6 opens the foreclosure-ops diligence-evidence task; 30 months → officer briefing (T12)
  { name: "scoreCurtailmentRisk", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "fcl_days_used", "fcl_days_allowable");
      const loanId = str(i, "loan_id"); const asOf = today(i, ctx.now); const upb = cents(i.upb_cents); const rate = str(i, "note_rate_pct") || "0";
      const inDefault = i.in_default !== false;
      // 1. the MI default watch: first observation of the second consecutive missed payment unpaid → the NOD, monthly-status and 36-month-cap clocks
      let watch = rt.store.get("mi_default_watch", loanId)?.data;
      const firstUnpaidIn = optDate(i, "first_unpaid_due_date") ?? optDate(i, "default_date"); const secondIn = optDate(i, "second_missed_payment_due");
      let started: DomainEvent | null = null;
      if (!watch && inDefault && (firstUnpaidIn || secondIn)) {
        const d = miDefaultStart({ first_unpaid_due_date: firstUnpaidIn, second_missed_payment_due: secondIn });
        rt.store.put("mi_default_watch", loanId, { loan_id: loanId, insurer_code: str(i, "insurer_code") || null, ...d, started_on: asOf, in_default: true }, ctx.actor, ctx.now);
        started = ctx.events.append({ type: "mi.default.started", loanId, actor: ctx.actor, payload: { loan_id: loanId, insurer_code: str(i, "insurer_code") || null, ...d, default_date: d.first_unpaid_due_date, detected_on: asOf } });
        watch = rt.store.get("mi_default_watch", loanId)!.data;
      }
      // 2. the insurer's default-report acceptances (NOD by the 25th, monthly updates) ingested from the default-reporting channel
      const reports = ingestDefaultReports({ records: list<DefaultReportRecord>(i.default_reports), upb_cents: upb, note_rate_pct: rate });
      const accepted: DomainEvent[] = []; const statusCycles: { closed: { id: string; status: string }[]; rearmed: { id: string; due_date: PlainDate | null } | null }[] = [];
      let nodLateDays = Number(i.nod_late_days ?? 0); let nodExcluded = 0n;
      for (const r of reports) {
        const key = `${loanId}-${r.key}`; const prev = rt.store.get("mi_default_reports", key)?.data;
        rt.store.put("mi_default_reports", key, { loan_id: loanId, ...r, source: str(i, "default_report_source") || "insurer_channel" }, ctx.actor, ctx.now);
        if (r.kind === "nod") { nodLateDays = r.days_late; nodExcluded = r.excluded_interest_cents; }
        if (!r.accepted || prev?.accepted) continue;
        const closed = r.kind === "monthly_status" ? closeRecurring(ctx, "MI_MP_STATUS_MONTHLY_25TH", loanId) : [];
        const e = ctx.events.append({ type: "mi.default_report.accepted", loanId, actor: ctx.actor, payload: { loan_id: loanId, kind: r.kind, period: r.period, due_on: r.due_on, reported_on: r.reported_on, accepted_on: r.accepted_on, late: r.late, days_late: r.days_late, excluded_interest_cents: r.excluded_interest_cents, report_due_on: r.report_due_on, insurer_ref: r.insurer_ref } });
        if (r.kind === "monthly_status") { recordSatisfied(ctx, closed, e); const next = inDefault ? rearm(ctx, "MI_MP_STATUS_MONTHLY_25TH", e) : null; statusCycles.push({ closed: closed.map((t) => ({ id: t.id, status: t.status })), rearmed: next ? { id: next.id, due_date: next.dueDate ?? null } : null }); }
        accepted.push(e);
      }
      if (!inDefault && watch && watch.in_default !== false) { cancelOpen(ctx, "MI_MP_STATUS_MONTHLY_25TH", loanId, `loan no longer in default as of ${asOf} — monthly status reporting ends (master policy §53)`); rt.store.put("mi_default_watch", loanId, { in_default: false, default_ended_on: asOf }, ctx.actor, ctx.now); }
      // 3. 13.x's scheduled sale on an MI-insured loan → the premium-paid-through gate (SM_MI_PREMIUM_PAID_THROUGH_GATE): closed → sale package flagged, premium advanced (Section 10)
      let saleGate: Record<string, unknown> | null = null; let premiumGap = flag(i, "premium_gap");
      const sale = optDate(i, "scheduled_sale_date");
      if (sale) {
        const key = `${loanId}-${sale}`; const seen = rt.store.get("mi_scheduled_sales", key)?.data;
        const facts = { premium_paid_through: str(i, "premium_paid_through") || null, scheduled_sale_date: sale, liquidation_month: sale.slice(0, 7) };
        if (!seen) {
          rt.store.put("mi_scheduled_sales", key, { loan_id: loanId, observed_on: asOf, ...facts }, ctx.actor, ctx.now);
          ctx.events.append({ type: "foreclosure.sale.scheduled", loanId, actor: ctx.actor, payload: { loan_id: loanId, mi_insured: true, scheduled_sale_date: sale, sale_at: sale, premium_paid_through: facts.premium_paid_through, liquidation_month: facts.liquidation_month, source: "foreclosure_timelines (13.x) observed by the 15.3 curtailment monitor", observed_on: asOf } });
        }
        const g = evaluateGate("15.3.premiumPaidThroughLiquidationMonth", facts);
        saleGate = { timer: "SM_MI_PREMIUM_PAID_THROUGH_GATE", evaluator: "15.3.premiumPaidThroughLiquidationMonth", open: g.open, reason: g.reason ?? null, ...facts, flag: null };
        if (!g.open) {
          premiumGap = true;
          const flagged = seen?.flag_id ? null : rt.escalations.open({ kind: "sev2", ownerRole: "pmi", loanId, severity: "sev2", payload: { timer: "SM_MI_PREMIUM_PAID_THROUGH_GATE", gate: "15.3.premiumPaidThroughLiquidationMonth", scheduled_sale_date: sale, premium_paid_through: facts.premium_paid_through, reason: g.reason, action: "sale package flagged — advance the MI renewal premium through the liquidation month (Section 10; F-1-05) before the sale package" } }, ctx.actor);
          if (flagged) { rt.store.put("mi_scheduled_sales", key, { flag_id: flagged.id, gate_open: false }, ctx.actor, ctx.now); saleGate.flag = flagged; }
        } else rt.store.put("mi_scheduled_sales", key, { gate_open: true }, ctx.actor, ctx.now);
      }
      // 4. the 36-month interest/advance cap (MI_MP_INTEREST_CAP_36M): the watch anchored on the first unpaid due date, the gate asserted on the accrual as of the run
      const cap = str(i, "accrual_from") ? interestCapWatch({ accrual_from: date(i, "accrual_from"), default_date: optDate(i, "default_date") ?? (watch?.first_unpaid_due_date ? D(String(watch.first_unpaid_due_date)) : null), as_of: asOf, upb_cents: upb, note_rate_pct: rate, resolved: flag(i, "resolved"), judicial: flag(i, "judicial"), projected_resolution_on: optDate(i, "projected_resolution_on") }) : null;
      const firstUnpaid = watch?.first_unpaid_due_date ? D(String(watch.first_unpaid_due_date)) : firstUnpaidIn;
      const capFacts = firstUnpaid ? interestCapFacts({ first_unpaid_due_date: firstUnpaid, interest_to: asOf }) : null;
      const capGate = capFacts ? { timer: "MI_MP_INTEREST_CAP_36M", evaluator: "15.3.interestWithinCap", not_after: capFacts.not_after, ...evaluateGate("15.3.interestWithinCap", capFacts) } : null;
      // 5. monthly status gaps (rule 5): current when the report due on the latest 25th at or before the run has been accepted
      const statusCurrent = i.status_reports_current !== undefined ? flag(i, "status_reports_current") : watch ? statusReportsCurrent({ reports: rt.store.list("mi_default_reports", (d) => d.loan_id === loanId).map((r) => ({ due_on: D(String(r.data.due_on)), accepted: Boolean(r.data.accepted) })), nod_due: D(String(watch.nod_due)), as_of: asOf }) : true;
      // 6. the projection row
      const { row, monitor } = curtailmentRiskRow({ loan_id: loanId, as_of: asOf, nod_late_days: nodLateDays, status_reports_current: statusCurrent, fcl_days_used: num(i, "fcl_days_used"), fcl_days_allowable: num(i, "fcl_days_allowable"), allowable_delays: Number(i.allowable_delays ?? 0), interest_months: cap ? cap.months_accrued : Number(i.interest_months ?? 0), property_condition_flags: Number(i.property_condition_flags ?? 0), docs_ready_pct: i.docs_ready_pct === undefined ? (i.docs_ready === false ? 0 : 100) : num(i, "docs_ready_pct"), premium_gap: premiumGap, upb_cents: upb, note_rate_pct: rate });
      const rec = rt.store.put("mi_curtailment_risk", `${loanId}-${asOf}`, { ...row, cap_months_remaining: cap ? cap.cap_months_remaining : row.cap_months_remaining, daily_interest_at_risk_cents: monitor.daily_interest_at_risk_cents, excess_interest_at_risk_cents: monitor.excess_interest_at_risk_cents, nod_excluded_interest_cents: nodExcluded, interest_cap_open: capGate ? capGate.open : null, premium_gate_open: saleGate ? saleGate.open : null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "mi_curtailment_risk.projected", loanId, actor: ctx.actor, payload: { as_of: asOf, risk_score: row.risk_score, projected_excess_days: row.projected_excess_days, nod_on_time: row.nod_on_time, status_reports_current: statusCurrent, premium_gap: premiumGap, cap_months_remaining: rec.data.cap_months_remaining } });
      const task = monitor.task ? rt.escalations.open({ kind: "human_agent", ownerRole: "foreclosure-ops", loanId, payload: { kind: monitor.task.kind, projected_excess_days: monitor.projected_excess_days, risk_score: monitor.score, excess_interest_at_risk_cents: monitor.excess_interest_at_risk_cents, reason: "document diligent-servicing evidence (court delays, bankruptcy, mediation) so the delay is 'despite diligent servicing'; feeds the A1-4.2-02 rebuttal" } }, ctx.actor) : null;
      const briefing = cap?.briefing ? rt.escalations.open({ kind: "officer", loanId, payload: { ...cap.briefing } }, ctx.actor) : null;
      return { ...monitor, row: rec.data, interest_cap: cap, interest_cap_gate: capGate, sale_gate: saleGate, default_started: started ? started.payload : null, default_reports: reports, accepted_reports: accepted.map((e) => e.payload), status_cycles: statusCycles, nod_excluded_interest_cents: nodExcluded, diligence_task: task, officer_briefing: briefing }; }) },
  // T7 / open question 4 — appeals: agent ≤ $10,000; human_agent review above (op=approve by the reviewer; submit / op=file / the operator's MICP result all check it); rescissions → officer (+ attorney on a relief dispute)
  { name: "draftAppeal", kind: "act", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "draft";
      const claimId = str(i, "claim_id"); const loanId = loanOf(i, ctx); const now = today(i, ctx.now);
      if (op === "approve") {
        need(i, "appeal_id");
        const a = rt.store.require("mi_claim_appeals", str(i, "appeal_id")).data;
        if (a.status === "filed") throw new RangeError(`appeal ${str(i, "appeal_id")} is already filed`);
        const rec = rt.store.put("mi_claim_appeals", str(i, "appeal_id"), { status: "approved", approved_by: `${ctx.actor.kind}:${ctx.actor.id}`, approved_role: ctx.actor.role ?? null, approved_on: now }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.appeal.approved", loanId, actor: ctx.actor, payload: { claim_id: String(a.claim_id), appeal_id: str(i, "appeal_id"), amount_cents: cents(a.amount_cents), approved_by: `${ctx.actor.kind}:${ctx.actor.id}`, approved_on: now } });
        return rec.data;
      }
      if (op === "file") {
        need(i, "appeal_id");
        const a = rt.store.require("mi_claim_appeals", str(i, "appeal_id")).data;
        if (a.status === "filed") throw new RangeError(`appeal ${str(i, "appeal_id")} is already filed`);
        const check = appealSubmissionCheck({ amount_cents: cents(a.amount_cents), approval: a.approval as "agent" | "human_agent" | "officer", status: String(a.status), actor_is_reviewer: hasRole(ctx.actor, REVIEWERS) });
        if (!check.allowed) refuse(ctx, "draftAppeal", "APPEAL_OVER_10K_HUMAN_REVIEW", "15.3 guardrail: appeals are drafted by the agent and approved by a human_agent reviewer when the amount > $10,000", check.refusal!, loanId);
        const cid = String(a.claim_id);
        const rec = rt.store.put("mi_claim_appeals", str(i, "appeal_id"), { status: "filed", filed_at: now, filed_by: `${ctx.actor.kind}:${ctx.actor.id}`, via: str(i, "via") || "insurer" }, ctx.actor, ctx.now);
        rt.store.put("mi_claims", cid, { status: "appeal" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.appeal.filed", loanId, actor: ctx.actor, payload: { claim_id: cid, appeal_id: str(i, "appeal_id"), amount_cents: cents(a.amount_cents), reason: String(a.reason), exhibits: list<string>(a.exhibits), approved_by: (a.approved_by as string | undefined) ?? (a.approval === "agent" ? "agent" : `${ctx.actor.kind}:${ctx.actor.id}`) } });
        claimEvent(rt, ctx, { claim_id: cid, loan_id: loanId, kind: "appealed", on: now, source: "agent", amount_cents: cents(a.amount_cents), reason: String(a.reason), payload: { appeal_id: str(i, "appeal_id"), exhibits: list<string>(a.exhibits) } });
        return rec.data;
      }
      need(i, "claim_id", "reason", "amount_cents");
      const routing = appealRouting({ reason: str(i, "reason") as AppealReason, amount_cents: cents(i.amount_cents), rescission_relief_evidenced: flag(i, "rescission_relief_evidenced") });
      if (routing.route === "officer_repurchase_path") return rt.escalations.open({ kind: "officer", loanId, payload: { claim_id: claimId, reason: routing.refusal } }, ctx.actor);
      const submit = flag(i, "submit");
      const status = submit ? "filed" : routing.approval === "agent" ? "ready_to_file" : "awaiting_human_agent_review";
      if (submit) { const check = appealSubmissionCheck({ amount_cents: cents(i.amount_cents), approval: routing.approval, status: routing.approval === "agent" ? "ready_to_file" : "awaiting_human_agent_review", actor_is_reviewer: hasRole(ctx.actor, REVIEWERS) }); if (!check.allowed) refuse(ctx, "draftAppeal", "APPEAL_OVER_10K_HUMAN_REVIEW", "15.3 guardrail: appeals are drafted by the agent and approved by a human_agent reviewer when the amount > $10,000", check.refusal!, loanId); }
      const rec = rt.store.put("mi_claim_appeals", `${claimId}-appeal-${ctx.now}`, { claim_id: claimId, loan_id: loanId, reason: str(i, "reason"), amount_cents: cents(i.amount_cents), exhibits: list<string>(i.exhibits), basis: str(i, "basis"), drafted_by: routing.drafted_by, approval: routing.approval, attorney_review: routing.attorney_review, status, filed_at: submit ? now : null, drafted_on: now }, ctx.actor, ctx.now);
      const reviewTask = !submit && routing.approval === "human_agent" ? rt.escalations.open({ kind: "human_agent", loanId, payload: { claim_id: claimId, appeal_id: rec.id, amount_cents: cents(i.amount_cents), reason: "appeal over $10,000 needs human_agent approval (draftAppeal{op=approve}) before it is filed" } }, ctx.actor) : null;
      const attorney = routing.attorney_review ? rt.escalations.open({ kind: "attorney", loanId, payload: { claim_id: claimId, appeal_id: rec.id, reason: "rescission dispute — rescission-relief eligibility (36/60-month rules) evidenced in the servicing file; attorney review of the appeal (agents paragraph: attorney for rescission disputes)" } }, ctx.actor) : null;
      if (submit) {
        rt.store.put("mi_claims", claimId, { status: "appeal" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "mi.claim.appeal.filed", loanId, actor: ctx.actor, payload: { claim_id: claimId, appeal_id: rec.id, amount_cents: cents(i.amount_cents), reason: str(i, "reason"), exhibits: list<string>(i.exhibits), approved_by: routing.approval === "agent" ? "agent" : `${ctx.actor.kind}:${ctx.actor.id}` } });
        claimEvent(rt, ctx, { claim_id: claimId, loan_id: loanId, kind: "appealed", on: now, source: "agent", amount_cents: cents(i.amount_cents), reason: str(i, "reason"), payload: { appeal_id: rec.id, exhibits: list<string>(i.exhibits) } });
      }
      return { ...rec.data, id: rec.id, review_task: reviewTask, attorney_review_task: attorney }; }),
    guardrails: [needsRole("APPEAL_OVER_10K_HUMAN_REVIEW", "15.3 guardrail: appeals are drafted by the agent and approved by a human_agent reviewer when the amount > $10,000", (i) => (str(i, "op") || "draft") === "draft" && flag(i, "submit") && cents(i.amount_cents) > 1_000_000n, ["human_agent", "officer"], "the reviewer approves the filing"),
      needsRole("APPEAL_APPROVAL_IS_HUMAN", "15.3 guardrail: the human_agent reviewer approves appeals over $10,000 — the agent cannot approve its own draft", (i) => str(i, "op") === "approve", ["human_agent", "officer"], "approval is the reviewer's act"),
      never("RESCISSION_IS_NOT_AN_APPEAL", "15.3 rule 10: a rescission for origination misrepresentation is the 5.6 repurchase path (officer), not an appeal by this process", (i) => str(i, "reason") === "rescission" && flag(i, "submit") && !flag(i, "rescission_relief_evidenced"), "route to the officer; appeal only with rescission-relief evidence (36/60-month rules)")] },
  // rule 9 — shortfall attribution and the A1-3-02 exposure record (memo `contingent_make_whole_fnma` until demanded); conveyance defects → attorney
  { name: "attributeShortfall", kind: "write", moneyFields: ["servicer_caused_shortfall_cents"], handler: compute((i, ctx, rt) => {
      need(i, "claim_id", "cause", "amount_cents");
      const claimId = str(i, "claim_id"); const loanId = loanOf(i, ctx);
      const r = attributeShortfall({ cause: str(i, "cause") as ShortfallCause, amount_cents: cents(i.amount_cents), timeline_evidence_reviewed: flag(i, "timeline_evidence_reviewed"), diligence_evidenced: flag(i, "diligence_evidenced") });
      const attorney = r.escalate_to === "attorney" ? rt.escalations.open({ kind: "attorney", loanId, payload: { claim_id: claimId, cause: str(i, "cause"), amount_cents: cents(i.amount_cents), reason: "conveyance defect behind the MI shortfall — attorney review (agents paragraph: attorney for conveyance defects)" } }, ctx.actor) : null;
      const rec = rt.store.put("mi_claim_shortfalls", `${claimId}-${str(i, "cause")}`, { claim_id: claimId, loan_id: loanId, cause: str(i, "cause"), amount_cents: cents(i.amount_cents), ...r, timeline_evidence_reviewed: flag(i, "timeline_evidence_reviewed"), timeline_evidence: i.timeline_evidence ?? null, attorney_task_id: attorney?.id ?? null, demanded: false }, ctx.actor, ctx.now);
      if (r.exposure) rt.store.put("mi_claims", claimId, { status: "shortfall_assessed", servicer_caused_shortfall_cents: r.servicer_caused_shortfall_cents }, ctx.actor, ctx.now);
      ctx.events.append({ type: "mi.claim.shortfall.attributed", loanId, actor: ctx.actor, payload: { claim_id: claimId, cause: str(i, "cause"), attribution: r.attribution, servicer_caused_shortfall_cents: r.servicer_caused_shortfall_cents, exposure: r.exposure, memo_account: r.memo_account, rule_ref: r.rule_ref, attorney_task_id: attorney?.id ?? null } });
      return { ...rec.data, attorney_task: attorney }; }),
    guardrails: [never("NO_SERVICER_CAUSED_WITHOUT_TIMELINE_REVIEW", "15.3 guardrail: never concede a curtailment as servicer-caused without the timeline evidence review", (i) => SERVICER_CAUSES.has(str(i, "cause") as ShortfallCause) && !flag(i, "timeline_evidence_reviewed"), "review the cause's timeline evidence first (default reporting, MICP requests, 571 request, 13.x foreclosure timeline, conveyance chronology, premium netting)")] },
  { name: "recordDecision", kind: "write", handler: decision() },
]);

/** Reads the tools file keeps for the human path (not spec tool strings; exported for the ops console). */
export const READS_15_3 = { claims: read("mi_claims"), calculations: read("mi_claim_calculations"), curtailment_risk: read("mi_curtailment_risk"), claim_events: read("mi_claim_events"), default_reports: read("mi_default_reports") } as const;
