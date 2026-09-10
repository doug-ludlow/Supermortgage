/**
 * §3.7 operating rules over the calculators in disbursement.ts and the lifecycle helpers in ops.ts. Every function
 * here appends the `loan_events` the 3.7 timer rows arm on and are satisfied by, validating the inbound record first
 * (a tax-service bill/confirmation/return record, a Fannie Mae escrow-event ack, a delinquency report, an insurer
 * cancellation notice) — so a timer is only ever closed by a fact the platform actually recorded:
 *
 *   receiveBill                 `escrow.bill.received` (+ `disbursement.scheduled`)   — rules 1–3, 7 (duplicate hash), T1/T13
 *   projectLine                 `escrow.line.created`                                 — ESC_EXPECTED_BILL_MISSING_30 trigger
 *   ingestRailStatus            `disbursement.confirmed` / `.rejected` / `.returned`  — rule 8, T10/T12/T15
 *   replanRejected              `disbursement.scheduled{replanned=true}`              — rule 8 (2 BD re-plan), T12
 *   reissueReturned             `escrow.disbursement.reissued` + `disbursement.sent`  — state machine returned → reissued → sent
 *   postEscrowActivity          `ledger.entries.posted{account=escrow}` + `escrow.event.queued` — rules 6/11, T2/T6/T7
 *   ackEscrowEvent              `escrow.event.accepted` / `escrow.event.rejected`     — LL-2026-05 responses
 *   correctEscrowEvent          `escrow.event.corrected` + a re-queued event          — rule 11 corrections, T7
 *   reverseEscrowEvent          opposite-signed `escrow.event.queued`                 — rule 11 reversals, T15
 *   closeEscrowPeriod           `escrow.period.closed{all_accepted}`                  — BD2 17:00 ET close
 *   enableEscrowEventReporting  `feature_flag.enabled{flag=investor_reporting.escrow_events}` + `escrow.setup_event.sent` — rule 12, T9
 *   recordSetupAcks             `escrow.setup_events.accepted{pct}`                   — FNMA_LL2026_05_ESCROW_SETUP_CUTOVER
 *   readyAttestationPackage     `escrow.attestation.package_ready`                    — rule 13, T8
 *   submitAttestation           `escrow.attestation.submitted`                        — human_portal_task outcome, T8
 *   flagNonEscrowDelinquency    `escrow.nonescrow.tax_delinquent`                     — rules 9–10, T11
 *   resolveNonEscrowDelinquency `escrow.nonescrow.tax_delinquency.resolved{outcome}`  — ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30
 *   evaluateInabilityToDisburse `escrow.hazard.inability_evaluated`                   — (k)(5)(ii)(A), T5
 *
 * Money is bigint cents (strings inside payloads, as the rest of the platform stores them); dates are PlainDate.
 */
import { type PlainDate, addDays, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import { wallClock, toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Ledger, LineInput } from "../../kernel/ledger/ledger.ts";
import { schedule, leadHonored, LEAD_DAYS, rejectReplanDue, hazardDecision, type Bill, type Method, type Schedule } from "./disbursement.ts";
import { billHash, replanAfterReject, attestationSchedule, setupEventsAtCutover, nonEscrowDelinquency, cancellationOverlay, ESCROW_SETUP_CUTOVER_DEADLINE, type CutoverLoan, type SetupAck } from "./ops.ts";
import { eventDeadlineMs } from "../investor/period.ts";

const ET = "America/New_York";
const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const latest = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const loanEvents = (store: EventStore, loanId: string, type: string): readonly DomainEvent[] => store.byLoan(loanId).filter((e) => e.type === type);
const dateOf = (v: unknown, what: string): PlainDate => { need(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v), `${what} must be a YYYY-MM-DD date`); return plainDate(v as string); };
/** The reporting period an activity belongs to (LL-2026-05: the month of the processed date; closes BD2 17:00 ET of the next month). */
export const periodKeyOf = (processedOn: PlainDate): string => processedOn.slice(0, 7);
/** The aggregate the §5.1 `period.month_end` fact carries (ops-5-1 periodAggregate), so period-scoped 3.7 events satisfy the rows it arms. */
export const periodAggregate = (servicerNumber: string, periodKey: string): { kind: "period"; id: string } => ({ kind: "period", id: `${servicerNumber}:${periodKey}` });
/** BD n of the month (Fannie Mae ET calendar). */
const fannieBd = (monthStart: PlainDate, n: number): PlainDate => { let d = addDays(monthStart, -1); for (let k = 0; k < n; k++) d = addBusinessDays(d, 1, fannieEt); return d; };

// ============================================================ bills, scheduling, duplicates (rules 1–3, 7; T1, T13)
export const DISBURSEMENT_KINDS = ["tax", "hazard", "flood", "wind", "other_insurance", "mi", "hoa", "ground_rent", "surplus_refund", "payoff_refund", "lpi_premium", "other"] as const;
export type DisbursementKind = (typeof DISBURSEMENT_KINDS)[number];
/** An inbound bill record (tax service, insurer, MI, HOA feed) as the integration delivers it. */
export interface BillRecord extends Bill {
  readonly loan_id: string; readonly bill_id?: string | null; readonly kind: DisbursementKind; readonly payee: string; readonly parcel_or_policy: string; readonly period: string;
  readonly feed: string; readonly escrowed: boolean; readonly regx_days_delinquent: number; readonly state?: string | null;
}
export interface ReceiveBillResult {
  readonly blocked: boolean; readonly anomaly: string | null; readonly bill_id: string; readonly disbursement_id: string | null; readonly schedule: Schedule | null; readonly events: DomainEvent[];
}
/**
 * Rule 7 duplicate prevention by (payee, parcel/policy, period, amount) hash — the second feed's copy is blocked and the
 * anomaly logged (T13); otherwise `escrow.bill.received` (the trigger of the two penalty deadlines and the discount
 * warning, with `penalty_date`, `discount_date`, `escrowed` and `regx_days_delinquent` for their conditions) and the
 * rule-1/2 schedule as `disbursement.scheduled`.
 */
