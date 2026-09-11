/**
 * 32.6 — Decision, property, title, insurance, MI, clear to close (spec/sections/32-borrower-experience/32-6-*.md): the
 * borrower-facing form of 21.6 (decisions), 23.3 (conditional approval, CTC), 24.1/24.2 (valuation, appraisal copy),
 * 24.3 (project review), 24.5 (hazard / flood), 24.6 (MI), 25.2 (the CD's earliest consummation date) and 28.1 (the
 * pre-funding QC hold). Every card is created through 32.1's `send_card` as the `intake` agent on the owning process's
 * event; nothing here computes a regulatory date or a money figure — dates come from `timers` and the owning events,
 * figures from the owning rows (credit_decisions, application_decisions, mi_quotes, appraisals).
 *
 *   decision.issued{conditional_approval}            StatusCard `decision.conditional_approval` (count_you / count_us from `conditions`) (T1)
 *   notice.sent{NTC_REGB_1002_9_APPROVAL}            NoticeCard `decision.approval.notice` {valid_until, borrower-facing conditions} (T1)
 *   decision.issued{counteroffer}                    ChoiceCard `decision.counteroffer` (accept · decline · talk to a person) + ComparisonCard requested vs offered (T2)
 *   notice.sent{NTC_REGB_1002_9_COUNTEROFFER}        NoticeCard `decision.counteroffer.notice`
 *   decision.issued{denial}                          every pending card cancelled (Needed-from-you empties); StatusCard `decision.denial.next` (T3)
 *   notice.sent{NTC_REGB_1002_9_ADVERSE_ACTION}      NoticeCard `decision.denial.notice` {principal_reasons — never a DU string} (T3)
 *   decision.issued{incomplete} / NOIA sent          StatusCard `decision.noia` {date}; NoticeCard `decision.noia.notice`
 *   valuation.method.selected{value_acceptance}      StatusCard `valuation.value_acceptance`; Property "No appraisal needed" (record.ts) (T4)
 *   valuation.assigned (refinance)                   ScheduleCard{appraisal_access} `valuation.schedule` — never for value acceptance (T4)
 *   valuation.copy.delivered                         DocumentCard `valuation.copy` {requires_ack} — the Reg B copy; REGB_1002_14_APPRAISAL_COPY_3BD_GATE is 24.2's (T5)
 *   valuation.value_used.set (purchase, below price) ChoiceCard `valuation.low.choice` renegotiate · cash · cancel; cash → application.confirmField{source=borrower} (T6)
 *   application.six_item.captured after "cash"       23.1 evaluateResubmission on the new loan amount → `du.resubmission.required` (T6)
 *   project.docs.requested                           SQ-08: UploadCard (owner you) for the documents the HOA sends to owners; HandoffCard{hoa_management} otherwise (T7)
 *   insurance.deficiency.opened{kind}                NoticeCard `insurance.deficient` naming the single failing element + UploadCard `insurance.upload.policy` (T8)
 *   flood.notice.delivered                           DocumentCard `flood.notice` {NTC_FDPA_4104A_FLOOD_NOTICE, requires_ack} (T9)
 *   mi.quote.received                                ComparisonCard `mi.compare.title` — one column per plan with its cancellation rule; mi.selectPlan (T10)
 *   clear_to_close.issued                            StatusCard `ctc.reached`; the closing ScheduleCard waits for the CD's earliest_consummation_date (T11)
 *   disclosure.cd.waiting_period.computed            ScheduleCard{ron_session} `closing.schedule` — never before `flood.notice.delivered` on an SFHA loan (T9, T11)
 *   qc.hold.applied{kind=prefunding}                 StatusCard `ctc.final_review` — "a final review is in progress", never "QC" (T12)
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { plainDate as D, addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../../kernel/calendar/business.ts";
import { EntityStore } from "../../../app/tools.ts";
import { piCents } from "../../../domain/underwriting/ops-23-1.ts";
import { timerLabel } from "../record.ts";
import type { BorrowerFlow, FlowDeps } from "./index.ts";

export const FLOW_ID = "32.6";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" };
const RUN = { runId: "flow:32.6", modelVersion: "borrower flows (deterministic)", promptVersion: "32.6" } as const;

/** 21.6 / 23.3 decision notices → the NoticeCard copy key (32.6 §1). */
export const DECISION_NOTICE_COPY: Readonly<Record<string, string>> = { NTC_REGB_1002_9_APPROVAL: "decision.approval.notice", NTC_REGB_1002_9_COUNTEROFFER: "decision.counteroffer.notice", NTC_REGB_1002_9_ADVERSE_ACTION: "decision.denial.notice", NTC_REGB_1002_9_NOIA: "decision.noia.notice" };
export const FLOOD_NOTICE_CODE = "NTC_FDPA_4104A_FLOOD_NOTICE";
export const APPRAISAL_COPY_NOTICE_CODE = "NTC_REGB_1002_14_VALUATION_COPY";
/** 32.6 §5: the single failing element of a deficient policy (24.5's `insurance_deficiencies.kind` → the element the card names) and the fix, as copy keys. */
export const DEFICIENCY_ELEMENT: Readonly<Record<string, string>> = { deductible_excess: "deductible", acv_dwelling: "coverage_form", perils_gap: "coverage_form", rating_fail: "carrier_rating", mortgagee_clause: "mortgagee_clause", named_insured: "mortgagee_clause", effective_date: "effective_date", premium_unpaid: "effective_date", flood_none: "flood_coverage", flood_insufficient: "flood_coverage", flood_deductible: "flood_coverage", nfip_not_applied_paid_at_closing: "flood_coverage", private_flood_terms: "flood_coverage" };
/** SQ-08: the project documents an association sends to its owners (the borrower holds them — owner *you*); the rest come from the management company (owner *third party*). */
export const HOA_SENDS_TO_OWNER: ReadonlySet<string> = new Set(["budget", "ccrs", "minutes", "dues_statement"]);
/** 32.6 §6: 24.6's premium plans → the four borrower-facing plans (bpmi_monthly · single · split · lpmi) and their HPA cancellation rule copy. */
export const MI_PLAN_UX: Readonly<Record<string, string>> = { bpmi_monthly: "bpmi_monthly", bpmi_annual: "bpmi_monthly", bpmi_single: "single", financed_single: "single", bpmi_split: "split", lpmi_monthly: "lpmi", lpmi_single: "lpmi" };
export const MI_PLAN_ORDER: readonly string[] = ["bpmi_monthly", "single", "split", "lpmi"];
const REACTS = new Set(["decision.issued", "notice.sent", "counteroffer.accepted", "counteroffer.declined", "counteroffer.expired", "noia.sent", "application.withdrawn", "application.closed_incomplete",
  "valuation.method.selected", "valuation.assigned", "valuation.inspection.scheduled", "valuation.copy.delivered", "valuation.value_used.set", "application.six_item.captured",
  "project.docs.requested", "insurance.deficiency.opened", "insurance.deficiency.cleared", "flood.determination.received", "flood.notice.delivered",
  "mi.quote.received", "mi.plan.selected", "clear_to_close.issued", "disclosure.cd.waiting_period.computed", "disclosure.cd.waiver.accepted", "closing.scheduled", "qc.hold.applied"]);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: string | bigint | number): string => USD.format(Number(BigInt(String(cents))) / 100);

