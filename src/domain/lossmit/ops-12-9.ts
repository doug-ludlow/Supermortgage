/**
 * §12.9 Short sale / Mortgage Release (DIL) — the inbound-integration and disbursement surface over the pure
 * calculators (liquidation.ts: contribution, relocation, clocks, deed timing; ops.ts: intake, closing clock, holds).
 * The 12.9 `liquidation.case.*` tool (src/app/tools/section12.ts) owns the case record and emits
 * `liquidation.case.status_changed{case_id, kind, status, status_on, …facts}` on every transition; this module rebuilds
 * the case from that loan's event history (event-sourced — no second store) and validates each inbound vendor,
 * closing, 13.x or disbursement record against it before appending the platform event a 12.9 timer row is satisfied
 * or armed by. Cents are bigint on the records this module returns and decimal strings inside event payloads
 * (JSON-safe); dates are PlainDate.
 *
 * Event vocabulary (producer 12.9):
 *   valuation.received{valuation_id, method, value_cents, as_of, received_on, order_to_receipt_days, sla_met}          satisfies FNMA_F114_SS_VALUATION_10 (F-1-14: results typically within 10 calendar days)
 *   closing.funds.received{case_id, amount_cents, received_on, close_by, within_window, approval_expired, …}           satisfies FNMA_D23301_SS_CLOSE_60 (D2-3.3-01: close within 60 days of approval)
 *   liquidation.case.status_changed{status=expired, next=re_evaluate}                                                  approval expired — funds after day 60 without a Fannie Mae extension (12.9 state machine)
 *   inspection.report.received{case_id, report_doc_id, received_on, interior, vacant, secure, broom_swept, hazards, …}  satisfies FNMA_D23302_DIL_INSPECTION_60 (D2-3.3-02: interior inspection within 60 days of acceptance)
 *   relocation.disbursed{case_id, kind, amount_cents, disbursed_on, payer, due_by, late, …}                            satisfies FNMA_D23302_DIL_RELOCATION_30 (D2-3.3-02: paid within 30 days after the deed is accepted)
 *   foreclosure.nod.rescinded{case_id, recorded_on, instrument_no, rule_citation, due_by, late}                         satisfies CA_CIV_2924_11C_RESCIND_NOD (Cal. Civ. Code §2924.11(c))
 *   foreclosure.sale_scheduled{sale_date, docket_date, dil_case_open, case_id, deed_cutoff, deed_timing}               arms FNMA_D23302_DIL_DEED_BEFORE_SALE_30 (D2-3.3-02: executed deed ≥30 days before the sale)
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { relocation, deedTiming } from "./liquidation.ts";
import { shortSaleClosingClock } from "./ops.ts";

export const LIQUIDATION_ACTOR: Actor = { kind: "agent", id: "lossmit-underwriter" };
export interface LiquidationEnv { readonly events: EventStore; readonly actor: Actor; readonly now: string; }

export type LiquidationKind = "short_sale" | "dil";
/** Statuses after which a DIL case no longer blocks a foreclosure sale date (12.9 state machine). */
const DIL_CLOSED_STATUSES: ReadonlySet<string> = new Set(["released", "reo_conveyed", "cancelled", "declined", "expired", "withdrawn"]);
const SS_APPROVED_STATUSES: ReadonlySet<string> = new Set(["approved", "closing_scheduled", "closed", "liquidated"]);

/** The `liquidation_cases` row as the 12.9 event stream describes it (one case per loan unless `case_id` is given). */
export interface LiquidationCaseView {
  readonly case_id: string; readonly loan_id: string; readonly kind: LiquidationKind; readonly status: string; readonly status_on: PlainDate;
  readonly history: readonly { status: string; on: PlainDate }[];
  readonly state: string | null; readonly proof_of_funds: boolean; readonly transition: boolean | null; readonly interior_bpo_within_90_days: boolean | null;
  readonly vacant_secure_confirmed: boolean; readonly contribution_required: boolean | null; readonly fnma_approval_id: string | null;
  readonly approved_on: PlainDate | null; readonly accepted_on: PlainDate | null; readonly deed_received_on: PlainDate | null; readonly closed_on: PlainDate | null;
  readonly valuations: readonly { id: string; ordered_on: PlainDate; received_on: PlainDate | null }[];
  readonly funds_received_on: PlainDate | null; readonly relocation_disbursed_on: PlainDate | null; readonly nod_rescinded_on: PlainDate | null;
}

