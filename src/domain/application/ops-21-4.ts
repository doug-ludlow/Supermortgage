/**
 * §21.4 Intent to proceed, fee collection and rate lock — the pure rules of the `pricing` agent over the
 * `applications` aggregate (migration 0066: intent_records, fee_gate_checks, locks, lock_extensions,
 * changed_circumstances). One small function per rule / T-id; every function validates, returns new rows (never
 * mutates its input) and appends its event with `applicationId` (origination timers arm only on origination
 * context — src/kernel/timers/engine.ts).
 *
 * Events (subject = the application):
 *   intent.to_proceed.received{intent_id, disclosure_id, channel, valid=true, received_at}      [opens REGZ_1026_19E2_INTENT_FEE_GATE]
 *   intent.to_proceed.rejected_premature{intent_id, disclosure_id, channel, le_effective_receipt_date}
 *   fee.gate.checked{check_id, command, result, amount_cents, collected_cents}
 *   fee.imposed{fee_item_id, amount_cents, method, ledger_set_id}
 *   lock.requested{lock_id, lineage_id, version, quote_id, rate_sheet_id, requested_at}         [arms SM_LOCK_MLO_APPROVAL_SLA_30MIN]
 *   lock.approved{lock_id, quote_id, mlo_nmlsr_id} · lock.rejected{lock_id, reason∈{quote_expired, mlo_returned}}   [satisfy the SLA]
 *   lock.executed{lock_id, lineage_id, version, note_rate, price, points_cents, lender_credit_cents, lock_period_days, expires_at, expires_on,
 *                 rate_set_date, quote_id_fnma, property_state, ny_expiry_notice_required}      [arms the 3BD revised-LE clock, the expiry clocks, the NY window]
 *   changed_circumstance.recorded{cc_id, kind∈{rate_lock, borrower_request}, basis, valid, discovered_at, information_received_at/on, revised_le_due_at, reflected_on, lock_id}   [21.5 consumes]
 *   lock.extended{lock_id, extension_id, days, fee_cents, payer, consumer_charge_cents, new_expires_on, new_expires_at, expires_on}
 *   lock.relocked{lock_id, supersedes_lock_id, version, note_rate, price, expires_on, expires_at, rate_set_date}   [29.1 key-data change]
 *   lock.float_down.applied{lock_id, supersedes_lock_id, version, note_rate, float_down_fee_cents, expires_on}
 *   lock.expiry.warned{lock_id, expires_at} · lock.expired{lock_id, expires_at} · lock.cancelled{lock_id, lineage_id, reason, refund_set_id}
 *   lock.commitment.linked{lock_id, commitment_id, commitment_id_fnma, expires_on}
 *   commitment.executed / commitment.modified / commitment.fallout.recorded{reason, pair_off_expected}   [the in-process best-efforts adapter 29.1 replaces]
 *
 * Consumed: application.trid_received (21.1), disclosure.le.received / disclosure.le.deemed_received / disclosure.le.issued
 * (21.2, `effective_receipt_date`), disclosure.le.revised{reason=rate_lock} (21.5) and disclosure.cd.corrected /
 * disclosure.cd.delivered (25.2) — the revised disclosure that carries the lock terms (`locks.revised_le_disclosure_id`).
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, businessDaysBetween, creditor, fannieEt, regzSpecific, rollForward } from "../../kernel/calendar/business.ts";
import { toIso, wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { type Cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, CorporateAccount, EntrySet, Ledger } from "../../kernel/ledger/ledger.ts";

export const PRICING_AGENT: Actor = { kind: "agent", id: "pricing" };
/** The refinance fixture's creditor time zone (Phoenix: MST all year; disclosed as "5:00 p.m. MST"). */
export const CREDITOR_TZ = "America/Phoenix";
export const LOCK_EXPIRY_HHMM = "17:00";
/** Partner lock policy defaults (open question 3): 12.5 bps per 7-day block, one float-down per lineage at 25 bps with a 0.125 % margin, 30-minute quote TTL. */
export const EXTENSION_BPS_PER_7_DAYS_X10 = 125n;   // 12.5 bps, kept as tenths of a basis point
export const FLOAT_DOWN_FEE_BPS = 25n;
export const FLOAT_DOWN_MARGIN_PCT = "0.125";
export const QUOTE_TTL_MINUTES = 30;
export const NY_EXPIRY_NOTICE_MIN_BD = 12, NY_EXPIRY_NOTICE_MAX_BD = 20;
export const REVISED_LE_BUSINESS_DAYS = 3;                 // §1026.19(e)(3)(iv)(D): general business days
export const CONSUMMATION_RECEIPT_LIMIT_SBD = 4;           // §1026.19(e)(4)(ii): specific business days
export const CD_WAITING_PERIOD_SBD = 3;                     // §1026.19(f)(1)(ii)(A) / (f)(2)(ii)
export const APR_TOLERANCE_X1000 = 125;                     // §1026.22(a)(2): 1/8 of one percentage point

export class LockRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, reason: string) { super(`${code}: ${reason}`); this.name = "LockRefused"; this.code = code; this.citation = citation; }
}
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isoOrThrow = (v: unknown, what: string): string => { const s = nonEmpty(v, what); if (Number.isNaN(Date.parse(s))) throw new RangeError(`${what} must be an ISO instant`); return s; };
/** The creditor's civil date of an instant (rule 2 / edge case: 23:30 MST Oct 7 is "locked" Oct 7 even though it is Oct 8 in ET). */
export const civilDate = (iso: string, tz: string = CREDITOR_TZ): PlainDate => wallClock(Date.parse(iso), tz).date;
const emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = PRICING_AGENT): DomainEvent =>
  events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, ...payload } });
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const forApp = (events: EventStore, applicationId: string, type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === applicationId || p(e).application_id === applicationId);
/** round_half_up(loan_amount × pct / 100) in cents; `pct` is a decimal string with up to 5 places ("0.125"). */
export function pctOfCents(amountCents: Cents, pct: string): Cents {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(pct.trim()); if (!m) throw new RangeError(`bad percentage ${pct}`);
  const frac = (m[3] ?? "").padEnd(6, "0"); const scaled = BigInt(m[2]!) * 1_000_000n + BigInt(frac);
  const v = divRound(amountCents * scaled, 100n * 1_000_000n, "HALF_UP"); return m[1] === "-" ? -v : v;
}

// ============================================================ LE receipt (21.2's evidence chain, consumed)
export interface LeReceipt { readonly disclosure_id: string; readonly le_version: number; readonly effective_receipt_date: PlainDate; readonly evidence: string; }
/** The latest LE receipt 21.2 recorded for the application (`disclosure.le.received{effective_receipt_date}` / `deemed_received` / `issued`); null before any LE exists. */
export function leReceiptFromEvents(events: EventStore, applicationId: string): LeReceipt | null {
  const rows = [...forApp(events, applicationId, "disclosure.le.received"), ...forApp(events, applicationId, "disclosure.le.deemed_received"), ...forApp(events, applicationId, "disclosure.le.issued")]
    .filter((e) => typeof p(e).effective_receipt_date === "string" || typeof p(e).deemed_receipt_date === "string").sort((a, b) => a.sequence - b.sequence);
  const e = rows.at(-1); if (!e) return null;
  const pl = p(e);
  return { disclosure_id: String(pl.disclosure_id ?? `le-${String(pl.le_version ?? 1)}`), le_version: Number(pl.le_version ?? 1), effective_receipt_date: plainDate(String(pl.effective_receipt_date ?? pl.deemed_receipt_date)), evidence: String(pl.evidence ?? pl.receipt_evidence ?? e.type) };
}

// ============================================================ Rule 2 — intent to proceed
export const INTENT_CHANNELS = ["app_button", "chat", "voice", "email", "esign_form", "in_person", "phone_human"] as const;
export type IntentChannel = (typeof INTENT_CHANNELS)[number];
export interface IntentRecord {
  readonly intent_id: string; readonly application_id: string; readonly disclosure_id: string; readonly le_effective_receipt_date: PlainDate; readonly received_at: string;
  readonly channel: IntentChannel; readonly statement_text: string; readonly evidence_document_id: string; readonly recorded_by: string; readonly valid: boolean; readonly withdrawn_at: string | null;
}
/** `valid = received_at::date ≥ le_effective_receipt_date` in the creditor time zone (rule 2). */
export const intentValid = (receivedAt: string, leEffectiveReceiptDate: PlainDate, tz: string = CREDITOR_TZ): boolean => civilDate(receivedAt, tz) >= leEffectiveReceiptDate;
export interface IntentInput { readonly application_id: string; readonly disclosure_id: string; readonly le_effective_receipt_date: PlainDate; readonly received_at: string; readonly channel: string; readonly statement_text: string; readonly evidence_document_id: string; readonly recorded_by: string; readonly time_zone?: string; }
/**
 * Records a documented indication of intent (comment 19(e)(2)(i)(A)-2: "in any manner the consumer chooses"; silence is
 * never intent, so an empty statement is refused). A statement received before LE receipt is kept as evidence with
 * `valid=false` and `intent.to_proceed.rejected_premature` (the agent re-asks after receipt).
 */
