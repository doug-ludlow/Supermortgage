/**
 * §23.1 process-owned tools — bus tools for 23.1 defined with `defineTools("23.1", "underwriter", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 23.1; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `underwriter` profile (spec "AI agent design"): buildDuRequest, associateCredit, submitCasefile, fetchFindings,
 * evaluateResubmission, snapshotClosedLoan, assertFinalSubmissionMatches, writeDecision, openEscalation. State lives in
 * the entity store (`du_casefiles`, `du_submissions`, `du_resubmission_checks`); events go through ops-23-1.ts so the
 * archival clocks, the final-match gate and 22.5's resubmission SLA arm and close. The DU adapter is the `fnma-du`
 * service (a port defined in ops-23-1.ts — the Direct Integration transport is UNVERIFIED login-gated material).
 * Guardrails encode the paragraph: never edit ULAD data except from a `verifications`/`documents`/`changed_circumstances`
 * source; never suppress a liability or income change to stay within tolerance; never submit without a report for every
 * borrower; never mix score models; never exceed the resubmission cap without `underwriting_reviewer`; never disclose
 * findings to the borrower; the DU UI fallback is a `fnma_portal_operator` act.
 */
import { defineTools, compute, escalate, decision, never, needsRole, humanWhen, service, str, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { CreditReport } from "../../domain/verification/ops-22-2.ts";
import { buildDuRequest, associateCredit, submitCasefile, receiveFindings, ingestOperatorFindings, evaluateResubmission, closedLoanSnapshotHash, closedLoanData, assertFinalSubmissionMatches, recordFinalSubmission, decisionRecord, RESUBMISSION_REVIEW_AFTER, RESUBMISSION_RATIONALE_AFTER,
  type DuCasefile, type DuSubmission, type DuPort, type DuRequest, type DuFindings, type UladSnapshot, type BorrowerIdentity, type SubmissionType, type SubmissionReason, type ReturnFileType, type ScoreModel } from "../../domain/underwriting/ops-23-1.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`23.1 tool needs ${missing.join(", ")}`); };
const SNAPSHOT_CENTS = ["sales_price_cents", "appraised_value_cents", "loan_amount_cents", "subordinate_liens_cents", "heloc_limit_cents", "qualifying_income_cents", "total_obligations_cents", "verified_reserves_cents"] as const;
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as T; };
const snapshotIn = (i: ToolInput, k = "snapshot"): UladSnapshot => { const s = i[k]; if (!s || typeof s !== "object") throw new RangeError(`23.1 tool needs ${k} (the ULAD snapshot)`); return bigints(s as UladSnapshot, SNAPSHOT_CENTS); };
const casefileIn = (i: ToolInput, rt: ToolRuntime): DuCasefile => { if (i.casefile && typeof i.casefile === "object") return i.casefile as DuCasefile; need(i, "casefile_id"); return rt.store.require("du_casefiles", str(i, "casefile_id")).data as unknown as DuCasefile; };
const submissionsOf = (i: ToolInput, rt: ToolRuntime, cf: DuCasefile): DuSubmission[] => (Array.isArray(i.prior) ? (i.prior as DuSubmission[]) : rt.store.list("du_submissions", (d) => d.casefile_id === cf.casefile_id).map((r) => r.data as unknown as DuSubmission).sort((a, b) => a.submission_number - b.submission_number));
const persist = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: object) => rt.store.put(kind, id, data as Record<string, unknown>, ctx.actor, ctx.now);
const dateIn = (i: ToolInput, k: string): PlainDate | null => (typeof i[k] === "string" && i[k] ? D(str(i, k)) : null);
const port = (rt: ToolRuntime): DuPort => service<DuPort>(rt, "fnma-du");
const NO_ULAD_EDIT = never("ULAD_EDIT_WITHOUT_SOURCE", "23.1 guardrails: never edit ULAD data except from a `verifications`/`documents`/`changed_circumstances` source", (i) => i.ulad_edits !== undefined && !i.source_ref, "a ULAD diff carries its verifications / documents / changed_circumstances source_ref");
const NO_SUPPRESSION = never("CHANGE_SUPPRESSED", "23.1 guardrails: never suppress a liability or income change to stay within tolerance; 'Data may never be changed to obtain a better recommendation'", (i) => i.suppress_change === true || i.exclude_liability === true || i.omit_income_change === true, "every liability / income change is evaluated and carried into the final closed-loan submission (rule 5)");
const NO_BORROWER_FINDINGS = never("FINDINGS_NOT_BORROWER_FACING", "23.1 guardrails: never disclose findings to the borrower (Fannie Mae-confidential; reasons reach the borrower via 21.6 notices)", (i) => i.deliver_to_borrower === true || i.recipient === "borrower" || i.channel === "borrower_portal", "DU findings are not borrower-deliverable");

