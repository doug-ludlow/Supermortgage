/**
 * §30.3 process-owned tools — bus tools for 30.3 defined with `defineTools("30.3", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 30.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `escrow` agent in origination mode. agents.json carries three strings for 30.3 (`buildEscrowLines`,
 * `lookupParcel`, `readPolicyDeclarations`) — its extractor stops at the paragraph's first parenthesised argument
 * list (`runEscrowAnalysis(type='initial', source='origination')`) — so the rest of the paragraph (`runEscrowAnalysis`,
 * `approveAnalysis`, `overrideLineEstimate`, `computeCdFigures`, `renderStatement`, `evaluateWaiver`,
 * `recordCreditAgreement`, `postCreditTransfer`, `establishEscrowAccount`, `escalate`, `writeDecision`) rides on
 * `buildEscrowLines` as `op` switches: the tool builds the escrow lines and carries them through the origination
 * escrow lifecycle the spec's end-to-end sentence describes (assemble → run the engine → resolve anomalies with
 * evidence → publish the CD figures → freeze → render the statement into the package → establish at funding → hand
 * off; waiver and same-servicer credit decide which lines are active and what the deposit is). Guardrails encode the
 * spec's sentences: the engine's arithmetic is immutable to the agent; a line amount is overridden only with a cited
 * document; no solicitation of a waiver (B-1-01); a waiver outside the partner's written policy needs `officer`; a
 * spoken "yes" is an escrow-credit agreement only on a recorded call with the scripted language; no statement leaves
 * without the (g)(1)(i) checklist. Gate facts come from the engine's stored record and the bus's own events, never
 * from the caller.
 */
