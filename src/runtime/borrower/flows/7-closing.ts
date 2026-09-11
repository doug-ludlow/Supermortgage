/**
 * 32.7 — CD, closing, rescission, funding, boarding (spec/sections/32-borrower-experience/32-7-*.md): the borrower-facing
 * form of 25.2 (CD), 25.3 (rescission), 25.4 (closing-time notices), 26.1–26.3 (closing documents, signing, funding),
 * 30.2–30.4 (boarding, the first 90 days). Every card is created through 32.1's `send_card` as the `intake` agent on the
 * owning process's event; nothing here computes a regulatory date or a money figure — dates are the owning process's own
 * (`timers.due_at`, 25.2's `earliest_consummation_date`, 25.3's `expires_at`, 26.3's funding calendar), figures are the
 * rendered snapshots (21.2's LE render, 25.2's CD figures on the disclosures row).
 *
 *   disclosure.cd.prepared                        StatusCard `cd.preparing` (next: SM_O62_CD_TARGET_4SBD.due_at)
 *   disclosure.cd.delivered{esign_portal|email}   DocumentCard `cd.delivered` {requires_ack} + What-changed (LE→CD) + the wire-fraud line (T1)
 *   disclosure.cd.delivered{mail|email_link}      StatusCard `cd.mailbox` — "counts as received on {{presumed_receipt_date}}" (T1, T3)
 *   disclosure.cd.received                        the consumer's CD card collapses to its receipt
 *   disclosure.cd.waiting_period.computed         a corrected CD's `cd.redisclosed_restart` with the recomputed date (T2); the closing ScheduleCard (T4)
 *   disclosure.cd.corrected{new_waiting_period}   the superseding DocumentCard `cd.corrected` with What-changed vs the prior version (T2)
 *   clear_to_close.issued                         ScheduleCard{ron_session} once 25.2's date is known and the §2 gates hold; ChoiceCard electronic/paper (T4, T5)
 *   closing.scheduled                             StatusCard `closing.confirmed` / `closing.paper_path`; PersonCards; the schedule cards close (T5)
 *   closing.documents.released                    HandoffCard{ron_platform | settlement_agent} `closing.presign` / `closing.wet.handoff`
 *   closing.pre_session_checks.passed             StatusCards `closing.all_set` + `closing.package_items`
 *   closing.consummated{!rescindable}             StatusCard `signed.purchase` (T7)
 *   rescission.notice.delivered                   DocumentCard `rescission.notice` {NTC_REGZ_1026_23_H8|H9, requires_ack} with the quiet "How to cancel" link (T6)
 *   rescission.period.started                     StatusCard `signed.refi` (midnight expires_on · funding on 26.3's earliest_funding_date) (T6)
 *   "How to cancel" (message)                     ChoiceCard `rescission.confirm` → rescission.exercise (T8)
 *   rescission.exercised                          every pending card cancelled; StatusCard `rescission.cancelled`; the Record reads Cancelled (T8)
 *   rescission.confirmed_not_rescinded            StatusCard `rescission.expired`
 *   funding.authorized                            StatusCard `funding.progress`
 *   funding.held{reason}                          StatusCard `funding.held` + the single borrower ask when the hold is a borrower item (T9)
 *   loan.funded                                   StatusCard `funded.refi` / `funded.purchase` + `funded.no_skip` (T10)
 *   loan.boarded                                  StatusCard `boarding.welcome` (T11)
 *   notice.sent{NTC_SM_FIRST_PAYMENT_LETTER}      NoticeCard `first_payment.letter`; ConsentCard{autodraft_authorization} with the 2.x rule-1 elements (T11)
 *   consents.boarded{invitation_required}         ConsentCard{esign, servicing scopes} `consent.esign.servicing` + `statement.paper_until_esign` (T12)
 *   escrow.statement.sent{initial}                DocumentCard `escrow.initial_statement`
 *   loan.purchased                                25.4 evaluateOwnershipTransfer + 30.4 explainFnmaLetter; HandoffCard{fannie_mae_letter} + UploadCard (T13)
 *   document.received{fnma_loan_purchase_letter}  22.1 classify; 30.4/25.4 evidence → `ownership_transfer_notices.evidenced` (T13)
 *   tick                                          25.2's mailbox sweep (`computeEarliestConsummation{op: deem}`) on/after each presumed receipt date (T1, T3)
 *
 * Vendor fakes this flow touches are named FAKE: the eClosing / RON platform's slot calendar and settlement-agent directory
 * (`FAKE_ECLOSING_DIRECTORY`), the document classifier's borrower-declared pass.
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { EntityStore } from "../../../app/tools.ts";
import { timerLabel } from "../record.ts";
import type { BorrowerFlow, FlowDeps, FlowReply, InboundMessage } from "./index.ts";

export const FLOW_ID = "32.7";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" };
const CLOSER: Actor = { kind: "agent", id: "title-closing" };
const FUNDER: Actor = { kind: "agent", id: "funder" };
const BOARDING: Actor = { kind: "agent", id: "boarding" };
const VERIFICATION: Actor = { kind: "agent", id: "verification" };
const RUN = { runId: "flow:32.7", modelVersion: "borrower flows (deterministic)", promptVersion: "32.7" } as const;
export const CD_NOTICE_CODE = "NTC_REGZ_1026_38_CD";
export const CORRECTED_CD_NOTICE_CODE = "NTC_REGZ_1026_38_CD_CORRECTED";
export const H8_NOTICE_CODE = "NTC_REGZ_1026_23_H8";
export const H9_NOTICE_CODE = "NTC_REGZ_1026_23_H9";
export const FIRST_PAYMENT_LETTER = "NTC_SM_FIRST_PAYMENT_LETTER";
export const INITIAL_ESCROW_STMT = "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT";
export const OWNERSHIP_NOTICE = "NTC_REGZ_1026_39_OWNERSHIP_TRANSFER";
/** 22.1's document class for the borrower's forwarded Fannie Mae loan purchase letter (30.4 HO-009 evidence). */
export const FNMA_LETTER_CLASS = "fnma_loan_purchase_letter";
/** The E-SIGN classes 30.2 boards as servicing scope (SERVICING_CONSENT_CLASSES); re-offered when E6 covered origination only (32.7 §6 item 3). */
export const SERVICING_ESIGN_SCOPES = ["periodic_statements", "escrow_statements", "regx_correspondence", "arm_notices", "privacy_notices", "lossmit_notices", "early_intervention_notices", "insurance_notices", "pmi_notices", "payoff_statements", "general_correspondence"] as const;
/** 2.3 rule 1 — the Nacha / Reg E authorization elements every autopay ConsentCard shows (32.7 §6 item 2). */
export const AUTODRAFT_ELEMENTS = ["borrower", "loan", "account", "amount", "amount_variable", "timing", "first_debit", "company", "revoke", "date", "esign"] as const;
export type AutodraftElement = (typeof AUTODRAFT_ELEMENTS)[number];
export const CLOSING_TYPES = ["ron", "ipen", "hybrid", "wet"] as const;
export type ClosingType = (typeof CLOSING_TYPES)[number];
export const REFUND_CLOCK = "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD";

const REACTS = new Set(["disclosure.cd.prepared", "disclosure.cd.delivered", "disclosure.cd.received", "disclosure.cd.waiting_period.computed", "disclosure.cd.corrected", "clear_to_close.issued", "lock.executed",
  "closing.scheduled", "closing.rescheduled", "closing.documents.released", "closing.pre_session_checks.passed", "closing.session.started", "closing.session.failed", "closing.consummated",
  "rescission.notice.delivered", "rescission.period.started", "rescission.exercised", "rescission.confirmed_not_rescinded",
  "funding.authorized", "funding.held", "funding.conditions.evaluated", "loan.funded",
  "loan.boarded", "notice.sent", "consents.boarded", "escrow.statement.sent", "loan.purchased", "document.received"]);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: string | bigint | number | null | undefined): string => USD.format(Number(BigInt(String(cents ?? "0"))) / 100);
