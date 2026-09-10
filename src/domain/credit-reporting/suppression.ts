/**
 * 8.3 Suspend credit reporting — suppression mechanisms, priority resolution
 * and the overlays (NoE bar, bankruptcy, SCRA, disaster, deceased, identity
 * theft, FDCPA gate) applied on top of an 8.1 snapshot.
 */
import { type PlainDate, addDays, daysBetween, endOfMonth, startOfMonth } from "../../kernel/calendar/date.ts";
import { type Cents, levelPayment, monthlyInterest, ratePercent, sumCents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";
import { deriveDelinquency, deriveDofd, phpPosition, setPhp, statusForDays, toPrior } from "./metro2.ts";
import type { AccountStatus, Ccc, Cii, Metro2Snapshot, PriorHistory } from "./types.ts";

export type Mechanism = "delete_account" | "delete_consumer" | "omit_account" | "freeze_status" | "as_if_paid_projection" | "flag_only";

/** Priority (highest first) when several suppressions apply to one consumer (8.3-T14). */
export const MECHANISM_PRIORITY: readonly Mechanism[] = ["delete_account", "delete_consumer", "omit_account", "freeze_status", "as_if_paid_projection", "flag_only"];

export type SuppressionReason =
  | "noe_bar" | "fcra_a1b_inaccuracy" | "bankruptcy" | "scra" | "disaster" | "deceased" | "identity_theft"
  | "fdcpa_gate" | "forbearance" | "cares_accommodation" | "transfer_out_final" | "boarding_unreconciled" | "qc_hold" | "dispute_open" | "courtesy_request";

export interface Suppression {
  readonly reason: SuppressionReason;
  readonly mechanism: Mechanism;
  readonly party_id: string | null;             // null = whole account
  readonly starts_on: PlainDate;
  readonly ends_on: PlainDate | null;
  readonly codes?: readonly string[];           // e.g. ["CII D", "XB"]
  readonly scope?: readonly PlainDate[];        // installment due dates (NoE bar / a1b)
}

export interface Resolution { readonly mechanism: Mechanism; readonly codes: readonly string[]; readonly reasons: readonly SuppressionReason[]; }

export function isActive(s: Suppression, on: PlainDate): boolean {
  return s.starts_on <= on && (s.ends_on === null || on <= s.ends_on);
}

/** Resolve the effective mechanism for one consumer on a date: highest priority wins; codes are the union. */
export function resolveSuppression(active: readonly Suppression[], on: PlainDate, partyId?: string): Resolution | null {
  const live = active.filter((s) => isActive(s, on) && (s.party_id === null || partyId === undefined || s.party_id === partyId));
  if (live.length === 0) return null;
  const mechanism = MECHANISM_PRIORITY.find((m) => live.some((s) => s.mechanism === m))!;
  const codes = [...new Set(live.flatMap((s) => s.codes ?? []))];
  return { mechanism, codes, reasons: live.map((s) => s.reason) };
}

/** A borrower's request not to report is never a suppression (8.3-T12). */
export function courtesyRequest(): { created: false; log: string; response: string } {
  return { created: false, log: "courtesy_request logged; no suppression created", response: "direct-dispute process explained" };
}

// ---- NoE / QWR 60-day bar (rule 1) ------------------------------------------

export interface NoeBar { readonly received_on: PlainDate; readonly scope: readonly PlainDate[]; readonly closed_on?: PlainDate | null; readonly outcome?: "error_found" | "no_error" | null; readonly continuing_disagreement?: boolean; }

/** §1024.35(i)(1): no adverse furnishing for 60 days after receipt. */
export function noeBarEnd(receivedOn: PlainDate): PlainDate { return addDays(receivedOn, 60); }

export function noeBarApplies(bar: NoeBar, transmittedOn: PlainDate): boolean {
  return transmittedOn >= bar.received_on && transmittedOn <= noeBarEnd(bar.received_on);
}

/**
 * Apply the bar at transmission time: scoped installments are treated as paid
 * on their due dates, disputed months render `D`, CCC XB. Outside the bar the
 * actual state is furnished with the closing CCC (XR / XH / XC).
 */
export function applyNoeBar(snapshot: Metro2Snapshot, installments: readonly AppliedInstallment[], bar: NoeBar, transmittedOn: PlainDate, prior: PriorHistory | Metro2Snapshot | null): Metro2Snapshot {
  const scope = new Set(bar.scope);
  if (!noeBarApplies(bar, transmittedOn)) {
    const ccc: Ccc = bar.outcome === "error_found" ? "XR" : bar.outcome === "no_error" ? (bar.continuing_disagreement ? "XC" : "XH") : "XB";
    return { ...snapshot, consumers: snapshot.consumers.map((c) => ({ ...c, ccc })), derivation: [...snapshot.derivation, `noe bar expired ${noeBarEnd(bar.received_on)}; ccc ${ccc}`] };
  }
  const projected = installments.map((i) => scope.has(i.due_date) ? { ...i, satisfied_on: i.due_date, paid_cents: i.amount_cents } : i);
  const dq = deriveDelinquency(projected, snapshot.as_of);
  const terminal = snapshot.final_reported;
  const status: AccountStatus = terminal ? snapshot.account_status : statusForDays(dq.days);
  let php = snapshot.php;
  for (const d of bar.scope) {
    const pos = phpPosition(snapshot.as_of, startOfMonth(d));
    if (pos !== null) php = setPhp(php, pos, "D");
  }
  return {
    ...snapshot, account_status: status, days_past_due: dq.days, amount_past_due_cents: terminal ? snapshot.amount_past_due_cents : dq.amount_past_due_cents,
    dofd: terminal ? snapshot.dofd : deriveDofd(status, dq.earliest_unpaid, prior), php,
    consumers: snapshot.consumers.map((c) => ({ ...c, ccc: "XB" })),
    derivation: [...snapshot.derivation, `noe bar active through ${noeBarEnd(bar.received_on)}: as_if_paid ${[...scope].join(",")}`],
  };
}

// ---- Bankruptcy overlay (rule 3) --------------------------------------------

export type Chapter = 7 | 11 | 12 | 13;

export type BankruptcyPhase =
  | { readonly phase: "petition"; readonly petition_status: AccountStatus; readonly petition_amount_past_due_cents: Cents }
  | { readonly phase: "ch13_confirmed"; readonly plan_cures_arrears: boolean }
  | { readonly phase: "ch7_discharged"; readonly reaffirmed: boolean; readonly rescinded?: boolean; readonly discharged_on: PlainDate }
  | { readonly phase: "ch13_completed"; readonly maintained: boolean; readonly discharged_on: PlainDate }
  | { readonly phase: "dismissed"; readonly dismissed_on: PlainDate; readonly withdrawn?: boolean; readonly cycles_since: number };

export interface BankruptcyState { readonly party_id: string; readonly chapter: Chapter; readonly petition_on: PlainDate; readonly phase: BankruptcyPhase; }

const PETITION_CII: Readonly<Record<Chapter, Cii>> = { 7: "A", 11: "B", 12: "C", 13: "D" };
const DISMISSED_CII: Readonly<Record<Chapter, Cii>> = { 7: "I", 11: "J", 12: "K", 13: "L" };
const WITHDRAWN_CII: Readonly<Record<Chapter, Cii>> = { 7: "M", 11: "N", 12: "O", 13: "P" };

function withCii(s: Metro2Snapshot, partyId: string, cii: Cii): Metro2Snapshot["consumers"] {
  return s.consumers.map((c) => (c.party_id === partyId ? { ...c, cii } : c));
}

/**
 * Overlay for the filing consumer. `installments` is the FIFO-applied ledger;
 * pre-petition installments (due on/before the petition) are excluded from
 * status/APD while a confirmed plan cures them, and from the DOFD anchor after
 * dismissal (the cured delinquency does not re-open — worked example).
 */
export function bankruptcyOverlay(s: Metro2Snapshot, bk: BankruptcyState, installments: readonly AppliedInstallment[], priorIn: PriorHistory | Metro2Snapshot | null): Metro2Snapshot {
  const prior = toPrior(priorIn);
  const trail = (note: string) => [...s.derivation, `bankruptcy ch${bk.chapter} ${bk.phase.phase}: ${note}`];
  const p = bk.phase;
  switch (p.phase) {
    case "petition":
      return { ...s, account_status: p.petition_status, amount_past_due_cents: p.petition_amount_past_due_cents, special_comment: "",
        dofd: deriveDofd(p.petition_status, deriveDelinquency(installments, s.as_of).earliest_unpaid, prior),
        consumers: withCii(s, bk.party_id, PETITION_CII[bk.chapter]), derivation: trail(`freeze at petition-date status ${p.petition_status}`) };
    case "ch13_confirmed": {
      if (!p.plan_cures_arrears) return { ...s, consumers: withCii(s, bk.party_id, "D"), derivation: trail("plan does not cure arrears; contractual") };
      const post = installments.filter((i) => i.due_date > bk.petition_on);
      const dq = deriveDelinquency(post, s.as_of);
      const status = statusForDays(dq.days);
      return { ...s, account_status: status, amount_past_due_cents: dq.amount_past_due_cents, days_past_due: dq.days,
        dofd: deriveDofd(status, dq.earliest_unpaid, prior), special_comment: "",
        consumers: withCii(s, bk.party_id, "D"), derivation: trail(`post-petition performance: days ${dq.days}`) };
    }
    case "ch7_discharged":
      if (p.reaffirmed) return { ...s, consumers: withCii(s, bk.party_id, p.rescinded ? "V" : "R"), derivation: trail("reaffirmed; normal reporting") };
      return { ...s, current_balance_cents: 0n, amount_past_due_cents: 0n, scheduled_monthly_payment_cents: 0n, date_closed: p.discharged_on,
        account_status: prior?.status ?? s.account_status, final_reported: true,
        consumers: withCii(s, bk.party_id, "E"), derivation: trail("discharged without reaffirmation; final") };
    case "ch13_completed":
      if (p.maintained) return { ...s, consumers: withCii(s, bk.party_id, "Q"), derivation: trail("maintained under §1322(b)(5); indicator removed") };
      return { ...s, current_balance_cents: 0n, amount_past_due_cents: 0n, date_closed: p.discharged_on, final_reported: true,
        consumers: withCii(s, bk.party_id, "H"), derivation: trail("discharged; final") };
    case "dismissed": {
      if (p.cycles_since >= 1) return { ...s, consumers: withCii(s, bk.party_id, "Q"), derivation: trail("indicator removed; normal reporting") };
      const post = installments.filter((i) => i.due_date > bk.petition_on);
      const dq = deriveDelinquency(post, s.as_of);
      const all = deriveDelinquency(installments, s.as_of);
      const status = statusForDays(dq.days);
      const cii = p.withdrawn ? WITHDRAWN_CII[bk.chapter] : DISMISSED_CII[bk.chapter];
      return { ...s, account_status: status, days_past_due: dq.days, amount_past_due_cents: all.amount_past_due_cents,
        dofd: deriveDofd(status, dq.earliest_unpaid, prior), consumers: withCii(s, bk.party_id, cii),
        derivation: trail(`freeze released; new delinquency anchor ${dq.earliest_unpaid ?? "none"}`) };
    }
  }
}

// ---- SCRA overlay (rule 4) --------------------------------------------------

export const SCRA_CAP = ratePercent("6");

export interface ScraReducedPayment { readonly pi_cents: Cents; readonly forgiven_interest_cents: Cents; readonly piti_cents: Cents; }

/** Reduced P&I under the 6% cap re-amortized over the remaining term; forgiven interest is never a receivable. */
export function scraReducedPayment(upb: Cents, noteRate: Decimal, remainingTerm: number, escrow: Cents): ScraReducedPayment {
  const pi = levelPayment(upb, SCRA_CAP, remainingTerm);
  const forgiven = monthlyInterest(upb, noteRate.sub(SCRA_CAP));          // 50 U.S.C. 3937: interest above 6% is forgiven
  return { pi_cents: pi, forgiven_interest_cents: forgiven, piti_cents: pi + escrow };
}

export interface ScraCase { readonly party_id: string; readonly relief_from: PlainDate; readonly relief_to: PlainDate | null; readonly reduced_piti_cents: Cents; readonly stay_granted: boolean; readonly officer_reviewed_adverse?: boolean; }

export interface ScraOverlayResult { readonly snapshot: Metro2Snapshot; readonly held_for_officer: boolean; }

/** Scheduled payment = reduced PITI; no `AI`; a stay freezes like forbearance; new adverse status during relief is held for officer review. */
export function scraOverlay(s: Metro2Snapshot, scra: ScraCase, priorIn: PriorHistory | Metro2Snapshot | null): ScraOverlayResult {
  const prior = toPrior(priorIn);
  let out: Metro2Snapshot = { ...s, scheduled_monthly_payment_cents: scra.reduced_piti_cents, derivation: [...s.derivation, "scra: reduced payment; no AI code"] };
  if (out.special_comment === "AZ") out = { ...out, special_comment: "" };
  if (scra.stay_granted && prior?.status) {
    out = { ...out, account_status: prior.status, derivation: [...out.derivation, "scra stay: status frozen"] };
  }
  const adverseNew = prior !== null && prior.status !== null && out.account_status !== prior.status && out.account_status !== "11" && !scra.stay_granted;
  return { snapshot: out, held_for_officer: adverseNew && !scra.officer_reviewed_adverse };
}

// ---- Disaster, deceased, identity theft, FDCPA gate ------------------------

/** Disaster overlay is a Special Comment AW unless CP already occupies the field (rule 5; 8.3-T7). */
export function disasterOverlay(s: Metro2Snapshot, declaredOn: PlainDate, extendedTo: PlainDate | null = null): Metro2Snapshot {
  const expires = extendedTo ?? addDays(declaredOn, 365);
  if (s.as_of > expires || s.special_comment === "CP") return s;
  return { ...s, special_comment: "AW", consumers: s.consumers.map((c) => ({ ...c, special_comment: "AW" })) };
}

/** Deceased consumer → ECOA X on that segment from the next cycle; other obligors unchanged (rule 6). */
export function deceasedOverlay(s: Metro2Snapshot, partyId: string): Metro2Snapshot {
  return { ...s, consumers: s.consumers.map((c) => (c.party_id === partyId ? { ...c, ecoa: "X" } : c)) };
}

export interface IdentityTheftEvent { readonly party_id: string; readonly received_on: PlainDate; readonly never_liable: boolean; }

export interface IdentityTheftResponse { readonly suppression: Suppression; readonly aud_due: PlainDate; readonly fraud_case: true; readonly resumption_requires: readonly string[]; }

/** Rule 7: omit (or ECOA Z) immediately, AUD within 2 BD, fraud case; resumption needs officer + BRR / CRA rescission. */
export function identityTheftResponse(ev: IdentityTheftEvent, audDue: PlainDate): IdentityTheftResponse {
  return {
    suppression: { reason: "identity_theft", mechanism: ev.never_liable ? "delete_consumer" : "omit_account", party_id: ev.party_id, starts_on: ev.received_on, ends_on: null, codes: ev.never_liable ? ["ECOA Z"] : [] },
    aud_due: audDue, fraud_case: true, resumption_requires: ["officer_approval", "brr_with_evidence", "cra_block_rescission"],
  };
}

export interface FdcpaGateInput { readonly live_contact_on: PlainDate | null; readonly validation_notice_sent_on: PlainDate | null; readonly undeliverable_on: PlainDate | null; }

/** Rule 8: the gate opens on live contact, or 14 days after a validation notice with no undeliverability. */
export function fdcpaGateOpensOn(g: FdcpaGateInput): PlainDate | null {
  const candidates: PlainDate[] = [];
  if (g.live_contact_on) candidates.push(g.live_contact_on);
  if (g.validation_notice_sent_on && g.undeliverable_on === null) candidates.push(addDays(g.validation_notice_sent_on, 14));
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b < a ? b : a));
}