import { defineTools, compute, never, needsRole, guard, port, str, num, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { EscalationKind } from "../escalations.ts";
import { assertGate, evaluateGate } from "../evaluators.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { CushionInputs } from "../../domain/escrow/analysis.ts";
import { buildEscrowLines, runInitialAnalysis, approveInitialAnalysis, cdDraftFromAnalysis, checkCdConsistency, latestCdPrepared, freezeAnalysis, overrideLineEstimate, initialAnalysisGateFacts, renderInitialStatement, deliverStatementAtSettlement, mailStatementFallback, establishEscrowAccount, fundedOn, consummatedOn,
  recordOriginationWaiver, recordCreditAgreement, postCreditTransfer, noAgreementRefund, creditAgreementGateFacts, queueEscrowSetupAtPurchase, purchasedOn, RULE_SET_30_3, PARTNER_WAIVER_POLICY_DEFAULT, POLICY_CUSHION_MONTHS,
  type InitialAnalysis30, type EscrowLine30, type ParcelRecord, type PolicyRecord, type MiRecord, type CdEscrowDraft, type OriginationWaiverRequest, type CreditConsent, type CreditAgreementEvidence } from "../../domain/orig-boarding/ops-30-3.ts";
import { scriptSolicitsWaiver } from "../../domain/escrow/ops.ts";

type Op = "build" | "run_analysis" | "approve_analysis" | "cd_figures" | "cd_check" | "override_line" | "freeze" | "render_statement" | "deliver_at_settlement" | "mail_fallback" | "evaluate_waiver" | "record_credit_agreement" | "post_credit_transfer" | "refund_no_agreement" | "establish" | "setup_event" | "escalate" | "write_decision";
const OPS: readonly Op[] = ["build", "run_analysis", "approve_analysis", "cd_figures", "cd_check", "override_line", "freeze", "render_statement", "deliver_at_settlement", "mail_fallback", "evaluate_waiver", "record_credit_agreement", "post_credit_transfer", "refund_no_agreement", "establish", "setup_event", "escalate", "write_decision"];
const opOf = (i: ToolInput): Op => { const op = (str(i, "op") || "build") as Op; if (!OPS.includes(op)) throw new RangeError(`unknown op ${op}: ${OPS.join(" | ")}`); return op; };
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const appId = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required (origination context)"); return id; };
/** The servicing loan id once 30.2 created the row; a context whose loanId is the application id is pre-funding. */
const loanIdOf = (i: ToolInput, ctx: CommandContext): string | null => str(i, "loan_id") || (ctx.applicationId && ctx.loanId !== ctx.applicationId ? ctx.loanId : "") || null;
const dateOr = (i: ToolInput, k: string, fallback: PlainDate): PlainDate => (typeof i[k] === "string" && i[k] ? D(str(i, k)) : fallback);
const optCents = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : cents(v));
const pl = (e: { payload: unknown } | undefined): Record<string, unknown> => ((e?.payload ?? {}) as Record<string, unknown>);
/** The engine's stored initial analysis (run_analysis wrote it) — the only source the approval/CD/statement/establishment paths read. */
const storedAnalysis = (i: ToolInput, rt: ToolRuntime, ctx: CommandContext): InitialAnalysis30 => {
  const id = str(i, "analysis_id") || latestAnalysisId(rt, appId(i, ctx)); if (!id) throw new RangeError("analysis_id is required (run_analysis first)");
  const rec = rt.store.get("escrow_analyses", id); if (!rec) throw new RangeError(`no computed initial analysis ${id}: run_analysis first`);
  return rec.data as unknown as InitialAnalysis30;
};
const latestAnalysisId = (rt: ToolRuntime, applicationId: string): string | null => { const xs = rt.store.list("escrow_analyses", (d) => d.application_id === applicationId && d.source === "origination" && d.status !== "superseded"); const last = xs[xs.length - 1]; return last ? last.id : null; };
const saveAnalysis = (rt: ToolRuntime, a: InitialAnalysis30, ctx: CommandContext): void => { rt.store.put("escrow_analyses", a.analysis_id, a as unknown as Record<string, unknown>, ctx.actor, ctx.now); };
const storedLines = (i: ToolInput, rt: ToolRuntime, ctx: CommandContext): EscrowLine30[] => { if (Array.isArray(i.lines)) return i.lines as EscrowLine30[]; const rec = rt.store.get("escrow_lines", appId(i, ctx)); if (!rec) throw new RangeError("lines are required (op build first)"); return rec.data.lines as EscrowLine30[]; };
const cdDraft = (c: Record<string, unknown> | undefined): CdEscrowDraft | null => {
  if (!c) return null;
  const g = (c.g3_lines as { item: string; months: number; per_month_cents: unknown; amount_cents: unknown }[] | undefined) ?? [];
  return { cd_version: String(c.cd_version ?? c.version ?? ""), g3_lines: g.map((l) => ({ item: l.item, months: Number(l.months), per_month_cents: cents(l.per_month_cents), amount_cents: cents(l.amount_cents) })), g3_aggregate_adjustment_cents: cents(c.g3_aggregate_adjustment_cents), g3_total_cents: cents(c.g3_total_cents),
    l7_escrowed_year1_cents: cents(c.l7_escrowed_year1_cents), l7_non_escrowed_year1_cents: cents(c.l7_non_escrowed_year1_cents), l7_initial_escrow_payment_cents: cents(c.l7_initial_escrow_payment_cents), l7_monthly_escrow_cents: cents(c.l7_monthly_escrow_cents), projected_payments_escrow_cents: cents(c.projected_payments_escrow_cents) };
};
const waiverRequest = (i: ToolInput, ctx: CommandContext): OriginationWaiverRequest => {
  need(i, "waiver_id", "requested_on", "transaction_type", "ltv_pct", "dti_pct", "loan_amount_cents", "annual_ti_cents");
  return { application_id: appId(i, ctx), loan_id: loanIdOf(i, ctx), waiver_id: str(i, "waiver_id"), requested_on: D(str(i, "requested_on")), scope: (str(i, "scope") || "full") as "full" | "partial", waived_line_types: (i.waived_line_types as string[] | undefined) ?? [], channel: str(i, "channel") || "portal",
    is_hpml: flag(i, "is_hpml"), consummation_date: i.consummation_date ? D(str(i, "consummation_date")) : null, state: str(i, "state"), state_requires_escrow: flag(i, "state_requires_escrow"), transaction_type: str(i, "transaction_type") as "purchase" | "refinance", taxes_financed_in_loan: flag(i, "taxes_financed_in_loan"),
    mi_premium_plan: (str(i, "mi_premium_plan") || "none") as OriginationWaiverRequest["mi_premium_plan"], mi_monthly_premium_cents: optCents(i.mi_monthly_premium_cents), ltv_pct: str(i, "ltv_pct"), reserves_months_of_ti: num(i, "reserves_months_of_ti") || 0, mortgage_lates_30_in_12m: num(i, "mortgage_lates_30_in_12m") || 0, dti_pct: str(i, "dti_pct"), lump_sum_ability_documented: flag(i, "lump_sum_ability_documented"),
    sfha: flag(i, "sfha"), flood_election_written: flag(i, "flood_election_written"), partner_is_regulated_lender: flag(i, "partner_is_regulated_lender"), instrument_permits_waiver: i.instrument_permits_waiver === undefined ? true : flag(i, "instrument_permits_waiver"), solicited: flag(i, "solicited"), script: typeof i.script === "string" ? i.script : null,
    policy: (i.policy as OriginationWaiverRequest["policy"]) ?? PARTNER_WAIVER_POLICY_DEFAULT, loan_amount_cents: cents(i.loan_amount_cents), annual_ti_cents: cents(i.annual_ti_cents) };
};
const evidence = (i: ToolInput): CreditAgreementEvidence => { const e = (i.evidence as Record<string, unknown> | undefined) ?? {}; return { kind: String(e.kind ?? "") as CreditAgreementEvidence["kind"], recorded_call_id: typeof e.recorded_call_id === "string" ? e.recorded_call_id : null, scripted_agreement_language_used: e.scripted_agreement_language_used === true, document_id: typeof e.document_id === "string" ? e.document_id : null }; };
const ENGINE_FIELDS = ["base_payment_cents", "cushion_cents", "target_at_start_cents", "required_start_balance_cents", "aggregate_adjustment_cents", "single_item_lines", "trial_balance"];
const is = (op: Op) => (i: ToolInput): boolean => (str(i, "op") || "build") === op;
/** The latest 3.4 cushion fact for an analysis id (the engine's own record of cap_check_passed / preaccrual_check_passed). */
const cushionFact = (i: ToolInput, ctx: CommandContext) => (str(i, "analysis_id") ? ctx.events.ofType("escrow.cushion.validated").filter((e) => pl(e).analysis_id === str(i, "analysis_id")).at(-1) : undefined);
const gateGuard = (code: string, citation: string, when: (i: ToolInput) => boolean, facts: (i: ToolInput, ctx: CommandContext) => Record<string, unknown> | null, ref: string) =>
  guard(code, citation, (i, ctx) => { if (!when(i)) return undefined; const f = facts(i, ctx); if (!f) return undefined; try { assertGate(ref, f); return undefined; } catch (e) { return (e as Error).message; } });