// ---------------------------------------------------------------- the application context one batch works on
interface Party { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string }
interface Ctx { readonly appId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly now: string; readonly app: P | null }
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

async function context(deps: FlowDeps, appId: string): Promise<Ctx> {
  const [events, records, parties, app] = await Promise.all([
    deps.runtime.uow.events.byApplication(appId),
    deps.runtime.entities.load({ applicationId: appId }),
    deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT party_id, id AS application_borrower_id, legal_name FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at, id`, [appId]),
    deps.runtime.db.query<P>(`SELECT a.id, a.transaction_type, a.occupancy, p.state, p.property_type, p.units, p.estimated_value_cents::text AS estimated_value_cents FROM applications a LEFT JOIN LATERAL (SELECT * FROM application_properties x WHERE x.application_id = a.id ORDER BY x.is_subject DESC, x.created_at LIMIT 1) p ON true WHERE a.id = $1`, [appId]).then((r) => r[0] ?? null)]);
  const store = new EntityStore(); store.seed(records);
  return { appId, events, store, parties, now: deps.runtime.clock.now(), app };
}
/** 21.6's per-applicant rows name the interview's own borrower id ("B1"); the intake application maps it to the application_borrowers row by legal name. */
function partiesFor(ctx: Ctx, borrowerId: unknown): readonly Party[] {
  if (typeof borrowerId !== "string" || !borrowerId) return ctx.parties;
  const intake = ctx.store.get("applications", ctx.appId)?.data as { borrowers?: { id: string; legal_name: string }[] } | undefined;
  const b = intake?.borrowers?.find((x) => x.id === borrowerId);
  const own = ctx.parties.filter((p) => p.application_borrower_id === borrowerId || (b && p.legal_name === b.legal_name));
  return own.length ? own : ctx.parties;
}

// ---------------------------------------------------------------- card and thread primitives (32.1's tools as the intake agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string; readonly flow_key: string; readonly informational?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, ctx: Ctx, party: Party, c: CardSpec): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { application_id: ctx.appId }, created_by: "agent:intake", rationale: `32.6 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  // a card with no action (StatusCard, NoticeCard, an informational ComparisonCard) is never the pinned ask: filed as read the moment it is sent (01 §3.1)
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", ctx.now, { informational: true, resolved_by: "system:flow-32.6" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx, p, c)); return ids; }
/** Move every pending card on a flow-key prefix (a newer card for the same ask, an ask withdrawn, a subject that reached a terminal state). */
async function transitionAll(deps: FlowDeps, ctx: Ctx, flowKeyPrefix: string, to: "resolved" | "superseded" | "cancelled", evidence: P): Promise<number> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE $2`, [ctx.appId, `${flowKeyPrefix}%`]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, to, "system", ctx.now, { ...evidence, resolved_by: "system:flow-32.6" });
  return rows.length;
}
/** 32.6 §1.3 / §1.5: a terminal disposition cancels every pending card of the application, whichever flow sent it — Needed-from-you empties, the Record is read-only. */
async function cancelEveryPendingCard(deps: FlowDeps, ctx: Ctx, reason: string): Promise<number> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND status = 'pending'`, [ctx.appId]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, "cancelled", "system", ctx.now, { reason, resolved_by: "system:flow-32.6" });
  return rows.length;
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true });
async function timerDue(deps: FlowDeps, appId: string, code: string): Promise<string | null> {
  const t = (await deps.runtime.db.query<{ due_at: string | null }>(`SELECT due_at FROM timers WHERE application_id = $1 AND code = $2 AND status IN ('armed', 'breached', 'satisfied', 'satisfied_late') ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
  return t?.due_at ?? null;
}
const pendingOfKind = async (deps: FlowDeps, ctx: Ctx, kind: string, where: string, params: unknown[] = []): Promise<number> =>
  Number((await deps.runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instances WHERE subject_application_id = $1 AND status = 'pending' AND kind = $2 ${where}`, [ctx.appId, kind, ...params]))[0]?.n ?? 0);