export function fdcpaGateIncludes(g: FdcpaGateInput, cycleAsOf: PlainDate): boolean {
  const opens = fdcpaGateOpensOn(g);
  return opens !== null && opens <= endOfMonth(cycleAsOf);
}

// ---- Appendix E III(d) sample verification (8.3-T13) ------------------------

export interface SampleVerification { readonly sample_size: number; readonly match_rate: number; readonly escalate: boolean; }

export function sampleVerification(cycleRecords: number, matched: number, sampled: number): SampleVerification {
  const required = Math.max(200, Math.ceil(cycleRecords * 0.05));
  const rate = sampled === 0 ? 0 : matched / sampled;
  return { sample_size: required, match_rate: rate, escalate: sampled < required || rate < 0.995 };
}

/** Stale-suppression review: a suppression with no monitor event for 30 days is flagged (8.3-T11). */
export function staleSuppressionReviewDue(lastEventOn: PlainDate): PlainDate { return addDays(lastEventOn, 30); }

export function totalUnpaid(installments: readonly AppliedInstallment[], asOf: PlainDate): Cents {
  return sumCents(installments.filter((i) => i.due_date <= asOf && (i.satisfied_on === null || i.satisfied_on > asOf)).map((i) => i.amount_cents - i.paid_cents));
}

export { daysBetween };
