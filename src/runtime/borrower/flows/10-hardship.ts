/**
 * 32.10 — Servicing: hardship and delinquency (spec/sections/32-borrower-experience/32-10-*.md): the borrower-facing form
 * of 11.1–11.5 (delinquency counters, early intervention, QRPC, Reg F, imminent default), 12.1–12.4 / 12.8 (loss
 * mitigation intake, evaluation, appeal, forbearance, Flex Mod TPP), 13.1 / 13.3 (foreclosure gates and referral) and
 * 14.1 / 14.3 (bankruptcy). Every card here is created through 32.1's `send_card` for the `borrower-comms` agent on the
 * owning process's event; nothing here computes a regulatory date or a money figure — dates come from `timers` and the
 * owning events, figures from the owning process's own records (the evaluation's `terms`, the plan's term).
 *
 *   loan.delinquency.day_reached{day≥16}              StatusCard `hardship.open` (11.1 counter job; the flow's tick runs it — src/runtime/delinquency.ts) (T1)
 *   continuity.assigned{team, direct_number}          PersonCard `team.assigned` with the reachable direct number (4.3) (T1)
 *   notice.sent{NTC_REGX_39B_EARLY_INTERVENTION…}      NoticeCard `hardship.notice.ei` (11.2) (T1)
 *   message "I lost my job and can't pay…"           11.3 contact.log (inbound) → qrpc.capture → lossmit.request.create{imminent_default} (11.5) → 32.2 lossmit.requestAssistance
 *                                                      (12.1 `lossmit.application.received`, REGX_1024_41B2_LM_ACK_5); reply `hardship.heard` + ConfirmCard `hardship.qrpc.confirm` (T2)
 *   lossmit.application.received / rfa.received        StatusCard `hardship.application.received` (next: the ack clock) (T2)
 *   notice.sent{NTC_REGX_41B2_ACK_INCOMPLETE}          NoticeCard `hardship.ack.incomplete` + one UploadCard `hardship.needs.item` per missing item → Needed-from-you (T3)
 *   lossmit.application.completed{days_before_sale>37} StatusCard `hardship.application.complete` + the protection sentence `hardship.protection` (REGX_1024_41G_DUAL_TRACK_GATE) (T4)
 *   lossmit.offer.sent (offer templates)               NoticeCard `hardship.offer.notice` + ComparisonCard `hardship.offer.compare` expiring at accept_by (REGX_1024_41E1_ACCEPT_14 in Dates) (T5)
 *   tick past accept_by                                the ComparisonCard expires; StatusCard `hardship.offer.deemed_rejected` (the Nov 2 copy); 12.2's deemed-rejection sweep after its policy grace (T5)
 *   lossmit.offer.sent{NTC_FNMA_D23206_TPP_OFFER}      NoticeCard `hardship.tpp.notice` + PaymentCard `hardship.tpp.pay` defaulting to the trial amount (T6)
 *   payment.received{designation=trial}                the cashiering → 12.2 bridge: `lossmit.evaluation.*{trial_payment_received}` → `lossmit.offer.responded{accepted_via=payment}` (tpp_active; FNMA_E3401 gate) (T6)
 *   workout_plan.activated{forbearance}                StatusCard `hardship.forb.active`; Loan section `hardship.forb` (T7)
 *   message "extend my forbearance"                    12.4 `workout_plan.*{prescreen}` → exception_required → reply `hardship.forb.limit` (LL-2026-01) (T7)
 *   workout_plan.ended{forbearance, expired}           ComparisonCard `hardship.forb.exit` (T7)
 *   lossmit.denial.provided{appeal_by}                 NoticeCard `hardship.denial.notice` (the reasons the 12.2 evaluation recorded) + ChoiceCard `hardship.appeal.choice` (T8)
 *   lossmit.appeal.received{eligible=false, late}      StatusCard `hardship.appeal.late`; notice.sent{NTC_REGX_41H_APPEAL_INELIGIBLE} → NoticeCard `hardship.appeal.ineligible` (T8)
 *   bankruptcy.petition.filed                          StatusCard `hardship.bk.protections`; the collection asks (payment / solicitation cards) cancelled; badge (record.ts) (T9)
 *   bankruptcy.statement_mode.set{mode≠standard}       StatusCard `hardship.bk.statements`; notice.sent{NTC_BK_PAYMENT_INSTRUCTIONS} → NoticeCard `hardship.bk.notice` (T9)
 *   notice.sent{NTC_SM_FC_REFERRAL_ADVICE}             NoticeCard `hardship.fc.advice` (help still available) + ChoiceCard `hardship.fc.reinstate` (T10)
 *   message "please stop contacting me"                11.3 preference.set{cease=written} (11.4: `fdcpa.cease.received{written}`, REGF_1006_6C_CEASE_GATE, NTC_REGF_1006_6C_CEASE_ACK);
 *                                                      StatusCard `hardship.cease.confirmed` + NoticeCard `hardship.cease.ack`; inbound stays open (T11)
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { plainDate as D, addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { EntityStore } from "../../../app/tools.ts";
import type { Recipient } from "../../../notices/channel.ts";
import { delinquencyDailySweep, LOAN_LOCAL_TZ } from "../../delinquency.ts";
import { registerFlowTimers, timerLabel } from "../record.ts";
import { FLOW_10_TIMER_ROWS, TPP_OFFER_TEMPLATE } from "./10-hardship-record.ts";
import type { BorrowerFlow, FlowDeps, FlowReply, InboundMessage } from "./index.ts";

export const FLOW_ID = "32.10";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const COMMS: Actor = { kind: "agent", id: "borrower-comms" };
const LOSSMIT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const RUN = { runId: "flow:32.10", modelVersion: "borrower flows (deterministic)", promptVersion: "32.10" } as const;
const CREATED_BY = "agent:borrower-comms";
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: string | bigint | number | null | undefined): string => (cents === null || cents === undefined || cents === "" ? "" : USD.format(Number(BigInt(String(cents))) / 100));

/** Notice codes this flow puts on cards (the owning process's rendered document; 02 §5). */
export const NOTICE_CODES_32_10 = { ei_standard: "NTC_REGX_39B_EARLY_INTERVENTION", ei_fdcpa: "NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", ei_bk: "NTC_REGX_39C_EARLY_INTERVENTION_BK", ack_incomplete: "NTC_REGX_41B2_ACK_INCOMPLETE", ack_complete: "NTC_REGX_41B2_ACK_COMPLETE", denial: "NTC_REGX_41C1_DENIAL", appeal_ineligible: "NTC_REGX_41H_APPEAL_INELIGIBLE", tpp_offer: TPP_OFFER_TEMPLATE, bk_payment_instructions: "NTC_BK_PAYMENT_INSTRUCTIONS", fc_referral_advice: "NTC_SM_FC_REFERRAL_ADVICE", cease_ack: "NTC_REGF_1006_6C_CEASE_ACK" } as const;
const EI_TEMPLATES = new Set<string>([NOTICE_CODES_32_10.ei_standard, NOTICE_CODES_32_10.ei_fdcpa, NOTICE_CODES_32_10.ei_bk, "NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA"]);
const OFFER_TEMPLATE = /OFFER|SS_ELIGIBILITY/;
registerFlowTimers(FLOW_10_TIMER_ROWS);