// ---------------------------------------------------------------- decisions (21.6, 23.3)
interface ConditionRow { condition_id: string; status: string; stage: string; text?: string; borrower_visible?: boolean }
/** 23.2's conditions as the borrower sees them: waiting on the borrower (`waiting_borrower`, or a live borrower-visible condition whose borrower text asks the borrower for something) vs. the platform's. */
export function conditionOwners(conditions: readonly ConditionRow[]): { you: ConditionRow[]; us: ConditionRow[] } {
  const live = conditions.filter((c) => ["open", "waiting_borrower", "waiting_third_party", "satisfied_pending_review", "reopened"].includes(c.status) && c.stage !== "post_closing");
  const you = live.filter((c) => c.status === "waiting_borrower" || ((c.status === "open" || c.status === "reopened") && c.borrower_visible === true && /\b(needs? (a copy of )?your|needs the|send us|upload)\b/i.test(c.text ?? "")));
  return { you, us: live.filter((c) => !you.includes(c)) };
}
const conditionsOf = (ctx: Ctx): ConditionRow[] => ctx.store.list("conditions", (d) => d.application_id === ctx.appId).map((r) => r.data as unknown as ConditionRow);
type DecisionFile = { disposition?: string; original_terms?: { loan_amount_cents: unknown; note_rate: string; product_code: string; ltv: string } | null; decisions?: { decision_id: string; kind: string; counteroffer_terms?: { loan_amount_cents: unknown; note_rate: string; product_code: string; ltv: string; conditions: string[]; expires_on: string } | null; sent_at?: string | null }[]; adverse_actions?: { adverse_action_id: string; decision_id: string; kind: string; principal_reasons?: { statement_text: string; reason_code: string }[]; sent_at?: string | null }[]; noias?: { noia_id: string; decision_id: string; items_needed?: { item: string; description: string }[]; response_due_on?: string | null }[] };
const decisionFile = (ctx: Ctx): DecisionFile | undefined => ctx.store.get("application_decisions", ctx.appId)?.data as DecisionFile | undefined;
const rateRow = (rate: string): P => ({ label: "Rate", value: `${rate}%`, emphasis: true });
/** 21.6's terms → the ComparisonCard column: loan amount, rate, LTV, the platform's own P&I for the note terms (23.1's amortization), never a figure the UI invents. */
function termsColumn(id: string, title: string, t: { loan_amount_cents: unknown; note_rate: string; ltv?: string; product_code?: string }, termMonths: number): P {
  const amount = BigInt(String(t.loan_amount_cents));
  const rows: P[] = [{ label: "Loan amount", value: money(amount) }, rateRow(t.note_rate), { label: "Monthly principal & interest", value: `${money(piCents(amount, t.note_rate, termMonths))}/mo` }];
  if (t.ltv) rows.push({ label: "Loan-to-value", value: `${t.ltv}%` });
  return { id, title, rows };
}
async function onDecisionIssued(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const kind = String(p["kind"] ?? ""); const decisionId = String(p["decision_id"] ?? e.id);
  if (kind === "conditional_approval" || kind === "approval") {
    const { you, us } = conditionOwners(conditionsOf(ctx));
    const validUntil = (last(ctx, "credit_decision.recorded", (x) => x["decision_id"] === decisionId)?.payload["valid_until"] as string | undefined) ?? (ctx.store.get("credit_decisions", decisionId)?.data["valid_until"] as string | undefined) ?? null;
    await sendToAll(deps, ctx, StatusCard("decision.conditional_approval", `decision.status:${decisionId}`, { copy_tokens: { count_you: String(you.length), count_us: String(us.length) }, next_event_label: timerLabel("SM_UW_DECISION_VALIDITY"), next_event_at: await timerDue(deps, ctx.appId, "SM_UW_DECISION_VALIDITY"), valid_until: validUntil, decision_id: decisionId, decision_kind: kind }));
    return;
  }
  if (kind === "counteroffer") {
    const file = decisionFile(ctx); const d = file?.decisions?.find((x) => x.decision_id === decisionId); const terms = d?.counteroffer_terms ?? null; const original = file?.original_terms ?? null;
    const expiresOn = String(p["expires_on"] ?? terms?.expires_on ?? ""); const termMonths = Number(ctx.store.list("locks", (x) => x.application_id === ctx.appId).at(-1)?.data["term_months"] ?? ctx.store.list("pricing_quotes").at(-1)?.data["term_months"] ?? 360);
    // the counteroffer's own expiry when shorter than REGB_1002_9_COUNTEROFFER_90 (32.6 §1.2): the card expires with the offer; the clock itself is rendered from `timers`
    const expires_at = expiresOn ? `${expiresOn}T23:59:59.000Z` : undefined;
    await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "decision.counteroffer", flow_key: `counteroffer.choice:${decisionId}`, command_ref: "counteroffer.respond", ...(expires_at ? { expires_at } : {}),
      props: { title: "", options: [{ id: "accept", label: "Accept these terms", is_primary: true }, { id: "decline", label: "Decline" }, { id: "human", label: "Talk to a person" }], command: "counteroffer.respond", command_args_by_option: { accept: { decision: "accept", decision_id: decisionId }, decline: { decision: "decline", decision_id: decisionId }, human: {} }, no_command_options: ["human"], decision_id: decisionId, expires_on: expiresOn || null, timer_code: "REGB_1002_9_COUNTEROFFER_90", affirmatives: ["accept these terms", "i accept"] } });
    if (terms) {
      const columns: P[] = []; if (original) columns.push(termsColumn("requested", "What you asked for", original, termMonths)); columns.push(termsColumn("offered", "What we can offer", terms, termMonths));
      await sendToAll(deps, ctx, { kind: "ComparisonCard", copy_key: "decision.counteroffer.compare", flow_key: `counteroffer.compare:${decisionId}`, informational: true,
        props: { title: "", columns, recommended_id: "offered", command: "counteroffer.respond", no_command_options: ["requested", "offered"], conditions: [...(terms.conditions ?? [])], expires_on: terms.expires_on ?? expiresOn ?? null, decision_id: decisionId, footnote: "" } });
    }
    return;
  }
  if (kind === "denial" || kind === "file_closed_incomplete" || kind === "approved_not_accepted") {
    await cancelEveryPendingCard(deps, ctx, `decision.issued{${kind}}`);
    if (kind === "denial") await sendToAll(deps, ctx, StatusCard("decision.denial.next", `decision.status:${decisionId}`, { decision_id: decisionId, next_steps_timer: has(ctx, "valuation.received") || has(ctx, "valuation.review.completed") ? "REGB_1002_14_COPY_NOT_CONSUMMATED_30" : null }));
    return;
  }
  if (kind === "incomplete") {
    const noia = decisionFile(ctx)?.noias?.find((n) => n.decision_id === decisionId);
    await sendToAll(deps, ctx, StatusCard("decision.noia", `decision.status:${decisionId}`, { copy_tokens: { date: String(noia?.response_due_on ?? p["response_due_on"] ?? "") }, next_event_label: timerLabel("REGB_1002_9_NOIA"), next_event_at: await timerDue(deps, ctx.appId, "REGB_1002_9C2_NOIA_RESPONSE") ?? (await timerDue(deps, ctx.appId, "REGB_1002_9_NOIA")), items_needed: noia?.items_needed ?? [], decision_id: decisionId }));
  }
}
/** The 21.6 / 23.3 notice rendered through the Notice Registry → the NoticeCard with the rendered document and the owning row's borrower-facing content (never DU output, never a score). */
async function onDecisionNoticeSent(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const template = String(p["template"]); const copy_key = DECISION_NOTICE_COPY[template]; if (!copy_key) return;
  const noticeId = String(p["notice_id"]); const channels = (Array.isArray(p["channels"]) ? (p["channels"] as { party_id?: string; channel?: string }[]) : []);
  const mailed = channels.some((c) => String(c.channel ?? "").startsWith("mail")); const channel = mailed ? "mail" : "app";
  const file = decisionFile(ctx);
  const base: P = { notice_code: template, notice_id: noticeId, title: "", rendered_document_id: String(p["rendered_document_id"] ?? noticeId), plain_language: "", line: "", template_version: null, delivered_at: String(p["sent_at"] ?? e.occurredAt), channel, ...(mailed ? { mailed_at: String(p["sent_at"] ?? e.occurredAt) } : {}) };
  let props: P = base; let flowKey = `decision.notice:${noticeId}`;
  if (template === "NTC_REGB_1002_9_APPROVAL") {
    const cd = ctx.store.list("credit_decisions", (d) => d.application_id === ctx.appId).at(-1)?.data as { decision_id?: string; valid_until?: string; validity_component?: string; conditions_snapshot?: { condition_id: string; text: string; stage: string }[] } | undefined;
    props = { ...base, decision_id: cd?.decision_id ?? null, valid_until: cd?.valid_until ?? null, validity_component: cd?.validity_component ?? null, conditions: (cd?.conditions_snapshot ?? []).map((c) => ({ condition_id: c.condition_id, text: c.text, stage: c.stage })), copy_tokens: { valid_until: cd?.valid_until ?? "" } };
    flowKey = `decision.notice:approval:${cd?.decision_id ?? noticeId}`;
  } else if (template === "NTC_REGB_1002_9_COUNTEROFFER") {
    const d = file?.decisions?.find((x) => x.kind === "counteroffer" && x.counteroffer_terms); const t = d?.counteroffer_terms ?? null;
    props = { ...base, decision_id: d?.decision_id ?? null, counteroffer: t ? { loan_amount_cents: String(t.loan_amount_cents), note_rate: t.note_rate, product_code: t.product_code, ltv: t.ltv, conditions: [...(t.conditions ?? [])], expires_on: t.expires_on } : null, original_terms: file?.original_terms ? { loan_amount_cents: String(file.original_terms.loan_amount_cents), note_rate: file.original_terms.note_rate, product_code: file.original_terms.product_code, ltv: file.original_terms.ltv } : null };
  } else if (template === "NTC_REGB_1002_9_ADVERSE_ACTION") {
    const aa = file?.adverse_actions?.slice().reverse().find((a) => a.kind !== "counteroffer") ?? file?.adverse_actions?.at(-1);
    // the specific reasons in the template's own taxonomy text (21.6 rule 3) — never the DU recommendation, a score cutoff or "internal standards" (21.6 guardrails; 32.6 §1.3 "never rendered")
    props = { ...base, decision_id: aa?.decision_id ?? null, adverse_action_id: aa?.adverse_action_id ?? null, principal_reasons: (aa?.principal_reasons ?? []).map((r) => ({ statement_text: r.statement_text, reason_code: r.reason_code })), next_steps_copy_key: "decision.denial.next", appraisal_copy_timer: has(ctx, "valuation.received") || has(ctx, "valuation.review.completed") ? "REGB_1002_14_COPY_NOT_CONSUMMATED_30" : null };
  } else if (template === "NTC_REGB_1002_9_NOIA") {
    const noia = file?.noias?.at(-1);
    props = { ...base, noia_id: noia?.noia_id ?? null, items_needed: noia?.items_needed ?? [], response_due_on: noia?.response_due_on ?? null, copy_tokens: { date: String(noia?.response_due_on ?? "") } };
  }
  const recipients = channels.map((c) => c.party_id).filter((x): x is string => typeof x === "string");
  const parties = recipients.length ? [...new Map(recipients.flatMap((r) => partiesFor(ctx, r)).map((x) => [x.party_id, x])).values()] : ctx.parties;
  await sendToAll(deps, ctx, { kind: "NoticeCard", copy_key, flow_key: flowKey, informational: true, props }, parties);
}

