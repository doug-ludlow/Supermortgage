/**
 * §2.5 gate evaluators, keyed "2.5.<name>". Every key must be named by an `evaluator:` override in
 * timers-2-5.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there. Both evaluators compute their verdict
 * from the receipt/loan facts — none is satisfiable by a caller's own label.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { biweeklyInterest } from "./biweekly.ts";
import { DEFAULT_CHANNELS } from "./receipt.ts";
import type { Channel } from "./types.ts";

export const EVALUATORS_2_5: Record<string, Evaluator> = {
  /**
   * FNMA_C1104_ACCEPT_CONTRACTOR_PAYMENT_GATE — "a conforming, sufficient, timely contractor payment must be accepted and
   * posted like any other payment (never refused because the payer is a contractor)". Facts are the receipt's own:
   * `channel`, `conforming` (receiptDates' verdict against the written payment requirements; defaults to the channel table),
   * `amount_cents` vs `periodic_payment_cents` (sufficient = a full P; a half is held under 2.2 — still never refused),
   * `received_on` vs `grace_end_on` (timely = credited by the grace end, 2.7).
   */
  "2.5.acceptConformingContractorPayment": (f) => {
    const channel = s(f, "channel");
    if (channel !== "third_party_contractor") return no(`not a contractor payment (channel ${channel || "unknown"})`);
    const conforming = f.conforming === undefined ? DEFAULT_CHANNELS[channel as Channel]?.conforming === true : b(f, "conforming");
    if (!conforming) return no("nonconforming contractor payment: 2.1 nonconforming-receipt rule, not C-1.1-04");
    const amount = c(f, "amount_cents"), periodic = c(f, "periodic_payment_cents");
    if (periodic <= 0n) return no("periodic payment unknown");
    if (amount < periodic) return no(`insufficient: ${amount}¢ < periodic payment ${periodic}¢ — held as a biweekly half / partial (2.2), not refused`);
    const receivedOn = s(f, "received_on"), graceEnd = s(f, "grace_end_on");
    if (!receivedOn || !graceEnd) return no("received_on and grace_end_on are required to judge timeliness");
    if (receivedOn > graceEnd) return no(`untimely: settled ${receivedOn}, after the grace end ${graceEnd} — accepted, late charge per the note (2.7, rule 3)`);
    return ok;
  },
  /** NOTE_BIWEEKLY_INTEREST_14D_RULE — rule 5: installment interest = round_half_up(UPB × rate × 14 ÷ 365) [UNVERIFIED day count]; recomputed from `upb_cents` and `rate_pct`. */
  "2.5.biweeklyInterest": (f) => {
    const upb = c(f, "upb_cents"), rate = s(f, "rate_pct");
    if (upb <= 0n || !rate) return no("upb_cents and rate_pct are required");
    const expected = biweeklyInterest(upb, rate), actual = c(f, "interest_cents");
    return actual === expected ? ok : no(`biweekly installment interest must be round_half_up(UPB × rate × 14 ÷ 365) = ${expected}¢ on ${upb}¢ at ${rate}%, got ${actual}¢ (rule 5; day count UNVERIFIED)`);
  },
};
export const kit_2_5 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
