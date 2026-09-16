/**
 * §33.1 process-owned tools — the `portfolio` agent's `book.import`, `account.provision`, `account.invite` and `book.report`
 * (spec/sections/33-partner-book/33-1-*.md "AI agent design"), defined with `defineTools("33.1", "portfolio", defs)` and spread
 * by ./index.ts. Every tool string is one spec/registry/agents.json names for 33.1.
 *
 * The bus tools and the runtime seam share one code path: the planning (`planPartnerBook`), the provisioning event and
 * decision (`provisionAccount`) and the invitation through the Notice Registry (`sendInvitation`) live here;
 * src/runtime/partner-book.ts `importPartnerBook` runs them in ONE unit of work per import (the baseline rows the events
 * reference — loans, parties, properties, borrowers, terms — are written in the unit of work's `before` hook the way
 * src/runtime/transfers.ts writes them; `runtime.execute` has no such hook, which is why the whole import is not one bus command).
 *
 *   book.import        act   parses the two files under the named profile and answers the plan of writes the import would make —
 *                            rows, exceptions, gaps, per-loan change, parties to create/link, invitations — as the operator's dry run
 *                            (no row is written on the bus; the route / console / seed call importPartnerBook). Decision record
 *                            {rows_total, rows_loaded, rows_exception, gaps, rule_set_version partner_book.m3.v1, deterministic, 33.1-v1, 1}.
 *   account.provision  write rule 3 for one monitored loan already on the platform (a later supplement supplies the contact): the
 *                            party is created or linked by the rule, borrowers.party_id set, `partner_book.account.provisioned` logged.
 *   account.invite     act   rule 4 for one provisioned party: NTC_SM_PARTNER_BOOK_INVITATION rendered through the Notice Registry and
 *                            sent on the e-delivery port; SMS only with a consents{tcpa_sms} id (NO_TCPA_EVIDENCE).
 *   book.report        read  an import's row, report and counts for the console.
 *   book.resolve       act   rule 8 — the operator's resolution of a loan absent from the partner's latest tape (an `ops_analyst` action):
 *                            `paid_off` / `transferred_out` move `loans.status` (from `monitored` only) and log `partner_book.loan.resolved`;
 *                            `keep` logs the event only, which lifts the hold for 7 days (src/runtime/partner-book.ts holdsOf).
 *
 * Guardrails (the paragraph's list): NO_CONSUMER_REPORT, LOAN_MONITORED, NO_INVESTOR_FIELDS_OUTSIDE_FACTS, NO_LINK_ON_UNVERIFIED_EMAIL,
 * NO_TCPA_EVIDENCE, NO_DESTINATION_IN_LOG. Never a destination in a payload, a rationale, a report or a log line — sha256 only.
 */
import { randomUUID } from "node:crypto";
import { defineTools, compute, never, str, flag, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext, AgentRunInfo } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import type { Actor, EventStore, Clock } from "../../kernel/events/index.ts";
import { plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import { NoticeService, type Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import type { EdeliveryPort, EdeliveryMessage, EdeliveryStatus } from "../../infra/integrations/delivery.ts";
import { INVESTOR_FIELDS } from "../../domain/leads-pricing/ops-20-1.ts";
import { M3_V1, type Fact, type RowException } from "../../domain/partner-book/profiles/m3-v1.ts";
import { type ParsedBook, type ParsedRow, type ExistingParty, type PartyResolution, type LoanDerivation, type GapKind, type GapCounts, emptyGaps, contactDestinations, deriveLoanRows, destinationHash, factsEqual, firstNameOf, lastFour, parseBook, profileById, readTabular, resolveParty, rowsWithExceptions } from "../../domain/partner-book/import.ts";
import { SERVICER_CONTACT } from "../../runtime/servicing.ts";

type P = Record<string, unknown>;
const PROCESS_33_1 = "33.1"; const PORTFOLIO = "portfolio";
export const PORTFOLIO_AGENT: Actor = { kind: "agent", id: PORTFOLIO };
/** The decision record's versions (33.1 AI agent design): `rule_set_version: partner_book.m3.v1, model_version: deterministic, prompt_version: 33.1-v1, confidence: 1`. */
export const PARTNER_BOOK_RULE_SET = "partner_book.m3.v1";
export const PARTNER_BOOK_MODEL = "deterministic";
export const PARTNER_BOOK_PROMPT = "33.1-v1";
export const partnerBookRun = (): AgentRunInfo => ({ runId: randomUUID(), modelVersion: PARTNER_BOOK_MODEL, promptVersion: PARTNER_BOOK_PROMPT, confidence: 1 });
export const INVITATION_TEMPLATE = "NTC_SM_PARTNER_BOOK_INVITATION";
/** Rule 8: `book.resolve{resolution ∈ paid_off | transferred_out | keep}`; `keep` lifts the `not_on_latest_tape` hold for 7 days. */
export const RESOLUTIONS: readonly string[] = ["paid_off", "transferred_out", "keep"];
export const KEEP_LIFTS_HOLD_DAYS = 7;
/** The sign-in address the invitation carries: the app base + /app (src/runtime/borrower/routes.ts returnUrlBase). */
export const signInUrl = (): string => `${(process.env["BORROWER_APP_URL"] ?? "https://app.supermortgage.example").replace(/\/+$/, "")}/app`;

const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});

// ───────── guardrails ─────────

/** The tape's investor columns (m3-v1 `investor: true`) and 20.1's INVESTOR_FIELDS: never a selection input, never outside facts/raw (rule 2). */
export const INVESTOR_KEYS: readonly string[] = [...new Set([...M3_V1.columns.filter((c) => c.investor).map((c) => c.key), ...INVESTOR_FIELDS])];
const DESTINATION = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+\d{8,15}\b|\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;
/** A free-text field that would reach a decision rationale or a log line carrying an e-mail or a phone number. */
export const looksLikeDestination = (s: string): boolean => DESTINATION.test(s);
const SERVICING_OPS = new Set(["payment", "post_payment", "statement", "escrow", "escrow_analysis", "delinquency", "late_charge", "autodraft", "collections"]);

