/**
 * 32.11 — Rate-watch and the re-refinance loop (spec/sections/32-borrower-experience/32-11-*.md): the borrower-facing
 * form of 20.1 (detection, the gates, the request path), 20.2 (the offer and its channels), 20.3 (the inquiry lead and the
 * MLO review of the offer's terms), 21.1 (the compressed application), 22.3 (the standing payroll connection — DELTA-05),
 * 16.2 / 30.3 (the same-servicer payoff and the escrow credit) and 7.4 (consents). Every card here is created through
 * 32.1's `send_card` (the `borrower-comms` agent owns the post-funding thread; the compressed application's cards are the
 * `intake` agent's); nothing here computes a regulatory date or a money figure — dates come from `timers`, figures from
 * the owning process's own rows (`refi_opportunities`, `pricing_quotes`, `loan_terms`); the block stays passive until an
 * opportunity exists and never names an investor or promises future terms (§7).
 *
 *   refi.opportunity.offer_ready                 the inquiry lead + the MLO of record's review of the offer's terms (20.3 requestQuote
 *                                                request_review on a 20.4 quote of the candidate) → StatusCard `terms.pending_mlo`
 *   mlo.review.completed{approved}               20.3 present → OfferCard once the opportunity is `offered` (proactive) or `offer_ready`
 *                                                (borrower_request); expiry = SM_REFI_OPPORTUNITY_EXPIRY_30.due_at, never computed (T3)
 *   refi.opportunity.offered                     OfferCard (in-app channel) — e-mail is 20.2's; voice/SMS never from here (T2); never
 *                                                after a `never` (block passive) (T5)
 *   refi.opportunity.declined / .expired         the pending OfferCard cancelled / expired; `offer.not_now` line; nothing on expiry (T4)
 *   consent.marketing.revoked                    `offer.never` line + 20.2's all_marketing suppression (T5)
 *   refi.opportunity.engaged{lead_id}            after a Yes on the card: the compressed application (runtime createApplication with
 *                                                prior_loan_id, 20.3 convert, 20.1 converted, 21.1 interview + the servicing-record prefills) (T6)
 *   application.received{prior_loan_id}          the compressed cards: home (servicing_record), name/SSN on file, value (AVM), loan amount
 *                                                (payoff-based), profile (prior_application), declarations + demographics again, credit hard
 *                                                pull, E-SIGN scope extension; income from the standing connection (FAKE Truv refresh under the
 *                                                blanket authorization) else ConnectCard{truv_income} (T6, T9)
 *   loan.funded{prior_loan_id}                   StatusCard `refi.same_servicer.funded` (+ the autopay line) (T7)
 *   escrow.credit_to_new_loan.posted             the `refi.escrow.moved` line on the old loan's thread (T7)
 *   loan.boarded                                 ConsentCards `consent.tcpa.marketing.title` (PEWC, once) and `consent.standing.title` (DELTA-05)
 *   consent.granted{blanket_verification…}       ChoiceCard `consent.standing.manage` — the Loan section's revocation (T9)
 *   message "can I refinance?"                   32.2 refi.request → 20.1's request path (skips the solicitation gates) (T1, T4)
 */
import { randomUUID } from "node:crypto";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import type { CardInstanceRow } from "../../../infra/db/borrower-ui.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import { EntityStore } from "../../../app/tools.ts";
import { candidateQuoteInputs, type UniverseLoan, type CandidateTerms } from "../../../domain/leads-pricing/ops-20-1.ts";
import { FakeTruv } from "../vendors/fake-truv.ts";
import { DECLARATIONS, DECLARATIONS_LIST_VERSION, DECLARATIONS_LIST_HASH, CREDIT_AUTHORIZATION_TEXT, CREDIT_AUTHORIZATION_VERSION, CREDIT_AUTHORIZATION_HASH } from "./3-entry.ts";
import type { BorrowerFlow, FlowDeps, FlowReply, InboundMessage } from "./index.ts";

export const FLOW_ID = "32.11";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const PRICING: Actor = { kind: "agent", id: "pricing" };
const VERIFICATION: Actor = { kind: "agent", id: "verification" };
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const RUN = { runId: "flow:32.11", modelVersion: "borrower flows (deterministic)", promptVersion: "32.11" } as const;
/** The post-funding thread is the borrower-comms agent's (32.11 AI agent design); the compressed application's cards are the intake agent's. */
export const CREATED_BY_COMMS = "agent:borrower-comms";
export const CREATED_BY_INTAKE = "agent:intake";
/** The OfferCard's fixed lines (32.11 §2; 32.1 §7.3: "not a commitment to lend; rates change daily", never "guaranteed"). */
export const NOT_A_COMMITMENT_TEXT = "This is not a commitment to lend;";
export const RATES_CHANGE_DAILY_TEXT = "rates change daily.";
export const NO_COST_LINE = "No lender fees and no third-party closing costs charged to you — Supermortgage pays them and they're reflected in the rate.";
export const paymentLine = (term: number, pi: string): string => `${term} monthly principal-and-interest payments of ${pi}; payments do not include taxes and insurance, so your actual payment will be higher.`;
export const lenderLine = (partner: string, nmlsr: string): string => `${partner}, NMLSR ID ${nmlsr}, is your lender; Supermortgage services your loan for ${partner}.`;
/** A typed "can I refinance?" / "what would a refinance look like?" (32.11 §1) — never cash-out unless the borrower names it (20.1 classifies). */
export const REFI_REQUEST = /\b(refinanc\w*|re-?fi\b|lower (?:my )?(?:rate|payment)|better rate)\b/i;
/** The FAKE payroll connector the standing authorization refreshes through (DELTA-05: refreshed only after a Yes on an offer). */
export const STANDING_TRUV = new FakeTruv();
export const STANDING_DISCLOSURE_VERSION = "DELTA-05-standing-authorization-v1";
export const MARKETING_DISCLOSURE_VERSION = "NTC_TCPA_CONSENT_CONFIRMATION";
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents: string | bigint | number | null | undefined): string => (cents === null || cents === undefined ? "" : USD.format(Number(BigInt(String(cents))) / 100));
/** 20.1's `note_rate` is a decimal fraction ("0.06125"); loan_terms carry bps (61250); the sheet carries "6.125" — every path renders "6.125". */
export const pct = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v); if (!Number.isFinite(n)) return null;
  return (n < 1 ? n * 100 : n > 100 ? n / 10_000 : n).toFixed(3);
};

type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------- the loan context one batch works on (a serviced loan on the book)
interface Party { readonly party_id: string; readonly legal_name: string; readonly application_borrower_id: string | null; readonly contact: P }
interface LoanRow { readonly id: string; readonly partner_party_id: string; readonly partner_name: string; readonly origination_application_id: string | null; readonly servicer_loan_number: string | null; readonly first_payment_date: string | null; readonly note_rate_bps: string | null; readonly pi_cents: string | null; readonly escrow_payment_cents: string | null; readonly property_id: string | null }
interface PropertyRow { readonly address_line1: string | null; readonly city: string | null; readonly state: string | null; readonly postal_code: string | null; readonly county: string | null; readonly property_type: string | null; readonly occupancy: string | null; readonly units: number | null }
interface LoanCtx { readonly loanId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly now: string; readonly loan: LoanRow | null; readonly property: PropertyRow | null; readonly origEvents: readonly DomainEvent[]; readonly origStore: EntityStore }
const hasL = (ctx: LoanCtx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));
const lastL = (ctx: LoanCtx, type: string, where: (p: P) => boolean = () => true): DomainEvent | undefined => ctx.events.filter((e) => e.type === type && where(pl(e))).at(-1);

