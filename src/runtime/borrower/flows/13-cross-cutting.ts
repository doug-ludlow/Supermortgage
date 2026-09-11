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
export const SUBJECT_FREE_COMMANDS: ReadonlySet<string> = new Set(["lead.start", "lead.acknowledgeAiDisclosure", "party.authenticate", "party.startIdentity"]);
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

