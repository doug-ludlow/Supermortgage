/**
 * The borrower read models (docs/ux/02-data-contracts.md §1) as a read model over the existing tables and the event
 * log — nothing here is stored, nothing recomputes a regulatory date or a money figure:
 *
 *   borrower_record (§1.1)   per party × subject: subject, status (01 §4 badge catalogue + state_source), next (the
 *                            earliest non-satisfied allow-listed timer), needed_from_you[] (§1.3), numbers pre- and
 *                            post-funding, dates[], documents[] (§1.4 classes), people[], property, loan, offers[]
 *   thread_messages (§1.2)   the conversation's messages with sender labels and the card they carry
 *   servicing history (§1.5) payments_view · escrow_history_view · statements_view · cases_view · lossmit_view
 *
 * Sources: the real tables (applications, application_borrowers, application_properties, loans, loan_terms, timers,
 * consents, notices, documents, escrow_*, autodraft_enrollments, mi_policies, cases, lossmit_*, statement_cycles,
 * ledger_lines), the entity store (`entity_current`: locks, pricing_quotes, disclosures, apr_calculations, conditions,
 * document_requests, closings, fundings, valuation_orders, signing_sessions, refi_opportunities, payments, …) and
 * `loan_events` — the badge is read off the event spine so the same state names the owning process emitted are the ones
 * shown (`state_source`). Money is bigint cents serialized as decimal strings; rates are decimal strings; timers render
 * `timers.due_at` only for the 42 codes of 02 §4 (spec/registry/timers.json rows with process 32.2 carry the labels).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Queryable } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { DOCUMENT_CLASSES } from "../../domain/verification/ops-22-1.ts";
import type { Subject } from "../../infra/db/borrower-parties.ts";
import type { CardInstanceRow, MessageRow } from "../../infra/db/borrower-ui.ts";

// ---------------------------------------------------------------- the 02 §4 allow-list (labels from the registry's 32.2 rows; calendar notes from the table)
interface TimerRow { code: string; process: string; breach: string }
const REGISTRY_ROWS: TimerRow[] = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/registry/timers.json", import.meta.url)), "utf8")) as TimerRow[]).filter((r) => r.process === "32.2");
export const TIMER_LABELS: ReadonlyMap<string, string> = new Map(REGISTRY_ROWS.map((r) => [r.code, r.breach]));
export const ALLOWED_TIMER_CODES: ReadonlySet<string> = new Set(TIMER_LABELS.keys());
const CALENDAR_NOTES: Readonly<Record<string, string>> = {
  REGZ_1026_19E1_LE_3BD: "business days", REGZ_1026_37A13_COSTS_EXPIRE_10BD: "business days", SM_MLO_PREAPP_TERMS_REVIEW_1BH: "clock", SM_O21_MLO_REVIEW_SLA_1BD: "clock", SM_LOCK_MLO_APPROVAL_SLA_30MIN: "clock",
  REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD: "business days", SM_LOCK_EXPIRY_WARN_7: "calendar", SM_LOCK_EXPIRY_DEADLINE: "calendar", REGB_1002_9_DECISION_30: "calendar days", REGB_1002_9_NOIA: "calendar days", REGB_1002_9C2_NOIA_RESPONSE: "calendar days",
  REGB_1002_9_COUNTEROFFER_90: "calendar days", SM_NEEDS_LIST_BORROWER_RESPONSE_5: "business days", SM_DOC_EXPIRY_WARN_14: "calendar", FNMA_B1_1_03_CREDIT_DOCS_4M: "calendar", SM_CREDIT_EXPIRY_WARN_21: "calendar", SM_UW_DECISION_VALIDITY: "calendar",
  REGB_1002_14_APPRAISAL_COPY_3BD_GATE: "business days", REGB_1002_14_APPRAISAL_COPY_PROMPT_7: "business days", FNMA_B4_1_3_12_ROV_TURNTIME_5BD: "business days", FDPA_4104A_FLOOD_NOTICE_GATE: "—", SM_FLOOD_NOTICE_DELIVER_1BD: "—",
  SM_O62_CD_TARGET_4SBD: "specific business days (Sundays and federal holidays don't count)", REGZ_1026_19F1_CD_3SBD_GATE: "specific business days", REGZ_1026_19F1III_CD_MAILBOX_3SBD: "specific business days", REGZ_1026_23_RESCISSION_3SBD_GATE: "specific business days",
  SM_O73_POST_RESCISSION_FUNDING_1BD: "business days", FNMA_B2_1_5_FIRST_PAYMENT_2M: "calendar", SM_O64_FIRST_PAYMENT_LETTER_5BD: "calendar", SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20: "calendar", REGX_1024_17G_INITIAL_STMT_45: "calendar days", SM_ORIG_FIRST_STATEMENT_LEAD_15: "calendar",
  REGZ_1026_39_OWNERSHIP_NOTICE_30: "calendar days", SM_REFI_OPPORTUNITY_EXPIRY_30: "calendar days", SM_LEAD_INACTIVITY_EXPIRY_90: "calendar days", REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45: "calendar days", REGX_1024_17I_ANNUAL_STMT_30: "calendar days",
  HPA_4902B_AUTO_TERMINATE_0: "scheduled date", REGZ_1026_36C3_PAYOFF_STMT_7BD: "business days", REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD: "business days", REGX_1024_41E1_ACCEPT_14: "calendar days", SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW: "calendar days",
};
/** 02 §4 servicing rows and 32.8–32.12 labels for the codes whose registry label is "per 32.8–32.12". */
const SERVICING_LABELS: Readonly<Record<string, string>> = { REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45: "Escrow review by", REGX_1024_17I_ANNUAL_STMT_30: "Escrow statement by", HPA_4902B_AUTO_TERMINATE_0: "PMI ends", REGZ_1026_36C3_PAYOFF_STMT_7BD: "Payoff statement by", REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD: "Escrow refund by", REGX_1024_41E1_ACCEPT_14: "Offer response by", SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW: "Deferral offer open until" };
export const timerLabel = (code: string): string => { const l = TIMER_LABELS.get(code) ?? ""; return /^per 32\./.test(l) ? (SERVICING_LABELS[code] ?? l) : l; };

// ---------------------------------------------------------------- the 02 §5 borrower-visible notice codes
const NOTICE_CODES: ReadonlySet<string> = new Set(["NTC_REGZ_1026_37_LE", "NTC_REGZ_1026_38_CD", "NTC_REGZ_1026_38_CD_CORRECTED", "NTC_REGX_1024_20_HCL", "NTC_REGX_1024_6_TOOLKIT", "NTC_REGX_1024_15_AFBA", "NTC_REGB_1002_14_APPRAISAL_NOTICE", "NTC_FCRA_609G_CREDIT_SCORE", "NTC_REGV_1022_74_RBP_EXCEPTION", "NTC_REGZ_1026_19B_ARM_PROGRAM", "NTC_REGZ_1026_19B_CHARM", "NTC_GLBA_1016_4_PRIVACY_INITIAL", "NTC_REGB_1002_9_APPROVAL", "NTC_REGB_1002_9_ADVERSE_ACTION", "NTC_REGB_1002_9_NOIA", "NTC_REGB_1002_9_COUNTEROFFER", "NTC_REGZ_1026_23_H8", "NTC_REGZ_1026_23_H9", "NTC_HPA_4903_INITIAL_FIXED", "NTC_HPA_4903_INITIAL_ARM", "NTC_HPA_4905_LPMI", "NTC_FDPA_4104A_FLOOD_NOTICE", "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT", "NTC_REGZ_1026_39_OWNERSHIP_TRANSFER", "NTC_SM_FIRST_PAYMENT_LETTER", "NTC_SM_ESIGN_CONSENT", "NTC_FNMA_1103_SCIF", "NTC_TX_50A6_12DAY", "NTC_TX_50A6_ITEMIZATION", "NTC_SM_NEEDS_LIST", "NTC_SM_NEEDS_LIST_REMINDER", "NTC_CO_SB26_189_ADMT_NOTICE", "NTC_REGZ_1026_24_REFI_OFFER",
  "NTC_ESIGN_7001C_DISCLOSURE", "NTC_ESIGN_CONSENT_CONFIRMATION", "NTC_ESIGN_VERIFICATION_EMAIL", "NTC_ESIGN_WITHDRAWAL_CONFIRMATION", "NTC_EDELIVERY_BOUNCE_PAPER_RESUME", "NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE", "NTC_TCPA_CONSENT_CONFIRMATION", "AUTODRAFT-CONFIRM-v1", "AUTODRAFT-AMOUNT-CHANGE-v1", "AUTODRAFT-RETURN-v1", "NTC_REGX_35C_ADDRESS", "NTC_REGX_35D_ACK", "NTC_REGX_36A2_OWNER_IDENTITY", "NTC_REGX_38B5_PROCEDURES", "NTC_REGZ_36C3_PAYOFF_STMT", "NTC_PAYOFF_REQUEST_ACK_DELAY", "NTC_PAYOFF_UPDATED_STMT", "NTC_FNMA_D23204_DEFERRAL_OFFER"]);