export function receiveBill(store: EventStore, i: { bill: BillRecord; method?: Method; escrow_balance_cents: Cents; other_due_within_30_cents?: Cents; capture?: boolean; actor: Actor }): ReceiveBillResult {
  const b = i.bill;
  need(typeof b.loan_id === "string" && b.loan_id.length > 0, "bill.loan_id is required");
  need((DISBURSEMENT_KINDS as readonly string[]).includes(b.kind), `bill.kind must be one of ${DISBURSEMENT_KINDS.join(", ")}`);
  need(typeof b.payee === "string" && b.payee.length > 0 && typeof b.parcel_or_policy === "string" && b.parcel_or_policy.length > 0 && typeof b.period === "string" && b.period.length > 0, "bill.payee, bill.parcel_or_policy and bill.period identify the bill");
  need(typeof b.amount_cents === "bigint" && b.amount_cents > 0n, "bill.amount_cents must be a positive bigint");
  need(typeof b.feed === "string" && b.feed.length > 0, "bill.feed names the source feed (tax_service, insurer, mi, hoa, county_portal …)");
  need(typeof b.escrowed === "boolean" && Number.isInteger(b.regx_days_delinquent), "bill.escrowed and bill.regx_days_delinquent are required (the penalty rows' conditions)");
  const dueOn = dateOf(b.due_on, "bill.due_on"), receivedOn = dateOf(b.received_on, "bill.received_on");
  const penaltyOn = b.penalty_on ? dateOf(b.penalty_on, "bill.penalty_on") : null; const discount = b.discount ? { pct: b.discount.pct, by: dateOf(b.discount.by, "bill.discount.by") } : null;
  const hash = billHash({ payee: b.payee, parcel_or_policy: b.parcel_or_policy, period: b.period, amount_cents: b.amount_cents });
  const billId = b.bill_id ?? `${b.kind}:${b.parcel_or_policy}:${b.period}`;
  const prior = loanEvents(store, b.loan_id, "escrow.bill.received").find((e) => p(e).bill_hash === hash);
  if (prior) {
    const anomaly = `duplicate bill ${hash} from ${b.feed} (first seen from ${String(p(prior).feed)})`;
    const ev = store.append({ type: "escrow.bill.duplicate_blocked", loanId: b.loan_id, actor: i.actor, causationId: prior.id, payload: { bill_hash: hash, feed: b.feed, first_feed: p(prior).feed, first_bill_id: p(prior).bill_id, anomaly } });
    return { blocked: true, anomaly, bill_id: String(p(prior).bill_id), disbursement_id: null, schedule: null, events: [ev] };
  }
  const must = penaltyOn ?? dueOn;
  const received = store.append({ type: "escrow.bill.received", loanId: b.loan_id, actor: i.actor, payload: {
    bill_id: billId, bill_hash: hash, kind: b.kind, payee: b.payee, parcel_or_policy: b.parcel_or_policy, period: b.period, amount_cents: String(b.amount_cents), feed: b.feed,
    due_date: dueOn, penalty_date: must, discount_date: discount?.by ?? null, discount_pct: discount?.pct ?? null, received_on: receivedOn, escrowed: b.escrowed, regx_days_delinquent: b.regx_days_delinquent, state: b.state ?? null } });
  const s = schedule({ amount_cents: b.amount_cents, due_on: dueOn, penalty_on: penaltyOn, received_on: receivedOn, discount }, i.method ?? (b.kind === "tax" ? "tax_service_bulk" : "ach"), i.escrow_balance_cents, i.other_due_within_30_cents ?? 0n, i.capture !== false);
  const disbursementId = `DSB-${b.loan_id}-${billId}`;
  const scheduled = store.append({ type: "disbursement.scheduled", loanId: b.loan_id, actor: i.actor, causationId: received.id, payload: {
    disbursement_id: disbursementId, bill_id: billId, kind: b.kind, method: s.method, amount_cents: String(s.amount_cents), release_on: s.release_on, must_pay_by: s.must_pay_by, discount_captured: s.discount_captured, discount_date: discount?.by ?? null,
    discount_lost_reason: s.discount_lost_reason ?? null, lead_business_days: s.lead_business_days, replanned: false, status: "scheduled" } });
  return { blocked: false, anomaly: null, bill_id: billId, disbursement_id: disbursementId, schedule: s, events: [received, scheduled] };
}
/** `escrow.line.created` (boarding/analysis) → the expected-bill timer 30 days before the projected due date (ESC_EXPECTED_BILL_MISSING_30). */
export function projectLine(store: EventStore, i: { loan_id: string; line_id?: string | null; line_type: string; projected_due_on: PlainDate; projected_amount_cents: Cents; source: string; actor: Actor }): { event: DomainEvent; expected_bill_by: PlainDate; line_id: string } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && typeof i.line_type === "string" && i.line_type.length > 0, "line.loan_id and line.line_type are required");
  need(typeof i.projected_amount_cents === "bigint" && i.projected_amount_cents > 0n, "line.projected_amount_cents must be a positive bigint");
  const due = dateOf(i.projected_due_on, "line.projected_due_on"); const lineId = i.line_id ?? `${i.line_type}:${due}`;
  const event = store.append({ type: "escrow.line.created", loanId: i.loan_id, actor: i.actor, payload: { line_id: lineId, line_type: i.line_type, projected_due_on: due, projected_amount_cents: String(i.projected_amount_cents), source: i.source, status: "projected", expected_bill_by: addDays(due, -30) } });
  return { event, expected_bill_by: addDays(due, -30), line_id: lineId };
}

// ============================================================ rail status files: confirm / reject / return / reissue (rule 8; T10, T12, T15)
export type RailStatus = "confirmed" | "rejected" | "returned";
export interface RailStatusRecord {
  readonly loan_id: string; readonly disbursement_id: string; readonly status: RailStatus; readonly on: PlainDate; readonly external_ref: string; readonly reason?: string | null;
  readonly amount_cents?: Cents | null; readonly parcel?: string | null; readonly property_address?: string | null;
}
/** The disbursement a rail record references: its schedule (bill id, must-pay date, method, amount) and the latest lifecycle fact as the causation. */
const disbursementOnLoan = (store: EventStore, loanId: string, disbursementId: string): { facts: Record<string, unknown>; cause: DomainEvent } => {
  const mine = store.byLoan(loanId).filter((x) => (x.type === "disbursement.scheduled" || x.type === "disbursement.sent") && p(x).disbursement_id === disbursementId);
  const sched = latest(mine.filter((x) => x.type === "disbursement.scheduled")); const cause = latest(mine);
  need(!!cause, `no disbursement ${disbursementId} scheduled or sent on loan ${loanId}: a rail status record must reference one`);
  return { facts: { ...p(cause!), ...(sched ? p(sched) : {}) }, cause: cause! };
};
/**
 * Tax service / custodial bank confirmation and return files update the disbursement: `confirmed` (with `paid_on`, `kind`,
 * `state` — the IL 45-business-day notice row arms on a confirmed IL tax payment), `rejected` (re-plan within 2 BD:
 * ESC_PAYEE_REJECT_REPLAN_2BD anchors on `rejected_on`) or `returned` (the same code, armed explicitly by the tool).
 */