// ---------------------------------------------------------------- valuation (24.1, 24.2)
const isPurchase = (ctx: Ctx): boolean => String(ctx.app?.["transaction_type"] ?? "") === "purchase";
function tzOf(ctx: Ctx): string { return String(ctx.app?.["state"] ?? "") === "AZ" ? "America/Phoenix" : "America/New_York"; }
/** A wall-clock instant in the property's time zone as ISO (Intl's own offset for that date — no hand-rolled DST arithmetic). */
export function localIso(date: PlainDate, hhmm: string, timeZone: string): string {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(guess).find((x) => x.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part); const sign = m?.[1] === "-" ? -1 : 1; const offsetMin = m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(guess.getTime() - offsetMin * 60_000).toISOString();
}
/** Appointment windows offered from a first eligible date: the next three creditor business days at 10:00 and 14:00 local. */
export function appointmentSlots(from: PlainDate, timeZone: string, source: string): P[] {
  const slots: P[] = []; let day = creditor.isBusinessDay(from) ? from : addBusinessDays(from, 1, creditor);
  for (let i = 0; i < 3; i++) { for (const hhmm of ["10:00", "14:00"]) { const starts_at = localIso(day, hhmm, timeZone); slots.push({ id: `slot-${day}-${hhmm.replace(":", "")}`, starts_at, ends_at: new Date(Date.parse(starts_at) + 60 * 60_000).toISOString(), label: `${day} ${hhmm}` }); } day = addBusinessDays(day, 1, creditor); }
  void source; return slots;
}
async function onValuationAssigned(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const orderId = String(p["order_id"] ?? p["valuation_order_id"] ?? "");
  if (isPurchase(ctx)) { await sendToAll(deps, ctx, { kind: "HandoffCard", copy_key: "valuation.handoff.appraiser", flow_key: `valuation.handoff:${orderId}`, informational: true, props: { destination: "appraiser", what_to_expect: "", return_state: "inspection_scheduled", title: "", order_id: orderId } }); return; }
  // refinance: the borrower grants access (24.1 scheduleInspection through `valuation.scheduleAccess`); the windows are the AMC's (FAKE AMC scheduling)
  const from = D(e.occurredAt.slice(0, 10)); const slots = appointmentSlots(addBusinessDays(from, 1, creditor), tzOf(ctx), "AMC scheduling (FAKE)");
  await sendToAll(deps, ctx, { kind: "ScheduleCard", copy_key: "valuation.schedule", flow_key: `valuation.schedule:${orderId}`, command_ref: "valuation.scheduleAccess",
    props: { purpose: "appraisal_access", slots, constraints_text: "", title: "", helper: "", order_id: orderId, vendor: "AMC scheduling (FAKE)", command: "valuation.scheduleAccess", command_args_by_option: Object.fromEntries(slots.map((s) => [String(s["id"]), { order_id: orderId, slot: s["starts_at"], order_status: "assigned" }])) } });
}
async function onCopyDelivered(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const appraisalId = String(p["appraisal_id"] ?? ""); const version = Number(p["version"] ?? 1); const noticeId = String(p["notice_id"] ?? "");
  const row = ctx.store.get("appraisals", `${appraisalId}:v${version}`)?.data; const channel = String(p["channel"] ?? "electronic");
  if (channel === "mail") { await sendToAll(deps, ctx, StatusCard("valuation.copy.mailed", `valuation.copy.mailed:${appraisalId}:v${version}`, { copy_tokens: { date: String(p["provided_on"] ?? "") }, appraisal_id: appraisalId, version, provided_on: p["provided_on"] ?? null })); return; }
  await transitionAll(deps, ctx, `valuation.copy:${appraisalId}:`, "superseded", { superseded_by_version: version });
  // the Reg B copy (§1002.14): receipt confirmed on the card → the 24.2 `disclosures{kind=valuation_copy}` row records it; the value itself appears once the copy is delivered (Property, record.ts)
  await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "valuation.copy", flow_key: `valuation.copy:${appraisalId}:v${version}`, command_ref: "disclosure.acknowledgeReceipt",
    props: { document_id: noticeId || randomUUID(), disclosure_id: noticeId ? `DISC-${noticeId}` : null, notice_code: APPRAISAL_COPY_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: true, esign_scope_required: "disclosures", appraisal_id: appraisalId, version, is_final_version: p["is_final_version"] === true, provided_on: p["provided_on"] ?? null, delivered_at: String(p["delivered_at"] ?? e.occurredAt), channel: "esign_portal", receipt_evidence: p["receipt_evidence"] ?? null,
      value_used_cents: row?.["value_used_cents"] !== undefined && row?.["value_used_cents"] !== null ? String(row["value_used_cents"]) : null, appraised_value_cents: row?.["appraised_value_cents"] !== undefined ? String(row["appraised_value_cents"]) : null, timer_code: "REGB_1002_14_APPRAISAL_COPY_3BD_GATE",
      rov: { available: !has(ctx, "rov.requested", (x) => x["appraisal_id"] === appraisalId), command: "rov.request", appraisal_id: appraisalId, gate: "FNMA_B4_1_3_12_ROV_CLOSING_GATE" }, command_args: { disclosure_id: noticeId ? `DISC-${noticeId}` : appraisalId, kind: "valuation_copy" } } });
}
/** 32.6 §2 Low value (purchase): the appraised value below the contract price → the levers as one ChoiceCard; "cash" is `application.confirmField{source=borrower}` on the new down payment and loan amount. */
async function onValueUsedSet(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  if (!isPurchase(ctx)) return;
  const p = pl(e); const appraised = BigInt(String(p["appraised_value_cents"] ?? "0")); if (appraised <= 0n) return;
  const contract = (await deps.runtime.db.query<{ sales_price_cents: string | null }>(`SELECT sales_price_cents::text AS sales_price_cents FROM purchase_contracts WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`, [ctx.appId]))[0];
  const stored = ctx.store.list("purchase_contracts", (d) => d.application_id === ctx.appId).at(-1)?.data as { fields?: Record<string, { value?: string }> } | undefined;
  const priceStr = contract?.sales_price_cents ?? stored?.fields?.["purchase_price_cents"]?.value ?? null; if (!priceStr) return;
  const price = BigInt(priceStr); if (appraised >= price) return;
  const difference = price - appraised;
  // 21.1's intake row carries the six items' money as `loan_amount_sought_cents` (the `six_items` block holds only each item's hash and source)
  const intake = ctx.store.get("applications", ctx.appId)?.data as { loan_amount_sought_cents?: unknown; fields?: Record<string, { value?: unknown }>; six_items?: Record<string, { value?: unknown }> } | undefined;
  const sought = intake?.loan_amount_sought_cents ?? intake?.six_items?.["loan_amount_sought"]?.value ?? intake?.fields?.["loan_amount_sought"]?.value ?? null;
  const loanSought = typeof sought === "bigint" ? sought : sought !== null && sought !== undefined && /^\d+$/.test(String(sought)) ? BigInt(String(sought)) : null;
  const newLoan = loanSought !== null ? loanSought - difference : null; const newDown = loanSought !== null ? price - loanSought + difference : difference;
  const appraisalId = String(p["appraisal_id"] ?? ""); const flowKey = `valuation.low:${appraisalId}:v${String(p["version_no"] ?? 1)}`;
  await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "valuation.low.choice", flow_key: flowKey, command_ref: "application.confirmField",
    props: { title: "", copy_tokens: { money: money(appraised), price: money(price) }, options: [{ id: "renegotiate", label: "Renegotiate the price" }, { id: "cash", label: `Bring the difference in cash (${money(difference)})`, is_primary: true }, { id: "cancel", label: "Cancel under my contingency" }],
      command: "application.confirmField", command_args_by_option: { cash: { path: "down_payment", fields: [{ path: "down_payment_cents", value: newDown.toString(), source: "borrower" }, ...(newLoan !== null ? [{ path: "loan_amount_sought", value: newLoan.toString(), source: "borrower" }] : [])], commits_to: "applications.down_payment_cents", low_value_lever: "cash", appraisal_id: appraisalId }, renegotiate: {}, cancel: {} }, no_command_options: ["renegotiate", "cancel"],
      appraised_value_cents: appraised.toString(), purchase_price_cents: price.toString(), difference_cents: difference.toString(), new_down_payment_cents: newDown.toString(), new_loan_amount_cents: newLoan?.toString() ?? null, appraisal_id: appraisalId, levers: { renegotiate: "HandoffCard{appraiser}", cash: "application.confirmField{source=borrower} → 23.1 resubmission", cancel: "application.withdraw" } } });
}
/** The "cash" lever committed (32.6 §2): the six-item capture of the new loan amount is 23.1's resubmission trigger — evaluated on the casefile's last findings (purchase: any change resubmits, B3-2-10). */
async function onSixItemCaptured(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (String(p["item"] ?? p["field"] ?? "") !== "loan_amount_sought" || !isPurchase(ctx)) return;
  // The borrower's "cash" answer runs its command — this capture — and that commit wakes the flows before the API's own transaction marks the card
  // resolved (commands.ts resolveCard), so the lever card may still read `pending` here. The write is recognised by what it wrote: the six-item
  // capture of the lever's own new loan amount as the borrower's statement (21.1 `borrower_stated`), or the card's recorded "cash" evidence once landed.
  const levers = await deps.runtime.db.query<{ card_instance_id: string; props: P; status: string; evidence: P | null }>(`SELECT card_instance_id, props, status, evidence FROM card_instances WHERE subject_application_id = $1 AND props->>'flow_key' LIKE 'valuation.low:%' ORDER BY created_at DESC, card_instance_id`, [ctx.appId]);
  const soughtNow = (ctx.store.get("applications", ctx.appId)?.data as { loan_amount_sought_cents?: unknown } | undefined)?.loan_amount_sought_cents;
  const sought = soughtNow === undefined || soughtNow === null ? null : String(soughtNow);
  const lever = levers.find((c) => c.evidence?.["option_id"] === "cash") ?? levers.find((c) => sought !== null && String(c.props["new_loan_amount_cents"] ?? "") === sought && String(p["source"] ?? "") === "borrower_stated");
  if (!lever) return;
  const casefile = ctx.store.list("du_casefiles", (d) => d.application_id === ctx.appId).at(-1); if (!casefile) return;
  const baseline = ctx.store.list("du_submissions", (d) => d.casefile_id === casefile.data["casefile_id"] && d.status === "findings_received").at(-1); if (!baseline) return;
  if (has(ctx, "du.resubmission.required", (x) => x["trigger_event"] === `${e.type}:${e.id}`)) return;
  const snapshot = baseline.data["snapshot"] as P; const newLoan = String(p["value"] ?? lever.props["new_loan_amount_cents"] ?? snapshot["loan_amount_cents"]);
  const credit = ctx.store.list("credit_reports", (d) => d.application_id === ctx.appId).at(-1)?.data; const creditExpires = String(credit?.["expires_at"] ?? credit?.["expires_on"] ?? addDays(D(String(credit?.["report_date"] ?? e.occurredAt.slice(0, 10)).slice(0, 10)), 120));
  const projected = String(ctx.store.list("purchase_contracts", (d) => d.application_id === ctx.appId).at(-1)?.data["closing_date"] ?? snapshot["projected_note_date"] ?? addDays(D(e.occurredAt.slice(0, 10)), 30));
  try {
    await deps.runtime.execute({ process: "23.1", name: "evaluateResubmission", loanId: "", applicationId: ctx.appId, actor: UNDERWRITER, run: { ...RUN },
      input: { casefile_id: casefile.data["casefile_id"], baseline: baseline.data, candidate: { ...snapshot, loan_amount_cents: newLoan }, trigger_event: `${e.type}:${e.id}`, credit_expires_at: creditExpires.slice(0, 10), projected_note_date: projected.slice(0, 10), lever_card_instance_id: lever.card_instance_id } });
  } catch (err) { deps.logger?.error("borrower.flow.32-6.resubmission", { application_id: ctx.appId, error: err instanceof Error ? err.message : String(err) }); }
}