export function recordIntent(events: EventStore, i: IntentInput, actor: Actor = PRICING_AGENT): { record: IntentRecord; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.disclosure_id, "disclosure_id"); nonEmpty(i.statement_text, "statement_text (silence is not intent)"); nonEmpty(i.evidence_document_id, "evidence_document_id");
  if (!(INTENT_CHANNELS as readonly string[]).includes(i.channel)) throw new RangeError(`channel ${JSON.stringify(i.channel)} is not one of ${INTENT_CHANNELS.join("/")}`);
  const received_at = isoOrThrow(i.received_at, "received_at");
  const valid = intentValid(received_at, i.le_effective_receipt_date, i.time_zone ?? CREDITOR_TZ);
  const record: IntentRecord = { intent_id: randomUUID(), application_id: i.application_id, disclosure_id: i.disclosure_id, le_effective_receipt_date: i.le_effective_receipt_date, received_at, channel: i.channel as IntentChannel,
    statement_text: i.statement_text, evidence_document_id: i.evidence_document_id, recorded_by: i.recorded_by, valid, withdrawn_at: null };
  const event = emit(events, i.application_id, valid ? "intent.to_proceed.received" : "intent.to_proceed.rejected_premature",
    { intent_id: record.intent_id, disclosure_id: record.disclosure_id, channel: record.channel, valid, received_at, le_effective_receipt_date: i.le_effective_receipt_date }, received_at, actor);
  return { record, event };
}
/** "I'm not sure anymore": no fees after `withdrawn_at`; fees already imposed stand; a later renewed intent is a new record. */
export function withdrawIntent(events: EventStore, r: IntentRecord, at: string, actor: Actor = PRICING_AGENT): { record: IntentRecord; event: DomainEvent } {
  const record = { ...r, withdrawn_at: isoOrThrow(at, "withdrawn_at") };
  return { record, event: emit(events, r.application_id, "intent.to_proceed.withdrawn", { intent_id: r.intent_id, withdrawn_at: record.withdrawn_at }, record.withdrawn_at, actor) };
}
/** The valid, unwithdrawn intent in force at `at` (any applicant's — "the consumer"). */
export const intentInForce = (intents: readonly IntentRecord[], at: string): IntentRecord | null =>
  intents.filter((r) => r.valid && Date.parse(r.received_at) <= Date.parse(at) && (r.withdrawn_at === null || Date.parse(r.withdrawn_at) > Date.parse(at))).sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))[0] ?? null;

// ============================================================ Rule 1 — the fee gate (§1026.19(e)(2)(i)(A)/(B))
export const FEE_GATE_COMMANDS = ["impose_fee", "capture_payment_method", "order_appraisal", "order_title", "order_flood", "order_pdc", "order_credit_report"] as const;
export type FeeGateCommand = (typeof FEE_GATE_COMMANDS)[number];
export type FeeGateResult = "open" | "closed_no_receipt" | "closed_no_intent" | "exempt_credit_report";
export interface FeeGateFacts {
  readonly application_id: string; readonly command: string; readonly fee_kind: string; readonly amount_cents: Cents; readonly checked_at: string;
  readonly le_effective_receipt_date: PlainDate | null; readonly intent: IntentRecord | null; readonly vendor_invoice_cents?: Cents | null; readonly fee_item_id?: string | null; readonly actor?: string; readonly time_zone?: string;
}
export interface FeeGateCheck {
  readonly check_id: string; readonly application_id: string; readonly command: FeeGateCommand; readonly fee_kind: string; readonly fee_item_id: string | null; readonly amount_cents: Cents; readonly collected_cents: Cents;
  readonly checked_at: string; readonly result: FeeGateResult; readonly basis: { le_effective_receipt_date: PlainDate | null; intent_id: string | null; vendor_invoice_cents: Cents | null; checked_on: PlainDate }; readonly actor: string;
}
/**
 * `gate_open = (today_creditor_tz ≥ le_effective_receipt_date) ∧ (∃ intent_records.valid)`; the credit-report
 * exception applies only to `fee_kind='credit_report'` and only up to the vendor's invoiced cost (comment
 * 19(e)(2)(i)(B)-1 as understood — the engine caps the collected amount at the invoice). "Impose" includes capturing a
 * payment method, so `capture_payment_method` runs through the same evaluation.
 */
export function evaluateFeeGate(f: FeeGateFacts): { result: FeeGateResult; collected_cents: Cents; reason: string } {
  if (f.amount_cents <= 0n) throw new RangeError("amount_cents must be positive");
  const tz = f.time_zone ?? CREDITOR_TZ;
  if (f.fee_kind === "credit_report" || f.command === "order_credit_report") {
    if (f.fee_kind !== "credit_report") throw new RangeError("order_credit_report carries fee_kind=credit_report only");
    const invoice = f.vendor_invoice_cents ?? null;
    if (invoice === null || invoice <= 0n) throw new RangeError("credit-report exemption needs the vendor's invoiced cost (bona fide and reasonable)");
    const collected = f.amount_cents < invoice ? f.amount_cents : invoice;
    return { result: "exempt_credit_report", collected_cents: collected, reason: `§1026.19(e)(2)(i)(B): credit-report fee capped at the vendor invoice ${invoice}` };
  }
  const today = civilDate(f.checked_at, tz);
  if (f.le_effective_receipt_date === null || today < f.le_effective_receipt_date) return { result: "closed_no_receipt", collected_cents: 0n, reason: "§1026.19(e)(2)(i)(A): the Loan Estimate has not been received" };
  const intent = f.intent;
  if (!intent || !intent.valid || Date.parse(intent.received_at) > Date.parse(f.checked_at) || (intent.withdrawn_at !== null && Date.parse(intent.withdrawn_at) <= Date.parse(f.checked_at)))
    return { result: "closed_no_intent", collected_cents: 0n, reason: "§1026.19(e)(2)(i)(A): no documented intent to proceed after receipt" };
  return { result: "open", collected_cents: f.amount_cents, reason: `gate open since ${intent.received_at} (LE received ${f.le_effective_receipt_date})` };
}
/** Every guarded command records its attempt — refusals included — as an append-only `fee_gate_checks` row with `fee.gate.checked`. */
export function checkFeeGate(events: EventStore, f: FeeGateFacts, actor: Actor = PRICING_AGENT): { check: FeeGateCheck; event: DomainEvent; open: boolean } {
  nonEmpty(f.application_id, "application_id"); nonEmpty(f.fee_kind, "fee_kind"); isoOrThrow(f.checked_at, "checked_at");
  if (!(FEE_GATE_COMMANDS as readonly string[]).includes(f.command)) throw new RangeError(`command ${JSON.stringify(f.command)} is not one of ${FEE_GATE_COMMANDS.join("/")}`);
  const r = evaluateFeeGate(f);
  const check: FeeGateCheck = { check_id: randomUUID(), application_id: f.application_id, command: f.command as FeeGateCommand, fee_kind: f.fee_kind, fee_item_id: f.fee_item_id ?? null, amount_cents: f.amount_cents, collected_cents: r.collected_cents,
    checked_at: f.checked_at, result: r.result, basis: { le_effective_receipt_date: f.le_effective_receipt_date, intent_id: f.intent?.intent_id ?? null, vendor_invoice_cents: f.vendor_invoice_cents ?? null, checked_on: civilDate(f.checked_at, f.time_zone ?? CREDITOR_TZ) }, actor: f.actor ?? `${actor.kind}:${actor.id}` };
  const event = emit(events, f.application_id, "fee.gate.checked", { check_id: check.check_id, command: check.command, fee_kind: check.fee_kind, result: check.result, amount_cents: String(check.amount_cents), collected_cents: String(check.collected_cents), reason: r.reason, intent_id: check.basis.intent_id, le_effective_receipt_date: check.basis.le_effective_receipt_date }, f.checked_at, actor);
  return { check, event, open: r.result === "open" || r.result === "exempt_credit_report" };
}
/** Ledger account the 21.2 note names for imposed origination fees (the kernel's account list predates origination; cast like 30.2's prepaid_interest). */
export const ORIGINATION_FEES_RECEIVABLE: AccountRef = { scope: "corporate", account: "origination_fees_receivable" };
export const ORIGINATION_VENDOR_PAYABLE: AccountRef = { scope: "corporate", account: "origination_vendor_payable" };
/** A fee is imposed (card/ACH authorized or a payment method captured) only on an open or exempt check; posts to `origination_fees_receivable`. */
export function imposeFee(events: EventStore, ledger: Ledger, i: { check: FeeGateCheck; fee_item_id: string; method: string; at: string; description?: string }, actor: Actor = PRICING_AGENT): { event: DomainEvent; ledger_set: EntrySet; amount_cents: Cents } {
  if (i.check.result !== "open" && i.check.result !== "exempt_credit_report") throw new LockRefused(i.check.result.toUpperCase(), "12 CFR 1026.19(e)(2)(i)(A)", `fee ${i.fee_item_id} cannot be imposed: ${i.check.result}`);
  nonEmpty(i.fee_item_id, "fee_item_id"); nonEmpty(i.method, "method");
  const amount = i.check.collected_cents;
  const ledger_set = ledger.post({ effectiveDate: civilDate(i.at), description: i.description ?? `origination fee ${i.fee_item_id} (${i.check.fee_kind}) imposed under fee_gate_check ${i.check.check_id}`,
    lines: [{ account: ORIGINATION_FEES_RECEIVABLE, amountCents: amount, ruleRef: `21.4 rule 1: fee imposed after receipt + intent (fee_gate_checks.result=${i.check.result})` },
      { account: ORIGINATION_VENDOR_PAYABLE, amountCents: -amount, ruleRef: "21.4 rule 1: pass-through to the provider (21.2 note: origination_fees_receivable)" }] }, i.at);
  const event = emit(events, i.check.application_id, "fee.imposed", { fee_item_id: i.fee_item_id, amount_cents: String(amount), method: i.method, check_id: i.check.check_id, ledger_set_id: ledger_set.id, fee_kind: i.check.fee_kind }, i.at, actor);
  return { event, ledger_set, amount_cents: amount };
}

