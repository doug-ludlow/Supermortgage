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