// ---------------------------------------------------------------- project review (24.3), insurance (24.5), MI (24.6)
async function onProjectDocsRequested(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const docs = Array.isArray(p["documents"]) ? (p["documents"] as unknown[]).map(String) : []; const hoa = str(p["hoa_contact"]) || "the HOA management company";
  for (const doc of docs) {
    const owner = HOA_SENDS_TO_OWNER.has(doc) ? "you" : "third_party";
    if (owner === "you") await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "hoa.docs.upload", flow_key: `hoa.docs:${doc}:${e.id}`, command_ref: "document.upload", props: { document_class: `hoa_${doc}`, accepted_examples: [], why: "", freshness_hint: "", title: "", copy_tokens: { document: doc.replace(/_/g, " ") }, owner, side_quest: "SQ-08", project_document: doc, command_args: { document_class: `hoa_${doc}` } } });
    else await sendToAll(deps, ctx, { kind: "HandoffCard", copy_key: "hoa.docs.handoff", flow_key: `hoa.docs:${doc}:${e.id}`, informational: true, props: { destination: "hoa_management", what_to_expect: "", return_state: "in_review", title: "", copy_tokens: { hoa_contact: hoa, document: doc.replace(/_/g, " ") }, owner, side_quest: "SQ-08", project_document: doc, hoa_contact: p["hoa_contact"] ?? null, channel: p["channel"] ?? null } });
  }
}
async function onDeficiencyOpened(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const kind = String(p["kind"] ?? ""); const element = DEFICIENCY_ELEMENT[kind] ?? "coverage"; const deficiencyId = String(p["deficiency_id"] ?? e.id);
  const policy = p["policy_id"] ? ctx.store.get("insurance_policies", String(p["policy_id"]))?.data : undefined;
  await sendToAll(deps, ctx, { kind: "NoticeCard", copy_key: "insurance.deficient", flow_key: `insurance.deficient:${deficiencyId}`, informational: true,
    props: { notice_code: "SM_INSURANCE_DEFICIENCY", title: "", rendered_document_id: String(p["policy_id"] ?? deficiencyId), plain_language: "", line: "", template_version: null, delivered_at: e.occurredAt, channel: "app", deficiency_id: deficiencyId, deficiency_kind: kind, element, copy_token_keys: { element: `insurance.deficient.element.${element}`, fix: `insurance.deficient.fix.${element}` }, policy_id: p["policy_id"] ?? null, policy_status: policy?.["status"] ?? "deficient", condition: p["condition"] ?? "ptf" } });
  // the item stays in Needed-from-you (32.6 §5): the corrected declarations page comes back through the same upload path (24.5 extractEvidence)
  await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "insurance.upload.policy", flow_key: `insurance.upload:${deficiencyId}`, command_ref: "document.upload", props: { document_class: "hoi_declaration", accepted_examples: [], why: "", freshness_hint: "", title: "", deficiency_id: deficiencyId, element, command_args: { document_class: "hoi_declaration" } } });
}
async function onFloodNoticeDelivered(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const documentId = String(p["notice_document_id"] ?? p["notice_id"] ?? randomUUID()); const channel = String(p["channel"] ?? "esign");
  const det = ctx.store.list("flood_determinations", (d) => d.application_id === ctx.appId).at(-1)?.data;
  await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "flood.notice", flow_key: `flood.notice:${documentId}`, ...(channel === "mail" ? { informational: true } : { command_ref: "disclosure.acknowledgeReceipt" }),
    props: { document_id: documentId, notice_code: FLOOD_NOTICE_CODE, title: "", why_you_see_this: "", requires_ack: channel !== "mail", esign_scope_required: "flood_notice", channel: channel === "mail" ? "mail" : "esign_portal", delivered_at: String(p["delivered_at"] ?? e.occurredAt), ...(channel === "mail" ? { mailed_at: String(p["delivered_at"] ?? e.occurredAt) } : {}),
      effective_receipt_date: p["effective_receipt_date"] ?? null, days_before_consummation: p["days_before_consummation"] ?? null, scheduled_consummation_date: p["scheduled_consummation_date"] ?? null, timer_code: "FDPA_4104A_FLOOD_NOTICE_GATE", flood_zone: det?.["zone"] ?? null, in_sfha: det?.["in_sfha"] ?? true, command_args: { disclosure_id: documentId, kind: "flood_notice" } } });
}
interface MiQuoteRow { quote_id: string; mi_company_code: string; plan: string; coverage_pct: number; coverage_option: string; rate_bps: number; monthly_premium_cents: unknown; upfront_premium_cents: unknown; expires_at?: string; selected?: boolean }
/** 32.6 §6: one column per borrower-facing plan (the cheapest quote of each), rows monthly cost · upfront cost · rate · when it can be cancelled (HPA, one line each — a copy key per plan). */
export function miPlanColumns(quotes: readonly MiQuoteRow[]): { columns: P[]; by_option: Record<string, P> } {
  const best = new Map<string, MiQuoteRow>();
  for (const q of quotes) { const ux = MI_PLAN_UX[q.plan]; if (!ux || q.coverage_option === "minimum") continue; const prior = best.get(ux); const cost = (x: MiQuoteRow) => BigInt(String(x.monthly_premium_cents ?? 0)) * 12n * 10n + BigInt(String(x.upfront_premium_cents ?? 0)); if (!prior || cost(q) < cost(prior)) best.set(ux, q); }
  const columns: P[] = []; const by_option: Record<string, P> = {};
  for (const ux of MI_PLAN_ORDER) { const q = best.get(ux); if (!q) continue;
    columns.push({ id: ux, title_key: `mi.plan.${ux}`, title: "", plan: q.plan, quote_id: q.quote_id, insurer_code: q.mi_company_code, rows: [{ label: "Monthly cost", value: `${money(String(q.monthly_premium_cents ?? 0))}/mo` }, { label: "Upfront cost", value: money(String(q.upfront_premium_cents ?? 0)) }, { label: "Rate", value: `${(q.rate_bps / 100).toFixed(2)}% of the loan amount`, emphasis: true }, { label: "When it can be cancelled", value: "", value_key: `mi.cancel.${ux}` }], cancellation_copy_key: `mi.cancel.${ux}` });
    by_option[ux] = { plan: ux, quote_id: q.quote_id };
  }
  return { columns, by_option };
}
async function onMiQuotes(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const ids = Array.isArray(p["quote_ids"]) ? (p["quote_ids"] as unknown[]).map(String) : [];
  const quotes = ids.map((id) => ctx.store.get("mi_quotes", id)?.data as unknown as MiQuoteRow | undefined).filter((q): q is MiQuoteRow => !!q);
  if (!quotes.length) return;
  const { columns, by_option } = miPlanColumns(quotes); if (!columns.length) return;
  const lock = ctx.store.list("locks", (d) => d.application_id === ctx.appId).at(-1)?.data; const quote = lock ? ctx.store.get("pricing_quotes", String(lock["quote_id"]))?.data : ctx.store.list("pricing_quotes").at(-1)?.data;
  const appraisal = ctx.store.list("appraisals", (d) => d.application_id === ctx.appId && d.is_final_version === true).at(-1)?.data;
  const intake = ctx.store.get("applications", ctx.appId)?.data as { property_value_estimate_cents?: unknown; six_items?: Record<string, { value?: unknown }> } | undefined;
  const value = appraisal?.["value_used_cents"] ?? appraisal?.["appraised_value_cents"] ?? ctx.app?.["estimated_value_cents"] ?? intake?.property_value_estimate_cents ?? intake?.six_items?.["property_value_estimate"]?.value ?? null;
  // the election's facts for 24.6 recordPlanElection: the quote's own loan amount, the platform's value basis, the application's transaction and the locked product — never a figure the UI invents
  const election: P = { units: Number(ctx.app?.["units"] ?? 1), occupancy: String(ctx.app?.["occupancy"] ?? "primary"), transaction_type: String(ctx.app?.["transaction_type"] ?? "purchase"), loan_amount_cents: String(quotes[0]!["loan_amount_cents" as keyof MiQuoteRow] ?? p["loan_amount_cents"] ?? ""), ...(value !== null && value !== undefined ? { appraised_value_cents: String(value) } : {}), product: /arm/i.test(String(quote?.["product_code"] ?? lock?.["product_code"] ?? "")) ? "arm" : "fixed", term_months: Number(quote?.["term_months"] ?? lock?.["term_months"] ?? 360), certificate_status: "quoted" };
  const flowKey = `mi.compare:${e.id}`;
  await transitionAll(deps, ctx, "mi.compare:", "superseded", { superseded_by: flowKey });
  await sendToAll(deps, ctx, { kind: "ComparisonCard", copy_key: "mi.compare.title", flow_key: flowKey, command_ref: "mi.selectPlan",
    props: { title: "", columns, recommended_id: null, command: "mi.selectPlan", command_args_by_option: Object.fromEntries(Object.entries(by_option).map(([k, v]) => [k, { ...v, ...election }])), footnote: "", plans: columns.length, insurers: p["insurers"] ?? [], quote_ids: ids, ltv_note: "the plans are shown because the loan-to-value is above 80% (24.6)", affirmatives: ["lender paid", "lpmi", "monthly mi"] } });
}