const handlers: Record<Op, (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown | Promise<unknown>> = {
  // Rule 1: lines from the parcel record, the policies, the MI certificate (and HOA/special assessments) — stored per application for the analysis.
  build: (i, ctx, rt) => {
    need(i, "first_payment_date");
    const lines = buildEscrowLines({ first_payment_date: D(str(i, "first_payment_date")), parcel: (i.parcel as ParcelRecord | undefined) ?? null, policies: (i.policies as PolicyRecord[] | undefined) ?? [], mi: (i.mi as MiRecord | undefined) ?? null, hoa_dues_annual_cents: optCents(i.hoa_dues_annual_cents), hoa_escrowed: flag(i, "hoa_escrowed"), special_assessments: (i.special_assessments as Parameters<typeof buildEscrowLines>[0]["special_assessments"]) ?? [] });
    rt.store.put("escrow_lines", appId(i, ctx), { application_id: appId(i, ctx), source: "origination", lines, built_at: ctx.now }, ctx.actor, ctx.now);
    return { lines, escrowed: lines.filter((l) => l.escrowed).length };
  },
  // runEscrowAnalysis(type='initial', source='origination'): the servicing engine on the stored lines; a superseding run when supersedes_analysis_id is given.
  run_analysis: (i, ctx, rt) => {
    need(i, "analysis_id", "first_payment_date", "settlement_date");
    const a = runInitialAnalysis(ctx.events, { application_id: appId(i, ctx), loan_id: loanIdOf(i, ctx), analysis_id: str(i, "analysis_id"), lines: storedLines(i, rt, ctx), first_payment_date: D(str(i, "first_payment_date")), settlement_date: D(str(i, "settlement_date")), disbursement_date: i.disbursement_date ? D(str(i, "disbursement_date")) : null,
      cushion: (i.cushion as CushionInputs | undefined) ?? { policy_months: POLICY_CUSHION_MONTHS }, biweekly: flag(i, "biweekly"), cd_version_id: str(i, "cd_version_id") || null, supersedes_analysis_id: str(i, "supersedes_analysis_id") || null, hpml: flag(i, "is_hpml"), as_of: dateOr(i, "as_of", today(ctx)), actor: ctx.actor, pi_cents: optCents(i.pi_cents) });
    if (a.supersedes_analysis_id && rt.store.get("escrow_analyses", a.supersedes_analysis_id)) rt.store.put("escrow_analyses", a.supersedes_analysis_id, { status: "superseded", superseded_by: a.analysis_id }, ctx.actor, ctx.now);
    saveAnalysis(rt, a, ctx);
    return { analysis_id: a.analysis_id, status: a.status, base_payment_cents: a.base_payment_cents, cushion_cents: a.cushion_cents, target_at_start_cents: a.target_at_start_cents, low_point_month: a.low_point_month, cap_check_passed: a.cap_check_passed, anomalies: a.anomalies, cd_figures: a.cd_figures, trial_balance: a.trial_balance, decision_record: a.decision_record };
  },
  // approveAnalysis: closes REGX_1024_17C2_INITIAL_ANALYSIS_GATE; the 3.4 gates are asserted on the engine's record (guardrails below).
  approve_analysis: (i, ctx, rt) => { const a = storedAnalysis(i, rt, ctx); const r = approveInitialAnalysis(ctx.events, a, { approved_on: dateOr(i, "approved_on", today(ctx)), actor: ctx.actor, reviewed: flag(i, "reviewed"), rationale: str(i, "rationale") || "engine analysis approved" }); saveAnalysis(rt, a, ctx); return { analysis_id: a.analysis_id, status: r.status, hpml: a.hpml, event_id: r.event.id }; },
  // computeCdFigures: the (g)(3)/(l)(7) block for 25.2's cd_figure_sources.
  cd_figures: (i, ctx, rt) => { const a = storedAnalysis(i, rt, ctx); return { analysis_id: a.analysis_id, cd_figures: a.cd_figures, cd_draft: cdDraftFromAnalysis(a, str(i, "cd_version") || a.cd_version_id || "draft") }; },
  // REGZ_1026_38L7 on a CD draft — the input's `cd` or 25.2's `disclosure.cd.prepared{version}` payload.
  cd_check: (i, ctx, rt) => {
    const a = storedAnalysis(i, rt, ctx); const fromEvent = latestCdPrepared(ctx.events, a.application_id);
    const draft = cdDraft(i.cd as Record<string, unknown> | undefined) ?? (fromEvent ? cdDraft({ ...(pl(fromEvent).escrow as Record<string, unknown> | undefined ?? {}), cd_version: pl(fromEvent).version }) : null);
    if (!draft) throw new RangeError("cd_check needs the CD draft (input.cd or 25.2's disclosure.cd.prepared{version} carrying its escrow figures)");
    const r = checkCdConsistency(ctx.events, a, draft, { actor: ctx.actor, cd_prepared_event_id: fromEvent?.id ?? null }); saveAnalysis(rt, a, ctx);
    return { passed: r.passed, mismatches: r.mismatches, gate: r.gate, cd_version: draft.cd_version };
  },
  // overrideLineEstimate(reason, evidence_doc): rule 10 — a superseding analysis from the corrected line.
  override_line: (i, ctx, rt) => {
    need(i, "line_type", "new_annual_cents", "reason"); const a = storedAnalysis(i, rt, ctx);
    const lines = overrideLineEstimate(a.lines, { line_type: str(i, "line_type") as EscrowLine30["line_type"], new_annual_cents: cents(i.new_annual_cents), reason: str(i, "reason"), evidence_document_id: str(i, "evidence_document_id") || null, basis: (str(i, "basis") || "quote") as EscrowLine30["estimate_basis"] });
    rt.store.put("escrow_lines", a.application_id, { lines, overridden_at: ctx.now }, ctx.actor, ctx.now);
    const next = runInitialAnalysis(ctx.events, { application_id: a.application_id, loan_id: a.loan_id, analysis_id: str(i, "new_analysis_id") || `${a.analysis_id}-s`, lines, first_payment_date: a.first_payment_date, settlement_date: a.settlement_date, disbursement_date: a.disbursement_date, cushion: { policy_months: a.requested_cushion_months }, cd_version_id: a.cd_version_id, supersedes_analysis_id: a.analysis_id, hpml: a.hpml, as_of: today(ctx), actor: ctx.actor, pi_cents: a.pi_cents });
    rt.store.put("escrow_analyses", a.analysis_id, { status: "superseded", superseded_by: next.analysis_id }, ctx.actor, ctx.now); saveAnalysis(rt, next, ctx);
    return { superseded: a.analysis_id, analysis_id: next.analysis_id, status: next.status, target_at_start_cents: next.target_at_start_cents, base_payment_cents: next.base_payment_cents, cushion_cents: next.cushion_cents, lines };
  },
  // Freeze at the final CD's consummation_ready (25.2).
  freeze: (i, ctx, rt) => { need(i, "cd_version_id"); const a = storedAnalysis(i, rt, ctx); const r = freezeAnalysis(ctx.events, a, { cd_version_id: str(i, "cd_version_id"), frozen_at: ctx.now, actor: ctx.actor }); saveAnalysis(rt, a, ctx); return { analysis_id: a.analysis_id, status: a.status, frozen_at: a.frozen_at, event_id: r.event.id }; },
  // renderStatement: 3.1's template from the frozen analysis; the (g)(1)(i) checklist must pass.
  render_statement: (i, ctx, rt) => {
    need(i, "pi_cents", "account_last4", "servicer_phone", "partner_name"); const a = storedAnalysis(i, rt, ctx);
    const r = renderInitialStatement(ctx.events, a, { pi_cents: cents(i.pi_cents), account_last4: str(i, "account_last4"), servicer_phone: str(i, "servicer_phone"), partner_name: str(i, "partner_name"), rendered_on: dateOr(i, "rendered_on", today(ctx)), credit_transfer_cents: optCents(i.credit_transfer_cents) }, ctx.actor);
    rt.store.put("disclosures", `initial_escrow_stmt:${a.application_id}`, { kind: "initial_escrow_stmt", analysis_id: a.analysis_id, template: r.template, payload_hash: r.rendered.payloadHash, rendered_on: str(i, "rendered_on") || today(ctx), checklist_passed: r.checklist.passed }, ctx.actor, ctx.now);
    return { template: r.template, checklist_passed: r.checklist.passed, payload_hash: r.rendered.payloadHash, text: r.rendered.text, cushion_text: r.cushion_text, servicer_block: r.servicer_block, computation_year: r.computation_year, event_id: r.event.id };
  },
  // At consummation: 3.1's required fact and, when the package carried the statement, the day-0 sent fact.
  deliver_at_settlement: (i, ctx, rt) => { need(i, "settlement_date"); const r = deliverStatementAtSettlement(ctx.events, { application_id: appId(i, ctx), loan_id: loanIdOf(i, ctx), settlement_date: D(str(i, "settlement_date")), in_package: flag(i, "in_package"), rendered_event_id: str(i, "rendered_event_id") || null, actor: ctx.actor }); rt.store.put("disclosures", `initial_escrow_stmt:${appId(i, ctx)}`, { kind: "initial_escrow_stmt", delivery_basis: r.delivery_basis, delivered_at: r.initial_statement_delivered_at, due_on: r.due_on }, ctx.actor, ctx.now); return { delivery_basis: r.delivery_basis, due_on: r.due_on, initial_statement_delivered_at: r.initial_statement_delivered_at, timer: r.timer }; },
  // The 45-day fallback (3.1 channel rules): the servicing send closes REGX_1024_17G_INITIAL_STMT_45 when mailed by settlement + 45 days.
  mail_fallback: async (i, ctx, rt) => {
    need(i, "settlement_date", "mailed_on"); const loanId = loanIdOf(i, ctx); if (!loanId) throw new RangeError("loan_id is required for the 45-day fallback send (the loan is boarded at funding)");
    if (rt.notices && str(i, "notice_id")) await rt.notices.send(str(i, "notice_id"), (i.channel_context as Parameters<NonNullable<ToolRuntime["notices"]>["send"]>[1] | undefined) ?? {});
    const r = mailStatementFallback(ctx.events, { application_id: appId(i, ctx), loan_id: loanId, settlement_date: D(str(i, "settlement_date")), mailed_on: D(str(i, "mailed_on")), actor: ctx.actor });
    rt.store.put("disclosures", `initial_escrow_stmt:${appId(i, ctx)}`, { kind: "initial_escrow_stmt", delivery_basis: r.delivery_basis, delivered_at: r.initial_statement_delivered_at, on_time: r.on_time }, ctx.actor, ctx.now);
    return r;
  },
  // evaluateWaiver (deterministic rule engine): law → Fannie Mae → the partner's written policy → flood; the worksheet is retained; approval drives 21.5's revised LE.
  evaluate_waiver: (i, ctx, rt) => {
    const r = waiverRequest(i, ctx); const lines = Array.isArray(i.lines) ? (i.lines as EscrowLine30[]) : (rt.store.get("escrow_lines", r.application_id)?.data.lines as EscrowLine30[] | undefined) ?? [];
    const exc = i.officer_exception as { rationale?: unknown } | undefined; const officer = exc ? { approved_by: ctx.actor, rationale: String(exc.rationale ?? "") } : null;
    const refiGate = evaluateGate("30.3.refiTaxFinancing", { transaction_type: r.transaction_type, taxes_financed_in_loan: r.taxes_financed_in_loan });
    const rec = recordOriginationWaiver(ctx.events, r, { decided_on: dateOr(i, "decided_on", today(ctx)), lines, actor: ctx.actor, officer_exception: officer });
    rt.store.put("escrow_waivers", r.waiver_id, { origin: "origination", scope: r.scope, waived_line_types: r.waived_line_types, decision: rec.decision.decision, denial_reasons: rec.decision.reasons, policy_version: rec.decision.policy_version, basis_document_id: rec.worksheet_document_id, pricing_adjustment_bps: rec.decision.pricing_adjustment_bps, requested_at: r.requested_on, decided_at: ctx.now, application_id: r.application_id }, ctx.actor, ctx.now);
    rt.store.put("documents", rec.worksheet_document_id, { kind: "escrow_waiver_decision_worksheet", waiver_id: r.waiver_id, worksheet: rec.decision.worksheet, refi_tax_gate: refiGate }, ctx.actor, ctx.now);
    if (lines.length) rt.store.put("escrow_lines", r.application_id, { lines: rec.lines_after }, ctx.actor, ctx.now);
    return { decision: rec.decision.decision, reasons: rec.decision.reasons, lines_kept: rec.decision.lines_kept, decision_due_on: rec.decision.decision_due_on, worksheet_document_id: rec.worksheet_document_id, le_revision: rec.le_revision, le_unchanged: rec.le_revision === null, lines_after: rec.lines_after };
  },
  // recordCreditAgreement (comment 34(b)(2)-2): `consents{kind=escrow_credit_to_new_loan}` captured before the new loan's settlement date.
  record_credit_agreement: (i, ctx, rt) => {
    need(i, "old_loan_id", "borrower_id", "captured_on", "settlement_date");
    const c = recordCreditAgreement(ctx.events, { old_loan_id: str(i, "old_loan_id"), new_application_id: appId(i, ctx), borrower_id: str(i, "borrower_id"), evidence: evidence(i), captured_on: D(str(i, "captured_on")), settlement_date: D(str(i, "settlement_date")), actor: ctx.actor });
    rt.store.put("consents", c.id, { kind: c.kind, old_loan_id: c.old_loan_id, new_application_id: c.new_application_id, borrower_id: c.borrower_id, captured_at: c.captured_at, evidence: c.evidence, provenance: c.provenance, verified: c.verified, event_id: c.event.id }, ctx.actor, ctx.now);
    return { consent_id: c.id, kind: c.kind, captured_at: c.captured_at };
  },
  // postCreditTransfer: rule 8 at payoff of the prior loan (the agreement gate is asserted below).
  post_credit_transfer: (i, ctx, rt) => {
    need(i, "old_loan_id", "new_loan_id", "payoff_date", "settlement_date", "old_balance_after_final_disbursements_cents", "target_at_start_cents");
    const row = rt.store.get("consents", str(i, "consent_id") || `consent:escrow_credit_to_new_loan:${str(i, "old_loan_id")}:${appId(i, ctx)}`)?.data as (Omit<CreditConsent, "event"> & { event_id: string }) | undefined;
    const consent: CreditConsent | null = row ? { ...row, event: ctx.events.all().find((e) => e.id === row.event_id)! } : null;
    const r = postCreditTransfer(ctx.events, ctx.ledger, { old_loan_id: str(i, "old_loan_id"), new_loan_id: str(i, "new_loan_id"), new_application_id: appId(i, ctx), consent, payoff_date: D(str(i, "payoff_date")), settlement_date: D(str(i, "settlement_date")), old_balance_after_final_disbursements_cents: cents(i.old_balance_after_final_disbursements_cents), target_at_start_cents: cents(i.target_at_start_cents), ...(str(i, "fnma_ti_account_id") ? { fnma_ti_account_id: str(i, "fnma_ti_account_id") } : {}), actor: ctx.actor });
    const { events: _ev, ...stored } = r; rt.store.put("escrow_credit_transfers", r.id, stored as unknown as Record<string, unknown>, ctx.actor, ctx.now);
    return { transfer_id: r.id, credited_cents: r.credited_cents, refunded_remainder_cents: r.refunded_remainder_cents, borrower_closing_escrow_funds_cents: r.borrower_closing_escrow_funds_cents, ledger_entry_ids: r.ledger_entry_ids, refund_check_issued: r.refund_check_issued };
  },
  // No agreement: 3.5's 20-day refund and the full deposit at closing.
  refund_no_agreement: (i) => { need(i, "payoff_date", "old_balance_after_final_disbursements_cents", "target_at_start_cents"); return noAgreementRefund({ payoff_date: D(str(i, "payoff_date")), old_balance_after_final_disbursements_cents: cents(i.old_balance_after_final_disbursements_cents), target_at_start_cents: cents(i.target_at_start_cents) }); },
  // establishEscrowAccount: rule 6 at loan.funded (REGX_1024_17C2 asserted below); the account row and the hand-off to 3.x.
  establish: (i, ctx, rt) => {
    need(i, "loan_id"); const a = storedAnalysis(i, rt, ctx); const app = a.application_id;
    const funded = fundedOn(ctx.events, app) ?? (i.funded_on ? D(str(i, "funded_on")) : null); if (!funded) throw new RangeError("funded_on is required (26.3's loan.funded{disbursement_date} not found for the application)");
    const cons = consummatedOn(ctx.events, app); const consummation = cons?.on ?? (i.consummation_date ? D(str(i, "consummation_date")) : a.settlement_date);
    const stmt = rt.store.get("disclosures", `initial_escrow_stmt:${app}`)?.data;
    const r = establishEscrowAccount(ctx.events, { application_id: app, loan_id: str(i, "loan_id"), analysis: a, funded_on: funded, consummation_date: consummation, is_hpml: cons?.is_hpml ?? (i.is_hpml === undefined ? a.hpml : flag(i, "is_hpml")), interest_rule_code: str(i, "interest_rule_code") || null, waiver_id: str(i, "waiver_id") || null, waived: flag(i, "waived"),
      statement: stmt ? { delivered_at: (stmt.delivered_at as PlainDate | null) ?? null, basis: (stmt.delivery_basis as "at_settlement" | "within_45_days" | null) ?? null } : null, lines_changed_since_freeze: flag(i, "lines_changed_since_freeze"), superseding_analysis_id: str(i, "superseding_analysis_id") || null, actor: ctx.actor });
    saveAnalysis(rt, a, ctx); rt.store.put("escrow_accounts", str(i, "loan_id"), r.account as unknown as Record<string, unknown>, ctx.actor, ctx.now);
    return { status: r.account.status, established_at: r.account.established_at, computation_year_start: r.account.computation_year_start, computation_year_end: r.account.computation_year_end, hpml_escrow_min_cancel_date: r.account.hpml_escrow_min_cancel_date, initial_deposit_cents: r.account.initial_deposit_cents, monthly_escrow_payment_cents: r.account.monthly_escrow_payment_cents, custodial_account_id: r.account.custodial_account_id, annual_analysis_lead_on: r.account.annual_analysis_lead_on };
  },
  // 30.1's Escrow Setup event at loan.purchased (LL-2026-05), sequence 1 of the T&I chain.
  setup_event: (i, ctx, rt) => {
    need(i, "loan_id", "ti_balance_cents"); const purchased = purchasedOn(ctx.events, str(i, "loan_id")) ?? (i.purchase_date ? D(str(i, "purchase_date")) : null); if (!purchased) throw new RangeError("purchase_date is required (30.1's loan.purchased{purchase_date} not found)");
    const flagOn = i.escrow_events_flag === undefined ? rt.store.get("feature_flags", "investor_reporting.escrow_events")?.data.enabled === true : flag(i, "escrow_events_flag");
    return queueEscrowSetupAtPurchase(ctx.events, { loan_id: str(i, "loan_id"), purchase_date: purchased, ti_balance_cents: cents(i.ti_balance_cents), flag_on: flagOn, now: ctx.now, actor: ctx.actor });
  },
  // escalate: `officer` (policy-exception waivers) or `human_agent` (borrower request).
  escalate: (i, ctx, rt) => { need(i, "reason"); return rt.escalations.open({ kind: ((str(i, "kind") || "human_agent") as EscalationKind), loanId: loanIdOf(i, ctx) ?? ctx.loanId, payload: { reason: str(i, "reason"), application_id: appId(i, ctx), ...((i.payload as Record<string, unknown> | undefined) ?? {}) }, ...(str(i, "severity") ? { severity: str(i, "severity") } : {}) }, ctx.actor); },
  // writeDecision: the spec's decision record (rule_set='regx.escrow.2013').
  write_decision: (i, ctx) => { need(i, "action", "rationale"); ctx.decide({ agent: "escrow", action: str(i, "action"), rationale: str(i, "rationale"), ruleSetVersion: str(i, "rule_set") || RULE_SET_30_3, loanId: loanIdOf(i, ctx) ?? ctx.loanId, subject: { kind: str(i, "subject_kind") || "escrow_analysis", id: str(i, "subject_id") || str(i, "analysis_id") || appId(i, ctx) }, ...(Array.isArray(i.evidence_document_ids) ? { evidenceDocumentIds: i.evidence_document_ids as string[] } : {}), ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}) }); return { recorded: true }; },
};

