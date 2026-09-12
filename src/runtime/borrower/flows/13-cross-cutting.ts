/**
 * 32.13 Cross-cutting — the harness rules that hold on every screen, whichever 32.x process sent the card
 * (spec/sections/32-borrower-experience/32-13-cross-cutting-acceptance-harness-copy-library-rules-side-que.md;
 * docs/ux/13-acceptance-tests.md T-X-01 … T-X-16, docs/ux/11-side-quests-catalogue.md SQ-30).
 *
 * What this flow does (everything else in 32.13 is a test over the other flows' output):
 *
 *   consent.esign.active / consent.granted{esign, active}   the party's `consents` row becomes `active` (T-X-04: a DocumentCard with a
 *                                                           `disclosure_id` exists only under an active esign consent; 20.3's demonstration
 *                                                           path emits the event without touching the 0009 table — this closes the seam)
 *   human.transfer.completed (20.3 delta `human_joined`)     PersonCard{human_agent} with the person's name (T-X-08, SQ-30; copy `person.human_agent`)
 *   contact.logged{outcome=human_transferred} (11.3)         the same card on a serviced loan — the platform's spelling of the completion (BACKEND-DELTAS §2)
 *   escalation.completed{kind=human_agent}                   the same card when the 4.3 / 32.2 escalation closes
 *   loan.paid_in_full                                        every pending card on the loan (and its application) is cancelled — the Record is read-only (T-X-16)
 *   Truv `voie.report.failed` (routes.ts → `connectorFailed`)  the ConnectCard's evidence records the failure without any error code; the
 *                                                           thread says `connect.failed.fallback`; an UploadCard `income.upload.fallback` is
 *                                                           the way forward (T-X-12; 01 §10 degraded vendor)
 *
 *   terminalStateOf / TERMINAL_ALLOWED_COMMANDS              the command guard commands.ts applies (T-X-16): after `denied | withdrawn |
 *                                                           closed_incomplete | rescinded | paid_in_full → closed | transferred_out` only
 *                                                           `case.open`, `human.request` and `party.updateContact` run (document download is a GET)
 *
 * Nothing here transitions an owning process's state: cards are sent through 32.1's `send_card` as the intake agent, the consents
 * row is the 7.4 table the owning event already describes, and the terminal states are read from the owning tables/events.
 */
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import type { Db, Queryable } from "../../../infra/db/client.ts";
import { isUuid, toJson } from "../../../infra/db/client.ts";
import type { PgBorrowerUiRepository } from "../../../infra/db/borrower-ui.ts";
import type { Runtime } from "../../app.ts";
import type { BorrowerFlow, FlowDeps } from "./index.ts";

export const FLOW_ID = "32.13";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const RUN = { runId: "flow:32.13", modelVersion: "borrower flows (deterministic)", promptVersion: "32.13" } as const;
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const s = (v: unknown): string => (typeof v === "string" ? v : "");

// ---------------------------------------------------------------- T-X-16: the terminal states and the commands that still run
/** The commands that run on a read-only Record (13 T-X-16): a question, a person, a contact change. Document download is a GET. */
export const TERMINAL_ALLOWED_COMMANDS: ReadonlySet<string> = new Set(["case.open", "human.request", "party.updateContact"]);
/** Commands that act on no subject (a new lead, the session's own disclosure and authentication, identity proofing): never judged by a subject's terminal state. */
export const SUBJECT_FREE_COMMANDS: ReadonlySet<string> = new Set(["lead.start", "lead.acknowledgeAiDisclosure", "party.authenticate", "party.startIdentity", "lead.answer", "lead.requestRange", "lead.proceed", "party.linkLoan"]);   // 32.14 DELTA-11: the anonymous minute's tools act on the lead, never on a subject; DELTA-16: link-my-loan runs before the party has a subject
export type TerminalState = "denied" | "withdrawn" | "closed_incomplete" | "rescinded" | "paid_in_full" | "transferred_out";

/**
 * The terminal state of a subject, read from the owning records: 21.6's decision (`decision.issued{kind=denial}`, `application.withdrawn`,
 * `application.closed_incomplete`), 25.3's `rescission.exercised`, 2.x/16.x's `loan.paid_in_full` / `loans.status=paid_off`, 17.x's
 * `loans.status=transferred_out`. An application subject is also terminal when the loan it became is.
 */
