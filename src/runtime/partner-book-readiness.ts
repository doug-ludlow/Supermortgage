/**
 * §33.3 — refinance readiness: what a refinance needs, what is on file, what is asked for
 * (spec/sections/33-partner-book/33-3-*.md), as the runtime pass the sweep takes after 33.2's daily review
 * (src/runtime/app.ts Runtime.sweep → partnerBookReviewRun → readinessRun) and the check the flows run on every
 * triggering event (identity.verified, credit.report.received, verification.received{income|assets}, consent.captured,
 * application.six_item.captured{ssn}) on a refinance application from a monitored loan.
 *
 *   rule 1  the items (`readinessItems`): every verification fact on the platform is keyed by an application, consents by
 *           a party — so a row reads party-level facts always (contact, activation, consents, any earlier application's
 *           identity through application_borrowers.party_id) and application-level facts once the refinance application
 *           exists (the SSN, the credit report, income, assets, the hard-pull authorization). Freshness is the owners':
 *           credit usable with `expires_at` ≥ as_of + 45 days (22.2 R3), identity `valid_until` ≥ the projected note date
 *           (22.6 R1; as_of + 45 days), a payroll or asset report dated within 120 days (this process's default; 22.3/22.4
 *           set none), a DU validation with a close-by date ahead, consents active, the partner's value within 12 months
 *           (33.2 rule 1's selection — the newest of FMV / BPO, else the original appraisal — read from the same
 *           monitoredUniverseRows the review reads, never recomputed here).
 *   rule 2  the check reads; it orders nothing — no vendor, no consumer report, no card. `readinessCheck` writes one
 *           readiness_checks row, its decision (agent refi-readiness, rule set partner_book.readiness.v1, model
 *           deterministic, prompt 33.3-v1, confidence 1) and `partner_book.readiness.checked` (loan-scoped,
 *           origination: true) in one unit of work on the loan.
 *   rule 3  `refiOpen` — the homeowner's Yes (`refi.opportunity.engaged` on a monitored loan, the borrower's own: the 32.2
 *           offer.respond actor, the lead the party owns or a resolved OfferCard with yes) opens the refinance application from
 *           the monitored loan — Runtime.createApplication{channel=refi_trigger, prior_loan_id}, the borrowers from borrowers /
 *           parties, the property from properties with the facts' value, application_borrowers.party_id linked — then the
 *           hand-off 32.11's convert() runs for a serviced loan (20.3 explainProgram{op=convert}, 20.1 emitOfferReady{op=converted},
 *           21.1 startInterview + captureField{credit_request} + confirmPrefill{op=offer} for the name, the address, the value and
 *           the candidate's loan amount) and `partner_book.refinance.opened` with its decision. Idempotent: an open application
 *           on the loan is returned, nothing more created. 32.11's convert() defers here for a monitored loan (no origination
 *           application); the flow src/runtime/borrower/flows/16-readiness.ts calls it and the bus tool `refi.open` wraps it.
 *   daily   `readinessRun` at/after 07:15 America/New_York once per calendar day over every loan whose latest review
 *           verdict is `candidate` and every open refinance application with `prior_loan_id` on a monitored loan; a loan
 *           whose refinance funded is skipped (rule 5: the loan reads paid_off) and a withdrawn / denied / cancelled application
 *           is no subject (`OPEN_REFINANCE_APPLICATION_SQL`: nothing on the platform writes applications.status for a withdrawal —
 *           21.x / 32.2 append the event only — so openness is judged by the status AND the absence of a closing event; the
 *           candidate branch still writes a row with application_id null until 33.2's review flips the verdict, which is the
 *           edge case's "the loan returns to the daily review under the cooldown"); then `partner_book.readiness.run_completed
 *           {as_of_date, checked, ready, not_ready, origination}` (global) — SM_PARTNER_BOOK_READINESS_DAILY's trigger and
 *           satisfying event (src/domain/partner-book/timers-33-3.ts: the day's clock on the global subject).
 *
 * No money figure is computed here: the value and the UPB the row cites are the partner's facts, read through 33.2's
 * helpers (latestPartnerFacts, monitoredUniverseRows) by import. Dates are PlainDate; ids are strings.
 */
import { randomUUID } from "node:crypto";
import { wallClock } from "../kernel/calendar/zoned.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../kernel/calendar/date.ts";
import type { Actor, DomainEvent } from "../kernel/events/index.ts";
import { toJson, type Queryable } from "../infra/db/client.ts";
import { decodeEntityData } from "../infra/db/entities.ts";
import type { DecisionInput } from "../infra/db/decisions.ts";
import type { UniverseLoan } from "../domain/leads-pricing/ops-20-1.ts";
import { EntityStore } from "../app/tools.ts";
import { ET, entityRowsById, latestPartnerFacts, monitoredLoans, monitoredUniverseRows, partiesOfLoans, type MonitoredFactsRow } from "./partner-book-review.ts";
import { partnerFacts, timeZoneOf } from "./partner-book-offers.ts";
import { mloOfRecord } from "./borrower/flows/11-rate-watch.ts";
import type { FlowDeps } from "./borrower/flows/index.ts";
import type { Runtime } from "./app.ts";
import type { Logger } from "./log.ts";

// ---------------------------------------------------------------- constants (the fixed interface)
export const READINESS_AT_ET = "07:15";
export const REFI_READINESS = "refi-readiness";
export const REFI_READINESS_AGENT: Actor = { kind: "agent", id: REFI_READINESS };
export const READINESS_RULE_SET_VERSION = "partner_book.readiness.v1";
export const READINESS_MODEL_VERSION = "deterministic";
export const READINESS_PROMPT_VERSION = "33.3-v1";
export const READINESS_RULE_CODE = "33.3 rule 1";
export const READINESS_RUN_PREFIX = "readiness-";
/** The projected note date of a refinance opened today: as_of + 45 days (rule 1: credit "with room to close"; 22.6's `valid_until` gate). */
export const PROJECTED_NOTE_DAYS = 45;
/** Credit: `expires_at` at least 45 days after the as-of date (22.2 R3: four months on the note date, room to close). */
export const CREDIT_ROOM_DAYS = 45;
/** Payroll and asset reports: dated within 120 days (this process's default — 22.3/22.4 set none; open question 1). */
export const REPORT_AGE_DAYS = 120;
/** The partner's value: dated within 12 months (33.2 rule 1's `medium` confidence window). */
export const VALUE_MONTHS = 12;
/** The hard-pull report types 22.2 orders on an application (a soft prequalification never counts). */
export const HARD_REPORT_TYPES: readonly string[] = ["tri_merge_infile", "rmcr"];
/** A credit report state that is usable and not superseded or expired (22.2: `usable`, then DU's reissue and the reliance at decision keep the same report). */
export const USABLE_REPORT_STATES: readonly string[] = ["usable", "du_reissued", "relied_upon"];
/** An application whose readiness rows stop (rule 5: funded under 30.x, or withdrawn / cancelled under 21.x). */
export const CLOSED_APPLICATION_STATUSES: readonly string[] = ["funded", "withdrawn", "denied", "cancelled", "closed", "closed_incomplete", "expired"];
/** The events that close an application under 21.x / 32.2 without touching applications.status (32.2 application.withdraw, 21.6 writeDecision) — an application with one is no readiness subject (rule 5). */
export const CLOSING_APPLICATION_EVENTS: readonly string[] = ["application.withdrawn", "application.denied", "application.cancelled"];
/**
 * One SQL predicate for "an open refinance application" on the alias `a`: not funded / closed by status, not boarded onto a loan,
 * and no closing event logged on it. `$loan` and `$statuses` name the parameter positions of the loan id and CLOSED_APPLICATION_STATUSES;
 * `$events` that of CLOSING_APPLICATION_EVENTS. Used by existingApplication, openRefinanceApplication, readinessSubjects and the flow's appContext.
 */
export const openRefinanceApplicationSql = (p: { loan: string; statuses: string; events: string }): string =>
  `a.prior_loan_id = ${p.loan} AND a.loan_id IS NULL AND NOT (a.status = ANY(${p.statuses}::text[])) AND NOT EXISTS (SELECT 1 FROM loan_events e WHERE e.application_id = a.id AND e.type = ANY(${p.events}::text[]))`;
/** Has a closing event (application.withdrawn / denied / cancelled) been logged on the application? */
export async function applicationClosedByEvent(db: Queryable, applicationId: string): Promise<boolean> {
  return (await db.query<{ n: string }>(`SELECT 1 AS n FROM loan_events e WHERE e.application_id = $1 AND e.type = ANY($2::text[]) LIMIT 1`, [applicationId, CLOSING_APPLICATION_EVENTS])).length > 0;
}

