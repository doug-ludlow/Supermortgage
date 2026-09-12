/**
 * 32.14 S4 — the prequalified rate (DELTA-13; docs/ux/15-entry-sign-up-and-sign-in.md §2 S4, §6 DELTA-13, §9 T13–T15):
 * 20.3's own worked example rendered as cards — the identity the consumer enters, the soft-pull authorization at L1, the
 * FAKE bureau's tier, 20.4's quote on the S1 estimates, the MLO of record's review, the presented terms and the hand-off
 * to 32.3. It runs BEFORE Reg B's `application.received`, so 32.3's E5/E6/R-path are untouched and start when the borrower
 * proceeds (T14). Every card is 32.1's `send_card` as the intake agent; every borrower command runs from a card through
 * 32.2 / 32.14; nothing here computes a regulatory date or a money figure — dates come from `timers` (3-entry's R9 cards),
 * figures from 20.4's quote and 20.3's own tier.
 *
 *   session opened, the party's organic application not yet received, its lead carrying an S1 goal
 *                                                     ChoiceCard `auth.identity.how`: Scan my ID (32.3 E5 unchanged — the client opens the Stripe FAKE
 *                                                     session; `identity.verified` → 3-entry's ConfirmCard source=stripe_identity, L3) · Type it in
 *   application.field.captured{identity_entry_method}  the same ConfirmCard `identity.confirm.title` with empty fields (source=borrower; the session
 *                                                     stays L1); 3-entry's afterIdentity then sends the SSN card on `current_address` (E5 unchanged)
 *   application.six_item.captured{ssn}                 ConsentCard `consent.credit.soft.title` {credit_authorization, scope [soft_pull], typed name} →
 *                                                     32.2 credit.authorize{soft_pull, consumer_entered_identity} at L1 (DELTA-13: the API states the
 *                                                     fact from the row the cards wrote) → 20.3 captureCreditAuthorization{soft_prequal} + orderSoftPull
 *                                                     (`credit.softpull.requested`, idempotent by authorization id)
 *   credit.softpull.requested                          the FAKE bureau answers → 20.3 orderSoftPull{op: receive} → `credit.softpull.received{tier, frozen, fraud_alert}`
 *   credit.softpull.received                           frozen → StatusCard `credit.freeze.lift` (no adverse inference); else 20.3 explainProgram
 *                                                     {request_prequal, provide_information} on the tier and the S1 estimates, the MLO of record from the
 *                                                     roster (requestQuote{assign_mlo}), 20.4 solvePassThrough on the tier, then requestQuote{request_review}
 *                                                     → `terms.presentation.requested` (3-entry R9 renders `terms.pending_mlo` + PersonCard with
 *                                                     SM_MLO_PREAPP_TERMS_REVIEW_1BH.due_at from `timers`); under origination.ai_mlo_intake=autonomous
 *                                                     the review is skipped (20.3/20.4 present nothing without a review — recorded in BACKEND-DELTAS)
 *   mlo.review.completed{approved}                     3-entry presents (requestQuote{present}) when the review ran on the application; a review that ran
 *                                                     in global scope is presented here by lead id. `terms.presented` → 3-entry's `terms.presented`
 *                                                     StatusCard (personal_terms, mlo_review_approved, the attribution, 20.4's disclaimer block; L2+ —
 *                                                     NO_RATE_BEFORE_MLO_REVIEW refuses any earlier personal card)
 *   terms.presented                                    ChoiceCard `entry.proceed.question`: Show me my rate → 32.14 lead.proceed (20.3 convert →
 *                                                     `application.received`, REGB_1002_9_DECISION_30, 32.3's E6 cards incl. the L3 hard-pull card) ·
 *                                                     Not yet → lead.proceed{not_yet} → `intent.deferred` (nothing ordered, pulled or converted)
 *   intent.deferred                                    the `entry.proceed.not_yet` line; the lead stays `terms_presented` (SM_QUOTE_VALIDITY_GATE governs a
 *                                                     re-quote; SM_LEAD_INACTIVITY_EXPIRY_90 is the only clock)
 */
