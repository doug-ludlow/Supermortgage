/**
 * 32.12 — Exits (spec/sections/32-borrower-experience/32-12-exits.md): the borrower-facing form of 7.6 / 16.1 (the
 * payoff statement and its updates), 16.2 (funds, shortage, paid in full, housekeeping), 16.3 (the lien release), 3.5
 * (the escrow refund), 2.3 (autopay termination), 17.x (the transfer out and the protected window), 4.2 / 4.4 (a
 * confirmed successor's own requests) and the closed loan. Every card here is created through 32.1's `send_card` for
 * the `borrower-comms` agent on the owning process's event; nothing here computes a regulatory date or a money figure —
 * dates come from `timers` and the rows the owning tools stored, figures from the owning process's own rows and events.
 *
 *   payoff.statement.sent{NTC_REGZ_36C3_PAYOFF_STMT}   NoticeCard `payoff.statement` (shared key with 32.9 — one card) + StatusCard `payoff.statement.components` from the `payoff_quotes` row, the positive-confirmation line `payoff.wire_confirm` (T1)
 *   payoff.statement.sent{NTC_PAYOFF_UPDATED_STMT}     NoticeCard `payoff.statement.updated` from the `payoff_statement_updates` row (T1)
 *   payoff.funds.cleared / .received                   StatusCard `payoff.funds_received` (§1.2 "Paying off")
 *   payoff.shortage.demand_sent                        NoticeCard `payoff.shortage` — the difference, the reason, the cure-by date (T2)
 *   tick, day 20 of an open shortage                   StatusCard `payoff.shortage.day20` (T2: "the card says so at day 20")
 *   payoff.shortage.resolved{applied_per_note|cured}   StatusCard `payoff.shortage.applied_per_note` (the loan stays open) / `payoff.shortage.cured` (T2)
 *   loan.paid_in_full                                  StatusCard `payoff.escrow_refund` (REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD.due_at) + `payoff.ratewatch_ended` (T3)
 *   notice.sent{NTC_PAYOFF_PAID_IN_FULL}               NoticeCard `payoff.paid_in_full`
 *   disbursement.issued{kind=payoff_refund}            StatusCard `payoff.escrow_refund.sent` (T3)
 *   autodraft.enrollment.terminated                    StatusCard `payoff.autopay_terminated` (payoff) / `transfer.autopay_ends` (transfer out) (T3, T5)
 *   lien_release.task_opened / .delivered_to_trustee   StatusCards `payoff.lien_release.opened` (STATE_LIEN_RELEASE_DEADLINE in Dates) / `.delivered` (T4)
 *   notice.sent{NTC_LIEN_RELEASE_RECORDED}             NoticeCard `payoff.lien_release` — the trustee path explained where the release task took it (T4)
 *   payoff.housekeeping.completed (the last task)      StatusCard `closed` — the Record turns read-only (T8)
 *   notice.mailed{NTC_REGX_1024_33B_*_MS2}             NoticeCard `transfer.notice` (mail; the stored goodbye-run dates) + StatusCard `transfer.autopay_ends` when autopay is on (T5)
 *   payment.misdirected.received{protected}            StatusCard `transfer.payment_forwarded` / `.after_window` (T6)
 *   transfer.protection_window.expired                 StatusCard `transfer.after_window`
 *   case.sii.acknowledgment.returned{elected=false}    StatusCard `successor.notices_declined`; statements and loan notices skip that party from then on (T7)
 *   case.opened{rfi}                                   4.2 `rfi.open{requester_role}` (the 4.2 clocks) → `case.notice.send{NTC_REGX_36C_ACK}` → NoticeCard `case.ack.notice` (T7)
 *   case.rfi.responded                                 NoticeCard `successor.rfi_answered` to the requester (T7)
 *   message on a paid-off / closed / transferred loan  32.2 `case.open{general_inquiry}` → reply `closed.question_logged` (T8)
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { plainDate as D, addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { EntityStore } from "../../../app/tools.ts";
import type { ToolDef } from "../../../app/tools.ts";
import { SECTION_04_CASE_COMMANDS } from "../../../app/tools/section04.ts";
import type { Recipient } from "../../../notices/channel.ts";
import { registerFlowTimers, timerLabel } from "../record.ts";
import { EXIT_TIMER_LABELS, TRANSFER_OUT_NOTICES, loadExitsContext, type ExitsContext } from "./12-exits-record.ts";
import type { BorrowerFlow, FlowDeps, FlowReply, InboundMessage } from "./index.ts";

export const FLOW_ID = "32.12";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const CASE_AGENT: Actor = { kind: "agent", id: "case" };
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const CREATED_BY = "agent:borrower-comms";
const RUN = { runId: "flow:32.12", modelVersion: "borrower flows (deterministic)", promptVersion: "32.12" } as const;
export const NOTICE_CODES_32_12 = { payoff_statement: "NTC_REGZ_36C3_PAYOFF_STMT", payoff_updated: "NTC_PAYOFF_UPDATED_STMT", shortage_demand: "NTC_PAYOFF_SHORTAGE_DEMAND", paid_in_full: "NTC_PAYOFF_PAID_IN_FULL", lien_release_recorded: "NTC_LIEN_RELEASE_RECORDED", rfi_ack: "NTC_REGX_36C_ACK", rfi_response: "NTC_REGX_36D_RESPONSE" } as const;
/** The clocks this process renders in Dates (32.12 "Borrower-visible clocks") beside the registry's 32.2 rows. */
registerFlowTimers(EXIT_TIMER_LABELS);
const REACTS = new Set(["payoff.statement.sent", "notice.sent", "payoff.funds.cleared", "payoff.funds.received", "payoff.shortage.demand_sent", "payoff.shortage.resolved", "loan.paid_in_full", "disbursement.issued", "autodraft.enrollment.terminated", "payoff.housekeeping.completed",
  "lien_release.task_opened", "lien_release.delivered_to_trustee", "notice.mailed", "payment.misdirected.received", "transfer.protection_window.expired", "case.sii.acknowledgment.returned", "case.opened", "case.rfi.responded"]);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: unknown): string => { if (cents === undefined || cents === null || cents === "") return ""; try { return USD.format(Number(BigInt(String(cents))) / 100); } catch { return ""; } };
