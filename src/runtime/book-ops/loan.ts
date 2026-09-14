/**
 * §34.3 rule 4 — "A loan's page." Facts by as-of date (every mapped column; the raw columns beside them for the page to
 * collapse), terms history, the party and invitations (hashes and dates only — NO_DESTINATION), reviews by day (verdict,
 * reasons in words, the analyst's rationale and flags, the engine's facts), readiness by day (items with status, source and
 * validity), offers (status, delivered how, expires), the resolutions and the clocks on the loan.
 *
 * Every row is section 33's or 20.1's as stored: partner_book_facts, loan_terms, partner_book_invitations, partner_book_reviews
 * (`reasonsInWords` is 33.2's own wording of its reason codes), readiness_checks (33.3's readinessHistory), the refi_opportunities
 * entity and 20.2's marketing_touches, loan_events, timers. Rule 7: nothing computed.
 */
import { decodeEntityData } from "../../infra/db/entities.ts";
import { VERDICT_WORDS, reasonsInWords, type ReviewVerdict } from "../partner-book-review.ts";
import { readinessHistory, type ReadinessRow } from "../partner-book-readiness.ts";
import type { Runtime } from "../app.ts";
import { type Homeowner, type Hold, type Row, holdOf, homeownersOf, isUuid, scrubDestinations, str } from "./common.ts";

