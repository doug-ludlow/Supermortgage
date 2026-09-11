/**
 * 32.5 — Verification, needs list, conditions, second borrower (spec/sections/32-borrower-experience/32-5-*.md): the
 * borrower-facing form of 22.1 (documents and the needs-list loop), 22.2 (the pre-closing credit refresh and undisclosed
 * debt), 22.4 (assets), 23.2–23.3 (the conditions lifecycle) and 21.1 (co-borrowers, joint intent). Every card here is
 * created through 32.1's `send_card` as the `intake` agent on the owning process's event; where a step belongs to the
 * owning process (a 22.1 request, 23.3's `waiting_borrower` step, 21.1's borrower row) the flow asks that process's own
 * tool as its own agent and renders the result — nothing here computes a regulatory date, a freshness verdict or a
 * money figure (the reason text on a re-opened request is 22.1's; the due date is `timers`/`document_requests.due_at`).
 *
 *   condition.opened{borrower_visible}             the borrower's items: 22.1 `openRequest` per document class (only once the LE is out — TRID FAQ)
 *                                                  and 23.3's `waiting_borrower` step; third-party items: `waiting_third_party`; the pinned ChecklistCard (T1)
 *   document_request.opened                        the UploadCard / ExplanationCard for the request (`upload.title` / `explain.title`, verb first); when 22.1's
 *                                                  review re-opened it (`reopened=true`) the card re-opens with `upload.mismatch` (detected class) or
 *                                                  `upload.stale` (paystub floor / four-month rule) — the reason is 22.1's own (T2, T3); a `sm_freshness`
 *                                                  replacement request carries `upload.rerequest.closing_moved` with the moved note date (T4)
 *   document_request.satisfied|waived|expired      the ask's cards resolve/cancel with a one-line receipt (`needs.item.received`); the checklist refreshes
 *   condition.cleared|waived|superseded|waiting    the checklist refreshes (23.3 owns the status)
 *   credit.udm.alert.received{new_tradeline}       ConfirmCard `new_debt.confirm` {creditor, date} — nothing about the decision — whose yes runs
 *                                                  application.confirmField{credit.alert.<id>} → 22.2 verified_new_debt → 23.1 tolerances (T5)
 *   du.resubmission.required|waived                StatusCard `new_debt.rechecking`
 *   asset.deposit.flagged_large                    ExplanationCard `explain.title`/`explain.deposit` for that deposit only → explanation.submit (T6)
 *   application.party.invited{co_borrower}         21.1 captureField{field=borrower} (arms SM_O21_JOINT_INTENT_GATE), the invitee's deep link, then
 *                                                  ConsentCard{joint_intent} FIRST — before any credit card (T7)
 *   application.party.invited{non_borrowing_spouse} 21.1 captureField{field=non_borrowing_spouse}: no Profile / Demographics / income / liability card, ever (T8)
 *   application.joint_intent.affirmed              the invitee's R2–R6: ConnectCard{truv_income}, ConfirmCard{liabilities}, ProfileCard, declarations, DemographicsCard
 *   human.transfer.requested                       PersonCard{human_agent}; a human sends cards and never resolves one for the borrower (T10)
 *   tick                                           22.1's nightly freshness sweep (`computeFreshness{op=sweep}`) against the scheduled note date for every
 *                                                  application with a closing on the calendar — `document.expiring` / `document.expired` and the replacement request (T4)
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { EntityStore } from "../../../app/tools.ts";
import { DOCUMENT_CLASSES } from "../../../domain/verification/ops-22-1.ts";
import { conditionIsBorrowers, conditionOwner, OWNER_COPY_KEYS, timerLabel } from "../record.ts";
import type { BorrowerFlow, FlowDeps } from "./index.ts";

export const FLOW_ID = "32.5";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const VERIFICATION: Actor = { kind: "agent", id: "verification" };
const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" };
const RUN = { runId: "flow:32.5", modelVersion: "borrower flows (deterministic)", promptVersion: "32.5" } as const;
const REACTS = new Set(["condition.opened", "condition.cleared", "condition.waived", "condition.superseded", "condition.reopened", "condition.waiting", "document_request.opened", "document_request.satisfied", "document_request.waived", "document_request.expired",
  "credit.udm.alert.received", "du.resubmission.required", "du.resubmission.waived", "asset.deposit.flagged_large", "application.party.invited", "application.joint_intent.affirmed", "human.transfer.requested"]);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (cents: string | bigint | number): string => USD.format(Number(BigInt(String(cents))) / 100);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (ymd: string): string => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : ymd; };

// ---------------------------------------------------------------- what the owning processes' evidence kinds mean for the borrower (23.2 `evidence_kinds` → 22.1 document classes)
/** A borrower-supplied document the condition asks for, as the 22.1 class the borrower uploads. */
const BORROWER_UPLOADS: Readonly<Record<string, string>> = { paystub: "paystub", w2: "w2", form_1099: "form_1099", bank_statement: "bank_statement", brokerage_statement: "brokerage_statement", retirement_statement: "retirement_statement", mortgage_statement: "mortgage_statement", heloc_statement: "heloc_statement", student_loan_statement: "student_loan_statement",
  hoi_declaration: "homeowners_policy", homeowners_policy: "homeowners_policy", government_id: "drivers_license", drivers_license: "drivers_license", passport: "passport", state_id: "state_id", form_4506_c: "form_4506c", form_4506c: "form_4506c", account_statement: "bank_statement", gift_letter: "gift_letter", gift_transfer_evidence: "gift_transfer_evidence", emd_evidence: "emd_evidence", purchase_contract: "purchase_contract", form_1040: "form_1040", occupancy_letter: "occupancy_letter" };
