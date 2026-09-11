/**
 * §27.1 process-owned tools — bus tools for 27.1 defined with `defineTools("27.1", "warehouse", defs)` from
 * ../tools.ts. Every tool string is one spec/registry/agents.json names for 27.1 (`warehouse`): evaluateEligibility,
 * computeBorrowingBase, approveAdvance, prepareWire (hands to funding_approver), funding_approver (the human dual-control
 * release — humanOnly), issueBaileeLetter (renders; routes to officer{sm} e-signature), trackCollateral (trust receipts,
 * Secured Party, Interim Funder, shipments, Control returned), confirmTransferOfControl (eRegistry, as Secured Party),
 * accrueInterest, capitalizeInterest, assessFee, ageAdvances, issueCurtailment, recordDefect, demandRepurchase,
 * issueKickout (requires officer{sm} acknowledgment), testCovenants, renderDailyReport, writeDecision.
 * Guardrails encode the paragraph: never fund without funding_approver release; never approve an advance failing a
 * hard criterion; never re-underwrite or contact the borrower; never alter a payee code or Letter Name; never sign a
 * bailee letter / Form 2004A (human officer{sm}); never liquidate or set off without officer{sm} acknowledgment;
 * never waive a covenant; never read applicant_demographics. Spread by ./index.ts.
 */
import { defineTools, compute, decision, never, needsRole, gate, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Cents } from "../../kernel/money/index.ts";
import {
  FACILITY_FIXTURE, POLICY_VERSION, RULE_SETS, SM_MERS_ORG_ID, GuardrailViolation, FakeWarehouseBank, FakeERegistry, FakeWarehouseCustodian,
  evaluateEligibility, computeBorrowingBase, toOpenAdvance, requestAdvance, decideAdvance, recordAdvanceDecision, fundAdvance, wireValueDate, advanceDecisionRecord,
  issueBaileeLetter, signBaileeLetter, baileeLetterEvent, recordTrustReceipt, recordSecuredPartyAdded, recordInterimFunderCheck, recordControlReturned, confirmTransferOfControl, requestShipment, releaseShipment, unwindOnRescission,
  indexRateFor, allInRateBps, accrueDay, recordAccrual, accrualLedgerSet, capitalizeMonth, recordCapitalization, capitalizationLedgerSet, assessFee, recordFee, feeLedgerSet,
  ageAdvance, curtailmentAt45, wetOverdue, repurchaseSchedule, kickoutOn, issueCurtailment, payCurtailment, curtailmentLedgerSet, issueMarginCall, recordDefect, cureDefect, demandRepurchase, completeRepurchase, issueKickout, payoffStatement,
  recordBorrowingBase, renderDailyReport, issueDailyReport, endCovenantPeriod, recordCovenantTests, covenantWaiverAllowed, requestFacilityActivation, activateFacility, fileUccContinuation, resumeFacility, etDate,
  type FacilityTerms, type AdvanceRecord, type AdvanceRequest, type EligibilityFacts, type EligibilitySnapshot, type AccrualRow, type AccrualState, type CurtailmentRow, type DefectRow, type SofrPoint, type NoteForm, type WetDry, type CollateralStatus, type WireApproval, type WarehouseBankPort, type ERegistryPort, type WarehouseCustodianPort, type CovenantFrequency, type CurtailmentKind, type DefectSource, type BorrowingBaseSnapshot,
} from "../../domain/warehouse/ops-27-1.ts";

// ---- helpers ------------------------------------------------------------------
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const rec = (i: ToolInput, k: string): Record<string, unknown> => { const v = i[k]; if (!v || typeof v !== "object") throw new RangeError(`${k} is required`); return v as Record<string, unknown>; };
const date = (v: unknown, what: string): PlainDate => { if (typeof v !== "string" || !v) throw new RangeError(`${what} is required`); return D(v); };
const optDate = (v: unknown): PlainDate | null => (typeof v === "string" && v ? D(v) : null);
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** bigint → string for the entity store (JSON-safe), recursively. */
const ser = (v: unknown): unknown => (typeof v === "bigint" ? String(v) : Array.isArray(v) ? v.map(ser) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ser(x)])) : v);
const K = { facilities: "warehouse_facilities", advances: "warehouse_advances", letters: "bailee_letters", accruals: "warehouse_interest_accruals", curtailments: "warehouse_curtailments", defects: "warehouse_collateral_defects", snapshots: "warehouse_borrowing_base_snapshots", covenants: "warehouse_covenant_tests", reports: "warehouse_daily_reports", sofr: "sofr_rates", approvals: "funding_approvals", accrualState: "warehouse_accrual_state" } as const;
export interface WarehouseServices { readonly bank: WarehouseBankPort; readonly registry: ERegistryPort; readonly custodian: WarehouseCustodianPort; }
/** The warehouse ports (bank wire API, eRegistry via the shared eVault adapter, custodian feed) — wired by the runtime under services.warehouse; fakes when absent. */
export function warehouseServices(rt: ToolRuntime): WarehouseServices {
  const s = rt.services as Record<string, unknown>;
  if (!s.warehouse) s.warehouse = { bank: new FakeWarehouseBank(), registry: new FakeERegistry(), custodian: new FakeWarehouseCustodian() } satisfies WarehouseServices;
  return s.warehouse as WarehouseServices;
}
const FACILITY_CENTS = ["facility_limit_cents", "wire_fee_cents", "custodian_fee_cents", "max_loan_cents"] as const;
const ADVANCE_CENTS = ["note_amount_cents", "net_disbursement_cents", "advance_cents", "partner_contribution_cents", "outstanding_principal_cents", "capitalized_interest_cents", "fees_outstanding_cents", "interest_accrued_cents", "collateral_value_cents", "curtailment_due_cents"] as const;
const deFacility = (d: Record<string, unknown>): FacilityTerms => { const o = { ...d } as Record<string, unknown>; for (const k of FACILITY_CENTS) o[k] = cents(d[k]); return o as unknown as FacilityTerms; };
const deAdvance = (d: Record<string, unknown>): AdvanceRecord => { const o = { ...d } as Record<string, unknown>; for (const k of ADVANCE_CENTS) o[k] = cents(d[k]); return o as unknown as AdvanceRecord; };
function facilityOf(rt: ToolRuntime, i: ToolInput): FacilityTerms {
  const id = str(i, "facility_id") || FACILITY_FIXTURE.facility_id;
  const r = rt.store.get(K.facilities, id);
  if (r) return deFacility(r.data);
  if (id === FACILITY_FIXTURE.facility_id) return FACILITY_FIXTURE;   // the LSA fixture is the v1 policy configuration (sm.warehouse.v1)
  throw new RangeError(`no warehouse facility ${id}`);
}
const putFacility = (rt: ToolRuntime, f: FacilityTerms, ctx: CommandContext): void => { rt.store.put(K.facilities, f.facility_id, ser(f) as Record<string, unknown>, ctx.actor, ctx.now); };
function advanceOf(rt: ToolRuntime, i: ToolInput): AdvanceRecord { need(i, "advance_id"); const r = rt.store.get(K.advances, str(i, "advance_id")); if (!r) throw new RangeError(`no warehouse advance ${str(i, "advance_id")}`); return deAdvance(r.data); }
const putAdvance = (rt: ToolRuntime, a: AdvanceRecord, ctx: CommandContext): AdvanceRecord => { rt.store.put(K.advances, a.advance_id, ser(a) as Record<string, unknown>, ctx.actor, ctx.now); return a; };
const allAdvances = (rt: ToolRuntime, facilityId: string): AdvanceRecord[] => rt.store.list(K.advances, (d) => d.facility_id === facilityId).map((r) => deAdvance(r.data));
const sofrSeries = (rt: ToolRuntime, i: ToolInput): SofrPoint[] => {
  const fromInput = Array.isArray(i.sofr) ? (i.sofr as Record<string, unknown>[]).map((p) => ({ publication_date: date(p.publication_date, "sofr.publication_date"), rate_bps: Number(p.rate_bps) })) : [];
  for (const p of fromInput) rt.store.put(K.sofr, p.publication_date, { publication_date: p.publication_date, rate_bps: p.rate_bps }, { kind: "external", id: "nyfed" }, `${p.publication_date}T13:00:00.000Z`);
  return rt.store.list(K.sofr).map((r) => ({ publication_date: D(String(r.data.publication_date)), rate_bps: Number(r.data.rate_bps) }));
};
const accrualStateOf = (rt: ToolRuntime, advanceId: string): AccrualState => { const r = rt.store.get(K.accrualState, advanceId); return r ? { cumulative: Decimal.fromUnscaled(BigInt(String(r.data.cumulative_unscaled))), posted_total_cents: cents(r.data.posted_total_cents) } : { cumulative: Decimal.ZERO, posted_total_cents: 0n }; };
const accrualRows = (rt: ToolRuntime, advanceId: string): AccrualRow[] => rt.store.list(K.accruals, (d) => d.advance_id === advanceId).map((r) => ({ ...(r.data as unknown as AccrualRow), principal_basis_cents: cents(r.data.principal_basis_cents), posted_cents: cents(r.data.posted_cents) }));
const curtailmentRows = (rt: ToolRuntime, advanceId: string): CurtailmentRow[] => rt.store.list(K.curtailments, (d) => d.advance_id === advanceId).map((r) => ({ ...(r.data as unknown as CurtailmentRow), amount_cents: cents(r.data.amount_cents) }));
const defectRows = (rt: ToolRuntime, advanceId: string): DefectRow[] => rt.store.list(K.defects, (d) => d.advance_id === advanceId).map((r) => r.data as unknown as DefectRow);
/** A data-dependent refusal inside a handler: logged as a guardrail violation event, then thrown (the bus logs input-only refusals itself as `command.refused`). */
const refuse = (ctx: CommandContext, code: string, citation: string, why: string, subject: Record<string, unknown>): never => {
  ctx.events.append({ type: "warehouse.guardrail.violated", loanId: ctx.loanId, actor: ctx.actor, payload: { code, citation, reason: why, ...subject } });
  throw new GuardrailViolation(code, citation, why);
};
const requestOf = (r: Record<string, unknown>): AdvanceRequest => ({ advance_id: String(r.advance_id ?? ""), facility_id: String(r.facility_id ?? FACILITY_FIXTURE.facility_id), loan_id: optStr(r.loan_id), application_id: String(r.application_id ?? ""), funding_id: String(r.funding_id ?? ""), requested_at: String(r.requested_at ?? ""),
  note_form: (r.note_form === "enote" ? "enote" : "paper") as NoteForm, closing_type: (String(r.closing_type ?? "hybrid") as AdvanceRequest["closing_type"]), wet_dry: (r.wet_dry === "wet" ? "wet" : "dry") as WetDry, note_amount_cents: cents(r.note_amount_cents), net_disbursement_cents: cents(r.net_disbursement_cents),
  note_date: date(r.note_date, "request.note_date"), transaction_type: String(r.transaction_type ?? "purchase") as AdvanceRequest["transaction_type"], commitment_price: String(r.commitment_price ?? "100.000"), commitment_id_fnma: String(r.commitment_id_fnma ?? ""), wire_verification_id: String(r.wire_verification_id ?? ""), property_state: String(r.property_state ?? ""),
  enote_registered_at: optDate(r.enote_registered_at), secured_party_added_at: optStr(r.secured_party_added_at), trust_receipt_at: optStr(r.trust_receipt_at) });
