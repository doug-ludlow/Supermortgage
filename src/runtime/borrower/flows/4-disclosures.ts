/**
 * 32.4 — Disclosures, intent to proceed, lock, revised LEs (spec/sections/32-borrower-experience/32-4-*.md): the
 * borrower-facing form of 21.2 (LE), 21.3 (companions), 21.4 (intent, locks), 21.5 (changed circumstances, revised LEs,
 * tolerance cures) and 25.1. Every card here is created through 32.1's `send_card` as the `intake` agent on the owning
 * process's event; nothing here computes a regulatory date or a money figure — dates come from `timers`, figures from
 * the owning process's own event snapshots.
 *
 *   disclosure.le.rendered{v1}                       StatusCard `le.preparing` (next: REGZ_1026_19E1_LE_3BD.due_at)
 *   escalation.created{stage=le_terms}               StatusCard `terms.pending_mlo` (next: the SLA's due_at)
 *   disclosure.le.delivered (electronic)             DocumentCard `le.delivered` {requires_ack} — held back while 21.3's ARM gate is closed (T4)
 *   disclosure.le.mailed                             StatusCard `le.mailed` + the E-SIGN ConsentCard re-offered (T1)
 *   disclosure.le.received / .deemed_received        the LE card collapses to its receipt; ChoiceCard `intent.title` (only now — T5)
 *   disclosure.companion.delivered{kind}             DocumentCard per companion, grouped with the LE (`package_id`) (T3, T4)
 *   arm.disclosures.delivered                        the deferred LE card, after the ARM pair (T4)
 *   consent.esign.active after a mailed LE           DocumentCard `le.electronic_copy` — a new Documents row; the mailing evidence stays (T1)
 *   intent.to_proceed.received{valid}                StatusCard `intent.received`; ComparisonCard `lock.compare.title` from valid pricing_quotes (+ Keep floating)
 *   lock.requested / lock.executed / lock.relocked   StatusCards `lock.pending_mlo` / `lock.executed`
 *   lock.expiry.warned (SM_LOCK_EXPIRY_WARN_7)       StatusCard `lock.expiry_warn` (+ extend/wait ChoiceCard when a closing is scheduled) (T6)
 *   lock.expired (SM_LOCK_EXPIRY_DEADLINE)           StatusCard `lock.expired` + `lock.required_before_closing` (why no closing slot) (T7)
 *   disclosure.le.revised{version=n}                 DocumentCard `revised_le.delivered` with the What-changed diff of the v(n−1)/v(n) snapshots (T9)
 *   changed_circumstance.recorded{reflected_on=cd}   StatusCard `revised_le.on_cd_instead` (T8)
 *   tolerance.refund.issued                          NoticeCard `tolerance.refund.notice` — no action (T10)
 *   tick                                             the 21.2 mailbox sweep and the 21.4 expiry playbook (src/runtime/origination.ts) (T2, T6, T7)
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { EntityStore } from "../../../app/tools.ts";
import { NOTICE_CODES } from "../../../domain/application/ops-21-3.ts";
import { originationDailySweep } from "../../origination.ts";
import { timerLabel } from "../record.ts";
import type { BorrowerFlow, FlowDeps } from "./index.ts";

export const FLOW_ID = "32.4";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const PRICING: Actor = { kind: "agent", id: "pricing" };
const RUN = { runId: "flow:32.4", modelVersion: "borrower flows (deterministic)", promptVersion: "32.4" } as const;
export const LE_NOTICE_CODE = "NTC_REGZ_1026_37_LE";
export const CORRECTED_CD_NOTICE_CODE = "NTC_REGZ_1026_38_CD_CORRECTED";
/** 32.4 §2: companion kind → the borrower copy key (`companion.state` carries the state as a token). */
export const COMPANION_COPY: Readonly<Record<string, string>> = { hcl: "companion.hcl", toolkit: "companion.toolkit", afba: "companion.afba", regb_appraisal_notice: "companion.appraisal_notice", hpml: "companion.appraisal_notice", credit_score_notice: "companion.score_notice", rbp_notice: "companion.score_notice", arm_program: "companion.arm", charm: "companion.arm", privacy: "companion.privacy", co_admt: "companion.co_admt", tx_12day: "companion.tx_12day" };
/** 32.4 §2 "Ack?": the AfBA (signature), the Texas 12-day notice, the privacy notice when posted electronically (7.4 rule 10). */
const companionRequiresAck = (kind: string, channel: string): boolean => kind === "afba" || kind === "tx_12day" || (kind === "privacy" && channel === "esign_portal");
/** 21.5's changed-circumstance kinds → the plain-language copy key of the What-changed block. */
export const CC_KIND_COPY: Readonly<Record<string, string>> = { extraordinary_event: "revised_le.kind.extraordinary_event", inaccurate_info: "revised_le.kind.inaccurate_info", new_info: "revised_le.kind.new_info", eligibility_change: "revised_le.kind.eligibility_change", borrower_request: "revised_le.kind.borrower_request", rate_lock: "revised_le.kind.rate_lock", le_expired: "revised_le.kind.le_expired", construction_delay: "revised_le.kind.construction_delay" };
const REACTS = new Set(["disclosure.le.rendered", "escalation.created", "disclosure.le.delivered", "disclosure.le.mailed", "disclosure.le.received", "disclosure.le.deemed_received", "disclosure.companion.delivered", "disclosure.companion.mailed", "arm.disclosures.delivered", "consent.esign.active", "consent.granted",
  "intent.to_proceed.received", "lock.requested", "lock.executed", "lock.relocked", "lock.extended", "lock.expiry.warned", "lock.expired", "disclosure.le.revised", "changed_circumstance.recorded", "disclosure.cd.revised_estimate.requested", "tolerance.refund.issued"]);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: string | bigint | number): string => USD.format(Number(BigInt(String(cents))) / 100);