export type ReadinessItemName = "contact" | "account" | "esign" | "credit_authorization" | "verification_authorization" | "identity" | "ssn" | "credit" | "income" | "assets" | "value" | "insurance" | "payoff";
export type ReadinessStatus = "present" | "stale" | "missing" | "not_applicable";
export type ReadinessItem = { item: ReadinessItemName; status: ReadinessStatus; source_table: string | null; source_id: string | null; as_of: string | null; valid_until: string | null; rule_ref: string; refresh_via: string | null };
export const REQUIRED_FOR_READY: readonly ReadinessItemName[] = ["contact", "account", "esign", "credit_authorization", "identity", "ssn", "credit", "income", "assets", "value"];
/** The order missing[] is listed and asked (rule 4: identity → SSN → payroll → assets → the six items); a required item outside it (`account`: a sign-in, never a card) is listed after them. */
export const ASK_ORDER: readonly ReadinessItemName[] = ["contact", "identity", "ssn", "income", "assets", "esign", "credit_authorization", "credit", "value"];
export const ALL_ITEMS: readonly ReadinessItemName[] = ["contact", "account", "esign", "credit_authorization", "verification_authorization", "identity", "ssn", "credit", "income", "assets", "value", "insurance", "payoff"];

/** One `readiness_checks` row as read back (dates as ISO strings). */
export type ReadinessRow = { readonly id: string; readonly loan_id: string; readonly party_id: string | null; readonly application_id: string | null; readonly as_of_date: string; readonly items: ReadinessItem[]; readonly ready: boolean; readonly missing: ReadinessItemName[]; readonly decision_id: string | null; readonly created_at: string };
export interface ReadinessCheckInput { readonly loan_id: string; readonly party_id: string; readonly application_id: string | null; readonly as_of_date: string; /** as_of + 45 days */ readonly projected_note_date: string }
export interface ReadinessCheckResult { readonly id: string; readonly ready: boolean; readonly items: ReadinessItem[]; readonly missing: ReadinessItemName[]; readonly decision_id: string }
export interface ReadinessRunOptions { readonly logger?: Logger | undefined; /** run regardless of the wall clock (tests) */ readonly force?: boolean }
export interface ReadinessRunReport { readonly checked: number; readonly ready: number; readonly not_ready: number; /** "" when the pass ran; otherwise why it did not (before 07:15 ET, already ran today, no monitored loans) */ readonly skipped: string; readonly as_of_date: string; readonly ran: boolean; readonly loans_skipped: { loan_id: string; reason: string }[]; readonly line: string }
/** What a `readinessCheck` may be handed so the daily pass reads the book once (never required: a single check loads its own). */
export interface ReadinessCheckContext { readonly universe?: ReadonlyMap<string, UniverseLoan>; readonly facts?: ReadonlyMap<string, MonitoredFactsRow>; readonly factsRowIds?: ReadonlyMap<string, string> }

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
const isoDate = (v: unknown): string | null => { const d = dateOf(v); return d ? String(d) : null; };
export const projectedNoteDate = (asOf: PlainDate): PlainDate => addDays(asOf, PROJECTED_NOTE_DAYS);
export const readinessRunIdFor = (asOf: PlainDate): string => `${READINESS_RUN_PREFIX}${asOf}`;
const item = (i: ReadinessItemName, status: ReadinessStatus, rule_ref: string, refresh_via: string | null, src: { table?: string | null; id?: string | null; as_of?: string | null; valid_until?: string | null } = {}): ReadinessItem =>
  ({ item: i, status, source_table: src.table ?? null, source_id: src.id ?? null, as_of: src.as_of ?? null, valid_until: src.valid_until ?? null, rule_ref, refresh_via });

// ---------------------------------------------------------------- the rule references and the asks (rule 1 / rule 4)
const RULE: Readonly<Record<ReadinessItemName, string>> = {
  contact: "33.3 rule 1 contact (an e-mail and a phone on parties.contact)",
  account: "33.3 rule 1 account (partner_book.account.activated; 33.1 rule 6)",
  esign: "33.3 rule 1 esign (consents{kind=esign, status=active} whose scope carries the origination disclosure classes; 20.3 rule 10, 32.2)",
  credit_authorization: "33.3 rule 1 credit_authorization (credit_authorizations{kind=hard_application} on the refinance application's lead; 32.17 rule 20)",
  verification_authorization: "33.3 rule 1 verification_authorization (consents{kind=blanket_verification_authorization, standing=true, status=active})",
  identity: "33.3 rule 1 identity (verifications{kind=identity, outcome=verified} on any of the party's applications with valid_until ≥ the projected note date; 22.6 R1)",
  ssn: "33.3 rule 1 ssn (application_borrowers.tin_last4 on the refinance application, or borrowers.tin_last4; 32.18 rule 1)",
  credit: "33.3 rule 1 credit (credit_reports on the refinance application: tri-merge, usable, expires_at ≥ as_of + 45 days; 22.2 R3)",
  income: "33.3 rule 1 income (verifications{kind=income} with vendor_data_as_of within 120 days, or income.validated with a close-by date ahead; 22.3)",
  assets: "33.3 rule 1 assets (verifications{kind=assets, report_days=365} within 120 days; 22.4)",
  value: "33.3 rule 1 value (the partner's facts' newest value within 12 months; 33.2 rule 1)",
  insurance: "33.3 rule 1 insurance (insurance_policies{status=verified} on the loan or the application — a condition after DU, 23.2; not required)",
  payoff: "33.3 rule 1 payoff (the facts' UPB as of the latest upload; not_applicable until the application exists; not required)",
};
/** How each item is refreshed — the owning process's card or order; readiness never opens one itself (rule 2). */
const REFRESH: Readonly<Record<ReadinessItemName, string | null>> = {
  contact: "the contact card (32.2 party.contact.update) — the assistant asks for an e-mail first",
  account: "the homeowner's first sign-in through the borrower API (33.1: the invitation's link, a code on the e-mail on file)",
  esign: "ConsentCard{esign} (32.2 consent.capture; 20.3 rule 10)",
  credit_authorization: "the goal tap after the Yes (32.17 rule 20: 32.2 credit.authorize{hard_application} on the lead)",
  verification_authorization: "ConsentCard{blanket_verification_authorization} (32.2 consent.capture)",
  identity: "the identity scan card (32.3 E5: ConnectCard{stripe_identity}; 22.6)",
  ssn: "the SSN card — the one typed field (32.18 rule 1: application.six_item.captured{item=ssn})",
  credit: "22.2's order once the six items are in and the hard-pull authorization stands (32.18 rule 2: credit.report.received)",
  income: "the payroll connector card (32.3 R3: ConnectCard{truv_income}; 22.3 verification.received{kind=income}) — a standing connection is refreshed by 22.3's order, not re-asked",
  assets: "the assets connector card (32.18 rule 1: ConnectCard{plaid_assets}; 22.4 verification.received{kind=assets, report_days=365})",
  value: "the partner's next upload (33.1 book.import) — the application's value stays the candidate's until the borrower confirms a new one on its card",
  insurance: "23.2's insurance condition after DU (the carrier connection card)",
  payoff: null,
};

