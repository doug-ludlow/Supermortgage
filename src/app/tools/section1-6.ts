/**
 * §1.6 tools — the spec's ten tool strings for the `custodial-recon` agent, verbatim, via `defineTools("1.6", …)`
 * (spec/registry/agents.json names them; src/app/tools.test.ts refuses any other name, so the acts the Agents paragraph
 * gives the `escrow` and `investor-reporting` agents run as `op`s of these tools — the same bus, the same guardrails,
 * as §17.3 does for its custodial-recon acts). The code paths live in src/domain/transfers/ops-1-6.ts; this file is the
 * bus binding and the `recon_variances` / `reconciliations` / `transfer_funds_receipts` / `escrow_analyses` /
 * `suspense_items` rows. Event vocabulary (what the §1.6 timer table keys on):
 *
 *   loadTapeBalances       recon.tape_balances.loaded; op=final_accounting → transfer.final_accounting.received
 *                          (FNMA_F1_11_FINAL_ACCOUNTING_30 satisfied; SM_ADVANCE_REIMBURSE_TRANSFEROR_30 armed)
 *   loadBankFeed           custodial-bank prior-day feed; op=wire → custodial.wire.received (transfer_funds_receipts, idempotent by reference)
 *   matchWires             recon.wires.matched (SM_RECON_WIRE_MATCH_1) | recon.variance.raised per unmatched wire (SM_RECON_VARIANCE_SLA_5)
 *   raiseVariance          recon.variance.raised / recon.variance.resolved (absorption and write-off guarded on this path);
 *                          op=loan_level → recon.loan.reconciled (SM_RECON_LOAN_LEVEL_T0) | recon.variance.raised per field
 *   classifyVariance       category by evidence; op=fnma_position → recon.fnma_position.balanced (SM_RECON_FNMA_POSITION_EOM) | recon.variance.raised{fnma_reporting_lag}
 *   postOpeningEntries     balanced entry set with a rule_ref on every line; op=reimburse_transferor → ledger.posted{advance_reimbursement_out}
 *                          (SM_ADVANCE_REIMBURSE_TRANSFEROR_30); op=seed_inherited_unapplied → suspense.item.created{reason_code=inherited_unapplied}
 *                          (the 6.5 register row whose closure satisfies SM_UNAPPLIED_INHERITED_REVIEW_60)
 *   writeDecision          agent_decisions row; op=escrow_computation_year → escrow.computation_year.decided (SM_ESCROW_COMPUTATION_YEAR_DECISION_30)
 *                          and, on a payment/method change, escrow.terms.changed_at_transfer (REGX_1024_17E_INITIAL_ESCROW_STMT_60)
 *
 * Guardrails (agents.json 1.6): a balance is adjusted only with transferor or bank evidence; absorbing or writing off any
 * variance requires `officer` approval (any amount on a borrower-affecting field; ≥ $25/loan, ≥ $5,000/batch otherwise);
 * the transferor is reimbursed only for amounts substantiated in its final accounting (F-1-11); no borrower contact.
 */