export function ingestRailStatus(store: EventStore, i: RailStatusRecord & { actor: Actor }): { event: DomainEvent; replan: ReturnType<typeof replanAfterReject> | null; il_notice_due_on: PlainDate | null } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && typeof i.disbursement_id === "string" && i.disbursement_id.length > 0, "rail status needs loan_id and disbursement_id");
  need(i.status === "confirmed" || i.status === "rejected" || i.status === "returned", "rail status must be confirmed, rejected or returned");
  need(typeof i.external_ref === "string" && i.external_ref.length > 0, "rail status needs the vendor/bank external_ref (immutable evidence)");
  const on = dateOf(i.on, "rail status date");
  const { facts: dp, cause: d } = disbursementOnLoan(store, i.loan_id, i.disbursement_id);
  const kind = String(dp.kind ?? "tax"); const amount = i.amount_cents ?? BigInt(String(dp.amount_cents ?? "0")); const mustPayBy = typeof dp.must_pay_by === "string" ? plainDate(dp.must_pay_by) : null;
  // The property identification and state come from the bill the disbursement pays (the 765 ILCS 910/15 notice needs parcel + state; the IL row's trigger conditions on `state`).
  const bill = latest(loanEvents(store, i.loan_id, "escrow.bill.received").filter((e) => p(e).bill_id === dp.bill_id)); const bp = bill ? p(bill) : {};
  const state = (bp.state as string | null | undefined) ?? null;
  if (i.status === "confirmed") {
    const ilDue = kind === "tax" && state === "IL" ? addBusinessDays(on, 45, servicer) : null;
    const event = store.append({ type: "disbursement.confirmed", loanId: i.loan_id, actor: i.actor, causationId: d.id, payload: { disbursement_id: i.disbursement_id, kind, state, paid_on: on, amount_cents: String(amount), external_ref: i.external_ref, parcel: i.parcel ?? (bp.parcel_or_policy as string | undefined) ?? null, property_address: i.property_address ?? null, method: dp.method ?? null, il_notice_due_on: ilDue, on_time: mustPayBy === null || on <= mustPayBy } });
    return { event, replan: null, il_notice_due_on: ilDue };
  }
  need(typeof i.reason === "string" && i.reason.length > 0, `a ${i.status} record carries the payee/vendor reason (wrong parcel, closed account, amount mismatch …)`);
  if (i.status === "rejected") {
    const replan = mustPayBy ? replanAfterReject(on, mustPayBy) : null;
    const event = store.append({ type: "disbursement.rejected", loanId: i.loan_id, actor: i.actor, causationId: d.id, payload: { disbursement_id: i.disbursement_id, kind, rejected_on: on, reason: i.reason, external_ref: i.external_ref, amount_cents: String(amount), must_pay_by: mustPayBy, replan_by: rejectReplanDue(on), replan_method: replan?.method ?? "ach" } });
    return { event, replan, il_notice_due_on: null };
  }
  // returned: the reject date the re-plan clock anchors on is the return date (spec: `disbursement.rejected/returned` → reject date + 2 BD).
  const event = store.append({ type: "disbursement.returned", loanId: i.loan_id, actor: i.actor, causationId: d.id, payload: { disbursement_id: i.disbursement_id, kind, returned_on: on, rejected_on: on, reason: i.reason, external_ref: i.external_ref, amount_cents: String(amount), must_pay_by: mustPayBy, replan_by: rejectReplanDue(on), method: dp.method ?? null } });
  return { event, replan: mustPayBy ? replanAfterReject(on, mustPayBy) : null, il_notice_due_on: null };
}
/** Rule 8 / T12: a vendor reject is re-planned by ACH direct within 2 servicer BD — `disbursement.scheduled{replanned=true}` closes ESC_PAYEE_REJECT_REPLAN_2BD. */
export function replanRejected(store: EventStore, i: { loan_id: string; disbursement_id: string; replanned_on: PlainDate; method?: Method; actor: Actor }): { event: DomainEvent; plan: ReturnType<typeof replanAfterReject> } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && typeof i.disbursement_id === "string" && i.disbursement_id.length > 0, "replan needs loan_id and disbursement_id");
  const rej = latest(store.byLoan(i.loan_id).filter((e) => (e.type === "disbursement.rejected" || e.type === "disbursement.returned") && p(e).disbursement_id === i.disbursement_id));
  need(!!rej, `no reject/return recorded for ${i.disbursement_id} on loan ${i.loan_id}`);
  const rp = p(rej!); need(typeof rp.must_pay_by === "string", `disbursement ${i.disbursement_id} has no must-pay date to re-plan against`);
  const plan = replanAfterReject(plainDate(String(rp.rejected_on)), plainDate(String(rp.must_pay_by)));
  const method = i.method ?? plan.method; const replannedOn = dateOf(i.replanned_on, "replanned_on");
  const event = store.append({ type: "disbursement.scheduled", loanId: i.loan_id, actor: i.actor, causationId: rej!.id, payload: {
    disbursement_id: i.disbursement_id, bill_id: rp.bill_id ?? null, kind: rp.kind, method, amount_cents: rp.amount_cents, release_on: plan.release_on, must_pay_by: rp.must_pay_by, replan_by: plan.replan_by, replanned_on: replannedOn, on_time: plan.on_time && replannedOn <= plan.replan_by,
    discount_captured: false, lead_business_days: LEAD_DAYS[method], replanned: true, status: "scheduled", reason: rp.reason } });
  return { event, plan };
}
/** State machine: `returned` → `reissued` → `sent` (returned checks reissued; the lead is re-measured for the reissue). */
export function reissueReturned(store: EventStore, i: { loan_id: string; disbursement_id: string; reissued_on: PlainDate; method?: Method; check_no?: string | null; actor: Actor }): { events: DomainEvent[]; lead_honored: boolean | null } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && typeof i.disbursement_id === "string" && i.disbursement_id.length > 0, "reissue needs loan_id and disbursement_id");
  const ret = latest(loanEvents(store, i.loan_id, "disbursement.returned").filter((e) => p(e).disbursement_id === i.disbursement_id));
  need(!!ret, `no returned disbursement ${i.disbursement_id} on loan ${i.loan_id}`);
  const rp = p(ret!); const on = dateOf(i.reissued_on, "reissued_on"); const method = i.method ?? ((rp.method as Method | null) ?? "check");
  const mustPayBy = typeof rp.must_pay_by === "string" ? plainDate(rp.must_pay_by) : null; const lead_honored = mustPayBy ? leadHonored(on, mustPayBy, method) : null;
  const reissued = store.append({ type: "escrow.disbursement.reissued", loanId: i.loan_id, actor: i.actor, causationId: ret!.id, payload: { disbursement_id: i.disbursement_id, reissued_on: on, method, amount_cents: rp.amount_cents, check_no: i.check_no ?? null, status: "reissued" } });
  const sent = store.append({ type: "disbursement.sent", loanId: i.loan_id, actor: i.actor, causationId: reissued.id, payload: { disbursement_id: i.disbursement_id, kind: rp.kind, method, amount_cents: rp.amount_cents, release_on: on, must_pay_by: mustPayBy, lead_business_days: LEAD_DAYS[method], lead_honored, reissue: true } });
  return { events: [reissued, sent], lead_honored };
}

