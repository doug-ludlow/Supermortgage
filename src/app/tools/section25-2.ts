/**
 * §25.2 process-owned tools — bus tools for 25.2 defined with `defineTools("25.2", "disclosure", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 25.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `disclosure` profile (spec "AI agent design"): assembleCdFigures, reconcileFigureSources, renderCd,
 * deliverDisclosure, recordReceipt, computeEarliestConsummation, evaluateRedisclosure, runToleranceTest (21.5),
 * assertGateOpen (25.1's compliance gates, 21.2's LE 7-SBD gate, this process's REGZ_1026_19F1_CD_3SBD_GATE and
 * FNMA_UCD_ACCEPTED_GATE — op switches on `gate`), runCdConsistencyChecks, generateUcd, submitUcd (op=generate|submit),
 * scheduleCorrectedCd (op=evaluate|record_event|schedule), openEscalation, writeDecision. Guardrails encode the paragraph:
 * never edit a figure without a versioned source; never record `actual_receipt_at` without evidence of the enumerated
 * kinds; never treat an oral confirmation as receipt; never shorten the waiting period except through a `cd_waivers`
 * row accepted by `officer`; never issue a "no-wait" corrected CD when 25.1's APR verdict is `fail`; never charge a fee
 * for the CD ((f)(5)); never embed a superseded CD in the UCD. State lives in the ClosingDisclosureService (one per
 * runtime, or the wired `cd-25-2` service) whose events arm and close the 25.2 clocks.
 */