export async function terminalStateOf(db: Queryable, subject: { application_id: string | null; loan_id: string | null }): Promise<TerminalState | null> {
  const loanIds: string[] = [];
  if (subject.loan_id) loanIds.push(subject.loan_id);
  if (subject.application_id) {
    // the latest disposition decides, and only the owning process disposes: 21.6's decision (a denial, a withdrawal, a file closed incomplete), 25.3's exercise —
    // a borrower's `application.withdrawn` statement alone (32.2's express stand-in before 21.6 has a decision file) is not yet the file's disposition; a terminal
    // event the file later moved past (a decision, a clear to close, a funding) no longer holds
    const rows = await db.query<{ type: string; payload: P }>(`SELECT type, payload FROM loan_events WHERE application_id = $1 AND type IN ('decision.issued', 'application.closed_incomplete', 'application.reopened', 'rescission.exercised', 'rescission.confirmed_not_rescinded', 'rescission.waiver.accepted', 'underwriting.clear_to_close', 'closing.consummated', 'loan.funded') ORDER BY sequence`, [subject.application_id]);
    let state: TerminalState | null = null;
    for (const r of rows) {
      if (r.type === "rescission.exercised") state = "rescinded";
      else if (r.type === "application.closed_incomplete") state = "closed_incomplete";
      else if (r.type === "decision.issued") { const kind = r.payload["kind"]; state = kind === "denial" ? "denied" : kind === "file_closed_incomplete" ? "closed_incomplete" : kind === "withdrawal" ? "withdrawn" : null; }
      else state = null;   // reopened, a rescission that ended without an exercise, clear to close, consummation, funding: the file went on
    }
    if (state) return state;
    const app = (await db.query<{ status: string | null; loan_id: string | null }>(`SELECT status, loan_id FROM applications WHERE id = $1`, [subject.application_id]))[0];
    if (app?.status === "withdrawn") return "withdrawn";
    if (app?.status === "denied") return "denied";
    if (app?.status === "closed_incomplete") return "closed_incomplete";
    if (app?.loan_id) loanIds.push(app.loan_id);
    for (const l of await db.query<{ id: string }>(`SELECT id FROM loans WHERE origination_application_id = $1`, [subject.application_id])) loanIds.push(l.id);
  }
  for (const loanId of [...new Set(loanIds)]) {
    const loan = (await db.query<{ status: string }>(`SELECT status::text AS status FROM loans WHERE id = $1`, [loanId]))[0];
    if (loan?.status === "transferred_out") return "transferred_out";
    if (loan?.status === "paid_off") return "paid_in_full";
    const paid = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type IN ('loan.paid_in_full', 'loan.transferred_out', 'transfer.out.completed')`, [loanId]);
    if (Number(paid[0]?.n ?? 0) > 0) return "paid_in_full";
  }
  return null;
}

// ---------------------------------------------------------------- parties of a subject (an application's borrowers; a loan's borrowers, successors and the application it came from)
interface Party { readonly party_id: string; readonly legal_name: string }
async function partiesOf(db: Queryable, subject: { application_id: string | null; loan_id: string | null }): Promise<Party[]> {
  if (subject.loan_id) return db.query<Party & Record<string, unknown>>(
    `SELECT DISTINCT p.id AS party_id, p.legal_name FROM parties p WHERE p.id IN (
       SELECT b.party_id FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL
       UNION SELECT ab.party_id FROM application_borrowers ab JOIN loans l ON l.origination_application_id = ab.application_id WHERE l.id = $1 AND ab.party_id IS NOT NULL
       UNION SELECT lp.party_id FROM loan_parties lp WHERE lp.loan_id = $1 AND lp.role = 'confirmed_successor' AND lp.ended_at IS NULL) ORDER BY p.legal_name`, [subject.loan_id]);
  if (subject.application_id) return db.query<Party & Record<string, unknown>>(`SELECT party_id, legal_name FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at, id`, [subject.application_id]);
  return [];
}

// ---------------------------------------------------------------- 32.1's send_card as the intake agent, idempotent on flow_key
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly flow_key: string; readonly informational?: boolean }
async function existingCard(db: Queryable, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: { runtime: Runtime; ui: PgBorrowerUiRepository }, subject: { application_id: string | null; loan_id: string | null }, party: Party, c: CardSpec, now: string): Promise<string> {
  const prior = await existingCard(deps.runtime.db, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: subject.loan_id ?? "", ...(subject.application_id ? { applicationId: subject.application_id } : {}), actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: null, subject: { application_id: subject.application_id, loan_id: subject.loan_id }, created_by: "agent:intake", rationale: `32.13 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  // a card with no action (PersonCard) is never the pinned ask: filed as read the moment it is sent (01 §3.1 "No action")
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", now, { informational: true, resolved_by: "system:flow-32.13" });
  return id;
}

// ---------------------------------------------------------------- T-X-04: the consents row follows the owning event
async function activateConsent(db: Db, p: P, at: string): Promise<void> {
  const id = s(p["consent_id"]); if (!isUuid(id)) return;
  await db.query(`UPDATE consents SET status = 'active', verified = true, verified_at = coalesce(verified_at, $2) WHERE id = $1 AND kind = 'esign' AND status <> 'active'`, [id, at]);
}

// ---------------------------------------------------------------- T-X-08 / SQ-30: the person who joined
async function personJoined(deps: FlowDeps, e: DomainEvent, p: P): Promise<void> {
  const subject = { application_id: e.applicationId ?? null, loan_id: e.loanId ?? null };
  if (!subject.application_id && !subject.loan_id) return;
  const key = s(p["escalation_id"]) || s(p["interaction_id"]) || s(p["id"]) || e.id;
  const name = s(p["human_agent_name"]) || s(p["agent_name"]) || s(p["name"]);
  const parties = typeof p["party_id"] === "string" ? (await partiesOf(deps.runtime.db, subject)).filter((x) => x.party_id === p["party_id"]) : await partiesOf(deps.runtime.db, subject);
  for (const party of parties.length ? parties : await partiesOf(deps.runtime.db, subject)) {
    await sendCard(deps, subject, party, { kind: "PersonCard", copy_key: "person.human_agent", flow_key: `human.joined:${key}`, informational: true,
      props: { role: "human_agent", name: name || "Your Supermortgage contact", credentials: "", intro: "", intro_copy_key: "person.human_agent", joined_at: s(p["joined_at"]) || e.occurredAt, escalation_id: s(p["escalation_id"]) || null, human_agent_id: s(p["human_agent_id"]) || s(p["completed_by"]) || null } }, e.occurredAt);
  }
}

// ---------------------------------------------------------------- T-X-16: a paid-in-full loan leaves nothing pending
async function cancelPending(deps: FlowDeps, subject: { application_id: string | null; loan_id: string | null }, reason: string, at: string): Promise<number> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE status = 'pending' AND (($1::uuid IS NOT NULL AND subject_loan_id = $1) OR ($2::uuid IS NOT NULL AND subject_application_id = $2))`, [subject.loan_id, subject.application_id]);
  for (const r of rows) await deps.ui.transitionCard(r.card_instance_id, "cancelled", "system", at, { reason, resolved_by: "system:flow-32.13" });
  return rows.length;
}

// ---------------------------------------------------------------- T-X-12: the degraded vendor (routes.ts calls this from the Truv webhook's failed branch)
/**
 * A vendor failure the borrower never has to decode: the ConnectCard's evidence records `outcome: failed` and the vendor's marker only
 * (no code, no message), the thread says we'll take documents instead, and an UploadCard for the same purpose is the way forward.
 * The card itself stays pending in state `failed` so "Try again" and the upload fallback are both live (01 §10; ConnectCard.tsx).
 */
export async function connectorFailed(deps: { runtime: Runtime; ui: PgBorrowerUiRepository }, card: { card_instance_id: string; party_id: string; subject_application_id: string | null; subject_loan_id?: string | null; props: Record<string, unknown> }, at: string, vendor: { name: string; fake: boolean; vendor_session_id: string | null }): Promise<{ upload_card_instance_id: string | null }> {
  const db = deps.runtime.db;
  await db.query(`UPDATE card_instances SET evidence = coalesce(evidence, '{}'::jsonb) || $2::jsonb, props = props || $3::jsonb WHERE card_instance_id = $1`,
    [card.card_instance_id, toJson({ vendor: vendor.name, ...(vendor.fake ? { vendor_fake: "FAKE" } : {}), vendor_session_id: vendor.vendor_session_id, outcome: "failed", failed_at: at, fallback: "upload" }), toJson({ state: "failed", failed_at: at, fallback_offered: true })]);
  await deps.ui.logUiEvent({ party_id: card.party_id, card_instance_id: card.card_instance_id, kind: "connector_completed", at, payload: { vendor: vendor.name, vendor_session_id: vendor.vendor_session_id, outcome: "failed", fallback: "upload" } });
  const conv = await deps.ui.conversationFor(card.party_id);
  await deps.ui.appendMessage({ conversation_id: conv.conversation_id, at, sender: "agent", sender_ref: "agent:intake", channel: "app", body_text: "{{copy:connect.failed.fallback}}", card_instance_id: card.card_instance_id, subject_application_id: card.subject_application_id, subject_loan_id: card.subject_loan_id ?? null });
  const subject = { application_id: card.subject_application_id, loan_id: card.subject_loan_id ?? null };
  const party = (await partiesOf(db, subject)).find((x) => x.party_id === card.party_id) ?? { party_id: card.party_id, legal_name: "" };
  const purpose = s(card.props["vendor"]) === "truv_income" ? "income" : s(card.props["vendor"]) || "documents";
  const flowKey = `upload.fallback:${card.card_instance_id}`;
  const prior = await existingCard(db, card.party_id, flowKey);
  if (prior && prior.status === "pending") return { upload_card_instance_id: prior.card_instance_id };
  const args = (card.props["command_args"] as P | undefined) ?? {};
  const id = await sendCard(deps, subject, party, { kind: "UploadCard", copy_key: purpose === "income" ? "income.upload.fallback" : "documents.upload.fallback", flow_key: flowKey, command_ref: "document.upload",
    props: { document_class: purpose === "income" ? "paystub" : "other", accepted_examples: purpose === "income" ? ["pay stub", "W-2"] : ["a PDF or a photo"], why: "", title: "", fallback_for_card_instance_id: card.card_instance_id, vendor: s(card.props["vendor"]) || null, command_args: { document_class: purpose === "income" ? "paystub" : "other", ...(typeof args["borrower_id"] === "string" ? { borrower_id: args["borrower_id"] } : {}) } } }, at);
  return { upload_card_instance_id: id };
}

// ---------------------------------------------------------------- DELTA-26 / 32.16 §2.3: when a card exists — the four cases, and nothing else
/**
 * docs/ux/17 §2.3 as data (32.16 T28 is the contract test over it): every card kind belongs to exactly one of the four cases, and a
 * card of that kind may exist only for one of the listed triggers. A trigger is what raised the card — an owning-process event type
 * (the state change the flow reacted to: `disclosure.le.received`, `payment.*`), the session hook (`session.opened`), the borrower's own
 * message a flow answered (`borrower.message` — the flows' `onMessage`; §4 "card.request for payments and changes"), the 32.16 tool
 * commands (`card.request`, `human.request`) or the scheduled pass (`tick`, the owning processes' daily sweeps). Patterns: `*` matches
 * any run of characters (`payment.*`, `*.received`). The trigger `chat` — the assistant decided a card would be nice — matches no row:
 * a status, a question, an explanation or a "what's next" is talk (§1 principle 3).
 *
 * Kinds the §2.3 table names by case are placed as it places them; the three kinds it does not name (the rail's own furniture, DELTA-26)
 * are placed from §4's "Rail item / The evidence" columns:
 *   StatusCard     document_or_choice — §4's Progress / What we're doing rows exist only on an owning-process state change (`du.findings.received`,
 *                  `lock.executed`, `payment.posted`, …) or the sweep that moves a clock (the day-20 shortage, a deemed rejection); it is the
 *                  rail's receipt of a fact "delivered … on its own clock", never the assistant's judgment — a StatusCard on `chat`,
 *                  `session.opened` or `borrower.message` is the canonical refusal ("the assistant decided to send a status").
 *   PersonCard     integration — §2.3 "a person they must meet": the human who joined (`human.transfer.completed`), the notary, the settlement
 *                  agent, the MLO of record, the 4.3 continuity team.
 *   ChecklistCard  integration — the pinned needs list is the container of the borrower's UploadCards / the 23.3 conditions (§4 "Conditions …
 *                  Needed / What we're doing … owning-process events").
 * `ChoiceCard` sits in two §2.3 rows (evidence when it is the borrower's own answer — declarations, the goal, the product; a regulated
 * choice when it is proceed / lock / counteroffer / escrow shortage); the table keeps one row per kind with the union of both rows' triggers
 * and names the case the spec lists first for it — the contract is over (kind, trigger), the case is the reason the card may exist.
 */
export type CardCase = "evidence" | "consent" | "integration" | "document_or_choice";
export interface CardCaseRow { readonly case: CardCase; readonly why: string; readonly triggers: readonly string[] }
/** The session hook, the borrower's message, the 32.16 tool commands and the sweep — the triggers that are not owning-process events. */
export const SESSION_TRIGGER = "session.opened"; export const MESSAGE_TRIGGER = "borrower.message"; export const TICK_TRIGGER = "tick";
export const COMMAND_TRIGGERS: readonly string[] = ["card.request", "human.request"];
/** The 32.16 §2.3 forbidden trigger: no owning event, no hook, no command — the assistant's own decision. */
export const CHAT_TRIGGER = "chat";
const ASK = [MESSAGE_TRIGGER, ...COMMAND_TRIGGERS];   // the borrower asked (a payment, a change, a person): §4 "card.request for payments and changes"

export const CARD_CASES: Readonly<Record<string, CardCaseRow>> = {
  // ---- Evidence the borrower must state or confirm: the six items count when stated (21.2); Reg B fields take no defaults; a prefill counts only on Confirm
  ConfirmCard: { case: "evidence", why: "a prefill counts only on Confirm (32.3 T5); the six items count when stated", triggers: [
    "application.received", "identity.verified", "application.field.captured", "application.six_item.captured", "application.demographics.collected", "verification.received",
    "credit.report.received", "credit.udm.alert.received", "document.received", "document.classified", "document.extracted", "application.joint_intent.affirmed",
    "application.party.invited", "lead.*", "prequal.*",   // 32.14 S4: the identity the consumer enters, on the lead's own events
    "contact.logged", "qrpc.*", "lossmit.request.*", "lossmit.application.received", MESSAGE_TRIGGER, "card.request",   // 32.10 T2: the QRPC read-back after "I lost my job"
  ] },
  ChoiceCard: { case: "evidence", why: "declarations, the goal and the product are the borrower's own answers; proceed, lock, counteroffer, MI, escrow shortage are the borrower's choices, not the assistant's", triggers: [
    "application.received", "application.field.captured", "application.demographics.collected", "application.joint_intent.affirmed", "document.received", "document.classified", "document.extracted",
    "lead.*", "prequal.*", "terms.presented", "mlo.review.completed", SESSION_TRIGGER,   // the only kind a session hook sends: 32.3 E3's goal, 32.14 S4's how-to-prove-identity
    "disclosure.le.received", "disclosure.le.deemed_received", "lock.expiry.warned", "lock.expired", "decision.issued", "valuation.value_used.set", "clear_to_close.issued", "disclosure.cd.waiting_period.computed",
    "rescission.*", "consent.granted", "autodraft.status.changed", "escrow.statement.sent", "escrow.analysis.*", "case.opened", "suspense.item.created",
    "mi.cancel.*", "mi.value_check_needed", "notice.sent", "lossmit.denial.provided", "lossmit.offer.sent", "workout_plan.*", "payoff.*", ...ASK,
  ] },
  ProfileCard: { case: "evidence", why: "Reg B fields take no defaults", triggers: ["application.six_item.captured", "application.field.captured", "application.joint_intent.affirmed", "application.received", "verification.received"] },
  DemographicsCard: { case: "evidence", why: "demographics are the borrower's own answers, never inferred", triggers: ["application.declarations.answered", "application.joint_intent.affirmed", "application.received"] },
  ExplanationCard: { case: "evidence", why: "an explanation is the borrower's own statement (22.1 / 22.4)", triggers: ["document_request.opened", "asset.deposit.flagged_large", "condition.opened", ...ASK] },
  // ---- Consent: E-SIGN's demonstrable-consent test; credit authorization with a typed name; TCPA's exact text
  ConsentCard: { case: "consent", why: "E-SIGN's demonstrable-consent test; credit authorization with a typed name; TCPA's exact text", triggers: [
    "application.received", "lead.*", "prequal.*", "disclosure.le.mailed", "disclosure.le.delivered", "application.party.invited", "consent.esign.*", "consent.granted", "consent.revoked",
    "notice.sent", "consents.boarded", "loan.boarded", "autodraft.enrollment.requested", TICK_TRIGGER,   // 32.8 T11: the December irs_estatement ask is the sweep's
    ...ASK,
  ] },
  // ---- Integration: a vendor the borrower must authenticate to, or a person they must meet
  ConnectCard: { case: "integration", why: "a vendor the borrower must authenticate to (Stripe Identity, Truv, Plaid, carrier)", triggers: ["application.received", "application.joint_intent.affirmed", "identity.*", "lead.*", "prequal.*", "verification.*", "consent.granted", ...ASK] },
  UploadCard: { case: "integration", why: "a document only the borrower holds", triggers: [
    "document_request.opened", "document_request.reopened", "condition.opened", "project.docs.requested", "insurance.deficiency.opened", "funding.held", "loan.purchased", "fpi.*", "notice.sent",
    "case.*", "sii.*", "verification.failed", "voie.report.failed", "lossmit.*", ...ASK,   // 13 T-X-12: the degraded vendor's fallback (routes.ts → connectorFailed) is raised by the vendor's failure
  ] },
  ScheduleCard: { case: "integration", why: "a person they must meet: appraisal access, the RON session", triggers: ["valuation.assigned", "valuation.*", "disclosure.cd.waiting_period.computed", "clear_to_close.issued", "closing.*", ...ASK] },
  InviteCard: { case: "integration", why: "a person they must bring in (the co-borrower)", triggers: ["application.received", "application.party.*", ...ASK] },   // no flow sends one today; the row exists so the kind has a case
  HandoffCard: { case: "integration", why: "a hand-off to a person or a platform outside the thread", triggers: ["valuation.assigned", "valuation.*", "project.docs.requested", "closing.documents.released", "closing.*", "loan.purchased", ...ASK] },
  PersonCard: { case: "integration", why: "§4 People: the human who joined, the notary, the settlement agent, the MLO, the continuity team", triggers: [
    "human.transfer.*", "contact.logged", "escalation.*", "terms.presentation.requested", "closing.scheduled", "continuity.assigned", "application.mlo_of_record.assigned", ...ASK,
  ] },
  ChecklistCard: { case: "integration", why: "the pinned needs list: the borrower's UploadCards and the 23.3 conditions", triggers: ["condition.*", "document_request.*", "du.findings.*", "du.resubmission.*"] },
  // ---- Document or regulated choice: delivered and received as documents on their own clocks; the borrower's choices, not the assistant's
  DocumentCard: { case: "document_or_choice", why: "the LE, CD and notices are delivered and received as documents on their own clocks", triggers: [
    "disclosure.*", "arm.disclosures.delivered", "consent.esign.active", "preapproval.letter.issued", "decision.issued", "valuation.copy.delivered", "flood.notice.delivered", "rescission.notice.delivered",
    "escrow.statement.sent", "statement.sent", "notice.*", "document.*",
  ] },
  NoticeCard: { case: "document_or_choice", why: "a notice the registry sent, on its own clock", triggers: [
    "notice.*", "tolerance.refund.issued", "insurance.deficiency.opened", "escrow.statement.sent", "tax_form.1098.furnished", "fpi.*", "flood.map_change.notified", "arm.initial_notice.sent",
    "payoff.*", "lossmit.*", "case.*", "sii.*", "fdcpa.*", "bankruptcy.*", "transfer.*",
  ] },
  ComparisonCard: { case: "document_or_choice", why: "lock, MI plan, counteroffer, a workout offer are the borrower's choices", triggers: ["intent.to_proceed.received", "lock.*", "decision.issued", "mi.quote.received", "lossmit.offer.sent", "workout_plan.ended", ...ASK] },
  PaymentCard: { case: "document_or_choice", why: "a money command never runs on words (32.1 §5: the fresh L1 code)", triggers: ["installment.due_date_reached", "autodraft.status.changed", "lossmit.offer.sent", "notice.sent", "mi.value_check_needed", ...ASK] },
  OfferCard: { case: "document_or_choice", why: "the refinance offer is the borrower's choice (20.2), presented only after the MLO's review", triggers: ["refi.opportunity.*", "mlo.review.completed"] },
  // ---- the rail's own furniture (DELTA-26; see the header of this block)
  StatusCard: { case: "document_or_choice", why: "§4 Progress / What we're doing: the rail's receipt of an owning-process state change, never the assistant's judgment", triggers: ["event:*", TICK_TRIGGER] },
};

/** The trigger names that are not owning-process events (the hooks, the borrower's asks, the sweep) — `event:*` in a row never matches these. */
const NON_EVENT_TRIGGERS: ReadonlySet<string> = new Set([SESSION_TRIGGER, MESSAGE_TRIGGER, TICK_TRIGGER, CHAT_TRIGGER, ...COMMAND_TRIGGERS]);
/** The thread's own events (a card, a message, a session) and the bus's receipts (`command.executed` / `command.refused`) are never the owning-process fact that raises a card. */
const UI_EVENT = /^(card|message|ui|session|thread|deep_link|command)\./;
function triggerMatches(pattern: string, trigger: string): boolean {
  if (pattern === "event:*") return !NON_EVENT_TRIGGERS.has(trigger) && !UI_EVENT.test(trigger) && trigger.length > 0;
  if (!pattern.includes("*")) return pattern === trigger;
  return new RegExp(`^${pattern.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(trigger);
}
/** The §2.3 case a card of `kind` raised by `trigger` (any of several: the events one commit reacted to) belongs to, or null when the table has no such row. */
export function cardCaseOf(kind: string, trigger: string | readonly string[]): CardCase | null {
  const row = CARD_CASES[kind]; if (!row) return null;
  const triggers = typeof trigger === "string" ? [trigger] : trigger;
  return triggers.some((t) => row.triggers.some((p) => triggerMatches(p, t))) ? row.case : null;
}
/** A `card.sent` with what raised it, as the contract test sees one. */
export interface CardSentForContract { readonly kind: string; readonly copy_key: string; readonly trigger: string | readonly string[]; readonly command_ref?: string | null; readonly created_by?: string | null }
/** T28's refusal: throws when the (kind, trigger) pair is outside §2.3's table, naming kind, trigger and copy_key. */
export function assertCardCase(event: CardSentForContract): CardCase {
  const c = cardCaseOf(event.kind, event.trigger);
  if (c) return c;
  const triggers = typeof event.trigger === "string" ? [event.trigger] : [...event.trigger];
  const shown = triggers.length ? triggers.join(" | ") : CHAT_TRIGGER;
  throw new Error(`32.16 §2.3: a ${event.kind} (copy_key ${event.copy_key}${event.command_ref ? `, command_ref ${event.command_ref}` : ""}${event.created_by ? `, created_by ${event.created_by}` : ""}) may not exist on trigger "${shown}" — ${CARD_CASES[event.kind] ? `its triggers are ${CARD_CASES[event.kind]!.triggers.join(", ")}` : "the kind has no §2.3 case"}`);
}

// ---------------------------------------------------------------- the reactions
const REACTS = new Set(["consent.esign.active", "consent.granted", "human.transfer.completed", "contact.logged", "escalation.completed", "loan.paid_in_full"]);

async function react(deps: FlowDeps, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "consent.esign.active": return activateConsent(deps.runtime.db, p, e.occurredAt);
    case "consent.granted": { if (p["kind"] === "esign" && p["status"] === "active") await activateConsent(deps.runtime.db, p, e.occurredAt); return; }
    case "human.transfer.completed": return personJoined(deps, e, p);
    case "contact.logged": { if (p["outcome"] === "human_transferred") await personJoined(deps, e, { ...p, escalation_id: s(p["id"]) }); return; }
    case "escalation.completed": { if (p["kind"] === "human_agent") await personJoined(deps, e, { ...p, human_agent_id: s(p["completed_by"]) }); return; }
    case "loan.paid_in_full": {
      const appId = e.applicationId ?? (e.loanId ? ((await deps.runtime.db.query<{ origination_application_id: string | null }>(`SELECT origination_application_id FROM loans WHERE id = $1`, [e.loanId]))[0]?.origination_application_id ?? null) : null);
      await cancelPending(deps, { loan_id: e.loanId ?? null, application_id: appId }, "loan paid in full (32.13 T-X-16: the Record is read-only)", e.occurredAt); return; }
    default: return;
  }
}

export const FLOW_13_CROSS_CUTTING: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) { for (const e of events) if (REACTS.has(e.type)) await react(deps, e); },
};