// ---------------------------------------------------------------- the application context one batch works on
interface Party { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string }
interface Ctx { readonly appId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly now: string }
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);

async function context(deps: FlowDeps, appId: string): Promise<Ctx> {
  const [events, records, parties] = await Promise.all([
    deps.runtime.uow.events.byApplication(appId),
    deps.runtime.entities.load({ applicationId: appId }),
    deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT party_id, id AS application_borrower_id, legal_name FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at, id`, [appId])]);
  const store = new EntityStore(); store.seed(records);
  return { appId, events, store, parties, now: deps.runtime.clock.now() };
}
/** 21.3's per-borrower rows name the interview's own borrower id ("B1", "B-A"); the intake application maps it to the application_borrowers row by legal name. */
function partiesFor(ctx: Ctx, borrowerId: unknown): readonly Party[] {
  if (typeof borrowerId !== "string" || !borrowerId) return ctx.parties;
  const intake = ctx.store.get("applications", ctx.appId)?.data as { borrowers?: { id: string; legal_name: string }[] } | undefined;
  const b = intake?.borrowers?.find((x) => x.id === borrowerId);
  const own = ctx.parties.filter((p) => p.application_borrower_id === borrowerId || (b && p.legal_name === b.legal_name));
  return own.length ? own : ctx.parties;
}

// ---------------------------------------------------------------- card and thread primitives (32.1's tools as the intake agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string; readonly flow_key: string; readonly informational?: boolean; readonly personal_terms?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, ctx: Ctx, party: Party, c: CardSpec): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { application_id: ctx.appId }, created_by: "agent:intake",
      ...(c.personal_terms ? { personal_terms: true, mlo_review_approved: has(ctx, "disclosure.le.mlo_approved") || has(ctx, "lock.approved") } : {}), rationale: `32.4 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  // a card with no action (StatusCard, NoticeCard, PersonCard) is never the pinned ask: it is filed as read the moment it is sent (01 §3.1 "No action")
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", ctx.now, { informational: true, resolved_by: "system:flow-32.4" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx, p, c)); return ids; }
/** Move every party's card on a flow key that is still pending (a newer card for the same ask, an ask withdrawn, a receipt that arrived out of band). */
async function transitionAll(deps: FlowDeps, ctx: Ctx, flowKeyPrefix: string, to: "resolved" | "superseded" | "cancelled", evidence: P): Promise<number> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE $2`, [ctx.appId, `${flowKeyPrefix}%`]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, to, "system", ctx.now, { ...evidence, resolved_by: "system:flow-32.4" });
  return rows.length;
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true });
async function timerDue(deps: FlowDeps, appId: string, code: string): Promise<string | null> {
  const t = (await deps.runtime.db.query<{ due_at: string | null }>(`SELECT due_at FROM timers WHERE application_id = $1 AND code = $2 AND status IN ('armed', 'breached', 'satisfied', 'satisfied_late') ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
  return t?.due_at ?? null;
}

// ---------------------------------------------------------------- the LE package (21.2 + 21.3): one grouped message, each document its own card
const leDisclosureId = (ctx: Ctx): string | null => { const e = last(ctx, "disclosure.le.issued", (p) => Number(p["le_version"] ?? 1) === 1) ?? last(ctx, "disclosure.le.rendered", (p) => Number(p["le_version"] ?? 1) === 1); return e ? String(pl(e)["disclosure_id"]) : null; };
const armGateClosed = (ctx: Ctx): boolean => has(ctx, "application.arm_interest.recorded") && !has(ctx, "arm.disclosures.delivered");
async function leCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const disclosureId = String(p["disclosure_id"]); const version = Number(p["le_version"] ?? 1);
  if (armGateClosed(ctx)) return;   // 21.3: the ARM program disclosure and CHARM come first; the LE receipt card follows `arm.disclosures.delivered`
  const ids = await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "le.delivered", flow_key: `le:${disclosureId}`, command_ref: "disclosure.acknowledgeReceipt",
    props: { document_id: randomUUID(), disclosure_id: disclosureId, notice_code: LE_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", le_version: version, package_id: disclosureId, channel: p["channel"] ?? "esign_portal", delivered_at: p["delivered_at"] ?? e.occurredAt, command_args: { disclosure_id: disclosureId, kind: "le" } } }, partiesFor(ctx, p["borrower_id"]));   // 32.5 T9: a per-consumer delivery (7.4 rule 4) carries `borrower_id` — the electronic card goes to that party only
  await collapseOnReceipt(deps, ctx, disclosureId, ids);
}
/** `received` → the card collapses to its receipt line (32.4 §1: "collapsed receipt line"); a deemed receipt leaves the confirm action available. */
async function collapseOnReceipt(deps: FlowDeps, ctx: Ctx, disclosureId: string, ids?: readonly string[]): Promise<void> {
  const received = last(ctx, "disclosure.le.received", (p) => p["disclosure_id"] === disclosureId && p["evidence"] !== "mailbox_rule");
  if (!received) return;
  const rows = ids ? ids.map((card_instance_id) => ({ card_instance_id })) : await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND status = 'pending' AND props->>'flow_key' = $2`, [ctx.appId, `le:${disclosureId}`]);
  for (const r of rows) { const c = await deps.ui.card(r.card_instance_id); if (c && c.status === "pending") await deps.ui.transitionCard(r.card_instance_id, "resolved", "system", ctx.now, { receipt_evidence: pl(received)["evidence"], received_at: received.occurredAt, manner: "receipt_evidence", resolved_by: "system:flow-32.4" }); }
}
async function companionCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const kind = String(p["kind"] ?? ""); const disclosureId = String(p["disclosure_id"]); const channel = String(p["channel"] ?? (e.type.endsWith("mailed") ? "mail" : "esign_portal"));
  if (kind === "sds" || !kind) return;
  const state = kind.startsWith("state:") ? kind.slice(6) : null;
  const copy_key = state ? "companion.state" : (COMPANION_COPY[kind] ?? "companion.hcl");
  const requires_ack = channel !== "mail" && companionRequiresAck(kind, channel);
  const props: P = { document_id: randomUUID(), disclosure_id: disclosureId, notice_code: (NOTICE_CODES as Record<string, string | null>)[kind] ?? null, title: "", why_you_see_this: "", requires_ack, esign_scope_required: "disclosures", companion_kind: kind, rule_code: p["rule_code"] ?? null, channel, package_id: leDisclosureId(ctx) ?? (typeof p["with_le_disclosure_id"] === "string" && p["with_le_disclosure_id"] ? p["with_le_disclosure_id"] : null),
    ...(state ? { copy_tokens: { state } } : {}), ...(channel === "mail" ? { mailed_at: p["mailed_at"] ?? e.occurredAt } : { delivered_at: p["delivered_at"] ?? e.occurredAt }), command_args: { disclosure_id: disclosureId, kind: "companion" } };
  await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key, flow_key: `companion:${disclosureId}`, ...(requires_ack ? { command_ref: "disclosure.acknowledgeReceipt" } : {}), props, informational: !requires_ack }, partiesFor(ctx, p["application_borrower_id"]));
}
/** The intent ChoiceCard appears only after the LE is received | deemed_received (32.4 §3; 32.3-T23). */
async function intentCard(deps: FlowDeps, ctx: Ctx, disclosureId: string): Promise<void> {
  if (has(ctx, "intent.to_proceed.received", (p) => p["valid"] !== false)) return;
  await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "intent.title", flow_key: `intent:${disclosureId}`, command_ref: "intent.record",
    props: { title: "", helper: "", options: [{ id: "proceed", label: "Proceed", is_primary: true }, { id: "not_yet", label: "Not yet" }], command: "intent.record", command_args_by_option: { proceed: { disclosure_id: disclosureId, statement_text: "I want to proceed with this Loan Estimate" }, not_yet: {} }, no_command_options: ["not_yet"], disclosure_version_shown: disclosureId, affirmatives: ["proceed", "yes proceed", "let's proceed", "go ahead", "i want to proceed"] } });
}

// ---------------------------------------------------------------- locks (21.4): the ComparisonCard from pricing_quotes rows inside their validity, never a computed expiry
interface Quote { quote_id: string; quoted_at?: string; quote_ttl_minutes?: number; valid_until?: string; expires_at?: string; note_rate_pct?: string; lock_period_days?: number; points_pct?: string; lender_credit_pct?: string; pi_cents?: bigint | string; loan_amount_cents?: bigint | string; product_code?: string; inputs?: { lock_period_days?: number; loan_amount_cents?: bigint | string }; outcome?: string; superseded_at?: string | null }
function validQuotes(ctx: Ctx): Quote[] {
  const nowMs = Date.parse(ctx.now);
  return ctx.store.list("pricing_quotes", (d) => d.application_id === ctx.appId || d.application_id === undefined).map((r) => r.data as unknown as Quote).filter((q) => {
    if (q.superseded_at) return false;
    if (q.quoted_at && q.quote_ttl_minutes) return Date.parse(q.quoted_at) + q.quote_ttl_minutes * 60_000 >= nowMs;   // 21.4 SM_QUOTE_VALIDITY_GATE: the quote's own TTL
    const until = q.valid_until ?? q.expires_at; return typeof until === "string" && Date.parse(until) >= nowMs;
  }).filter((q) => typeof q.note_rate_pct === "string");
}
function lockColumns(quotes: readonly Quote[]): { columns: P[]; recommended_id: string | null; by_option: Record<string, P> } {
  const columns: P[] = []; const by_option: Record<string, P> = {};
  for (const q of quotes) {
    const days = q.lock_period_days ?? q.inputs?.lock_period_days ?? null;
    const rows: P[] = [{ label: "Rate", value: `${q.note_rate_pct}%`, emphasis: true }];
    if (days !== null) rows.push({ label: "Lock period", value: `${days} days` });
    if (q.pi_cents !== undefined) rows.push({ label: "Principal & interest", value: `${money(q.pi_cents)}/mo` });
    if (q.points_pct !== undefined && q.points_pct !== "0.000") rows.push({ label: "Points", value: `${q.points_pct}% of the loan amount (cost)` });
    if (q.lender_credit_pct !== undefined && q.lender_credit_pct !== "0.000") rows.push({ label: "Lender credit", value: `${q.lender_credit_pct}% of the loan amount (credit)` });
    if (days !== null) rows.push({ label: "Expires", value: `${days} days after your lock is executed` });
    columns.push({ id: q.quote_id, title: days !== null ? `${days}-day lock` : `Quote ${q.quote_id.slice(0, 8)}`, rows });
    by_option[q.quote_id] = { quote_id: q.quote_id, ...(days !== null ? { period_days: days } : {}) };
  }
  // recommended = the shortest period (the projected closing date + 7 days is inside every offered period until a closing is scheduled — 32.4 §4.1)
  const shortest = quotes.map((q) => ({ id: q.quote_id, days: q.lock_period_days ?? q.inputs?.lock_period_days ?? Number.MAX_SAFE_INTEGER })).sort((a, b) => a.days - b.days)[0];
  return { columns, recommended_id: shortest?.id ?? null, by_option };
}
/** The property's state for 21.4 `requestLock{property_state}`: the subject application_properties row, else 21.1's intake record (its `property_state`, or the state inside the confirmed six-item address — an organic application opened at the account door has no properties row until the home is confirmed, 32.16 §2.0). */
async function propertyStateOf(deps: FlowDeps, ctx: Ctx): Promise<string | null> {
  const row = (await deps.runtime.db.query<{ state: string | null }>(`SELECT state FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [ctx.appId]))[0];
  if (row?.state) return row.state;
  const intake = ctx.store.get("applications", ctx.appId)?.data as P | undefined;
  if (typeof intake?.["property_state"] === "string" && intake["property_state"]) return String(intake["property_state"]);
  const item = (intake?.["six_items"] as Record<string, P> | undefined)?.["property_address"]; const address = String(item?.["value"] ?? intake?.["property_address"] ?? "");
  const m = /\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/.exec(address); return m ? m[1]! : null;
}
async function lockCompareCard(deps: FlowDeps, ctx: Ctx, flowKey: string, copy_key: "lock.compare.title" | "lock.relock.title"): Promise<boolean> {
  const quotes = validQuotes(ctx); if (!quotes.length) return false;   // 32.4 §4.4: never a rate that is not a pricing_quotes row within SM_QUOTE_VALIDITY_GATE
  const { columns, recommended_id, by_option } = lockColumns(quotes);
  const property_state = await propertyStateOf(deps, ctx);   // what `lock.request` needs beside the quote (commands.ts fills it from application_properties when the row exists)
  await sendToAll(deps, ctx, { kind: "ComparisonCard", copy_key, flow_key: flowKey, command_ref: "lock.request", personal_terms: true,
    props: { title: "", columns, recommended_id, command: "lock.request", ...(property_state ? { command_args: { property_state } } : {}), command_args_by_option: by_option, secondary_option: { id: "float", label: "Keep floating" }, no_command_options: ["float"], footnote: "", affirmatives: ["lock it", "lock", "lock my rate"] } });
  return true;
}
const lockOf = (ctx: Ctx, lockId: unknown): P | undefined => (typeof lockId === "string" ? (ctx.store.get("locks", lockId)?.data as P | undefined) : undefined);
async function lockWarnCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const lockId = String(p["lock_id"]); const expiresOn = String(p["expires_on"] ?? ""); const closingOn = typeof p["closing_scheduled_on"] === "string" ? (p["closing_scheduled_on"] as string) : null;
  let quote: { days: number; fee_cents: string } | null = null;
  if (closingOn && p["closing_inside_lock"] === false) {
    try { const r = await deps.runtime.execute({ process: "21.4", name: "quoteExtension", loanId: "", applicationId: ctx.appId, actor: PRICING, input: { application_id: ctx.appId, lock_id: lockId, new_closing_on: closingOn, delay_attribution: "borrower" } }); const o = r.output as { days: number; fee_cents: bigint | string }; quote = { days: o.days, fee_cents: String(o.fee_cents) }; } catch { quote = null; }
  }
  await sendToAll(deps, ctx, StatusCard(quote ? "lock.expiry_warn" : "lock.expiry_warn.no_closing", `lock.warn:${lockId}`, { copy_tokens: { date: expiresOn, ...(quote ? { cost: money(quote.fee_cents), days: String(quote.days) } : {}) }, next_event_label: timerLabel("SM_LOCK_EXPIRY_DEADLINE"), next_event_at: lockOf(ctx, lockId)?.["expires_at"] ?? null, lock_id: lockId }));
  if (quote) await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "lock.extend.choice", flow_key: `lock.extend:${lockId}`, command_ref: "lock.requestExtension",
    props: { title: "", options: [{ id: "extend", label: `Extend ${quote.days} days (${money(quote.fee_cents)})`, is_primary: true }, { id: "wait", label: "Wait" }], command: "lock.requestExtension", command_args_by_option: { extend: { lock_id: lockId, new_closing_on: closingOn, days: quote.days }, wait: {} }, no_command_options: ["wait"], copy_tokens: { days: String(quote.days), cost: money(quote.fee_cents) } } });
}