// ---------------------------------------------------------------- clear to close (23.3), the closing appointment (25.2 → 26.2), the pre-funding hold (28.1)
const earliestConsummation = (ctx: Ctx): string | null => { const e = last(ctx, "disclosure.cd.waiver.accepted") ?? last(ctx, "disclosure.cd.waiting_period.computed"); const d = e?.payload["earliest_consummation_date"]; return typeof d === "string" && d ? d : null; };
const floodNoticePending = (ctx: Ctx): boolean => has(ctx, "flood.determination.received", (x) => x["in_sfha"] === true || x["sfha"] === true || x["notice_required"] === true) && !has(ctx, "flood.notice.delivered");
/** The closing ScheduleCard waits for the CD's `earliest_consummation_date` (32.7 §2), a clear-to-close decision, and the flood notice on an SFHA loan (32.6 §5); it is withdrawn once a closing is scheduled on any channel. */
async function maybeClosingSchedule(deps: FlowDeps, ctx: Ctx): Promise<void> {
  if (!has(ctx, "clear_to_close.issued") || has(ctx, "closing.scheduled") || has(ctx, "closing.consummated")) return;
  const earliest = earliestConsummation(ctx); if (!earliest) return;
  if (floodNoticePending(ctx)) return;
  const flowKey = `closing.schedule:${earliest}`;
  await transitionAll(deps, ctx, "closing.schedule:", "superseded", { superseded_by: flowKey });
  const tz = tzOf(ctx); const slots = appointmentSlots(D(earliest), tz, "RON platform (FAKE)");
  const state = String(ctx.app?.["state"] ?? ""); const transaction_type = String(ctx.app?.["transaction_type"] ?? "");
  await sendToAll(deps, ctx, { kind: "ScheduleCard", copy_key: "closing.schedule", flow_key: flowKey, command_ref: "closing.selectSlot",
    props: { purpose: "ron_session", slots, constraints_text: "", title: "", helper: "", earliest_consummation_date: earliest, timer_code: "REGZ_1026_19F1_CD_3SBD_GATE", vendor: "RON platform (FAKE)", command: "closing.selectSlot", command_args_by_option: Object.fromEntries(slots.map((s) => [String(s["id"]), { slot: s["starts_at"], state, transaction_type, time_zone: tz, closing_type_preference: "ron" }])), copy_tokens: { closing_type_sentence: "You'll sign online with a notary on video." } } });
}

