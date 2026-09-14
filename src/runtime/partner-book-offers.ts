/**
 * §33.2 rules 5–6 — offer delivery (`offer.deliver`) and expiry (`offer.expire`) for the partner book, run by the daily
 * review pass (src/runtime/partner-book-review.ts partnerBookReviewRun) after the reviews of the day are written, and
 * exposed on the bus as the `refi-analyst` agent's `offer.deliver` / `offer.expire` (src/app/tools/section33-2.ts).
 *
 *   deliverOffers   for each `refi_opportunities` row `offer_ready` on a monitored loan (the day's candidates the review pass
 *                   names, else every open one):
 *                     1. the partner's campaign `camp-refi-<partner8>` and creative `cr-refi-email-<partner8>` — one per
 *                        program, created by the pass through 20.2 (`planChannels{create_campaign}`, `renderCreative`) when
 *                        absent and approved by the officer (`renderCreative{op=approve}`, `planChannels{approve_campaign}`,
 *                        `planChannels{launch}`) — outside production the FAKE officer `{kind: human, id: FAKE:officer,
 *                        role: officer}` (the FAKE reviewer pattern of src/infra/integrations/reviewers.ts: only when the
 *                        runtime's FAKE reviewers are wired, never under ENVIRONMENT=production, FAKE_REVIEWERS=off or
 *                        INTEGRATIONS other than fake — otherwise the approvals wait for a person and the pass reports
 *                        the opportunity `skipped` with the reason). The
 *                        creative is the program's advertisement frame (the partner as the current lender and SM as its
 *                        servicer, the NMLSR ID, the no-fee phrasing, not a commitment, rates change daily, the CAN-SPAM
 *                        footer) with no rate in it: 20.2's §1026.24 / MAP / CAN-SPAM checklist passes on the frame, and the
 *                        loan's own figures ride in the notice the touch sends (NTC_REGZ_1026_24_REFI_OFFER, whose own rules
 *                        check the APR beside the rate, the payment statement, the taxes-and-insurance sentence).
 *                     2. the day's registry scrub once (`scheduleTouch{op=complete_scrub}`, a FAKE registry version — voice
 *                        gates only read it; the e-mail and portal channels never do).
 *                     3. per party a 20.2 touch (`scheduleTouch{facts}`): channel `email` with the party's e-mail as the
 *                        destination, the servicing relationship's informational consent as the consent fact, the day's scrub,
 *                        the party's suppressions from the store (the Never path of 32.11 writes one — never overridden), the
 *                        EBR anchored on the facts' as-of date, the sheet current, the e-mail count of the party's earlier
 *                        touches; a suppressed touch ends the loan there (the reason is reported).
 *                     4. `scheduleTouch{op=send}` with 20.1's benefit disclosure (`computeBenefit{op=explain}`) beside the
 *                        notice's fields (the partner's name and NMLSR ID, the account's last four, the current and offered
 *                        rates, the APR of the candidate's 20.4 quote, the payments, the sheet date, the unsubscribe link and
 *                        postal address) and the party's name and e-mail — the FAKE e-delivery holds the message.
 *                     5. `20.1 emitOfferReady{op=offered}` from the sent touch — 32.11's flow then asks the MLO of record's
 *                        review and places the OfferCard; the record's rate-watch block reads `offer_open`.
 *                   A party without an e-mail gets the portal channel only: a `portal` touch is scheduled through 20.2 (the same
 *                   gates — creative approval, suppressions — are evaluated and recorded) and, when it is permitted, marked sent
 *                   through 20.2's own `sendTouch` with no notice (`marketing.touch.sent{channel: portal, notice_id: null}`), then
 *                   `op=offered` as for e-mail: nothing is sent — no notice, no e-mail, no mail — the OfferCard 32.11 places is the
 *                   delivery, and the 2-BD SLA is satisfied by the touch like any channel's. (20.2's bus `send` on a portal touch
 *                   renders a notice whose channel decision would mail or hold it — the wrong evidence for "nothing sent".) A text
 *                   or an AI voice call is never scheduled here: the only channels this pass knows are `email` and `portal`
 *                   (NO_UNCONSENTED_TEXT_OR_VOICE).
 *   expireOffers    every SM_REFI_OPPORTUNITY_EXPIRY_30 on a monitored loan that is breached — or armed and past due: the
 *                   sweep runs this pass before its breach pass — and every `offered`/`offer_ready` opportunity whose
 *                   `offer_valid_until` has passed → `20.1 emitOfferReady{op=expired}` (20.1's own date rule decides; a clock
 *                   whose opportunity is not yet past its validity is left alone); 32.11 closes the OfferCard on
 *                   `refi.opportunity.expired` (flows/11-rate-watch.ts, status `expired`).
 *
 * Idempotent: a touch already sent for an opportunity is not sent twice (the touch id is `t-<channel>-<opportunity>`), an
 * opportunity already `offered` is skipped, a campaign or creative already approved is reused, the day's scrub is one row.
 * One open offer per loan: an `offer_ready` opportunity on a loan that already has an open offer — another opportunity
 * `offered` and not past its `offer_valid_until`, or `engaged` — is never delivered (skipped `open_offer:<id>`, no
 * `offered` event, the frequency cap untouched); the review pass continues the open offer instead (partner-book-review.ts)
 * and refi-daily holds such a loan out of the engine's run so no duplicate `offer_ready` (and no SM_REFI_OFFER_SLA_2BD) arises.
 * Money stays a decimal-string of cents on the wire (the notice payload) and bigint in process; dates are PlainDate.
 */