export const TOOLS_23_1: readonly ToolDef[] = defineTools("23.1", "underwriter", [
  { name: "buildDuRequest", kind: "act", handler: compute((i, ctx, rt) => {
    const cf = casefileIn(i, rt); const snapshot = snapshotIn(i);
    const t = (str(i, "submission_type") || "credit_and_underwriting") as SubmissionType, reason = (str(i, "reason") || "initial") as SubmissionReason;
    const req = buildDuRequest(cf, { submission_type: t, reason, built_at: (i.built_at as string | undefined) ?? ctx.now, snapshot, ...(Array.isArray(i.return_file_types) ? { return_file_types: i.return_file_types as ReturnFileType[] } : {}), ...(Array.isArray(i.validation_report_refs) ? { validation_report_refs: i.validation_report_refs as DuRequest["validation_report_refs"] } : {}), prior_submission_number: cf.submission_count || null });
    return { request: req, request_hash: req.request_hash, return_file_types: req.return_file_types, mismo_version: req.mismo_version };
  }), guardrails: [NO_ULAD_EDIT, never("REPORT_FOR_EVERY_BORROWER", "23.1 guardrails: never submit without a report for every borrower", (i) => i.skip_credit_association === true, "every borrower's credit report is associated before an underwriting submission")] },
  { name: "associateCredit", kind: "act", handler: compute((i, ctx, rt) => {
    const cf = casefileIn(i, rt); need(i, "reports", "borrowers");
    const r = associateCredit(ctx.events, cf, { reports: i.reports as CreditReport[], borrowers: i.borrowers as BorrowerIdentity[], app_score_model: (i.app_score_model as ScoreModel | undefined) ?? cf.score_model, at: ctx.now }, ctx.actor);
    persist(rt, ctx, "du_casefiles", cf.casefile_id, r.casefile);
    return { casefile: r.casefile, event: r.event.type };
  }), guardrails: [never("SCORE_MODEL_MIXED", "23.1 guardrails: never mix score models (DU 12.1 VantageScore 4.0 Update, Sept 9, 2026; LL-2026-06)", (i) => Array.isArray(i.reports) && new Set((i.reports as { score_model?: string }[]).map((r) => r.score_model)).size > 1, "one credit score model for all borrowers on the casefile — 22.2 re-orders")] },
  { name: "submitCasefile", kind: "act", handler: compute(async (i, ctx, rt) => {
    const cf = casefileIn(i, rt); need(i, "request");
    const req = i.request as DuRequest; const prior = submissionsOf(i, rt, cf);
    const r = await submitCasefile(ctx.events, port(rt), cf, { request: req, at: ctx.now, prior, projected_note_date: dateIn(i, "projected_note_date"), scif_facts: (i.scif_facts as Record<string, unknown> | undefined) ?? {}, ...(Array.isArray(i.relied_documents) ? { relied_documents: i.relied_documents as never[] } : {}), rationale: (i.rationale as string | undefined) ?? null, reviewer_approval_ref: (i.reviewer_approval_ref as string | undefined) ?? null, agent_run_id: ctx.run?.runId ?? null, escalations: rt.escalations }, ctx.actor);
    persist(rt, ctx, "du_casefiles", cf.casefile_id, r.casefile); persist(rt, ctx, "du_submissions", r.submission.submission_id, r.submission);
    return { submission: r.submission, casefile: r.casefile, outage: r.outage ? { attempts: r.outage.attempts, escalation_id: r.outage.escalation?.id ?? null, declared_at: r.outage.declared_at } : null, events: r.events.map((e) => e.type) };
  }), guardrails: [NO_ULAD_EDIT, NO_SUPPRESSION,
    never("REPORT_FOR_EVERY_BORROWER", "23.1 guardrails: never submit without a report for every borrower", (i) => i.skip_credit_association === true || i.borrowers_without_report === true, "every borrower's credit report is associated before submission"),
    never("RESUBMISSION_CAP_REVIEW", `23.1 rule 6 / B3-2-11 excessive resubmissions: never exceed the resubmission cap (${RESUBMISSION_REVIEW_AFTER}) without underwriting_reviewer`, (i) => Number((i.casefile as { submission_count?: number } | undefined)?.submission_count ?? i.submission_count ?? 0) >= RESUBMISSION_REVIEW_AFTER && !i.reviewer_approval_ref, "underwriting_reviewer review (reviewer_approval_ref) is required before the next submission"),
    never("RESUBMISSION_RATIONALE_REQUIRED", `23.1 rule 6: after the ${RESUBMISSION_RATIONALE_AFTER}th submission a rationale is attached to each further submission`, (i) => Number((i.casefile as { submission_count?: number } | undefined)?.submission_count ?? i.submission_count ?? 0) >= RESUBMISSION_RATIONALE_AFTER && !i.rationale, "a rationale traces the diff to a verifications / documents / changed_circumstances row"),
    humanWhen("DU_UI_FALLBACK_IS_OPERATOR_ACT", "23.1 state machine: `fnma_portal_operator` may perform `submitted` via the DU UI fallback with the same request artifact", (i) => i.via === "du_ui_fallback", "the DU web UI upload is performed by fnma_portal_operator with the SM-generated request file (no scraping/RPA)")] },
  { name: "fetchFindings", kind: "act", handler: compute(async (i, ctx, rt) => {
    const cf = casefileIn(i, rt); const prior = submissionsOf(i, rt, cf);
    if (i.op === "ingest_operator_upload") {
      need(i, "findings");
      const r = ingestOperatorFindings(ctx.events, cf, prior, bigints(i.findings as DuFindings, ["reserves_required_cents", "total_funds_to_verify_cents", "loan_amount_cents"]), ctx.actor);
      persist(rt, ctx, "du_casefiles", cf.casefile_id, r.casefile); persist(rt, ctx, "du_submissions", r.submission.submission_id, r.submission);
      return { submission: r.submission, casefile: r.casefile, recommendation: r.submission.recommendation };
    }
    need(i, "submission_number");
    const sub = prior.find((s) => s.submission_number === Number(i.submission_number)); if (!sub) throw new RangeError(`23.1 fetchFindings: no du_submissions row ${String(i.submission_number)} on casefile ${cf.casefile_id}`);
    const f = await port(rt).fetchFindings(cf.casefile_id, sub.submission_number);
    const r = receiveFindings(ctx.events, cf, sub, f, ctx.actor);
    persist(rt, ctx, "du_casefiles", cf.casefile_id, r.casefile); persist(rt, ctx, "du_submissions", r.submission.submission_id, r.submission);
    return { submission: r.submission, casefile: r.casefile, recommendation: r.submission.recommendation, messages: r.submission.messages, hand_off: { "23.2": "findings interpretation", "24.1": "value_acceptance_offer", "24.6": "mi_requirement", "22.4": "reserves_required_cents" } };
  }), guardrails: [NO_BORROWER_FINDINGS, humanWhen("OPERATOR_UPLOAD_IS_HUMAN_ACT", "23.1 T13: the operator-uploaded findings are ingested and matched to the queued du_submissions row by casefile ID", (i) => i.op === "ingest_operator_upload", "operator-uploaded findings come from fnma_portal_operator")] },
  { name: "evaluateResubmission", kind: "act", handler: compute((i, ctx, rt) => {
    const cf = casefileIn(i, rt); need(i, "baseline", "trigger_event");
    const baseline = i.baseline as DuSubmission; const candidate = snapshotIn(i, "candidate");
    const r = evaluateResubmission(ctx.events, cf, { baseline: { ...baseline, snapshot: bigints(baseline.snapshot, SNAPSHOT_CENTS) }, candidate, trigger_event: str(i, "trigger_event"), at: ctx.now, reserves_required_cents: i.reserves_required_cents === undefined ? null : cents(i.reserves_required_cents), verified_reserves_cents: i.verified_reserves_cents === undefined ? null : cents(i.verified_reserves_cents), credit_report_updated: i.credit_report_updated === true, validation_report_updated: i.validation_report_updated === true, credit_expires_at: dateIn(i, "credit_expires_at"), projected_note_date: dateIn(i, "projected_note_date") }, ctx.actor);
    for (const c of r.checks) persist(rt, ctx, "du_resubmission_checks", c.id, c);
    if (r.casefile_status !== cf.status) persist(rt, ctx, "du_casefiles", cf.casefile_id, { ...cf, status: r.casefile_status });
    return { result: r.result, rule_codes: r.rule_codes, reason: r.reason, arithmetic: r.arithmetic, checks: r.checks, submission_blocked: r.submission_blocked, restructure_hand_off: r.restructure_hand_off, ami_retest: r.ami_retest, event: r.event.type };
  }), guardrails: [NO_ULAD_EDIT, NO_SUPPRESSION] },
  { name: "snapshotClosedLoan", kind: "act", handler: compute((i) => { const s = snapshotIn(i, "closing"); return { closed_loan_snapshot_hash: closedLoanSnapshotHash(s), closed_loan: closedLoanData(s), frozen_at: (i.frozen_at as string | undefined) ?? null, source: "25.2 CD-final" }; }), guardrails: [NO_ULAD_EDIT] },
  { name: "assertFinalSubmissionMatches", kind: "act", handler: compute((i, ctx, rt) => {
    const cf = casefileIn(i, rt); const closing = snapshotIn(i, "closing"); const prior = submissionsOf(i, rt, cf);
    const command = (str(i, "command") || "generateClosingDocs") as "generateClosingDocs" | "issueCD" | "submitDelivery";
    if (i.op === "record_final") {
      need(i, "submission_number");
      const sub = prior.find((s) => s.submission_number === Number(i.submission_number)); if (!sub) throw new RangeError(`23.1: no du_submissions row ${String(i.submission_number)}`);
      const r = recordFinalSubmission(ctx.events, cf, { ...sub, snapshot: bigints(sub.snapshot, SNAPSHOT_CENTS) }, closing, ctx.now, ctx.actor);
      persist(rt, ctx, "du_casefiles", cf.casefile_id, r.casefile); persist(rt, ctx, "du_submissions", r.submission.submission_id, r.submission);
      if (r.escalate) rt.escalations.open({ kind: "underwriting_reviewer", applicationId: cf.application_id, severity: "sev2", payload: { reason: "recommendation downgrade on the final match submission", submission_number: sub.submission_number, recommendation: sub.recommendation, decision_reopen: "23.3" } }, ctx.actor);
      return { gate: r.gate, is_final: r.submission.is_final, escalate: r.escalate };
    }
    const last = prior.filter((s) => s.status === "findings_received").at(-1) ?? null;
    const r = assertFinalSubmissionMatches(ctx.events, cf, last ? { ...last, snapshot: bigints(last.snapshot, SNAPSHOT_CENTS) } : null, closing, command, ctx.now, ctx.actor);
    return { gate: r.gate, command, resubmit: r.resubmit ? { reason: r.resubmit.reason, differences: r.resubmit.differences } : null, blocked: !r.gate.open };
  }), guardrails: [NO_ULAD_EDIT, NO_SUPPRESSION] },
  { name: "writeDecision", kind: "write", handler: compute((i, ctx, rt) => {
    if (i.casefile || i.casefile_id) {
      const cf = casefileIn(i, rt);
      const rec = decisionRecord(cf, { submission: (i.submission as DuSubmission | undefined) ?? null, previous: (i.previous as DuSubmission | undefined) ?? null, evaluation: (i.evaluation as never) ?? null, reason: str(i, "reason") || str(i, "action"), rationale: str(i, "rationale"), model_version: ctx.run?.modelVersion ?? "deterministic", prompt_version: ctx.run?.promptVersion ?? "n/a", confidence: typeof i.confidence === "number" ? i.confidence : 1 });
      ctx.decide({ agent: "underwriter", action: str(i, "action") || "23.1.decision", rationale: rec.rationale, ruleSetVersion: rec.rule_set_version, loanId: (i.loan_id as string | undefined) ?? ctx.loanId, subject: { kind: "du_casefiles", id: cf.casefile_id }, ...(typeof i.rule_code === "string" ? { ruleCode: i.rule_code } : {}), confidence: rec.confidence });
      return { recorded: true, record: rec };
    }
    return decision()(i, ctx);
  }) },
  { name: "openEscalation", kind: "act", handler: escalate("human_portal_task"), humanRoles: ["officer", "underwriting_reviewer", "fnma_portal_operator", "human_agent", "ops_analyst"], guardrails: [needsRole("TSP_CREDENTIAL_CHANGE_IS_OFFICER", "23.1 escalations: `officer` (Technology Manager/TSP credential changes)", (i) => i.kind === "officer" && i.approve_credential_change === true, ["officer"], "Technology Manager / TSP credential changes are approved by the partner officer")] },
]);
