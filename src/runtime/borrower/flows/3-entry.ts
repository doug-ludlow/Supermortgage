/**
 * 32.3 — Entry and the five-minute qualification (spec/sections/32-borrower-experience/32-3-*.md): the borrower-facing
 * form of 20.3 (lead intake), 20.4 (pricing), 21.1 (the six items), 21.2 (the LE channel), 21.3 (score notices), 22.x
 * (identity, credit, income, documents), 23.x (DU, conditions, the preapproval decision). Every card here is created
 * through 32.1's `send_card` as the `intake` agent on the owning process's event; every borrower command runs through
 * the 32.2 command surface from a card; nothing here computes a regulatory date or a money figure — dates come from
 * `timers`, figures from the owning process's own rows.
 *
 *   session opened (any channel)                      the automation disclosure is the first assistant content (E2), then
 *                                                     20.3 lead.start / start interaction / lead.disclosure.delivered / lead.authenticated
 *   application.received                              the three E6 consents written on the tap that raised it (32.17 rule 20; a joint borrower's credit card stays), the ID and Truv ConnectCards (E5 / R3),
 *                                                     preapproval P1 ConfirmCard for a TBD purchase
 *   identity.verified                                 ConfirmCard {legal name, DOB, current address, how you live there, months there} from the Stripe extraction (E5; the tap writes the Current du_residences row)
 *   application.field.captured{current_address}       ConfirmCard {SSN} (E5) + ConfirmCard {prior residence} under two years (SQ-06) + ConfirmCard {your home} (R1)
 *   verification.received{income}                     ConfirmCard {income} from the FAKE Truv report (R3)
 *   application.six_item.captured{income}             ProfileCard (R4)
 *   application.field.captured{citizenship_status}    ChoiceCard {declarations} (R5)
 *   application.declarations.answered                 DemographicsCard (R6)
 *   card resolved (the borrower's own tap)            the next card of the R5 sequence — 5a.A's follow-ups, 5a.E, the thirteen-item list, SQ-05's questions one at a time — until the last tap runs application.answerDeclarations once (onCardResolved);
 *                                                     a re-sent gap card resolved with its command re-runs the assembly (32.18 rule 7; reassembleAfterGapCard)
 *   application.demographics.collected                ConfirmCards {value (AVM), loan amount}, ChoiceCard {product} (R7) / P8 for a TBD purchase
 *   application.trid_received                         StatusCard `application.received` (next: REGZ_1026_19E1_LE_3BD.due_at)
 *   credit.report.received (22.2)                     ConfirmCards {liabilities, current loan}; 21.3 score notices ingested and delivered (R2)
 *   credit.report.ordered after a report              StatusCard `credit.rerun.neutral` (T9)
 *   du.findings.received / .interpreted               StatusCard `du.running` / ChecklistCard of the borrower-visible conditions (R8)
 *   du.document.emitted{required_missing > 0}         32.18 rule 7: each gap the borrower supplies → its card re-sent (declarations / residence / home); a platform gap logged (gapCards, run by flows/18-du-gaps.ts after the other flows' cards of the settlement)
 *   terms.presentation.requested                      StatusCard `terms.pending_mlo` (next: SM_MLO_PREAPP_TERMS_REVIEW_1BH.due_at) + PersonCard (R9)
 *   mlo.review.completed{approved} / terms.presented  20.3 present → StatusCard `terms.presented` (personal terms: L2+)
 *   intent.to_proceed.rejected_premature              the `intent.too_early` line (R10)
 *   decision.issued{conditional_approval} on TBD      20.3 issue_preapproval_letter (DELTA-01) → preapproval.letter.issued → DocumentCard (P8)
 *   document.received{purchase_contract}              22.1 classify + FAKE extraction → ConfirmCard {contract} (C1)
 *   consent.esign.pending / .active                   the FAKE verification e-mail + the pending / active lines (E6)
 *   message "are you a real person?"                  20.3's T11 script, the disclosure re-logged (T2)
 *   message "send me the listing …" (preapproved)     the payment estimate on the approved quote, or MLO review first (P9, T28)
 */