/** A letter the borrower writes (SQ-02): an ExplanationCard, rendered by explanation.submit to 22.1's letters classes. */
const LETTER_KINDS: ReadonlySet<string> = new Set(["letter_of_explanation", "explanation_letter", "inquiry_explanation"]);
const LETTER_CLASSES: ReadonlySet<string> = new Set(["explanation_letter", "inquiry_explanation", "occupancy_letter"]);
const KNOWN_CLASSES: ReadonlySet<string> = new Set(DOCUMENT_CLASSES.map((c) => c.code));
/** The document class in the borrower's words (the `{{document}}` token of `upload.title`; the class code itself is the owning process's). */
const DOC_WORDS: Readonly<Record<string, string>> = { paystub: "most recent pay stub", w2: "W-2", form_1099: "1099", bank_statement: "bank statement", brokerage_statement: "brokerage statement", retirement_statement: "retirement account statement", mortgage_statement: "mortgage statement", heloc_statement: "HELOC statement", student_loan_statement: "student loan statement", homeowners_policy: "homeowners insurance declarations page", drivers_license: "photo ID", passport: "passport", state_id: "state ID", form_4506c: "signed Form 4506-C", gift_letter: "gift letter", gift_transfer_evidence: "proof of the gift transfer", emd_evidence: "earnest money receipt", purchase_contract: "signed purchase contract", form_1040: "federal tax return", explanation_letter: "letter of explanation", inquiry_explanation: "inquiry explanation", occupancy_letter: "occupancy letter", asset_sale_evidence: "bill of sale and proof of the deposit" };
const words = (doc_class: string): string => DOC_WORDS[doc_class] ?? doc_class.replace(/_/g, " ");
const EXAMPLES: Readonly<Record<string, string[]>> = { paystub: ["a pay stub from your employer", "a payroll portal PDF"], w2: ["your W-2 from your employer"], bank_statement: ["all pages of the statement, even blank ones"], brokerage_statement: ["the full quarterly or monthly statement"], retirement_statement: ["the full quarterly statement"], mortgage_statement: ["your latest mortgage statement"], homeowners_policy: ["the declarations page from your insurer"], drivers_license: ["driver's license", "passport", "state ID"], form_4506c: ["the form we sent you, signed"], gift_letter: ["the signed gift letter"], asset_sale_evidence: ["bill of sale", "deposit slip"] };
/** 22.1's freshness rule for the class, in the borrower's words (a hint, never a computed date): the paystub floor (30 days at application) and the four-month rule at the note date. */
const FRESHNESS_HINT: Readonly<Record<string, string>> = { paystub: "dated within the last 30 days", bank_statement: "your most recent statement", brokerage_statement: "your most recent statement", retirement_statement: "your most recent statement", mortgage_statement: "your most recent statement" };
/** `{{n}}` of `upload.stale` / `upload.rerequest.closing_moved`: the rule's own window — 30 days for a paystub (FNMA_B3_3_2_01_PAYSTUB_30D_GATE), four months (120 days) for a credit document (FNMA_B1_1_03_CREDIT_DOCS_4M). */
const FRESH_DAYS = (doc_class: string): number => (doc_class === "paystub" ? 30 : 120);

// ---------------------------------------------------------------- the application context one batch works on
interface Party { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string; readonly borrower_role: string }
interface Ctx { readonly appId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly now: string }
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const has = (ctx: Ctx, type: string | RegExp, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => (typeof type === "string" ? e.type === type : type.test(e.type)) && where(pl(e)));
const firstName = (legal: string): string => legal.split(/\s+/)[0] ?? legal;