const s = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const b = (v: unknown): boolean | null => (v === undefined || v === null || v === "" ? null : v === true || v === "true");
const d = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? (v as PlainDate) : null);
const on = (e: DomainEvent): PlainDate => e.occurredAt.slice(0, 10) as PlainDate;

/** Rebuild the case from the loan's `liquidation.case.status_changed` stream plus the 12.9 inbound events; `null` when the loan has no case. */
export function projectLiquidationCase(events: EventStore, loanId: string, caseId?: string | null): LiquidationCaseView | null {
  const all = events.byLoan(loanId);
  const changes = all.filter((e) => e.type === "liquidation.case.status_changed" && (!caseId || s(e.payload.case_id) === caseId));
  const last = changes.at(-1); if (!last) return null;
  const id = s(last.payload.case_id) ?? `liq-${loanId}`;
  const mine = changes.filter((e) => s(e.payload.case_id) === id);
  const fact = (k: string): unknown => { for (let i = mine.length - 1; i >= 0; i--) { const v = mine[i]!.payload[k]; if (v !== undefined && v !== null) return v; } return undefined; };
  const history = mine.map((e) => ({ status: s(e.payload.status) ?? "open", on: d(e.payload.status_on) ?? on(e) }));
  const firstOn = (status: string): PlainDate | null => history.find((h) => h.status === status)?.on ?? null;
  const forCase = (type: string) => all.filter((e) => e.type === type && (s(e.payload.case_id) === id || s(e.payload.case_id) === null));
  const orders = all.filter((e) => e.type === "valuation.ordered"); const received = all.filter((e) => e.type === "valuation.received");
  const kind = s(fact("kind")) === "dil" || s(fact("kind")) === "mortgage_release" ? "dil" : "short_sale";
  return { case_id: id, loan_id: loanId, kind, status: history.at(-1)!.status, status_on: history.at(-1)!.on, history,
    state: s(fact("state")), proof_of_funds: b(fact("proof_of_funds")) === true, transition: b(fact("transition")), interior_bpo_within_90_days: b(fact("interior_bpo_within_90_days")),
    vacant_secure_confirmed: b(fact("vacant_secure_confirmed")) === true, contribution_required: b(fact("contribution_required")), fnma_approval_id: s(fact("fnma_approval_id")),
    approved_on: firstOn("approved"), accepted_on: firstOn("accepted"), deed_received_on: firstOn("deed_received"), closed_on: firstOn("closed"),
    valuations: orders.map((o) => ({ id: s(o.payload.valuation_id) ?? "", ordered_on: on(o), received_on: received.filter((r) => s(r.payload.valuation_id) === s(o.payload.valuation_id)).map((r) => d(r.payload.received_on) ?? on(r)).at(-1) ?? null })),
    funds_received_on: forCase("closing.funds.received").map((e) => d(e.payload.received_on) ?? on(e)).at(-1) ?? null,
    relocation_disbursed_on: forCase("relocation.disbursed").map((e) => d(e.payload.disbursed_on) ?? on(e)).at(-1) ?? null,
    nod_rescinded_on: forCase("foreclosure.nod.rescinded").map((e) => d(e.payload.recorded_on) ?? on(e)).at(-1) ?? null };
}