export const TOOLS_30_3: readonly ToolDef[] = defineTools("30.3", "escrow", [
  { name: "buildEscrowLines", kind: "act", handler: compute((i, ctx, rt) => handlers[opOf(i)](i, ctx, rt)),
    decision: (i, o, ctx) => ({ action: `escrow.origination.${str(i, "op") || "build"}`, rationale: str(i, "rationale") || `${str(i, "op") || "build"} by ${ctx.actor.kind}:${ctx.actor.id}${(o as { decision?: string } | null)?.decision ? ` → ${String((o as { decision?: string }).decision)}` : ""}`, subject: { kind: str(i, "waiver_id") ? "escrow_waiver" : "escrow_analysis", id: str(i, "waiver_id") || str(i, "analysis_id") || str(i, "application_id") || ctx.applicationId || ctx.loanId }, ruleCode: RULE_SET_30_3 }),
    guardrails: [
      never("ENGINE_OUTPUTS_IMMUTABLE", "30.3 guardrails: the engine's arithmetic and the Reg X option set are immutable to the agent", (i) => i.changes !== undefined && Object.keys(i.changes).some((k) => ENGINE_FIELDS.includes(k)), "engine outputs are not editable; correct the escrow line with a cited document (op override_line)"),
      never("LINE_OVERRIDE_NEEDS_DOCUMENT", "30.3 guardrails: a line amount may be overridden only with a cited document", (i) => is("override_line")(i) && !str(i, "evidence_document_id"), "a line amount may be overridden only with a cited document (bill image, declarations page, renewal quote)"),
      gateGuard("REGX_1024_17C5_CUSHION_CAP_GATE", "3.4 timer table: cushion ≤ 1/6 of annual disbursements (§1024.17(c)(5)); breach: approveAnalysis refused", is("approve_analysis"), (i, ctx) => { const e = cushionFact(i, ctx); return e ? { cap_check_passed: pl(e).cap_check_passed === true } : null; }, "3.4.cushionCap"),
      gateGuard("REGX_1024_17C6_PREACCRUAL_GATE", "3.4 timer table: no pre-accrual (§1024.17(c)(6)); breach: approveAnalysis refused", is("approve_analysis"), (i, ctx) => { const e = cushionFact(i, ctx); return e ? { preaccrual_check_passed: pl(e).preaccrual_check_passed === true } : null; }, "3.4.preaccrual"),
      guard("G1_CHECKLIST_REQUIRED", "30.3 guardrails: no statement leaves without the (g)(1)(i) checklist", (i, ctx) => (is("deliver_at_settlement")(i) && flag(i, "in_package") && !ctx.events.ofType("escrow.statement.rendered").some((e) => pl(e).checklist_passed === true && e.applicationId === (str(i, "application_id") || ctx.applicationId)) ? "no rendered statement with a passed (g)(1)(i) checklist for this application" : undefined)),
      never("NO_WAIVER_SOLICITATION", "30.3 guardrails / Servicing Guide B-1-01: the agent may not solicit a waiver", (i) => is("evaluate_waiver")(i) && (flag(i, "solicited") || (typeof i.script === "string" && scriptSolicitsWaiver(i.script))), "the servicer must not solicit borrowers to waive escrow; a waiver is the borrower's own election"),
      needsRole("POLICY_EXCEPTION_NEEDS_OFFICER", "30.3 guardrails: the agent may not approve a waiver outside the partner's written policy (that needs officer)", (i) => is("evaluate_waiver")(i) && i.officer_exception !== undefined && i.officer_exception !== null, ["officer"], "a waiver outside the partner's written escrow-waiver policy is an officer decision"),
      never("ORAL_AGREEMENT_NEEDS_RECORDING", "30.3 guardrails: a spoken 'yes' is an escrow-credit agreement only when the call is recorded and the scripted agreement language was used (comment 34(b)(2)-2)", (i) => { if (!is("record_credit_agreement")(i)) return false; const e = evidence(i); return e.kind === "recorded_call" && !(e.recorded_call_id && e.scripted_agreement_language_used); }, "an oral agreement needs the recorded call id and the scripted agreement language"),
      gateGuard("REGX_1024_17C2_INITIAL_ANALYSIS_GATE", "30.3 timer table: establishEscrowAccount refused at funding without an approved initial analysis (every line's basis set, cushion ≤ cap, no pre-accrual)", (i) => is("establish")(i) && !!str(i, "analysis_id"), (i, ctx) => { const e = ctx.events.ofType("escrow.initial_analysis.approved").filter((x) => pl(x).analysis_id === str(i, "analysis_id")).at(-1); return initialAnalysisGateFacts(e ? { status: "approved", all_lines_have_basis: pl(e).all_lines_have_basis === true, cap_check_passed: pl(e).cap_check_passed === true, preaccrual_check_passed: pl(e).preaccrual_check_passed === true } : null); }, "30.3.initialAnalysisApproved"),
      gateGuard("REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE", "30.3 timer table: no credit without `consents{kind=escrow_credit_to_new_loan, captured_at ≤ new settlement date}`; 3.5's refund runs instead", (i) => is("post_credit_transfer")(i) && !!str(i, "settlement_date"), (i, ctx) => { const c = ctx.events.ofType("consent.captured").filter((e) => pl(e).kind === "escrow_credit_to_new_loan" && e.loanId === str(i, "old_loan_id")).at(-1); return creditAgreementGateFacts(c ? { kind: "escrow_credit_to_new_loan", captured_at: D(String(pl(c).captured_at)) } : null, D(str(i, "settlement_date"))); }, "30.3.creditAgreementPresent"),
      never("HPML_NO_WAIVED_ESTABLISHMENT", "§1026.35(b)(1): an HPML first lien is escrowed before consummation", (i) => is("establish")(i) && flag(i, "is_hpml") && flag(i, "waived"), "an HPML loan cannot be established with a waived escrow account"),
    ] },
  // Tax-service parcel lookup (24.4 APN → installments and delinquency dates): the adapter's delinquency search plus the stored parcel record.
  { name: "lookupParcel", kind: "act", handler: compute(async (i, _c, rt) => { need(i, "parcel_id"); const rec = rt.store.get("tax_parcels", str(i, "parcel_id"))?.data ?? null; const search = await port(rt, "taxService").delinquencySearch(str(i, "parcel_id")); return { parcel: rec, delinquency: search }; }) },
  // 24.5's policy record (premium, paid-through, renewal quote) the hazard/flood line is built from.
  { name: "readPolicyDeclarations", kind: "act", handler: compute((i, _c, rt) => { need(i, "policy_id"); return rt.store.get("insurance_policies", str(i, "policy_id"))?.data ?? null; }) },
]);
