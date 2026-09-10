/**
 * §14.4 operating rules over the credit calculators (./credit.ts): the
 * per-filer `bankruptcy_reporting_state` row and its 1-BD sync deadline
 * (rules 1–2, `SM_BK_CR_STATE_SYNC_1BD`), the `bk.credit_feed.v1` mapping of a
 * 14.1 phase event to the phase/fields the row carries and to 8.3's suppression
 * request (rules 2–9, 14.4-Q3), the per-cycle Metro 2 segment 8.3's overlay
 * derives from the row (rule 3 matrix; T1–T6), the late-discovery AUD (rule 10,
 * T7) and the same-name false-match reversal (rule 10, T8). The feed is
 * deterministic: event → state row; 8.3 owns codes, mechanisms, AUDs and e-OSCAR.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { cii, accountStatus, correctionDue, dollars9, type Phase } from "./credit.ts";
import type { Chapter } from "./case.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";

/** Versioned rule set named by the spec's decision record. */
export const RULE_SET_VERSION = "bk.credit_feed.v1; crrg.2026";

/**
 * 11 U.S.C. §524(c)(4) / `USC_524C4_REAFFIRM_RESCISSION` (14.1 timer table: "later of discharge_at
 * or filed_at + 60 calendar_days"): the debtor may rescind "at any time prior to discharge or within
 * sixty days after such agreement is filed with the court, whichever occurs later". The window's
 * last day is the later of the discharge date and the 60th day after filing (T5: filed 2026-11-20,
 * discharge 2026-12-15 → 2027-01-19); the reaffirmation is `final` from the following day. ./credit.ts
 * reaffirmationFinal takes 60 days after the discharge instead (2027-02-13), which is not the
 * statute — corrected here.
 */
export function rescissionWindowEnds(filedOn: PlainDate, dischargeOn: PlainDate | null): PlainDate {
  const sixty = addDays(filedOn, 60);
  return dischargeOn && dischargeOn > sixty ? dischargeOn : sixty;
}
/** The reaffirmation is final on `asOf` when the rescission window has lapsed (CII stays A through its last day; R thereafter). */
export function reaffirmationIsFinal(filedOn: PlainDate, dischargeOn: PlainDate | null, asOf: PlainDate): boolean { return asOf > rescissionWindowEnds(filedOn, dischargeOn); }

export interface Escalation { readonly kind: "officer" | "attorney" | "human_agent"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; }

/** 14.1 canonical events the feed consumes (spec "Inputs and triggers"). */
export type FeedEvent =
  | "bankruptcy.petition.filed" | "bankruptcy.plan.confirmed" | "bankruptcy.plan.modified" | "bankruptcy.surrender"
  | "bankruptcy.stay.relief_granted" | "bankruptcy.case.dismissed" | "bankruptcy.case.discharged"
  | "bankruptcy.reaffirmation.filed" | "bankruptcy.reaffirmation.approved" | "bankruptcy.reaffirmation.final" | "bankruptcy.reaffirmation.rescinded"
  | "bankruptcy.case.converted" | "bankruptcy.case.closed" | "bankruptcy.case.reopened" | "bankruptcy.cramdown.confirmed" | "loan.boarded";

/** The spec's phase enum (8.3 data model; the table's CHECK) — rescission is CII `V` on the row, not a phase. */
export type ReportingPhase = Exclude<Phase, "rescinded">;

/**
 * `bankruptcy_reporting_state` (8.3 data model; written by 14.4) — one column per field below:
 * 0010 (8.3's columns), 0016 (`reaffirmation_final`, `postpetition_days_delinquent`, `cramdown`,
 * `evidence_document_id`, `case_id`) and 0033 (`surrendered`, `discharge_order_document_id`,
 * `rule_set_version`, `retracted`/`retracted_on`/`retraction_reason`). `cii_current` is the standing
 * CII the mapping table assigns the row. A retraction (rule 10, T8) never deletes the PK row: it
 * writes a `retracted` version (the tombstone 8.3 reads as "no active row"), and the entity store /
 * row history keeps every version with its evidence document ("state-row history with docket
 * evidence hashes").
 */