import { createHash } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { EntityStore } from "../../../app/tools.ts";
import { isUuid } from "../../../infra/db/client.ts";
import { addDays } from "../../../kernel/calendar/date.ts";
import { activeSheetAt, type RateSheet } from "../../../domain/leads-pricing/ops-20-4.ts";
import { civilDate } from "../../../domain/leads-pricing/ops-20-3.ts";
import { FakeSoftPullBureau, type SoftPullBureauPort } from "../../../infra/integrations/credit.ts";
import { mloOfRecord } from "./11-rate-watch.ts";
import type { BorrowerFlow, FlowDeps, SessionOpened } from "./index.ts";

export const FLOW_ID = "32.14";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const PRICING: Actor = { kind: "agent", id: "pricing" };
const RUN = { runId: "flow:32.14-s4", modelVersion: "borrower flows (deterministic)", promptVersion: "32.14" } as const;
type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const s = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const centsOf = (v: unknown): bigint | null => { if (v === undefined || v === null || v === "") return null; if (typeof v === "bigint") return v; const d = String(v).replace(/[^0-9]/g, ""); return d ? BigInt(d) : null; };

/** The soft-pull authorization statement the ConsentCard shows (copy `consent.credit.soft.body`, the partner named); its hash is the authorization's `text_version` (20.3 `credit_authorizations.text_version_hash`). */
export const SOFT_PULL_AUTHORIZATION_VERSION = "credit-authorization-soft-prequal-2026-09";
export const softPullAuthorizationText = (partner: string): string => `I authorize ${partner} to obtain my credit report to prequalify me. This is a soft inquiry and does not affect my credit score. A full credit check happens only if I choose to apply.`;
export const softPullAuthorizationHash = (partner: string): string => sha(softPullAuthorizationText(partner));
/** The identity-entry choice recorded on the interview as a plain 21.1 field (`application.field.captured{field=identity_entry_method}` is what the typed card reacts to). */
export const IDENTITY_ENTRY_FIELD = "identity_entry_method";
/** The prequalification the S4 pull opens on the lead (20.3 rule 4: one per lead, `basis=soft_pull`). */
export const prequalIdOf = (leadId: string): string => `PQ-${leadId.slice(0, 8)}`;
/** The lead-stage quote, one per soft-pull report (a re-quote under SM_QUOTE_VALIDITY_GATE is a new report or a new day's sheet). */
export const quoteIdOf = (leadId: string, reportId: string): string => `Q-PQ-${sha(`${leadId}|${reportId}`).slice(0, 10)}`;
/** The goal tiles' `transaction_intent` values that carry a 21.1 `transaction_type` (DELTA-11) — plus 20.1's coarse `refinance` (D's flow reads it as the rate/payment goal). */
const GOALS: ReadonlySet<string> = new Set(["purchase", "limited_cash_out", "cash_out", "refinance"]);
/** The FAKE bureau (INTEGRATIONS=fake) — one for the runtime's life, so a repeated `credit.softpull.requested` is the same report (idempotent by authorization id); a runtime that lends a `softPullBureau` port wins. */
const FAKE_BUREAU = new FakeSoftPullBureau();
const bureauOf = (deps: FlowDeps): SoftPullBureauPort => (deps.runtime.ports as { softPullBureau?: SoftPullBureauPort }).softPullBureau ?? FAKE_BUREAU;

// ---------------------------------------------------------------- the application + lead context one reaction works on
interface Party { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string; readonly tin_last4: string | null; readonly date_of_birth: string | null }
interface AppRow { readonly id: string; readonly channel: string; readonly transaction_type: string; readonly occupancy: string; readonly partner_party_id: string; readonly partner_name: string }
interface PropertyRow { readonly state: string | null; readonly county: string | null; readonly property_type: string | null; readonly units: number | null; readonly estimated_value_cents: string | null }
interface Ctx { readonly appId: string; readonly app: AppRow; readonly property: PropertyRow | null; readonly parties: readonly Party[]; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly lead: P; readonly leadId: string; readonly now: string }