/** `now` for a reaction is the instant of the fact it reacts to (the batch's latest event): a card answers the event, not the clock's later reading. */
async function context(deps: FlowDeps, appId: string, now: string = deps.runtime.clock.now()): Promise<Ctx> {
  const [events, records, parties] = await Promise.all([
    deps.runtime.uow.events.byApplication(appId),
    deps.runtime.entities.load({ applicationId: appId }),
    deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT party_id, id AS application_borrower_id, legal_name, borrower_role FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at, id`, [appId])]);
  const store = new EntityStore(); store.seed(records);
  return { appId, events, store, parties, now };
}
const batchNow = (deps: FlowDeps, list: readonly DomainEvent[]): string => list.map((e) => e.occurredAt).filter((t) => typeof t === "string" && !Number.isNaN(Date.parse(t))).sort().at(-1) ?? deps.runtime.clock.now();
interface IntakeBorrower { id: string; legal_name: string; borrower_role?: string; credit_requested?: boolean }
const intakeBorrowers = (ctx: Ctx): IntakeBorrower[] => ((ctx.store.get("applications", ctx.appId)?.data as { borrowers?: IntakeBorrower[] } | undefined)?.borrowers ?? []);
/** 23.2's per-borrower rows name the interview's own borrower id ("B1"); the intake application maps it to the application_borrowers row by legal name. */
function partiesFor(ctx: Ctx, borrowerId: unknown): readonly Party[] {
  if (typeof borrowerId !== "string" || !borrowerId) return ctx.parties;
  const b = intakeBorrowers(ctx).find((x) => x.id === borrowerId);
  const own = ctx.parties.filter((p) => p.application_borrower_id === borrowerId || (b && p.legal_name === b.legal_name));
  return own.length ? own : ctx.parties;
}
/** The interview's own id of a party (the id 21.1/22.1/23.2 use), by legal name. */
const intakeIdOf = (ctx: Ctx, party: Party): string | null => intakeBorrowers(ctx).find((b) => b.legal_name === party.legal_name)?.id ?? null;
/** Parties the flow treats as credit applicants (a non-borrowing spouse never gets a credit question — 21.1 rule 4). */
const isCreditParty = (ctx: Ctx, party: Party): boolean => party.borrower_role !== "non_borrowing_spouse" && (intakeBorrowers(ctx).find((b) => b.legal_name === party.legal_name)?.credit_requested !== false);

// ---------------------------------------------------------------- card and thread primitives (32.1's tools as the intake agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string; readonly flow_key: string; readonly informational?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, ctx: Ctx, party: Party, c: CardSpec): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, at: ctx.now, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { application_id: ctx.appId }, created_by: "agent:intake", rationale: `32.5 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", ctx.now, { informational: true, resolved_by: "system:flow-32.5" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) ids.push(await sendCard(deps, ctx, p, c)); return ids; }
/** Move every pending card on a flow-key prefix (a newer card for the same ask, an ask withdrawn, an item the owning process satisfied). */
async function transitionAll(deps: FlowDeps, ctx: Ctx, flowKeyPrefix: string, to: "resolved" | "superseded" | "cancelled", evidence: P, partyId?: string): Promise<string[]> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE $2 AND ($3::uuid IS NULL OR party_id = $3)`, [ctx.appId, `${flowKeyPrefix}%`, partyId ?? null]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, to, "system", ctx.now, { ...evidence, resolved_by: "system:flow-32.5" });
  return rows.map((r) => r.card_instance_id);
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true });
/** 02 §1.3: an item never leaves the list silently — the collapsed receipt line in the Thread. */
async function receiptLine(deps: FlowDeps, ctx: Ctx, cardId: string, copy_key: string): Promise<void> {
  const card = await deps.ui.card(cardId); if (!card) return;
  await deps.ui.appendMessage({ conversation_id: card.conversation_id, at: ctx.now, sender: "system", sender_ref: "system:flow-32.5", channel: "app", body_text: `{{copy:${copy_key}}}`, card_instance_id: cardId, subject_application_id: ctx.appId });
}

// ---------------------------------------------------------------- the owning processes' own steps, asked as their own agents
async function owning(deps: FlowDeps, ctx: Ctx, process: string, name: string, actor: Actor, input: P): Promise<P> {
  const r = await deps.runtime.execute({ process, name, loanId: "", applicationId: ctx.appId, actor, run: { ...RUN }, input: { application_id: ctx.appId, ...input } });
  return (r.output ?? {}) as P;
}
type Cond = { condition_id: string; application_id: string; borrower_id: string | null; status: string; stage: string; text: string; template_code: string; du_message_id: string | null; evidence_kinds: string[]; borrower_visible: boolean; due_at: string | null; opened_at: string; category: string };
const condOf = (ctx: Ctx, id: string): Cond | undefined => ctx.store.get("conditions", id)?.data as unknown as Cond | undefined;
type Req = { request_id: string; application_id: string; condition_id: string | null; borrower_id: string; doc_class: string; qualifier: P; reason_code: string; reason_text: string; status: string; due_at: string | null; requested_at: string };
const reqOf = (ctx: Ctx, id: string): Req | undefined => ctx.store.get("document_requests", id)?.data as unknown as Req | undefined;
/** What the condition asks the borrower for: the 22.1 classes to upload and whether a letter is wanted; nothing when it is ours or a third party's. */
function askOf(cond: Cond): { uploads: string[]; letter: boolean } {
  const uploads = [...new Set(cond.evidence_kinds.map((k) => BORROWER_UPLOADS[k]).filter((c): c is string => !!c && KNOWN_CLASSES.has(c)))];
  return { uploads, letter: cond.evidence_kinds.some((k) => LETTER_KINDS.has(k)) };
}

// ---------------------------------------------------------------- 32.5 §1 — one list, one owner per item (the pinned ChecklistCard)
const LIVE = new Set(["open", "waiting_borrower", "waiting_third_party", "satisfied_pending_review", "reopened"]);
async function refreshChecklist(deps: FlowDeps, ctx: Ctx, parties: readonly Party[] = ctx.parties): Promise<void> {
  const conds = ctx.store.list("conditions", (d) => d.application_id === ctx.appId).map((r) => r.data as unknown as Cond).filter((c) => c.borrower_visible && LIVE.has(c.status) && c.stage !== "post_closing");
  const ctc = has(ctx, "clear_to_close.issued"); const funded = has(ctx, /^(loan\.funded|loan\.boarded)$/);
  for (const party of parties) {
    if (!isCreditParty(ctx, party)) continue;
    const mine = intakeIdOf(ctx, party);
    const cards = await deps.runtime.db.query<{ card_instance_id: string; kind: string; props: P }>(`SELECT card_instance_id, kind, props FROM card_instances WHERE party_id = $1 AND subject_application_id = $2 AND status = 'pending' AND kind IN ('UploadCard', 'ExplanationCard') ORDER BY created_at`, [party.party_id, ctx.appId]);
    const items = conds.filter((c) => !funded && !(ctc && c.stage === "ptd") && (!c.borrower_id || !mine || c.borrower_id === mine)).map((c) => {
      const d = c as unknown as Record<string, unknown>; const yours = conditionIsBorrowers(d);
      const owner = yours ? "you" : conditionOwner(c.evidence_kinds) === "us" ? "us" : "third_party";
      const card = cards.filter((x) => x.props["condition_id"] === c.condition_id).sort((a, b) => Number(a.props["ask_index"] ?? 0) - Number(b.props["ask_index"] ?? 0))[0];   // the condition's first ask (created_at ties under one reaction)
      const label = (typeof card?.props["action_label"] === "string" ? String(card.props["action_label"]) : "") || c.text || c.template_code;
      return { condition_id: c.condition_id, label, owner, status: c.status, ...(c.due_at ? { due_at: c.due_at } : {}), ...(yours && card ? { action: { kind: card.kind === "ExplanationCard" ? "explain" : "upload", card_kind: card.kind, card_instance_id: card.card_instance_id } } : {}), owner_copy_key: yours ? "needs.owner.you" : OWNER_COPY_KEYS[conditionOwner(c.evidence_kinds)] };
    });
    // a newer checklist supersedes the party's previous one — one pinned ChecklistCard (32.5 §1)
    const stamp = `${items.map((i) => `${i.condition_id}:${i.status}:${i.action?.card_instance_id ?? "-"}`).join("|")}`;
    const prior = (await deps.runtime.db.query<{ card_instance_id: string; props: P }>(`SELECT card_instance_id, props FROM card_instances WHERE party_id = $1 AND subject_application_id = $2 AND status = 'pending' AND kind = 'ChecklistCard' AND props->>'flow' = $3 ORDER BY created_at DESC LIMIT 1`, [party.party_id, ctx.appId, FLOW_ID]))[0];
    if (prior && prior.props["stamp"] === stamp) continue;
    if (prior) await deps.ui.transitionCard(prior.card_instance_id, "superseded", "system", ctx.now, { superseded_by: "a newer checklist", resolved_by: "system:flow-32.5" });
    if (!items.length && !prior) continue;   // nothing to list and nothing to withdraw: no card (the Record shows the nothing-needed state — T11)
    await sendCard(deps, ctx, party, { kind: "ChecklistCard", copy_key: "needs.title", flow_key: `checklist:${ctx.appId}:${randomUUID()}`, props: { title: "", items, stamp, count_you: items.filter((i) => i.owner === "you").length, notice_code: "NTC_SM_NEEDS_LIST" } });
  }
}

// ---------------------------------------------------------------- 32.5 §1–§2 — conditions and the needs-list loop
/** Applications whose pinned ChecklistCard needs a refresh after this batch (one refresh per commit, not one per condition). */
const dirty = new Set<string>();
async function onConditionOpened(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const cond = condOf(ctx, String(pl(e)["condition_id"])); if (!cond || !cond.borrower_visible || cond.stage === "post_closing") return;
  const ask = askOf(cond);
  if (ask.uploads.length || ask.letter) {
    // 22.1's needs list: one request per document class the condition names, linked to the condition (never free-typed) — only once the LE is delivered (TRID FAQ; 22.1 R6)
    if (has(ctx, /^disclosure\.le\.(delivered|mailed)$/)) {
      const borrower_id = cond.borrower_id ?? intakeBorrowers(ctx).find((b) => b.credit_requested !== false)?.id ?? null;
      if (borrower_id) for (const doc_class of [...ask.uploads, ...(ask.letter ? ["explanation_letter"] : [])]) {
        // an explicit request id: 22.1's own `req-n` counter is per application while entity_records' key is global (the 32.4 test notes the same seam for 24.1/24.5)
        try { await owning(deps, ctx, "22.1", "openRequest", VERIFICATION, { request_id: `req-${ctx.appId.slice(0, 8)}-${doc_class}-${randomUUID().slice(0, 8)}`, borrower_id, doc_class, reason_code: cond.du_message_id ?? cond.template_code, reason_text: cond.text, condition_id: cond.condition_id, qualifier: {}, at: ctx.now }); }
        catch (err) { deps.logger?.error("borrower.flow.32-5.openRequest", { condition_id: cond.condition_id, doc_class, error: err instanceof Error ? err.message : String(err) }); }
      }
    }
    // 23.3's lifecycle step: the needs-list item is sent → `waiting_borrower` (the owning process transitions; the UI renders)
    if (cond.status === "open" || cond.status === "reopened") await owning(deps, ctx, "23.3", "reopenCondition", UNDERWRITER, { op: "waiting", condition_id: cond.condition_id, on: "borrower", reason: "needs-list item sent to the borrower (32.5)", at: ctx.now });
  } else if (conditionOwner(cond.evidence_kinds) !== "us" && (cond.status === "open" || cond.status === "reopened")) {
    await owning(deps, ctx, "23.3", "reopenCondition", UNDERWRITER, { op: "waiting", condition_id: cond.condition_id, on: "third_party", reason: `vendor order — ${conditionOwner(cond.evidence_kinds)} (32.5)`, at: ctx.now });
  }
  dirty.add(ctx.appId);
}
/** The reason 22.1's review wrote on a re-opened request → the card's mismatch / freshness copy (never our own verdict). */
function reopenReason(reasonText: string, rejected: { doc_class?: string; document_date?: string | null } | undefined, expected: string): { mismatch?: { detected: string; expected: string }; stale?: { date: string; n: number } } {
  const reason = reasonText.split("does not meet the standard:").at(-1) ?? reasonText;   // 22.1 appends each review's verdict to the request's reason text — only the latest one is this card's
  const m = /document class (\S+) does not satisfy a (\S+) request/.exec(reason);
  if (m) return { mismatch: { detected: words(m[1]!), expected: words(m[2]!) } };
  const floor = /(\d{4}-\d{2}-\d{2}) is before the floor (\d{4}-\d{2}-\d{2})/.exec(reason);
  if (floor) return { stale: { date: shortDate(floor[1]!), n: FRESH_DAYS("paystub") } };
  if (/freshness expired/.test(reason)) return { stale: { date: shortDate(String(rejected?.document_date ?? "")), n: FRESH_DAYS(expected) } };
  return {};
}
async function onRequestOpened(deps: FlowDeps, ctx0: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const requestId = String(p["request_id"]); const req = reqOf(ctx0, requestId);
  // the card is dated to the request it answers (22.1's `requested_at`, the condition's instant — inside SM_DU_CONDITIONS_SLA_4H); a re-open is dated to the review that caused it
  const requestedAt = typeof p["requested_at"] === "string" && !Number.isNaN(Date.parse(p["requested_at"])) ? String(p["requested_at"]) : ctx0.now;
  const ctx: Ctx = p["reopened"] === true ? ctx0 : { ...ctx0, now: requestedAt < ctx0.now ? requestedAt : ctx0.now };
  const doc_class = String(p["doc_class"] ?? req?.doc_class ?? ""); if (!doc_class) return;
  const borrower_id = String(p["borrower_id"] ?? req?.borrower_id ?? ""); const parties = partiesFor(ctx, borrower_id).filter((x) => isCreditParty(ctx, x));
  const condition_id = (p["condition_id"] as string | null) ?? req?.condition_id ?? null;
  const reopened = p["reopened"] === true; const freshness = String(p["reason_code"] ?? req?.reason_code ?? "") === "sm_freshness";
  const version = reopened ? (await deps.runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instances WHERE subject_application_id = $1 AND props->>'request_id' = $2`, [ctx.appId, requestId]))[0]!.n : "0";
  if (reopened) await transitionAll(deps, ctx, `req.card:${requestId}:`, "superseded", { reason: "22.1 re-opened the request", rejected_document_id: p["rejected_document_id"] ?? null });
  const rejected = typeof p["rejected_document_id"] === "string" ? (ctx.store.get("documents", p["rejected_document_id"])?.data as { doc_class?: string; document_date?: string | null } | undefined) : undefined;
  const verdict = reopened ? reopenReason(String(p["reason_text"] ?? ""), rejected, doc_class) : {};
  const noteDate = freshness ? (ctx.events.filter((x) => x.type === "closing.scheduled" || x.type === "closing.rescheduled").at(-1)?.payload as P | undefined) : undefined;
  const movedTo = noteDate ? String(noteDate["scheduled_note_date"] ?? noteDate["note_date"] ?? String(noteDate["scheduled_at"] ?? "").slice(0, 10)) : "";
  const flow_key = `req.card:${requestId}:v${Number(version) + 1}`;
  const w = words(doc_class);
  // the condition's asks in the order 22.1 opened them (uploads, then the letter): the Record links the condition's first ask (32.5 §1)
  const cond = condition_id ? condOf(ctx, condition_id) : undefined; const asks = cond ? (() => { const a = askOf(cond); return [...a.uploads, ...(a.letter ? ["explanation_letter"] : [])]; })() : [];
  const ask_index = Math.max(0, asks.indexOf(doc_class));
  const common: P = { request_id: requestId, condition_id, document_class: doc_class, ask_index, due_at: (p["due_at"] as string | undefined) ?? req?.due_at ?? null, timer_code: "SM_NEEDS_LIST_BORROWER_RESPONSE_5", timer_label: timerLabel("SM_NEEDS_LIST_BORROWER_RESPONSE_5"), reason_text: String(p["reason_text"] ?? req?.reason_text ?? "") };
  if (LETTER_CLASSES.has(doc_class)) {
    const subject = condition_id ? condOf(ctx, condition_id)?.text ?? w : w;
    await sendToAll(deps, ctx, { kind: "ExplanationCard", copy_key: "explain.title", flow_key, command_ref: "explanation.submit", props: { ...common, subject: "", prompt: subject, min_length: 40, copy_tokens: { subject: w }, label_copy_key: "explain.title", action_label: `Explain the ${w}`, command_args: { subject_ref: condition_id ?? requestId, document_class: doc_class } } }, parties);
  } else {
    const rerequest = freshness ? { reason_copy_key: "upload.rerequest.closing_moved", copy_tokens: { document: w, date: shortDate(movedTo), n: String(FRESH_DAYS(doc_class)) } } : { copy_tokens: { document: w } };
    await sendToAll(deps, ctx, { kind: "UploadCard", copy_key: "upload.title", flow_key, command_ref: "document.upload", props: { ...common, ...rerequest, accepted_examples: EXAMPLES[doc_class] ?? [w], why: "", freshness_hint: FRESHNESS_HINT[doc_class] ?? "", title: "", label_copy_key: "upload.title", action_label: `Upload your ${w}`, ...(verdict.mismatch ? { mismatch: verdict.mismatch } : {}), ...(verdict.stale ? { stale: verdict.stale } : {}), rejected_document_id: p["rejected_document_id"] ?? null, command_args: { document_class: doc_class, request_id: requestId } } }, parties);
  }
  dirty.add(ctx.appId);
}
async function onRequestClosed(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const requestId = String(pl(e)["request_id"]);
  const ids = await transitionAll(deps, ctx, `req.card:${requestId}:`, e.type === "document_request.satisfied" ? "resolved" : "cancelled", { manner: "owning_process", event: e.type, document_id: pl(e)["document_id"] ?? null });
  if (e.type === "document_request.satisfied") for (const id of ids) await receiptLine(deps, ctx, id, "needs.item.received");
  dirty.add(ctx.appId);
}
async function onConditionMoved(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const id = String(pl(e)["condition_id"]);
  if (e.type === "condition.cleared" || e.type === "condition.waived" || e.type === "condition.superseded") {
    const reqs = ctx.store.list("document_requests", (d) => d.application_id === ctx.appId && d.condition_id === id).map((r) => r.id);
    for (const r of reqs) await transitionAll(deps, ctx, `req.card:${r}:`, e.type === "condition.cleared" ? "resolved" : "cancelled", { manner: "owning_process", event: e.type });
    await transitionAll(deps, ctx, `cond.card:${id}:`, e.type === "condition.cleared" ? "resolved" : "cancelled", { manner: "owning_process", event: e.type });
  }
  dirty.add(ctx.appId);
}