export interface ReportingStateRow {
  readonly loan_id: string; readonly borrower_id: string; readonly case_id: string; readonly chapter: Chapter; readonly phase: ReportingPhase;
  readonly petition_date: PlainDate; readonly confirmation_date: PlainDate | null; readonly discharge_date: PlainDate | null; readonly dismissal_date: PlainDate | null;
  readonly reaffirmation_date: PlainDate | null; readonly reaffirmation_final: boolean; readonly debt_discharged: boolean;
  readonly status_at_petition: string | null; readonly post_petition_payment_cents: Cents | null; readonly plan_cures_arrears: boolean | null;
  readonly postpetition_days_delinquent: number | null; readonly cramdown: { secured_balance_cents: Cents; payment_cents: Cents } | null;
  readonly cii_current: string; readonly surrendered: boolean; readonly discharge_order_document_id: string | null;
  readonly evidence_document_id: string; readonly rule_set_version: string; readonly retracted: boolean;
}

/** Rule 2 / `SM_BK_CR_STATE_SYNC_1BD`: the state row is written within 1 servicer business day of the phase event. */
export function syncDue(eventOn: PlainDate): PlainDate { return addBusinessDays(eventOn, 1, servicer); }

/**
 * `bk.credit_feed.v1` event → phase. Dismissal on the debtor's own motion maps to `withdrawn`
 * (14.4-Q3 default); relief from stay changes nothing (rule 8); conversion re-enters `petition`
 * with the new chapter (rule 7); a reaffirmation stays in `petition` (CII A) until the §524(c)(4)
 * window lapses (rule 5) — a discharge entered while the reaffirmation is still rescindable does
 * not move the phase (the reaffirmed debt survives it), and a discharge processed after the window
 * has already lapsed lands directly in `reaffirmed` (CII R — never Q, the Ch. 13 removal code);
 * a rescission returns to the phase the case is in (CII V is carried on `cii_current`).
 * `closed`: rule 6 is "dismissal/withdrawal/closure *without discharge*" — the routine closure
 * that follows a discharge (14.1 example C: discharge 2026-12-15, no-asset report and case closed
 * 2026-12-22) changes nothing (null): the discharge treatment (E/H final record, or Q) governs.
 * `reopened` re-enters the phase the case was in before it was closed/dismissed: `confirmed`
 * when a plan had been confirmed, else `petition`; a reopened discharged/reaffirmed case keeps that
 * phase (a discharge revocation is an explicit `debt_discharged` reset with the order — edge cases).
 */
export function phaseForEvent(i: { event: FeedEvent; prior_phase?: ReportingPhase | null; prior_confirmed?: boolean; debtor_motion?: boolean; reaffirmation_final?: boolean; reaffirmation_pending?: boolean; discharge_entered?: boolean }): ReportingPhase | null {
  const prior = i.prior_phase ?? null;
  switch (i.event) {
    case "bankruptcy.petition.filed": case "bankruptcy.case.converted": case "loan.boarded": return "petition";
    case "bankruptcy.plan.confirmed": case "bankruptcy.plan.modified": case "bankruptcy.cramdown.confirmed": return "confirmed";
    case "bankruptcy.case.discharged":
      if (i.reaffirmation_final || prior === "reaffirmed") return "reaffirmed";
      return i.reaffirmation_pending ? (prior ?? "petition") : "discharged";
    case "bankruptcy.case.dismissed": return i.debtor_motion ? "withdrawn" : "dismissed";
    case "bankruptcy.case.closed": return i.discharge_entered || prior === "discharged" || prior === "reaffirmed" ? null : "closed";
    case "bankruptcy.case.reopened": return prior === "closed" || prior === "dismissed" || prior === "withdrawn" ? (i.prior_confirmed ? "confirmed" : "petition") : (prior ?? "petition");
    case "bankruptcy.reaffirmation.filed": case "bankruptcy.reaffirmation.approved": return i.reaffirmation_final ? "reaffirmed" : (prior ?? "petition");
    case "bankruptcy.reaffirmation.final": return "reaffirmed";
    case "bankruptcy.reaffirmation.rescinded": return i.discharge_entered ? "discharged" : (prior === "reaffirmed" ? "petition" : (prior ?? "petition"));
    case "bankruptcy.surrender": return prior ?? "petition";
    case "bankruptcy.stay.relief_granted": return null;
  }
}

