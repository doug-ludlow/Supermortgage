/** §14.4 Credit reporting in bankruptcy — Metro 2 CII by phase/chapter, status freeze, dismissal codes. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
export function accountStatus(daysDelinquent: number): "11" | "71" | "78" | "80" | "82" | "83" | "84" { return daysDelinquent < 30 ? "11" : daysDelinquent < 60 ? "71" : daysDelinquent < 90 ? "78" : daysDelinquent < 120 ? "80" : daysDelinquent < 150 ? "82" : daysDelinquent < 180 ? "83" : "84"; }
export type Phase = "petition" | "confirmed" | "discharged" | "dismissed" | "withdrawn" | "closed" | "reaffirmed" | "rescinded";
const PET: Record<"7" | "11" | "12" | "13", string> = { "7": "A", "11": "B", "12": "C", "13": "D" };
const DIS: Record<"7" | "11" | "12" | "13", string> = { "7": "I", "11": "J", "12": "K", "13": "L" };
const WDR: Record<"7" | "11" | "12" | "13", string> = { "7": "M", "11": "N", "12": "O", "13": "P" };
export function cii(chapter: "7" | "11" | "12" | "13", phase: Phase, debtDischarged: boolean): { cii: string; zero_balances: boolean; freeze_status: boolean; final: boolean } {
  switch (phase) {
    case "petition": case "confirmed": return { cii: PET[chapter], zero_balances: false, freeze_status: phase === "petition", final: false };
    case "discharged": return debtDischarged ? { cii: chapter === "7" ? "E" : "H", zero_balances: true, freeze_status: true, final: true } : { cii: "Q", zero_balances: false, freeze_status: false, final: false };
    case "dismissed": case "closed": return { cii: DIS[chapter], zero_balances: false, freeze_status: false, final: false };
    case "withdrawn": return { cii: WDR[chapter], zero_balances: false, freeze_status: false, final: false };
    case "reaffirmed": return { cii: "R", zero_balances: false, freeze_status: false, final: false };
    case "rescinded": return { cii: "V", zero_balances: false, freeze_status: false, final: false };
  }
}
export const dollars9 = (c: Cents): string => (c / 100n).toString().padStart(9, "0");
export function petitionSnapshot(f: { chapter: "7" | "11" | "12" | "13"; days_delinquent_at_petition: number; monthly_payment_cents: Cents; installments_past_due: number; upb_cents: Cents; dofd: PlainDate }): { cii: string; account_status: string; amount_past_due: string; dofd: string; current_balance: string; scheduled_payment: string } {
  return { cii: PET[f.chapter], account_status: accountStatus(f.days_delinquent_at_petition), amount_past_due: dollars9(BigInt(f.installments_past_due) * f.monthly_payment_cents), dofd: f.dofd.slice(5, 7) + f.dofd.slice(8, 10) + f.dofd.slice(0, 4), current_balance: dollars9(f.upb_cents), scheduled_payment: dollars9(f.monthly_payment_cents) };
}
export function reaffirmationFinal(filedOn: PlainDate, dischargeOn: PlainDate): PlainDate { const a = addDays(filedOn, 60), b = addDays(dischargeOn, 60); return a > b ? a : b; }   // §524(c)(4): later of 60 days after filing or discharge
export function correctionDue(discoveredOn: PlainDate): PlainDate { return addBusinessDays(discoveredOn, 2, servicer); }
