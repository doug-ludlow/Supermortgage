/**
 * 32.8 — Servicing: loan home, payments, autopay, statements, escrow (spec/sections/32-borrower-experience/32-8-*.md):
 * the borrower-facing form of 2.1–2.7 (cashiering), 7.1 (periodic statements), 7.4 (E-SIGN), 7.1-A (Form 1098) and
 * 3.1–3.8 (escrow). Every card is created through 32.1's `send_card` on the owning process's event, as the
 * `borrower-comms` agent's thread (created_by `agent:borrower-comms`); nothing here computes a regulatory date or a
 * money figure — dates come from the engines' events and `timers`, figures from the owning process's rows.
 *
 *   installment.due_date_reached{grace_end_on}       PaymentCard `payment.due` (date options through the engine's grace end; fresh L1 on resolve — T1, T2)
 *   payment.received (portal)                        StatusCard `payment.received`
 *   payment.posted{interest, principal, escrow}      StatusCard `payment.posted` (the collapsed receipt with the C-1.1-01 allocation)
 *   suspense.item.created{partial_payment}           StatusCard `payment.held` (held, the remainder, the 30-day rule) — T3
 *   case.opened{case_id=REFUND-<item>}               2.2 `suspense.read/write{op=refund}` as cashiering → `suspense.item.closed{refunded}`; StatusCard `payment.refunded` — T3
 *   autodraft.enrollment.requested                   ConsentCard{autodraft_authorization} with every 2.x rule-1 element and the optional statement — T5
 *   consent.granted{kind=autopay}                    2.3 `autodraft.read/write{op=authorize}` (never from voice) → `{op=validate}`; StatusCard `autopay.active` — T5
 *   notice.sent{AUTODRAFT-CONFIRM-v1}                NoticeCard `autopay.confirm`
 *   notice.sent{AUTODRAFT-RETURN-v1}                 NoticeCard `payment.returned` (the retry date from `ach.entry.reinitiation_scheduled`) — T4
 *   autodraft.status.changed{suspended_returns}      ChoiceCard `autopay.suspended.choice` (re-activate | pay another way) + PaymentCard with a new account — T4
 *   notice.sent{kind=variable_amount_10d}            NoticeCard `autopay.amount_change` — T6
 *   fee.assessed{late_charge}                        StatusCard `late_charge.assessed` — T1
 *   escrow.statement.sent{annual|shortage_notice}    NoticeCard `escrow.statement`; a shortage → ChoiceCard `escrow.shortage.choice` (spread 12 | pay now) — T8
 *   escrow.analysis.approved{credit}                 StatusCard `escrow.surplus_credit` (< $50 credited to payments) — T9
 *   disbursement.issued{surplus_refund}              StatusCard `escrow.surplus`; notice.sent{NTC_SM_ESCROW_SURPLUS_REFUND} → NoticeCard — T9
 *   escrow.repayment_plan.created                    StatusCard `escrow.plan.created`; the co-borrower's shortage card withdrawn — T8
 *   escrow.waiver.decided{denied}                    StatusCard `escrow.waiver.denied`
 *   statement.sent{channel}                          DocumentCard `statement.available` (electronic) | StatusCard `statement.mailed` (paper) — T7
 *   consent.esign.suspect                            ConsentCard `consent.esign.reverify` (7.4 rule 8) — T7
 *   tax_form.1098.furnished{channel}                 NoticeCard `year_end.1098` (paper → Mailed) — T11
 *   tick                                             src/runtime/servicing.ts servicingDailySweep; the December `irs_estatement` ConsentCard — T11
 *   onMessage                                        "make a payment" → PaymentCard; "refund" → ChoiceCard; "waive my escrow" → ChoiceCard `escrow.waiver.choice` (T10);
 *                                                    an extra-principal ask ("pay 500 extra toward principal") is left to the agent turn (32.16 `card.request{extra_principal}`)
 *
 * 32.16 Stage 4 (docs/ux/17 §4 "card.request for payments and changes"): the card builders are exported — `paymentFacts` loads the same
 * loan facts `context()` reads, and `paymentCard` / `extraPrincipalCard` / `autopayEnrollCard` / `autopayChoiceCard` / `escrowShortageCard`
 * are the specs this flow sends — so the 32.16 `card.request` catalogue (src/app/tools/section32-16.ts) raises the same card the flow
 * raises, from inside the turn's unit of work. Nothing the flow commits changes.
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../../kernel/calendar/date.ts";
import { EntityStore } from "../../../app/tools.ts";
import { servicingDailySweep, servicingParties, recipientsOf, loanCashState, type ServicingParty } from "../../servicing.ts";
import { timerLabel } from "../record.ts";
import type { BorrowerFlow, FlowDeps, FlowReply, InboundMessage } from "./index.ts";

export const FLOW_ID = "32.8";
const INTAKE: Actor = { kind: "agent", id: "intake" };            // 32.1's tools are registered on `intake` (with borrower-comms): the card is created as the borrower-comms thread
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const COMMS = "agent:borrower-comms";
const RUN = { runId: "flow:32.8", modelVersion: "borrower flows (deterministic)", promptVersion: "32.8" } as const;
export const SERVICING_ESIGN_SCOPES = ["periodic_statements", "escrow_statements", "regx_correspondence", "arm_notices", "privacy_notices", "lossmit_notices", "early_intervention_notices", "insurance_notices", "pmi_notices", "payoff_statements", "general_correspondence"] as const;
export const AUTODRAFT_DISCLOSURE_VERSION = "AUTODRAFT-CONFIRM-v1";
export const IRS_ESTATEMENT_DISCLOSURE = "NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE";
const REACTS = new Set(["installment.due_date_reached", "payment.received", "payment.posted", "suspense.item.created", "case.opened", "autodraft.enrollment.requested", "consent.granted", "notice.sent", "autodraft.status.changed", "fee.assessed",
  "escrow.statement.sent", "escrow.analysis.approved", "disbursement.issued", "escrow.repayment_plan.created", "escrow.waiver.decided", "statement.sent", "consent.esign.suspect", "tax_form.1098.furnished"]);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: unknown): string => { try { return USD.format(Number(BigInt(String(cents ?? "0"))) / 100); } catch { return ""; } };
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const monthOf = (d: string): string => MONTH.format(new Date(`${d.slice(0, 10)}T12:00:00Z`));

// ---------------------------------------------------------------- the loan context one batch works on
type P = Record<string, unknown>;
/** The loan's own terms the payment cards state (the latest `loan_terms` version beside the `loans` row): never a figure the flow computed. */
export interface PaymentTerms { readonly pi_cents: bigint; readonly escrow_cents: bigint; readonly grace_days: number; readonly late_charge_pct_bps: number | null; readonly loan_last4: string; readonly first_payment_date: string; readonly note_rate_pct: string }
/** What the card builders read: the loan's committed log, its entity rows, the clock and its terms — the flow's `context()` and the 32.16 turn's unit of work both supply one. */
export interface PaymentFacts { readonly loanId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly now: string; readonly terms: PaymentTerms }
interface Ctx extends PaymentFacts { readonly appId: string | null; readonly parties: readonly ServicingParty[] }
const pl = (e: DomainEvent): P => e.payload as P;
const has = (ctx: PaymentFacts, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: PaymentFacts, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** The `loans` + latest `loan_terms` row the cards state their figures from (the same query for the flow and for 32.16 `card.request`). */
export async function loadPaymentTerms(db: Queryable, loanId: string): Promise<{ terms: PaymentTerms; appId: string | null }> {
  const row = (await db.query<P>(`SELECT l.origination_application_id, l.servicer_loan_number, l.first_payment_date::text AS first_payment_date, lt.pi_cents::text AS pi_cents, lt.escrow_payment_cents::text AS escrow_payment_cents, lt.late_charge_grace_days, lt.late_charge_pct_bps, lt.note_rate_bps FROM loans l LEFT JOIN LATERAL (SELECT * FROM loan_terms t WHERE t.loan_id = l.id ORDER BY t.effective_from DESC, t.created_at DESC LIMIT 1) lt ON true WHERE l.id = $1`, [loanId]))[0] ?? null;
  const terms: PaymentTerms = { pi_cents: BigInt(String(row?.["pi_cents"] ?? "0")), escrow_cents: BigInt(String(row?.["escrow_payment_cents"] ?? "0")), grace_days: Number(row?.["late_charge_grace_days"] ?? 15), late_charge_pct_bps: row?.["late_charge_pct_bps"] === null || row?.["late_charge_pct_bps"] === undefined ? null : Number(row["late_charge_pct_bps"]), loan_last4: str(row?.["servicer_loan_number"]).slice(-4), first_payment_date: str(row?.["first_payment_date"]), note_rate_pct: (Number(row?.["note_rate_bps"] ?? 0) / 10_000).toFixed(3) };
  return { terms, appId: (row?.["origination_application_id"] as string | null) ?? null };
}
/** The facts from an already-open unit of work (32.16 `card.request`: the turn's seeded event store and entity store, the command's clock). */
export async function paymentFacts(db: Queryable, loanId: string, o: { events: readonly DomainEvent[]; store: EntityStore; now: string }): Promise<PaymentFacts> {
  const { terms } = await loadPaymentTerms(db, loanId);
  return { loanId, events: o.events, store: o.store, now: o.now, terms };
}
async function context(deps: FlowDeps, loanId: string): Promise<Ctx> {
  const [events, records, parties, loaded] = await Promise.all([deps.runtime.uow.events.byLoan(loanId), deps.runtime.entities.load({ loanId }), servicingParties(deps.runtime, loanId), loadPaymentTerms(deps.runtime.db, loanId)]);
  const store = new EntityStore(); store.seed(records);
  return { loanId, appId: loaded.appId, parties, events, store, now: deps.runtime.clock.now(), terms: loaded.terms };
}
const partyOf = (ctx: Ctx, partyId: unknown): readonly ServicingParty[] => { const p = ctx.parties.find((x) => x.party_id === partyId); return p ? [p] : ctx.parties; };

// ---------------------------------------------------------------- card primitives (32.1's tools; idempotent on `flow_key`)
export interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string; readonly flow_key: string; readonly informational?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, ctx: Ctx, party: ServicingParty, c: CardSpec): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: ctx.loanId, ...(ctx.appId ? { applicationId: ctx.appId } : {}), actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { application_id: ctx.appId, loan_id: ctx.loanId }, created_by: COMMS, rationale: `32.8 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", ctx.now, { informational: true, resolved_by: "system:flow-32.8" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly ServicingParty[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx, p, c)); return ids; }
async function transitionAll(deps: FlowDeps, ctx: Ctx, flowKeyPrefix: string, to: "resolved" | "superseded" | "cancelled", evidence: P, except: string | null = null): Promise<number> {
  const rows = (await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_loan_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE $2`, [ctx.loanId, `${flowKeyPrefix}%`])).filter((r) => r.card_instance_id !== except);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, to, "system", ctx.now, { ...evidence, resolved_by: "system:flow-32.8" });
  return rows.length;
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true });
const NoticeCard = (copy_key: string, flow_key: string, notice_code: string, e: DomainEvent, props: P = {}): CardSpec => {
  const p = pl(e); const channels = (p["channels"] as { channel?: string }[] | undefined) ?? []; const channel = str(p["channel"] ?? channels[0]?.channel); const mailed = channel.startsWith("mail") || channel === "paper";
  return { kind: "NoticeCard", copy_key, flow_key, informational: true, props: { notice_code, title: "", rendered_document_id: str(p["notice_id"] ?? p["rendered_document_id"]) || randomUUID(), plain_language: "", line: "", template_version: p["template_version"] ?? null, delivered_at: e.occurredAt, channel: mailed ? "mail" : "app", mailed_at: mailed ? (p["mailed_at"] ?? e.occurredAt) : null, ...props } };
};
async function timerDue(deps: FlowDeps, loanId: string, code: string): Promise<string | null> {
  const t = (await deps.runtime.db.query<{ due_at: string | null }>(`SELECT due_at FROM timers WHERE loan_id = $1 AND code = $2 AND status IN ('armed', 'breached', 'satisfied', 'satisfied_late') ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
  return t?.due_at ?? null;
}
const dateRange = (from: PlainDate, to: PlainDate): string[] => { const out: string[] = []; for (let d = from, k = 0; d <= to && k < 62; d = addDays(d, 1), k++) out.push(d); return out.length ? out : [from]; };

// ---------------------------------------------------------------- payments (2.1 / 2.2 / 2.7)
/** The next installment the loan's rows say is due: the engine's own `installment.due_date_reached` when inside its grace, else the schedule's next date (a calendar restatement of the note). */
export function nextInstallment(ctx: PaymentFacts): { due: PlainDate; grace_end: PlainDate | null; reached: boolean } {
  const reversed = new Set(ctx.events.filter((e) => e.type === "payment.reversed").map((e) => str(pl(e)["payment_id"])));   // 2.3 rule 7: a returned debit no longer covers its installment
  const reached = last(ctx, "installment.due_date_reached"); const posted = ctx.events.filter((e) => e.type === "payment.posted" && !reversed.has(str(pl(e)["payment_id"])) && Array.isArray(pl(e)["installments"])).flatMap((e) => pl(e)["installments"] as string[]);
  if (reached && !posted.includes(str(pl(reached)["installment_due_date"]))) return { due: D(str(pl(reached)["installment_due_date"])), grace_end: str(pl(reached)["grace_end_on"]) ? D(str(pl(reached)["grace_end_on"])) : null, reached: true };
  const lastPosted = posted.slice().sort().at(-1);
  return { due: lastPosted ? addMonths(D(lastPosted), 1) : D(ctx.terms.first_payment_date || ctx.now.slice(0, 10)), grace_end: null, reached: false };
}
export function savedAccounts(ctx: PaymentFacts): P[] {
  return ctx.store.list("autodraft_enrollments", (d) => d.loan_id === ctx.loanId && typeof d.account_last4 === "string" && d.account_last4 !== "").map((r) => ({ id: r.id, last4: String(r.data.account_last4), label: `${String(r.data.account_type ?? "checking")} (autopay)` }));
}
export function paymentCard(ctx: PaymentFacts, flowKey: string, opts: { late_charge_cents?: bigint; add_account?: boolean; title_key?: string } = {}): CardSpec {
  const n = nextInstallment(ctx); const today = D(ctx.now.slice(0, 10)); const amount = ctx.terms.pi_cents + ctx.terms.escrow_cents;
  // 32.8 §3.1: date options = today through the engine's grace end (never a date the engine did not state); before the due date is reached, through the due date
  const through = n.grace_end && n.grace_end >= today ? n.grace_end : n.due >= today ? n.due : today;
  const lc = opts.late_charge_cents ?? 0n;
  return { kind: "PaymentCard", copy_key: opts.title_key ?? "payment.due", flow_key: flowKey, command_ref: "payment.makeOneTime",
    props: { mode: "one_time", amount_default_cents: amount.toString(), amount_editable: true, date_options: dateRange(today, through), accounts: savedAccounts(ctx), add_account: opts.add_account ?? true, ...(lc > 0n ? { include_late_charge_option: { late_charge_cents: lc.toString() } } : {}), title: "", installment_due_date: n.due, grace_end_on: n.grace_end, copy_tokens: { money: money(amount), date: n.due }, fresh_l1_required: true, command_args: { date: today, amount_cents: amount.toString(), designation: "contractual" } } };
}
/**
 * 32.8 §3.2 / 32.16 §4: the extra-principal PaymentCard a borrower asks for in words — amount only (`payment.extraPrincipal`, a curtailment
 * 2.4 applies the same day on a current loan and redirects to the cure when an installment is past due: the card says which before the tap).
 * `amount_cents` is the figure the borrower named (the model transcribed it into the ask); it is the editable default, never the commit —
 * the tap's evidence carries the amount, with a fresh code (32.1 §5).
 */
export function extraPrincipalCard(ctx: PaymentFacts, flowKey: string, opts: { amount_cents?: string | null } = {}): CardSpec {
  const n = nextInstallment(ctx); const today = D(ctx.now.slice(0, 10));
  const pastDue = n.reached && (n.grace_end ? n.grace_end < today : n.due < today);
  const amount = opts.amount_cents && /^\d+$/.test(opts.amount_cents) && BigInt(opts.amount_cents) > 0n ? opts.amount_cents : null;
  return { kind: "PaymentCard", copy_key: "payment.extra_principal", flow_key: flowKey, command_ref: "payment.extraPrincipal",
    props: { mode: "extra_principal", amount_default_cents: amount, amount_source: amount ? "borrower_stated_unconfirmed" : null, amount_editable: true, date_options: [today], accounts: savedAccounts(ctx), add_account: true, title: "", installment_due_date: n.due, applies: pastDue ? "redirected_to_cure" : "same_day_principal", fresh_l1_required: true, copy_tokens: { ...(amount ? { money: money(amount) } : {}), date: n.due }, command_args: { date: today, designation: "curtailment" } } };
}
/** The Reg E / Nacha elements shown before an enrollment (2.x rule 1), for the enrollment ConsentCard a borrower asks for in words (32.16 `card.request{autopay_enroll}`): `autodraft.enroll` runs on the tap (fresh code; the tap's args carry the account), then this flow's authorization ConsentCard follows `autodraft.enrollment.requested`. */
export function autopayEnrollCard(ctx: PaymentFacts, party: Pick<ServicingParty, "party_id" | "legal_name">, flowKey: string, o: { draft_day: number }): CardSpec {
  const draftDay = Math.min(Math.max(Math.trunc(o.draft_day || 1), 1), 16);
  const a = autodraftAuthorization(ctx, party, { draft_day: draftDay, amount_rule: "contractual" });
  return { kind: "ConsentCard", copy_key: "autopay.enroll", flow_key: flowKey, command_ref: "autodraft.enroll",
    props: { consent_kind: "autodraft", disclosure_version_id: AUTODRAFT_DISCLOSURE_VERSION, scope: ["autopay"], affirmation_method: "checkbox_with_text", title: "", body_text: a.body_text, helper_text: "", footer_text: "", requires_typed_name: true, verification_state: "none", optional_statement_copy_key: "consent.autodraft.optional", optional: true, prechecked: false, elements: a.elements, draft_day: draftDay, amount_rule: "contractual", amount_cents: (ctx.terms.pi_cents + ctx.terms.escrow_cents).toString(), first_debit_on: a.authorization["first_debit_on"] ?? null, add_account: true, accounts: savedAccounts(ctx), fresh_l1_required: true, copy_tokens: { money: money(ctx.terms.pi_cents + ctx.terms.escrow_cents), n: String(draftDay) },
      command_args: { amount_rule: "contractual", draft_day: draftDay, include_fees: false, elements_displayed: true } } };
}
/** An autopay change / pause / revocation a borrower asks for in words: the ChoiceCard whose tap runs the 32.2 command on the enrollment row (fresh code); the assistant never argues against a revocation (32.8 §4). */
export function autopayChoiceCard(verb: "change" | "pause" | "revoke", rec: { id: string; data: P }, flowKey: string, o: { draft_day?: number | null } = {}): CardSpec {
  const a = (rec.data["authorization"] as P | undefined) ?? {}; const last4 = str(a["account_last4"] ?? rec.data["account_last4"]);
  const account = { last4, type: str(a["account_type"] ?? rec.data["account_type"]) || "checking", routing: str(a["routing"] ?? rec.data["routing"]) };
  const day = verb === "change" ? Math.min(Math.max(Math.trunc(o.draft_day ?? Number(rec.data["draft_day"] ?? 1)), 1), 16) : Number(rec.data["draft_day"] ?? 1);
  const ordinal = (n: number): string => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
  const primary = verb === "change" ? { id: "change", label: `Draft on the ${ordinal(day)} from now on`, is_primary: true } : verb === "pause" ? { id: "pause", label: "Pause autopay", is_primary: true } : { id: "revoke", label: "Turn autopay off", is_primary: true };
  const args = verb === "change" ? { enrollment_id: rec.id, amount_rule: str(rec.data["amount_rule"]) || "contractual", draft_day: day, include_fees: rec.data["include_fees"] === true, account, elements_displayed: true } : { enrollment_id: rec.id };
  return { kind: "ChoiceCard", copy_key: `autopay.${verb}.choice`, flow_key: flowKey, command_ref: `autodraft.${verb}`,
    props: { title: "", options: [primary, { id: "keep", label: "Keep it as it is" }], command: `autodraft.${verb}`, command_args_by_option: { [primary.id]: args, keep: {} }, no_command_options: ["keep"], enrollment_id: rec.id, draft_day: day, copy_tokens: { last4, n: String(day) }, fresh_l1_required: true, affirmatives: verb === "change" ? ["change it", "move it"] : verb === "pause" ? ["pause it", "pause autopay"] : ["turn it off", "cancel autopay", "stop autopay"] } };
}
async function onInstallmentDue(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const due = str(p["installment_due_date"] ?? p["due_date"]);
  if (has(ctx, "payment.posted", (x) => Array.isArray(x["installments"]) && (x["installments"] as unknown[]).includes(due))) return;   // the 00:30 run posted the receipt before the due-date fact: nothing to ask
  await sendToAll(deps, ctx, paymentCard(ctx, `pay:${due}`));
}
async function onPaymentReceived(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (str(p["channel"]) !== "portal") return;
  await sendToAll(deps, ctx, StatusCard("payment.received", `payment.received:${str(p["payment_id"])}`, { copy_tokens: { money: money(p["amount_cents"]), date: str(p["received_on"]) }, payment_id: p["payment_id"] }));
}
async function onPaymentPosted(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const id = str(p["payment_id"]);
  await transitionAll(deps, ctx, "pay:", "resolved", { payment_id: id, manner: "payment_posted" });
  await sendToAll(deps, ctx, StatusCard("payment.posted", `payment.posted:${id}`, { copy_tokens: { money: money(p["amount_cents"]), date: str(p["credited_as_of"] ?? p["received_on"]), interest: money(p["interest_cents"]), principal: money(p["principal_cents"]), escrow: money(p["escrow_cents"]) }, payment_id: id, installments: p["installments"] ?? [], allocation_order: "C-1.1-01" }));
}
async function onPartialHeld(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["partial_payment"] !== true && str(p["reason_code"]) !== "partial_payment") return;
  const itemId = str(p["suspense_item_id"]); const item = ctx.store.get("suspense_items", itemId)?.data ?? {};
  const remaining = str(item["balance_needed_cents"]) || (ctx.terms.pi_cents + ctx.terms.escrow_cents - BigInt(str(p["amount_cents"]) || "0")).toString();
  await sendToAll(deps, ctx, StatusCard("payment.held", `payment.held:${itemId}`, { copy_tokens: { money: [money(p["amount_cents"]), money(remaining)] }, suspense_item_id: itemId, payment_id: p["payment_id"] ?? null, held_cents: str(p["amount_cents"]), remaining_cents: remaining, return_after: p["partial_commitment_due_on"] ?? null, next_event_label: timerLabel("FNMA_C1102_PARTIAL_BALANCE_30") || "Held until", next_event_at: await timerDue(deps, ctx.loanId, "FNMA_C1102_PARTIAL_BALANCE_30"), rule: "C-1.1-02 (30 days)" }));
}
const openPartial = (ctx: Ctx): { id: string; data: P } | undefined => ctx.store.list("suspense_items", (d) => d.loan_id === ctx.loanId && d.status === "open" && (d.reason_code === "partial_payment" || d.reason_code === undefined)).map((r) => ({ id: r.id, data: r.data })).at(-1);
function refundChoiceCard(ctx: Ctx, item: { id: string; data: P }): CardSpec {
  return { kind: "ChoiceCard", copy_key: "payment.refund.choice", flow_key: `refund:${item.id}`, command_ref: "case.open",
    props: { title: "", options: [{ id: "refund", label: `Return my ${money(item.data["amount_cents"])}`, is_primary: true }, { id: "keep", label: "Keep holding it" }], command: "case.open", command_args_by_option: { refund: { kind: "general_inquiry", case_id: `REFUND-${item.id}`, text: `Please return the held partial payment of ${money(item.data["amount_cents"])}.` }, keep: {} }, no_command_options: ["keep"], copy_tokens: { money: money(item.data["amount_cents"]) }, suspense_item_id: item.id, affirmatives: ["refund", "return my money", "send it back"] } };
}
async function onCaseOpened(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const caseId = str(p["case_id"]); if (!caseId.startsWith("REFUND-")) return;
  const itemId = caseId.slice("REFUND-".length); const item = ctx.store.get("suspense_items", itemId)?.data; if (!item || item["status"] !== "open") return;
  // 2.2 rule 6 / 32.8 §3.3: the borrower can always ask for the funds back — the cashiering agent returns the held partial (its own tool, its own guardrails)
  const r = await deps.runtime.execute({ process: "2.2", name: "suspense.read/write", loanId: ctx.loanId, actor: CASHIERING, run: { ...RUN }, input: { op: "refund", id: itemId, loan_id: ctx.loanId, refunded_on: ctx.now.slice(0, 10), requested_by: "borrower", case_id: caseId, data: { action: "return", payee_is_borrower: true, lossmit_case_active: false, amount_cents: str(item["amount_cents"]), suspense_item_id: itemId } } });
  const o = r.output as { amount_cents: string; refunded_on: string };
  await transitionAll(deps, ctx, `refund:${itemId}`, "resolved", { case_id: caseId, manner: "refund_issued" });
  await sendToAll(deps, ctx, StatusCard("payment.refunded", `payment.refunded:${itemId}`, { copy_tokens: { money: money(o.amount_cents), date: o.refunded_on }, suspense_item_id: itemId, case_id: caseId }));
}
async function onLateCharge(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["late_charge"] !== true && str(p["fee_type"]) !== "late_charge") return;
  await sendToAll(deps, ctx, StatusCard("late_charge.assessed", `late_charge:${str(p["fee_id"])}`, { copy_tokens: { money: money(p["amount_cents"]), date: str(p["assessed_on"] ?? e.occurredAt.slice(0, 10)) }, fee_id: p["fee_id"], installment_due_date: p["installment_due_date"] ?? null, late_charge_state: p["state"] ?? "assessed", grace_end_on: p["grace_end_on"] ?? null }));
  // the pending PaymentCard for the installment now carries the late-charge option (a newer card for the same ask)
  const due = str(p["installment_due_date"]); if (!due) return;
  await transitionAll(deps, ctx, `pay:${due}`, "superseded", { reason: "late charge assessed", fee_id: p["fee_id"] });
  await sendToAll(deps, ctx, paymentCard(ctx, `pay:${due}:lc`, { late_charge_cents: BigInt(str(p["amount_cents"]) || "0") }));
}

// ---------------------------------------------------------------- autopay (2.3)
/** 2.x rule 1: every Nacha / Reg E element the ConsentCard must show (32.7's element copy keys), and the Authorization record 2.3's checklist verifies. */
export function autodraftAuthorization(ctx: PaymentFacts, party: Pick<ServicingParty, "party_id" | "legal_name">, e: P): { authorization: P; elements: P[]; body_text: string } {
  const amount = ctx.terms.pi_cents + ctx.terms.escrow_cents + BigInt(str(e["extra_principal_cents"]) || "0");
  const draftDay = Number(e["draft_day"] ?? 1); const n = nextInstallment(ctx); const today = ctx.now.slice(0, 10);
  const firstMonth = `${n.due.slice(0, 8)}${String(Math.min(draftDay, 28)).padStart(2, "0")}`; const firstDebit = firstMonth > today ? firstMonth : `${addMonths(n.due, 1).slice(0, 8)}${String(Math.min(draftDay, 28)).padStart(2, "0")}`;
  const authorization: P = { borrower_name: party.legal_name, loan_number_masked: `****${ctx.terms.loan_last4}`, routing: str(e["routing"]), account_last4: str(e["account_last4"]), account_type: str(e["account_type"]) || "checking", amount_rule: str(e["amount_rule"]) === "fixed" ? "fixed" : "full_periodic_payment", variable_amount_statement: true, frequency: "monthly", first_debit_on: firstDebit, authorized_on: today, company_name: "SUPERMORTGAGE", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" };
  const elements: P[] = [
    { id: "borrower", label_key: "consent.autodraft.element.borrower", value: party.legal_name },
    { id: "loan", label_key: "consent.autodraft.element.loan", value: `····${ctx.terms.loan_last4}` },
    { id: "account", label_key: "consent.autodraft.element.account", value: `routing ${str(e["routing"])} · account ····${str(e["account_last4"])} · ${str(e["account_type"]) || "checking"}` },
    { id: "amount", label_key: "consent.autodraft.element.amount", value: `${money(amount)} (your full monthly payment)` },
    { id: "amount_variable", label_key: "consent.autodraft.element.amount.variable", value: "" },
    { id: "timing", label_key: "consent.autodraft.element.timing", value: `monthly on the ${draftDay}${draftDay === 1 ? "st" : draftDay === 2 ? "nd" : draftDay === 3 ? "rd" : "th"}` },
    { id: "first_debit", label_key: "consent.autodraft.element.first_debit", value: firstDebit },
    { id: "company", label_key: "consent.autodraft.element.company", value: "SUPERMORTGAGE" },
    { id: "revoke", label_key: "consent.autodraft.element.revoke", value: "" },
    { id: "date", label_key: "consent.autodraft.element.date", value: today },
    { id: "esign", label_key: "consent.autodraft.element.esign", value: "" },
    { id: "optional", label_key: "consent.autodraft.optional", value: "" },
  ];
  const body_text = elements.map((x) => `${String(x["label_key"]).replace(/^consent\.autodraft\.(element\.)?/, "")}: ${str(x["value"])}`.replace(/: $/, "")).join("\n");
  return { authorization, elements, body_text };
}
async function onEnrollmentRequested(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const id = str(p["enrollment_id"]); const rec = ctx.store.get("autodraft_enrollments", id)?.data ?? {};
  const party = ctx.parties.find((x) => x.party_id === str(p["party_id"] ?? rec["party_id"])) ?? ctx.parties[0]; if (!party) return;
  const a = autodraftAuthorization(ctx, party, rec);
  await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.autodraft.title", flow_key: `autodraft.authorize:${id}`, command_ref: "consent.capture",
    props: { consent_kind: "autodraft_authorization", disclosure_version_id: AUTODRAFT_DISCLOSURE_VERSION, scope: ["autopay"], affirmation_method: "checkbox_with_text", title: "", body_text: a.body_text, helper_text: "", footer_text: "", requires_typed_name: true, verification_state: "none", optional_statement_copy_key: "consent.autodraft.optional", optional: true, prechecked: false, elements: a.elements, authorization: a.authorization, enrollment_id: id, copy_delivery_timer: "SM_AUTODRAFT_COPY_DELIVERY_1BD",
      command_args: { kind: "autodraft_authorization", method: "checkbox_with_text", scope: ["autopay"], disclosure_version_id: AUTODRAFT_DISCLOSURE_VERSION, purpose: "informational", enrollment_id: id } } });
}
async function onConsentGranted(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (str(p["kind"]) !== "autopay" && str(p["ux_kind"]) !== "autodraft_authorization") return;
  const cardId = str(p["card_instance_id"]); const card = cardId ? await deps.ui.card(cardId) : undefined; if (!card) return;
  const enrollmentId = str((card.props["command_args"] as P | undefined)?.["enrollment_id"] ?? card.props["enrollment_id"]); if (!enrollmentId) return;
  const rec = ctx.store.get("autodraft_enrollments", enrollmentId)?.data; if (!rec || rec["status"] !== "requested") return;
  const party = ctx.parties.find((x) => x.party_id === card.party_id) ?? ctx.parties[0]; if (!party) return;
  const evidence = (card.evidence as P | null) ?? {}; const channel = str(evidence["channel"]) || "app";
  // 2.3 rule 1 → `authorized` (the tool refuses a voice channel and any missing element) → validated (the FAKE instant account-validation API) → `active`
  const authorization = { ...((card.props["authorization"] as P | undefined) ?? {}), authorized_on: ctx.now.slice(0, 10), esign_consent: true };
  const r = await deps.runtime.execute({ process: "2.3", name: "autodraft.read/write", loanId: ctx.loanId, actor: CASHIERING, run: { ...RUN }, input: { op: "authorize", id: enrollmentId, loan_id: ctx.loanId, channel, authorization, authorized_on: ctx.now.slice(0, 10), card_instance_id: cardId, periodic_payment_cents: (ctx.terms.pi_cents + ctx.terms.escrow_cents).toString(), recipients: recipientsOf([party]) } });
  const out = r.output as P;
  await deps.runtime.execute({ process: "2.3", name: "autodraft.read/write", loanId: ctx.loanId, actor: CASHIERING, run: { ...RUN }, input: { op: "validate", id: enrollmentId, loan_id: ctx.loanId, status: "validated_api", next_draft_on: str((authorization as P)["first_debit_on"]) } });
  await sendCard(deps, ctx, party, StatusCard("autopay.active", `autopay.active:${enrollmentId}`, { copy_tokens: { money: money(ctx.terms.pi_cents + ctx.terms.escrow_cents), date: str((authorization as P)["first_debit_on"]), last4: str((authorization as P)["account_last4"]) }, enrollment_id: enrollmentId, copy_due_by: out["copy_due_by"] ?? null, next_event_label: timerLabel("SM_AUTODRAFT_COPY_DELIVERY_1BD") || "Copy of your authorization by", next_event_at: await timerDue(deps, ctx.loanId, "SM_AUTODRAFT_COPY_DELIVERY_1BD") }));
}
async function onAutodraftSuspended(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (str(p["status"]) !== "suspended_returns") return;
  const id = str(p["enrollment_id"]); const rec = ctx.store.get("autodraft_enrollments", id)?.data ?? {}; const a = (rec["authorization"] as P | undefined) ?? {};
  await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "autopay.suspended.choice", flow_key: `autopay.suspended:${id}`, command_ref: "autodraft.change",
    props: { title: "", options: [{ id: "reactivate", label: `Use account ····${str(a["account_last4"] ?? rec["account_last4"])} again`, is_primary: true }, { id: "pay_another_way", label: "Pay another way" }], command: "autodraft.change", command_args_by_option: { reactivate: { enrollment_id: id, amount_rule: str(rec["amount_rule"]) || "contractual", draft_day: Number(rec["draft_day"] ?? 1), include_fees: rec["include_fees"] === true, account: { last4: str(a["account_last4"] ?? rec["account_last4"]), type: str(a["account_type"] ?? rec["account_type"]) || "checking", routing: str(a["routing"] ?? rec["routing"]) }, elements_displayed: true }, pay_another_way: {} }, no_command_options: ["pay_another_way"], enrollment_id: id, return_code: p["return_code"] ?? null, copy_tokens: { last4: str(a["account_last4"] ?? rec["account_last4"]) }, affirmatives: ["reactivate", "use it again", "turn autopay back on"] } });
  await sendToAll(deps, ctx, paymentCard(ctx, `pay:another_way:${id}`, { add_account: true, title_key: "payment.another_way" }));
}
async function onNoticeSent(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const template = str(p["template"]); const noticeId = str(p["notice_id"]);
  switch (template) {
    case "AUTODRAFT-CONFIRM-v1": {
      if (!noticeId) return;   // the ops satisfier (`enrollment_confirmation`) rides beside the registry's send of the same piece
      await sendToAll(deps, ctx, NoticeCard("autopay.confirm", `autopay.confirm:${noticeId}`, template, e, { enrollment_id: str(last(ctx, "autodraft.enrollment.authorized")?.payload["enrollment_id"]) || null })); return;
    }
    case "AUTODRAFT-RETURN-v1": {
      if (!noticeId) return;
      const ret = last(ctx, "ach.return.received"); const retry = last(ctx, "ach.entry.reinitiation_scheduled", (x) => x["enrollment_id"] === ret?.payload["enrollment_id"]);
      const retryOn = retry && ret && Number(retry.sequence) >= Number(ret.sequence) ? str(pl(retry)["retry_on"]) : "";
      const settled = str(ret?.payload["original_settlement_date"] ?? ret?.payload["returned_on"]);
      await sendToAll(deps, ctx, NoticeCard(retryOn ? "payment.returned" : "payment.returned.final", `payment.returned:${noticeId}`, template, e, { copy_tokens: { date: retryOn ? [settled, retryOn] : settled }, return_code: ret?.payload["reason_code"] ?? null, retry_on: retryOn || null, settlement_date: settled, enrollment_id: ret?.payload["enrollment_id"] ?? null, next_event_label: retryOn ? "We'll try again on" : undefined, next_event_at: retryOn ? `${retryOn}T12:00:00.000Z` : null })); return;
    }
    case "AUTODRAFT-AMOUNT-CHANGE-v1": {
      if (str(p["kind"]) !== "variable_amount_10d") return;   // the ops fact carries the amount and the debit date; the registry's send of the same piece rides beside it
      await sendToAll(deps, ctx, NoticeCard("autopay.amount_change", `autopay.amount_change:${str(p["enrollment_id"])}:${str(p["debit_on"])}`, template, e, { copy_tokens: { money: money(p["amount_cents"]), date: str(p["debit_on"]) }, amount_cents: str(p["amount_cents"]), debit_on: p["debit_on"] ?? null, sent_on: p["sent_on"] ?? null, deadline: p["deadline"] ?? null, on_time: p["on_time"] ?? null, timer: "REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10" })); return;
    }
    case "NTC_SM_ESCROW_SURPLUS_REFUND": {
      if (!noticeId) return;
      const issued = last(ctx, "disbursement.issued", (x) => x["kind"] === "surplus_refund");
      await sendToAll(deps, ctx, NoticeCard("escrow.surplus.notice", `escrow.surplus.notice:${noticeId}`, template, e, { copy_tokens: { money: money(issued?.payload["amount_cents"]) }, amount_cents: str(issued?.payload["amount_cents"]) || null })); return;
    }
    default: return;
  }
}

// ---------------------------------------------------------------- escrow (3.x)
const approvedAnalysis = (ctx: Ctx, analysisId?: string): { id: string; data: P } | undefined => { const id = analysisId || str(last(ctx, "escrow.analysis.approved")?.payload["analysis_id"]); const rec = id ? ctx.store.get("escrow_analyses", id) : undefined; return rec ? { id, data: rec.data } : undefined; };
const bi = (v: unknown): bigint => { try { return BigInt(String(v ?? "0")); } catch { return 0n; } };
async function onEscrowStatementSent(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const type = str(p["statement_type"]); if (type !== "annual" && type !== "shortage_notice" && type !== "short_year_reset") return;
  const template = str(p["template"]); const key = `${template}:${str(p["sent_on"])}`;
  const sent = last(ctx, "notice.sent", (x) => x["template"] === template);
  await sendToAll(deps, ctx, { kind: "NoticeCard", copy_key: "escrow.statement", flow_key: `escrow.statement:${key}`, informational: true, props: { notice_code: template, title: "", rendered_document_id: str(sent?.payload["notice_id"]) || randomUUID(), plain_language: "", line: "", template_version: null, delivered_at: e.occurredAt, channel: str((sent?.payload["channels"] as { channel?: string }[] | undefined)?.[0]?.channel).startsWith("mail") ? "mail" : "app", statement_type: type, sent_on: p["sent_on"] ?? null, stated_payment_cents: p["stated_payment_cents"] ?? null, stated_payment_effective_on: p["stated_payment_effective_on"] ?? null, copy_tokens: { money: money(p["stated_payment_cents"]), date: str(p["stated_payment_effective_on"]) } } });
  // 32.8 §6.2 shortage: the ChoiceCard (spread over 12 months | pay now) with the engine's figures; withdrawn once a plan or election exists
  const a = approvedAnalysis(ctx); const d = (a?.data["decision"] as P | undefined);
  if (!a || !d || d["kind"] !== "shortage" || bi(d["shortage_cents"]) <= 0n) return;
  if (has(ctx, "escrow.repayment_plan.created", (x) => x["analysis_id"] === a.id) || has(ctx, "escrow.election.recorded", (x) => x["analysis_id"] === a.id)) return;
  await sendToAll(deps, ctx, escrowShortageCard(a, d));
}
/** 32.8 §6.2: the shortage ChoiceCard (spread over the plan's months | pay now) with 3.2's own figures — sent on the statement, and re-offered when the borrower asks for it in words (32.16 `card.request{escrow_shortage}`) while no plan or election exists. */
export function escrowShortageCard(a: { id: string; data: P }, d: P): CardSpec {
  const shortage = bi(d["shortage_cents"]); const installment = bi(d["installment_cents"]); const months = Number(d["months"] ?? 12); const start = str(a.data["year_start"]);
  return { kind: "ChoiceCard", copy_key: "escrow.shortage.choice", flow_key: `escrow.shortage:${a.id}`, command_ref: "escrow.electShortage",
    props: { title: "", options: [{ id: "spread_12", label: `Spread over ${months} months (+${money(installment)}/mo)`, is_primary: true }, { id: "lump_sum", label: `Pay ${money(shortage)} now` }], command: "escrow.electShortage", command_args_by_option: { spread_12: { option: "spread_12", analysis_id: a.id, start }, lump_sum: { option: "lump_sum", analysis_id: a.id } }, copy_tokens: { money: [money(shortage), money(installment), money(shortage)] }, analysis_id: a.id, shortage_cents: shortage.toString(), installment_cents: installment.toString(), months, start_due_date: start, lump_sum_insert: "NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT", lump_sum_option_offered: d["lump_sum_option_offered"] === true, fresh_l1_required: true, affirmatives: ["spread it", "spread over 12 months", "pay it now"] } };
}
/** The approved analysis whose shortage still awaits the borrower's election (no 3.6 plan, no election recorded), or null — the same test `onEscrowStatementSent` applies. */
export function openShortage(ctx: PaymentFacts): { analysis: { id: string; data: P }; decision: P } | null {
  const id = str(last(ctx, "escrow.analysis.approved")?.payload["analysis_id"]); const rec = id ? ctx.store.get("escrow_analyses", id) : undefined; if (!rec) return null;
  const d = rec.data["decision"] as P | undefined; if (!d || d["kind"] !== "shortage" || bi(d["shortage_cents"]) <= 0n) return null;
  if (!has(ctx, "escrow.statement.sent", (x) => ["annual", "shortage_notice", "short_year_reset"].includes(str(x["statement_type"])))) return null;
  if (has(ctx, "escrow.repayment_plan.created", (x) => x["analysis_id"] === id) || has(ctx, "escrow.election.recorded", (x) => x["analysis_id"] === id)) return null;
  return { analysis: { id, data: rec.data }, decision: d };
}
async function onAnalysisApproved(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const id = str(p["analysis_id"]);
  if (str(p["decision"]) === "credit") { const a = approvedAnalysis(ctx, id); const d = (a?.data["decision"] as P | undefined) ?? {}; await sendToAll(deps, ctx, StatusCard("escrow.surplus_credit", `escrow.credit:${id}`, { copy_tokens: { money: money(p["surplus_cents"]), monthly: money(d["credit_monthly_cents"]) }, analysis_id: id, surplus_cents: str(p["surplus_cents"]), outcome: "credited_to_payments" })); return; }
  if (str(p["decision"]) === "retain") await sendToAll(deps, ctx, StatusCard("escrow.surplus_retained", `escrow.retain:${id}`, { copy_tokens: { money: money(p["surplus_cents"]) }, analysis_id: id, outcome: "retained" }));
}
async function onDisbursementIssued(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (str(p["kind"]) !== "surplus_refund") return;
  await sendToAll(deps, ctx, StatusCard("escrow.surplus", `escrow.refund:${str(p["analysis_id"]) || str(p["due_on"])}`, { copy_tokens: { money: money(p["amount_cents"]) }, amount_cents: str(p["amount_cents"]), method: p["method"] ?? null, issued_on: p["issued_on"] ?? null, due_on: p["due_on"] ?? null, next_event_label: timerLabel("REGX_1024_17F2_SURPLUS_REFUND_30") || "Refund by", next_event_at: await timerDue(deps, ctx.loanId, "REGX_1024_17F2_SURPLUS_REFUND_30") }));
}
async function onPlanCreated(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  // the electing party's own card resolves through the API; the other borrowers' asks are withdrawn (a newer fact for the same ask)
  const election = last(ctx, "escrow.election.recorded", (x) => !x["analysis_id"] || x["analysis_id"] === p["analysis_id"]);
  await transitionAll(deps, ctx, `escrow.shortage:${str(p["analysis_id"])}`, "cancelled", { reason: "election recorded", plan_id: p["plan_id"] }, str(p["election_evidence_document_id"]) || str(election?.payload["evidence_document_id"]) || null);
  await sendToAll(deps, ctx, StatusCard("escrow.plan.created", `escrow.plan:${str(p["plan_id"])}`, { copy_tokens: { n: String(p["months"] ?? 12), money: money(p["installment_cents"]), date: str(p["start_due_date"]) }, plan_id: p["plan_id"], months: p["months"] ?? null, installment_cents: str(p["installment_cents"]), total_cents: str(p["total_cents"]), start_due_date: p["start_due_date"] ?? null, end_due_date: p["end_due_date"] ?? null, status: p["status"] ?? "active", lump_sum_insert: "not_rendered" }));
}
async function onWaiverDecided(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (str(p["decision"]) !== "denied") return;
  await sendToAll(deps, ctx, StatusCard("escrow.waiver.denied", `escrow.waiver.denied:${str(p["waiver_id"]) || e.id}`, { copy_tokens: { date: str(p["re_request_on"]) }, waiver_id: p["waiver_id"] ?? null, reasons: p["reasons"] ?? [], re_request_on: p["re_request_on"] ?? null }));
}
/** The 3.8 WaiverRequest from the loan's own rows and log (the engine decides; the flow only names the record's facts). */
async function waiverRequest(deps: FlowDeps, ctx: Ctx): Promise<P> {
  const facts = await loanCashState(deps.runtime, ctx.loanId, D(ctx.now.slice(0, 10)));
  const appEvents = ctx.appId ? await deps.runtime.uow.events.byApplication(ctx.appId) : [];   // 23.4's determination is keyed by the application
  const hpml = last(ctx, "compliance.hpml.determined")?.payload["is_hpml"] === true || appEvents.filter((x) => x.type === "compliance.hpml.determined").at(-1)?.payload["is_hpml"] === true || last(ctx, "closing.consummated")?.payload["is_hpml"] === true;
  const consummation = str(last(ctx, "closing.consummated")?.payload["consummation_on"] ?? last(ctx, "loan.boarded")?.payload["consummation_date"]);
  const value = str((await deps.runtime.db.query<P>(`SELECT p.estimated_value_cents::text AS v FROM applications a JOIN application_properties p ON p.application_id = a.id WHERE a.loan_id = $1 ORDER BY p.is_subject DESC LIMIT 1`, [ctx.loanId]))[0]?.["v"]) || "80000000";
  const nextDue = facts.state.installments.filter((x) => x.status === "due").map((x) => x.due_date);
  return { hpml, ...(consummation ? { consummation_date: consummation } : {}), upb_cents: facts.state.upb_cents.toString(), original_appraised_value_cents: value, original_property_value_cents: value, regx_days_delinquent: 0, late_30_in_12m: 0, late_60_in_24m: 0, prior_modification: false, prior_waiver_missed_payments: false, monthly_mi_line: false, flood_escrow_mandatory: false, instrument_permits: true, state: "AZ", next_due_dates: nextDue.slice(0, 12) };
}

// ---------------------------------------------------------------- statements and year-end (7.1 / 7.4)
async function onStatementSent(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const noticeId = str(p["notice_id"]); const due = str(p["cycle_due_date"]); const month = monthOf(due || e.occurredAt);
  const mailed = str(p["channel"]) === "mail" || !!p["mailed_at"];
  if (mailed) { await sendToAll(deps, ctx, StatusCard("statement.mailed", `statement:${noticeId}`, { copy_tokens: { month, date: str(p["mailed_at"] ?? e.occurredAt).slice(0, 10) }, notice_id: noticeId, notice_code: p["template"] ?? "NTC_REGZ_41_STMT_STD", cycle_due_date: due, mailed_at: p["mailed_at"] ?? e.occurredAt, bounced: has(ctx, "statement.bounced", (x) => x["notice_id"] === noticeId) })); return; }
  await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "statement.available", flow_key: `statement:${noticeId}`, informational: true,
    props: { document_id: noticeId || randomUUID(), notice_code: str(p["template"]) || "NTC_REGZ_41_STMT_STD", title: "", why_you_see_this: "", requires_ack: false, esign_scope_required: "periodic_statements", channel: "app", delivered_at: e.occurredAt, cycle_due_date: due, statement_date: p["statement_date"] ?? null, variant: p["variant"] ?? "standard", copy_tokens: { month } } });
}
async function onConsentSuspect(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const parties = partyOf(ctx, p["party_id"]);
  // 7.4 rule 8: the affected class reverts to mail; the re-verification (the demonstration test again) is offered by card, never by voice
  await sendToAll(deps, ctx, { kind: "ConsentCard", copy_key: "consent.esign.reverify", flow_key: `esign.reverify:${str(p["notice_id"]) || e.id}`, command_ref: "consent.capture",
    props: { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: [...SERVICING_ESIGN_SCOPES], affirmation_method: "checkbox_with_text", title: "", body_text: "", footer_text: "", requires_typed_name: true, verification_state: "none", reason: "hard_bounce", suspect_consent_id: p["consent_id"] ?? null, bounced_notice_id: p["notice_id"] ?? null, paper_until_active: true, command_args: { kind: "esign", method: "checkbox_with_text", scope: [...SERVICING_ESIGN_SCOPES], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", purpose: "informational" } } }, parties);
}
async function on1098Furnished(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const paper = str(p["channel"]) === "paper";
  await sendToAll(deps, ctx, { kind: "NoticeCard", copy_key: "year_end.1098", flow_key: `1098:${str(p["tax_year"])}`, informational: true, props: { notice_code: "NTC_IRS_1098", title: "", rendered_document_id: str(p["notice_id"]) || randomUUID(), plain_language: "", line: "", template_version: null, delivered_at: e.occurredAt, channel: paper ? "mail" : "app", mailed_at: paper ? `${str(p["furnished_on"])}T12:00:00.000Z` : null, tax_year: p["tax_year"] ?? null, furnished_on: p["furnished_on"] ?? null, furnish_channel: p["channel"] ?? null, copy_tokens: { year: str(p["tax_year"]), date: str(p["furnished_on"]) } } });
}
/** 32.8 §5: the `irs_estatement` ConsentCard is offered in December to every party without an active one (the 1098 is electronic only under it). */
async function offerIrsEstatementConsent(deps: FlowDeps, nowIso: string): Promise<void> {
  const d = new Date(nowIso); if (d.getUTCMonth() !== 11) return;
  const year = d.getUTCFullYear();
  const loans = await deps.runtime.db.query<{ id: string }>(`SELECT id FROM loans WHERE boarded_at IS NOT NULL AND origination_application_id IS NOT NULL AND status NOT IN ('paid_off', 'transferred_out', 'repurchased', 'charged_off')`);
  for (const { id } of loans) {
    const ctx = await context(deps, id);
    for (const party of ctx.parties) {
      if (party.irs_estatement?.status === "active") continue;
      await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.irs_estatement.title", flow_key: `irs_estatement:${year}`, command_ref: "consent.capture",
        props: { consent_kind: "irs_estatement", disclosure_version_id: IRS_ESTATEMENT_DISCLOSURE, scope: ["irs_estatement"], affirmation_method: "checkbox_with_text", title: "", body_text: "", footer_text: "", helper_text: "", requires_typed_name: true, verification_state: "none", tax_year: year, copy_tokens: { year: String(year) }, command_args: { kind: "irs_estatement", method: "checkbox_with_text", scope: ["irs_estatement"], disclosure_version_id: IRS_ESTATEMENT_DISCLOSURE, purpose: "informational" } } });
    }
  }
}

// ---------------------------------------------------------------- the reactions, per loan, in commit order
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  switch (e.type) {
    case "installment.due_date_reached": return onInstallmentDue(deps, ctx, e);
    case "payment.received": return onPaymentReceived(deps, ctx, e);
    case "payment.posted": return onPaymentPosted(deps, ctx, e);
    case "suspense.item.created": return onPartialHeld(deps, ctx, e);
    case "case.opened": return onCaseOpened(deps, ctx, e);
    case "fee.assessed": return onLateCharge(deps, ctx, e);
    case "autodraft.enrollment.requested": return onEnrollmentRequested(deps, ctx, e);
    case "consent.granted": return onConsentGranted(deps, ctx, e);
    case "autodraft.status.changed": return onAutodraftSuspended(deps, ctx, e);
    case "notice.sent": return onNoticeSent(deps, ctx, e);
    case "escrow.statement.sent": return onEscrowStatementSent(deps, ctx, e);
    case "escrow.analysis.approved": return onAnalysisApproved(deps, ctx, e);
    case "disbursement.issued": return onDisbursementIssued(deps, ctx, e);
    case "escrow.repayment_plan.created": return onPlanCreated(deps, ctx, e);
    case "escrow.waiver.decided": return onWaiverDecided(deps, ctx, e);
    case "statement.sent": return onStatementSent(deps, ctx, e);
    case "consent.esign.suspect": return onConsentSuspect(deps, ctx, e);
    case "tax_form.1098.furnished": return on1098Furnished(deps, ctx, e);
    default: return;
  }
}

const PAY = /\b(make|schedule|send|submit)\b.*\bpayment\b|\bpay (my|the|this) (mortgage|loan|payment|bill)\b|^pay\b|\bpayment card\b/i;
/** An extra-principal ask (32.8 §3.2) is not the contractual PaymentCard's: it is left to the agent turn (32.16 `card.request{extra_principal}`), which raises `extraPrincipalCard`. */
export const EXTRA_PRINCIPAL = /\b(extra|additional|more)\b.*\b(principal|toward|towards)\b|\bprincipal\b.*\b(extra|additional|curtail\w*|prepay\w*|pay down)\b|\bcurtail\w*\b|\bpay (down|off) (some|part|extra)\b/i;
const REFUND = /\b(refund|send (it |the money |the funds )?back|return (my|the) (money|funds|partial|payment)|money back)\b/i;
const WAIVER = /\b(waive|cancel|remove|drop|close|stop)\b.*\bescrow\b|\bescrow\b.*\b(waiver|waive|cancel|remove|drop)\b/i;
async function onMessage(deps: FlowDeps, m: InboundMessage): Promise<FlowReply | null> {
  const loanId = m.subject?.loan_id ?? null; if (!loanId) return null;
  const ctx = await context(deps, loanId); const party = ctx.parties.find((x) => x.party_id === m.party_id); if (!party) return null;
  if (REFUND.test(m.text)) {
    const item = openPartial(ctx); if (!item) return null;
    const id = await sendCard(deps, ctx, party, refundChoiceCard(ctx, item));
    return { copy_key: "payment.refund.offered", card_instance_id: id };
  }
  if (WAIVER.test(m.text)) {
    const request = await waiverRequest(deps, ctx);
    const id = await sendCard(deps, ctx, party, { kind: "ChoiceCard", copy_key: "escrow.waiver.choice", flow_key: `escrow.waiver:${m.message_id}`, command_ref: "escrow.requestWaiver",
      props: { title: "", options: [{ id: "request", label: "Ask to close my escrow account", is_primary: true }, { id: "keep", label: "Keep escrow" }], command: "escrow.requestWaiver", command_args_by_option: { request: { request }, keep: {} }, no_command_options: ["keep"], gate: "REGZ_1026_35B1_HPML_ESCROW_GATE", hpml: request["hpml"] === true, consummation_date: request["consummation_date"] ?? null, affirmatives: ["close my escrow", "waive escrow"] } });
    return { copy_key: "escrow.waiver.offered", card_instance_id: id };
  }
  if (PAY.test(m.text) && !EXTRA_PRINCIPAL.test(m.text)) {
    const id = await sendCard(deps, ctx, party, paymentCard(ctx, `pay:manual:${m.at.slice(0, 10)}`));
    return { copy_key: "payment.card_offered", card_instance_id: id };
  }
  return null;
}

export const FLOW_8_SERVICING: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byLoan = new Map<string, DomainEvent[]>(); const appLoan = new Map<string, string | null>();
    for (const e of events) {
      let loan = e.loanId ?? (typeof pl(e)["loan_id"] === "string" ? str(pl(e)["loan_id"]) : null);
      // 32.2's consent.granted is keyed by the application: the boarded loan of that application is the subject
      if (!loan && e.type === "consent.granted" && e.applicationId) { if (!appLoan.has(e.applicationId)) appLoan.set(e.applicationId, (await deps.runtime.db.query<{ id: string }>(`SELECT id FROM loans WHERE origination_application_id = $1 AND boarded_at IS NOT NULL ORDER BY boarded_at DESC LIMIT 1`, [e.applicationId]))[0]?.id ?? null); loan = appLoan.get(e.applicationId) ?? null; }
      if (!loan) continue; const list = byLoan.get(loan) ?? []; list.push(e); byLoan.set(loan, list);
    }
    for (const [loanId, list] of byLoan) {
      const ctx = await context(deps, loanId);
      if (!ctx.parties.length) continue;   // no borrower party has signed in: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-8.reaction", { event: e.type, loan_id: loanId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  async tick(deps, nowIso) { await servicingDailySweep(deps.runtime, nowIso); await offerIrsEstatementConsent(deps, nowIso); },
  onMessage,
};