export interface StateRowInput {
  readonly case_id: string; readonly case_verified: boolean; readonly loan_id: string; readonly borrower_id: string; readonly filer_borrower_ids: readonly string[];
  readonly chapter: Chapter; readonly event: FeedEvent; readonly event_on: PlainDate; readonly evidence_document_id: string | null; readonly petition_date: PlainDate;
  readonly prior?: ReportingStateRow | null; readonly debtor_motion?: boolean;
  /**
   * Rule 2: `status_at_petition` is 8.1's day count on the petition date (rule 7: the conversion date) — derived
   * here from the contract-terms earliest unpaid installment (FIFO) or the day count 8.1 reports; a caller-asserted
   * `status_at_petition` is only cross-checked against that derivation (boarded facts may carry it alone).
   */
  readonly earliest_unpaid_due_at_petition?: PlainDate | null; readonly days_delinquent_at_petition?: number | null; readonly status_at_petition?: string | null;
  /** The attorney's determination where liability is unclear (lien avoidance, hardship discharge); otherwise derived per the data model. */
  readonly debt_discharged?: boolean; readonly discharge_order_document_id?: string | null; readonly discharge_date?: PlainDate | null;
  /** Plan/SOI treatment carried on a surrender or discharge event: surrender or lien avoidance discharges the debt with the case (rule 4). */
  readonly treatment?: "maintained" | "surrender" | "lien_avoidance" | null;
  readonly reaffirmation_filed_on?: PlainDate | null; readonly as_of?: PlainDate | null;
  readonly plan_cures_arrears?: boolean | null; readonly post_petition_payment_cents?: Cents | null; readonly postpetition_days_delinquent?: number | null;
  readonly cramdown?: { secured_balance_cents: Cents; payment_cents: Cents } | null;
}

/**
 * Data model: `debt_discharged` — Ch. 7 no reaffirmation → true; Ch. 13 §1322(b)(5) maintained →
 * false; Ch. 13 surrender/lien avoidance with discharge → true. An explicit attorney determination wins.
 */
export function debtDischargedAtDischarge(i: { chapter: Chapter; explicit?: boolean | undefined; reaffirmation_pending: boolean; reaffirmation_final: boolean; surrendered: boolean }): boolean {
  if (typeof i.explicit === "boolean") return i.explicit;
  if (i.chapter === "7") return !(i.reaffirmation_pending || i.reaffirmation_final);
  return i.surrendered;
}

/** The guardrail a refusal enforces (the tool records `command.refused` under this code on the real path, where the filer set and the verification come from the 14.1 case record). */
export type RefusalCode = "NON_FILER_NEVER_GETS_ROW" | "NO_ROW_WITHOUT_VERIFIED_CASE" | "DISCHARGE_ORDER_REQUIRED" | "REAFFIRMATION_NOT_FINAL" | "STATUS_AT_PETITION_DERIVED";

/**
 * Rule 2 / rule 7: the frozen status is 8.1's day count on the petition date (or the conversion date):
 * days = anchor − due date of the earliest unpaid contractual installment (FIFO), bucketed by 8.1 rule 1.
 */
export function statusAtPetition(i: { anchor: PlainDate; earliest_unpaid_due?: PlainDate | null; days_delinquent?: number | null }): string | null {
  if (i.earliest_unpaid_due) return contractualStatus(i.earliest_unpaid_due, i.anchor);
  if (typeof i.days_delinquent === "number") return accountStatus(i.days_delinquent);
  return null;
}