/** 32.12 §1.2: the trustee / public-trustee release paths (CA / WA / CO) the notice explains. */
export const TRUSTEE_PATHS: ReadonlySet<string> = new Set(["trustee_third_party", "trustee", "public_trustee"]);
const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ---------------------------------------------------------------- the loan context one batch works on
type P = Record<string, unknown>;
interface Party { readonly party_id: string; readonly legal_name: string; readonly contact: P; readonly role: string }
interface Ctx { readonly loanId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly exits: ExitsContext; readonly declined: ReadonlySet<string>; readonly address: string | null; readonly now: string }
const pl = (e: DomainEvent): P => e.payload as P;
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);
const evOf = (e: DomainEvent) => ({ sequence: String(e.sequence), type: e.type, occurred_at: e.occurredAt, payload: pl(e) });

/** Every party on the loan with a conversation and their role: the boarded borrowers, the application's borrowers, a confirmed successor (02 §6). */
async function loanParties(deps: FlowDeps, loanId: string): Promise<Party[]> {
  return deps.runtime.db.query<Party & Record<string, unknown>>(
    `SELECT p.id AS party_id, p.legal_name, p.contact, min(r.role) AS role FROM parties p JOIN (
       SELECT b.party_id, 'borrower' AS role FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL
       UNION SELECT ab.party_id, 'borrower' FROM application_borrowers ab JOIN loans l ON l.origination_application_id = ab.application_id WHERE l.id = $1 AND ab.party_id IS NOT NULL
       UNION SELECT lp.party_id, lp.role FROM loan_parties lp WHERE lp.loan_id = $1 AND lp.role = 'confirmed_successor' AND lp.ended_at IS NULL) r ON r.party_id = p.id GROUP BY p.id, p.legal_name, p.contact ORDER BY p.legal_name`, [loanId]);
}
/** The property address on the loan (the borrower's — and a successor's — mailing address of record for a registry notice). */
async function loanAddress(deps: FlowDeps, loanId: string): Promise<string | null> {
  const row = (await deps.runtime.db.query<{ address: string | null }>(`SELECT concat_ws(', ', pr.address_line1, pr.city, pr.state || ' ' || pr.postal_code) AS address FROM loans l LEFT JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  return row?.address || null;
}
async function context(deps: FlowDeps, loanId: string): Promise<Ctx> {
  const [events, records, parties, address] = await Promise.all([deps.runtime.uow.events.byLoan(loanId), deps.runtime.entities.load({ loanId }), loanParties(deps, loanId), loanAddress(deps, loanId)]);
  const store = new EntityStore(); store.seed(records);
  const exits = await loadExitsContext(deps.runtime.db, loanId, events.map(evOf));
  // 4.4: a confirmed successor who returned the acknowledgment declining the borrower's notices (`case.sii.confirmed{party_id}` + `case.sii.acknowledgment.returned{elected_notices=false}` on the same case)
  const declined = new Set<string>();
  for (const e of events.filter((x) => x.type === "case.sii.acknowledgment.returned" && pl(x)["elected_notices"] === false)) { const caseId = String(pl(e)["case_id"] ?? ""); const confirmed = events.filter((x) => x.type === "case.sii.confirmed" && pl(x)["case_id"] === caseId).at(-1); const pid = confirmed ? String(pl(confirmed)["party_id"] ?? "") : ""; if (pid) declined.add(pid); }
  return { loanId, events, store, parties, exits, declined, address, now: deps.runtime.clock.now() };
}
/** The parties a loan-level notice / statement card goes to: everyone but a successor who declined (32.12 §3). */
const noticeParties = (ctx: Ctx): readonly Party[] => ctx.parties.filter((p) => !ctx.declined.has(p.party_id));
const partyById = (ctx: Ctx, id: unknown): Party | undefined => (typeof id === "string" ? ctx.parties.find((p) => p.party_id === id) : undefined);
const emailOf = (p: Party): string | undefined => { const c = p.contact; const e = typeof c["email"] === "string" ? c["email"] : Array.isArray(c["emails"]) ? (c["emails"] as unknown[])[0] : undefined; return typeof e === "string" && e ? e : undefined; };
/** A Notice Registry recipient for a loan party: at the property, a portal user (the channel decision is the registry's). */
const recipientFor = (p: Party, ctx: Ctx): Recipient => { const email = emailOf(p); return { partyId: p.party_id, name: p.legal_name, mailingAddress: ctx.address, ...(email ? { email } : {}), portalUser: true }; };

// ---------------------------------------------------------------- bus helpers: the owning processes' tools as their own agents; the 4.x case commands through executeDef
const CASE_CMDS = new Map<string, ToolDef>(SECTION_04_CASE_COMMANDS.map((d) => [`${d.process} ${d.name}`, d]));
async function exec(deps: FlowDeps, loanId: string, process: string, name: string, actor: Actor, input: P): Promise<P> {
  const r = await deps.runtime.execute({ process, name, loanId, actor, input, run: { ...RUN } });
  return (r.output ?? {}) as P;
}
async function caseCmd(deps: FlowDeps, loanId: string, process: string, name: string, input: P, actor: Actor = CASE_AGENT): Promise<{ output: P; events: readonly DomainEvent[] }> {
  // the case commands are registered under the section process that owns them (4.1's `case.notice.send` serves every 4.x case); the name is what the caller knows
  const def = CASE_CMDS.get(`${process} ${name}`) ?? SECTION_04_CASE_COMMANDS.find((d) => d.name === name); if (!def) throw new RangeError(`no ${process} case command ${name}`);
  const r = await deps.runtime.executeDef(def, { loanId, actor, input, run: { ...RUN } });
  return { output: (r.output ?? {}) as P, events: r.events };
}
async function timerRow(deps: FlowDeps, loanId: string, code: string): Promise<{ id: string; due_at: string | null; due_date: string | null; status: string } | undefined> {
  return (await deps.runtime.db.query<{ id: string; due_at: string | null; due_date: string | null; status: string }>(`SELECT id, due_at, due_date::text AS due_date, status::text AS status FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
}
/** The Notice Registry's rendered notice (the runtime keeps them for the life of the process — Runtime.noticeMemory): its plain-language text goes on the NoticeCard, never a summary. */
const renderedText = (deps: FlowDeps, noticeId: unknown): string => { const n = typeof noticeId === "string" ? deps.runtime.noticeMemory.get(noticeId) : undefined; return n?.rendered.text ?? ""; };

// ---------------------------------------------------------------- card primitives (32.1's send_card for the borrower-comms agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string | null; readonly flow_key: string; readonly informational?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, loanId: string, party: Party, c: CardSpec, now: string): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { loan_id: loanId }, created_by: CREATED_BY, rationale: `32.12 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  // a card with no action (StatusCard, NoticeCard) is never the pinned ask: filed as read the moment it is sent (01 §3.1 "No action")
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", now, { informational: true, resolved_by: "system:flow-32.12" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = noticeParties(ctx)): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx.loanId, p, c, ctx.now)); return ids; }
/** 32.12 §3: a successor who declined the borrower's notices gets no statement — a statement card another flow filed for them on this event (32.9's `payoff.statement`) is withdrawn with the reason on the card. */
async function withdrawStatementsFromDeclined(deps: FlowDeps, ctx: Ctx): Promise<void> {
  if (!ctx.declined.size) return;
  const rows = await deps.runtime.db.query<{ card_instance_id: string; party_id: string; status: string }>(`SELECT card_instance_id, party_id, status FROM card_instances WHERE subject_loan_id = $1 AND party_id = ANY($2::uuid[]) AND status IN ('pending', 'resolved') AND (props->>'notice_code' ~ 'STMT' OR props->>'notice_code' ~ 'STATEMENT')`, [ctx.loanId, [...ctx.declined]]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, "cancelled", "system", ctx.now, { reason: "successor_declined_notices", rule: "4.4 NTC_REGX_32C_SII_ACK choice (32.12 §3)", resolved_by: "system:flow-32.12" });
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true });
const NoticeCard = (copy_key: string, flow_key: string, notice_code: string, props: P = {}): CardSpec => ({ kind: "NoticeCard", copy_key, props: { notice_code, title: "", rendered_document_id: randomUUID(), plain_language: "", line: "", template_version: null, channel: "app", ...props }, flow_key, informational: true });

// ---------------------------------------------------------------- §1.1 the payoff statement and its updates (16.1)
async function statementCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const template = String(p["template"] ?? ""); const noticeId = String(p["notice_id"] ?? e.id); const sid = String(p["statement_id"] ?? "");
  const text = renderedText(deps, p["notice_id"]);
  if (template === NOTICE_CODES_32_12.payoff_statement && p["updated"] !== true) {
    const st = ctx.store.get("payoff_statements", sid)?.data ?? {}; const q = ctx.store.get("payoff_quotes", String(st["quote_id"] ?? ""))?.data ?? {};
    const goodThrough = String(q["good_through"] ?? st["good_through"] ?? ""); const fees = (["late_charges_cents", "fees_cents", "recording_fee_cents", "corporate_advances_cents", "escrow_advance_cents", "mi_premium_cents"] as const).reduce((t, k) => t + (q[k] !== undefined && q[k] !== null ? BigInt(String(q[k])) : 0n), 0n);
    const tokens = { principal: money(q["upb_cents"]), interest: money(q["interest_cents"]), escrow: money(st["escrow_balance_cents"]), fees: money(fees), per_diem: money(q["per_diem_cents"]), total: money(q["total_cents"] ?? st["total_cents"]), good_through: goodThrough, date: goodThrough, money: money(q["total_cents"] ?? st["total_cents"]) };
    // the notice itself (one card: 32.9 sends the same key on `notice.sent`; whichever runs first files it) — the template's own text as the plain-language block, the positive-confirmation rule as its line
    await sendToAll(deps, ctx, NoticeCard("payoff.statement", `payoff.statement:${noticeId}`, template, { rendered_document_id: noticeId, statement_id: sid, quote_id: st["quote_id"] ?? null, plain_language: text, template_version: p["template_version"] ?? null, delivered_at: e.occurredAt, amount_cents: q["total_cents"] !== undefined ? String(q["total_cents"]) : undefined, good_through: goodThrough, copy_tokens: tokens, copy_token_keys: { confirm: "payoff.wire_confirm" } }));
    await sendToAll(deps, ctx, StatusCard("payoff.statement.components", `payoff.components:${sid || noticeId}`, { statement_id: sid, quote_id: st["quote_id"] ?? null, notice_id: noticeId, good_through: goodThrough, per_diem_cents: q["per_diem_cents"] !== undefined ? String(q["per_diem_cents"]) : null, total_cents: q["total_cents"] !== undefined ? String(q["total_cents"]) : null, copy_tokens: tokens, detail_copy_key: "payoff.wire_confirm", positive_confirmation: true, next_event_label: "Good through", next_event_at: goodThrough ? `${goodThrough}T23:59:59.000Z` : null }));
    return;
  }
  if (template === NOTICE_CODES_32_12.payoff_updated || p["updated"] === true) {
    const u = ctx.store.get("payoff_statement_updates", sid)?.data ?? {}; const q = ctx.store.get("payoff_quotes", String(u["quote_id"] ?? ""))?.data ?? {};
    const goodThrough = String(q["good_through"] ?? "");
    await sendToAll(deps, ctx, NoticeCard("payoff.statement.updated", `payoff.updated:${noticeId}`, NOTICE_CODES_32_12.payoff_updated, { rendered_document_id: noticeId, statement_id: u["statement_id"] ?? sid, updated_statement_id: sid, plain_language: text, template_version: p["template_version"] ?? null, delivered_at: e.occurredAt, amount_cents: u["total_cents"] !== undefined ? String(u["total_cents"]) : undefined, previous_total_cents: u["previous_total_cents"] !== undefined ? String(u["previous_total_cents"]) : null, trigger_event: u["trigger_event"] ?? q["trigger_event"] ?? null, good_through: goodThrough,
      copy_tokens: { reason: String(u["explanation"] ?? u["reason"] ?? ""), money: money(u["total_cents"]), date: goodThrough, previous: money(u["previous_total_cents"]) } }));
  }
}

