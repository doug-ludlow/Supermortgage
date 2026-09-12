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
 *   application.received                              ConsentCards (esign · tcpa · credit authorization) (E6), Truv ConnectCard (R3),
 *                                                     preapproval P1 ConfirmCard for a TBD purchase
 *   identity.verified                                 ConfirmCard {legal name, DOB, current address} from the Stripe extraction (E5)
 *   application.field.captured{current_address}       ConfirmCard {SSN} (E5) + ConfirmCard {your home} (R1)
 *   verification.received{income}                     ConfirmCard {income} from the FAKE Truv report (R3)
 *   application.six_item.captured{income}             ProfileCard (R4)
 *   application.field.captured{citizenship_status}    ChoiceCard {declarations} (R5)
 *   application.declarations.answered                 DemographicsCard (R6)
 *   application.demographics.collected                ConfirmCards {value (AVM), loan amount}, ChoiceCard {product} (R7) / P8 for a TBD purchase
 *   application.trid_received                         StatusCard `application.received` (next: REGZ_1026_19E1_LE_3BD.due_at)
 *   credit.report.received (22.2)                     ConfirmCards {liabilities, current loan}; 21.3 score notices ingested and delivered (R2)
 *   credit.report.ordered after a report              StatusCard `credit.rerun.neutral` (T9)
 *   du.findings.received / .interpreted               StatusCard `du.running` / ChecklistCard of the borrower-visible conditions (R8)
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
import { deliverLoanEstimate, type LoanEstimateDeliveryInput } from "../../origination.ts";
import type { Runtime } from "../../app.ts";
import { timerLabel } from "../record.ts";
import { leadCarriesGoal } from "./14-entry-lead.ts";
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
interface PropertyRow { readonly address_line1: string | null; readonly city: string | null; readonly state: string | null; readonly postal_code: string | null; readonly property_type: string | null; readonly units: number | null; readonly estimated_value_cents: string | null }
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
    deps.runtime.db.query<PropertyRow & Record<string, unknown>>(`SELECT address_line1, city, state, postal_code, property_type, units, estimated_value_cents::text AS estimated_value_cents FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [appId])]);
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
const isTbd = (ctx: Ctx): boolean => !ctx.property?.address_line1;
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
const AUTH_20_3: Record<string, string> = { otp_phone: "otp_phone", otp_email: "otp_email", passkey: "passkey", oidc_google: "oidc_google", password: "otp_email" };
const cents = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v.toString() : String(v));

// ---------------------------------------------------------------- E1/E2/E4: the session hook (every channel; the disclosure first)
async function sessionOpened(deps: FlowDeps, s: SessionOpened): Promise<void> {
  const conv = await deps.ui.conversationFor(s.party_id);
  const subjects = await deps.runtime.db.query<{ application_id: string; id: string; legal_name: string }>(`SELECT application_id, id, legal_name FROM application_borrowers WHERE party_id = $1 ORDER BY created_at, id`, [s.party_id]);
  const appId = subjects[0]?.application_id ?? null;
  const app = appId ? (await deps.runtime.db.query<{ partner_party_id: string; partner_name: string; channel: string; consumer_state: string | null }>(`SELECT a.partner_party_id, p.legal_name AS partner_name, a.channel::text AS channel, (SELECT state FROM application_properties ap WHERE ap.application_id = a.id ORDER BY is_subject DESC, created_at LIMIT 1) AS consumer_state FROM applications a JOIN parties p ON p.id = a.partner_party_id WHERE a.id = $1`, [appId]))[0] ?? null : null;
  const partner = app ? { id: app.partner_party_id, legal_name: app.partner_name } : await partnerOf(deps);
  // E2: the automation disclosure is the first assistant content of the session — before any card, any line, any answer (T1)
  await deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: s.at, sender: "agent", sender_ref: "agent:intake", channel: s.channel, body_text: "{{copy:entry.disclosure.first}}", subject_application_id: appId, voice_turn: s.channel === "voice" });
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
      await sendCard(deps, ctx, me, { kind: "ChoiceCard", copy_key: "entry.goal.question", flow_key: `goal:${appId}`, command_ref: "application.setGoal",
        props: { title: "", options: [{ id: "buy", label: "Buy a home", is_primary: ctx.app.transaction_type === "purchase" }, { id: "lower_rate", label: "Lower my rate or payment", is_primary: ctx.app.transaction_type === "limited_cash_out" }, { id: "cash_out", label: "Take cash out", is_primary: ctx.app.transaction_type === "cash_out" }], command: "application.setGoal",
          command_args_by_option: { buy: { ...base, transaction_type: "purchase" }, lower_rate: { ...base, transaction_type: "limited_cash_out" }, cash_out: { ...base, transaction_type: "cash_out" } }, affirmatives: ["buy a home", "lower my rate", "take cash out"] } });
    }
  }
}

// ---------------------------------------------------------------- E6 / R3 / P1: the consent cards and the connectors on `application.received`
async function consentCards(deps: FlowDeps, ctx: Ctx): Promise<void> {
  const lead_id = leadId(ctx);
  for (const party of ctx.parties) {
    await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.esign.title", flow_key: `consent.esign:${party.party_id}`, command_ref: "consent.capture",
      props: { consent_kind: "esign", disclosure_version_id: ESIGN_DISCLOSURE_VERSION, scope: [...ESIGN_SCOPE], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true, verification_state: "none", affirmatives: ["e-delivery is fine", "e delivery is fine", "yes e-delivery", "yes e delivery", "electronic delivery is fine", "edelivery is fine"],
        command_args: { kind: "esign", method: "checkbox_with_text", scope: [...ESIGN_SCOPE], disclosure_version_id: ESIGN_DISCLOSURE_VERSION, purpose: "informational" } } });
    await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.tcpa.title", flow_key: `consent.tcpa:${party.party_id}`, command_ref: "consent.capture",
      props: { consent_kind: "tcpa_sms", disclosure_version_id: "NTC_TCPA_CONSENT_CONFIRMATION", scope: ["informational"], affirmation_method: "checkbox_with_text", title: "", body_text: "", optional: true, requires_typed_name: true, verification_state: "none", command_args: { kind: "tcpa_sms", method: "checkbox_with_text", purpose: "informational", disclosure_version_id: "NTC_TCPA_CONSENT_CONFIRMATION" } } });
    await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.credit.title", flow_key: `consent.credit:${party.party_id}`, command_ref: "credit.authorize",
      props: { consent_kind: "credit_authorization", disclosure_version_id: CREDIT_AUTHORIZATION_VERSION, scope: ["hard_pull"], affirmation_method: "checkbox_with_text", title: "", body_text: CREDIT_AUTHORIZATION_TEXT, requires_typed_name: true, verification_state: "none", requires_level: "L3", gate: "SM_IDENTITY_IAL2_GATE",
        command_args: { kind: "hard_pull", text_hash: CREDIT_AUTHORIZATION_HASH, authorization_kind: "hard_application", ...(lead_id ? { lead_id } : {}) } } });
    // R3: the payroll connector — free to the borrower and optional before the LE (fee_paid_by=sm opens REGZ_1026_19E2_INTENT_FEE_GATE for it)
    await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "income.connect.purpose", flow_key: `connect.income:${party.party_id}`, command_ref: "verification.connect",
      props: { vendor: "truv_income", purpose_text: "", what_we_get: ["employer", "start date", "pay frequency", "base and variable pay", "year-to-date"], fallback: { label: "Type your monthly income now; we'll ask for paystubs later", document_class: "paystub" }, state: "not_started", pre_intent_optional: true, vendor_fake: "FAKE", command_args: { vendor: "truv_income", component: "income", fee_paid_by: "sm", ...(lead_id ? { lead_id } : {}) } } });
  }
  if (isPurchase(ctx) && isTbd(ctx)) {
    await sendToAll(deps, ctx, StatusCard("preapproval.intro", `preapproval.intro:${ctx.appId}`, { copy_tokens: {} }));
    await sendToAll(deps, ctx, { kind: "ConfirmCard", copy_key: "preapproval.where", flow_key: `preapproval.where:${ctx.appId}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "state", label: "State you're buying in", value: ctx.property?.state ?? "", source: "borrower" }, { path: "price_min_cents", label: "Price range — low", value: "", source: "borrower" }, { path: "price_max_cents", label: "Price range — high", value: "", source: "borrower" }, { path: "down_payment_cents", label: "Down payment", value: "", source: "borrower" }, { path: "first_time_buyer", label: "First-time buyer?", value: "yes", source: "borrower" }],
        commits_to: "prequalifications", money_paths: ["price_min_cents", "price_max_cents", "down_payment_cents"], required_paths: ["state", "price_min_cents", "price_max_cents", "down_payment_cents"], command_args: { path: "preapproval.where", commits_to: "prequalifications", ...(lead_id ? { lead_id } : {}) } } });
  }
}

