/**
 * §35.6 rule 8 — the three-sided purchase reconciliation (`orchestration.reconcile`). The SAME 27.2 `purchase_advices` row was
 * handed to 29.4 `ingestPurchaseAdvice` (its R3 variance), 30.1 `matchPurchaseAdvice` (the investor update) and 27.2
 * `matchProceeds` (advice vs forecast vs the bank's credit). `purchase_reconciliations` is written once with the three
 * outcomes: `reconciled` needs 29.4 |variance| ≤ 100 cents, 30.1's update keyed to this row, 27.2 `matched`, and
 * advice net = investor net = bank received; anything else is `exception` with 27.2's breakdown, one sev-2 `officer`
 * escalation (27.2 `explainVariance` attached), no waterfall and no release until the officer decides.
 *   op "reconcile" (default): decide; an exception writes the row, escalates and emits `orchestration.purchase.exception`;
 *                              a reconciled outcome returns `pending_write` — the pass runs 27.2 postWaterfall/releaseCollateral first;
 *   op "complete":            after the waterfall and the release are on the record: write the row with 27.2's figures and emit
 *                              `orchestration.purchase.reconciled` (satisfies SM_ORCH_PURCHASE_RECON_1BD).
 * This module recomputes no owner figure: every number is read from 27.2's, 29.4's and 30.1's rows and events.
 */
import type { Runtime } from "../../runtime/app.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { EscalationService } from "../../app/escalations.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { purchaseIdempotencyKey, type PurchaseAdvice } from "../orig-boarding/ops-30-1.ts";
import { loadRecord, RecordGap, type OrchRecord } from "./facts-35-6.ts";
import { closingFacts } from "./facts-35-6-b.ts";
import { settlementAdvice, investorMatchInput } from "./facts-35-6-d.ts";
import { EV, ORCH_ACTOR } from "./orchestration-35-6.ts";

type Row = Record<string, unknown>;
export type ReconcileOp = "reconcile" | "complete";
export interface ReconcileOptions { readonly now: string; readonly actor: Actor; readonly op?: ReconcileOp; readonly explanation?: Row | null; readonly escalations?: EscalationService }
export type Side294 = "reconciled" | "variance" | "missing";
export type Side301 = "matched" | "unmatched" | "missing";
export type Side272 = "matched" | "exception" | "missing";
export interface Sides { readonly "29.4": Side294; readonly "30.1": Side301; readonly "27.2": Side272 }
/** 29.4 R3: the advice ties to the platform's expected net within 100 cents. */
export const RECON_TOLERANCE_CENTS = 100n;
const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const big = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : BigInt(String(v)));
const CONVENTIONS = new Set(["a_30_360", "b_act_365", "unresolved"]);

interface Evaluation {
  readonly loanId: string; readonly orchestrationId: string | null; readonly adviceId: string; readonly advice: Row; readonly sides: Sides; readonly reconciled: boolean;
  readonly variance294: bigint | null; readonly match: Row | null; readonly bankReceived: bigint | null; readonly investorNet: bigint | null; readonly expectedNet: bigint | null; readonly deliveryId: string | null;
}