async function contextForApp(deps: FlowDeps, appId: string): Promise<Ctx | null> {
  const [events, records, parties, apps, props] = await Promise.all([
    deps.runtime.uow.events.byApplication(appId),
    deps.runtime.entities.load({ applicationId: appId }),
    deps.runtime.db.query<Party & P>(`SELECT party_id, id AS application_borrower_id, legal_name, tin_last4, date_of_birth::text AS date_of_birth FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY created_at, id`, [appId]),
    deps.runtime.db.query<AppRow & P>(`SELECT a.id, a.channel::text AS channel, a.transaction_type::text AS transaction_type, a.occupancy::text AS occupancy, a.partner_party_id, p.legal_name AS partner_name FROM applications a JOIN parties p ON p.id = a.partner_party_id WHERE a.id = $1`, [appId]),
    deps.runtime.db.query<PropertyRow & P>(`SELECT state, county, property_type, units, estimated_value_cents::text AS estimated_value_cents FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [appId])]);
  const app = apps[0]; if (!app) return null;
  const store = new EntityStore(); store.seed(records);
  // the application's own lead: by id (one id space), by its `application_id`, else the lead linked to one of its parties (DELTA-11 `lead.linked`) — never the first global lead
  const lead = (store.get("leads", appId)?.data as P | undefined) ?? store.list("leads", (d) => d.application_id === appId || (typeof d.party_id === "string" && parties.some((p) => p.party_id === d.party_id))).map((r) => r.data as P).at(-1) ?? null;
  if (!lead) return null;
  return { appId, app, property: props[0] ?? null, parties, events, store, lead, leadId: s(lead["lead_id"]), now: deps.runtime.clock.now() };
}
/** A lead-keyed event (no application on it: a review completed in global scope) → the lead's application: its `application_id`, the application that shares its id, else its party's open origination application. */
async function contextForLead(deps: FlowDeps, leadId: string): Promise<Ctx | null> {
  const lead = (await deps.runtime.entities.current("leads", leadId))?.data; if (!lead) return null;
  const db = deps.runtime.db;
  // a 20.1/20.2 lead names its servicing party by the interview id ("B1"), never a parties row: only a uuid party links to an application_borrowers row
  const appId = s(lead["application_id"]) || (await db.query<{ id: string }>(`SELECT id FROM applications WHERE id::text = $1`, [leadId]))[0]?.id
    || (isUuid(s(lead["party_id"])) ? (await db.query<{ application_id: string }>(`SELECT ab.application_id FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE ab.party_id = $1 AND a.loan_id IS NULL ORDER BY a.created_at DESC LIMIT 1`, [s(lead["party_id"])]))[0]?.application_id : undefined) || null;
  return appId ? contextForApp(deps, appId) : null;
}
const has = (ctx: Ctx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
/** S4 runs on an organic application the lead opened with an S1 goal, before Reg B's `application.received` (32.3's E3 goal card and E6 consent cards govern every other application). */
const s4Active = (ctx: Ctx): boolean => ctx.app.channel !== "refi_trigger" && !has(ctx, "application.received") && GOALS.has(s(ctx.lead["transaction_intent"])) && !["converted", "expired", "closed_lost"].includes(s(ctx.lead["status"]));
const softAuthorization = (ctx: Ctx): P | undefined => ((ctx.lead["credit_authorizations"] as P[] | undefined) ?? []).find((a) => a["kind"] === "soft_prequal");
const leadParty = (ctx: Ctx): Party | undefined => ctx.parties.find((p) => p.party_id === s(ctx.lead["party_id"])) ?? ctx.parties[0];
const stateOf = (ctx: Ctx): string | null => ctx.property?.state || s(ctx.lead["property_state"]) || s(ctx.lead["consumer_state"]) || null;
/** 21.1's own borrower ids ("B1") map to the application_borrowers row by legal name (the intake record's borrowers list); an unknown id means every party. */
function partiesFor(ctx: Ctx, borrowerId: unknown): readonly Party[] {
  if (typeof borrowerId !== "string" || !borrowerId) return ctx.parties;
  const bs = ((ctx.store.get("applications", ctx.appId)?.data as { borrowers?: { id: string; legal_name: string }[] } | undefined)?.borrowers ?? []);
  const own = ctx.parties.filter((p) => p.application_borrower_id === borrowerId || bs.find((b) => b.id === borrowerId)?.legal_name === p.legal_name);
  return own.length ? own : ctx.parties;
}

// ---------------------------------------------------------------- card and thread primitives (32.1's tools as the intake agent; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly flow_key: string; readonly informational?: boolean }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey]))[0];
}
async function sendCard(deps: FlowDeps, ctx: Ctx, party: Party, c: CardSpec): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID, lead_id: ctx.leadId }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: null, subject: { application_id: ctx.appId }, created_by: "agent:intake", rationale: `32.14 S4 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", ctx.now, { informational: true, resolved_by: "system:flow-32.14" });
  return id;
}
async function say(deps: FlowDeps, ctx: Ctx, party: Party, copy_key: string): Promise<string> {
  const conv = await deps.ui.conversationFor(party.party_id);
  return deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: ctx.now, sender: "agent", sender_ref: "agent:intake", channel: "app", body_text: `{{copy:${copy_key}}}`, subject_application_id: ctx.appId });
}
const exec = (deps: FlowDeps, ctx: Ctx, process: string, name: string, actor: Actor, input: P) => deps.runtime.execute({ process, name, loanId: "", applicationId: ctx.appId, actor, input, run: { ...RUN } });

// ---------------------------------------------------------------- S4 step 1: identity for the pull (Scan my ID — 32.3 E5 unchanged — or Type it in)
async function identityHowCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  await sendCard(deps, ctx, party, { kind: "ChoiceCard", copy_key: "auth.identity.how", flow_key: `prequal.identity:${ctx.leadId}:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", options: [{ id: "scan", label: "Scan my ID (30 seconds)", is_primary: true, action: { kind: "identity_session", vendor: "stripe_identity", vendor_fake: "FAKE" } }, { id: "type", label: "Type it in" }], command: "application.confirmField",
      command_args: { path: "identity_entry", commits_to: "applications", lead_id: ctx.leadId }, command_args_by_option: { scan: {}, type: { fields: [{ path: IDENTITY_ENTRY_FIELD, value: "typed", source: "borrower" }] } }, no_command_options: ["scan"], affirmatives: ["scan my id", "type it in"] } });
}
/** "Type it in": the same ConfirmCard 32.3 E5 sends from the vendor's extraction, with empty fields the consumer types (source=borrower); the SSN card follows from 3-entry on `current_address` (E5 unchanged). */
async function typedIdentityCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.confirm.title", flow_key: `identity.confirm:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", fields: [{ path: "legal_name", label: "Legal name", value: "", source: "borrower" }, { path: "date_of_birth", label: "Date of birth", value: "", source: "borrower" }, { path: "current_address", label: "Current address", value: "", source: "borrower" }], required_paths: ["legal_name", "date_of_birth", "current_address"], commits_to: "application_borrowers", source: "borrower", entry: "typed",
      command_args: { path: "identity", commits_to: "application_borrowers", lead_id: ctx.leadId } } });
}