const REACTS = new Set(["loan.delinquency.day_reached", "continuity.assigned", "notice.sent", "solicitation_package.sent", "lossmit.application.received", "lossmit.rfa.received", "lossmit.application.completed", "lossmit.offer.sent", "lossmit.offer.responded", "lossmit.offer.deemed_rejected", "payment.received",
  "workout_plan.activated", "workout_plan.ended", "lossmit.denial.provided", "lossmit.appeal.received", "bankruptcy.petition.filed", "bankruptcy.statement_mode.set", "fdcpa.cease.received", "foreclosure.referral.sent"]);

// ---------------------------------------------------------------- the loan context one batch works on
interface Party { readonly party_id: string; readonly legal_name: string; readonly contact: P }
interface LoanFacts { readonly loan_id: string; readonly servicer_loan_number: string; readonly state: string; readonly property_address: string; readonly fdcpa_debt_collector: boolean; readonly regx_days_delinquent_at_boarding: number; readonly principal_residence: boolean }
interface Ctx { readonly loanId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly facts: LoanFacts | null; readonly now: string }
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);

/** Every party on a serviced loan with a conversation: the boarded borrowers, the application's borrowers before the link, a confirmed successor (02 §6). */
async function loanParties(deps: FlowDeps, loanId: string): Promise<Party[]> {
  return deps.runtime.db.query<Party & Record<string, unknown>>(
    `SELECT DISTINCT p.id AS party_id, p.legal_name, p.contact FROM parties p WHERE p.id IN (
       SELECT b.party_id FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL
       UNION SELECT ab.party_id FROM application_borrowers ab JOIN loans l ON l.origination_application_id = ab.application_id WHERE l.id = $1 AND ab.party_id IS NOT NULL
       UNION SELECT lp.party_id FROM loan_parties lp WHERE lp.loan_id = $1 AND lp.role = 'confirmed_successor' AND lp.ended_at IS NULL) ORDER BY p.legal_name`, [loanId]);
}
async function loanFacts(deps: FlowDeps, loanId: string): Promise<LoanFacts | null> {
  const loan = (await deps.runtime.db.query<Record<string, unknown>>(`SELECT l.id, l.servicer_loan_number, l.fdcpa_debt_collector_flag, l.regx_days_delinquent_at_boarding, l.principal_residence, pr.state, concat_ws(', ', pr.address_line1, pr.city, pr.state || ' ' || pr.postal_code) AS property_address FROM loans l LEFT JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  if (!loan) return null;
  return { loan_id: loanId, servicer_loan_number: String(loan["servicer_loan_number"] ?? ""), state: String(loan["state"] ?? "AZ"), property_address: String(loan["property_address"] ?? ""), fdcpa_debt_collector: loan["fdcpa_debt_collector_flag"] === true, regx_days_delinquent_at_boarding: Number(loan["regx_days_delinquent_at_boarding"] ?? 0), principal_residence: loan["principal_residence"] !== false };
}
async function context(deps: FlowDeps, loanId: string): Promise<Ctx> {
  const [events, records, parties, facts] = await Promise.all([deps.runtime.uow.events.byLoan(loanId), deps.runtime.entities.load({ loanId }), loanParties(deps, loanId), loanFacts(deps, loanId)]);
  const store = new EntityStore(); store.seed(records);
  return { loanId, events, store, parties, facts, now: deps.runtime.clock.now() };
}
const civilToday = (nowIso: string): PlainDate => wallClock(Date.parse(nowIso), LOAN_LOCAL_TZ).date;
const endOfDay = (d: string): string => new Date(`${d}T23:59:59-07:00`).toISOString();   // the loan-local day's end (America/Phoenix, no DST)
const emailOf = (p: Party): string | undefined => { const c = p.contact ?? {}; const e = typeof c["email"] === "string" ? c["email"] : Array.isArray(c["emails"]) ? (c["emails"] as unknown[])[0] : undefined; return typeof e === "string" && e ? e : undefined; };
/** A Notice Registry recipient for a loan party: the borrower at the property, a portal user (the channel decision is the registry's). */
export function recipientFor(p: Party, facts: LoanFacts | null): Recipient { const email = emailOf(p); return { partyId: p.party_id, name: p.legal_name, mailingAddress: facts?.property_address || null, ...(email ? { email } : {}), portalUser: true }; }
/** The registry's own sample payload for a template (fixture values, FAKE addresses — never a real name or number), overridden with the loan's facts. */
function samplePayload(deps: FlowDeps, code: string, on: PlainDate): P { return { ...(deps.runtime.noticeRegistry.activeVersion(code, on)?.samplePayload ?? {}) }; }

// ---------------------------------------------------------------- bus helpers
async function exec(deps: FlowDeps, loanId: string, process: string, name: string, actor: Actor, input: P): Promise<{ output: P; events: readonly DomainEvent[] }> {
  const r = await deps.runtime.execute({ process, name, loanId, actor, input, run: { ...RUN } });
  return { output: (r.output ?? {}) as P, events: r.events };
}
async function timerRow(deps: FlowDeps, loanId: string, code: string): Promise<{ id: string; due_at: string | null; due_date: string | null; status: string } | undefined> {
  return (await deps.runtime.db.query<{ id: string; due_at: string | null; due_date: string | null; status: string }>(`SELECT id, due_at, due_date::text AS due_date, status::text AS status FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
}
/** The rendered notice, when this runtime rendered it (the Notice Registry keeps its notices in memory per runtime; 02 §5: the card carries the document's own plain-language text). */
function noticeOf(deps: FlowDeps, noticeId: unknown): { text: string; payload: P; document_id: string | null } | null {
  const n = typeof noticeId === "string" ? deps.runtime.noticeMemory.get(noticeId) : undefined;
  return n ? { text: n.rendered?.text ?? "", payload: n.payload, document_id: n.renderedDocumentId ?? null } : null;
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
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { loan_id: loanId }, created_by: CREATED_BY, rationale: `32.10 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  // a card with no action (StatusCard, NoticeCard, PersonCard) is never the pinned ask: filed as read the moment it is sent (01 §3.1 "No action")
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", now, { informational: true, resolved_by: "system:flow-32.10" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx.loanId, p, c, ctx.now)); return ids; }
async function transitionAll(deps: FlowDeps, loanId: string, flowKeyPrefix: string, to: "resolved" | "superseded" | "cancelled" | "expired", evidence: P, now: string): Promise<number> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_loan_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE $2`, [loanId, `${flowKeyPrefix}%`]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, to, "system", now, { ...evidence, resolved_by: "system:flow-32.10" });
  return rows.length;
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true });
const NoticeCard = (copy_key: string, flow_key: string, notice_code: string, props: P = {}): CardSpec => ({ kind: "NoticeCard", copy_key, props: { notice_code, title: "", rendered_document_id: randomUUID(), plain_language: "", line: "", template_version: null, channel: "app", ...props }, flow_key, informational: true });
/** A NoticeCard over a notice the registry rendered in this runtime: the document's own text is the plain-language block. */
function noticeProps(deps: FlowDeps, e: DomainEvent): P {
  const p = pl(e); const n = noticeOf(deps, p["notice_id"]); const channels = Array.isArray(p["channels"]) ? (p["channels"] as P[]) : [];
  const channel = String(channels[0]?.["channel"] ?? "mail"); const mail = channel.startsWith("mail");
  return { rendered_document_id: n?.document_id ?? (typeof p["rendered_document_id"] === "string" ? p["rendered_document_id"] : randomUUID()), notice_id: p["notice_id"] ?? null, plain_language: n?.text ?? "", channel: mail ? "mail" : channel === "esign_portal" ? "app" : "email", delivered_at: p["sent_at"] ?? e.occurredAt, ...(mail ? { mailed_at: p["sent_at"] ?? e.occurredAt } : {}) };
}

