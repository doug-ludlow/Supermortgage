/** §5.3 Reporting liquidations — code selection matrix and amounts. */
import type { Cents } from "../../kernel/money/cents.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { monthInterest } from "./remittance.ts";
import type { RemittanceType } from "./types.ts";

export type LiquidationKind = "payoff" | "short_sale" | "condemnation" | "third_party_sale" | "second_lien_chargeoff" | "foreclosure_fnma_acquires" | "redemption" | "mortgage_release" | "va_no_upset";
export type InsuredFlag = "none" | "mi" | "fha" | "va";

/** 5.3 rule 1. */
export function actionCode(kind: LiquidationKind, insured: InsuredFlag): "60" | "70" | "71" | "72" {
  if (kind === "payoff") return "60";
  if (kind === "short_sale" || kind === "condemnation" || kind === "third_party_sale" || kind === "second_lien_chargeoff") return "71";
  return insured === "none" ? "70" : "72";
}
export const PROCEEDS_CRS_CODE: Record<"71" | "60" | "70" | "72", string> = { "71": "311", "60": "001", "70": "—", "72": "—" };

export interface RemovalAmounts { readonly principal_cents: Cents; readonly interest_cents: Cents; readonly action_code: string; readonly action_date: PlainDate; readonly reported_late: boolean; }

/** 5.3 rule 2: principal = (UPB per type + NIB) × participation; interest per remittance type. */
export function removalAmounts(o: { kind: LiquidationKind; insured: InsuredFlag; type: RemittanceType; actual_upb_cents: Cents; scheduled_upb_cents: Cents; nib_cents: Cents; ptr: string; legal_date: PlainDate; period_open: boolean; interest_cents?: Cents }): RemovalAmounts {
  const base = (o.type === "SS" ? o.scheduled_upb_cents : o.actual_upb_cents) + o.nib_cents;
  const interest = o.interest_cents ?? (o.type === "AA" && o.kind !== "payoff" ? 0n : monthInterest(o.type === "SS" ? o.scheduled_upb_cents : o.actual_upb_cents, o.ptr));
  return { principal_cents: base, interest_cents: interest, action_code: actionCode(o.kind, o.insured), action_date: o.legal_date, reported_late: !o.period_open };
}