function requireCase(env: LiquidationEnv, loanId: string, caseId?: string | null): LiquidationCaseView {
  if (!loanId) throw new RangeError("loan_id is required");
  const c = projectLiquidationCase(env.events, loanId, caseId);
  if (!c) throw new RangeError(`no liquidation case for loan ${loanId}${caseId ? ` (case ${caseId})` : ""} — open it with liquidation.case.* first (12.9 data model)`);
  return c;
}
const emit = (env: LiquidationEnv, type: string, loanId: string, payload: Record<string, unknown>): DomainEvent => env.events.append({ type, loanId, actor: env.actor, payload });
const today = (env: LiquidationEnv): PlainDate => env.now.slice(0, 10) as PlainDate;
const needDate = (v: PlainDate | null | undefined, k: string): PlainDate => { if (!v) throw new RangeError(`${k} is required (YYYY-MM-DD)`); return v; };

// ---- valuation.received (F-1-14; FNMA_F114_SS_VALUATION_10) ------------------------------------------------------
export interface ValuationReceivedInput { readonly loan_id: string; readonly valuation_id: string; readonly method: string; readonly value_cents: Cents; readonly as_of: PlainDate; readonly received_on?: PlainDate | null; }
/** The SMDU/BPO valuation result ingested: it must answer an order placed through the servicing solutions system (`valuation.ordered{valuation_id}`), carry a positive value and an as-of date no later than receipt. */
export function recordValuationReceived(env: LiquidationEnv, r: ValuationReceivedInput): { event: DomainEvent; order_to_receipt_days: number; sla_met: boolean; ordered_on: PlainDate } {
  if (!r.loan_id) throw new RangeError("loan_id is required");
  if (!r.valuation_id) throw new RangeError("valuation_id is required");
  if (r.value_cents <= 0n) throw new RangeError(`valuation ${r.valuation_id}: value must be positive (got ${r.value_cents} cents)`);
  const receivedOn = r.received_on ?? today(env); needDate(r.as_of, "as_of");
  if (r.as_of > receivedOn) throw new RangeError(`valuation ${r.valuation_id}: as_of ${r.as_of} is after receipt ${receivedOn}`);
  const order = env.events.byLoan(r.loan_id).find((e) => e.type === "valuation.ordered" && s(e.payload.valuation_id) === r.valuation_id);
  if (!order) throw new RangeError(`valuation ${r.valuation_id} was not ordered for loan ${r.loan_id} (F-1-14: valuations are ordered through Fannie Mae's servicing solutions system before a result is accepted)`);
  const orderedOn = on(order); const days = daysBetween(orderedOn, receivedOn);
  const event = emit(env, "valuation.received", r.loan_id, { valuation_id: r.valuation_id, method: r.method || null, value_cents: r.value_cents.toString(), as_of: r.as_of, received_on: receivedOn, ordered_on: orderedOn, order_to_receipt_days: days, sla_met: days <= 10 });
  return { event, order_to_receipt_days: days, sla_met: days <= 10, ordered_on: orderedOn };
}

// ---- closing.funds.received (D2-3.3-01; FNMA_D23301_SS_CLOSE_60) --------------------------------------------------
export interface ClosingFundsInput { readonly loan_id: string; readonly case_id?: string | null; readonly amount_cents: Cents; readonly received_on?: PlainDate | null; readonly reference?: string | null; readonly fnma_extension_id?: string | null; }
/**
 * Lockbox/wire proceeds ingested against an approved short sale. Funds inside the 60-day window (or under a Fannie Mae
 * extension) satisfy the closing clock; later funds still record the receipt but expire the approval — the case moves
 * to `expired` with `next=re_evaluate` (12.9 state machine: approved → expired → re-evaluate).
 */
