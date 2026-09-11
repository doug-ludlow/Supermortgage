/**
 * 32.9 — Servicing: insurance, PMI, ARM, life events, requests (spec/sections/32-borrower-experience/32-9-*.md): the
 * borrower-facing form of 9.x (insurance tracking, force-placement, flood), 10.1 (PMI cancellation), 7.3 (the initial ARM
 * notice), 4.4 (successors in interest), 4.1 / 4.5 (notices of error, complaints) and 7.6 / 16.1 (payoff requests).
 * Every card here is created through 32.1's `send_card` for the `borrower-comms` agent on the owning process's event;
 * nothing here computes a regulatory date or a money figure — dates come from `timers`, figures from the owning
 * process's own events. A typed message goes through the Intake Router (4.1): the deterministic FAKE classifier below
 * (recall-tuned rules over the 32.9 phrases; confidence < 0.6 → the generic reply, the human path stays open) routes it
 * to the owning case command, and the borrower commits by card.
 *
 *   fpi.first_notice.sent                          NoticeCard `insurance.fpi.first_notice` (INS_FPI_FIRST_MS3A; the 45-day date from REGX_1024_37C_FPI_FIRST_NOTICE_45) + UploadCard `insurance.fpi.upload` (T1)
 *   fpi.reminder.sent                              NoticeCard `insurance.fpi.reminder` (MS-3(B)/(C); max(t0 + 45, t1 + 15) from the engine) (T1)
 *   fpi.charge.assessed                            NoticeCard `insurance.fpi.placed` with the charge (T1/T2)
 *   fpi.lpi.cancelled_and_refunded                 StatusCard `insurance.fpi.refund_confirm` (INS_FPI_CANCEL_REFUND_CONFIRM) (T2)
 *   flood.map_change.notified                      NoticeCard `flood.map_change` (INS_FLOOD_MAP_CHANGE_NOTICE) — Dates: FDPA_4012A_E_FLOOD_FPI_NOTICE_45 (T3)
 *   mi.cancel.requested / mi.value_check_needed    StatusCard `pmi.request.received` / ChoiceCard `pmi.fee.choice` expiring with SM_MI_FEE_WAIT_60 (T4, T5)
 *   payment.received{mi_valuation_fee}             the fee receipt through 10.1's own `ledger.post{valuation_fee}` (T5)
 *   timer.breached{SM_MI_FEE_WAIT_60}              10.1 `pmi.*{fee_wait_expired}` → `mi.case.expired` → StatusCard `pmi.expired` (T5)
 *   mi.cancel.withdrawn                            StatusCard `pmi.withdrawn` (the fee refunded when no order was placed) (T5)
 *   notice.sent{NTC_HPA_4904A_CANCELLED}           NoticeCard `pmi.cancelled` (T4)
 *   arm.initial_notice.sent                        NoticeCard `arm.change` (NTC_REGZ_20D_ARM_INITIAL); Numbers carry the estimate (record.ts) (T6)
 *   message "my mother passed away…"               4.4 `sii.open` → `sii.potential_successor.identify` → `sii.documents.request` (the matrix row) → NTC_REGX_38B1VI_SII_DOCS; NoticeCard `successor.documents` + UploadCards (T7)
 *   message "you charged me a late fee I don't owe" 4.1 `case.noe.open` (+ the §1024.35(i) suppression) → NTC_REGX_35D_ACK; NoticeCard `case.noe.ack` with the response date (T8)
 *   spoken payoff request                          16.1 `computePayoffQuote{oral}` — the figure live, no clock; ChoiceCard `payoff.written.choice` (T9)
 *   case.opened{payoff_request}                    16.1 `computePayoffQuote{statement}` → `payoff.request.received` (REGZ_1026_36C3_PAYOFF_STMT_7BD) (T9, T10)
 *   notice.sent{NTC_REGZ_36C3_PAYOFF_STMT}         NoticeCard `payoff.statement` (T10)
 *   complaint + assertion of error                 4.5 `complaint.open` and 4.1 `case.noe.open` (linked); NTC_COMPLAINT_ACK + NTC_REGX_35D_ACK (T11)
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { addMonths, addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import type { ToolDef } from "../../../app/tools.ts";
import { EntityStore } from "../../../app/tools.ts";
import { SECTION_04_CASE_COMMANDS } from "../../../app/tools/section04.ts";
import { DOCUMENT_MATRIX, type TransferType } from "../../../domain/servicing-requests/successor.ts";
import type { AssertionType } from "../../../domain/servicing-requests/noe.ts";
import { VALUATION_FEES_CENTS } from "../../../domain/pmi/ops-10-1.ts";
import type { Recipient } from "../../../notices/channel.ts";
import { registerFlowTimers, timerLabel } from "../record.ts";
import type { BorrowerFlow, FlowDeps, FlowReply, InboundMessage } from "./index.ts";

export const FLOW_ID = "32.9";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const CASE_AGENT: Actor = { kind: "agent", id: "case" };
const PMI_AGENT: Actor = { kind: "agent", id: "pmi" };
const PAYOFF_AGENT: Actor = { kind: "agent", id: "payoff-release" };
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const RUN = { runId: "flow:32.9", modelVersion: "borrower flows (deterministic)", promptVersion: "32.9" } as const;
const CREATED_BY = "agent:borrower-comms";
const ET = "America/New_York";
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: string | bigint | number | null | undefined): string => (cents === null || cents === undefined || cents === "" ? "" : USD.format(Number(BigInt(String(cents))) / 100));

/** The servicer contact block the owning notices print — the FAKE servicer of every build stage (fixture values; never a real address or number). */
export const FAKE_SERVICER_CONTACT = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", online_channel: "the secure message center in the Supermortgage app", insurance_email: "insurance@example.test", error_resolution_address: "Supermortgage Error Resolution, PO Box 2, Testville TX 75001" } as const;

/** Notice codes this flow puts on cards (the owning process's rendered document; 02 §5). */
export const NOTICE_CODES_32_9 = { fpi_first: "INS_FPI_FIRST_MS3A", fpi_reminder_no_info: "INS_FPI_REMINDER_NOINFO_MS3B", fpi_reminder_insufficient: "INS_FPI_REMINDER_INSUFF_MS3C", fpi_refund_confirm: "INS_FPI_CANCEL_REFUND_CONFIRM", flood_map_change: "INS_FLOOD_MAP_CHANGE_NOTICE", pmi_cancelled: "NTC_HPA_4904A_CANCELLED", arm_initial: "NTC_REGZ_20D_ARM_INITIAL", sii_docs: "NTC_REGX_38B1VI_SII_DOCS", noe_ack: "NTC_REGX_35D_ACK", complaint_ack: "NTC_COMPLAINT_ACK", payoff_statement: "NTC_REGZ_36C3_PAYOFF_STMT" } as const;