async function partiesOfLoan(deps: FlowDeps, loanId: string, origAppId: string | null): Promise<Party[]> {
  const out: Party[] = [];
  if (origAppId) for (const r of await deps.runtime.db.query<Party & P>(`SELECT party_id, legal_name, id AS application_borrower_id, contact FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY (borrower_role::text = 'borrower') DESC, created_at, id`, [origAppId])) out.push(r);
  for (const r of await deps.runtime.db.query<Party & P>(`SELECT b.party_id, b.legal_name, NULL::uuid AS application_borrower_id, '{}'::jsonb AS contact FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL ORDER BY lb.is_primary DESC`, [loanId])) if (!out.some((p) => p.party_id === r.party_id)) out.push(r);
  return out;
}
async function loanContext(deps: FlowDeps, loanId: string): Promise<LoanCtx> {
  const loan = (await deps.runtime.db.query<LoanRow & P>(`SELECT l.id, l.partner_party_id, p.legal_name AS partner_name, l.origination_application_id, l.servicer_loan_number, l.first_payment_date::text AS first_payment_date, lt.note_rate_bps::text AS note_rate_bps, lt.pi_cents::text AS pi_cents, lt.escrow_payment_cents::text AS escrow_payment_cents, l.property_id FROM loans l JOIN parties p ON p.id = l.partner_party_id LEFT JOIN LATERAL (SELECT * FROM loan_terms t WHERE t.loan_id = l.id ORDER BY t.effective_from DESC, t.created_at DESC LIMIT 1) lt ON true WHERE l.id = $1`, [loanId]))[0] ?? null;
  const origAppId = loan?.origination_application_id ?? null;
  const [events, records, parties, property, origEvents, origRecords] = await Promise.all([
    deps.runtime.uow.events.byLoan(loanId), deps.runtime.entities.load({ loanId }), partiesOfLoan(deps, loanId, origAppId),
    loan?.property_id ? deps.runtime.db.query<PropertyRow & P>(`SELECT address_line1, city, state, postal_code, county, property_type, occupancy, units FROM properties WHERE id = $1`, [loan.property_id]).then((r) => r[0] ?? null) : Promise.resolve(null),
    origAppId ? deps.runtime.uow.events.byApplication(origAppId) : Promise.resolve([] as DomainEvent[]), origAppId ? deps.runtime.entities.load({ applicationId: origAppId }) : Promise.resolve([])]);
  const store = new EntityStore(); store.seed(records); const origStore = new EntityStore(); origStore.seed(origRecords);
  return { loanId, events, store, parties, now: deps.runtime.clock.now(), loan, property, origEvents, origStore };
}
const opportunityOf = (ctx: LoanCtx, id: string): P | undefined => ctx.store.get("refi_opportunities", id)?.data as P | undefined;
const universeOf = (ctx: LoanCtx): UniverseLoan | undefined => ctx.store.get("refi_universe", ctx.loanId)?.data as unknown as UniverseLoan | undefined;
const programOf = (ctx: LoanCtx, programId: unknown): P | undefined => (typeof programId === "string" ? (ctx.store.get("partner_programs", programId)?.data as P | undefined) : undefined);
const addressOf = (p: PropertyRow | null): string | null => (p?.address_line1 ? [p.address_line1, p.city, [p.state, p.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null);

/** The loan's MLO of record (31.1 roster / 21.1 assignment on the origination record; the LE/CD attribution as the fallback) — the OfferCard always names them (§7). */
export function mloOfRecord(origEvents: readonly DomainEvent[], origStore: EntityStore, roster: readonly P[], state: string | null): { mlo_of_record_id: string; name: string; nmlsr_id: string } | null {
  const assigned = origEvents.filter((e) => e.type === "application.mlo_of_record.assigned" || e.type === "application.mlo_of_record.reassigned" || e.type === "mlo.assigned").at(-1);
  if (assigned) { const p = pl(assigned); const nmlsr = s(p["nmlsr_id"] ?? p["mlo_nmlsr_id"]); if (nmlsr) return { mlo_of_record_id: s(p["mlo_of_record_id"]) ?? `mlo-${nmlsr}`, name: s(p["mlo_name"]) ?? s(p["name"]) ?? "your loan officer", nmlsr_id: nmlsr }; }
  const app = origStore.list("applications")[0]?.data as P | undefined;
  if (app && s(app["mlo_nmlsr_id"] ?? app["mlo_of_record_nmlsr_id"])) return { mlo_of_record_id: s(app["mlo_of_record_id"]) ?? `mlo-${String(app["mlo_nmlsr_id"])}`, name: s(app["mlo_name"]) ?? "your loan officer", nmlsr_id: String(app["mlo_nmlsr_id"] ?? app["mlo_of_record_nmlsr_id"]) };
  for (const e of [...origEvents].reverse()) {
    const p = pl(e); const lo = (p["loan_officer"] as P | undefined) ?? (p["parties"] as P | undefined);
    if (lo && s(lo["nmlsr_id"] ?? lo["mlo_nmlsr_id"])) return { mlo_of_record_id: `mlo-${String(lo["nmlsr_id"] ?? lo["mlo_nmlsr_id"])}`, name: s(lo["name"] ?? lo["mlo_name"]) ?? "your loan officer", nmlsr_id: String(lo["nmlsr_id"] ?? lo["mlo_nmlsr_id"]) };
  }
  const entry = roster.find((m) => m["nmls_status"] === "active" && (!state || (Array.isArray(m["licensed_states"]) && (m["licensed_states"] as string[]).includes(state))));
  if (entry) return { mlo_of_record_id: String(entry["mlo_id"]), name: String(entry["name"]), nmlsr_id: String(entry["nmlsr_id"]) };
  return null;
}
/** The partner's NMLSR ID from the origination record (21.1's interview / 21.2's LE / 25.2's CD) — the lender line of every rate-bearing message (32.1 §7.3). */
function partnerNmlsr(origEvents: readonly DomainEvent[], origStore: EntityStore): string {
  const app = origStore.list("applications")[0]?.data as P | undefined; if (app && s(app["partner_nmlsr_id"])) return String(app["partner_nmlsr_id"]);
  for (const e of [...origEvents].reverse()) { const p = pl(e); const c = (p["creditor"] as P | undefined) ?? (p["parties"] as P | undefined); const n = s(c?.["nmlsr_id"] ?? c?.["creditor_nmlsr_id"] ?? p["partner_nmlsr_id"] ?? p["creditor_nmlsr_id"]); if (n) return n; }
  return "";
}

// ---------------------------------------------------------------- card and thread primitives (32.1's tools; idempotent on `flow_key`)
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly body_text?: string; readonly expires_at?: string | null; readonly flow_key: string; readonly informational?: boolean; readonly personal_terms?: boolean; readonly created_by?: string }
type Subject = { application_id?: string | null; loan_id?: string | null };
/** One card per party, flow key and subject: the same key on a later loan or a later application is a new card (the standing-consent card is offered after every funding; the compressed application's cards are its own). */
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string, subject: Subject): Promise<{ card_instance_id: string; status: string } | undefined> {
  const where = subject.application_id ? "subject_application_id = $3" : "subject_loan_id = $3";
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 AND ${where} ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey, subject.application_id ?? subject.loan_id ?? ""]))[0];
}
async function sendCard(deps: FlowDeps, subject: Subject, party: Pick<Party, "party_id">, c: CardSpec, now: string): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key, subject);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: subject.loan_id ?? "", ...(subject.application_id ? { applicationId: subject.application_id } : {}), actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: c.body_text ?? null, expires_at: c.expires_at ?? null, subject: { application_id: subject.application_id ?? null, loan_id: subject.loan_id ?? null }, created_by: c.created_by ?? CREATED_BY_COMMS,
      ...(c.personal_terms ? { personal_terms: true, mlo_review_approved: true } : {}), rationale: `32.11 ${c.kind} ${c.copy_key} on ${c.flow_key}` } });
  const id = (r.output as { card_instance_id: string }).card_instance_id;
  if (c.informational) await deps.ui.transitionCard(id, "resolved", "system", now, { informational: true, resolved_by: "system:flow-32.11" });
  return id;
}
const StatusCard = (copy_key: string, flow_key: string, props: P = {}, created_by = CREATED_BY_COMMS): CardSpec => ({ kind: "StatusCard", copy_key, props: { state_label: "", ...props }, flow_key, informational: true, created_by });
/** A one-line agent message in the thread (a receipt or a reply the copy library names). */
async function say(deps: FlowDeps, partyId: string, subject: Subject, copyKey: string, now: string, sender_ref = CREATED_BY_COMMS): Promise<void> {
  const conv = await deps.ui.conversationFor(partyId);
  await deps.ui.appendMessage({ conversation_id: conv.conversation_id, at: now, sender: "agent", sender_ref, channel: "app", body_text: `{{copy:${copyKey}}}`, subject_application_id: subject.application_id ?? null, subject_loan_id: subject.loan_id ?? null });
}
async function timerDue(deps: FlowDeps, where: { loan_id?: string; application_id?: string }, code: string): Promise<string | null> {
  const t = (await deps.runtime.db.query<{ due_at: string | null }>(`SELECT due_at FROM timers WHERE code = $3 AND (($1::uuid IS NOT NULL AND loan_id = $1) OR ($2::uuid IS NOT NULL AND application_id = $2)) AND status IN ('armed', 'breached', 'satisfied', 'satisfied_late') ORDER BY armed_at DESC LIMIT 1`, [where.loan_id ?? null, where.application_id ?? null, code]))[0];
  return t?.due_at ?? null;
}
async function exec(deps: FlowDeps, subject: Subject, process: string, name: string, actor: Actor, input: P): Promise<P> {
  const r = await deps.runtime.execute({ process, name, loanId: subject.loan_id ?? "", ...(subject.application_id ? { applicationId: subject.application_id } : {}), actor, run: { ...RUN }, input });
  return (r.output ?? {}) as P;
}

// ---------------------------------------------------------------- §2 the offer: the inquiry lead, the MLO review of the terms, the OfferCard
const leadIdFor = (opportunityId: string): string => `L-offer-${opportunityId}`.slice(0, 200);
const quoteIdFor = (opportunityId: string): string => `Q-OFFER-${opportunityId}`.slice(0, 200);
const marketingNever = (ctx: LoanCtx): boolean => { const revoked = lastL(ctx, "consent.marketing.revoked", (p) => p["reason"] === "never_proactive_offers"); if (!revoked) return false; const later = ctx.events.filter((e) => e.type === "consent.granted" && (pl(e)["purpose"] === "marketing" || (Array.isArray(pl(e)["scope"]) && (pl(e)["scope"] as unknown[]).includes("marketing"))) && Number(e.sequence ?? 0) > Number(revoked.sequence ?? 0)); return later.length === 0; };
const presentedFor = (ctx: LoanCtx, opportunityId: string): DomainEvent | undefined => lastL(ctx, "terms.presented", (p) => p["quote_id"] === quoteIdFor(opportunityId)) ?? lastL(ctx, "mlo.review.completed", (p) => p["quote_id"] === quoteIdFor(opportunityId) && p["outcome"] === "approved");