/**
 * Rules 1–7 with the agent's guardrails: one row per filer (a non-filing co-obligor never
 * receives one), no row without a verified case and evidence, `debt_discharged=true` only with
 * the discharge order, `reaffirmed` only after the rescission window, `status_at_petition` from
 * 8.1's day count. Returns the row to write, the refusal (with its guardrail code) that blocked
 * it, or `no_change` for events that do not alter reporting (relief from stay; closure after a discharge).
 */
export function stateRow(i: StateRowInput): { row: ReportingStateRow | null; refusal: string | null; refusal_code: RefusalCode | null; no_change: boolean; sync_due: PlainDate; event: "bankruptcy.reporting_state.changed" | null } {
  const due = syncDue(i.event_on);
  const refuse = (code: RefusalCode, why: string) => ({ row: null, refusal: why, refusal_code: code, no_change: false, sync_due: due, event: null });
  if (!i.filer_borrower_ids.includes(i.borrower_id)) return refuse("NON_FILER_NEVER_GETS_ROW", `borrower ${i.borrower_id} is not a filer — non-filing obligors never receive a state row (14.4 rule 1; §1301 restricts collection, not accurate reporting)`);
  if (!i.case_verified || !i.evidence_document_id) return refuse("NO_ROW_WITHOUT_VERIFIED_CASE", "no state row without a verified 14.1 case and docket evidence (14.4 guardrail)");
  const p = i.prior ?? null;
  const rescinded = i.event === "bankruptcy.reaffirmation.rescinded";
  const reaffirmationFiledOn = i.event === "bankruptcy.reaffirmation.filed" ? i.event_on : (i.reaffirmation_filed_on ?? p?.reaffirmation_date ?? null);
  const dischargeDate = i.event === "bankruptcy.case.discharged" ? i.event_on : (i.discharge_date ?? p?.discharge_date ?? null);
  const windowEnds = reaffirmationFiledOn && !rescinded ? rescissionWindowEnds(reaffirmationFiledOn, dischargeDate) : null;
  const asOf = i.as_of ?? i.event_on;
  const reaffirmationFinalNow = Boolean(windowEnds && asOf > windowEnds) || (p?.reaffirmation_final === true && !rescinded);
  const reaffirmationPending = Boolean(reaffirmationFiledOn) && !rescinded && !reaffirmationFinalNow;
  if (i.event === "bankruptcy.reaffirmation.final" && !reaffirmationFinalNow) return refuse("REAFFIRMATION_NOT_FINAL", `reaffirmation is not final until the §524(c)(4) rescission window lapses${windowEnds ? ` on ${windowEnds}` : ""} (14.4 guardrail; SM_BK_CR_REAFFIRM_HOLD)`);
  const phase = phaseForEvent({ event: i.event, prior_phase: p?.phase ?? null, prior_confirmed: p?.confirmation_date != null, debtor_motion: i.debtor_motion ?? false, reaffirmation_final: reaffirmationFinalNow, reaffirmation_pending: reaffirmationPending, discharge_entered: dischargeDate !== null });
  if (phase === null) return { row: null, refusal: null, refusal_code: null, no_change: true, sync_due: due, event: null };
  // rule 2 / rule 7: the frozen status is derived from 8.1's day count on the petition (conversion) date; an asserted value must agree
  const freezes = i.event === "bankruptcy.petition.filed" || i.event === "bankruptcy.case.converted" || i.event === "loan.boarded";
  const derivedStatus = freezes ? statusAtPetition({ anchor: i.event === "bankruptcy.case.converted" ? i.event_on : i.petition_date, earliest_unpaid_due: i.earliest_unpaid_due_at_petition ?? null, days_delinquent: i.days_delinquent_at_petition ?? null }) : null;
  if (derivedStatus && i.status_at_petition && i.status_at_petition !== derivedStatus) return refuse("STATUS_AT_PETITION_DERIVED", `status_at_petition ${i.status_at_petition} contradicts 8.1's day count on ${i.event === "bankruptcy.case.converted" ? i.event_on : i.petition_date} (${derivedStatus}) — the frozen status is derived, never asserted (14.4 rule 2)`);
  const statusAtPetitionNow = freezes ? (derivedStatus ?? i.status_at_petition ?? null) : (p?.status_at_petition ?? i.status_at_petition ?? null);
  const surrendered = i.treatment === "surrender" || i.treatment === "lien_avoidance" || (i.event === "bankruptcy.surrender") || (p?.surrendered ?? false);
  const dischargeOrder = i.discharge_order_document_id ?? (i.event === "bankruptcy.case.discharged" ? i.evidence_document_id : (p?.discharge_order_document_id ?? null));
  // data model: derived at the discharge (and at a rescission that lets an entered discharge take effect); carried on every later
  // event that keeps the row in `discharged` (reopening, surrender) so a routine event never resets it; an explicit attorney determination wins
  const debtDischarged = phase === "discharged"
    ? (i.event === "bankruptcy.case.discharged" || rescinded || p?.phase !== "discharged"
      ? debtDischargedAtDischarge({ chapter: i.chapter, explicit: i.debt_discharged, reaffirmation_pending: reaffirmationPending, reaffirmation_final: reaffirmationFinalNow && !rescinded, surrendered })
      : (i.debt_discharged ?? p.debt_discharged))
    : (i.debt_discharged ?? false);
  if (debtDischarged && !dischargeOrder) return refuse("DISCHARGE_ORDER_REQUIRED", "`debt_discharged=true` requires the discharge order document (14.4 guardrail)");
  const standing = cii(i.chapter, phase, debtDischarged).cii;
  const row: ReportingStateRow = {
    loan_id: i.loan_id, borrower_id: i.borrower_id, case_id: i.case_id, chapter: i.chapter, phase,
    petition_date: i.petition_date,
    confirmation_date: phase === "confirmed" && i.event !== "bankruptcy.cramdown.confirmed" && i.event !== "bankruptcy.plan.modified" && i.event !== "bankruptcy.case.reopened" ? i.event_on : (p?.confirmation_date ?? null),
    discharge_date: dischargeDate,
    dismissal_date: phase === "dismissed" || phase === "withdrawn" ? i.event_on : (p?.dismissal_date ?? null),
    reaffirmation_date: rescinded ? null : reaffirmationFiledOn,
    reaffirmation_final: phase === "reaffirmed",
    debt_discharged: debtDischarged,
    status_at_petition: statusAtPetitionNow,
    post_petition_payment_cents: i.post_petition_payment_cents ?? p?.post_petition_payment_cents ?? null,
    plan_cures_arrears: i.plan_cures_arrears ?? p?.plan_cures_arrears ?? null,
    postpetition_days_delinquent: i.postpetition_days_delinquent ?? p?.postpetition_days_delinquent ?? null,
    cramdown: i.cramdown ?? p?.cramdown ?? null,
    cii_current: rescinded ? "V" : standing, surrendered, discharge_order_document_id: dischargeOrder,
    evidence_document_id: i.evidence_document_id, rule_set_version: RULE_SET_VERSION, retracted: false,
  };
  return { row, refusal: null, refusal_code: null, no_change: false, sync_due: due, event: "bankruptcy.reporting_state.changed" };
}