const NO_CONSUMER_REPORT = never("NO_CONSUMER_REPORT", "33.1 Verified requirement / FCRA §604(a) (15 U.S.C. §1681b): no consumer report is obtained on import — the tape's FICO is a fact of the partner's file (score_source = partner_file)",
  (i) => flag(i, "order_consumer_report") || flag(i, "pull_credit") || str(i, "score_source") === "consumer_report", "the import never orders a consumer report; the partner's FICO is a pricing input only (20.1 rule 8 keeps it out of selection)");
const LOAN_MONITORED = never("LOAN_MONITORED", "33.1 guardrails: never a payment, statement, escrow or delinquency action on a monitored loan — the partner stays servicer of record",
  (i) => SERVICING_OPS.has(str(i, "op")), "a monitored loan is watched, not serviced: no payment, statement, escrow, autodraft or delinquency action here — the servicer of record performs them");
const NO_INVESTOR_FIELDS_OUTSIDE_FACTS = never("NO_INVESTOR_FIELDS_OUTSIDE_FACTS", "33.1 rule 2 / 20.1 rule 7 (INVESTOR_FIELDS): the tape's investor columns stay in partner_book_facts.facts/raw and never reach the refinance universe",
  (i) => INVESTOR_KEYS.some((k) => k in i && i[k] !== undefined), `investor columns (${INVESTOR_KEYS.join(", ")}) are never an input outside facts/raw`);
const NO_LINK_ON_UNVERIFIED_EMAIL = never("NO_LINK_ON_UNVERIFIED_EMAIL", "33.1 rule 3 / 32.14: a party is never linked on an unverified e-mail alone — normalized e-mail AND name at import, else the verified code merges",
  (i) => typeof i["link_party_id"] === "string" && i["link_party_id"] !== "" && !flag(i, "name_matched") && !flag(i, "email_verified"), "an explicit party link needs the name match (name_matched) or a verified code (email_verified); the tool resolves the party by rule 3 otherwise");
const NO_TCPA_EVIDENCE = never("NO_TCPA_EVIDENCE", "33.1 rule 4 / TCPA 47 U.S.C. §227(b)(1)(A): the SMS variant only with the partner's consent evidence (a consents{kind=tcpa_sms} row)",
  (i) => str(i, "channel") === "sms" && !str(i, "consent_id"), "no text without a consents{kind=tcpa_sms} id for the party or the number");
const NO_DESTINATION_IN_LOG = never("NO_DESTINATION_IN_LOG", "33.1 rule 3 / T4: never a destination in an event payload, a decision rationale, a report or a log line — sha256 hex only",
  (i) => ["rationale", "reason", "note"].some((k) => typeof i[k] === "string" && looksLikeDestination(i[k] as string)), "rationale/reason/note carry an e-mail or a phone number; use destination hashes");

// ───────── the plan (rule 1–4 over what exists) ─────────

export type LoanPlan = {
  readonly row: ParsedRow;
  readonly loan_id: string;
  readonly existing: boolean;
  readonly change: "created" | "updated" | "unchanged";
  readonly derivation: LoanDerivation;
  /** The open loan_terms row's effective_from (an update closes it with effective_to = as_of when as_of is later). */
  readonly prior_terms_from: string | null;
  readonly property_id: string;
  readonly borrower_id: string;
  /** The primary borrower's party: an existing loan's party (no provisioning), else rule 3's resolution ("plan:<row>" ids name parties this import creates earlier). */
  readonly party: { readonly existing_party_id: string | null; readonly resolution: PartyResolution | null; readonly party_id: string; readonly contact_update: { email: string | null; phone: string | null } | null };
  readonly channels: ("email" | "sms")[];
  readonly sms_consent_id: string | null;
  readonly invite: boolean;
  readonly gaps: GapKind[];
};
export type BookPlan = {
  readonly as_of_date: PlainDate;
  readonly partner_party_id: string | null;
  readonly loans: LoanPlan[];
  readonly exceptions: RowException[];
  readonly gaps: GapCounts;
  readonly gaps_by_loan: Record<string, GapKind[]>;
  readonly parties_created: number;
  readonly parties_linked: number;
  readonly invitations: number;
  /** Rule 8: the partner's monitored loans whose latest facts are older than this tape's as-of date and which the tape does not carry — on hold, never closed. */
  readonly not_on_tape: NotOnTape[];
};
export type NotOnTape = { readonly loan_id: string; readonly servicer_loan_number: string; readonly last_as_of_date: string };

/** Every borrower party on the platform with its destinations (rule 3's lookup; the scan mirrors src/infra/db/borrower-parties.ts emailOrPhone). */
export async function existingBorrowerParties(db: Queryable): Promise<ExistingParty[]> {
  const rows = await db.query<{ id: string; legal_name: string; contact: Record<string, unknown> }>(`SELECT id, legal_name, contact FROM parties WHERE party_type = 'borrower' ORDER BY created_at`);
  return rows.map((r) => { const d = contactDestinations(r.contact); return { id: r.id, legal_name: r.legal_name, emails: d.emails, phones: d.phones }; });
}
/** A consents{kind=tcpa_sms, granted, not revoked} row for the party or the number — the only evidence that lets a text go (rule 4). */
export async function tcpaSmsConsent(db: Queryable, partyId: string | null, phone: string | null): Promise<string | null> {
  if (!partyId && !phone) return null;
  const rows = await db.query<{ id: string }>(`SELECT id FROM consents WHERE kind = 'tcpa_sms' AND granted AND revoked_at IS NULL AND status = 'active' AND (($1::uuid IS NOT NULL AND party_id = $1::uuid) OR ($2::text IS NOT NULL AND channel_identifier = $2::text)) ORDER BY captured_at DESC LIMIT 1`, [partyId, phone]);
  return rows[0]?.id ?? null;
}