// ---------------------------------------------------------------- 32.5 §2.4 — the pre-closing credit refresh: a finding, never the decision
async function onNewTradeline(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["alert_type"] !== "new_tradeline") return;
  const alertId = String(p["alert_id"]); const alert = ctx.store.get("credit_alerts", alertId)?.data as { payload?: P; borrower_id?: string } | undefined;
  const payload = alert?.payload ?? {}; const creditor = String(payload["creditor_name"] ?? "a creditor"); const opened = String(payload["opened"] ?? payload["opened_on"] ?? e.occurredAt.slice(0, 10));
  const monthly = payload["monthly_payment_cents"] !== undefined ? String(payload["monthly_payment_cents"]) : null;
  await sendToAll(deps, ctx, { kind: "ConfirmCard", copy_key: "new_debt.confirm", flow_key: `new_debt:${alertId}`, command_ref: "application.confirmField",
    props: { commits_to: "application_liabilities", fields: [{ path: `credit.alert.${alertId}`, label: "Account", value: creditor, source: "credit_report" }, { path: `credit.alert.${alertId}.opened`, label: "Opened", value: opened, source: "credit_report" }], copy_tokens: { creditor, date: shortDate(opened) }, helper_copy_key: "new_debt.source", source: "credit_refresh", alert_id: alertId,
      options: [{ id: "yes", label: "Yes, that's mine", is_primary: true }, { id: "no", label: "No, I don't recognize it" }], command_args: { path: `credit.alert.${alertId}`, value: { is_mine: true, creditor_name: creditor, ...(monthly ? { monthly_payment_cents: monthly } : {}) }, source: "credit_refresh" },
      command_args_by_option: { yes: { value: { is_mine: true, creditor_name: creditor, ...(monthly ? { monthly_payment_cents: monthly } : {}) } }, no: { value: { is_mine: false, creditor_name: creditor } } } } }, partiesFor(ctx, alert?.borrower_id ?? p["borrower_id"]).filter((x) => isCreditParty(ctx, x)));
}
async function onResubmission(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (String(p["trigger_event"] ?? "") !== "credit.undisclosed_debt.found") return;
  await sendToAll(deps, ctx, StatusCard("new_debt.rechecking", `new_debt.recheck:${String(p["check_id"] ?? p["resubmission_id"] ?? e.id)}`, { result: e.type === "du.resubmission.required" ? "resubmission_required" : "within_tolerance", rule_codes: p["rule_codes"] ?? [], next_event_label: timerLabel("SM_DU_RESUBMIT_SLA_1BD") }), ctx.parties.filter((x) => isCreditParty(ctx, x)));
}