const NOTICE_PREFIXES = ["NTC_REGX_35E_", "NTC_REGZ_41_STMT", "NTC_REGZ_36C3_PAYOFF_STMT_", "NTC_REGX_1024_17", "NTC_HPA_", "NTC_REGZ_1026_20", "NTC_FPI_", "NTC_REGX_1024_37", "NTC_REGX_1024_39", "NTC_FNMA_D2_2_04", "NTC_SM_EI_", "NTC_LOSSMIT_", "NTC_REGX_41_", "NTC_SM_HELLO", "NTC_SM_GOODBYE", "NTC_REGX_1024_33"];
export const noticeVisible = (code: string): boolean => NOTICE_CODES.has(code) || NOTICE_PREFIXES.some((p) => code.startsWith(p));
const VISIBLE_FAMILIES: Readonly<Record<string, "own_only" | "shared">> = { identity: "own_only", income_employment: "own_only", assets: "own_only", letters: "own_only", insurance: "shared", hoa_project: "shared" };

// ---------------------------------------------------------------- shapes (02 §1.1)
export interface NeededItem { item_id: string; kind: "condition" | "consent" | "confirmation" | "connector" | "document_request" | "acknowledgment" | "schedule" | "signature"; label: string; due_at: string | null; card_instance_id: string | null; created_at: string; source: string }
export interface BorrowerRecord {
  subject: { application_id: string | null; loan_id: string | null; label: string; transaction_type: string | null; occupancy: string | null; stage: "origination" | "servicing" };
  status: { badge: string; state_source: string; one_liner: string };
  next: { label: string; due_at: string; timer_code: string; calendar_note: string } | null;
  needed_from_you: NeededItem[];
  numbers: Record<string, unknown> | null;
  dates: { timer_code: string; label: string; due_at: string; calendar: string; status: string }[];
  documents: Record<string, unknown>[];
  people: Record<string, unknown>[];
  property: Record<string, unknown> | null;
  loan: Record<string, unknown> | null;
  offers: Record<string, unknown>[];
  as_of: string;
}
interface Ev { sequence: string; type: string; occurred_at: string; loan_id: string | null; application_id: string | null; payload: Record<string, unknown> }
interface Entity { kind: string; id: string; data: Record<string, unknown>; updated_at: string }
interface Timer { id: string; code: string; status: string; due_at: string | null; due_date: string | null; armed_at: string }

const cents = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v.toString() : typeof v === "number" ? Math.round(v).toString() : /^-?\d+$/.test(String(v)) ? String(v) : null);
const rate = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const bpsToPct = (bps: unknown): string | null => (bps === undefined || bps === null ? null : (Number(bps) / 10_000).toFixed(3));   // loan_terms.note_rate_bps 61250 → "6.125"; a decimal string, never a float on the wire
const firstName = (legal: string): string => legal.split(/\s+/)[0] ?? legal;
const withAt = (e: Entity): Record<string, unknown> => ({ ...e.data, updated_at: e.updated_at });
const latest = <T extends Record<string, unknown>>(rows: T[]): T | undefined => rows.slice().sort((a, b) => String(b["updated_at"] ?? "").localeCompare(String(a["updated_at"] ?? "")))[0];

export class BorrowerRecordReader {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  // ---- shared loads
  private async events(appId: string | null, loanId: string | null): Promise<Ev[]> {
    if (!appId && !loanId) return [];
    return this.db.query<Ev & Record<string, unknown>>(`SELECT sequence::text AS sequence, type, occurred_at, loan_id, application_id, payload FROM loan_events WHERE ($1::uuid IS NOT NULL AND application_id = $1) OR ($2::uuid IS NOT NULL AND loan_id = $2) ORDER BY sequence`, [appId, loanId]);
  }
  private async entities(appId: string | null, loanId: string | null): Promise<Entity[]> {
    if (!appId && !loanId) return [];
    const rows = await this.db.query<{ kind: string; id: string; data: unknown; updated_at: string }>(`SELECT DISTINCT ON (kind, id) kind, id, data, updated_at FROM entity_records WHERE ($1::text IS NOT NULL AND application_id = $1) OR ($2::text IS NOT NULL AND loan_id = $2) ORDER BY kind, id, version DESC`, [appId, loanId]);
    return rows.map((r) => ({ kind: r.kind, id: r.id, data: decodeEntityData(r.data), updated_at: r.updated_at }));
  }
  private async timers(appId: string | null, loanId: string | null): Promise<Timer[]> {
    if (!appId && !loanId) return [];
    return this.db.query<Timer & Record<string, unknown>>(`SELECT id, code, status::text AS status, due_at, due_date::text AS due_date, armed_at FROM timers WHERE ($1::uuid IS NOT NULL AND application_id = $1) OR ($2::uuid IS NOT NULL AND loan_id = $2) ORDER BY due_at NULLS LAST, armed_at`, [appId, loanId]);
  }

  /** 02 §1.1 `borrower_record` for one party on one subject the party may read (scoping is the caller's — auth.assertSubject). */
  async record(party: { id: string; legal_name: string }, subject: Subject, cards: readonly CardInstanceRow[], asOf: string): Promise<BorrowerRecord> {
    const appId = subject.application_id; const loanId = subject.loan_id;
    const [app, loan, events, entities, timers] = await Promise.all([
      appId ? this.db.query<Record<string, unknown>>(`SELECT a.*, (SELECT count(*) FROM application_borrowers ab WHERE ab.application_id = a.id)::int AS borrower_count FROM applications a WHERE a.id = $1`, [appId]).then((r) => r[0] ?? null) : Promise.resolve(null),
      loanId ? this.db.query<Record<string, unknown>>(`SELECT l.*, lt.note_rate_bps, lt.pi_cents, lt.escrow_payment_cents, lt.escrowed, lt.arm_next_change_date, lt.amortization, lt.remaining_term_months FROM loans l LEFT JOIN LATERAL (SELECT * FROM loan_terms t WHERE t.loan_id = l.id ORDER BY t.effective_from DESC, t.created_at DESC LIMIT 1) lt ON true WHERE l.id = $1`, [loanId]).then((r) => r[0] ?? null) : Promise.resolve(null),
      this.events(appId, loanId), this.entities(appId, loanId), this.timers(appId, loanId)]);
    const byKind = (kind: string): Entity[] => entities.filter((e) => e.kind === kind);
    const ev = (type: string, where: (p: Record<string, unknown>) => boolean = () => true): Ev | undefined => events.filter((e) => e.type === type && where(e.payload)).at(-1);
    const has = (type: string | RegExp, where: (p: Record<string, unknown>) => boolean = () => true): boolean => events.some((e) => (typeof type === "string" ? e.type === type : type.test(e.type)) && where(e.payload));
    const stage: "origination" | "servicing" = loan ? "servicing" : "origination";

    // ---- subject
    const transaction_type = (app?.["transaction_type"] as string | null) ?? null; const occupancy = (app?.["occupancy"] as string | null) ?? null;
    const property = await this.property(appId, loan, entities, events);
    const subjectOut = { application_id: appId, loan_id: loanId, label: subject.label, transaction_type, occupancy, stage };

    // ---- status (01 §4 catalogue, read off the event spine; state_source = the state name and table the owning process wrote)
    const status = this.badge(app, loan, events, entities, byKind, ev, has);

    // ---- next / dates (02 §4 allow-list; never a computed date)
    const allowed = timers.filter((t) => ALLOWED_TIMER_CODES.has(t.code) && t.due_at);
    const dedupe = new Map<string, Timer>(); for (const t of allowed) { const prev = dedupe.get(t.code); if (!prev || (t.status === "armed" && prev.status !== "armed") || (t.status === prev.status && t.armed_at > prev.armed_at)) dedupe.set(t.code, t); }
    const open = [...dedupe.values()].filter((t) => t.status === "armed" || t.status === "breached").sort((a, b) => a.due_at!.localeCompare(b.due_at!));
    const nextTimer = open.find((t) => t.status === "armed" && t.due_at! >= asOf) ?? open.find((t) => t.status === "armed") ?? open[0];
    const next = nextTimer ? { label: timerLabel(nextTimer.code), due_at: nextTimer.due_at!, timer_code: nextTimer.code, calendar_note: CALENDAR_NOTES[nextTimer.code] ?? "as stated in the owning process" } : null;
    const dates = [...dedupe.values()].filter((t) => (t.status === "armed" || t.status === "breached") && t.due_at! >= asOf.slice(0, 10)).sort((a, b) => a.due_at!.localeCompare(b.due_at!)).map((t) => ({ timer_code: t.code, label: timerLabel(t.code), due_at: t.due_at!, calendar: CALENDAR_NOTES[t.code] ?? "as stated", status: t.status }));
    // the closings.scheduled_at column and the CD's earliest_consummation_date render as dates too (02 §4 names them beside the codes)
    const closing = latest(byKind("closings").map(withAt));
    if (closing?.["scheduled_at"] && !has("closing.consummated")) dates.push({ timer_code: "closings.scheduled_at", label: "Closing appointment", due_at: String(closing["scheduled_at"]), calendar: "local time", status: "scheduled" });

    // ---- needed from you (02 §1.3)
    const needed = this.neededFromYou(party, subject, cards, byKind, events, has, closing);

    // ---- numbers
    const numbers = loan ? await this.servicingNumbers(loanId!, loan, events, byKind) : this.originationNumbers(app, byKind, events, transaction_type);

    // ---- documents (02 §1.4)
    const documents = await this.documents(party, subject, byKind, events);
    // ---- people
    const people = await this.people(party, subject, byKind, events, loan);
    // ---- loan (servicing) and offers
    const loanSection = loan ? await this.loanSection(loanId!, loan, byKind, events, timers) : null;
    const offers = byKind("refi_opportunities").filter((o) => ["offer_ready", "offered", "engaged"].includes(String(o.data["status"]))).map((o) => ({ refi_opportunity_id: o.id, status: o.data["status"], offered_at: o.data["offered_at"] ?? o.data["created_at"] ?? null, expires_at: o.data["expires_at"] ?? o.data["offer_expires_at"] ?? null,
      terms: { current_rate: rate((o.data["current_terms"] as Record<string, unknown> | undefined)?.["note_rate"] ?? loan?.["note_rate_bps"] !== undefined ? bpsToPct(loan?.["note_rate_bps"]) : null), offered_rate: rate((o.data["candidate_terms"] as Record<string, unknown> | undefined)?.["note_rate"]), new_pi_payment_cents: cents((o.data["candidate_terms"] as Record<string, unknown> | undefined)?.["pi_cents"]), monthly_savings_cents: cents((o.data["benefit"] as Record<string, unknown> | undefined)?.["pi_delta_cents"] ?? o.data["pi_delta_cents"]), costs_to_borrower_cents: "0" } }));

    return { subject: subjectOut, status, next, needed_from_you: needed, numbers, dates, documents, people, property, loan: loanSection, offers, as_of: asOf };
  }