/** 8.3 rule 3 treatment of a row's standing CII (`V` = reaffirmation rescinded: indicator only; the discharge treatment follows on the next cycle). */
export function feedCii(row: Pick<ReportingStateRow, "chapter" | "phase" | "debt_discharged" | "cii_current">): { cii: string; zero_balances: boolean; freeze_status: boolean; final: boolean } {
  return row.cii_current === "V" ? { cii: "V", zero_balances: false, freeze_status: false, final: false } : cii(row.chapter, row.phase, row.debt_discharged);
}

/** Mapping table `bk.credit_feed.v1`: state row → 8.3 suppression row `{reason, mechanism, codes}` per 8.3 rule 3 (the agent never creates it; 8.3 does, from the row). */
export function suppressionRequest(row: ReportingStateRow): { reason: "bankruptcy_active" | "bankruptcy_discharged"; mechanism: "freeze_status" | "flag_only" | "delete_account"; codes: readonly string[]; party_id: string; final_reported: boolean; zero_balances: boolean } {
  const c = feedCii(row);
  return { reason: row.phase === "discharged" && row.debt_discharged ? "bankruptcy_discharged" : "bankruptcy_active", mechanism: c.final ? "delete_account" : c.freeze_status ? "freeze_status" : "flag_only", codes: [`CII ${c.cii}`], party_id: row.borrower_id, final_reported: c.final, zero_balances: c.zero_balances };
}