/** The FAKE eClosing directory: one settlement agent per property state, RON- and IPEN-capable, on the FAKE RON platform (26.2's `eclosing_eligibility` shape). */
export const FAKE_ECLOSING_DIRECTORY = { vendor: "FAKE eClosing platform", agent: (state: string) => ({ settlement_agent_party_id: `P-ESCROW-${state}-1`, county_fips: null, ron_capable: true, ipen_capable: true, erecording_submitter: true, platforms: ["FAKE RON platform"], remote_witness_service: false, verified_at: "2026-10-20T00:00:00.000Z", verified_by: "title-closing" }) } as const;
/** The property state's local zone for the FAKE platform's slot calendar (labels only; no regulatory date is computed here). */
const TZ_BY_STATE: Readonly<Record<string, string>> = { AZ: "America/Phoenix", CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles", CO: "America/Denver", UT: "America/Denver", NM: "America/Denver", TX: "America/Chicago", IL: "America/Chicago", MN: "America/Chicago", HI: "Pacific/Honolulu", AK: "America/Anchorage" };
export const timeZoneFor = (state: string | null | undefined): string => TZ_BY_STATE[String(state ?? "").toUpperCase()] ?? "America/New_York";
const WET_STATES = new Set(["CA", "NV", "WA", "OR", "ID", "HI", "AK"]);

// ---------------------------------------------------------------- the application context one batch works on
interface Party { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string }
interface AppRow { readonly transaction_type: string | null; readonly prior_loan_id: string | null; readonly loan_id: string | null; readonly partner_legal_name: string | null; readonly prior_servicer: string | null; readonly state: string | null; readonly county: string | null; readonly address: string | null }
interface Ctx { readonly appId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly app: AppRow; readonly now: string }
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);
const s = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