async function evaluate(rt: Runtime, applicationId: string): Promise<{ rec: OrchRecord; ev: Evaluation | null; pending: string | null }> {
  const app = await rt.applications.get(applicationId); if (!app) throw new RangeError(`no application ${applicationId}`);
  const orch = (await rt.db.query<{ id: string; loan_id: string | null }>(`SELECT id, loan_id::text AS loan_id FROM closing_orchestrations WHERE application_id = $1`, [applicationId]))[0] ?? null;
  const rec = await loadRecord(rt, app, app.loan_id ?? orch?.loan_id ?? null);
  const loanId = rec.loanId ?? orch?.loan_id ?? null; if (!loanId) throw new RecordGap("applications.loan_id", "no servicing loan (30.2)");
  const row = settlementAdvice(rec, loanId); if (!row) return { rec, ev: null, pending: "sellers_api" };
  const closing = closingFacts(rec); if (!closing) throw new RecordGap("closing.scheduled", "no closing on the record (26.2)");
  const sln = (await rt.db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0]?.n; if (!sln) throw new RecordGap("loans", `no loans row ${loanId} (30.2)`);
  // side 29.4: its own advice row (`<id>:delivery`) reconciled against 29.4 R3's expected net
  const r294 = rec.last("purchase_advice.reconciled", (p) => p["purchase_advice_id"] === `${row.id}:delivery`);
  const variance294 = r294 ? big(r294.payload["variance_cents"]) : null;
  const side294: Side294 = variance294 === null ? "missing" : abs(variance294) <= RECON_TOLERANCE_CENTS ? "reconciled" : "variance";
  // side 30.1: every investor update on the loan keyed to THIS row (30.1's idempotency key = fnma loan number | purchase date | advice id); an update from another figure is one-sided
  const inv = await investorMatchInput(rec, row, { loan_id: loanId, seller_loan_number: sln, closing });
  const key = purchaseIdempotencyKey({ fnma_loan_number: String(inv.advice["fnma_loan_number"]), purchase_date: plainDate(String(inv.advice["purchase_date"])), advice_id: row.id } as unknown as PurchaseAdvice);
  const updates = rec.all("loan.investor_updated");
  const side301: Side301 = !updates.length ? "missing" : updates.every((e) => e.payload["idempotency_key"] === key) ? "matched" : "unmatched";
  // side 27.2: the three-way match on the loan
  const match = rec.entities("proceeds_matches", (d) => d["loan_id"] === loanId).at(-1) ?? null;
  const side272: Side272 = !match ? "missing" : match.data["status"] === "matched" ? "matched" : "exception";
  const receipt = match ? rec.entity("proceeds_receipts", String(match.data["receipt_id"])) ?? null : null;
  const bankReceived = match ? big(receipt?.data["amount_cents"] ?? match.data["received_cents"]) : null;
  const adviceNet = big(row.data["net_proceeds_cents"]);
  const investorNet = side301 === "matched" ? adviceNet : null;
  const sides: Sides = { "29.4": side294, "30.1": side301, "27.2": side272 };
  const reconciled = side294 === "reconciled" && side301 === "matched" && side272 === "matched" && adviceNet !== null && bankReceived === adviceNet && investorNet === adviceNet;
  const pending = side294 === "missing" ? "delivery_reconcile" : side272 === "missing" ? "collection_bank" : null;
  const delivery = rec.entities("deliveries", (d) => typeof d["delivery_id"] === "string").at(-1) ?? null;
  return { rec, pending, ev: { loanId, orchestrationId: orch?.id ?? null, adviceId: row.id, advice: row.data, sides, reconciled, variance294, match: match?.data ?? null, bankReceived, investorNet, expectedNet: match ? big(match.data["expected_proceeds_cents"]) : null, deliveryId: delivery ? String(delivery.data["delivery_id"]) : null } };
}

async function existingRow(rt: Runtime, loanId: string): Promise<{ id: string; status: string; escalation_id: string | null } | null> {
  return (await rt.db.query<{ id: string; status: string; escalation_id: string | null }>(`SELECT id, status, escalation_id::text AS escalation_id FROM purchase_reconciliations WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1`, [loanId]))[0] ?? null;
}