import { defineTools, compute, escalate, decision, never, needsRole, service, str, num, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { ClosingDisclosureService, scheduleDelivery, computeEarliestConsummation, evaluateRedisclosure, renderCd, reconcileFigureSource, validateCdFees, cd3sbdGate, ucdAcceptedGate, REBUTTING_EVIDENCE, CD_DELIVERY_CHANNELS, PROHIBITED_CD_FEE,
  type CdDeliveryChannel, type CdFeeLine, type CdRenderInput, type CdReceipt, type FigureParty, type ConsistencyCheckCode, type ConsistencyValue, type RedisclosureInput, type CdReason, type UcdStatus, type CdWaiverInput } from "../../domain/compliance-disclosures/ops-25-2.ts";
import { assertGateOpen as assertComplianceGateOpen, gateCode, GATES, type ComplianceSnapshot, type ComplianceWaiver, type ComplianceRun } from "../../domain/compliance-disclosures/ops-25-1.ts";
import { assertGateOpen as assertLeGateOpen } from "../../domain/application/ops-21-2.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`25.2 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("25.2 tool needs application_id (every 25.2 event carries it so the clocks arm under origination context)"); return a; };
const dateIn = (i: ToolInput, k: string): PlainDate => D(str(i, k));
const big = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };
const feeLines = (i: ToolInput, k = "fees"): CdFeeLine[] => { const xs = i[k]; if (!Array.isArray(xs)) throw new RangeError(`25.2 tool needs ${k}[] (fee_items with the 21.5 tolerance classes)`); return (xs as CdFeeLine[]).map((x) => big(x, ["amount_cents"])); };
const services = new WeakMap<ToolRuntime, ClosingDisclosureService>();
/** The wired `cd-25-2` service when the runtime provides one, else one per runtime over the unit of work's event store. */
const svcOf = (ctx: CommandContext, rt: ToolRuntime): ClosingDisclosureService => {
  const wired = rt.services["cd-25-2"] as ClosingDisclosureService | undefined; if (wired) return wired;
  let s = services.get(rt); if (!s) { s = new ClosingDisclosureService({ events: ctx.events, clock: ctx.clock, escalations: rt.escalations, ...(rt.services["tolerance-21-5"] ? { tolerance: rt.services["tolerance-21-5"] as never } : {}), ...(rt.services["le-21-2"] ? { le: rt.services["le-21-2"] as never } : {}) }); services.set(rt, s); }
  return s;
};
const renderInput = (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): CdRenderInput => {
  need(i, "disclosure_id", "cd_version", "transaction_type", "state", "loan", "apr", "fees", "escrow", "parties", "dates", "property_address", "cash_to_close_cents");
  const application_id = appOf(i, ctx);
  const loan = big(i.loan as CdRenderInput["loan"], ["loan_amount_cents", "pi_cents"]); const apr = big(i.apr as CdRenderInput["apr"], ["finance_charge_cents", "amount_financed_cents", "total_of_payments_cents"]); const escrow = big(i.escrow as CdRenderInput["escrow"], ["monthly_escrow_cents", "initial_escrow_payment_cents", "escrowed_costs_year1_cents", "non_escrowed_costs_year1_cents", "escrow_waiver_fee_cents"]);
  return { application_id, disclosure_id: str(i, "disclosure_id"), cd_version: num(i, "cd_version"), cd_reason: ((i.cd_reason as CdReason | undefined) ?? (num(i, "cd_version") === 1 ? "initial" : "pre_consummation_no_wait")), transaction_type: str(i, "transaction_type") as "purchase" | "refinance", state: str(i, "state"), loan: { ...loan, first_payment_date: D(String(loan.first_payment_date)), maturity_date: D(String(loan.maturity_date)) }, apr, fees: feeLines(i),
    figure_sources: Array.isArray(i.figure_sources) ? (i.figure_sources as CdRenderInput["figure_sources"]) : svcOf(ctx, rt).figureSources(application_id), escrow, parties: i.parties as CdRenderInput["parties"], dates: { date_issued: D(String((i.dates as Record<string, string>).date_issued)), closing_date: D(String((i.dates as Record<string, string>).closing_date)), disbursement_date: D(String((i.dates as Record<string, string>).disbursement_date)) }, property_address: str(i, "property_address"),
    cash_to_close_cents: cents(i.cash_to_close_cents), lender_credits_cents: cents(i.lender_credits_cents), ...(i.payoffs_and_payments_cents !== undefined ? { payoffs_and_payments_cents: cents(i.payoffs_and_payments_cents) } : {}), ...(typeof i.rescindable === "boolean" ? { rescindable: i.rescindable } : {}) };
};
const NO_TYPED_FIGURE = never("FIGURE_NEEDS_VERSIONED_SOURCE", "25.2 guardrails: never edit a figure without a versioned source", (i) => i.figure_override !== undefined || i.typed_figures !== undefined || i.manual_amount_cents !== undefined, "every CD figure comes from a `cd_figure_sources` version (settlement agent, creditor, MI, flood, payoff, escrow) — record and reconcile the source, never type the amount");
const NO_CD_FEE = never("NO_FEE_FOR_CD", "§1026.19(f)(5); 25.2-T14", (i) => Array.isArray(i.fees) && (i.fees as { description?: string; fee_code?: string }[]).some((f) => PROHIBITED_CD_FEE.test(String(f.description ?? "")) || PROHIBITED_CD_FEE.test(String(f.fee_code ?? "").replace(/_/g, " "))), "no fee may be imposed by a creditor or servicer for the preparation or delivery of the Closing Disclosure");

/**
 * 02 §1.1 `disclosures{cd}` figure snapshot (32.7 §1): the figures 25.2 rendered, kept on the disclosures row as decimal strings so the borrower
 * record can diff LE→CD and show the first payment without re-rendering — a projection of the render input, never a recomputation.
 */