import { createHash, randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { EntityStore } from "../../../app/tools.ts";
import { quoteValidAt, DISCLAIMER_TEMPLATE, DISCLAIMER_STATEMENT } from "../../../domain/leads-pricing/ops-20-4.ts";
import { esignVerificationToken } from "../../../app/tools/section32-2.ts";
import { RESIDENCY_BASIS_OPTIONS } from "../../../app/tools/residence.ts";
import { CLEAN_ENERGY_LIEN_OPTIONS, ESTATE_OPTIONS } from "../../../app/tools/property.ts";
import { deliverLoanEstimate, type LoanEstimateDeliveryInput } from "../../origination.ts";
import type { Runtime } from "../../app.ts";
import { timerLabel } from "../record.ts";
import { leadCarriesGoal } from "./14-entry-lead.ts";
import { isMonitoredOnly } from "./15-partner-book.ts";
import { entryPartner } from "../partner.ts";
import type { BorrowerFlow, FlowDeps, FlowReply, InboundMessage, SessionOpened } from "./index.ts";

export const FLOW_ID = "32.3";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" };
const VERIFICATION: Actor = { kind: "agent", id: "verification" };
const RUN = { runId: "flow:32.3", modelVersion: "borrower flows (deterministic)", promptVersion: "32.3" } as const;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** URLA Section 5 in plain language (R5): the thirteen declarations, versioned; "None of these apply" writes thirteen `false` with this hash as evidence (T14). */
export const DECLARATIONS_LIST_VERSION = "urla-2020-section5-plain-v1";
export const DECLARATIONS: readonly string[] = [
  "outstanding judgments against you", "delinquent or in default on a federal debt", "a party to a lawsuit that could affect your finances", "conveyed title in lieu of foreclosure in the past 7 years",
  "a pre-foreclosure or short sale in the past 7 years", "a foreclosure in the past 7 years", "a bankruptcy in the past 7 years", "borrowing money for the down payment or closing costs not shown on the application",
  "other new credit applied for that is not shown", "another mortgage or lien on the property not shown", "a co-signer or guarantor on any debt", "alimony, child support or separate maintenance obligations", "a relationship with the seller (purchase only)"];
export const DECLARATIONS_LIST_HASH = sha(`${DECLARATIONS_LIST_VERSION}\n${DECLARATIONS.join("\n")}`);
/** The credit-report authorization statement (E6); its hash is what `credit_authorizations.text_version_hash` records. */
export const CREDIT_AUTHORIZATION_TEXT = "I authorize the lender and Supermortgage on its behalf to obtain my consumer credit report from one or more consumer reporting agencies for this application (a hard inquiry).";
export const CREDIT_AUTHORIZATION_VERSION = "credit-authorization-2026-09";
export const CREDIT_AUTHORIZATION_HASH = sha(CREDIT_AUTHORIZATION_TEXT);
export const ESIGN_DISCLOSURE_VERSION = "NTC_ESIGN_7001C_DISCLOSURE";
export const ESIGN_SCOPE = ["disclosures", "notices"] as const;
/**
 * 32.17 rule 20 (decided 2026-09-13): the three E6 consents ride the goal. One statement under the goal card (and under 32.14's
 * Show me my rate); the tap that raises `application.received` is the affirmation of all three — no ConsentCard, no checkbox,
 * no typed name. Its hash is the E-SIGN and TCPA rows' text version; the credit sentence inside it keeps its own (CREDIT_AUTHORIZATION_HASH).
 */
export const CONSENTS_STATEMENT = `By continuing you agree to get your documents electronically (a code to your e-mail confirms it) and to texts about this application (reply STOP to end them), and you authorize the lender and Supermortgage on its behalf to obtain your consumer credit report from one or more consumer reporting agencies for this application (a hard inquiry). You can change any of these later from Your record.`;
export const CONSENTS_VERSION = "consents-on-goal-2026-09";
export const CONSENTS_HASH = sha(CONSENTS_STATEMENT);
/** The FAKE print vendor's mailing-date evidence (a mailed disclosure needs one — 21.2 / 21.3). */
export const fakeMailingProof = (ref: string): string => `PMV-FAKE-${ref}`;
/** DELTA-03: the FAKE property-data adapter — deterministic public-record figures for a listing (never a real record). */
export function fakePropertyPull(address: string): { taxes_annual_cents: string; hoa_monthly_cents: string; flood_status: string; vendor: "FAKE" } {
  const n = parseInt(sha(address).slice(0, 6), 16);
  return { taxes_annual_cents: String(360_000 + (n % 40) * 10_000), hoa_monthly_cents: n % 3 === 0 ? String(5_000 + (n % 20) * 1_000) : "0", flood_status: n % 7 === 0 ? "in a FEMA flood zone (FAKE determination)" : "not in a FEMA flood zone (FAKE determination)", vendor: "FAKE" };
}

// ---------------------------------------------------------------- the application context one batch works on
interface Party { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string; readonly prefill: Record<string, unknown> }
interface Ctx { readonly appId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly now: string; readonly app: AppRow | null; readonly property: PropertyRow | null; readonly lead: Record<string, unknown> | null }
interface AppRow { readonly id: string; readonly channel: string; readonly transaction_type: string; readonly occupancy: string; readonly partner_party_id: string; readonly partner_name: string }
interface PropertyRow { readonly address_line1: string | null; readonly city: string | null; readonly state: string | null; readonly postal_code: string | null; readonly property_type: string | null; readonly units: number | null; readonly estimated_value_cents: string | null; readonly estate_type: string | null; readonly existing_clean_energy_lien: boolean | null }
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const last = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);
const addressOf = (p: PropertyRow | null): string | null => (p?.address_line1 ? [p.address_line1, p.city, [p.state, p.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null);

async function context(deps: FlowDeps, appId: string): Promise<Ctx> {
  const [events, records, parties, apps, props] = await Promise.all([
    deps.runtime.uow.events.byApplication(appId),
    deps.runtime.entities.load({ applicationId: appId }),
    deps.runtime.db.query<Party & Record<string, unknown>>(`SELECT party_id, id AS application_borrower_id, legal_name, prefill FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at, id`, [appId]),
    deps.runtime.db.query<AppRow & Record<string, unknown>>(`SELECT a.id, a.channel::text AS channel, a.transaction_type::text AS transaction_type, a.occupancy::text AS occupancy, a.partner_party_id, p.legal_name AS partner_name FROM applications a JOIN parties p ON p.id = a.partner_party_id WHERE a.id = $1`, [appId]),
    deps.runtime.db.query<PropertyRow & Record<string, unknown>>(`SELECT address_line1, city, state, postal_code, property_type, units, estimated_value_cents::text AS estimated_value_cents, estate_type, existing_clean_energy_lien FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [appId])]);
  const store = new EntityStore(); store.seed(records);
  const lead = (store.get("leads", appId)?.data as P | undefined) ?? (store.list("leads", (d) => d.application_id === appId || parties.some((p) => p.party_id === d.party_id)).map((r) => r.data as P)[0] ?? null);
  return { appId, events, store, parties, now: deps.runtime.clock.now(), app: apps[0] ?? null, property: props[0] ?? null, lead };
}
/** 21.1's own borrower ids ("B1") map to the application_borrowers row by legal name (the intake record's borrowers list). */
function intakeBorrowerId(ctx: Ctx, party: Party): string {
  const intake = ctx.store.get("applications", ctx.appId)?.data as { borrowers?: { id: string; legal_name: string }[] } | undefined;
  const bs = intake?.borrowers ?? [];
  return bs.find((b) => b.legal_name === party.legal_name)?.id ?? bs[ctx.parties.findIndex((p) => p.party_id === party.party_id)]?.id ?? party.application_borrower_id;
}
function partiesFor(ctx: Ctx, borrowerId: unknown): readonly Party[] {
  if (typeof borrowerId !== "string" || !borrowerId) return ctx.parties;
  const own = ctx.parties.filter((p) => p.application_borrower_id === borrowerId || intakeBorrowerId(ctx, p) === borrowerId);
  return own.length ? own : ctx.parties;
}
/** 32.19 §2.2 (DELTA-36): the address the goal tap carries (`args.property.address` → setGoal → 21.1's intake record `property_address`) counts as the file's address for the reactions that ask whether the purchase is TBD — `propertyFacts` writes the subject row only on the home card's / confirmField's resolve, which on an addressed purchase follows the goal tap (21.1 refuses a capture before the interview is open). A TBD placeholder in the record (21.1 rule 2's forms) stays TBD. */
const intakeAddress = (ctx: Ctx): string | null => { const a = (ctx.store.get("applications", ctx.appId)?.data as P | undefined)?.["property_address"]; return typeof a === "string" && a.trim() !== "" && !/^\s*(tbd|to be determined|n\/?a)\s*$/i.test(a) ? a : null; };
const isTbd = (ctx: Ctx): boolean => !ctx.property?.address_line1 && !intakeAddress(ctx);
/** A refi-trigger lead (20.1/20.2 → 20.3's own consents, prequalification and conversion) arrives with its E1–E6 done by the owning process; this flow's asks are for the leads that open their application here (organic / referral). */
const asksHere = (ctx: Ctx): boolean => ctx.app?.channel !== "refi_trigger";
const isPurchase = (ctx: Ctx): boolean => ctx.app?.transaction_type === "purchase";
const leadId = (ctx: Ctx): string | null => (ctx.lead ? String(ctx.lead["lead_id"]) : null);

// ---------------------------------------------------------------- card and thread primitives (32.1's tools as the intake agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string; readonly flow_key: string; readonly informational?: boolean; readonly personal_terms?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
/** The party's assurance level as its sessions record it (01 §5): the highest level any of its sessions reached. */
export async function partyLevel(deps: FlowDeps, partyId: string): Promise<"L1" | "L2" | "L3" | null> {
  const r = (await deps.runtime.db.query<{ level: string | null }>(`SELECT max(level) AS level FROM sessions WHERE party_id = $1 AND revoked_at IS NULL`, [partyId]))[0];
  return (r?.level as "L1" | "L2" | "L3" | null) ?? null;
}
async function sendCard(deps: FlowDeps, ctx: Ctx, party: Party, c: CardSpec): Promise<string | null> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  // 01 §5 / T3: a card that renders personal terms is never created below L2 — the party steps up first
  if (c.personal_terms) { const level = await partyLevel(deps, party.party_id); if (level !== "L2" && level !== "L3") { deps.logger?.info("borrower.flow.32-3.level_gate", { party_id: party.party_id, flow_key: c.flow_key, level }); return null; } }
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID, ...(c.personal_terms ? { personal_terms: true } : {}) }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { application_id: ctx.appId }, created_by: "agent:intake",
      ...(c.personal_terms ? { personal_terms: true, mlo_review_approved: true } : {}), rationale: `32.3 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", ctx.now, { informational: true, resolved_by: "system:flow-32.3" });
  return id;
}
async function sendToAll(deps: FlowDeps, ctx: Ctx, c: CardSpec, parties: readonly Party[] = ctx.parties): Promise<string[]> { const ids: string[] = []; for (const p of parties) { const id = await sendCard(deps, ctx, p, c); if (id) ids.push(id); } return ids; }
const StatusCard = (copy_key: string, flow_key: string, props: P = {}, personal_terms = false): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true, personal_terms });
async function timerDue(deps: FlowDeps, appId: string, code: string): Promise<string | null> {
  const t = (await deps.runtime.db.query<{ due_at: string | null }>(`SELECT due_at FROM timers WHERE application_id = $1 AND code = $2 AND status IN ('armed', 'breached', 'satisfied', 'satisfied_late') ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
  return t?.due_at ?? null;
}
async function say(deps: FlowDeps, ctx: Ctx, party: Party, copy_key: string, extra: { channel?: "app" | "sms" | "email" | "voice"; card_instance_id?: string | null; body?: string } = {}): Promise<string> {
  const conv = await deps.ui.conversationFor(party.party_id);
  return deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: ctx.now, sender: "agent", sender_ref: "agent:intake", channel: extra.channel ?? "app", body_text: extra.body ?? `{{copy:${copy_key}}}`, card_instance_id: extra.card_instance_id ?? null, subject_application_id: ctx.appId, voice_turn: extra.channel === "voice" });
}
const exec = (deps: FlowDeps, appId: string | null, process: string, name: string, actor: Actor, input: P) => deps.runtime.execute({ process, name, loanId: "", ...(appId ? { applicationId: appId } : {}), actor, input, run: { ...RUN } });
const prefillOf = (party: Party, key: string): { value: string; source: string } | null => { const p = party.prefill?.[key] as { value?: unknown; source?: unknown } | undefined; return p && p.value !== undefined && p.value !== null ? { value: String(p.value), source: typeof p.source === "string" ? p.source : "borrower" } : null; };
/** 32.14 DELTA-15: the Phase I partner from configuration (`BORROWER_DEFAULT_PARTNER_ID` → a parties row); only when it is unset, the newest servicer party. Never an invented partner: null when neither exists (the lead is not started). */
export const partnerOf = async (deps: FlowDeps): Promise<{ id: string; legal_name: string } | null> => {
  // 32.14 DELTA-15 / docs/ux/17 §2.0: the configured partner, else the newest servicer party that is not Supermortgage itself (partner.ts) — never Supermortgage as the lender
  const partner = await entryPartner(deps.runtime.db, deps.defaultPartnerId);
  if (!partner) deps.logger?.error("borrower.flow.32-3.partner.unknown", { default_partner_id: deps.defaultPartnerId?.trim() ?? null });
  return partner;
};
const CHANNEL_20_3: Record<string, string> = { app: "web_chat", sms: "sms", voice: "voice_inbound" };
/** The session's auth method as 20.3's `authenticate{method}` (32.2 `party.authenticate` maps the platform's names); `oidc_google` (32.14 DELTA-12) is L1 like a code; `password` (32.16 DELTA-29) is L1 on the e-mail a code verified at account creation. */
const AUTH_20_3: Record<string, string> = { otp_phone: "otp_phone", otp_email: "otp_email", passkey: "passkey", oidc_google: "oidc_google", password: "otp_email", video: "otp_email" };   // 32.17: the video door's session — 20.3 knows no video method; the e-mail that follows is its credential
const cents = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v.toString() : String(v));

// ---------------------------------------------------------------- E1/E2/E4: the session hook (every channel; the disclosure first)
async function sessionOpened(deps: FlowDeps, s: SessionOpened): Promise<void> {
  const conv = await deps.ui.conversationFor(s.party_id);
  const subjects = await deps.runtime.db.query<{ application_id: string; id: string; legal_name: string }>(`SELECT application_id, id, legal_name FROM application_borrowers WHERE party_id = $1 ORDER BY created_at, id`, [s.party_id]);
  const appId = subjects[0]?.application_id ?? null;
  const app = appId ? (await deps.runtime.db.query<{ partner_party_id: string; partner_name: string; channel: string; consumer_state: string | null }>(`SELECT a.partner_party_id, p.legal_name AS partner_name, a.channel::text AS channel, (SELECT state FROM application_properties ap WHERE ap.application_id = a.id ORDER BY is_subject DESC, created_at LIMIT 1) AS consumer_state FROM applications a JOIN parties p ON p.id = a.partner_party_id WHERE a.id = $1`, [appId]))[0] ?? null : null;
  const partner = app ? { id: app.partner_party_id, legal_name: app.partner_name } : await partnerOf(deps);
  // E2: the automation disclosure is the first assistant content of the session — before any card, any line, any answer (T1).
  // 32.16 §2.0 (docs/ux/17 principle 8): on the app the row is the session's disclosure record with `sender: system` — the shell renders it as the header's AI tag, never a bubble; SMS sends it and voice reads it, so those channels keep the assistant line
  await deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: s.at, sender: s.channel === "app" ? "system" : "agent", sender_ref: "agent:intake", channel: s.channel, body_text: "{{copy:entry.disclosure.first}}", subject_application_id: appId, voice_turn: s.channel === "voice" });
  // 33.1 rule 5: a party whose every subject is a monitored loan (the partner book) gets the disclosure and nothing else here — no 20.3 lead, no organic application, no goal card; flows/15-partner-book.ts logs the activation
  if (await isMonitoredOnly(deps.runtime.db, s.party_id)) return;
  const store = new EntityStore(); store.seed(await deps.runtime.entities.load(appId ? { applicationId: appId } : {}));
  const existing = (appId ? store.get("leads", appId)?.data : undefined) ?? store.list("leads", (d) => d.party_id === s.party_id).map((r) => r.data)[0];
  const lead_id = existing ? String(existing["lead_id"]) : (appId ?? randomUUID());
  const interaction_id = randomUUID(); const channel = CHANNEL_20_3[s.channel] ?? "web_chat";
  if (app?.channel === "refi_trigger" && !existing) return;   // 20.1/20.2's lead: 20.3 delivered the disclosure on its own interaction (the journey); this session's line is the spoken/typed repeat only
  try {
    if (!existing && !partner) throw new Error("no partner: BORROWER_DEFAULT_PARTNER_ID is unset and no servicer party exists (32.14 DELTA-15)");
    if (!existing) await exec(deps, appId, "32.2", "lead.start", BORROWER_APP, { partner_id: partner!.id, partner_name: partner!.legal_name, party_id: s.party_id, lead_id, interaction_id, channel, lead_channel: app?.channel === "refi_trigger" ? "organic" : (app?.channel ?? "organic"), consumer_state: app?.consumer_state ?? null, time_zone: "America/New_York", session_id: s.session_id });
    else await exec(deps, appId, "20.3", "deliverDisclosure", INTAKE, { op: "start", lead_id, interaction_id, channel, ai: true });
    // E2: `lead.disclosure.delivered` + `consent.ai_disclosure.acknowledged` — logged on the render, no tap
    await exec(deps, appId, "32.2", "lead.acknowledgeAiDisclosure", BORROWER_APP, { lead_id, interaction_id, notice_id: `n-disc-${interaction_id.slice(0, 8)}`, party_id: s.party_id });
    // E4: `lead.authenticated{level=L1}` — the session itself is the API's (01 §5)
    await exec(deps, appId, "32.2", "party.authenticate", BORROWER_APP, { lead_id, method: AUTH_20_3[s.auth_method] ?? "otp_email", session_id: s.session_id, party_id: s.party_id });
  } catch (e) { deps.logger?.error("borrower.flow.32-3.session", { party_id: s.party_id, error: e instanceof Error ? e.message : String(e) }); }
  // 32.14 DELTA-11: a session opened on a lead cookie whose lead already carries a goal gets `entry.resumed` from flows/14-entry-lead.ts instead of the goal card
  if (s.lead_id && (await leadCarriesGoal(deps, s.lead_id))) return;
  // E3: the goal ChoiceCard for an application the lead opened itself (a refi-trigger lead arrives with its goal — 20.1/20.3 convert)
  if (appId && app && app.channel !== "refi_trigger") {
    const ctx = await context(deps, appId);
    if (!ctx.store.get("applications", appId) && ctx.app) {
      const me = ctx.parties.find((p) => p.party_id === s.party_id); if (!me) return;
      const borrowers = subjects.filter((x) => x.application_id === appId).map((b, k) => ({ id: `B${k + 1}`, legal_name: b.legal_name }));
      const property = ctx.property?.address_line1 ? { address: addressOf(ctx.property), state: ctx.property.state } : { tbd: true, state: ctx.property?.state ?? null };
      const base = { occupancy: ctx.app.occupancy, property, borrowers, time_zone: "America/New_York", partner_name: ctx.app.partner_name, property_state: ctx.property?.state ?? null, lead_id };
      // 32.17 rule 12: a session the video door opened has no name and no e-mail yet — the identity ConfirmCard is the first need (Michelle asks the name, then the e-mail; the tap writes both through video.identify), ahead of the goal
      if (s.auth_method === "video") await sendCard(deps, ctx, me, { kind: "ConfirmCard", copy_key: "identity.contact.title", flow_key: `identity.contact:${s.party_id}`, command_ref: "video.identify",
        props: { title: "", fields: [{ path: "legal_name", label: "Your name", value: "", source: "borrower" }, { path: "email", label: "E-mail address", value: "", source: "borrower" }], required_paths: ["legal_name", "email"], commits_to: "your account", needed_first: true, statement: "This is how we address you, and the address that gets you back into this conversation from any device." } });
      await sendCard(deps, ctx, me, { kind: "ChoiceCard", copy_key: "entry.goal.question", flow_key: `goal:${appId}`, command_ref: "application.setGoal",
        props: { title: "", statement: CONSENTS_STATEMENT, statement_version: CONSENTS_VERSION, options: [{ id: "buy", label: "Buy a home", is_primary: ctx.app.transaction_type === "purchase" }, { id: "lower_rate", label: "Lower my rate or payment", is_primary: ctx.app.transaction_type === "limited_cash_out" }, { id: "cash_out", label: "Take cash out", is_primary: ctx.app.transaction_type === "cash_out" }], command: "application.setGoal",
          command_args_by_option: { buy: { ...base, transaction_type: "purchase" }, lower_rate: { ...base, transaction_type: "limited_cash_out" }, cash_out: { ...base, transaction_type: "cash_out" } }, affirmatives: ["buy a home", "lower my rate", "take cash out"] } });
    }
  }
}

// ---------------------------------------------------------------- E6 / R3 / P1: the consent cards and the connectors on `application.received`
async function consentCards(deps: FlowDeps, ctx: Ctx): Promise<void> {
  const lead_id = leadId(ctx);
  // 32.17 rule 20: the consents ride the tap that raised application.received — the goal card (E3) or 32.14's Show me my rate — the statement was on that card; three rows written here, no ConsentCard, no typed name
  // (the card's own row may still be 'pending' here: its resolve commits after the command's events — the newest goal / proceed card is the one tapped)
  const tapped = (await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND copy_key IN ('entry.goal.question', 'entry.proceed.question') ORDER BY seq DESC LIMIT 1`, [ctx.appId]))[0] ?? null;
  const onTap = async (name: string, input: P): Promise<void> => {
    try { await deps.runtime.execute({ process: "32.2", name, loanId: "", applicationId: ctx.appId, actor: BORROWER_APP, run: { ...RUN }, input }); }
    catch (e) {
      // a refusal is kept on the tapped card (props.consents_errors) beside the log line: the record's reader and the tests see why a row is missing
      const error = e instanceof Error ? e.message : String(e); deps.logger?.error("borrower.flow.32-3.consent_on_tap", { name, kind: input["kind"] ?? null, application_id: ctx.appId, error });
      if (process.env["FLOW_DEBUG"]) process.stderr.write(`borrower.flow.32-3.consent_on_tap ${name} ${String(input["kind"] ?? "")} ${ctx.appId}: ${error}\n`);
      if (tapped) await deps.runtime.db.query(`UPDATE card_instances SET props = jsonb_set(props, '{consents_errors}', coalesce(props->'consents_errors', '[]'::jsonb) || $2::jsonb) WHERE card_instance_id = $1`, [tapped.card_instance_id, JSON.stringify([{ name, kind: input["kind"] ?? null, party_id: input["party_id"], error: error.slice(0, 500) }])]);
    }
  };
  for (const party of ctx.parties) {
    // once per party and application: application.received can fire more than once (the goal, then a preapproval request) and its reactions can overlap —
    // the tapped card takes an atomic marker (its props) for the party; without a card, the party's own E-SIGN row is the marker
    const claimed = tapped
      ? (await deps.runtime.db.query(`UPDATE card_instances SET props = props || $2::jsonb WHERE card_instance_id = $1 AND NOT (props ? $3) RETURNING card_instance_id`, [tapped.card_instance_id, JSON.stringify({ [`consents_written:${party.party_id}`]: ctx.now }), `consents_written:${party.party_id}`])).length > 0
      : (await deps.runtime.db.query(`SELECT 1 FROM consents WHERE party_id = $1 AND application_id = $2 AND kind = 'esign'`, [party.party_id, ctx.appId])).length === 0;
    if (claimed) {
      const common: P = { party_id: party.party_id, application_id: ctx.appId, method: "single_tap", channel: "app", text_hash: CONSENTS_HASH, purpose: "informational", ...(tapped ? { card_instance_id: tapped.card_instance_id } : {}) };
      // E-SIGN: 7.4's row, pending the e-mailed code (the old card carried no lead_id either: 20.3's own esign row is the demonstration test's, 32.4-T1)
      await onTap("consent.capture", { ...common, kind: "esign", scope: [...ESIGN_SCOPE], disclosure_version_id: ESIGN_DISCLOSURE_VERSION });
      // TCPA for texts about this application: 7.4's row; 20.3's lead consent needs a number, which the borrower has not given yet (the old card carried none either)
      await onTap("consent.capture", { ...common, kind: "tcpa_sms", scope: ["informational"], disclosure_version_id: "NTC_TCPA_CONSENT_CONFIRMATION" });
      // the hard-pull authorization: the statement's own sentence, its text version the authorization's; a joint application's borrowers authorize after joint intent (32.5 §7) — their card stays
      if (ctx.parties.length === 1) await onTap("credit.authorize", { party_id: party.party_id, application_id: ctx.appId, kind: "hard_pull", text_hash: CREDIT_AUTHORIZATION_HASH, authorization_kind: "hard_application", assurance_level: "L1", channel: "app", ...(tapped ? { card_instance_id: tapped.card_instance_id } : {}), ...(lead_id ? { lead_id } : {}) });
      else await creditCard(deps, ctx, party, lead_id);
    }
    await connectorCards(deps, ctx, party);
  }
  if (isPurchase(ctx) && isTbd(ctx)) {
    await sendToAll(deps, ctx, StatusCard("preapproval.intro", `preapproval.intro:${ctx.appId}`, { copy_tokens: {} }));
    await sendToAll(deps, ctx, { kind: "ConfirmCard", copy_key: "preapproval.where", flow_key: `preapproval.where:${ctx.appId}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "state", label: "State you're buying in", value: ctx.property?.state ?? "", source: "borrower" }, { path: "price_min_cents", label: "Price range — low", value: "", source: "borrower" }, { path: "price_max_cents", label: "Price range — high", value: "", source: "borrower" }, { path: "down_payment_cents", label: "Down payment", value: "", source: "borrower" }, { path: "first_time_buyer", label: "First-time buyer?", value: "yes", source: "borrower" }],
        commits_to: "prequalifications", money_paths: ["price_min_cents", "price_max_cents", "down_payment_cents"], required_paths: ["state", "price_min_cents", "price_max_cents", "down_payment_cents"], command_args: { path: "preapproval.where", commits_to: "prequalifications", ...(lead_id ? { lead_id } : {}) } } });
  }
}
/** The hard-pull ConsentCard for a borrower on a joint application (32.5 §7: after joint intent) — the one E6 card that is still a card. */
async function creditCard(deps: FlowDeps, ctx: Ctx, party: Party, lead_id: string | null): Promise<void> {
  await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.credit.title", flow_key: `consent.credit:${party.party_id}`, command_ref: "credit.authorize",
    props: { consent_kind: "credit_authorization", disclosure_version_id: CREDIT_AUTHORIZATION_VERSION, scope: ["hard_pull"], affirmation_method: "checkbox_with_text", title: "", body_text: CREDIT_AUTHORIZATION_TEXT, requires_typed_name: true, verification_state: "none",
      command_args: { kind: "hard_pull", text_hash: CREDIT_AUTHORIZATION_HASH, authorization_kind: "hard_application", ...(lead_id ? { lead_id } : {}) } } });
}
/** E5 / R3: the connectors — the ID scan and the payroll connection, cards that finish on the tap (32.17 rule 19). */
async function connectorCards(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  const lead_id = leadId(ctx);
    // 32.17 rule 19 / E5: the ID scan is a card of its own — "Verify with Stripe Identity" — sent with the consents; the vendor session runs on this card (routes identitySession), never a second one; no command of its own: the vendor's settlement resolves it
    await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "identity.stripe.purpose", flow_key: `connect.identity:${party.party_id}`,
      props: { vendor: "stripe_identity", purpose_text: "", what_we_get: ["your name", "date of birth", "the address on your ID"], fallback: { label: "Upload a photo of your ID instead", document_class: "drivers_license" }, state: "not_started", vendor_fake: "FAKE" } });
    // R3: the payroll connector — free to the borrower and optional before the LE (fee_paid_by=sm opens REGZ_1026_19E2_INTENT_FEE_GATE for it)
    await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "income.connect.purpose", flow_key: `connect.income:${party.party_id}`, command_ref: "verification.connect",
      props: { vendor: "truv_income", purpose_text: "", what_we_get: ["employer", "start date", "pay frequency", "base and variable pay", "year-to-date"], fallback: { label: "Type your monthly income now; we'll ask for paystubs later", document_class: "paystub" }, state: "not_started", pre_intent_optional: true, vendor_fake: "FAKE", command_args: { vendor: "truv_income", component: "income", fee_paid_by: "sm", ...(lead_id ? { lead_id } : {}) } } });
    // 32.18 rule 1: the assets connection rides with the connectors — a 365-day DU validation service report (assets, employment and income validated from one place); no command of its own: the vendor's settlement (routes assetsSession / settleAssets) writes the report
    await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "assets.connect.purpose", flow_key: `connect.assets:${party.party_id}`,
      props: { vendor: "plaid_assets", purpose_text: "", what_we_get: ["balances", "twelve months of deposits"], fallback: { label: "Send two months of statements per account instead", document_class: "bank_statement" }, state: "not_started", pre_intent_optional: true, vendor_fake: "FAKE" } });
}

// ---------------------------------------------------------------- 32.18 rule 2: the credit pull is the platform's — on the hard-pull authorization and the SSN, once
const CREDIT_ORDER = { permissible_purpose: "credit_transaction_604a3A", certification_ref: process.env["CREDIT_CERTIFICATION_REF"] ?? "CERT-PARTNER-FAKE-2026", subscriber_code: process.env["CREDIT_SUBSCRIBER_CODE"] ?? "SUB-PARTNER-FAKE" } as const;
async function creditPull(deps: FlowDeps, ctx: Ctx): Promise<void> {
  if (has(ctx, "credit.report.ordered") || has(ctx, "credit.report.received")) return;
  if (!has(ctx, "application.trid_received")) return;   // 22.2 R1 / §1026.19(e)(2)(i)(B): no hard pull before the six items (the fee is SM-borne — the other half of SIX_ITEMS_AND_FEE_FIRST)
  const intake = ctx.store.get("applications", ctx.appId)?.data as P | undefined; const borrowers = (intake?.["borrowers"] as P[] | undefined) ?? [];
  const ssnOnFile = has(ctx, "application.six_item.captured", (x) => x["item"] === "ssn") || (await deps.runtime.db.query(`SELECT 1 FROM application_borrowers WHERE application_id = $1 AND tin_last4 IS NOT NULL`, [ctx.appId])).length > 0;
  if (!ssnOnFile) return;
  // the hard-pull authorization the goal's tap wrote (32.17 rule 20 → 20.3 captureConsent): on the lead record's credit_authorizations[]
  const authorizations = Array.isArray(ctx.lead?.["credit_authorizations"]) ? (ctx.lead!["credit_authorizations"] as P[]) : [];
  const authz = authorizations.filter((a) => a["kind"] === "hard_application").map((a) => String(a["authorization_id"])).at(-1);
  if (!authz) return;
  const borrower_ids = borrowers.map((b) => String(b["id"])).filter(Boolean);
  if (!borrower_ids.length) return;
  try {
    const order = await exec(deps, ctx.appId, "22.2", "orderCreditReport", VERIFICATION, { application_id: ctx.appId, borrower_ids, ...CREDIT_ORDER, borrower_authorization_ref: authz, fee_sm_borne: true });
    const reportId = String((order.output as P)["report_id"]);
    await exec(deps, ctx.appId, "22.2", "parseCreditReport", VERIFICATION, { application_id: ctx.appId, report_id: reportId });
    deps.logger?.info("borrower.flow.32-18.credit.ordered", { application_id: ctx.appId, report_id: reportId, borrower_ids, authorization_id: authz });
  } catch (err) { deps.logger?.warn("borrower.flow.32-18.credit.refused", { application_id: ctx.appId, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code ?? null }); }
}

// ---------------------------------------------------------------- 32.18 rule 3: the DU moment — the last prerequisite runs underwriting.run once
async function duMoment(deps: FlowDeps, ctx: Ctx): Promise<void> {
  if (!has(ctx, "application.trid_received")) return;
  if (has(ctx, "du.casefile.created") || has(ctx, "du.submitted")) return;
  const report = ctx.store.list("credit_reports", (d) => d["application_id"] === ctx.appId && d["state"] === "usable").at(-1); if (!report) return;
  const intake = ctx.store.get("applications", ctx.appId)?.data as P | undefined;
  const incomeOnFile = (await deps.runtime.db.query(`SELECT 1 FROM application_income WHERE application_id = $1`, [ctx.appId])).length > 0 || has(ctx, "verification.received", (x) => x["kind"] === "income") || (typeof intake?.["income_monthly_cents"] === "string" && intake["income_monthly_cents"] !== "");
  if (!incomeOnFile) return;
  // the assets card settled: connected, or no assets card pending (declined / never sent); a pending one is the current ask and DU waits for it
  const assetsPending = (await deps.runtime.db.query(`SELECT 1 FROM card_instances WHERE subject_application_id = $1 AND kind = 'ConnectCard' AND props->>'vendor' = 'plaid_assets' AND status = 'pending'`, [ctx.appId])).length > 0;
  if (assetsPending) return;
  try {
    const r = await exec(deps, ctx.appId, "32.18", "underwriting.run", BORROWER_APP, { application_id: ctx.appId });
    deps.logger?.info("borrower.flow.32-18.du.ran", { application_id: ctx.appId, ...(r.output as P), events: r.events.map((e) => e.type) });
  } catch (err) { deps.logger?.warn("borrower.flow.32-18.du.refused", { application_id: ctx.appId, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code ?? null, ...(process.env["FLOW_DEBUG"] && err instanceof Error && err.stack ? { stack: err.stack.split("\n").slice(0, 6).join(" | ") } : {}) }); }
}

// ---------------------------------------------------------------- 32.18 rule 7: a gap the borrower supplies becomes the card; a gap the platform holds is derived, never asked
/**
 * 23.6 assembles with `conditionality = report` and names every required data point it could not fill on
 * `du.document.emitted{required_missing, gaps[{code, path}]}`; 23.7's preflight runs on the same emission (23.1 buildDuRequest) and a
 * refusal is `du.preflight.refused{code, xpath, rule}` — one XPath, mapped the same way (23.7 Open question 1: a refusal that maps to a
 * borrower ask goes to the rail directly, never through 23.2). Each gap's XPath maps to the card that collects it, (re)sent as the current ask under a flow_key suffixed by the
 * emission, so one emission sends one card and a later emission with the same gap sends a fresh one:
 *   BORROWER/DECLARATION/*                                        → the declarations sequence's first card (32.3 R5), for the PARTY the path names
 *   BORROWER/RESIDENCES/*                                         → the address confirm card with its basis (32.3 E5; the identity command path)
 *   SUBJECT_PROPERTY/PROPERTY_DETAIL/PropertyEstateType | PropertyExistingCleanEnergyLienIndicator → the home card (32.3 R1)
 * Every other gap is the platform's — LastName from the legal name, TAXPAYER_IDENTIFIER from the typed SSN, StateCode and AttachmentType
 * from the confirmed home — and is logged (`borrower.flow.32-18.gap.platform`), never asked. Michelle's line beside the card is the copy
 * library's `application.gap.resend`; nothing here names what runs behind it. When a re-sent card resolves with its command and the application
 * already has a casefile, the assembly re-runs on that resolution (reassembleAfterGapCard → underwriting.run{reassemble}: a further
 * du.document.emitted, 23.7's preflight on it, the gaps still open re-sent under the new emission); the resubmission itself is 23.1's.
 * The reaction runs from flows/18-du-gaps.ts, registered after the flows whose cards ride the same settlement (5-verification's needs checklist
 * on `du.findings.interpreted`), so the re-sent card is the newest pending one — the rail's current ask (01 §1.3).
 */
const GAP_DECLARATION = /\/ROLES\/ROLE\/BORROWER\/DECLARATION\//;
const GAP_RESIDENCE = /\/ROLES\/ROLE\/BORROWER\/RESIDENCES\//;
const GAP_HOME = /\/SUBJECT_PROPERTY\/PROPERTY_DETAIL\/(?:PropertyEstateType|PropertyExistingCleanEnergyLienIndicator)$/;
const PARTY_INDEX = /\/PARTIES\/PARTY(?:\[(\d+)\])?\//;
const BORROWING_ROLES = `('borrower', 'co_borrower', 'non_occupant_co_borrower')`;
interface Gap { readonly code: string; readonly path: string }
/** The gaps an emission names (`gaps[{code, path | xpath}]`), or the one a preflight refusal names (23.7 emitDuPreflight: `{code, xpath, rule, detail}`). */
function gapsOf(e: DomainEvent): Gap[] {
  const p = pl(e);
  if (e.type === "du.preflight.refused") return typeof p["xpath"] === "string" ? [{ code: String(p["code"] ?? "DU_PREFLIGHT_REFUSED"), path: p["xpath"] }] : [];
  const list = Array.isArray(p["gaps"]) ? (p["gaps"] as P[]) : [];
  return list.map((g) => ({ code: String(g["code"] ?? "DU_REQUIRED_MISSING"), path: String(g["path"] ?? g["xpath"] ?? "") })).filter((g) => g.path);
}
/** The 32.18 rule 7 reaction as flows/18-du-gaps.ts runs it: one context per application, the gaps of every emission (and every preflight refusal) in commit order. */
export async function reactDuGaps(deps: FlowDeps, events: readonly DomainEvent[]): Promise<void> {
  const byApp = new Map<string, DomainEvent[]>();
  for (const e of events) { const app = e.applicationId ?? (typeof pl(e)["application_id"] === "string" ? String(pl(e)["application_id"]) : null); if (!app) continue; const list = byApp.get(app) ?? []; list.push(e); byApp.set(app, list); }
  for (const [appId, list] of byApp) {
    const ctx = await context(deps, appId);
    if (!ctx.parties.length || !asksHere(ctx)) continue;   // no conversation to put a card in; a refi-trigger lead's cards are 32.11's (its home card shares the flow_key, so a gap there is 32.11's to re-send)
    for (const e of list) { if (e.type === "du.document.emitted" && !(Number(pl(e)["required_missing"] ?? 0) > 0)) continue; try { await gapCards(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-18.gap.failed", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
  }
}
async function gapCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const gaps = gapsOf(e); if (!gaps.length) return;
  const emission = String(pl(e)["du_document_id"] ?? e.id).replace(/-/g, "").slice(0, 8);
  // PARTY[n] is the nth borrowing party in 23.6's order (projectGraph: borrower_ordinal, then created_at); a path with no index names the only one
  const ordered = await deps.runtime.db.query<{ id: string }>(`SELECT id::text AS id FROM application_borrowers WHERE application_id = $1 AND borrower_role IN ${BORROWING_ROLES} ORDER BY borrower_ordinal, created_at, id`, [ctx.appId]);
  const partiesAt = (path: string): readonly Party[] => { const n = PARTY_INDEX.exec(path)?.[1]; const ab = n ? ordered[Number(n) - 1]?.id : ordered.length === 1 ? ordered[0]!.id : null; const own = ab ? ctx.parties.filter((p) => p.application_borrower_id === ab) : ctx.parties; return own.length ? own : ctx.parties; };
  // one card per gap and party (rule 7): a sequence still open under any of the party's prefixes — the interview's `declarations.<step>:<ab>`, an invitee's `cob.declarations.<step>:<party>` (32.5 §7), an earlier emission's `…:gap:<emission>` — is the current ask already
  const pendingLike = async (party: Party, prefixes: readonly string[]): Promise<boolean> => (await deps.runtime.db.query(`SELECT 1 FROM card_instances WHERE party_id = $1 AND status = 'pending' AND props->>'flow_key' LIKE ANY ($2::text[])`, [party.party_id, prefixes.map((p) => `${p}%`)])).length > 0;
  const resent = new Map<string, string[]>();   // party_id → the cards sent for this emission (the line is said once per party, beside the first)
  const resend = async (party: Party, ask: "declarations" | "residence" | "home", spec: CardSpec, pendingPrefixes: readonly string[]): Promise<void> => {
    if (resent.get(party.party_id)?.includes(ask)) return;
    if (await pendingLike(party, pendingPrefixes)) { deps.logger?.info("borrower.flow.32-18.gap.pending", { application_id: ctx.appId, party_id: party.party_id, ask }); return; }
    if (await existingCard(deps, party.party_id, spec.flow_key)) return;   // this emission's card is already on the rail (a delivery replayed)
    const id = await sendCard(deps, ctx, party, spec); if (!id) return;
    const first = !resent.has(party.party_id); resent.set(party.party_id, [...(resent.get(party.party_id) ?? []), ask]);
    if (first) await say(deps, ctx, party, "application.gap.resend", { card_instance_id: id });
    deps.logger?.info("borrower.flow.32-18.gap.card", { application_id: ctx.appId, party_id: party.party_id, ask, card_instance_id: id, emission });
  };
  for (const gap of gaps) {
    if (GAP_DECLARATION.test(gap.path)) {
      // an invited co-borrower's sequence runs under `cob.declarations.<step>:<party_id>` (32.5 §7 / 5-verification.ts) and is resolved only by the invitee: the re-sent card keeps that prefix, and either prefix pending is the open sequence
      for (const party of partiesAt(gap.path)) { const seq = declarationsSeqOf(ctx, party); await resend(party, "declarations", firstDeclarationsCard({ prefix: seq.prefix, key: `${seq.key}:gap:${emission}`, borrower_id: intakeBorrowerId(ctx, party) }), [`declarations.%:${party.application_borrower_id}`, `cob.declarations.%:${party.party_id}`]); }
    } else if (GAP_RESIDENCE.test(gap.path)) {
      for (const party of partiesAt(gap.path)) await resend(party, "residence", residenceCard(ctx, party, `identity.confirm:${party.application_borrower_id}:gap:${emission}`), [`identity.confirm:${party.application_borrower_id}`]);
    } else if (GAP_HOME.test(gap.path)) {
      for (const party of ctx.parties) await resend(party, "home", homeCard(ctx, party, `refi.home:${party.application_borrower_id}:gap:${emission}`), [`refi.home:${party.application_borrower_id}`]);
    } else {
      deps.logger?.info("borrower.flow.32-18.gap.platform", { application_id: ctx.appId, code: gap.code, path: gap.path, emission });
    }
  }
}
/** The declarations sequence's flow-key prefix and party key for a party: `cob.declarations:<party_id>` for an invited co-borrower (32.5 §7, `application.party.invited`), `declarations:<application_borrower_id>` for the interview's own borrowers. */
function declarationsSeqOf(ctx: Ctx, party: Party): { prefix: string; key: string } {
  const invited = has(ctx, "application.party.invited", (p) => p["party_id"] === party.party_id);
  return invited ? { prefix: "cob.declarations", key: party.party_id } : { prefix: "declarations", key: party.application_borrower_id };
}
/** The address confirm card re-sent for the residence basis (32.3 E5): the ID's name, birth date and address when the scan read them, else the address asked; the residence asks; the identity command path. */
function residenceCard(ctx: Ctx, party: Party, flowKey: string): CardSpec {
  const name = prefillOf(party, "legal_name"); const dob = prefillOf(party, "date_of_birth"); const addr = prefillOf(party, "current_address") ?? prefillOf(party, "address");
  const residence = RESIDENCE_FIELDS();
  return { kind: "ConfirmCard", copy_key: "identity.confirm.title", flow_key: flowKey, command_ref: "application.confirmField",
    props: { title: "", fields: [...(name ? [{ path: "legal_name", label: "Legal name", value: name.value, source: name.source }] : []), ...(dob ? [{ path: "date_of_birth", label: "Date of birth", value: dob.value, source: dob.source }] : []), { path: "current_address", label: "Current address", value: addr?.value ?? "", source: addr?.source ?? "borrower" }, ...residence.fields], commits_to: "application_borrowers",
      required_paths: ["current_address", ...residence.required_paths], money_paths: residence.money_paths, required_when: residence.required_when, helper_copy_key: "identity.residence.why",
      command_args: { path: "identity", commits_to: "application_borrowers", application_borrower_id: party.application_borrower_id, ...(leadId(ctx) ? { lead_id: leadId(ctx) } : {}) } } };
}

// ---------------------------------------------------------------- E5: identity → confirm (with the residence basis and the months), then the SSN, then R1; SQ-06 under two years
/**
 * 32.3 E5 / 23.5 discrepancy 3: DU needs the current residence with its basis on every casefile, so the identity card asks how the borrower lives there
 * (Own · Rent with the monthly rent · Living rent-free) and the months at the address on every file; the tap's command (application.confirmField{path=identity})
 * writes the Current du_residences row. `prefix` builds the same three asks for the prior-residence card (SQ-06). The rent field shows only when Rent is chosen
 * (`when`), and the API requires it then (`required_when`); `input` and `options` are what the borrower app renders and what 32.16's proposal validation reads.
 */
export const RESIDENCE_FIELDS = (prefix = ""): { fields: P[]; required_paths: string[]; money_paths: string[]; required_when: P } => ({
  fields: [
    { path: `${prefix}residency_basis`, label: prefix ? "How you lived there" : "How you live there", value: "", source: "borrower", options: RESIDENCY_BASIS_OPTIONS },
    { path: `${prefix}monthly_rent_cents`, label: "Monthly rent", value: "", source: "borrower", input: "money", when: { path: `${prefix}residency_basis`, equals: "rent" } },
    { path: `${prefix}months_at_address`, label: prefix ? "Months you lived there" : "Months at this address", value: "", source: "borrower", input: "number" },
  ],
  required_paths: [`${prefix}residency_basis`, `${prefix}months_at_address`], money_paths: [`${prefix}monthly_rent_cents`], required_when: { [`${prefix}monthly_rent_cents`]: { path: `${prefix}residency_basis`, equals: "rent" } },
});
/** 32.13 SQ-06: under two years at the current address — the stated months on the E5 card (`du_residences.duration_months` of the borrower's Current row). */
export const SQ06_UNDER_MONTHS = 24;
async function identityCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const abId = String(pl(e)["borrower_id"] ?? "");
  for (const party of ctx.parties.filter((p) => p.application_borrower_id === abId)) {
    const name = prefillOf(party, "legal_name"); const dob = prefillOf(party, "date_of_birth"); const addr = prefillOf(party, "address") ?? prefillOf(party, "current_address");
    if (!name || !dob || !addr) continue;
    const residence = RESIDENCE_FIELDS();
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.confirm.title", flow_key: `identity.confirm:${party.application_borrower_id}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "legal_name", label: "Legal name", value: name.value, source: name.source }, { path: "date_of_birth", label: "Date of birth", value: dob.value, source: dob.source }, { path: "current_address", label: "Current address", value: addr.value, source: addr.source }, ...residence.fields], commits_to: "application_borrowers",
        required_paths: residence.required_paths, money_paths: residence.money_paths, required_when: residence.required_when, helper_copy_key: "identity.residence.why",
        command_args: { path: "identity", commits_to: "application_borrowers", application_borrower_id: party.application_borrower_id, ...(leadId(ctx) ? { lead_id: leadId(ctx) } : {}) } } });
  }
}
/**
 * SQ-06 residence history (32.13; 32.3 E5): under two years at the current address → `ConfirmCard{prior address, how you lived there, months there}` → a Prior
 * du_residences row through application.confirmField{path=prior_residence}. The trigger today is the months the borrower stated on the E5 card, read from the
 * Current du_residences row the confirm's own transaction wrote (22.2's credit report exposes no address-tenure fact on the bus yet; when it does, a report
 * showing less than the stated months is the second trigger the spec names — the same card, the same flow_key).
 */
