/**
 * §5.3 operating rules over the liquidation calculators (./liquidation.ts, ./ops.ts, ./period.ts) and the event
 * vocabulary the 5.3 timer rows arm on and are satisfied by. The tools in src/app/tools/section5-3.ts are thin shells:
 *   - `processLiquidationFact` (Inputs: `payoff.funds.cleared`, `shortsale.closed`, `foreclosure.sale.held`, … land as a
 *     `liquidation_facts` row; state `fact_recorded` → `code_selected`) → `liquidation_facts.processed{fact_id,
 *     liquidation_type, legal_date, processed_at, purchaser, insured_flag, action_code, event_type, mode, reported_late}` —
 *     the arming event of FNMA_IRM_LIQ_AC70_72_NEXTBD_2000 and, under rule 9 (`mode=event`), of
 *     FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD;
 *   - `acceptP360LiquidationEvent` (the `fnma-p360` acceptance of a projected liquidation event, validated as an inbound
 *     record) → `p360.liquidation_event.accepted{fact_id, fnma_loan_number, liquidation_event_type, p360_case_id,
 *     accepted_at, action_code, env}`;
 *   - `codeChangeAfterClose` (edge case "sale rescinded/set aside after LAR 71/70 accepted": within the period → correcting
 *     event; after close → SF CPM code-change / re-add) → `liquidation.code_change.needed{from_code, to_code, cpm_action,
 *     accepted_period, detected_at}` arming SM_LIQ_CODE_CHANGE_CPM_2BD; `draftCpmNotice` (agent draft) and
 *     `sendCpmNotice` (the `fnma_portal_operator`/`officer` send) → `cpm.notification.sent{kind, from_code, to_code,
 *     sent_via, reference, sent_by, sent_at}`;
 *   - `recordPostCloseRemovalError` (rule 6 / T6) → `loans.fnma_liquidated_in_error{accepted_period, amount_due_cents}` +
 *     `case.opened{kind=qc_finding}`;
 *   - the REOgram portal task (rule 8, E-4.1-01): `preCreateReogramTask` (rule 7: a DRA sale-held with no
 *     `foreclosure.sale.held` of ours → the confirmation task is pre-created) → `reogram.created{receipt, source,
 *     confirm_due_at}` + `human_portal_task.created{task=reogram_confirmation}`; `confirmReogram` →
 *     `human_portal_task.completed{task=reogram_confirmation}` + `reogram.confirmed{p360_case_id, evidence_document_id}`;
 *     `raiseReogramException` / `resolveReogramException` → `reogram.exception.raised{raised_at}` / `.resolved`.
 * Subjects: every 5.3 fact is loan-level (`loanId`); `liquidation_facts` rows carry `aggregate {kind: liquidation_facts, id}`.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { ChannelMode, InvestorEventType } from "./types.ts";
import { actionCode, type InsuredFlag, type LiquidationKind } from "./liquidation.ts";
import { larDeadlineMs, eventDeadlineMs, removalCorrectionCloseMs, period as periodOf } from "./period.ts";
import { ET, postCloseRemovalError, reogramConfirmation } from "./ops.ts";

export const RULE_SET_VERSION = "5.3@ops.v1";
export interface Emitter { readonly events: EventStore; readonly actor: Actor; readonly now: string; readonly loanId: string; }

/** `liquidation_facts.liquidation_type` (data model) → the code-matrix kind (rule 1). */
export const LIQUIDATION_TYPES = ["payoff", "short_sale", "mortgage_release", "fcl_third_party", "fcl_fnma_acquired", "condemnation", "charge_off", "redemption"] as const;
export type LiquidationType = (typeof LIQUIDATION_TYPES)[number];
export const PURCHASERS = ["borrower", "third_party", "fnma", "insurer"] as const;
export type Purchaser = (typeof PURCHASERS)[number];
export const INSURED_FLAGS: readonly InsuredFlag[] = ["none", "mi", "fha", "va"];
export const CHANNEL_MODES: readonly ChannelMode[] = ["legacy", "dual", "event"];
export const P360_EVENT_TYPES = ["Government Conveyance", "REO", "Third-Party Sale"] as const;
export type P360EventType = (typeof P360_EVENT_TYPES)[number];
export type RemovalCode = "60" | "70" | "71" | "72";