/** offer_ready → the MLO of record reviews the offer's terms (20.3 rule 7 under `assisted`) before any personal rate renders: an inquiry lead, a 20.4 quote of 20.1's candidate, the review request. */
async function requestOfferReview(deps: FlowDeps, ctx: LoanCtx, opportunityId: string): Promise<void> {
  const opp = opportunityOf(ctx, opportunityId); const row = universeOf(ctx); const loan = ctx.loan;
  if (!opp || !row || !loan || !ctx.parties.length) return;
  const candidate = opp["candidate_terms"] as CandidateTerms | null; if (!candidate) return;
  const subject: Subject = { loan_id: ctx.loanId };
  const program = programOf(ctx, opp["program_id"]); const partnerId = s(program?.["partner_id"]) ?? String(row.partner_id);
  const mlo = mloOfRecord(ctx.origEvents, ctx.origStore, ctx.store.list("mlo_roster").map((r) => r.data as P), ctx.property?.state ?? row.property_state);
  if (!mlo) { deps.logger?.error("borrower.flow.32-11.no_mlo_of_record", { loan_id: ctx.loanId, opportunity_id: opportunityId }); return; }
  const leadId = leadIdFor(opportunityId); const quoteId = quoteIdFor(opportunityId); const party = ctx.parties[0]!;
  const tz = "America/Phoenix";
  if (!ctx.store.get("leads", leadId)) {
    const touch = lastL(ctx, "marketing.touch.sent", (p) => p["opportunity_id"] === opportunityId);
    await exec(deps, subject, "20.3", "deliverDisclosure", INTAKE, { op: "create", lead_id: leadId, partner_id: partnerId, partner_name: loan.partner_name, channel: opp["trigger_kind"] === "borrower_request" ? "organic" : "refi_trigger", source_touch_id: touch ? s(pl(touch)["touch_id"]) : null, review_of_opportunity_id: opportunityId, loan_id: ctx.loanId, party_id: party.party_id, consumer_state: ctx.property?.state ?? row.property_state, property_state: ctx.property?.state ?? row.property_state, property_address: addressOf(ctx.property), transaction_intent: "refinance", time_zone: tz });
    const interactionId = `i-${randomUUID().slice(0, 8)}`;
    await exec(deps, subject, "20.3", "deliverDisclosure", INTAKE, { op: "start", lead_id: leadId, interaction_id: interactionId, channel: "web_chat", ai: true });
    await exec(deps, subject, "20.3", "deliverDisclosure", INTAKE, { lead_id: leadId, interaction_id: interactionId, notice_id: `n-disc-${interactionId}` });
    await exec(deps, subject, "20.3", "authenticate", INTAKE, { lead_id: leadId, method: "portal_login", evidence: { flow: FLOW_ID, party_id: party.party_id } });
    await exec(deps, subject, "20.3", "requestQuote", INTAKE, { op: "assign_mlo", lead_id: leadId, mlo_of_record_id: mlo.mlo_of_record_id, mlo_name: mlo.name, mlo_nmlsr_id: mlo.nmlsr_id, mlo_time_zone: tz });
  }
  if (!ctx.store.get("pricing_quotes", quoteId)) {
    const inputs = candidateQuoteInputs(row, candidate);
    await exec(deps, subject, "20.4", "solvePassThrough", PRICING, { inputs, quote_id: quoteId, purpose: "lead_quote", partner_id: partnerId, lead_id: leadId, loan_id: ctx.loanId, quoted_at: ctx.now });
  }
  if (!hasL(ctx, "terms.presentation.requested", (p) => p["quote_id"] === quoteId)) await exec(deps, subject, "20.3", "requestQuote", INTAKE, { op: "request_review", lead_id: leadId, quote_id: quoteId });
  const due = await timerDue(deps, { loan_id: ctx.loanId }, "SM_MLO_PREAPP_TERMS_REVIEW_1BH");
  for (const p of ctx.parties) await sendCard(deps, subject, p, StatusCard("terms.pending_mlo", `offer.review:${opportunityId}`, { copy_tokens: { "mlo.name": mlo.name, "mlo.nmlsr_id": mlo.nmlsr_id, due: due ?? "" }, next_event_label: "Your loan officer is reviewing — expected by", next_event_at: due, opportunity_id: opportunityId, quote_id: quoteId }), ctx.now);
}