// ---------------------------------------------------------------- S4 step 2: the soft-pull authorization at L1 (DELTA-13)
async function softPullConsentCard(deps: FlowDeps, ctx: Ctx, party: Party): Promise<void> {
  const partner = ctx.app.partner_name; const text = softPullAuthorizationText(partner);
  await sendCard(deps, ctx, party, { kind: "ConsentCard", copy_key: "consent.credit.soft.title", flow_key: `prequal.softpull:${ctx.leadId}:${party.application_borrower_id}`, command_ref: "credit.authorize",
    props: { consent_kind: "credit_authorization", disclosure_version_id: SOFT_PULL_AUTHORIZATION_VERSION, scope: ["soft_pull"], affirmation_method: "checkbox_with_text", title: "", body_text: text, body_copy_key: "consent.credit.soft.body", requires_typed_name: true, verification_state: "none", requires_level: "L1", soft_inquiry: true, copy_tokens: { "partner.legal_name": partner },
      command_args: { kind: "soft_pull", text_hash: sha(text), authorization_kind: "soft_prequal", consumer_entered_identity: true, lead_id: ctx.leadId } } });
}

// ---------------------------------------------------------------- S4 step 3: the FAKE bureau answers the request (20.3 orderSoftPull{op: receive})
async function onSoftPullRequested(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (s(p["lead_id"]) && s(p["lead_id"]) !== ctx.leadId) return;
  if (ctx.lead["soft_pull_report"]) return;   // the report is on the lead already — one vendor request per authorization (20.3 T3)
  const authorization_id = s(p["authorization_id"]) || s(ctx.lead["credit_authorization_id"]); if (!authorization_id) return;
  const party = leadParty(ctx);
  const result = await bureauOf(deps).pull({ authorization_id, lead_id: ctx.leadId, ssn_last4: party?.tin_last4 ?? null, legal_name: party?.legal_name ?? null, date_of_birth: party?.date_of_birth ?? null }, ctx.now);
  deps.logger?.info("borrower.flow.32-14.softpull", { lead_id: ctx.leadId, authorization_id, vendor: result.vendor, report_id: result.report_id, frozen: result.frozen, fraud_alert: result.fraud_alert });   // never the score
  await exec(deps, ctx, "20.3", "orderSoftPull", INTAKE, { op: "receive", lead_id: ctx.leadId, report_id: result.report_id, representative_score: result.representative_score, score_model: result.score_model, frozen: result.frozen, fraud_alert: result.fraud_alert });
}