const KIND_OF: Record<LiquidationType, LiquidationKind> = { payoff: "payoff", short_sale: "short_sale", mortgage_release: "mortgage_release", fcl_third_party: "third_party_sale", fcl_fnma_acquired: "foreclosure_fnma_acquires", condemnation: "condemnation", charge_off: "second_lien_chargeoff", redemption: "redemption" };
export const liquidationKind = (t: LiquidationType): LiquidationKind => KIND_OF[t];
export const removalEventType = (code: string): InvestorEventType => (code === "60" ? "removal.payoff" : code === "70" ? "removal.liquidation.uninsured" : code === "71" ? "removal.liquidation.third_party" : code === "72" ? "removal.liquidation.insured" : "removal.repurchase");
/** Rule 9: the Property 360 liquidation event a `liquidation_facts` row projects under `mode=event`. */
export const p360EventType = (kind: LiquidationKind, code: string): P360EventType => (kind === "third_party_sale" || kind === "short_sale" || kind === "condemnation" || kind === "second_lien_chargeoff" ? "Third-Party Sale" : code === "72" ? "Government Conveyance" : "REO");

const need = (ok: boolean, why: string): void => { if (!ok) throw new RangeError(why); };
const isoDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const instant = (s: unknown, what: string): number => { const ms = typeof s === "string" ? Date.parse(s) : NaN; need(Number.isFinite(ms), `${what} must be an ISO instant`); return ms; };
const oneOf = <T extends string>(v: unknown, set: readonly T[], what: string): T => { need(typeof v === "string" && (set as readonly string[]).includes(v), `${what} ${String(v)} is not one of ${set.join("/")}`); return v as T; };
const append = <P extends Record<string, unknown>>(em: Emitter, type: string, payload: P, aggregate?: { kind: string; id: string }): DomainEvent<P> =>
  em.events.append({ type, loanId: em.loanId, ...(aggregate ? { aggregate } : {}), actor: em.actor, payload });

// ───── the liquidation fact (state `fact_recorded` → `code_selected`) ─────
export interface LiquidationFactInput {
  readonly fact_id?: string | null; readonly case_id?: string | null;
  readonly liquidation_type: LiquidationType; readonly legal_date: PlainDate; readonly processed_at: string;
  readonly purchaser?: Purchaser | null; readonly insured_flag?: InsuredFlag; readonly fnma_loss_risk?: boolean | null;
  readonly proceeds_cents?: Cents | null; readonly proceeds_received_at?: string | null;
  /** `investor_reporting.removal.liquidation.*.mode` (rule 9): `event` also projects the P360 liquidation event. */
  readonly mode?: ChannelMode;
}
export interface LiquidationFact {
  readonly fact_id: string; readonly liquidation_type: LiquidationType; readonly kind: LiquidationKind; readonly legal_date: PlainDate; readonly processed_at: string;
  readonly purchaser: Purchaser | null; readonly insured_flag: InsuredFlag; readonly fnma_loss_risk: boolean | null; readonly proceeds_cents: Cents | null;
  readonly action_code: RemovalCode; readonly event_type: InvestorEventType; readonly mode: ChannelMode; readonly p360_event_type: P360EventType | null;
  /** Rule 3: the legal date's activity period had already closed when the fact arrived — report in the current period with the true legal date. */
  readonly reported_late: boolean; readonly activity_period: string;
  /** FNMA_IRM_PAYOFF_AC60 / FNMA_IRM_LIQ_AC70_72: next `fannie_et` BD 20:00 ET (17:00 if BD2). */
  readonly lar_due_at: string;
  /** FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD (rule 9, `mode=event`): next BD 03:00 ET. */
  readonly p360_event_due_at: string | null;
  readonly state: "code_selected";
}
/** Validates the fact and appends `liquidation_facts.processed` (the arming event of the removal clocks). */
export function processLiquidationFact(em: Emitter, i: LiquidationFactInput): { readonly fact: LiquidationFact; readonly event: DomainEvent } {
  const liquidation_type = oneOf(i.liquidation_type, LIQUIDATION_TYPES, "liquidation_type");
  need(isoDate(i.legal_date), "legal_date must be YYYY-MM-DD");
  const processedMs = instant(i.processed_at, "processed_at");
  const purchaser = i.purchaser == null ? null : oneOf(i.purchaser, PURCHASERS, "purchaser");
  const insured_flag = oneOf(i.insured_flag ?? "none", INSURED_FLAGS, "insured_flag");
  const mode = oneOf(i.mode ?? "legacy", CHANNEL_MODES, "mode");
  need(liquidation_type !== "fcl_third_party" || purchaser !== "fnma", "a third-party sale cannot name fnma as the purchaser (code 70/72 is a Fannie Mae acquisition)");
  need(i.proceeds_cents == null || i.proceeds_cents >= 0n, "proceeds_cents must not be negative");
  const kind = liquidationKind(liquidation_type);
  const action_code = actionCode(kind, insured_flag);
  const legalPeriod = periodOf(i.legal_date);
  const reported_late = processedMs > removalCorrectionCloseMs(legalPeriod);
  const activity_period = reported_late ? periodOf(wallClock(processedMs, ET).date) : legalPeriod;
  const processed_at = toIso(processedMs);
  const fact: LiquidationFact = {
    fact_id: i.fact_id || `liquidation:${em.loanId}:${i.legal_date}:${liquidation_type}`, liquidation_type, kind, legal_date: i.legal_date, processed_at, purchaser, insured_flag,
    fnma_loss_risk: i.fnma_loss_risk ?? null, proceeds_cents: i.proceeds_cents ?? null, action_code, event_type: removalEventType(action_code), mode,
    p360_event_type: mode === "legacy" || action_code === "60" ? null : p360EventType(kind, action_code), reported_late, activity_period,
    lar_due_at: toIso(larDeadlineMs(processedMs, true)), p360_event_due_at: mode === "event" && action_code !== "60" ? toIso(eventDeadlineMs(processedMs)) : null, state: "code_selected",
  };
  const event = append(em, "liquidation_facts.processed", { fact_id: fact.fact_id, case_id: i.case_id ?? null, liquidation_type, legal_date: fact.legal_date, processed_at, purchaser, insured_flag, fnma_loss_risk: fact.fnma_loss_risk,
    proceeds_cents: fact.proceeds_cents === null ? null : fact.proceeds_cents.toString(), action_code, event_type: fact.event_type, mode, p360_event_type: fact.p360_event_type, reported_late, activity_period, lar_due_at: fact.lar_due_at, p360_event_due_at: fact.p360_event_due_at, state: fact.state },
    { kind: "liquidation_facts", id: fact.fact_id });
  return { fact, event };
}