// 32.9 §Timers: the borrower-visible clocks this process renders beside the 32.2 rows — the label is the allow-list's, the date is always `timers.due_at`.
registerFlowTimers([
  { code: "INS_FPI_FIRST_NOTICE_SLA_3BD", label: "Insurance notice to you by", calendar: "business days" },
  { code: "REGX_1024_37C_FPI_FIRST_NOTICE_45", label: "Lender-placed coverage could be charged from", calendar: "calendar days" },
  { code: "REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15", label: "Lender-placed coverage could be charged from", calendar: "calendar days" },
  { code: "REGX_1024_37E_FPI_RENEWAL_NOTICE_45", label: "Lender-placed coverage renews", calendar: "calendar days" },
  { code: "REGX_1024_37G_FPI_CANCEL_REFUND_15", label: "Lender-placed coverage cancelled and refunded by", calendar: "calendar days" },
  { code: "FDPA_4012A_E_FLOOD_FPI_NOTICE_45", label: "Flood coverage may be placed on", calendar: "calendar days" },
  { code: "FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30", label: "Flood coverage cancelled and refunded by", calendar: "calendar days" },
  { code: "SM_MI_FEE_WAIT_60", label: "Valuation fee needed by", calendar: "calendar days" },
  { code: "HPA_4904B_DENIAL_NOTICE_30", label: "PMI decision by", calendar: "calendar days" },
  { code: "REGX_1024_35D_NOE_ACK_5", label: "Acknowledgment by", calendar: "business days (federal)" },
  { code: "REGX_1024_35E_NOE_RESPONSE_30", label: "Answer by", calendar: "business days (federal)" },
  { code: "REGX_1024_35E_NOE_PAYOFF_RESPONSE_7", label: "Answer by", calendar: "business days (federal)" },
  { code: "REGX_1024_36C_RFI_ACK_5", label: "Acknowledgment by", calendar: "business days (federal)" },
  { code: "REGX_1024_38B1VI_SII_DOCS_DESC_5", label: "Document list to you by", calendar: "business days (federal)" },
  { code: "SM_COMPLAINT_RESOLVE_15", label: "Complaint answer by", calendar: "calendar days" },
  { code: "REGZ_1026_20D_INITIAL_NOTICE_210", label: "Rate-change notice to you by", calendar: "calendar days" },
]);

const REACTS = new Set(["fpi.case.opened", "fpi.first_notice.sent", "fpi.reminder.sent", "fpi.lpi_bound", "fpi.charge.assessed", "fpi.case.closed", "fpi.lpi.cancelled_and_refunded", "flood.map_change.notified", "flood.fpi.notice.sent",
  "mi.cancel.requested", "mi.value_check_needed", "mi.evidence.received", "mi.case.decided", "mi.cancelled", "mi.cancel.withdrawn", "mi.case.expired", "timer.breached", "payment.received",
  "arm.initial_notice.sent", "case.noe.opened", "case.complaint.opened", "case.sii.potential_successor.identified", "case.opened", "payoff.request.received", "payoff.statement.sent", "notice.sent"]);

// ---------------------------------------------------------------- the loan context one batch works on
interface Party { readonly party_id: string; readonly legal_name: string; readonly contact: P }
interface LoanFacts { readonly loan_id: string; readonly first_payment_date: string; readonly original_upb_cents: string; readonly servicer_loan_number: string; readonly state: string; readonly property_address: string; readonly note_rate_pct: string | null; readonly pi_cents: string | null; readonly escrow_payment_cents: string | null; readonly principal_cents: string | null; readonly escrow_cents: string | null }
interface Ctx { readonly loanId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly facts: LoanFacts | null; readonly now: string }
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);
const bpsToPct = (bps: unknown): string | null => (bps === null || bps === undefined ? null : (Number(bps) / 1000).toFixed(3));