// ---------------------------------------------------------------- the owning records this flow reads (never computes)
const latestEvaluation = (ctx: Ctx, id?: unknown): P | null => { const rows = ctx.store.list("lossmit_evaluations", (d) => d.loan_id === ctx.loanId); const r = typeof id === "string" && id ? rows.find((x) => x.id === id) : rows.at(-1); return r ? { id: r.id, ...r.data } : null; };
const latestApplication = (ctx: Ctx, id?: unknown): P | null => { const rows = ctx.store.list("lossmit_applications", (d) => d.loan_id === ctx.loanId); const r = typeof id === "string" && id ? rows.find((x) => x.id === id) : rows.at(-1); return r ? { id: r.id, ...r.data } : null; };
const termsOf = (ev: P | null): P => ((ev?.["terms"] as P | undefined) ?? {});
/** The evaluation's determinations (12.2 `draft{determinations}`) for the denied option: reason codes as the notice states them, never invented here. */
function denialReasons(ctx: Ctx, ev: P | null, noticePayload: P): { option: string; reasons: string[] } {
  const denied = Array.isArray(noticePayload["denied"]) ? (noticePayload["denied"] as P[]) : [];
  if (denied.length) return { option: String(denied[0]!["name"] ?? ev?.["option"] ?? "a loan modification"), reasons: denied.map((d) => String(d["reason"] ?? "")).filter(Boolean) };
  const dets = Array.isArray(ev?.["determinations"]) ? (ev!["determinations"] as P[]) : [];
  const d = dets.find((x) => x["result"] === "denied" || x["result"] === "ineligible") ?? dets[0];
  return { option: String(d?.["option"] ?? ev?.["option"] ?? "a loan modification"), reasons: Array.isArray(d?.["reason_codes"]) ? (d!["reason_codes"] as unknown[]).map(String) : [] };
}