async function context(deps: FlowDeps, appId: string): Promise<Ctx> {
  const [events, records, parties, rows] = await Promise.all([
    deps.runtime.uow.events.byApplication(appId),
    deps.runtime.entities.load({ applicationId: appId }),
    deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT party_id, id AS application_borrower_id, legal_name FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at, id`, [appId]),
    deps.runtime.db.query<AppRow & Record<string, unknown>>(`SELECT a.transaction_type, a.prior_loan_id, a.loan_id, p.legal_name AS partner_legal_name, pp.legal_name AS prior_servicer, ap.state, ap.county, concat_ws(', ', ap.address_line1, ap.city, ap.state || ' ' || ap.postal_code) AS address
      FROM applications a LEFT JOIN parties p ON p.id = a.partner_party_id LEFT JOIN loans pl ON pl.id = a.prior_loan_id LEFT JOIN parties pp ON pp.id = pl.partner_party_id
      LEFT JOIN LATERAL (SELECT address_line1, city, state, postal_code, county FROM application_properties WHERE application_id = a.id ORDER BY is_subject DESC, created_at LIMIT 1) ap ON true WHERE a.id = $1`, [appId])]);
  const store = new EntityStore(); store.seed(records);
  const app: AppRow = rows[0] ?? { transaction_type: null, prior_loan_id: null, loan_id: null, partner_legal_name: null, prior_servicer: null, state: null, county: null, address: null };
  return { appId, events, store, parties, app, now: deps.runtime.clock.now() };
}
/** 25.2/25.3's consumer ids and 30.2's party ids name the interview's own borrower id ("B1") or the application_borrowers row; the intake application maps the former by legal name. */
function partiesFor(ctx: Ctx, borrowerId: unknown): readonly Party[] {
  if (typeof borrowerId !== "string" || !borrowerId) return ctx.parties;
  const intake = ctx.store.get("applications", ctx.appId)?.data as { borrowers?: { id: string; legal_name: string }[] } | undefined;
  const b = intake?.borrowers?.find((x) => x.id === borrowerId);
  const own = ctx.parties.filter((p) => p.application_borrower_id === borrowerId || p.party_id === borrowerId || (b && p.legal_name === b.legal_name));
  return own.length ? own : ctx.parties;
}
const isPurchase = (ctx: Ctx): boolean => ctx.app.transaction_type === "purchase";
const loanIdOf = (ctx: Ctx, e?: DomainEvent): string => (e?.loanId as string | undefined) ?? ctx.app.loan_id ?? "";

// ---------------------------------------------------------------- card and thread primitives (32.1's tools as the intake agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string; readonly flow_key: string; readonly informational?: boolean; readonly loan_id?: string | null }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, ctx: Ctx, party: Party, c: CardSpec): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: c.loan_id ?? "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { application_id: ctx.appId, ...(c.loan_id ? { loan_id: c.loan_id } : {}) }, created_by: "agent:intake", rationale: `32.7 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  // a card with no action (StatusCard, NoticeCard, PersonCard, HandoffCard without a launch) is never the pinned ask: filed as read the moment it is sent (01 §3.1)
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", ctx.now, { informational: true, resolved_by: "system:flow-32.7" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx, p, c)); return ids; }
/** Move every party's pending card on a flow-key prefix (a newer card for the same ask, an ask withdrawn, a receipt that arrived out of band). An empty prefix moves every pending card of the subject. */
async function transitionAll(deps: FlowDeps, ctx: Ctx, flowKeyPrefix: string, to: "resolved" | "superseded" | "cancelled", evidence: P): Promise<number> {
  const rows = flowKeyPrefix
    ? await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE $2`, [ctx.appId, `${flowKeyPrefix}%`])
    : await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE (subject_application_id = $1 OR ($2::uuid IS NOT NULL AND subject_loan_id = $2)) AND status = 'pending'`, [ctx.appId, ctx.app.loan_id]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, to, "system", ctx.now, { ...evidence, resolved_by: "system:flow-32.7" });
  return rows.length;
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}, loan_id: string | null = null): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true, ...(loan_id ? { loan_id } : {}) });
async function timerDue(deps: FlowDeps, appId: string, code: string): Promise<string | null> {
  const t = (await deps.runtime.db.query<{ due_at: string | null }>(`SELECT due_at FROM timers WHERE application_id = $1 AND code = $2 AND status IN ('armed', 'breached', 'satisfied', 'satisfied_late') ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
  return t?.due_at ?? null;
}
const partnerTokens = (ctx: Ctx): P => ({ "partner.legal_name": ctx.app.partner_legal_name ?? "your lender" });

// ---------------------------------------------------------------- the CD (25.2): What-changed since the Loan Estimate, from the two figure snapshots
interface LeSnapshot { rate_pct?: string | undefined; apr?: string | undefined; pi_cents?: string | undefined; points_cents?: string | undefined; lender_credits_cents?: string | undefined; cash_to_close_cents?: string | undefined; fees?: { fee_code: string; description?: string | undefined; amount_cents: string }[] | undefined }
export interface CdFigures { rate_pct?: string | null; apr_pct?: string | null; pi_cents?: string | null; loan_amount_cents?: string | null; cash_to_close_cents?: string | null; lender_credits_cents?: string | null; payoffs_and_payments_cents?: string | null; monthly_escrow_cents?: string | null; initial_escrow_payment_cents?: string | null; fees?: { fee_code: string; description?: string; amount_cents: string; section?: string }[] }
export interface WhatChangedRow { readonly key: string; readonly label_key?: string; readonly label?: string; readonly from: string | null; readonly to: string | null; readonly unit: "cents" | "rate" }
export interface CdCure { readonly cure_id: string; readonly amount_cents: string; readonly fee_code?: string | null }
const abs = (v: string | null): string | null => (v === null ? null : String(BigInt(v) < 0n ? -BigInt(v) : BigInt(v)));
/**
 * The LE→CD row diff (32.7 §1): rate, APR, payment, lender credits, then cash to close (purchase) or the payoff (refinance), then every fee whose amount moved
 * — from 21.2's `disclosure.le.rendered` snapshot and 25.2's CD figures, never free text; 21.5's lender-credit cures render as lender credits.
 */
export function cdWhatChanged(le: LeSnapshot, cd: CdFigures, opts: { purchase: boolean; cures?: readonly CdCure[] } = { purchase: false }): WhatChangedRow[] {
  const rows: WhatChangedRow[] = [];
  const push = (key: string, label_key: string, from: string | null, to: string | null, unit: "cents" | "rate") => { if (from !== to && (from !== null || to !== null)) rows.push({ key, label_key, from, to, unit }); };
  push("rate", "revised_le.row.rate", s(le.rate_pct), s(cd.rate_pct), "rate");
  push("apr", "cd.row.apr", s(le.apr), s(cd.apr_pct), "rate");
  push("payment", "revised_le.row.payment", s(le.pi_cents), s(cd.pi_cents), "cents");
  push("lender_credit", "cd.row.lender_credit", abs(s(le.lender_credits_cents)), abs(s(cd.lender_credits_cents)), "cents");
  if (opts.purchase) push("cash_to_close", "revised_le.row.cash_to_close", s(le.cash_to_close_cents), s(cd.cash_to_close_cents), "cents");
  else { if (cd.payoffs_and_payments_cents !== undefined && cd.payoffs_and_payments_cents !== null) rows.push({ key: "payoff", label_key: "cd.row.payoff", from: null, to: s(cd.payoffs_and_payments_cents), unit: "cents" }); if (cd.monthly_escrow_cents !== undefined && cd.monthly_escrow_cents !== null) rows.push({ key: "escrow", label_key: "cd.row.escrow", from: null, to: s(cd.monthly_escrow_cents), unit: "cents" }); }
  const before = new Map((le.fees ?? []).map((f) => [f.fee_code, f])); const after = new Map((cd.fees ?? []).map((f) => [f.fee_code, f]));
  for (const code of before.keys()) { const a = before.get(code)!; const b = after.get(code); if (!b || s(a.amount_cents) === s(b.amount_cents)) continue; rows.push({ key: `fee:${code}`, label: b.description ?? a.description ?? code, from: s(a.amount_cents), to: s(b.amount_cents), unit: "cents" }); }
  for (const c of opts.cures ?? []) rows.push({ key: `cure:${c.cure_id}`, label_key: "cd.row.tolerance_cure", from: null, to: s(c.amount_cents), unit: "cents" });
  return rows;
}
const cdRow = (ctx: Ctx, disclosureId: string): P | undefined => ctx.store.get("disclosures", disclosureId)?.data as P | undefined;
const cdFiguresOf = (ctx: Ctx, disclosureId: string): CdFigures => ((cdRow(ctx, disclosureId)?.["figures"] as CdFigures | undefined) ?? {});
const leSnapshot = (ctx: Ctx): LeSnapshot => (pl(last(ctx, "disclosure.le.rendered") ?? ({ payload: {} } as unknown as DomainEvent)) as LeSnapshot);
const cures = (ctx: Ctx): CdCure[] => ctx.events.filter((e) => e.type === "tolerance.cure.applied" && pl(e)["method"] === "lender_credit_at_closing").map((e) => ({ cure_id: String(pl(e)["cure_id"] ?? e.id), amount_cents: String(pl(e)["amount_cents"] ?? "0"), fee_code: s(pl(e)["fee_code"]) }));
const cdVersionPrefix = (disclosureId: string): string => `cd:${disclosureId}`;

async function cdDeliveredCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const disclosureId = String(p["disclosure_id"]); const channel = String(p["channel"] ?? "esign_portal"); const version = Number(p["cd_version"] ?? 1); const consumer = p["consumer_id"];
  const parties = partiesFor(ctx, consumer);
  const corrected = version > 1; const post = corrected && has(ctx, "closing.consummated");
  const reason = s(p["cd_reason"]); const newWait = reason === "pre_consummation_new_wait";
  const presumed = s(p["presumed_receipt_date"]);
  // the mailbox StatusCard (32.7 §1 row 2): a mailed or e-mailed CD counts as received on the presumed date unless the consumer confirms sooner
  if (channel === "mail" || channel === "email_link") await sendToAll(deps, ctx, StatusCard("cd.mailbox", `cd.mailbox:${disclosureId}:${String(consumer)}`, { copy_tokens: { date: String(p["delivered_on"] ?? e.occurredAt.slice(0, 10)), presumed_date: presumed ?? "" }, disclosure_id: disclosureId, consumer_id: consumer, channel, mailed_at: p["mailed_at"] ?? null, presumed_receipt_date: presumed, next_event_label: timerLabel("REGZ_1026_19F1III_CD_MAILBOX_3SBD"), next_event_at: await timerDue(deps, ctx.appId, "REGZ_1026_19F1III_CD_MAILBOX_3SBD") }), parties);
  if (channel === "mail" || channel === "courier") return;   // no DocumentCard without an electronic delivery under E-SIGN (01 §3.6); Documents shows *Mailed*
  if (corrected) {
    // the superseding CD: What-changed against the prior version's figures (32.7 §1 `superseded`); post-consummation corrections need no receipt
    const prevId = s(p["supersedes"]) ?? s(cdRow(ctx, disclosureId)?.["supersedes"]) ?? (last(ctx, "disclosure.cd.corrected", (x) => x["disclosure_id"] === disclosureId)?.payload["supersedes"] as string | undefined) ?? null;
    const prevFigures = prevId ? cdFiguresOf(ctx, prevId) : {};
    const nextFigures = cdFiguresOf(ctx, disclosureId);
    const rows = cdWhatChanged({ rate_pct: prevFigures.rate_pct ?? undefined, apr: prevFigures.apr_pct ?? undefined, pi_cents: prevFigures.pi_cents ?? undefined, lender_credits_cents: prevFigures.lender_credits_cents ?? undefined, cash_to_close_cents: prevFigures.cash_to_close_cents ?? undefined, fees: (prevFigures.fees ?? []).map((f) => ({ fee_code: f.fee_code, amount_cents: f.amount_cents, ...(f.description ? { description: f.description } : {}) })) }, { ...nextFigures, payoffs_and_payments_cents: null, monthly_escrow_cents: null }, { purchase: isPurchase(ctx) });
    if (!post) await transitionAll(deps, ctx, prevId ? `${cdVersionPrefix(prevId)}:` : "cd:", "superseded", { superseded_by: disclosureId, cd_version: version });   // the prior version's cards only (`cd:<id>:` — never the superseding version's own key prefix)
    await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: post ? "cd.corrected.post" : "cd.corrected", flow_key: `${cdVersionPrefix(disclosureId)}:${String(consumer)}`, ...(post ? {} : { command_ref: "disclosure.acknowledgeReceipt" }), informational: post,
      props: { document_id: randomUUID(), disclosure_id: disclosureId, notice_code: CORRECTED_CD_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: !post, esign_scope_required: "disclosures", cd_version: version, cd_reason: reason, new_waiting_period: newWait, supersedes_disclosure_id: prevId, channel, delivered_at: p["delivered_at"] ?? e.occurredAt, presumed_receipt_date: presumed, consumer_id: consumer,
        what_changed: { since_version: version - 1, kind: reason, kind_copy_key: newWait ? "cd.redisclosed_restart" : null, title_key: "cd.what_changed", rows }, wire_warning_copy_key: "cd.wire_warning", command_args: { disclosure_id: disclosureId, kind: "cd" } } }, parties);
    return;
  }
  const rows = cdWhatChanged(leSnapshot(ctx), cdFiguresOf(ctx, disclosureId), { purchase: isPurchase(ctx), cures: cures(ctx) });
  await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "cd.delivered", flow_key: `${cdVersionPrefix(disclosureId)}:${String(consumer)}`, command_ref: "disclosure.acknowledgeReceipt",
    props: { document_id: randomUUID(), disclosure_id: disclosureId, notice_code: CD_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", cd_version: version, channel, delivered_at: p["delivered_at"] ?? e.occurredAt, presumed_receipt_date: presumed, consumer_id: consumer,
      what_changed: { since_version: 0, kind: "le_to_cd", kind_copy_key: null, title_key: "cd.what_changed", rows }, wire_warning_copy_key: "cd.wire_warning", command_args: { disclosure_id: disclosureId, kind: "cd" } } }, parties);
}
/** `received` → the consumer's CD card collapses to its receipt line; a mailbox-rule receipt leaves the confirm action available (32.4 §1 rule, mirrored). */
async function collapseCdOnReceipt(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["evidence"] === "mailbox_rule") return;
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND status = 'pending' AND props->>'flow_key' = $2`, [ctx.appId, `${cdVersionPrefix(String(p["disclosure_id"]))}:${String(p["consumer_id"])}`]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, "resolved", "system", ctx.now, { receipt_evidence: p["evidence"], received_at: e.occurredAt, received_on: p["received_on"] ?? null, manner: "receipt_evidence", resolved_by: "system:flow-32.7" });
}

// ---------------------------------------------------------------- scheduling the signing (26.2): the ScheduleCard{ron_session} once the §2 gates hold
const lockOf = (ctx: Ctx): P | undefined => { const rows = ctx.store.list("locks").map((r) => r.data as P); return rows.filter((l) => ["executed", "confirmed"].includes(String(l["status"]))).at(-1) ?? rows.at(-1); };
function scheduleGates(ctx: Ctx): { ok: boolean; earliest: string | null; reasons: string[] } {
  const reasons: string[] = [];
  if (has(ctx, "closing.scheduled")) reasons.push("closing already scheduled");
  if (!has(ctx, "clear_to_close.issued")) reasons.push("not clear to close");
  const wp = last(ctx, "disclosure.cd.waiting_period.computed"); const earliest = wp ? s(pl(wp)["earliest_consummation_date"]) : null;
  if (!earliest) reasons.push("earliest_consummation_date not known");
  const lock = lockOf(ctx);
  if (!lock || !["executed", "confirmed"].includes(String(lock["status"]))) reasons.push("no active lock"); else if (earliest && typeof lock["expires_on"] === "string" && String(lock["expires_on"]) < earliest) reasons.push("lock does not cover the earliest closing date");
  if (has(ctx, "flood.determination.received", (p) => p["sfha"] === true || p["in_sfha"] === true) && !has(ctx, "flood.notice.delivered")) reasons.push("flood notice not delivered");
  const appraisal = ctx.store.list("appraisals").length > 0 || has(ctx, "valuation.received") || has(ctx, "appraisal.received");
  if (appraisal && !has(ctx, "valuation.copy_delivered") && !has(ctx, "appraisal.copy_delivered") && !has(ctx, "appraisal.copy.waived") && !has(ctx, "valuation.copy.waived")) reasons.push("appraisal copy not delivered or waived");
  return { ok: reasons.length === 0, earliest, reasons };
}
/** The consumer's E-SIGN standing for the closing consent: an active consents row for the party, or an electronic CD delivery under consent (the API's own heuristic, commands.ts). */
async function signers(deps: FlowDeps, ctx: Ctx): Promise<{ party_id: string; esign_consented: boolean; identity_proofing_possible: boolean }[]> {
  const out: { party_id: string; esign_consented: boolean; identity_proofing_possible: boolean }[] = [];
  for (const p of ctx.parties) {
    const active = Number((await deps.runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE kind = 'esign' AND status = 'active' AND (party_id = $1 OR application_id = $2)`, [p.party_id, ctx.appId]))[0]?.n ?? 0) > 0;
    const electronic = has(ctx, "disclosure.cd.delivered", (x) => (x["channel"] === "esign_portal" || x["channel"] === "email_link") && partiesFor(ctx, x["consumer_id"]).some((q) => q.party_id === p.party_id));
    out.push({ party_id: p.application_borrower_id, esign_consented: active || electronic, identity_proofing_possible: true });
  }
  return out;
}
/** The FAKE platform's slot calendar: two windows a day on the three days from the earliest closing date (Sundays skipped), in the property's local zone. */
export function fakeSlots(earliest: string, timeZone: string, types: readonly ClosingType[]): { id: string; starts_at: string; ends_at: string; label: string; closing_type: ClosingType; date: string }[] {
  const out: { id: string; starts_at: string; ends_at: string; label: string; closing_type: ClosingType; date: string }[] = [];
  let d = new Date(`${earliest}T12:00:00Z`); let days = 0;
  while (days < 3) {
    const date = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0) { for (const hh of ["10", "14"]) for (const t of types) { const starts_at = zoned(date, `${hh}:00`, timeZone); const ends_at = zoned(date, `${hh}:45`, timeZone); out.push({ id: `${t}:${date}T${hh}`, starts_at, ends_at, label: "", closing_type: t, date }); } days += 1; }
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}
/** ISO instant of a civil time in a zone (offset read from Intl for that date). */
export function zoned(date: string, hhmm: string, timeZone: string): string {
  const probe = new Date(`${date}T${hhmm}:00Z`);
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(probe).find((x) => x.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part); const sign = m?.[1] === "-" ? -1 : 1; const off = m ? sign * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(probe.getTime() - off * 60_000).toISOString();
}
/** The closing types the card offers: 26.2's decided default first, then every downgrade the agent supports, always the paper path — never `ron` when SM_O72_RON_STATE_AUTH_GATE is closed (T4). */
export function offeredClosingTypes(decision: { closing_type: string; ron: { eligible: boolean } }, agent: { ipen_capable: boolean }): ClosingType[] {
  const out: ClosingType[] = [];
  if (decision.closing_type === "ron" && decision.ron.eligible) out.push("ron");
  if (agent.ipen_capable) out.push("ipen");
  out.push("hybrid", "wet");
  return [...new Set(out)];
}
async function maybeScheduleCard(deps: FlowDeps, ctx: Ctx): Promise<void> {
  const g = scheduleGates(ctx); if (!g.ok || !g.earliest) { if (process.env["FLOW_DEBUG"]) deps.logger?.info("borrower.flow.32-7.schedule_gates", { application_id: ctx.appId, earliest: g.earliest, reasons: g.reasons, lock: lockOf(ctx) ? { status: lockOf(ctx)!["status"], expires_on: lockOf(ctx)!["expires_on"] } : null }); return; }
  const flowKey = `closing.schedule:${g.earliest}`;
  // one closing ask per party (32.6-T9/T11 count exactly one): a pending card on this key — 32.6's slot ask, sent on the same event earlier in flow order — is enriched in place with the closing-type decision; a resolved or superseded one means the ask is over
  const existing = ctx.parties.length ? await existingCard(deps, ctx.parties[0]!.party_id, flowKey) : undefined;
  if (existing && existing.status !== "pending") return;
  if (existing && (await deps.ui.card(existing.card_instance_id))?.props["closing_type_options"]) return;
  const state = String(ctx.app.state ?? "AZ").toUpperCase(); const agent = FAKE_ECLOSING_DIRECTORY.agent(state); const tz = timeZoneFor(state);
  const sg = await signers(deps, ctx);
  // 26.2's own closing-type decision (SM_O72_RON_STATE_AUTH_GATE, the agent's eligibility, every signer's consent) — the flow never decides the type itself
  const d = (await deps.runtime.execute({ process: "26.2", name: "decideClosingType", loanId: "", applicationId: ctx.appId, actor: CLOSER, run: { ...RUN }, input: { state, county_fips: null, tx_50a6: false, settlement_agent_party_id: agent.settlement_agent_party_id, eligibility: [agent], signers: sg, proposed_closing_type: "ron", enote_eligible: true } })).output as { closing_type: string; note_form: string; reasons: string[]; ron: { eligible: boolean; refusals: string[] } };
  const types = offeredClosingTypes(d, agent);
  const slots = fakeSlots(g.earliest, tz, types);
  const base = { state, county_fips: null, settlement_agent_party_id: agent.settlement_agent_party_id, transaction_type: ctx.app.transaction_type ?? "limited_cash_out", time_zone: tz, dry_state: !WET_STATES.has(state), notary_party_id: null, ron_provider_party_id: d.ron.eligible ? "P-RON-1" : null, eligibility: [agent], signers: sg, rescindable: !isPurchase(ctx) };
  const by_option: Record<string, P> = {}; for (const sl of slots) by_option[sl.id] = { slot: sl.starts_at, closing_type_preference: sl.closing_type, ...(sl.closing_type === "wet" ? { location_type: "settlement_agent_office" } : {}) };
  const decision: P = { slots: slots.map(({ id, starts_at, ends_at, label, closing_type }) => ({ id, starts_at, ends_at, label, closing_type })), vendor_fake: "FAKE",
    closing_type_options: types.map((t) => ({ id: t, copy_key: `closing.schedule.type.${t}`, is_default: t === types[0] })), default_closing_type: types[0], ron_eligible: d.ron.eligible, ron_refusals: d.ron.refusals, decision_reasons: d.reasons, fallback_copy_key: "closing.schedule.fallback", earliest_consummation_date: g.earliest, time_zone: tz,
    command: "closing.selectSlot", command_args: base, command_args_by_option: by_option };
  if (existing) { for (const party of ctx.parties) { const c = await existingCard(deps, party.party_id, flowKey); if (c && c.status === "pending") await deps.ui.mergeCardProps(c.card_instance_id, { ...decision, closing_types_by: FLOW_ID }); } }
  else await sendToAll(deps, ctx, { kind: "ScheduleCard", copy_key: "closing.schedule", flow_key: flowKey, command_ref: "closing.selectSlot",
    props: { purpose: "ron_session", title: "", helper: "", constraints_text: "", vendor: FAKE_ECLOSING_DIRECTORY.vendor, ...decision } });
  // A2-4.1-03: the borrower may decline electronic records at any point — the choice reshapes the ask; the slot they pick with `closing_type_preference` commits it (T5)
  if (types.some((t) => t !== "wet")) await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "closing.electronic_or_paper", flow_key: `closing.choice:${g.earliest}`,
    props: { title: "", helper: "", options: [{ id: "electronic", label: "Sign electronically", is_primary: true }, { id: "paper", label: "Sign on paper" }], command: "closing.selectSlot", command_args_by_option: {}, no_command_options: ["electronic", "paper"], schedule_flow_key: flowKey, affirmatives: [] } });
}

// ---------------------------------------------------------------- funding / boarding helpers
const fundingOf = (ctx: Ctx, fundingId: unknown): P | undefined => (typeof fundingId === "string" ? (ctx.store.get("fundings", fundingId)?.data as P | undefined) : undefined);
/** 26.3's funding calendar for the transaction (the owning process's computation; a read of `computeDates` with no `op`). */
async function fundingCalendar(deps: FlowDeps, ctx: Ctx, consummationAt: string | null): Promise<{ earliest_funding_date: string; rescission_expires_at: string | null } | null> {
  try {
    const r = await deps.runtime.execute({ process: "26.3", name: "computeDates", loanId: "", applicationId: ctx.appId, actor: FUNDER, run: { ...RUN }, input: { state: String(ctx.app.state ?? "AZ"), transaction_type: ctx.app.transaction_type ?? "limited_cash_out", time_zone: timeZoneFor(ctx.app.state), consummation_at: consummationAt, rescindable: !isPurchase(ctx) } });
    const o = r.output as { earliest_funding_date: string; rescission_expires_at: string | null }; return { earliest_funding_date: String(o.earliest_funding_date), rescission_expires_at: o.rescission_expires_at ?? null };
  } catch { return null; }
}
const firstPaymentAmount = (ctx: Ctx): { total: string; pi: string | null; escrow: string | null } => {
  const cds = ctx.store.list("disclosures").map((r) => r.data as P).filter((d) => d["kind"] === "cd" || d["kind"] === "corrected_cd").sort((a, b) => Number(a["cd_version"] ?? 1) - Number(b["cd_version"] ?? 1));
  // 26.3's worksheet names the CD version the funding reconciled to (`funding.worksheet.reconciled{cd_version}`) — that version's figures are the loan's; else the latest
  const ws = last(ctx, "funding.worksheet.reconciled") ?? last(ctx, "funding.worksheet.built"); const wsVersion = ws ? Number(ws.payload["cd_version"]) : NaN;
  const cd = (Number.isFinite(wsVersion) ? cds.find((d) => Number(d["cd_version"] ?? 1) === wsVersion) : undefined) ?? cds.at(-1);
  const fig = (cd?.["figures"] as CdFigures | undefined) ?? {};
  const cycle = last(ctx, "statement.cycle.opened");
  const pi = s(fig.pi_cents) ?? s(cycle?.payload["pi_cents"]) ?? s(ctx.store.list("apr_calculations").map((r) => r.data as P).filter((d) => d["checkpoint"] === "cd").at(-1)?.["pi_cents"]);
  const escrow = s(fig.monthly_escrow_cents) ?? s(cycle?.payload["escrow_cents"]) ?? s((last(ctx, "disclosure.cd.prepared")?.payload["escrow"] as P | undefined)?.["monthly_escrow_cents"]);
  const total = s(cycle?.payload["amount_due_cents"]) ?? (pi ? String(BigInt(pi) + BigInt(escrow ?? "0")) : "0");
  return { total, pi, escrow };
};
/** The borrower item a funding hold asks for (32.7 §5): a corrected insurance effective date, a re-signed document; anything else is internal. */
export function holdAsk(reason: string): { kind: "insurance_effective_date"; document_class: string } | { kind: "resigned_document"; document_class: string } | null {
  if (/FC_HAZARD_EVIDENCE|hazard_effective|insurance_effective/.test(reason)) return { kind: "insurance_effective_date", document_class: "homeowners_policy" };
  if (/FC_DOCS_EXECUTED_QC|instrument_altered|re-?sign/.test(reason)) return { kind: "resigned_document", document_class: "security_instrument" };
  return null;
}
async function fundingHeld(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const reason = String(p["reason"] ?? ""); const fundingId = String(p["funding_id"] ?? "");
  const ask = holdAsk(reason);
  // "a final check is in progress" — no wire, bank or fraud detail ever reaches the card (32.7 §5)
  await sendToAll(deps, ctx, StatusCard("funding.held", `funding.held:${e.id}`, { funding_id: fundingId, hold_kind: ask?.kind ?? "internal" }));
  await transitionAll(deps, ctx, "funding.ask:", "cancelled", { reason: "a newer hold", funding_id: fundingId });
  if (!ask) return;
  if (ask.kind === "insurance_effective_date") await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "funding.held.insurance_effective_date", flow_key: `funding.ask:${e.id}`, command_ref: "insurance.submitEvidence",
    props: { document_class: ask.document_class, accepted_examples: ["declarations page", "binder"], why: "", title: "", freshness_hint: "", funding_id: fundingId, hold_kind: ask.kind, command_args: { kind: "hoi_declaration" } } });
  else await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "funding.held.resigned_document", flow_key: `funding.ask:${e.id}`, props: { document_class: ask.document_class, accepted_examples: ["the re-signed page"], why: "", title: "", funding_id: fundingId, hold_kind: ask.kind } });
}
const autodraftElements = (ctx: Ctx, party: Party, first: { total: string; pi: string | null; escrow: string | null }, firstDue: string | null, loanLast4: string | null): P[] => [
  { id: "borrower", label_key: "consent.autodraft.element.borrower", value: party.legal_name },
  { id: "loan", label_key: "consent.autodraft.element.loan", value: loanLast4 ? `····${loanLast4}` : "" },
  { id: "account", label_key: "consent.autodraft.element.account", value: "", input: "bank_account" },
  { id: "amount", label_key: "consent.autodraft.element.amount", value: money(first.total), options: ["contractual", "fixed"] },
  { id: "amount_variable", label_key: "consent.autodraft.element.amount.variable", value: "" },
  { id: "timing", label_key: "consent.autodraft.element.timing", value: "monthly", draft_day_options: Array.from({ length: 16 }, (_, k) => k + 1) },
  { id: "first_debit", label_key: "consent.autodraft.element.first_debit", value: firstDue ?? "" },
  { id: "company", label_key: "consent.autodraft.element.company", value: "SUPERMORTGAGE" },
  { id: "revoke", label_key: "consent.autodraft.element.revoke", value: "" },
  { id: "date", label_key: "consent.autodraft.element.date", value: ctx.now.slice(0, 10) },
  { id: "esign", label_key: "consent.autodraft.element.esign", value: "" },
];

// ---------------------------------------------------------------- the reactions, per application, in commit order
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "disclosure.cd.prepared": {
      if (Number(p["cd_version"] ?? 1) !== 1) return;
      await sendToAll(deps, ctx, StatusCard("cd.preparing", `cd.preparing:${String(p["disclosure_id"])}`, { next_event_label: timerLabel("SM_O62_CD_TARGET_4SBD"), next_event_at: await timerDue(deps, ctx.appId, "SM_O62_CD_TARGET_4SBD"), disclosure_id: p["disclosure_id"] })); return;
    }
    case "disclosure.cd.delivered": await cdDeliveredCard(deps, ctx, e); return;
    case "disclosure.cd.received": await collapseCdOnReceipt(deps, ctx, e); return;
    case "disclosure.cd.waiting_period.computed": {
      const version = Number(p["cd_version"] ?? 1); const date = String(p["earliest_consummation_date"] ?? "");
      if (version > 1) await sendToAll(deps, ctx, StatusCard("cd.redisclosed_restart", `cd.restart:${String(p["disclosure_id"])}`, { copy_tokens: { date }, disclosure_id: p["disclosure_id"], cd_version: version, earliest_consummation_date: date, next_event_label: timerLabel("REGZ_1026_19F1_CD_3SBD_GATE"), next_event_at: `${date}T12:00:00.000Z` }));
      await maybeScheduleCard(deps, ctx); return;
    }
    case "disclosure.cd.corrected": {
      // the delivery events of the corrected version carry the cards (cdDeliveredCard); here the older version's pending asks close when a new wait starts
      if (p["new_waiting_period"] === true && typeof p["supersedes"] === "string") await transitionAll(deps, ctx, `${cdVersionPrefix(p["supersedes"] as string)}:`, "superseded", { superseded_by: p["disclosure_id"], cd_version: p["cd_version"] });
      return;
    }
    case "clear_to_close.issued": case "lock.executed": await maybeScheduleCard(deps, ctx); return;
    case "closing.scheduled": case "closing.rescheduled": {
      const type = String(p["closing_type"] ?? "ron"); const when = String(p["scheduled_at"] ?? e.occurredAt); const noteDate = s(p["scheduled_note_date"]) ?? when.slice(0, 10);
      await transitionAll(deps, ctx, "closing.schedule:", "resolved", { closing_id: p["closing_id"], scheduled_at: when, closing_type: type, manner: "closing_scheduled" });
      await transitionAll(deps, ctx, "closing.choice:", "resolved", { closing_id: p["closing_id"], closing_type: type, manner: "closing_scheduled" });
      if (type === "wet") await sendToAll(deps, ctx, StatusCard("closing.paper_path", `closing.paper:${String(p["closing_id"])}:${e.type}`, { copy_tokens: { date: noteDate }, closing_id: p["closing_id"], closing_type: type, note_form: p["note_form"] ?? "paper", enote: false, next_event_label: "Closing appointment", next_event_at: when }));
      else await sendToAll(deps, ctx, StatusCard("closing.confirmed", `closing.confirmed:${String(p["closing_id"])}:${e.type}`, { copy_tokens: { date: noteDate }, closing_id: p["closing_id"], closing_type: type, note_form: p["note_form"] ?? null, closing_type_copy_key: `closing.schedule.type.${type}`, next_event_label: "Closing appointment", next_event_at: when }));
      if (typeof p["notary_party_id"] === "string" && p["notary_party_id"]) await sendToAll(deps, ctx, { kind: "PersonCard", copy_key: "closing.person.notary", flow_key: `person.notary:${String(p["notary_party_id"])}`, informational: true, props: { role: "notary", name: "", credentials: String(p["state"] ?? ""), party_ref: p["notary_party_id"] } });
      if (typeof p["settlement_agent_party_id"] === "string" && p["settlement_agent_party_id"]) await sendToAll(deps, ctx, { kind: "PersonCard", copy_key: "closing.person.settlement_agent", flow_key: `person.agent:${String(p["settlement_agent_party_id"])}`, informational: true, props: { role: "settlement_agent", name: "", party_ref: p["settlement_agent_party_id"] } });
      return;
    }
    case "closing.documents.released": {
      const type = String(p["closing_type"] ?? "ron"); const closing = ctx.store.list("closings").map((r) => r.data as P).at(-1);
      if (type === "wet") await sendToAll(deps, ctx, { kind: "HandoffCard", copy_key: "closing.wet.handoff", flow_key: `handoff.wet:${String(p["set_id"] ?? e.id)}`, informational: true, props: { destination: "settlement_agent", what_to_expect: "", return_state: "", what_to_expect_copy_key: "closing.wet.what_to_expect", return_state_copy_key: "closing.presign.return", closing_type: type, scheduled_at: closing?.["scheduled_at"] ?? null } });
      else await sendToAll(deps, ctx, { kind: "HandoffCard", copy_key: "closing.presign", flow_key: `handoff.ron:${String(p["set_id"] ?? e.id)}`, props: { destination: "ron_platform", what_to_expect: "", return_state: "", what_to_expect_copy_key: "closing.presign.what_to_expect", return_state_copy_key: "closing.presign.return", closing_type: type, vendor_fake: "FAKE", vendor: "FAKE RON platform", scheduled_at: closing?.["scheduled_at"] ?? null, attendees: ctx.parties.map((x) => x.legal_name) } });
      return;
    }
    case "closing.pre_session_checks.passed": {
      const closing = ctx.store.list("closings").map((r) => r.data as P).find((c) => c["closing_id"] === p["closing_id"]) ?? ctx.store.list("closings").map((r) => r.data as P).at(-1);
      const when = s(closing?.["scheduled_at"]) ?? e.occurredAt;
      await sendToAll(deps, ctx, StatusCard("closing.all_set", `closing.all_set:${String(p["closing_id"])}`, { copy_tokens: { time: when }, next_event_label: "Closing appointment", next_event_at: when, closing_id: p["closing_id"] }));
      const items = ["closing.package.cd_final", ...(!isPurchase(ctx) ? ["closing.package.rescission_notice"] : []), ...(ctx.store.list("mi_certificates").length ? ["closing.package.hpa"] : []), "closing.package.escrow_statement", "closing.package.privacy", "closing.package.state_notices", "closing.package.first_payment_letter"];
      await sendToAll(deps, ctx, StatusCard("closing.package_items", `closing.package:${String(p["closing_id"])}`, { detail_copy_keys: items, closing_id: p["closing_id"], copy_tokens: partnerTokens(ctx) }));
      return;
    }
    case "closing.session.started":
      await transitionAll(deps, ctx, "handoff.ron:", "resolved", { manner: "session_started", closing_id: p["closing_id"] });   // the pre-sign hand-off is done once the session opens
      await sendToAll(deps, ctx, StatusCard("closing.in_session", `closing.session:${String(p["session_id"] ?? p["closing_id"])}`, { closing_id: p["closing_id"] })); return;
    case "closing.session.failed": await sendToAll(deps, ctx, StatusCard("closing.failed", `closing.failed:${String(p["session_id"] ?? e.id)}`, { closing_id: p["closing_id"], reason_kind: p["reason"] ?? null, reschedule_proposal: p["reschedule_proposal"] ?? [], next_event_label: timerLabel("SM_O72_PAPER_FALLBACK_5BD") || "", next_event_at: await timerDue(deps, ctx.appId, "SM_O72_PAPER_FALLBACK_5BD") })); return;
    case "closing.consummated": {
      for (const prefix of ["handoff.ron:", "handoff.wet:"]) await transitionAll(deps, ctx, prefix, "resolved", { manner: "consummated", closing_id: p["closing_id"] });   // signed: the hand-off asks close
      if (p["rescindable"] !== false && !isPurchase(ctx) && p["transaction_type"] !== "purchase") return;   // the refinance line waits for 25.3's period (rescission.period.started)
      const cal = await fundingCalendar(deps, ctx, String(p["consummation_at"] ?? e.occurredAt));
      await sendToAll(deps, ctx, StatusCard("signed.purchase", `signed:${String(p["closing_id"])}`, { copy_tokens: { when: cal?.earliest_funding_date ?? String(p["consummation_on"] ?? "") }, closing_id: p["closing_id"], consummation_at: p["consummation_at"], rescission: "not_applicable", next_event_label: timerLabel("SM_O73_POST_RESCISSION_FUNDING_1BD") || "Funding expected", next_event_at: cal ? `${cal.earliest_funding_date}T12:00:00.000Z` : null }));
      return;
    }
    case "rescission.notice.delivered": {
      const form = String(p["kind"] ?? "rescission_h8").endsWith("h9") ? "h9" : "h8"; const consumer = p["consumer_id"];
      const disclosureId = `${ctx.appId}:${String(p["kind"] ?? "rescission_h8")}:${String(consumer)}:${e.occurredAt}`;
      await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "rescission.notice", flow_key: `rescission.notice:${String(consumer)}`,
        props: { document_id: randomUUID(), disclosure_id: disclosureId, notice_code: form === "h9" ? H9_NOTICE_CODE : H8_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "closing_package", form, copies: p["copies"] ?? 2, channel: p["channel"] ?? null, delivered_at: e.occurredAt, consumer_id: consumer, evidence_document_id: p["evidence_document_id"] ?? null,
          how_to_cancel: { copy_key: "rescission.how", message_text: "How to cancel", quiet: true } } }, partiesFor(ctx, consumer));
      return;
    }
    case "rescission.period.started": {
      const cal = await fundingCalendar(deps, ctx, s(p["consummation_at"]) ?? s(last(ctx, "closing.consummated")?.payload["consummation_at"]));
      await sendToAll(deps, ctx, StatusCard("signed.refi", `signed:${String(p["rescission_id"] ?? ctx.appId)}`, { copy_tokens: { expires_at: String(p["expires_on"] ?? ""), date: cal?.earliest_funding_date ?? "" }, rescission_id: p["rescission_id"], expires_at: p["expires_at"], expires_on: p["expires_on"], period_start_date: p["period_start_date"], earliest_funding_date: cal?.earliest_funding_date ?? null, next_event_label: timerLabel("REGZ_1026_23_RESCISSION_3SBD_GATE"), next_event_at: p["expires_at"] ?? null }));
      return;
    }
    case "rescission.exercised": {
      // the application becomes read-only: every pending ask of the subject closes; the Record's badge reads Cancelled (record.ts)
      await transitionAll(deps, ctx, "", "cancelled", { reason: "rescission exercised", exercise_id: p["exercise_id"] });
      await sendToAll(deps, ctx, StatusCard("rescission.cancelled", `rescission.cancelled:${String(p["exercise_id"] ?? e.id)}`, { copy_tokens: { date: String(p["refund_due_at"] ?? "") }, exercise_id: p["exercise_id"], refund_due_at: p["refund_due_at"], refund_clock: "REGZ_1026_23D2_RESCISSION_REFUND_20", next_event_label: timerLabel("REGZ_1026_23D2_RESCISSION_REFUND_20") || "Refund by", next_event_at: p["refund_due_at"] ? `${String(p["refund_due_at"])}T12:00:00.000Z` : null }));
      return;
    }
    case "rescission.confirmed_not_rescinded": {
      await transitionAll(deps, ctx, "rescission.notice:", "resolved", { manner: "period_ended" });   // the window closed: the notice's receipt ask is moot (delivered at signing with evidence)
      const f = ctx.store.list("fundings").map((r) => r.data as P).at(-1);
      const date = s(f?.["scheduled_funding_date"]) ?? s(f?.["earliest_funding_date"]) ?? (await fundingCalendar(deps, ctx, s(last(ctx, "closing.consummated")?.payload["consummation_at"])))?.earliest_funding_date ?? "";
      await sendToAll(deps, ctx, StatusCard("rescission.expired", `rescission.expired:${String(p["rescission_id"] ?? e.id)}`, { copy_tokens: { date }, next_event_label: timerLabel("SM_O73_POST_RESCISSION_FUNDING_1BD") || "Funding expected", next_event_at: (await timerDue(deps, ctx.appId, "SM_O73_POST_RESCISSION_FUNDING_1BD")) ?? (date ? `${date}T12:00:00.000Z` : null) }));
      return;
    }
    case "funding.authorized": {
      const f = fundingOf(ctx, p["funding_id"]); const date = s(f?.["scheduled_funding_date"]) ?? s(f?.["earliest_funding_date"]) ?? s(p["scheduled_funding_date"]) ?? "";
      await transitionAll(deps, ctx, "funding.ask:", "cancelled", { reason: "funding authorized" });
      await sendToAll(deps, ctx, StatusCard("funding.progress", `funding.progress:${String(p["funding_id"])}`, { copy_tokens: { date }, funding_id: p["funding_id"], next_event_label: timerLabel("SM_O73_POST_RESCISSION_FUNDING_1BD") || "Funding expected", next_event_at: date ? `${date}T12:00:00.000Z` : null }));
      return;
    }
    case "funding.held": await fundingHeld(deps, ctx, e); return;
    case "funding.conditions.evaluated": { if (p["passed"] === true) await transitionAll(deps, ctx, "funding.ask:", "cancelled", { reason: "funding conditions passed", funding_id: p["funding_id"] }); return; }
    case "loan.funded": {
      await transitionAll(deps, ctx, "funding.ask:", "cancelled", { reason: "funded" });
      const first = firstPaymentAmount(ctx); const requested = last(ctx, "funding.requested");
      const tokens = { money: money(first.total), date: String(p["first_payment_date"] ?? ""), prior_servicer: ctx.app.prior_servicer ?? "your current servicer", disbursement: String(p["disbursement_date"] ?? ""), month_end: String(p["lpi_date"] ?? "") };
      await sendToAll(deps, ctx, StatusCard(isPurchase(ctx) ? "funded.purchase" : "funded.refi", `funded:${String(p["funding_id"])}`, { copy_tokens: tokens, detail_copy_key: "funded.no_skip", funding_id: p["funding_id"], disbursement_date: p["disbursement_date"], first_payment_date: p["first_payment_date"], first_payment_latest_allowed_date: requested?.payload["first_payment_latest_allowed_date"] ?? null, first_payment_gate: "FNMA_B2_1_5_FIRST_PAYMENT_2M", first_payment_cents: first.total, pi_cents: first.pi, escrow_cents: first.escrow, prepaid_days: p["prepaid_days"] ?? null, per_diem_cents: p["per_diem_cents"] ?? null, prepaid_interest_cents: p["prepaid_interest_cents"] ?? null, ...(isPurchase(ctx) ? {} : { prior_servicer: tokens.prior_servicer, refund_clock: REFUND_CLOCK, refund_days: 20 }), next_event_label: timerLabel("FNMA_B2_1_5_FIRST_PAYMENT_2M") || "First payment due", next_event_at: p["first_payment_date"] ? `${String(p["first_payment_date"])}T12:00:00.000Z` : null }));
      return;
    }
    case "loan.boarded": {
      await sendToAll(deps, ctx, StatusCard("boarding.welcome", `boarding.welcome:${loanIdOf(ctx, e)}`, { copy_tokens: partnerTokens(ctx), loan_id: loanIdOf(ctx, e), first_payment_date: p["first_payment_date"] ?? null, servicing_layout: true }, loanIdOf(ctx, e)));
      return;
    }
    case "notice.sent": {
      if (p["template"] !== FIRST_PAYMENT_LETTER) return;
      const loanId = loanIdOf(ctx, e); const parties = partiesFor(ctx, p["party_id"]); const first = firstPaymentAmount(ctx); const boarded = last(ctx, "loan.boarded"); const firstDue = s(boarded?.payload["first_payment_date"]) ?? s(last(ctx, "loan.funded")?.payload["first_payment_date"]);
      const channel = String(p["channel"] ?? "mail_first_class"); const mailed = channel.startsWith("mail"); const last4 = s(boarded?.payload["servicing_loan_number"])?.slice(-4) ?? null;
      for (const party of parties) {
        await sendCard(deps, ctx, party, { kind: "NoticeCard", copy_key: "first_payment.letter", flow_key: `first_payment.letter:${String(p["notice_id"])}`, informational: true, loan_id: loanId,
          props: { notice_code: FIRST_PAYMENT_LETTER, title: "", rendered_document_id: String(p["notice_id"] ?? randomUUID()), plain_language: "", line: "", channel: mailed ? "mail" : "app", mailed_at: p["mailed_at"] ?? (mailed ? e.occurredAt : null), delivered_at: e.occurredAt, sent_on: p["sent_on"] ?? null, carries: p["carries"] ?? [], template_version: null, copy_tokens: { money: money(first.total), date: firstDue ?? "", ...partnerTokens(ctx) }, first_payment_cents: first.total, first_payment_date: firstDue, payee_copy_key: "first_payment.payee", timer: "SM_O64_FIRST_PAYMENT_LETTER_5BD" } });
        // 32.7 §6 item 2: autopay — every 2.x rule-1 element and the Reg E optional statement, never pre-checked, never a condition (25.4 T7)
        await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.autodraft.title", flow_key: `autodraft.consent:${loanId}`, command_ref: "autodraft.enroll", loan_id: loanId,
          props: { consent_kind: "autodraft_authorization", disclosure_version_id: "AUTODRAFT-AUTHORIZATION-2026-09", scope: [], affirmation_method: "checkbox_with_text", title: "", body_text: "", helper_text: "", requires_typed_name: true, optional_statement_copy_key: "consent.autodraft.optional", optional: true, prechecked: false, elements: autodraftElements(ctx, party, first, firstDue, last4), draft_day_options: Array.from({ length: 16 }, (_, k) => k + 1), amount_rules: ["contractual", "fixed"], copy_delivery_timer: "SM_AUTODRAFT_COPY_DELIVERY_1BD", command_args: { amount_rule: "contractual", draft_day: 1, include_fees: false, elements_displayed: true } } });
      }
      return;
    }
    case "consents.boarded": {
      const loanId = loanIdOf(ctx, e); const rows = Array.isArray(p["consents"]) ? (p["consents"] as P[]) : [];
      for (const c of rows) {
        if (c["kind"] !== "esign" || c["invitation_required"] !== true) continue;
        for (const party of partiesFor(ctx, c["party_id"])) {
          await sendCard(deps, ctx, party, StatusCard("statement.paper_until_esign", `statement.paper:${loanId}:${party.party_id}`, { loan_id: loanId, boarded_scope: c["scope"] ?? [], statement_channel: "mail" }, loanId));
          await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.esign.servicing", flow_key: `esign.servicing:${loanId}`, command_ref: "consent.capture", loan_id: loanId,
            props: { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: [...SERVICING_ESIGN_SCOPES], affirmation_method: "checkbox_with_text", title: "", body_text: "", footer_text: "", requires_typed_name: true, verification_state: "none", boarded_scope: c["scope"] ?? [], paper_until_active: true, command_args: { kind: "esign", method: "checkbox_with_text", scope: [...SERVICING_ESIGN_SCOPES], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE" } } });
        }
      }
      return;
    }
    case "escrow.statement.sent": {
      if (String(p["statement_type"] ?? "") !== "initial") return;
      await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "escrow.initial_statement", flow_key: `escrow.initial:${String(p["statement_id"] ?? e.id)}`, informational: true, loan_id: loanIdOf(ctx, e),
        props: { document_id: String(p["document_id"] ?? randomUUID()), notice_code: INITIAL_ESCROW_STMT, title: "", why_you_see_this: "", requires_ack: false, esign_scope_required: "escrow_statements", channel: p["channel"] ?? "app", delivered_at: e.occurredAt, monthly_escrow_cents: p["monthly_escrow_cents"] ?? null } });
      return;
    }
    case "loan.purchased": await purchased(deps, ctx, e); return;
    case "document.received": {
      if (String(p["declared_class"] ?? "") !== FNMA_LETTER_CLASS) return;
      await fnmaLetterReceived(deps, ctx, e); return;
    }
    default: return;
  }
}

// ---------------------------------------------------------------- the Fannie Mae letter (25.4 §1026.39 · 30.4 HO-009)
async function purchased(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const loanId = loanIdOf(ctx, e); if (!loanId) return;
  const purchaseDate = String(p["purchase_date"] ?? p["date_of_transfer"] ?? e.occurredAt.slice(0, 10)); const otnId = `OTN-${loanId}`;
  let row: P | null = null;
  if (!has(ctx, "ownership_transfer.notice.expected")) {
    // 25.4: Fannie Mae (covered person) sends its own letter — the row records the expectation; nothing is rendered in Fannie Mae's name
    try { row = (await deps.runtime.execute({ process: "25.4", name: "evaluateOwnershipTransfer", loanId, applicationId: ctx.appId, actor: DISCLOSURE, run: { ...RUN }, input: { otn_id: otnId, loan_id: loanId, covered_person: "fannie_mae", acquisition_date: purchaseDate, as_of: ctx.now.slice(0, 10) } })).output as P; }
    catch (err) { deps.logger?.error("borrower.flow.32-7.ownership", { error: err instanceof Error ? err.message : String(err) }); }
  }
  let explainer: P | null = null;
  try { explainer = (await deps.runtime.execute({ process: "30.4", name: "explainFnmaLetter", loanId, applicationId: ctx.appId, actor: BOARDING, run: { ...RUN }, input: { loan_id: loanId, application_id: ctx.appId, purchase_date: purchaseDate, covered_person: "fannie_mae" } })).output as P; }
  catch (err) { deps.logger?.error("borrower.flow.32-7.explainer", { error: err instanceof Error ? err.message : String(err) }); }
  const ex = (explainer?.["explainer"] as { headline?: string; points?: string[] } | undefined) ?? {};
  await sendToAll(deps, ctx, { kind: "HandoffCard", copy_key: "boarding.fannie_letter", flow_key: `fnma.letter:${loanId}`, informational: true, loan_id: loanId,
    props: { destination: "fannie_mae_letter", what_to_expect: "", return_state: "", what_to_expect_copy_key: "boarding.fannie_letter.what_to_expect", return_state_copy_key: "boarding.fannie_letter.return", notice_code: OWNERSHIP_NOTICE, ownership_status: s(row?.["status"]) ?? s(explainer?.["status"]) ?? "expected", due_date: s(row?.["due_date"]) ?? s(explainer?.["due_date"]) ?? null, explainer_points: ex.points ?? [], explainer_headline: ex.headline ?? "", upload_class: FNMA_LETTER_CLASS, timer: "REGZ_1026_39_OWNERSHIP_NOTICE_30" } });
  await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "boarding.fannie_letter.upload", flow_key: `fnma.upload:${loanId}`, loan_id: loanId,
    props: { document_class: FNMA_LETTER_CLASS, accepted_examples: ["the letter from Fannie Mae"], why: "", title: "", optional: true, otn_id: otnId } });
}
async function fnmaLetterReceived(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const documentId = String(p["document_id"]); const loanId = loanIdOf(ctx, e); if (!loanId) return;
  const receivedOn = String(p["received_at"] ?? e.occurredAt).slice(0, 10);
  // 22.1: the borrower-declared class stands (FAKE classifier pass) → `document.classified`
  try { await deps.runtime.execute({ process: "22.1", name: "classifyDocument", loanId: "", applicationId: ctx.appId, actor: VERIFICATION, run: { ...RUN }, input: { document_id: documentId, doc_class: FNMA_LETTER_CLASS, confidence: 1, classifier_version: "FAKE-classifier borrower-declared 2026.09", borrower_declared: true } }); }
  catch (err) { deps.logger?.error("borrower.flow.32-7.classify", { error: err instanceof Error ? err.message : String(err) }); }
  // 30.4 HO-009: the uploaded copy evidences the letter (25.4's own event); 25.4's row moves to `evidenced` with the document as its evidence
  try { await deps.runtime.execute({ process: "30.4", name: "explainFnmaLetter", loanId, applicationId: ctx.appId, actor: BOARDING, run: { ...RUN }, input: { loan_id: loanId, application_id: ctx.appId, evidence_document_id: documentId, received_on: receivedOn, source: "borrower_upload" } }); }
  catch (err) { deps.logger?.error("borrower.flow.32-7.evidence", { error: err instanceof Error ? err.message : String(err) }); }
  const otn = ctx.store.get("ownership_transfer_notices", `OTN-${loanId}`)?.data as P | undefined;
  if (otn && otn["status"] !== "evidenced") {
    try { await deps.runtime.execute({ process: "25.4", name: "evaluateOwnershipTransfer", loanId, applicationId: ctx.appId, actor: DISCLOSURE, run: { ...RUN }, input: { op: "borrower_report", otn_id: `OTN-${loanId}`, loan_id: loanId, row: { ...otn, evidence_document_id: documentId }, reported_on: receivedOn, channel: "portal", payment_sent_to_fnma: false } }); }
    catch (err) { deps.logger?.error("borrower.flow.32-7.otn", { error: err instanceof Error ? err.message : String(err) }); }
  }
  await transitionAll(deps, ctx, "fnma.upload:", "resolved", { document_id: documentId, document_class: FNMA_LETTER_CLASS, manner: "document_received" });
  await sendToAll(deps, ctx, StatusCard("boarding.fannie_letter.received", `fnma.received:${documentId}`, { document_id: documentId, loan_id: loanId, ownership_status: "evidenced" }, loanId));
}

// ---------------------------------------------------------------- the quiet "How to cancel" link (32.7 §4): a borrower message opens the ChoiceCard; the tap commits
const CANCEL_ASK = /\b(how (do|can|would) i cancel|how to cancel|cancel)\b/i;
async function howToCancel(deps: FlowDeps, m: InboundMessage): Promise<FlowReply | null> {
  const appId = m.subject?.application_id; if (!appId || !CANCEL_ASK.test(m.text)) return null;
  const ctx = await context(deps, appId);
  const started = last(ctx, "rescission.period.started"); if (!started) return null;
  if (has(ctx, "rescission.exercised") || has(ctx, "rescission.confirmed_not_rescinded") || has(ctx, "rescission.waiver.accepted")) return null;
  const party = ctx.parties.find((x) => x.party_id === m.party_id); if (!party) return null;
  const rescissionId = String(started.payload["rescission_id"] ?? appId);
  const id = await sendCard(deps, ctx, party, { kind: "ChoiceCard", copy_key: "rescission.confirm", flow_key: `rescission.confirm:${rescissionId}:${party.party_id}`, command_ref: "rescission.exercise",
    props: { title: "", helper: "", options: [{ id: "keep", label: "Keep my loan", is_primary: true }, { id: "cancel", label: "Yes, cancel" }], command: "rescission.exercise", command_args_by_option: { cancel: { method: "portal", text: "I wish to cancel this transaction." }, keep: {} }, no_command_options: ["keep"], rescission_id: rescissionId, expires_at: started.payload["expires_at"] ?? null, refund_clock: "REGZ_1026_23D2_RESCISSION_REFUND_20", opened_by: "rescission.how", affirmatives: [] } });
  return { copy_key: "rescission.how.opened", card_instance_id: id };
}

// ---------------------------------------------------------------- the scheduled pass: 25.2's mailbox presumption on/after each presumed receipt date
async function cdMailboxSweep(deps: FlowDeps, nowIso: string): Promise<void> {
  const rows = await deps.runtime.db.query<{ application_id: string; disclosure_id: string; consumer_id: string; presumed: string; state: string | null }>(
    `SELECT d.application_id, d.payload->>'disclosure_id' AS disclosure_id, d.payload->>'consumer_id' AS consumer_id, d.payload->>'presumed_receipt_date' AS presumed, (SELECT state FROM application_properties ap WHERE ap.application_id = d.application_id ORDER BY is_subject DESC, created_at LIMIT 1) AS state
       FROM loan_events d WHERE d.type = 'disclosure.cd.delivered' AND d.payload->>'presumed_receipt_date' IS NOT NULL AND d.payload->>'channel' <> 'in_person'
         AND NOT EXISTS (SELECT 1 FROM loan_events r WHERE r.type = 'disclosure.cd.received' AND r.application_id = d.application_id AND r.payload->>'disclosure_id' = d.payload->>'disclosure_id' AND r.payload->>'consumer_id' = d.payload->>'consumer_id')
         AND NOT EXISTS (SELECT 1 FROM loan_events c WHERE c.type = 'closing.consummated' AND c.application_id = d.application_id)`);
  const byDisclosure = new Map<string, { application_id: string; state: string | null; presumed: string }>();
  for (const r of rows) {
    const today = civilDate(nowIso, timeZoneFor(r.state));
    if (today < r.presumed) continue;
    if (!byDisclosure.has(r.disclosure_id)) byDisclosure.set(r.disclosure_id, { application_id: r.application_id, state: r.state, presumed: r.presumed });
  }
  for (const [disclosureId, r] of byDisclosure) {
    try { await deps.runtime.execute({ process: "25.2", name: "computeEarliestConsummation", loanId: "", applicationId: r.application_id, actor: DISCLOSURE, run: { ...RUN }, input: { op: "deem", disclosure_id: disclosureId, today: civilDate(nowIso, timeZoneFor(r.state)) } }); }
    catch (err) { deps.logger?.error("borrower.flow.32-7.mailbox", { disclosure_id: disclosureId, error: err instanceof Error ? err.message : String(err) }); }
  }
}
export function civilDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export const FLOW_7_CLOSING: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byApp = new Map<string, DomainEvent[]>();
    for (const e of events) { const app = e.applicationId ?? (typeof (e.payload as P)["application_id"] === "string" ? String((e.payload as P)["application_id"]) : null); if (!app) continue; const list = byApp.get(app) ?? []; list.push(e); byApp.set(app, list); }
    for (const [appId, list] of byApp) {
      const ctx = await context(deps, appId);
      if (!ctx.parties.length) continue;   // no borrower party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-7.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  async onMessage(deps, message) { return howToCancel(deps, message); },
  async tick(deps, nowIso) { await cdMailboxSweep(deps, nowIso); },
};