/** Every party on a serviced loan with a conversation: the boarded borrowers, the application's borrowers before the link, a confirmed successor (02 §6). */
async function loanParties(deps: FlowDeps, loanId: string): Promise<Party[]> {
  return deps.runtime.db.query<Party & Record<string, unknown>>(
    `SELECT DISTINCT p.id AS party_id, p.legal_name, p.contact FROM parties p WHERE p.id IN (
       SELECT b.party_id FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL
       UNION SELECT ab.party_id FROM application_borrowers ab JOIN loans l ON l.origination_application_id = ab.application_id WHERE l.id = $1 AND ab.party_id IS NOT NULL
       UNION SELECT lp.party_id FROM loan_parties lp WHERE lp.loan_id = $1 AND lp.role = 'confirmed_successor' AND lp.ended_at IS NULL) ORDER BY p.legal_name`, [loanId]);
}
async function loanFacts(deps: FlowDeps, loanId: string): Promise<LoanFacts | null> {
  const db = deps.runtime.db;
  const loan = (await db.query<Record<string, unknown>>(`SELECT l.id, l.first_payment_date::text AS first_payment_date, l.original_upb_cents::text AS original_upb_cents, l.servicer_loan_number, pr.state, concat_ws(', ', pr.address_line1, pr.city, pr.state || ' ' || pr.postal_code) AS property_address FROM loans l LEFT JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  if (!loan) return null;
  const terms = (await db.query<Record<string, unknown>>(`SELECT note_rate_bps, pi_cents::text AS pi_cents, escrow_payment_cents::text AS escrow_payment_cents FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, id DESC LIMIT 1`, [loanId]))[0];
  const bal = await db.query<{ account: string; s: string }>(`SELECT account, sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account IN ('principal', 'escrow') GROUP BY account`, [loanId]);
  const principal = bal.find((b) => b.account === "principal")?.s ?? null; const escrow = bal.find((b) => b.account === "escrow")?.s ?? null;
  return { loan_id: loanId, first_payment_date: String(loan["first_payment_date"]), original_upb_cents: String(loan["original_upb_cents"]), servicer_loan_number: String(loan["servicer_loan_number"] ?? ""), state: String(loan["state"] ?? "AZ"), property_address: String(loan["property_address"] ?? ""), note_rate_pct: bpsToPct(terms?.["note_rate_bps"]), pi_cents: (terms?.["pi_cents"] as string | null) ?? null, escrow_payment_cents: (terms?.["escrow_payment_cents"] as string | null) ?? null, principal_cents: principal, escrow_cents: escrow };
}
async function context(deps: FlowDeps, loanId: string): Promise<Ctx> {
  const [events, records, parties, facts] = await Promise.all([deps.runtime.uow.events.byLoan(loanId), deps.runtime.entities.load({ loanId }), loanParties(deps, loanId), loanFacts(deps, loanId)]);
  const store = new EntityStore(); store.seed(records);
  return { loanId, events, store, parties, facts, now: deps.runtime.clock.now() };
}
const civilToday = (nowIso: string): PlainDate => wallClock(Date.parse(nowIso), ET).date;
const emailOf = (p: Party): string | undefined => { const c = p.contact; const e = (typeof c["email"] === "string" ? c["email"] : Array.isArray(c["emails"]) ? (c["emails"] as unknown[])[0] : undefined); return typeof e === "string" && e ? e : undefined; };
/** A Notice Registry recipient for a loan party: the borrower at the property, a portal user (the channel decision is the registry's). */
export function recipientFor(p: Party, facts: LoanFacts | null): Recipient { const email = emailOf(p); return { partyId: p.party_id, name: p.legal_name, mailingAddress: facts?.property_address || null, ...(email ? { email } : {}), portalUser: true }; }

// ---------------------------------------------------------------- bus helpers: the owning processes' tools as their own agents; the 4.x case commands through executeDef
const CASE_CMDS = new Map<string, ToolDef>(SECTION_04_CASE_COMMANDS.map((d) => [`${d.process} ${d.name}`, d]));
async function exec(deps: FlowDeps, loanId: string, process: string, name: string, actor: Actor, input: P): Promise<P> {
  const r = await deps.runtime.execute({ process, name, loanId, actor, input, run: { ...RUN } });
  return (r.output ?? {}) as P;
}
async function caseCmd(deps: FlowDeps, loanId: string, process: string, name: string, input: P, actor: Actor = CASE_AGENT): Promise<{ output: P; events: readonly DomainEvent[] }> {
  const def = CASE_CMDS.get(`${process} ${name}`); if (!def) throw new RangeError(`no ${process} case command ${name}`);
  const r = await deps.runtime.executeDef(def, { loanId, actor, input, run: { ...RUN } });
  return { output: (r.output ?? {}) as P, events: r.events };
}
async function timerRow(deps: FlowDeps, loanId: string, code: string, armedByEventId?: string | null): Promise<{ id: string; due_at: string | null; due_date: string | null; status: string } | undefined> {
  return (await deps.runtime.db.query<{ id: string; due_at: string | null; due_date: string | null; status: string }>(`SELECT id, due_at, due_date::text AS due_date, status::text AS status FROM timers WHERE loan_id = $1 AND code = $2 AND ($3::uuid IS NULL OR armed_by_event_id = $3) ORDER BY armed_at DESC LIMIT 1`, [loanId, code, armedByEventId ?? null]))[0];
}

// ---------------------------------------------------------------- card primitives (32.1's send_card for the borrower-comms agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string | null; readonly flow_key: string; readonly informational?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, loanId: string, party: Party, c: CardSpec, now: string): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { loan_id: loanId }, created_by: CREATED_BY, rationale: `32.9 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  // a card with no action (StatusCard, NoticeCard) is never the pinned ask: filed as read the moment it is sent (01 §3.1 "No action")
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", now, { informational: true, resolved_by: "system:flow-32.9" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx.loanId, p, c, ctx.now)); return ids; }
async function transitionAll(deps: FlowDeps, loanId: string, flowKeyPrefix: string, to: "resolved" | "superseded" | "cancelled" | "expired", evidence: P, now: string): Promise<number> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_loan_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE $2`, [loanId, `${flowKeyPrefix}%`]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, to, "system", now, { ...evidence, resolved_by: "system:flow-32.9" });
  return rows.length;
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true });
const NoticeCard = (copy_key: string, flow_key: string, notice_code: string, props: P = {}): CardSpec => ({ kind: "NoticeCard", copy_key, props: { notice_code, title: "", rendered_document_id: randomUUID(), plain_language: "", line: "", template_version: null, channel: "app", ...props }, flow_key, informational: true });

// ---------------------------------------------------------------- the Intake Router (4.1): a deterministic FAKE classifier over the 32.9 phrases (recall-tuned; the LLM router is not wired)
export type IntakeKind = "noe" | "rfi" | "complaint" | "complaint_and_noe" | "sii_inquiry" | "payoff_request" | "pmi_cancel" | "pmi_withdraw" | "general_inquiry";
export interface IntakeClassification { readonly kind: IntakeKind; readonly confidence: number; readonly assertion_category: AssertionType | null; readonly needs_human: boolean }
const DEATH = /\b(passed away|passed|died|death|deceased|late (mother|father|husband|wife|spouse|parent))\b|\bmy (mother|father|husband|wife|spouse|parent|dad|mom)\b.*\b(passed|died|death)/i;
const PAYOFF = /\bpay-?off\b|\bpay (it |my loan |the loan )?off\b/i;
const COMPLAINT = /\b(unhappy|frustrat\w*|complain\w*|terrible|awful|unacceptable|poor service|rude|nobody (called|answered|responded|got back)|no one (called|answered|responded))\b/i;
const ERROR_CLAIM = /\b(don'?t|do not|didn'?t|did not|never) (owe|owed|authori[sz]e|receive|received|get|got)\b|\b(shouldn'?t|should not) have\b|\b(wrong(ly)?|error|mistake|incorrect(ly)?|misapplied|not owed|in error|dispute)\b|\bcharged me\b/i;
const ERROR_SUBJECT = /\b(fee|charge|payment|escrow|payoff|balance|late|interest|statement)\b/i;
const PMI = /\b(pmi|mortgage insurance)\b/i;
const WITHDRAW = /\b(withdraw|cancel (my |the )?request|never mind|forget it)\b/i;
export function classifyIntake(text: string): IntakeClassification {
  const t = text.trim();
  if (DEATH.test(t)) return { kind: "sii_inquiry", confidence: 0.95, assertion_category: null, needs_human: false };
  if (PAYOFF.test(t)) return { kind: "payoff_request", confidence: 0.95, assertion_category: null, needs_human: false };
  if (PMI.test(t) && WITHDRAW.test(t)) return { kind: "pmi_withdraw", confidence: 0.9, assertion_category: null, needs_human: false };
  if (PMI.test(t) && /\b(cancel|remove|drop|get rid of|stop)\b/i.test(t)) return { kind: "pmi_cancel", confidence: 0.9, assertion_category: null, needs_human: false };
  const noe = ERROR_CLAIM.test(t) && ERROR_SUBJECT.test(t); const complaint = COMPLAINT.test(t);
  const category: AssertionType | null = noe ? (/\blate (fee|charge)\b|\bfee\b/i.test(t) ? "b5" : /\bpayoff\b/i.test(t) ? "b6" : /\bescrow\b/i.test(t) ? "b3" : /\bpayment\b/i.test(t) ? "b1" : "b11") : null;
  if (noe && complaint) return { kind: "complaint_and_noe", confidence: 0.85, assertion_category: category, needs_human: false };
  if (noe) return { kind: "noe", confidence: 0.9, assertion_category: category, needs_human: false };
  if (complaint) return { kind: "complaint", confidence: 0.85, assertion_category: null, needs_human: false };
  return { kind: "general_inquiry", confidence: 0.5, assertion_category: null, needs_human: true };
}

// ---------------------------------------------------------------- payoff facts for 16.1 (the engine computes; the flow only names the record's inputs)
/** Paid-through and next due from the record: the first payment date advanced by the contractual installments posted (and past the calendar for a seasoned loan the ledger predates). */
export function paidThrough(firstPaymentDate: PlainDate, installmentsPosted: number, today: PlainDate): { next_due: PlainDate; lpi_due: PlainDate } {
  let next = addMonths(firstPaymentDate, installmentsPosted);
  while (addMonths(next, 1) <= today) next = addMonths(next, 1);
  return { next_due: next, lpi_due: addMonths(next, -1) };
}
function payoffInputs(ctx: Ctx): P {
  const f = ctx.facts; if (!f) throw new RangeError(`loan ${ctx.loanId} has no record`);
  const posted = ctx.store.list("payments", (d) => d.loan_id === ctx.loanId && d.status === "posted" && (d.designation ?? "contractual") === "contractual").length;
  const today = civilToday(ctx.now); const pt = paidThrough(f.first_payment_date as PlainDate, posted, today);
  return { loan_id: ctx.loanId, upb_cents: f.principal_cents ?? f.original_upb_cents, rate_pct: f.note_rate_pct ?? "0.000", lpi_due: pt.lpi_due, state: f.state, ledger_snapshot_id: `ledger:${ctx.loanId}:${ctx.now}` };
}

// ---------------------------------------------------------------- reactions
async function fpiCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const caseId = String(p["case_id"] ?? "");
  switch (e.type) {
    case "fpi.first_notice.sent": {
      const gate = await timerRow(deps, ctx.loanId, "REGX_1024_37C_FPI_FIRST_NOTICE_45");
      const opened = last(ctx, "fpi.case.opened", (x) => x["case_id"] === caseId);
      await sendToAll(deps, ctx, NoticeCard("insurance.fpi.first_notice", `fpi.first:${caseId}`, NOTICE_CODES_32_9.fpi_first, { delivered_at: e.occurredAt, channel: "mail", mailed_at: e.occurredAt, rendered_document_id: String(p["notice_id"] ?? randomUUID()), fpi_case_id: caseId, tone: "caution",
        copy_tokens: { status: String(opened?.payload["kind"] ?? "lapsed").replace("nonrenewed", "was not renewed").replace("cancelled", "was cancelled").replace("expired", "expired"), date: String(opened?.payload["lapse_start"] ?? p["first_notice_mailed_at"] ?? ""), deadline: gate?.due_date ?? String(p["earliest_charge_date"] ?? "") }, next_event_label: timerLabel("REGX_1024_37C_FPI_FIRST_NOTICE_45"), next_event_at: gate?.due_at ?? null }));
      await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "insurance.fpi.upload", flow_key: `fpi.upload:${caseId}`, command_ref: "insurance.submitEvidence", props: { document_class: "homeowners_policy", accepted_examples: ["declarations page", "binder", "renewal notice"], why: "", title: "", fpi_case_id: caseId, command_args: { servicing: true, fpi_case_id: caseId, kind: "hoi_declaration" } } });
      return;
    }
    case "fpi.reminder.sent": {
      const gate = await timerRow(deps, ctx.loanId, "REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15");
      const opened = last(ctx, "fpi.case.opened", (x) => x["case_id"] === caseId);
      await sendToAll(deps, ctx, NoticeCard("insurance.fpi.reminder", `fpi.reminder:${caseId}`, String(p["template"] ?? NOTICE_CODES_32_9.fpi_reminder_no_info), { delivered_at: e.occurredAt, channel: "mail", mailed_at: e.occurredAt, rendered_document_id: String(p["notice_id"] ?? randomUUID()), fpi_case_id: caseId, tone: "caution",
        copy_tokens: { deadline: String(p["earliest_charge_date"] ?? gate?.due_date ?? ""), from: String(opened?.payload["lapse_start"] ?? "") }, next_event_label: timerLabel("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15"), next_event_at: gate?.due_at ?? null }));
      return;
    }
    case "fpi.charge.assessed": {
      const bound = last(ctx, "fpi.lpi_bound", (x) => x["case_id"] === caseId);
      await sendToAll(deps, ctx, NoticeCard("insurance.fpi.placed", `fpi.placed:${caseId}`, String(p["notice_template"] ?? "INS_FPI_PLACED_NOTICE"), { delivered_at: e.occurredAt, fpi_case_id: caseId, amount_cents: String(p["amount_cents"] ?? bound?.payload["premium_cents"] ?? "0"), copy_tokens: { money: money(String(bound?.payload["premium_cents"] ?? p["amount_cents"] ?? "0")), date: String(p["period_start"] ?? bound?.payload["effective"] ?? "") } }));
      return;
    }
    case "fpi.lpi.cancelled_and_refunded": {
      await transitionAll(deps, ctx.loanId, "fpi.upload:", "resolved", { outcome: "evidence_received", binding_id: p["binding_id"] ?? null }, ctx.now);
      const refund = last(ctx, "fpi.refund.paid") ?? e;
      await sendToAll(deps, ctx, StatusCard("insurance.fpi.refund_confirm", `fpi.refund:${String(p["binding_id"] ?? e.id)}`, { notice_code: NOTICE_CODES_32_9.fpi_refund_confirm, refund_cents: String(refund.payload["refund_cents"] ?? p["refund_cents"] ?? "0"), copy_tokens: { money: money(String(refund.payload["refund_cents"] ?? p["refund_cents"] ?? "0")) }, binding_id: p["binding_id"] ?? null }));
      return;
    }
    case "fpi.case.closed": { if (String(p["closed_reason"]) === "closed_evidence") await transitionAll(deps, ctx.loanId, "fpi.upload:", "resolved", { outcome: "evidence_received" }, ctx.now); return; }
    default: return;
  }
}
async function floodCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  if (e.type !== "flood.map_change.notified" || p["coverage_required"] !== true) return;
  const gate = await timerRow(deps, ctx.loanId, "FDPA_4012A_E_FLOOD_FPI_NOTICE_45");
  await sendToAll(deps, ctx, NoticeCard("flood.map_change", `flood.map_change:${String(p["certificate_id"] ?? e.id)}`, NOTICE_CODES_32_9.flood_map_change, { delivered_at: e.occurredAt, rendered_document_id: String(p["notice_id"] ?? randomUUID()), tone: "caution", amount_cents: p["required_cents"] !== null && p["required_cents"] !== undefined ? String(p["required_cents"]) : undefined,
    copy_tokens: { date: String(p["effective_date"] ?? ""), zone: String(p["new_zone"] ?? ""), money: money(p["required_cents"] as string | null ?? null), deadline: gate?.due_date ?? String(p["borrower_deadline"] ?? "") }, next_event_label: timerLabel("FDPA_4012A_E_FLOOD_FPI_NOTICE_45"), next_event_at: gate?.due_at ?? null }));
}
async function pmiCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const caseId = String(p["case_id"] ?? "");
  switch (e.type) {
    case "mi.cancel.requested": {
      await transitionAll(deps, ctx.loanId, "pmi.ask:", "resolved", { case_id: caseId }, ctx.now);
      const due = await timerRow(deps, ctx.loanId, "HPA_4904B_DENIAL_NOTICE_30");
      await sendToAll(deps, ctx, StatusCard("pmi.request.received", `pmi.received:${caseId}`, { case_id: caseId, copy_tokens: { date: due?.due_date ?? String(p["decision_due"] ?? "") }, next_event_label: timerLabel("HPA_4904B_DENIAL_NOTICE_30"), next_event_at: due?.due_at ?? null }));
      return;
    }
    case "mi.value_check_needed": {
      const wait = await timerRow(deps, ctx.loanId, "SM_MI_FEE_WAIT_60", e.id);
      const options = (Array.isArray(p["options"]) ? (p["options"] as { type: string; fee_cents: unknown }[]) : []); const bpo = options.find((o) => o.type === "bpo"); const fee = String(bpo?.fee_cents ?? VALUATION_FEES_CENTS["bpo"]);
      const openCase = ctx.store.list("mi_cases", (d) => d.loan_id === ctx.loanId && !["closed", "withdrawn", "expired"].includes(String(d.status)))[0];
      await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "pmi.fee.choice", flow_key: `pmi.fee:${String(p["evaluation_id"] ?? e.id)}`, command_ref: "payment.makeOneTime", expires_at: wait?.due_at ?? null,
        props: { title: "", helper: "", options: [{ id: "pay_fee", label: `Pay the ${money(fee)} valuation fee`, is_primary: true }, { id: "not_now", label: "Not now" }], command: "payment.makeOneTime", command_args_by_option: { pay_fee: { amount_cents: fee, designation: "mi_valuation_fee", date: civilToday(ctx.now), account: { last4: "0001" }, mi_case_id: openCase?.id ?? null, valuation_kind: "bpo" }, not_now: {} }, no_command_options: ["not_now"], copy_tokens: { money: money(fee) }, fee_cents: fee, mi_case_id: openCase?.id ?? null, evaluation_id: p["evaluation_id"] ?? null, fee_wait_timer: wait ? { code: "SM_MI_FEE_WAIT_60", due_at: wait.due_at } : null } });
      return;
    }
    case "payment.received": {
      if (String(p["designation"]) !== "mi_valuation_fee") return;
      // the borrower paid the tabulated valuation fee: 10.1's own ledger tool records the receipt (`mi.evidence.received{kind=fee}` — closes SM_MI_FEE_WAIT_60, opens FNMA_F102_VALUATION_FEE_GATE); the pmi agent's act, never the UI's
      const fee = String(p["amount_cents"] ?? VALUATION_FEES_CENTS["bpo"]); const on = String(p["received_on"] ?? civilToday(ctx.now));
      await exec(deps, ctx.loanId, "10.1", "ledger.post", PMI_AGENT, { loan_id: ctx.loanId, valuation_fee: true, fee_cents: fee, valuation_kind: "bpo", received_on: on, funding_account: "corporate_clearing", entry_set: { effectiveDate: on, description: `PMI valuation fee received (F-1-02 BPO) — payment ${String(p["payment_id"] ?? "")}`, lines: [{ account: { scope: "corporate", account: "corporate_cash" }, amountCents: BigInt(fee), ruleRef: "10.1:F-1-02:valuation_fee_receipt" }, { account: { scope: "corporate", account: "advance_receivable" }, amountCents: -BigInt(fee), ruleRef: "10.1:F-1-02:valuation_fee_receipt" }] } });
      return;
    }
    case "mi.evidence.received": {
      if (String(p["kind"]) !== "fee") return;
      await transitionAll(deps, ctx.loanId, "pmi.fee:", "resolved", { outcome: "fee_received", amount_cents: p["amount_cents"] ?? null }, ctx.now);
      await sendToAll(deps, ctx, StatusCard("pmi.fee.received", `pmi.fee.received:${e.id}`, { amount_cents: String(p["amount_cents"] ?? ""), copy_tokens: { money: money(String(p["amount_cents"] ?? "0")) } }));
      return;
    }
    case "timer.breached": {
      if (String(p["code"]) !== "SM_MI_FEE_WAIT_60") return;
      // the owning process's own breach handling ("case → expired; closing letter"): 10.1 pmi.*{fee_wait_expired} as the pmi agent
      await exec(deps, ctx.loanId, "10.1", "pmi.*", PMI_AGENT, { op: "fee_wait_expired", loan_id: ctx.loanId, timer_id: p["timer_id"] ?? null, expired_on: civilToday(ctx.now) });
      return;
    }
    case "mi.case.expired": {
      await transitionAll(deps, ctx.loanId, "pmi.fee:", "expired", { reason: "SM_MI_FEE_WAIT_60 breached", case_id: caseId }, ctx.now);
      await sendToAll(deps, ctx, StatusCard("pmi.expired", `pmi.expired:${caseId}`, { case_id: caseId }));
      return;
    }
    case "mi.cancel.withdrawn": {
      await transitionAll(deps, ctx.loanId, "pmi.fee:", "cancelled", { reason: "request withdrawn", case_id: caseId }, ctx.now);
      await transitionAll(deps, ctx.loanId, "pmi.withdraw:", "resolved", { case_id: caseId }, ctx.now);
      const refund = String(p["fee_refund_cents"] ?? "0");
      await sendToAll(deps, ctx, StatusCard(BigInt(refund) > 0n ? "pmi.withdrawn" : "pmi.withdrawn.no_refund", `pmi.withdrawn:${caseId}`, { case_id: caseId, refund_cents: refund, copy_tokens: { money: money(refund) } }));
      return;
    }
    case "mi.cancelled": {
      await transitionAll(deps, ctx.loanId, "pmi.fee:", "cancelled", { reason: "PMI cancelled", effective: p["effective"] ?? null }, ctx.now);
      await sendToAll(deps, ctx, StatusCard("pmi.cancelled.status", `pmi.cancelled:${String(p["effective"] ?? e.id)}`, { copy_tokens: { date: String(p["effective"] ?? p["effective_on"] ?? "") } }));
      return;
    }
    default: return;
  }
}
async function noticeCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const template = String(p["template"] ?? ""); const noticeId = String(p["notice_id"] ?? randomUUID());
  const channels = (Array.isArray(p["channels"]) ? (p["channels"] as { channel?: string }[]) : []); const mailed = channels.some((c) => String(c.channel ?? "").startsWith("mail"));
  const delivery: P = mailed ? { channel: "mail", mailed_at: e.occurredAt, delivered_at: e.occurredAt } : { channel: "app", delivered_at: e.occurredAt };
  switch (template) {
    case NOTICE_CODES_32_9.pmi_cancelled: {
      const cancelled = last(ctx, "mi.cancelled");
      await sendToAll(deps, ctx, NoticeCard("pmi.cancelled", `pmi.notice:${noticeId}`, template, { ...delivery, rendered_document_id: noticeId, template_version: p["template_version"] ?? null, copy_tokens: { date: String(cancelled?.payload["effective"] ?? cancelled?.payload["effective_on"] ?? "") } })); return;
    }
    case NOTICE_CODES_32_9.noe_ack: {
      const opened = last(ctx, "case.noe.opened"); const caseId = String(opened?.payload["case_id"] ?? ""); const assertions = (opened?.payload["assertions"] as { response_due?: string }[] | undefined) ?? [];
      const response = await timerRow(deps, ctx.loanId, "REGX_1024_35E_NOE_RESPONSE_30", opened?.id ?? null) ?? await timerRow(deps, ctx.loanId, "REGX_1024_35E_NOE_PAYOFF_RESPONSE_7", opened?.id ?? null);
      const bar = await timerRow(deps, ctx.loanId, "REGX_1024_35I_CREDIT_SUPPRESS_60", opened?.id ?? null);
      await sendToAll(deps, ctx, NoticeCard("case.noe.ack", `noe.ack:${noticeId}`, template, { ...delivery, rendered_document_id: noticeId, template_version: p["template_version"] ?? null, case_id: caseId, response_due: response?.due_date ?? assertions[0]?.response_due ?? null, credit_reporting_suppressed_through: bar?.due_date ?? null,
        copy_tokens: { date: response?.due_date ?? assertions[0]?.response_due ?? "", until: bar?.due_date ?? "", received: String(opened?.payload["receipt_date"] ?? "") }, next_event_label: timerLabel("REGX_1024_35E_NOE_RESPONSE_30"), next_event_at: response?.due_at ?? null })); return;
    }
    case NOTICE_CODES_32_9.complaint_ack: {
      const opened = last(ctx, "case.complaint.opened"); const resolve = await timerRow(deps, ctx.loanId, "SM_COMPLAINT_RESOLVE_15", opened?.id ?? null);
      await sendToAll(deps, ctx, NoticeCard("case.complaint.ack", `complaint.ack:${noticeId}`, template, { ...delivery, rendered_document_id: noticeId, template_version: p["template_version"] ?? null, case_id: opened?.payload["case_id"] ?? null, linked_noe_case_id: opened?.payload["linked_noe_case_id"] ?? null, copy_tokens: { date: resolve?.due_date ?? "" }, next_event_label: timerLabel("SM_COMPLAINT_RESOLVE_15"), next_event_at: resolve?.due_at ?? null })); return;
    }
    case NOTICE_CODES_32_9.sii_docs: {
      const identified = last(ctx, "case.sii.potential_successor.identified"); const partyId = String(identified?.payload["party_id"] ?? ""); const described = last(ctx, "case.sii.documents.described");
      const party = (await deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT id AS party_id, legal_name, contact FROM parties WHERE id = $1`, [partyId]))[0]; if (!party) return;
      const docs = (described?.payload["documents"] as string[] | undefined) ?? [];
      await sendCard(deps, ctx.loanId, party, NoticeCard("successor.documents", `sii.docs:${noticeId}`, template, { ...delivery, rendered_document_id: noticeId, template_version: p["template_version"] ?? null, case_id: identified?.payload["case_id"] ?? null, documents: docs, transfer_type: described?.payload["transfer_type"] ?? null, copy_tokens: { documents: docs.map(docLabel).join("; ") } }), ctx.now);
      for (const d of docs) await sendCard(deps, ctx.loanId, party, { kind: "UploadCard", copy_key: "successor.upload", flow_key: `sii.upload:${String(identified?.payload["case_id"] ?? "")}:${d}`, props: { document_class: d, accepted_examples: [docLabel(d)], why: "", title: "", copy_tokens: { document: docLabel(d) }, case_id: identified?.payload["case_id"] ?? null } }, ctx.now);
      return;
    }
    case NOTICE_CODES_32_9.payoff_statement: {
      const computed = last(ctx, "payoff.quote.computed", (x) => x["quote_type"] === "statement");
      await transitionAll(deps, ctx.loanId, "payoff.written:", "resolved", { statement_notice_id: noticeId }, ctx.now);
      await sendToAll(deps, ctx, NoticeCard("payoff.statement", `payoff.statement:${noticeId}`, template, { ...delivery, rendered_document_id: noticeId, template_version: p["template_version"] ?? null, statement_id: p["statement_id"] ?? null, amount_cents: computed ? String(computed.payload["total_cents"]) : undefined, good_through: computed?.payload["good_through"] ?? null, copy_tokens: { date: String(computed?.payload["good_through"] ?? ""), money: money(computed ? String(computed.payload["total_cents"]) : null) } })); return;
    }
    case NOTICE_CODES_32_9.fpi_refund_confirm: {
      const refund = last(ctx, "fpi.refund.paid");
      await sendToAll(deps, ctx, NoticeCard("insurance.fpi.refund_confirm", `fpi.refund.notice:${noticeId}`, template, { ...delivery, rendered_document_id: noticeId, template_version: p["template_version"] ?? null, refund_cents: String(refund?.payload["refund_cents"] ?? "0"), copy_tokens: { money: money(String(refund?.payload["refund_cents"] ?? "0")) } })); return;
    }
    default: return;
  }
}
/** The 4.4 matrix's document codes in the borrower's words (the notice itself is the registry's). */
export const docLabel = (code: string): string => ({ death_certificate: "a death certificate", recorded_deed: "the recorded deed", letters_testamentary: "letters testamentary (from the probate court)", will: "the will", divorce_decree: "the divorce decree", separation_agreement: "the separation agreement", trust_certification: "the trust certification" } as Record<string, string>)[code] ?? code.replace(/_/g, " ");