// ============================================================ Pricing port (20.4 implements; the fixture adapter prices from its inputs)
export interface RateSheet { readonly rate_sheet_id: string; readonly effective_at: string; readonly superseded_at: string | null; readonly llpa_version: string; }
export interface PriceRequest { readonly application_id: string; readonly loan_amount_cents: Cents; readonly product_code: string; readonly note_rate_pct: string; readonly lock_period_days: number; readonly points_pct?: string; readonly lender_credit_pct?: string; readonly price_pct?: string; readonly quote_id_fnma?: string | null; }
export interface PricingQuote extends PriceRequest {
  readonly quote_id: string; readonly rate_sheet_id: string; readonly llpa_version: string; readonly price_pct: string; readonly points_pct: string; readonly lender_credit_pct: string;
  readonly quoted_at: string; readonly quote_ttl_minutes: number; readonly quote_id_fnma: string | null;
}
export interface PricingPort { readonly rateSheetAt: (at: string) => RateSheet; readonly price: (req: PriceRequest, at: string) => PricingQuote; }
/** Rate-sheet versioning stub for 20.4's engine: the rate/price/points come from the request (the spec's fixture inputs); the sheet in force at `at` stamps the quote. */
export class FixturePricing implements PricingPort {
  readonly sheets: RateSheet[];
  constructor(sheets: readonly RateSheet[]) { if (!sheets.length) throw new RangeError("at least one rate sheet"); this.sheets = [...sheets].sort((a, b) => Date.parse(a.effective_at) - Date.parse(b.effective_at)); }
  rateSheetAt(at: string): RateSheet {
    const t = Date.parse(at); const live = this.sheets.filter((s) => Date.parse(s.effective_at) <= t && (s.superseded_at === null || Date.parse(s.superseded_at) > t)).at(-1);
    if (!live) throw new RangeError(`no rate sheet in force at ${at}`); return live;
  }
  price(req: PriceRequest, at: string): PricingQuote {
    if (req.loan_amount_cents <= 0n) throw new RangeError("loan_amount_cents must be positive");
    if (!/^\d+\.\d{3}$/.test(req.note_rate_pct)) throw new RangeError(`note_rate_pct ${req.note_rate_pct} must have three decimals (6.125)`);
    const sheet = this.rateSheetAt(at);
    return { ...req, quote_id: randomUUID(), rate_sheet_id: sheet.rate_sheet_id, llpa_version: sheet.llpa_version, price_pct: req.price_pct ?? "100.000", points_pct: req.points_pct ?? "0.000", lender_credit_pct: req.lender_credit_pct ?? "0.000",
      quoted_at: at, quote_ttl_minutes: QUOTE_TTL_MINUTES, quote_id_fnma: req.quote_id_fnma ?? null };
  }
}
/** Rule 5: points and credits in dollars — `round_half_up(loan_amount_cents × pct / 100)`. */
export const pointsCents = (loanAmountCents: Cents, pointsPct: string): Cents => pctOfCents(loanAmountCents, pointsPct);
export const quoteIsFresh = (q: PricingQuote, pricing: PricingPort, at: string): boolean => pricing.rateSheetAt(at).rate_sheet_id === q.rate_sheet_id && Date.parse(at) <= Date.parse(q.quoted_at) + q.quote_ttl_minutes * 60_000;

// ============================================================ Locks — data model and state machine
export type LockKind = "initial" | "extension" | "relock" | "float_down" | "renegotiation";
export type LockStatus = "requested" | "pending_mlo_approval" | "quote_expired" | "executed" | "confirmed" | "superseded" | "expired" | "cancelled" | "consummated";
export type ExtensionPayer = "borrower" | "lender_delay" | "lender_goodwill";
export type CancelReason = "borrower_withdrawal" | "lender_declination" | "product_change_ineligible" | "expired" | "superseded";
export type StateVariant = "NY" | "NJ" | "MA" | null;
export interface Lock {
  readonly lock_id: string; readonly application_id: string; readonly lineage_id: string; readonly version: number; readonly kind: LockKind; readonly supersedes_lock_id: string | null; readonly status: LockStatus;
  readonly requested_at: string; readonly quote: PricingQuote; readonly quote_id: string; readonly quote_id_fnma: string | null; readonly mlo_approval_escalation_id: string | null; readonly approved_at: string | null; readonly mlo_nmlsr_id: string | null;
  readonly locked_at: string | null; readonly rate_set_date: PlainDate | null; readonly note_rate: string; readonly price: string; readonly points_cents: Cents; readonly lender_credit_cents: Cents; readonly lock_period_days: number;
  readonly expires_on: PlainDate | null; readonly expires_at: string | null; readonly expiry_roll_applied: boolean; readonly time_zone: string; readonly product_code: string; readonly loan_amount_cents: Cents; readonly worst_case_pricing_applied: boolean;
  readonly extension_fee_cents: Cents; readonly extension_payer: ExtensionPayer | null; readonly float_down_fee_cents: Cents; readonly commitment_id: string | null; readonly revised_le_disclosure_id: string | null; readonly state_agreement_variant: StateVariant;
  readonly property_state: string; readonly cancelled_reason: CancelReason | null; readonly ny_expiry_notice_required: boolean; readonly borrower_statement: string; readonly superseded_quote_ids: readonly string[]; readonly recorded_by: string;
}
export interface LockExtension { readonly extension_id: string; readonly lock_id: string; readonly days: number; readonly fee_cents: Cents; readonly payer: ExtensionPayer; readonly granted_at: string; readonly new_expires_on: PlainDate; readonly new_expires_at: string; readonly delay_attribution: DelayAttribution; }
export type DelayAttribution = "borrower" | "lender" | "lender_agent";
export const stateAgreementVariant = (state: string): StateVariant => (state === "NY" || state === "NJ" || state === "MA" ? state : null);

// ---- Rule 4: expiration ----------------------------------------------------------------
export interface LockExpiry { readonly expires_on: PlainDate; readonly raw_expires_on: PlainDate; readonly expiry_roll_applied: boolean; readonly expires_at: string; readonly display: string; }
/** `expires_on = locked_on + period` (calendar days), rolled to the next creditor business day at no cost (policy default); `expires_at` = 17:00 creditor time. */
export function lockExpiry(lockedOn: PlainDate, periodDays: number, cal: Calendar = creditor, tz: string = CREDITOR_TZ): LockExpiry {
  if (!Number.isInteger(periodDays) || periodDays <= 0) throw new RangeError("lock_period_days must be a positive integer");
  const raw = addDays(lockedOn, periodDays); const rolled = rollForward(raw, cal);
  return { expires_on: rolled, raw_expires_on: raw, expiry_roll_applied: rolled !== raw, expires_at: toIso(zonedEpochMs(rolled, LOCK_EXPIRY_HHMM, tz)), display: expiryDisplay(rolled, tz) };
}
/** §1026.37(a)(13)(i): "the date and time (including the applicable time zone)" — "11/23/2026 at 5:00 p.m. MST". */
export function expiryDisplay(expiresOn: PlainDate, tz: string = CREDITOR_TZ): string {
  const { y, m, d } = { y: expiresOn.slice(0, 4), m: expiresOn.slice(5, 7), d: expiresOn.slice(8, 10) };
  const abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(zonedEpochMs(expiresOn, LOCK_EXPIRY_HHMM, tz))).find((x) => x.type === "timeZoneName")?.value ?? tz;
  return `${m}/${d}/${y} at 5:00 p.m. ${abbr}`;
}

// ---- Rule 3: the revised-LE clock and the (e)(4)(ii) receipt limit -----------------------
export interface RevisedLeAssessment {
  readonly due_on: PlainDate; readonly due_at: string; readonly latest_receipt_on: PlainDate | null; readonly mailbox_presumption_ok: boolean | null; readonly revised_le_permitted: boolean; readonly reflected_on: "le" | "cd"; readonly reason: string;
}
/** `revised_le_due = addBusinessDays(locked_on, 3, creditor)` end of day, creditor time zone — general business days, "the calendar is data". */
export function revisedLeDue(lockedOn: PlainDate, cal: Calendar = creditor, tz: string = CREDITOR_TZ): { due_on: PlainDate; due_at: string } {
  const due_on = addBusinessDays(lockedOn, REVISED_LE_BUSINESS_DAYS, cal);
  return { due_on, due_at: toIso(zonedEpochMs(due_on, "23:59", tz)) };
}
/** §1026.19(e)(4)(ii): the consumer must receive a revised LE ≥ 4 specific business days before consummation, and none may issue on/after the CD date. */
export function assessRevisedLe(i: { locked_at: string; consummation_on: PlainDate | null; cd_provided_at: string | null; delivery_in_person_or_confirmed?: boolean; cal?: Calendar; tz?: string }): RevisedLeAssessment {
  const tz = i.tz ?? CREDITOR_TZ; const lockedOn = civilDate(i.locked_at, tz); const due = revisedLeDue(lockedOn, i.cal ?? creditor, tz);
  const latest = i.consummation_on ? addBusinessDays(i.consummation_on, -CONSUMMATION_RECEIPT_LIMIT_SBD, regzSpecific) : null;
  if (i.cd_provided_at && Date.parse(i.locked_at) >= Date.parse(i.cd_provided_at)) return { ...due, latest_receipt_on: latest, mailbox_presumption_ok: null, revised_le_permitted: false, reflected_on: "cd", reason: `§1026.19(e)(4)(ii): locked ${lockedOn} on/after the CD (${civilDate(i.cd_provided_at, tz)}) — terms go on the CD/corrected CD (25.2)` };
  if (latest && lockedOn > latest) return { ...due, latest_receipt_on: latest, mailbox_presumption_ok: false, revised_le_permitted: false, reflected_on: "cd", reason: `§1026.19(e)(4)(ii): latest receipt ${latest} is already past — terms go on the CD` };
  const mailboxOk = latest === null ? null : addBusinessDays(lockedOn, 3, regzSpecific) <= latest;
  return { ...due, latest_receipt_on: latest, mailbox_presumption_ok: mailboxOk, revised_le_permitted: true, reflected_on: "le", reason: mailboxOk === false && !i.delivery_in_person_or_confirmed ? "mailbox presumption cannot land in time: e-deliver with confirmed receipt" : "revised LE within 3 creditor business days" };
}