async function priorResidenceCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  const current = (await deps.runtime.db.query<{ duration_months: number }>(`SELECT duration_months FROM du_residences WHERE application_borrower_id = $1 AND residency_type = 'Current'`, [party.application_borrower_id]))[0];
  if (!current || Number(current.duration_months) >= SQ06_UNDER_MONTHS) return;
  const residence = RESIDENCE_FIELDS("prior_");
  await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.prior_residence.title", flow_key: `identity.prior_residence:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", fields: [{ path: "prior_address_line", label: "Street address", value: "", source: "borrower" }, { path: "prior_city", label: "City", value: "", source: "borrower" }, { path: "prior_state", label: "State", value: "", source: "borrower" }, { path: "prior_postal_code", label: "ZIP code", value: "", source: "borrower", input: "number" }, ...residence.fields], commits_to: "du_residences",
      required_paths: ["prior_address_line", "prior_city", "prior_state", "prior_postal_code", ...residence.required_paths], money_paths: residence.money_paths, required_when: residence.required_when, helper_copy_key: "identity.prior_residence.why",
      command_args: { path: "prior_residence", commits_to: "du_residences", application_borrower_id: party.application_borrower_id, ...(leadId(ctx) ? { lead_id: leadId(ctx) } : {}) } } });
}
async function afterIdentity(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const borrowerId = pl(e)["borrower_id"];
  for (const party of partiesFor(ctx, borrowerId)) {
    const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
    // the one typed field: masked, stored once, never echoed (masked_paths keeps it out of the evidence trail)
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.ssn.title", flow_key: `identity.ssn:${party.application_borrower_id}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "ssn", label: "Social Security number", value: "", source: "borrower" }], commits_to: "application_borrowers", masked_paths: ["ssn"], required_paths: ["ssn"], helper_copy_key: "identity.ssn.why", gate: "FNMA_B2_2_01_SSN_VALIDATION_GATE", command_args: { path: "ssn", source: "borrower", ...lead } } });
    await priorResidenceCard(deps, ctx, party);   // SQ-06: the address history when the stay at the current address is under two years (after the SSN card — the credit pull's one typed field stays the next ask)
    if (!isPurchase(ctx)) await sendCard(deps, ctx, party, homeCard(ctx, party, `refi.home:${party.application_borrower_id}`));
  }
}
/**
 * 32.3 R1 / 32.18 rule 7: the home card — the address (the ID's, or the row's), the type and units from the record, "your primary home", and the two
 * facts only the borrower gives, asked on every file: the estate (own the land · a leasehold → PropertyEstateType) and a PACE / clean-energy loan on
 * the home (→ PropertyExistingCleanEnergyLienIndicator). Both are required before Confirm; the tap's command (application.confirmField{path=property_address})
 * writes them and the parsed address to the subject application_properties row (0137). The same spec is re-sent under a fresh flow_key when 23.6's
 * assembly names either as a gap (gapCards).
 */