// ---------------------------------------------------------------- §1.2 funds, shortage, paid in full, housekeeping (16.2 / 3.5 / 2.3)
const shortageReasonKey = (ctx: Ctx, short: DomainEvent | undefined): string => {
  const receipt = String(pl(short ?? ({ payload: {} } as unknown as DomainEvent))["receipt"] ?? ""); const st = ctx.store.list("payoff_statements").map((r) => r.data).at(-1);
  const goodThrough = st ? String(st["good_through"] ?? "") : "";
  return receipt && goodThrough && receipt > goodThrough ? "payoff.shortage.reason.per_diem" : "payoff.shortage.reason.amount";
};
async function shortageCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  if (e.type === "payoff.shortage.demand_sent") {
    const short = last(ctx, "payoff.funds.short"); const noticeId = String(p["notice_id"] ?? e.id);
    await sendToAll(deps, ctx, NoticeCard("payoff.shortage", `payoff.shortage:${noticeId}`, NOTICE_CODES_32_12.shortage_demand, { rendered_document_id: noticeId, plain_language: renderedText(deps, p["notice_id"]), delivered_at: e.occurredAt, amount_cents: String(p["shortage_cents"] ?? ""), cure_by: p["cure_by"] ?? null, uncured_on: p["uncured_on"] ?? null, suspense_item_id: p["suspense_item_id"] ?? null,
      copy_tokens: { money: money(p["shortage_cents"]), date: String(p["cure_by"] ?? ""), uncured_on: String(p["uncured_on"] ?? "") }, copy_token_keys: { reason: shortageReasonKey(ctx, short) } }));
    return;
  }
  if (e.type === "payoff.shortage.resolved") {
    const outcome = String(p["outcome"] ?? "");
    if (outcome === "applied_per_note") { await sendToAll(deps, ctx, StatusCard("payoff.shortage.applied_per_note", `payoff.shortage.applied:${e.id}`, { copy_tokens: { date: e.occurredAt.slice(0, 10), money: money(p["unapplied_cents"] ?? p["shortage_cents"]) }, loan_status: p["loan_status"] ?? "active", installments_paid: p["installments_paid"] ?? null, curtailment_cents: p["curtailment_cents"] !== undefined ? String(p["curtailment_cents"]) : null, ledger_set_id: p["ledger_set_id"] ?? null })); return; }
    if (outcome === "cured") { await sendToAll(deps, ctx, StatusCard("payoff.shortage.cured", `payoff.shortage.cured:${e.id}`, { copy_tokens: { money: money(p["shortage_cents"]), received: e.occurredAt.slice(0, 10), date: String(p["paid_in_full_as_of"] ?? "") } })); return; }
  }
}
/** T2 "the card says so at day 20": day 20 after the short receipt on an open shortage — the uncured date the demand named, never computed here. */
async function shortageDay20(deps: FlowDeps, ctx: Ctx, today: PlainDate): Promise<void> {
  const short = last(ctx, "payoff.funds.short"); if (!short) return;
  const resolved = ctx.events.some((x) => x.type === "payoff.shortage.resolved" && x.sequence > short.sequence); if (resolved) return;
  const demand = last(ctx, "payoff.shortage.demand_sent"); if (!demand) return;
  const receipt = String(pl(short)["receipt"] ?? short.occurredAt.slice(0, 10)); const day20 = addDays(D(receipt), 20); const uncured = String(pl(demand)["uncured_on"] ?? "");
  if (today < day20 || (uncured && today >= uncured)) return;
  await sendToAll(deps, ctx, StatusCard("payoff.shortage.day20", `payoff.shortage.day20:${String(pl(short)["suspense_item_id"] ?? short.id)}`, { copy_tokens: { money: money(pl(short)["shortage_cents"]), date: uncured }, uncured_on: uncured, next_event_label: timerLabel("SM_PAYOFF_SHORTAGE_UNCURED_30"), next_event_at: (await timerRow(deps, ctx.loanId, "SM_PAYOFF_SHORTAGE_UNCURED_30"))?.due_at ?? null }));
}
async function paidInFullCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const sid = String(p["settlement_id"] ?? e.id); const st = ctx.store.get("payoff_settlements", sid)?.data ?? {};
  if (p["escrowed"] === true || st["escrow_balance_cents"] !== undefined) {
    const refund = await timerRow(deps, ctx.loanId, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD");
    await sendToAll(deps, ctx, StatusCard("payoff.escrow_refund", `payoff.escrow_refund:${sid}`, { settlement_id: sid, amount_cents: st["escrow_balance_cents"] !== undefined ? String(st["escrow_balance_cents"]) : null, copy_tokens: { money: money(st["escrow_balance_cents"]), date: refund?.due_date ?? "" }, next_event_label: timerLabel("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"), next_event_at: refund?.due_at ?? null, timer_code: "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD" }));
  }
  // rate-watch ends with the loan (32.12 §1.2 "Rate-watch ends (refi_opportunities.void)"): the Record hides offers and reports ratewatch_status=void
  await sendToAll(deps, ctx, StatusCard("payoff.ratewatch_ended", `payoff.ratewatch:${sid}`, { settlement_id: sid, payoff_date: p["payoff_date"] ?? null, ratewatch_status: "void" }));
}
async function housekeepingCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const sid = String(p["settlement_id"] ?? "");
  const created = last(ctx, "payoff.housekeeping.created", (x) => x["settlement_id"] === sid); const tasks = ((pl(created ?? e)["tasks"] as unknown[] | undefined) ?? []).map(String);
  const done = new Set(ctx.events.filter((x) => x.type === "payoff.housekeeping.completed" && pl(x)["settlement_id"] === sid).map((x) => String(pl(x)["task"])));
  if (tasks.length && tasks.every((t) => done.has(t))) await sendToAll(deps, ctx, StatusCard("closed", `closed:${sid}`, { settlement_id: sid, closed_on: e.occurredAt.slice(0, 10), read_only: true }));
}