// ---------------------------------------------------------------- S4 step 4: the tier → 20.3 prequalification, 20.4's quote, the MLO of record's review
/** The S1 estimates the quote is priced on (20.3 rule 6 facts on the lead — never a figure the consumer did not state): value + own-stated balance for a refinance / cash-out, price range − down payment for a purchase. */
function estimatesOf(ctx: Ctx): { value: bigint | null; amount: bigint | null; price: bigint | null } {
  const L = ctx.lead;
  if (ctx.app.transaction_type === "purchase") { const price = centsOf(L["price_range_cents"]); const down = centsOf(L["down_payment_cents"]) ?? 0n; return { value: price, amount: price !== null && price > down ? price - down : null, price }; }
  return { value: centsOf(L["value_estimate_cents"]), amount: centsOf(L["stated_existing_balance_cents"]), price: null };
}
/** 20.4's inputs for the lead-stage quote: the program default product, the sheet's own shortest lock period, the tier from the report, the S1 estimates, the partner's cost schedule for the state — no county, no escrow figures and no dates the consumer has not given (the APR estimate waits for the Loan Estimate). */
function quoteInputsFor(deps: FlowDeps, ctx: Ctx, report: P, est: { value: bigint; amount: bigint; price: bigint | null }): P | null {
  const state = stateOf(ctx); if (!state) { deps.logger?.info("borrower.flow.32-14.no_state", { lead_id: ctx.leadId }); return null; }
  const sheet = activeSheetAt(ctx.store.list("rate_sheets").map((r) => r.data as unknown as RateSheet), ctx.now); if (!sheet) { deps.logger?.info("borrower.flow.32-14.no_sheet", { lead_id: ctx.leadId }); return null; }
  const period = sheet.prices.filter((p) => p.product_code === "FRM30" && p.term_months === 360).map((p) => p.lock_period_days).sort((a, b) => a - b)[0]; if (!period) { deps.logger?.info("borrower.flow.32-14.no_frm30", { lead_id: ctx.leadId, rate_sheet_id: sheet.rate_sheet_id }); return null; }
  const cost = ctx.store.list("sm_cost_schedules").map((r) => r.data as P).find((c) => c["state"] === state && c["transaction_type"] === ctx.app.transaction_type); if (!cost) { deps.logger?.info("borrower.flow.32-14.no_cost_schedule", { lead_id: ctx.leadId, state, transaction_type: ctx.app.transaction_type }); return null; }
  const on = civilDate(ctx.now, s(ctx.lead["time_zone"]) || "America/New_York"); const score_model = s(report["score_model"]) || "classic_fico";
  return { product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type: ctx.app.transaction_type, occupancy: ctx.app.occupancy, property_type: ctx.property?.property_type ?? "sfr", units: ctx.property?.units ?? 1, loan_amount_cents: est.amount.toString(), value_cents: est.value.toString(), purchase_price_cents: est.price?.toString() ?? null,
    representative_score: typeof report["representative_score"] === "number" ? report["representative_score"] : null, score_model, score_source: `soft_pull:${s(report["report_id"])}`, borrower_score_models: [score_model],
    state, county: ctx.property?.county ?? "unspecified", county_limit_cents: null, subordinate_financing_cents: "0", mi_option: "none", homeready: false, homeready_evaluation: null, first_time_homebuyer: false, fthb_ami_waiver: false, dts_waiver: false, very_low_income: false,
    lock_period_days: period, expected_purchase_ready_date: addDays(on, period), escrowed: true, valuation_method: s(cost["valuation_method"]) || "hybrid", borrower_pays_third_party_costs: false, taxes_annual_cents: null, insurance_annual_cents: null, mi_annual_rate_pct: null, assumed_disbursement_date: null, first_payment_date: null };
}
async function onSoftPullReceived(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (s(p["lead_id"]) && s(p["lead_id"]) !== ctx.leadId) return;
  const party = leadParty(ctx); if (!party) return;
  const report = (ctx.lead["soft_pull_report"] as P | null) ?? p; const reportId = s(report["report_id"] ?? p["report_id"]);
  // a frozen file: the lift instructions, nothing inferred, nothing priced (20.3 receiveSoftPull; copy `credit.freeze.lift`)
  if (p["frozen"] === true || report["frozen"] === true) {
    await sendCard(deps, ctx, party, { kind: "StatusCard", copy_key: "credit.freeze.lift", flow_key: `prequal.freeze:${ctx.leadId}:${reportId}`, informational: true, props: { state_label: "", report_id: reportId, adverse_inference: false, retry: "credit.authorize", copy_tokens: {} } });
    await say(deps, ctx, party, "credit.freeze.lift");
    return;
  }
  // 20.3 rule 4: the prequalification on the report's tier and the S1 estimates (`exploring → prequal_requested → prequalified`)
  const est = estimatesOf(ctx); const prequal_id = s(ctx.lead["prequal_id"]) || prequalIdOf(ctx.leadId);
  const prequals = (ctx.lead["prequalifications"] as P[] | undefined) ?? [];
  if (!prequals.some((q) => q["prequal_id"] === prequal_id)) await exec(deps, ctx, "20.3", "explainProgram", INTAKE, { op: "request_prequal", lead_id: ctx.leadId, prequal_id, value_estimate_cents: est.value?.toString() ?? null, loan_amount_range_cents: est.amount !== null ? [est.amount.toString(), est.amount.toString()] : null });
  if (!prequals.some((q) => q["prequal_id"] === prequal_id && q["outcome"])) await exec(deps, ctx, "20.3", "explainProgram", INTAKE, { op: "provide_information", lead_id: ctx.leadId, program_fit: { basis: "soft_pull", tier: s(p["tier"] ?? report["tier"]) || null, product_code: "FRM30", transaction_type: ctx.app.transaction_type, fraud_alert: p["fraud_alert"] === true } });
  if (est.value === null || est.amount === null) { deps.logger?.info("borrower.flow.32-14.no_estimates", { lead_id: ctx.leadId, transaction_type: ctx.app.transaction_type }); return; }
  // 20.4's personalized quote on the tier — a draft nobody sees until the MLO of record approves it (NO_RATE_BEFORE_MLO_REVIEW)
  const quote_id = quoteIdOf(ctx.leadId, reportId);
  if (!ctx.store.get("pricing_quotes", quote_id)) {
    const inputs = quoteInputsFor(deps, ctx, report, { value: est.value, amount: est.amount, price: est.price }); if (!inputs) return;
    await exec(deps, ctx, "20.4", "solvePassThrough", PRICING, { inputs, quote_id, purpose: "lead_quote", partner_id: s(ctx.lead["partner_id"]) || ctx.app.partner_party_id, lead_id: ctx.leadId, application_id: ctx.appId });
  }
  // the MLO of record for the state (the partner's roster — 21.1 rule 7 / 31.1), assigned on the lead before particular terms are requested (§1026.36(g))
  if (!s(ctx.lead["mlo_of_record_id"])) {
    const mlo = mloOfRecord(ctx.events, ctx.store, ctx.store.list("mlo_roster").map((r) => r.data as P), stateOf(ctx));
    if (!mlo) { deps.logger?.error("borrower.flow.32-14.no_mlo_of_record", { lead_id: ctx.leadId, state: stateOf(ctx) }); return; }
    await exec(deps, ctx, "20.3", "requestQuote", INTAKE, { op: "assign_mlo", lead_id: ctx.leadId, mlo_of_record_id: mlo.mlo_of_record_id, mlo_name: mlo.name, mlo_nmlsr_id: mlo.nmlsr_id });
  }
  // 20.3 rule 7: the review request (SM_MLO_PREAPP_TERMS_REVIEW_1BH); under `autonomous` it is skipped — 20.3/20.4 have no presentation without a completed review, so no terms are presented either (BACKEND-DELTAS: DELTA-13 note)
  const mode = s(ctx.store.get("feature_flags", "origination.ai_mlo_intake")?.data["value"]) || "assisted";
  if (mode === "autonomous") { deps.logger?.info("borrower.flow.32-14.review_skipped", { lead_id: ctx.leadId, quote_id, mode }); return; }
  if (((ctx.lead["quote_ids"] as string[] | undefined) ?? []).includes(quote_id) || has(ctx, "terms.presentation.requested", (x) => x["quote_id"] === quote_id)) return;
  await exec(deps, ctx, "20.3", "requestQuote", INTAKE, { op: "request_review", lead_id: ctx.leadId, quote_id });
}