function homeCard(ctx: Ctx, party: Party, flowKey: string): CardSpec {
  const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
  const confirmed = prefillOf(party, "current_address") ?? prefillOf(party, "address"); const address = confirmed?.value ?? addressOf(ctx.property) ?? "";
  const lien = ctx.property?.existing_clean_energy_lien; const lienValue = lien === true ? "yes" : lien === false ? "no" : "";
  return { kind: "ConfirmCard", copy_key: "refi.home.confirm", flow_key: flowKey, command_ref: "application.confirmField",
    props: { title: "", fields: [{ path: "property_address", label: "Property address", value: address, source: confirmed?.source ?? "stripe_identity" }, { path: "property_type", label: "Property type", value: ctx.property?.property_type ?? "sfr", source: "public_records" }, { path: "units", label: "Units", value: String(ctx.property?.units ?? 1), source: "public_records" }, { path: "occupancy", label: "Your primary home", value: ctx.app?.occupancy ?? "primary", source: "borrower" },
      ...HOME_ASKS(ctx.property?.estate_type ?? "", lienValue)], commits_to: "application_properties", required_paths: ["property_address", "estate_type", "existing_clean_energy_lien"], helper_copy_key: "refi.home.why",
      command_args: { path: "property_address", commits_to: "application_properties", ...lead } } };
}
/** The two asks of the home card (and of the purchase contract card; 32.11's compressed home card too): a select each, the copy library's `refi.home.estate` / `refi.home.clean_energy_lien`. */
export const HOME_ASKS = (estate: string, lien: string): P[] => [
  { path: "estate_type", label: "Do you own the land, or is it a leasehold?", value: estate, source: "borrower", options: ESTATE_OPTIONS },
  { path: "existing_clean_energy_lien", label: "Is there a PACE or clean-energy loan on the home?", value: lien, source: "borrower", options: CLEAN_ENERGY_LIEN_OPTIONS },
];

// ---------------------------------------------------------------- R3: the FAKE Truv report → the income ConfirmCard
async function incomeCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["kind"] !== "income") return;
  const ref = String(p["report_reference_id"] ?? ""); const verificationId = String(p["verification_id"] ?? "");
  const rows = await deps.runtime.db.query<{ party_id: string; evidence: P | null; props: P }>(`SELECT party_id, evidence, props FROM card_instances WHERE subject_application_id = $1 AND kind = 'ConnectCard' AND (evidence->>'report_reference_id' = $2 OR props->>'report_reference_id' = $2) ORDER BY created_at DESC LIMIT 1`, [ctx.appId, ref]);
  const report = ((rows[0]?.evidence?.["report"] ?? rows[0]?.props["report"]) as P | undefined) ?? {};
  const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
  for (const party of partiesFor(ctx, p["borrower_id"]).filter((x) => !rows[0] || x.party_id === rows[0].party_id)) {
    const employer = String(report["employer"] ?? "your employer");
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "income.confirm.title", flow_key: `income.confirm:${verificationId || ref}`, command_ref: "application.confirmField",
      props: { title: "", copy_tokens: { employer }, fields: [{ path: "employer", label: "Employer", value: employer, source: "payroll_connection" }, { path: "position", label: "Position", value: String(report["position"] ?? ""), source: "payroll_connection" }, { path: "start_date", label: "Start date", value: String(report["start_date"] ?? ""), source: "payroll_connection" }, { path: "pay_frequency", label: "Pay frequency", value: String(report["pay_frequency"] ?? ""), source: "payroll_connection" },
        { path: "monthly_base_cents", label: "Monthly base pay", value: String(report["monthly_base_cents"] ?? ""), source: "payroll_connection" }, { path: "monthly_variable_cents", label: "Monthly overtime, bonus, commission", value: String(report["monthly_variable_cents"] ?? "0"), source: "payroll_connection" }, { path: "other_income", label: "Other income (Social Security, pension, child support, rental)", value: "none", source: "borrower" }],
        commits_to: "application_income", money_paths: ["monthly_base_cents", "monthly_variable_cents"], affirmatives: ["that's my income", "thats my income", "yes that's my income", "that is my income", "my income is right"], statement: "This becomes the income you're stating on your application.",
        command_args: { path: "income", commits_to: "application_income", verification_id: verificationId, report_reference_id: ref, ...lead } } });
  }
}

