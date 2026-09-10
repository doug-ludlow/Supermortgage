/** 10.4 Annual PMI disclosure — applicability, cadence and channel. */
import { type PlainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";

export type PremiumPlan = "bpmi_monthly" | "bpmi_annual" | "bpmi_single_financed" | "lpmi";

export function annualDisclosureApplies(plan: PremiumPlan, status: string): boolean { return plan !== "lpmi" && status === "active"; }
export function disclosureTemplate(consummation: PlainDate): "annual_b_legacy" | "annual_a3" { return consummation < "1999-07-29" ? "annual_b_legacy" : "annual_a3"; }

export interface DisclosurePlan { readonly next_due: PlainDate; readonly send_on: PlainDate; readonly included_with: "escrow_statement" | "form_1098" | "standalone"; }

/** R2 — next_due = last_sent + 12 months; attach to the escrow statement if within [next_due − 120, next_due], else 1098, else standalone at next_due − 15. */
export function disclosurePlan(i: { last_sent: PlainDate | null; boarded_on: PlainDate; escrow_statement_on: PlainDate | null; form_1098_on: PlainDate | null }): DisclosurePlan {
  if (i.last_sent === null) { const due = addDays(i.boarded_on, 60); return { next_due: due, send_on: due, included_with: "standalone" }; }
  const byMonths = addMonths(i.last_sent, 12), cap = addDays(i.last_sent, 365);
  const due = byMonths < cap ? byMonths : cap;   // R2: "+ 12 months (never more than 365 days)" — a Feb. 29 in the span would make 12 months 366 days
  const winStart = addDays(due, -120);
  const inWindow = (d: PlainDate | null): d is PlainDate => d !== null && d >= winStart && d <= due;
  if (inWindow(i.escrow_statement_on)) return { next_due: due, send_on: i.escrow_statement_on, included_with: "escrow_statement" };
  if (inWindow(i.form_1098_on)) return { next_due: due, send_on: i.form_1098_on, included_with: "form_1098" };
  return { next_due: due, send_on: addDays(due, -15), included_with: "standalone" };
}

export function disclosureChannel(esignConsentValid: boolean): "electronic" | "mail" { return esignConsentValid ? "electronic" : "mail"; }