/** The OfferCard (32.11 §2 / 01 §3.15): every field from `refi_opportunities` and the presented `pricing_quotes` row; the expiry is SM_REFI_OPPORTUNITY_EXPIRY_30's own due_at (null until 20.1 arms it). */
export function offerCardProps(i: { opp: P; quote: P | null; expires_at: string | null; partner_name: string; partner_nmlsr_id: string; mlo: { name: string; nmlsr_id: string }; partner_id: string; state: string | null; time_zone: string }): P {
  const c = (i.opp["candidate_terms"] as P | null) ?? {}; const ex = (i.opp["existing_terms"] as P | null) ?? {}; const b = (i.opp["benefit_metrics"] as P | null) ?? {};
  const pi = s(c["pi_cents"]) ?? "0"; const savings = b["pi_delta_cents"] !== undefined && b["pi_delta_cents"] !== null ? (BigInt(String(b["pi_delta_cents"])) < 0n ? -BigInt(String(b["pi_delta_cents"])) : BigInt(String(b["pi_delta_cents"]))).toString() : "0";
  const costs = s(b["borrower_paid_costs_cents"]) ?? "0"; const term = Number(c["term_months"] ?? 360);
  return { refi_opportunity_id: String(i.opp["opportunity_id"]), path: i.opp["trigger_kind"] === "borrower_request" ? "borrower_request" : "proactive", quote_id: i.quote ? String(i.quote["quote_id"]) : null,
    current_rate: pct(ex["note_rate"]) ?? "", offered_rate: pct(c["note_rate"]) ?? "", apr: pct(i.quote?.["apr_estimate"]) ?? pct(c["note_rate"]) ?? "", term_months: term, new_pi_payment_cents: pi, monthly_savings_cents: savings, costs_to_borrower_cents: costs,
    lender_legal_name: i.partner_name, lender_nmlsr_id: i.partner_nmlsr_id, lender_line: lenderLine(i.partner_name, i.partner_nmlsr_id), mlo_name: i.mlo.name, mlo_nmlsr_id: i.mlo.nmlsr_id, mlo_attribution: `${i.mlo.name}, NMLSR ID ${i.mlo.nmlsr_id}`,
    expires_at: i.expires_at, expiry_timer_code: "SM_REFI_OPPORTUNITY_EXPIRY_30", not_a_commitment_text: NOT_A_COMMITMENT_TEXT, rates_change_daily_text: RATES_CHANGE_DAILY_TEXT, payment_line: paymentLine(term, money(pi)), no_cost_line: costs === "0" ? NO_COST_LINE : `Costs charged to you: ${money(costs)}.`, savings_line: `Saves about ${money(savings)} a month.`,
    options: [{ id: "yes", label: "Yes, let's do it", is_primary: true }, { id: "not_now", label: "Not now" }, { id: "never", label: "Never" }],
    command_args: { opportunity_id: String(i.opp["opportunity_id"]), partner_id: i.partner_id, partner_name: i.partner_name, consumer_state: i.state, property_state: i.state, time_zone: i.time_zone, opportunity_status: String(i.opp["status"]) },
    command_args_by_option: { yes: { decision: "yes" }, not_now: { decision: "not_now" }, never: { decision: "never" } }, affirmatives: ["yes let's do it", "let's do it", "yes lets do it", "lets do it", "not now", "never"] };
}
async function offerCard(deps: FlowDeps, ctx: LoanCtx, opportunityId: string): Promise<void> {
  const opp = opportunityOf(ctx, opportunityId); const loan = ctx.loan; const row = universeOf(ctx);
  if (!opp || !loan || !ctx.parties.length) return;
  const status = String(opp["status"]); const proactive = opp["trigger_kind"] !== "borrower_request";
  if (proactive && status !== "offered") return;                      // 20.2 sends first; the in-app card is the same offer (worked example 1: "(2) portal card, same content")
  if (!proactive && status !== "offer_ready" && status !== "offered") return;
  if (proactive && marketingNever(ctx)) return;                       // Never: proactive offers are off; the borrower may still ask (§2)
  const presented = presentedFor(ctx, opportunityId); if (!presented) return;   // 32.1 guardrail: no personal rate before mlo.review.completed{approved}
  const mlo = { name: String(pl(presented)["mlo_name"] ?? "your loan officer"), nmlsr_id: String(pl(presented)["nmlsr_id"] ?? "") };
  const quote = (ctx.store.get("pricing_quotes", quoteIdFor(opportunityId))?.data as P | undefined) ?? null;
  const program = programOf(ctx, opp["program_id"]);
  const expires_at = await timerDue(deps, { loan_id: ctx.loanId }, "SM_REFI_OPPORTUNITY_EXPIRY_30");
  const props = offerCardProps({ opp, quote, expires_at, partner_name: loan.partner_name, partner_nmlsr_id: partnerNmlsr(ctx.origEvents, ctx.origStore), mlo, partner_id: s(program?.["partner_id"]) ?? String(row?.partner_id ?? "partner"), state: ctx.property?.state ?? row?.property_state ?? null, time_zone: "America/Phoenix" });
  for (const p of ctx.parties) await sendCard(deps, { loan_id: ctx.loanId }, p, { kind: "OfferCard", copy_key: "offer.card", flow_key: `offer:${opportunityId}`, command_ref: "offer.respond", personal_terms: true, expires_at, props }, ctx.now);
  await deps.runtime.db.query(`UPDATE card_instances SET status = 'superseded', resolved_at = $2, evidence = coalesce(evidence, '{}'::jsonb) || '{"resolved_by":"system:flow-32.11","reason":"offer presented"}'::jsonb WHERE subject_loan_id = $1 AND status = 'pending' AND props->>'flow_key' = $3`, [ctx.loanId, ctx.now, `offer.review:${opportunityId}`]).catch(() => undefined);
}
async function closeOfferCards(deps: FlowDeps, ctx: LoanCtx, opportunityId: string, to: "cancelled" | "expired", evidence: P): Promise<void> {
  const rows = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_loan_id = $1 AND status = 'pending' AND props->>'flow_key' = $2`, [ctx.loanId, `offer:${opportunityId}`]);
  // the borrower's own tap may be resolving one of these cards in a transaction of its own (the decline is its command's event): take the row lock, re-read, and close only a card that is still pending
  for (const r of rows) await deps.runtime.db.tx(async (q) => {
    const row = (await q.query<{ status: string }>(`SELECT status FROM card_instances WHERE card_instance_id = $1 FOR UPDATE`, [r.card_instance_id]))[0];
    if (row?.status === "pending") await deps.ui.transitionCard(r.card_instance_id, to, "system", ctx.now, { ...evidence, resolved_by: "system:flow-32.11" }, q);
  });
}

// ---------------------------------------------------------------- §3 conversion: Yes on the card → the compressed application on the borrower's own record
async function yesCardFor(deps: FlowDeps, loanId: string, opportunityId: string): Promise<{ party_id: string } | undefined> {
  return (await deps.runtime.db.query<{ party_id: string }>(`SELECT party_id FROM card_instances WHERE subject_loan_id = $1 AND kind = 'OfferCard' AND status = 'resolved' AND props->>'refi_opportunity_id' = $2 AND (evidence->>'decision' = 'yes' OR evidence->>'option_id' = 'yes') ORDER BY resolved_at DESC LIMIT 1`, [loanId, opportunityId]))[0];
}
async function convert(deps: FlowDeps, ctx: LoanCtx, opportunityId: string, leadId: string, engaged: DomainEvent): Promise<void> {
  const opp = opportunityOf(ctx, opportunityId); const loan = ctx.loan; const row = universeOf(ctx);
  if (!opp || !loan || !ctx.loan?.origination_application_id) return;
  // only the borrower's own Yes on the card converts here (an ops-driven engagement converts through 20.3's own path): the engagement was written by the borrower command surface (32.2 offer.respond) or the resolved OfferCard says yes
  const lead = ctx.store.get("leads", leadId)?.data as P | undefined;
  const byBorrower = (engaged.actor.kind === BORROWER_APP.kind && engaged.actor.id === BORROWER_APP.id) || (typeof lead?.["party_id"] === "string" && ctx.parties.some((party) => party.party_id === lead["party_id"]));
  if (!byBorrower && !(await yesCardFor(deps, ctx.loanId, opportunityId))) { deps.logger?.info("borrower.flow.32-11.convert.skipped", { loan_id: ctx.loanId, opportunity_id: opportunityId, lead_id: leadId, reason: "not the borrower's own yes" }); return; }
  const existing = await deps.runtime.db.query<{ id: string }>(`SELECT a.id FROM applications a WHERE a.id::text = $1 OR (a.prior_loan_id = $2 AND a.loan_id IS NULL AND a.status NOT IN ('withdrawn', 'denied') AND NOT EXISTS (SELECT 1 FROM loan_events e WHERE e.application_id = a.id AND e.type IN ('application.withdrawn', 'application.denied', 'application.cancelled'))) LIMIT 1`, [leadId, ctx.loanId]);
  if (existing.length) { deps.logger?.info("borrower.flow.32-11.convert.skipped", { loan_id: ctx.loanId, opportunity_id: opportunityId, lead_id: leadId, reason: `application ${existing[0]!.id} already open on this loan` }); return; }
  const candidate = (opp["candidate_terms"] as P | null) ?? {}; const subject: Subject = { loan_id: ctx.loanId };
  const orig = await deps.runtime.db.query<{ legal_name: string; borrower_role: string; citizenship_status: string | null; marital_status: string | null; language_preference: string | null; tin_last4: string | null; date_of_birth: string | null; contact: P; party_id: string | null }>(`SELECT legal_name, borrower_role::text AS borrower_role, citizenship_status::text AS citizenship_status, marital_status::text AS marital_status, language_preference, tin_last4, date_of_birth::text AS date_of_birth, contact, party_id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at, id`, [loan.origination_application_id]);
  const prop = ctx.property ?? (await deps.runtime.db.query<PropertyRow & P>(`SELECT address_line1, city, state, postal_code, county, property_type, NULL::text AS occupancy, units FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [loan.origination_application_id]))[0] ?? null;
  const transaction_type = (s(candidate["transaction_type"]) ?? s(opp["transaction_type"]) ?? "limited_cash_out") as "limited_cash_out" | "cash_out";
  const occupancy = ((row?.occupancy ?? (opp["existing_terms"] as P | null)?.["occupancy"] ?? "primary") as string) === "primary" ? "primary" : "second_home";
  const created = await deps.runtime.createApplication({ id: leadId, partner_party_id: loan.partner_party_id, channel: "refi_trigger", transaction_type, occupancy, intake_channel: "web", interview_language: "en-US", prior_loan_id: ctx.loanId,
    borrowers: orig.map((b) => ({ legal_name: b.legal_name, borrower_role: b.borrower_role as "borrower" | "co_borrower", citizenship_status: b.citizenship_status, marital_status: b.marital_status, language_preference: b.language_preference, tin_last4: b.tin_last4, date_of_birth: b.date_of_birth, contact: b.contact })),
    property: prop?.address_line1 ? { address_line1: prop.address_line1, city: prop.city ?? "", state: prop.state ?? "", postal_code: prop.postal_code ?? "", county: prop.county, property_type: prop.property_type, units: prop.units, estimated_value_cents: s((row?.value_estimate as { value_cents?: unknown } | undefined)?.value_cents ?? candidate["value_cents"]) } : null } as unknown as Parameters<typeof deps.runtime.createApplication>[0], INTAKE);
  const appId = created.application.id;
  // the borrowers are the loan's parties already (01 §6.1: one conversation across the refinance); the rows link by name here and by contact at the next sign-in
  for (const b of orig) if (b.party_id) await deps.runtime.db.query(`UPDATE application_borrowers SET party_id = $3 WHERE application_id = $1 AND lower(legal_name) = lower($2) AND party_id IS NULL`, [appId, b.legal_name, b.party_id]);
  for (const p of ctx.parties) await deps.runtime.db.query(`UPDATE application_borrowers SET party_id = $3 WHERE application_id = $1 AND lower(legal_name) = lower($2) AND party_id IS NULL`, [appId, p.legal_name, p.party_id]);
  const primary = orig[0]!; const tz = "America/Phoenix"; const state = prop?.state ?? row?.property_state ?? null; const address = addressOf(prop);
  await exec(deps, subject, "20.3", "explainProgram", INTAKE, { op: "convert", lead_id: leadId, transaction_type, occupancy, creditor_time_zone: tz, borrower_name: primary.legal_name });
  await exec(deps, subject, "20.1", "emitOfferReady", INTAKE, { op: "converted", opportunity_id: opportunityId, application_id: appId });
  const appSubject: Subject = { application_id: appId };
  const mlo = mloOfRecord(ctx.origEvents, ctx.origStore, ctx.store.list("mlo_roster").map((r) => r.data as P), state);
  await exec(deps, appSubject, "21.1", "startInterview", INTAKE, { session_id: `flow-32.11:${appId}`, partner_name: loan.partner_name, partner_nmlsr_id: partnerNmlsr(ctx.origEvents, ctx.origStore) || null, intake_channel: "web", channel: "web", creditor_time_zone: tz, property_state: state, property_address: address, transaction_type, occupancy, borrowers: orig.map((b, k) => ({ id: `B${k + 1}`, legal_name: b.legal_name, marital_status: b.marital_status ?? "unmarried" })), ...(mlo ? { mlo_of_record_id: mlo.mlo_of_record_id, mlo_nmlsr_id: mlo.nmlsr_id } : {}), model_version: RUN.modelVersion, prompt_version: RUN.promptVersion });
  await exec(deps, appSubject, "21.1", "captureField", INTAKE, { field: "credit_request", transaction_type, occupancy, property_state: state, property_address: address, identity_verified: true });
  // the servicing-record prefills (21.1 rule 1: a prefill counts only at the borrower's item-level confirmation) — name and SSN on file, the address, the AVM, the payoff-based amount
  const offers: [string, string][] = [["name", primary.legal_name], ...(address ? [["property_address", address] as [string, string]] : []),
    ...(s((row?.value_estimate as { value_cents?: unknown } | undefined)?.value_cents ?? candidate["value_cents"]) ? [["property_value_estimate", s((row?.value_estimate as { value_cents?: unknown } | undefined)?.value_cents ?? candidate["value_cents"])!] as [string, string]] : []),
    ...(s(candidate["loan_amount_cents"]) ? [["loan_amount_sought", s(candidate["loan_amount_cents"])!] as [string, string]] : [])];
  for (const [item, value] of offers) await exec(deps, appSubject, "21.1", "confirmPrefill", INTAKE, { op: "offer", item, value });
  // the SSN is on the origination file (21.1's six-item hash): offered by that file's own hash — never re-typed, never in clear (32.11 §3: identity documents are not re-asked)
  const origIntake = ctx.origStore.get("applications", loan.origination_application_id ?? "")?.data as P | undefined;
  const ssnHash = s(((origIntake?.["six_items"] as P | undefined)?.["ssn"] as P | undefined)?.["value_hash"]);
  if (ssnHash) await exec(deps, appSubject, "21.1", "confirmPrefill", INTAKE, { op: "offer", item: "ssn", on_file_value_hash: ssnHash });
  else deps.logger?.error("borrower.flow.32-11.no_ssn_on_file", { loan_id: ctx.loanId, application_id: appId, origination_application_id: loan.origination_application_id });
}