// ---------------------------------------------------------------- rule 1: the items from the rows
/** Every application the party stands on (application_borrowers.party_id), the refinance application included. */
async function applicationsOfParty(db: Queryable, partyId: string, applicationId: string | null): Promise<string[]> {
  const rows = await db.query<{ application_id: string }>(`SELECT DISTINCT application_id::text AS application_id FROM application_borrowers WHERE party_id = $1`, [partyId]);
  const ids = new Set(rows.map((r) => r.application_id)); if (applicationId) ids.add(applicationId);
  return [...ids];
}
/** The entity rows of one kind on a set of applications (entity_current: verifications / credit_reports are 22.x's entity records), decoded. */
async function entitiesOnApplications(db: Queryable, kind: string, applicationIds: readonly string[]): Promise<{ id: string; data: Row }[]> {
  if (!applicationIds.length) return [];
  const rows = await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = $1 AND data->>'application_id' = ANY($2::text[])`, [kind, applicationIds]);
  return rows.map((r) => ({ id: String(r.id), data: decodeEntityData(r.data) as Row }));
}
/** The hard-pull authorization of the refinance application's lead: 20.3's record on the lead entity (`leads.credit_authorizations[kind=hard_application]`, the lead id being the application id — 32.2 credit.authorize → 20.3 captureConsent), else the credit_authorizations table. */
async function hardPullAuthorization(rt: Runtime, applicationId: string): Promise<{ table: string; id: string; as_of: string | null } | null> {
  const lead = await rt.entities.current("leads", applicationId);
  const data = lead ? (decodeEntityData(lead.data) as Row) : null;
  const rows = Array.isArray(data?.["credit_authorizations"]) ? (data!["credit_authorizations"] as Row[]) : [];
  const hard = rows.filter((a) => a["kind"] === "hard_application").at(-1);
  if (hard && typeof hard["authorization_id"] === "string") return { table: "leads", id: hard["authorization_id"], as_of: isoDate(hard["captured_at"]) };
  const row = (await rt.db.query<{ id: string; captured_at: string }>(`SELECT authorization_id::text AS id, captured_at::text AS captured_at FROM credit_authorizations WHERE (application_id = $1::uuid OR lead_id = $1::uuid) AND kind = 'hard_application' ORDER BY captured_at DESC LIMIT 1`, [applicationId]))[0];
  return row ? { table: "credit_authorizations", id: row.id, as_of: isoDate(row.captured_at) } : null;
}
const newestBy = <T>(rows: readonly T[], key: (r: T) => string | null): T | null => { let best: T | null = null; let bestKey = ""; for (const r of rows) { const k = key(r) ?? ""; if (!best || k > bestKey) { best = r; bestKey = k; } } return best; };
const withinDays = (date: PlainDate, asOf: PlainDate, days: number): boolean => date >= addDays(asOf, -days);

/**
 * Rule 1's identity test, shared with the flow (flows/16-readiness connectorCards — rule 4: an identity verified on an earlier application
 * within its validity is not asked again): the newest verified identity on ANY application of the party (application_borrowers.party_id,
 * the refinance application included) by valid_until — `present` when valid_until is at or after the projected note date (or undated),
 * `stale` when earlier; null when none.
 */
export async function identityOnFile(db: Queryable, partyId: string, applicationId: string | null, projected: PlainDate): Promise<{ status: "present" | "stale"; id: string; as_of: string | null; valid_until: string | null } | null> {
  const partyApps = await applicationsOfParty(db, partyId, applicationId);
  const verifications = await entitiesOnApplications(db, "verifications", partyApps);
  const identities = verifications.filter((v) => v.data["kind"] === "identity" && v.data["outcome"] === "verified");
  const identity = newestBy(identities, (v) => isoDate(v.data["valid_until"]) ?? "9999-12-31");
  if (!identity) return null;
  const until = dateOf(identity.data["valid_until"]);
  return { status: !until || until >= projected ? "present" : "stale", id: identity.id, as_of: isoDate(identity.data["screened_on"]), valid_until: until ? String(until) : null };
}

/**
 * The thirteen items for a loan / party / (optional) refinance application as of a date — computed from rows only; nothing
 * is ordered, requested or sent (rule 2). `ctx` may carry the book's universe rows and facts so the daily pass reads them once.
 */
export async function readinessItems(rt: Runtime, i: ReadinessCheckInput, ctx: ReadinessCheckContext = {}): Promise<ReadinessItem[]> {
  const db = rt.db; const asOf = D(i.as_of_date); const projected = D(i.projected_note_date); const app = i.application_id;
  const items: ReadinessItem[] = [];

  // contact — an e-mail and a phone on parties.contact
  const party = (await db.query<{ contact: Row | null }>(`SELECT contact FROM parties WHERE id = $1`, [i.party_id]))[0];
  const contact = party?.contact ?? {};
  const email = s(contact["email"]); const phone = s(contact["phone"]) ?? s(contact["mobile"]);
  items.push(item("contact", email && phone ? "present" : "missing", RULE.contact, REFRESH.contact, { table: "parties", id: i.party_id }));

  // account — partner_book.account.activated for the party (any of the party's monitored loans; 33.1 logs it once per party × loan)
  const activated = (await db.query<{ id: string; occurred_at: string }>(`SELECT id::text AS id, occurred_at::text AS occurred_at FROM loan_events WHERE type = 'partner_book.account.activated' AND payload->>'party_id' = $1 ORDER BY sequence LIMIT 1`, [i.party_id]))[0];
  items.push(item("account", activated ? "present" : "missing", RULE.account, REFRESH.account, activated ? { table: "loan_events", id: activated.id, as_of: isoDate(activated.occurred_at) } : {}));

  // esign — consents{kind=esign, status=active} on the party (or the application) whose scope carries the origination disclosure classes
  const esign = (await db.query<{ id: string; captured_at: string }>(`SELECT id::text AS id, captured_at::text AS captured_at FROM consents WHERE kind = 'esign' AND status = 'active' AND revoked_at IS NULL AND (party_id = $1 OR ($2::uuid IS NOT NULL AND application_id = $2::uuid)) AND (scope && ARRAY['disclosures', 'origination_disclosures']::text[]) ORDER BY captured_at DESC LIMIT 1`, [i.party_id, app]))[0];
  items.push(item("esign", esign ? "present" : "missing", RULE.esign, REFRESH.esign, esign ? { table: "consents", id: esign.id, as_of: isoDate(esign.captured_at) } : {}));

  // credit_authorization — a hard_application authorization on the refinance application's lead (the application id is the lead id, 20.3) — before the application: missing.
  // 20.3 captureConsent keeps it on the lead record (`leads.credit_authorizations[]`, the entity store — the way routes hardPullAuthorization and flows/3-entry creditPull read it); the credit_authorizations table is the fallback
  const authz = app ? await hardPullAuthorization(rt, app) : null;
  items.push(item("credit_authorization", authz ? "present" : "missing", RULE.credit_authorization, REFRESH.credit_authorization, authz ? { table: authz.table, id: authz.id, as_of: authz.as_of } : {}));

  // verification_authorization — the blanket verification authorization standing on the party (not required)
  const bva = (await db.query<{ id: string; captured_at: string }>(`SELECT id::text AS id, captured_at::text AS captured_at FROM consents WHERE kind = 'blanket_verification_authorization' AND standing = true AND status = 'active' AND revoked_at IS NULL AND (party_id = $1 OR ($2::uuid IS NOT NULL AND application_id = $2::uuid)) ORDER BY captured_at DESC LIMIT 1`, [i.party_id, app]))[0];
  items.push(item("verification_authorization", bva ? "present" : "missing", RULE.verification_authorization, REFRESH.verification_authorization, bva ? { table: "consents", id: bva.id, as_of: isoDate(bva.captured_at) } : {}));

  // identity — verifications{kind=identity, outcome=verified} on ANY application of the party: valid_until ≥ projected → present, earlier → stale (an expiry the vendor did not date is not expired), none → missing
  const partyApps = await applicationsOfParty(db, i.party_id, app);
  const identity = await identityOnFile(db, i.party_id, app, projected);
  if (!identity) items.push(item("identity", "missing", RULE.identity, REFRESH.identity));
  else items.push(item("identity", identity.status, RULE.identity, REFRESH.identity, { table: "verifications", id: identity.id, as_of: identity.as_of, valid_until: identity.valid_until }));
  const verifications = await entitiesOnApplications(db, "verifications", partyApps);

  // ssn — application_borrowers.tin_last4 on the refinance application, else borrowers.tin_last4 (the servicing-side borrower of the loan / the party)
  const appSsn = app ? (await db.query<{ id: string }>(`SELECT id::text AS id FROM application_borrowers WHERE application_id = $1 AND tin_last4 IS NOT NULL ORDER BY created_at LIMIT 1`, [app]))[0] : undefined;
  const loanSsn = appSsn ? undefined : (await db.query<{ id: string }>(`SELECT b.id::text AS id FROM borrowers b LEFT JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE (lb.loan_id = $1 OR b.party_id = $2) AND b.tin_last4 IS NOT NULL ORDER BY lb.is_primary DESC NULLS LAST, b.created_at LIMIT 1`, [i.loan_id, i.party_id]))[0];
  items.push(item("ssn", appSsn || loanSsn ? "present" : "missing", RULE.ssn, REFRESH.ssn, appSsn ? { table: "application_borrowers", id: appSsn.id } : loanSsn ? { table: "borrowers", id: loanSsn.id } : {}));

  // credit — a hard-pull report on the refinance application, usable, expires_at ≥ as_of + 45 days → present; usable but expiring sooner → stale
  const reports = app ? (await entitiesOnApplications(db, "credit_reports", [app])).filter((r) => HARD_REPORT_TYPES.includes(String(r.data["report_type"])) && USABLE_REPORT_STATES.includes(String(r.data["state"]))) : [];
  const report = newestBy(reports, (r) => isoDate(r.data["report_date"]));
  if (!report) items.push(item("credit", "missing", RULE.credit, REFRESH.credit));
  else { const expires = dateOf(report.data["expires_at"]); items.push(item("credit", expires && expires >= addDays(asOf, CREDIT_ROOM_DAYS) ? "present" : "stale", RULE.credit, REFRESH.credit, { table: "credit_reports", id: report.id, as_of: isoDate(report.data["report_date"]), valid_until: expires ? String(expires) : null })); }

  // income — verifications{kind=income} (22.3 stores the kind as `component`) with vendor_data_as_of within 120 days, or income.validated with a close-by date ahead → present; older → stale; none → missing
  const appVerifications = app ? verifications.filter((v) => v.data["application_id"] === app) : [];
  const incomes = appVerifications.filter((v) => (v.data["kind"] === "income" || v.data["component"] === "income") && dateOf(v.data["vendor_data_as_of"]) !== null);
  const income = newestBy(incomes, (v) => isoDate(v.data["vendor_data_as_of"]));
  const validated = app ? (await db.query<{ id: string; occurred_at: string; close_by_date: string | null }>(`SELECT id::text AS id, occurred_at::text AS occurred_at, payload->>'close_by_date' AS close_by_date FROM loan_events WHERE type = 'income.validated' AND application_id = $1 AND payload->>'close_by_date' IS NOT NULL ORDER BY sequence DESC LIMIT 1`, [app]))[0] : undefined;
  const closeBy = validated ? dateOf(validated.close_by_date) : null;
  if (closeBy && closeBy >= asOf) items.push(item("income", "present", RULE.income, REFRESH.income, { table: "loan_events", id: validated!.id, as_of: isoDate(validated!.occurred_at), valid_until: String(closeBy) }));
  else if (income) { const dated = dateOf(income.data["vendor_data_as_of"])!; items.push(item("income", withinDays(dated, asOf, REPORT_AGE_DAYS) ? "present" : "stale", RULE.income, REFRESH.income, { table: "verifications", id: income.id, as_of: String(dated), valid_until: String(addDays(dated, REPORT_AGE_DAYS)) })); }
  else items.push(item("income", "missing", RULE.income, REFRESH.income));

  // assets — verifications{kind=assets, report_days=365} within 120 days → present; older → stale; none (or only a shorter report) → missing
  const assets = newestBy(appVerifications.filter((v) => v.data["kind"] === "assets" && Number(v.data["report_days"]) === 365 && dateOf(v.data["vendor_data_as_of"]) !== null), (v) => isoDate(v.data["vendor_data_as_of"]));
  if (!assets) items.push(item("assets", "missing", RULE.assets, REFRESH.assets));
  else { const dated = dateOf(assets.data["vendor_data_as_of"])!; items.push(item("assets", withinDays(dated, asOf, REPORT_AGE_DAYS) ? "present" : "stale", RULE.assets, REFRESH.assets, { table: "verifications", id: assets.id, as_of: String(dated), valid_until: String(addDays(dated, REPORT_AGE_DAYS)) })); }

  // value — the latest facts' newest value (33.2 rule 1's selection, read from the universe row) within 12 months → present, older → stale, none → missing
  const universe = ctx.universe ?? new Map((await monitoredUniverseRows(rt, asOf)).rows.map((r) => [r.loan_id, r]));
  const facts = ctx.facts?.get(i.loan_id) ?? (await latestPartnerFacts(db, [i.loan_id])).get(i.loan_id) ?? null;
  const factsRowId = ctx.factsRowIds?.get(i.loan_id) ?? (await db.query<{ id: string }>(`SELECT id::text AS id FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [i.loan_id]))[0]?.id ?? null;
  const row = universe.get(i.loan_id) ?? null;
  if (!row) items.push(item("value", "missing", RULE.value, REFRESH.value, factsRowId ? { table: "partner_book_facts", id: factsRowId } : {}));
  else { const valueDate = row.value_estimate.as_of; items.push(item("value", valueDate >= addMonths(asOf, -VALUE_MONTHS) ? "present" : "stale", RULE.value, REFRESH.value, { table: "partner_book_facts", id: factsRowId, as_of: String(valueDate), valid_until: String(addMonths(valueDate, VALUE_MONTHS)) })); }

  // insurance — insurance_policies{status=verified} on the loan or the application (not required)
  const policy = (await db.query<{ id: string; verified_at: string | null; expiration_date: string | null }>(`SELECT id::text AS id, verified_at::text AS verified_at, expiration_date::text AS expiration_date FROM insurance_policies WHERE status = 'verified' AND (loan_id = $1 OR ($2::uuid IS NOT NULL AND application_id = $2::uuid)) ORDER BY verified_at DESC NULLS LAST, created_at DESC LIMIT 1`, [i.loan_id, app]))[0];
  items.push(item("insurance", policy ? "present" : "missing", RULE.insurance, REFRESH.insurance, policy ? { table: "insurance_policies", id: policy.id, as_of: isoDate(policy.verified_at), valid_until: isoDate(policy.expiration_date) } : {}));

  // payoff — not_applicable until the application exists, then present with the facts' UPB as of the latest upload
  if (!app) items.push(item("payoff", "not_applicable", RULE.payoff, REFRESH.payoff));
  else items.push(item("payoff", facts && s(facts.facts["upb_cents"]) ? "present" : "missing", RULE.payoff, REFRESH.payoff, facts ? { table: "partner_book_facts", id: factsRowId, as_of: String(facts.as_of_date) } : {}));

  return items;
}