  private badge(app: Record<string, unknown> | null, loan: Record<string, unknown> | null, events: Ev[], _entities: Entity[], byKind: (k: string) => Entity[], ev: (t: string, w?: (p: Record<string, unknown>) => boolean) => Ev | undefined, has: (t: string | RegExp, w?: (p: Record<string, unknown>) => boolean) => boolean): BorrowerRecord["status"] {
    const b = (badge: string, state_source: string, one_liner: string) => ({ badge, state_source, one_liner });
    if (loan) {
      if (loan["status"] === "paid_off" || has("loan.paid_in_full")) return b("Paid off", "loans.status=paid_off", "payoff.paid_in_full");
      if (loan["status"] === "transferred" || loan["transfer_out_at"]) return b("Closed", `loans.status=${String(loan["status"])}`, "transfer.goodbye");
      const dq = ev("loan.delinquency.day_reached"); const lastPay = ev("payment.posted") ?? ev("payment.written");
      if (dq && (!lastPay || Number(dq.sequence) > Number(lastPay.sequence))) { const n = Number(dq.payload["n"] ?? dq.payload["days"] ?? 0); return n >= 45 ? b("Behind", `servicing account: regx_days_delinquent=${n}`, "hardship.open") : b("Past due", `servicing account: regx_days_delinquent=${n}`, "payment.due_soon"); }
      if (has("loan.boarded") || loan["boarded_at"]) return b("Your loan", "loans.boarding_status=active", "boarding.welcome");
    }
    const fundings = byKind("fundings").map((e) => e.data);
    if (has("loan.funded") || fundings.some((f) => f["status"] === "disbursed")) return b("Funded", "fundings.status=disbursed", app?.["transaction_type"] === "purchase" ? "funded.purchase" : "funded.refi");
    if (has("funding.authorized") || fundings.some((f) => ["authorized", "wire_prepared", "wire_released", "funds_at_agent"].includes(String(f["status"])))) return b("Funding", `fundings.status=${String(fundings.at(-1)?.["status"] ?? "authorized")}`, "funding.progress");
    if (has("application.withdrawn") || app?.["status"] === "withdrawn") return b("Withdrawn", "applications.disposition=withdrawn", "decision.withdraw.confirm");
    if (has("rescission.period.started") && !has(/^rescission\.(confirmed_not_rescinded|expired|waiver\.accepted)$/)) return b("Cancel window", "rescission_periods.status=running", "rescission.how");
    if (has("closing.consummated")) return b("Signed", `closings.status=${String(byKind("closings").at(-1)?.data["execution_status"] ?? "signed")}`, app?.["transaction_type"] === "purchase" ? "signed.purchase" : "signed.refi");
    if (has("closing.scheduled")) return b("Closing scheduled", `closings.status=${has("closing.documents.released") ? "package_released" : "scheduled"}`, "closing.schedule");
    const decision = ev("decision.issued");
    if (decision?.payload["kind"] === "denial") return b("Decision letter sent", "credit_decisions.kind=denial", "decision.denial.next");
    if (has("clear_to_close.issued")) return b("Clear to close", "credit_decisions.status=clear_to_close", "ctc.reached");
    if (decision?.payload["kind"] === "counteroffer") return b("Counteroffer", "credit_decisions.kind=counteroffer", "decision.counteroffer");
    if (decision?.payload["kind"] === "noia" || has("needs_list.noia.recommended")) return b("What's missing", "applications.status=suspended (NOIA)", "decision.noia");
    if (decision?.payload["kind"] === "conditional_approval") return b("Approved with conditions", "credit_decisions.kind=conditional_approval", "decision.conditional_approval");
    if (has("du.submitted") || has("credit.report.received")) return b("Verifying", "decision sub-status underwriting_pending", "du.running");
    const lock = latest(byKind("locks").map(withAt));
    if (lock && ["executed", "confirmed"].includes(String(lock["status"]))) return b("Rate locked", `locks.status=${String(lock["status"])}`, "lock.executed");
    if (has("intent.to_proceed.received")) return b("Rate floating", "intent_records.valid=true; no active lock", "intent.received");
    if (has("disclosure.le.received")) return b("Ready to proceed", "disclosures.status=received (le)", "le.delivered");
    if (has(/^disclosure\.le\.(delivered|issued|mailed)$/)) return b("Loan Estimate sent", "disclosures.status=delivered (le)", has("disclosure.le.mailed") ? "le.mailed" : "le.delivered");
    if (has("application.trid_received")) return b("Application received", "applications.status=trid_received", "application.received");
    if (has("application.received")) return b("Application received", "applications.status=received", "application.received");
    if (has("preapproval.letter.issued")) return b("Preapproved", "prequalifications.kind=preapproval (letter issued)", "preapproval.letter");
    if (has("prequal.letter.issued")) return b("Prequalified", "leads.status=prequalified", "preapproval.intro");
    return b("Getting started", `${app ? "applications.status=" + String(app["status"] ?? "started") : "leads.status=new"}`, "entry.goal.question");
  }

