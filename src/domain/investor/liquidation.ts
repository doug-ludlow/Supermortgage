/** §5.3 Reporting liquidations — code selection matrix and amounts. */
import type { Cents } from "../../kernel/money/cents.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { monthInterest } from "./remittance.ts";
import type { RemittanceType } from "./types.ts";

export type LiquidationKind = "payoff" | "short_sale" | "condemnation" | "third_party_sale" | "second_lien_chargeoff" | "foreclosure_fnma_acquires" | "redemption" | "mortgage_release" | "va_no_upset";
export type InsuredFlag = "none" | "mi" | "fha" | "va";
/** IRM removal-interest table for S/A loans: advancing (months 1–3), recovering (month 4: the advanced interest × −1), not advancing (after recovery). */
export type SaAdvanceState = "advancing" | "recovering" | "not_advancing";

/** 5.3 rule 1. */
export function actionCode(kind: LiquidationKind, insured: InsuredFlag): "60" | "70" | "71" | "72" {
  if (kind === "payoff") return "60";
  if (kind === "short_sale" || kind === "condemnation" || kind === "third_party_sale" || kind === "second_lien_chargeoff") return "71";
  return insured === "none" ? "70" : "72";
}
export const PROCEEDS_CRS_CODE: Record<"71" | "60" | "70" | "72", string> = { "71": "311", "60": "001", "70": "—", "72": "—" };

export interface RemovalAmounts { readonly principal_cents: Cents; readonly interest_cents: Cents; readonly action_code: string; readonly action_date: PlainDate; readonly reported_late: boolean; }

export interface RemovalInput {
  readonly kind: LiquidationKind; readonly insured: InsuredFlag; readonly type: RemittanceType; readonly actual_upb_cents: Cents; readonly scheduled_upb_cents: Cents; readonly nib_cents: Cents; readonly ptr: string; readonly legal_date: PlainDate; readonly period_open: boolean;
  /** Explicit interest (e.g. the payoff calculator's A/A daily accrual) overrides the table. */
  readonly interest_cents?: Cents;
  /** S/A only (IRM §2-04): which leg of the advance/recover cycle the loan is in; default `advancing`. */
  readonly sa_state?: SaAdvanceState;
  /** S/A recovering: total interest advanced so far (reported × −1). */
  readonly total_advanced_interest_cents?: Cents;
  /** LPI movement on the removal LAR (A/A and S/A recovering use it): `none` → $0 / backward adds the current month to the recovery. */
  readonly lpi_movement?: "none" | "forward" | "backward";
  readonly participation_pct?: string;
}
const partOf = (c: Cents, pct: string | undefined): Cents => { if (!pct || pct === "100") return c; const scaled = c * BigInt(Math.round(Number(pct) * 1_000_000)); const den = 100n * 1_000_000n; const q = scaled / den; const rem = scaled - q * den; return rem * 2n >= den ? q + 1n : q; };

/** IRM §2-04 removal interest by remittance type (5.3 verified requirement). */
export function removalInterest(o: RemovalInput): Cents {
  if (o.interest_cents !== undefined) return o.interest_cents;
  if (o.type === "SS") return partOf(monthInterest(o.scheduled_upb_cents, o.ptr), o.participation_pct);
  if (o.type === "AA") {
    if (o.kind === "payoff") return partOf(monthInterest(o.actual_upb_cents, o.ptr), o.participation_pct);   // payoff interest normally comes from 5.2 rule 6 via interest_cents
    const one = partOf(monthInterest(o.actual_upb_cents, o.ptr), o.participation_pct);
    return o.lpi_movement === "forward" ? one : o.lpi_movement === "backward" ? -one : 0n;                     // $0.00 with no LPI movement
  }
  // S/A
  const monthly = monthInterest(o.actual_upb_cents, o.ptr);
  switch (o.sa_state ?? "advancing") {
    case "advancing": return partOf(monthInterest(o.scheduled_upb_cents || o.actual_upb_cents, o.ptr), o.participation_pct);   // prior scheduled UPB × % × PTR ÷ 12
    case "recovering": { const total = o.total_advanced_interest_cents ?? 0n; return -partOf(total + (o.lpi_movement === "backward" ? monthly : 0n), o.participation_pct); }   // total advanced × (−1); backward LPI adds the month
    case "not_advancing": return -partOf(monthly, o.participation_pct);                                                                          // prior actual UPB × PTR ÷ 12 × (−1)
  }
}

/** 5.3 rule 2: principal = (UPB per type + NIB) × participation; interest per the IRM table. */
export function removalAmounts(o: RemovalInput): RemovalAmounts {
  const base = partOf((o.type === "SS" ? o.scheduled_upb_cents : o.actual_upb_cents) + o.nib_cents, o.participation_pct);
  return { principal_cents: base, interest_cents: removalInterest(o), action_code: actionCode(o.kind, o.insured), action_date: o.legal_date, reported_late: !o.period_open };
}