// ---------------------------------------------------------------- the reactions, per application, in commit order
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "decision.issued": await onDecisionIssued(deps, ctx, e); return;
    case "notice.sent": await onDecisionNoticeSent(deps, ctx, e); return;
    case "counteroffer.accepted": case "counteroffer.declined": case "counteroffer.expired": await transitionAll(deps, ctx, "counteroffer.choice:", e.type === "counteroffer.expired" ? "cancelled" : "resolved", { outcome: e.type, decision_id: p["decision_id"] ?? null }); return;
    case "application.withdrawn": case "application.closed_incomplete": await cancelEveryPendingCard(deps, ctx, e.type); return;
    case "valuation.method.selected": if (p["method"] === "value_acceptance") await sendToAll(deps, ctx, StatusCard("valuation.value_acceptance", `valuation.value_acceptance:${String(p["du_submission_id"] ?? e.id)}`, { method: "value_acceptance", du_submission_id: p["du_submission_id"] ?? null })); return;
    case "valuation.assigned": await onValuationAssigned(deps, ctx, e); return;
    case "valuation.inspection.scheduled": await transitionAll(deps, ctx, "valuation.schedule:", "resolved", { scheduled_for: p["scheduled_for"] ?? null, manner: "receipt_evidence" }); return;
    case "valuation.copy.delivered": await onCopyDelivered(deps, ctx, e); return;
    case "valuation.value_used.set": await onValueUsedSet(deps, ctx, e); return;
    case "application.six_item.captured": await onSixItemCaptured(deps, ctx, e); return;
    case "project.docs.requested": await onProjectDocsRequested(deps, ctx, e); return;
    case "insurance.deficiency.opened": await onDeficiencyOpened(deps, ctx, e); return;
    case "insurance.deficiency.cleared": await transitionAll(deps, ctx, `insurance.upload:${String(p["deficiency_id"] ?? "")}`, "resolved", { resolution: p["resolution"] ?? "cured", manner: "receipt_evidence" }); return;
    case "flood.determination.received": return;   // Property "Not in a flood zone" / the notice path is the record's and 24.5's; nothing to commit
    case "flood.notice.delivered": await onFloodNoticeDelivered(deps, ctx, e); await maybeClosingSchedule(deps, ctx); return;
    case "mi.quote.received": await onMiQuotes(deps, ctx, e); return;
    case "mi.plan.selected": await transitionAll(deps, ctx, "mi.compare:", "resolved", { plan: p["premium_plan"] ?? p["plan"] ?? null, certificate_id: p["certificate_id"] ?? null, manner: "receipt_evidence" }); return;
    case "clear_to_close.issued": await sendToAll(deps, ctx, StatusCard("ctc.reached", `ctc.reached:${String(p["decision_id"] ?? e.id)}`, { decision_id: p["decision_id"] ?? null, checklist_id: p["checklist_id"] ?? null })); await maybeClosingSchedule(deps, ctx); return;
    case "disclosure.cd.waiting_period.computed": case "disclosure.cd.waiver.accepted": await maybeClosingSchedule(deps, ctx); return;
    case "closing.scheduled": await transitionAll(deps, ctx, "closing.schedule:", "resolved", { closing_id: p["closing_id"] ?? null, scheduled_at: p["scheduled_at"] ?? null, manner: "receipt_evidence" }); return;
    case "qc.hold.applied": if (p["kind"] === "prefunding") await sendToAll(deps, ctx, StatusCard("ctc.final_review", `ctc.final_review:${String(p["hold_id"] ?? p["review_id"] ?? e.id)}`, { gate: "FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE", hold_id: p["hold_id"] ?? null })); return;
    default: return;
  }
}

export const FLOW_6_DECISION_PROPERTY: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byApp = new Map<string, DomainEvent[]>();
    for (const e of events) { const app = e.applicationId ?? (typeof (e.payload as P)["application_id"] === "string" ? String((e.payload as P)["application_id"]) : null); if (!app) continue; const list = byApp.get(app) ?? []; list.push(e); byApp.set(app, list); }
    for (const [appId, list] of byApp) {
      const ctx = await context(deps, appId);
      if (!ctx.parties.length) continue;   // no borrower party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-6.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
};