// ---------------------------------------------------------------- R4–R7: profile, declarations, demographics, the six-item moment
async function profileCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
  await sendCard(deps, ctx, party, { kind: "ProfileCard", copy_key: "profile.title", flow_key: `profile:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", fields: [
      { path: "citizenship_status", label: "Citizenship", required: true, options: [{ id: "us_citizen", label: "U.S. citizen" }, { id: "permanent_resident", label: "Permanent resident" }, { id: "non_permanent_resident", label: "Non-permanent resident" }] },
      { path: "marital_status", label: "Marital status", required: true, options: [{ id: "married", label: "Married" }, { id: "unmarried", label: "Unmarried" }, { id: "separated", label: "Separated" }] },
      { path: "dependents", label: "Dependents (number)", required: true, input: "number" },
      { path: "military_service", label: "Military service (URLA Section 7)", required: true, options: [{ id: "none", label: "No" }, { id: "active_duty", label: "Currently serving on active duty" }, { id: "retired_or_separated", label: "Retired, discharged or separated" }, { id: "reserve_or_guard", label: "Reserve or National Guard, never activated" }, { id: "surviving_spouse", label: "Surviving spouse" }] },
      { path: "language_preference", label: "Language preference (Form 1103)", required: true, options: [{ id: "english", label: "English" }, { id: "spanish", label: "Spanish" }, { id: "chinese", label: "Chinese" }, { id: "korean", label: "Korean" }, { id: "tagalog", label: "Tagalog" }, { id: "vietnamese", label: "Vietnamese" }, { id: "other", label: "Other" }, { id: "not_answered", label: "I'd rather not say" }] }],
      required_paths: ["citizenship_status", "marital_status", "dependents", "military_service"], scif_notice: "NTC_FNMA_1103_SCIF", command_args: { path: "profile", commits_to: "application_borrowers", ...lead } } });
}
// ---------------------------------------------------------------- R5: the declarations as a ChoiceCard sequence that ends in ONE application.answerDeclarations (23.5 rule 4; SQ-05)
/**
 * The state one declarations card hands the next (`props.declarations_seq`): 5a.A and 5a.E as answered on their own cards before the list
 * (the two URLA section 5 questions the list does not carry — 23.5 rule 4: never derived from a "none apply" tap), the thirteen listed
 * items as SQ-05 asks them one at a time, the bankruptcy chapter(s) — one tap each, "another?" between them — and the written explanation, the borrowed-funds amount. Every
 * card of the sequence but the last issues no command; the last card's tap carries the whole of it as `application.answerDeclarations`'s
 * input — the fourteen typed URLA section 5 answers, their follow-ups, the chapters and the explanation — and the API executes it as the
 * borrower's own actor (commands.ts runCommand; 23.5 assertDeclarations refuses any other). The inviter's twin (32.5 §7 `cob.declarations`)
 * runs the same sequence under its own flow-key prefix, resolved only by the invitee's session (PARTY_SCOPE).
 */
export interface DeclarationsSeq {
  /** the flow-key prefix (`declarations` for the interview's own borrowers, `cob.declarations` for an invited co-borrower) and the party-specific suffix */
  readonly prefix: string; readonly key: string;
  /** 21.1's own borrower id ("B1") — the legacy `declarations` record's key */
  readonly borrower_id: string;
  readonly step: string;
  readonly intent_to_occupy: "Yes" | "No" | null;
  readonly homeowner_past_three_years: "Yes" | "No" | null;
  readonly property_usage: string | null;
  readonly prior_property_title: string | null;
  /** 5a.E — a lien that could take priority over the first mortgage (a PACE / clean-energy lien): asked on its own card before the list, like 5a.A (23.5 rule 4: it is not on the list, so a "none apply" tap cannot answer it) */
  readonly property_proposed_clean_energy_lien: "Yes" | "No" | null;
  /** the thirteen listed items as answered in SQ-05 (null = not asked yet); "None of these apply" writes thirteen false */
  readonly items: readonly (boolean | null)[];
  readonly bankruptcy_chapters: readonly string[];
  readonly bankruptcy_explanation: string | null;
  readonly undisclosed_borrowed_funds_cents: string | null;
}
export interface DeclarationsCardSpec { readonly kind: string; readonly copy_key: string; readonly flow_key: string; readonly command_ref?: string; readonly props: P }
/** The list item (0-based) whose Yes opens a follow-up: bankruptcy → the chapter(s) and the optional explanation; borrowed funds → the amount. */
const ITEM_BANKRUPTCY = 6; const ITEM_BORROWED_FUNDS = 7; const ITEM_LAST = DECLARATIONS.length - 1;
/** A Yes here opens the B3-5.3-07 waiting-period explanation in the assistant's own words — criteria, never a decline (deed-in-lieu, short sale, foreclosure, bankruptcy). */
const ITEMS_WITH_WAITING_PERIOD: ReadonlySet<number> = new Set([3, 4, 5, 6]);
/** 5b.8.1 BankruptcyChapterType — the four chapters, in the order the card lists them. */
const BANKRUPTCY_CHAPTERS: readonly { id: string; label: string }[] = [{ id: "ChapterSeven", label: "Chapter 7" }, { id: "ChapterThirteen", label: "Chapter 13" }, { id: "ChapterEleven", label: "Chapter 11" }, { id: "ChapterTwelve", label: "Chapter 12" }];
/** The DU column each listed item answers (32.2 DECLARATION_COLUMN_FOR_LIST_ITEM); alimony/child support is URLA 2d, an expense, and answers no column. */
const COLUMN_FOR_ITEM: readonly (string | null)[] = ["outstanding_judgments", "presently_delinquent", "party_to_lawsuit", "prior_property_deed_in_lieu_conveyed", "prior_property_short_sale_completed", "prior_property_foreclosure_completed", "bankruptcy", "undisclosed_borrowed_funds", "undisclosed_credit_application", "undisclosed_mortgage_application", "undisclosed_comaker_of_note", null, "special_borrower_seller_relationship"];
const seqOf = (props: P): DeclarationsSeq | null => { const s = props["declarations_seq"]; return s && typeof s === "object" && !Array.isArray(s) && typeof (s as P)["step"] === "string" ? (s as unknown as DeclarationsSeq) : null; };
const yesNo = (v: boolean | null): "Yes" | "No" => (v === true ? "Yes" : "No");
/** The fourteen typed answers, their follow-ups, the chapters, the explanation and the legacy thirteen-item list — the one command's input as of this state. */
export function declarationsCommandArgs(seq: DeclarationsSeq): P {
  const items = seq.items.map((v) => v === true);
  const answers: Record<string, "Yes" | "No"> = { intent_to_occupy: seq.intent_to_occupy ?? "No" };
  COLUMN_FOR_ITEM.forEach((col, k) => { if (col) answers[col] = yesNo(items[k] ?? false); });
  // URLA 5a.E (a lien that could take priority — a PACE / clean-energy lien) is not on the list: it is asked on its own card before the list (the `clean_energy_lien` step), never copied from another item's answer (23.5 rule 4)
  answers["property_proposed_clean_energy_lien"] = seq.property_proposed_clean_energy_lien ?? "No";
  const follow_ups: P = {};
  if (seq.intent_to_occupy === "Yes") follow_ups["homeowner_past_three_years"] = seq.homeowner_past_three_years ?? "No";
  if (seq.intent_to_occupy === "Yes" && seq.homeowner_past_three_years === "Yes") { follow_ups["property_usage"] = seq.property_usage; if (seq.prior_property_title) follow_ups["prior_property_title"] = seq.prior_property_title; }
  if (items[ITEM_BORROWED_FUNDS]) follow_ups["undisclosed_borrowed_funds_cents"] = seq.undisclosed_borrowed_funds_cents;
  return { answers, follow_ups, bankruptcy_chapters: items[ITEM_BANKRUPTCY] ? [...seq.bankruptcy_chapters] : [], ...(seq.bankruptcy_explanation !== null ? { bankruptcy_explanation: seq.bankruptcy_explanation } : {}),
    declarations: items, borrower_id: seq.borrower_id, list_version: DECLARATIONS_LIST_VERSION, list_version_hash: DECLARATIONS_LIST_HASH };
}
const seqCard = (seq: DeclarationsSeq, step: string, c: { kind: string; copy_key: string; command_ref?: string; props: P }): DeclarationsCardSpec => ({ kind: c.kind, copy_key: c.copy_key, flow_key: `${seq.prefix}.${step}:${seq.key}`, ...(c.command_ref ? { command_ref: c.command_ref } : {}), props: { title: "", ...c.props, declarations_seq: { ...seq, step } } });
/** A step's name without its ordinal (`bk_chapter:2` → `bk_chapter`): the bankruptcy cards repeat, one per chapter, each under its own flow_key. */
const stepBase = (step: string): string => step.split(":")[0]!;
/** The bankruptcy step for the chapter about to be named / just named: the first without an ordinal (`bk_chapter`), the later ones with it (`bk_chapter:2`, …). */
const bkStep = (base: "bk_chapter" | "bk_another", seq: DeclarationsSeq): string => (seq.bankruptcy_chapters.length ? `${base}:${seq.bankruptcy_chapters.length + (base === "bk_chapter" ? 1 : 0)}` : base);
/** The card for a step of the sequence. */
function declarationsStepCard(seq: DeclarationsSeq, step: string): DeclarationsCardSpec {
  const NO_COMMAND = (ids: string[]): P => ({ no_command_options: ids });
  switch (stepBase(step)) {
    case "occupancy":   // 5a.A on every file, the follow-up folded into the common case
      return seqCard(seq, step, { kind: "ChoiceCard", copy_key: "declarations.occupancy", props: { options: [{ id: "yes_no_prior", label: "Yes, and I haven't owned another home in the past three years", is_primary: true }, { id: "yes_prior", label: "Yes, and I've owned another home in the past three years" }, { id: "no", label: "No, I won't live here" }], command: "application.answerDeclarations", command_args_by_option: { yes_no_prior: {}, yes_prior: {}, no: {} }, ...NO_COMMAND(["yes_no_prior", "yes_prior", "no"]) } });
    case "prior_usage":   // 5a.1.2 PriorPropertyUsageType
      return seqCard(seq, step, { kind: "ChoiceCard", copy_key: "declarations.prior_usage", props: { options: [{ id: "PrimaryResidence", label: "My main home", is_primary: true }, { id: "SecondHome", label: "A second home" }, { id: "Investment", label: "An investment property" }], command: "application.answerDeclarations", command_args_by_option: { PrimaryResidence: {}, SecondHome: {}, Investment: {} }, ...NO_COMMAND(["PrimaryResidence", "SecondHome", "Investment"]) } });
    case "prior_title":   // 5a.1.3 PriorPropertyTitleType
      return seqCard(seq, step, { kind: "ChoiceCard", copy_key: "declarations.prior_title", props: { options: [{ id: "Sole", label: "By myself", is_primary: true }, { id: "JointWithSpouse", label: "With my spouse" }, { id: "JointWithOtherThanSpouse", label: "With someone else" }], command: "application.answerDeclarations", command_args_by_option: { Sole: {}, JointWithSpouse: {}, JointWithOtherThanSpouse: {} }, ...NO_COMMAND(["Sole", "JointWithSpouse", "JointWithOtherThanSpouse"]) } });
    case "clean_energy_lien":   // 5a.E PropertyProposedCleanEnergyLienIndicator — on every file, its own card before the list (23.5 rule 4: not on the list, never derived from another item's answer)
      return seqCard(seq, step, { kind: "ChoiceCard", copy_key: "declarations.clean_energy_lien", props: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No", is_primary: true }], command: "application.answerDeclarations", command_args_by_option: { yes: {}, no: {} }, ...NO_COMMAND(["yes", "no"]) } });
    case "list": {   // the thirteen items, one tap: "None" runs the command with everything so far; "Something applies" opens SQ-05
      const none = declarationsCommandArgs({ ...seq, items: DECLARATIONS.map(() => false) });
      return seqCard(seq, step, { kind: "ChoiceCard", copy_key: "declarations.title", command_ref: "application.answerDeclarations", props: { options: [{ id: "none", label: "None of these apply to me", is_primary: true }, { id: "some", label: "Something here applies" }], command: "application.answerDeclarations", list: DECLARATIONS, list_version: DECLARATIONS_LIST_VERSION, list_version_hash: DECLARATIONS_LIST_HASH,
        command_args_by_option: { none, some: {} }, ...NO_COMMAND(["some"]), side_quest_on: { some: "SQ-05" }, affirmatives: ["none of these apply", "none apply", "nothing applies"] } });
    }
    case "bk_chapter": {   // 5b.8.1 BankruptcyChapterType — one tap names a chapter; the chapters already named are off the card, and `bk_another` asks whether there is one more (the second and later cards carry the chapter's ordinal in their step, so each has its own flow_key)
      const left = BANKRUPTCY_CHAPTERS.filter((c) => !seq.bankruptcy_chapters.includes(c.id));
      const options = left.map((c, k) => (k === 0 ? { ...c, is_primary: true } : c));
      return seqCard(seq, bkStep("bk_chapter", seq), { kind: "ChoiceCard", copy_key: "declarations.bankruptcy.chapter", props: { options, command: "application.answerDeclarations", command_args_by_option: Object.fromEntries(left.map((c) => [c.id, {}])), chapters_so_far: [...seq.bankruptcy_chapters], ...NO_COMMAND(left.map((c) => c.id)) } });
    }
    case "bk_another":   // more than one filing in the seven years: the chapters accumulate one tap at a time (one du_bankruptcy_filings row per chapter chosen)
      return seqCard(seq, bkStep("bk_another", seq), { kind: "ChoiceCard", copy_key: "declarations.bankruptcy.another", props: { options: [{ id: "no", label: "No, that was the only one", is_primary: true }, { id: "yes", label: "Yes, another chapter" }], command: "application.answerDeclarations", command_args_by_option: { no: {}, yes: {} }, chapters_so_far: [...seq.bankruptcy_chapters], ...NO_COMMAND(["no", "yes"]) } });
    case "bk_explanation":   // the borrower's own words, optional, kept verbatim on the row (23.5 data model: never discarded)
      return seqCard(seq, step, { kind: "ExplanationCard", copy_key: "declarations.bankruptcy.explain", props: { subject: "", prompt: "", min_length: 1, optional: true, subject_copy_key: "declarations.bankruptcy.explain", prompt_copy_key: "declarations.bankruptcy.explain.prompt", ...NO_COMMAND(["submit", "skip"]) } });
    case "borrowed_amount":   // 5a.3.1 — required exactly when C = Yes (du_declarations_borrowed_amount_follows_indicator)
      return seqCard(seq, step, { kind: "ConfirmCard", copy_key: "declarations.borrowed_funds.amount", props: { fields: [{ path: "undisclosed_borrowed_funds_cents", label: "Amount you are borrowing", value: "", source: "borrower" }], commits_to: "du_declarations", money_paths: ["undisclosed_borrowed_funds_cents"], required_paths: ["undisclosed_borrowed_funds_cents"] } });
    default: {
      const m = /^q:(\d+)$/.exec(step); if (!m) throw new RangeError(`declarations: no step ${step}`);
      const n = Number(m[1]); const item = DECLARATIONS[n]; if (item === undefined) throw new RangeError(`declarations: no item ${n}`);
      const props: P = { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No", is_primary: true }], command: "application.answerDeclarations", copy_tokens: { item, n: String(n + 1), of: String(DECLARATIONS.length) }, item_index: n, item_text: item };
      if (n === ITEM_LAST) {   // the last card's tap runs the command once with all fourteen answers, their follow-ups, the chapters and the explanation
        const withLast = (v: boolean) => declarationsCommandArgs({ ...seq, items: seq.items.map((x, k) => (k === n ? v : x)) });
        return seqCard(seq, step, { kind: "ChoiceCard", copy_key: "declarations.item", command_ref: "application.answerDeclarations", props: { ...props, command_args_by_option: { yes: withLast(true), no: withLast(false) }, list_version: DECLARATIONS_LIST_VERSION, list_version_hash: DECLARATIONS_LIST_HASH } });
      }
      return seqCard(seq, step, { kind: "ChoiceCard", copy_key: "declarations.item", props: { ...props, command_args_by_option: { yes: {}, no: {} }, ...NO_COMMAND(["yes", "no"]) } });
    }
  }
}
/** The first card of the sequence (5a.A, on every file). */
export function firstDeclarationsCard(o: { prefix: string; key: string; borrower_id: string }): DeclarationsCardSpec {
  return declarationsStepCard({ prefix: o.prefix, key: o.key, borrower_id: o.borrower_id, step: "occupancy", intent_to_occupy: null, homeowner_past_three_years: null, property_usage: null, prior_property_title: null, property_proposed_clean_energy_lien: null, items: DECLARATIONS.map(() => null), bankruptcy_chapters: [], bankruptcy_explanation: null, undisclosed_borrowed_funds_cents: null }, "occupancy");
}
/** Money typed on the amount card: cents as digits, or dollars with an optional $ and cents; null when it reads as neither. */
const moneyCents = (v: unknown): string | null => { const s = String(v ?? "").trim(); if (/^\d+$/.test(s)) return s; const m = /^\$?\s*(\d[\d,]*)(?:\.(\d{1,2}))?$/.exec(s); return m ? (BigInt(m[1]!.replace(/,/g, "")) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"))).toString() : null; };
/**
 * The next card after one of the sequence resolved with `option_id` and `evidence` — null when the resolved card ran the command (the list's
 * "None", the last question) and the sequence is over. Also says whether the tap opened the waiting-period explanation (B3-5.3-07).
 */
export function nextDeclarationsCard(card: { props: P; kind: string }, optionId: string | null, evidence: P): { next: DeclarationsCardSpec | null; waiting_period: boolean } {
  const seq = seqOf(card.props); if (!seq) return { next: null, waiting_period: false };
  const go = (s: DeclarationsSeq, step: string): { next: DeclarationsCardSpec; waiting_period: boolean } => ({ next: declarationsStepCard(s, step), waiting_period: false });
  const afterItem = (s: DeclarationsSeq, n: number): { next: DeclarationsCardSpec | null; waiting_period: boolean } => (n >= ITEM_LAST ? { next: null, waiting_period: false } : go(s, `q:${n + 1}`));
  switch (stepBase(seq.step)) {
    case "occupancy": {   // 5a.A, then 5a.E on its own card, then the list
      if (optionId === "yes_prior") return go({ ...seq, intent_to_occupy: "Yes", homeowner_past_three_years: "Yes" }, "prior_usage");
      if (optionId === "no") return go({ ...seq, intent_to_occupy: "No", homeowner_past_three_years: null }, "clean_energy_lien");
      return go({ ...seq, intent_to_occupy: "Yes", homeowner_past_three_years: "No" }, "clean_energy_lien");
    }
    case "prior_usage": return go({ ...seq, property_usage: optionId ?? "PrimaryResidence" }, "prior_title");
    case "prior_title": return go({ ...seq, prior_property_title: optionId ?? "Sole" }, "clean_energy_lien");
    case "clean_energy_lien": return go({ ...seq, property_proposed_clean_energy_lien: optionId === "yes" ? "Yes" : "No" }, "list");
    case "list": return optionId === "some" ? go(seq, "q:0") : { next: null, waiting_period: false };
    case "bk_chapter": {   // the chapter named joins the ones before it; "another?" follows while a chapter is still unnamed
      const chapters = optionId && BANKRUPTCY_CHAPTERS.some((c) => c.id === optionId) && !seq.bankruptcy_chapters.includes(optionId) ? [...seq.bankruptcy_chapters, optionId] : [...seq.bankruptcy_chapters];
      const s = { ...seq, bankruptcy_chapters: chapters };
      return go(s, chapters.length < BANKRUPTCY_CHAPTERS.length ? "bk_another" : "bk_explanation");
    }
    case "bk_another": return go(seq, optionId === "yes" ? "bk_chapter" : "bk_explanation");
    case "bk_explanation": { const text = typeof evidence["text"] === "string" ? (evidence["text"] as string) : ""; return afterItem({ ...seq, bankruptcy_explanation: optionId === "skip" || text === "" ? null : text }, ITEM_BANKRUPTCY); }
    case "borrowed_amount": { const f = (Array.isArray(evidence["fields"]) ? (evidence["fields"] as P[]) : []).find((x) => x["path"] === "undisclosed_borrowed_funds_cents"); return afterItem({ ...seq, undisclosed_borrowed_funds_cents: moneyCents(f?.["value_confirmed"] ?? f?.["value"]) }, ITEM_BORROWED_FUNDS); }
    default: {
      const m = /^q:(\d+)$/.exec(seq.step); if (!m) return { next: null, waiting_period: false };
      const n = Number(m[1]); const yes = optionId === "yes"; const s = { ...seq, items: seq.items.map((x, k) => (k === n ? yes : x)) };
      const waiting_period = yes && ITEMS_WITH_WAITING_PERIOD.has(n);
      if (yes && n === ITEM_BANKRUPTCY) return { ...go(s, "bk_chapter"), waiting_period };
      if (yes && n === ITEM_BORROWED_FUNDS) return { ...go(s, "borrowed_amount"), waiting_period };
      return { ...afterItem(s, n), waiting_period };
    }
  }
}
async function declarationsCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  await sendCard(deps, ctx, party, firstDeclarationsCard({ prefix: "declarations", key: party.application_borrower_id, borrower_id: intakeBorrowerId(ctx, party) }));
}
/** A card of the sequence resolved by the borrower's own tap (BorrowerFlows.cardResolved): the next question, and the waiting-period line when the tap opened one. */
async function onCardResolved(deps: FlowDeps, r: { card: { props: P; kind: string; subject_application_id: string | null; party_id: string }; option_id: string | null; evidence: P }): Promise<void> {
  if (!r.card.subject_application_id) return;
  if (seqOf(r.card.props)) {
    const { next, waiting_period } = nextDeclarationsCard(r.card, r.option_id, r.evidence);
    if (next || waiting_period) {
      const ctx = await context(deps, r.card.subject_application_id); const party = ctx.parties.find((p) => p.party_id === r.card.party_id);
      if (party) { if (waiting_period) await say(deps, ctx, party, "declarations.waiting_period"); if (next) await sendCard(deps, ctx, party, next); }
    }
  }
  await reassembleAfterGapCard(deps, r);
}
/**
 * 32.18 rule 7 / T8: a re-sent gap card (flow_key `…:gap:<emission>`) whose tap ran its command — the sequence's last card, the address confirm, the
 * home card — resolved on an application that already has a casefile: the assembly re-runs on that resolution (underwriting.run{reassemble}: 23.6's
 * build and 23.7's preflight over the graph as it now stands, a further du.document.emitted) so the gap closes; a gap still open is re-sent by
 * reactDuGaps under the new emission's key (the pending check keeps one card per ask), and the resubmission itself stays 23.1's.
 */
async function reassembleAfterGapCard(deps: FlowDeps, r: { card: { props: P; subject_application_id: string | null }; evidence: P }): Promise<void> {
  const appId = r.card.subject_application_id; if (!appId) return;
  if (!String(r.card.props["flow_key"] ?? "").includes(":gap:")) return;
  if (r.evidence["command_output"] === null || r.evidence["command_output"] === undefined) return;   // a card of the sequence before the last: nothing was written yet
  const ctx = await context(deps, appId);
  if (!has(ctx, "du.casefile.created")) return;
  try {
    const out = await exec(deps, appId, "32.18", "underwriting.run", BORROWER_APP, { application_id: appId, reassemble: true });
    deps.logger?.info("borrower.flow.32-18.gap.reassembled", { application_id: appId, flow_key: r.card.props["flow_key"], ...(out.output as P) });
  } catch (err) { deps.logger?.warn("borrower.flow.32-18.gap.reassemble_refused", { application_id: appId, flow_key: r.card.props["flow_key"], error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code ?? null }); }
}
async function demographicsCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  const borrower_id = intakeBorrowerId(ctx, party);
  await sendCard(deps, ctx, party, { kind: "DemographicsCard", copy_key: "demographics.title", flow_key: `demographics:${party.application_borrower_id}`, command_ref: "application.answerDemographics",
    props: { collection_method: "internet", statement_text: "", available: true,
      ethnicity: [{ id: "hispanic_or_latino", label: "Hispanic or Latino", sub: [{ id: "mexican", label: "Mexican" }, { id: "puerto_rican", label: "Puerto Rican" }, { id: "cuban", label: "Cuban" }, { id: "other_hispanic", label: "Other Hispanic or Latino" }] }, { id: "not_hispanic_or_latino", label: "Not Hispanic or Latino" }],
      race: [{ id: "american_indian_or_alaska_native", label: "American Indian or Alaska Native" }, { id: "asian", label: "Asian", sub: [{ id: "asian_indian", label: "Asian Indian" }, { id: "chinese", label: "Chinese" }, { id: "filipino", label: "Filipino" }, { id: "japanese", label: "Japanese" }, { id: "korean", label: "Korean" }, { id: "vietnamese", label: "Vietnamese" }, { id: "other_asian", label: "Other Asian" }] }, { id: "black_or_african_american", label: "Black or African American" }, { id: "native_hawaiian_or_other_pacific_islander", label: "Native Hawaiian or Other Pacific Islander", sub: [{ id: "native_hawaiian", label: "Native Hawaiian" }, { id: "guamanian_or_chamorro", label: "Guamanian or Chamorro" }, { id: "samoan", label: "Samoan" }, { id: "other_pacific_islander", label: "Other Pacific Islander" }] }, { id: "white", label: "White" }],
      sex: [{ id: "female", label: "Female" }, { id: "male", label: "Male" }], command_args: { borrower_id, collection_method: "internet" } } });
}
async function sixItemCards(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
  if (isPurchase(ctx) && isTbd(ctx)) {
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "preapproval.target", flow_key: `preapproval.target:${party.application_borrower_id}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "target_price_cents", label: "Target price", value: "", source: "borrower" }, { path: "down_payment_cents", label: "Down payment", value: "", source: "borrower" }, { path: "loan_amount_sought", label: "Loan amount", value: "", source: "borrower" }, { path: "product_code", label: "Product", value: "FRM30", source: "borrower" }],
        commits_to: "applications", money_paths: ["target_price_cents", "down_payment_cents", "loan_amount_sought"], required_paths: ["target_price_cents", "down_payment_cents", "loan_amount_sought"], command_args: { path: "preapproval.target", commits_to: "applications", ...lead } } });
    return;
  }
  // R7: the AVM shown counts only when accepted (21.2 rule 2) — the card's `avm` source; an edit is the borrower's own number
  const avm = ctx.property?.estimated_value_cents ?? null;
  await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "refi.value.confirm", flow_key: `refi.value:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", fields: [{ path: "property_value_estimate", label: "Estimated value", value: avm ?? "", source: avm ? "avm" : "borrower" }], commits_to: "application_properties.estimated_value", money_paths: ["property_value_estimate"], required_paths: ["property_value_estimate"], avm_vendor: "FAKE", command_args: { path: "property_value_estimate", ...lead } } });
  // the payoff-based amount from the credit report's mortgage tradeline (source credit_report), else the amount the application already carries
  const report = last(ctx, "credit.report.received", (x) => typeof x["report_id"] === "string");
  const rep = report ? (ctx.store.get("credit_reports", String(pl(report)["report_id"]))?.data as P | undefined) : undefined;
  const mortgage = ((rep?.["tradelines"] as P[] | undefined) ?? []).find((t) => /mortgage/i.test(String(t["liability_kind"] ?? "")));
  const intakeAmount = cents((ctx.store.get("applications", ctx.appId)?.data as P | undefined)?.["loan_amount_sought_cents"]);
  const amount = cents(mortgage?.["balance_cents"]) ?? intakeAmount ?? null;
  await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "refi.loan_amount.confirm", flow_key: `refi.loan_amount:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", fields: [{ path: "loan_amount_sought", label: "Loan amount", value: amount ?? "", source: mortgage ? "credit_report" : amount ? "prior_application" : "borrower" }], commits_to: "applications.loan_amount_sought", money_paths: ["loan_amount_sought"], required_paths: ["loan_amount_sought"], command_args: { path: "loan_amount_sought", ...lead } } });
  await sendCard(deps, ctx, party, { kind: "ChoiceCard", copy_key: "refi.product.choice", flow_key: `refi.product:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", options: [{ id: "FRM30", label: "30-year fixed", is_primary: true }, { id: "FRM15", label: "15-year fixed" }, { id: "ARM", label: "Adjustable (ARM)" }], command: "application.confirmField", command_args_by_option: { FRM30: { path: "product_code", value: "FRM30", source: "borrower" }, FRM15: { path: "product_code", value: "FRM15", source: "borrower" }, ARM: { path: "product_code", value: "ARM", source: "borrower", arm_interest: true } }, affirmatives: ["30 year fixed", "thirty year fixed", "15 year fixed"] } });
}

// ---------------------------------------------------------------- R2: the credit report → liabilities, the current loan, the 21.3 score notices
async function esignConsentFor(deps: FlowDeps, partyId: string, at: string): Promise<{ id: string; scope: string[]; granted_at: string } | null> {
  const r = (await deps.runtime.db.query<{ id: string; scope: string[]; captured_at: string }>(`SELECT id, scope, captured_at FROM consents WHERE kind = 'esign' AND status = 'active' AND party_id = $1 AND captured_at <= $2 ORDER BY captured_at DESC LIMIT 1`, [partyId, at]))[0];
  return r ? { id: r.id, scope: r.scope, granted_at: r.captured_at } : null;
}
async function creditCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const reportId = String(p["report_id"]); const rep = ctx.store.get("credit_reports", reportId)?.data as P | undefined; if (!rep) return;
  const tradelines = (rep["tradelines"] as P[] | undefined) ?? []; const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
  for (const borrowerId of ((p["borrower_ids"] as string[] | undefined) ?? [])) {
    for (const party of partiesFor(ctx, borrowerId)) {
      const own = tradelines.filter((t) => t["borrower_id"] === borrowerId);
      if (asksHere(ctx)) await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "credit.liabilities.confirm", flow_key: `credit.liabilities:${reportId}:${party.application_borrower_id}`, command_ref: "application.confirmField",
        props: { title: "", fields: own.length ? own.map((t, k) => ({ path: `liabilities.${k}`, label: `${String(t["creditor_name"])} · ${String(t["liability_kind"])}`, value: `${cents(t["balance_cents"]) ?? "0"}|${cents(t["monthly_payment_cents"]) ?? "0"}`, source: "credit_report" })) : [{ path: "liabilities.none", label: "Debts on your report", value: "none reported", source: "credit_report" }], commits_to: "application_liabilities", helper_copy_key: "credit.liabilities.student_zero", anything_missing: true, no_scores: true, command_args: { path: "liabilities", commits_to: "application_liabilities", report_id: reportId, ...lead } } });
      const mortgage = own.find((t) => /mortgage/i.test(String(t["liability_kind"] ?? "")));
      if (asksHere(ctx) && !isPurchase(ctx)) await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "refi.current_loan.confirm", flow_key: `refi.current_loan:${reportId}:${party.application_borrower_id}`, command_ref: "application.confirmField",
        props: { title: "", fields: [{ path: "current_lender", label: "Current lender", value: String(mortgage?.["creditor_name"] ?? "not on your report"), source: "credit_report" }, { path: "current_balance_cents", label: "Approximate balance", value: cents(mortgage?.["balance_cents"]) ?? "", source: "credit_report" }, { path: "current_payment_cents", label: "Monthly payment", value: cents(mortgage?.["monthly_payment_cents"]) ?? "", source: "credit_report" }, { path: "escrow_included", label: "Taxes and insurance included in the payment?", value: "yes", source: "borrower" }, { path: "second_lien", label: "Second lien or HELOC?", value: "none", source: "credit_report" }], commits_to: "application_liabilities.mortgage", money_paths: ["current_balance_cents", "current_payment_cents"], command_args: { path: "current_loan", commits_to: "application_liabilities", report_id: reportId, ...lead } } });
      // 21.3: the §609(g) score notice for this borrower alone — ingested from 22.2's report row, delivered on the consented channel (FCRA_609G_SCORE_NOTICE_1BD)
      try { await scoreNotice(deps, ctx, party, borrowerId, rep, e); } catch (err) { deps.logger?.error("borrower.flow.32-3.score_notice", { application_id: ctx.appId, borrower_id: borrowerId, error: err instanceof Error ? err.message : String(err) }); }
    }
  }
}
const CRA_NAMES: Record<string, string> = { efx: "EFX", exp: "EXP", tu: "TU" };   // 21.3 CRA_CONTACTS keys — the notice prints the bureau's name and contact from its own table
async function scoreNotice(deps: FlowDeps, ctx: Ctx, party: Party, borrowerId: string, rep: P, e: DomainEvent): Promise<void> {
  if (has(ctx, "score_disclosure.delivered", (x) => x["application_borrower_id"] === borrowerId)) return;
  const b = ((rep["borrowers"] as P[] | undefined) ?? []).find((x) => x["borrower_id"] === borrowerId); if (!b) return;
  const applicable = (rep["borrower_applicable_scores"] as Record<string, number | null> | undefined)?.[borrowerId] ?? null;
  const scores = Object.entries((b["scores"] as Record<string, P> | undefined) ?? {}).filter(([, s]) => typeof s?.["score"] === "number").map(([repo, s]) => ({ cra: CRA_NAMES[repo] ?? repo, model: String(rep["score_model"] ?? s["model_version"] ?? ""), score: Number(s["score"]), range_low: 300, range_high: 850, date: String(rep["report_date"] ?? e.occurredAt.slice(0, 10)), key_factors: ((s["key_factors"] as string[] | undefined) ?? []).slice(0, 4), inquiries_factor: s["inquiries_key_factor"] === true, representative: applicable !== null && Number(s["score"]) === applicable }));
  if (!has(ctx, "credit.report.received", (x) => x["credit_report_id"] === rep["report_id"] && x["application_borrower_id"] === borrowerId))
    await exec(deps, ctx.appId, "21.3", "renderScoreDisclosure", DISCLOSURE, { op: "ingest", application_id: ctx.appId, application_borrower_id: borrowerId, borrower_name: party.legal_name, credit_report_id: String(rep["report_id"]), received_at: e.occurredAt, scores });
  const consent = await esignConsentFor(deps, party.party_id, ctx.now);
  await exec(deps, ctx.appId, "21.3", "deliver", DISCLOSURE, { application_id: ctx.appId, kind: "credit_score_notice", application_borrower_id: borrowerId, at: ctx.now, rendered_document_id: `DOC-609G-${String(rep["report_id"])}-${borrowerId}`, ...(consent ? { channel: "esign_portal", consent } : { channel: "mail", mailing_proof_id: fakeMailingProof(`609G-${borrowerId}-${ctx.now.slice(0, 10)}`) }) });
}

// ---------------------------------------------------------------- R8: DU → the checklist
async function checklistCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const submissionId = String(pl(e)["submission_id"] ?? pl(e)["du_submission_id"] ?? "");
  const conds = ctx.store.list("conditions", (d) => d.application_id === ctx.appId && d.borrower_visible !== false && (d.status === "open" || d.status === "waiting_borrower" || d.status === "received")).map((r) => r.data as P);
  if (!conds.length) return;
  const owner = (c: P): string => (c["requires_role"] === "borrower" || String(c["category"] ?? "").includes("borrower") || String(c["source"] ?? "") === "borrower" ? "you" : String(c["category"] ?? "") === "third_party" ? "third_party" : "us");
  const items = conds.map((c) => ({ condition_id: String(c["condition_id"]), label: String(c["text"] ?? c["template_code"] ?? ""), owner: owner(c), status: c["status"] === "open" ? "open" : String(c["status"]), ...(c["due_at"] ? { due_at: c["due_at"] } : {}) }));
  await sendToAll(deps, ctx, { kind: "ChecklistCard", copy_key: "conditions.checklist", flow_key: `conditions:${submissionId || ctx.appId}`, informational: true, props: { title: "", items, du_submission_id: submissionId || null } });
}

// ---------------------------------------------------------------- R9 / P8 / P9: the MLO review of personalized terms (20.3 rule 7)
async function termsPendingCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const quoteId = String(p["quote_id"]);
  const due = await timerDue(deps, ctx.appId, "SM_MLO_PREAPP_TERMS_REVIEW_1BH");
  const mloName = String(ctx.lead?.["mlo_name"] ?? "your loan officer"); const nmlsr = String(ctx.lead?.["mlo_nmlsr_id"] ?? "");
  await sendToAll(deps, ctx, StatusCard("terms.pending_mlo", `terms.pending:${quoteId}`, { next_event_label: timerLabel("SM_MLO_PREAPP_TERMS_REVIEW_1BH"), next_event_at: due, quote_id: quoteId, copy_tokens: { "mlo.name": mloName, "mlo.nmlsr_id": nmlsr, due: due ?? "" } }));
  if (ctx.lead?.["mlo_name"]) await sendToAll(deps, ctx, { kind: "PersonCard", copy_key: "terms.pending_mlo", flow_key: `person.mlo:${String(ctx.lead["mlo_of_record_id"])}`, informational: true, props: { role: "mlo_of_record", name: mloName, credentials: nmlsr ? `NMLSR ID ${nmlsr}` : "", intro: "" } });
}
async function presentTerms(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["outcome"] !== "approved" || !leadId(ctx)) return;
  const quoteId = String(p["quote_id"]);
  if (has(ctx, "terms.presented", (x) => x["quote_id"] === quoteId)) return;
  await exec(deps, ctx.appId, "20.3", "requestQuote", INTAKE, { op: "present", lead_id: leadId(ctx), quote_id: quoteId, review_id: String(p["review_id"]) });
}
async function termsPresentedCards(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const quoteId = String(p["quote_id"]); const q = ctx.store.get("pricing_quotes", quoteId)?.data as P | undefined;
  const rate = q ? `${String(q["note_rate_pct"] ?? q["note_rate"] ?? "")}%` : "";
  // 32.14 DELTA-13: the card carries the review it rests on, the attribution ("reviewed by {{mlo.name}}, NMLSR ID {{mlo.nmlsr_id}}") and 20.4's written-quote disclaimer block (REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE's statement) — the borrower reads a reviewed estimate, never a commitment
  await sendToAll(deps, ctx, StatusCard("terms.presented", `terms.presented:${quoteId}`, { quote_id: quoteId, note_rate_pct: q?.["note_rate_pct"] ?? null, pi_cents: cents(q?.["pi_cents"]), mlo_review_id: p["mlo_review_id"] ?? null, mlo_review_approved: true, attribution: String(p["attribution"] ?? ""), disclaimer: { template: String(p["disclaimer_template"] ?? DISCLAIMER_TEMPLATE), statement: DISCLAIMER_STATEMENT }, copy_tokens: { "mlo.name": String(p["mlo_name"] ?? ""), "mlo.nmlsr_id": String(p["nmlsr_id"] ?? ""), rate } }, true));
  // P9: a listing that waited for this review now gets its estimate on the reviewed quote
  const pending = await deps.runtime.db.query<{ card_instance_id: string; party_id: string; props: P }>(`SELECT card_instance_id, party_id, props FROM card_instances WHERE subject_application_id = $1 AND props->>'flow_key' LIKE 'listing.pending:%' AND props->>'quote_id' = $2`, [ctx.appId, quoteId]);
  for (const row of pending) { const party = ctx.parties.find((x) => x.party_id === row.party_id); if (party && q) await listingEstimateCard(deps, ctx, party, String(row.props["listing_address"] ?? ""), String(row.props["listing_price_cents"] ?? ""), q); }
}
async function listingEstimateCard(deps: FlowDeps, ctx: Ctx, party: Party, address: string, priceCents: string, q: P): Promise<string | null> {
  const pull = fakePropertyPull(address || ctx.appId); const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const money = (c: unknown): string => (c === null || c === undefined || c === "" ? "—" : usd.format(Number(BigInt(String(c))) / 100));
  const approved = last(ctx, "preapproval.letter.issued"); const approvedAmount = cents(approved?.payload["approved_amount_cents"]);
  return sendCard(deps, ctx, party, StatusCard("preapproval.listing_numbers", `listing.estimate:${String(q["quote_id"])}:${sha(`${address}|${priceCents}`).slice(0, 12)}`,
    { quote_id: String(q["quote_id"]), note_rate_pct: q["note_rate_pct"] ?? null, pi_cents: cents(q["pi_cents"]), listing_address: address, listing_price_cents: priceCents || null, approved_amount_cents: approvedAmount, property_pull: pull,
      copy_tokens: { address: address || "the listing", money: [money(pull.taxes_annual_cents), money(pull.hoa_monthly_cents), money(q["pi_cents"])], flood_status: pull.flood_status, down: priceCents && approvedAmount ? "your down payment" : "your down payment" } }, true));
}

// ---------------------------------------------------------------- P8: the preapproval decision → the letter (DELTA-01)
async function preapprovalLetter(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["kind"] !== "conditional_approval" || !isPurchase(ctx) || !isTbd(ctx) || !leadId(ctx)) return;
  if (has(ctx, "preapproval.letter.issued")) return;
  const recorded = last(ctx, "credit_decision.recorded"); const validUntil = String(recorded?.payload["valid_until"] ?? p["expires_on"] ?? "");
  const casefile = ctx.store.list("du_casefiles", (d) => d.application_id === ctx.appId).map((r) => r.data as P).at(-1);
  const intake = ctx.store.get("applications", ctx.appId)?.data as P | undefined;
  const amount = cents(intake?.["loan_amount_sought_cents"]) ?? null; if (!amount || !validUntil) return;
  const consumer = ctx.parties[0]?.legal_name ?? "[Consumer name]"; const quoteId = ctx.lead?.["prequalifications"] ? ((ctx.lead["prequalifications"] as P[]).at(-1)?.["quote_id"] as string | undefined) ?? null : null;
  await exec(deps, ctx.appId, "20.3", "explainProgram", INTAKE, { op: "issue_preapproval_letter", lead_id: leadId(ctx), du_casefile_id: casefile ? String(casefile["casefile_id"]) : `TBD-${ctx.appId.slice(0, 8)}`, approved_amount_cents: amount, valid_until: validUntil, decision_id: p["decision_id"] ?? null, quote_id: quoteId, consumer_name: consumer, partner_nmlsr_id: String(intake?.["partner_nmlsr_id"] ?? "000000"), product: "30-year fixed", letter_document_id: randomUUID() });
}
async function preapprovalLetterCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  await sendToAll(deps, ctx, { kind: "DocumentCard", copy_key: "preapproval.letter", flow_key: `preapproval.letter:${String(p["prequal_id"] ?? e.id)}`, informational: true,
    props: { document_id: p["letter_document_id"] ?? randomUUID(), notice_code: "NTC_SM_PREAPPROVAL_LETTER", title: "", why_you_see_this: "", requires_ack: false, esign_scope_required: "none", valid_until: p["valid_until"] ?? null, approved_amount_cents: cents(p["approved_amount_cents"]), delivered_at: e.occurredAt, channel: "app", copy_tokens: { valid_until: String(p["valid_until"] ?? "") } } });
}

// ---------------------------------------------------------------- C1: the contract upload → FAKE extraction → the ConfirmCard
async function contractExtraction(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); const documentId = String(p["document_id"]);
  if (has(ctx, "document.extracted", (x) => x["document_id"] === documentId)) return;
  if (!has(ctx, "document.classified", (x) => x["document_id"] === documentId)) await exec(deps, ctx.appId, "22.1", "classifyDocument", VERIFICATION, { application_id: ctx.appId, document_id: documentId, doc_class: "purchase_contract", borrower_declared: true, confidence: 1, classifier_version: "FAKE-contract-classifier-2026.09" });
  // the FAKE extractor reads the uploaded bytes as the contract's own field list (a real adapter OCRs the pages)
  let fields: P = {};
  try { const blob = await deps.blobs?.get(documentId); if (blob) { const parsed = JSON.parse(blob.bytes.toString("utf8")) as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as P; } } catch { fields = {}; }
  if (!Object.keys(fields).length) { deps.logger?.info("borrower.flow.32-3.contract.unreadable", { document_id: documentId }); return; }
  await exec(deps, ctx.appId, "22.1", "extractFields", VERIFICATION, { application_id: ctx.appId, document_id: documentId, fields, extractor_version: "FAKE-contract-extractor-2026.09", ocr_engine: "FAKE", human_verified: false });
}
async function contractCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["doc_class"] !== "purchase_contract") return; const documentId = String(p["document_id"]);
  const x = ctx.store.list("document_extractions", (d) => d.document_id === documentId).map((r) => r.data as P).at(-1); const f = (x?.["fields"] as P | undefined) ?? {};
  const s = (k: string): string => (f[k] === undefined || f[k] === null ? "" : Array.isArray(f[k]) ? (f[k] as unknown[]).join(", ") : String(f[k]));
  const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
  const fields = [["property_address", "Property address"], ["purchase_price_cents", "Purchase price"], ["closing_date", "Closing date"], ["contract_date", "Contract date"], ["earnest_money_cents", "Earnest money"], ["earnest_money_holder", "Earnest money held by"], ["financing_contingency_date", "Financing contingency"], ["appraisal_contingency_date", "Appraisal contingency"], ["seller_concessions_cents", "Seller concessions"], ["seller_names", "Seller(s)"]] as const;
  await sendToAll(deps, ctx, { kind: "ConfirmCard", copy_key: "contract.confirm", flow_key: `contract.confirm:${documentId}`, command_ref: "application.confirmField",
    // 32.18 rule 7 on the purchase path: this card carries the extraction's fields only (32.3 T29: every field `source = document_extraction`), so the estate and the clean-energy lien are
    // not asked here — a to-be-determined purchase has no property row to hold them yet (journey-purchase.ts GAP 1) and the assembly's gap re-sends the home card (homeCard) that asks both
    props: { title: "", fields: fields.map(([path, label]) => ({ path, label, value: s(path), source: "document_extraction", confirmed_at: null })), commits_to: "purchase_contracts", money_paths: ["purchase_price_cents", "earnest_money_cents", "seller_concessions_cents"], extraction_id: x?.["extraction_id"] ?? null, extractor: "FAKE", required_paths: ["property_address", "purchase_price_cents"],
      command_args: { path: "purchase_contract", commits_to: "purchase_contracts", document_id: documentId, ...lead } } });
  // the declarations addendum (URLA Section 5, relationship with the seller)
  await sendToAll(deps, ctx, { kind: "ChoiceCard", copy_key: "contract.seller_relationship", flow_key: `contract.seller:${documentId}`, command_ref: "application.confirmField",
    props: { title: "", options: [{ id: "no", label: "No relationship", is_primary: true }, { id: "yes", label: "Yes, I know the seller" }], command: "application.confirmField", command_args_by_option: { no: { path: "seller_relationship", value: "none", source: "borrower" }, yes: { path: "seller_relationship", value: "related", source: "borrower" } } } });
}

// ---------------------------------------------------------------- the reactions, per application, in commit order
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "application.received": await consentCards(deps, ctx); await creditPull(deps, ctx); return;   // 32.18 rule 2: the goal's tap wrote the authorization — the SSN may already be on file
    case "identity.verified": await identityCard(deps, ctx, e); return;
    case "application.field.captured": {
      const field = String(p["field"] ?? "");
      if (field === "current_address") await afterIdentity(deps, ctx, e);
      if (field === "citizenship_status") for (const party of partiesFor(ctx, p["borrower_id"])) await declarationsCard(deps, ctx, party);
      return;
    }
    case "application.six_item.captured": {
      if (p["item"] === "income") for (const party of partiesFor(ctx, p["borrower_id"])) await profileCard(deps, ctx, party);
      if (p["item"] === "ssn") await creditPull(deps, ctx);   // 32.18 rule 2
      if (p["item"] === "income") await duMoment(deps, ctx);   // 32.18 rule 3
      return;
    }
    case "application.declarations.answered": for (const party of partiesFor(ctx, p["borrower_id"])) await demographicsCard(deps, ctx, party); return;
    case "application.demographics.collected": for (const party of partiesFor(ctx, p["borrower_id"])) await sixItemCards(deps, ctx, party); return;
    case "application.trid_received": {
      const due = await timerDue(deps, ctx.appId, "REGZ_1026_19E1_LE_3BD");
      await sendToAll(deps, ctx, StatusCard("application.received", `application.received:${ctx.appId}`, { next_event_label: timerLabel("REGZ_1026_19E1_LE_3BD"), next_event_at: due, copy_tokens: { date: String(p["trid_application_date"] ?? e.occurredAt.slice(0, 10)), due: due ?? "" } }));
      await creditPull(deps, ctx);   // 32.18 rule 2: the six items are in — the pull (its report's reaction runs the DU moment)
      await duMoment(deps, ctx); return;   // 32.18 rule 3
    }
    case "verification.received": await incomeCard(deps, ctx, e); await duMoment(deps, ctx); return;   // 32.18 rule 3: the income or the assets report may be the last prerequisite
    case "credit.report.ordered": {
      // T9: a re-order after a report (one score model for every borrower — 22.2 R11 / 23.1 T11): the neutral line, never a score
      if (has(ctx, "credit.report.received", (x) => typeof x["report_id"] === "string" && x["report_id"] !== p["report_id"]) || has(ctx, "du.submission.errored", (x) => x["error_code"] === "SCORE_MODEL_MIXED")) await sendToAll(deps, ctx, StatusCard("credit.rerun.neutral", `credit.rerun:${String(p["client_order_id"] ?? e.id)}`, { copy_tokens: {} }));
      return;
    }
    case "credit.report.received": if (typeof p["report_id"] === "string" && p["source"] !== "origination") await creditCards(deps, ctx, e); await duMoment(deps, ctx); return;   // 32.18 rule 3
    case "du.findings.received": await sendToAll(deps, ctx, StatusCard("du.running", `du.running:${String(p["casefile_id"])}:${String(p["submission_number"])}`, { copy_tokens: {} })); return;
    case "du.findings.interpreted": await checklistCard(deps, ctx, e); return;
    case "terms.presentation.requested": await termsPendingCards(deps, ctx, e); return;
    case "mlo.review.completed": await presentTerms(deps, ctx, e); return;
    case "terms.presented": await termsPresentedCards(deps, ctx, e); return;
    case "intent.to_proceed.rejected_premature": for (const party of ctx.parties) await say(deps, ctx, party, "intent.too_early"); return;
    case "decision.issued": await preapprovalLetter(deps, ctx, e); return;
    case "preapproval.letter.issued": await preapprovalLetterCard(deps, ctx, e); return;
    case "document.received": if (p["declared_class"] === "purchase_contract") await contractExtraction(deps, ctx, e); return;
    case "document.classified": if (p["doc_class"] === "purchase_contract" && !has(ctx, "document.extracted", (x) => x["document_id"] === p["document_id"])) await contractExtraction(deps, ctx, { ...e, payload: { ...p, declared_class: "purchase_contract" } } as DomainEvent); return;
    case "document.extracted": await contractCard(deps, ctx, e); return;
    case "consent.esign.pending": {
      const party = ctx.parties.find((x) => x.party_id === p["party_id"]); if (!party) return;
      // 7.4's demonstration test: the FAKE verification e-mail carries the link + the PDF token (NTC_ESIGN_VERIFICATION_EMAIL); nothing is active until it is entered
      const email = (await deps.runtime.db.query<{ email: string | null }>(`SELECT contact->>'email' AS email FROM application_borrowers WHERE id = $1`, [party.application_borrower_id]))[0]?.email ?? "";
      const port = deps.runtime.ports.edelivery;
      if (port) await port.send({ messageId: `esign-verify:${String(p["consent_id"])}`, noticeId: `NTC_ESIGN_VERIFICATION_EMAIL:${String(p["consent_id"])}`, channel: "email", to: email, subject: "Confirm e-delivery", consentId: String(p["consent_id"]) }, ctx.now);
      await say(deps, ctx, party, "consent.esign.pending");
      deps.logger?.info("borrower.flow.32-3.esign.verification_email", { consent_id: p["consent_id"], vendor: "FAKE", token: esignVerificationToken(String(p["consent_id"])) });
      return;
    }
    case "consent.esign.active": { const party = ctx.parties.find((x) => x.party_id === p["party_id"]); if (party) await say(deps, ctx, party, "consent.esign.active"); return; }
    default: return;
  }
}

// ---------------------------------------------------------------- the messages this flow answers itself
const REAL_PERSON = /\bare you (?:a )?(?:real person|human|a bot|an? ai|a person|a robot)\b|\bis this (?:a )?(?:bot|person|human)\b/i;
const LISTING = /\b(listing|mls|zillow|redfin|realtor\.com)\b|https?:\/\/|\$\s?\d[\d,]*(?:\.\d+)?\s*(k|m)?\b/i;
async function onMessage(deps: FlowDeps, m: InboundMessage): Promise<FlowReply | null> {
  const appId = m.subject?.application_id ?? null;
  if (REAL_PERSON.test(m.text)) {
    const store = new EntityStore(); store.seed(await deps.runtime.entities.load(appId ? { applicationId: appId } : {}));
    const lead = (appId ? store.get("leads", appId)?.data : undefined) ?? store.list("leads", (d) => d.party_id === m.party_id).map((r) => r.data)[0];
    const interaction = ((lead?.["interactions"] as P[] | undefined) ?? []).at(-1);
    if (lead && interaction) {
      const r = await exec(deps, appId, "20.3", "deliverDisclosure", INTAKE, { op: "are_you_human", lead_id: String(lead["lead_id"]), interaction_id: String(interaction["interaction_id"]) });
      return { copy_key: "entry.disclosure.real_person", body_text: String((r.output as P)["answer"] ?? "{{copy:entry.disclosure.real_person}}") };
    }
    return { copy_key: "entry.disclosure.real_person" };
  }
  if (appId && LISTING.test(m.text)) {
    const ctx = await context(deps, appId); const party = ctx.parties.find((x) => x.party_id === m.party_id);
    const letter = last(ctx, "preapproval.letter.issued"); if (!party || !letter) return null;
    const priceMatch = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?/i.exec(m.text); const price = priceMatch ? String(BigInt(Math.round(Number(priceMatch[1]!.replace(/,/g, "")) * (priceMatch[2]?.toLowerCase() === "k" ? 1000 : priceMatch[2]?.toLowerCase() === "m" ? 1_000_000 : 1))) * 100n) : "";
    const address = (/\d+\s+[A-Za-z0-9 .'-]+?(?:\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|way|blvd|ct|court|pl|place)\b\.?)(?:,?\s*[A-Za-z .]+)?(?:,?\s*[A-Z]{2}\s*\d{5})?/i.exec(m.text)?.[0] ?? "").trim();
    const quoteId = String(letter.payload["quote_id"] ?? ""); const q = quoteId ? (ctx.store.get("pricing_quotes", quoteId)?.data as P | undefined) : undefined;
    if (q && typeof q["valid_until"] === "string" && quoteValidAt({ valid_until: q["valid_until"] as string }, ctx.now)) {
      const id = await listingEstimateCard(deps, ctx, party, address, price, q);
      return { copy_key: "preapproval.listing_numbers", card_instance_id: id };
    }
    // SM_QUOTE_VALIDITY_GATE closed: today's pricing through 20.4, then the MLO review (assisted) before any new rate renders
    if (!q || !leadId(ctx)) return null;
    const inputs = (q["inputs"] as P | undefined) ?? {};
    const fresh = await exec(deps, ctx.appId, "20.4", "solvePassThrough", { kind: "agent", id: "pricing" }, { inputs, quote_id: `Q-L-${randomUUID().slice(0, 8)}`, purpose: "lead_quote", partner_id: String(ctx.lead?.["partner_id"] ?? "partner"), lead_id: leadId(ctx), application_id: ctx.appId });
    const newQuoteId = String((fresh.output as P)["quote_id"]);
    await exec(deps, ctx.appId, "20.3", "requestQuote", INTAKE, { op: "request_review", lead_id: leadId(ctx), quote_id: newQuoteId });
    const id = await sendCard(deps, ctx, party, StatusCard("preapproval.listing_pending", `listing.pending:${newQuoteId}`, { quote_id: newQuoteId, listing_address: address, listing_price_cents: price || null, gate: "SM_QUOTE_VALIDITY_GATE", copy_tokens: { address: address || "the listing" } }));
    return { copy_key: "preapproval.listing_pending", card_instance_id: id };
  }
  return null;
}

// ---------------------------------------------------------------- the LE channel by consent (21.2 guard: e-delivery only under active E-SIGN for the disclosures class, else mail)
/** Delivers the initial LE through the 21.2 bridge on the channel the consents table allows: `esign_portal` with every borrower party's active E-SIGN consent (scope ∋ disclosures), otherwise `mail` with the FAKE print vendor's proof (T7, T22). */
export async function deliverLeByConsent(runtime: Runtime, applicationId: string, input: { render: LoanEstimateDeliveryInput["render"]; mlo: LoanEstimateDeliveryInput["mlo"]; at?: string; actor?: Actor }): Promise<{ channel: "esign_portal" | "mail"; consent_ids: string[]; result: Awaited<ReturnType<typeof deliverLoanEstimate>> }> {
  const at = input.at ?? runtime.clock.now();
  const parties = await runtime.db.query<{ party_id: string }>(`SELECT party_id FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL`, [applicationId]);
  const consents: { id: string; scope: string[]; captured_at: string }[] = [];
  for (const p of parties) { const c = (await runtime.db.query<{ id: string; scope: string[]; captured_at: string }>(`SELECT id, scope, captured_at FROM consents WHERE kind = 'esign' AND status = 'active' AND party_id = $1 AND 'disclosures' = ANY(scope) AND captured_at <= $2 ORDER BY captured_at DESC LIMIT 1`, [p.party_id, at]))[0]; if (c) consents.push(c); }
  const electronic = parties.length > 0 && consents.length === parties.length;
  const delivery: LoanEstimateDeliveryInput["delivery"] = electronic ? { channel: "esign_portal", at, consent: { id: consents[0]!.id, scope: consents[0]!.scope, granted_at: consents[0]!.captured_at } } : { channel: "mail", at, mailing_proof_id: fakeMailingProof(`LE-${applicationId.slice(0, 8)}-${at.slice(0, 10)}`) };
  const result = await deliverLoanEstimate(runtime, applicationId, { render: input.render, mlo: input.mlo, delivery }, input.actor ?? { kind: "human", id: "u-mlo-of-record", role: "mlo_of_record" });
  return { channel: electronic ? "esign_portal" : "mail", consent_ids: consents.map((c) => c.id), result };
}

/** On a refi-trigger lead the owning processes already ran E1–E6 (20.3); only the informational projections react here (R2 score notices and the neutral re-run line, R8's DU status and checklist, the TRID StatusCard, the MLO review status). */
const INFORMATIONAL_ON_EVERY_LEAD = new Set(["application.trid_received", "credit.report.ordered", "credit.report.received", "du.findings.received", "du.findings.interpreted", "terms.presentation.requested", "mlo.review.completed", "terms.presented", "intent.to_proceed.rejected_premature", "decision.issued", "preapproval.letter.issued", "consent.esign.pending", "consent.esign.active"]);
const REACTS = new Set(["application.received", "identity.verified", "application.field.captured", "application.six_item.captured", "application.declarations.answered", "application.demographics.collected", "application.trid_received", "verification.received", "credit.report.ordered", "credit.report.received", "du.findings.received", "du.findings.interpreted",
  "terms.presentation.requested", "mlo.review.completed", "terms.presented", "intent.to_proceed.rejected_premature", "decision.issued", "preapproval.letter.issued", "document.received", "document.classified", "document.extracted", "consent.esign.pending", "consent.esign.active"]);

export const FLOW_3_ENTRY: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byApp = new Map<string, DomainEvent[]>();
    for (const e of events) { const app = e.applicationId ?? (typeof (e.payload as P)["application_id"] === "string" ? String((e.payload as P)["application_id"]) : null); if (!app) continue; const list = byApp.get(app) ?? []; list.push(e); byApp.set(app, list); }
    for (const [appId, list] of byApp) {
      const ctx = await context(deps, appId);
      if (!ctx.parties.length) continue;   // no borrower party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { if (!asksHere(ctx) && !INFORMATIONAL_ON_EVERY_LEAD.has(e.type)) continue; try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-3.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  onSessionOpened: sessionOpened,
  onMessage,
  onCardResolved,   // R5 / SQ-05: the next declaration question on the borrower's own tap (the inviter's `cob.declarations` twin included)
};