import { defineTools, write, decision, ledgerPost, compute, guard, never, port, cents, abs, str, flag, data, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wireVariance, classifyVariance, absorbNeedsOfficer, isBorrowerAffecting, type VarianceFacts, type LoanBalances } from "../../domain/transfers/reconciliation.ts";
import { raiseVariance as raiseVarianceEvent, resolveVariance } from "../../domain/transfers/inbound.ts";
import { reconcileLoanLevel, matchWireSet, wireReceipt, receiptsByWire, reconcileFnmaPosition, ingestFinalAccounting, reimburseTransferorAdvances, escrowContinuityDecision, inheritedUnappliedItem, varianceId, RULE_SET_VERSION_1_6, type ReceiptKind, type EscrowMethod, type TransferorEscrowAnalysis } from "../../domain/transfers/ops-1-6.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const today = (i: ToolInput, ctx: CommandContext): PlainDate => D(str(i, "today") || ctx.now.slice(0, 10));
const obj = (i: ToolInput | Record<string, unknown>, k: string): Record<string, unknown> => (typeof i[k] === "object" && i[k] !== null ? (i[k] as Record<string, unknown>) : {});
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const merged = (i: ToolInput): Record<string, unknown> => ({ ...data(i), ...((i.changes as Record<string, unknown> | undefined) ?? {}) });
const moneyRecord = (o: Record<string, unknown>): Record<string, bigint> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, cents(v)]));
const facts = (i: ToolInput): Omit<VarianceFacts, "difference_cents"> => obj(i, "facts") as Omit<VarianceFacts, "difference_cents">;
const loanBalances = (l: Record<string, unknown>): LoanBalances => ({ upb_cents: cents(l.upb_cents), escrow_cents: cents(l.escrow_cents), unapplied_cents: cents(l.unapplied_cents), corporate_advances_cents: cents(l.corporate_advances_cents), late_charges_cents: cents(l.late_charges_cents),
  ...(l.unremitted_pi_cents != null ? { unremitted_pi_cents: cents(l.unremitted_pi_cents) } : {}), ...(l.prepaid_next_period_pi_cents != null ? { prepaid_next_period_pi_cents: cents(l.prepaid_next_period_pi_cents) } : {}), ...(l.pi_advances_cents != null ? { pi_advances_cents: cents(l.pi_advances_cents) } : {}), ...(typeof l.escrow_interest_rate_pct === "string" ? { escrow_interest_rate_pct: l.escrow_interest_rate_pct } : {}) });
const finalAccountingFor = (ctx: CommandContext, batchId: string): DomainEvent | undefined => ctx.events.ofType("transfer.final_accounting.received").filter((e) => (e.payload as { batch_id?: unknown }).batch_id === batchId).at(-1);
/** The bus records guardrail refusals; a refusal decided inside a handler (against stored rows a guardrail cannot see) is recorded the same way. */
const refuseInHandler = (ctx: CommandContext, command: string, code: string, citation: string, reason: string, subjectId: string | null): never => {
  ctx.events.append({ type: "command.refused", loanId: ctx.loanId, actor: ctx.actor, payload: { command, code, citation, reason, subject_id: subjectId } });
  throw new CommandRefused(command, code, citation, reason);
};

