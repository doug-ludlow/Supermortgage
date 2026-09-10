/** §2.5 Biweekly third-party payments — arrangement lifecycle and the true-biweekly interest formula. */
import { randomUUID } from "node:crypto";
import { Machine } from "../../kernel/fsm/machine.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";

export type ArrangementStatus = "reported" | "verified" | "active" | "dormant" | "ended";
export const arrangementMachine = new Machine<ArrangementStatus, { matched?: boolean }>({
  name: "biweekly_arrangement", initial: "reported", states: ["reported", "verified", "active", "dormant", "ended"], terminal: ["ended"],
  transitions: [
    { from: "reported", to: "verified", on: "verify", guard: (t) => (t.ctx.matched ? undefined : "first remittance not matched / no borrower confirmation") },
    { from: "verified", to: "active", on: "activate" }, { from: "active", to: "dormant", on: "no_remittance_60d" }, { from: "dormant", to: "active", on: "remittance" },
    { from: ["reported", "verified", "active", "dormant"], to: "ended", on: "end" },
  ],
});

export interface Arrangement { readonly id: string; readonly loan_id: string; readonly contractor_company_id: string; status: ArrangementStatus; last_remittance_on: PlainDate | null; }
export function newArrangement(loanId: string, companyId: string): Arrangement { return { id: randomUUID(), loan_id: loanId, contractor_company_id: companyId, status: "reported", last_remittance_on: null }; }

/** 2.5 rule 5 [UNVERIFIED day-count]: 14 days' interest = round_half_up(UPB × rate × 14 ÷ 365). */
export function biweeklyInterest(upbCents: Cents, ratePct: string): Cents {
  const r = ratePercent(ratePct);
  return divRound(upbCents * r.unscaled * 14n, 365n * Decimal.ONE.unscaled, "HALF_UP");
}

/** Parse the contractor addenda for a designated principal amount ("PRIN 219257"). */
export function designatedPrincipalFromAddenda(addenda: string | undefined): Cents {
  const m = addenda ? /PRIN\s*(\d+)/i.exec(addenda) : null;
  return m ? BigInt(m[1]!) : 0n;
}

/** The 30-day return clock does not run while the arrangement is active and the loan is ≤ 30 days delinquent. */
export function returnClockSuspended(a: Arrangement, daysDelinquent: number): boolean { return a.status === "active" && daysDelinquent <= 30; }

/** 2.5 rule 3 / T4: a late charge on a contractor-timed remittance is explained with the THIRDPARTY-BIWEEKLY-INFO-v1 context the borrower already received. */
export const THIRDPARTY_INFO_TEMPLATE = "THIRDPARTY-BIWEEKLY-INFO-v1";
export function lateChargeExplanation(a: Arrangement, fee: { amount_cents: Cents; installment_due_date: PlainDate; grace_end_on: PlainDate }, settledOn: PlainDate): { text: string; context_template: string } {
  return { context_template: THIRDPARTY_INFO_TEMPLATE, text: `Your ${a.contractor_company_id} remittance for the ${fee.installment_due_date} installment settled ${settledOn}, after the grace period ended ${fee.grace_end_on}; under your note a late charge of ${fee.amount_cents} cents applies. As explained in ${THIRDPARTY_INFO_TEMPLATE}, Supermortgage is not party to the arrangement and the contractor's timing is your risk; the free in-house split option is available.` };
}
/** 2.5 rule 6 / T7: what the voice agent says about a contractor's program — the non-endorsement statement and the free in-house option, always. */
export const NON_ENDORSEMENT_STATEMENT = "Supermortgage does not endorse, market or receive compensation from any third-party biweekly payment program.";
export const FREE_INHOUSE_OPTION = "You can split your payment for free with Supermortgage's in-house biweekly option; there is no fee and no third party.";
export function contractorProgramAnswer(question: string, facts: { contractor_fee_cents?: Cents; late_charges_follow_note?: boolean } = {}): { transcript: string[]; non_endorsement: true; free_inhouse_option: true } {
  const lines = [NON_ENDORSEMENT_STATEMENT];
  if (facts.contractor_fee_cents !== undefined) lines.push(`The program charges you ${facts.contractor_fee_cents} cents; halves are held until a full payment accumulates, and late charges follow your note regardless of the contractor's timing.`);
  lines.push(FREE_INHOUSE_OPTION);
  return { transcript: [`Q: ${question}`, ...lines.map((l) => `A: ${l}`)], non_endorsement: true, free_inhouse_option: true };
}