async function armCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const row = last(ctx, "arm.schedule.row_created", (x) => x["initial"] === true);
  await sendToAll(deps, ctx, NoticeCard("arm.change", `arm.initial:${String(p["notice_id"] ?? e.id)}`, NOTICE_CODES_32_9.arm_initial, { delivered_at: e.occurredAt, channel: String(p["channel"]) === "mail" ? "mail" : "app", ...(String(p["channel"]) === "mail" ? { mailed_at: e.occurredAt } : {}), rendered_document_id: String(p["notice_id"] ?? randomUUID()), basis: p["basis"] ?? "estimate", amount_cents: p["est_pi_cents"] !== undefined ? String(p["est_pi_cents"]) : undefined,
    copy_tokens: { date: String(row?.payload["first_new_payment_due"] ?? row?.payload["change_date"] ?? ""), money: money(p["est_pi_cents"] !== undefined ? String(p["est_pi_cents"]) : null), rate: `${String(p["est_rate_pct"] ?? "")}%` } }));
}
async function payoffCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  if (e.type === "case.opened") {
    if (String(p["case_type"]) !== "payoff_request") return;
    if (has(ctx, "payoff.request.received", (x) => x["case_id"] === p["case_id"])) return;
    // the written request (a typed message, or the one-tap conversion of a spoken quote) recorded by 16.1 as `payoff.request.received{written}` — the §1026.36(c)(3) clock starts here, at the receipt instant the case carries
    const requestId = `pr-${String(p["case_id"])}`; const inputs = payoffInputs(ctx); const received = String(p["received_at"] ?? e.occurredAt);
    await exec(deps, ctx.loanId, "16.1", "computePayoffQuote", PAYOFF_AGENT, { ...inputs, quote_type: "statement", request_id: requestId, quote_id: `pq-${String(p["case_id"])}`, channel: "portal", written: true, received_at: received, requester_type: "borrower", borrower_party_ids: ctx.parties.map((x) => x.party_id), delivery_channel_requested: "portal", good_through: addDays(civilToday(received), 15), case_id: p["case_id"] });
    return;
  }
  if (e.type === "payoff.request.received") {
    const due = await timerRow(deps, ctx.loanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD", e.id);
    await sendToAll(deps, ctx, StatusCard("payoff.requested", `payoff.requested:${String(p["request_id"] ?? e.id)}`, { request_id: p["request_id"] ?? null, next_event_label: timerLabel("REGZ_1026_36C3_PAYOFF_STMT_7BD"), next_event_at: due?.due_at ?? null, copy_tokens: { date: due?.due_date ?? "" } }));
  }
}
async function caseCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  if (e.type === "case.noe.opened") {
    const response = await timerRow(deps, ctx.loanId, "REGX_1024_35E_NOE_RESPONSE_30", e.id); const ack = await timerRow(deps, ctx.loanId, "REGX_1024_35D_NOE_ACK_5", e.id);
    await sendToAll(deps, ctx, StatusCard("case.noe.opened", `noe.opened:${String(p["case_id"])}`, { case_id: p["case_id"], copy_tokens: { date: [ack?.due_date ?? "", response?.due_date ?? ""] as unknown as string }, next_event_label: timerLabel("REGX_1024_35D_NOE_ACK_5"), next_event_at: ack?.due_at ?? null, ack_due: ack?.due_date ?? null, response_due: response?.due_date ?? null }));
  }
}

