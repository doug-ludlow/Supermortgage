/**
 * §30.4 process-owned tools — bus tools for 30.4 defined with `defineTools("30.4", "boarding", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 30.4; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The hand-off profile of the `boarding` agent (spec "AI agent design"): openHandoff, verifyTimerSeeding, repairTimer,
 * requestVendorActivation, confirmVendorActivation (op=confirm|reject), reconcileFirstStatement, evaluateEpd
 * (op=run|clear|close_watch), compileServicingFile (op=request|compile), classifyRetention, explainFnmaLetter (portal
 * content), closeHandoff, requestOfficerOverride. Guardrails encode the paragraph: the agent cannot send a consumer notice
 * from this process; cannot clear an `epd_flags` row without a ledger event; cannot mark HO-018 `not_applicable` when
 * `mi_certificates` exists; cannot close a hand-off with breached statutory items without an `officer` override.
 * State lives in the entity store (`servicing_handoffs` = the HandoffState per loan, `vendor_activations`, `epd_flags`,
 * `servicing_file_compilations`, `retention_schedule`); events go through ops-30-4.ts so the 30.4 timers arm and close.
 */
import { defineTools, compute, escalate, never, needsRole, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { ToolRuntime } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { openHandoff, satisfyItem, breachItem, recordPurchase, mirrorOwnershipNotice, fnmaLetterEvidenced, ownershipNoticeMayRender, FNMA_LETTER_EXPLAINER, reconcileFirstStatement, runEpdDaily, clearEpdFlags, closeEpdWatch, epdWatchUntil,
  requestVendorActivation, confirmVendorActivation, rejectVendorActivation, requestServicingFile, compileHandoffServicingFile, classifyRetention, expectedSeedSet, verifyTimerSeeding, repairTimer, recordSeedingVerified, closeHandoff, handoffCompletion,
  type HandoffState, type HandoffCtx, type VendorKind, type VendorActivationRow, type EpdFlagRow, type EpdInstallment, type ServicingFileKind, type SeedFixture, type RenderedStatement, type BoardedFigures, type RetentionAnchors, type CloseInput } from "../../domain/orig-boarding/ops-30-4.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`30.4 tool needs ${missing.join(", ")}`); };
const ctxOf = (i: ToolInput, ctx: CommandContext): HandoffCtx => {
  const loan_id = (i.loan_id as string | undefined) ?? ctx.loanId; const application_id = (i.application_id as string | undefined) ?? ctx.applicationId;
  if (!loan_id) throw new RangeError("30.4 tool needs loan_id"); if (!application_id) throw new RangeError("30.4 tool needs application_id (events carry both ids during the hand-off)");
  return { loan_id, application_id };
};
const handoffOf = (rt: ToolRuntime, loanId: string): HandoffState => { const r = rt.store.get("servicing_handoffs", loanId); if (!r) throw new RangeError(`no servicing_handoffs row for ${loanId} (openHandoff first)`); return r.data as unknown as HandoffState; };
const saveHandoff = (rt: ToolRuntime, ctx: CommandContext, s: HandoffState): HandoffState => { rt.store.put("servicing_handoffs", s.handoff.loan_id, s as unknown as Record<string, unknown>, ctx.actor, ctx.now); return s; };
const dateIn = (i: ToolInput, k: string): PlainDate => D(str(i, k));
const flagsOf = (rt: ToolRuntime, loanId: string): EpdFlagRow[] => ((rt.store.get("epd_flags", loanId)?.data.flags as EpdFlagRow[] | undefined) ?? []);
const bigints = <T extends object>(o: T, keys: readonly string[]): T => { const out: Record<string, unknown> = { ...(o as Record<string, unknown>) }; for (const k of keys) if (out[k] !== undefined && out[k] !== null && typeof out[k] !== "bigint") out[k] = BigInt(String(out[k])); return out as unknown as T; };

export const TOOLS_30_4: readonly ToolDef[] = defineTools("30.4", "boarding", [
  { name: "openHandoff", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "boarded_at", "first_payment_date"); const c = ctxOf(i, ctx);
      const r = openHandoff(ctx.events, { ...c, boarded_at: str(i, "boarded_at"), first_payment_date: dateIn(i, "first_payment_date"), mi_certificates_present: flag(i, "mi_certificates_present"), escrowed: i.escrowed !== false, purchase_date: i.purchase_date ? dateIn(i, "purchase_date") : null }, ctx.timers);
      for (const a of r.vendor_requests) rt.store.put("vendor_activations", a.activation_id, a as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      saveHandoff(rt, ctx, { handoff: r.handoff, items: r.items });
      return { handoff: r.handoff, items: r.items, vendor_requests: r.vendor_requests, retired_mi_timer_id: r.retired_mi_timer_id, event_id: r.event.id }; }),
    guardrails: [never("HO018_NA_WITH_MI_CERTIFICATE", "30.4 guardrails: the agent cannot mark HO-018 not_applicable when mi_certificates exists", (i) => i.ho018_not_applicable === true && i.mi_certificates_present === true, "HO-018 stays pending while mi_certificates exists — the insurer's activation confirmation (mi_policy.activated) satisfies it")] },
  { name: "verifyTimerSeeding", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "fixture"); const c = ctxOf(i, ctx);
      const f = i.fixture as SeedFixture;
      const expected = expectedSeedSet(f);
      const seeded = Array.isArray(i.seeded) ? (i.seeded as { code: string; anchor_date: PlainDate }[]) : ctx.timers.forSubject("loan", c.loan_id).map((t) => ({ code: t.code, anchor_date: t.anchorDate }));
      const v = verifyTimerSeeding(expected, seeded);
      const repairs = Array.isArray(i.repairs) ? (i.repairs as { code: string; anchor_date: PlainDate; created_by: string }[]) : [];
      const st = rt.store.get("servicing_handoffs", c.loan_id) ? handoffOf(rt, c.loan_id) : null;
      if (st && (v.ok || repairs.length)) { const r = recordSeedingVerified(ctx.events, st, v, repairs, ctx.now); saveHandoff(rt, ctx, { handoff: r.handoff, items: r.items }); }
      return { ...v, expected_count: expected.length, expected }; }) },
  { name: "repairTimer", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "code", "anchor_date", "reason"); const c = ctxOf(i, ctx);
      const r = repairTimer(ctx.events, c, { code: str(i, "code"), anchor_date: dateIn(i, "anchor_date"), owner: str(i, "owner") || "30.4", reason: str(i, "reason"), at: ctx.now });
      rt.store.put("timer_repairs", `${c.loan_id}:${r.instance.code}:${r.instance.anchor_date}`, { ...r.instance }, ctx.actor, ctx.now);
      return r.instance; }) },
  { name: "requestVendorActivation", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "vendor_kind"); const c = ctxOf(i, ctx);
      const r = requestVendorActivation(ctx.events, { ...c, vendor_kind: str(i, "vendor_kind") as VendorKind, requested_at: str(i, "requested_at") || ctx.now, ...(typeof i.attempt === "number" ? { attempt: i.attempt } : {}), ...(Array.isArray(i.apns) ? { apns: i.apns as string[] } : {}), ...(i.escrowed !== undefined ? { escrowed: i.escrowed === true } : {}),
        ...(typeof i.lol_certificate_id === "string" ? { lol_certificate_id: i.lol_certificate_id } : {}), ...(Array.isArray(i.policies) ? { policies: i.policies as string[] } : {}), ...(typeof i.mi_certificate_number === "string" ? { mi_certificate_number: i.mi_certificate_number } : {}), ...(i.correction ? { correction: i.correction as Record<string, unknown> } : {}) });
      rt.store.put("vendor_activations", r.activation.activation_id, r.activation as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      return r.activation; }) },
  { name: "confirmVendorActivation", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "activation_id"); const c = ctxOf(i, ctx);
      const a = (i.activation as VendorActivationRow | undefined) ?? (rt.store.get("vendor_activations", str(i, "activation_id"))?.data as VendorActivationRow | undefined);
      if (!a) throw new RangeError(`no vendor_activations row ${str(i, "activation_id")}`);
      const st = rt.store.get("servicing_handoffs", c.loan_id) ? handoffOf(rt, c.loan_id) : null;
      if (i.op === "reject") {
        need(i, "reject_reason", "boarded_on");
        const r = rejectVendorActivation(ctx.events, { ...c, activation: a, reject_reason: str(i, "reject_reason"), rejected_at: str(i, "rejected_at") || ctx.now, boarded_on: dateIn(i, "boarded_on"), next_installment_due: i.next_installment_due ? dateIn(i, "next_installment_due") : null, origination_record_wrong: flag(i, "origination_record_wrong") });
        rt.store.put("vendor_activations", a.activation_id, r.activation as unknown as Record<string, unknown>, ctx.actor, ctx.now);
        if (r.escalation) rt.escalations.open({ kind: "sev2", loanId: c.loan_id, applicationId: c.application_id, severity: "sev2", payload: { vendor_kind: a.vendor_kind, reject_reason: r.activation.reject_reason, escalate_at: r.escalation.at, fallback: r.escalation.fallback } }, ctx.actor);
        return { activation: r.activation, retry: r.retry, escalation: r.escalation };
      }
      need(i, "contract_ref");
      const r = confirmVendorActivation(ctx.events, st, { ...c, activation: a, contract_ref: str(i, "contract_ref"), confirmed_at: str(i, "confirmed_at") || ctx.now, ...(Array.isArray(i.parcels_confirmed) ? { parcels_confirmed: i.parcels_confirmed as string[] } : {}), ...(Array.isArray(i.expected_apns) ? { expected_apns: i.expected_apns as string[] } : {}),
        ...(Array.isArray(i.installments) ? { installments: (i.installments as { due_on: PlainDate; amount_cents: unknown }[]).map((x) => bigints(x, ["amount_cents"]) as { due_on: PlainDate; amount_cents: bigint }) } : {}), ...(Array.isArray(i.projected_bills) ? { projected_bills: (i.projected_bills as { due_on: PlainDate; amount_cents: unknown }[]).map((x) => bigints(x, ["amount_cents"]) as { due_on: PlainDate; amount_cents: bigint }) } : {}), evidence_document_id: (i.evidence_document_id as string | undefined) ?? null });
      rt.store.put("vendor_activations", a.activation_id, r.activation as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      if (r.state) saveHandoff(rt, ctx, r.state);
      return { activation: r.activation, variance: r.variance, item_event_id: r.item_event?.id ?? null }; }) },
  { name: "reconcileFirstStatement", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "statement", "boarded", "statement_event_id"); const c = ctxOf(i, ctx);
      const st = handoffOf(rt, c.loan_id);
      const statement = bigints(i.statement as RenderedStatement, ["amount_due_cents", "late_fee_cents", "upb_cents", "escrow_balance_cents"]);
      const boarded = bigints(i.boarded as BoardedFigures, ["pi_cents", "escrow_payment_cents", "mi_cents", "original_amount_cents", "escrow_deposit_cents", "escrow_disbursed_cents", "late_charge_cap_cents"]);
      const r = reconcileFirstStatement(ctx.events, st, { statement, boarded, statement_event_id: str(i, "statement_event_id"), at: ctx.now });
      saveHandoff(rt, ctx, r.state);
      if (!r.passed && r.mismatches.some((m) => m.severity === "sev2")) rt.escalations.open({ kind: "sev2", loanId: c.loan_id, applicationId: c.application_id, severity: "sev2", payload: { item_code: "HO-006", mismatches: r.mismatches, corrected_statement_by: "7.1" } }, ctx.actor);
      return { passed: r.passed, expected: r.expected, mismatches: r.mismatches, corrected_statement_required: r.corrected_statement_required, corrected_by: r.corrected_by }; }) },
  { name: "evaluateEpd", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "as_of"); const c = ctxOf(i, ctx);
      const as_of = dateIn(i, "as_of");
      const flags = (i.flags as EpdFlagRow[] | undefined) ?? flagsOf(rt, c.loan_id);
      const installments = (i.installments as EpdInstallment[] | undefined) ?? [];
      if (i.op === "close_watch") {
        need(i, "first_payment_date");
        return closeEpdWatch(ctx.events, { ...c, as_of, epd_watch_until: epdWatchUntil(dateIn(i, "first_payment_date")), paid_off_on: i.paid_off_on ? dateIn(i, "paid_off_on") : null, transferred_on: i.transferred_on ? dateIn(i, "transferred_on") : null });
      }
      if (i.op === "clear") {
        need(i, "clear_reason", "ledger_event_id");
        const r = clearEpdFlags(ctx.events, { ...c, as_of, installments, flags, clear_reason: str(i, "clear_reason") as "payment" | "reversal" | "posting_error", ledger_event_id: str(i, "ledger_event_id") });
        rt.store.put("epd_flags", c.loan_id, { flags: r.flags }, ctx.actor, ctx.now);
        return { cleared: r.cleared, qc_withdraw: r.qc_withdraw, flags: r.flags };
      }
      const r = runEpdDaily(ctx.events, { ...c, as_of, installments, flags });
      rt.store.put("epd_flags", c.loan_id, { flags: r.flags }, ctx.actor, ctx.now);
      return { raised: r.raised, flags: r.flags }; }),
    guardrails: [never("EPD_CLEAR_NEEDS_LEDGER_EVENT", "30.4 guardrails: the agent cannot clear an epd_flags row without a ledger event", (i) => i.op === "clear" && !i.ledger_event_id, "an epd_flags row clears only on a ledger event (payment, reversal or posting-error correction) — pass ledger_event_id")] },
  { name: "compileServicingFile", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "kind"); const c = ctxOf(i, ctx);
      const kind = str(i, "kind") as ServicingFileKind;
      if (i.op === "request") { need(i, "requested_at"); return requestServicingFile(ctx.events, { ...c, kind, requested_at: str(i, "requested_at"), requester: (i.requester as string | undefined) ?? null, scope: (i.scope as string | undefined) ?? null }); }
      need(i, "requested_at", "ledger_entries", "data_fields");
      const t0 = performance.now();
      const st = rt.store.get("servicing_handoffs", c.loan_id) ? handoffOf(rt, c.loan_id) : null;
      const r = compileHandoffServicingFile(ctx.events, st, { ...c, kind, request_id: (i.request_id as string | undefined) ?? null, requested_at: str(i, "requested_at"), compiled_at: ctx.now, elapsed_ms: typeof i.elapsed_ms === "number" ? i.elapsed_ms : Math.round(performance.now() - t0),
        ledger_entries: i.ledger_entries as Record<string, unknown>[], security_instrument: (i.security_instrument as { document_id: string; recorded: boolean } | undefined) ?? null, interaction_notes: (i.interaction_notes as Record<string, unknown>[] | undefined) ?? [], agent_decisions: (i.agent_decisions as Record<string, unknown>[] | undefined) ?? [],
        data_fields: i.data_fields as { loans: Record<string, unknown> }, borrower_documents: (i.borrower_documents as Record<string, unknown>[] | undefined) ?? [] });
      rt.store.put("servicing_file_compilations", r.compilation.compilation_id, r.compilation as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      rt.store.put("documents", r.compilation.package_document_id, { loan_id: c.loan_id, kind: "servicing_file_package", sha256: r.compilation.package_sha256, compilation_id: r.compilation.compilation_id }, ctx.actor, ctx.now);
      if (r.state) saveHandoff(rt, ctx, r.state);
      if (r.compilation.items.ii.included === false) rt.escalations.open({ kind: "sev2", loanId: c.loan_id, applicationId: c.application_id, severity: "sev2", payload: { compilation_id: r.compilation.compilation_id, gap: "(ii) security instrument copy missing" } }, ctx.actor);
      return { compilation: r.compilation, gaps: r.bundle.gaps }; }) },
  { name: "classifyRetention", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "documents", "anchors"); const c = ctxOf(i, ctx);
      const r = classifyRetention(ctx.events, c, { documents: i.documents as { document_id: string; kind: string }[], anchors: i.anchors as RetentionAnchors, computed_at: ctx.now });
      for (const row of r.rows) rt.store.put("retention_schedule", row.document_id, row as unknown as Record<string, unknown>, ctx.actor, ctx.now);
      const st = rt.store.get("servicing_handoffs", c.loan_id) ? handoffOf(rt, c.loan_id) : null;
      if (st && r.gate_open) { const s2 = satisfyItem(ctx.events, st, "HO-020", { at: ctx.now, evidence_event_id: r.events[0]!.id }); saveHandoff(rt, ctx, { handoff: s2.handoff, items: s2.items }); }
      return { rows: r.rows, classified_count: r.classified_count, unclassified: r.unclassified, gate_open: r.gate_open, purge_floor: r.purge_floor }; }) },
  { name: "explainFnmaLetter", kind: "act", handler: compute((i, ctx, rt) => {
      if (!i.purchase_date && !i.evidence_document_id) return { explainer: FNMA_LETTER_EXPLAINER, may_render_fallback_notice: false };   // harmless read of the portal content
      const c = ctxOf(i, ctx);
      if (i.evidence_document_id) {
        need(i, "received_on");
        const st = handoffOf(rt, c.loan_id);
        const r = fnmaLetterEvidenced(ctx.events, st, { document_id: str(i, "evidence_document_id"), received_on: dateIn(i, "received_on"), source: (i.source as "borrower_upload" | "fnma_copy" | "borrower_reported" | undefined) ?? "borrower_upload" });
        saveHandoff(rt, ctx, { handoff: r.handoff, items: r.items });
        return { status: r.status, evidence_event_id: r.evidence_event.id, explainer: FNMA_LETTER_EXPLAINER };
      }
      const m = mirrorOwnershipNotice(ctx.events, { ...c, purchase_date: dateIn(i, "purchase_date"), covered_person: (i.covered_person as "fannie_mae" | "sm_warehouse_assignee" | "other" | undefined) ?? "fannie_mae", written_fnma_instruction_on_file: flag(i, "written_fnma_instruction_on_file") });
      if (rt.store.get("servicing_handoffs", c.loan_id)) saveHandoff(rt, ctx, recordPurchase(handoffOf(rt, c.loan_id), dateIn(i, "purchase_date")));
      return { status: m.status, due_date: m.due_date, evidence_due: m.evidence_due, sender: m.sender, render_notice: m.render_notice, may_render_fallback_notice: ownershipNoticeMayRender(m.status, m.sender), explainer_primed_on: m.explainer_primed_on, explainer: FNMA_LETTER_EXPLAINER }; }),
    guardrails: [never("NO_CONSUMER_NOTICE_FROM_30_4", "30.4 guardrails: the agent cannot send a consumer notice from this process; never send NTC_REGZ_1026_39_OWNERSHIP_TRANSFER while status='expected'", (i) => i.send_notice === true || typeof i.template_code === "string", "30.4 sends no consumer notice — the explainer is portal content; §1026.39 letters are Fannie Mae's (25.4 owns the fallback template)")] },
  { name: "closeHandoff", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "as_of"); const c = ctxOf(i, ctx);
      let st = handoffOf(rt, c.loan_id);
      for (const b of (Array.isArray(i.breached_items) ? (i.breached_items as { item_code: string; timer_id: string }[]) : [])) { const r = breachItem(ctx.events, st, b.item_code, { timer_id: b.timer_id, at: ctx.now }); st = { handoff: r.handoff, items: r.items }; }
      const ov = i.override as CloseInput["override"] | undefined;
      const r = closeHandoff(ctx.events, st, { as_of: dateIn(i, "as_of"), third_statement_sent_on: i.third_statement_sent_on ? dateIn(i, "third_statement_sent_on") : null, retention_gate_open: i.retention_gate_open !== false, paid_off_on: i.paid_off_on ? dateIn(i, "paid_off_on") : null, transferred_on: i.transferred_on ? dateIn(i, "transferred_on") : null,
        override: ov ? { ...ov, officer_actor: ov.officer_actor ?? ctx.actor } : null, agent_decision_id: (i.agent_decision_id as string | undefined) ?? null });
      saveHandoff(rt, ctx, r.state);
      return { closed: r.closed, refused: r.refused, status: r.status, close_basis: r.close_basis, closed_at: r.closed_at, open_items: r.open_items, statutory_breaches: r.statutory_breaches, exception_count: r.exception_count, timers_kept_running: r.timers_kept_running, completion: handoffCompletion(r.state, i.retention_gate_open !== false) }; }),
    guardrails: [needsRole("STATUTORY_BREACH_CLOSE_NEEDS_OFFICER", "30.4 guardrails: cannot close a hand-off with breached statutory items (HO-004, HO-009 when SM is the sender, HO-019/REGX_1024_38C2_SERVICING_FILE_5) without an officer override", (i) => i.override !== undefined && i.override !== null, ["officer"], "closure with exceptions is the officer's override decision (close_basis=officer_override)"),
      never("OVERRIDE_LISTS_EXCEPTIONS", "30.4 rule 12: closure with open items requires close_basis='officer_override' with the list of exceptions and their follow-on owners", (i) => { const o = i.override as { exceptions?: unknown[] } | undefined; return !!o && (!Array.isArray(o.exceptions) || o.exceptions.length === 0); }, "an override must list every open item with its follow-on owner")] },
  { name: "requestOfficerOverride", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "exceptions"); const c = ctxOf(i, ctx);
      const exceptions = i.exceptions as { item_code: string; follow_on_owner: string; note?: string }[];
      if (!exceptions.length) throw new RangeError("requestOfficerOverride needs at least one exception (item_code, follow_on_owner)");
      return escalate("officer")({ ...i, loan_id: c.loan_id, kind: "officer", payload: { request: "close_handoff_with_exceptions", exceptions, close_by: str(i, "close_by") || null, rationale: str(i, "rationale") || null, rule_set_version: "30.4@rules.v1" } }, ctx, rt); }) },
]);