// ---------------------------------------------------------------- 32.5 §3–§4 — the large deposit's one question (that deposit only)
async function onLargeDeposit(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const depositId = String(p["deposit_id"]); const dep = ctx.store.get("asset_deposits", depositId)?.data as P | undefined;
  const asset = dep ? (ctx.store.get("application_assets", String(dep["asset_id"]))?.data as P | undefined) : undefined;
  const amount = String(p["amount_cents"] ?? dep?.["amount_cents"] ?? "0"); const posted = String(dep?.["posted_on"] ?? p["posted_on"] ?? e.occurredAt.slice(0, 10)); const last4 = String(asset?.["account_last4"] ?? "").slice(-4);
  const ownerIds = Array.isArray(asset?.["borrower_ids"]) ? (asset!["borrower_ids"] as string[]) : [];
  const parties = (ownerIds.length ? ownerIds.flatMap((b) => partiesFor(ctx, b)) : ctx.parties).filter((x, i, all) => all.findIndex((y) => y.party_id === x.party_id) === i && isCreditParty(ctx, x));
  await sendToAll(deps, ctx, { kind: "ExplanationCard", copy_key: "explain.title", flow_key: `deposit:${depositId}`, command_ref: "explanation.submit",
    props: { subject: "", prompt: "", min_length: 40, subject_copy_key: "explain.deposit.subject", prompt_copy_key: "explain.deposit", copy_tokens: { money: money(amount), date: shortDate(posted), account_last4: last4 ? `····${last4}` : "your account", subject: `${money(amount)} deposit on ${shortDate(posted)}` }, label_copy_key: "explain.title", action_label: `Explain the ${money(amount)} deposit on ${shortDate(posted)}`, deposit_id: depositId, asset_id: dep?.["asset_id"] ?? null, amount_cents: amount, threshold_cents: String(p["threshold_cents"] ?? dep?.["threshold_cents"] ?? ""), gate: "FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE", command_args: { subject_ref: `deposit:${depositId}`, document_class: "explanation_letter" } } }, parties);
}