// ---------------------------------------------------------------- the compressed application's cards (an application with prior_loan_id)
interface AppParty { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string; readonly tin_last4: string | null; readonly citizenship_status: string | null; readonly marital_status: string | null; readonly contact: P }
interface AppCtx { readonly appId: string; readonly priorLoanId: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly AppParty[]; readonly now: string; readonly property: PropertyRow | null; readonly loanCtx: LoanCtx; readonly opp: P | null }
async function appContext(deps: FlowDeps, appId: string): Promise<AppCtx | null> {
  const app = (await deps.runtime.db.query<{ prior_loan_id: string | null }>(`SELECT prior_loan_id FROM applications WHERE id = $1`, [appId]))[0];
  if (!app?.prior_loan_id) return null;
  const [events, records, parties, props] = await Promise.all([deps.runtime.uow.events.byApplication(appId), deps.runtime.entities.load({ applicationId: appId }),
    deps.runtime.db.query<AppParty & P>(`SELECT party_id, id AS application_borrower_id, legal_name, tin_last4, citizenship_status::text AS citizenship_status, marital_status::text AS marital_status, contact FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY (borrower_role::text = 'borrower') DESC, created_at, id`, [appId]),
    deps.runtime.db.query<PropertyRow & P>(`SELECT address_line1, city, state, postal_code, county, property_type, NULL::text AS occupancy, units FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [appId])]);
  const store = new EntityStore(); store.seed(records);
  const loanCtx = await loanContext(deps, app.prior_loan_id);
  const opp = loanCtx.store.list("refi_opportunities", (d) => d.application_id === appId).map((r) => r.data as P).at(-1) ?? loanCtx.store.list("refi_opportunities", (d) => d.status === "converted" || d.status === "engaged").map((r) => r.data as P).at(-1) ?? null;
  return { appId, priorLoanId: app.prior_loan_id, events, store, parties, now: deps.runtime.clock.now(), property: props[0] ?? null, loanCtx, opp };
}
const intakeBorrowerId = (ctx: AppCtx, party: AppParty): string => { const bs = ((ctx.store.get("applications", ctx.appId)?.data as { borrowers?: { id: string; legal_name: string }[] } | undefined)?.borrowers ?? []); return bs.find((b) => b.legal_name === party.legal_name)?.id ?? bs[ctx.parties.findIndex((p) => p.party_id === party.party_id)]?.id ?? "B1"; };
async function standingConsent(deps: FlowDeps, partyId: string): Promise<{ id: string; captured_at: string } | undefined> {
  return (await deps.runtime.db.query<{ id: string; captured_at: string }>(`SELECT id, captured_at FROM consents WHERE party_id = $1 AND kind = 'blanket_verification_authorization' AND standing AND (status IS NULL OR status = 'active') ORDER BY captured_at DESC LIMIT 1`, [partyId]))[0];
}
const appCard = (c: CardSpec): CardSpec => ({ ...c, created_by: CREATED_BY_INTAKE });
/** The application's own 20.3 lead — keyed by the application id (the intake journey), linked by `application_id`, the offer's own lead (`L-offer-<opportunity>` on the prior loan), or a party's. Never the first
 *  `leads` row of the scoped store: the store also holds every global row, and a pre-application lead is global until it is linked (20.3), so "the first lead" is an unrelated consumer's whenever any exist. */
function leadOf(ctx: AppCtx): string {
  const own = ctx.store.get("leads", ctx.appId); if (own) return String(own.data["lead_id"] ?? ctx.appId);
  const parties = new Set(ctx.parties.map((p) => p.party_id));
  const mine = (d: P): boolean => d["application_id"] === ctx.appId || parties.has(String(d["party_id"]));
  const linked = ctx.store.list("leads", mine)[0] ?? ctx.loanCtx.store.list("leads", mine)[0];
  if (linked) return String(linked.data["lead_id"]);
  const oppId = s(ctx.opp?.["opportunity_id"]); const offer = oppId ? ctx.loanCtx.store.get("leads", leadIdFor(oppId)) : undefined;
  return offer ? String(offer.data["lead_id"]) : ctx.appId;
}
async function compressedCards(deps: FlowDeps, ctx: AppCtx): Promise<void> {
  const subject: Subject = { application_id: ctx.appId }; const lead = leadOf(ctx);
  const row = universeOf(ctx.loanCtx); const candidate = (ctx.opp?.["candidate_terms"] as P | null) ?? {};
  const address = addressOf(ctx.property) ?? addressOf(ctx.loanCtx.property) ?? ""; const state = ctx.property?.state ?? ctx.loanCtx.property?.state ?? null;
  const value = s((row?.value_estimate as { value_cents?: unknown } | undefined)?.value_cents ?? candidate["value_cents"]) ?? ""; const amount = s(candidate["loan_amount_cents"]) ?? "";
  for (const [k, party] of ctx.parties.entries()) {
    const abId = party.application_borrower_id; const borrower_id = intakeBorrowerId(ctx, party); const common = { lead_id: lead, application_borrower_id: abId, borrower_id };
    if (k === 0) {
      // TRID items on file — the home from the servicing record (never re-asked as identity), the name and SSN on file, the AVM, the payoff-based amount (§3 table)
      await sendCard(deps, subject, party, appCard({ kind: "ConfirmCard", copy_key: "refi.home.confirm", flow_key: `refi.home:${abId}`, command_ref: "application.confirmField",
        props: { title: "", fields: [{ path: "property_address", label: "Property address", value: address, source: "servicing_record" }, { path: "property_type", label: "Property type", value: ctx.property?.property_type ?? ctx.loanCtx.property?.property_type ?? "sfr", source: "servicing_record" }, { path: "units", label: "Units", value: String(ctx.property?.units ?? ctx.loanCtx.property?.units ?? 1), source: "servicing_record" }, { path: "occupancy", label: "Still your primary home?", value: "primary", source: "servicing_record" }], commits_to: "application_properties", required_paths: ["property_address"], command_args: { path: "property_address", commits_to: "application_properties", ...common } } }), ctx.now);
      await sendCard(deps, subject, party, appCard({ kind: "ConfirmCard", copy_key: "refi.name.confirm", flow_key: `refi.name:${abId}`, command_ref: "application.confirmField",
        props: { title: "", fields: [{ path: "legal_name", label: "Legal name", value: party.legal_name, source: "prior_application" }], commits_to: "application_borrowers", required_paths: ["legal_name"], command_args: { path: "identity", commits_to: "application_borrowers", ...common } } }), ctx.now);
      await sendCard(deps, subject, party, appCard({ kind: "ConfirmCard", copy_key: "refi.ssn.confirm", flow_key: `refi.ssn:${abId}`, command_ref: "application.confirmField",
        props: { title: "", copy_tokens: { last4: party.tin_last4 ?? "" }, fields: [{ path: "ssn_on_file", label: "Social Security number on file", value: `••••${party.tin_last4 ?? ""}`, source: "prior_application" }], commits_to: "application_borrowers", masked_paths: ["ssn_on_file"], helper_copy_key: "refi.ssn.confirm", identity_on_file: true, command_args: { path: "ssn_on_file", source: "prior_application", ...common } } }), ctx.now);
      await sendCard(deps, subject, party, appCard({ kind: "ConfirmCard", copy_key: "value.confirm.title", flow_key: `refi.value:${abId}`, command_ref: "application.confirmField",
        props: { title: "", copy_tokens: { money: money(value || "0") }, fields: [{ path: "property_value_estimate", label: "Estimated value", value, source: value ? "avm" : "borrower" }], commits_to: "application_properties.estimated_value", money_paths: ["property_value_estimate"], required_paths: ["property_value_estimate"], avm_vendor: "FAKE", command_args: { path: "property_value_estimate", ...common } } }), ctx.now);
      await sendCard(deps, subject, party, appCard({ kind: "ConfirmCard", copy_key: "loan_amount.confirm.title", flow_key: `refi.loan_amount:${abId}`, command_ref: "application.confirmField",
        props: { title: "", copy_tokens: { money: money(amount || "0") }, fields: [{ path: "loan_amount_sought", label: "Loan amount", value: amount, source: amount ? "servicing_record" : "borrower" }], commits_to: "applications.loan_amount_sought", money_paths: ["loan_amount_sought"], required_paths: ["loan_amount_sought"], payoff_based: true, command_args: { path: "loan_amount_sought", ...common } } }), ctx.now);
    }
    // re-confirmed from the earlier application (URLA): citizenship, marital status, dependents, military service
    await sendCard(deps, subject, party, appCard({ kind: "ConfirmCard", copy_key: "refi.profile.confirm", flow_key: `refi.profile:${abId}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "citizenship_status", label: "Citizenship", value: party.citizenship_status ?? "us_citizen", source: "prior_application" }, { path: "marital_status", label: "Marital status", value: party.marital_status ?? "unmarried", source: "prior_application" }, { path: "dependents", label: "Dependents (number)", value: "0", source: "prior_application" }, { path: "military_service", label: "Military service (URLA Section 7)", value: "none", source: "prior_application" }, { path: "language_preference", label: "Language preference (Form 1103)", value: "english", source: "prior_application" }], commits_to: "application_borrowers", required_paths: ["citizenship_status", "marital_status", "dependents", "military_service"], command_args: { path: "profile", commits_to: "application_borrowers", ...common } } }), ctx.now);
    // asked again per application: the 13 declarations (one tap) and the Reg C request
    await sendCard(deps, subject, party, appCard({ kind: "ChoiceCard", copy_key: "declarations.title", flow_key: `declarations:${abId}`, command_ref: "application.answerDeclarations",
      props: { title: "", options: [{ id: "none", label: "None of these apply to me", is_primary: true }, { id: "some", label: "Something here applies" }], command: "application.answerDeclarations", list: DECLARATIONS, list_version: DECLARATIONS_LIST_VERSION, list_version_hash: DECLARATIONS_LIST_HASH, asked_again: true,
        command_args_by_option: { none: { declarations: DECLARATIONS.map(() => false), borrower_id, list_version: DECLARATIONS_LIST_VERSION, list_version_hash: DECLARATIONS_LIST_HASH }, some: {} }, no_command_options: ["some"], side_quest_on: { some: "SQ-05" }, affirmatives: ["none of these apply", "none apply", "nothing applies"] } }), ctx.now);
    await sendCard(deps, subject, party, appCard({ kind: "DemographicsCard", copy_key: "demographics.title", flow_key: `demographics:${abId}`, command_ref: "application.answerDemographics",
      props: { collection_method: "internet", statement_text: "", available: true, asked_again: true,
        ethnicity: [{ id: "hispanic_or_latino", label: "Hispanic or Latino", sub: [{ id: "mexican", label: "Mexican" }, { id: "puerto_rican", label: "Puerto Rican" }, { id: "cuban", label: "Cuban" }, { id: "other_hispanic", label: "Other Hispanic or Latino" }] }, { id: "not_hispanic_or_latino", label: "Not Hispanic or Latino" }],
        race: [{ id: "american_indian_or_alaska_native", label: "American Indian or Alaska Native" }, { id: "asian", label: "Asian", sub: [{ id: "asian_indian", label: "Asian Indian" }, { id: "chinese", label: "Chinese" }, { id: "filipino", label: "Filipino" }, { id: "japanese", label: "Japanese" }, { id: "korean", label: "Korean" }, { id: "vietnamese", label: "Vietnamese" }, { id: "other_asian", label: "Other Asian" }] }, { id: "black_or_african_american", label: "Black or African American" }, { id: "native_hawaiian_or_other_pacific_islander", label: "Native Hawaiian or Other Pacific Islander", sub: [{ id: "native_hawaiian", label: "Native Hawaiian" }, { id: "guamanian_or_chamorro", label: "Guamanian or Chamorro" }, { id: "samoan", label: "Samoan" }, { id: "other_pacific_islander", label: "Other Pacific Islander" }] }, { id: "white", label: "White" }],
        sex: [{ id: "female", label: "Female" }, { id: "male", label: "Male" }], command_args: { borrower_id, collection_method: "internet" } } }), ctx.now);
    // a new hard tri-merge (20.1: the servicing score was only an estimate) and the E-SIGN scope extended to the origination classes (7.4 class rule)
    await sendCard(deps, subject, party, appCard({ kind: "ConsentCard", copy_key: "consent.credit.title", flow_key: `consent.credit:${party.party_id}`, command_ref: "credit.authorize",
      props: { consent_kind: "credit_authorization", disclosure_version_id: CREDIT_AUTHORIZATION_VERSION, scope: ["hard_pull"], affirmation_method: "checkbox_with_text", title: "", body_text: CREDIT_AUTHORIZATION_TEXT, requires_typed_name: true, verification_state: "none", requires_level: "L3", identity_on_file: true, gate: "SM_IDENTITY_IAL2_GATE", command_args: { kind: "hard_pull", text_hash: CREDIT_AUTHORIZATION_HASH, authorization_kind: "hard_application", lead_id: lead } } }), ctx.now);
    await sendCard(deps, subject, party, appCard({ kind: "ConsentCard", copy_key: "consent.esign.extend", flow_key: `consent.esign:${party.party_id}`, command_ref: "consent.capture",
      props: { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: ["disclosures", "notices"], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true, verification_state: "none", scope_extension: true, command_args: { kind: "esign", method: "checkbox_with_text", scope: ["disclosures", "notices"], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", purpose: "informational", lead_id: lead } } }), ctx.now);
    // income must be re-stated (21.2 rule 2): from the standing payroll connection when the borrower kept it (§5), else the connector again (T9)
    const standing = await standingConsent(deps, party.party_id);
    if (standing) await refreshStandingIncome(deps, ctx, party, standing, state);
    else await sendCard(deps, subject, party, appCard({ kind: "ConnectCard", copy_key: "income.connect.purpose", flow_key: `connect.income:${party.party_id}`, command_ref: "verification.connect",
      props: { vendor: "truv_income", purpose_text: "", what_we_get: ["employer", "start date", "pay frequency", "base and variable pay", "year-to-date"], fallback: { label: "Type your monthly income now; we'll ask for paystubs later", document_class: "paystub" }, state: "not_started", pre_intent_optional: true, vendor_fake: "FAKE", command_args: { vendor: "truv_income", component: "income", fee_paid_by: "sm", lead_id: lead } } }), ctx.now);
  }
}
/** DELTA-05: the standing authorization refreshes the payroll data now — after the Yes, never for selection — through the FAKE Truv adapter, lands as 22.3's `verification.received{income}` and becomes the income ConfirmCard (source payroll_connection, a fresh statement). */
async function refreshStandingIncome(deps: FlowDeps, ctx: AppCtx, party: AppParty, standing: { id: string }, _state: string | null): Promise<void> {
  const subject: Subject = { application_id: ctx.appId }; const borrower_id = intakeBorrowerId(ctx, party);
  // the connector card is not needed (a standing connection stands in for it): withdraw any pending one for this party on this application
  const pending = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND party_id = $2 AND kind = 'ConnectCard' AND props->>'vendor' = 'truv_income' AND status = 'pending'`, [ctx.appId, party.party_id]);
  for (const r of pending) await deps.ui.transitionCard(r.card_instance_id, "cancelled", "system", ctx.now, { reason: "standing connection (DELTA-05): the payroll data refreshes under the borrower's standing authorization", standing_consent_id: standing.id, resolved_by: "system:flow-32.11" });
  if (ctx.events.some((e) => e.type === "verification.received" && pl(e)["kind"] === "income" && pl(e)["authorization_consent_id"] === standing.id)) return;
  const ordered = await exec(deps, subject, "22.3", "orderVerificationReport", VERIFICATION, { op: "order", borrower_id, component: "income", supplier_code: "TRUV", report_type: "voie", authorization_consent_id: standing.id });
  const session = await STANDING_TRUV.createSession({ party_id: party.party_id, application_id: ctx.appId, application_borrower_id: party.application_borrower_id, borrower_id, card_instance_id: `standing:${standing.id}`, order_id: s(ordered["order_id"]) }, ctx.now);
  const report = STANDING_TRUV.complete(session.vendor_session_id, ctx.now);
  const received = await exec(deps, subject, "22.3", "orderVerificationReport", VERIFICATION, { op: "receive", borrower_id, kind: "income", supplier_code: "TRUV", report_reference_id: report.report_reference_id, vendor_data_as_of: report.vendor_data_as_of, report_document_id: report.report_document_id, authorization_consent_id: standing.id, ...(s(ordered["order_id"]) ? { verification_id: s(ordered["order_id"]) } : {}) });
  const verificationId = s(received["verification_id"]) ?? report.report_reference_id; const lead = leadOf(ctx);
  await exec(deps, subject, "21.1", "confirmPrefill", INTAKE, { op: "offer", item: "income", value: (BigInt(report.monthly_base_cents) + BigInt(report.monthly_variable_cents)).toString() });
  await sendCard(deps, subject, party, appCard({ kind: "ConfirmCard", copy_key: "income.confirm.title", flow_key: `income.confirm:${verificationId}`, command_ref: "application.confirmField",
    props: { title: "", copy_tokens: { employer: report.employer }, helper_copy_key: "refi.income.fresh", standing_connection: true, standing_consent_id: standing.id, vendor_fake: "FAKE", fields: [{ path: "employer", label: "Employer", value: report.employer, source: "payroll_connection" }, { path: "position", label: "Position", value: report.position, source: "payroll_connection" }, { path: "start_date", label: "Start date", value: report.start_date, source: "payroll_connection" }, { path: "pay_frequency", label: "Pay frequency", value: report.pay_frequency, source: "payroll_connection" },
      { path: "monthly_base_cents", label: "Monthly base pay", value: report.monthly_base_cents, source: "payroll_connection" }, { path: "monthly_variable_cents", label: "Monthly overtime, bonus, commission", value: report.monthly_variable_cents, source: "payroll_connection" }, { path: "other_income", label: "Other income (Social Security, pension, child support, rental)", value: "none", source: "borrower" }],
      commits_to: "application_income", money_paths: ["monthly_base_cents", "monthly_variable_cents"], required_paths: ["monthly_base_cents"], statement: "This becomes the income you're stating on your application.", affirmatives: ["that's my income", "thats my income", "that is my income"],
      command_args: { path: "income", commits_to: "application_income", verification_id: verificationId, report_reference_id: report.report_reference_id, application_borrower_id: party.application_borrower_id, borrower_id } } }), ctx.now);   // no lead_id: after 20.3's conversion 21.1 owns the six items (20.3 rule 6 keeps a lead's income to the pre-conversion statuses)
}

// ---------------------------------------------------------------- §6 the new loan live, the old loan closed
async function fundedCard(deps: FlowDeps, ctx: AppCtx, e: DomainEvent): Promise<void> {
  // 30.2's hand-off events carry both ids: from funding on, the card's command is keyed by the loan and the application (the id grammar — a timer the command fires then carries both ids too)
  const p = pl(e); const newLoanId = e.loanId ?? s(p["loan_id"]) ?? null; const subject: Subject = { application_id: ctx.appId, ...(newLoanId ? { loan_id: newLoanId } : {}) };
  const cd = ctx.events.filter((x) => x.type === "disclosure.cd.prepared" || x.type === "disclosure.cd.rendered").at(-1); const cdLoan = (cd ? (pl(cd)["loan"] as P | undefined) : undefined) ?? {};
  const lock = ctx.store.list("locks").map((r) => r.data as P).filter((l) => l["status"] === "executed" || l["status"] === "confirmed").at(-1);
  const rate = pct(cdLoan["rate_pct"] ?? lock?.["note_rate"] ?? (ctx.opp?.["candidate_terms"] as P | null)?.["note_rate"]) ?? "";
  const pi = s(cdLoan["pi_cents"] ?? lock?.["pi_cents"] ?? (ctx.opp?.["candidate_terms"] as P | null)?.["pi_cents"]) ?? "0";
  const escrow = s((cd ? (pl(cd)["escrow"] as P | undefined) : undefined)?.["monthly_escrow_cents"]) ?? "0";
  const payment = (BigInt(pi) + BigInt(escrow)).toString();
  const oldAutopay = (await deps.runtime.db.query<{ status: string }>(`SELECT status::text AS status FROM autodraft_enrollments WHERE loan_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [ctx.priorLoanId]))[0];
  const autopay = oldAutopay && ["active", "authorized", "validating", "requested"].includes(oldAutopay.status) ? "refi.autopay.reauthorize" : "refi.autopay.none";
  for (const party of ctx.parties) await sendCard(deps, subject, party, StatusCard("refi.same_servicer.funded", `refi.funded:${ctx.appId}`, { copy_tokens: { rate: `${rate}%`, money: money(payment), date: String(p["first_payment_date"] ?? "") }, detail_copy_key: "refi.same_servicer.autopay", autopay_copy_key: autopay, copy_token_keys: { autopay }, prior_loan_id: ctx.priorLoanId, new_payment_cents: payment, first_payment_date: p["first_payment_date"] ?? null, disbursement_date: p["disbursement_date"] ?? null }), ctx.now);
}

// ---------------------------------------------------------------- post-funding consents (the marketing PEWC once; the standing authorization — DELTA-05) and the Loan-section revocation
async function boardedCards(deps: FlowDeps, ctx: LoanCtx): Promise<void> {
  const subject: Subject = { loan_id: ctx.loanId }; const partner = ctx.loan?.partner_name ?? "your lender";
  for (const party of ctx.parties) {
    const phone = s((party.contact as P)["phone"] ?? (party.contact as P)["mobile"]) ?? "";
    await sendCard(deps, subject, party, { kind: "ConsentCard", copy_key: "consent.tcpa.marketing.title", flow_key: `consent.tcpa.marketing:${party.party_id}`, command_ref: "consent.capture",
      props: { consent_kind: "tcpa_voice", purpose: "marketing", disclosure_version_id: MARKETING_DISCLOSURE_VERSION, scope: ["marketing"], affirmation_method: "checkbox_with_text", title: "", body_text: `Yes, ${partner} and Supermortgage on its behalf may call or text me at ${phone || "the number on my account"} using an automated system or an artificial or prerecorded voice about refinance offers. I understand consent is not a condition of any purchase or loan.`, phone_number: phone, requires_typed_name: true, verification_state: "none", optional: true, offered_once: true,
        command_args: { kind: "tcpa_voice", purpose: "marketing", method: "checkbox_with_text", disclosure_version_id: MARKETING_DISCLOSURE_VERSION, phone_number: phone, scope: ["marketing"] } } }, ctx.now);
    await sendCard(deps, subject, party, { kind: "ConsentCard", copy_key: "consent.standing.title", flow_key: `consent.standing:${party.party_id}`, command_ref: "consent.capture",
      props: { consent_kind: "blanket_verification_authorization", disclosure_version_id: STANDING_DISCLOSURE_VERSION, scope: ["truv_income", "plaid_assets"], affirmation_method: "checkbox_with_text", title: "", body_text: "Keep my payroll and bank connections active so a future refinance takes minutes. Supermortgage refreshes them only after I say yes to an offer, never to decide whether to make one. I can turn this off any time from my loan record.", requires_typed_name: true, verification_state: "none", standing: true, optional: true,
        command_args: { kind: "blanket_verification_authorization", method: "checkbox_with_text", standing: true, scope: ["truv_income", "plaid_assets"], disclosure_version_id: STANDING_DISCLOSURE_VERSION, purpose: "informational" } } }, ctx.now);
  }
}
async function standingManageCard(deps: FlowDeps, ctx: LoanCtx, partyId: string, consentId: string): Promise<void> {
  const party = ctx.parties.find((p) => p.party_id === partyId); if (!party) return;
  await sendCard(deps, { loan_id: ctx.loanId }, party, { kind: "ChoiceCard", copy_key: "consent.standing.manage", flow_key: `consent.standing.manage:${consentId}`, command_ref: "consent.capture",
    props: { title: "", options: [{ id: "keep_on", label: "Keep them on", is_primary: true }, { id: "turn_off", label: "Turn them off" }], command: "consent.capture", standing_consent_id: consentId, no_command_options: ["keep_on"], loan_section: "standing_connections",
      command_args_by_option: { keep_on: {}, turn_off: { kind: "blanket_verification_authorization", withdraw: true, method: "single_tap", reason: "borrower_turned_off_from_loan_section", consent_id: consentId } }, affirmatives: ["turn them off", "turn off my connections", "keep them on"] } }, ctx.now);
}

// ---------------------------------------------------------------- the Loan-section projection (record.ts calls it): the Rate-watch block and the standing connections — never a computed date, never an investor
export interface RateWatchBlock { readonly current_rate: string | null; readonly best_available_rate: string | null; readonly rate_sheet_id: string | null; readonly state: "passive" | "offer_open" | "in_progress"; readonly worth_it_copy_key: "ratewatch.worth_it"; readonly state_copy_key: "ratewatch.passive" | "ratewatch.offer_open" | "ratewatch.in_progress"; readonly offer_card_instance_id: string | null; readonly application_id: string | null }
export interface StandingConnectionsBlock { readonly status: "active" | "withdrawn" | "none"; readonly consent_id: string | null; readonly captured_at: string | null; readonly withdrawn_at: string | null; readonly manage_card_instance_id: string | null; readonly vendors: string[] }
/** The lowest note rate on the sheet in force at `asOf` with a price at or above par (no points to the borrower) — the sheet's own figure, not a computation of the borrower's terms. */
export function bestAvailableRate(sheets: readonly P[], asOf: string, productCode: string | null): { rate: string | null; rate_sheet_id: string | null } {
  const t = Date.parse(asOf);
  const live = sheets.filter((sh) => sh["status"] !== "withdrawn" && Date.parse(String(sh["published_at"])) <= t && Date.parse(String(sh["expires_at"])) > t).sort((a, b) => Date.parse(String(b["published_at"])) - Date.parse(String(a["published_at"])))[0];
  if (!live) return { rate: null, rate_sheet_id: null };
  const prices = (live["prices"] as P[] | undefined) ?? [];
  const eligible = prices.filter((p) => (!productCode || p["product_code"] === productCode || !prices.some((x) => x["product_code"] === productCode)) && Number(p["price"]) >= 100);
  const rates = eligible.map((p) => pct(p["note_rate_pct"] ?? p["note_rate"])).filter((r): r is string => r !== null).sort((a, b) => Number(a) - Number(b));
  return { rate: rates[0] ?? null, rate_sheet_id: String(live["rate_sheet_id"]) };
}
export async function rateWatchSection(db: Queryable, i: { loanId: string; partyId: string; note_rate_bps: unknown; product_code: string | null; opportunities: readonly P[]; cards: readonly CardInstanceRow[]; asOf: string }): Promise<{ ratewatch: RateWatchBlock; standing_connections: StandingConnectionsBlock }> {
  const sheets = (await db.query<{ data: unknown }>(`SELECT DISTINCT ON (id) data FROM entity_records WHERE kind = 'rate_sheets' AND loan_id IS NULL AND application_id IS NULL ORDER BY id, version DESC`)).map((r) => decodeEntityData(r.data) as P);
  const best = bestAvailableRate(sheets, i.asOf, i.product_code);
  const inProgress = (await db.query<{ id: string }>(`SELECT a.id FROM applications a WHERE a.prior_loan_id = $1 AND a.loan_id IS NULL AND a.status NOT IN ('withdrawn', 'denied') AND NOT EXISTS (SELECT 1 FROM loan_events e WHERE e.application_id = a.id AND e.type IN ('application.withdrawn', 'application.denied', 'application.cancelled')) ORDER BY a.created_at DESC LIMIT 1`, [i.loanId]))[0];
  const offer = i.cards.find((c) => c.kind === "OfferCard" && c.status === "pending" && c.subject_loan_id === i.loanId);
  const state: RateWatchBlock["state"] = inProgress ? "in_progress" : offer ? "offer_open" : "passive";
  const ratewatch: RateWatchBlock = { current_rate: pct(i.note_rate_bps), best_available_rate: best.rate, rate_sheet_id: best.rate_sheet_id, state, worth_it_copy_key: "ratewatch.worth_it", state_copy_key: state === "in_progress" ? "ratewatch.in_progress" : state === "offer_open" ? "ratewatch.offer_open" : "ratewatch.passive", offer_card_instance_id: offer?.card_instance_id ?? null, application_id: inProgress?.id ?? null };
  const consent = (await db.query<{ id: string; status: string | null; captured_at: string; revoked_at: string | null; scope: string[] | null }>(`SELECT id, status, captured_at, revoked_at, scope FROM consents WHERE party_id = $1 AND kind = 'blanket_verification_authorization' AND standing ORDER BY captured_at DESC LIMIT 1`, [i.partyId]))[0];
  const manage = consent ? i.cards.find((c) => c.kind === "ChoiceCard" && c.status === "pending" && c.props["standing_consent_id"] === consent.id) : undefined;
  const standing_connections: StandingConnectionsBlock = consent ? { status: consent.status === null || consent.status === "active" ? "active" : "withdrawn", consent_id: consent.id, captured_at: consent.captured_at, withdrawn_at: consent.revoked_at, manage_card_instance_id: manage?.card_instance_id ?? null, vendors: consent.scope ?? [] } : { status: "none", consent_id: null, captured_at: null, withdrawn_at: null, manage_card_instance_id: null, vendors: [] };
  return { ratewatch, standing_connections };
}

// ---------------------------------------------------------------- the reactions
const LOAN_EVENTS = new Set(["refi.opportunity.offer_ready", "refi.opportunity.offered", "refi.opportunity.declined", "refi.opportunity.expired", "refi.opportunity.engaged", "consent.marketing.revoked", "mlo.review.completed", "terms.presented", "escrow.credit_to_new_loan.posted", "loan.boarded", "consent.granted", "consent.blanket_verification_authorization.withdrawn"]);
const APP_EVENTS = new Set(["application.received", "loan.funded"]);
async function reactLoan(deps: FlowDeps, ctx: LoanCtx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "refi.opportunity.offer_ready": {
      const id = String(p["opportunity_id"]); const proactiveOpp = opportunityOf(ctx, id)?.["trigger_kind"] !== "borrower_request";
      if (proactiveOpp && marketingNever(ctx)) return;                // Never: no proactive offer — no MLO review asked, no card, no line; the borrower may still ask (§2, T5)
      if (!presentedFor(ctx, id)) await requestOfferReview(deps, ctx, id); else await offerCard(deps, ctx, id); return;
    }
    case "mlo.review.completed": {
      if (p["outcome"] !== "approved") return;
      const quoteId = String(p["quote_id"] ?? ""); const m = /^Q-OFFER-(.+)$/.exec(quoteId); if (!m) return;
      const opportunityId = m[1]!; const leadId = String(p["lead_id"] ?? leadIdFor(opportunityId));
      if (!hasL(ctx, "terms.presented", (x) => x["quote_id"] === quoteId)) await exec(deps, { loan_id: ctx.loanId }, "20.3", "requestQuote", INTAKE, { op: "present", lead_id: leadId, quote_id: quoteId, review_id: String(p["review_id"]) });
      await offerCard(deps, ctx, opportunityId); return;
    }
    case "terms.presented": { const m = /^Q-OFFER-(.+)$/.exec(String(p["quote_id"] ?? "")); if (m) await offerCard(deps, ctx, m[1]!); return; }
    case "refi.opportunity.offered": { const id = String(p["opportunity_id"]); if (presentedFor(ctx, id)) await offerCard(deps, ctx, id); else await requestOfferReview(deps, ctx, id); return; }
    case "refi.opportunity.declined": {
      const id = String(p["opportunity_id"]); await closeOfferCards(deps, ctx, id, "cancelled", { reason: p["reason"] ?? "declined", declined_on: p["declined_on"] ?? null });
      if (p["reason"] !== "never_proactive_offers") for (const party of ctx.parties) await say(deps, party.party_id, { loan_id: ctx.loanId }, "offer.not_now", ctx.now);
      return;
    }
    case "refi.opportunity.expired": await closeOfferCards(deps, ctx, String(p["opportunity_id"]), "expired", { expired_at: e.occurredAt }); return;   // nothing is sent about expiry (§2)
    case "consent.marketing.revoked": {
      for (const party of ctx.parties) await say(deps, party.party_id, { loan_id: ctx.loanId }, "offer.never", ctx.now);
      const partyId = s(p["party_id"]); if (partyId && !hasL(ctx, "marketing.suppression.recorded", (x) => x["party_id"] === partyId && x["kind"] === "all_marketing")) {
        try { await exec(deps, { loan_id: ctx.loanId }, "20.2", "scheduleTouch", INTAKE, { op: "record_suppression", suppression_id: `sup-never-${ctx.loanId.slice(0, 8)}-${randomUUID().slice(0, 8)}`, kind: "all_marketing", party_id: partyId, loan_id: ctx.loanId, channel_received: "portal", requested_at: e.occurredAt, time_zone: "America/Phoenix" }); } catch (err) { deps.logger?.error("borrower.flow.32-11.suppression", { loan_id: ctx.loanId, error: err instanceof Error ? err.message : String(err) }); }
      }
      return;
    }
    case "refi.opportunity.engaged": await convert(deps, ctx, String(p["opportunity_id"]), String(p["lead_id"]), e); return;
    case "escrow.credit_to_new_loan.posted": for (const party of ctx.parties) await say(deps, party.party_id, { loan_id: ctx.loanId, application_id: e.applicationId ?? null }, "refi.escrow.moved", ctx.now); return;
    case "loan.boarded": await boardedCards(deps, ctx); return;
    case "consent.granted": { if (p["kind"] === "blanket_verification_authorization" && p["standing"] === true && s(p["party_id"]) && s(p["consent_id"])) await standingManageCard(deps, ctx, String(p["party_id"]), String(p["consent_id"])); return; }
    case "consent.blanket_verification_authorization.withdrawn": { const partyId = s(p["party_id"]); if (partyId) await say(deps, partyId, { loan_id: ctx.loanId }, "consent.standing.off", ctx.now); return; }
    default: return;
  }
}
async function reactApp(deps: FlowDeps, ctx: AppCtx, e: DomainEvent): Promise<void> {
  switch (e.type) {
    case "application.received": await compressedCards(deps, ctx); return;
    case "loan.funded": await fundedCard(deps, ctx, e); return;
    default: return;
  }
}