// ---------------------------------------------------------------- the message paths (Intake Router → the owning case command → the card the borrower commits by)
async function partyOf(deps: FlowDeps, partyId: string): Promise<Party | undefined> { return (await deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT id AS party_id, legal_name, contact FROM parties WHERE id = $1`, [partyId]))[0]; }
function contactPayload(party: Party, facts: LoanFacts | null): P { return { ...FAKE_SERVICER_CONTACT, borrower_name: party.legal_name, account_last4: (facts?.servicer_loan_number ?? "").slice(-4) || "0000", property_address: facts?.property_address ?? "" }; }

async function onMessage(deps: FlowDeps, m: InboundMessage): Promise<FlowReply | null> {
  const c = classifyIntake(m.text);
  const claimed = (m as InboundMessage & { claimed_subject?: { loan_id?: string | null } | null }).claimed_subject ?? null;
  const loanId = m.subject?.loan_id ?? (c.kind === "sii_inquiry" ? claimed?.loan_id ?? null : null);
  if (!loanId || c.needs_human) return null;
  const ctx = await context(deps, loanId); const today = civilToday(m.at);
  const party = ctx.parties.find((x) => x.party_id === m.party_id) ?? (await partyOf(deps, m.party_id));
  if (!party) return null;
  const receipt = { receipt_date: today, receipt_at: m.at, state: ctx.facts?.state ?? null, channel: m.channel };
  switch (c.kind) {
    case "sii_inquiry": {
      // 4.4: anyone reporting a death opens the case; the reporter is a potential successor with a limited Record; the documents come from the matrix row (death of a relative); no account information before confirmation
      const caseId = `sii-${loanId.slice(0, 8)}-${randomUUID().slice(0, 8)}`; const transfer: TransferType = "death_relative"; const docs = [...DOCUMENT_MATRIX[transfer]];
      await caseCmd(deps, loanId, "4.4", "sii.open", { case_id: caseId, notice_source: "app_message", transfer_type: transfer, notice_date: today, state: ctx.facts?.state ?? null, message_id: m.message_id });
      await caseCmd(deps, loanId, "4.4", "sii.potential_successor.identify", { case_id: caseId, party_id: m.party_id, identified_on: today });
      await caseCmd(deps, loanId, "4.4", "sii.documents.request", { case_id: caseId, documents: docs, transfer_type: transfer });
      await caseCmd(deps, loanId, "4.1", "case.notice.send", { case_id: caseId, template: NOTICE_CODES_32_9.sii_docs, recipients: [recipientFor(party, ctx.facts)], payload: { ...FAKE_SERVICER_CONTACT, deceased_or_transferor: "your mother", documents: docs.map(docLabel), questions: [], business_days_after_receipt: 0 } });
      return { copy_key: "successor.intro" };
    }
    case "noe": case "complaint_and_noe": case "complaint": {
      const both = c.kind === "complaint_and_noe"; let complaintId: string | null = null; let noeId: string | null = null;
      if (c.kind !== "noe") {
        complaintId = `cmp-${loanId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const r = await caseCmd(deps, loanId, "4.5", "complaint.open", { case_id: complaintId, received_on: today, received_at: m.at, state: ctx.facts?.state ?? null, channel: m.channel === "voice" ? "voice_transcript" : "web_form", source: "borrower_direct", text: m.text, flags: [] });
        noeId = (r.output["linked_noe_case_id"] as string | null) ?? (both ? `noe-${complaintId}` : null);
        await caseCmd(deps, loanId, "4.5", "complaint.acknowledge", { case_id: complaintId, channel: "written" });
        await caseCmd(deps, loanId, "4.1", "case.notice.send", { case_id: complaintId, template: NOTICE_CODES_32_9.complaint_ack, recipients: [recipientFor(party, ctx.facts)], payload: { ...contactPayload(party, ctx.facts), received_on: today, response_by: (await timerRow(deps, loanId, "SM_COMPLAINT_RESOLVE_15"))?.due_date ?? addDays(today, 15), ny: ctx.facts?.state === "NY", business_days_after_receipt: 0 } });
      }
      if (c.kind !== "complaint" || (noeId && m.channel !== "voice")) {
        // 4.1: any assertion that something was done wrong is a notice of error (a written channel — the app counts as written); the §1024.35(i) suppression row follows a payment-related assertion
        noeId = noeId ?? `noe-${loanId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const r = await caseCmd(deps, loanId, "4.1", "case.noe.open", { case_id: noeId, ...receipt, assertions: [{ id: "a1", category: c.assertion_category ?? "b11", description: m.text, identifiable: true }], ...(complaintId ? { linked_case_ids: [complaintId] } : {}), message_id: m.message_id });
        const assertions = (r.output["assertions"] as { id: string; response_due: string }[] | undefined) ?? [];
        await caseCmd(deps, loanId, "4.1", "case.notice.send", { case_id: noeId, template: NOTICE_CODES_32_9.noe_ack, recipients: [recipientFor(party, ctx.facts)], payload: { ...contactPayload(party, ctx.facts), received_on: today, business_days_after_receipt: 0, assertions: assertions.map((a, n) => ({ n: n + 1, text: m.text, response_due: a.response_due })) } });
      }
      return { copy_key: both ? "case.complaint.with_noe" : "case.ack" };
    }
    case "payoff_request": {
      if (m.channel === "voice") {
        // 7.6 / 16.1 rule 11: a spoken request gets the engine's figure live (identity verified by the session) — no §1026.36(c)(3) clock; the one-tap written request starts it
        const inputs = payoffInputs(ctx); const quoteId = `pq-oral-${loanId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const q = await exec(deps, loanId, "16.1", "computePayoffQuote", PAYOFF_AGENT, { ...inputs, quote_type: "oral", mode: "oral", channel: "ai_voice", identity_verified: true, quote_id: quoteId, requested_at: m.at, good_through: addDays(today, 15) });
        const oral = (q["oral"] as { transcript?: string[] } | null) ?? null;
        const cardId = (await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "payoff.written.choice", flow_key: `payoff.written:${quoteId}`, command_ref: "case.open", props: { title: "", helper: "", options: [{ id: "send", label: "Yes, send it", is_primary: true }, { id: "not_now", label: "Not now" }], command: "case.open", command_args_by_option: { send: { kind: "payoff_request", text: `Written payoff statement requested after the spoken quote ${quoteId}` }, not_now: {} }, no_command_options: ["not_now"], oral_quote_id: quoteId, affirmatives: ["send it", "yes send it", "send the statement"] } }, [party]))[0] ?? null;
        return { copy_key: "payoff.quote_spoken", body_text: `{{copy:payoff.quote_spoken}} ${(oral?.transcript ?? []).join(" ")}`, card_instance_id: cardId };
      }
      // typed = written: the Intake Router's case (32.2 `case.open{payoff_request}` for the party who wrote) — the flow's `case.opened` reaction records the 16.1 request and the 7-BD clock starts
      const r = await exec(deps, loanId, "32.2", "case.open", BORROWER_APP, { loan_id: loanId, kind: "payoff_request", text: m.text, party_id: m.party_id, message_id: m.message_id });
      return { copy_key: "payoff.requested", command: "case.open", body_text: `{{copy:payoff.requested}}`, ...(typeof r["case_id"] === "string" ? {} : {}) };
    }
    case "pmi_cancel": {
      const cardId = (await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "pmi.cancel.choice", flow_key: `pmi.ask:${today}`, command_ref: "pmi.requestCancellation", props: { title: "", helper: "", options: [{ id: "ask", label: "Yes, ask to cancel", is_primary: true }, { id: "not_now", label: "Not now" }], command: "pmi.requestCancellation", command_args_by_option: { ask: { request: { basis: "original_value" } }, not_now: {} }, no_command_options: ["not_now"], affirmatives: ["cancel it", "yes cancel", "ask to cancel"] } }, [party]))[0] ?? null;
      return { copy_key: "pmi.cancel.intro", card_instance_id: cardId };
    }
    case "pmi_withdraw": {
      const open = ctx.store.list("mi_cases", (d) => d.loan_id === loanId && !["closed", "withdrawn", "expired"].includes(String(d.status)))[0]; if (!open) return null;
      const cardId = (await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "pmi.withdraw.choice", flow_key: `pmi.withdraw:${open.id}`, command_ref: "pmi.requestCancellation", props: { title: "", helper: "", options: [{ id: "withdraw", label: "Yes, withdraw", is_primary: true }, { id: "keep", label: "Keep going" }], command: "pmi.requestCancellation", command_args_by_option: { withdraw: { withdraw: true, case_id: open.id }, keep: {} }, no_command_options: ["keep"], mi_case_id: open.id, affirmatives: ["withdraw", "yes withdraw"] } }, [party]))[0] ?? null;
      return { copy_key: "pmi.withdraw.choice", card_instance_id: cardId };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- the reactions, per loan, in commit order
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  if (e.type.startsWith("fpi.")) return fpiCards(deps, ctx, e);
  if (e.type.startsWith("flood.")) return floodCards(deps, ctx, e);
  if (e.type.startsWith("mi.") || e.type === "timer.breached" || e.type === "payment.received") return pmiCards(deps, ctx, e);
  if (e.type === "notice.sent") return noticeCards(deps, ctx, e);
  if (e.type === "arm.initial_notice.sent") return armCards(deps, ctx, e);
  if (e.type === "case.opened" || e.type === "payoff.request.received") return payoffCards(deps, ctx, e);
  if (e.type === "case.noe.opened") return caseCards(deps, ctx, e);
}

export const FLOW_9_SERVICING_REQUESTS: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byLoan = new Map<string, DomainEvent[]>();
    for (const e of events) { const loan = e.loanId ?? (typeof pl(e)["loan_id"] === "string" ? String(pl(e)["loan_id"]) : null); if (!loan) continue; const list = byLoan.get(loan) ?? []; list.push(e); byLoan.set(loan, list); }
    for (const [loanId, list] of byLoan) {
      const ctx = await context(deps, loanId);
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-9.reaction", { event: e.type, loan_id: loanId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  onMessage,
};