// ---- per-cycle Metro 2 segment (8.3 rule 3 matrix over the row; 8.1 field conventions) ----------
/** Metro 2 `MMDDYYYY`; `00000000` when there is no date. */
export const mmddyyyy = (d: PlainDate | null): string => (d ? d.slice(5, 7) + d.slice(8, 10) + d.slice(0, 4) : "00000000");
/** 8.1 rule 1: days past due = as_of − due date of the earliest unpaid installment (FIFO); 11 when current. */
export function contractualStatus(earliestUnpaidDue: PlainDate | null, asOf: PlainDate): string { return earliestUnpaidDue ? accountStatus(daysBetween(earliestUnpaidDue, asOf)) : "11"; }

/**
 * Rule 3 / 14.4-Q2 (default): Current Balance while a Chapter 13 plan is open = the UPB per the plan-terms view — each
 * post-petition installment applied per the note's amortization schedule *as if* the pre-petition installments had
 * been paid (their principal is recovered through the arrearage claim; 14.1 worked example A). Fixture: 33 payments
 * before the petition, May–Sep 2026 (#34–#38) in the claim, Oct (#39) and Nov (#40) applied by the trustee's Dec-18
 * disbursement → $312,279.66 after Oct, $311,916.95 after Oct and Nov.
 */
export function planTermsUpb(i: { original_upb_cents: Cents; rate_pct: string; term_months: number; installments_applied: number }): Cents {
  return balanceAfter(i.original_upb_cents, i.rate_pct, i.term_months, i.installments_applied);
}

/** A performance view as of the snapshot: contract terms (8.1 FIFO) or the plan-terms/post-petition view (rule 3, 14.4-Q2). */
export interface PerformanceView { readonly earliest_unpaid_due: PlainDate | null; readonly installments_past_due: number; readonly scheduled_payment_cents: Cents; readonly upb_cents: Cents; }
export interface Metro2Segment {
  readonly furnish: boolean; readonly cii: string; readonly account_status: string; readonly amount_past_due: string; readonly dofd: string;
  readonly current_balance: string; readonly scheduled_payment: string; readonly date_closed: string; readonly mechanism: "report" | "freeze_status" | "flag_only" | "delete_account"; readonly final_reported: boolean;
}

/**
 * The filer's segment for the month-end snapshot `cycle_as_of`, from the state row and the two
 * performance views (8.3 rule 3; T1–T6). `prior_cii` is the CII the previous cycle furnished for the
 * consumer (1.1 boards the transferor's last CII so the first cycle neither drops nor duplicates
 * an indicator): the one-cycle codes (I–P, V, Q, the E/H final record) turn over on it; `prior_account_status`
 * is the status that cycle furnished — the E/H final record freezes it (8.3 rule 3: "Account Status = the frozen
 * pre-discharge status"); absent it, the pre-discharge status is derived: the petition-date freeze while the
 * case was in `petition`, the post-petition performance status (rule 3) once a plan had been confirmed.
 * A null row is a non-filing obligor: contractual reporting, no CII (rule 1).
 */