// ---------------------------------------------------------------- reactions
async function delinquencyCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const day = Number(p["day"] ?? p["regx_day"] ?? 0); if (day < 16) return;
  const due = String(p["due_date"] ?? ""); const live = await timerRow(deps, ctx.loanId, "REGX_1024_39A_LIVE_CONTACT_36"); const written = await timerRow(deps, ctx.loanId, "REGX_1024_39B_WRITTEN_NOTICE_45");
  const next = written && written.status === "armed" ? { label: timerLabel("REGX_1024_39B_WRITTEN_NOTICE_45"), at: written.due_at } : live && live.status === "armed" ? { label: timerLabel("REGX_1024_39A_LIVE_CONTACT_36"), at: live.due_at } : null;
  // one open-door status per delinquency (the earliest unpaid due date names the episode); the badge is the record's own (record.ts)
  await sendToAll(deps, ctx, StatusCard("hardship.open", `hardship.open:${due}`, { due_date: due, day, ...(next ? { next_event_label: next.label, next_event_at: next.at } : {}) }));
}
async function teamCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const team = String(p["team"] ?? p["team_name"] ?? "Your servicing team"); const number = String(p["direct_number"] ?? "");
  await sendToAll(deps, ctx, { kind: "PersonCard", copy_key: "team.assigned", flow_key: `team:${String(p["episode_id"] ?? e.id)}`, informational: true,
    props: { role: "continuity_of_contact_team", name: team, reach: number, intro: "", copy_tokens: { team, number }, named_human: p["named_human"] ?? null, episode_id: p["episode_id"] ?? null, assigned_on: p["assigned_on"] ?? e.occurredAt.slice(0, 10) } });
}
async function noticeCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const code = String(p["template"] ?? ""); const noticeId = String(p["notice_id"] ?? e.id); const n = noticeOf(deps, p["notice_id"]); const base = noticeProps(deps, e);
  if (EI_TEMPLATES.has(code)) {
    const window = last(ctx, "loan.delinquency.window_opened"); const due = String(n?.payload["due_date"] ?? window?.payload["due_date"] ?? "");
    await sendToAll(deps, ctx, NoticeCard("hardship.notice.ei", `ei:${noticeId}`, code, { ...base, tone: "info", copy_tokens: { date: due } }));
    return;
  }
  if (code === NOTICE_CODES_32_10.ack_incomplete) {
    const app = latestApplication(ctx, n?.payload["application_id"]);
    const items = (Array.isArray(n?.payload["missing_documents"]) ? (n!.payload["missing_documents"] as unknown[]) : Array.isArray(app?.["missing_documents"]) ? (app!["missing_documents"] as unknown[]) : []).map(String);
    const reasonable = String(n?.payload["reasonable_date"] ?? app?.["reasonable_date"] ?? "");
    await sendToAll(deps, ctx, NoticeCard("hardship.ack.incomplete", `ack.incomplete:${noticeId}`, code, { ...base, application_id: app?.["id"] ?? null, reasonable_date: reasonable, missing_documents: items, copy_tokens: { date: reasonable, items: items.join(", ") } }));
    // one UploadCard per listed item: the same items the notice lists appear under Needed-from-you (02 §1.3 — `needed_label` / `needed_due_at` are the ack's own)
    for (const item of items) {
      const slug = item.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "hardship.needs.item", flow_key: `needs:${app?.["id"] ?? noticeId}:${slug}`, command_ref: "document.upload", ...(reasonable ? { expires_at: endOfDay(reasonable) } : {}),
        props: { document_class: slug || "lossmit_document", accepted_examples: [item], why: "", title: "", copy_tokens: { item }, needed_label: item, ...(reasonable ? { needed_due_at: endOfDay(reasonable) } : {}), application_id: app?.["id"] ?? null, command_args: { document_class: slug || "lossmit_document", servicing: true, lossmit_application_id: app?.["id"] ?? null } } });
    }
    return;
  }
  if (code === NOTICE_CODES_32_10.ack_complete) { const app = latestApplication(ctx, n?.payload["application_id"]); await sendToAll(deps, ctx, NoticeCard("hardship.ack.complete", `ack.complete:${noticeId}`, code, { ...base, application_id: app?.["id"] ?? null, copy_tokens: { date: String(n?.payload["complete_date"] ?? app?.["complete_at"] ?? e.occurredAt.slice(0, 10)) } })); return; }
  if (code === NOTICE_CODES_32_10.appeal_ineligible) { await sendToAll(deps, ctx, NoticeCard("hardship.appeal.ineligible", `appeal.ineligible:${noticeId}`, code, { ...base, copy_tokens: { date: String(n?.payload["appeal_by"] ?? "") } })); return; }
  if (code === NOTICE_CODES_32_10.bk_payment_instructions) { await sendToAll(deps, ctx, NoticeCard("hardship.bk.notice", `bk.notice:${noticeId}`, code, { ...base, informational_only: true })); return; }
  if (code === NOTICE_CODES_32_10.fc_referral_advice) {
    await sendToAll(deps, ctx, NoticeCard("hardship.fc.advice", `fc.advice:${noticeId}`, code, { ...base, tone: "caution", copy_tokens: { date: String(n?.payload["referral_on"] ?? e.occurredAt.slice(0, 10)) } }));
    // the reinstatement ask: a written request for the figure (4.2 RFI through 32.2 `case.open{kind=rfi}`); the figure itself is 13.x's, never computed here
    await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "hardship.fc.reinstate", flow_key: `fc.reinstate:${noticeId}`, command_ref: "case.open",
      props: { title: "", helper: "", options: [{ id: "send", label: "Send me the figure", is_primary: true }, { id: "not_now", label: "Not now" }], command: "case.open", command_args_by_option: { send: { kind: "rfi", text: "Please send the amount required to bring my loan current (a reinstatement figure)." }, not_now: {} }, no_command_options: ["not_now"], affirmatives: ["send me the figure", "send the figure", "how much to reinstate"] } });
    return;
  }
  if (code === NOTICE_CODES_32_10.cease_ack) { await sendToAll(deps, ctx, NoticeCard("hardship.cease.ack", `cease.ack:${noticeId}`, code, { ...base, copy_tokens: { date: String(n?.payload["cease_received_on"] ?? e.occurredAt.slice(0, 10)) } })); return; }
}
async function solicitationCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const noticeId = String(p["notice_id"] ?? e.id);
  await sendToAll(deps, ctx, NoticeCard("hardship.solicitation.notice", `solicit.notice:${noticeId}`, String(p["kind"] === "bsp" ? "NTC_FNMA_D2_2_04_BSP" : "NTC_FNMA_F745_LETTER"), { delivered_at: p["sent_at"] ?? e.occurredAt, channel: "mail", mailed_at: p["sent_at"] ?? e.occurredAt, solicitation_kind: p["kind"] ?? null }));
  if (has(ctx, "lossmit.application.received") || has(ctx, "lossmit.rfa.received")) return;
  await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "hardship.solicitation.start", flow_key: `solicit.start:${noticeId}`, command_ref: "lossmit.requestAssistance",
    props: { title: "", helper: "", options: [{ id: "start", label: "Start", is_primary: true }, { id: "not_now", label: "Not now" }], command: "lossmit.requestAssistance", command_args_by_option: { start: { hardship_text: "I would like to start a request for mortgage assistance." }, not_now: {} }, no_command_options: ["not_now"], affirmatives: ["start", "yes start", "let's start"] } });
}
async function applicationCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const appId = String(p["application_id"] ?? "");
  await transitionAll(deps, ctx.loanId, "solicit.start:", "resolved", { application_id: appId }, ctx.now);
  const ack = await timerRow(deps, ctx.loanId, "REGX_1024_41B2_LM_ACK_5");
  await sendToAll(deps, ctx, StatusCard("hardship.application.received", `app.received:${appId || e.id}`, { application_id: appId || null, received_on: p["received_date"] ?? e.occurredAt.slice(0, 10), ...(ack ? { next_event_label: timerLabel("REGX_1024_41B2_LM_ACK_5"), next_event_at: ack.due_at } : {}) }));
}
async function completedCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const appId = String(p["application_id"] ?? "");
  await transitionAll(deps, ctx.loanId, `needs:${appId}:`, "resolved", { application_id: appId, complete_at: p["complete_at"] ?? null }, ctx.now);
  await sendToAll(deps, ctx, StatusCard("hardship.application.complete", `app.complete:${appId || e.id}`, { application_id: appId || null, complete_at: p["complete_at"] ?? e.occurredAt.slice(0, 10) }));
  // 13.2 / §1024.41(g): a complete application more than 37 days before the sale — the protection sentence (REGX_1024_41G_DUAL_TRACK_GATE holds the sale internally)
  const days = p["days_before_sale"]; const tier = String(p["protection_tier"] ?? p["tier"] ?? "");
  const protected_ = (typeof days === "number" && days > 37) || (p["sale_on"] !== null && p["sale_on"] !== undefined && /gt_37|ge_90|ge_45/.test(tier));
  if (protected_) await sendToAll(deps, ctx, StatusCard("hardship.protection", `protection:${appId || e.id}`, { application_id: appId || null, days_before_sale: days ?? null, sale_on: p["sale_on"] ?? null, protection_tier: tier || null, gate: "REGX_1024_41G_DUAL_TRACK_GATE" }));
}
function offerColumns(terms: P): P[] {
  const rows: P[] = [];
  if (terms["rate_pct"] !== undefined) rows.push({ label: "Rate", value: `${String(terms["rate_pct"])}%`, emphasis: true });
  if (terms["pi_cents"] !== undefined) rows.push({ label: "Principal & interest", value: `${money(String(terms["pi_cents"]))}/mo` });
  if (terms["escrow_cents"] !== undefined) rows.push({ label: "Escrow", value: `${money(String(terms["escrow_cents"]))}/mo` });
  if (terms["trial_payment_cents"] !== undefined) rows.push({ label: "Trial payment", value: `${money(String(terms["trial_payment_cents"]))}/mo`, emphasis: true });
  if (terms["term_months"] !== undefined) rows.push({ label: "Term", value: `${String(terms["term_months"])} months` });
  if (terms["forborne_cents"] !== undefined) rows.push({ label: "Deferred (non-interest-bearing)", value: money(String(terms["forborne_cents"])) });
  if (terms["effective"] !== undefined) rows.push({ label: "Effective", value: String(terms["effective"]) });
  return rows;
}
async function offerCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const code = String(p["template"] ?? ""); const noticeId = String(p["notice_id"] ?? e.id); if (!OFFER_TEMPLATE.test(code)) return;
  const ev = latestEvaluation(ctx, p["evaluation_id"]); const terms = termsOf(ev); const acceptBy = String(ev?.["accept_by"] ?? ""); const n = noticeOf(deps, p["notice_id"]);
  const accept = await timerRow(deps, ctx.loanId, "REGX_1024_41E1_ACCEPT_14");
  const base = { ...noticeProps(deps, { ...e, payload: { ...p, notice_id: p["notice_id"] } } as DomainEvent), evaluation_id: ev?.["id"] ?? null, option: p["option"] ?? ev?.["option"] ?? null };
  if (code === TPP_OFFER_TEMPLATE) {
    // 12.8 TPP: the first trial payment by its due date is the acceptance (D2-2-05) — the PaymentCard defaults to the trial amount the evaluation carries; nothing else to tap
    const amount = String(terms["trial_payment_cents"] ?? n?.payload["trial_payment_cents"] ?? "0"); const dueDates = (Array.isArray(terms["due_dates"]) ? terms["due_dates"] : Array.isArray(n?.payload["due_dates"]) ? n!.payload["due_dates"] : []) as unknown[];
    const firstDue = String(terms["first_due"] ?? n?.payload["first_due"] ?? dueDates[0] ?? acceptBy); const count = Number(terms["trial_count"] ?? n?.payload["trial_count"] ?? dueDates.length ?? 3);
    await sendToAll(deps, ctx, NoticeCard("hardship.tpp.notice", `tpp.notice:${noticeId}`, code, { ...base, copy_tokens: { money: money(amount), date: firstDue }, trial_payment_cents: amount, first_due: firstDue, trial_count: count }));
    const today = civilToday(ctx.now); const dates: string[] = []; for (let d = today; d <= D(firstDue) && dates.length < 31; d = addDays(d, 1)) dates.push(d); if (!dates.length) dates.push(firstDue);
    await sendToAll(deps, ctx, { kind: "PaymentCard", copy_key: "hardship.tpp.pay", flow_key: `tpp.pay:${noticeId}:1`, command_ref: "payment.makeOneTime", expires_at: endOfDay(firstDue),
      props: { mode: "one_time", amount_default_cents: amount, amount_editable: false, date_options: dates, accounts: [{ id: "acct-0001", last4: "0001", label: "Checking ····0001" }], add_account: false, copy_tokens: { n: "1", count: String(count) }, trial_number: 1, trial_count: count, due_on: firstDue, evaluation_id: ev?.["id"] ?? null, command_args: { designation: "trial", account: { last4: "0001" }, trial_number: 1, evaluation_id: ev?.["id"] ?? null } } });
    return;
  }
  await sendToAll(deps, ctx, NoticeCard("hardship.offer.notice", `offer.notice:${noticeId}`, code, { ...base, accept_by: acceptBy || null, copy_tokens: { date: acceptBy } }));
  const option = String(p["option"] ?? ev?.["option"] ?? "offer");
  await sendToAll(deps, ctx, { kind: "ComparisonCard", copy_key: "hardship.offer.compare", flow_key: `offer.compare:${noticeId}`, command_ref: "lossmit.respondToOffer", expires_at: acceptBy ? endOfDay(acceptBy) : (accept?.due_at ?? null),
    props: { title: "", columns: [{ id: "accept", title: option.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), rows: offerColumns(terms) }], recommended_id: "accept", command: "lossmit.respondToOffer", command_args_by_option: { accept: { decision: "accept", evaluation_id: ev?.["id"] ?? null }, decline: { decision: "decline", evaluation_id: ev?.["id"] ?? null } }, secondary_option: { id: "decline", label: "Decline" }, footnote: "", copy_tokens: { date: acceptBy }, accept_by: acceptBy || null, deadline_copy_key: "hardship.offer.deadline", evaluation_id: ev?.["id"] ?? null, option, affirmatives: ["accept", "i accept", "accept the offer", "yes accept"] } });
}
async function offerRespondedCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const response = String(p["response"] ?? "");
  await transitionAll(deps, ctx.loanId, "offer.compare:", "resolved", { response, offer_id: p["offer_id"] ?? null, accepted_via: p["accepted_via"] ?? null }, ctx.now);
  if (response !== "accepted") return;
  if (p["accepted_via"] === "payment") {
    await transitionAll(deps, ctx.loanId, "tpp.pay:", "resolved", { offer_id: p["offer_id"] ?? null, accepted_via: "payment" }, ctx.now);
    const ev = latestEvaluation(ctx, p["evaluation_id"]); const terms = termsOf(ev); const count = Number(terms["trial_count"] ?? 3);
    await sendToAll(deps, ctx, StatusCard("hardship.tpp.active", `tpp.active:${String(p["offer_id"] ?? e.id)}`, { copy_tokens: { n: "1", count: String(count), remaining: String(Math.max(count - 1, 0)) }, offer_id: p["offer_id"] ?? null, evaluation_id: ev?.["id"] ?? null, gate: "FNMA_E3401_FC_SUSPEND_DURING_TRIAL" }));
  }
}
/** The cashiering → 12.2 bridge (32.10 backend delta): a trial-designated receipt on a loan with a pending TPP offer is 12.2's `trial_payment_received` — acceptance by payment, no other tap. */
async function trialPaymentBridge(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["designation"] !== "trial" && p["designation"] !== "trial_payment") return;
  const sent = last(ctx, "lossmit.offer.sent", (x) => String(x["template"]) === TPP_OFFER_TEMPLATE); if (!sent) return;
  if (has(ctx, "lossmit.trial.first_payment_received")) return;   // recorded already (the bridge ran, or cashiering's own 2.6 path did)
  const ev = latestEvaluation(ctx, sent.payload["evaluation_id"]); const terms = termsOf(ev);
  const dueOn = String(terms["first_due"] ?? (Array.isArray(terms["due_dates"]) ? (terms["due_dates"] as unknown[])[0] : "") ?? ""); if (!dueOn) return;
  await exec(deps, ctx.loanId, "12.2", "lossmit.evaluation.*", LOSSMIT, { op: "trial_payment_received", loan_id: ctx.loanId, evaluation_id: ev?.["id"] ?? null, option: String(sent.payload["option"] ?? ev?.["option"] ?? "flex_mod"), payment_date: String(p["received_on"] ?? e.occurredAt.slice(0, 10)), due_on: dueOn, amount_cents: String(p["amount_cents"] ?? "0"), required_cents: String(terms["trial_payment_cents"] ?? p["amount_cents"] ?? "0"), acceptance_items_outstanding: [], payment_id: p["payment_id"] ?? null, source: "rules_engine" });
}
async function deemedCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const acceptBy = String(p["accept_by"] ?? "");
  await transitionAll(deps, ctx.loanId, "offer.compare:", "expired", { deemed_rejected_on: p["deemed_rejected_on"] ?? null, accept_by: acceptBy }, ctx.now);
  await sendToAll(deps, ctx, StatusCard("hardship.offer.deemed_rejected", `offer.deemed:${String(p["offer_id"] ?? e.id)}`, { copy_tokens: { date: acceptBy }, offer_id: p["offer_id"] ?? null, accept_by: acceptBy, deemed_rejected_on: p["deemed_rejected_on"] ?? null, grace_days: p["grace_days"] ?? null }));
}
async function forbearanceCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if ((p["kind"] ?? p["plan_kind"]) !== "forbearance") return; const planId = String(p["plan_id"] ?? e.id);
  if (e.type === "workout_plan.activated") {
    const disposition = await timerRow(deps, ctx.loanId, "FNMA_D23201_FORB_EXPIRY_DISPOSITION");
    await sendToAll(deps, ctx, StatusCard("hardship.forb.active", `forb.active:${planId}`, { copy_tokens: { date: String(p["term_end"] ?? "") }, plan_id: planId, term_start: p["term_start"] ?? null, term_end: p["term_end"] ?? null, ...(disposition ? { next_event_label: timerLabel("FNMA_D23201_FORB_EXPIRY_DISPOSITION"), next_event_at: disposition.due_at } : {}) }));
    return;
  }
  if (e.type === "workout_plan.ended") {
    await transitionAll(deps, ctx.loanId, "forb.extend:", "cancelled", { plan_id: planId, status: p["status"] ?? null }, ctx.now);
    if (String(p["status"]) !== "expired" && String(p["status"]) !== "completed") return;
    const date = String(p["term_end"] ?? p["ended_on"] ?? ""); const ask = (id: string, option: string) => ({ id, args: { hardship_text: `My forbearance ended ${date}; I would like ${option.replace(/_/g, " ")}.`, requested_option: option, plan_id: planId } });
    const cols = [ask("reinstate", "reinstatement"), ask("repayment_plan", "repayment_plan"), ask("payment_deferral", "payment_deferral"), ask("flex_mod", "flex_modification"), ask("payoff", "payoff")];
    const titles: Record<string, string> = { reinstate: "Reinstate", repayment_plan: "Repayment plan", payment_deferral: "Payment deferral", flex_mod: "Flex Modification", payoff: "Payoff" };
    await sendToAll(deps, ctx, { kind: "ComparisonCard", copy_key: "hardship.forb.exit", flow_key: `forb.exit:${planId}`, command_ref: "lossmit.requestAssistance",
      props: { title: "", columns: cols.map((c) => ({ id: c.id, title: titles[c.id]!, rows: [] })), command: "lossmit.requestAssistance", command_args_by_option: Object.fromEntries(cols.map((c) => [c.id, c.args])), footnote: "", copy_tokens: { date }, plan_id: planId, term_end: date, prescreen_hint: p["deferral_eligible"] === true ? "payment_deferral" : p["flex_eligible"] === true ? "flex_mod" : null } });
  }
}
async function denialCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const noticeId = String(p["notice_id"] ?? e.id); const ev = latestEvaluation(ctx, p["evaluation_id"]); const n = noticeOf(deps, p["notice_id"]);
  const appealBy = String(p["appeal_by"] ?? ev?.["appeal_by"] ?? ""); const { option, reasons } = denialReasons(ctx, ev, n?.payload ?? {});
  const appId = String(ev?.["application_id"] ?? latestApplication(ctx)?.["id"] ?? "");
  await sendToAll(deps, ctx, NoticeCard("hardship.denial.notice", `denial:${noticeId}`, String(p["template"] ?? NOTICE_CODES_32_10.denial), { rendered_document_id: n?.document_id ?? randomUUID(), notice_id: p["notice_id"] ?? null, plain_language: n?.text ?? "", channel: "mail", delivered_at: e.occurredAt, mailed_at: e.occurredAt, tone: "caution",
    copy_tokens: { option, reasons: reasons.join("; "), date: appealBy }, denied_option: option, reasons, appeal_by: appealBy || null, evaluation_id: ev?.["id"] ?? null, application_id: appId || null, appeal_rights: p["appeal_rights"] ?? ev?.["appeal_rights"] ?? null }));
  if (p["appeal_rights"] === false || ev?.["appeal_rights"] === false) return;
  const appeal = await timerRow(deps, ctx.loanId, "REGX_1024_41H_APPEAL_14");
  await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "hardship.appeal.choice", flow_key: `appeal:${noticeId}`, command_ref: "lossmit.appeal", expires_at: appeal?.due_at ?? (appealBy ? endOfDay(appealBy) : null),
    props: { title: "", helper: "", options: [{ id: "appeal", label: "Appeal", is_primary: true }, { id: "not_now", label: "Not now" }], command: "lossmit.appeal", command_args_by_option: { appeal: { application_id: appId || null, evaluation_id: ev?.["id"] ?? null, text: `I would like to appeal the denial of ${option}. Please look at my application again.` }, not_now: {} }, no_command_options: ["not_now"], copy_tokens: { date: appealBy }, appeal_by: appealBy || null, evaluation_id: ev?.["id"] ?? null, affirmatives: ["appeal", "i want to appeal", "appeal this decision"] } });
}
async function appealCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const appealId = String(p["appeal_id"] ?? e.id);
  await transitionAll(deps, ctx.loanId, "appeal:", "resolved", { appeal_id: appealId, eligible: p["eligible"] ?? null }, ctx.now);
  if (p["eligible"] === false && (p["ineligibility_reason"] === "late" || p["late"] === true)) {
    const ends = String(p["appeal_window_ends"] ?? ""); const days = Number(p["appeal_days"] ?? 14);
    await sendToAll(deps, ctx, StatusCard("hardship.appeal.late", `appeal.late:${appealId}`, { copy_tokens: { days: String(days), date: ends }, appeal_id: appealId, appeal_window_ends: ends || null, ineligibility_reason: "late" }));
  }
}
async function bankruptcyCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  if (e.type === "bankruptcy.petition.filed") {
    // every collection ask stops: the pending payment / solicitation / reinstatement cards are cancelled (14.1 rule 1: no demand while the stay is in effect)
    for (const prefix of ["tpp.pay:", "solicit.start:", "fc.reinstate:", "offer.compare:"]) await transitionAll(deps, ctx.loanId, prefix, "cancelled", { reason: "bankruptcy stay in effect", case_id: p["case_id"] ?? null }, ctx.now);
    await sendToAll(deps, ctx, StatusCard("hardship.bk.protections", `bk.protections:${String(p["case_id"] ?? e.id)}`, { case_id: p["case_id"] ?? null, chapter: p["chapter"] ?? null, petition_date: p["petition_date"] ?? null }));
    return;
  }
  if (e.type === "bankruptcy.statement_mode.set" && String(p["mode"]) !== "standard") await sendToAll(deps, ctx, StatusCard("hardship.bk.statements", `bk.statements:${String(p["mode"])}:${e.occurredAt.slice(0, 10)}`, { mode: p["mode"] ?? null, effective_on: p["effective_on"] ?? null }));
}
async function ceaseCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["written"] !== true) return;
  for (const prefix of ["tpp.pay:", "solicit.start:", "fc.reinstate:"]) await transitionAll(deps, ctx.loanId, prefix, "cancelled", { reason: "written cease (§1006.6(c))" }, ctx.now);
  const on = String(p["on"] ?? p["received_on"] ?? e.occurredAt.slice(0, 10));
  await sendToAll(deps, ctx, StatusCard("hardship.cease.confirmed", `cease.confirmed:${on}`, { received_on: on, scope: p["scope"] ?? p["cease_scope"] ?? "written_full", gate: "REGF_1006_6C_CEASE_GATE" }));
}
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  switch (e.type) {
    case "loan.delinquency.day_reached": return delinquencyCards(deps, ctx, e);
    case "continuity.assigned": return teamCard(deps, ctx, e);
    case "notice.sent": return noticeCards(deps, ctx, e);
    case "solicitation_package.sent": return solicitationCards(deps, ctx, e);
    case "lossmit.application.received": case "lossmit.rfa.received": return applicationCards(deps, ctx, e);
    case "lossmit.application.completed": return completedCards(deps, ctx, e);
    case "lossmit.offer.sent": return offerCards(deps, ctx, e);
    case "lossmit.offer.responded": return offerRespondedCards(deps, ctx, e);
    case "lossmit.offer.deemed_rejected": return deemedCards(deps, ctx, e);
    case "payment.received": return trialPaymentBridge(deps, ctx, e);
    case "workout_plan.activated": case "workout_plan.ended": return forbearanceCards(deps, ctx, e);
    case "lossmit.denial.provided": return denialCards(deps, ctx, e);
    case "lossmit.appeal.received": return appealCards(deps, ctx, e);
    case "bankruptcy.petition.filed": case "bankruptcy.statement_mode.set": return bankruptcyCards(deps, ctx, e);
    case "fdcpa.cease.received": return ceaseCards(deps, ctx, e);
    default: return;
  }
}