// ---------------------------------------------------------------- E5: identity → confirm, then the SSN, then R1
async function identityCard(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const abId = String(pl(e)["borrower_id"] ?? "");
  for (const party of ctx.parties.filter((p) => p.application_borrower_id === abId)) {
    const name = prefillOf(party, "legal_name"); const dob = prefillOf(party, "date_of_birth"); const addr = prefillOf(party, "address") ?? prefillOf(party, "current_address");
    if (!name || !dob || !addr) continue;
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.confirm.title", flow_key: `identity.confirm:${party.application_borrower_id}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "legal_name", label: "Legal name", value: name.value, source: name.source }, { path: "date_of_birth", label: "Date of birth", value: dob.value, source: dob.source }, { path: "current_address", label: "Current address", value: addr.value, source: addr.source }], commits_to: "application_borrowers",
        command_args: { path: "identity", commits_to: "application_borrowers", ...(leadId(ctx) ? { lead_id: leadId(ctx) } : {}) } } });
  }
}
async function afterIdentity(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const borrowerId = pl(e)["borrower_id"];
  for (const party of partiesFor(ctx, borrowerId)) {
    const lead = leadId(ctx) ? { lead_id: leadId(ctx) } : {};
    // the one typed field: masked, stored once, never echoed (masked_paths keeps it out of the evidence trail)
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.ssn.title", flow_key: `identity.ssn:${party.application_borrower_id}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "ssn", label: "Social Security number", value: "", source: "borrower" }], commits_to: "application_borrowers", masked_paths: ["ssn"], required_paths: ["ssn"], helper_copy_key: "identity.ssn.why", gate: "FNMA_B2_2_01_SSN_VALIDATION_GATE", command_args: { path: "ssn", source: "borrower", ...lead } } });
    if (!isPurchase(ctx)) {
      const confirmed = prefillOf(party, "current_address") ?? prefillOf(party, "address"); const address = confirmed?.value ?? addressOf(ctx.property) ?? "";
      await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "refi.home.confirm", flow_key: `refi.home:${party.application_borrower_id}`, command_ref: "application.confirmField",
        props: { title: "", fields: [{ path: "property_address", label: "Property address", value: address, source: confirmed?.source ?? "stripe_identity" }, { path: "property_type", label: "Property type", value: ctx.property?.property_type ?? "sfr", source: "public_records" }, { path: "units", label: "Units", value: String(ctx.property?.units ?? 1), source: "public_records" }, { path: "occupancy", label: "Your primary home", value: ctx.app?.occupancy ?? "primary", source: "borrower" }], commits_to: "application_properties",
          command_args: { path: "property_address", commits_to: "application_properties", ...lead } } });
    }
  }
}

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
async function declarationsCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  const borrower_id = intakeBorrowerId(ctx, party);
  await sendCard(deps, ctx, party, { kind: "ChoiceCard", copy_key: "declarations.title", flow_key: `declarations:${party.application_borrower_id}`, command_ref: "application.answerDeclarations",
    props: { title: "", options: [{ id: "none", label: "None of these apply to me", is_primary: true }, { id: "some", label: "Something here applies" }], command: "application.answerDeclarations", list: DECLARATIONS, list_version: DECLARATIONS_LIST_VERSION, list_version_hash: DECLARATIONS_LIST_HASH,
      command_args_by_option: { none: { declarations: DECLARATIONS.map(() => false), borrower_id, list_version: DECLARATIONS_LIST_VERSION, list_version_hash: DECLARATIONS_LIST_HASH }, some: {} }, no_command_options: ["some"], side_quest_on: { some: "SQ-05" }, affirmatives: ["none of these apply", "none apply", "nothing applies"] } });
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
    case "application.received": await consentCards(deps, ctx); return;
    case "identity.verified": await identityCard(deps, ctx, e); return;
    case "application.field.captured": {
      const field = String(p["field"] ?? "");
      if (field === "current_address") await afterIdentity(deps, ctx, e);
      if (field === "citizenship_status") for (const party of partiesFor(ctx, p["borrower_id"])) await declarationsCard(deps, ctx, party);
      return;
    }
    case "application.six_item.captured": {
      if (p["item"] === "income") for (const party of partiesFor(ctx, p["borrower_id"])) await profileCard(deps, ctx, party);
      return;
    }
    case "application.declarations.answered": for (const party of partiesFor(ctx, p["borrower_id"])) await demographicsCard(deps, ctx, party); return;
    case "application.demographics.collected": for (const party of partiesFor(ctx, p["borrower_id"])) await sixItemCards(deps, ctx, party); return;
    case "application.trid_received": {
      const due = await timerDue(deps, ctx.appId, "REGZ_1026_19E1_LE_3BD");
      await sendToAll(deps, ctx, StatusCard("application.received", `application.received:${ctx.appId}`, { next_event_label: timerLabel("REGZ_1026_19E1_LE_3BD"), next_event_at: due, copy_tokens: { date: String(p["trid_application_date"] ?? e.occurredAt.slice(0, 10)), due: due ?? "" } })); return;
    }
    case "verification.received": await incomeCard(deps, ctx, e); return;
    case "credit.report.ordered": {
      // T9: a re-order after a report (one score model for every borrower — 22.2 R11 / 23.1 T11): the neutral line, never a score
      if (has(ctx, "credit.report.received", (x) => typeof x["report_id"] === "string" && x["report_id"] !== p["report_id"]) || has(ctx, "du.submission.errored", (x) => x["error_code"] === "SCORE_MODEL_MIXED")) await sendToAll(deps, ctx, StatusCard("credit.rerun.neutral", `credit.rerun:${String(p["client_order_id"] ?? e.id)}`, { copy_tokens: {} }));
      return;
    }
    case "credit.report.received": if (typeof p["report_id"] === "string" && p["source"] !== "origination") await creditCards(deps, ctx, e); return;
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
};