import { createHash } from "node:crypto";
import { wallClock } from "../kernel/calendar/zoned.ts";
import { plainDate as D, type PlainDate } from "../kernel/calendar/date.ts";
import type { Actor } from "../kernel/events/index.ts";
import type { Queryable } from "../infra/db/client.ts";
import { decodeEntityData } from "../infra/db/entities.ts";
import { EntityStore } from "../app/tools.ts";
import { INTAKE_AGENT, type PartnerProgram, type RefiOpportunity, type UniverseLoan } from "../domain/leads-pricing/ops-20-1.ts";
import { activeSheetAt, type RateSheet } from "../domain/leads-pricing/ops-20-4.ts";
import { sendTouch, type Touch } from "../domain/leads-pricing/ops-20-2.ts";
import { computeApr } from "../domain/compliance-disclosures/ops-25-1.ts";
import { contactDestinations } from "../domain/partner-book/import.ts";
import type { Runtime } from "./app.ts";
import type { Logger } from "./log.ts";

export const ET = "America/New_York";
export const CAMPAIGN_KIND = "refi_trigger_outbound";
export const SELECTION_RULE_SET = "sm.refi_trigger.v1";
export const EXPIRY_TIMER = "SM_REFI_OPPORTUNITY_EXPIRY_30";
/** The FAKE officer who approves the partner's campaign and creative in nonprod (DELTA-30's FAKE reviewer naming: every FAKE act carries `FAKE` in its id). */
export const FAKE_OFFICER: Actor = { kind: "human", id: "FAKE:officer", role: "officer" };
/** The postal address the CAN-SPAM footer carries when the partner's parties row has none (nonprod only; marked FAKE). */
export const FAKE_PARTNER_POSTAL_ADDRESS = "100 Example Way, Anytown, AZ 85000";
export const DEFAULT_APP_URL = "https://app.supermortgage.example";
/** The channels this pass may schedule (rule 5): never `sms`, `ai_voice` or `human_voice` — those need 20.2's marketing consent. */
export const DELIVERY_CHANNELS = ["email", "portal"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const campaignIdFor = (partnerId: string): string => `camp-refi-${partnerId.slice(0, 8)}`;
export const creativeIdFor = (partnerId: string): string => `cr-refi-email-${partnerId.slice(0, 8)}`;
export const scrubIdFor = (asOf: PlainDate): string => `scrub-FAKE-${asOf}`;
export const touchIdFor = (opportunityId: string, channel: DeliveryChannel): string => `t-${channel}-${opportunityId}`.slice(0, 200);
/** The FAKE officer unless a person approves: never in production (ENVIRONMENT=production — the repo's production switch, src/runtime/main.ts), nor under FAKE_REVIEWERS=off or INTEGRATIONS other than fake (src/infra/integrations/reviewers.ts fakeReviewerRolesFromEnv's rule). */
export function fakeOfficerFromEnv(env: NodeJS.ProcessEnv = process.env): Actor | null {
  if ((env["ENVIRONMENT"] ?? "nonprod").trim().toLowerCase() === "production") return null;
  if ((env["FAKE_REVIEWERS"] ?? "").trim().toLowerCase() === "off") return null;
  if ((env["INTEGRATIONS"] ?? "fake") !== "fake") return null;
  return FAKE_OFFICER;
}
/** The called party's time zone from the property state (quiet hours are voice/SMS rules; e-mail and the portal are not time-bound — the value is evidence on the gate record). */
export const timeZoneOf = (state: string | null): string => ({ AZ: "America/Phoenix", CA: "America/Los_Angeles", WA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", CO: "America/Denver", UT: "America/Denver", NM: "America/Denver", ID: "America/Denver", MT: "America/Denver", WY: "America/Denver", TX: "America/Chicago" } as Record<string, string>)[state ?? ""] ?? "America/New_York";

export type DeliverOffersOptions = { readonly logger?: Logger | undefined; readonly as_of_date?: PlainDate; readonly program_id?: string; /** restrict to these opportunity ids (the pass's candidates of the day) */ readonly opportunity_ids?: readonly string[]; /** the officer who approves the campaign and creative (default: the FAKE officer when the runtime's FAKE reviewers are wired and the environment allows them — `fakeOfficerFromEnv`; none otherwise, so the approvals wait for a person) */ readonly officer?: Actor | null; readonly env?: NodeJS.ProcessEnv };
export type DeliverOffersResult = { readonly delivered: number; readonly portal_only: number; /** touches 20.2's gates refused (the suppression reason per opportunity) */ readonly suppressed: number; /** opportunities this pass could not deliver, with the reason (no party, no officer to approve the campaign, a refused tool) */ readonly skipped: readonly { opportunity_id: string; loan_id: string; reason: string }[]; readonly campaigns: readonly { program_id: string; partner_id: string; campaign_id: string; creative_id: string; status: string; creative_status: string; approved_by: string | null }[] };
export type ExpireOffersResult = { readonly expired: number; readonly examined: number; readonly expired_ids: readonly string[] };

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const sha16 = (x: string): string => createHash("sha256").update(x).digest("hex").slice(0, 16);
/** A rate on the wire as a percent with three decimals: 20.1's fraction ("0.06375"), a percent ("6.375") or bps (63750) → "6.375". */
export const pct3 = (v: unknown): string | null => { if (v === null || v === undefined || v === "") return null; const n = Number(v); if (!Number.isFinite(n)) return null; return (n < 1 ? n * 100 : n > 100 ? n / 10_000 : n).toFixed(3); };
const centsStr = (v: unknown): string => (typeof v === "bigint" ? v.toString() : v === null || v === undefined ? "0" : String(v));

// ---------------------------------------------------------------- the partner and its program's campaign (rule 5: one per program, the officer's one-time approval)
export interface PartnerFacts { readonly partner_id: string; readonly legal_name: string; readonly nmlsr_id: string; readonly postal_address: string | null; readonly postal_address_fake: boolean }
/** The partner's advertising facts: the name from `parties`, the NMLSR ID from the global `partners/<id>` row (entry-seed / 33.1) else the parties contact, the postal address from the contact (FAKE in nonprod when absent). */
export async function partnerFacts(db: Queryable, store: EntityStore, partnerId: string, fake: boolean): Promise<PartnerFacts | null> {
  const row = (await db.query<{ id: string; legal_name: string; contact: Row | null }>(`SELECT id::text AS id, legal_name, contact FROM parties WHERE id = $1`, [partnerId]))[0];
  if (!row) return null;
  const c = row.contact ?? {}; const ent = store.get("partners", partnerId)?.data ?? {};
  const nmlsr = s(ent["nmlsr_id"]) ?? s(c["nmlsr_id"]) ?? "";
  const addr = c["postal_address"] ?? c["mailing_address"] ?? c["address"];
  const postal = typeof addr === "string" ? addr : addr && typeof addr === "object" ? [s((addr as Row)["line1"] ?? (addr as Row)["address_line1"]), s((addr as Row)["city"]), [s((addr as Row)["state"]), s((addr as Row)["postal_code"] ?? (addr as Row)["zip"])].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null;
  return { partner_id: partnerId, legal_name: row.legal_name, nmlsr_id: nmlsr, postal_address: postal || (fake ? FAKE_PARTNER_POSTAL_ADDRESS : null), postal_address_fake: !postal && fake };
}
export const unsubscribeLink = (campaignId: string, partyId: string | null, env: NodeJS.ProcessEnv = process.env): string => `${env["BORROWER_APP_URL"] ?? DEFAULT_APP_URL}/marketing/unsubscribe?campaign=${encodeURIComponent(campaignId)}${partyId ? `&token=${sha16(`${campaignId}:${partyId}`)}` : ""}`;
/**
 * The program's creative: the advertisement frame every offer e-mail of the program shares — no rate, no payment, no
 * term (the loan's own figures are the notice's), so 20.2's content checklist passes on the frame itself: the partner as
 * the current lender with SM as its servicer (§1026.24(i)(4)), the NMLSR ID, the approved no-fee phrasing, not a
 * commitment, rates change daily, the CAN-SPAM identification / unsubscribe / postal address.
 */
export function creativeFrame(p: PartnerFacts, campaignId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${p.legal_name}, NMLSR ID ${p.nmlsr_id}, is your current lender; Supermortgage services your loan for ${p.legal_name}. This message is about a refinance option on your current mortgage: the terms in it come from the day's published rate sheet and a licensed loan officer reviews them before they are yours. No lender fees and no third-party closing costs charged to you; those costs are paid by Supermortgage and reflected in the rate offered. This is not a commitment to lend. Rates change daily. This is an advertisement from ${p.legal_name} (the sender), sent by Supermortgage on its behalf; to stop marketing e-mail use this unsubscribe link: ${unsubscribeLink(campaignId, null, env)}. ${p.legal_name}, ${p.postal_address ?? ""}.`;
}
/** The rates on the sheet in force, as 20.2's approval checklist wants them ("6.375", …) — nothing in the frame states one; the list is the approval's evidence. */
export function sheetRatesPct(sheets: readonly RateSheet[], nowIso: string): { rate_sheet_id: string | null; rates: string[]; date: PlainDate | null } {
  const sheet = activeSheetAt(sheets, nowIso);
  if (!sheet) return { rate_sheet_id: null, rates: [], date: null };
  return { rate_sheet_id: sheet.rate_sheet_id, rates: [...new Set(sheet.prices.map((p) => pct3((p as unknown as Row)["note_rate_pct"] ?? p.note_rate)).filter((r): r is string => r !== null))], date: wallClock(Date.parse(sheet.published_at), ET).date };
}

interface CampaignState { campaign_id: string; creative_id: string; status: string; creative_status: string; approved_by: string | null }
async function exec(rt: Runtime, loanId: string, process: string, name: string, actor: Actor, input: Record<string, unknown>): Promise<Row> {
  const r = await rt.execute({ process, name, loanId, actor, input, run: { runId: "flow:33.2", modelVersion: "partner-book offers (deterministic)", promptVersion: "33.2-v1" } });
  return (r.output ?? {}) as Row;
}
/** Rule 5: the program's campaign and creative exist, approved by the officer, live — created by the pass where absent (global rows: every loan-scoped touch reads them). */
export async function ensureCampaign(rt: Runtime, store: EntityStore, program: PartnerProgram, partner: PartnerFacts, sheet: { rate_sheet_id: string | null; rates: string[] }, officer: Actor | null, env: NodeJS.ProcessEnv, log?: Logger): Promise<CampaignState | { blocked: string }> {
  const campaign_id = campaignIdFor(program.partner_id), creative_id = creativeIdFor(program.partner_id);
  const campaign = () => store.get("marketing_campaigns", campaign_id)?.data as Row | undefined;
  const creative = () => store.get("marketing_creatives", creative_id)?.data as Row | undefined;
  const refresh = async () => { store.seed(await rt.entities.load({})); };
  if (!campaign()) {
    await exec(rt, "", "20.2", "planChannels", INTAKE_AGENT, { op: "create_campaign", campaign_id, partner_id: program.partner_id, program_id: program.program_id, kind: CAMPAIGN_KIND, channels: [...DELIVERY_CHANNELS], selection_rule_set: SELECTION_RULE_SET, creative_ids: [creative_id] });
    await refresh(); log?.info("partner book offers: campaign created", { campaign_id, program_id: program.program_id, partner_id: program.partner_id });
  }
  if (!creative()) {
    if (!partner.nmlsr_id) return { blocked: `partner ${partner.partner_id} has no NMLSR ID (partners/<id> row or parties.contact.nmlsr_id): 20.2's checklist needs it beside every advertisement` };
    if (!partner.postal_address) return { blocked: `partner ${partner.partner_id} has no postal address (parties.contact.postal_address): CAN-SPAM needs one on every e-mail` };
    await exec(rt, "", "20.2", "renderCreative", INTAKE_AGENT, { creative_id, campaign_id, channel: "email", template: creativeFrame(partner, campaign_id, env), variables: {}, variables_schema: ["borrower_name", "offered_rate_pct"], rate_sheet_id: sheet.rate_sheet_id });
    await refresh(); log?.info("partner book offers: creative rendered", { creative_id, campaign_id, rate_sheet_id: sheet.rate_sheet_id });
  }
  const c0 = creative()!;
  if (c0["status"] !== "approved") {
    if (!officer) return { blocked: `creative ${creative_id} awaits the partner officer's approval (no FAKE officer in this environment)` };
    const r = await exec(rt, "", "20.2", "renderCreative", officer, { op: "approve", creative_id, campaign_kind: CAMPAIGN_KIND, sheet_rates_pct: sheet.rates, optout_offer_seconds: 2 });
    if (r["refused"] === true) return { blocked: `creative ${creative_id} refused by the officer's checklist: ${String(r["reason"])} ${JSON.stringify(r["detail"] ?? null)}` };
    await refresh(); log?.info("partner book offers: creative approved", { creative_id, approved_by: r["approved_by"] ?? null, actor: officer.id });
  }
  const camp0 = campaign()!;
  if (camp0["status"] === "draft") {
    if (!officer) return { blocked: `campaign ${campaign_id} awaits the partner officer's approval (no FAKE officer in this environment)` };
    const r = await exec(rt, "", "20.2", "planChannels", officer, { op: "approve_campaign", campaign_id });
    if (r["refused"] === true) return { blocked: `campaign ${campaign_id} refused at approval: ${String(r["reason"])} ${JSON.stringify(r["detail"] ?? null)}` };
    await refresh(); log?.info("partner book offers: campaign approved", { campaign_id, actor: officer.id });
  }
  const camp1 = campaign()!;
  if (camp1["status"] === "approved" || camp1["status"] === "paused") {
    await exec(rt, "", "20.2", "planChannels", officer ?? INTAKE_AGENT, { op: "launch", campaign_id });
    await refresh(); log?.info("partner book offers: campaign live", { campaign_id });
  }
  const camp = campaign()!, cr = creative()!;
  if (camp["status"] !== "live") return { blocked: `campaign ${campaign_id} is ${String(camp["status"])}, not live` };
  return { campaign_id, creative_id, status: String(camp["status"]), creative_status: String(cr["status"]), approved_by: s(camp["approved_by"]) };
}
/** The day's registry scrub (one row per day, a FAKE registry version): the voice gates read it; the e-mail and portal gates never do. */
export async function ensureScrub(rt: Runtime, store: EntityStore, asOf: PlainDate, nowIso: string): Promise<Row> {
  const scrub_id = scrubIdFor(asOf);
  const have = store.get("dnc_scrubs", scrub_id)?.data as Row | undefined; if (have) return have;
  const r = await exec(rt, "", "20.2", "scheduleTouch", INTAKE_AGENT, { op: "complete_scrub", scrub_id, source: "ftc_registry", obtained_at: nowIso, numbers_checked: 0, hits: 0, file_hash: `sha256:FAKE-registry-${asOf}` });
  store.seed(await rt.entities.load({}));
  return (store.get("dnc_scrubs", scrub_id)?.data as Row | undefined) ?? r;
}

// ---------------------------------------------------------------- the loans, parties and opportunities
interface MonitoredLoanRow extends Row { loan_id: string; partner_id: string; servicer_loan_number: string | null; property_state: string | null }
async function monitoredLoanRows(db: Queryable): Promise<Map<string, MonitoredLoanRow>> {
  const rows = await db.query<MonitoredLoanRow>(`SELECT l.id::text AS loan_id, l.partner_party_id::text AS partner_id, l.servicer_loan_number, p.state AS property_state FROM loans l LEFT JOIN properties p ON p.id = l.property_id WHERE l.status = 'monitored'`);
  return new Map(rows.map((r) => [r.loan_id, r]));
}
interface PartyRow extends Row { party_id: string; legal_name: string; contact: Row }
/** The loan's primary borrower party (33.1 wrote borrowers.party_id; the contact carries the supplement's e-mail and phone). */
async function partyOfLoan(db: Queryable, loanId: string): Promise<PartyRow | null> {
  return (await db.query<PartyRow>(`SELECT p.id::text AS party_id, p.legal_name, p.contact FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC, b.created_at LIMIT 1`, [loanId]))[0] ?? null;
}
/** The `refi_opportunities` rows of the monitored loans with a status in `statuses` (entity_current: the latest version whatever scope wrote it), bigint cents revived. */
async function opportunitiesOf(db: Queryable, loanIds: readonly string[], statuses: readonly string[]): Promise<RefiOpportunity[]> {
  if (!loanIds.length) return [];
  const rows = await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = 'refi_opportunities' AND loan_id = ANY($1::text[])`, [loanIds]);   // entity_records.loan_id is text
  return rows.map((r) => decodeEntityData(r.data) as unknown as RefiOpportunity).filter((o) => statuses.includes(o.status));
}
/** An open offer on `today`: `offered` and not past its `offer_valid_until` (none → open until 20.1 expires it), or `engaged` (the homeowner's Yes, 33.3's refi.open pending). */
export function isOpenOffer(o: Pick<RefiOpportunity, "status" | "offer_valid_until">, today: PlainDate): boolean {
  if (o.status === "engaged") return true;
  if (o.status !== "offered") return false;
  return o.offer_valid_until === null || o.offer_valid_until === undefined || D(String(o.offer_valid_until)) >= today;
}
/** The open offer per monitored loan on `today` (the newest opportunity by id when a loan has more than one), for the pass's one-open-offer rule and the engine's hold-out (refi-daily.ts). */
export async function openOffersOf(db: Queryable, loanIds: readonly string[], today: PlainDate): Promise<Map<string, RefiOpportunity>> {
  const out = new Map<string, RefiOpportunity>();
  for (const o of (await opportunitiesOf(db, loanIds, ["offered", "engaged"])).filter((o) => isOpenOffer(o, today)).sort((a, b) => a.opportunity_id.localeCompare(b.opportunity_id))) out.set(o.loan_id, o);
  return out;
}
/** The servicing relationship's informational consent as a 20.2 consent fact — the portal enrolment / the partner's file; `purpose: informational` never satisfies a marketing (PEWC) gate, which is the point: e-mail and the portal need none. */
export function informationalConsent(party: PartyRow, loanId: string, phone: string | null, capturedAt: string): Row {
  return { consent_id: `c-info-${loanId.slice(0, 8)}-${party.party_id.slice(0, 8)}`, party_id: party.party_id, loan_id: loanId, kind: "tcpa_voice", purpose: "informational", phone_number: phone ?? "", status: "active", written_consent: false, pewc_elements: null, signature_kind: null, disclosure_version: null, disclosure_text_hash: null, captured_at: capturedAt, written_confirmation_due_at: null, national_dnc_written_permission: false, evidence: { captured_via: "partner_book_import", source: "33.1 the partner's supplement" } };
}
/** The offer notice's payload (NTC_REGZ_1026_24_REFI_OFFER's fields) from 20.1's benefit disclosure and the opportunity row: the APR is the candidate's 20.4 quote's, else Appendix J over the candidate's own schedule (never a figure typed here). */
export function offerPayload(i: { disclosure: Row; opp: RefiOpportunity; quote: Row | null; partner: PartnerFacts; account_last4: string; rate_sheet_date: PlainDate; email_channel: boolean; unsubscribe_link: string }): Row {
  const c = i.opp.candidate_terms!; const ex = i.opp.existing_terms;
  const apr = s(i.quote?.["apr_estimate"]) ?? computeApr({ loan_amount_cents: c.loan_amount_cents, note_rate_pct: pct3(c.note_rate) ?? "0.000", term_months: c.term_months, term_start_date: c.schedule.disbursement_date, first_payment_date: c.schedule.first_payment_date, prepaid_finance_charges_cents: 0n, prepaid_interest_cents: c.prepaid_interest_cents }).apr_disclosed_str;
  return { ...i.disclosure, partner_name: i.partner.legal_name, partner_nmlsr_id: i.partner.nmlsr_id, account_last4: i.account_last4, current_rate_pct: pct3(ex.note_rate), offered_rate_pct: pct3(c.note_rate), apr_pct: apr, term_payments: c.term_months, pi_cents: centsStr(c.pi_cents), fixed: c.amortization === "fixed", amortization: c.amortization,
    rate_sheet_date: i.rate_sheet_date, invite_pewc: true, email_channel: i.email_channel, unsubscribe_link: i.unsubscribe_link, partner_postal_address: i.partner.postal_address ?? "" };
}

// ---------------------------------------------------------------- rule 5: offer.deliver
export async function deliverOffers(rt: Runtime, nowIso: string, opts: DeliverOffersOptions = {}): Promise<DeliverOffersResult> {
  const log = opts.logger; const env = opts.env ?? process.env; const asOf = opts.as_of_date ?? wallClock(Date.parse(nowIso), ET).date;
  // the officer: the caller's, else the FAKE officer only when the runtime runs the FAKE reviewers (src/runtime/main.ts fakeReviewersFromEnv) and the environment allows one — never in production
  const officer = opts.officer !== undefined ? opts.officer : rt.reviewers ? fakeOfficerFromEnv(env) : null;
  const skipped: { opportunity_id: string; loan_id: string; reason: string }[] = []; const campaigns: { program_id: string; partner_id: string; campaign_id: string; creative_id: string; status: string; creative_status: string; approved_by: string | null }[] = [];
  let delivered = 0, portal_only = 0, suppressed = 0;
  const monitored = await monitoredLoanRows(rt.db);
  if (!monitored.size) return { delivered, portal_only, suppressed, skipped, campaigns };
  const wanted = opts.opportunity_ids ? new Set(opts.opportunity_ids) : null;
  const opps = (await opportunitiesOf(rt.db, [...monitored.keys()], ["offer_ready"])).filter((o) => (!wanted || wanted.has(o.opportunity_id)) && (!opts.program_id || o.program_id === opts.program_id)).sort((a, b) => a.opportunity_id.localeCompare(b.opportunity_id));
  if (!opps.length) return { delivered, portal_only, suppressed, skipped, campaigns };
  const openBy = await openOffersOf(rt.db, [...new Set(opps.map((o) => o.loan_id))], asOf);   // one open offer per loan: a duplicate offer_ready beside it is never delivered
  const store = new EntityStore(); store.seed(await rt.entities.load({}));
  const programs = new Map(store.list("partner_programs").map((r) => [String(r.data["program_id"]), r.data as unknown as PartnerProgram]));
  const sheet = sheetRatesPct(store.list("rate_sheets").map((r) => r.data as unknown as RateSheet), nowIso);
  const byProgram = new Map<string, CampaignState | { blocked: string }>(); const partners = new Map<string, PartnerFacts | null>();
  let scrub: Row | null = null;
  for (const opp of opps) {
    const loan = monitored.get(opp.loan_id)!; const tag = { opportunity_id: opp.opportunity_id, loan_id: opp.loan_id };
    const open = openBy.get(opp.loan_id);
    if (open && open.opportunity_id !== opp.opportunity_id) { skipped.push({ ...tag, reason: `open_offer:${open.opportunity_id}` }); log?.info("partner book offers: an offer is already open on the loan — not offered again", { ...tag, open_opportunity_id: open.opportunity_id, open_status: open.status, offer_valid_until: open.offer_valid_until ?? null }); continue; }
    try {
      // the program's campaign and creative, once per program per pass
      const program = programs.get(opp.program_id); if (!program) { skipped.push({ ...tag, reason: `no partner_programs row ${opp.program_id}` }); continue; }
      if (!partners.has(program.partner_id)) partners.set(program.partner_id, await partnerFacts(rt.db, store, program.partner_id, officer !== null));
      const partner = partners.get(program.partner_id); if (!partner) { skipped.push({ ...tag, reason: `no parties row for partner ${program.partner_id}` }); continue; }
      if (!byProgram.has(program.program_id)) { const st = await ensureCampaign(rt, store, program, partner, sheet, officer, env, log); byProgram.set(program.program_id, st); if (!("blocked" in st)) campaigns.push({ program_id: program.program_id, partner_id: program.partner_id, ...st }); }
      const camp = byProgram.get(program.program_id)!; if ("blocked" in camp) { skipped.push({ ...tag, reason: camp.blocked }); continue; }
      scrub ??= await ensureScrub(rt, store, asOf, nowIso);
      // the party and its channel: e-mail when the contact has one, else the portal only
      const party = await partyOfLoan(rt.db, opp.loan_id); if (!party) { skipped.push({ ...tag, reason: "no borrower party on the loan (33.1 writes borrowers.party_id)" }); continue; }
      const dest = contactDestinations(party.contact); const email = dest.emails[0] ?? null; const phone = dest.phones[0] ?? null;
      const channel: DeliveryChannel = email ? "email" : "portal";
      const loanStore = new EntityStore(); loanStore.seed(await rt.entities.load({ loanId: opp.loan_id }));
      const row = loanStore.get("refi_universe", opp.loan_id)?.data as unknown as UniverseLoan | undefined;
      const state = loan.property_state ?? row?.property_state ?? null; const tz = timeZoneOf(state);
      const touch_id = touchIdFor(opp.opportunity_id, channel);
      const prior = loanStore.get("marketing_touches", touch_id)?.data as Row | undefined;
      const emailsSent = loanStore.list("marketing_touches", (d) => d["party_id"] === party.party_id && d["channel"] === "email" && (d["outcome"] === "sent" || d["outcome"] === "delivered")).length;
      let touch: Row | undefined = prior;
      if (!touch || touch["outcome"] === "queued") {
        const facts: Row = { touch: { touch_id, campaign_id: camp.campaign_id, campaign_kind: CAMPAIGN_KIND, creative_id: camp.creative_id, channel, party_id: party.party_id, loan_id: opp.loan_id, opportunity_id: opp.opportunity_id, destination: email ?? `portal:${party.party_id}`, destination_id: email ? `email:${sha16(email)}` : `portal:${party.party_id}`, line_type: null, queued_at: nowIso, time_zones: [tz], state },
          partner_name: partner.legal_name, consents: [informationalConsent(party, opp.loan_id, phone, `${asOf}T00:00:00.000Z`)], scrubs: [scrub], on_national_registry: false, ebr: { last_transaction_on: asOf }, rate_sheet_current: sheet.rate_sheet_id !== null, history: { emails_sent: emailsSent } };
        // `suppressions` is left to the store: the party's marketing_suppressions rows (the Never path of 32.11 writes all_marketing) gate the touch — never overridden here
        const sched = await exec(rt, opp.loan_id, "20.2", "scheduleTouch", INTAKE_AGENT, { facts });
        if (sched["outcome"] !== "scheduled") { suppressed += 1; skipped.push({ ...tag, reason: `touch ${touch_id} ${String(sched["outcome"])}: ${String(sched["suppression_reason"] ?? "")}` }); log?.info("partner book offers: touch suppressed", { ...tag, touch_id, reason: sched["suppression_reason"] ?? null }); continue; }
        loanStore.seed(await rt.entities.load({ loanId: opp.loan_id })); touch = loanStore.get("marketing_touches", touch_id)?.data as Row | undefined;
      }
      if (touch && (touch["outcome"] === "suppressed")) { suppressed += 1; skipped.push({ ...tag, reason: `touch ${touch_id} suppressed: ${String(touch["suppression_reason"] ?? "")}` }); continue; }
      if (channel === "email") {
        if (touch && touch["outcome"] === "scheduled") {
          const explain = await exec(rt, opp.loan_id, "20.1", "computeBenefit", INTAKE_AGENT, { op: "explain", opportunity_id: opp.opportunity_id });
          const quote = opp.candidate_terms?.quote_id ? (loanStore.get("pricing_quotes", opp.candidate_terms.quote_id)?.data as Row | undefined) ?? null : null;
          const payload = offerPayload({ disclosure: (explain["benefit_disclosure"] as Row | undefined) ?? {}, opp, quote, partner, account_last4: String(loan.servicer_loan_number ?? "").slice(-4), rate_sheet_date: sheet.date ?? asOf, email_channel: true, unsubscribe_link: unsubscribeLink(camp.campaign_id, party.party_id, env) });
          const sent = await exec(rt, opp.loan_id, "20.2", "scheduleTouch", INTAKE_AGENT, { op: "send", touch_id, payload, recipient: { name: party.legal_name, email } });
          log?.info("partner book offers: offer e-mail sent", { ...tag, touch_id, notice_id: sent["notice_id"] ?? null, party_id: party.party_id });
        }
        await exec(rt, opp.loan_id, "20.1", "emitOfferReady", INTAKE_AGENT, { op: "offered", opportunity_id: opp.opportunity_id });
        delivered += 1;
      } else {
        // portal only: nothing is sent — no notice, no e-mail, no mail. The scheduled portal touch (its passing gate record) is marked sent through 20.2's own
        // sendTouch with `notice_id: null` (`marketing.touch.sent{channel: portal}` — 20.1's `offered` consumes it and the 2-BD SLA is satisfied, as for any channel);
        // the OfferCard 32.11 places on `refi.opportunity.offered` is the delivery.
        if (touch && touch["outcome"] === "scheduled") {
          const mark = loanStore.versionCount(); const row2 = { ...touch } as unknown as Touch;
          await rt.uow.run({ loanId: opp.loan_id }, async (ctx) => { const r = sendTouch(ctx.events, row2, { sent_at: nowIso, notice_id: null, content_hash: null }, INTAKE_AGENT); loanStore.put("marketing_touches", touch_id, r.touch as unknown as Row, INTAKE_AGENT, nowIso); },
            { clock: rt.clock, commit: async (q) => { await rt.entities.save(loanStore.versionsSince(mark), { loanId: opp.loan_id }, q); } });
        }
        await exec(rt, opp.loan_id, "20.1", "emitOfferReady", INTAKE_AGENT, { op: "offered", opportunity_id: opp.opportunity_id });
        log?.info("partner book offers: portal only (no e-mail on file)", { ...tag, touch_id, party_id: party.party_id });
        portal_only += 1;
      }
    } catch (e) { const msg = e instanceof Error ? e.message : String(e); skipped.push({ ...tag, reason: msg }); log?.warn("partner book offers: opportunity not delivered", { ...tag, error: msg }); }
  }
  log?.info("partner book offers", { at: nowIso, as_of_date: asOf, delivered, portal_only, suppressed, skipped, campaigns, line: `partner book offers ${asOf}: delivered=${delivered} portal_only=${portal_only} suppressed=${suppressed} skipped=${skipped.length}` });
  return { delivered, portal_only, suppressed, skipped, campaigns };
}

// ---------------------------------------------------------------- rule 6: offer.expire
export async function expireOffers(rt: Runtime, nowIso: string): Promise<ExpireOffersResult> {
  const today = wallClock(Date.parse(nowIso), ET).date;
  const monitored = await monitoredLoanRows(rt.db);
  if (!monitored.size) return { expired: 0, examined: 0, expired_ids: [] };
  const ids = [...monitored.keys()];
  // the breached 30-day clocks (and the armed ones already past due: this pass runs before the sweep's breach pass), plus every open opportunity whose validity has passed
  const clocks = await rt.db.query<{ loan_id: string }>(`SELECT DISTINCT loan_id::text AS loan_id FROM timers WHERE code = $1 AND loan_id = ANY($2::uuid[]) AND (status = 'breached' OR (status = 'armed' AND due_at <= $3))`, [EXPIRY_TIMER, ids, nowIso]);
  const clocked = new Set(clocks.map((r) => r.loan_id));
  const open = await opportunitiesOf(rt.db, ids, ["offered", "offer_ready"]);
  const due = open.filter((o) => clocked.has(o.loan_id) || (o.offer_valid_until !== null && D(String(o.offer_valid_until)) < today));
  const expired_ids: string[] = [];
  for (const o of due) {
    const r = await exec(rt, o.loan_id, "20.1", "emitOfferReady", INTAKE_AGENT, { op: "expired", opportunity_id: o.opportunity_id });
    if (r["expired"] === true) expired_ids.push(o.opportunity_id);
  }
  return { expired: expired_ids.length, examined: due.length, expired_ids };
}