async function insertRow(rt: Runtime, applicationId: string, e: Evaluation, status: "reconciled" | "exception", w: { payoff: bigint | null; interest: bigint | null; fee: bigint | null; cost: bigint | null; retained: bigint | null; residual: bigint | null }, escalationId: string | null, now: string): Promise<string> {
  const a = e.advice; const m = e.match;
  const conv = m && typeof m["convention_basis"] === "string" && CONVENTIONS.has(m["convention_basis"]) ? m["convention_basis"] : null;
  const varianceCents = m ? big(m["variance_cents"]) : e.variance294;
  const r = await rt.db.query<{ id: string }>(
    `INSERT INTO purchase_reconciliations (loan_id, application_id, orchestration_id, delivery_id, purchase_advice_id, advice_date, purchase_date, price_pct, upb_cents, principal_proceeds_cents, interest_adjustment_cents, llpa_total_cents, fees_cents,
       advice_net_proceeds_cents, expected_net_proceeds_cents, investor_net_proceeds_cents, bank_received_cents, warehouse_payoff_cents, warehouse_interest_cents, warehouse_fee_cents, sm_cost_recovery_cents, sm_retained_cents, partner_residual_cents,
       variance_cents, variance_breakdown, sides, interest_convention, status, escalation_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26::jsonb, $27, $28, $29, $30) RETURNING id`,
    [e.loanId, applicationId, e.orchestrationId, e.deliveryId, e.adviceId, String(a["advice_date"]), String(a["purchase_date"]), String(a["price"]), String(a["upb_cents"]), String(a["gross_price_proceeds_cents"]), String(a["interest_cents"] ?? "0"), String(a["llpa_total_cents"]), String(a["other_fees_cents"] ?? "0"),
      String(a["net_proceeds_cents"]), e.expectedNet === null ? null : String(e.expectedNet), e.investorNet === null ? null : String(e.investorNet), e.bankReceived === null ? null : String(e.bankReceived), w.payoff === null ? null : String(w.payoff), w.interest === null ? null : String(w.interest), w.fee === null ? null : String(w.fee), w.cost === null ? null : String(w.cost), w.retained === null ? null : String(w.retained), w.residual === null ? null : String(w.residual),
      varianceCents === null ? null : String(varianceCents), JSON.stringify(m?.["variance_breakdown"] ?? {}), JSON.stringify(e.sides), conv, status, escalationId, now]);
  return r[0]!.id;
}

async function emit(rt: Runtime, applicationId: string, e: Evaluation, type: string, payload: Row, now: string): Promise<string | null> {
  const r = await rt.uow.run({ applicationId, loanId: e.loanId }, (ctx) => ctx.events.append({ type, applicationId, loanId: e.loanId, aggregate: { kind: "purchase_reconciliation", id: String(payload["reconciliation_id"]) }, actor: ORCH_ACTOR, occurredAt: now, payload: { application_id: applicationId, loan_id: e.loanId, purchase_advice_id: e.adviceId, sides: e.sides, ...payload } }));
  return r.events[0]?.id ?? null;
}