// ---------------------------------------------------------------- 32.5 §7 — the second borrower: a first-class parallel flow
async function onPartyInvited(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const partyId = String(p["party_id"]); const role = String(p["role"] ?? "co_borrower");
  const invitee = ctx.parties.find((x) => x.party_id === partyId); if (!invitee) return;
  const inviter = ctx.parties.find((x) => x.party_id === String(p["invited_by_party_id"] ?? "")) ?? ctx.parties.find((x) => x.party_id !== partyId);
  const intake = intakeBorrowers(ctx); const known = intake.find((b) => b.legal_name === invitee.legal_name);
  if (role === "co_borrower" && !known) {
    // 21.1's own borrower row: `application.borrower.added{joint_intent_required}` arms SM_O21_JOINT_INTENT_GATE — the invitee's credit waits on their own affirmation
    await owning(deps, ctx, "21.1", "captureField", INTAKE, { field: "borrower", borrower_id: `B${intake.length + 1}`, legal_name: invitee.legal_name, borrower_role: "co_borrower", at: ctx.now });
  } else if (role === "non_borrowing_spouse" && !known && inviter) {
    const applicant = intakeIdOf(ctx, inviter);
    if (applicant) { try { await owning(deps, ctx, "21.1", "captureField", INTAKE, { field: "non_borrowing_spouse", applicant_id: applicant, spouse_id: `S${intake.length + 1}`, spouse_name: invitee.legal_name, at: ctx.now }); } catch (err) { deps.logger?.error("borrower.flow.32-5.spouse", { error: err instanceof Error ? err.message : String(err) }); } }
  }
  // the invitee's own conversation and deep link (32.5 §7): the link carries no loan data; the message is the only text they get before signing in
  const link = await deps.runtime.execute({ process: "32.1", name: "create_deep_link", loanId: "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN }, input: { party_id: partyId, target: { route: "/" } } });
  const token = String((link.output as { token: string }).token);
  const conv = await deps.ui.conversationFor(partyId);
  await deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: ctx.now, sender: "agent", sender_ref: "agent:intake", channel: "app", body_text: `{{copy:coborrower.deep_link}} /d/${token}`, subject_application_id: ctx.appId });
  if (role !== "co_borrower") return;   // a non-borrowing spouse signs the security instrument only: no joint intent, no credit, no profile, no demographics (21.1 rule 4; T8)
  const fresh = await context(deps, ctx.appId);
  const me = fresh.parties.find((x) => x.party_id === partyId) ?? invitee; const myIntakeId = intakeIdOf(fresh, me) ?? `B${intake.length + 1}`;
  // joint intent FIRST — before any credit card for the invitee (SM_O21_JOINT_INTENT_GATE; 21.1 rule 4); a checkbox and a typed name, never a spoken yes
  await sendCard(deps, fresh, me, StatusCard("coborrower.joint_intent.first", `cob.first:${partyId}`, { copy_tokens: { other_first_name: inviter ? firstName(inviter.legal_name) : "" } }));
  await sendCard(deps, fresh, me, { kind: "ConsentCard", copy_key: "consent.joint_intent.title", flow_key: `cob.joint_intent:${partyId}`, command_ref: "application.affirmJointIntent",
    props: { consent_kind: "joint_intent", disclosure_version_id: "REGB_1002_7D_JOINT_INTENT", scope: [], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true, verification_state: "none", gate: "SM_O21_JOINT_INTENT_GATE", copy_tokens: { other_first_name: inviter ? firstName(inviter.legal_name) : "" }, command_args: { borrower_id: myIntakeId, method: "web_checkbox" } } });
}
/** After the invitee's own affirmation: their R2–R6 — income, liabilities, profile, declarations, demographics (each their own; the inviter never answers for them). */
async function onJointIntentAffirmed(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const parties = partiesFor(ctx, p["borrower_id"]).filter((x) => isCreditParty(ctx, x));
  const invited = new Set(ctx.events.filter((x) => x.type === "application.party.invited").map((x) => String(pl(x)["party_id"])));
  for (const party of parties) {
    if (!invited.has(party.party_id)) continue;   // the interview's own borrowers get R2–R6 from the happy path (32.3)
    const id = intakeIdOf(ctx, party) ?? String(p["borrower_id"]);
    await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "income.connect.purpose", flow_key: `cob.income:${party.party_id}`, command_ref: "verification.connect", props: { vendor: "truv_income", vendor_fake: "FAKE", state: "not_started", what_we_get: "", fallback: "", command_args: { vendor: "truv_income", borrower_id: id, fee_paid_by: "sm" } } });
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "credit.liabilities.confirm", flow_key: `cob.liabilities:${party.party_id}`, command_ref: "application.confirmField", props: { commits_to: "application_liabilities", fields: [], command_args: { path: "liabilities", borrower_id: id, value: { confirmed: true } } } });
    await sendCard(deps, ctx, party, { kind: "ProfileCard", copy_key: "profile.title", flow_key: `cob.profile:${party.party_id}`, command_ref: "application.confirmField", props: { title: "", fields: [{ path: "marital_status", label: "Marital status", required: true, options: [{ id: "married", label: "Married" }, { id: "unmarried", label: "Unmarried" }, { id: "separated", label: "Separated" }] }, { path: "citizenship_status", label: "Citizenship", required: true, options: [{ id: "us_citizen", label: "U.S. citizen" }, { id: "permanent_resident", label: "Permanent resident" }, { id: "non_permanent_resident", label: "Non-permanent resident" }] }], command_args: { path: "profile", borrower_id: id } } });
    await sendCard(deps, ctx, party, { kind: "ChoiceCard", copy_key: "declarations.title", flow_key: `cob.declarations:${party.party_id}`, command_ref: "application.answerDeclarations", props: { title: "", options: [{ id: "none", label: "None of these apply to me", is_primary: true }, { id: "something", label: "Something here applies" }], command: "application.answerDeclarations", command_args_by_option: { none: { borrower_id: id, declarations: Array.from({ length: 13 }, () => false) }, something: {} }, no_command_options: ["something"] } });
    await sendCard(deps, ctx, party, { kind: "DemographicsCard", copy_key: "demographics.title", flow_key: `cob.demographics:${party.party_id}`, command_ref: "application.answerDemographics", props: { collection_method: "internet", statement_text: "", ethnicity: [{ id: "hispanic_or_latino", label: "Hispanic or Latino" }, { id: "not_hispanic_or_latino", label: "Not Hispanic or Latino" }, { id: "do_not_wish", label: "I do not wish to provide this information" }], race: [{ id: "american_indian_or_alaska_native", label: "American Indian or Alaska Native" }, { id: "asian", label: "Asian" }, { id: "black_or_african_american", label: "Black or African American" }, { id: "native_hawaiian_or_other_pacific_islander", label: "Native Hawaiian or Other Pacific Islander" }, { id: "white", label: "White" }, { id: "do_not_wish", label: "I do not wish to provide this information" }], sex: [{ id: "female", label: "Female" }, { id: "male", label: "Male" }, { id: "do_not_wish", label: "I do not wish to provide this information" }], available: true, command_args: { borrower_id: id, collection_method: "internet" } } });
  }
}