  private neededFromYou(party: { id: string }, subject: Subject, cards: readonly CardInstanceRow[], byKind: (k: string) => Entity[], _events: Ev[], has: (t: string | RegExp, w?: (p: Record<string, unknown>) => boolean) => boolean, closing: Record<string, unknown> | undefined): NeededItem[] {
    const items: NeededItem[] = [];
    const pending = cards.filter((c) => c.status === "pending" && (!c.subject_application_id || c.subject_application_id === subject.application_id) && (!c.subject_loan_id || c.subject_loan_id === subject.loan_id));
    const cardFor = (pred: (c: CardInstanceRow) => boolean): string | null => pending.find(pred)?.card_instance_id ?? null;
    const KIND_OF: Record<string, NeededItem["kind"] | undefined> = { ConsentCard: "consent", ConfirmCard: "confirmation", ConnectCard: "connector", UploadCard: "document_request", DocumentCard: "acknowledgment", ScheduleCard: "schedule", ChoiceCard: "acknowledgment", ComparisonCard: "acknowledgment", ProfileCard: "confirmation", DemographicsCard: "confirmation", ExplanationCard: "document_request", PaymentCard: "acknowledgment", InviteCard: "acknowledgment", OfferCard: "acknowledgment" };
    // conditions waiting on the borrower (23.2/23.3) — the owner=you items of the ChecklistCard; prior-to-decision items are cleared by clear_to_close.issued (CTC_PTD_ALL_CLEARED), every condition by funding
    const ctc = has("clear_to_close.issued"); const funded = has(/^(loan\.funded|loan\.boarded)$/);
    for (const c of byKind("conditions")) { const d = c.data; const status = String(d["status"] ?? ""); const text = String(d["text"] ?? "");
      if (funded || (ctc && String(d["stage"] ?? "") === "ptd")) continue;
      const yours = status === "waiting_borrower" || (status === "open" && d["borrower_visible"] === true && /\b(needs? (a copy of )?your|needs the|send us|upload)\b/i.test(text));
      if (!yours || (d["borrower_id"] && subject.application_borrower_id && !String(subject.application_borrower_id).endsWith(String(d["borrower_id"])) && String(d["borrower_id"]).length > 3)) continue;
      items.push({ item_id: c.id, kind: "condition", label: text || String(d["template_code"] ?? "Condition"), due_at: (d["due_at"] as string | null) ?? null, card_instance_id: cardFor((x) => x.kind === "UploadCard" && x.props["condition_id"] === c.id) ?? cardFor((x) => x.kind === "ChecklistCard"), created_at: String(d["opened_at"] ?? c.updated_at), source: "conditions" }); }
    // open document requests (22.1)
    for (const r of byKind("document_requests")) { const d = r.data; if (!["open", "reminded", "waiting_borrower"].includes(String(d["status"] ?? ""))) continue; if (d["borrower_id"] && subject.application_borrower_id && String(d["borrower_id"]) !== subject.application_borrower_id && String(d["borrower_id"]).length > 3) continue;
      items.push({ item_id: r.id, kind: "document_request", label: String(d["reason_text"] ?? d["doc_class"] ?? "Document requested"), due_at: (d["due_at"] as string | null) ?? (d["due_on"] ? `${String(d["due_on"])}T23:59:59.000Z` : null), card_instance_id: cardFor((x) => x.kind === "UploadCard" && x.props["request_id"] === r.id), created_at: String(d["opened_at"] ?? r.updated_at), source: "document_requests" }); }
    // pending cards the borrower must act on (consents required for the stage, confirmations, connectors not connected, acknowledgments, schedules)
    for (const c of pending) { const kind = KIND_OF[c.kind]; if (!kind || c.kind === "StatusCard" || c.kind === "NoticeCard" || c.kind === "PersonCard" || c.kind === "HandoffCard" || c.kind === "ChecklistCard") continue;
      if (c.kind === "ConnectCard" && !["not_started", "failed", "in_progress", undefined].includes(c.props["state"] as string | undefined)) continue;
      if (items.some((x) => x.card_instance_id === c.card_instance_id)) continue;
      items.push({ item_id: c.card_instance_id, kind, label: c.copy_key, due_at: c.expires_at, card_instance_id: c.card_instance_id, created_at: c.created_at, source: "card_instances" }); }
    // disclosures delivered under E-SIGN and not yet acknowledged (requires_ack)
    for (const d of byKind("disclosures")) { const kind = String(d.data["kind"]); const delivered = has(`disclosure.${kind}.delivered`, (p) => p["disclosure_id"] === d.id) || ["delivered", "issued"].includes(String(d.data["status"] ?? ""));
      if (!delivered || String(d.data["status"]) === "superseded" || has(`disclosure.${kind}.received`, (p) => p["disclosure_id"] === d.id && p["all_required"] !== false)) continue;
      if (items.some((x) => x.item_id === `ack:${d.id}`)) continue;
      items.push({ item_id: `ack:${d.id}`, kind: "acknowledgment", label: d.data["kind"] === "cd" ? "Confirm you received your Closing Disclosure" : "Confirm you received your Loan Estimate", due_at: null, card_instance_id: cardFor((x) => x.kind === "DocumentCard" && x.props["disclosure_id"] === d.id), created_at: d.updated_at, source: "disclosures" }); }
    // clear to close without a scheduled closing → the ScheduleCard; a scheduled closing without the E-SIGN closing consent → the signature item
    if (has("clear_to_close.issued") && !has("closing.scheduled")) items.push({ item_id: "closing:schedule", kind: "schedule", label: "Pick your closing time", due_at: null, card_instance_id: cardFor((x) => x.kind === "ScheduleCard"), created_at: "", source: "closings" });
    if (closing && !has("closing.consent.verified") && !has("closing.consummated")) items.push({ item_id: `signing:${String(closing["closing_id"])}`, kind: "signature", label: "Agree to sign your closing documents electronically", due_at: (closing["scheduled_at"] as string | null) ?? null, card_instance_id: cardFor((x) => x.kind === "ConsentCard" && x.props["consent_kind"] === "esign" && x.props["scope"] !== undefined), created_at: "", source: "signing_sessions" });
    return items.sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") || a.created_at.localeCompare(b.created_at));
  }

  private originationNumbers(app: Record<string, unknown> | null, byKind: (k: string) => Entity[], events: Ev[], transaction_type: string | null): Record<string, unknown> | null {
    const lock = latest(byKind("locks").map(withAt));
    const quotes = byKind("pricing_quotes").map(withAt);
    const quote = (lock ? quotes.find((q) => q["quote_id"] === lock["quote_id"]) : undefined) ?? latest(quotes.filter((q) => q["outcome"] === "priced" || q["note_rate_pct"] !== undefined));
    const cdApr = latest(byKind("apr_calculations").filter((e) => e.data["checkpoint"] === "cd").map(withAt));
    const leRendered = events.filter((e) => e.type === "disclosure.le.rendered").at(-1);
    const cdPrepared = events.filter((e) => e.type === "disclosure.cd.prepared").at(-1);
    const le = latest(byKind("disclosures").filter((e) => e.data["kind"] === "le").map(withAt));
    const cd = latest(byKind("disclosures").filter((e) => e.data["kind"] === "cd").map(withAt));
    if (!lock && !quote && !le && !cd) return null;
    const figures_source = cd ? `cd_v${String(cd["cd_version"] ?? 1)}` : le ? `le_v${String(le["le_version"] ?? 1)}` : "quote";
    const note_rate = rate(lock?.["note_rate"] ?? quote?.["note_rate_pct"] ?? (quote?.["note_rate"] !== undefined ? (Number(quote["note_rate"]) * 100).toFixed(3) : null));
    const apr = rate(cdApr?.["apr_disclosed_str"] ?? leRendered?.payload["apr"] ?? null);
    const pi = cents(cdApr?.["pi_cents"] ?? quote?.["pi_cents"] ?? null);
    const escrow = cents((cdPrepared?.payload["escrow"] as Record<string, unknown> | undefined)?.["monthly_escrow_cents"] ?? quote?.["escrow_monthly_cents"] ?? null);
    const loan_amount = cents(lock?.["loan_amount_cents"] ?? cdApr?.["loan_amount_cents"] ?? quote?.["loan_amount_cents"] ?? (quote?.["inputs"] as Record<string, unknown> | undefined)?.["loan_amount_cents"] ?? app?.["loan_amount_sought_cents"] ?? null);
    const cash_to_close = transaction_type === "purchase" ? cents(cdPrepared?.payload["cash_to_close_cents"] ?? null) : null;
    const opp = latest(byKind("refi_opportunities").map(withAt));
    const monthly_savings = transaction_type !== "purchase" ? cents(opp?.["pi_delta_cents"] ?? (opp?.["benefit"] as Record<string, unknown> | undefined)?.["pi_delta_cents"] ?? null) : null;
    return { note_rate, apr, pi_payment_cents: pi, escrow_payment_cents: escrow, loan_amount_cents: loan_amount, cash_to_close_cents: cash_to_close, monthly_savings_cents: monthly_savings,
      lock: lock ? { status: String(lock["status"]), expires_at: (lock["expires_at"] as string | null) ?? null, expires_on: (lock["expires_on"] as string | null) ?? null, period_days: (lock["lock_period_days"] as number | undefined) ?? ((lock["quote"] as Record<string, unknown> | undefined)?.["lock_period_days"] as number | undefined) ?? null } : { status: "none", expires_at: null, expires_on: null, period_days: null }, figures_source };
  }