// ---- Rule 6 / worked example 2(b): APR estimate for the late-lock warning ------------------
/** APR to three decimals from the note rate and the prepaid finance charges (points): the rate at which the amount financed amortizes to the note's P&I (Reg Z Appendix J, actuarial; bisection on thousandths). */
export function aprEstimatePct(loanAmountCents: Cents, noteRatePct: string, prepaidFinanceChargeCents: Cents, termMonths = 360): string {
  const payment = levelPayment(loanAmountCents, ratePercent(noteRatePct), termMonths);
  const financed = loanAmountCents - prepaidFinanceChargeCents; if (financed <= 0n) throw new RangeError("amount financed must be positive");
  let lo = 0, hi = 30_000;   // thousandths of a percent
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); const pm = levelPayment(financed, ratePercent(`${Math.floor(mid / 1000)}.${String(mid % 1000).padStart(3, "0")}`), termMonths); if (pm < payment) lo = mid; else hi = mid; }
  return `${Math.floor(hi / 1000)}.${String(hi % 1000).padStart(3, "0")}`;
}
export interface LateLockWarning { readonly apr_before_pct: string; readonly apr_after_pct: string; readonly apr_change_x1000: number; readonly exceeds_apr_tolerance: boolean; readonly earliest_consummation_on: PlainDate; readonly closing_moves: boolean; readonly text: string; }
/** The borrower is warned before a lock that late: a corrected CD whose APR moves > 1/8 point restarts the 3-specific-business-day wait (25.2 owns the computation; this process only warns). */
export function lateLockWarning(i: { loan_amount_cents: Cents; before: { note_rate_pct: string; points_cents: Cents }; after: { note_rate_pct: string; points_cents: Cents }; corrected_cd_received_on: PlainDate; scheduled_consummation_on: PlainDate; cal?: Calendar }): LateLockWarning {
  const apr_before_pct = aprEstimatePct(i.loan_amount_cents, i.before.note_rate_pct, i.before.points_cents), apr_after_pct = aprEstimatePct(i.loan_amount_cents, i.after.note_rate_pct, i.after.points_cents);
  const x = (s: string) => Math.round(Number(s) * 1000); const apr_change_x1000 = x(apr_after_pct) - x(apr_before_pct);
  const exceeds = Math.abs(apr_change_x1000) > APR_TOLERANCE_X1000;
  const dayAfterWait = addDays(addBusinessDays(i.corrected_cd_received_on, CD_WAITING_PERIOD_SBD, regzSpecific), 1);
  const earliest = exceeds ? rollForward(dayAfterWait, i.cal ?? creditor) : i.scheduled_consummation_on;
  const closing_moves = earliest > i.scheduled_consummation_on;
  return { apr_before_pct, apr_after_pct, apr_change_x1000, exceeds_apr_tolerance: exceeds, earliest_consummation_on: earliest, closing_moves,
    text: closing_moves ? `Locking today moves your closing to ${earliest}: the corrected Closing Disclosure changes the APR by more than 1/8 percentage point (${apr_before_pct}% → ${apr_after_pct}%), which restarts the three-business-day waiting period.` : "Locking today does not move your closing date." };
}

// ---- Rule 11 / guardrails: request → MLO approval → execution -------------------------------
export interface GuardrailResult { readonly code: string; readonly ok: boolean; readonly detail: string; }
export interface LockRequestFacts { readonly le_loan_amount_cents: Cents; readonly eligible_products: readonly string[]; readonly denial_open: boolean; readonly intent: IntentRecord | null; readonly property_state: string; }
export function runLockGuardrails(q: PricingQuote, pricing: PricingPort, at: string, f: LockRequestFacts): GuardrailResult[] {
  const tolerance = f.le_loan_amount_cents / 100n;   // loan amount within 1 % of the LE's
  const diff = q.loan_amount_cents > f.le_loan_amount_cents ? q.loan_amount_cents - f.le_loan_amount_cents : f.le_loan_amount_cents - q.loan_amount_cents;
  return [
    { code: "rate_sheet_fresh", ok: quoteIsFresh(q, pricing, at), detail: `quote on ${q.rate_sheet_id} at ${q.quoted_at}; sheet in force ${pricing.rateSheetAt(at).rate_sheet_id}` },
    { code: "product_eligible", ok: f.eligible_products.length === 0 || f.eligible_products.includes(q.product_code), detail: `product ${q.product_code}` },
    { code: "loan_amount_within_le", ok: diff <= tolerance, detail: `quote ${q.loan_amount_cents} vs LE ${f.le_loan_amount_cents}` },
    { code: "no_denial_in_flight", ok: !f.denial_open, detail: f.denial_open ? "open decisions.kind=denial" : "none" },
    { code: "intent_recorded", ok: !!f.intent && f.intent.valid && f.intent.withdrawn_at === null, detail: f.intent ? `intent ${f.intent.intent_id}` : "no valid intent (rule 1 / open question 1: the agent records the intent first)" },
    { code: "state_variant", ok: true, detail: `state_agreement_variant=${stateAgreementVariant(f.property_state) ?? "none"}` },
  ];
}
export interface LockRequestInput { readonly application_id: string; readonly quote: PricingQuote; readonly requested_at: string; readonly borrower_statement: string; readonly property_state: string; readonly facts: LockRequestFacts; readonly pricing: PricingPort; readonly lineage_id?: string; readonly recorded_by?: string; readonly time_zone?: string; }
export interface LockRequestResult { readonly lock: Lock; readonly guardrails: GuardrailResult[]; readonly events: DomainEvent[]; readonly quote_refreshed: boolean; readonly stale_quote_id: string | null; }
const newLock = (i: LockRequestInput, q: PricingQuote, superseded: readonly string[]): Lock => ({
  lock_id: randomUUID(), application_id: i.application_id, lineage_id: i.lineage_id ?? randomUUID(), version: 1, kind: "initial", supersedes_lock_id: null, status: "pending_mlo_approval", requested_at: i.requested_at, quote: q, quote_id: q.quote_id, quote_id_fnma: q.quote_id_fnma,
  mlo_approval_escalation_id: null, approved_at: null, mlo_nmlsr_id: null, locked_at: null, rate_set_date: null, note_rate: q.note_rate_pct, price: q.price_pct, points_cents: pointsCents(q.loan_amount_cents, q.points_pct), lender_credit_cents: pointsCents(q.loan_amount_cents, q.lender_credit_pct),
  lock_period_days: q.lock_period_days, expires_on: null, expires_at: null, expiry_roll_applied: false, time_zone: i.time_zone ?? CREDITOR_TZ, product_code: q.product_code, loan_amount_cents: q.loan_amount_cents, worst_case_pricing_applied: false, extension_fee_cents: 0n, extension_payer: null, float_down_fee_cents: 0n,
  commitment_id: null, revised_le_disclosure_id: null, state_agreement_variant: stateAgreementVariant(i.property_state), property_state: i.property_state, cancelled_reason: null, ny_expiry_notice_required: false, borrower_statement: i.borrower_statement, superseded_quote_ids: superseded, recorded_by: i.recorded_by ?? "agent:pricing" });
/**
 * A lock request: guardrails run first. A stale rate sheet (rule "never execute at a stale price") returns the terms
 * (`lock.rejected{reason=quote_expired}` satisfies the SLA row for that request), re-prices on the sheet in force and
 * opens a fresh request; the caller opens the MLO escalation for the request that stands.
 */