// ---------------------------------------------------------------- 32.5 §8 — the human agent: introduced, never resolving
async function onHumanRequested(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const parties = typeof p["party_id"] === "string" ? ctx.parties.filter((x) => x.party_id === p["party_id"]) : ctx.parties;
  await sendToAll(deps, ctx, { kind: "PersonCard", copy_key: "human.agent.intro", flow_key: `human:${String(p["escalation_id"] ?? e.id)}`, informational: true, props: { role: "human_agent", name: "", name_copy_key: "human.agent.pending", intro: "", intro_copy_key: "human.agent.intro", requested_at: p["requested_at"] ?? e.occurredAt, reason: p["reason"] ?? null } }, parties);
}

// ---------------------------------------------------------------- the reactions, per application, in commit order
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  switch (e.type) {
    case "condition.opened": return onConditionOpened(deps, ctx, e);
    case "condition.cleared": case "condition.waived": case "condition.superseded": case "condition.reopened": case "condition.waiting": return onConditionMoved(deps, ctx, e);
    case "document_request.opened": return onRequestOpened(deps, ctx, e);
    case "document_request.satisfied": case "document_request.waived": case "document_request.expired": return onRequestClosed(deps, ctx, e);
    case "credit.udm.alert.received": return onNewTradeline(deps, ctx, e);
    case "du.resubmission.required": case "du.resubmission.waived": return onResubmission(deps, ctx, e);
    case "asset.deposit.flagged_large": return onLargeDeposit(deps, ctx, e);
    case "application.party.invited": return onPartyInvited(deps, ctx, e);
    case "application.joint_intent.affirmed": return onJointIntentAffirmed(deps, ctx, e);
    case "human.transfer.requested": return onHumanRequested(deps, ctx, e);
    default: return;
  }
}