// ---------------------------------------------------------------- S4 step 5: the review that ran in global scope (no application on the event) is presented here; the application-scoped one is 3-entry R9's
async function presentByLead(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["outcome"] !== "approved") return; const quoteId = s(p["quote_id"]);
  if (has(ctx, "terms.presented", (x) => x["quote_id"] === quoteId)) return;
  await exec(deps, ctx, "20.3", "requestQuote", INTAKE, { op: "present", lead_id: ctx.leadId, quote_id: quoteId, review_id: s(p["review_id"]) });
}

// ---------------------------------------------------------------- S4 step 6: proceed (→ 32.3) or not yet
async function proceedCard(deps: FlowDeps, ctx: Ctx, party: Party, quoteId: string): Promise<void> {
  await sendCard(deps, ctx, party, { kind: "ChoiceCard", copy_key: "entry.proceed.question", flow_key: `prequal.proceed:${ctx.leadId}:${quoteId}`, command_ref: "lead.proceed",
    props: { title: "", quote_id: quoteId, options: [{ id: "proceed", label: "Show me my rate", is_primary: true }, { id: "not_yet", label: "Not yet" }], command: "lead.proceed", command_args: { lead_id: ctx.leadId, quote_id: quoteId, borrower_name: party.legal_name, occupancy: ctx.app.occupancy },
      command_args_by_option: { proceed: { choice: "proceed" }, not_yet: { choice: "not_yet" } }, affirmatives: ["show me my rate", "my rate", "not yet"] } });
}