// ---------------------------------------------------------------- §1.2 the lien release (16.3)
async function releaseCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const rid = String(p["release_task_id"] ?? "");
  if (e.type === "lien_release.task_opened") {
    const deadline = await timerRow(deps, ctx.loanId, "STATE_LIEN_RELEASE_DEADLINE");
    await sendToAll(deps, ctx, StatusCard("payoff.lien_release.opened", `lien.opened:${rid}`, { release_task_id: rid, state: p["state"] ?? null, recording_path: p["recording_path"] ?? null, copy_tokens: { date: deadline?.due_date ?? String(p["statutory_release_due"] ?? "") }, next_event_label: timerLabel("STATE_LIEN_RELEASE_DEADLINE"), next_event_at: deadline?.due_at ?? null, timer_code: "STATE_LIEN_RELEASE_DEADLINE" }));
    return;
  }
  if (e.type === "lien_release.delivered_to_trustee") { await sendToAll(deps, ctx, StatusCard("payoff.lien_release.delivered", `lien.delivered:${rid}`, { release_task_id: rid, copy_tokens: { date: String(p["delivered_on"] ?? p["received_by_trustee_on"] ?? e.occurredAt.slice(0, 10)) } })); return; }
}
async function releaseNotice(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const noticeId = String(p["notice_id"] ?? e.id);
  const notified = last(ctx, "lien_release.borrower_notified"); const rid = String(pl(notified ?? e)["release_task_id"] ?? ""); const task = ctx.store.get("release_tasks", rid)?.data ?? {};
  const recorded = last(ctx, "lien_release.recorded") ?? last(ctx, "trustee.reconveyance.recorded");
  const path = String(task["recording_path"] ?? ""); const trustee = TRUSTEE_PATHS.has(path) || has(ctx, "lien_release.delivered_to_trustee");
  await sendToAll(deps, ctx, NoticeCard("payoff.lien_release", `lien.recorded:${noticeId}`, NOTICE_CODES_32_12.lien_release_recorded, { rendered_document_id: noticeId, plain_language: renderedText(deps, p["notice_id"]), delivered_at: e.occurredAt, release_task_id: rid || null, state: task["state"] ?? null, recording_path: path || null, recording_reference: task["recording_reference"] ?? pl(recorded ?? e)["recording_reference"] ?? null, recorded_on: task["recorded_at"] ?? pl(recorded ?? e)["recorded_on"] ?? null, recorded_document_id: task["recorded_document_id"] ?? null,
    copy_tokens: { date: String(task["recorded_at"] ?? pl(recorded ?? e)["recorded_on"] ?? ""), reference: String(task["recording_reference"] ?? pl(recorded ?? e)["recording_reference"] ?? ""), state: String(task["state"] ?? "") }, copy_token_keys: { path: trustee ? "payoff.lien_release.trustee" : "payoff.lien_release.direct" } }));
}

