/** 18.4 Form 582 — deadlines, insurance adequacy (A3-5-02/03), materiality clocks. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, nextBusinessDay } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export function form582Clocks(fye: PlainDate): { due: PlainDate; partner_package_due: PlainDate; afs_target: PlainDate; warn_30: PlainDate; warn_60: PlainDate } {
  return { due: addDays(fye, 90), partner_package_due: addDays(fye, 60), afs_target: addDays(fye, 75), warn_30: addDays(fye, 30), warn_60: addDays(fye, 60) };
}

const bps = (amount: Cents, rate: string) => Decimal.fromBigInt(amount).mul(Decimal.parse(rate)).toScaledInt(0, "HALF_UP");

/** Fidelity: $300,000 + 0.15% of UPB $100M–$500M + 0.125% of $500M–$1B + 0.10% above $1B; E&O same, capped $10M; max deductible 15%. */
export function insuranceRequirement(highestMonthlyServicingUpb: Cents, annualOriginationsUpb: Cents = 0n): { fidelity_cents: Cents; eo_cents: Cents; max_deductible_cents: Cents } {
  const base = highestMonthlyServicingUpb > annualOriginationsUpb ? highestMonthlyServicingUpb : annualOriginationsUpb;
  const tier = (lo: Cents, hi: Cents) => (base <= lo ? 0n : (base < hi ? base : hi) - lo);
  const fidelity = 30_000_000n + bps(tier(10_000_000_000n, 50_000_000_000n), "0.0015") + bps(tier(50_000_000_000n, 100_000_000_000n), "0.00125") + bps(tier(100_000_000_000n, 1n << 62n), "0.0010");
  const eo = fidelity < 1_000_000_000n ? fidelity : 1_000_000_000n;
  return { fidelity_cents: fidelity, eo_cents: eo, max_deductible_cents: bps(fidelity, "0.15") };
}
export function insuranceAdequate(policyFidelity: Cents, policyEo: Cents, req: ReturnType<typeof insuranceRequirement>): boolean { return policyFidelity >= req.fidelity_cents && policyEo >= req.eo_cents; }
export function insuranceExpiryWarning(expiresOn: PlainDate): PlainDate { return addDays(expiresOn, -30); }

export type ChangeClass = "pending_actions_5bd" | "major_change_60d_advance" | "immediate";
export function orgChangeClocks(cls: ChangeClass, recordedOn: PlainDate, effectiveOn: PlainDate | null, cal: Calendar = fannieEt): { fnma_due: PlainDate; partner_due: PlainDate; internal_target: PlainDate; already_passed: boolean } {
  if (cls === "pending_actions_5bd") { const due = addBusinessDays(recordedOn, 5, cal); return { fnma_due: due, partner_due: nextBusinessDay(recordedOn, cal), internal_target: addBusinessDays(recordedOn, 4, cal), already_passed: false }; }
  if (cls === "major_change_60d_advance") { const due = addDays(effectiveOn ?? recordedOn, -60); return { fnma_due: due, partner_due: nextBusinessDay(recordedOn, cal), internal_target: addDays(due, -5), already_passed: due < recordedOn }; }
  return { fnma_due: recordedOn, partner_due: recordedOn, internal_target: recordedOn, already_passed: false };
}
export function form582SubmittedAllowed(ecrmConfirmationDocId: string | null): boolean { return ecrmConfirmationDocId !== null; }