export async function reconcilePurchase(rt: Runtime, applicationId: string, o: ReconcileOptions): Promise<Record<string, unknown>> {
  const op: ReconcileOp = o.op ?? "reconcile";
  const { rec, ev, pending } = await evaluate(rt, applicationId);
  if (!ev) return { status: "pending", waiting_on: pending, reason: "27.2 has no advice for the loan yet" };
  const prior = await existingRow(rt, ev.loanId);
  if (op === "complete") {
    if (!ev.reconciled) throw new RangeError(`35.6 rule 8: the sides no longer agree (${JSON.stringify(ev.sides)}) — nothing to complete`);
    const waterfall = rec.last("settlement.waterfall.posted"); const repaid = rec.last("warehouse.advance.repaid", (p) => p["repaid_from"] === "purchase_proceeds");
    const released = rec.last("warehouse.secured_party.released") ?? rec.last("warehouse.bailee_letter.released") ?? rec.last("warehouse.collateral.status_changed", (p) => p["to"] === "released");
    if (!waterfall || !repaid) throw new RecordGap("settlement.waterfall.posted", "27.2's waterfall and the advance repayment are not on the record");
    if (!released) throw new RecordGap("warehouse.secured_party.released", "27.1/27.2's collateral release is not on the record");
    const wfRow = rec.entities("settlement_waterfalls", (d) => d["waterfall_id"] === waterfall.payload["waterfall_id"]).at(-1)?.data ?? {};
    const interest = big(wfRow["accrued_interest_cents"]) !== null ? big(wfRow["accrued_interest_cents"])! + (big(wfRow["capitalized_interest_cents"]) ?? 0n) : null;
    const figures = { payoff: big(waterfall.payload["payoff_total_cents"]), interest, fee: big(wfRow["warehouse_fees_cents"]), cost: big(waterfall.payload["sm_cost_recovery_cents"]), retained: big(waterfall.payload["sm_retained_residual_cents"]), residual: big(waterfall.payload["partner_residual_cents"]) };
    let reconciliationId = prior?.status === "reconciled" ? prior.id : null;
    if (!reconciliationId) reconciliationId = await insertRow(rt, applicationId, ev, "reconciled", figures, null, o.now);
    let eventId = rec.last(EV.reconciled)?.id ?? null;
    if (!eventId) eventId = await emit(rt, applicationId, ev, EV.reconciled, { reconciliation_id: reconciliationId, waterfall_id: waterfall.payload["waterfall_id"], repaid_event_id: repaid.id, release_event_id: released.id, advice_net_proceeds_cents: String(ev.advice["net_proceeds_cents"]), bank_received_cents: String(ev.bankReceived), payoff_total_cents: String(figures.payoff), partner_residual_cents: String(figures.residual) }, o.now);
    return { status: "reconciled", reconciliation_id: reconciliationId, event_id: eventId, sides: ev.sides, step: "purchased" };
  }
  if (prior) return { status: prior.status, reconciliation_id: prior.id, escalation_id: prior.escalation_id, sides: ev.sides, replayed: true, step: "purchased" };
  if (pending) return { status: "pending", waiting_on: pending, sides: ev.sides, reason: pending === "delivery_reconcile" ? "29.4 has not reconciled the advice against its expected net" : "the collection bank has not credited the proceeds" };
  if (ev.reconciled) return { status: "reconciled", pending_write: true, sides: ev.sides, advice_net_proceeds_cents: String(ev.advice["net_proceeds_cents"]), bank_received_cents: String(ev.bankReceived), step: "purchased" };
  // exception: the row, one sev-2 officer escalation with 27.2's breakdown, the event; the money does not move
  const breakdown = ev.match?.["variance_breakdown"] ?? null;
  const payload: Row = { reason: "PURCHASE_EXCEPTION", rule: "35.6 rule 8 THREE_SIDES_ONE_ADVICE", purchase_advice_id: ev.adviceId, sides: ev.sides, advice_net_proceeds_cents: String(ev.advice["net_proceeds_cents"]), investor_net_proceeds_cents: ev.investorNet === null ? null : String(ev.investorNet), bank_received_cents: ev.bankReceived === null ? null : String(ev.bankReceived),
    delivery_variance_cents: ev.variance294 === null ? null : String(ev.variance294), match_status: ev.match?.["status"] ?? null, match_variance_cents: ev.match?.["variance_cents"] ?? null, variance_breakdown: breakdown, explanation: o.explanation ?? null, ask: "confirm which figure is the loan's (the advice, 30.1's update or the bank credit) — no waterfall, no release until then" };
  const esc = o.escalations ? o.escalations.open({ kind: "sev2", ownerRole: "officer", applicationId, loanId: ev.loanId, severity: "sev2", payload }, o.actor) : null;
  const reconciliationId = await insertRow(rt, applicationId, ev, "exception", { payoff: null, interest: null, fee: null, cost: null, retained: null, residual: null }, esc?.id ?? null, o.now);
  const eventId = await emit(rt, applicationId, ev, EV.exception, { reconciliation_id: reconciliationId, escalation_id: esc?.id ?? null, variance_breakdown: breakdown, waiting_on: "officer" }, o.now);
  return { status: "exception", reconciliation_id: reconciliationId, escalation_id: esc?.id ?? null, event_id: eventId, sides: ev.sides, step: "purchased" };
}