// ---------------------------------------------------------------- the reactions
async function react(deps: FlowDeps, ctx: Ctx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "application.field.captured": { if (p["field"] === IDENTITY_ENTRY_FIELD && s4Active(ctx)) for (const party of partiesFor(ctx, p["borrower_id"])) await typedIdentityCard(deps, ctx, party); return; }
    case "application.six_item.captured": { if (p["item"] === "ssn" && s4Active(ctx) && !softAuthorization(ctx)) for (const party of partiesFor(ctx, p["borrower_id"])) await softPullConsentCard(deps, ctx, party); return; }
    case "credit.softpull.requested": { if (s4Active(ctx)) await onSoftPullRequested(deps, ctx, e); return; }
    case "credit.softpull.received": { if (s4Active(ctx)) await onSoftPullReceived(deps, ctx, e); return; }
    case "mlo.review.completed": { if (!e.applicationId && s4Active(ctx)) await presentByLead(deps, ctx, e); return; }
    case "terms.presented": { const party = leadParty(ctx); if (party && s4Active(ctx)) await proceedCard(deps, ctx, party, s(p["quote_id"])); return; }
    case "intent.deferred": { const party = leadParty(ctx); if (party) await say(deps, ctx, party, "entry.proceed.not_yet"); return; }
    default: return;
  }
}
const REACTS = new Set(["application.field.captured", "application.six_item.captured", "credit.softpull.requested", "credit.softpull.received", "mlo.review.completed", "terms.presented", "intent.deferred"]);