// ---------------------------------------------------------------- revised LEs (21.5): the What-changed diff of two rendered snapshots
interface Snapshot { rate_pct?: string; pi_cents?: string; points_cents?: string; lender_credits_cents?: string; cash_to_close_cents?: string; total_closing_costs_cents?: string; fees?: { fee_code: string; description?: string; le_section?: string; amount_cents: string }[] }
export interface WhatChangedRow { readonly key: string; readonly label_key?: string; readonly label?: string; readonly from: string | null; readonly to: string | null; readonly unit: "cents" | "rate" }
/** The diff of rows between le_v{n−1} and le_v{n}: rate, points, payment, cash to close, then every fee whose amount moved — from the two `disclosure.le.rendered` snapshots, never free text. */
export function whatChanged(prev: Snapshot, next: Snapshot): WhatChangedRow[] {
  const rows: WhatChangedRow[] = [];
  const s = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
  if (s(prev.rate_pct) !== s(next.rate_pct)) rows.push({ key: "rate", label_key: "revised_le.row.rate", from: s(prev.rate_pct), to: s(next.rate_pct), unit: "rate" });
  if (s(prev.points_cents) !== s(next.points_cents)) rows.push({ key: "points", label_key: "revised_le.row.points", from: s(prev.points_cents), to: s(next.points_cents), unit: "cents" });
  if (s(prev.pi_cents) !== s(next.pi_cents)) rows.push({ key: "payment", label_key: "revised_le.row.payment", from: s(prev.pi_cents), to: s(next.pi_cents), unit: "cents" });
  if (prev.cash_to_close_cents !== undefined && next.cash_to_close_cents !== undefined && s(prev.cash_to_close_cents) !== s(next.cash_to_close_cents)) rows.push({ key: "cash_to_close", label_key: "revised_le.row.cash_to_close", from: s(prev.cash_to_close_cents), to: s(next.cash_to_close_cents), unit: "cents" });
  const before = new Map((prev.fees ?? []).map((f) => [f.fee_code, f])); const after = new Map((next.fees ?? []).map((f) => [f.fee_code, f]));
  for (const code of new Set([...before.keys(), ...after.keys()])) { const a = before.get(code); const b = after.get(code); if (s(a?.amount_cents) === s(b?.amount_cents)) continue; rows.push({ key: `fee:${code}`, label: b?.description ?? a?.description ?? code, from: s(a?.amount_cents), to: s(b?.amount_cents), unit: "cents" }); }
  return rows;
}
async function revisedLeCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const disclosureId = String(p["disclosure_id"]); const version = Number(p["le_version"] ?? p["version"] ?? 2);
  const snap = (v: number): Snapshot => (pl(last(ctx, "disclosure.le.rendered", (x) => Number(x["le_version"] ?? 1) === v) ?? ({ payload: {} } as unknown as DomainEvent)) as Snapshot);
  const prev = snap(version - 1); const next = snap(version);
  const kind = typeof p["reason"] === "string" ? (p["reason"] as string) : null;
  const rows = whatChanged(prev, next);
  const prevId = leDisclosureId(ctx);
  // the older version's card is superseded by the newer version's (32.4 §1: "the newer version's card"; the Record lists the older under Earlier versions)
  await transitionAll(deps, ctx, "le:", "superseded", { superseded_by: disclosureId, le_version: version });
  await transitionAll(deps, ctx, "le.copy:", "superseded", { superseded_by: disclosureId, le_version: version });
  const ids = await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "revised_le.delivered", flow_key: `le:${disclosureId}`, command_ref: "disclosure.acknowledgeReceipt",
    props: { document_id: randomUUID(), disclosure_id: disclosureId, notice_code: LE_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", le_version: version, package_id: disclosureId, supersedes_disclosure_id: prevId, channel: p["channel"] ?? "esign_portal", delivered_at: e.occurredAt,
      what_changed: { since_version: version - 1, kind, kind_copy_key: kind ? (CC_KIND_COPY[kind] ?? null) : null, cc_ids: Array.isArray(p["cc_ids"]) ? p["cc_ids"] : [], rows }, command_args: { disclosure_id: disclosureId, kind: "le" } } });
  await collapseOnReceipt(deps, ctx, disclosureId, ids);
}