export function requestLock(events: EventStore, i: LockRequestInput, actor: Actor = PRICING_AGENT): LockRequestResult {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_statement, "borrower_statement"); nonEmpty(i.property_state, "property_state"); isoOrThrow(i.requested_at, "requested_at");
  const out: DomainEvent[] = [];
  const request = (q: PricingQuote, superseded: readonly string[]): Lock => {
    const lock = newLock(i, q, superseded);
    out.push(emit(events, i.application_id, "lock.requested", { lock_id: lock.lock_id, lineage_id: lock.lineage_id, version: lock.version, quote_id: q.quote_id, rate_sheet_id: q.rate_sheet_id, requested_at: i.requested_at, note_rate: q.note_rate_pct, price: q.price_pct, lock_period_days: q.lock_period_days }, i.requested_at, actor));
    return lock;
  };
  let guardrails = runLockGuardrails(i.quote, i.pricing, i.requested_at, i.facts);
  const hard = guardrails.filter((g) => !g.ok && g.code !== "rate_sheet_fresh");
  if (hard.length) throw new LockRefused("LOCK_GUARDRAIL", "21.4 state machine guards", hard.map((g) => `${g.code}: ${g.detail}`).join("; "));
  let lock = request(i.quote, []);
  let refreshed = false, stale: string | null = null;
  if (!guardrails[0]!.ok) {
    out.push(emit(events, i.application_id, "lock.rejected", { lock_id: lock.lock_id, reason: "quote_expired", quote_id: i.quote.quote_id, detail: guardrails[0]!.detail }, i.requested_at, actor));
    const fresh = i.pricing.price({ ...i.quote, quote_id_fnma: null }, i.requested_at);
    stale = i.quote.quote_id; refreshed = true;
    lock = { ...request(fresh, [i.quote.quote_id]), lineage_id: lock.lineage_id };
    guardrails = runLockGuardrails(fresh, i.pricing, i.requested_at, i.facts);
  }
  return { lock, guardrails, events: out, quote_refreshed: refreshed, stale_quote_id: stale };
}
/** MLO of record approval (SAFE Act "offers or negotiates terms"): only the quote the request stands on, only while it is fresh — otherwise `quote_expired`. */
export function approveLock(events: EventStore, lock: Lock, a: { quote_id: string; mlo_nmlsr_id: string; approved_at: string; pricing: PricingPort }, actor: Actor = { kind: "human", id: "mlo", role: "mlo_of_record" }): { lock: Lock; event: DomainEvent } {
  nonEmpty(a.mlo_nmlsr_id, "mlo_nmlsr_id"); isoOrThrow(a.approved_at, "approved_at");
  if (lock.status !== "pending_mlo_approval") throw new LockRefused("LOCK_STATE", "21.4 state machine", `lock ${lock.lock_id} is ${lock.status}`);
  if (a.quote_id !== lock.quote_id || !quoteIsFresh(lock.quote, a.pricing, a.approved_at)) {
    const why = a.quote_id !== lock.quote_id ? `approval names quote ${a.quote_id}; the request stands on ${lock.quote_id} (superseded: ${lock.superseded_quote_ids.join(",") || "none"})` : `quote ${lock.quote_id} lapsed (rate sheet ${lock.quote.rate_sheet_id} superseded or TTL passed)`;
    emit(events, lock.application_id, "lock.rejected", { lock_id: lock.lock_id, reason: "quote_expired", quote_id: a.quote_id, detail: why }, a.approved_at, actor);
    throw new LockRefused("quote_expired", "21.4 rule 11 / edge case: never execute at a stale price", why);
  }
  const next: Lock = { ...lock, approved_at: a.approved_at, mlo_nmlsr_id: a.mlo_nmlsr_id };
  return { lock: next, event: emit(events, lock.application_id, "lock.approved", { lock_id: lock.lock_id, quote_id: lock.quote_id, mlo_nmlsr_id: a.mlo_nmlsr_id, approved_at: a.approved_at }, a.approved_at, actor) };
}
/** MLO returns the terms (`lock.rejected{reason=mlo_returned}`): the SLA row is satisfied without a lock. */
export function rejectLock(events: EventStore, lock: Lock, r: { reason: string; at: string }, actor: Actor = { kind: "human", id: "mlo", role: "mlo_of_record" }): { lock: Lock; event: DomainEvent } {
  const next: Lock = { ...lock, status: "quote_expired" };
  return { lock: next, event: emit(events, lock.application_id, "lock.rejected", { lock_id: lock.lock_id, reason: "mlo_returned", detail: r.reason }, r.at, actor) };
}

export type CcKind = "rate_lock" | "borrower_request";
export interface ChangedCircumstance {
  readonly cc_id: string; readonly application_id: string; readonly kind: CcKind; readonly basis: "C" | "D"; readonly discovered_at: string; readonly information_received_at: string; readonly source_event_id: string; readonly lock_id: string;
  readonly narrative: string; readonly revised_le_due_at: string; readonly revised_le_due_on: PlainDate; readonly reflected_on: "le" | "cd"; readonly revised_le_disclosure_id: string | null; readonly valid: true; readonly affected_amount_cents: Cents; readonly recorded_by: string;
}
export interface ExecuteInput { readonly executed_at: string; readonly cal?: Calendar; readonly consummation_on?: PlainDate | null; readonly cd_provided_at?: string | null; readonly intent: IntentRecord | null; readonly denial_open?: boolean; readonly recorded_by?: string; }
export interface ExecuteResult { readonly lock: Lock; readonly event: DomainEvent; readonly changed_circumstance: ChangedCircumstance; readonly cc_event: DomainEvent; readonly revised_le: RevisedLeAssessment; readonly expiry: LockExpiry; readonly ny_window: NyNoticeWindow | null; }
const ccFor = (events: EventStore, lock: Lock, kind: CcKind, source: DomainEvent, at: string, assessment: RevisedLeAssessment, narrative: string, amount: Cents, actor: Actor): { cc: ChangedCircumstance; event: DomainEvent } => {
  const cc: ChangedCircumstance = { cc_id: randomUUID(), application_id: lock.application_id, kind, basis: kind === "rate_lock" ? "D" : "C", discovered_at: at, information_received_at: at, source_event_id: source.id, lock_id: lock.lock_id, narrative,
    revised_le_due_at: assessment.due_at, revised_le_due_on: assessment.due_on, reflected_on: assessment.reflected_on, revised_le_disclosure_id: null, valid: true, affected_amount_cents: amount, recorded_by: lock.recorded_by };
  // `valid=true` + `information_received_on` are what 21.5's REGZ_1026_19E4_REVISED_LE_3BD (basis C) arms on; basis D rows arm 21.4's own REGZ_1026_19E3IVD row.
  const event = emit(events, lock.application_id, "changed_circumstance.recorded", { cc_id: cc.cc_id, kind, basis: cc.basis, valid: cc.valid, discovered_at: at, information_received_at: cc.information_received_at, information_received_on: civilDate(cc.information_received_at), revised_le_due_at: cc.revised_le_due_at, revised_le_due_on: cc.revised_le_due_on, reflected_on: cc.reflected_on, lock_id: lock.lock_id, source_event_id: source.id, affected_amount_cents: String(amount), narrative }, at, actor);
  return { cc, event };
};
/**
 * Execution at `locked_at` (rule 10: `rate_set_date` = the creditor's civil date; rule 4: expiry; rule 3: the 3-day
 * clock and the (e)(4)(ii) bar). Guards: MLO approval, a valid intent for the current LE, no denial in flight.
 * Emits `lock.executed` (the canonical event) and the `changed_circumstances{kind='rate_lock'}` row 21.5 consumes.
 */
export function executeLock(events: EventStore, lock: Lock, i: ExecuteInput, actor: Actor = PRICING_AGENT): ExecuteResult {
  isoOrThrow(i.executed_at, "executed_at");
  if (lock.status !== "pending_mlo_approval") throw new LockRefused("LOCK_STATE", "21.4 state machine", `lock ${lock.lock_id} is ${lock.status}`);
  if (!lock.approved_at || !lock.mlo_nmlsr_id) throw new LockRefused("MLO_APPROVAL_REQUIRED", "12 CFR 1008.103 / Appendix A: presenting particular loan terms; 21.4 rule 11", "no mlo_of_record approval on the lock");
  if (!i.intent || !i.intent.valid || i.intent.withdrawn_at !== null) throw new LockRefused("INTENT_REQUIRED", "21.4 state machine guard: executed requires a valid intent_records row", "record the intent first (open question 1)");
  if (i.denial_open) throw new LockRefused("DENIAL_IN_FLIGHT", "21.4 state machine guard", "an open decisions.kind=denial blocks execution");
  const cal = i.cal ?? creditor; const rate_set_date = civilDate(i.executed_at, lock.time_zone);
  const expiry = lockExpiry(rate_set_date, lock.lock_period_days, cal, lock.time_zone);
  const revised_le = assessRevisedLe({ locked_at: i.executed_at, consummation_on: i.consummation_on ?? null, cd_provided_at: i.cd_provided_at ?? null, cal, tz: lock.time_zone });
  const ny_window = lock.property_state === "NY" ? nyExpiryNoticeWindow(rate_set_date, expiry.expires_on, cal) : null;
  const next: Lock = { ...lock, status: "executed", locked_at: i.executed_at, rate_set_date, expires_on: expiry.expires_on, expires_at: expiry.expires_at, expiry_roll_applied: expiry.expiry_roll_applied, ny_expiry_notice_required: ny_window?.required ?? false, recorded_by: i.recorded_by ?? lock.recorded_by };
  const event = emit(events, lock.application_id, "lock.executed", { lock_id: next.lock_id, lineage_id: next.lineage_id, version: next.version, kind: next.kind, note_rate: next.note_rate, price: next.price, points_cents: String(next.points_cents), lender_credit_cents: String(next.lender_credit_cents),
    lock_period_days: next.lock_period_days, expires_at: next.expires_at, expires_on: next.expires_on, expiry_roll_applied: next.expiry_roll_applied, rate_set_date, locked_at: i.executed_at, quote_id: next.quote_id, quote_id_fnma: next.quote_id_fnma, rate_sheet_id: next.quote.rate_sheet_id, llpa_version: next.quote.llpa_version,
    mlo_nmlsr_id: next.mlo_nmlsr_id, property_state: next.property_state, state_agreement_variant: next.state_agreement_variant, ny_expiry_notice_required: next.ny_expiry_notice_required, revised_le_due_at: revised_le.due_at, revised_le_reflected_on: revised_le.reflected_on, loan_amount_cents: String(next.loan_amount_cents), product_code: next.product_code }, i.executed_at, actor);
  const { cc, event: cc_event } = ccFor(events, next, "rate_lock", event, i.executed_at, revised_le, `interest rate locked ${rate_set_date} at ${next.note_rate}% / ${next.price} (§1026.19(e)(3)(iv)(D)); ${revised_le.reason}`, next.points_cents, actor);
  return { lock: next, event, changed_circumstance: cc, cc_event, revised_le, expiry, ny_window };
}
/** Confirmation delivered (`NTC_SM_RATE_LOCK_CONFIRMATION` sent) → `confirmed`. */
export function confirmLock(lock: Lock): Lock { if (lock.status !== "executed") throw new LockRefused("LOCK_STATE", "21.4 state machine", `lock ${lock.lock_id} is ${lock.status}`); return { ...lock, status: "confirmed" }; }
const isLive = (lock: Lock): boolean => lock.status === "executed" || lock.status === "confirmed" || lock.status === "expired";