export function snapshotSegment(i: { row: ReportingStateRow | null; cycle_as_of: PlainDate; contract: PerformanceView; plan?: PerformanceView | null; prior_cii?: string | null; prior_account_status?: string | null }): Metro2Segment {
  const prior = i.prior_cii ?? "";
  const contractual = (view: PerformanceView, cii: string, mechanism: Metro2Segment["mechanism"]): Metro2Segment => ({
    furnish: true, cii, account_status: contractualStatus(view.earliest_unpaid_due, i.cycle_as_of), amount_past_due: dollars9(BigInt(view.installments_past_due) * view.scheduled_payment_cents),
    dofd: mmddyyyy(view.earliest_unpaid_due), current_balance: dollars9(view.upb_cents), scheduled_payment: dollars9(view.scheduled_payment_cents), date_closed: "00000000", mechanism, final_reported: false,
  });
  const r = i.row;
  if (!r || r.retracted) return contractual(i.contract, "", "report");
  const standing = feedCii(r);
  // rescission: CII V for one cycle (rule 5), then the treatment the discharge (or the open case) calls for
  if (r.cii_current === "V" && prior !== "V") return { ...contractual(i.contract, "V", "flag_only") };
  const after = r.cii_current === "V" ? cii(r.chapter, r.phase, r.debt_discharged) : standing;
  switch (r.phase) {
    case "petition": {
      // rule 2: CII A/B/C/D, Account Status frozen at the petition-date status (8.3-Q3), Amount Past Due/DOFD/Current Balance from the contract terms
      const seg = contractual(i.contract, after.cii, "freeze_status");
      return { ...seg, account_status: r.status_at_petition ?? seg.account_status };
    }
    case "confirmed": {
      // rule 3: post-petition performance — status from the post-petition earliest unpaid, Amount Past Due = post-petition past due only,
      // Scheduled Monthly Payment = the post-petition amount, Current Balance = the plan-terms UPB (14.4-Q2 default; cramdown secured balance, rule 9)
      const plan = i.plan ?? { earliest_unpaid_due: null, installments_past_due: 0, scheduled_payment_cents: r.post_petition_payment_cents ?? i.contract.scheduled_payment_cents, upb_cents: i.contract.upb_cents };
      const view: PerformanceView = { ...plan, scheduled_payment_cents: r.cramdown?.payment_cents ?? r.post_petition_payment_cents ?? plan.scheduled_payment_cents, upb_cents: r.cramdown?.secured_balance_cents ?? plan.upb_cents };
      return contractual(view, after.cii, "flag_only");
    }
    case "discharged": {
      if (after.final) {
        // rule 5 / rule 4 (surrender): the E/H final record — zero balances, Date Closed = discharge date, Account Status frozen at the pre-discharge value; then `final_reported`
        if (prior === after.cii) return { ...contractual(i.contract, after.cii, "delete_account"), furnish: false, final_reported: true };
        // the frozen pre-discharge status: what the last cycle furnished; else the petition-date freeze (Ch. 7 / pre-confirmation), or the
        // post-petition performance status as of the discharge once a plan had been confirmed (a Ch. 13 surrender discharge after years of plan reporting)
        const frozen = i.prior_account_status ?? (r.confirmation_date
          ? contractualStatus((i.plan ?? { earliest_unpaid_due: null }).earliest_unpaid_due, r.discharge_date ?? i.cycle_as_of)
          : (r.status_at_petition ?? contractualStatus(i.contract.earliest_unpaid_due, r.discharge_date ?? i.cycle_as_of)));
        return { furnish: true, cii: after.cii, account_status: frozen, amount_past_due: dollars9(0n), dofd: mmddyyyy(i.contract.earliest_unpaid_due),
          current_balance: dollars9(0n), scheduled_payment: dollars9(0n), date_closed: mmddyyyy(r.discharge_date), mechanism: "delete_account", final_reported: true };
      }
      // rule 4: maintained under §1322(b)(5) — Q removes the indicator for one cycle, then normal contractual reporting
      return contractual(i.contract, prior === "Q" ? "" : "Q", prior === "Q" ? "report" : "flag_only");
    }
    case "dismissed": case "withdrawn": case "closed": {
      // rule 6: I/J/K/L (or M/N/O/P) for one cycle then Q; the freeze is released and the contractual status/DOFD are reported
      const code = prior === after.cii ? "Q" : prior === "Q" ? "" : after.cii;
      return contractual(i.contract, code, code ? "flag_only" : "report");
    }
    case "reaffirmed":
      // rule 5: CII R and normal reporting
      return contractual(i.contract, "R", "flag_only");
  }
}