/** The session hook (after 3-entry's disclosure line and `party.authenticate`, and after 32.14's lead flow created the application from the lead): the identity ask opens S4 once per lead. */
async function onSessionOpened(deps: FlowDeps, sess: SessionOpened): Promise<void> {
  const apps = await deps.runtime.db.query<{ application_id: string }>(`SELECT DISTINCT ab.application_id FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE ab.party_id = $1 AND a.loan_id IS NULL ORDER BY ab.application_id`, [sess.party_id]);
  for (const a of apps) {
    const ctx = await contextForApp(deps, a.application_id);
    if (!ctx || !s4Active(ctx) || softAuthorization(ctx)) continue;
    const me = ctx.parties.find((x) => x.party_id === sess.party_id); if (!me) continue;
    await identityHowCard(deps, ctx, me);
  }
}

export const FLOW_14_PREQUAL: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => REACTS.has(type),
  async onEvents(deps, events) {
    const byApp = new Map<string, DomainEvent[]>(); const byLead = new Map<string, DomainEvent[]>();
    for (const e of events) {
      const app = e.applicationId ?? (typeof pl(e)["application_id"] === "string" ? s(pl(e)["application_id"]) : "");
      const key = app ? byApp : byLead; const id = app || s(pl(e)["lead_id"]) || (e.aggregate?.kind === "lead" ? s(e.aggregate.id) : "");
      if (!id) continue; const list = key.get(id) ?? []; list.push(e); key.set(id, list);
    }
    for (const [appId, list] of byApp) {
      const ctx = await contextForApp(deps, appId); if (!ctx || !ctx.parties.length) continue;   // no party has signed in: no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-14.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
    }
    for (const [leadId, list] of byLead) {
      const ctx = await contextForLead(deps, leadId); if (!ctx || !ctx.parties.length) continue;
      for (const e of list) { try { await react(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-14.reaction", { event: e.type, lead_id: leadId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  onSessionOpened,
};