/** The plan of writes for a parsed book against what the platform holds: per loan created/updated/unchanged, the party resolution, the channels, the invitations. Reads only. */
export async function planPartnerBook(db: Queryable, parsed: ParsedBook, partnerPartyId: string | null, asOf: PlainDate): Promise<BookPlan> {
  const exceptions: RowException[] = [...parsed.exceptions];
  const gaps = emptyGaps(); const gapsByLoan: Record<string, GapKind[]> = {};
  const existingParties = await existingBorrowerParties(db);
  const known = partnerPartyId ? await db.query<{ id: string; servicer_loan_number: string; status: string; last_as_of_date: string | null }>(`SELECT l.id, l.servicer_loan_number, l.status, (SELECT max(f.as_of_date)::text FROM partner_book_facts f WHERE f.loan_id = l.id) AS last_as_of_date FROM loans l WHERE l.partner_party_id = $1`, [partnerPartyId]) : [];
  const knownByNumber = new Map(known.map((l) => [l.servicer_loan_number, l]));
  const loans: LoanPlan[] = [];
  let created = 0, linked = 0, invitations = 0;
  const invitedKeys = new Set<string>();   // "<party>:<channel>" — rule 4: once per provisioned party (a homeowner with two loans on the tape is invited once)
  for (const row of parsed.rows) {
    const derivation = deriveLoanRows(row.facts, asOf);
    const prior = knownByNumber.get(row.servicer_loan_number);
    let change: LoanPlan["change"] = "created"; let priorTermsFrom: string | null = null; let loanId: string = randomUUID(); let propertyId: string = randomUUID(); let borrowerId: string = randomUUID();
    let existingPartyId: string | null = null; let resolution: PartyResolution | null = null; let contactUpdate: LoanPlan["party"]["contact_update"] = null;
    const contact = { email: row.supplement?.email ?? null, phone: row.supplement?.phone ?? null };
    if (prior) {
      loanId = prior.id;
      const latest = (await db.query<{ facts: Record<string, Fact> }>(`SELECT facts FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loanId]))[0];
      change = latest && factsEqual(latest.facts, row.facts) ? "unchanged" : "updated";
      priorTermsFrom = (await db.query<{ effective_from: string }>(`SELECT effective_from::text AS effective_from FROM loan_terms WHERE loan_id = $1 AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`, [loanId]))[0]?.effective_from ?? null;
      propertyId = (await db.query<{ property_id: string }>(`SELECT property_id FROM loans WHERE id = $1`, [loanId]))[0]?.property_id ?? propertyId;
      const b = (await db.query<{ id: string; party_id: string | null }>(`SELECT b.id, b.party_id FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC, b.created_at LIMIT 1`, [loanId]))[0];
      if (b) { borrowerId = b.id; existingPartyId = b.party_id; }
      if (existingPartyId) {
        // rule 4: "invited when a later supplement supplies one" — a party without any destination gains the supplement's (never replacing one it holds)
        const party = existingParties.find((p) => p.id === existingPartyId);
        const addEmail = contact.email && party && party.emails.length === 0 && !existingParties.some((p) => p.id !== party.id && p.emails.includes(contact.email!)) ? contact.email : null;
        const addPhone = contact.phone && party && party.phones.length === 0 ? contact.phone : null;
        if (addEmail || addPhone) contactUpdate = { email: addEmail, phone: addPhone };
      }
    }
    if (!existingPartyId) {
      const tapeName = typeof row.facts["borrower_name"] === "string" && row.facts["borrower_name"].trim() ? row.facts["borrower_name"].trim() : "(unknown)";
      resolution = resolveParty(existingParties, tapeName, contact);
      if (resolution.kind === "create") {
        if (resolution.conflict) exceptions.push({ row: row.row, servicer_loan_number: row.servicer_loan_number, code: "contact_conflict", column: "borrower_email" });
        // the party this import creates joins the lookup so a household e-mail on a second loan resolves against it (rule 3)
        existingParties.push({ id: `plan:${row.row}`, legal_name: tapeName, emails: resolution.email ? [resolution.email] : [], phones: resolution.phone ? [resolution.phone] : [] });
        created++;
      } else linked++;
    }
    const partyId = existingPartyId ?? (resolution!.kind === "link" ? resolution!.party_id : `plan:${row.row}`);
    const effectiveEmail = existingPartyId ? (contactUpdate?.email ?? existingParties.find((p) => p.id === existingPartyId)?.emails[0] ?? null) : resolution!.kind === "link" ? contact.email : resolution!.email;
    const effectivePhone = existingPartyId ? (contactUpdate?.phone ?? existingParties.find((p) => p.id === existingPartyId)?.phones[0] ?? null) : resolution!.kind === "link" ? contact.phone : resolution!.phone;
    const smsConsent = effectivePhone ? await tcpaSmsConsent(db, partyId.startsWith("plan:") ? null : partyId, effectivePhone) : null;
    const channels: ("email" | "sms")[] = [...(effectiveEmail ? ["email" as const] : []), ...(effectivePhone && smsConsent ? ["sms" as const] : [])];
    const rowGaps = new Set<GapKind>(row.gaps);
    if (effectiveEmail || (effectivePhone && smsConsent)) rowGaps.delete("contact"); else rowGaps.add("contact");
    // a newly provisioned party (created or linked) is invited once; an existing party is invited only when this supplement first supplies its contact
    const invite = channels.length > 0 && (!existingPartyId || contactUpdate !== null);
    if (invite) for (const c of channels) { const k = `${partyId}:${c}`; if (!invitedKeys.has(k)) { invitedKeys.add(k); invitations++; } }
    const gapList = [...rowGaps];
    for (const g of gapList) gaps[g]++;
    gapsByLoan[row.servicer_loan_number] = gapList;
    loans.push({ row, loan_id: loanId, existing: !!prior, change, derivation, prior_terms_from: priorTermsFrom, property_id: propertyId, borrower_id: borrowerId, party: { existing_party_id: existingPartyId, resolution, party_id: partyId, contact_update: contactUpdate }, channels, sms_consent_id: smsConsent, invite, gaps: gapList });
  }
  // rule 8: a monitored loan of the partner absent from a LATER full tape (its latest facts predate this as-of date; a same-day supplement or
  // partial tape marks nothing) stays monitored on hold — counted under `not_on_latest_tape`, keyed by servicer loan number, never a row of the file
  const onTape = new Set(loans.map((l) => l.row.servicer_loan_number));
  const notOnTape: NotOnTape[] = known.filter((l) => l.status === "monitored" && !onTape.has(l.servicer_loan_number) && l.last_as_of_date !== null && l.last_as_of_date < asOf)
    .map((l) => ({ loan_id: l.id, servicer_loan_number: l.servicer_loan_number, last_as_of_date: l.last_as_of_date! })).sort((a, b) => a.servicer_loan_number.localeCompare(b.servicer_loan_number));
  for (const n of notOnTape) { gaps.not_on_latest_tape++; gapsByLoan[n.servicer_loan_number] = [...(gapsByLoan[n.servicer_loan_number] ?? []), "not_on_latest_tape"]; }
  return { as_of_date: asOf, partner_party_id: partnerPartyId, loans, exceptions, gaps, gaps_by_loan: gapsByLoan, parties_created: created, parties_linked: linked, invitations, not_on_tape: notOnTape };
}

// ───────── provisioning (rule 3) and the invitation (rule 4) — shared by the seam and the bus ─────────

export interface DecisionSink { decide(d: { agent: string; action: string; rationale: string; ruleSetVersion: string; loanId?: string; subject?: { kind: string; id: string }; confidence?: number | null; modelVersion?: string | null; promptVersion?: string | null; ruleCode?: string }): void }
export interface ProvisionInput { readonly party_id: string; readonly loan_id: string; readonly borrower_id: string; readonly servicer_loan_number: string; readonly channels: readonly ("email" | "sms")[]; readonly linked_existing_party: boolean; readonly gaps: readonly GapKind[]; readonly email: string | null; readonly phone: string | null }

/** `partner_book.account.provisioned{party_id, loan_id, borrower_id, channels, linked_existing_party, gaps, origination}` and the per-party decision (hashes only). */
export function provisionAccount(events: EventStore, decisions: DecisionSink, actor: Actor, p: ProvisionInput): void {
  const hashes = { ...(p.email ? { email_hash: destinationHash(p.email) } : {}), ...(p.phone ? { phone_hash: destinationHash(p.phone) } : {}) };
  events.append({ type: "partner_book.account.provisioned", loanId: p.loan_id, aggregate: { kind: "party", id: p.party_id }, actor,
    payload: { party_id: p.party_id, loan_id: p.loan_id, borrower_id: p.borrower_id, channels: [...p.channels], linked_existing_party: p.linked_existing_party, ...(p.gaps.length ? { gaps: [...p.gaps] } : {}), ...hashes, origination: true } });
  decisions.decide({ agent: PORTFOLIO, action: "account.provision", ruleSetVersion: PARTNER_BOOK_RULE_SET, modelVersion: PARTNER_BOOK_MODEL, promptVersion: PARTNER_BOOK_PROMPT, confidence: 1, loanId: p.loan_id, subject: { kind: "party", id: p.party_id },
    rationale: `${p.linked_existing_party ? "linked existing party (normalized e-mail and name match, rule 3)" : "created party from the tape's name and the supplement's contact (rule 3)"} for loan ending ${lastFour(p.servicer_loan_number)}; channels: ${p.channels.length ? p.channels.join(",") : "none"}${p.gaps.length ? `; gaps: ${p.gaps.join(",")}` : ""}${hashes.email_hash ? `; email sha256:${hashes.email_hash.slice(0, 12)}` : ""}${hashes.phone_hash ? `; phone sha256:${hashes.phone_hash.slice(0, 12)}` : ""}` });
}

export type InvitationSubject = { readonly messageId: string; readonly subject: string };
/**
 * The e-delivery port as the invitation sees it: the Notice Registry's `send` names the message `<notice>:<attempt>` with the
 * template's name as subject; for an invitation the message id is the idempotency key `partner_book:<import>:<party>:<channel>`
 * (33.1 Integrations) and the subject names the partner and the loan's last four (T6: the FAKE port holds one message per party
 * naming both). Everything else — bounce handling, the events, the deliveries — stays the NoticeService's.
 */
export function invitationEdelivery(real: EdeliveryPort, overrides: Map<string, InvitationSubject>): EdeliveryPort {
  return {
    send(m: EdeliveryMessage, now: string): Promise<EdeliveryStatus & { duplicate: boolean }> { const o = overrides.get(m.noticeId); return real.send(o ? { ...m, messageId: o.messageId, subject: o.subject } : m, now); },
    events(since: string) { return real.events(since); },
  };
}

export interface InvitationDeps { readonly notices: NoticeService; readonly edelivery: EdeliveryPort; readonly events: EventStore; readonly clock: Clock; readonly actor: Actor; readonly overrides?: Map<string, InvitationSubject> }
export interface InvitationInput { readonly import_id: string; readonly party_id: string; readonly loan_id: string; readonly kind: "invitation" | "reminder"; readonly channel: "email" | "sms"; readonly destination: string; readonly display_name: string; readonly partner_legal_name: string; readonly servicer_loan_number: string; readonly consent_id?: string | null }
export interface InvitationResult { readonly notice_id: string; readonly message_id: string; readonly sent_at: string; readonly bounced: boolean; readonly destination_hash: string; readonly held_reason: string | null }

export const invitationSubject = (partnerLegalName: string, servicerLoanNumber: string): string => `${partnerLegalName}: your account for the loan ending ${lastFour(servicerLoanNumber)}`;
export const invitationMessageId = (importId: string, partyId: string, channel: "email" | "sms", kind: "invitation" | "reminder"): string => `partner_book:${importId}:${partyId}:${channel}${kind === "reminder" ? ":reminder" : ""}`;

/** Rule 4: NTC_SM_PARTNER_BOOK_INVITATION rendered through the registry (checklist, notice.rendered), delivered on the e-delivery port, `partner_book.invitation.sent` logged (the timer's trigger; the reminder's `kind` does not re-arm). */
export async function sendInvitation(deps: InvitationDeps, inv: InvitationInput): Promise<InvitationResult> {
  const now = deps.clock.now();
  const last4 = lastFour(inv.servicer_loan_number);
  const messageId = invitationMessageId(inv.import_id, inv.party_id, inv.channel, inv.kind);
  const hash = destinationHash(inv.destination);
  const payload: P = { partner_legal_name: inv.partner_legal_name, loan_last4: last4, first_name: firstNameOf(inv.display_name), sign_in_url: signInUrl(), platform_postal_address: SERVICER_CONTACT.servicer_address, channel: inv.channel, sms: inv.channel === "sms", kind: inv.kind };
  const recipient: Recipient = { partyId: inv.party_id, name: inv.display_name, mailingAddress: null, ...(inv.channel === "email" ? { email: inv.destination } : {}) };
  const n: Notice = deps.notices.render({ templateCode: INVITATION_TEMPLATE, loanId: inv.loan_id, recipients: [recipient], payload, asOf: plainDate(now.slice(0, 10)) });
  if (n.status === "held") return { notice_id: n.id, message_id: messageId, sent_at: now, bounced: false, destination_hash: hash, held_reason: n.heldReason ?? "held" };
  deps.overrides?.set(n.id, { messageId, subject: invitationSubject(inv.partner_legal_name, inv.servicer_loan_number) });
  let bounced = false; let sentAt = now;
  if (inv.channel === "email") {
    // decideChannel: electronic_ok_without_esign + an e-mail → email_link (consentId policy:electronic_ok_without_esign); a hard bounce falls back to mail, which a party without a mailing address cannot take — recorded as a bounce, never as a failure of the import
    try { const sent = await deps.notices.send(n.id); sentAt = sent.sentAt ?? now; bounced = sent.deliveries.some((d) => d.emailStatus === "bounced"); }
    catch (e) { if (n.deliveries.some((d) => d.emailStatus === "bounced")) bounced = true; else throw e; }
  } else {
    // the SMS variant: rendered by the registry (the checklist's STOP line), delivered on the port under the consent evidence id — never a marketing consent, never without one (NO_TCPA_EVIDENCE)
    if (!inv.consent_id) throw new RangeError("an SMS invitation needs the consents{kind=tcpa_sms} id (33.1 rule 4)");
    const res = await deps.edelivery.send({ messageId, noticeId: n.id, channel: "sms", to: inv.destination, subject: invitationSubject(inv.partner_legal_name, inv.servicer_loan_number), consentId: inv.consent_id }, now);
    bounced = res.status === "bounced";
    n.deliveries.push({ attemptNo: n.deliveries.length + 1, partyId: inv.party_id, channel: "sms_link", vendor: "e-delivery", vendorPieceId: res.messageId, submittedAt: now, emailStatus: bounced ? "bounced" : "sent", satisfiesTimer: true });
    n.status = "sent"; n.sentAt = now;
    deps.events.append({ type: "notice.sent", loanId: inv.loan_id, aggregate: { kind: "notice", id: n.id }, actor: { kind: "agent", id: "disclosures" }, payload: { notice_id: n.id, template: n.templateCode, channels: [{ party_id: inv.party_id, channel: "sms_link", satisfies_timer: true }], sent_at: now, consent_id: inv.consent_id } });
  }
  deps.events.append({ type: "partner_book.invitation.sent", loanId: inv.loan_id, aggregate: { kind: "notice", id: n.id }, actor: deps.actor,
    payload: { party_id: inv.party_id, loan_id: inv.loan_id, channel: inv.channel, notice_id: n.id, message_id: messageId, sent_at: sentAt, kind: inv.kind, destination_hash: hash, ...(bounced ? { bounced: true } : {}), origination: true } });
  return { notice_id: n.id, message_id: messageId, sent_at: sentAt, bounced, destination_hash: hash, held_reason: null };
}

/** The invitation's own decision row (`account.invite`), hashes only. */
export function inviteDecision(decisions: DecisionSink, inv: InvitationInput, r: InvitationResult): void {
  decisions.decide({ agent: PORTFOLIO, action: "account.invite", ruleSetVersion: PARTNER_BOOK_RULE_SET, modelVersion: PARTNER_BOOK_MODEL, promptVersion: PARTNER_BOOK_PROMPT, confidence: 1, loanId: inv.loan_id, subject: { kind: "notice", id: r.notice_id },
    rationale: `${inv.kind} by ${inv.channel} to party ${inv.party_id} for the loan ending ${lastFour(inv.servicer_loan_number)} (destination sha256:${r.destination_hash.slice(0, 12)}); ${r.held_reason ? `held: ${r.held_reason}` : r.bounced ? "bounced" : "sent"}${inv.consent_id ? `; tcpa_sms consent ${inv.consent_id}` : ""}` });
}

// ───────── the tools ─────────

const fileOf = (v: unknown, what: string): { filename: string; content: Uint8Array } => {
  const f = obj(v);
  const filename = typeof f["filename"] === "string" && f["filename"] ? f["filename"] : `${what}.csv`;
  if (typeof f["content_base64"] === "string") return { filename, content: new Uint8Array(Buffer.from(f["content_base64"], "base64")) };
  if (typeof f["content"] === "string") return { filename, content: new Uint8Array(Buffer.from(f["content"], "utf8")) };
  if (f["content"] instanceof Uint8Array) return { filename, content: f["content"] };
  throw new RangeError(`${what} needs { filename, content_base64 } (or content)`);
};

async function partnerPartyByName(db: Queryable, legalName: string): Promise<string | null> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM parties WHERE party_type = 'servicer' AND lower(legal_name) = lower($1) ORDER BY created_at LIMIT 1`, [legalName]);
  return rows[0]?.id ?? null;
}

export const TOOLS_33_1: readonly ToolDef[] = defineTools(PROCESS_33_1, PORTFOLIO, [
  { name: "book.import", kind: "act", ruleSetVersion: PARTNER_BOOK_RULE_SET, guardrails: [NO_CONSUMER_REPORT, NO_INVESTOR_FIELDS_OUTSIDE_FACTS, NO_DESTINATION_IN_LOG, LOAN_MONITORED],
    handler: compute(async (i, _ctx: CommandContext, rt) => {
      need(i, "partner", "as_of_date"); const partner = obj(i["partner"]); if (typeof partner["legal_name"] !== "string" || !partner["legal_name"]) throw new RangeError("partner.legal_name is required");
      const profile = profileById(str(i, "profile") || "m3-v1"); const asOf = plainDate(str(i, "as_of_date"));
      const tape = fileOf(i["tape"], "tape"); const supplement = i["supplement"] ? fileOf(i["supplement"], "supplement") : null;
      const parsed = parseBook(profile, readTabular(tape.filename, tape.content), supplement ? readTabular(supplement.filename, supplement.content) : null);
      if (parsed.rejected) return { status: "rejected", profile: profile.id, rows_total: parsed.rows_total, rows_loaded: 0, rows_exception: 0, missing_headers: parsed.rejected.missing_headers, expected_headers: profile.required };
      const db = dbOf(rt);
      const plan = await planPartnerBook(db, parsed, await partnerPartyByName(db, partner["legal_name"]), asOf);
      return { status: "plan", profile: profile.id, as_of_date: asOf, partner_party_id: plan.partner_party_id, rows_total: parsed.rows_total, rows_loaded: plan.loans.length, rows_exception: rowsWithExceptions(plan.exceptions), exceptions: plan.exceptions, gaps: plan.gaps,
        loans_created: plan.loans.filter((l) => l.change === "created").length, loans_updated: plan.loans.filter((l) => l.change === "updated").length, loans_unchanged: plan.loans.filter((l) => l.change === "unchanged").length, parties_created: plan.parties_created, parties_linked: plan.parties_linked, invitations: plan.invitations, not_on_tape: plan.not_on_tape,
        loans: plan.loans.map((l) => ({ servicer_loan_number: l.row.servicer_loan_number, change: l.change, party: l.party.existing_party_id ? "existing" : l.party.resolution?.kind === "link" ? "link" : "create", channels: l.channels, invite: l.invite, gaps: l.gaps })) };
    }),
    decision: (i, output) => { const o = obj(output); return { action: "book.import", subject: { kind: "partner_book_import_plan", id: `${str(obj(i["partner"]) as ToolInput, "legal_name")}@${str(i, "as_of_date")}` },
      rationale: `profile ${str(i, "profile") || "m3-v1"}: ${String(o["status"])}; rows_total ${String(o["rows_total"])}, rows_loaded ${String(o["rows_loaded"])}, rows_exception ${String(o["rows_exception"])}; gaps ${toJson(o["gaps"] ?? {})}; rule_set_version ${PARTNER_BOOK_RULE_SET}` }; } },

  { name: "account.provision", kind: "write", ruleSetVersion: PARTNER_BOOK_RULE_SET, guardrails: [NO_LINK_ON_UNVERIFIED_EMAIL, NO_DESTINATION_IN_LOG, LOAN_MONITORED, NO_CONSUMER_REPORT],
    handler: compute(async (i, ctx, rt) => {
      need(i, "loan_id"); const db = dbOf(rt); const loanId = str(i, "loan_id");
      const loan = (await db.query<{ id: string; servicer_loan_number: string; status: string }>(`SELECT id, servicer_loan_number, status FROM loans WHERE id = $1`, [loanId]))[0];
      if (!loan) throw new RangeError(`no loan ${loanId}`); if (loan.status !== "monitored") throw new RangeError(`loan ${loanId} is ${loan.status}, not monitored (33.1 provisions the partner book only)`);
      const b = (await db.query<{ id: string; legal_name: string; party_id: string | null }>(`SELECT b.id, b.legal_name, b.party_id FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC, b.created_at LIMIT 1`, [loanId]))[0];
      if (!b) throw new RangeError(`loan ${loanId} has no borrower row`);
      if (b.party_id) return { party_id: b.party_id, borrower_id: b.id, linked_existing_party: false, provisioned: false, reason: "the borrower already has a party" };
      const c = obj(i["contact"]); const contact = { email: typeof c["email"] === "string" ? (c["email"] as string).trim().toLowerCase() || null : null, phone: typeof c["phone"] === "string" ? (c["phone"] as string) || null : null };
      const legalName = str(i, "legal_name") || b.legal_name;
      const resolution = resolveParty(await existingBorrowerParties(db), legalName, contact);
      const partyId = resolution.kind === "link" ? resolution.party_id : randomUUID();
      const email = resolution.kind === "link" ? contact.email : resolution.email; const phone = resolution.kind === "link" ? contact.phone : resolution.phone;
      const smsConsent = phone ? await tcpaSmsConsent(db, resolution.kind === "link" ? partyId : null, phone) : null;
      const channels: ("email" | "sms")[] = [...(email ? ["email" as const] : []), ...(phone && smsConsent ? ["sms" as const] : [])];
      const gaps: GapKind[] = channels.length ? [] : ["contact"];
      const defer = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!defer) throw new PortUnavailable("service:deferWrite");
      defer(async (q) => {
        // 35.12 rule 6: the provisioned party carries its partner's marker (a fixture book's partner is synthetic; a real partner never marks)
        if (resolution.kind === "create") await q.query(`INSERT INTO parties (id, party_type, legal_name, contact, synthetic) VALUES ($1, 'borrower', $2, $3::jsonb, coalesce((SELECT p.synthetic FROM loans l JOIN parties p ON p.id = l.partner_party_id WHERE l.id = $4), false))`, [partyId, legalName, toJson({ ...(email ? { email } : {}), ...(phone ? { phone } : {}) }), loanId]);
        else if (resolution.add_phone) await q.query(`UPDATE parties SET contact = contact || $2::jsonb WHERE id = $1`, [partyId, toJson({ phone: resolution.add_phone })]);
        await q.query(`UPDATE borrowers SET party_id = $2 WHERE id = $1 AND party_id IS NULL`, [b.id, partyId]);
      });
      provisionAccount(ctx.events, ctx, ctx.actor, { party_id: partyId, loan_id: loanId, borrower_id: b.id, servicer_loan_number: loan.servicer_loan_number, channels, linked_existing_party: resolution.kind === "link", gaps, email, phone });
      return { party_id: partyId, borrower_id: b.id, linked_existing_party: resolution.kind === "link", provisioned: true, channels, gaps, contact_conflict: resolution.kind === "create" && resolution.conflict, ...(smsConsent ? { sms_consent_id: smsConsent } : {}) };
    }),
    decision: () => null },   // provisionAccount records the party's decision itself (one per provisioned party — 33.1 AI agent design)

  { name: "account.invite", kind: "act", ruleSetVersion: PARTNER_BOOK_RULE_SET, guardrails: [NO_TCPA_EVIDENCE, NO_DESTINATION_IN_LOG, LOAN_MONITORED],
    handler: compute(async (i, ctx, rt) => {
      need(i, "loan_id", "party_id"); const db = dbOf(rt); const svc = rt.notices; if (!svc) throw new PortUnavailable("notices"); const edelivery = rt.ports.edelivery; if (!edelivery) throw new PortUnavailable("edelivery");
      const loanId = str(i, "loan_id"); const partyId = str(i, "party_id"); const channel = (str(i, "channel") || "email") as "email" | "sms"; const kind = (str(i, "kind") || "invitation") as "invitation" | "reminder";
      const loan = (await db.query<{ servicer_loan_number: string; status: string; partner_legal_name: string }>(`SELECT l.servicer_loan_number, l.status, p.legal_name AS partner_legal_name FROM loans l JOIN parties p ON p.id = l.partner_party_id WHERE l.id = $1`, [loanId]))[0];
      if (!loan) throw new RangeError(`no loan ${loanId}`);
      const party = (await db.query<{ legal_name: string; contact: Record<string, unknown> }>(`SELECT legal_name, contact FROM parties WHERE id = $1 AND party_type = 'borrower'`, [partyId]))[0];
      if (!party) throw new RangeError(`no borrower party ${partyId}`);
      const d = contactDestinations(party.contact); const destination = channel === "email" ? d.emails[0] ?? null : d.phones[0] ?? null;
      if (!destination) return { sent: false, reason: `no ${channel} on the party's contact (gaps: contact)` };
      const consentId = channel === "sms" ? (await tcpaSmsConsent(db, partyId, destination)) : null;
      if (channel === "sms" && (!consentId || consentId !== str(i, "consent_id"))) throw new RangeError("the consent_id is not an active consents{kind=tcpa_sms} row for the party or the number (33.1 rule 4)");
      const importId = str(i, "import_id") || (await db.query<{ import_id: string }>(`SELECT import_id FROM partner_book_facts WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1`, [loanId]))[0]?.import_id;
      if (!importId) throw new RangeError("import_id is required (the loan has no partner_book_facts row)");
      const inv: InvitationInput = { import_id: importId, party_id: partyId, loan_id: loanId, kind, channel, destination, display_name: party.legal_name, partner_legal_name: loan.partner_legal_name, servicer_loan_number: loan.servicer_loan_number, consent_id: consentId };
      const r = await sendInvitation({ notices: svc, edelivery, events: ctx.events, clock: ctx.clock, actor: ctx.actor }, inv);
      const defer = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!defer) throw new PortUnavailable("service:deferWrite");
      if (!r.held_reason) defer(async (q) => { await q.query(`INSERT INTO partner_book_invitations (id, import_id, party_id, loan_id, channel, destination_hash, notice_id, message_id, sent_at, kind, bounced_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [randomUUID(), importId, partyId, loanId, channel, r.destination_hash, r.notice_id, r.message_id, r.sent_at, kind, r.bounced ? r.sent_at : null]); });
      return { sent: !r.held_reason, notice_id: r.notice_id, message_id: r.message_id, channel, kind, sent_at: r.sent_at, bounced: r.bounced, destination_hash: r.destination_hash, held_reason: r.held_reason };
    }),
    decision: (i, output, ctx) => { const o = obj(output); return { action: "account.invite", subject: { kind: "party", id: str(i, "party_id") }, rationale: `${str(i, "kind") || "invitation"} by ${str(i, "channel") || "email"} to party ${str(i, "party_id")} on loan ${str(i, "loan_id")}: ${o["sent"] ? "sent" : `not sent (${String(o["reason"] ?? o["held_reason"] ?? "held")})`} by ${ctx.actor.kind}:${ctx.actor.id}` }; } },

  // rule 8: "an operator resolves it with `book.resolve{loan_id, resolution ∈ paid_off | transferred_out | keep, reason}` (an `ops_analyst` action; `paid_off`/`transferred_out`
  // move `loans.status` and log `partner_book.loan.resolved`; `keep` lifts the hold for 7 days)" — a human act of the ops_analyst, never an agent's; the loan is the command's scope
  { name: "book.resolve", kind: "act", ruleSetVersion: PARTNER_BOOK_RULE_SET, humanOnly: true, humanRoles: ["ops_analyst"], guardrails: [NO_DESTINATION_IN_LOG, LOAN_MONITORED, NO_CONSUMER_REPORT],
    handler: compute(async (i, ctx, rt) => {
      need(i, "loan_id", "resolution", "reason"); const db = dbOf(rt); const loanId = str(i, "loan_id"); const resolution = str(i, "resolution"); const reason = str(i, "reason");
      if (!RESOLUTIONS.includes(resolution)) throw new RangeError(`resolution is one of ${RESOLUTIONS.join(" | ")} (33.1 rule 8)`);
      if (ctx.loanId && ctx.loanId !== loanId) throw new RangeError(`loan_id ${loanId} is not the command's loan ${ctx.loanId}`);
      const loan = (await db.query<{ id: string; servicer_loan_number: string; status: string; partner_party_id: string | null; last_as_of_date: string | null; partner_as_of_date: string | null }>(
        `SELECT l.id, l.servicer_loan_number, l.status, l.partner_party_id::text AS partner_party_id, (SELECT max(f.as_of_date)::text FROM partner_book_facts f WHERE f.loan_id = l.id) AS last_as_of_date,
                (SELECT max(i.as_of_date)::text FROM partner_book_imports i WHERE i.partner_party_id = l.partner_party_id AND i.status = 'loaded') AS partner_as_of_date
           FROM loans l WHERE l.id = $1`, [loanId]))[0];
      if (!loan) throw new RangeError(`no loan ${loanId}`);
      if (!loan.partner_party_id || loan.last_as_of_date === null) throw new RangeError(`loan ${loanId} is not on a partner book (no partner_book_facts row)`);
      if (loan.status !== "monitored") throw new RangeError(`loan ${loanId} is ${loan.status}, not monitored — nothing to resolve (33.1 rule 8)`);
      const onHold = loan.partner_as_of_date !== null && loan.last_as_of_date < loan.partner_as_of_date;
      if (resolution !== "keep") {
        // the status moves in the command's transaction, from `monitored` only (the state machine's transition; a refinance that funded first wins)
        const defer = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!defer) throw new PortUnavailable("service:deferWrite");
        defer(async (q) => { await q.query(`UPDATE loans SET status = $2 WHERE id = $1 AND status = 'monitored'`, [loanId, resolution]); });
      }
      ctx.events.append({ type: "partner_book.loan.resolved", loanId, aggregate: { kind: "loan", id: loanId }, actor: ctx.actor,
        payload: { loan_id: loanId, servicer_loan_number: loan.servicer_loan_number, partner_id: loan.partner_party_id, resolution, reason, last_as_of_date: loan.last_as_of_date, partner_as_of_date: loan.partner_as_of_date, was_on_hold: onHold, ...(resolution === "keep" ? { hold_lifted_days: KEEP_LIFTS_HOLD_DAYS } : { status: resolution }), origination: true } });
      return { loan_id: loanId, servicer_loan_number: loan.servicer_loan_number, resolution, status: resolution === "keep" ? "monitored" : resolution, was_on_hold: onHold, last_as_of_date: loan.last_as_of_date, partner_as_of_date: loan.partner_as_of_date, ...(resolution === "keep" ? { hold_lifted_days: KEEP_LIFTS_HOLD_DAYS } : {}) };
    }),
    decision: (i, output, ctx) => { const o = obj(output); return { action: "book.resolve", subject: { kind: "loan", id: str(i, "loan_id") },
      rationale: `${str(i, "resolution")} for the loan ending ${lastFour(String(o["servicer_loan_number"] ?? str(i, "loan_id")))} by ${ctx.actor.kind}:${ctx.actor.id}${ctx.actor.role ? ` (${ctx.actor.role})` : ""}: ${str(i, "reason")}; ${o["was_on_hold"] ? "the loan was on hold (not_on_latest_tape)" : "the loan was not on hold"}${str(i, "resolution") === "keep" ? `; the hold is lifted for ${KEEP_LIFTS_HOLD_DAYS} days` : `; loans.status → ${str(i, "resolution")}`}` }; } },

  { name: "book.report", kind: "read", handler: compute(async (i, _ctx, rt) => {
      const db = dbOf(rt);
      if (str(i, "import_id")) {
        const row = (await db.query<P>(`SELECT id::text AS import_id, partner_party_id::text AS partner_party_id, as_of_date::text AS as_of_date, profile, status, tape_sha256, supplement_sha256, rows_total, rows_loaded, rows_exception, loans_created, loans_updated, parties_created, parties_linked, invitations_sent, report, actor_id, created_at::text AS created_at FROM partner_book_imports WHERE id = $1`, [str(i, "import_id")]))[0];
        return row ?? null;
      }
      const partner = str(i, "partner_party_id") || null;
      const rows = await db.query<P>(`SELECT id::text AS import_id, partner_party_id::text AS partner_party_id, as_of_date::text AS as_of_date, profile, status, rows_total, rows_loaded, rows_exception, loans_created, loans_updated, parties_created, parties_linked, invitations_sent, created_at::text AS created_at FROM partner_book_imports WHERE ($1::uuid IS NULL OR partner_party_id = $1::uuid) ORDER BY created_at DESC LIMIT 200`, [partner]);
      const counts = (await db.query<{ monitored: string; parties: string; invited: string; activated: string }>(`SELECT (SELECT count(*) FROM loans WHERE status = 'monitored' AND ($1::uuid IS NULL OR partner_party_id = $1::uuid))::text AS monitored,
        (SELECT count(DISTINCT b.party_id) FROM loans l JOIN loan_borrowers lb ON lb.loan_id = l.id JOIN borrowers b ON b.id = lb.borrower_id WHERE l.status = 'monitored' AND b.party_id IS NOT NULL AND ($1::uuid IS NULL OR l.partner_party_id = $1::uuid))::text AS parties,
        (SELECT count(DISTINCT party_id) FROM partner_book_invitations i JOIN loans l ON l.id = i.loan_id WHERE i.kind = 'invitation' AND ($1::uuid IS NULL OR l.partner_party_id = $1::uuid))::text AS invited,
        (SELECT count(*) FROM loan_events e JOIN loans l ON l.id = e.loan_id WHERE e.type = 'partner_book.account.activated' AND ($1::uuid IS NULL OR l.partner_party_id = $1::uuid))::text AS activated`, [partner]))[0]!;
      return { imports: rows, book: { monitored_loans: Number(counts.monitored), parties: Number(counts.parties), invited: Number(counts.invited), activated: Number(counts.activated) } };
    }) },
]);