/** A cycle already furnished for the consumer (8.1 Metro 2 file) — what a correction must undo. */
export interface FurnishedCycle { readonly cycle_as_of: PlainDate; readonly transmitted_on: PlainDate; readonly cii: string; readonly account_status: string; readonly dofd: PlainDate | null; }

export interface AudRequest { readonly kind: "aud"; readonly action: "add_cii" | "remove_cii"; readonly cycle_as_of: PlainDate; readonly due: PlainDate; readonly codes: readonly string[]; readonly account_status: string; readonly party_id: string; readonly evidence_document_id: string; readonly owner: "8.3"; }

/** Rule 10 (T7): a petition learned after a cycle furnished a delinquent status without CII → AUD within 2 BD adding the CII and the frozen status. */
export function lateDiscoveryCorrection(i: { discovered_on: PlainDate; row: ReportingStateRow; furnished: FurnishedCycle }): AudRequest | null {
  if (i.furnished.cii !== "" || i.furnished.cycle_as_of < i.row.petition_date) return null;
  const c = feedCii(i.row);
  return { kind: "aud", action: "add_cii", cycle_as_of: i.furnished.cycle_as_of, due: correctionDue(i.discovered_on), codes: [`CII ${c.cii}`], account_status: c.freeze_status && i.row.status_at_petition ? i.row.status_at_petition : i.furnished.account_status, party_id: i.row.borrower_id, evidence_document_id: i.row.evidence_document_id, owner: "8.3" };
}

/**
 * Rule 10 (T8): a same-name false match reversed by 14.1 — every state row of the case is
 * retracted (append-only: a `retracted` version, no active row survives), 8.3 is asked to release
 * the suppression it derived, any cycle already furnished with a CII gets an AUD removing it
 * within 2 BD that restores the contractual status, and the officer is notified (any deletion).
 */
export function falseMatchReversal(i: { reversed_on: PlainDate; rows: readonly ReportingStateRow[]; furnished: readonly FurnishedCycle[]; evidence_document_id: string }): {
  surviving_rows: readonly ReportingStateRow[]; retracted: readonly (ReportingStateRow & { retracted: true; retracted_on: PlainDate; retraction_reason: "false_match" })[];
  releases: readonly { party_id: string; reason: "bankruptcy_active" | "bankruptcy_discharged" }[]; auds: readonly AudRequest[]; aud_due: PlainDate | null; escalation: Escalation; events: readonly string[];
} {
  const live = i.rows.filter((r) => !r.retracted);
  const retracted = live.map((r) => ({ ...r, retracted: true as const, retracted_on: i.reversed_on, retraction_reason: "false_match" as const, evidence_document_id: i.evidence_document_id }));
  const releases = live.map((r) => ({ party_id: r.borrower_id, reason: suppressionRequest(r).reason }));
  const due = correctionDue(i.reversed_on);
  const auds: AudRequest[] = [];
  for (const r of live) for (const f of i.furnished) {
    if (f.cii === "") continue;
    auds.push({ kind: "aud", action: "remove_cii", cycle_as_of: f.cycle_as_of, due, codes: [`CII ${f.cii}`], account_status: contractualStatus(f.dofd, f.cycle_as_of), party_id: r.borrower_id, evidence_document_id: i.evidence_document_id, owner: "8.3" });
  }
  const events = [...live.map(() => "bankruptcy.reporting_state.retracted"), ...auds.map(() => "credit.correction.requested")];
  return { surviving_rows: [], retracted, releases, auds, aud_due: auds.length ? due : null, escalation: { kind: "officer", reason: `false bankruptcy match reversed ${i.reversed_on}: ${live.length} state row(s) deleted${auds.length ? `, ${auds.length} AUD(s) removing the CII due ${due}` : ", nothing furnished with a CII"} (14.4 rule 10; officer on any deletion)` }, events };
}