export type LoanFactsRow = { id: string; import_id: string; as_of_date: string; created_at: string; facts: Row; raw: Row; raw_columns: number };
export type LoanTermsRow = { id: string; effective_from: string; effective_to: string | null; source: string; amortization: string; note_rate_bps: number; pi_cents: string; escrow_payment_cents: string; escrowed: boolean; remittance_type: string; maturity_date: string; remaining_term_months: number | null; deferred_principal_cents: string; arm_index: string | null; arm_margin_bps: number | null };
export type LoanInvitation = { id: string; import_id: string; party_id: string; kind: string; channel: string; destination_hash: string; notice_id: string | null; sent_at: string; bounced_at: string | null };
export type LoanReview = { id: string; as_of_date: string; run_id: string; verdict: ReviewVerdict; verdict_words: string; reasons: string[]; reasons_in_words: string[]; opportunity_id: string | null; decision_id: string | null; facts: Row; analyst: { skipped: string | null; rationale: string | null; explanation_text: string | null; flags: string[]; model_version: string | null; prompt_version: string | null; turn_id: string | null; confidence: number | null }; created_at: string };
export type LoanOffer = { opportunity_id: string; as_of_date: string | null; status: string | null; offer_valid_until: string | null; campaign_id: string | null; program_id: string | null; detected_at: string | null; delivered: { touch_id: string; channel: string | null; outcome: string | null; sent_at: string | null }[]; expired: boolean };
export type LoanResolution = { at: string; resolution: string | null; reason: string | null; actor: string; was_on_hold: boolean | null; status: string | null };
export type LoanClock = { timer_id: string; code: string; status: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null; cancelled_reason: string | null };
export type BookLoan = {
  loan: { loan_id: string; servicer_loan_number: string; status: string; partner_party_id: string; partner_legal_name: string; lien: string | null; origination_date: string | null; first_payment_date: string | null; maturity_date: string | null; original_upb_cents: string | null; original_term_months: number | null; property: { address_line1: string | null; city: string | null; state: string | null; postal_code: string | null; county: string | null; occupancy: string | null; property_type: string | null } | null };
  homeowner: Homeowner; on_hold: boolean; hold: Hold | null; facts_by_as_of: LoanFactsRow[]; terms: LoanTermsRow[]; invitations: LoanInvitation[]; reviews: LoanReview[]; readiness: ReadinessRow[]; offers: LoanOffer[]; resolutions: LoanResolution[]; not_on_tape: { at: string; as_of_date: string | null; last_as_of_date: string | null; import_id: string | null }[]; clocks: LoanClock[];
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const iso = (v: unknown): string | null => (typeof v === "string" ? v : v instanceof Date ? v.toISOString() : null);

/** GET …/loans/{id}. */
export async function bookLoan(rt: Runtime, loanId: string, now: string = rt.clock.now()): Promise<BookLoan | null> {
  if (!isUuid(loanId)) return null;
  const db = rt.db;
  const loan = (await db.query<{ loan_id: string; servicer_loan_number: string; status: string; partner_party_id: string | null; partner_legal_name: string | null; lien: string | null; origination_date: string | null; first_payment_date: string | null; maturity_date: string | null; original_upb_cents: string | null; original_term_months: number | null; address_line1: string | null; city: string | null; state: string | null; postal_code: string | null; county: string | null; occupancy: string | null; property_type: string | null; has_property: boolean }>(
    `SELECT l.id::text AS loan_id, l.servicer_loan_number, l.status::text AS status, l.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_legal_name, l.lien::text AS lien, l.origination_date::text AS origination_date, l.first_payment_date::text AS first_payment_date, l.maturity_date::text AS maturity_date, l.original_upb_cents::text AS original_upb_cents, l.original_term_months,
            p.address_line1, p.city, p.state, p.postal_code, p.county, p.occupancy::text AS occupancy, p.property_type::text AS property_type, (p.id IS NOT NULL) AS has_property
       FROM loans l LEFT JOIN parties pp ON pp.id = l.partner_party_id LEFT JOIN properties p ON p.id = l.property_id WHERE l.id = $1 AND l.partner_party_id IS NOT NULL AND EXISTS (SELECT 1 FROM partner_book_facts f WHERE f.loan_id = l.id)`, [loanId]))[0];
  if (!loan || !loan.partner_party_id) return null;
  const [owners, hold, facts, terms, invitations, reviews, readiness, opps, resolved, notOnTape, timers] = await Promise.all([
    homeownersOf(db, [loanId]), holdOf(rt, loanId, now),
    db.query<{ id: string; import_id: string; as_of_date: string; created_at: string; facts: Row; raw: Row }>(`SELECT id::text AS id, import_id::text AS import_id, as_of_date::text AS as_of_date, created_at::text AS created_at, facts, raw FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date, created_at`, [loanId]),
    db.query<LoanTermsRow>(`SELECT id::text AS id, effective_from::text AS effective_from, effective_to::text AS effective_to, source, amortization::text AS amortization, note_rate_bps, pi_cents::text AS pi_cents, escrow_payment_cents::text AS escrow_payment_cents, escrowed, remittance_type::text AS remittance_type, maturity_date::text AS maturity_date, remaining_term_months, deferred_principal_cents::text AS deferred_principal_cents, arm_index, arm_margin_bps FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from, id`, [loanId]),
    db.query<LoanInvitation>(`SELECT id::text AS id, import_id::text AS import_id, party_id::text AS party_id, kind, channel, destination_hash, notice_id::text AS notice_id, sent_at::text AS sent_at, bounced_at::text AS bounced_at FROM partner_book_invitations WHERE loan_id = $1 ORDER BY sent_at, id`, [loanId]),
    db.query<{ id: string; as_of_date: string; run_id: string; verdict: ReviewVerdict; reasons: unknown; opportunity_id: string | null; decision_id: string | null; facts: Row; analyst: Row; created_at: string }>(`SELECT id::text AS id, as_of_date::text AS as_of_date, run_id, verdict, reasons, opportunity_id, decision_id::text AS decision_id, facts, analyst, created_at::text AS created_at FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date, created_at`, [loanId]),
    readinessHistory(rt, loanId),
    db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = 'refi_opportunities' AND data->>'loan_id' = $1 ORDER BY data->>'as_of_date', id`, [loanId]),
    db.query<{ occurred_at: string; actor_kind: string; actor_id: string; payload: Row }>(`SELECT occurred_at::text AS occurred_at, actor_kind, actor_id, payload FROM loan_events WHERE loan_id = $1 AND type = 'partner_book.loan.resolved' ORDER BY sequence`, [loanId]),
    db.query<{ occurred_at: string; payload: Row }>(`SELECT occurred_at::text AS occurred_at, payload FROM loan_events WHERE loan_id = $1 AND type = 'partner_book.loan.not_on_tape' ORDER BY sequence`, [loanId]),
    db.query<LoanClock>(`SELECT id::text AS timer_id, code, status::text AS status, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at, cancelled_reason FROM timers WHERE loan_id = $1 ORDER BY armed_at, id`, [loanId]),
  ]);
  // offers: the refi_opportunities entity rows of the loan with 20.2's touches (`t-<channel>-<opportunity_id>`) — delivered how, expires when
  const offers: LoanOffer[] = [];
  for (const o of opps) {
    const d = decodeEntityData(o.data);
    const touches = await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = 'marketing_touches' AND (id LIKE $1 OR data->>'opportunity_id' = $2)`, [`t-%-${o.id}`, o.id]);
    offers.push({ opportunity_id: o.id, as_of_date: str(d["as_of_date"]), status: str(d["status"]), offer_valid_until: str(d["offer_valid_until"]), campaign_id: str(d["campaign_id"]), program_id: str(d["program_id"]), detected_at: str(d["detected_at"]),
      delivered: touches.map((t) => { const x = decodeEntityData(t.data); return { touch_id: t.id, channel: str(x["channel"]), outcome: str(x["outcome"] ?? x["status"]), sent_at: str(x["sent_at"]) }; }), expired: d["status"] === "expired" });
  }
  const analystOf = (a: Row): LoanReview["analyst"] => ({ skipped: str(a["skipped"]), rationale: str(a["rationale"]), explanation_text: str(a["explanation_text"]), flags: strings(a["flags"]), model_version: str(a["model_version"]), prompt_version: str(a["prompt_version"]), turn_id: str(a["turn_id"]), confidence: typeof a["confidence"] === "number" ? a["confidence"] : null });
  return {
    loan: { loan_id: loan.loan_id, servicer_loan_number: loan.servicer_loan_number, status: loan.status, partner_party_id: loan.partner_party_id, partner_legal_name: loan.partner_legal_name ?? "", lien: loan.lien, origination_date: loan.origination_date, first_payment_date: loan.first_payment_date, maturity_date: loan.maturity_date, original_upb_cents: loan.original_upb_cents, original_term_months: loan.original_term_months,
      property: loan.has_property ? { address_line1: loan.address_line1, city: loan.city, state: loan.state, postal_code: loan.postal_code, county: loan.county, occupancy: loan.occupancy, property_type: loan.property_type } : null },
    homeowner: owners.get(loanId) ?? { party_id: null, legal_name: null, email_masked: null, phone_masked: null }, on_hold: hold !== null, hold,
    facts_by_as_of: facts.map((f) => ({ id: f.id, import_id: f.import_id, as_of_date: f.as_of_date, created_at: f.created_at, facts: scrubDestinations(obj(f.facts)), raw: scrubDestinations(obj(f.raw)), raw_columns: Object.keys(obj(f.raw)).length })),
    terms: terms.map((t) => ({ ...t, note_rate_bps: Number(t.note_rate_bps), remaining_term_months: t.remaining_term_months === null ? null : Number(t.remaining_term_months), arm_margin_bps: t.arm_margin_bps === null ? null : Number(t.arm_margin_bps) })),
    invitations,
    reviews: reviews.map((r) => ({ id: r.id, as_of_date: r.as_of_date, run_id: r.run_id, verdict: r.verdict, verdict_words: VERDICT_WORDS[r.verdict] ?? r.verdict, reasons: strings(r.reasons), reasons_in_words: reasonsInWords(strings(r.reasons)), opportunity_id: r.opportunity_id, decision_id: r.decision_id, facts: obj(r.facts), analyst: analystOf(obj(r.analyst)), created_at: r.created_at })),
    readiness, offers,
    resolutions: resolved.map((e) => ({ at: iso(e.occurred_at) ?? e.occurred_at, resolution: str(e.payload["resolution"]), reason: str(e.payload["reason"]), actor: `${e.actor_kind}:${e.actor_id}`, was_on_hold: typeof e.payload["was_on_hold"] === "boolean" ? e.payload["was_on_hold"] : null, status: str(e.payload["status"]) })),
    not_on_tape: notOnTape.map((e) => ({ at: e.occurred_at, as_of_date: str(e.payload["as_of_date"]), last_as_of_date: str(e.payload["last_as_of_date"]), import_id: str(e.payload["import_id"]) })),
    clocks: timers,
  };
}