/** A typed "can I refinance?" on a serviced loan → 32.2 refi.request (20.1's request path: no solicitation gates; the recapture acknowledgment stays internal) — the reply names no rate (T1, T4). */
async function onMessage(deps: FlowDeps, m: InboundMessage): Promise<FlowReply | null> {
  const loanId = m.subject?.loan_id ?? null; if (!loanId || !REFI_REQUEST.test(m.text)) return null;
  const ctx = await loanContext(deps, loanId);
  const row = universeOf(ctx); const programs = ctx.store.list("partner_programs").map((r) => r.data as P);
  // the loan's program: the one its open/most recent opportunity runs under, else the partner's registered program (20.1's own default order)
  const known = ctx.store.list("refi_opportunities").map((r) => r.data as P).filter((o) => typeof o["program_id"] === "string").at(-1);
  const program = (known ? programs.find((x) => x["program_id"] === known["program_id"]) : undefined) ?? programs.find((x) => row && x["partner_id"] === row.partner_id) ?? programs[0];
  if (!program) return null;
  try {
    await exec(deps, { loan_id: loanId }, "32.2", "refi.request", BORROWER_APP, { loan_id: loanId, program_id: String(program["program_id"]), free_text: m.text, party_id: m.party_id, channel: m.channel });
    return { copy_key: "refi.request.received", command: "refi.request" };
  } catch (err) { deps.logger?.error("borrower.flow.32-11.refi_request", { loan_id: loanId, error: err instanceof Error ? err.message : String(err) }); return null; }
}