  private async servicingNumbers(loanId: string, loan: Record<string, unknown>, events: Ev[], byKind: (k: string) => Entity[]): Promise<Record<string, unknown>> {
    const bal = await this.db.query<{ account: string; s: string }>(`SELECT account, sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account IN ('principal', 'escrow') GROUP BY account`, [loanId]);
    const principal = bal.find((b) => b.account === "principal")?.s ?? null; const escrow = bal.find((b) => b.account === "escrow")?.s;
    const cycleOpened = events.filter((e) => e.type === "statement.cycle.opened").at(-1);
    const cycle = (await this.db.query<Record<string, unknown>>(`SELECT cycle_due_date::text AS cycle_due_date, status FROM statement_cycles WHERE loan_id = $1 ORDER BY cycle_due_date DESC LIMIT 1`, [loanId]))[0];
    const pi = cents(loan["pi_cents"]); const esc = cents(loan["escrow_payment_cents"]);
    const paidOff = loan["status"] === "paid_off";
    const dq = events.filter((e) => e.type === "loan.delinquency.day_reached").at(-1); const lastPay = events.filter((e) => e.type === "payment.posted" || e.type === "payment.written").at(-1);
    const days_past_due = dq && (!lastPay || Number(dq.sequence) > Number(lastPay.sequence)) ? Number(dq.payload["n"] ?? dq.payload["days"] ?? 0) : 0;
    const payoffs = byKind("payoff_settlements").map((e) => e.data);
    return { upb_cents: paidOff ? "0" : principal, next_payment: paidOff ? null : { due_on: (cycleOpened?.payload["cycle_due_date"] as string | undefined) ?? (cycle?.["cycle_due_date"] as string | undefined) ?? (loan["first_payment_date"] as string | null) ?? null, amount_cents: cents(cycleOpened?.payload["amount_due_cents"]) ?? (pi && esc ? (BigInt(pi) + BigInt(esc)).toString() : pi), pi_cents: pi, escrow_cents: esc },
      escrow_balance_cents: escrow ? (-BigInt(escrow)).toString() : null, note_rate: bpsToPct(loan["note_rate_bps"]), days_past_due, ...(paidOff ? { paid_off: { payoff_date: payoffs.at(-1)?.["payoff_date"] ?? null, escrow_refund_pending_cents: escrow ? (-BigInt(escrow)).toString() : null } } : {}) };
  }