// ---------------------------------------------------------------- the reactions, per application, in commit order
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "disclosure.le.rendered": {
      if (Number(p["le_version"] ?? 1) !== 1 || has(ctx, "disclosure.le.issued", (x) => Number(x["le_version"] ?? 1) === 1)) return;
      const due = await timerDue(deps, ctx.appId, "REGZ_1026_19E1_LE_3BD");
      await sendToAll(deps, ctx, StatusCard("le.preparing", `le.preparing:${String(p["disclosure_id"])}`, { next_event_label: timerLabel("REGZ_1026_19E1_LE_3BD"), next_event_at: due, disclosure_id: p["disclosure_id"] })); return;
    }
    case "escalation.created": {
      if (p["stage"] !== "le_terms" || p["kind"] !== "mlo_of_record" || has(ctx, "disclosure.le.issued")) return;
      const nmlsr = last(ctx, "disclosure.le.mlo_approved")?.payload["nmlsr_id"] ?? null;
      await sendToAll(deps, ctx, StatusCard("terms.pending_mlo", `le.pending_mlo:${String(p["disclosure_id"])}`, { next_event_label: timerLabel("SM_O21_MLO_REVIEW_SLA_1BD"), next_event_at: p["sla_due_at"] ?? null, copy_tokens: { "mlo.name": "your loan officer", "mlo.nmlsr_id": nmlsr ?? "", due: String(p["sla_due_at"] ?? "") } })); return;
    }
    case "disclosure.le.delivered": if (String(p["channel"]) !== "in_person" && Number(p["le_version"] ?? 1) === 1) await leCard(deps, ctx, e); return;
    case "disclosure.le.mailed": {
      const disclosureId = String(p["disclosure_id"]);
      const property = (await deps.runtime.db.query<{ a: string | null }>(`SELECT concat_ws(', ', address_line1, city, state || ' ' || postal_code) AS a FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [ctx.appId]))[0]?.a ?? "your mailing address";
      await sendToAll(deps, ctx, StatusCard("le.mailed", `le.mailed:${disclosureId}`, { copy_tokens: { mailing_address: property, date: String(p["issued_on"] ?? e.occurredAt.slice(0, 10)) }, disclosure_id: disclosureId, mailed_at: p["mailed_at"] ?? e.occurredAt }), partiesFor(ctx, p["borrower_id"]));
      // the E-SIGN ConsentCard re-offered (32.4 §1): checkbox + typed name, never a spoken yes
      await sendToAll(deps, ctx, { kind: "ConsentCard", copy_key: "consent.esign.title", flow_key: `esign.reoffer:${disclosureId}`, command_ref: "consent.capture",
        props: { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: ["disclosures", "notices"], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true, verification_state: "none", command_args: { kind: "esign", method: "checkbox_with_text", scope: ["disclosures", "notices"], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE" } } }, partiesFor(ctx, p["borrower_id"]));
      return;
    }
    case "disclosure.le.received": case "disclosure.le.deemed_received": {
      const disclosureId = String(p["disclosure_id"]);
      if (e.type === "disclosure.le.received" && p["evidence"] !== "mailbox_rule") await collapseOnReceipt(deps, ctx, disclosureId);
      await intentCard(deps, ctx, disclosureId); return;
    }
    case "disclosure.companion.delivered": case "disclosure.companion.mailed": await companionCard(deps, ctx, e); return;
    case "arm.disclosures.delivered": { const d = last(ctx, "disclosure.le.delivered", (x) => Number(x["le_version"] ?? 1) === 1); if (d) await leCard(deps, ctx, d); return; }
    case "consent.esign.active": case "consent.granted": {
      if (e.type === "consent.granted" && !(p["kind"] === "esign" && p["status"] === "active")) return;
      const mailed = last(ctx, "disclosure.le.mailed"); if (!mailed) return;
      const disclosureId = String(pl(mailed)["disclosure_id"]);
      if (has(ctx, "disclosure.le.received", (x) => x["disclosure_id"] === disclosureId)) return;
      // an electronic copy of the mailed LE now that e-delivery is on: a new Documents row; the mailing (and its mailbox rule) stays the delivery of record (T1)
      await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "le.electronic_copy", flow_key: `le.copy:${disclosureId}`, command_ref: "disclosure.acknowledgeReceipt",
        props: { document_id: randomUUID(), disclosure_id: disclosureId, copy_of_disclosure_id: disclosureId, electronic_copy: true, notice_code: LE_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", le_version: Number(pl(mailed)["le_version"] ?? 1), channel: "esign_portal", delivered_at: ctx.now, mailed_at: pl(mailed)["mailed_at"] ?? mailed.occurredAt, copy_tokens: { date: String(pl(mailed)["issued_on"] ?? mailed.occurredAt.slice(0, 10)) }, command_args: { disclosure_id: disclosureId, kind: "le" } } });
      return;
    }
    case "intent.to_proceed.received": {
      if (p["valid"] === false) return;
      await transitionAll(deps, ctx, "intent:", "cancelled", { reason: "intent recorded through another channel", intent_id: p["intent_id"] ?? null });
      await sendToAll(deps, ctx, StatusCard("intent.received", `intent.received:${String(p["intent_id"] ?? e.id)}`, { copy_tokens: { prior_servicer: "your current servicer" } }));
      await lockCompareCard(deps, ctx, `lock.compare:${String(p["intent_id"] ?? e.id)}`, "lock.compare.title"); return;
    }
    case "lock.requested": {
      await transitionAll(deps, ctx, "lock.compare:", "superseded", { lock_id: p["lock_id"] });
      await sendToAll(deps, ctx, StatusCard("lock.pending_mlo", `lock.pending:${String(p["lock_id"])}`, { copy_tokens: { "mlo.name": "Your loan officer" }, next_event_label: timerLabel("SM_LOCK_MLO_APPROVAL_SLA_30MIN"), next_event_at: await timerDue(deps, ctx.appId, "SM_LOCK_MLO_APPROVAL_SLA_30MIN"), lock_id: p["lock_id"] })); return;
    }
    case "lock.executed": case "lock.relocked": case "lock.extended": {
      await transitionAll(deps, ctx, "lock.compare:", "superseded", { lock_id: p["lock_id"] }); await transitionAll(deps, ctx, "lock.relock:", "superseded", { lock_id: p["lock_id"] }); await transitionAll(deps, ctx, "lock.extend:", "resolved", { lock_id: p["lock_id"] });
      const lock = lockOf(ctx, p["lock_id"]); const expiresOn = String(p["new_expires_on"] ?? p["expires_on"] ?? lock?.["expires_on"] ?? "");
      await sendToAll(deps, ctx, StatusCard("lock.executed", `lock.executed:${String(p["lock_id"])}:${e.type}`, { copy_tokens: { rate: `${String(p["note_rate"] ?? lock?.["note_rate"] ?? "")}%`, expires_at: expiresOn }, next_event_label: timerLabel("SM_LOCK_EXPIRY_DEADLINE"), next_event_at: p["new_expires_at"] ?? p["expires_at"] ?? lock?.["expires_at"] ?? null, lock_id: p["lock_id"] })); return;
    }
    case "lock.expiry.warned": await lockWarnCards(deps, ctx, e); return;
    case "lock.expired": {
      await transitionAll(deps, ctx, "lock.extend:", "cancelled", { reason: "the lock expired" });
      await sendToAll(deps, ctx, StatusCard("lock.expired", `lock.expired:${String(p["lock_id"])}`, { copy_tokens: { date: String(p["expires_on"] ?? "") }, lock_id: p["lock_id"] }));
      // why no closing slot can be offered until a relock: SM_O71_DOC_GEN_GATE needs an active lock through the closing date (32.4 §4.1, T7)
      await sendToAll(deps, ctx, StatusCard("lock.required_before_closing", `lock.required:${String(p["lock_id"])}`, { gate: "SM_O71_DOC_GEN_GATE", lock_id: p["lock_id"] }));
      await lockCompareCard(deps, ctx, `lock.relock:${String(p["lock_id"])}`, "lock.relock.title"); return;
    }
    case "disclosure.le.revised": await revisedLeCard(deps, ctx, e); return;
    case "changed_circumstance.recorded": case "disclosure.cd.revised_estimate.requested": {
      const route = String(p["reflected_on"] ?? p["route"] ?? "le"); if (route !== "cd" && route !== "corrected_cd") return;
      const kind = typeof p["kind"] === "string" ? (p["kind"] as string) : null;
      await sendToAll(deps, ctx, StatusCard("revised_le.on_cd_instead", `cc.on_cd:${String(p["cc_id"])}`, { cc_id: p["cc_id"], reflected_on: route, change_kind: kind, kind_copy_key: kind ? (CC_KIND_COPY[kind] ?? null) : null })); return;
    }
    case "tolerance.refund.issued": {
      await sendToAll(deps, ctx, { kind: "NoticeCard", copy_key: "tolerance.refund.notice", flow_key: `refund:${String(p["cure_id"])}`, informational: true,
        props: { notice_code: CORRECTED_CD_NOTICE_CODE, title: "", rendered_document_id: randomUUID(), plain_language: "", line: "", template_version: null, delivered_at: e.occurredAt, channel: "app", copy_tokens: { money: money(String(p["amount_cents"] ?? "0")), date: String(p["sent_on"] ?? ""), due: String(p["due_on"] ?? "") }, amount_cents: String(p["amount_cents"] ?? "0"), instrument: p["instrument"] ?? null, sent_on: p["sent_on"] ?? null, due_on: p["due_on"] ?? null, ledger_set_id: p["ledger_set_id"] ?? null, cure_id: p["cure_id"] ?? null } });
      return;
    }
    default: return;
  }
}

export const FLOW_4_DISCLOSURES: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byApp = new Map<string, DomainEvent[]>();
    for (const e of events) { const app = e.applicationId ?? (typeof (e.payload as P)["application_id"] === "string" ? String((e.payload as P)["application_id"]) : null); if (!app) continue; const list = byApp.get(app) ?? []; list.push(e); byApp.set(app, list); }
    for (const [appId, list] of byApp) {
      const ctx = await context(deps, appId);
      if (!ctx.parties.length) continue;   // no borrower party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-4.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  async tick(deps, nowIso) { await originationDailySweep(deps.runtime, nowIso); },
};