export function recordClosingFundsReceived(env: LiquidationEnv, r: ClosingFundsInput): { event: DomainEvent; expiry: DomainEvent | null; close_by: PlainDate; status: "closed" | "expired"; approval_expired: boolean; next: "re_evaluate" | null; refusal: string | null } {
  const c = requireCase(env, r.loan_id, r.case_id);
  if (c.kind !== "short_sale") throw new RangeError(`case ${c.case_id} is a Mortgage Release — closing proceeds apply to a short sale (D2-3.3-01)`);
  if (!SS_APPROVED_STATUSES.has(c.status) || !c.approved_on) throw new RangeError(`case ${c.case_id} is ${c.status}, not approved — no closing funds are accepted before the SMDU decision / Fannie Mae approval (12.9 guardrail)`);
  if (r.amount_cents <= 0n) throw new RangeError(`closing funds must be positive (got ${r.amount_cents} cents)`);
  const receivedOn = r.received_on ?? today(env);
  const clock = shortSaleClosingClock({ approved_on: c.approved_on, funds_received_on: receivedOn, fnma_extension_id: r.fnma_extension_id ?? null });
  const event = emit(env, "closing.funds.received", r.loan_id, { case_id: c.case_id, amount_cents: r.amount_cents.toString(), received_on: receivedOn, approved_on: c.approved_on, close_by: clock.close_by, within_window: receivedOn <= clock.close_by, fnma_extension_id: r.fnma_extension_id ?? null, approval_expired: clock.approval_expired, reference: r.reference ?? null });
  const expiry = clock.approval_expired ? emit(env, "liquidation.case.status_changed", r.loan_id, { case_id: c.case_id, kind: c.kind, status: "expired", status_on: receivedOn, previous_status: c.status, close_by: clock.close_by, funds_received_on: receivedOn, next: "re_evaluate", ...(c.state ? { state: c.state } : {}) }) : null;
  return { event, expiry, close_by: clock.close_by, status: clock.approval_expired ? "expired" : "closed", approval_expired: clock.approval_expired, next: clock.next, refusal: clock.refusal };
}

// ---- inspection.report.received (D2-3.3-02; FNMA_D23302_DIL_INSPECTION_60) ------------------------------------------
export interface InspectionReportInput { readonly loan_id: string; readonly case_id?: string | null; readonly report_doc_id: string; readonly received_on?: PlainDate | null; readonly interior: boolean; readonly vacant: boolean; readonly secure: boolean; readonly broom_swept: boolean; readonly hazards?: readonly string[]; readonly personal_property_value_cents?: Cents; }
/** The inspection vendor's report ingested against an accepted Mortgage Release: vacancy/security (lien-release anchor), broom-swept condition and hazards (relocation reductions), personal property ≥$500 (Fannie Mae approval). */
export function recordInspectionReport(env: LiquidationEnv, r: InspectionReportInput): { event: DomainEvent; due_by: PlainDate; late: boolean; vacant_secure_confirmed: boolean; remediation_required: boolean; personal_property_fnma_approval_required: boolean } {
  const c = requireCase(env, r.loan_id, r.case_id);
  if (c.kind !== "dil") throw new RangeError(`case ${c.case_id} is a short sale — the D2-3.3-02 interior inspection belongs to a Mortgage Release`);
  if (!c.accepted_on) throw new RangeError(`case ${c.case_id} is ${c.status} — the inspection window opens on the borrower's acceptance (D2-3.3-02)`);
  if (!r.report_doc_id) throw new RangeError("report_doc_id is required");
  const receivedOn = r.received_on ?? today(env);
  if (receivedOn < c.accepted_on) throw new RangeError(`inspection received ${receivedOn} before acceptance ${c.accepted_on}`);
  const dueBy = addDays(c.accepted_on, 60); const hazards = [...(r.hazards ?? [])];
  const confirmed = r.interior && r.vacant && r.secure; const remediation = !r.broom_swept || hazards.length > 0;
  const ppApproval = (r.personal_property_value_cents ?? 0n) >= 50_000n;
  const event = emit(env, "inspection.report.received", r.loan_id, { case_id: c.case_id, report_doc_id: r.report_doc_id, received_on: receivedOn, interior: r.interior, vacant: r.vacant, secure: r.secure, broom_swept: r.broom_swept, hazards, vacant_secure_confirmed: confirmed, due_by: dueBy, late: receivedOn > dueBy, remediation_required: remediation, personal_property_fnma_approval_required: ppApproval });
  return { event, due_by: dueBy, late: receivedOn > dueBy, vacant_secure_confirmed: confirmed, remediation_required: remediation, personal_property_fnma_approval_required: ppApproval };
}