  private async property(appId: string | null, loan: Record<string, unknown> | null, entities: Entity[], events: Ev[]): Promise<Record<string, unknown> | null> {
    const row = appId ? (await this.db.query<Record<string, unknown>>(`SELECT address_line1, address_line2, city, state, postal_code, county, property_type, units, estimated_value_cents FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [appId]))[0] : loan?.["property_id"] ? (await this.db.query<Record<string, unknown>>(`SELECT address_line1, address_line2, city, state, postal_code, county, property_type, units, occupancy FROM properties WHERE id = $1`, [loan["property_id"] as string]))[0] : undefined;
    if (!row) return null;
    const tbd = !row["address_line1"];
    const order = entities.filter((e) => e.kind === "valuation_orders").at(-1)?.data; const appraisal = entities.filter((e) => e.kind === "appraisals").at(-1)?.data;
    const valuation = { method: (order?.["method"] as string | null) ?? (events.some((e) => e.type === "value_acceptance.offer.received") ? "value_acceptance" : null),
      status: appraisal ? (events.some((e) => e.type === "valuation.copy_delivered" || e.type === "appraisal.copy_delivered") ? "copy_delivered" : "received") : order ? (String(order["status"]) === "ordered" && order["scheduled_for"] ? "inspection_scheduled" : String(order["status"])) : events.some((e) => e.type === "value_acceptance.offer.received") ? "no_appraisal_needed" : "none",
      appointment_at: (order?.["scheduled_for"] as string | null) ?? null, value_used_cents: cents(appraisal?.["value_used_cents"] ?? (events.filter((e) => e.type === "value_acceptance.offer.received").at(-1)?.payload["property_value_cents"])) };
    const flood = events.filter((e) => /^flood\./.test(e.type)).at(-1); const hazard = entities.filter((e) => e.kind === "insurance_evidence").at(-1)?.data;
    return { address: tbd ? null : [row["address_line1"], row["address_line2"], row["city"], row["state"], row["postal_code"]].filter(Boolean).join(", ").replace(/, ([A-Z]{2}), /, ", $1 "), tbd, property_type: row["property_type"] ?? null, units: row["units"] ?? null, occupancy: row["occupancy"] ?? null, county: row["county"] ?? null,
      valuation, flood: { status: flood ? (flood.type === "flood.notice.delivered" ? "notice_delivered" : flood.type === "flood.determination.received" ? (flood.payload["sfha"] === true ? "in_flood_zone" : "not_in_flood_zone") : flood.type.replace("flood.", "")) : "pending" }, hazard: { status: hazard ? String(hazard["status"]) : events.some((e) => e.type === "insurance.evidence.received") ? "received" : "pending" }, project_review: { status: entities.some((e) => e.kind === "project_reviews") ? String(entities.filter((e) => e.kind === "project_reviews").at(-1)!.data["status"]) : "n/a" }, hoa_dues_cents: cents(entities.filter((e) => e.kind === "project_reviews").at(-1)?.data["hoa_dues_cents"]) };
  }

  private async documents(party: { id: string }, subject: Subject, byKind: (k: string) => Entity[], events: Ev[]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const d of byKind("disclosures")) { const kind = String(d.data["kind"]); const id = d.id;
      const delivered = events.filter((e) => e.type === `disclosure.${kind}.delivered` && e.payload["disclosure_id"] === id).at(-1); const received = events.filter((e) => e.type === `disclosure.${kind}.received` && e.payload["disclosure_id"] === id).at(-1); const mailed = events.filter((e) => e.type === `disclosure.${kind}.mailed` && e.payload["disclosure_id"] === id).at(-1);
      const status = String(d.data["status"]) === "superseded" ? "superseded" : received ? "received" : mailed ? "mailed" : delivered ? (delivered.payload["presumed_receipt_date"] && String(delivered.payload["presumed_receipt_date"]) <= events.at(-1)!.occurred_at.slice(0, 10) && !received ? "deemed_received" : "delivered") : "pending";
      out.push({ document_id: (d.data["rendered_document_id"] as string | null) ?? (d.data["document_id"] as string | null) ?? null, disclosure_id: id, notice_code: kind === "le" ? "NTC_REGZ_1026_37_LE" : kind === "cd" ? (d.data["cd_reason"] === "corrected" ? "NTC_REGZ_1026_38_CD_CORRECTED" : "NTC_REGZ_1026_38_CD") : (d.data["notice_code"] as string | null) ?? null, title: kind === "le" ? `Loan Estimate${d.data["le_version"] && Number(d.data["le_version"]) > 1 ? ` (revised v${String(d.data["le_version"])})` : ""}` : kind === "cd" ? `Closing Disclosure${d.data["cd_version"] && Number(d.data["cd_version"]) > 1 ? ` (v${String(d.data["cd_version"])})` : ""}` : String(d.data["title"] ?? kind), kind: `disclosure:${kind}`, status,
        delivered_at: (delivered?.payload["delivered_at"] as string | null) ?? (d.data["delivered_at"] as string | null) ?? null, received_at: received?.occurred_at ?? null, mailed_at: (mailed?.payload["mailed_at"] as string | null) ?? mailed?.occurred_at ?? null, requires_ack: kind === "le" || kind === "cd", channel: (delivered?.payload["channel"] as string | null) ?? (d.data["delivery_channel"] as string | null) ?? (mailed ? "mail" : null), template_version: d.data["template_version"] ?? null }); }
    if (subject.loan_id || subject.application_id) {
      // the Notice Registry's rows (recipients are the subject's own parties by construction; visibility is by code — 02 §5)
      const notices = await this.db.query<Record<string, unknown>>(`SELECT n.id, n.template_code, n.template_version, n.document_id, n.status, n.produced_at, n.sent_at, n.channel_decision, (SELECT d.channel FROM notice_deliveries d WHERE d.notice_id = n.id ORDER BY d.attempt_no DESC LIMIT 1) AS channel, (SELECT d.mailed_at FROM notice_deliveries d WHERE d.notice_id = n.id AND d.mailed_at IS NOT NULL ORDER BY d.attempt_no DESC LIMIT 1) AS mailed_at
        FROM notices n WHERE $1::uuid IS NOT NULL AND n.loan_id = $1 ORDER BY n.created_at`, [subject.loan_id]);
      const seen = new Set<string>();
      for (const n of notices) { const code = String(n["template_code"]); if (!noticeVisible(code)) continue; seen.add(String(n["id"])); const channel = (n["channel"] as string | null) ?? ((n["channel_decision"] as Record<string, unknown> | null)?.["channel"] as string | undefined) ?? null;
        out.push({ document_id: n["document_id"] ?? null, disclosure_id: null, notice_code: code, title: code.replace(/^NTC_/, "").replace(/_/g, " "), kind: "notice", status: n["mailed_at"] || (channel ?? "").startsWith("mail") ? "mailed" : n["sent_at"] ? "delivered" : "pending", delivered_at: n["sent_at"] ?? null, received_at: null, mailed_at: n["mailed_at"] ?? null, requires_ack: false, channel, template_version: n["template_version"] ?? null }); }
      // notices sent through the registry inside a unit of work (`notice.sent{template, notice_id, channels|channel}`) — the first-payment letter, the needs list, the score notice …
      for (const e of events.filter((x) => x.type === "notice.sent" && typeof x.payload["template"] === "string")) { const code = String(e.payload["template"]); const id = String(e.payload["notice_id"] ?? e.payload["carrier_notice_id"] ?? ""); if (!noticeVisible(code) || seen.has(`${id}:${code}`) || seen.has(id)) continue; seen.add(`${id}:${code}`);
        const channels = (e.payload["channels"] as { channel?: string }[] | undefined) ?? []; const channel = (e.payload["channel"] as string | undefined) ?? channels[0]?.channel ?? null; const mailed = !!e.payload["mailed_at"] || (channel ?? "").startsWith("mail");
        out.push({ document_id: (e.payload["document_id"] as string | null) ?? (e.payload["rendered_document_id"] as string | null) ?? null, disclosure_id: null, notice_code: code, title: code.replace(/^NTC_/, "").replace(/_/g, " "), kind: "notice", status: mailed ? "mailed" : "delivered", delivered_at: (e.payload["sent_at"] as string | undefined) ?? e.occurred_at, received_at: null, mailed_at: mailed ? ((e.payload["mailed_at"] as string | null) ?? e.occurred_at) : null, requires_ack: false, channel, template_version: (e.payload["template_version"] as string | null) ?? null }); }
    }
    if (subject.application_id || subject.loan_id) {
      const docs = await this.db.query<Record<string, unknown>>(`SELECT id, kind, doc_class, subject_borrower_id, received_at, created_at, metadata FROM documents WHERE ($1::uuid IS NOT NULL AND application_id = $1) OR ($2::uuid IS NOT NULL AND loan_id = $2) ORDER BY created_at`, [subject.application_id, subject.loan_id]);
      const consummated = events.some((e) => e.type === "closing.consummated"); const copyDelivered = events.some((e) => e.type === "valuation.copy_delivered" || e.type === "appraisal.copy_delivered");
      for (const d of docs) { const cls = DOCUMENT_CLASSES.find((c) => c.code === d["doc_class"]); const family = cls?.family; const kind = String(d["kind"]);
        const visible = family ? (VISIBLE_FAMILIES[family] === "shared" || (VISIBLE_FAMILIES[family] === "own_only" && d["subject_borrower_id"] === subject.application_borrower_id) || (family === "valuation" && copyDelivered) || (family === "closing" && consummated)) : ["rendered_notice", "rendered_disclosure", "notice", "disclosure"].includes(kind);
        if (!visible || String(family) === "credit" || /credit_report|du_findings|title_commitment|fraud|qc_/i.test(String(d["doc_class"] ?? ""))) continue;
        const md = (d["metadata"] as Record<string, unknown> | null) ?? {};
        out.push({ document_id: d["id"], disclosure_id: null, notice_code: null, title: (md["title"] as string | undefined) ?? (md["filename"] as string | undefined) ?? cls?.code ?? kind, kind: family ? `document:${family}` : `document:${kind}`, status: "received", delivered_at: null, received_at: d["received_at"] ?? d["created_at"], mailed_at: null, requires_ack: false, channel: "app", template_version: null }); }
    }
    return out;
  }

  private async people(party: { id: string }, subject: Subject, byKind: (k: string) => Entity[], events: Ev[], loan: Record<string, unknown> | null): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    if (subject.application_id) {
      const abs = await this.db.query<{ id: string; legal_name: string; borrower_role: string; party_id: string | null; joint_intent_affirmed_at: string | null; prefill: Record<string, Record<string, unknown>> }>(`SELECT id, legal_name, borrower_role, party_id, joint_intent_affirmed_at, prefill FROM application_borrowers WHERE application_id = $1 ORDER BY created_at`, [subject.application_id]);
      const consents = await this.db.query<{ party_id: string | null; kind: string; status: string | null }>(`SELECT party_id, kind::text AS kind, status FROM consents WHERE application_id = $1 OR party_id = ANY($2::uuid[])`, [subject.application_id, abs.map((a) => a.party_id).filter((p): p is string => !!p)]);
      const signed = new Set(byKind("signing_sessions").flatMap((s) => ((s.data["documents_signed"] as { signer_party_id: string }[] | undefined) ?? []).map((d) => d.signer_party_id)));
      for (const ab of abs) { const own = ab.party_id === party.id; const shortId = ab.id.slice(0, 2).toUpperCase();
        const progress = { consents_ok: consents.some((c) => c.party_id === ab.party_id && c.kind === "esign" && c.status === "active") || events.some((e) => e.type === "disclosure.le.received" && e.payload["borrower_id"] === ab.id), confirmations_ok: Object.values(ab.prefill ?? {}).every((p) => p["confirmed_at"] !== null && p["confirmed_at"] !== undefined) || ab.joint_intent_affirmed_at !== null, signed: signed.has(ab.id) || [...signed].some((s) => s === shortId) || events.some((e) => e.type === "closing.document.signed" && e.payload["signer_party_id"] === ab.id) };
        out.push({ party_id: ab.party_id, role: ab.borrower_role, display_name: own ? ab.legal_name : firstName(ab.legal_name), progress, is_you: own }); }   // the other borrower: first name + progress booleans only (02 §1.1 access rule)
    }
    const mlo = events.filter((e) => e.type === "disclosure.le.mlo_approved" || e.type === "mlo.assigned" || e.type === "lock.approved").at(-1);
    const mloName = events.filter((e) => e.type === "mlo.assigned").at(-1)?.payload["mlo_name"] as string | undefined; const nmlsr = (mlo?.payload["mlo_nmlsr_id"] ?? mlo?.payload["nmlsr_id"]) as string | undefined;
    if (nmlsr || mloName) out.push({ party_id: null, role: "mlo_of_record", display_name: mloName ?? "Your loan officer", nmlsr_id: nmlsr ?? null, progress: null });
    const closing = byKind("closings").at(-1)?.data;
    if (closing?.["notary_party_id"]) out.push({ party_id: closing["notary_party_id"], role: "notary", display_name: "Your notary", commission_state: closing["state"] ?? null, progress: null });
    if (closing?.["settlement_agent_party_id"]) out.push({ party_id: closing["settlement_agent_party_id"], role: "settlement_agent", display_name: "Settlement agent", progress: null });
    if (loan) { const team = events.filter((e) => e.type === "continuity.assigned").at(-1); if (team) out.push({ party_id: null, role: "continuity_of_contact_team", display_name: String(team.payload["team_name"] ?? "Your servicing team"), direct_number: team.payload["direct_number"] ?? null, progress: null }); }
    return out;
  }

  private async loanSection(loanId: string, loan: Record<string, unknown>, byKind: (k: string) => Entity[], events: Ev[], timers: Timer[]): Promise<Record<string, unknown>> {
    const [ad, lines, mi, y1098] = await Promise.all([
      this.db.query<Record<string, unknown>>(`SELECT id, status::text AS status, next_draft_on::text AS next_draft_on, fixed_amount_cents, extra_principal_cents, bank_account_last4, amount_rule::text AS amount_rule, draft_day FROM autodraft_enrollments WHERE loan_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [loanId]),
      this.db.query<Record<string, unknown>>(`SELECT el.line_type::text AS line_type, coalesce(el.payee_ref, el.payee_reference, p.legal_name) AS payee, el.next_due_date::text AS next_disbursement_on, coalesce(el.annual_amount_cents, el.estimated_annual_cents) AS annual_cents FROM escrow_lines el JOIN escrow_accounts ea ON ea.id = el.escrow_account_id LEFT JOIN parties p ON p.id = coalesce(el.payee_party_id, el.payee_id) WHERE ea.loan_id = $1 AND el.active ORDER BY el.line_type`, [loanId]),
      this.db.query<Record<string, unknown>>(`SELECT status, scheduled_80_date::text AS scheduled_80_date, scheduled_78_date::text AS scheduled_78_date, midpoint_termination_date::text AS midpoint_termination_date, terminated_on::text AS terminated_on FROM mi_policies WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1`, [loanId]),
      Promise.resolve(events.filter((e) => /^form_1098\.|^irs\.1098/.test(e.type)).at(-1))]);
    const adEntity = latest(byKind("autodraft_enrollments").map(withAt));
    const a = ad[0] ?? (adEntity ? { status: adEntity["status"], next_draft_on: adEntity["next_draft_on"] ?? null, fixed_amount_cents: adEntity["fixed_amount_cents"] ?? null, bank_account_last4: adEntity["account_last4"] ?? null, draft_day: adEntity["draft_day"] ?? null, amount_rule: adEntity["amount_rule"] ?? null } : undefined);
    const miEntity = latest(byKind("mi_policies").map(withAt)); const m = mi[0] ?? miEntity;
    const hpa = timers.find((t) => t.code === "HPA_4902B_AUTO_TERMINATE_0" && t.status === "armed");
    return { autodraft: a ? { status: a["status"], next_draft_on: a["next_draft_on"] ?? null, amount_cents: cents(a["fixed_amount_cents"]) ?? (loan["pi_cents"] !== undefined && loan["pi_cents"] !== null ? (BigInt(String(loan["pi_cents"])) + BigInt(String(loan["escrow_payment_cents"] ?? 0))).toString() : null), account_last4: a["bank_account_last4"] ?? null, draft_day: a["draft_day"] ?? null, amount_rule: a["amount_rule"] ?? null } : { status: "none", next_draft_on: null, amount_cents: null, account_last4: null },
      escrow_lines: lines.map((l) => ({ type: l["line_type"], payee: l["payee"] ?? null, next_disbursement_on: l["next_disbursement_on"] ?? null, annual_cents: cents(l["annual_cents"]) })),
      mi: m ? { status: m["status"] ?? null, projected_end_on: (m["scheduled_78_date"] as string | null) ?? (hpa?.due_date ?? null), cancellation_eligible_on: (m["scheduled_80_date"] as string | null) ?? null, midpoint_on: (m["midpoint_termination_date"] as string | null) ?? null } : { status: "none", projected_end_on: null, cancellation_eligible_on: null },
      arm: loan["arm_next_change_date"] ? { next_change_on: loan["arm_next_change_date"], notice_status: events.some((e) => e.type === "arm.notice.sent") ? "notice_sent" : "pending" } : null,
      year_end: { form_1098_status: y1098 ? y1098.type.split(".").at(-1) : "pending" },
      continuity_team: events.filter((e) => e.type === "continuity.assigned").at(-1)?.payload ?? null,
      servicer_loan_number_last4: String(loan["servicer_loan_number"] ?? "").slice(-4) || null, first_payment_date: loan["first_payment_date"] ?? null, maturity_date: loan["maturity_date"] ?? null, escrowed: loan["escrowed"] ?? null, remaining_term_months: loan["remaining_term_months"] ?? null };
  }

  // ---------------------------------------------------------------- 02 §1.2 thread_messages
  threadMessages(rows: readonly MessageRow[], cards: ReadonlyMap<string, CardInstanceRow>, partyFirstName: string): Record<string, unknown>[] {
    return rows.map((m) => {
      const card = m.card_instance_id ? cards.get(m.card_instance_id) : undefined;
      const sender_label = m.sender === "agent" ? "Supermortgage" : m.sender === "notice" ? "Notice" : m.sender === "borrower" ? partyFirstName : m.sender === "human" ? humanLabel(m.sender_ref) : "Supermortgage";
      return { message_id: m.message_id, conversation_id: m.conversation_id, at: m.at, sender: m.sender, sender_label, channel: m.channel, body_text: m.body_text, card_instance_id: m.card_instance_id, subject: { application_id: m.subject_application_id, loan_id: m.subject_loan_id }, voice_turn: m.voice_turn, delivery: { sent: true, delivered: true, read: m.sender === "borrower" },
        card: card ? { card_instance_id: card.card_instance_id, kind: card.kind, status: card.status, copy_key: card.copy_key, command_ref: card.command_ref, props: card.props, expires_at: card.expires_at, created_by: card.created_by, resolved_at: card.resolved_at } : null };
    });
  }

  // ---------------------------------------------------------------- 02 §1.5 servicing history views
  async history(loanId: string, view: "payments" | "escrow" | "statements" | "cases" | "lossmit"): Promise<Record<string, unknown>[]> {
    const ents = await this.entities(null, loanId);
    const of = (kind: string) => ents.filter((e) => e.kind === kind);
    if (view === "payments") {
      const lines = await this.db.query<{ description: string; account: string; s: string }>(`SELECT s.description, l.account, sum(l.amount_cents)::text AS s FROM ledger_lines l JOIN ledger_entry_sets s ON s.id = l.set_id WHERE l.scope = 'loan' AND l.loan_id = $1 AND s.description LIKE 'allocation %' GROUP BY s.description, l.account`, [loanId]);
      const alloc = (paymentId: string, account: string): string => { const l = lines.find((x) => x.description.endsWith(paymentId) && x.account === account); return l ? (-BigInt(l.s)).toString() : "0"; };
      return of("payments").map((p) => ({ payment_id: p.id, status: p.data["status"] ?? null, amount_cents: cents(p.data["amount_cents"]), received_on: p.data["received_on"] ?? null, credited_as_of: p.data["credited_as_of"] ?? null, channel: p.data["channel"] ?? null, designation: p.data["designation"] ?? null,
        allocation: { principal_cents: alloc(p.id, "principal"), interest_cents: alloc(p.id, "interest_due"), escrow_cents: alloc(p.id, "escrow"), fees_cents: alloc(p.id, "late_charges") } })).sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)));
    }
    if (view === "escrow") {
      const [disb, analyses] = await Promise.all([
        this.db.query<Record<string, unknown>>(`SELECT d.id, d.disbursement_kind, d.amount_cents, d.due_date::text AS due_date, d.status, d.sent_at, d.confirmed_at, coalesce(p.legal_name, d.payee_type) AS payee FROM disbursements d LEFT JOIN parties p ON p.id = d.payee_id WHERE d.loan_id = $1 AND d.status IN ('sent', 'confirmed', 'cleared') ORDER BY d.due_date DESC`, [loanId]),
        this.db.query<Record<string, unknown>>(`SELECT a.id, a.analysis_type::text AS analysis_type, a.as_of_date::text AS as_of_date, a.status::text AS status, a.new_payment_cents, a.new_payment_effective_date::text AS new_payment_effective_date, a.shortage_cents, a.surplus_cents, a.deficiency_cents FROM escrow_analyses a JOIN escrow_accounts ea ON ea.id = a.escrow_account_id WHERE ea.loan_id = $1 AND a.status::text IN ('effective', 'statement_sent', 'approved') ORDER BY a.as_of_date DESC`, [loanId])]);
      return [...disb.map((d) => ({ kind: "disbursement", id: d["id"], type: d["disbursement_kind"], payee: d["payee"], amount_cents: cents(d["amount_cents"]), due_date: d["due_date"], status: d["status"], sent_at: d["sent_at"], confirmed_at: d["confirmed_at"] })),
        ...analyses.map((a) => ({ kind: "analysis", id: a["id"], type: a["analysis_type"], as_of: a["as_of_date"], status: a["status"], new_payment_cents: cents(a["new_payment_cents"]), effective_on: a["new_payment_effective_date"], shortage_cents: cents(a["shortage_cents"]), surplus_cents: cents(a["surplus_cents"]), deficiency_cents: cents(a["deficiency_cents"]) })),
        ...of("escrow_elections").map((e) => ({ kind: "election", id: e.id, type: e.data["kind"], months: e.data["months"] ?? null, recorded_on: e.data["recorded_on"] ?? null, status: "recorded" }))];
    }
    if (view === "statements") {
      const rows = await this.db.query<Record<string, unknown>>(`SELECT id, cycle_due_date::text AS cycle_due_date, statement_due_by::text AS statement_due_by, variant, status, generated_at, notice_id FROM statement_cycles WHERE loan_id = $1 ORDER BY cycle_due_date DESC`, [loanId]);
      const notices = await this.db.query<{ id: string; sent_at: string | null; document_id: string | null; channel: string | null }>(`SELECT n.id, n.sent_at, n.document_id, (SELECT d.channel FROM notice_deliveries d WHERE d.notice_id = n.id ORDER BY d.attempt_no DESC LIMIT 1) AS channel FROM notices n WHERE n.loan_id = $1 AND n.template_code LIKE 'NTC_REGZ_41_STMT%'`, [loanId]);
      const table = rows.map((r) => { const n = notices.find((x) => x.id === r["notice_id"]); return { cycle_id: r["id"], cycle_due_date: r["cycle_due_date"], statement_due_by: r["statement_due_by"], variant: r["variant"], status: r["status"], generated_at: r["generated_at"], document_id: n?.document_id ?? null, delivered_at: n?.sent_at ?? null, channel: n?.channel ?? null }; });
      // 7.1 cycles that live on the event spine only (30.2's `statement.cycle.opened`, 7.1's `statement.sent|delivered|bounced|fallback_mailed`)
      const events = await this.events(null, loanId); const seen = new Set(table.map((t) => t.cycle_due_date));
      for (const e of events.filter((x) => x.type === "statement.cycle.opened")) { const due = String(e.payload["cycle_due_date"] ?? ""); if (!due || seen.has(due)) continue; seen.add(due);
        const outcome = events.filter((x) => /^statement\.(sent|delivered|bounced|fallback_mailed)$/.test(x.type) && (x.payload["cycle_due_date"] === due || x.payload["cycle_id"] === e.payload["cycle_id"])).at(-1);
        table.push({ cycle_id: (e.payload["cycle_id"] as string | undefined) ?? `cycle:${due}`, cycle_due_date: due, statement_due_by: (e.payload["statement_due_by"] as string | null) ?? null, variant: (e.payload["variant"] as string | null) ?? null, status: outcome ? outcome.type.replace("statement.", "") : "opened", generated_at: null, document_id: (outcome?.payload["document_id"] as string | null) ?? null, delivered_at: outcome?.occurred_at ?? null, channel: (outcome?.payload["channel"] as string | null) ?? null }); }
      return table.sort((a, b) => String(b.cycle_due_date).localeCompare(String(a.cycle_due_date)));
    }
    if (view === "cases") {
      const rows = await this.db.query<Record<string, unknown>>(`SELECT id, case_type, status, opened_at, closed_at, received_at, receipt_date::text AS receipt_date, channel, is_qwr, determination, response_type FROM cases WHERE loan_id = $1 AND case_type IN ('rfi', 'noe', 'complaint', 'payoff', 'payoff_request', 'sii', 'address_change', 'general_inquiry', 'pmi_cancel') ORDER BY opened_at DESC`, [loanId]);
      const due = await this.db.query<{ code: string; due_date: string | null; status: string; subject_id: string }>(`SELECT code, due_date::text AS due_date, status::text AS status, subject_id FROM timers WHERE loan_id = $1 AND subject_kind = 'case' AND status IN ('armed', 'breached')`, [loanId]);
      const table = rows.map((c) => ({ case_id: c["id"], kind: c["case_type"], status: c["status"], opened_at: c["opened_at"] ?? c["received_at"], closed_at: c["closed_at"], receipt_date: c["receipt_date"], channel: c["channel"], is_qwr: c["is_qwr"], determination: c["determination"], response_type: c["response_type"], due: due.filter((t) => t.subject_id === c["id"]).map((t) => ({ timer_code: t.code, due_date: t.due_date, status: t.status })) }));
      const seen = new Set(table.map((c) => c.case_id));
      return [...table, ...of("cases").filter((c) => !seen.has(c.id)).map((c) => ({ case_id: c.id, kind: c.data["case_type"] ?? c.data["kind"] ?? null, status: c.data["status"] ?? null, opened_at: c.data["received_at"] ?? c.data["opened_at"] ?? c.updated_at, closed_at: c.data["closed_at"] ?? null, receipt_date: c.data["receipt_date"] ?? null, channel: c.data["channel"] ?? null, is_qwr: c.data["is_qwr"] ?? null, determination: c.data["determination"] ?? null, response_type: null, due: [] }))];
    }
    const [apps, evals, plans, appeals] = await Promise.all([
      this.db.query<Record<string, unknown>>(`SELECT id, status, received_date::text AS received_date, protection_tier, facially_complete_at, complete_at, reasonable_date::text AS reasonable_date, ack_sent_on::text AS ack_sent_on FROM lossmit_applications WHERE loan_id = $1 ORDER BY received_at DESC`, [loanId]),
      this.db.query<Record<string, unknown>>(`SELECT id, application_id, status, started_at, due_at::text AS due_at, decided_at, provided_at::text AS provided_at FROM lossmit_evaluations WHERE loan_id = $1 ORDER BY started_at DESC`, [loanId]),
      this.db.query<Record<string, unknown>>(`SELECT id, plan_type, status, start_date::text AS start_date, current_term_end::text AS current_term_end, installment_cents, term_months FROM workout_plans WHERE loan_id = $1 ORDER BY start_date DESC`, [loanId]),
      this.db.query<Record<string, unknown>>(`SELECT id, evaluation_id, status, received_date::text AS received_date, appeal_window_ends::text AS appeal_window_ends, decision, decided_at, accept_by::text AS accept_by FROM lossmit_appeals WHERE loan_id = $1 ORDER BY received_at DESC`, [loanId])]);
    const ent = (kind: string, map: (d: Record<string, unknown>, id: string) => Record<string, unknown>) => of(kind).map((e) => map(e.data, e.id));
    return [
      ...apps.map((a) => ({ kind: "application", id: a["id"], status: a["status"], received_date: a["received_date"], protection_tier: a["protection_tier"], facially_complete_at: a["facially_complete_at"], complete_at: a["complete_at"], reasonable_date: a["reasonable_date"], ack_sent_on: a["ack_sent_on"] })),
      ...ent("lossmit_applications", (d, id) => ({ kind: "application", id, status: d["status"] ?? null, received_date: d["received_on"] ?? d["received_date"] ?? null, protection_tier: d["protection_tier"] ?? null, facially_complete_at: d["facially_complete_at"] ?? null, complete_at: d["complete_at"] ?? null, reasonable_date: d["reasonable_date"] ?? null, ack_sent_on: d["ack_due"] ?? null })),
      ...evals.map((e) => ({ kind: "evaluation", id: e["id"], application_id: e["application_id"], status: e["status"], started_at: e["started_at"], due_at: e["due_at"], decided_at: e["decided_at"], provided_at: e["provided_at"] })),
      ...ent("lossmit_evaluations", (d, id) => ({ kind: "evaluation", id, application_id: d["application_id"] ?? null, status: d["status"] ?? null, started_at: d["started_at"] ?? null, due_at: d["due_at"] ?? null, decided_at: d["decided_at"] ?? null, provided_at: d["provided_at"] ?? null })),
      ...ent("lossmit_offers", (d, id) => ({ kind: "offer", id, option: d["option"] ?? null, status: d["status"] ?? null, accept_by: d["accept_by"] ?? null, responded_on: d["responded_on"] ?? null })),
      ...plans.map((p) => ({ kind: "workout_plan", id: p["id"], plan_type: p["plan_type"], status: p["status"], start_date: p["start_date"], current_term_end: p["current_term_end"], installment_cents: cents(p["installment_cents"]), term_months: p["term_months"] })),
      ...ent("workout_plans", (d, id) => ({ kind: "workout_plan", id, plan_type: d["plan_type"] ?? null, status: d["status"] ?? null, start_date: d["start_date"] ?? null, current_term_end: d["current_term_end"] ?? null, installment_cents: cents(d["installment_cents"]), term_months: d["term_months"] ?? null })),
      ...appeals.map((a) => ({ kind: "appeal", id: a["id"], evaluation_id: a["evaluation_id"], status: a["status"], received_date: a["received_date"], appeal_window_ends: a["appeal_window_ends"], decision: a["decision"], decided_at: a["decided_at"], accept_by: a["accept_by"] })),
      ...ent("lossmit_appeals", (d, id) => ({ kind: "appeal", id, evaluation_id: d["evaluation_id"] ?? null, status: d["status"] ?? null, received_date: d["received_date"] ?? d["received_on"] ?? null, appeal_window_ends: d["appeal_window_ends"] ?? null, decision: d["decision"] ?? null, decided_at: d["decided_at"] ?? null, accept_by: d["accept_by"] ?? null })),
    ];
  }
}

const humanLabel = (ref: string | null): string => { if (!ref) return "Your team"; const m = /^human:([^:]+)(?::(.+))?$/.exec(ref); if (m) return `${m[2] ? firstName(m[2]) : "A person"} · ${m[1]!.replace(/_/g, " ")}`; return ref.replace(/_/g, " "); };
