/**
 * 32.14 — Entry, sign-up and sign-in: the anonymous minute's hand-off (DELTA-11; docs/ux/15-entry-sign-up-and-sign-in.md
 * §2 S3, §4, §9 T7 / T19). The L0 lead lives on the 20.3 aggregate behind the `sm_borrower_lead` cookie
 * (src/runtime/borrower/lead-routes.ts); this flow is what happens to it once a session exists, and how it dies:
 *
 *   session opened with a lead (`SessionOpened.lead_id`)   the verify route linked the lead to the party first (`lead.linked{party_id}`),
 *                                                          3-entry (registered before this flow) posted the session's disclosure line and ran
 *                                                          `party.authenticate` on that same lead; then, when the lead carries a goal, this flow
 *                                                          creates the application from the lead (`Runtime.createApplication{channel: organic,
 *                                                          transaction_type, occupancy, property tbd + state}` as the intake agent, the party's
 *                                                          provisional name as the borrower), starts 21.1's interview (`startInterview` with the
 *                                                          lead's facts; the estimate offered as a six-item prefill only — 32.3 T18; NO Reg B
 *                                                          request — `application.received` is 32.14 S4's Proceed: `lead.proceed` → 20.3 convert),
 *                                                          and posts ONE receipt line `{{copy:entry.resumed}}` instead of 32.3's goal card
 *                                                          (3-entry skips E3 for that session).
 *                                                          A lead without a goal is left to 32.3 E3 (the goal card, unchanged).
 *   tick (POST /v1/sweep)                                  SM_LEAD_INACTIVITY_EXPIRY_90: every armed lead clock whose due day has passed runs
 *                                                          20.3 `explainProgram{op: expire}` (`lead.expired`); tokens past their 30 days are dropped.
 *   lead.expired                                           the lead's `lead_tokens` rows are purged (T19: an unauthenticated lead leaves no row
 *                                                          behind — no party, no session, no conversation, no message was ever created for it).
 *
 * Nothing here computes a regulatory date (the expiry day is the Timer Engine's `due_date` and 20.3's own `expires_on`) and nothing
 * transitions an owning process's state except through its own bus tool.
 */
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { isUuid, toJson } from "../../../infra/db/client.ts";
import { PgBorrowerPartyRepository } from "../../../infra/db/borrower-parties.ts";
import { PgLeadTokenRepository } from "../../../infra/db/lead-tokens.ts";
import { civilDate } from "../../../domain/leads-pricing/ops-20-3.ts";
import { stateName } from "../../../domain/governance/ops-31-1.ts";
import type { BorrowerFlow, FlowDeps, SessionOpened } from "./index.ts";

export const FLOW_ID = "32.14";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const RUN = { runId: "flow:32.14", modelVersion: "borrower flows (deterministic)", promptVersion: "32.14" } as const;
export const RESUMED_COPY_KEY = "entry.resumed";
export const RESUMED_LINE = `{{copy:${RESUMED_COPY_KEY}}}`;
export const LEAD_EXPIRY_TIMER = "SM_LEAD_INACTIVITY_EXPIRY_90";
type P = Record<string, unknown>;
export type TransactionType = "purchase" | "limited_cash_out" | "cash_out";

/** The goal tiles ↔ `transaction_type`, one-to-one (32.14 §1.6; DELTA-11 `lead.goal.set{transaction_intent}`); 20.3's older `refinance` intent reads as the rate/payment goal. */
export const GOAL_OF_INTENT: Readonly<Record<string, TransactionType>> = { purchase: "purchase", limited_cash_out: "limited_cash_out", cash_out: "cash_out", refinance: "limited_cash_out" };
export const transactionTypeOf = (lead: P | null | undefined): TransactionType | null => (lead ? GOAL_OF_INTENT[String(lead["transaction_intent"] ?? "")] ?? null : null);
const OCCUPANCIES = new Set(["primary", "second_home", "investment"]);
const centsOf = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v.toString() : /^\d+$/.test(String(v)) ? String(v) : null);

const GOAL_LABEL: Readonly<Record<TransactionType, string>> = { purchase: "purchase", limited_cash_out: "refinance", cash_out: "cash-out refinance" };
const OCCUPANCY_LABEL: Readonly<Record<string, string>> = { primary: "primary home", second_home: "second home", investment: "investment property" };
const CONTRACT_LABEL: Readonly<Record<string, string>> = { signed: "contract signed", looking: "still looking" };
/** `entry.resumed`'s `{{answers}}`: "refinance · primary home · Arizona" — the goal, the occupancy (refi / cash-out) or the contract status (purchase), the state's full name. */
export function resumedAnswers(lead: P, transaction_type: TransactionType, occupancy: string, state: string | null): string {
  const middle = transaction_type === "purchase" ? CONTRACT_LABEL[String(lead["contract_status"] ?? "")] ?? null : OCCUPANCY_LABEL[occupancy] ?? null;
  return [GOAL_LABEL[transaction_type], middle, state ? stateName(state) : null].filter((x): x is string => !!x).join(" · ");
}
/** The lead's current record (a global entity row), or null. */
export async function leadRecord(deps: FlowDeps, leadId: string): Promise<P | null> {
  const r = await deps.runtime.entities.current("leads", leadId);
  return r ? r.data : null;
}
/** Does the lead carry a goal this flow will apply (so 3-entry's E3 goal card is not sent for the session)? */
export async function leadCarriesGoal(deps: FlowDeps, leadId: string | null | undefined): Promise<boolean> {
  if (!leadId) return false;
  const lead = await leadRecord(deps, leadId);
  return !!lead && transactionTypeOf(lead) !== null && !lead["application_id"];
}