// ---- guardrails --------------------------------------------------------------------------------------------------
const ABSORB_CITATION = "1.6 guardrails: absorbing or writing off any variance requires `officer` approval (any amount for borrower-affecting fields; ≥ $25/loan or ≥ $5,000/batch for portfolio-level)";
const EVIDENCE_CITATION = "1.6 guardrails: the agent may adjust a balance only with transferor evidence (corrected tape/trial balance) or bank evidence";
/** Absorption / write-off of a variance resolution (`d` = the row as it will be recorded). */
function absorbRefusal(d: Record<string, unknown>, i: ToolInput, ctx: CommandContext): string | undefined {
  const resolution = String(d.resolution ?? i.resolution ?? "");
  if (!["absorbed_by_supermortgage", "written_off_officer"].includes(resolution) || ctx.actor.role === "officer") return undefined;
  if (resolution === "written_off_officer") return "written_off_officer is an officer resolution";
  const v = abs(cents(d.difference_cents ?? i.variance_cents)); const scope = (d.loan_id ?? i.loan_id) ? "loan" : ((d.scope ?? i.scope) as "loan" | "batch" | undefined) ?? "batch";
  return absorbNeedsOfficer(v, scope, isBorrowerAffecting(String(d.field ?? i.field ?? "")) || flag(i, "borrower_affecting")) ? `absorbing ${v} cents on ${String(d.field ?? i.field ?? "a portfolio-level field")} (${scope} scope) requires an officer` : undefined;
}
/** An evidence-backed resolution without the evidence (`adjusted_with_evidence`, `transferor_corrected`) is the plug the guardrail forbids. */
function evidenceRefusal(d: Record<string, unknown>, i: ToolInput, ctx: CommandContext): string | undefined {
  const resolution = String(d.resolution ?? i.resolution ?? "");
  if (!["adjusted_with_evidence", "transferor_corrected"].includes(resolution) || ctx.actor.role === "officer") return undefined;
  return d.evidence_document_id || i.evidence_document_id ? undefined : `${resolution} needs evidence_document_id (the transferor's corrected tape/trial balance or bank evidence)`;
}
const varianceResolutionGuard = guard("ABSORB_NEEDS_OFFICER", ABSORB_CITATION, (i, ctx) => absorbRefusal(merged(i), i, ctx));
const varianceEvidenceGuard = guard("EVIDENCE_REQUIRED", EVIDENCE_CITATION, (i, ctx) => evidenceRefusal(merged(i), i, ctx));
const SUBSTANTIATION_CITATION = "1.6 rule 5 / F-1-11: the transferor is reimbursed only for amounts substantiated in the final accounting";
const substantiationGuard = guard("FINAL_ACCOUNTING_SUBSTANTIATION", SUBSTANTIATION_CITATION, (i, ctx) => {
  if (i.op !== "reimburse_transferor") return undefined;
  const fa = finalAccountingFor(ctx, str(i, "batch_id"));
  if (!fa) return `no final accounting received for batch ${str(i, "batch_id") || "?"} (F-1-11: reimburse once a final accounting is received)`;
  const claimed = cents((fa.payload as { advances_claimed_cents?: unknown }).advances_claimed_cents), total = cents(i.amount_cents) + cents(i.netted_cents);
  return total > claimed ? `reimbursement ${total} cents exceeds the ${claimed} cents of advances claimed in final accounting ${String((fa.payload as { document_id?: unknown }).document_id ?? "")}` : undefined;
});