// ---------------------------------------------------------------- §2 the transfer out (17.2 / 17.3)
async function transferNotice(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const t = ctx.exits.transfer; const noticeId = String(p["notice_id"] ?? e.id);
  const tokens = { new_servicer: t?.new_servicer ?? "your new servicer", date: t?.respa_effective_date ?? t?.transfer_date ?? "", through: t?.transferor_stops ?? "", address: t?.address ?? "", tollfree: t?.tollfree ?? "" };
  await sendToAll(deps, ctx, NoticeCard("transfer.notice", `transfer.notice:${noticeId}`, String(p["template"] ?? ""), { rendered_document_id: noticeId, channel: "mail", mailed_at: String(p["mailed_at"] ?? e.occurredAt.slice(0, 10)).length === 10 ? `${String(p["mailed_at"] ?? e.occurredAt.slice(0, 10))}T12:00:00.000Z` : String(p["mailed_at"]), proof_of_mailing_id: p["proof_of_mailing_id"] ?? null, batch_id: p["batch_id"] ?? null, run_id: p["run_id"] ?? null, respa_effective_date: t?.respa_effective_date ?? null, transferor_stops: t?.transferor_stops ?? null, transferee_starts: t?.transferee_starts ?? null, window_end: t?.window_end ?? null, copy_tokens: tokens }));
  // autopay: the last debit is no later than the last pre-cutover due date (17.2's stored ach_cancel_by / transferor stop) — "set up autopay with the new servicer after the transfer"
  const enrollment = ctx.store.list("autodraft_enrollments", (d) => ["active", "requested", "authorized", "validating", "paused"].includes(String(d["status"] ?? ""))).at(-1);
  if (enrollment && t) await sendToAll(deps, ctx, StatusCard("transfer.autopay_ends", `transfer.autopay:${t.batch_id}`, { enrollment_id: enrollment.id, ends_on: t.ach_cancel_by ?? t.transferor_stops ?? null, copy_tokens: { date: t.ach_cancel_by ?? t.transferor_stops ?? "", new_servicer: t.new_servicer, transfer_date: t.respa_effective_date ?? t.transfer_date ?? "" } }));
}
async function misdirectedCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const t = ctx.exits.transfer; const isProtected = p["protected"] === true;
  await sendToAll(deps, ctx, StatusCard(isProtected ? "transfer.payment_forwarded" : "transfer.payment_forwarded.after_window", `transfer.payment:${String(p["payment_id"] ?? e.id)}`, { payment_id: p["payment_id"] ?? null, protected: isProtected, received_on: p["received_at"] ?? null, credited_as_of: p["credited_as_of"] ?? null, amount_cents: p["amount_cents"] !== undefined ? String(p["amount_cents"]) : null, forwarded: true, copy_tokens: { money: money(p["amount_cents"]), date: String(p["received_at"] ?? e.occurredAt.slice(0, 10)), new_servicer: t?.new_servicer ?? "your new servicer" } }));
}