// ---------------------------------------------------------------- S3 (ii): the application from the lead
async function resumeFromLead(deps: FlowDeps, s: SessionOpened): Promise<void> {
  if (!s.lead_id) return;
  const lead = await leadRecord(deps, s.lead_id); if (!lead) return;
  const transaction_type = transactionTypeOf(lead); if (!transaction_type) return;   // no goal: 32.3 E3's goal card is the ask
  if (lead["application_id"]) return;                                                   // already converted (20.3 convert) — nothing to create
  if (lead["party_id"] && lead["party_id"] !== s.party_id) { deps.logger?.info("borrower.flow.32-14.lead.other_party", { lead_id: s.lead_id }); return; }
  const db = deps.runtime.db; const parties = new PgBorrowerPartyRepository(db);
  const conv = await deps.ui.conversationFor(s.party_id);
  if ((await db.query<{ message_id: string }>(`SELECT message_id FROM messages WHERE conversation_id = $1 AND body_text = $2 LIMIT 1`, [conv.conversation_id, RESUMED_LINE])).length) return;   // resumed once
  const party = (await db.query<{ legal_name: string; contact: P }>(`SELECT legal_name, contact FROM parties WHERE id = $1`, [s.party_id]))[0]; if (!party) return;
  // the partner the lead was opened for (DELTA-15: the referral's or the configured default), else the configured default itself, else the newest servicer party — never an invented one
  const partnerRow = async (id: string | undefined): Promise<{ id: string; legal_name: string } | undefined> => (isUuid(id ?? "") ? (await db.query<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM parties WHERE id = $1 AND party_type <> 'borrower'`, [id]))[0] : undefined);
  const partner = (await partnerRow(String(lead["partner_id"] ?? ""))) ?? (await partnerRow(deps.defaultPartnerId)) ?? (deps.defaultPartnerId ? undefined : (await db.query<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM parties WHERE party_type = 'servicer' ORDER BY created_at DESC LIMIT 1`))[0]);
  if (!partner) { deps.logger?.error("borrower.flow.32-14.partner.unknown", { lead_id: s.lead_id }); return; }
  const state = typeof lead["consumer_state"] === "string" && lead["consumer_state"] ? String(lead["consumer_state"]) : typeof lead["property_state"] === "string" && lead["property_state"] ? String(lead["property_state"]) : null;
  const occupancy = OCCUPANCIES.has(String(lead["occupancy"] ?? "")) ? (String(lead["occupancy"]) as "primary" | "second_home" | "investment") : "primary";
  // an origination application the party already has whose interview has not started takes the goal; otherwise the application is created from the lead
  const existing = (await db.query<{ application_id: string; application_borrower_id: string }>(`SELECT ab.application_id, ab.id AS application_borrower_id FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE ab.party_id = $1 AND a.loan_id IS NULL ORDER BY a.created_at`, [s.party_id]))[0];
  let appId: string; let abId: string;
  if (existing) {
    if (await deps.runtime.entities.current("applications", existing.application_id)) return;   // its goal is set already (21.1's interview started)
    appId = existing.application_id; abId = existing.application_borrower_id;
  } else {
    const contact: P = {}; for (const k of ["email", "phone", "emails", "phones"]) if (party.contact?.[k] !== undefined) contact[k] = party.contact[k];
    // the application keeps the lead's id: 20.3's conversion (`lead.proceed` → explainProgram{convert} → application.received) names `applications.id = lead_id`, so 32.3's E6 cards watch the same application
    const created = await deps.runtime.createApplication({ id: s.lead_id, partner_party_id: partner.id, channel: "organic", transaction_type, occupancy, intake_channel: "web", interview_language: "en-US", borrowers: [{ legal_name: party.legal_name, borrower_role: "borrower", contact }], property: null }, INTAKE);
    appId = created.application.id; abId = created.application.borrowers[0]!.id;
    // the subject property is TBD — no address yet — in the state the visitor named (T7: "the property tbd with state AZ")
    if (state) await db.query(`INSERT INTO application_properties (application_id, state, is_subject) VALUES ($1, $2, true)`, [appId, state]);
    await parties.linkApplicationBorrower(abId, s.party_id);
  }
  // the estimates ride as a prefill only (32.3 T18: the value counts on the borrower's later Confirm), never as a captured six-item
  const prefill: P = {};
  for (const k of ["value_estimate_cents", "stated_existing_balance_cents", "price_range_cents", "down_payment_cents"]) { const v = centsOf(lead[k]); if (v !== null) prefill[k] = { value: v, source: "borrower", extracted_at: s.at, confirmed_at: null, lead_id: s.lead_id }; }
  if (Object.keys(prefill).length) await db.query(`UPDATE application_borrowers SET prefill = prefill || $2::jsonb WHERE id = $1`, [abId, toJson(prefill)]);
  // 21.1's interview opens on the application from the lead's facts (the goal, the occupancy, the state as the intake record's own fields; the estimate offered as a six-item prefill — 32.3 T18: it counts on the borrower's later Confirm). The Reg B request is NOT made here: `application.received` comes from 32.14 S4's Proceed (`lead.proceed` → 20.3 explainProgram{convert}), so S4's identity ask, soft pull and MLO review run first (DELTA-13) and 32.3's E6 cards wait for it (T14).
  try {
    if (!(await deps.runtime.entities.current("applications", appId))) await deps.runtime.execute({ process: "21.1", name: "startInterview", loanId: "", applicationId: appId, actor: INTAKE, run: { ...RUN },
      input: { application_id: appId, session_id: `lead:${s.session_id}`, partner_name: partner.legal_name, intake_channel: "web", channel: "web", creditor_time_zone: "America/New_York", interview_language: "en-US", property_state: state, transaction_type, occupancy, borrowers: [{ id: "B1", legal_name: party.legal_name }], started_at: s.at, model_version: RUN.modelVersion, prompt_version: RUN.promptVersion } });
    const estimate = centsOf(lead["value_estimate_cents"]) ?? centsOf(lead["price_range_cents"]);
    if (estimate !== null) await deps.runtime.execute({ process: "21.1", name: "confirmPrefill", loanId: "", applicationId: appId, actor: INTAKE, run: { ...RUN }, input: { application_id: appId, op: "offer", item: "property_value_estimate", value: estimate } });
  } catch (e) { deps.logger?.error("borrower.flow.32-14.interview", { lead_id: s.lead_id, application_id: appId, error: e instanceof Error ? e.message : String(e) }); }
  // S3 (ii): ONE receipt line instead of the goal card — after the session's disclosure line (3-entry ran first); its `answers` token is composed here from the lead's facts (the shell substitutes message copy tokens at render; the sentence never goes in body_text)
  await deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: s.at, sender: "agent", sender_ref: "agent:intake", channel: s.channel, body_text: RESUMED_LINE, subject_application_id: appId, voice_turn: s.channel === "voice", copy_tokens: { answers: resumedAnswers(lead, transaction_type, occupancy, state) } });
  deps.logger?.info("borrower.flow.32-14.resumed", { lead_id: s.lead_id, party_id: s.party_id, application_id: appId, transaction_type, occupancy, state });
}