const factsOf = (f: Record<string, unknown>): EligibilityFacts => ({ du_recommendation: String(f.du_recommendation ?? ""), du_final_matches_closing: f.du_final_matches_closing !== false, ctc_issued: f.ctc_issued === true, disbursement_gate_opened: f.disbursement_gate_opened === true,
  commitment: f.commitment && typeof f.commitment === "object" ? { commitment_id_fnma: String((f.commitment as Record<string, unknown>).commitment_id_fnma ?? ""), live: (f.commitment as Record<string, unknown>).live !== false, expires_on: date((f.commitment as Record<string, unknown>).expires_on, "commitment.expires_on"), type: ((f.commitment as Record<string, unknown>).type === "mandatory" ? "mandatory" : "best_efforts") } : null,
  wire_verification: f.wire_verification && typeof f.wire_verification === "object" ? { id: String((f.wire_verification as Record<string, unknown>).id ?? ""), match_result: String((f.wire_verification as Record<string, unknown>).match_result ?? ""), expires_at: String((f.wire_verification as Record<string, unknown>).expires_at ?? ""), blocks_disbursement: (f.wire_verification as Record<string, unknown>).blocks_disbursement === true } : null,
  transaction_type: String(f.transaction_type ?? "purchase") as EligibilityFacts["transaction_type"], rescission_gate_open: typeof f.rescission_gate_open === "boolean" ? f.rescission_gate_open : null, wet_dry: (f.wet_dry === "wet" ? "wet" : "dry"), dry_recording_condition_met: typeof f.dry_recording_condition_met === "boolean" ? f.dry_recording_condition_met : null,
  note_amount_cents: cents(f.note_amount_cents), units: Number(f.units ?? 1), program_in_scope: f.program_in_scope !== false, first_payment_date: date(f.first_payment_date, "facts.first_payment_date"), disbursement_date: date(f.disbursement_date, "facts.disbursement_date"),
  qc_prefunding_blocking: f.qc_prefunding_blocking === true, ltv_pct: Number(f.ltv_pct ?? 0), mi_active: f.mi_active === true, flood_gate_open: f.flood_gate_open !== false, insurance_gate_open: f.insurance_gate_open !== false, cpl_names_partner: f.cpl_names_partner !== false,
  duplicate_advance: f.duplicate_advance === true, partner_suspended: f.partner_suspended === true, facility_status: String(f.facility_status ?? "active") as EligibilityFacts["facility_status"], appraisal_expires_at: optDate(f.appraisal_expires_at), lock_extension_count: Number(f.lock_extension_count ?? 0),
  evidence: (f.evidence && typeof f.evidence === "object" ? f.evidence : {}) as Record<string, string> });
/** Platform-record facts for the eligibility check are read from the loan's events when the caller does not assert them: `clear_to_close.issued` (23.3, SM_UW_CTC_GATE), `compliance.gate.opened{gate=disbursement}` (25.1). */
function observedGates(ctx: CommandContext, applicationId: string): { ctc_issued: boolean; disbursement_gate_opened: boolean } {
  const evs = ctx.events.all().filter((e) => e.applicationId === applicationId || (e.payload as Record<string, unknown>).application_id === applicationId);
  return { ctc_issued: evs.some((e) => e.type === "clear_to_close.issued" && (e.payload as Record<string, unknown>).passed !== false), disbursement_gate_opened: evs.some((e) => e.type === "compliance.gate.opened" && (e.payload as Record<string, unknown>).gate === "disbursement") };
}
const baseSnapshot = (rt: ToolRuntime, f: FacilityTerms, asOf: PlainDate, pending: Cents = 0n): BorrowingBaseSnapshot => computeBorrowingBase(f, allAdvances(rt, f.facility_id).filter((a) => a.status !== "requested").map((a) => toOpenAdvance(a, { open_incurable_defect: defectRows(rt, a.advance_id).some((d) => !d.cured_at && d.outcome === "written_off") })), asOf, pending);
const postLedger = (ctx: CommandContext, sets: readonly { effectiveDate: PlainDate; description: string; lines: readonly { account: unknown; amountCents: Cents; ruleRef: string; memo?: string }[] }[]): string[] => sets.filter((s) => s.lines.length >= 2 && s.lines.every((l) => l.amountCents !== 0n)).map((s) => ctx.ledger.post(s as Parameters<typeof ctx.ledger.post>[0], ctx.now).id);
const payoffFor = (rt: ToolRuntime, a: AdvanceRecord, repaymentOn: PlainDate) => payoffStatement({ outstanding_principal_cents: a.outstanding_principal_cents, capitalized_interest_cents: a.capitalized_interest_cents, accrued_not_capitalized_cents: accrualRows(rt, a.advance_id).filter((r) => !r.capitalized && r.accrual_date < repaymentOn).reduce((s, r) => s + r.posted_cents, 0n), fees_cents: a.fees_outstanding_cents, repayment_on: repaymentOn });