// ---------------------------------------------------------------- §3 the confirmed successor's own requests (4.2 / 4.4)
async function successorDeclined(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["elected_notices"] !== false) return;
  const caseId = String(p["case_id"] ?? ""); const confirmed = last(ctx, "case.sii.confirmed", (x) => x["case_id"] === caseId); const party = partyById(ctx, pl(confirmed ?? e)["party_id"]); if (!party) return;
  await sendCard(deps, ctx.loanId, party, StatusCard("successor.notices_declined", `successor.declined:${caseId}`, { case_id: caseId, elected_notices: false }), ctx.now);
}
/** A request for information from a loan party (32.2 `case.open{kind=rfi}`): 4.2 opens the RFI on its clocks with the requester's role (a confirmed successor's answer is redacted per §1024.36(d)(3)), the acknowledgment goes out through the Notice Registry and its card to the requester. */
async function rfiOpened(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (String(p["case_type"]) !== "rfi") return;
  const caseId = String(p["case_id"] ?? ""); const rfiId = `rfi-${caseId}`;
  if (has(ctx, "case.rfi.opened", (x) => x["case_id"] === rfiId)) return;
  const row = ctx.store.get("cases", caseId)?.data ?? {}; const party = partyById(ctx, row["submitted_by_party_id"]); if (!party) return;
  const receipt = String(row["receipt_date"] ?? e.occurredAt.slice(0, 10)); const text = String(row["text"] ?? "").trim() || "information about my loan";
  const role = party.role === "confirmed_successor" ? "confirmed_successor" : "borrower";
  await caseCmd(deps, ctx.loanId, "4.2", "rfi.open", { case_id: rfiId, receipt_date: receipt, requester_role: role, items: [{ id: "1", kind: "standard", description: text }], linked_case_ids: [caseId], party_id: party.party_id });
  const response = await timerRow(deps, ctx.loanId, "REGX_1024_36D_RFI_RESPONSE_30"); const ack = await timerRow(deps, ctx.loanId, "REGX_1024_36C_RFI_ACK_5");
  // the §1024.36(c) acknowledgment within 5 business days: the 4.x case agent renders NTC_REGX_36C_ACK through the registry (its payload from the template's authored sample, the request's own facts over it)
  const sample = deps.runtime.noticeRegistry.activeVersion(NOTICE_CODES_32_12.rfi_ack, D(receipt))?.samplePayload ?? {};
  const payload = { ...sample, borrower_name: party.legal_name, account_last4: ctx.loanId.slice(-4), received_on: receipt, business_days_after_receipt: 1, items: [{ n: 1, text, response_due: response?.due_date ?? "" }] };
  const sent = await caseCmd(deps, ctx.loanId, "4.2", "case.notice.send", { template: NOTICE_CODES_32_12.rfi_ack, case_id: rfiId, recipients: [recipientFor(party, ctx)], payload });
  const noticeId = String(sent.output["notice_id"] ?? "");
  await sendCard(deps, ctx.loanId, party, NoticeCard("case.ack.notice", `rfi.ack:${rfiId}`, NOTICE_CODES_32_12.rfi_ack, { rendered_document_id: noticeId || randomUUID(), plain_language: renderedText(deps, noticeId), delivered_at: ctx.now, case_id: rfiId, source_case_id: caseId, requester_role: role, copy_tokens: { date: receipt, due: response?.due_date ?? "" }, next_event_label: timerLabel("REGX_1024_36D_RFI_RESPONSE_30"), next_event_at: response?.due_at ?? null, ack_due_at: ack?.due_at ?? null }), ctx.now);
}
async function rfiAnswered(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const rfiId = String(p["case_id"] ?? ""); const opened = last(ctx, "case.rfi.opened", (x) => x["case_id"] === rfiId); if (!opened) return;
  const linked = ((pl(opened)["linked_case_ids"] as unknown[] | undefined) ?? []).map(String); const source = linked.map((id) => ctx.store.get("cases", id)?.data).find((d) => d && d["submitted_by_party_id"]);
  const party = partyById(ctx, source?.["submitted_by_party_id"]); if (!party) return;
  await sendCard(deps, ctx.loanId, party, NoticeCard("successor.rfi_answered", `rfi.answered:${rfiId}`, NOTICE_CODES_32_12.rfi_response, { rendered_document_id: String(p["notice_id"] ?? randomUUID()), delivered_at: e.occurredAt, case_id: rfiId, complete: p["complete"] ?? null, redaction_check_passed: p["redaction_check_passed"] ?? null, requester_role: pl(opened)["requester_role"] ?? null, copy_tokens: { date: String(pl(opened)["receipt_date"] ?? "") } }), ctx.now);
}