// ---- Rule 6: extensions -----------------------------------------------------------------
/** Partner schedule (open question 3): 12.5 bps per 7-day block, blocks rounded half-up with a one-block minimum — 8 days → 12.5 bps ($700.00 on $560,000), 15 days → 25 bps. */
export function extensionBpsX10(days: number): bigint { if (!Number.isInteger(days) || days <= 0) throw new RangeError("extension days must be a positive integer"); const blocks = BigInt(Math.max(1, Math.floor((days * 2 + 7) / 14))); return EXTENSION_BPS_PER_7_DAYS_X10 * blocks; }
export const extensionFeeCents = (loanAmountCents: Cents, days: number): Cents => divRound(loanAmountCents * extensionBpsX10(days), 100_000n, "HALF_UP");
export const extensionPayer = (attribution: DelayAttribution): ExtensionPayer => (attribution === "borrower" ? "borrower" : "lender_delay");
export interface ExtensionQuote { readonly days: number; readonly fee_cents: Cents; readonly payer: ExtensionPayer; readonly consumer_charge_cents: Cents; readonly bps_x10: bigint; readonly new_expires_on: PlainDate; readonly new_expires_at: string; readonly revised_disclosure: "none" | "revised_le" | "corrected_cd"; }
export function quoteExtension(lock: Lock, i: { new_closing_on: PlainDate; delay_attribution: DelayAttribution; cd_provided_at?: string | null; cal?: Calendar }): ExtensionQuote {
  if (!lock.expires_on) throw new LockRefused("LOCK_STATE", "21.4 state machine", "extension needs an executed lock");
  const days = daysBetween(lock.expires_on, i.new_closing_on); if (days <= 0) throw new RangeError(`closing ${i.new_closing_on} is inside the lock (expires ${lock.expires_on}); no extension needed`);
  const payer = extensionPayer(i.delay_attribution); const fee_cents = extensionFeeCents(lock.loan_amount_cents, days);
  const newOn = rollForward(i.new_closing_on, i.cal ?? creditor);
  return { days, fee_cents, payer, consumer_charge_cents: payer === "borrower" ? fee_cents : 0n, bps_x10: extensionBpsX10(days), new_expires_on: newOn, new_expires_at: toIso(zonedEpochMs(newOn, LOCK_EXPIRY_HHMM, lock.time_zone)),
    revised_disclosure: payer !== "borrower" ? "none" : i.cd_provided_at ? "corrected_cd" : "revised_le" };
}
export interface ExtendInput { readonly requested_at: string; readonly new_closing_on: PlainDate; readonly delay_attribution: DelayAttribution; readonly cd_provided_at?: string | null; readonly consummation_on?: PlainDate | null; readonly cal?: Calendar; readonly mlo_nmlsr_id?: string | null; }
export interface ExtendResult { readonly lock: Lock; readonly extension: LockExtension; readonly quote: ExtensionQuote; readonly event: DomainEvent; readonly changed_circumstance: ChangedCircumstance | null; readonly cc_event: DomainEvent | null; }
/**
 * Lender-caused delay (MA industry letter, national policy): honored at the locked terms, fee borne by the lender, no
 * consumer charge and no revised LE/CD. Borrower-caused: borrower pays → (e)(3)(iv)(C) `changed_circumstances{kind='borrower_request'}`,
 * revised LE within 3 creditor business days or — after the CD — a corrected CD (25.2).
 */
export function extendLock(events: EventStore, lock: Lock, i: ExtendInput, actor: Actor = PRICING_AGENT): ExtendResult {
  isoOrThrow(i.requested_at, "requested_at");
  if (!isLive(lock) || !lock.expires_on) throw new LockRefused("LOCK_STATE", "21.4 state machine", `lock ${lock.lock_id} is ${lock.status}`);
  const quote = quoteExtension(lock, { new_closing_on: i.new_closing_on, delay_attribution: i.delay_attribution, cd_provided_at: i.cd_provided_at ?? null, ...(i.cal ? { cal: i.cal } : {}) });
  if (quote.payer === "borrower" && !i.mlo_nmlsr_id) throw new LockRefused("MLO_APPROVAL_REQUIRED", "21.4 AI design: mlo_of_record approves every borrower-paid extension", "borrower-paid extension needs the MLO's NMLSR ID");
  const extension: LockExtension = { extension_id: randomUUID(), lock_id: lock.lock_id, days: quote.days, fee_cents: quote.fee_cents, payer: quote.payer, granted_at: i.requested_at, new_expires_on: quote.new_expires_on, new_expires_at: quote.new_expires_at, delay_attribution: i.delay_attribution };
  const next: Lock = { ...lock, status: lock.status === "expired" ? "confirmed" : lock.status, expires_on: quote.new_expires_on, expires_at: quote.new_expires_at, extension_fee_cents: lock.extension_fee_cents + quote.fee_cents, extension_payer: quote.payer };
  const event = emit(events, lock.application_id, "lock.extended", { lock_id: lock.lock_id, lineage_id: lock.lineage_id, extension_id: extension.extension_id, days: quote.days, fee_cents: String(quote.fee_cents), payer: quote.payer, consumer_charge_cents: String(quote.consumer_charge_cents), delay_attribution: i.delay_attribution,
    note_rate: lock.note_rate, price: lock.price, previous_expires_on: lock.expires_on, new_expires_on: quote.new_expires_on, new_expires_at: quote.new_expires_at, expires_on: quote.new_expires_on, expires_at: quote.new_expires_at, rate_set_date: lock.rate_set_date, revised_disclosure: quote.revised_disclosure }, i.requested_at, actor);
  if (quote.payer !== "borrower") return { lock: next, extension, quote, event, changed_circumstance: null, cc_event: null };
  const assessment = assessRevisedLe({ locked_at: i.requested_at, consummation_on: i.consummation_on ?? null, cd_provided_at: i.cd_provided_at ?? null, ...(i.cal ? { cal: i.cal } : {}), tz: lock.time_zone });
  const { cc, event: cc_event } = ccFor(events, next, "borrower_request", event, i.requested_at, assessment, `borrower-requested ${quote.days}-day lock extension (§1026.19(e)(3)(iv)(C)); fee ${quote.fee_cents} cents; ${assessment.reason}`, quote.fee_cents, actor);
  return { lock: next, extension, quote, event, changed_circumstance: cc, cc_event };
}