// ============================================================ escrow events (rule 11; LL-2026-05): ledger posting → outbox → acks → corrections → reversals
export const ESCROW_CATEGORIES = ["taxes_insurance", "loss_draft", "buy_down", "renovation"] as const;
export type EscrowCategory = (typeof ESCROW_CATEGORIES)[number];
/** Rule 11 item-type mapping (LL-2026-05 examples; other values per the Business & Data Requirements [UNVERIFIED]). */
export const ITEM_TYPE: Record<string, string> = { tax: "County Tax", hazard: "Property Insurance", flood: "Property Insurance", wind: "Property Insurance", other_insurance: "Property Insurance", mi: "Mortgage Insurance", hoa: "HOA Assessment", ground_rent: "Ground Rent", lpi_premium: "Property Insurance", contractual_payment: "Loan Escrow Payment", interest: "Interest on Escrow", refund: "Payee Refund", modification: "Modification", setup: "Set up", loss_draft: "Loan Loss Draft Activity" };
export interface ChainState { readonly sequence: number; readonly balance_cents: Cents; readonly last: DomainEvent | null; }
/** The per-loan, per-category event chain (Setup and queued events, in store order): next sequence = max + 1; balance = the last event's balance after posting. */
export function chainState(store: EventStore, loanId: string, category: EscrowCategory): ChainState {
  const chain = store.byLoan(loanId).filter((e) => (e.type === "escrow.event.queued" || e.type === "escrow.setup_event.sent") && p(e).category === category);
  const last = latest(chain) ?? null;
  return { sequence: chain.reduce((m, e) => Math.max(m, Number(p(e).sequence)), 0), balance_cents: last ? BigInt(String(p(last).balance_cents)) : 0n, last };
}
const processedAtOf = (v: string | undefined, fallback: string): { at: string; on: PlainDate; ms: number } => { const at = v ?? fallback; const ms = Date.parse(at); need(!Number.isNaN(ms), "processed_at must be an ISO instant"); return { at, on: wallClock(ms, ET).date, ms }; };
export interface PostEscrowActivityInput {
  readonly loan_id: string; readonly direction: "deposit" | "disbursement"; readonly amount_cents: Cents; readonly item: string; readonly category?: EscrowCategory;
  readonly processed_at?: string; readonly now: string; readonly opening_balance_cents?: Cents | null; readonly contractual_payment_cents?: Cents | null; readonly advance_cents?: Cents | null;
  readonly disbursement_id?: string | null; readonly custodial_account_id?: string; readonly actor: Actor;
}
export interface PostedEscrowActivity { readonly sequence: number; readonly amount_cents: Cents; readonly balance_cents: Cents; readonly processed_on: PlainDate; readonly deadline_at: string; readonly period_key: string; readonly entry_set_id: string; readonly events: DomainEvent[]; }
const custodialTi = (id: string) => ({ scope: "custodial" as const, custodialAccountId: id, account: "custodial_ti_cash" as const });
/**
 * Every ledger set touching a loan's `escrow` account emits one escrow event: amount = signed change, balance after
 * posting, processed date = posting day, next per-loan sequence, deadline next `fannie_et` BD 03:00 ET. Fatal rules
 * enforced before queueing: item amount ≠ 0; LD/BD/Renovation balances never negative (T&I may); the balance equation
 * (prior balance + amount = reported balance) holds by construction. The advance variant (rule 6) posts
 * Dr custodial_ti_cash / Cr advance_receivable first, then Dr loan escrow / Cr custodial_ti_cash for the full amount.
 */