/** ready = every required item present; missing = the required items missing or stale in the order they are asked (ASK_ORDER, then the rest). */
export function readinessOf(items: readonly ReadinessItem[]): { ready: boolean; missing: ReadinessItemName[] } {
  const by = new Map(items.map((x) => [x.item, x]));
  const notReady = REQUIRED_FOR_READY.filter((n) => { const st = by.get(n)?.status ?? "missing"; return st === "missing" || st === "stale"; });
  const rank = (n: ReadinessItemName): number => { const k = ASK_ORDER.indexOf(n); return k < 0 ? ASK_ORDER.length + REQUIRED_FOR_READY.indexOf(n) : k; };
  const missing = [...notReady].sort((a, b) => rank(a) - rank(b));
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------- the row, its decision and its event
export interface ReadinessWriteRecord { readonly id: string; readonly decision_id: string; readonly decision: DecisionInput; readonly event: { type: "partner_book.readiness.checked"; loanId: string; aggregate: { kind: string; id: string }; payload: Record<string, unknown> } }
/** The decision record {loan_id, party_id, application_id, as_of_date, ready, missing, rule_set_version, model_version, prompt_version, confidence 1, rationale} and the loan-scoped event. */
export function readinessWriteRecord(i: ReadinessCheckInput, items: readonly ReadinessItem[], ids: { id?: string; decision_id?: string } = {}): ReadinessWriteRecord {
  const id = ids.id ?? randomUUID(); const decision_id = ids.decision_id ?? randomUUID();
  const { ready, missing } = readinessOf(items);
  const summary = items.map((x) => `${x.item} ${x.status}${x.source_table ? ` (${x.source_table}${x.source_id ? ` ${x.source_id}` : ""}${x.as_of ? ` as of ${x.as_of}` : ""}${x.valid_until ? ` until ${x.valid_until}` : ""})` : ""}`).join("; ");
  const decision: DecisionInput = { agent: REFI_READINESS, action: "readiness.check", ruleSetVersion: READINESS_RULE_SET_VERSION, loanId: i.loan_id, ...(i.application_id ? { applicationId: i.application_id } : {}), subject: { kind: "readiness_check", id }, ruleCode: READINESS_RULE_CODE,
    confidence: 1, modelVersion: READINESS_MODEL_VERSION, promptVersion: READINESS_PROMPT_VERSION,
    rationale: `readiness of loan ${i.loan_id} (party ${i.party_id}${i.application_id ? `, application ${i.application_id}` : ", no application yet"}) as of ${i.as_of_date}, projected note date ${i.projected_note_date}: ${ready ? "ready — every required item is present" : `not ready — missing or stale: ${missing.join(", ")}`}; items: ${summary}. Read from rows only; nothing ordered, requested or sent (33.3 rule 2).` };
  const event: ReadinessWriteRecord["event"] = { type: "partner_book.readiness.checked", loanId: i.loan_id, aggregate: { kind: "readiness_check", id },
    payload: { readiness_check_id: id, loan_id: i.loan_id, party_id: i.party_id, application_id: i.application_id, as_of_date: i.as_of_date, projected_note_date: i.projected_note_date, ready, missing, items: items.map((x) => ({ item: x.item, status: x.status })), decision_id, rule_set_version: READINESS_RULE_SET_VERSION, origination: true } };
  return { id, decision_id, decision, event };
}
/** The `readiness_checks` row (append-only; one per loan per day and one per triggering event). */
export async function insertReadinessRow(q: Queryable, i: ReadinessCheckInput, items: readonly ReadinessItem[], r: ReadinessWriteRecord, createdAt: string): Promise<void> {
  const { ready, missing } = readinessOf(items);
  await q.query(`INSERT INTO readiness_checks (id, loan_id, party_id, application_id, as_of_date, items, ready, missing, decision_id, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10)`,
    [r.id, i.loan_id, i.party_id, i.application_id, i.as_of_date, toJson(items), ready, toJson(missing), r.decision_id, createdAt]);
}

/**
 * `readiness.check`: computes the items from rows, writes one readiness_checks row, the decision (agent refi-readiness,
 * rule set partner_book.readiness.v1, model deterministic, prompt 33.3-v1, confidence 1) and `partner_book.readiness.checked`
 * (loan-scoped, origination: true) in ONE unit of work on the loan. ORDERS NOTHING: no vendor, no consumer report, no card.
 */
export async function readinessCheck(rt: Runtime, i: ReadinessCheckInput, ctx: ReadinessCheckContext = {}): Promise<ReadinessCheckResult> {
  if (!i.loan_id || !i.party_id) throw new RangeError("readiness.check needs loan_id and party_id");
  if (D(i.projected_note_date) < D(i.as_of_date)) throw new RangeError("projected_note_date is before as_of_date");
  const items = await readinessItems(rt, i, ctx);
  const r = readinessWriteRecord(i, items);
  await rt.uow.run({ loanId: i.loan_id }, async (uctx) => { uctx.events.append({ type: r.event.type, loanId: r.event.loanId, aggregate: r.event.aggregate, actor: REFI_READINESS_AGENT, payload: r.event.payload }); },
    { clock: rt.clock, commit: async (q) => { await rt.uow.decisions.record(r.decision, q, r.decision_id); await insertReadinessRow(q, i, items, r, rt.clock.now()); } });
  const { ready, missing } = readinessOf(items);
  return { id: r.id, ready, items, missing, decision_id: r.decision_id };
}

// ---------------------------------------------------------------- the daily pass
export interface ReadinessSubject { readonly loan_id: string; readonly party_id: string | null; readonly application_id: string | null; readonly why: "candidate" | "open_application" }
/** Has the readiness pass completed for `asOf` (idempotent per day)? */
export async function readinessRanToday(db: Queryable, asOf: PlainDate): Promise<boolean> {
  return (await db.query<{ n: string }>(`SELECT 1 AS n FROM loan_events WHERE type = 'partner_book.readiness.run_completed' AND payload->>'as_of_date' = $1 LIMIT 1`, [asOf])).length > 0;
}
/** The open refinance application of a monitored loan (prior_loan_id = the loan, not funded / closed by status and no withdrawn / denied / cancelled event — openRefinanceApplicationSql), newest first. */
export async function openRefinanceApplication(db: Queryable, loanId: string): Promise<{ application_id: string; party_id: string | null; status: string } | null> {
  const r = (await db.query<{ application_id: string; party_id: string | null; status: string }>(`SELECT a.id::text AS application_id, (SELECT ab.party_id::text FROM application_borrowers ab WHERE ab.application_id = a.id AND ab.party_id IS NOT NULL ORDER BY ab.created_at LIMIT 1) AS party_id, a.status FROM applications a WHERE ${openRefinanceApplicationSql({ loan: "$1", statuses: "$2", events: "$3" })} ORDER BY a.created_at DESC LIMIT 1`, [loanId, CLOSED_APPLICATION_STATUSES, CLOSING_APPLICATION_EVENTS]))[0];
  return r ?? null;
}
/**
 * Inputs and triggers: every monitored loan whose latest partner_book_reviews verdict is `candidate`, and every open
 * application with `prior_loan_id` on a monitored loan (its linked party first); a loan whose refinance funded (the loan then
 * reads paid_off) is not a subject and a withdrawn / denied / cancelled application (openRefinanceApplicationSql: the event, since
 * nothing writes the status) is no open application — the loan stays a subject only while its latest review verdict is `candidate`,
 * with application_id null (rule 5; the edge case's "the loan returns to the daily review under the cooldown").
 */
export async function readinessSubjects(db: Queryable): Promise<ReadinessSubject[]> {
  const candidates = await db.query<{ loan_id: string; party_id: string | null; verdict: string }>(`SELECT r.loan_id::text AS loan_id, r.party_id::text AS party_id, r.verdict FROM (SELECT DISTINCT ON (loan_id) loan_id, party_id, verdict FROM partner_book_reviews ORDER BY loan_id, as_of_date DESC, created_at DESC) r JOIN loans l ON l.id = r.loan_id WHERE l.status = 'monitored' AND r.verdict = 'candidate' ORDER BY r.loan_id`);
  const opens = await db.query<{ loan_id: string; application_id: string; party_id: string | null }>(`SELECT DISTINCT ON (a.prior_loan_id) a.prior_loan_id::text AS loan_id, a.id::text AS application_id, (SELECT ab.party_id::text FROM application_borrowers ab WHERE ab.application_id = a.id AND ab.party_id IS NOT NULL ORDER BY ab.created_at LIMIT 1) AS party_id FROM applications a JOIN loans l ON l.id = a.prior_loan_id WHERE l.status = 'monitored' AND ${openRefinanceApplicationSql({ loan: "l.id", statuses: "$1", events: "$2" })} ORDER BY a.prior_loan_id, a.created_at DESC`, [CLOSED_APPLICATION_STATUSES, CLOSING_APPLICATION_EVENTS]);
  const by = new Map<string, ReadinessSubject>();
  for (const c of candidates) by.set(c.loan_id, { loan_id: c.loan_id, party_id: c.party_id, application_id: null, why: "candidate" });
  for (const o of opens) { const prior = by.get(o.loan_id); by.set(o.loan_id, { loan_id: o.loan_id, party_id: o.party_id ?? prior?.party_id ?? null, application_id: o.application_id, why: "open_application" }); }
  const missingParty = [...by.values()].filter((x) => !x.party_id).map((x) => x.loan_id);
  if (missingParty.length) { const parties = await partiesOfLoans(db, missingParty); for (const id of missingParty) { const x = by.get(id)!; by.set(id, { ...x, party_id: parties.get(id) ?? null }); } }
  return [...by.values()].sort((a, b) => (a.loan_id < b.loan_id ? -1 : a.loan_id > b.loan_id ? 1 : 0));
}

const skippedReport = (asOf: PlainDate, reason: string): ReadinessRunReport => ({ checked: 0, ready: 0, not_ready: 0, skipped: reason, as_of_date: asOf, ran: false, loans_skipped: [], line: `partner book readiness ${asOf}: not run (${reason})` });

/**
 * The daily pass at/after 07:15 America/New_York once per calendar day: one `readinessCheck` per subject (the book's
 * universe rows and facts read once), then `partner_book.readiness.run_completed{as_of_date, checked, ready, not_ready,
 * origination}` (global) — idempotent per day. A loan without a party is skipped with its reason (escalation: ops_analyst
 * when an application cannot be opened is refi.open's; here the row simply waits for the party). Never a vendor order.
 */
export async function readinessRun(rt: Runtime, nowIso: string, opts: ReadinessRunOptions = {}): Promise<ReadinessRunReport> {
  const wc = wallClock(Date.parse(nowIso), ET); const asOf = wc.date; const log = opts.logger;
  const [hh, mm] = READINESS_AT_ET.split(":").map(Number) as [number, number];
  const loans = await monitoredLoans(rt.db);
  if (!loans.length) return skippedReport(asOf, "no monitored loans with partner_book_facts (33.1 import)");
  if (!opts.force && wc.hour * 60 + wc.minute < hh * 60 + mm) return skippedReport(asOf, `before ${READINESS_AT_ET} ET`);
  if (await readinessRanToday(rt.db, asOf)) return skippedReport(asOf, "already ran today");
  const subjects = await readinessSubjects(rt.db);
  const ids = subjects.map((x) => x.loan_id);
  const [universeRows, facts, factsIds] = await Promise.all([monitoredUniverseRows(rt, asOf), latestPartnerFacts(rt.db, ids), ids.length ? rt.db.query<{ loan_id: string; id: string }>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, id::text AS id FROM partner_book_facts WHERE loan_id = ANY($1::uuid[]) ORDER BY loan_id, as_of_date DESC, created_at DESC`, [ids]) : Promise.resolve([])]);
  const ctx: ReadinessCheckContext = { universe: new Map(universeRows.rows.map((r) => [r.loan_id, r])), facts, factsRowIds: new Map(factsIds.map((r) => [r.loan_id, r.id])) };
  const projected = projectedNoteDate(asOf);
  let checked = 0; let ready = 0; const loans_skipped: { loan_id: string; reason: string }[] = []; const checkedLoans: Record<string, unknown>[] = [];
  for (const sub of subjects) {
    if (!sub.party_id) { loans_skipped.push({ loan_id: sub.loan_id, reason: "no party on the loan's borrower (33.1 rule 3)" }); continue; }
    try {
      const r = await readinessCheck(rt, { loan_id: sub.loan_id, party_id: sub.party_id, application_id: sub.application_id, as_of_date: asOf, projected_note_date: projected }, ctx);
      checked += 1; if (r.ready) ready += 1;
      checkedLoans.push({ loan_id: sub.loan_id, party_id: sub.party_id, application_id: sub.application_id, why: sub.why, readiness_check_id: r.id, ready: r.ready, missing: r.missing });
    } catch (e) { const msg = e instanceof Error ? e.message : String(e); loans_skipped.push({ loan_id: sub.loan_id, reason: `check failed: ${msg}` }); log?.warn("partner book readiness: check failed", { loan_id: sub.loan_id, as_of_date: asOf, error: msg }); }
  }
  const not_ready = checked - ready;
  const run_id = readinessRunIdFor(asOf);
  // the receipt (global): SM_PARTNER_BOOK_READINESS_DAILY's trigger and satisfying event — the day's clock, re-armed for tomorrow 07:15 ET
  await rt.uow.run({}, async (uctx) => { uctx.events.append({ type: "partner_book.readiness.run_completed", aggregate: { kind: "partner_book_readiness_run", id: run_id }, actor: REFI_READINESS_AGENT,
    payload: { run_id, as_of_date: asOf, at: nowIso, projected_note_date: projected, checked, ready, not_ready, candidates: subjects.filter((x) => x.why === "candidate").length, open_applications: subjects.filter((x) => x.why === "open_application").length, skipped: loans_skipped.length, loans: checkedLoans, loans_skipped, rule_set_version: READINESS_RULE_SET_VERSION, origination: true } }); }, { clock: rt.clock });
  const line = `partner book readiness ${asOf}: checked=${checked} ready=${ready} not_ready=${not_ready} subjects=${subjects.length} skipped=${loans_skipped.length}${loans_skipped.length ? ` skipped_loans=${JSON.stringify(loans_skipped)}` : ""}`;
  log?.info("partner book readiness run", { at: nowIso, as_of_date: asOf, run_id, checked, ready, not_ready, loans: checkedLoans, loans_skipped, line });
  return { checked, ready, not_ready, skipped: "", as_of_date: asOf, ran: true, loans_skipped, line };
}

// ---------------------------------------------------------------- the read (console + the turn's situation)
const ROW_COLS = `r.id::text AS id, r.loan_id::text AS loan_id, r.party_id::text AS party_id, r.application_id::text AS application_id, r.as_of_date::text AS as_of_date, r.items, r.ready, r.missing, r.decision_id::text AS decision_id, r.created_at::text AS created_at`;
/** The latest readiness row of a loan (by created_at, then the order its `partner_book.readiness.checked` event was logged — rows of one settlement under a fixed clock share a created_at). */
export async function readinessRead(rt: Runtime, loanId: string): Promise<ReadinessRow | null> {
  const r = (await rt.db.query<ReadinessRow>(`SELECT ${ROW_COLS} FROM readiness_checks r LEFT JOIN LATERAL (SELECT max(e.sequence) AS seq FROM loan_events e WHERE e.loan_id = r.loan_id AND e.type = 'partner_book.readiness.checked' AND e.payload->>'readiness_check_id' = r.id::text) ev ON true WHERE r.loan_id = $1 ORDER BY r.created_at DESC, ev.seq DESC NULLS LAST LIMIT 1`, [loanId]))[0];
  return r ?? null;
}
/** Every readiness row of a loan, oldest first (the examiner's view: the rows by date with each item's source, as-of and validity). */
export async function readinessHistory(rt: Runtime, loanId: string): Promise<ReadinessRow[]> {
  return rt.db.query<ReadinessRow>(`SELECT ${ROW_COLS} FROM readiness_checks r LEFT JOIN LATERAL (SELECT max(e.sequence) AS seq FROM loan_events e WHERE e.loan_id = r.loan_id AND e.type = 'partner_book.readiness.checked' AND e.payload->>'readiness_check_id' = r.id::text) ev ON true WHERE r.loan_id = $1 ORDER BY r.created_at, ev.seq NULLS FIRST`, [loanId]);
}

// ---------------------------------------------------------------- rule 3: refi.open — the Yes opens the refinance application from the monitored loan
export interface RefiOpenInput { readonly loan_id: string; readonly opportunity_id: string; readonly lead_id: string; readonly engaged: DomainEvent }
/** The intake agent opens and hands off the file (21.1 / 20.3 / 20.1 run as the intake agent, as they do under 32.11's convert). */
export const INTAKE_AGENT: Actor = { kind: "agent", id: "intake" };
/** 32.2's command surface: every card command runs as this agent — the `refi.opportunity.engaged` a Yes on the OfferCard writes carries it (32.11 convert's byBorrower test). */
export const BORROWER_APP_AGENT: Actor = { kind: "agent", id: "borrower-app" };
export const REFI_OPEN_RUN = { runId: "flow:33.3", modelVersion: READINESS_MODEL_VERSION, promptVersion: READINESS_PROMPT_VERSION } as const;
export const REFI_OPEN_RULE_CODE = "33.3 rule 3";
/** A refusal of refi.open (YES_REQUIRED / a loan that is not monitored / no party or property): the flow logs it, the bus tool answers it. */
export class RefiOpenRefused extends RangeError { readonly code: "YES_REQUIRED" | "NOT_MONITORED" | "NO_PARTY" | "NO_PROPERTY" | "NO_OPPORTUNITY"; constructor(code: RefiOpenRefused["code"], message: string) { super(message); this.name = "RefiOpenRefused"; this.code = code; } }

interface LoanBorrowerRow { readonly borrower_id: string; readonly legal_name: string; readonly party_id: string | null; readonly tin_last4: string | null; readonly date_of_birth: string | null; readonly is_primary: boolean; readonly contact: Row | null }
/** The loan's borrowers (borrowers ⋈ loan_borrowers, the primary first) with their parties' contact (33.1 rule 3: borrowers.party_id). */
async function loanBorrowers(db: Queryable, loanId: string): Promise<LoanBorrowerRow[]> {
  return db.query<LoanBorrowerRow & Row>(`SELECT b.id::text AS borrower_id, b.legal_name, b.party_id::text AS party_id, b.tin_last4, b.date_of_birth::text AS date_of_birth, lb.is_primary, p.contact FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id LEFT JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC, b.created_at, b.id`, [loanId]);
}
/** The resolved OfferCard that said yes on this opportunity (32.11 convert's yesCardFor). */
async function yesCardFor(db: Queryable, loanId: string, opportunityId: string): Promise<{ party_id: string } | undefined> {
  return (await db.query<{ party_id: string }>(`SELECT party_id::text AS party_id FROM card_instances WHERE subject_loan_id = $1 AND kind = 'OfferCard' AND status = 'resolved' AND props->>'refi_opportunity_id' = $2 AND (evidence->>'decision' = 'yes' OR evidence->>'option_id' = 'yes') ORDER BY resolved_at DESC LIMIT 1`, [loanId, opportunityId]))[0];
}
/** The open application of the loan (32.11 convert's own test: the lead's id, or an unfunded, unwithdrawn one with prior_loan_id = the loan — openRefinanceApplicationSql). */
async function existingApplication(db: Queryable, leadId: string, loanId: string): Promise<string | null> {
  const r = (await db.query<{ id: string }>(`SELECT a.id::text AS id FROM applications a WHERE a.id::text = $1 OR (${openRefinanceApplicationSql({ loan: "$2", statuses: "$3", events: "$4" })}) ORDER BY (a.id::text = $1) DESC, a.created_at DESC LIMIT 1`, [leadId, loanId, CLOSED_APPLICATION_STATUSES, CLOSING_APPLICATION_EVENTS]))[0];
  return r?.id ?? null;
}
type Occupancy = "primary" | "second_home" | "investment";
/** The occupancy of the refinance: the loan's property row, else the tape's text, else the universe row's — never asked here (the home card re-confirms it). */
export function occupancyOf(property: string | null | undefined, tape: unknown, universe: string | null | undefined): Occupancy {
  const norm = (v: unknown): Occupancy | null => { const t = String(v ?? "").toLowerCase(); if (!t) return null; if (/second/.test(t)) return "second_home"; if (/invest|non.?owner|rental|tenant/.test(t)) return "investment"; if (/owner|primary|principal/.test(t)) return "primary"; return null; };
  return norm(property) ?? norm(tape) ?? norm(universe) ?? "primary";
}
type UladPropertyType = "sfr" | "condo" | "pud" | "2_4_unit" | "manufactured";
/** The servicing property's type (33.1 keeps the tape's text — "Single Family", "PUD", "Condominium" — or its code) as 21.1's ULAD enumeration (MISMO 3.4 B324: sfr | condo | pud | 2_4_unit | manufactured); null when it names none. */
export function uladPropertyTypeOf(...values: readonly unknown[]): UladPropertyType | null {
  for (const v of values) {
    const t = String(v ?? "").trim().toLowerCase(); if (!t) continue;
    if (["sfr", "condo", "pud", "2_4_unit", "manufactured"].includes(t)) return t as UladPropertyType;
    if (/manufactured|mobile|mh\b/.test(t)) return "manufactured";
    if (/condo|^co$/.test(t)) return "condo";
    if (/pud|planned unit|^pu$/.test(t)) return "pud";
    if (/2[- ]?4|duplex|triplex|fourplex|quadplex|multi|two.to.four|^(2|3|4)[- ]?(unit|family)|^(du|tp|fp)$/.test(t)) return "2_4_unit";
    if (/single|detached|1[- ]?unit|one[- ]?unit|^sf[rd]?$|townhouse|town home|row/.test(t)) return "sfr";
  }
  return null;
}
/** The facts' newest value by date (33.2 rule 1's selection, the fallback when the universe row is absent): FMV / BPO by their dates, else the original appraisal. */
export function newestFactsValue(facts: Record<string, unknown> | null | undefined): { value_cents: string; as_of: string | null } | null {
  if (!facts) return null;
  const c = (k: string, d: string): { value_cents: string; as_of: string | null } | null => { const v = s(facts[k]); return v && /^\d+$/.test(v) ? { value_cents: v, as_of: isoDate(facts[d]) } : null; };
  const dated = [c("fmv_cents", "fmv_date"), c("bpo_value_cents", "bpo_date")].filter((x): x is { value_cents: string; as_of: string | null } => x !== null && x.as_of !== null).sort((a, b) => (a.as_of! < b.as_of! ? 1 : a.as_of! > b.as_of! ? -1 : 0));
  return dated[0] ?? c("appraised_value_cents", "appraised_date") ?? c("appraised_value_cents", "origination_date") ?? null;
}
const addressLine = (p: { address_line1: string | null; city: string | null; state: string | null; postal_code: string | null }): string | null => (p.address_line1 ? [p.address_line1, p.city, [p.state, p.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null);

/**
 * Rule 3 — the Yes opens the refinance application from the monitored loan. YES_REQUIRED: the engagement is the borrower's own
 * (the 32.2 offer.respond actor, the lead the party owns, or a resolved OfferCard with yes) — an ops- or agent-driven engagement
 * opens nothing here. ONE_OPEN_APPLICATION_PER_LOAN: an open application on the loan is returned with `created: false` and
 * nothing more is written (two Yes taps → one application). Then Runtime.createApplication{channel=refi_trigger, prior_loan_id,
 * the candidate's transaction type, the property's occupancy, the borrowers from borrowers/parties, the property with the facts'
 * value}, application_borrowers.party_id linked, and 32.11 convert's hand-off (20.3 explainProgram{op=convert}, 20.1
 * emitOfferReady{op=converted}, 21.1 startInterview + captureField{credit_request} + confirmPrefill{op=offer} for the name, the
 * address, the value and the candidate's loan amount) — every figure the candidate's (20.1) or the partner's facts, none
 * computed here — and `partner_book.refinance.opened{loan_id, application_id, party_id, opportunity_id, origination}` with the
 * refi.open decision (rule set partner_book.readiness.v1, model deterministic, prompt 33.3-v1). The cards after
 * `application.received` are the 32.11 / 33.3 flows' (flows/11-rate-watch compressedCards, flows/16-readiness connectorCards).
 */
export async function refiOpen(rt: Runtime, i: RefiOpenInput, deps: FlowDeps): Promise<{ application_id: string; created: boolean }> {
  const db = rt.db; const log = deps.logger ?? rt.logger;
  if (!i.loan_id || !i.opportunity_id || !i.lead_id) throw new RangeError("refi.open needs loan_id, opportunity_id and lead_id");
  const loan = (await db.query<{ id: string; status: string; partner_party_id: string; partner_name: string; property_id: string | null }>(`SELECT l.id::text AS id, l.status::text AS status, l.partner_party_id::text AS partner_party_id, p.legal_name AS partner_name, l.property_id::text AS property_id FROM loans l JOIN parties p ON p.id = l.partner_party_id WHERE l.id = $1`, [i.loan_id]))[0];
  if (!loan) throw new RangeError(`no loan ${i.loan_id}`);
  // ONE_OPEN_APPLICATION_PER_LOAN — before anything else: the open one is returned, nothing more created
  const open = await existingApplication(db, i.lead_id, i.loan_id);
  if (open) { log?.info("partner_book.refi_open.existing", { loan_id: i.loan_id, opportunity_id: i.opportunity_id, lead_id: i.lead_id, application_id: open }); return { application_id: open, created: false }; }
  if (loan.status !== "monitored") throw new RefiOpenRefused("NOT_MONITORED", `loan ${i.loan_id} is ${loan.status}, not monitored — a serviced loan's refinance converts under 32.11 (flows/11-rate-watch convert)`);
  // the loan's scope: the opportunity (20.1), the lead (20.3, created in loan scope by 32.2 offer.respond), the universe row (33.2 rule 1), the roster and the partner (global)
  const store = new EntityStore(); store.seed(await rt.entities.load({ loanId: i.loan_id }));
  const opp = store.get("refi_opportunities", i.opportunity_id)?.data as Row | undefined;
  if (!opp) throw new RefiOpenRefused("NO_OPPORTUNITY", `no refi_opportunities ${i.opportunity_id} on loan ${i.loan_id}`);
  const lead = store.get("leads", i.lead_id)?.data as Row | undefined;
  const borrowers = await loanBorrowers(db, i.loan_id);
  const parties = borrowers.filter((b): b is LoanBorrowerRow & { party_id: string } => !!b.party_id);
  // YES_REQUIRED — the borrower's own Yes: the 32.2 command surface's actor, the lead the party owns, or the resolved OfferCard with yes (32.11 convert's byBorrower)
  const byBorrower = (i.engaged.actor.kind === BORROWER_APP_AGENT.kind && i.engaged.actor.id === BORROWER_APP_AGENT.id)
    || (typeof lead?.["party_id"] === "string" && parties.some((p) => p.party_id === lead["party_id"]))
    || !!(await yesCardFor(db, i.loan_id, i.opportunity_id));
  if (!byBorrower) throw new RefiOpenRefused("YES_REQUIRED", `refi.opportunity.engaged ${i.engaged.id} on loan ${i.loan_id} was not the borrower's own Yes (actor ${i.engaged.actor.kind}:${i.engaged.actor.id}; no resolved OfferCard with yes) — 33.3 guardrail YES_REQUIRED`);
  if (!parties.length) throw new RefiOpenRefused("NO_PARTY", `loan ${i.loan_id} has no borrower with a party (33.1 rule 3) — escalation: ops_analyst`);
  const primary = parties[0]!;
  // the property: the loan's row (33.1), the value the partner's facts (33.2 rule 1's selection on the universe row; the facts themselves as the fallback) — never computed here
  const prop = loan.property_id ? (await db.query<{ address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; postal_code: string | null; county: string | null; property_type: string | null; occupancy: string | null; units: number | null }>(`SELECT address_line1, address_line2, city, state, postal_code, county, property_type, occupancy, units FROM properties WHERE id = $1`, [loan.property_id]))[0] ?? null : null;
  if (!prop?.address_line1) throw new RefiOpenRefused("NO_PROPERTY", `loan ${i.loan_id} has no property row (33.1) — escalation: ops_analyst`);
  const facts = (await latestPartnerFacts(db, [i.loan_id])).get(i.loan_id) ?? null;
  const universe = ((store.get("refi_universe", i.loan_id)?.data as Row | undefined) ?? (await entityRowsById(db, "refi_universe", [i.loan_id])).get(i.loan_id) ?? null) as (Row & { value_estimate?: { value_cents?: unknown; as_of?: unknown } | null; occupancy?: string | null }) | null;
  const candidate = ((opp["candidate_terms"] as Row | null) ?? {}) as Row;
  const factsValue = newestFactsValue(facts?.facts as Record<string, unknown> | undefined);
  const value = s(universe?.value_estimate?.value_cents) ?? factsValue?.value_cents ?? s(candidate["value_cents"]) ?? null;
  const amount = s(candidate["loan_amount_cents"]);
  const transaction_type = ((s(candidate["transaction_type"]) ?? s(opp["transaction_type"]) ?? "limited_cash_out") === "cash_out" ? "cash_out" : "limited_cash_out") as "limited_cash_out" | "cash_out";
  const occupancy = occupancyOf(prop.occupancy, facts?.facts["occupancy"], universe?.occupancy ?? null);
  const state = prop.state ?? s(facts?.facts["property_state"]) ?? null; const tz = timeZoneOf(state); const address = addressLine(prop);
  const created = await rt.createApplication({ id: i.lead_id, partner_party_id: loan.partner_party_id, channel: "refi_trigger", transaction_type, occupancy, intake_channel: "web", interview_language: "en-US", prior_loan_id: i.loan_id,
    borrowers: borrowers.map((b, k) => ({ legal_name: b.legal_name, borrower_role: k === 0 ? "borrower" : "co_borrower", tin_last4: b.tin_last4, date_of_birth: b.date_of_birth, contact: b.contact ?? {} })),
    property: { address_line1: prop.address_line1, address_line2: prop.address_line2 ?? null, city: prop.city ?? "", state: prop.state ?? "", postal_code: prop.postal_code ?? "", county: prop.county, property_type: uladPropertyTypeOf(prop.property_type, facts?.facts["property_type"], facts?.facts["property_type_code"]), units: prop.units, estimated_value_cents: value } } as unknown as Parameters<typeof rt.createApplication>[0], INTAKE_AGENT);
  const appId = created.application.id;
  // application_borrowers.party_id linked by the returned rows (one conversation across the refinance — 01 §6.1); 32.18's routes find the application through it
  for (const [k, row] of created.application.borrowers.entries()) { const party = borrowers[k]?.party_id; if (party) await db.query(`UPDATE application_borrowers SET party_id = $2 WHERE id = $1 AND party_id IS NULL`, [row.id, party]); }
  log?.info("partner_book.refi_open.created", { loan_id: i.loan_id, opportunity_id: i.opportunity_id, application_id: appId, party_id: primary.party_id, transaction_type, occupancy, value_cents: value, loan_amount_cents: amount });
  // 32.11 convert's hand-off, verbatim in order: 20.3's conversion (loan scope: the lead lives there), 20.1's converted, 21.1's interview and the servicing-record prefills
  const exec = async (subject: { loan_id?: string; application_id?: string }, process: string, name: string, input: Row): Promise<Row> => {
    const r = await rt.execute({ process, name, loanId: subject.loan_id ?? "", ...(subject.application_id ? { applicationId: subject.application_id } : {}), actor: INTAKE_AGENT, run: { ...REFI_OPEN_RUN }, input });
    return (r.output ?? {}) as Row;
  };
  const loanSubject = { loan_id: i.loan_id }; const appSubject = { application_id: appId };
  await exec(loanSubject, "20.3", "explainProgram", { op: "convert", lead_id: i.lead_id, transaction_type, occupancy, creditor_time_zone: tz, borrower_name: primary.legal_name });
  await exec(loanSubject, "20.1", "emitOfferReady", { op: "converted", opportunity_id: i.opportunity_id, application_id: appId });
  const roster = store.list("mlo_roster").map((r) => r.data as Row);
  const mlo = mloOfRecord([], new EntityStore(), roster, state);
  if (!mlo) log?.warn("partner_book.refi_open.no_mlo", { loan_id: i.loan_id, application_id: appId, state, reason: "no active roster entry licensed for the state — the interview starts without an MLO of record (21.1 assigns later)" });
  const partner = await partnerFacts(db, store, loan.partner_party_id, false);
  await exec(appSubject, "21.1", "startInterview", { session_id: `flow-33.3:${appId}`, partner_name: partner?.legal_name ?? loan.partner_name, partner_nmlsr_id: partner?.nmlsr_id || null, intake_channel: "web", channel: "web", creditor_time_zone: tz, property_state: state, property_address: address, transaction_type, occupancy,
    borrowers: borrowers.map((b, k) => ({ id: `B${k + 1}`, legal_name: b.legal_name, marital_status: "unmarried" })), ...(mlo ? { mlo_of_record_id: mlo.mlo_of_record_id, mlo_nmlsr_id: mlo.nmlsr_id } : {}), model_version: REFI_OPEN_RUN.modelVersion, prompt_version: REFI_OPEN_RUN.promptVersion });
  // the identity is not on file for a partner-book homeowner (32.3 E5 asks the scan after application.received) — `identity_verified` is left unset, never asserted
  await exec(appSubject, "21.1", "captureField", { field: "credit_request", transaction_type, occupancy, property_state: state, property_address: address });
  // 21.1 rule 1: a prefill counts only at the borrower's item-level confirmation — the name, the address, the partner's value and the candidate's amount are offered, never stated for the borrower
  const offers: [string, string][] = [["name", primary.legal_name], ...(address ? [["property_address", address] as [string, string]] : []), ...(value ? [["property_value_estimate", value] as [string, string]] : []), ...(amount ? [["loan_amount_sought", amount] as [string, string]] : [])];
  for (const [item, v] of offers) await exec(appSubject, "21.1", "confirmPrefill", { op: "offer", item, value: v });
  // the receipt and its decision, on the loan and the application (the id grammar: the refinance carries both)
  const decision_id = randomUUID();
  const decision: DecisionInput = { agent: REFI_READINESS, action: "refi.open", ruleSetVersion: READINESS_RULE_SET_VERSION, loanId: i.loan_id, applicationId: appId, subject: { kind: "application", id: appId }, ruleCode: REFI_OPEN_RULE_CODE, confidence: 1, modelVersion: READINESS_MODEL_VERSION, promptVersion: READINESS_PROMPT_VERSION,
    rationale: `refinance application ${appId} opened from monitored loan ${i.loan_id} on the homeowner's Yes (opportunity ${i.opportunity_id}, lead ${i.lead_id}, engaged by ${i.engaged.actor.kind}:${i.engaged.actor.id}): channel refi_trigger, ${transaction_type}, ${occupancy}, ${borrowers.length} borrower(s) (party ${primary.party_id} linked), the property from the loan's row with the partner's value${value ? ` ${value} cents` : " (none on file)"}${amount ? `, the candidate's loan amount ${amount} cents` : ""}; 20.3 converted, 20.1 converted, 21.1 interview started and the prefills offered. No figure computed here (33.3 rule 3).` };
  await rt.uow.run({ loanId: i.loan_id, applicationId: appId }, async (uctx) => {
    uctx.events.append({ type: "partner_book.refinance.opened", loanId: i.loan_id, applicationId: appId, aggregate: { kind: "application", id: appId }, actor: REFI_READINESS_AGENT,
      payload: { loan_id: i.loan_id, application_id: appId, party_id: primary.party_id, opportunity_id: i.opportunity_id, lead_id: i.lead_id, transaction_type, occupancy, prior_loan_id: i.loan_id, engaged_event_id: i.engaged.id, decision_id, rule_set_version: READINESS_RULE_SET_VERSION, origination: true } });
  }, { clock: rt.clock, commit: async (q) => { await rt.uow.decisions.record(decision, q, decision_id); } });
  return { application_id: appId, created: true };
}