// ---------------------------------------------------------------- the borrower's own words (the Intake Router's deterministic FAKE classifier over the 32.10 phrases)
const HARDSHIP = /\b(lost my job|laid off|let go|unemploy\w*|can'?t (make|pay|afford|cover)|cannot (make|pay|afford|cover)|won'?t be able to (make|pay)|hardship|behind on (my|the) (payment|mortgage)|miss(ed|ing)? (a|my|the|next) payment|reduced (hours|income|pay)|pay cut|medical bills?|divorce|separat(ed|ion)|passed away|died)\b/i;
const FORB_EXTEND = /\b(extend|extension|more time|longer)\b.*\bforbearance\b|\bforbearance\b.*\b(extend|extension|more time|longer)\b/i;
const CEASE = /\b(stop (contacting|calling|texting|emailing|writing to) me|cease (communication|contact|calling)|do not contact me|don'?t contact me|no more (calls|contact|letters)|stop all (contact|communication))\b/i;
export type HardshipReason = "unemployment" | "reduction_in_income" | "disability_or_illness" | "divorce_or_legal_separation" | "death_of_borrower_or_wage_earner" | "other";
export function classifyHardship(text: string): { kind: "hardship" | "forbearance_extension" | "cease" | null; reason: HardshipReason | null } {
  const t = text.trim();
  if (CEASE.test(t)) return { kind: "cease", reason: null };
  if (FORB_EXTEND.test(t)) return { kind: "forbearance_extension", reason: null };
  if (!HARDSHIP.test(t)) return { kind: null, reason: null };
  const reason: HardshipReason = /lost my job|laid off|let go|unemploy/i.test(t) ? "unemployment" : /reduced (hours|income|pay)|pay cut/i.test(t) ? "reduction_in_income" : /medical|illness|disab/i.test(t) ? "disability_or_illness" : /divorce|separat/i.test(t) ? "divorce_or_legal_separation" : /passed away|died/i.test(t) ? "death_of_borrower_or_wage_earner" : "other";
  return { kind: "hardship", reason };
}
async function partyOf(deps: FlowDeps, partyId: string): Promise<Party | undefined> { return (await deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT id AS party_id, legal_name, contact FROM parties WHERE id = $1`, [partyId]))[0]; }

async function onMessage(deps: FlowDeps, m: InboundMessage): Promise<FlowReply | null> {
  const c = classifyHardship(m.text); const loanId = m.subject?.loan_id ?? null;
  if (!c.kind || !loanId) return null;
  const ctx = await context(deps, loanId); const today = civilToday(m.at);
  const party = ctx.parties.find((x) => x.party_id === m.party_id) ?? (await partyOf(deps, m.party_id)); if (!party) return null;
  const loanRow = ctx.store.get("loans", loanId)?.data ?? {};
  switch (c.kind) {
    case "hardship": {
      // 11.3: the conversation is an inbound contact; the QRPC record is captured from the borrower's own words (the AI's chat counts as conversation_only until a person verifies it — rule 6)
      const contactId = `ct-${loanId.slice(0, 8)}-${m.message_id.slice(0, 8)}`;
      await exec(deps, loanId, "11.3", "contact.log", COMMS, { id: contactId, loan_id: loanId, mode: "chat", direction: "inbound", outcome: "conversation", party_id: m.party_id, on: today, channel: m.channel, message_id: m.message_id });
      const q = await exec(deps, loanId, "11.3", "qrpc.capture", COMMS, { loan_id: loanId, contact_id: contactId, id: `qrpc-${contactId}`, narrative: m.text, spoken_on: today, conversation: { verified_party: "borrower", reason_primary: c.reason, hardship_nature: "temporary" }, channel: m.channel, conducted_by: "ai_agent", ai_voice_counts: false });
      const qrpcId = String(q.output["id"] ?? `qrpc-${contactId}`);
      // 11.5: the imminent-default evaluation on a current loan (`regx_days_delinquent` from the counter job's projection, 0 when current); it waits on the BRP the application will carry
      const days = Number(loanRow["regx_days_delinquent"] ?? 0);
      const id = await exec(deps, loanId, "11.3", "lossmit.request.create", COMMS, { loan_id: loanId, id: `lmr-${loanId.slice(0, 8)}-${m.message_id.slice(0, 8)}`, data: { loan_id: loanId, case_type: "lossmit_request", source: "borrower_message", message_id: m.message_id, party_id: m.party_id, qrpc_id: qrpcId, hardship_reason: c.reason, received_on: today }, state: ctx.facts?.state ?? "AZ",
        imminent_default: { evaluation_date: today, regx_days_delinquent: days, principal_residence: ctx.facts?.principal_residence !== false, brp_complete: false, oldest_doc_date: today, cash_reserves_cents: "0", hardship_type: c.reason, hardship_documented: false } });
      // 12.1 through 32.2: a stated hardship with its reason is evaluative information — a loss mitigation application, not a bare RFA (`lossmit.application.received`; REGX_1024_41B2_LM_ACK_5 arms)
      const a = await exec(deps, loanId, "32.2", "lossmit.requestAssistance", BORROWER_APP, { loan_id: loanId, party_id: m.party_id, hardship_text: m.text, hardship_reason: c.reason, qrpc_id: qrpcId, state: ctx.facts?.state ?? "AZ", assurance_level: "L1", message_id: m.message_id });
      const appId = String(a.output["application_id"] ?? "");
      const ide = (id.output["imminent_default"] as P | undefined) ?? {};
      const fields = [{ path: "hardship.reason", label: "What changed", value: String(c.reason).replace(/_/g, " "), source: "borrower" }, { path: "hardship.since", label: "Since", value: today, source: "borrower" }, { path: "hardship.nature", label: "Expected to last", value: "temporary", source: "borrower" }];
      const cardId = (await sendToAll(deps, ctx, { kind: "ConfirmCard", copy_key: "hardship.qrpc.confirm", flow_key: `qrpc.confirm:${qrpcId}`, command_ref: "lossmit.requestAssistance",
        props: { title: "", fields, commits_to: "lossmit_applications.hardship", options: [{ id: "confirm", label: "That's right", is_primary: true }, { id: "fix", label: "Correct it" }], copy_tokens: { summary: `${String(c.reason).replace(/_/g, " ")} since ${today}` }, qrpc_id: qrpcId, application_id: appId || null, imminent_default_evaluation_id: ide["evaluation_id"] ?? null, command_args: { op: "update", id: appId || null, hardship_reason: c.reason, qrpc_id: qrpcId, hardship_text: m.text } } }, [party]))[0] ?? null;
      return { copy_key: "hardship.heard", command: "lossmit.requestAssistance", card_instance_id: cardId };
    }
    case "forbearance_extension": {
      const plan = ctx.store.list("workout_plans", (d) => d.loan_id === loanId && d.kind === "forbearance" && d.status === "active").at(-1); if (!plan) return null;
      // the plan's cumulative forborne months after its current term: 12.4's own `workout_plan.term.create{cumulative_months_after}` (the activation's term row), else the plan row
      const term = last(ctx, "workout_plan.term.create", (x) => x["plan_id"] === plan.id);
      const cumulative = Number(term?.payload["cumulative_months_after"] ?? plan.data["cumulative_months"] ?? plan.data["months"] ?? 0); const atStart = Number(term?.payload["months_delinquent_at_start"] ?? plan.data["delinquency_months_at_start"] ?? plan.data["months_delinquent_at_start"] ?? 0);
      // 12.4 rule 4: the pre-screen decides — an extension within the caps, or the exception template when LL-2026-01's 12-month caps are reached
      const r = await exec(deps, loanId, "12.4", "workout_plan.*", LOSSMIT, { op: "prescreen", loan_id: loanId, id: plan.id, hardship_resolved: false, months_delinquent: atStart + Number(plan.data["months"] ?? 0), cumulative_months: cumulative, months_delinquent_at_next_start: atStart + Number(plan.data["months"] ?? 0), requested_months: 3, start_on: String(plan.data["term_end"] ?? today), mbs: plan.data["mbs"] === true });
      if (r.output["result"] === "exception_required" || Number(r.output["extension_months"] ?? 0) < 1) return { copy_key: "hardship.forb.limit" };
      const n = Number(r.output["extension_months"]);
      const cardId = (await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "hardship.forb.extension", flow_key: `forb.extend:${plan.id}:${today}`, command_ref: "lossmit.requestAssistance",
        props: { title: "", helper: "", options: [{ id: "extend", label: `Extend ${n} months`, is_primary: true }, { id: "not_now", label: "Not now" }], command: "lossmit.requestAssistance", command_args_by_option: { extend: { hardship_text: `Please extend my forbearance by ${n} months.`, requested_option: "forbearance_extension", requested_months: n, plan_id: plan.id }, not_now: {} }, no_command_options: ["not_now"], copy_tokens: { n: String(n) }, plan_id: plan.id, extension_months: n } }, [party]))[0] ?? null;
      return { copy_key: "hardship.forb.extension", card_instance_id: cardId };
    }
    case "cease": {
      // 11.4 rule 6: the borrower's typed request is a written cease (the app is a written channel) — recorded by 11.3 `preference.set{cease=written}` on the loan's fdcpa_status; the acknowledgment renders from the registry's template (FAKE fixture values, the loan's last4)
      const written = ctx.facts?.fdcpa_debt_collector === true;
      const payload = { ...samplePayload(deps, NOTICE_CODES_32_10.cease_ack, today), account_last4: (ctx.facts?.servicer_loan_number ?? "").slice(-4) || "0000", property_address: ctx.facts?.property_address ?? "", cease_received_on: today, notice_date: today };
      await exec(deps, loanId, "11.3", "preference.set", COMMS, { party_id: m.party_id, loan_id: loanId, cease: written ? "written" : "oral", revoke_channels: ["tcpa_voice", "tcpa_sms"], revocation_method: "written", do_not_call_reason: "borrower cease request", channel: "app", message_id: m.message_id, consented_channels: ["voice", "sms", "email"], regx_days_delinquent_at_boarding: ctx.facts?.regx_days_delinquent_at_boarding ?? 0, ...(written ? { recipients: [recipientFor(party, ctx.facts)], payload } : {}) });
      return { copy_key: "hardship.cease.confirmed", command: "preference.set" };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- the scheduled pass
async function tick(deps: FlowDeps, nowIso: string): Promise<void> {
  // 11.1 / 13.1: the counter job over every delinquent loan (src/runtime/delinquency.ts)
  await delinquencyDailySweep(deps.runtime, nowIso);
  const today = civilToday(nowIso);
  // 12.2: silence past accept_by — the borrower's cards expire and the Record says what the offer said (the copy of the day it was sent); the owning process deems the rejection after its own policy grace (`deemed_rejection`)
  const pending = await deps.runtime.db.query<{ card_instance_id: string; subject_loan_id: string; props: P }>(`SELECT card_instance_id, subject_loan_id, props FROM card_instances WHERE status = 'pending' AND props->>'flow' = $1 AND props->>'flow_key' LIKE 'offer.compare:%' AND expires_at IS NOT NULL AND expires_at < $2`, [FLOW_ID, nowIso]);
  const byLoan = new Map<string, { card_instance_id: string; props: P }[]>();
  for (const c of pending) { const l = byLoan.get(c.subject_loan_id) ?? []; l.push(c); byLoan.set(c.subject_loan_id, l); }
  for (const [loanId, cards] of byLoan) {
    const ctx = await context(deps, loanId);
    for (const c of cards) {
      await deps.ui.transitionCard(c.card_instance_id, "expired", "system", ctx.now, { reason: "no response by accept_by (the offer said the silence is a decline)", accept_by: c.props["accept_by"] ?? null, resolved_by: "system:flow-32.10" });
      await sendToAll(deps, ctx, StatusCard("hardship.offer.deemed_rejected", `offer.silent:${String(c.props["evaluation_id"] ?? c.card_instance_id)}`, { copy_tokens: { date: String(c.props["accept_by"] ?? "") }, accept_by: c.props["accept_by"] ?? null, evaluation_id: c.props["evaluation_id"] ?? null, said_on_copy_key: "hardship.offer.deadline", basis: "no response by accept_by; 12.2 deems the rejection after its policy grace" }));
    }
  }
  // the 12.2 deemed-rejection sweep for every offer still open past its accept_by (the op decides the date — accept_by + the tier's policy grace)
  const open = await deps.runtime.db.query<{ loan_id: string; payload: P }>(`SELECT s.loan_id, s.payload FROM loan_events s WHERE s.type = 'lossmit.offer.sent' AND s.loan_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM loan_events r WHERE r.loan_id = s.loan_id AND r.type IN ('lossmit.offer.responded', 'lossmit.offer.deemed_rejected') AND r.sequence > s.sequence AND (r.payload->>'evaluation_id' = s.payload->>'evaluation_id' OR r.payload->>'evaluation_id' IS NULL OR s.payload->>'evaluation_id' IS NULL))`);
  for (const o of open) {
    const ctx = await context(deps, o.loan_id); const ev = latestEvaluation(ctx, o.payload["evaluation_id"]); const acceptBy = typeof ev?.["accept_by"] === "string" ? String(ev["accept_by"]) : "";
    if (!acceptBy || today <= D(acceptBy)) continue;
    try { await exec(deps, o.loan_id, "12.2", "lossmit.evaluation.*", LOSSMIT, { op: "deemed_rejection", loan_id: o.loan_id, evaluation_id: ev?.["id"] ?? null, option: o.payload["option"] ?? ev?.["option"] ?? null, accept_by: acceptBy, window_days: ev?.["window_days"] ?? 14 }); }
    catch (err) { deps.logger?.error("borrower.flow.32-10.deemed_rejection", { loan_id: o.loan_id, error: err instanceof Error ? err.message : String(err) }); }
  }
}

export const FLOW_10_HARDSHIP: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byLoan = new Map<string, DomainEvent[]>();
    for (const e of events) { const loan = e.loanId ?? (typeof pl(e)["loan_id"] === "string" ? String(pl(e)["loan_id"]) : null); if (!loan) continue; const list = byLoan.get(loan) ?? []; list.push(e); byLoan.set(loan, list); }
    for (const [loanId, list] of byLoan) {
      const ctx = await context(deps, loanId);
      if (!ctx.parties.length) continue;   // no borrower party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-10.reaction", { event: e.type, loan_id: loanId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  onMessage,
  tick,
};