// ---------------------------------------------------------------- reactions
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "payoff.statement.sent": { await statementCards(deps, ctx, e); await withdrawStatementsFromDeclined(deps, ctx); return; }
    case "notice.sent": {
      const template = String(p["template"] ?? "");
      if (template === NOTICE_CODES_32_12.paid_in_full) { const refund = await timerRow(deps, ctx.loanId, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"); const release = await timerRow(deps, ctx.loanId, "STATE_LIEN_RELEASE_DEADLINE"); const st = ctx.store.list("payoff_settlements").map((r) => r.data).at(-1) ?? {};
        await sendToAll(deps, ctx, NoticeCard("payoff.paid_in_full", `payoff.pif:${String(p["notice_id"] ?? e.id)}`, template, { rendered_document_id: String(p["notice_id"] ?? e.id), plain_language: renderedText(deps, p["notice_id"]), delivered_at: e.occurredAt, payoff_date: st["payoff_date"] ?? null, copy_tokens: { money: money(st["escrow_balance_cents"]), date: refund?.due_date ?? "", n: release?.due_date ?? "" } })); return; }
      if (template === NOTICE_CODES_32_12.lien_release_recorded) return releaseNotice(deps, ctx, e);
      if (/STMT|STATEMENT/.test(template)) await withdrawStatementsFromDeclined(deps, ctx);
      return;
    }
    case "payoff.funds.cleared": case "payoff.funds.received": {
      if (e.type === "payoff.funds.received" && has(ctx, "payoff.funds.cleared", (x) => x["funds_id"] === p["funds_id"])) return;
      await sendToAll(deps, ctx, StatusCard("payoff.funds_received", `payoff.funds:${String(p["funds_id"] ?? e.id)}`, { funds_id: p["funds_id"] ?? null, amount_cents: p["amount_cents"] !== undefined ? String(p["amount_cents"]) : null, copy_tokens: { date: String(p["received_on"] ?? p["credited_as_of"] ?? (typeof p["cleared_at"] === "string" ? (p["cleared_at"] as string).slice(0, 10) : e.occurredAt.slice(0, 10))), money: money(p["amount_cents"]) } })); return;
    }
    case "payoff.shortage.demand_sent": case "payoff.shortage.resolved": return shortageCards(deps, ctx, e);
    case "loan.paid_in_full": return paidInFullCards(deps, ctx, e);
    case "disbursement.issued": {
      if (String(p["kind"]) !== "payoff_refund") return;
      await sendToAll(deps, ctx, StatusCard("payoff.escrow_refund.sent", `payoff.refund.sent:${String(p["disbursement_id"] ?? e.id)}`, { disbursement_id: p["disbursement_id"] ?? null, amount_cents: p["amount_cents"] !== undefined ? String(p["amount_cents"]) : null, copy_tokens: { money: money(p["amount_cents"]), date: e.occurredAt.slice(0, 10) } })); return;
    }
    case "autodraft.enrollment.terminated": {
      const reason = String(p["reason"] ?? ""); const enr = ctx.store.get("autodraft_enrollments", String(p["enrollment_id"] ?? ""))?.data ?? {}; const t = ctx.exits.transfer;
      if (reason === "transfer_out" || (t && reason !== "payoff")) await sendToAll(deps, ctx, StatusCard("transfer.autopay_ends", `transfer.autopay:${t?.batch_id ?? String(p["batch_id"] ?? e.id)}`, { enrollment_id: p["enrollment_id"] ?? null, ends_on: p["terminated_on"] ?? null, copy_tokens: { date: String(p["terminated_on"] ?? ""), new_servicer: t?.new_servicer ?? "your new servicer", transfer_date: t?.respa_effective_date ?? "" } }));
      else await sendToAll(deps, ctx, StatusCard("payoff.autopay_terminated", `payoff.autopay:${String(p["enrollment_id"] ?? e.id)}`, { enrollment_id: p["enrollment_id"] ?? null, terminated_on: p["terminated_on"] ?? null, copy_tokens: { last4: String(enr["account_last4"] ?? enr["bank_account_last4"] ?? "") } }));
      return;
    }
    case "payoff.housekeeping.completed": return housekeepingCards(deps, ctx, e);
    case "lien_release.task_opened": case "lien_release.delivered_to_trustee": return releaseCards(deps, ctx, e);
    case "notice.mailed": { if (!TRANSFER_OUT_NOTICES.has(String(p["template"] ?? "")) || !e.loanId) return; return transferNotice(deps, ctx, e); }
    case "payment.misdirected.received": return misdirectedCard(deps, ctx, e);
    case "transfer.protection_window.expired": { const t = ctx.exits.transfer; await sendToAll(deps, ctx, StatusCard("transfer.after_window", `transfer.window_end:${String(p["batch_id"] ?? e.id)}`, { batch_id: p["batch_id"] ?? null, copy_tokens: { new_servicer: t?.new_servicer ?? "your new servicer", date: t?.respa_effective_date ?? "" } })); return; }
    case "case.sii.acknowledgment.returned": return successorDeclined(deps, ctx, e);
    case "case.opened": return rfiOpened(deps, ctx, e);
    case "case.rfi.responded": return rfiAnswered(deps, ctx, e);
    default: return;
  }
}