// ───── the Property 360 liquidation-event acceptance (rule 9 rail; inbound `fnma-p360` record) ─────
export interface P360AcceptanceRecord {
  readonly fact_id?: string | null; readonly fnma_loan_number: string; readonly liquidation_event_type: P360EventType; readonly p360_case_id: string;
  readonly accepted_at: string; readonly action_code?: RemovalCode | null; readonly env?: "production" | "api-clve" | null;
}
/** Validates the parsed acceptance and appends `p360.liquidation_event.accepted` (state `reported` → `accepted`; satisfies FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD). */
export function acceptP360LiquidationEvent(em: Emitter, r: P360AcceptanceRecord): DomainEvent {
  need(typeof r.fnma_loan_number === "string" && /^\d{10}$/.test(r.fnma_loan_number), "fnma_loan_number must be the 10-digit Fannie Mae loan number");
  const liquidation_event_type = oneOf(r.liquidation_event_type, P360_EVENT_TYPES, "liquidation_event_type");
  need(typeof r.p360_case_id === "string" && r.p360_case_id !== "", "p360_case_id is required (the Property 360 case the acceptance names)");
  const acceptedMs = instant(r.accepted_at, "accepted_at");
  need(acceptedMs <= Date.parse(em.now), "accepted_at cannot be in the future");
  const action_code = r.action_code == null ? null : oneOf(r.action_code, ["70", "71", "72"] as const, "action_code");
  const env = r.env == null ? "production" : oneOf(r.env, ["production", "api-clve"] as const, "env");
  const fact_id = r.fact_id || null;
  return append(em, "p360.liquidation_event.accepted", { fact_id, fnma_loan_number: r.fnma_loan_number, liquidation_event_type, p360_case_id: r.p360_case_id, accepted_at: toIso(acceptedMs), action_code, env, state: "accepted" },
    fact_id ? { kind: "liquidation_facts", id: fact_id } : undefined);
}