// ---- relocation.disbursed (D2-3.3-01 / D2-3.3-02; FNMA_D23302_DIL_RELOCATION_30) -------------------------------------
export type RelocationPayer = "closing_agent" | "servicer" | "fnma_property_manager";
export interface RelocationDisbursementInput { readonly loan_id: string; readonly case_id?: string | null; readonly disbursed_on?: PlainDate | null; readonly payer: RelocationPayer; readonly third_party_assistance_cents?: Cents; readonly remediation_estimate_cents?: Cents; readonly fnma_approval_id?: string | null; }
/**
 * The $7,500 relocation payment recorded against the case. Guardrail: never while a cash contribution is required
 * unless Fannie Mae approved it (12.9 rule 3); the amount is the calculator's ($7,500 less third-party assistance and,
 * on a DIL, the remediation estimate); a non-transition DIL pays within 30 days after the executed deed is accepted.
 */
export function disburseRelocation(env: LiquidationEnv, r: RelocationDisbursementInput): { event: DomainEvent; amount_cents: Cents; due_by: PlainDate | null; late: boolean } {
  const c = requireCase(env, r.loan_id, r.case_id);
  const approval = r.fnma_approval_id ?? c.fnma_approval_id;
  if (c.contribution_required === true && !approval) throw new RangeError(`NO_RELOCATION_WITH_CONTRIBUTION: case ${c.case_id} requires a cash contribution — relocation assistance is not payable absent Fannie Mae approval (D2-3.3-01; 12.9 guardrail)`);
  if (c.relocation_disbursed_on) throw new RangeError(`case ${c.case_id}: relocation assistance already disbursed on ${c.relocation_disbursed_on}`);
  const amount = relocation(false, r.third_party_assistance_cents ?? 0n, c.kind === "dil" ? (r.remediation_estimate_cents ?? 0n) : 0n);
  if (amount <= 0n) throw new RangeError(`case ${c.case_id}: nothing payable after third-party assistance/remediation reductions (D2-3.3-0${c.kind === "dil" ? "2" : "1"})`);
  if (c.kind === "short_sale" && r.payer !== "closing_agent") throw new RangeError("short-sale relocation assistance is disbursed by the closing agent from proceeds on the settlement statement (D2-3.3-01)");
  if (c.kind === "dil" && c.transition === true && r.payer !== "fnma_property_manager") throw new RangeError("transition-option relocation assistance is paid by Fannie Mae's property manager within 30 days after vacancy (D2-3.3-02)");
  if (c.kind === "dil" && c.transition !== true && !c.deed_received_on) throw new RangeError(`case ${c.case_id} is ${c.status} — a non-transition Mortgage Release pays relocation after the executed deed is accepted (D2-3.3-02)`);
  const disbursedOn = r.disbursed_on ?? today(env);
  const dueBy = c.kind === "dil" && c.transition !== true && c.deed_received_on ? addDays(c.deed_received_on, 30) : null;
  const late = dueBy !== null && disbursedOn > dueBy;
  const event = emit(env, "relocation.disbursed", r.loan_id, { case_id: c.case_id, kind: c.kind, amount_cents: amount.toString(), disbursed_on: disbursedOn, payer: r.payer, third_party_assistance_cents: (r.third_party_assistance_cents ?? 0n).toString(), remediation_estimate_cents: (c.kind === "dil" ? (r.remediation_estimate_cents ?? 0n) : 0n).toString(), fnma_approval_id: approval, due_by: dueBy, late });
  return { event, amount_cents: amount, due_by: dueBy, late };
}