// ---- tools ------------------------------------------------------------------
export const TOOLS_27_1: readonly ToolDef[] = defineTools("27.1", "warehouse", [
  // Rule 1: every hard criterion from platform records, never re-underwritten; the snapshot carries evidence ids and rule-set versions.
  { name: "evaluateEligibility", kind: "write", handler: compute((i, ctx, rt) => {
      const f = facilityOf(rt, i); const facts = factsOf(rec(i, "facts")); const app = str(i, "application_id");
      const observed = app ? observedGates(ctx, app) : { ctc_issued: facts.ctc_issued, disbursement_gate_opened: facts.disbursement_gate_opened };
      const snap = evaluateEligibility({ ...facts, ctc_issued: facts.ctc_issued || observed.ctc_issued, disbursement_gate_opened: facts.disbursement_gate_opened || observed.disbursement_gate_opened }, f);
      if (str(i, "advance_id") && rt.store.get(K.advances, str(i, "advance_id"))) putAdvance(rt, { ...advanceOf(rt, i), eligibility_snapshot: snap }, ctx);
      return snap; }),
    guardrails: [never("NO_REUNDERWRITE", "27.1 guardrails: the agent may never re-underwrite or contact the borrower", (i) => flag(i, "reunderwrite") || flag(i, "contact_borrower"), "eligibility is an objective collateral check from platform records"),
      never("NO_DEMOGRAPHICS", "27.1 guardrails: never read applicant_demographics", (i) => flag(i, "read_applicant_demographics"), "applicant_demographics is off limits to the warehouse agent")] },
  // Rule 3: borrowing base, availability, wet usage, concentrations, margin calls (SM_WH_BORROWING_BASE_DAILY; opens SM_WH_MARGIN_CALL_1BD per shortfall).
  { name: "computeBorrowingBase", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "as_of"); const f = facilityOf(rt, i); const asOf = date(i.as_of, "as_of");
      if (Array.isArray(i.commitment_reprices)) for (const r of i.commitment_reprices as Record<string, unknown>[]) { const a = deAdvance(rt.store.require(K.advances, String(r.advance_id)).data); putAdvance(rt, { ...a, commitment_price: String(r.commitment_price) }, ctx); }
      const snap = baseSnapshot(rt, f, asOf);
      const { event, snapshot_id } = recordBorrowingBase(ctx.events, snap, ctx.now);
      rt.store.put(K.snapshots, snapshot_id, ser({ snapshot_id, ...snap, report_document_id: null }) as Record<string, unknown>, ctx.actor, ctx.now);
      const margin_calls: Record<string, unknown>[] = [];
      for (const row of snap.rows) if (row.margin_call_cents > 0n) {
        const a = deAdvance(rt.store.require(K.advances, row.advance_id).data);
        if (curtailmentRows(rt, a.advance_id).some((c) => c.kind === "margin_call" && c.status === "due")) continue;
        const m = issueMarginCall(ctx.events, a, { amount_cents: row.margin_call_cents, collateral_value_cents: row.collateral_value_cents, issued_at: ctx.now });
        putAdvance(rt, { ...m.record, collateral_value_cents: row.collateral_value_cents }, ctx); rt.store.put(K.curtailments, m.row.curtailment_id, ser(m.row) as Record<string, unknown>, ctx.actor, ctx.now);
        margin_calls.push({ advance_id: a.advance_id, amount_cents: String(row.margin_call_cents), collateral_value_cents: String(row.collateral_value_cents), due_on: m.row.due_on });
      }
      return { ...(ser(snap) as Record<string, unknown>), snapshot_id, event_id: event.id, margin_calls }; }) },
  // Rules 1–3: `funding.authorized` → requested → approved/rejected with reasons within 2 business hours (SM_WH_ADVANCE_APPROVAL_2BH); the decision record per LL-2026-04.
  { name: "approveAdvance", kind: "write", moneyFields: ["advance_cents", "partner_contribution_cents", "net_disbursement_cents"], handler: compute((i, ctx, rt) => {
      const f = facilityOf(rt, i); const r = requestOf(rec(i, "request")); const facts = factsOf(rec(i, "facts"));
      let a = rt.store.get(K.advances, r.advance_id) ? deAdvance(rt.store.get(K.advances, r.advance_id)!.data) : null;
      if (!a) { const q = requestAdvance(ctx.events, r); a = putAdvance(rt, q.record, ctx); }
      const observed = observedGates(ctx, r.application_id);
      const snap = evaluateEligibility({ ...facts, ctc_issued: facts.ctc_issued || observed.ctc_issued, disbursement_gate_opened: facts.disbursement_gate_opened || observed.disbursement_gate_opened, duplicate_advance: facts.duplicate_advance || allAdvances(rt, f.facility_id).some((x) => x.advance_id !== r.advance_id && x.loan_id !== null && x.loan_id === r.loan_id && x.status !== "rejected" && x.status !== "repaid" && x.status !== "repurchased"), facility_status: f.status }, f);
      const base = baseSnapshot(rt, f, etDate(ctx.now));
      const d = decideAdvance(f, r, snap, base, ctx.now);
      const out = recordAdvanceDecision(ctx.events, a, d, snap); putAdvance(rt, out.record, ctx);
      return { outcome: d.outcome, advance_id: r.advance_id, evidence_document_ids: Object.values(facts.evidence), reasons: [...d.reasons], advance_cents: String(d.advance_cents), partner_contribution_cents: String(d.partner_contribution_cents), wet: d.wet, wet_reason: d.wet_reason, collateral_plan: d.collateral_plan, soft_flags: [...snap.soft_flags], availability_after_cents: String(d.availability_after_cents), wet_check: ser(d.wet_check), decision_record: advanceDecisionRecord(out.record, d, snap, { model_version: ctx.run?.modelVersion ?? null, prompt_version: ctx.run?.promptVersion ?? null }, null), event_id: out.event.id }; }),
    decision: (_i, out) => { const o = out as { outcome: string; advance_id: string; reasons: string[]; evidence_document_ids: string[]; decision_record: { rationale: string } }; return { action: `approveAdvance:${o.outcome}`, rationale: o.decision_record.rationale, subject: { kind: "warehouse_advance", id: o.advance_id }, ruleCode: o.outcome === "approved" ? "27.1:rule1-3" : o.reasons[0]!, evidenceDocumentIds: o.evidence_document_ids }; },
    guardrails: [never("APPROVE_NEEDS_HARD_CRITERIA", "27.1 guardrails: the agent may never approve an advance failing a hard criterion", (i) => flag(i, "override_hard_criteria"), "hard criteria are never overridden; reject with reasons or cure upstream"),
      never("NO_TABLE_FUNDING", "27.1 structure decision / Reg X §1024.2(b): the purchase-at-closing (table-funding) form is refused without an officer-and-counsel record", (i) => i.legal_form === "purchase_at_closing" && !str(i, "officer_and_counsel_record_id"), "the facility is a loan secured by the notes; no assignment at settlement")] },
  // Rule 2 / cut-off / haircut gate: the wire package handed to funding_approver (2-hour SLA within the cut-off window); `op=release` needs the approval record — the agent never calls the bank API without it (T12).
  { name: "prepareWire", kind: "act", handler: compute(async (i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i);
      if (a.status !== "approved") throw new RangeError(`advance ${a.advance_id} is ${a.status}; only an approved advance is wired`);
      const vd = wireValueDate(a.approved_at ?? ctx.now);
      const pkg = { advance_id: a.advance_id, wire_cents: String(a.net_disbursement_cents), advance_cents: String(a.advance_cents), partner_contribution_cents: String(a.partner_contribution_cents), value_date: vd.value_date, same_day: vd.same_day, beneficiary_wire_verification_id: a.wire_verification_id, funding_account_ref: f.funding_account_ref, cutoff_et: "13:00", idempotency_key: `${a.advance_id}:${vd.value_date}` };
      if (str(i, "op") === "release") {
        const approval = rt.store.get(K.approvals, str(i, "funding_approver_approval_id"));
        if (!approval) refuse(ctx, "WIRE_NEEDS_FUNDING_APPROVER", "27.1 guardrails: never fund without funding_approver release (dual control)", `no funding_approver approval record ${str(i, "funding_approver_approval_id")}`, { advance_id: a.advance_id });
        const ap: WireApproval = { approval_id: approval!.id, approved_by: approval!.data.approved_by as Actor, approved_at: String(approval!.data.approved_at), wire_cents: cents(approval!.data.wire_cents) };
        const fund = await fundAdvance(ctx.events, warehouseServices(rt).bank, f, a, ap, flag(i, "escrow_state"));
        putAdvance(rt, fund.record, ctx); const posted = fund.ledger ? postLedger(ctx, [fund.ledger.sm_wire, fund.ledger.clearing]) : [];
        return { ...pkg, released: true, wire_out_id: fund.wire_out_id, advance_date: fund.record.advance_date, collateral_status: fund.record.collateral_status, ledger_entry_set_ids: posted, event_id: fund.event.id };
      }
      const esc = rt.escalations.open({ kind: "funding_approver", ownerRole: "funding_approver", applicationId: a.application_id, ...(a.loan_id ? { loanId: a.loan_id } : {}), severity: "sev-2", payload: { reason: "wire_release", package: pkg, sla: "2 hours within the 13:00 ET cut-off window" } }, ctx.actor);
      return { ...pkg, released: false, escalation_id: esc.id, handed_to: "funding_approver" }; }),
    guardrails: [never("WIRE_NEEDS_FUNDING_APPROVER", "27.1 guardrails: the agent may never fund without funding_approver release", (i) => str(i, "op") === "release" && !str(i, "funding_approver_approval_id"), "the bank wire API is called only with a funding_approver approval record"),
      gate("27.1.haircutReserveCovers", "27.1 SM_WH_HAIRCUT_RESERVE_GATE: partner_haircut_reserve ≥ partner_contribution_cents before the wire")] },
  // The human dual-control release: funding_approver approves the package (approval record) and the wire goes out; agents are refused by the bus (HUMAN_ONLY).
  { name: "funding_approver", kind: "act", humanOnly: true, humanRoles: ["funding_approver"], handler: compute(async (i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i);
      if (a.status !== "approved") throw new RangeError(`advance ${a.advance_id} is ${a.status}; only an approved advance is released`);
      const approval_id = `fa-${a.advance_id}-${rt.store.list(K.approvals).length + 1}`;
      const ap: WireApproval = { approval_id, approved_by: ctx.actor, approved_at: ctx.now, wire_cents: a.net_disbursement_cents };
      rt.store.put(K.approvals, approval_id, { approval_id, advance_id: a.advance_id, approved_by: ctx.actor, approved_at: ctx.now, wire_cents: String(a.net_disbursement_cents), dual_control: true }, ctx.actor, ctx.now);
      const fund = await fundAdvance(ctx.events, warehouseServices(rt).bank, f, a, ap, flag(i, "escrow_state"));
      putAdvance(rt, fund.record, ctx); const posted = fund.ledger ? postLedger(ctx, [fund.ledger.sm_wire, fund.ledger.clearing]) : [];
      for (const e of rt.escalations.opened) if (e.kind === "funding_approver" && e.status === "open" && (e.payload.package as { advance_id?: string } | undefined)?.advance_id === a.advance_id) { e.status = "completed"; e.completedAt = ctx.now; e.completedBy = `${ctx.actor.kind}:${ctx.actor.id}`; }
      return { approval_id, wire_out_id: fund.wire_out_id, advance_date: fund.record.advance_date, value_date: fund.record.value_date, collateral_status: fund.record.collateral_status, wire_cents: String(a.net_disbursement_cents), ledger_entry_set_ids: posted, event_id: fund.event.id }; }) },
  // Rule 5: one letter per shipment on SM letterhead; Letter Name and Form 482 hash equality enforced (T6); signature by officer{sm}; corrections per the Bailee Correction Reminders.
  { name: "issueBaileeLetter", kind: "write", handler: compute((i, ctx, rt) => {
      const f = facilityOf(rt, i); const op = str(i, "op") || "render";
      if (op === "render") {
        const d = rec(i, "letter"); const loan_list = (Array.isArray(d.loan_list) ? d.loan_list : []) as Record<string, unknown>[];
        const r = issueBaileeLetter(f, { bailee_letter_id: String(d.bailee_letter_id ?? ""), facility_id: f.facility_id, custodian_party_id: String(d.custodian_party_id ?? ""), letter_name: String(d.letter_name ?? ""), letter_date: date(d.letter_date, "letter.letter_date"), loan_list: loan_list.map((l) => ({ advance_id: String(l.advance_id ?? ""), seller_loan_number: String(l.seller_loan_number ?? ""), borrower_last_name: String(l.borrower_last_name ?? ""), note_amount_cents: cents(l.note_amount_cents), note_date: date(l.note_date, "loan_list.note_date") })), wire_instructions_hash: String(d.wire_instructions_hash ?? ""), fnma_letter_type: d.fnma_letter_type === "form_2004a" ? "form_2004a" : "bailee", signature_kind: d.signature_kind === "wet_ink" ? "wet_ink" : "esign" });
        if (!r.ok) refuse(ctx, r.refusal, "27.1 rule 5: letterhead text = warehouse_facilities.bailee_letter_name character-for-character; wire instructions = the partner's Form 482 payee code for SM (Warehouse Lender User Guide p. 5; Form 482)", r.detail, { bailee_letter_id: String(d.bailee_letter_id ?? ""), refusal: r.refusal });
        const letter = r.ok ? r.letter : null;
        rt.store.put(K.letters, letter!.bailee_letter_id, ser({ ...letter, document_id: `doc:${letter!.bailee_letter_id}.pdf`, custodian_acknowledged_at: null, superseded_by: null }) as Record<string, unknown>, ctx.actor, ctx.now);
        const esc = rt.escalations.open({ kind: "officer", ownerRole: "officer", severity: "sev-3", payload: { reason: "bailee_letter_signature", bailee_letter_id: letter!.bailee_letter_id, party: "sm", sla: "same day" } }, ctx.actor);
        for (const l of letter!.loan_list) if (rt.store.get(K.advances, l.advance_id)) putAdvance(rt, { ...deAdvance(rt.store.get(K.advances, l.advance_id)!.data), bailee_letter_id: letter!.bailee_letter_id }, ctx);
        return { rendered: true, ...(ser(letter) as Record<string, unknown>), release_condition_text: letter!.release_condition_text, escalation_id: esc.id, routed_to: "officer" };
      }
      need(i, "bailee_letter_id"); const cur = rt.store.require(K.letters, str(i, "bailee_letter_id")).data;
      if (op === "sign") { const s = signBaileeLetter(ctx.actor); rt.store.put(K.letters, str(i, "bailee_letter_id"), { ...s, signed_at: ctx.now }, ctx.actor, ctx.now); baileeLetterEvent(ctx.events, f.facility_id, "warehouse.bailee_letter.issued", { bailee_letter_id: str(i, "bailee_letter_id"), letter_name: cur.letter_name, signed_by: s.signed_by, loan_list: cur.loan_list }, ctx.now, ctx.actor); return { ...s, bailee_letter_id: str(i, "bailee_letter_id") }; }
      if (op === "acknowledge") { need(i, "acknowledged_at"); rt.store.put(K.letters, str(i, "bailee_letter_id"), { status: "acknowledged", custodian_acknowledged_at: str(i, "acknowledged_at") }, ctx.actor, ctx.now); baileeLetterEvent(ctx.events, f.facility_id, "warehouse.bailee_letter.acknowledged", { bailee_letter_id: str(i, "bailee_letter_id"), custodian_acknowledged_at: str(i, "acknowledged_at") }, str(i, "acknowledged_at"), { kind: "external", id: "custodian" }); return { status: "acknowledged" }; }
      if (op === "correct") { need(i, "superseded_by", "reason"); rt.store.put(K.letters, str(i, "bailee_letter_id"), { status: "corrected", superseded_by: str(i, "superseded_by") }, ctx.actor, ctx.now); baileeLetterEvent(ctx.events, f.facility_id, "warehouse.bailee_letter.corrected", { bailee_letter_id: str(i, "bailee_letter_id"), superseded_by: str(i, "superseded_by"), reason: str(i, "reason"), steps: ["cancel certification", "correct payee code / warehouse lender ID", "resubmit (new Fannie Mae loan number)", "corrected physical letter to the custodian"] }, ctx.now); return { status: "corrected" }; }
      if (op === "release") { rt.store.put(K.letters, str(i, "bailee_letter_id"), { status: "released", released_at: ctx.now }, ctx.actor, ctx.now); baileeLetterEvent(ctx.events, f.facility_id, "warehouse.bailee_letter.released", { bailee_letter_id: str(i, "bailee_letter_id"), released_at: ctx.now, reason: str(i, "reason") || "proceeds received" }, ctx.now); return { status: "released" }; }
      throw new RangeError(`issueBaileeLetter op ${op} is not one of render/sign/acknowledge/correct/release`); }),
    guardrails: [needsRole("BAILEE_LETTER_SIGNATURE_IS_OFFICER", "27.1 guardrails: the agent may never sign a bailee letter or Form 2004A (human officer{sm} signature)", (i) => str(i, "op") === "sign", ["officer"], "signature is a human officer{sm} act"),
      never("LETTER_NAME_IMMUTABLE", "27.1 guardrails: the agent may never alter a payee code or Letter Name", (i) => flag(i, "change_letter_name") || flag(i, "change_payee_code"), "Letter Name and payee code changes go through SM's fnma_portal_operator and a fresh bailee letter")] },
  // Rule 4: the collateral chain — trust receipts (secured_possession), Secured Party added (secured_control), Interim Funder verification, shipments under the bailee-letter gate, Control returned, rescission unwind.
  { name: "trackCollateral", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op"); const a = advanceOf(rt, i);
      switch (op) {
        case "trust_receipt": { need(i, "receipt_id", "received_at"); const r = recordTrustReceipt(ctx.events, a, { receipt_id: str(i, "receipt_id"), received_at: str(i, "received_at"), custody_record_id: str(i, "custody_record_id") || a.loan_id || a.advance_id, bailee_letter_id: optStr(i.bailee_letter_id) }); putAdvance(rt, r.record, ctx); return { collateral_status: r.record.collateral_status, note_received_at: str(i, "received_at"), event_ids: r.events.map((e) => e.id) }; }
        case "secured_party_added": { need(i, "min", "added_at"); const r = recordSecuredPartyAdded(ctx.events, a, { min: str(i, "min"), secured_party_org_id: str(i, "secured_party_org_id") || SM_MERS_ORG_ID, added_at: str(i, "added_at"), notification_id: str(i, "notification_id") || `ereg-${str(i, "min")}`, reason: "add_secured_party" }); putAdvance(rt, r.record, ctx); return { collateral_status: r.record.collateral_status, secured_party_added_at: r.record.secured_party_added_at, event_ids: r.events.map((e) => e.id) }; }
        case "interim_funder": { need(i, "min", "registered_at"); const r = recordInterimFunderCheck(ctx.events, a, { min: str(i, "min"), interim_funder_org_id: optStr(i.interim_funder_org_id), registered_at: str(i, "registered_at") }); putAdvance(rt, r.record, ctx);
          if (!r.designated) rt.store.put(K.defects, `${a.advance_id}:mers_mismatch:${str(i, "min")}`, ser({ defect_id: `${a.advance_id}:mers_mismatch:${str(i, "min")}`, advance_id: a.advance_id, source: "mers_mismatch", recorded_at: str(i, "registered_at"), description: `Interim Funder ${optStr(i.interim_funder_org_id) ?? "(none)"} ≠ SM ${SM_MERS_ORG_ID}`, cure_due_at: (r.event.payload as { cure_due_at: string }).cure_due_at, cured_at: null, outcome: null, cure_owner: "post-closing" }) as Record<string, unknown>, ctx.actor, ctx.now);
          const ids = r.escalations.map((e) => rt.escalations.open({ kind: e.kind, ownerRole: e.owner_role, applicationId: a.application_id, ...(a.loan_id ? { loanId: a.loan_id } : {}), severity: "sev-2", payload: e.payload }, ctx.actor).id);
          return { designated: r.designated, interim_funder_designated_at: r.record.interim_funder_designated_at, escalation_ids: ids, event_id: r.event.id }; }
        case "control_returned": { need(i, "min", "returned_at"); const r = recordControlReturned(ctx.events, a, { min: str(i, "min"), returned_at: str(i, "returned_at"), notification_id: str(i, "notification_id") || `ereg-ret-${str(i, "min")}`, reason: str(i, "reason") || "Fannie Mae declined to purchase" }); putAdvance(rt, r.record, ctx);
          const defectEvent = r.events.find((e) => e.type === "warehouse.collateral.defect_recorded")!; const p = defectEvent.payload as Record<string, unknown>;
          rt.store.put(K.defects, String(p.defect_id), ser({ defect_id: p.defect_id, advance_id: a.advance_id, source: p.source, recorded_at: p.recorded_at, description: p.description, cure_due_at: p.cure_due_at, cured_at: null, outcome: null, cure_owner: p.cure_owner }) as Record<string, unknown>, ctx.actor, ctx.now);
          return { collateral_status: r.record.collateral_status, status: r.record.status, defect_id: p.defect_id, event_ids: r.events.map((e) => e.id) }; }
        case "shipment_request": { need(i, "shipment_id"); const e = requestShipment(ctx.events, a, { shipment_id: str(i, "shipment_id"), custodian_party_id: str(i, "custodian_party_id"), requested_at: ctx.now }); return { shipment_id: str(i, "shipment_id"), gate: "SM_WH_BAILEE_LETTER_GATE", event_id: e.id }; }
        case "shipment_release": { need(i, "shipment_id", "bailee_letter_id"); const letter = rt.store.get(K.letters, str(i, "bailee_letter_id"))?.data; const status = String(letter?.status ?? "");
          if (status !== "issued" && status !== "acknowledged") refuse(ctx, "SM_WH_BAILEE_LETTER_GATE", "27.1 timers: shipment blocked unless bailee_letters.status ∈ {issued, acknowledged} covering the loan", `bailee letter ${str(i, "bailee_letter_id")} is ${status || "absent"}`, { advance_id: a.advance_id });
          const e = releaseShipment(ctx.events, a, { shipment_id: str(i, "shipment_id"), bailee_letter_id: str(i, "bailee_letter_id"), released_at: ctx.now, tracking: str(i, "tracking") }); putAdvance(rt, { ...a, bailee_letter_id: str(i, "bailee_letter_id") }, ctx); return { released: true, event_id: e.id }; }
        case "delivered": { need(i, "delivered_at"); if (a.collateral_status !== "secured_possession" && a.collateral_status !== "secured_control") refuse(ctx, "DELIVERY_NEEDS_SECURED_COLLATERAL", "27.1 state machine guard / UCC 9-330(d)", `collateral_status ${a.collateral_status}`, { advance_id: a.advance_id }); putAdvance(rt, { ...a, status: "delivered" }, ctx); return { status: "delivered" }; }
        case "rescission_exercised": { need(i, "exercise_id", "exercised_at"); const r = unwindOnRescission(ctx.events, a, { exercise_id: str(i, "exercise_id"), exercised_at: str(i, "exercised_at") }); putAdvance(rt, r.record, ctx); return { status: r.record.status, repaid_from: r.record.repaid_from, event_ids: r.events.map((e) => e.id) }; }
        default: throw new RangeError(`trackCollateral op ${op || "(none)"} is not one of trust_receipt/secured_party_added/interim_funder/control_returned/shipment_request/shipment_release/delivered/rescission_exercised`);
      } }) },
  // Rule 4 (eNote): SM confirms the partner's Transfer of Control and Location to Fannie Mae as Secured Party; the registry removes the Secured Party; Funding Agreement protection (T8).
  { name: "confirmTransferOfControl", kind: "act", handler: compute(async (i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i); const t = rec(i, "transfer");
      const r = await confirmTransferOfControl(ctx.events, warehouseServices(rt).registry, f, a, { transfer_id: String(t.transfer_id ?? ""), min: String(t.min ?? ""), from_controller_org_id: String(t.from_controller_org_id ?? ""), to_controller_org_id: String(t.to_controller_org_id ?? ""), effective_date: date(t.effective_date, "transfer.effective_date"), initiated_by_org_id: String(t.initiated_by_org_id ?? ""), kind: "control_and_location" }, ctx.now);
      if (r.accepted) { putAdvance(rt, r.record, ctx); if (a.loan_id) rt.store.put("enotes", a.loan_id, { loan_id: a.loan_id, secured_party_org_id: null, secured_party_released_at: r.secured_party_released_at, controller: "FNMA", location: "FNMA" }, ctx.actor, ctx.now); }
      return { accepted: r.accepted, collateral_status: r.record.collateral_status, secured_party_released_at: r.secured_party_released_at, in_borrowing_base: r.accepted, event_ids: r.events.map((e) => e.id) }; }) },
  // Rule 6: the daily accrual by the cumulative method at the lookback SOFR (SM_WH_DAILY_ACCRUAL); posts Dr warehouse_interest_receivable / Cr warehouse_interest_income.
  { name: "accrueInterest", kind: "write", moneyFields: ["posted_cents", "index_rate_bps"], handler: compute((i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i); need(i, "accrual_date");
      if (!a.advance_date) throw new RangeError(`advance ${a.advance_id} is not funded`);
      if (a.status === "repaid" || a.status === "repurchased") throw new RangeError(`advance ${a.advance_id} is ${a.status}; no accrual`);
      const d = date(i.accrual_date, "accrual_date"); const series = sofrSeries(rt, i);
      if (accrualRows(rt, a.advance_id).some((r) => r.accrual_date === d)) return { duplicate: true, accrual_date: d };
      const idx = indexRateFor(d, series, f.index_lookback_business_days);
      const wo = a.note_form === "paper" && a.collateral_status === "unsecured_wet" ? wetOverdue(f, a.advance_date, d, null).overdue : a.wet_overdue;
      const rate = allInRateBps(f, idx.rate_bps, { dwell_stepup_active: a.dwell_stepup_active || (d >= curtailmentAt45(f, a.advance_date, a.outstanding_principal_cents).stepup_from), wet_overdue: wo });
      const st = accrualStateOf(rt, a.advance_id); const r = accrueDay(st, a.outstanding_principal_cents, rate.all_in_rate_bps);
      const row: AccrualRow = { accrual_date: d, principal_basis_cents: a.outstanding_principal_cents, index_rate_bps: idx.rate_bps, index_publication_date: idx.publication_date, spread_bps: f.spread_bps, stepup_bps: rate.stepup_bps, all_in_rate_bps: rate.all_in_rate_bps, cumulative_interest_dollars: r.cumulative.div(Decimal.fromInt(100)).toFixed(8), posted_cents: r.posted_cents, capitalized: false };
      const rec2 = recordAccrual(ctx.events, a, row); putAdvance(rt, { ...rec2.record, wet_overdue: wo, dwell_stepup_active: rate.stepup_bps >= f.dwell_stepup_bps && d >= curtailmentAt45(f, a.advance_date, a.outstanding_principal_cents).stepup_from }, ctx);
      const posted = a.loan_id && row.posted_cents !== 0n ? postLedger(ctx, [accrualLedgerSet(a.loan_id, row)]) : [];
      rt.store.put(K.accrualState, a.advance_id, { cumulative_unscaled: String(r.state.cumulative.unscaled), posted_total_cents: String(r.state.posted_total_cents) }, ctx.actor, ctx.now);
      rt.store.put(K.accruals, `${a.advance_id}:${d}`, ser({ accrual_id: `${a.advance_id}:${d}`, advance_id: a.advance_id, ...row, ledger_entry_id: posted[0] ?? null }) as Record<string, unknown>, ctx.actor, ctx.now);
      return { ...(ser(row) as Record<string, unknown>), interest_accrued_cents: String(rec2.record.interest_accrued_cents), ledger_entry_id: posted[0] ?? null, event_id: rec2.event.id }; }) },
  // Rule 6: capitalization on the 1st (SM_WH_INTEREST_CAPITALIZE_MONTHLY) — the prior month's postings move to warehouse_advance_receivable.capitalized_interest (capitalize first on a payoff day).
  { name: "capitalizeInterest", kind: "write", handler: compute((i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i); need(i, "on"); const on = date(i.on, "on");
      const c = capitalizeMonth(f, accrualRows(rt, a.advance_id), on);
      if (c.capitalized_cents === 0n) return { month: c.month, capitalized_cents: "0", treatment: c.treatment, skipped: true };
      const r = recordCapitalization(ctx.events, a, { on, month: c.month, capitalized_cents: c.capitalized_cents, treatment: c.treatment }); putAdvance(rt, r.record, ctx);
      for (const row of c.rows) rt.store.put(K.accruals, `${a.advance_id}:${row.accrual_date}`, { capitalized: true }, ctx.actor, ctx.now);
      const posted = a.loan_id && c.treatment === "capitalize_monthly" ? postLedger(ctx, [capitalizationLedgerSet(a.loan_id, on, c.capitalized_cents)]) : [];
      return { month: c.month, capitalized_cents: String(c.capitalized_cents), treatment: c.treatment, capitalized_interest_cents: String(r.record.capitalized_interest_cents), ledger_entry_id: posted[0] ?? null, event_id: r.event.id }; }) },
  // Rule 7: wire / custodian pass-through fees to warehouse_fees_receivable{loan}; no commitment, non-usage or unused-line fee.
  { name: "assessFee", kind: "write", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i); need(i, "kind");
      const kind = str(i, "kind"); if (kind !== "wire_out" && kind !== "wire_in" && kind !== "custodian") throw new RangeError(`fee kind ${kind} is not one of wire_out/wire_in/custodian`);
      const fee = assessFee(f, kind, flag(i, "uses_sm_custodian")); if (fee.amount_cents === 0n) return { kind, amount_cents: "0", skipped: true };
      const on = optDate(i.on) ?? etDate(ctx.now); const r = recordFee(ctx.events, a, { kind, amount_cents: fee.amount_cents, on }); putAdvance(rt, r.record, ctx);
      const posted = a.loan_id ? postLedger(ctx, [feeLedgerSet(a.loan_id, on, kind, fee.amount_cents)]) : [];
      return { kind, amount_cents: String(fee.amount_cents), pass_through: true, fees_outstanding_cents: String(r.record.fees_outstanding_cents), ledger_entry_id: posted[0] ?? null, event_id: r.event.id }; }),
    guardrails: [never("NO_UNUSED_LINE_FEE", "27.1 rule 7: no commitment, non-usage or unused-line fee in v1", (i) => ["commitment", "non_usage", "unused_line"].includes(str(i, "kind")), "only wire and custodian pass-through fees are assessed")] },
  // Rule 8: buckets from aged_days; day 45 curtailment (rolled), day 46 step-up, wet-overdue day 6 / day 10, day 60 repurchase and day 90 kick-out packages for officer{sm} (never automated enforcement).
  { name: "ageAdvances", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "as_of"); const f = facilityOf(rt, i); const asOf = date(i.as_of, "as_of");
      const out: Record<string, unknown>[] = [];
      for (const a0 of allAdvances(rt, f.facility_id).filter((a) => a.advance_date && (a.status === "funded" || a.status === "delivered" || a.status === "transferred_pending_payment" || a.status === "returned"))) {
        const aged = ageAdvance(ctx.events, f, a0, asOf); let a = aged.record; const actions: string[] = [];
        const curts = curtailmentRows(rt, a.advance_id);
        if (aged.aged_days >= f.aging_curtail_day && !curts.some((c) => c.kind === "aging_45")) { const c45 = curtailmentAt45(f, a.advance_date!, a.outstanding_principal_cents); const c = issueCurtailment(ctx.events, a, { kind: "aging_45", due_on: c45.due_on, amount_cents: c45.amount_cents, issued_at: ctx.now }); a = c.record; rt.store.put(K.curtailments, c.row.curtailment_id, ser(c.row) as Record<string, unknown>, ctx.actor, ctx.now); actions.push(`curtailment aging_45 ${c45.amount_cents} due ${c45.due_on}`); }
        if (a.note_form === "paper" && a.collateral_status === "unsecured_wet") { const wo = wetOverdue(f, a.advance_date!, asOf, null); if (wo.overdue && !curts.some((c) => c.kind === "wet_overdue")) { const c = issueCurtailment(ctx.events, a, { kind: "wet_overdue", due_on: wo.full_repayment_due_on, amount_cents: a.outstanding_principal_cents + a.capitalized_interest_cents, issued_at: ctx.now }); a = { ...c.record, wet_overdue: true }; rt.store.put(K.curtailments, c.row.curtailment_id, ser(c.row) as Record<string, unknown>, ctx.actor, ctx.now); actions.push(`wet_overdue from ${wo.overdue_from}: +${wo.stepup_bps} bps; full repayment due ${wo.full_repayment_due_on}`);
          rt.escalations.open({ kind: "sev1", ownerRole: "officer", applicationId: a.application_id, ...(a.loan_id ? { loanId: a.loan_id } : {}), severity: "sev-1", payload: { reason: "wet_overdue", advance_id: a.advance_id, parties: ["officer{partner}", "officer{sm}"] } }, ctx.actor); } }
        const rs = repurchaseSchedule(f, a.advance_date!);
        if (asOf >= rs.demand_on && !a.repurchase_demanded_at && !rt.escalations.opened.some((e) => e.status === "open" && e.payload.reason === "repurchase_demand" && e.payload.advance_id === a.advance_id)) { rt.escalations.open({ kind: "officer", ownerRole: "officer", applicationId: a.application_id, ...(a.loan_id ? { loanId: a.loan_id } : {}), severity: "sev-2", payload: { reason: "repurchase_demand", advance_id: a.advance_id, demand_on: rs.demand_on, payment_due_on: rs.payment_due_on, payoff: ser(payoffFor(rt, a, asOf)) } }, ctx.actor); actions.push(`day ${f.repurchase_day}: repurchase demand package to officer{sm}`); }
        if (asOf >= kickoutOn(f, a.advance_date!) && !a.kickout_at && !rt.escalations.opened.some((e) => e.status === "open" && e.payload.reason === "kickout" && e.payload.advance_id === a.advance_id)) { rt.escalations.open({ kind: "officer", ownerRole: "officer", applicationId: a.application_id, ...(a.loan_id ? { loanId: a.loan_id } : {}), severity: "sev-1", payload: { reason: "kickout", advance_id: a.advance_id, kickout_on: kickoutOn(f, a.advance_date!) } }, ctx.actor); actions.push(`day ${f.kickout_day}: kick-out package to officer{sm}`); }
        putAdvance(rt, a, ctx);
        out.push({ advance_id: a.advance_id, aged_days: aged.aged_days, bucket: aged.bucket, dwell_stepup_active: a.dwell_stepup_active, wet_overdue: a.wet_overdue, curtailment_due_cents: String(a.curtailment_due_cents), actions });
      }
      return { as_of: asOf, advances: out }; }) },
  // Rule 8: curtailments issued (aging_45 / wet_overdue / partner_voluntary) and paid — Dr sm_collection_cash / Cr warehouse_advance_receivable.principal; `warehouse.curtailment.paid{kind}` satisfies the aging / margin clocks.
  { name: "issueCurtailment", kind: "write", moneyFields: ["amount_cents"], handler: compute((i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i); const op = str(i, "op") || "issue";
      if (op === "issue") { need(i, "kind", "due_on"); const kind = str(i, "kind") as CurtailmentKind; const amount = kind === "aging_45" ? curtailmentAt45(f, a.advance_date ?? etDate(ctx.now), a.outstanding_principal_cents).amount_cents : cents(i.amount_cents);
        const c = issueCurtailment(ctx.events, a, { kind, due_on: date(i.due_on, "due_on"), amount_cents: amount, issued_at: ctx.now }); putAdvance(rt, c.record, ctx); rt.store.put(K.curtailments, c.row.curtailment_id, ser(c.row) as Record<string, unknown>, ctx.actor, ctx.now); return { ...(ser(c.row) as Record<string, unknown>), event_id: c.event.id }; }
      if (op === "paid") { need(i, "curtailment_id", "paid_at", "wire_in_ref"); const row = curtailmentRows(rt, a.advance_id).find((c) => c.curtailment_id === str(i, "curtailment_id")); if (!row) throw new RangeError(`no curtailment ${str(i, "curtailment_id")}`);
        const p = payCurtailment(ctx.events, a, row, { paid_at: str(i, "paid_at"), wire_in_ref: str(i, "wire_in_ref"), amount_cents: i.amount_cents === undefined ? row.amount_cents : cents(i.amount_cents) }); putAdvance(rt, p.record, ctx); rt.store.put(K.curtailments, row.curtailment_id, ser(p.row) as Record<string, unknown>, ctx.actor, ctx.now);
        const posted = a.loan_id ? postLedger(ctx, [curtailmentLedgerSet(a.loan_id, etDate(str(i, "paid_at")), row.amount_cents, f.collection_account_ref, row.kind)]) : [];
        return { ...(ser(p.row) as Record<string, unknown>), outstanding_principal_cents: String(p.record.outstanding_principal_cents), ledger_entry_id: posted[0] ?? null, event_id: p.event.id }; }
      throw new RangeError(`issueCurtailment op ${op} is not one of issue/paid`); }) },
  // Rule 9: defects (custodian exception, Loan Delivery edit, Purchase Error, EarlyCheck fatal, QC, compliance, missing document, eRegistry/MERS mismatch) with SM_WH_DEFECT_CURE_10BD; cures hand back to the owning agent.
  { name: "recordDefect", kind: "write", handler: compute((i, ctx, rt) => {
      const a = advanceOf(rt, i); const op = str(i, "op") || "record";
      if (op === "record") { need(i, "defect_id", "source", "description"); const owner = (str(i, "cure_owner") || "post-closing") as "secondary" | "post-closing" | "compliance-tester" | "title-closing";
        const r = recordDefect(ctx.events, a, { defect_id: str(i, "defect_id"), source: str(i, "source") as DefectSource, recorded_at: str(i, "recorded_at") || ctx.now, description: str(i, "description"), cure_owner: owner }); rt.store.put(K.defects, r.row.defect_id, ser(r.row) as Record<string, unknown>, ctx.actor, ctx.now);
        return { ...r.row, same_day_mirror: true, event_id: r.event.id }; }
      if (op === "cure") { need(i, "defect_id", "cured_at", "evidence_document_id"); const row = defectRows(rt, a.advance_id).find((d) => d.defect_id === str(i, "defect_id")); if (!row) throw new RangeError(`no defect ${str(i, "defect_id")}`);
        const c = cureDefect(ctx.events, a, row, { cured_at: str(i, "cured_at"), outcome: str(i, "outcome") === "substituted" ? "substituted" : "cured", evidence_document_id: str(i, "evidence_document_id") }); rt.store.put(K.defects, row.defect_id, ser(c.row) as Record<string, unknown>, ctx.actor, ctx.now); return { ...c.row, event_id: c.event.id }; }
      throw new RangeError(`recordDefect op ${op} is not one of record/cure`); }),
    guardrails: [needsRole("SUBSTITUTION_NEEDS_OFFICER", "27.1 rule 8: the partner may substitute collateral only with SM's consent (officer{sm})", (i) => str(i, "outcome") === "substituted", ["officer"], "substitution needs SM officer consent; the default answer is repurchase")] },
  // Rule 8: day 60 / uncured defect / wet-overdue → repurchase demand (officer{sm} acknowledgment required; SM_WH_REPURCHASE_PAYMENT_5BD) and completion from the partner's own funds (never a new advance).
  { name: "demandRepurchase", kind: "act", handler: compute((i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i); const op = str(i, "op") || "demand";
      if (op === "demand") { const demandedAt = str(i, "demanded_at") || ctx.now; const payoff = payoffFor(rt, a, etDate(demandedAt));
        const r = demandRepurchase(ctx.events, f, a, { demanded_at: demandedAt, payoff, officer_ack_id: optStr(i.officer_ack_id), reason: (str(i, "reason") || "aged_60") as "aged_60" | "defect_uncured" | "wet_overdue" }); putAdvance(rt, r.record, ctx);
        return { demanded_at: demandedAt, payment_due_on: r.payment_due_on, payoff_cents: String(payoff.total_cents), payoff: ser(payoff), event_id: r.event.id }; }
      if (op === "completed") { need(i, "paid_at", "wire_in_ref", "amount_cents"); const payoff = payoffFor(rt, a, etDate(str(i, "paid_at")));
        const r = completeRepurchase(ctx.events, a, { paid_at: str(i, "paid_at"), wire_in_ref: str(i, "wire_in_ref"), amount_cents: cents(i.amount_cents), payoff_cents: payoff.total_cents }); putAdvance(rt, r.record, ctx); return { status: r.record.status, repaid_from: r.record.repaid_from, event_ids: r.events.map((e) => e.id) }; }
      throw new RangeError(`demandRepurchase op ${op} is not one of demand/completed`); }),
    guardrails: [never("REPURCHASE_NEEDS_OFFICER_ACK", "27.1 state machine guards: `repurchase demanded` requires officer{sm} acknowledgment (no automatic enforcement wires)", (i) => (str(i, "op") || "demand") === "demand" && !str(i, "officer_ack_id"), "a repurchase demand needs an officer{sm} acknowledgment record"),
      never("REPURCHASE_FROM_PARTNER_FUNDS", "27.1 rule 9: not cured → repurchase from the partner's own funds (never a new advance)", (i) => flag(i, "fund_with_new_advance"), "a repurchase is never funded by a new advance")] },
  // Rule 8: day 90 or an incurable defect → kick-out (officer{sm} acknowledgment; facility suspended for new advances; LSA remedies, no automated liquidation).
  { name: "issueKickout", kind: "act", handler: compute((i, ctx, rt) => {
      const a = advanceOf(rt, i); const f = facilityOf(rt, i);
      const r = issueKickout(ctx.events, a, { issued_at: str(i, "issued_at") || ctx.now, reason: str(i, "reason") === "incurable_defect" ? "incurable_defect" : "aged_90", officer_ack_id: optStr(i.officer_ack_id) });
      putAdvance(rt, r.record, ctx); putFacility(rt, { ...f, status: "suspended" }, ctx);
      return { status: r.record.status, kickout_at: r.record.kickout_at, facility_status: "suspended", removed_from_borrowing_base: true, event_ids: r.events.map((e) => e.id) }; }),
    guardrails: [never("KICKOUT_NEEDS_OFFICER_ACK", "27.1 guardrails: the agent may never liquidate collateral or set off partner funds without officer{sm} acknowledgment; `kicked_out` requires officer{sm} acknowledgment", (i) => !str(i, "officer_ack_id"), "a kick-out needs an officer{sm} acknowledgment record"),
      never("NO_AUTOMATED_LIQUIDATION", "27.1 rule 8: LSA remedies apply (officer{sm} decision; no automated liquidation)", (i) => flag(i, "liquidate") || flag(i, "set_off"), "liquidation and set-off are officer{sm} decisions")] },
  // Rule 10: covenant periods (SM_WH_COVENANT_QUARTERLY_45 / _ANNUAL_90), the partner's certified package, breaches (facility suspended) and officer{sm} waivers within 5 business days; facility activation / UCC continuation ride here too.
  { name: "testCovenants", kind: "write", handler: compute((i, ctx, rt) => {
      const f = facilityOf(rt, i); const op = str(i, "op") || "package";
      switch (op) {
        case "period_end": { need(i, "period_end"); const freq: CovenantFrequency = str(i, "frequency") === "annual" ? "annual" : "quarterly"; const e = endCovenantPeriod(ctx.events, f.facility_id, { period_end: date(i.period_end, "period_end"), frequency: freq }); return { period_end: str(i, "period_end"), frequency: freq, package_due_on: (e.payload as { package_due_on: string }).package_due_on, event_id: e.id }; }
        case "package": { need(i, "period_end", "received_at", "reported", "evidence_document_id", "certified_by"); const freq: CovenantFrequency = str(i, "frequency") === "annual" ? "annual" : "quarterly";
          const r = recordCovenantTests(ctx.events, f, { period_end: date(i.period_end, "period_end"), frequency: freq, received_at: str(i, "received_at"), reported: rec(i, "reported") as Record<string, string>, evidence_document_id: str(i, "evidence_document_id"), certified_by: str(i, "certified_by") });
          for (const row of r.rows) rt.store.put(K.covenants, row.test_id, { ...row }, ctx.actor, ctx.now);
          if (r.breach) { putFacility(rt, { ...f, status: "suspended" }, ctx); rt.escalations.open({ kind: "officer", ownerRole: "officer", severity: "sev-2", payload: { reason: "covenant_breach", kind: (r.breach.payload as { kind: string }).kind, period_end: str(i, "period_end"), party: "partner", waiver_by: "officer{sm} within 5 business days" } }, ctx.actor); }
          return { rows: r.rows, late: r.late, failed: r.failed, breached: !!r.breach, facility_status: r.breach ? "suspended" : f.status, breach_event_id: r.breach?.id ?? null }; }
        case "waive": { need(i, "covenant_code", "period_end", "breached_on", "waiver_id"); if (!covenantWaiverAllowed(ctx.actor, date(i.breached_on, "breached_on"), etDate(ctx.now))) refuse(ctx, "COVENANT_WAIVER_WINDOW", "27.1 rule 10: suspended unless waived by officer{sm} within 5 business days", "waiver outside the officer{sm} window", { covenant_code: str(i, "covenant_code") });
          const id = `${f.facility_id}:${str(i, "covenant_code")}:${str(i, "period_end")}`; rt.store.put(K.covenants, id, { result: "waived", waiver_id: str(i, "waiver_id") }, ctx.actor, ctx.now); putFacility(rt, { ...f, status: "active" }, ctx); resumeFacility(ctx.events, f.facility_id, `covenant ${str(i, "covenant_code")} waived ${str(i, "waiver_id")}`, ctx.now); return { result: "waived", facility_status: "active" }; }
        case "activation_request": { const e = requestFacilityActivation(ctx.events, f, ctx.now); putFacility(rt, f, ctx); return { gate: "SM_WH_UCC1_FILING_GATE", event_id: e.id }; }
        case "activate": { need(i, "ucc1_filed_on"); const r = activateFacility(ctx.events, f, { ucc1_filed_on: date(i.ucc1_filed_on, "ucc1_filed_on"), ucc1_acknowledged: flag(i, "ucc1_acknowledged"), lien_search_clean: flag(i, "lien_search_clean"), activated_at: ctx.now }); putFacility(rt, r.facility, ctx); return { status: "active", ucc1_lapse_on: r.ucc1_lapse_on, continuation_window_from: r.continuation_window_from, event_id: r.event.id }; }
        case "ucc_continuation": { need(i, "filed_on", "filing_number"); const e = fileUccContinuation(ctx.events, f, { filed_on: date(i.filed_on, "filed_on"), filing_number: str(i, "filing_number") }); return { filed_on: str(i, "filed_on"), event_id: e.id }; }
        default: throw new RangeError(`testCovenants op ${op} is not one of period_end/package/waive/activation_request/activate/ucc_continuation`);
      } }),
    guardrails: [needsRole("COVENANT_WAIVER_IS_OFFICER", "27.1 guardrails: the agent may never waive a covenant (officer{sm} within 5 business days)", (i) => str(i, "op") === "waive", ["officer"], "covenant waivers are an officer{sm} act")] },
  // Rule 11: the partner's daily report by 09:00 ET (SM_WH_DAILY_REPORT_0900ET) — position, per-advance table, curtailments, defects, covenant status, index history; PDF + JSON.
  { name: "renderDailyReport", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "as_of"); const f = facilityOf(rt, i); const asOf = date(i.as_of, "as_of");
      const snapRec = rt.store.get(K.snapshots, `${f.facility_id}:${asOf}`); const snap = snapRec ? computeBorrowingBase(f, allAdvances(rt, f.facility_id).filter((a) => a.status !== "requested").map((a) => toOpenAdvance(a)), asOf) : baseSnapshot(rt, f, asOf);
      const advances = allAdvances(rt, f.facility_id); const curts = advances.flatMap((a) => curtailmentRows(rt, a.advance_id)); const defects = advances.flatMap((a) => defectRows(rt, a.advance_id));
      const covenant_status = rt.store.list(K.covenants).some((r) => r.data.result === "fail") ? "breached" : f.status === "suspended" ? "suspended" : "compliant";
      const report = renderDailyReport(snap, advances, curts, defects, covenant_status, sofrSeries(rt, i), (a) => (a.advance_date ? D(String(i.expected_purchase_on ?? a.advance_date)) : null));
      const e = issueDailyReport(ctx.events, report, ctx.now);
      rt.store.put(K.reports, report.report_id, { report_id: report.report_id, facility_id: f.facility_id, as_of: asOf, document_id: report.document_id, data_export_id: report.data_export_id, delivered_at: ctx.now, channel: report.channel, json: report }, ctx.actor, ctx.now);
      return { ...report, delivered_at: ctx.now, event_id: e.id }; }) },
  // The decision row per advance and per enforcement decision (rule_set_version / model_version / prompt_version / rationale / confidence).
  { name: "writeDecision", kind: "write", handler: decision() },
]);
export { RULE_SETS as WAREHOUSE_RULE_SETS, type EligibilitySnapshot, type CollateralStatus };