// ---------------------------------------------------------------- T19: the inactivity sweep and the purge
/** SM_LEAD_INACTIVITY_EXPIRY_90 breach → 20.3 `explainProgram{op: expire}` per lead whose due day has passed (the Timer Engine's own `due_date`, re-checked against the lead's `expires_on`). */
export async function expireInactiveLeads(deps: FlowDeps, nowIso: string): Promise<string[]> {
  const expired: string[] = [];
  const due = await deps.runtime.db.query<{ subject_id: string; due_date: string | null }>(`SELECT DISTINCT subject_id, due_date::text AS due_date FROM timers WHERE code = $1 AND subject_kind = 'lead' AND status IN ('armed', 'breached') ORDER BY subject_id`, [LEAD_EXPIRY_TIMER]);
  for (const t of due) {
    const lead = await leadRecord(deps, t.subject_id); if (!lead) continue;
    if (["converted", "expired", "closed_lost"].includes(String(lead["status"])) || lead["application_id"]) continue;
    const today = civilDate(nowIso, String(lead["time_zone"] ?? "America/New_York"));
    const expiresOn = String(lead["expires_on"] ?? ""); const dueOn = t.due_date ?? expiresOn;
    if (!expiresOn || today < expiresOn || today < dueOn) continue;   // the lead's own clock, re-anchored by every consumer activity, decides
    try {
      await deps.runtime.execute({ process: "20.3", name: "explainProgram", loanId: "", actor: INTAKE, run: { ...RUN }, input: { op: "expire", lead_id: t.subject_id, on: today } });
      expired.push(t.subject_id);
    } catch (e) { deps.logger?.error("borrower.flow.32-14.expire", { lead_id: t.subject_id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return expired;
}

const REACTS = new Set(["lead.expired"]);
export const FLOW_14_ENTRY_LEAD: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events: readonly DomainEvent[]) {
    const tokens = new PgLeadTokenRepository(deps.runtime.db);
    for (const e of events) {
      if (e.type !== "lead.expired") continue;
      const leadId = String((e.payload as P)["lead_id"] ?? e.aggregate?.id ?? ""); if (!leadId) continue;
      const purged = await tokens.purgeByLead(leadId);
      deps.logger?.info("borrower.flow.32-14.lead_tokens.purged", { lead_id: leadId, purged });
    }
  },
  async tick(deps, nowIso) {
    await expireInactiveLeads(deps, nowIso);
    await new PgLeadTokenRepository(deps.runtime.db).purgeExpired(nowIso);
  },
  onSessionOpened: resumeFromLead,
};
