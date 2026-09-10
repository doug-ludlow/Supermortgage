/**
 * 9.7 Loss draft / insurance claim handling — track, release sizing,
 * custodial interest, and the Form 176 / REOgram clocks.
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export type LossDraftTrack = "current_lt31" | "delinquent_31plus" | "abandoned_or_fc_sale" | "not_rebuildable";

export function lossDraftTrack(i: { fnma_days_delinquent: number; abandoned: boolean; fc_sale_scheduled: boolean; rebuildable: "yes" | "no" | "unknown" }): LossDraftTrack {
  if (i.rebuildable === "no") return "not_rebuildable";
  if (i.abandoned || i.fc_sale_scheduled) return "abandoned_or_fc_sale";
  return i.fnma_days_delinquent < 31 ? "current_lt31" : "delinquent_31plus";
}

export const CURRENT_FLOOR: Cents = 4_000_000n;     // $40,000
export const DELINQUENT_LUMP: Cents = 500_000n;     // $5,000
export const DELINQUENT_FLOOR: Cents = 1_000_000n;  // $10,000

function pct(total: Cents, p: string): Cents { return Decimal.fromBigInt(total).mul(Decimal.parse(p)).toScaledInt(0, "HALF_UP"); }
function maxC(...xs: Cents[]): Cents { return xs.reduce((a, b) => (b > a ? b : a)); }
function minC(...xs: Cents[]): Cents { return xs.reduce((a, b) => (b < a ? b : a)); }

export interface ReleaseInput { readonly total_cents: Cents; readonly upb_cents: Cents; readonly accrued_interest_cents: Cents; readonly advances_cents: Cents; readonly track: LossDraftTrack; }

export interface InitialRelease { readonly cents: Cents; readonly receipts_required: boolean; readonly final_inspection_required: boolean; readonly max_progress_cents: Cents | null; }

/** Rule 2 — initial release by track. */
export function initialRelease(i: ReleaseInput): InitialRelease {
  const excess = maxC(0n, i.total_cents - (i.upb_cents + i.accrued_interest_cents + i.advances_cents));
  if (i.track === "not_rebuildable") return { cents: 0n, receipts_required: false, final_inspection_required: false, max_progress_cents: null };
  if (i.track === "current_lt31") {
    const c = minC(i.total_cents, maxC(CURRENT_FLOOR, pct(i.total_cents, "0.33"), excess));
    return { cents: c, receipts_required: i.total_cents > CURRENT_FLOOR, final_inspection_required: false, max_progress_cents: null };
  }
  if (i.total_cents <= DELINQUENT_LUMP) return { cents: i.total_cents, receipts_required: false, final_inspection_required: false, max_progress_cents: null };
  const quarter = pct(i.total_cents, "0.25");
  return { cents: minC(quarter, maxC(DELINQUENT_FLOOR, excess)), receipts_required: true, final_inspection_required: true, max_progress_cents: quarter };
}

/** Current-track progress: cumulative ≤ initial + pct_complete × remainder. */
export function progressReleaseCurrent(total: Cents, initial: Cents, releasedSoFar: Cents, pctComplete: string): Cents {
  const cap = initial + Decimal.fromBigInt(total - initial).mul(Decimal.parse(pctComplete)).toScaledInt(0, "HALF_UP");
  return maxC(0n, cap - releasedSoFar);
}

/** Delinquent-track progress: ≤ 25% per inspected increment; last release needs the final inspection. */
export function progressReleaseDelinquent(total: Cents, releasedSoFar: Cents, inspected: boolean, finalInspection: boolean): { cents: Cents; refused: string | null } {
  if (!inspected) return { cents: 0n, refused: "INSPECTION_REQUIRED" };
  const remaining = total - releasedSoFar;
  const cents = minC(pct(total, "0.25"), remaining);
  if (cents === remaining && !finalInspection) return { cents: 0n, refused: "FINAL_INSPECTION_REQUIRED" };
  return { cents, refused: null };
}

/** Rule 5 — daily balance × rate ÷ 365. */
export function custodialInterest(balance: Cents, ratePct: string, days: number): Cents {
  return Decimal.fromBigInt(balance).mul(Decimal.parse(ratePct).div(Decimal.fromInt(100))).mul(Decimal.fromInt(days)).div(Decimal.fromInt(365)).toScaledInt(0, "HALF_UP");
}

/** Rule 4 — contents/ALE released within 2 business days of deposit. */
export function contentsReleaseDue(depositedOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(depositedOn, 2, cal); }
/** Rule 9 — Form 176 within 5 business days of learning of the damage on an abandoned property. */
export function form176Due(learnedOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(learnedOn, 5, cal); }
/** Rule 9 — remit held proceeds within 30 days of REOgram confirmation; later proceeds within 10 fannie_et BD. */
export function reogramRemitDue(confirmedOn: PlainDate): PlainDate { return addDays(confirmedOn, 30); }
export function supplementalWireDue(receivedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(receivedOn, 10, cal); }

/** Rule 8 — public adjuster paid from proceeds only with recorded Fannie Mae approval. */
export function thirdPartyReleaseAllowed(fnmaApprovalRecorded: boolean): boolean { return fnmaApprovalRecorded; }

/** Rule 10 — authenticated app-captured photo/video; otherwise a vendor inspection (≤ $60). */
export function remoteInspectionAcceptable(m: { app_captured: boolean; gps: boolean; timestamp: boolean; hash: boolean }): boolean {
  return m.app_captured && m.gps && m.timestamp && m.hash;
}

/** Rule 1 — not rebuildable: all proceeds to UPB; payoff path when proceeds ≥ payoff. */
export function notRebuildableDisposition(proceeds: Cents, payoff: Cents): { curtailment_cents: Cents; payoff: boolean } {
  return proceeds >= payoff ? { curtailment_cents: payoff, payoff: true } : { curtailment_cents: proceeds, payoff: false };
}