const cdFigureSnapshot = (i: CdRenderInput): Record<string, unknown> => {
  const S = (v: unknown): string | null => (v === undefined || v === null ? null : String(v)); const x = i as unknown as Record<string, unknown>;
  return { rate_pct: S(i.loan.rate_pct), apr_pct: S(i.apr.apr_pct), pi_cents: S(i.loan.pi_cents), loan_amount_cents: S(i.loan.loan_amount_cents), cash_to_close_cents: S(x["cash_to_close_cents"]), lender_credits_cents: S(x["lender_credits_cents"]), payoffs_and_payments_cents: S(x["payoffs_and_payments_cents"]),
    monthly_escrow_cents: S((i.escrow as unknown as Record<string, unknown> | undefined)?.["monthly_escrow_cents"]), initial_escrow_payment_cents: S((i.escrow as unknown as Record<string, unknown> | undefined)?.["initial_escrow_payment_cents"]), fees: i.fees.map((f) => ({ fee_code: f.fee_code, description: f.description, amount_cents: S(f.amount_cents), section: f.section ?? null })) };
};

export const TOOLS_25_2: readonly ToolDef[] = defineTools("25.2", "disclosure", [
  { name: "assembleCdFigures", kind: "act", handler: compute((i, ctx, rt) => {
      const application_id = appOf(i, ctx); const svc = svcOf(ctx, rt);
      if (i.op === "record_source") {
        need(i, "source_id", "party", "payload");
        const src = svc.recordFigureSource({ source_id: str(i, "source_id"), application_id, party: str(i, "party") as FigureParty, payload: i.payload as Record<string, unknown>, payload_document_id: (i.payload_document_id as string | undefined) ?? null });
        rt.store.put("cd_figure_sources", src.source_id, { ...src, payload: undefined }, ctx.actor, ctx.now);
        return { source_id: src.source_id, party: src.party, version: src.version, hash: src.hash, reconciled: src.reconciled };
      }
      if (i.op === "schedule") { need(i, "scheduled_consummation_date"); return scheduleDelivery(dateIn(i, "scheduled_consummation_date"), (i.channel as CdDeliveryChannel | undefined) ?? "esign_portal"); }
      const sources = svc.figureSources(application_id);
      return { application_id, figure_sources: sources.map((s) => ({ source_id: s.source_id, party: s.party, version: s.version, hash: s.hash, reconciled: s.reconciled, variances: s.variances })), all_reconciled: sources.length > 0 && sources.every((s) => s.reconciled), fee_violations: Array.isArray(i.fees) ? validateCdFees(feeLines(i)) : [] }; }),
    guardrails: [NO_TYPED_FIGURE, NO_CD_FEE] },
  { name: "reconcileFigureSources", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "fees"); const application_id = appOf(i, ctx); const svc = svcOf(ctx, rt);
      if (i.source) { return reconcileFigureSource(i.source as never, feeLines(i), Array.isArray(i.resolved_codes) ? (i.resolved_codes as string[]) : []); }
      const out = svc.reconcileFigureSources(application_id, feeLines(i), Array.isArray(i.resolved_codes) ? (i.resolved_codes as string[]) : []);
      for (const s of out) rt.store.put("cd_figure_sources", s.source_id, { reconciled: s.reconciled, variances: s.variances }, ctx.actor, ctx.now);
      return out.map((s) => ({ source_id: s.source_id, party: s.party, version: s.version, reconciled: s.reconciled, variances: s.variances })); }),
    guardrails: [never("VARIANCE_NEEDS_SOURCE_RESOLUTION", "25.2 integrations: 'every inbound version is hashed and reconciled; unreconciled variances block the CD gate'", (i) => i.force_reconciled === true, "a variance is resolved by a new figure-source version from the party (or a resolved_codes list citing it), never by forcing reconciled=true")] },
  { name: "renderCd", kind: "act", handler: compute((i, ctx, rt) => {
      const input = renderInput(i, ctx, rt); const svc = svcOf(ctx, rt);
      if (i.op === "validate") return renderCd(input);
      const required = Array.isArray(i.required_consumer_ids) ? (i.required_consumer_ids as string[]) : []; if (!required.length) throw new RangeError("25.2 tool needs required_consumer_ids[] (every borrower; every rescinding consumer on a refinance)");
      const row = svc.prepare({ ...input, required_consumer_ids: required, supersedes: (i.supersedes as string | undefined) ?? null, ...(typeof i.pdf_document_id === "string" ? { pdf_document_id: i.pdf_document_id } : {}) });
      rt.store.put("disclosures", row.disclosure_id, { application_id: row.application_id, kind: row.kind, cd_version: row.cd_version, cd_reason: row.cd_reason, status: row.status, figures_hash: row.figures_hash, figure_source_version: row.figure_source_version, apr_calculation_id: row.apr_calculation_id, template_version: row.render.template_version, retention_class: row.retention_class, new_waiting_period: row.new_waiting_period, figures: cdFigureSnapshot(input) }, ctx.actor, ctx.now);
      return { disclosure_id: row.disclosure_id, cd_version: row.cd_version, status: row.status, figures_hash: row.figures_hash, checklist: row.render.checklist, notice_code: row.render.notice_code, le_gate_asserted_on: row.le_gate_asserted_on }; }),
    guardrails: [NO_CD_FEE, NO_TYPED_FIGURE] },
  { name: "deliverDisclosure", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "disclosure_id", "consumer_id", "channel"); const svc = svcOf(ctx, rt);
      if (!CD_DELIVERY_CHANNELS.includes(i.channel as CdDeliveryChannel)) throw new RangeError(`channel ${String(i.channel)} is not one of ${CD_DELIVERY_CHANNELS.join("/")}`);
      if (i.gate_run) { const g = i.gate_run as { run_id: string; open: boolean; apr_verdict?: "pass" | "fail" | null; blocked_channels?: string[] }; svc.recordGateRun(str(i, "disclosure_id"), g); }
      const r: CdReceipt = svc.deliver(str(i, "disclosure_id"), { consumer_id: str(i, "consumer_id"), channel: i.channel as CdDeliveryChannel, at: str(i, "at") || ctx.now, esign_consent_id: (i.esign_consent_id as string | undefined) ?? null, mailing_proof_id: (i.mailing_proof_id as string | undefined) ?? null, evidence_document_id: (i.evidence_document_id as string | undefined) ?? null });
      rt.store.put("cd_receipts", r.receipt_id, { ...r }, ctx.actor, ctx.now);
      return r; }),
    guardrails: [never("ELECTRONIC_NEEDS_ESIGN_CONSENT", "§1026.17(a)(1); 15 U.S.C. 7001(c); 25.1 ESIGN_7001C_CONSENT", (i) => (i.channel === "esign_portal" || i.channel === "email_link") && !i.esign_consent_id, "electronic delivery of the CD needs the consumer's unrevoked E-SIGN consent — otherwise print/mail the same day under the mailbox rule")] },
  { name: "recordReceipt", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "disclosure_id", "consumer_id", "evidence", "at"); const svc = svcOf(ctx, rt);
      const r = svc.recordReceipt(str(i, "disclosure_id"), { consumer_id: str(i, "consumer_id"), evidence: str(i, "evidence"), at: str(i, "at"), evidence_document_id: (i.evidence_document_id as string | undefined) ?? null });
      rt.store.put("cd_receipts", r.receipt.receipt_id, { ...r.receipt }, ctx.actor, ctx.now);
      return r; }),
    guardrails: [never("RECEIPT_EVIDENCE_KIND", "25.2 guardrails: never record actual_receipt_at without evidence of the enumerated kinds; never treat an oral confirmation as receipt (decision 25.2-Q2)", (i) => i.evidence !== undefined && !REBUTTING_EVIDENCE.includes(i.evidence as never), `receipt evidence is one of ${REBUTTING_EVIDENCE.join("/")} — an e-mail "opened" event, a phone call or an oral confirmation is not receipt`),
      never("RECEIPT_NEEDS_EVIDENCE_DOCUMENT", "25.2 'Human path': no \"mark received\" without an uploaded evidence document", (i) => i.evidence !== undefined && !i.evidence_document_id, "attach the e-sign certificate, portal acknowledgement, courier signature or the settlement agent's signed receipt")] },
  { name: "computeEarliestConsummation", kind: "act", handler: compute((i, ctx, rt) => {
      if (Array.isArray(i.receipts) && Array.isArray(i.required_consumer_ids)) return computeEarliestConsummation(i.receipts as CdReceipt[], i.required_consumer_ids as string[]);
      need(i, "disclosure_id"); const svc = svcOf(ctx, rt);
      if (i.op === "deem") { need(i, "today"); return svc.deemReceived(str(i, "disclosure_id"), dateIn(i, "today")); }
      if (i.op === "accept_waiver") {
        need(i, "waiver"); const w = i.waiver as CdWaiverInput;
        const wv = svc.acceptWaiver(str(i, "disclosure_id"), { ...w, dated_on: D(String(w.dated_on)) }, { by: ctx.actor, at: ctx.now });
        rt.store.put("cd_waivers", wv.waiver_id, { ...wv }, ctx.actor, ctx.now); return wv;
      }
      return svc.computeEarliestConsummation(str(i, "disclosure_id")); }),
    guardrails: [needsRole("WAIVER_ACCEPTED_BY_OFFICER", "25.2 guardrails: never shorten the waiting period except through a cd_waivers row accepted by officer (§1026.19(f)(1)(iv))", (i) => i.op === "accept_waiver", ["officer"], "acceptance of the consumer's bona fide personal financial emergency statement is the partner officer's act"),
      never("NO_PRINTED_WAIVER_FORM", "§1026.19(f)(1)(iv) 'Printed forms for this purpose are prohibited'; decision 25.2-Q3", (i) => i.op === "accept_waiver" && (((i.waiver as { printed_form?: boolean; template_used?: boolean } | undefined)?.printed_form ?? false) || ((i.waiver as { template_used?: boolean } | undefined)?.template_used ?? false)), "the waiver is the consumer's own dated, signed statement — never a platform-supplied form or template text"),
      never("NO_MANUAL_EARLIEST_DATE", "25.2 guardrails: never shorten the waiting period", (i) => i.earliest_consummation_date_override !== undefined, "earliest_consummation_date is computed from receipts on the regz_specific calendar, never set by hand")] },
  { name: "evaluateRedisclosure", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "next"); const next = big(i.next as RedisclosureInput["next"], ["finance_charge_cents"]);
      if (i.prev) return evaluateRedisclosure({ prev: big(i.prev as RedisclosureInput["prev"], ["finance_charge_cents"]), next, ...(i.transaction ? { transaction: i.transaction as never } : {}), apr_verdict: (i.apr_verdict as never) ?? null });
      need(i, "disclosure_id"); return svcOf(ctx, rt).evaluateRedisclosure(str(i, "disclosure_id"), next, { ...(i.transaction ? { transaction: i.transaction as never } : {}), apr_verdict: (i.apr_verdict as never) ?? null }); }),
    guardrails: [never("APR_VERDICT_IS_25_1", "25.2 rule 'Redisclosure decision': APR_inaccurate is 25.1's APR_1026_22_ACCURACY result", (i) => i.apr_inaccurate_override !== undefined || i.new_wait_override !== undefined, "new_wait derives from 25.1's accuracy verdict, the (a)(5)(iii) product description and the (b) prepayment-penalty statement — never set directly")] },
  { name: "runToleranceTest", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "stage"); const application_id = appOf(i, ctx);
      // 21.5 owns tolerance_tests / tolerance_cures / runToleranceTest; 25.2 invokes it at every CD version
      const engine = service<{ runToleranceTest(input: { application_id: string; stage: string; disclosure_id?: string; fee_items?: unknown; checkpoint?: string }): unknown }>(rt, "tolerance-21-5");
      return { delegated_to: "21.5", result: engine.runToleranceTest({ application_id, stage: str(i, "stage"), disclosure_id: str(i, "disclosure_id"), fee_items: i.fees, checkpoint: str(i, "stage").startsWith("cd") ? "cd" : "corrected_cd" }) }; }) },
  { name: "assertGateOpen", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "gate"); const gate = str(i, "gate"); const application_id = appOf(i, ctx); const svc = svcOf(ctx, rt);
      if (gate === "REGZ_1026_19F1_CD_3SBD_GATE") {
        need(i, "requested_on"); const facts = svc.gateFacts(application_id, dateIn(i, "requested_on")); const g = cd3sbdGate(facts);
        if (i.op === "evaluate") return { gate, ...g, facts };
        if (i.op === "consummate") { const row = svc.consummate(application_id, { at: str(i, "at") || ctx.now, requested_on: dateIn(i, "requested_on") }); rt.store.put("disclosures", row.disclosure_id, { status: row.status, consummated_at: row.consummated_at }, ctx.actor, ctx.now); return { gate, open: true, disclosure_id: row.disclosure_id, cd_version: row.cd_version }; }
        svc.assertGateOpen(application_id, dateIn(i, "requested_on")); return { gate, open: true, facts };
      }
      if (gate === "FNMA_UCD_ACCEPTED_GATE") { const facts = svc.ucdGateFacts(application_id); const g = ucdAcceptedGate(facts); if (i.op === "evaluate") return { gate, ...g, facts }; svc.assertUcdGateOpen(application_id); return { gate, open: true, facts }; }
      if (gate === "REGZ_1026_19E1III_LE_7SBD_GATE") { need(i, "requested_on"); const le = rt.services["le-21-2"] as { assertGateOpen(a: string, d: PlainDate): void } | undefined; if (le) le.assertGateOpen(application_id, dateIn(i, "requested_on")); else { need(i, "earliest_consummation_date"); assertLeGateOpen({ earliest_consummation_date: dateIn(i, "earliest_consummation_date"), requested_on: dateIn(i, "requested_on"), waiver_recorded_on: i.waiver_recorded_on ? dateIn(i, "waiver_recorded_on") : null }); } return { gate, open: true }; }
      const code = gateCode(gate); const s = i.snapshot as ComplianceSnapshot | undefined; if (!s || typeof s !== "object") throw new RangeError(`25.2 tool needs snapshot (25.1's canonical input snapshot for the ${GATES[code].checkpoint} checkpoint)`);
      const waivers = rt.store.list("compliance_waivers", (d) => d.application_id === application_id).map((r) => r.data as unknown as ComplianceWaiver);
      const existing = (rt.store.list("compliance_test_runs", (d) => d.application_id === application_id && d.gate === code && d.status !== "superseded").at(-1)?.data as unknown as ComplianceRun | undefined) ?? null;
      const r = assertComplianceGateOpen(ctx.events, code, { ...s, application_id }, { now: ctx.now, waivers, escalations: rt.escalations, existing_run: existing && Array.isArray(existing.tests) ? existing : null });
      const apr = r.run.tests.find((t) => t.test_code === "APR_1026_22_ACCURACY");
      if (typeof i.disclosure_id === "string" && i.disclosure_id) svc.recordGateRun(i.disclosure_id, { run_id: r.run.run_id, open: r.open, apr_verdict: apr ? (apr.result === "fail" ? "fail" : "pass") : null, blocked_channels: r.blocked_channels });
      return { gate, open: r.open, run_id: r.run.run_id, blocked_channels: r.blocked_channels, apr_verdict: apr?.result ?? null }; }),
    guardrails: [never("NO_FORCE_GATE_OPEN", "25.1 'Human path': there is no \"force gate open\"; 25.2 guardrails", (i) => i.force_open === true || i.force === true, "a gate re-derives only from the facts (receipts, an officer-accepted waiver, a new 25.1 run, an accepted UCD)")] },
  { name: "runCdConsistencyChecks", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "disclosure_id", "source"); const svc = svcOf(ctx, rt);
      const src = i.source as Partial<Record<ConsistencyCheckCode, ConsistencyValue>>; const bigKeys: ConsistencyCheckCode[] = ["CD_NOTE_LOAN_AMOUNT", "CD_NOTE_PI", "CD_CASH_TO_CLOSE_VS_SETTLEMENT_LEDGER"];
      for (const k of bigKeys) if (typeof src[k] === "string" && /^-?\d+$/.test(src[k] as string)) (src as Record<string, unknown>)[k] = BigInt(src[k] as string);
      const r = svc.runCdConsistencyChecks(str(i, "disclosure_id"), src);
      for (const c of r.checks) rt.store.put("cd_consistency_checks", c.check_id, { ...c }, ctx.actor, ctx.now);
      return r; }),
    guardrails: [never("MISMATCH_RESOLVED_BY_CORRECTED_CD", "25.2 rule 'CD-to-note consistency checks': any mismatch blocks 26.1's generateClosingDocuments until the CD is corrected", (i) => i.resolve === true || i.resolved_by !== undefined, "a mismatch is resolved by a corrected CD (or a corrected note/source) and a re-run, never by marking the row resolved")] },
  { name: "generateUcd", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "ucd_submission_id", "du_casefile_id"); const application_id = appOf(i, ctx); const svc = svcOf(ctx, rt);
      const sub = svc.generateUcd(application_id, { ucd_submission_id: str(i, "ucd_submission_id"), du_casefile_id: str(i, "du_casefile_id"), ...(typeof i.disclosure_id === "string" ? { disclosure_id: i.disclosure_id } : {}), ...(i.ucd_version ? { ucd_version: str(i, "ucd_version") as "1.5" | "2.0" } : {}), flags: (i.flags as Record<string, string> | undefined) ?? {}, channel: (i.channel as "di" | "ui" | undefined) ?? "di", loan_id: (i.loan_id as string | undefined) ?? ctx.loanId ?? null, submitted_by: `${ctx.actor.kind}:${ctx.actor.id}`, ...(typeof i.seller_cd_separate === "boolean" ? { seller_cd_separate: i.seller_cd_separate } : {}) });
      rt.store.put("ucd_submissions", sub.ucd_submission_id, { ...sub }, ctx.actor, ctx.now);
      return sub; }),
    guardrails: [never("NO_SUPERSEDED_CD_IN_UCD", "25.2 guardrails: never embed a superseded CD in the UCD; GSE UCD FAQ 'the most recent version of the CD must be included'", (i) => flag(i, "embed_superseded") || i.cd_status === "superseded", "the UCD embeds the CD version in force (consummated / final)")] },
  { name: "submitUcd", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "ucd_submission_id", "response"); const application_id = appOf(i, ctx); const svc = svcOf(ctx, rt);
      const resp = i.response as { status: Exclude<UcdStatus, "generated" | "submitted">; casefile_id_ucd: string | null; critical_edit_failures: number; feedback_messages?: string[] };
      const sub = svc.submitUcd(application_id, str(i, "ucd_submission_id"), { ...resp, at: str(i, "at") || ctx.now, channel: (i.channel as "di" | "ui" | undefined) ?? "di", submitted_by: ctx.actor });
      rt.store.put("ucd_submissions", sub.ucd_submission_id, { ...sub }, ctx.actor, ctx.now);
      if (sub.is_final) rt.store.put("deliveries", application_id, { application_id, ucd_casefile_id: sub.casefile_id_ucd }, ctx.actor, ctx.now);
      return sub; }),
    guardrails: [needsRole("UI_FALLBACK_IS_PORTAL_OPERATOR", "25.2 integrations: UI fallback by fnma_portal_operator", (i) => i.channel === "ui", ["fnma_portal_operator"], "a UCD uploaded through the UCD Collection Solution UI is the portal operator's act (same XML, same hash)")] },
  { name: "scheduleCorrectedCd", kind: "act", handler: compute((i, ctx, rt) => {
      const application_id = appOf(i, ctx); const svc = svcOf(ctx, rt);
      if (i.op === "record_event") {
        need(i, "event_on", "info_received_on", "description");
        return svc.recordCorrectionEvent(application_id, { event_on: dateIn(i, "event_on"), info_received_on: dateIn(i, "info_received_on"), numeric: i.numeric !== false, amount_paid_changed: i.amount_paid_changed !== false, in_connection_with_settlement: i.in_connection_with_settlement !== false, tolerance_refund: flag(i, "tolerance_refund"), description: str(i, "description") });
      }
      if (i.op === "seller_cd") { need(i, "document_id"); const e = svc.recordSellerCd(application_id, { document_id: str(i, "document_id"), received_at: str(i, "received_at") || ctx.now, provided_by: str(i, "provided_by") || "settlement_agent" }); return { event_id: e.id, delivery: svc.delivery(application_id) }; }
      need(i, "disclosure_id", "cd_reason", "input", "gate", "deliveries");
      const input = renderInput({ ...(i.input as ToolInput), application_id, disclosure_id: str(i, "disclosure_id"), cd_version: 0 }, ctx, rt);
      const { application_id: _a, disclosure_id: _d, cd_version: _v, cd_reason: _r, ...rest } = input;
      const prev = svc.current(application_id);
      const r = svc.scheduleCorrectedCd(application_id, { disclosure_id: str(i, "disclosure_id"), cd_reason: str(i, "cd_reason") as Exclude<CdReason, "initial">, input: rest, evaluation: (i.evaluation as never) ?? null, gate: i.gate as { run_id: string; apr_verdict: "pass" | "fail" }, deliveries: (i.deliveries as never[]).map((d: { at?: string }) => ({ ...d, at: d.at ?? ctx.now })) as never, ...(Array.isArray(i.cc_ids) ? { cc_ids: (i.cc_ids as unknown[]).map(String) } : {}) });
      rt.store.put("disclosures", r.row.disclosure_id, { application_id, kind: r.row.kind, cd_version: r.row.cd_version, cd_reason: r.row.cd_reason, status: r.row.status, figures_hash: r.row.figures_hash, new_waiting_period: r.row.new_waiting_period, redisclosure_triggers: r.row.redisclosure_triggers, supersedes: prev?.disclosure_id ?? null, figures: cdFigureSnapshot(input) }, ctx.actor, ctx.now);
      return { disclosure_id: r.row.disclosure_id, cd_version: r.row.cd_version, cd_reason: r.row.cd_reason, status: r.row.status, corrected_event_id: r.corrected_event.id, tolerance_test_invoked: r.tolerance_test_invoked, notice_code: "NTC_REGZ_1026_38_CD_CORRECTED" }; }),
    guardrails: [never("NO_WAIT_WITH_APR_FAIL", "25.2 guardrails: never issue a \"no-wait\" corrected CD when 25.1's APR verdict is fail (§1026.19(f)(2)(ii)(A))", (i) => i.cd_reason === "pre_consummation_no_wait" && (((i.gate as { apr_verdict?: string } | undefined)?.apr_verdict === "fail") || ((i.evaluation as { new_wait?: boolean } | undefined)?.new_wait === true)), "an inaccurate APR, a product change or an added prepayment penalty requires cd_reason = pre_consummation_new_wait and a new three-business-day waiting period"), NO_CD_FEE, NO_TYPED_FIGURE] },
  { name: "openEscalation", kind: "act", handler: escalate("settlement_agent"), humanRoles: ["officer", "settlement_agent", "fnma_portal_operator", "mlo_of_record", "human_agent", "ops_analyst"] },
  { name: "writeDecision", kind: "write", handler: decision() },
]);