// ───── code changes after close (IRM 4-08 finality; side state `code_change_cpm`) ─────
export type CpmAction = "cancel_reogram" | "submit_reogram" | "reclassify_conveyance" | "readd";
export interface CodeChangeInput { readonly from_code: RemovalCode; readonly to_code: RemovalCode; readonly accepted_period: string; readonly reason: string; readonly detected_at?: string | null; }
export interface CodeChangeDecision {
  readonly path: "correction_pending" | "code_change_cpm"; readonly after_close: boolean; readonly close_at: string; readonly cpm_action: CpmAction | null;
  /** SM_LIQ_CODE_CHANGE_CPM_2BD: 2 BD from detection (the engine arms it from the event). */
  readonly cpm_due_on: PlainDate | null; readonly draft: CpmNotice | null; readonly event: DomainEvent | null;
}
export interface CpmNotice { readonly to: "SF CPM"; readonly kind: "code_change" | "readd"; readonly loan_id: string; readonly from_code: RemovalCode | null; readonly to_code: RemovalCode | null; readonly body: string; readonly status: "draft"; readonly send_by: readonly ["fnma_portal_operator", "officer"]; }

/** "70→71: CPM cancels the REOgram; 71→70/72: submit a REOgram to CPM" (IRM 4-08). */
export const cpmActionFor = (from: RemovalCode, to: RemovalCode): CpmAction => (from === "70" || from === "72") && to === "71" ? "cancel_reogram" : from === "71" && (to === "70" || to === "72") ? "submit_reogram" : from === "60" || to === "60" ? "readd" : "reclassify_conveyance";
/** Rule 6 / guardrail "never change a removal after BD2 17:00 ET": the agent drafts; `fnma_portal_operator`/`officer` send. */
export function draftCpmNotice(i: { readonly loan_id: string; readonly kind?: "code_change" | "readd"; readonly reason: string; readonly from_code?: RemovalCode | null; readonly to_code?: RemovalCode | null }): CpmNotice {
  need(i.loan_id !== "" && i.reason !== "", "loan_id and reason are required");
  const kind = i.kind ?? "code_change";
  const body = kind === "readd" ? `Request to re-add loan ${i.loan_id} liquidated in error (readd_requests@fanniemae.com): ${i.reason}` : `Request to change the liquidation action code for loan ${i.loan_id}${i.from_code && i.to_code ? ` from ${i.from_code} to ${i.to_code}` : ""}: ${i.reason}`;
  return { to: "SF CPM", kind, loan_id: i.loan_id, from_code: i.from_code ?? null, to_code: i.to_code ?? null, body, status: "draft", send_by: ["fnma_portal_operator", "officer"] };
}
/** Within the period a correcting (superseding) removal event is projected before BD2 17:00 ET; after close the change goes to SF CPM → `liquidation.code_change.needed` (arms SM_LIQ_CODE_CHANGE_CPM_2BD, 2 BD from detection). */
export function codeChangeAfterClose(em: Emitter, i: CodeChangeInput): CodeChangeDecision {
  const from = oneOf(i.from_code, ["60", "70", "71", "72"] as const, "from_code"), to = oneOf(i.to_code, ["60", "70", "71", "72"] as const, "to_code");
  need(from !== to, "from_code and to_code must differ");
  need(/^\d{4}-\d{2}$/.test(i.accepted_period), "accepted_period must be YYYY-MM");
  need(typeof i.reason === "string" && i.reason !== "", "reason is required");
  const detectedMs = i.detected_at ? instant(i.detected_at, "detected_at") : Date.parse(em.now);
  const closeMs = removalCorrectionCloseMs(i.accepted_period);
  const after_close = detectedMs > closeMs;
  if (!after_close) return { path: "correction_pending", after_close, close_at: toIso(closeMs), cpm_action: null, cpm_due_on: null, draft: null, event: null };
  const cpm_action = cpmActionFor(from, to);
  const detected_at = toIso(detectedMs);
  const cpm_due_on = addBusinessDays(wallClock(detectedMs, ET).date, 2, fannieEt);
  const draft = draftCpmNotice({ loan_id: em.loanId, kind: cpm_action === "readd" ? "readd" : "code_change", reason: i.reason, from_code: from, to_code: to });
  const event = append(em, "liquidation.code_change.needed", { from_code: from, to_code: to, accepted_period: i.accepted_period, reason: i.reason, cpm_action, detected_at, close_at: toIso(closeMs), cpm_due_on, state: "code_change_cpm" });
  return { path: "code_change_cpm", after_close, close_at: toIso(closeMs), cpm_action, cpm_due_on, draft, event };
}
export interface CpmSendInput { readonly kind?: "code_change" | "readd"; readonly from_code?: RemovalCode | null; readonly to_code?: RemovalCode | null; readonly sent_via: "email" | "portal"; readonly reference: string; readonly body?: string | null; }
/** The human send (role-gated by the tool): appends `cpm.notification.sent` — satisfies SM_LIQ_CODE_CHANGE_CPM_2BD. */
export function sendCpmNotice(em: Emitter, i: CpmSendInput): DomainEvent {
  need(em.actor.kind === "human", "CPM notifications are sent by a human (fnma_portal_operator/officer); the agent only drafts");
  const sent_via = oneOf(i.sent_via, ["email", "portal"] as const, "sent_via");
  need(typeof i.reference === "string" && i.reference !== "", "reference (the CPM e-mail id / portal ticket) is required as evidence of the send");
  return append(em, "cpm.notification.sent", { kind: i.kind ?? "code_change", from_code: i.from_code ?? null, to_code: i.to_code ?? null, sent_via, reference: i.reference, body: i.body ?? null, sent_by: em.actor.id, sent_by_role: em.actor.role ?? null, sent_at: em.now });
}