// ---- tools ---------------------------------------------------------------------------------------------------------
export const TOOLS_1_6: readonly ToolDef[] = defineTools("1.6", "custodial-recon", [
  { name: "loadTapeBalances", kind: "write", handler: compute((i, ctx, rt) => {
      if (i.op === "final_accounting") {   // transferor SFTP: the post-transfer accounting (F-1-11) — validated, then `transfer.final_accounting.received`
        need(i, "batch_id", "document_id", "received_on", "transfer_date"); const batchId = str(i, "batch_id");
        const r = ingestFinalAccounting(ctx.events, { batch_id: batchId, document_id: str(i, "document_id"), received_on: date(i, "received_on"), transfer_date: date(i, "transfer_date"), advances_claimed_cents: cents(i.advances_claimed_cents), shortage_surplus_cents: cents(i.shortage_surplus_cents), fnma_adjustment_request_document_id: str(i, "fnma_adjustment_request_document_id") || null });
        rt.store.put("transfer_final_accountings", batchId, { batch_id: batchId, document_id: str(i, "document_id"), received_on: str(i, "received_on"), due: r.due, late: r.late, advances_claimed_cents: String(r.advances_claimed_cents), shortage_surplus_cents: String(r.shortage_surplus_cents), fnma_adjustment_request_document_id: str(i, "fnma_adjustment_request_document_id") || null }, ctx.actor, ctx.now);
        return { batch_id: batchId, due: r.due, late: r.late, advances_claimed_cents: r.advances_claimed_cents, shortage_surplus_cents: r.shortage_surplus_cents, adjustment_request_evidenced: r.adjustment_request_evidenced, batch_status: "final_accounting_received" };
      }
      return write("tape_balances", "recon.tape_balances.loaded")(i, ctx, rt); }) },
  { name: "loadTrialBalance", kind: "act", handler: compute((i, _c, rt) => port(rt, "lsdu").trialBalance(list<string>(i, "fnma_loan_numbers"))) },
  { name: "loadBankFeed", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "wire") {   // custodial-bank wire advice → `transfer_funds_receipts`, idempotent by bank reference (a replayed advice returns the row and appends nothing)
        need(i, "batch_id", "custodial_account_id", "kind", "amount_cents", "wire_reference"); const ref = str(i, "wire_reference");
        const existing = rt.store.list("transfer_funds_receipts", (d) => d.wire_reference === ref)[0];
        if (existing) return { ...existing.data, id: existing.id, duplicate: true };
        const r = wireReceipt({ batch_id: str(i, "batch_id"), custodial_account_id: str(i, "custodial_account_id"), kind: str(i, "kind") as ReceiptKind, amount_cents: cents(i.amount_cents), received_on: optDate(i, "received_on") ?? today(i, ctx), wire_reference: ref, sender: str(i, "sender") || null, expected_cents: i.expected_cents === undefined || i.expected_cents === null ? null : cents(i.expected_cents) });
        const id = `${str(i, "batch_id")}:${ref}`; rt.store.put("transfer_funds_receipts", id, r.row, ctx.actor, ctx.now); ctx.events.append(r.event);
        return { ...r.row, id, duplicate: false };
      }
      return port(rt, "custodialBank").priorDay(str(i, "account_number"), str(i, "as_of") || ctx.now.slice(0, 10)); }) },
  { name: "queryFnmaPosition", kind: "read", handler: compute((i, _c, rt) => port(rt, "lsdu").trialBalance([str(i, "fnma_loan_number")])) },
  // `recon.wires.matched` (SM_RECON_WIRE_MATCH_1) when the P&I and T&I wires both equal the trial-balance totals by category; otherwise one variance per wire and the batch stays in `variances_open`.
  { name: "matchWires", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "batch_id"); const batchId = str(i, "batch_id"); const on = today(i, ctx);
      const receipts = rt.store.list("transfer_funds_receipts", (d) => d.batch_id === batchId && d.kind !== "advance_reimbursement_out"); const got = receiptsByWire(receipts.map((r) => r.data));
      const received = { ti: i.ti_received_cents === undefined || i.ti_received_cents === null ? got.ti : cents(i.ti_received_cents), pi: i.pi_received_cents === undefined || i.pi_received_cents === null ? got.pi : cents(i.pi_received_cents), other: i.other_received_cents === undefined || i.other_received_cents === null ? got.other : cents(i.other_received_cents) };
      const open = rt.store.list("recon_variances", (d) => d.batch_id === batchId && !d.resolved_at).map((r) => r.id);
      const r = matchWireSet(ctx.events, { batch_id: batchId, loans: list<Record<string, unknown>>(i, "loans").map(loanBalances), ti_received_cents: received.ti, pi_received_cents: received.pi, other_received_cents: received.other, today: on, include_escrow_interest_month: flag(i, "include_escrow_interest_month"), open_variances: open, facts: facts(i) }, ctx.actor);
      for (const v of r.variances_raised) rt.store.put("recon_variances", v.variance_id, { batch_id: batchId, loan_id: null, field: `${v.wire}_wire`, value_trial_balance: String(v.wire === "ti" ? r.expected.ti_wire_cents : r.expected.pi_wire_cents), value_wire: String(v.wire === "ti" ? received.ti : received.pi), difference_cents: String(v.difference_cents), category: v.category, raised_at: on, sla_due: v.sla_due, sla_timer: "SM_RECON_VARIANCE_SLA_5" }, ctx.actor, ctx.now);
      for (const w of ["ti", "pi"] as const) { const x = w === "ti" ? r.ti : r.pi; rt.store.put("reconciliations", `${batchId}:boarding_wire_${w}`, { batch_id: batchId, kind: `boarding_wire_${w}`, scope: "batch", source_a: "trial_balance", source_b: "custodial_bank", expected_cents: String(w === "ti" ? r.expected.ti_wire_cents : r.expected.pi_wire_cents), received_cents: String(received[w]), difference_cents: String(x.variance_cents), status: x.blocks_wires_matched ? "open" : "balanced", as_of: on }, ctx.actor, ctx.now); }
      if (r.wires_matched) for (const rec of receipts) if (!rec.data.matched_at) rt.store.put("transfer_funds_receipts", rec.id, { ...rec.data, matched_at: on }, ctx.actor, ctx.now);
      return { expected: r.expected, received, ti: r.ti, pi: r.pi, wires_matched: r.wires_matched, batch_status: r.batch_status, variances_raised: r.variances_raised }; }) },
  // The append-only `recon_variances` row: raised with its category (never plugged), later resolved; absorption/write-off and evidence are guarded here, on the path that records it.
  { name: "raiseVariance", kind: "write", guardrails: [varianceResolutionGuard, varianceEvidenceGuard], handler: compute((i, ctx, rt) => {
      const on = today(i, ctx);
      if (i.op === "loan_level") {   // final tape vs trial balance on every money field (SM_RECON_LOAN_LEVEL_T0): reconciled → `recon.loan.reconciled`; else a variance per field
        need(i, "loan_id", "batch_id"); const loanId = str(i, "loan_id"), batchId = str(i, "batch_id"); const evidence = str(i, "evidence_document_id") || null;
        const open = rt.store.list("recon_variances", (d) => d.batch_id === batchId && d.loan_id === loanId && !d.resolved_at).map((r) => String(r.data.field));
        const r = reconcileLoanLevel(ctx.events, { loan_id: loanId, batch_id: batchId, tape: moneyRecord(obj(i, "tape")), trial_balance: moneyRecord(obj(i, "trial_balance")), reconciled_on: on, open_fields: open, evidence_document_id: evidence, facts: facts(i) }, ctx.actor);
        for (const v of r.variances) if (!open.includes(v.field)) rt.store.put("recon_variances", v.variance_id, { batch_id: batchId, loan_id: loanId, field: v.field, value_tape: String(v.tape), value_trial_balance: String(v.trial_balance), difference_cents: String(v.difference_cents), category: v.category, raised_at: on, sla_due: addBusinessDays(on, 5, servicer), sla_timer: "SM_RECON_VARIANCE_SLA_5" }, ctx.actor, ctx.now);
        for (const f of r.resolved) { const id = varianceId(batchId, f, loanId); rt.store.put("recon_variances", id, { ...(rt.store.get("recon_variances", id)?.data ?? {}), resolved_at: on, resolution: "transferor_corrected", evidence_document_id: evidence, resolved_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now); }
        rt.store.put("reconciliations", `${batchId}:${loanId}:boarding_loan_level`, { batch_id: batchId, loan_id: loanId, kind: "boarding_loan_level", scope: "loan", source_a: "final_tape", source_b: "trial_balance", difference_cents: String(r.variances.reduce((s, v) => s + abs(v.difference_cents), 0n)), status: r.status === "reconciled" ? "balanced" : "open", as_of: on }, ctx.actor, ctx.now);
        return { status: r.status, gate: r.gate, boardable: r.boardable, variances: r.variances, resolved: r.resolved };
      }
      const d = data(i); const id = str(i, "id") || `var-${rt.store.list("recon_variances").length + 1}`;
      const resolution = String(d.resolution ?? (i.changes as Record<string, unknown> | undefined)?.resolution ?? "");
      if (resolution) {   // the row as recorded (stored facts under the caller's) is what the guardrails judge — a resolution that names only an id cannot bypass them
        const row = { ...(rt.store.get("recon_variances", id)?.data ?? {}), ...merged(i), resolved_at: on, resolved_by: `${ctx.actor.kind}:${ctx.actor.id}` };
        const a = absorbRefusal(row, i, ctx); if (a) refuseInHandler(ctx, "raiseVariance", "ABSORB_NEEDS_OFFICER", ABSORB_CITATION, a, id);
        const e = evidenceRefusal(row, i, ctx); if (e) refuseInHandler(ctx, "raiseVariance", "EVIDENCE_REQUIRED", EVIDENCE_CITATION, e, id);
        const rec = rt.store.put("recon_variances", id, row, ctx.actor, ctx.now);
        resolveVariance(ctx.events, { variance_id: id, loan_id: (rec.data.loan_id as string | undefined) ?? null, resolution: resolution as Parameters<typeof resolveVariance>[1]["resolution"], evidence_document_id: (rec.data.evidence_document_id as string | undefined) ?? null }, on, ctx.actor);
        return rec.data;
      }
      const category = String(d.category ?? classifyVariance({ difference_cents: cents(d.difference_cents), ...facts(i) }));
      const rec = rt.store.put("recon_variances", id, { ...d, category, raised_at: on, sla_due: addBusinessDays(on, 5, servicer), sla_timer: "SM_RECON_VARIANCE_SLA_5" }, ctx.actor, ctx.now);
      raiseVarianceEvent(ctx.events, { variance_id: id, batch_id: String(d.batch_id ?? ""), loan_id: (d.loan_id as string | undefined) ?? null, field: String(d.field ?? ""), difference_cents: cents(d.difference_cents), category, ...(typeof d.reconciliation_id === "string" ? { reconciliation_id: d.reconciliation_id } : {}) }, on, ctx.actor);
      return rec.data; }) },
  { name: "classifyVariance", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "fnma_position") {   // Σ boarded UPB vs the LSDU position (SM_RECON_FNMA_POSITION_EOM): balanced → `recon.fnma_position.balanced`; a pre-LAR figure → `fnma_reporting_lag`, raised once
        need(i, "batch_id", "transfer_date", "as_of", "boarded_upb_cents", "fnma_position_upb_cents"); const batchId = str(i, "batch_id"); const asOf = date(i, "as_of");
        const vid = varianceId(batchId, "fnma_position"); const prev = rt.store.get("recon_variances", vid); const snapshot = str(i, "snapshot_document_id") || null;
        const r = reconcileFnmaPosition(ctx.events, { batch_id: batchId, transfer_date: date(i, "transfer_date"), as_of: asOf, boarded_upb_cents: cents(i.boarded_upb_cents), fnma_position_upb_cents: cents(i.fnma_position_upb_cents), transferor_pre_transfer_upb_cents: i.transferor_pre_transfer_upb_cents === undefined || i.transferor_pre_transfer_upb_cents === null ? null : cents(i.transferor_pre_transfer_upb_cents), transferor_lar_posted: flag(i, "transferor_lar_posted"), variance_open: !!prev && !prev.data.resolved_at, snapshot_document_id: snapshot }, ctx.actor);
        if (r.raised) rt.store.put("recon_variances", vid, { batch_id: batchId, loan_id: null, field: "upb", value_trial_balance: String(cents(i.boarded_upb_cents)), value_fnma: String(cents(i.fnma_position_upb_cents)), difference_cents: String(r.difference_cents), category: r.category, raised_at: asOf, must_close_by: r.must_close_by, sla_timer: "SM_RECON_FNMA_POSITION_EOM" }, ctx.actor, ctx.now);
        if (r.resolved) rt.store.put("recon_variances", vid, { ...(prev?.data ?? {}), resolved_at: asOf, resolution: "transferor_corrected", evidence_document_id: snapshot, resolved_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
        rt.store.put("reconciliations", `${batchId}:boarding_fnma_position`, { batch_id: batchId, kind: "boarding_fnma_position", scope: "batch", source_a: "boarded_upb", source_b: "lsdu_position", difference_cents: String(r.difference_cents), category: r.category, status: r.balanced ? "balanced" : "open", as_of: asOf, must_close_by: r.must_close_by }, ctx.actor, ctx.now);
        return { difference_cents: r.difference_cents, category: r.category, balanced: r.balanced, must_close_by: r.must_close_by, overdue: r.overdue, variance_id: r.variance_id, raised: r.raised, resolved: r.resolved, batch_status: r.balanced ? "fnma_position_reconciled" : "variances_open" };
      }
      const v = wireVariance(cents(i.expected_cents), cents(i.received_cents), (i.category as "ti" | "pi") ?? "ti", today(i, ctx), facts(i));
      return { ...v, category: i.facts || v.variance_cents === 0n ? v.category : classifyVariance({ difference_cents: v.variance_cents }) }; }) },
  { name: "draftTransferorQuery", kind: "write", handler: write("transferor_queries", "transferor_query.drafted") },
  { name: "postOpeningEntries", kind: "act",
    guardrails: [guard("EVIDENCE_REQUIRED", EVIDENCE_CITATION, (i) => (i.adjustment === true && !["transferor", "bank"].includes(str(i, "evidence")) ? "adjustment without transferor/bank evidence" : undefined)),
      guard("ABSORB_NEEDS_OFFICER", ABSORB_CITATION, (i, ctx) => {
        if (i.absorb !== true && !str(i, "write_off")) return undefined; const v = abs(cents(i.variance_cents));
        const needs = str(i, "write_off") !== "" || absorbNeedsOfficer(v, (i.scope as "loan" | "batch" | undefined) ?? "loan", flag(i, "borrower_affecting") || isBorrowerAffecting(str(i, "field")));
        return needs && ctx.actor.role !== "officer" ? `absorbing ${v} cents (${str(i, "scope") || "loan"} scope) requires an officer` : undefined; }),
      never("NO_BORROWER_CONTACT", "1.6 guardrails: no borrower contact from 1.6", (i) => flag(i, "borrower_contact") || i.recipients !== undefined || i.template_code !== undefined || i.channel !== undefined, "1.6 never contacts the borrower; escrow statements are Notice Registry outputs"),
      substantiationGuard],
    handler: compute((i, ctx, rt) => {
      switch (i.op) {
        case "reimburse_transferor": {   // F-1-11 advances reimbursement once the final accounting is in: Dr transfer_in_clearing (due_to_transferor) / Cr corporate_cash (+ Cr advance_receivable for the netted part)
          need(i, "batch_id", "custodial_account_id", "paid_on"); const batchId = str(i, "batch_id"); const fa = finalAccountingFor(ctx, batchId);
          if (!fa) throw new RangeError(`no final accounting received for batch ${batchId}`);
          const p = fa.payload as { advances_claimed_cents?: unknown; document_id?: unknown };
          const r = reimburseTransferorAdvances(ctx.ledger, ctx.events, { batch_id: batchId, custodial_account_id: str(i, "custodial_account_id"), paid_on: date(i, "paid_on"), amount_cents: cents(i.amount_cents), netted_cents: cents(i.netted_cents), substantiated_cents: cents(p.advances_claimed_cents), final_accounting_document_id: String(p.document_id ?? ""), wire_reference: str(i, "wire_reference") || null }, ctx.actor, ctx.now);
          rt.store.put("transfer_funds_receipts", `${batchId}:advance_reimbursement_out:${r.set.id}`, { batch_id: batchId, custodial_account_id: str(i, "custodial_account_id"), kind: "advance_reimbursement_out", expected_cents: String(cents(p.advances_claimed_cents)), received_cents: String(r.settled_cents), received_at: str(i, "paid_on"), wire_reference: str(i, "wire_reference") || null, matched_at: str(i, "paid_on"), set_id: r.set.id, variance_id: null }, ctx.actor, ctx.now);
          rt.store.put("reconciliations", `${batchId}:boarding_final_accounting`, { batch_id: batchId, kind: "boarding_final_accounting", scope: "batch", source_a: "final_accounting", source_b: "ledger", difference_cents: String(r.unsettled_cents), status: r.unsettled_cents === 0n ? "closed" : "balanced_with_variances", as_of: str(i, "paid_on") }, ctx.actor, ctx.now);
          return { set_id: r.set.id, amount_cents: r.amount_cents, netted_cents: r.netted_cents, settled_cents: r.settled_cents, unsettled_cents: r.unsettled_cents, batch_status: r.unsettled_cents === 0n ? "advances_settled" : "final_accounting_received" };
        }
        case "seed_inherited_unapplied": {   // the boarded unapplied balance as a 6.5 register item (reason_code inherited_unapplied) — its closure satisfies SM_UNAPPLIED_INHERITED_REVIEW_60
          need(i, "loan_id", "batch_id", "transfer_date", "unapplied_cents");
          const r = inheritedUnappliedItem({ loan_id: str(i, "loan_id"), batch_id: str(i, "batch_id"), transfer_date: date(i, "transfer_date"), unapplied_cents: cents(i.unapplied_cents), postpetition: flag(i, "postpetition") });
          const existing = rt.store.get("suspense_items", r.id); if (existing) return { ...existing.data, id: r.id, duplicate: true };
          rt.store.put("suspense_items", r.id, r.row, ctx.actor, ctx.now); ctx.events.append(r.event);
          return { ...r.row, duplicate: false };
        }
        default: return ledgerPost()(i, ctx);
      } }) },
  { name: "writeDecision", kind: "act", handler: compute((i, ctx, rt) => {
      if (i.op === "escrow_computation_year") {   // the `escrow` agent's continuity decision (§1024.17(e)(1)): retained | short_year | new_year, seeding `escrow_analyses` from the transferor's analysis
        need(i, "loan_id", "batch_id", "transfer_date", "transferor", "monthly_escrow_cents"); const loanId = str(i, "loan_id"); const t = obj(i, "transferor");
        need(t, "analysis_date", "computation_year_start", "monthly_escrow_cents");
        const transferor: TransferorEscrowAnalysis = { analysis_date: D(String(t.analysis_date)), computation_year_start: D(String(t.computation_year_start)), monthly_escrow_cents: cents(t.monthly_escrow_cents), cushion_cents: cents(t.cushion_cents), shortage_cents: cents(t.shortage_cents), surplus_cents: cents(t.surplus_cents), deficiency_cents: cents(t.deficiency_cents), shortage_spread_months: t.shortage_spread_months === undefined || t.shortage_spread_months === null ? null : Number(t.shortage_spread_months), method: (t.method as EscrowMethod | undefined) ?? "aggregate" };
        const r = escrowContinuityDecision(ctx.events, { loan_id: loanId, batch_id: str(i, "batch_id"), transfer_date: date(i, "transfer_date"), decided_on: today(i, ctx), transferor, supermortgage: { monthly_escrow_cents: cents(i.monthly_escrow_cents), ...(typeof i.method === "string" ? { method: i.method as EscrowMethod } : {}), ...(i.short_year_statement !== undefined ? { short_year_statement: flag(i, "short_year_statement") } : {}) } }, ctx.actor);
        rt.store.put("escrow_analyses", `${loanId}:transferor`, r.escrow_analysis_seed, ctx.actor, ctx.now);
        ctx.decide({ agent: ctx.actor.id, action: `escrow.computation_year:${r.decision}`, rationale: str(i, "rationale") || `payment ${r.payment_changed ? "changed" : "kept"}, method ${r.method_changed ? "changed" : "kept"} (${r.method}); computation year ${r.decision} from ${r.computation_year_start}${r.initial_statement_due ? `; initial escrow statement due ${r.initial_statement_due}` : ""}`, ruleSetVersion: RULE_SET_VERSION_1_6.regx, loanId, subject: { kind: "loan", id: loanId }, ruleCode: "§1024.17(e)(1)", ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}) });
        return { decision: r.decision, computation_year_start: r.computation_year_start, initial_statement_due: r.initial_statement_due, initial_statement_required: r.initial_statement_required, payment_changed: r.payment_changed, method_changed: r.method_changed, method: r.method, inherited: r.inherited, timer_satisfied: r.timer_satisfied };
      }
      return decision()(i, ctx); }) },
]);

export type { ToolRuntime };