/** A message on a loan that has left servicing (paid off, closed, transferred out): the Thread stays open — the question is logged as a case through 32.2 (T8). */
async function onMessage(deps: FlowDeps, m: InboundMessage): Promise<FlowReply | null> {
  const loanId = m.subject?.loan_id ?? null; if (!loanId || !isUuid(m.party_id)) return null;
  const ctx = await context(deps, loanId);
  if (!(ctx.exits.paidInFull || ctx.exits.closed || ctx.exits.transfer)) return null;
  const r = await exec(deps, loanId, "32.2", "case.open", BORROWER_APP, { loan_id: loanId, party_id: m.party_id, kind: "general_inquiry", text: m.text, channel: m.channel });
  return { copy_key: "closed.question_logged", command: "case.open", card_instance_id: null, ...(typeof r["case_id"] === "string" ? {} : {}) };
}

export const FLOW_12_EXITS: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byLoan = new Map<string, DomainEvent[]>();
    for (const e of events) { const loan = e.loanId ?? (typeof pl(e)["loan_id"] === "string" ? String(pl(e)["loan_id"]) : null); if (!loan || !isUuid(loan)) continue; const list = byLoan.get(loan) ?? []; list.push(e); byLoan.set(loan, list); }
    for (const [loanId, list] of byLoan) {
      const ctx = await context(deps, loanId);
      if (!ctx.parties.length) continue;   // no party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-12.reaction", { event: e.type, loan_id: loanId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  /** The scheduled pass: the day-20 shortage line on every loan with an open shortage. */
  async tick(deps, nowIso) {
    const today = D(nowIso.slice(0, 10));
    const loans = await deps.runtime.db.query<{ loan_id: string }>(`SELECT DISTINCT loan_id FROM loan_events WHERE type = 'payoff.funds.short' AND loan_id IS NOT NULL`);
    for (const { loan_id } of loans) { try { const ctx = await context(deps, loan_id); if (ctx.parties.length) await shortageDay20(deps, ctx, today); } catch (err) { deps.logger?.error("borrower.flow.32-12.tick", { loan_id, error: err instanceof Error ? err.message : String(err) }); } }
  },
  onMessage,
};