// ───── post-close payoff error (rule 6 / T6; side state `payoff_final_error`) ─────
export interface PostCloseErrorInput { readonly accepted_period: string; readonly discovered_at?: string | null; readonly reported_principal_cents: Cents; readonly reported_interest_cents: Cents; readonly reason?: string | null; }
export function recordPostCloseRemovalError(em: Emitter, i: PostCloseErrorInput): ReturnType<typeof postCloseRemovalError> & { readonly case_id: string | null; readonly owner: "partner_non_fnma" | null; readonly events: DomainEvent[] } {
  need(/^\d{4}-\d{2}$/.test(i.accepted_period), "accepted_period must be YYYY-MM");
  const discoveredMs = i.discovered_at ? instant(i.discovered_at, "discovered_at") : Date.parse(em.now);
  const r = postCloseRemovalError({ accepted_period: i.accepted_period, discovered_at_ms: discoveredMs, reported_principal_cents: i.reported_principal_cents, reported_interest_cents: i.reported_interest_cents });
  if (!r.after_close) return { ...r, case_id: null, owner: null, events: [] };
  const case_id = `qc:${em.loanId}:${i.accepted_period}:payoff_final_error`;
  const flagged = append(em, "loans.fnma_liquidated_in_error", { accepted_period: i.accepted_period, discovered_at: toIso(discoveredMs), close_at: toIso(r.close_ms), amount_due_cents: r.amount_due_cents.toString(), owner: "partner_non_fnma", readd_request_to: "readd_requests@fanniemae.com", reason: i.reason ?? null, state: "payoff_final_error" });
  const opened = append(em, "case.opened", { case_id, kind: "qc_finding", source: "5.3", accepted_period: i.accepted_period, amount_due_cents: r.amount_due_cents.toString(), escalation: "officer" }, { kind: "case", id: case_id });
  return { ...r, case_id, owner: "partner_non_fnma", events: [flagged, opened] };
}