// ---- Rules 7–8: relock and float-down (new lock versions) ----------------------------------
const minPrice = (a: string, b: string): string => (Number(a) <= Number(b) ? a : b);
export interface RelockInput { readonly relocked_at: string; readonly quote: PricingQuote; readonly lender_delay?: boolean; readonly cal?: Calendar; readonly mlo_nmlsr_id: string; readonly intent: IntentRecord | null; readonly cd_provided_at?: string | null; readonly consummation_on?: PlainDate | null; }
/** `relock_price = min(current_price, original_price)` (worst-case) unless the lender-delay rule applies; a new version → `lock.relocked` → revised LE within 3 creditor business days from the relock date. */
export function relock(events: EventStore, lock: Lock, i: RelockInput, actor: Actor = PRICING_AGENT): ExecuteResult & { superseded: Lock } {
  isoOrThrow(i.relocked_at, "relocked_at"); nonEmpty(i.mlo_nmlsr_id, "mlo_nmlsr_id");
  if (!isLive(lock)) throw new LockRefused("LOCK_STATE", "21.4 state machine", `lock ${lock.lock_id} is ${lock.status}`);
  const worst = !i.lender_delay; const price = worst ? minPrice(i.quote.price_pct, lock.price) : lock.price; const rate = worst ? i.quote.note_rate_pct : lock.note_rate;
  const q: PricingQuote = { ...i.quote, price_pct: price, note_rate_pct: rate };
  const draft: Lock = { ...lock, lock_id: randomUUID(), version: lock.version + 1, kind: "relock", supersedes_lock_id: lock.lock_id, status: "pending_mlo_approval", requested_at: i.relocked_at, quote: q, quote_id: q.quote_id, quote_id_fnma: q.quote_id_fnma, approved_at: i.relocked_at, mlo_nmlsr_id: i.mlo_nmlsr_id,
    locked_at: null, rate_set_date: null, note_rate: rate, price, points_cents: pointsCents(q.loan_amount_cents, q.points_pct), lender_credit_cents: pointsCents(q.loan_amount_cents, q.lender_credit_pct), lock_period_days: q.lock_period_days, loan_amount_cents: q.loan_amount_cents, worst_case_pricing_applied: worst && price !== i.quote.price_pct,
    expires_on: null, expires_at: null, expiry_roll_applied: false, extension_fee_cents: 0n, extension_payer: null, revised_le_disclosure_id: null, cancelled_reason: null };
  const r = executeLock(events, draft, { executed_at: i.relocked_at, ...(i.cal ? { cal: i.cal } : {}), intent: i.intent, cd_provided_at: i.cd_provided_at ?? null, consummation_on: i.consummation_on ?? null }, actor);
  const relockEvent = emit(events, lock.application_id, "lock.relocked", { lock_id: r.lock.lock_id, lineage_id: lock.lineage_id, supersedes_lock_id: lock.lock_id, version: r.lock.version, note_rate: r.lock.note_rate, price: r.lock.price, worst_case_pricing_applied: r.lock.worst_case_pricing_applied,
    expires_on: r.lock.expires_on, expires_at: r.lock.expires_at, rate_set_date: r.lock.rate_set_date, commitment_id: lock.commitment_id, key_data_change: "note_rate/price" }, i.relocked_at, actor);
  return { ...r, lock: { ...r.lock, commitment_id: lock.commitment_id }, event: relockEvent, superseded: { ...lock, status: "superseded", cancelled_reason: "superseded" } };
}
export interface FloatDownInput { readonly applied_at: string; readonly market_rate_pct: string; readonly mlo_nmlsr_id: string; readonly intent: IntentRecord | null; readonly cal?: Calendar; readonly lineage_float_downs: number; readonly cd_provided_at?: string | null; readonly consummation_on?: PlainDate | null; readonly pricing: PricingPort; }
/** One float-down per lineage: `new_rate = market + margin`, fee 25 bps; `lock.float_down.applied` → revised LE (a decrease never raises a tolerance issue; 25.1's APR test still runs). */
export function applyFloatDown(events: EventStore, lock: Lock, i: FloatDownInput, actor: Actor = PRICING_AGENT): ExecuteResult & { superseded: Lock } {
  isoOrThrow(i.applied_at, "applied_at"); nonEmpty(i.mlo_nmlsr_id, "mlo_nmlsr_id");
  if (i.lineage_float_downs > 0) throw new LockRefused("FLOAT_DOWN_ONCE", "21.4 rule 8 / open question 3: one float-down per lineage", "the lineage already used its float-down");
  const newRateX1000 = Math.round(Number(i.market_rate_pct) * 1000) + Math.round(Number(FLOAT_DOWN_MARGIN_PCT) * 1000);
  if (newRateX1000 >= Math.round(Number(lock.note_rate) * 1000)) throw new LockRefused("FLOAT_DOWN_NOT_LOWER", "21.4 rule 8", `market ${i.market_rate_pct} + margin is not below the locked ${lock.note_rate}`);
  const new_rate = `${Math.floor(newRateX1000 / 1000)}.${String(newRateX1000 % 1000).padStart(3, "0")}`;
  const q = i.pricing.price({ ...lock.quote, note_rate_pct: new_rate, quote_id_fnma: null }, i.applied_at);
  const fee = divRound(lock.loan_amount_cents * FLOAT_DOWN_FEE_BPS, 10_000n, "HALF_UP");
  const draft: Lock = { ...lock, lock_id: randomUUID(), version: lock.version + 1, kind: "float_down", supersedes_lock_id: lock.lock_id, status: "pending_mlo_approval", requested_at: i.applied_at, quote: q, quote_id: q.quote_id, quote_id_fnma: null, approved_at: i.applied_at, mlo_nmlsr_id: i.mlo_nmlsr_id, locked_at: null, rate_set_date: null,
    note_rate: new_rate, price: q.price_pct, float_down_fee_cents: fee, expires_on: null, expires_at: null, expiry_roll_applied: false, revised_le_disclosure_id: null, cancelled_reason: null };
  const r = executeLock(events, draft, { executed_at: i.applied_at, ...(i.cal ? { cal: i.cal } : {}), intent: i.intent, cd_provided_at: i.cd_provided_at ?? null, consummation_on: i.consummation_on ?? null }, actor);
  const fdEvent = emit(events, lock.application_id, "lock.float_down.applied", { lock_id: r.lock.lock_id, lineage_id: lock.lineage_id, supersedes_lock_id: lock.lock_id, version: r.lock.version, note_rate: new_rate, float_down_fee_cents: String(fee), expires_on: r.lock.expires_on, expires_at: r.lock.expires_at, rate_set_date: r.lock.rate_set_date, commitment_id: lock.commitment_id, key_data_change: "note_rate" }, i.applied_at, actor);
  return { ...r, lock: { ...r.lock, commitment_id: lock.commitment_id }, event: fdEvent, superseded: { ...lock, status: "superseded", cancelled_reason: "superseded" } };
}

// ---- Expiry playbook (SM_LOCK_EXPIRY_WARN_7 / SM_LOCK_EXPIRY_DEADLINE) ----------------------
export function warnExpiry(events: EventStore, lock: Lock, at: string, closingScheduledOn: PlainDate | null, actor: Actor = PRICING_AGENT): { event: DomainEvent; closing_inside_lock: boolean | null } {
  if (!lock.expires_at || !lock.expires_on) throw new LockRefused("LOCK_STATE", "21.4 state machine", "no expiry on the lock");
  const inside = closingScheduledOn ? closingScheduledOn <= lock.expires_on : null;
  return { event: emit(events, lock.application_id, "lock.expiry.warned", { lock_id: lock.lock_id, expires_at: lock.expires_at, expires_on: lock.expires_on, closing_scheduled_on: closingScheduledOn, closing_inside_lock: inside, escalate_to_closing_scheduler: closingScheduledOn === null }, at, actor), closing_inside_lock: inside };
}
export function expireLock(events: EventStore, lock: Lock, at: string, actor: Actor = PRICING_AGENT): { lock: Lock; event: DomainEvent; playbook: string[] } {
  if (!lock.expires_at) throw new LockRefused("LOCK_STATE", "21.4 state machine", "no expiry on the lock");
  if (Date.parse(at) < Date.parse(lock.expires_at)) throw new LockRefused("NOT_EXPIRED", "21.4 timers: SM_LOCK_EXPIRY_DEADLINE is the expiration instant", `lock expires ${lock.expires_at}`);
  const next: Lock = { ...lock, status: "expired" };
  return { lock: next, event: emit(events, lock.application_id, "lock.expired", { lock_id: lock.lock_id, expires_at: lock.expires_at, expires_on: lock.expires_on }, at, actor), playbook: ["extension quote (borrower-caused delay: borrower's cost)", "relock at worst-case pricing", "honor at locked terms (lender/agent delay — MA rule, national policy)"] };
}
/** Application denied / withdrawn / product ineligible: `lock.cancelled{reason}`; NY/NJ lock fees refund as a ledger reversal; 29.1 records fallout without pair-off. */
export function cancelLock(events: EventStore, ledger: Ledger, lock: Lock, i: { reason: CancelReason; at: string; lock_fee_ledger_set_id?: string | null; detail?: string }, actor: Actor = PRICING_AGENT): { lock: Lock; event: DomainEvent; refund: EntrySet | null } {
  isoOrThrow(i.at, "at");
  if (lock.status === "cancelled" || lock.status === "consummated" || lock.status === "superseded") throw new LockRefused("LOCK_STATE", "21.4 state machine", `lock ${lock.lock_id} is ${lock.status}`);
  const refund = i.lock_fee_ledger_set_id ? ledger.reverse(i.lock_fee_ledger_set_id, civilDate(i.at, lock.time_zone), `lock ${lock.lock_id} cancelled (${i.reason}): lock-in fee refunded in full (3 NYCRR 38.6(b)(2); N.J.A.C. 3:1-16.4(c))`, i.at) : null;
  const next: Lock = { ...lock, status: "cancelled", cancelled_reason: i.reason };
  return { lock: next, refund, event: emit(events, lock.application_id, "lock.cancelled", { lock_id: lock.lock_id, lineage_id: lock.lineage_id, reason: i.reason, detail: i.detail ?? null, refund_set_id: refund?.id ?? null, refund_cents: refund ? String(-refund.lines[0]!.amountCents) : "0", commitment_id: lock.commitment_id }, i.at, actor) };
}

// ---- NY 3 NYCRR §38.6(b)(4): the expiration-notice window --------------------------------
export interface NyNoticeWindow { readonly required: boolean; readonly business_days_lock_to_expiry: number; readonly opens_on: PlainDate; readonly closes_on: PlainDate; }
/** Window −20 to −12 creditor business days before `expires_on`, required when the expiry is more than 12 business days from the lock date. */
export function nyExpiryNoticeWindow(lockedOn: PlainDate, expiresOn: PlainDate, cal: Calendar = creditor): NyNoticeWindow {
  const bd = businessDaysBetween(lockedOn, expiresOn, cal);
  return { required: bd > NY_EXPIRY_NOTICE_MIN_BD, business_days_lock_to_expiry: bd, opens_on: addBusinessDays(expiresOn, -NY_EXPIRY_NOTICE_MAX_BD, cal), closes_on: addBusinessDays(expiresOn, -NY_EXPIRY_NOTICE_MIN_BD, cal) };
}
export function assertNyNoticeInWindow(w: NyNoticeWindow, expiresOn: PlainDate, sendOn: PlainDate, cal: Calendar = creditor): { business_days_before_expiry: number } {
  const before = businessDaysBetween(sendOn, expiresOn, cal);
  if (sendOn < w.opens_on || sendOn > w.closes_on) throw new LockRefused("NY_38_6B4_WINDOW", "3 NYCRR 38.6(b)(4): not less than 12 nor more than 20 business days prior to the expiration", `${sendOn} is ${before} business days before ${expiresOn}; window ${w.opens_on}–${w.closes_on}`);
  return { business_days_before_expiry: before };
}