export const FLOW_11_RATE_WATCH: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => LOAN_EVENTS.has(type) || APP_EVENTS.has(type),
  async onEvents(deps, events) {
    const byLoan = new Map<string, DomainEvent[]>(); const byApp = new Map<string, DomainEvent[]>();
    for (const e of events) {
      if (LOAN_EVENTS.has(e.type)) { const loan = e.loanId ?? (typeof pl(e)["loan_id"] === "string" ? String(pl(e)["loan_id"]) : null); if (loan) { const l = byLoan.get(loan) ?? []; l.push(e); byLoan.set(loan, l); } }
      if (APP_EVENTS.has(e.type)) { const app = e.applicationId ?? (typeof pl(e)["application_id"] === "string" ? String(pl(e)["application_id"]) : null); if (app) { const l = byApp.get(app) ?? []; l.push(e); byApp.set(app, l); } }
    }
    for (const [loanId, list] of byLoan) {
      const ctx = await loanContext(deps, loanId);
      if (!ctx.parties.length) continue;   // no borrower party has signed in yet: there is no conversation to put a card in (01 §6.1)
      for (const e of list) { try { await reactLoan(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-11.reaction", { event: e.type, loan_id: loanId, error: err instanceof Error ? err.message : String(err) }); } }
    }
    for (const [appId, list] of byApp) {
      const ctx = await appContext(deps, appId);
      if (!ctx || !ctx.parties.length) continue;   // only a refinance of a serviced loan (prior_loan_id) is this flow's; a fresh application is 32.3's
      for (const e of list) { try { await reactApp(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.32-11.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
    }
  },
  onMessage,
};