// ---- foreclosure.nod.rescinded (Cal. Civ. Code §2924.11(c); CA_CIV_2924_11C_RESCIND_NOD) ---------------------------
export interface NodRescindedInput { readonly loan_id: string; readonly case_id?: string | null; readonly recorded_on?: PlainDate | null; readonly instrument_no: string; readonly county?: string | null; }
/** Counsel's/e-recording's confirmation that the notice of default was rescinded after a CA short-sale approval with proof of funds. */
export function recordNodRescinded(env: LiquidationEnv, r: NodRescindedInput): { event: DomainEvent; due_by: PlainDate; late: boolean } {
  const c = requireCase(env, r.loan_id, r.case_id);
  if (c.state !== "CA") throw new RangeError(`case ${c.case_id}: §2924.11(c) rescission applies to California loans (state ${c.state ?? "unknown"})`);
  if (!c.approved_on || !SS_APPROVED_STATUSES.has(c.status) && c.status !== "expired") throw new RangeError(`case ${c.case_id} is ${c.status} — the rescission duty follows an approved short sale with proof of funds (Cal. Civ. Code §2924.11(c))`);
  if (!r.instrument_no) throw new RangeError("instrument_no is required (the recorded rescission)");
  const recordedOn = r.recorded_on ?? today(env); const dueBy = addBusinessDays(c.approved_on, 5, servicer);
  const event = emit(env, "foreclosure.nod.rescinded", r.loan_id, { case_id: c.case_id, recorded_on: recordedOn, instrument_no: r.instrument_no, county: r.county ?? null, approved_on: c.approved_on, rule_citation: "Cal. Civ. Code §2924.11(c)", due_by: dueBy, late: recordedOn > dueBy });
  return { event, due_by: dueBy, late: recordedOn > dueBy };
}

// ---- foreclosure.sale_scheduled (D2-3.3-02; FNMA_D23302_DIL_DEED_BEFORE_SALE_30) ------------------------------------
export interface SaleScheduledInput { readonly loan_id: string; readonly sale_date: PlainDate; readonly docket_date?: PlainDate | null; readonly source?: string | null; }
/**
 * A 13.x sale (or court docket) date ingested for the liquidation file: the 12.9 event carries whether a Mortgage Release
 * is open (`dil_case_open`), the executed-deed cut-off 30 calendar days before the sale and, when the deed is already in,
 * the `12.9.deedTiming` verdict — a later deed needs Fannie Mae's prior approval.
 */
export function recordForeclosureSaleScheduled(env: LiquidationEnv, r: SaleScheduledInput): { event: DomainEvent; dil_case_open: boolean; deed_cutoff: PlainDate; deed_timing: "allowed" | "fnma_prior_approval" | null; fnma_prior_approval_required: boolean } {
  if (!r.loan_id) throw new RangeError("loan_id is required");
  const saleOn = needDate(r.sale_date, "sale_date");
  const c = projectLiquidationCase(env.events, r.loan_id);
  const open = c !== null && c.kind === "dil" && !DIL_CLOSED_STATUSES.has(c.status);
  const cutoff = addDays(saleOn, -30);
  const timing = open && c!.deed_received_on ? deedTiming(c!.deed_received_on, saleOn) : null;
  const event = emit(env, "foreclosure.sale_scheduled", r.loan_id, { sale_date: saleOn, docket_date: r.docket_date ?? null, dil_case_open: open, case_id: open ? c!.case_id : null, deed_cutoff: cutoff, deed_received_on: open ? c!.deed_received_on : null, deed_timing: timing, source: r.source ?? null });
  return { event, dil_case_open: open, deed_cutoff: cutoff, deed_timing: timing, fnma_prior_approval_required: timing === "fnma_prior_approval" };
}
/** Subscribe the liquidation file to the platform's `foreclosure.sale.scheduled` (13.x/15.x spelling: `sale_at` / `scheduled_sale_date`) so every scheduled sale is re-stated for 12.9 with `dil_case_open`. */
export function attachSaleScheduleListener(env: LiquidationEnv): () => void {
  return env.events.subscribe("foreclosure.sale.scheduled", (e) => {
    const saleOn = d(e.payload.sale_at) ?? d(e.payload.scheduled_sale_date) ?? d(e.payload.sale_date);
    if (e.loanId && saleOn) recordForeclosureSaleScheduled({ ...env, now: e.occurredAt }, { loan_id: e.loanId, sale_date: saleOn, source: `foreclosure.sale.scheduled (${e.id})` });
  });
}