// ───── the REOgram portal task (E-4.1-01; rule 7 / rule 8) ─────
export interface ReogramTaskInput { readonly source: "p360_notice" | "ac70_72_acceptance" | "dra_sale_event"; readonly received_at?: string | null; readonly sale_date?: PlainDate | null; readonly p360_case_id?: string | null; readonly bid_cents?: Cents | null; }
/** Pre-creates (rule 7) or opens (rule 8) the confirmation task: `reogram.created{receipt}` arms FNMA_E4101_REOGRAM_CONFIRM_1BD (1 `fannie_et` BD). */
export function preCreateReogramTask(em: Emitter, i: ReogramTaskInput): { readonly due_on: PlainDate; readonly due_at: string; readonly warning_at: string; readonly role: "fnma_portal_operator"; readonly task_id: string; readonly events: DomainEvent[] } {
  const source = oneOf(i.source, ["p360_notice", "ac70_72_acceptance", "dra_sale_event"] as const, "source");
  const receivedMs = i.received_at ? instant(i.received_at, "received_at") : Date.parse(em.now);
  need(i.sale_date == null || isoDate(i.sale_date), "sale_date must be YYYY-MM-DD");
  const t = reogramConfirmation(receivedMs);
  const receipt = toIso(receivedMs);
  const task_id = `reogram:${em.loanId}:${receipt.slice(0, 10)}`;
  const created = append(em, "reogram.created", { receipt, source, queue: "pending", p360_case_id: i.p360_case_id ?? null, sale_date: i.sale_date ?? null, bid_cents: i.bid_cents == null ? null : i.bid_cents.toString(), confirm_due_at: toIso(t.due_ms), confirm_due_on: t.due_on }, { kind: "reogram_confirmations", id: task_id });
  const task = append(em, "human_portal_task.created", { task: "reogram_confirmation", task_id, role: t.role, due_on: t.due_on, due_at: toIso(t.due_ms), warning_at: toIso(t.warning_at_ms), source }, { kind: "human_portal_task", id: task_id });
  return { due_on: t.due_on, due_at: toIso(t.due_ms), warning_at: toIso(t.warning_at_ms), role: t.role, task_id, events: [created, task] };
}
export interface ReogramConfirmInput { readonly p360_case_id: string; readonly evidence_document_id: string; readonly task_id?: string | null; readonly confirmed_at?: string | null; }
/** `human_portal_task` completed with the P360 confirmation evidence → `reogram.confirmed` (satisfies FNMA_E4101_REOGRAM_CONFIRM_1BD). */
export function confirmReogram(em: Emitter, i: ReogramConfirmInput): DomainEvent[] {
  need(typeof i.p360_case_id === "string" && i.p360_case_id !== "", "p360_case_id is required");
  need(typeof i.evidence_document_id === "string" && i.evidence_document_id !== "", "evidence_document_id (screenshot / case id capture) is required");
  const confirmedMs = i.confirmed_at ? instant(i.confirmed_at, "confirmed_at") : Date.parse(em.now);
  const task_id = i.task_id ?? null;
  const done = append(em, "human_portal_task.completed", { task: "reogram_confirmation", task_id, p360_case_id: i.p360_case_id, evidence_document_id: i.evidence_document_id, completed_at: toIso(confirmedMs) }, task_id ? { kind: "human_portal_task", id: task_id } : undefined);
  // "confirmed cases move to Accepted at 7 p.m. ET and fields stay editable for 5 BD" (REOgram User Guide)
  const day = wallClock(confirmedMs, ET).date; const sevenPm = zonedEpochMs(day, "19:00", ET);
  const acceptsAtMs = confirmedMs < sevenPm ? sevenPm : zonedEpochMs(addBusinessDays(day, 1, fannieEt), "19:00", ET);
  const confirmed = append(em, "reogram.confirmed", { p360_case_id: i.p360_case_id, confirmed_at: toIso(confirmedMs), evidence_document_id: i.evidence_document_id, task_id, p360_accepts_at: toIso(acceptsAtMs), editable_until: addBusinessDays(wallClock(acceptsAtMs, ET).date, 5, fannieEt), state: "reo_confirmed" });
  return [done, confirmed];
}
export function raiseReogramException(em: Emitter, i: { readonly p360_case_id: string; readonly code: string; readonly text?: string | null; readonly raised_at?: string | null }): DomainEvent {
  need(i.p360_case_id !== "" && i.code !== "", "p360_case_id and the exception code are required");
  const raisedMs = i.raised_at ? instant(i.raised_at, "raised_at") : Date.parse(em.now);
  return append(em, "reogram.exception.raised", { raised_at: toIso(raisedMs), p360_case_id: i.p360_case_id, code: i.code, text: i.text ?? null });
}
export function resolveReogramException(em: Emitter, i: { readonly p360_case_id: string; readonly code: string; readonly evidence_document_id: string }): DomainEvent {
  need(i.p360_case_id !== "" && i.code !== "" && i.evidence_document_id !== "", "p360_case_id, code and evidence_document_id are required");
  return append(em, "reogram.exception.resolved", { p360_case_id: i.p360_case_id, code: i.code, evidence_document_id: i.evidence_document_id, resolved_at: em.now });
}