export function postEscrowActivity(store: EventStore, ledger: Ledger, i: PostEscrowActivityInput): PostedEscrowActivity {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0, "loan_id is required");
  need(i.direction === "deposit" || i.direction === "disbursement", "direction must be deposit or disbursement");
  need(typeof i.amount_cents === "bigint" && i.amount_cents > 0n, "LL-2026-05 fatal rule: Loan Escrow Item Amount ≠ 0.00 — amount_cents must be a positive bigint (the direction gives the sign)");
  need(typeof i.item === "string" && i.item.length > 0, "item (the Loan Escrow Item Type or the disbursement kind) is required");
  const category = i.category ?? "taxes_insurance"; need((ESCROW_CATEGORIES as readonly string[]).includes(category), `category must be one of ${ESCROW_CATEGORIES.join(", ")}`);
  const itemType = ITEM_TYPE[i.item] ?? i.item;
  const signed = i.direction === "deposit" ? i.amount_cents : -i.amount_cents;
  const chain = chainState(store, i.loan_id, category);
  need(chain.last !== null || (typeof i.opening_balance_cents === "bigint"), `no escrow event chain for loan ${i.loan_id} (${category}): send the Setup event first or give opening_balance_cents from the ledger snapshot`);
  const priorBalance = chain.last ? chain.balance_cents : (i.opening_balance_cents as Cents);
  const balance = priorBalance + signed;
  need(category === "taxes_insurance" || balance >= 0n, `LL-2026-05 fatal rule: ${category} balance may not be negative (${balance} cents) — posting blocked; route to custodial-recon`);
  const { at, on, ms } = processedAtOf(i.processed_at, i.now);
  const adv = i.advance_cents ?? 0n; need(adv >= 0n && adv <= i.amount_cents, "advance_cents must be between 0 and the amount");
  const ti = custodialTi(i.custodial_account_id ?? "TI-1014");
  const lines: LineInput[] = i.direction === "disbursement"
    ? [...(adv > 0n ? [{ account: ti, amountCents: adv, ruleRef: "3.7 rule 6: advance (servicer funds into T&I custodial)" }, { account: { scope: "corporate" as const, account: "advance_receivable" as const }, amountCents: -adv, ruleRef: "3.7 rule 6: Cr servicer_advance_receivable" }] : []),
      { account: { scope: "loan" as const, loanId: i.loan_id, account: "escrow" as const }, amountCents: i.amount_cents, ruleRef: `3.7 rule 6: Dr loan escrow (${itemType})` }, { account: ti, amountCents: -i.amount_cents, ruleRef: "3.7 rule 6: Cr custodial_ti_cash" }]
    : [{ account: ti, amountCents: i.amount_cents, ruleRef: `3.7 rule 11: Dr custodial_ti_cash (${itemType})` }, { account: { scope: "loan" as const, loanId: i.loan_id, account: "escrow" as const }, amountCents: -i.amount_cents, ruleRef: "3.7 rule 11: Cr loan escrow (deposit)" }];
  const set = ledger.post({ effectiveDate: on, description: `${itemType} ${i.direction} ${i.loan_id}`, lines }, at);
  const posted = store.append({ type: "ledger.entries.posted", loanId: i.loan_id, actor: i.actor, occurredAt: at, payload: { account: "escrow", entry_set_id: set.id, processed_on: on, processed_at: at, amount_cents: String(signed), advance_cents: String(adv), category, item_type: itemType, disbursement_id: i.disbursement_id ?? null, lines: lines.map((l) => ({ account: l.account.account, amount_cents: String(l.amountCents), rule_ref: l.ruleRef })) } });
  const sequence = chain.sequence + 1; const deadline = toIso(eventDeadlineMs(ms)); const periodKey = periodKeyOf(on);
  const queued = store.append({ type: "escrow.event.queued", loanId: i.loan_id, actor: i.actor, occurredAt: at, causationId: posted.id, payload: {
    event_id: `EE-${i.loan_id}-${category}-${sequence}-${set.id.slice(0, 8)}`, sequence, category, item_type: itemType, amount_cents: String(signed), balance_cents: String(balance), processed_on: on, processed_at: at, deadline_at: deadline, period_key: periodKey,
    contractual_payment_cents: i.contractual_payment_cents === undefined || i.contractual_payment_cents === null ? null : String(i.contractual_payment_cents), advance_cents: String(adv), entry_set_id: set.id, disbursement_id: i.disbursement_id ?? null, corrects: null, reversal_of: null, status: "queued" } });
  return { sequence, amount_cents: signed, balance_cents: balance, processed_on: on, deadline_at: deadline, period_key: periodKey, entry_set_id: set.id, events: [posted, queued] };
}
export type EscrowEventStatus = "queued" | "accepted" | "accepted_warning" | "rejected" | "corrected";
/** The status of one queued event id, derived from the acks/corrections that reference it (the append-only chain is the record). */
export function escrowEventStatus(store: EventStore, loanId: string, eventId: string): EscrowEventStatus {
  const acts = store.byLoan(loanId).filter((e) => (e.type === "escrow.event.accepted" || e.type === "escrow.event.rejected" || e.type === "escrow.event.corrected") && p(e).event_id === eventId);
  const last = latest(acts); if (!last) return "queued";
  if (last.type === "escrow.event.corrected") return "corrected";
  if (last.type === "escrow.event.rejected") return "rejected";
  return p(last).status === "accepted_warning" ? "accepted_warning" : "accepted";
}
/** Every queued event of a sequence (the original and any corrections), oldest first, with its derived status. */
export function escrowEventHistory(store: EventStore, loanId: string, sequence: number): { event_id: string; status: EscrowEventStatus; balance_cents: Cents; amount_cents: Cents; corrects: string | null }[] {
  return loanEvents(store, loanId, "escrow.event.queued").filter((e) => Number(p(e).sequence) === sequence).map((e) => ({ event_id: String(p(e).event_id), status: escrowEventStatus(store, loanId, String(p(e).event_id)), balance_cents: BigInt(String(p(e).balance_cents)), amount_cents: BigInt(String(p(e).amount_cents)), corrects: (p(e).corrects as string | null) ?? null }));
}
const openQueued = (store: EventStore, loanId: string, sequence: number): DomainEvent => {
  const e = latest(loanEvents(store, loanId, "escrow.event.queued").filter((x) => Number(p(x).sequence) === sequence));
  need(!!e, `no escrow event with sequence ${sequence} queued on loan ${loanId}`);
  return e!;
};
/** A Fannie Mae response on the `fnma-servicing-events` rail: accepted / accepted with warning (both terminal) or rejected (needs a correction). */
export function ackEscrowEvent(store: EventStore, i: { loan_id: string; sequence: number; status: "accepted" | "accepted_warning" | "rejected"; message?: string | null; fnma_response_id?: string | null; acked_at?: string; now: string; actor: Actor }): { event: DomainEvent; status: EscrowEventStatus } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && Number.isInteger(i.sequence) && i.sequence > 0, "ack needs loan_id and a positive integer sequence");
  need(i.status === "accepted" || i.status === "accepted_warning" || i.status === "rejected", "ack status must be accepted, accepted_warning or rejected");
  const q = openQueued(store, i.loan_id, i.sequence); const eventId = String(p(q).event_id); const cur = escrowEventStatus(store, i.loan_id, eventId);
  need(cur === "queued", `escrow event ${eventId} is ${cur}, not awaiting a response`);
  if (i.status === "rejected") need(typeof i.message === "string" && i.message.length > 0, "a rejection carries the Fannie Mae fatal-rule message");
  const at = i.acked_at ?? i.now;
  const event = i.status === "rejected"
    ? store.append({ type: "escrow.event.rejected", loanId: i.loan_id, actor: i.actor, occurredAt: at, causationId: q.id, payload: { event_id: eventId, sequence: i.sequence, category: p(q).category, reason: i.message, fnma_response_id: i.fnma_response_id ?? null, period_key: p(q).period_key } })
    : store.append({ type: "escrow.event.accepted", loanId: i.loan_id, actor: i.actor, occurredAt: at, causationId: q.id, payload: { event_id: eventId, sequence: i.sequence, category: p(q).category, status: i.status, warning: i.status === "accepted_warning" ? i.message ?? null : null, fnma_response_id: i.fnma_response_id ?? null, period_key: p(q).period_key, deadline_at: p(q).deadline_at, late: Date.parse(at) > Date.parse(String(p(q).deadline_at)) } });
  return { event, status: escrowEventStatus(store, i.loan_id, eventId) };
}
/** Rule 11 / T7: a rejected event is corrected by resubmitting a corrected event at the same sequence position; the rejected one shows `corrected`. */
export function correctEscrowEvent(store: EventStore, i: { loan_id: string; sequence: number; fix: { amount_cents?: Cents; balance_cents?: Cents }; processed_at?: string; now: string; actor: Actor }): { events: DomainEvent[]; rejected_event_id: string; corrected_event_id: string; balance_cents: Cents } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && Number.isInteger(i.sequence) && i.sequence > 0, "correction needs loan_id and a positive integer sequence");
  need(!!i.fix && (typeof i.fix.amount_cents === "bigint" || typeof i.fix.balance_cents === "bigint"), "a correction changes amount_cents and/or balance_cents");
  const bad = openQueued(store, i.loan_id, i.sequence); const badId = String(p(bad).event_id);
  need(escrowEventStatus(store, i.loan_id, badId) === "rejected", `escrow event ${badId} is not rejected — only rejected events are corrected (an accepted event is reversed instead)`);
  const { at, on } = processedAtOf(i.processed_at, i.now); const amount = i.fix.amount_cents ?? BigInt(String(p(bad).amount_cents)); const balance = i.fix.balance_cents ?? BigInt(String(p(bad).balance_cents));
  const newId = `${badId}-C${loanEvents(store, i.loan_id, "escrow.event.corrected").length + 1}`;
  const corrected = store.append({ type: "escrow.event.corrected", loanId: i.loan_id, actor: i.actor, occurredAt: at, causationId: bad.id, payload: { event_id: badId, sequence: i.sequence, corrected_by: newId, category: p(bad).category } });
  const queued = store.append({ type: "escrow.event.queued", loanId: i.loan_id, actor: i.actor, occurredAt: at, causationId: corrected.id, payload: { ...p(bad), event_id: newId, amount_cents: String(amount), balance_cents: String(balance), processed_at: at, resubmitted_on: on, deadline_at: toIso(eventDeadlineMs(Date.parse(at))), corrects: badId, status: "queued" } });
  return { events: [corrected, queued], rejected_event_id: badId, corrected_event_id: newId, balance_cents: balance };
}
/** Rule 11 / T15: a reversal (returned check) emits the opposite-signed event on the reversal's processed date with the next sequence — never a deletion; the balance is restored. */
export function reverseEscrowEvent(store: EventStore, ledger: Ledger, i: { loan_id: string; sequence: number; reason: string; processed_at?: string; now: string; custodial_account_id?: string; actor: Actor }): PostedEscrowActivity & { reversal_of: number } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && Number.isInteger(i.sequence) && i.sequence > 0, "reversal needs loan_id and a positive integer sequence");
  need(typeof i.reason === "string" && i.reason.length > 0, "reversal needs a reason (returned check, payee refund …)");
  const orig = openQueued(store, i.loan_id, i.sequence); const op = p(orig); const origAmount = BigInt(String(op.amount_cents));
  const category = op.category as EscrowCategory; const chain = chainState(store, i.loan_id, category); const balance = chain.balance_cents - origAmount;
  const { at, on, ms } = processedAtOf(i.processed_at, i.now);
  const set = ledger.reverse(String(op.entry_set_id), on, i.reason, at);
  const posted = store.append({ type: "ledger.entries.posted", loanId: i.loan_id, actor: i.actor, occurredAt: at, causationId: orig.id, payload: { account: "escrow", entry_set_id: set.id, reverses_entry_set_id: op.entry_set_id, processed_on: on, processed_at: at, amount_cents: String(-origAmount), category, item_type: `${String(op.item_type)} (reversal)`, reason: i.reason } });
  const sequence = chain.sequence + 1; const deadline = toIso(eventDeadlineMs(ms));
  const queued = store.append({ type: "escrow.event.queued", loanId: i.loan_id, actor: i.actor, occurredAt: at, causationId: posted.id, payload: {
    event_id: `EE-${i.loan_id}-${category}-${sequence}-${set.id.slice(0, 8)}`, sequence, category, item_type: `${String(op.item_type)} (reversal)`, amount_cents: String(-origAmount), balance_cents: String(balance), processed_on: on, processed_at: at, deadline_at: deadline, period_key: periodKeyOf(on),
    contractual_payment_cents: null, advance_cents: "0", entry_set_id: set.id, disbursement_id: op.disbursement_id ?? null, corrects: null, reversal_of: i.sequence, reason: i.reason, status: "queued" } });
  return { sequence, amount_cents: -origAmount, balance_cents: balance, processed_on: on, deadline_at: deadline, period_key: periodKeyOf(on), entry_set_id: set.id, events: [posted, queued], reversal_of: i.sequence };
}
/** BD2 17:00 ET close: every queued event of the period accepted → `escrow.period.closed{all_accepted=true}`; otherwise the pending ones are listed (they roll to the next period; attestation variance). */
export function closeEscrowPeriod(store: EventStore, i: { servicer_number: string; period_key: string; closed_at?: string; now: string; actor: Actor }): { event: DomainEvent; all_accepted: boolean; total: number; accepted: number; pending: string[]; close_at: string; late: boolean } {
  need(/^\d{9}$/.test(i.servicer_number), "servicer_number (9 digits) is required");
  need(/^\d{4}-\d{2}$/.test(i.period_key), "period_key must be YYYY-MM");
  const closedAt = i.closed_at ?? i.now; need(!Number.isNaN(Date.parse(closedAt)), "closed_at must be an ISO instant");
  const queued = store.ofType("escrow.event.queued").filter((e) => p(e).period_key === i.period_key);
  const statuses = queued.map((e) => ({ key: `${e.loanId}:${String(p(e).sequence)}`, id: String(p(e).event_id), status: escrowEventStatus(store, e.loanId!, String(p(e).event_id)) }));
  // A corrected (rejected → resubmitted) event is closed by its replacement; the pending set is what is still queued or rejected.
  const pending = statuses.filter((s) => s.status === "queued" || s.status === "rejected").map((s) => s.key);
  const accepted = statuses.filter((s) => s.status === "accepted" || s.status === "accepted_warning").length;
  const [y, m] = i.period_key.split("-").map(Number) as [number, number]; const nextMonth = plainDate(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`);
  const closeAt = toIso(zonedEpochMs(fannieBd(nextMonth, 2), "17:00", ET)); const late = Date.parse(closedAt) > Date.parse(closeAt);
  const all = pending.length === 0;
  const event = store.append({ type: "escrow.period.closed", aggregate: periodAggregate(i.servicer_number, i.period_key), actor: i.actor, occurredAt: closedAt, payload: { period_key: i.period_key, servicer_number: i.servicer_number, all_accepted: all, total: queued.length, accepted, pending, closed_at: closedAt, close_at: closeAt, late } });
  return { event, all_accepted: all, total: queued.length, accepted, pending, close_at: closeAt, late };
}

// ============================================================ Setup events at cutover (rule 12; T9; FNMA_LL2026_05_ESCROW_SETUP_CUTOVER)
export const ESCROW_EVENTS_FLAG = "investor_reporting.escrow_events";
/** The go-live cutover job: the feature flag turns on (the deadline row's trigger, anchored on the configured cutover date ≤ 2026-12-01) and one Setup event per category is sent for every active and inactive escrowed loan, before any deposit/disbursement event. */
export function enableEscrowEventReporting(store: EventStore, i: { cutover_on: PlainDate; loans: readonly CutoverLoan[]; enabled_at?: string; now: string; actor: Actor }): { flag: DomainEvent; setups: DomainEvent[]; plan: ReturnType<typeof setupEventsAtCutover> } {
  const cutover = dateOf(i.cutover_on, "cutover_on"); need(cutover <= ESCROW_SETUP_CUTOVER_DEADLINE, `cutover ${cutover} is after the LL-2026-05 mandate ${ESCROW_SETUP_CUTOVER_DEADLINE}`);
  need(Array.isArray(i.loans) && i.loans.length > 0, "the cutover needs the escrowed-loan snapshot (loans[] with categories and ledger balances)");
  const enabledAt = i.enabled_at ?? i.now;
  const plan = setupEventsAtCutover(i.loans, cutover);
  const flag = store.append({ type: "feature_flag.enabled", actor: i.actor, occurredAt: enabledAt, payload: { flag: ESCROW_EVENTS_FLAG, cutover_on: cutover, accept_by: plan.accept_by, enabled_at: enabledAt, escrowed_loans: plan.events.length } });
  const setups = plan.events.map((e) => store.append({ type: "escrow.setup_event.sent", loanId: e.loan_id, actor: i.actor, occurredAt: enabledAt, causationId: flag.id, payload: {
    event_id: `ES-${e.loan_id}-${e.category}`, category: e.category, item_type: ITEM_TYPE.setup, sequence: e.sequence, amount_cents: String(e.balance_cents), balance_cents: String(e.balance_cents), processed_on: cutover, deadline_at: toIso(zonedEpochMs(e.deadline_at, "03:00", ET)), period_key: periodKeyOf(cutover), before_first_deposit: e.before_first_deposit, status: "sent" } }));
  return { flag, setups, plan };
}
/** The Fannie Mae acks for the Setup events, measured against the mandate: `escrow.setup_events.accepted{pct}` closes the cutover row only at 100 (the row's "Setup events accepted for 100% of escrowed loans"). */
export function recordSetupAcks(store: EventStore, i: { cutover_on: PlainDate; loans: readonly CutoverLoan[]; acks: readonly SetupAck[]; recorded_at?: string; now: string; actor: Actor }): { event: DomainEvent; plan: ReturnType<typeof setupEventsAtCutover> } {
  const cutover = dateOf(i.cutover_on, "cutover_on"); need(Array.isArray(i.loans) && i.loans.length > 0 && Array.isArray(i.acks), "setup acks need the loan snapshot and the acks[]");
  for (const a of i.acks) need(typeof a.loan_id === "string" && typeof a.category === "string" && ["accepted", "accepted_warning", "rejected", "pending"].includes(a.status), "each ack is {loan_id, category, status, accepted_on?}");
  const plan = setupEventsAtCutover(i.loans, cutover, i.acks);
  const event = store.append({ type: "escrow.setup_events.accepted", actor: i.actor, occurredAt: i.recorded_at ?? i.now, payload: { flag: ESCROW_EVENTS_FLAG, cutover_on: cutover, pct: plan.accepted_pct, accepted: plan.events.length - plan.missing.length, total: plan.events.length, all_accepted_by_deadline: plan.all_accepted_by_deadline, accept_by: plan.accept_by, covers_inactive: plan.covers_inactive, missing: plan.missing } });
  return { event, plan };
}

// ============================================================ attestation (rule 13; T8; FNMA_LL2026_05_ESCROW_ATTEST_BD2)
export interface CategoryTotals { readonly loan_count: number; readonly ending_balance_cents: Cents; readonly aggregate_contractual_payment_cents: Cents; }
export interface AttestationCategory { readonly category: EscrowCategory; readonly ledger: CategoryTotals; readonly fnma: CategoryTotals; }
/** BD3 package per servicer number and category (ending balance, loan count, aggregate contractual payment) reconciled to the Fannie Mae summary; any mismatch is a variance the human sees before attesting. The `human_portal_task` SLA is BD2 of the following month. */
export function readyAttestationPackage(store: EventStore, i: { servicer_number: string; period_key: string; categories: readonly AttestationCategory[]; ready_at?: string; now: string; actor: Actor }): { event: DomainEvent; package_ready_on: PlainDate; sla_on: PlainDate; variance: boolean; variances: string[] } {
  need(/^\d{9}$/.test(i.servicer_number), "servicer_number (9 digits) is required"); need(/^\d{4}-\d{2}$/.test(i.period_key), "period_key must be YYYY-MM");
  need(Array.isArray(i.categories) && i.categories.length > 0, "the package needs at least one category (ledger vs Fannie Mae totals)");
  const variances: string[] = [];
  for (const c of i.categories) {
    need((ESCROW_CATEGORIES as readonly string[]).includes(c.category) && !!c.ledger && !!c.fnma, "each category carries ledger and fnma {loan_count, ending_balance_cents, aggregate_contractual_payment_cents}");
    if (c.ledger.loan_count !== c.fnma.loan_count) variances.push(`${c.category}: loan count ledger ${c.ledger.loan_count} vs Fannie Mae ${c.fnma.loan_count}`);
    if (c.ledger.ending_balance_cents !== c.fnma.ending_balance_cents) variances.push(`${c.category}: ending balance ledger ${c.ledger.ending_balance_cents} vs Fannie Mae ${c.fnma.ending_balance_cents}`);
    if (c.ledger.aggregate_contractual_payment_cents !== c.fnma.aggregate_contractual_payment_cents) variances.push(`${c.category}: aggregate contractual payment ledger ${c.ledger.aggregate_contractual_payment_cents} vs Fannie Mae ${c.fnma.aggregate_contractual_payment_cents}`);
  }
  const ledgerLoans = i.categories.reduce((s, c) => s + c.ledger.loan_count, 0), fnmaLoans = i.categories.reduce((s, c) => s + c.fnma.loan_count, 0);
  // The BD3 / BD2 dates come from the period (attestationSchedule); the outcome from every reconciled field, not the loan count alone.
  const sched = attestationSchedule(plainDate(`${i.period_key}-01`), { ledger_loans: ledgerLoans, fnma_loans: fnmaLoans });
  const event = store.append({ type: "escrow.attestation.package_ready", aggregate: periodAggregate(i.servicer_number, i.period_key), actor: i.actor, occurredAt: i.ready_at ?? i.now, payload: {
    period_key: i.period_key, servicer_number: i.servicer_number, package_ready_on: sched.package_ready_on, sla_on: sched.portal_task_sla_on, human_portal_task: "escrow_attestation", variance: variances.length > 0, variances, expected_outcome: variances.length ? "attested_no_with_commentary" : "attested_yes",
    categories: i.categories.map((c) => ({ category: c.category, ledger: { loan_count: c.ledger.loan_count, ending_balance_cents: String(c.ledger.ending_balance_cents), aggregate_contractual_payment_cents: String(c.ledger.aggregate_contractual_payment_cents) }, fnma: { loan_count: c.fnma.loan_count, ending_balance_cents: String(c.fnma.ending_balance_cents), aggregate_contractual_payment_cents: String(c.fnma.aggregate_contractual_payment_cents) } })) } });
  return { event, package_ready_on: sched.package_ready_on, sla_on: sched.portal_task_sla_on, variance: variances.length > 0, variances };
}
/** The human's UI attestation: "Yes" only when the package reconciled; a variance attests "No" with commentary and opens the variance case (`attested_no_with_commentary` → `variance_case`). */
export function submitAttestation(store: EventStore, i: { servicer_number: string; period_key: string; commentary?: string | null; evidence_document_id: string; submitted_at?: string; now: string; actor: Actor }): { event: DomainEvent; outcome: "attested_yes" | "attested_no_with_commentary"; variance_case_id: string | null; on_time: boolean } {
  need(/^\d{9}$/.test(i.servicer_number) && /^\d{4}-\d{2}$/.test(i.period_key), "servicer_number (9 digits) and period_key (YYYY-MM) are required");
  need(typeof i.evidence_document_id === "string" && i.evidence_document_id.length > 0, "the UI attestation is evidenced (screenshot / confirmation id document)");
  const agg = periodAggregate(i.servicer_number, i.period_key);
  const pkg = latest(store.ofType("escrow.attestation.package_ready").filter((e) => e.aggregate?.kind === agg.kind && e.aggregate.id === agg.id));
  need(!!pkg, `no attestation package ready for ${i.servicer_number} ${i.period_key}`);
  const variance = p(pkg!).variance === true; const submittedAt = i.submitted_at ?? i.now;
  if (variance) need(typeof i.commentary === "string" && i.commentary.length > 0, `the package shows a variance (${(p(pkg!).variances as string[]).join("; ")}): attest No with commentary`);
  const outcome = variance ? "attested_no_with_commentary" : "attested_yes"; const caseId = variance ? `VAR-${i.servicer_number}-${i.period_key}` : null;
  const submittedOn = wallClock(Date.parse(submittedAt), ET).date; const onTime = submittedOn <= plainDate(String(p(pkg!).sla_on));
  const event = store.append({ type: "escrow.attestation.submitted", aggregate: agg, actor: i.actor, occurredAt: submittedAt, causationId: pkg!.id, payload: { period_key: i.period_key, servicer_number: i.servicer_number, outcome, commentary: i.commentary ?? null, evidence_document_id: i.evidence_document_id, variance_case_id: caseId, submitted_on: submittedOn, sla_on: p(pkg!).sla_on, on_time: onTime, attested_by: `${i.actor.kind}:${i.actor.id}` } });
  if (caseId) store.append({ type: "case.opened", aggregate: agg, actor: i.actor, occurredAt: submittedAt, causationId: event.id, payload: { case_id: caseId, kind: "escrow_attestation_variance", period_key: i.period_key, variances: p(pkg!).variances, commentary: i.commentary } });
  return { event, outcome, variance_case_id: caseId, on_time: onTime };
}

// ============================================================ non-escrowed monitoring (rules 9–10; T11; ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30)
/** The tax service's delinquency report for a non-escrowed loan: the case, the borrower notice and the 30-day follow-up clock anchored on `found_on`. */
export function flagNonEscrowDelinquency(store: EventStore, i: { loan_id: string; escrowed: boolean; parcel: string; delinquent_cents: Cents; found_on: PlainDate; tax_sale_date?: PlainDate | null; source: string; actor: Actor }): { event: DomainEvent; case_id: string; plan: ReturnType<typeof nonEscrowDelinquency> } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0 && typeof i.parcel === "string" && i.parcel.length > 0, "delinquency report needs loan_id and parcel");
  need(i.escrowed === false, "non-escrow monitoring applies to loans without an escrow account (an escrowed loan's unpaid bill is a 3.7 disbursement, not a delinquency case)");
  need(typeof i.delinquent_cents === "bigint" && i.delinquent_cents > 0n, "delinquent_cents must be a positive bigint");
  need(typeof i.source === "string" && i.source.length > 0, "source names the report (tax_service_delinquency_search, tax_sale_notice, lien_notice)");
  const foundOn = dateOf(i.found_on, "found_on"); const taxSale = i.tax_sale_date ? dateOf(i.tax_sale_date, "tax_sale_date") : null;
  const plan = nonEscrowDelinquency({ found_on: foundOn, paid_by_followup: false, tax_sale_scheduled: taxSale !== null });
  const caseId = `NET-${i.loan_id}-${foundOn}`;
  const event = store.append({ type: "escrow.nonescrow.tax_delinquent", loanId: i.loan_id, actor: i.actor, payload: { case_id: caseId, parcel: i.parcel, delinquent_cents: String(i.delinquent_cents), found_on: foundOn, tax_sale_date: taxSale, follow_up_on: plan.follow_up_on, source: i.source, notice: plan.notice, status: "delinquent" } });
  store.append({ type: "case.opened", loanId: i.loan_id, actor: i.actor, causationId: event.id, payload: { case_id: caseId, kind: "nonescrow_tax_delinquency", parcel: i.parcel, follow_up_on: plan.follow_up_on } });
  return { event, case_id: caseId, plan };
}
/** Closes the follow-up: borrower proof of payment, or the advance + waiver revocation (3.8) already recorded on the loan — never a bare declaration. */
export function resolveNonEscrowDelinquency(store: EventStore, i: { loan_id: string; resolved_on: PlainDate; proof_of_payment_document_id?: string | null; actor: Actor }): { event: DomainEvent; outcome: "proof_of_payment" | "advance_and_revocation"; on_time: boolean } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0, "loan_id is required");
  const flagged = latest(loanEvents(store, i.loan_id, "escrow.nonescrow.tax_delinquent")); need(!!flagged, `no open non-escrow tax delinquency on loan ${i.loan_id}`);
  const resolvedOn = dateOf(i.resolved_on, "resolved_on");
  const after = (t: string, pred: (e: DomainEvent) => boolean = () => true) => store.byLoan(i.loan_id).some((e) => e.type === t && e.sequence > flagged!.sequence && pred(e));
  let outcome: "proof_of_payment" | "advance_and_revocation";
  if (typeof i.proof_of_payment_document_id === "string" && i.proof_of_payment_document_id.length > 0) outcome = "proof_of_payment";
  else if (after("escrow.advance.posted", (e) => p(e).waived === true) && after("escrow.waiver.revoked")) outcome = "advance_and_revocation";
  else throw new RangeError("cannot resolve: neither borrower proof of payment (proof_of_payment_document_id) nor an advance with waiver revocation (postAdvance waived=true; 3.8) is on the loan since the delinquency was found");
  const onTime = resolvedOn <= plainDate(String(p(flagged!).follow_up_on));
  const event = store.append({ type: "escrow.nonescrow.tax_delinquency.resolved", loanId: i.loan_id, actor: i.actor, causationId: flagged!.id, payload: { case_id: p(flagged!).case_id, outcome, resolved_on: resolvedOn, on_time: onTime, proof_of_payment_document_id: i.proof_of_payment_document_id ?? null, parcel: p(flagged!).parcel } });
  store.append({ type: "case.closed", loanId: i.loan_id, actor: i.actor, causationId: event.id, payload: { case_id: p(flagged!).case_id, outcome } });
  return { event, outcome, on_time: onTime };
}

// ============================================================ (k)(5) inability evaluation (T4/T5; REGX_1024_17K5_LPI_PURCHASE_GATE)
export type CancellationReason = "underwriting" | "non_payment" | "vacancy" | "other";
/** `insurance.policy.cancellation_notice` / `property.vacancy_confirmed` (Section 9) → the (k)(5)(ii)(A) evaluation recorded on the loan for Section 9.2's LPI gate. */
export function evaluateInabilityToDisburse(store: EventStore, i: { loan_id: string; notice: "insurance.policy.cancellation_notice" | "property.vacancy_confirmed"; reason: CancellationReason; received_on: PlainDate; regx_days_delinquent: number; actor: Actor }): { event: DomainEvent } & ReturnType<typeof cancellationOverlay> & { pay_or_advance: boolean } {
  need(typeof i.loan_id === "string" && i.loan_id.length > 0, "loan_id is required");
  need(i.notice === "insurance.policy.cancellation_notice" || i.notice === "property.vacancy_confirmed", "notice must be insurance.policy.cancellation_notice or property.vacancy_confirmed");
  need(["underwriting", "non_payment", "vacancy", "other"].includes(i.reason), "reason must be underwriting, non_payment, vacancy or other");
  need(Number.isInteger(i.regx_days_delinquent) && i.regx_days_delinquent >= 0, "regx_days_delinquent is required (the (k)(5) restriction applies to borrowers > 30 days overdue)");
  const receivedOn = dateOf(i.received_on, "received_on");
  const o = cancellationOverlay(i.notice === "property.vacancy_confirmed" ? "vacancy" : i.reason, receivedOn);
  const h = hazardDecision(i.regx_days_delinquent, i.notice === "property.vacancy_confirmed" ? null : i.reason, i.notice === "property.vacancy_confirmed");
  const event = store.append({ type: "escrow.hazard.inability_evaluated", loanId: i.loan_id, actor: i.actor, payload: { notice: i.notice, reason: i.reason, reason_code: o.reason_code, inability_to_disburse: o.inability_to_disburse, lpi_gate_open: o.lpi_gate_open, recorded_on: o.recorded_on, regx_days_delinquent: i.regx_days_delinquent, pay_or_advance: h.pay, basis: "12 CFR 1024.17(k)(5)(ii)(A); Supplement I 17(k)(5)(ii)(A)-1" } });
  return { event, ...o, pay_or_advance: h.pay };
}