export const FLOW_5_VERIFICATION: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byApp = new Map<string, DomainEvent[]>();
    for (const e of events) { const app = e.applicationId ?? (typeof (e.payload as P)["application_id"] === "string" ? String((e.payload as P)["application_id"]) : null); if (!app) continue; const list = byApp.get(app) ?? []; list.push(e); byApp.set(app, list); }
    for (const [appId, list] of byApp) {
      const now = batchNow(deps, list); const ctx = await context(deps, appId, now);
      if (!ctx.parties.length) continue;   // no borrower party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-5.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
      // the refreshed checklist mirrors the list after the batch: dated no earlier than the facts it mirrors, so it is the most recent pending card (the pinned current ask — 32.1 §Thread, 32.5 §1)
      if (dirty.delete(appId)) { try { const clockNow = deps.runtime.clock.now(); await refreshChecklist(deps, await context(deps, appId, clockNow > now ? clockNow : now)); } catch (err) { deps.logger?.error("borrower.flow.32-5.checklist", { application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  /** 22.1's nightly freshness sweep for every application with a scheduled closing and documents on file (the owning process's own op; the flow only asks). */
  async tick(deps, nowIso) {
    const apps = await deps.runtime.db.query<{ application_id: string }>(`SELECT DISTINCT e.application_id FROM loan_events e WHERE e.type IN ('closing.scheduled', 'closing.rescheduled') AND e.application_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM loan_events f WHERE f.application_id = e.application_id AND f.type IN ('loan.funded', 'closing.consummated', 'application.withdrawn'))
      AND EXISTS (SELECT 1 FROM entity_records d WHERE d.kind = 'documents' AND d.application_id = e.application_id::text)`);
    for (const a of apps) {
      try { await deps.runtime.execute({ process: "22.1", name: "computeFreshness", loanId: "", applicationId: a.application_id, actor: VERIFICATION, run: { ...RUN }, input: { application_id: a.application_id, op: "sweep", as_of: nowIso.slice(0, 10), request_id: `req-${a.application_id.slice(0, 8)}-fresh-${randomUUID().slice(0, 8)}` } }); }
      catch (err) { deps.logger?.error("borrower.flow.32-5.sweep", { application_id: a.application_id, error: err instanceof Error ? err.message : String(err) }); }
    }
  },
};