// ---- Rule 9: best-efforts commitment linkage (29.1's adapter; in-process port until it exists) ----
export interface CommitmentRecord { readonly commitment_id: string; readonly commitment_id_fnma: string; readonly lineage_id: string; readonly lock_id: string; readonly application_id: string; readonly type: "best_efforts"; readonly status: "committed" | "modified" | "fallout"; readonly expires_on: PlainDate; readonly executed_at: string; readonly price: string; readonly modifications: number; readonly fallout_reason: string | null; }
export interface CommitmentPort {
  requestBestEfforts(lock: Lock, at: string): CommitmentRecord;
  keyDataChange(lock: Lock, at: string, change: string): CommitmentRecord;
  recordFallout(lineageId: string, reason: CancelReason, at: string): { commitment: CommitmentRecord | null; pair_off_expected: false };
  open(lineageId: string): CommitmentRecord[];
}
/** 29.1-Q1: `expires_on = rollForward(lock.expires_on + 14, fannie)` capped at 90 days (Mon Dec 7, 2026 on the fixture). */
export function commitmentExpiry(lockExpiresOn: PlainDate, lockedOn: PlainDate, cal: Calendar = fannieEt): PlainDate {
  const d = rollForward(addDays(lockExpiresOn, 14), cal); const cap = addDays(lockedOn, 90); return d > cap ? cap : d;
}
/** The best-efforts committing adapter as this process needs it: one commitment per lineage (a second commit on an open lineage is refused — duplicate commitments are a Fannie Mae price adjustment), key-data changes within one business day, fallout without pair-off on withdrawal/declination. */
export class InMemoryCommitmentAdapter implements CommitmentPort {
  private readonly events: EventStore; readonly rows: CommitmentRecord[] = []; private n = 0;
  constructor(events: EventStore) { this.events = events; }
  open(lineageId: string): CommitmentRecord[] { return this.rows.filter((c) => c.lineage_id === lineageId && c.status !== "fallout"); }
  requestBestEfforts(lock: Lock, at: string): CommitmentRecord {
    if (!lock.expires_on || !lock.rate_set_date) throw new LockRefused("LOCK_STATE", "29.1 best efforts: requested on lock.executed", "commitment needs an executed lock");
    if (this.open(lock.lineage_id).length) throw new LockRefused("DUPLICATE_COMMITMENT", "C2-1.2-02 duplicate commitment price adjustment; 21.4 integrations: one commitment per lineage_id", `lineage ${lock.lineage_id} already has an open commitment`);
    const c: CommitmentRecord = { commitment_id: randomUUID(), commitment_id_fnma: `BE-${String(++this.n).padStart(6, "0")}`, lineage_id: lock.lineage_id, lock_id: lock.lock_id, application_id: lock.application_id, type: "best_efforts", status: "committed", expires_on: commitmentExpiry(lock.expires_on, lock.rate_set_date), executed_at: at, price: lock.price, modifications: 0, fallout_reason: null };
    this.rows.push(c);
    emit(this.events, lock.application_id, "commitment.executed", { commitment_id: c.commitment_id, commitment_id_fnma: c.commitment_id_fnma, type: c.type, price: c.price, expires_on: c.expires_on, lineage_id: c.lineage_id, lock_id: lock.lock_id }, at, { kind: "agent", id: "secondary" });
    return c;
  }
  keyDataChange(lock: Lock, at: string, change: string): CommitmentRecord {
    const cur = this.open(lock.lineage_id)[0]; if (!cur) throw new LockRefused("NO_COMMITMENT", "C2-1.2-03", `lineage ${lock.lineage_id} has no open commitment`);
    const next: CommitmentRecord = { ...cur, status: "modified", lock_id: lock.lock_id, price: lock.price, modifications: cur.modifications + 1 };
    this.rows[this.rows.indexOf(cur)] = next;
    emit(this.events, lock.application_id, "commitment.modified", { commitment_id: cur.commitment_id, commitment_id_fnma: cur.commitment_id_fnma, lineage_id: lock.lineage_id, lock_id: lock.lock_id, change, price: lock.price, worst_case_pricing: "fannie_mae_acquisition_price" }, at, { kind: "agent", id: "secondary" });
    return next;
  }
  recordFallout(lineageId: string, reason: CancelReason, at: string): { commitment: CommitmentRecord | null; pair_off_expected: false } {
    const cur = this.open(lineageId)[0] ?? null;
    if (cur) { this.rows[this.rows.indexOf(cur)] = { ...cur, status: "fallout", fallout_reason: reason }; emit(this.events, cur.application_id, "commitment.fallout.recorded", { commitment_id: cur.commitment_id, lineage_id: lineageId, reason, pair_off_expected: false, dpa_exposure_until: addDays(civilDate(at), 30) }, at, { kind: "agent", id: "secondary" }); }
    return { commitment: cur ? this.open(lineageId)[0] ?? { ...cur, status: "fallout", fallout_reason: reason } : null, pair_off_expected: false };
  }
}
export function linkCommitment(events: EventStore, lock: Lock, c: CommitmentRecord, at: string, actor: Actor = PRICING_AGENT): { lock: Lock; event: DomainEvent } {
  const next: Lock = { ...lock, commitment_id: c.commitment_id };
  return { lock: next, event: emit(events, lock.application_id, "lock.commitment.linked", { lock_id: lock.lock_id, lineage_id: lock.lineage_id, commitment_id: c.commitment_id, commitment_id_fnma: c.commitment_id_fnma, expires_on: c.expires_on }, at, actor) };
}

// ---- The revised disclosure that carries the lock terms (21.5 / 25.2, consumed) --------------
export interface ReflectedDisclosure { readonly disclosure_id: string; readonly reflected_on: "le" | "cd"; readonly event: DomainEvent; }
/** `disclosure.le.revised{reason=rate_lock}` (21.5) or, when a revised LE is barred, `disclosure.cd.corrected` / `disclosure.cd.delivered` (25.2) naming the lock → `locks.revised_le_disclosure_id`. */
export function reflectedDisclosure(events: EventStore, lock: Lock): ReflectedDisclosure | null {
  const le = forApp(events, lock.application_id, "disclosure.le.revised").filter((e) => p(e).reason === "rate_lock" && (p(e).lock_id === undefined || p(e).lock_id === lock.lock_id)).at(-1);
  if (le) return { disclosure_id: String(p(le).disclosure_id ?? le.id), reflected_on: "le", event: le };
  const cd = [...forApp(events, lock.application_id, "disclosure.cd.corrected"), ...forApp(events, lock.application_id, "disclosure.cd.delivered")].filter((e) => p(e).lock_id === lock.lock_id || p(e).reflects_lock_id === lock.lock_id).sort((a, b) => a.sequence - b.sequence).at(-1);
  return cd ? { disclosure_id: String(p(cd).disclosure_id ?? cd.id), reflected_on: "cd", event: cd } : null;
}

// ---- Confirmation ("lock agreement") payload -------------------------------------------------
export interface ConfirmationParty { readonly borrower_names: readonly string[]; readonly property_address: string; readonly partner_name: string; readonly mlo_name: string; readonly mlo_nmlsr_id: string; readonly lock_fee_cents?: Cents; readonly commitment_fee_cents?: Cents; }
export function lockConfirmationPayload(lock: Lock, party: ConfirmationParty): Record<string, unknown> {
  if (!lock.expires_on || !lock.expires_at || !lock.rate_set_date) throw new LockRefused("LOCK_STATE", "21.4 state machine", "confirmation needs an executed lock");
  const v = lock.state_agreement_variant;
  return { notice_date: lock.rate_set_date, borrower_names: [...party.borrower_names], property_address: party.property_address, property_state: lock.property_state, partner_name: party.partner_name, product_code: lock.product_code, note_rate_pct: lock.note_rate, price_pct: lock.price, points_cents: lock.points_cents, lender_credit_cents: lock.lender_credit_cents,
    loan_amount_cents: lock.loan_amount_cents, lock_period_days: lock.lock_period_days, locked_on: lock.rate_set_date, expires_on: lock.expires_on, expires_display: expiryDisplay(lock.expires_on, lock.time_zone), time_zone: lock.time_zone, lock_fee_cents: party.lock_fee_cents ?? 0n, commitment_fee_cents: party.commitment_fee_cents ?? 0n,
    extension_terms: "12.5 basis points of the loan amount per 7-day extension; a delay caused by the lender or its agents is extended at the lender's cost", relock_terms: "a relock after expiration is priced at the worse of the original and current price unless the delay was the lender's", float_down_terms: "one float-down per lock at 25 basis points to the market rate plus 0.125 %",
    mlo_name: party.mlo_name, mlo_nmlsr_id: party.mlo_nmlsr_id, variant_ny: v === "NY", variant_nj: v === "NJ", variant_ma: v === "MA", state_agreement_variant: v };
}
