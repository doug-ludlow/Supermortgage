/**
 * Allocation Engine, rule set `cashiering.allocation.v1` (2.1 rule 5) with
 * the 2.2 $50 rule for partials. Pure: takes loan cash state + payment facts,
 * returns the plan and the next state without touching ledgers or events.
 */
import { type PlainDate } from "../../kernel/calendar/date.ts";
import { monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type LoanCashState, type Allocation, type AllocationOutcome, type Designation, type InstallmentProjection, type HoldType, instrumentProfile, BUCKET_ORDER, cashCfg } from "./types.ts";

export const RULE_SET = "cashiering.allocation.v1";
export const FIFTY_RULE_MAX_SHORTFALL = 5_000n;

export interface AllocationRequest {
  readonly payment_id: string;
  readonly amount_cents: Cents;
  readonly received_on: PlainDate;
  readonly credited_as_of: PlainDate;
  readonly designation: Designation;
  readonly instruction_text?: string;
  /** Explicit curtailment amount carried on the item (portal "additional principal" field, contractor addenda "PRIN n"). */
  readonly curtailment_cents?: Cents;
  /** 2.2 rule 4 / 2.6: applying already-held funds — overlays were evaluated when the funds were held. */
  readonly bypass_overlays?: boolean;
}

export interface InstallmentApplication {
  readonly due_date: PlainDate;
  readonly interest_cents: Cents;
  readonly principal_cents: Cents;
  readonly escrow_cents: Cents;
  readonly upb_after_cents: Cents;
  readonly kind: "contractual" | "prepaid";
  readonly fifty_rule_shortfall_cents?: Cents;
}

export interface AllocationPlan {
  readonly outcome: AllocationOutcome;
  readonly allocations: readonly Allocation[];
  readonly installments: readonly InstallmentApplication[];
  readonly late_charge_cents: Cents;
  readonly nsf_fee_cents: Cents;
  readonly other_fee_cents: Cents;
  readonly curtailment_cents: Cents;
  readonly curtailment_nib_cents: Cents;             // portion applied to deferred/forborne principal (2.4 rule 4)
  readonly to_suspense_cents: Cents;                 // remainder parked (or the whole amount when held)
  readonly redirected_curtailment: boolean;          // 2.4 rule 3: designated principal used for unpaid installments instead
  readonly hold?: HoldType | "trial" | "plan";
  readonly refused_instruction?: { text: string; reason: string; cite: string };
  readonly next: LoanCashState;
  readonly rule_path: string[];
}

function cloneState(s: LoanCashState): LoanCashState {
  return { ...s, installments: s.installments.map((i) => ({ ...i })), holds: [...s.holds], ...(s.fees ? { fees: s.fees.map((f) => ({ ...f })) } : {}), ...(s.overlays ? { overlays: [...s.overlays] } : {}) };
}

const HOLD_OUTCOME: Record<HoldType, AllocationOutcome> = {
  bankruptcy: "held_bk", foreclosure_post_referral: "held_fc", noe_dispute: "held_dispute", fraud: "held_other",
  deceased_estate: "held_other", payoff_pending: "payoff_routed", transfer_out_cutover: "held_other",
};

export function allocate(state: LoanCashState, req: AllocationRequest): AllocationPlan {
  const next = cloneState(state);
  const path: string[] = [];
  const allocations: Allocation[] = [];
  let seq = 0;
  const push = (bucket: Allocation["bucket"], amount: Cents, due: PlainDate | null, ruleRef: string) => {
    if (amount !== 0n) allocations.push({ sequence: ++seq, installment_due_date: due, bucket, amount_cents: amount, rule_ref: ruleRef, credited_as_of: req.credited_as_of });
  };
  const profile = instrumentProfile(state.instrument_date);
  const orderRef = profile === "uniform_1999_plus" ? "F-1-09:order_1999plus" : "F-1-09:order_pre1999";

  // Refused instructions never change the installment order (rule 6; C-1.1-01).
  let refused: AllocationPlan["refused_instruction"] | undefined;
  if (req.instruction_text && /second|2nd|subordinate|junior|heloc/i.test(req.instruction_text)) {
    refused = { text: req.instruction_text, reason: "an instruction to apply a first-lien payment to a subordinate lien is refused", cite: "Servicing Guide C-1.1-01" };
    path.push("instruction.refused:C-1.1-01");
  }

  // Overlays first (rule 5): holds, payoff.
  const held: AllocationPlan = {
    outcome: "unapplied", allocations, installments: [], late_charge_cents: 0n, nsf_fee_cents: 0n, other_fee_cents: 0n, curtailment_cents: 0n, curtailment_nib_cents: 0n, to_suspense_cents: req.amount_cents, redirected_curtailment: false, next, rule_path: path,
    ...(refused ? { refused_instruction: refused } : {}),
  };
  if (req.designation === "payoff") { path.push("overlay.payoff→16.2"); return { ...held, outcome: "payoff_routed" }; }
  if (!req.bypass_overlays && state.holds.length > 0) {
    const h = state.holds[0]!;
    path.push(`overlay.hold:${h}`);
    next.suspense_unapplied_cents += req.amount_cents;
    push("suspense", req.amount_cents, null, `2.1:hold:${h}`);
    return { ...held, outcome: HOLD_OUTCOME[h], hold: h };
  }
  if (!req.bypass_overlays && state.trial_active) { path.push("overlay.trial→2.6"); next.suspense_unapplied_cents += req.amount_cents; push("suspense", req.amount_cents, null, "2.6:trial_hold"); return { ...held, outcome: "held_trial", hold: "trial" }; }

  // Available funds A = payment + open suspense not under a hold.
  let pool = req.amount_cents + state.suspense_unapplied_cents;
  const suspenseUsed = state.suspense_unapplied_cents;
  if (suspenseUsed > 0n) { path.push(`suspense.accumulated:${suspenseUsed}`); push("suspense", -suspenseUsed, null, "2.2:accumulation"); }
  next.suspense_unapplied_cents = 0n;

  const rate = ratePercent(state.note_rate_pct);
  const applied: InstallmentApplication[] = [];
  const open = next.installments.filter((i) => i.status === "due").sort((a, b) => (a.due_date < b.due_date ? -1 : 1));

  const applyInstallment = (inst: InstallmentProjection, escrowShort: Cents): void => {
    const interest = monthlyInterest(next.upb_cents, rate);                 // 30 days' interest on UPB as of LPI (F-1-09)
    const principal = inst.pi_cents - interest;
    const escrow = inst.escrow_cents - escrowShort;
    const kind: InstallmentApplication["kind"] = inst.due_date > req.received_on ? "prepaid" : "contractual";
    for (const b of BUCKET_ORDER[profile]) {
      if (b === "interest") push("interest", interest, inst.due_date, `${orderRef}:interest`);
      else if (b === "principal") push("principal", principal, inst.due_date, `${orderRef}:principal`);
      else if (b === "escrow") push("escrow", escrow, inst.due_date, `${orderRef}:escrow`);
    }
    next.upb_cents -= principal;
    next.lpi_date = inst.due_date;
    inst.status = kind === "prepaid" ? "prepaid" : "satisfied";
    inst.satisfied_on = req.received_on; inst.credited_as_of = req.credited_as_of; inst.satisfied_by_payment_id = req.payment_id;
    applied.push({ due_date: inst.due_date, interest_cents: interest, principal_cents: principal, escrow_cents: escrow, upb_after_cents: next.upb_cents, kind, ...(escrowShort > 0n ? { fifty_rule_shortfall_cents: escrowShort } : {}) });
  };

  // n installments oldest-first while the pool covers the full periodic payment P for that installment.
  for (const inst of open) {
    const P = inst.pi_cents + inst.escrow_cents;
    if (pool < P) break;
    pool -= P; applyInstallment(inst, 0n);
  }
  let outcome: AllocationOutcome = applied.length ? "applied" : "unapplied";
  if (applied.length) path.push(`installments.applied:${applied.length}`);

  // Partial (n = 0) → 2.2: the $50 rule first, deterministic.
  if (applied.length === 0 && open.length > 0) {
    const inst = open[0]!;
    const P = inst.pi_cents + inst.escrow_cents;
    const shortfall = P - pool;
    const eligible = shortfall <= FIFTY_RULE_MAX_SHORTFALL && state.escrowed && profile === "uniform_1999_plus" && state.lien === "first" && state.partial_count_12m < 3 && !state.opted_out_of_50_rule;
    if (eligible) {
      path.push(`2.2:50_rule:shortfall=${shortfall}`);
      applyInstallment(inst, shortfall);
      pool = 0n;
      next.partial_count_12m += 1;
      outcome = "applied_with_50_rule";
    } else {
      path.push("2.2:partial→suspense");
      next.suspense_unapplied_cents = pool;
      push("suspense", pool, null, "2.2:partial_hold");
      return { outcome: "unapplied", allocations, installments: [], late_charge_cents: 0n, nsf_fee_cents: 0n, other_fee_cents: 0n, curtailment_cents: 0n, curtailment_nib_cents: 0n, to_suspense_cents: pool, redirected_curtailment: false, next, rule_path: path, ...(refused ? { refused_instruction: refused } : {}) };
    }
  }

  // Remainder R (rule 5): curtailment if designated, else outstanding late charges / fees, else suspense.
  let curtailment = 0n, curtailmentNib = 0n, lc = 0n, nsf = 0n, other = 0n, redirected = false;
  const principalInstruction = req.designation === "curtailment" || (req.curtailment_cents ?? 0n) > 0n || (!!req.instruction_text && !refused && /principal|curtail/i.test(req.instruction_text));
  const stillDue = next.installments.some((i) => i.status === "due" && i.due_date <= req.received_on);
  if (pool > 0n && principalInstruction && stillDue) {
    // 2.4 rule 3: on a delinquent loan designated principal cures installments first; what is left is held toward the next, never curtailed.
    redirected = true; path.push("2.4:r3:redirected_to_cure");
  } else if (pool > 0n && principalInstruction) {
    curtailment = req.curtailment_cents && req.curtailment_cents < pool ? req.curtailment_cents : pool;
    pool -= curtailment;
    // 2.4 rule 4 NIB order: amount < IB UPB → all to IB; amount ≥ IB UPB → NIB first, then IB.
    const nib = cashCfg(next).deferred + cashCfg(next).forborne;
    if (nib > 0n && curtailment >= next.upb_cents) {
      curtailmentNib = curtailment < nib ? curtailment : nib;
      let left = curtailmentNib;
      const d = cashCfg(next).deferred, useD = left < d ? left : d; next.deferred_principal_cents = d - useD; left -= useD;
      const f = cashCfg(next).forborne, useF = left < f ? left : f; next.forborne_principal_cents = f - useF;
      next.upb_cents -= curtailment - curtailmentNib;
      if (curtailmentNib) push("deferred_principal", curtailmentNib, null, "2.4:r4:nib_first");
      if (curtailment - curtailmentNib) push("curtailment", curtailment - curtailmentNib, null, "2.4:curtailment");
    } else {
      next.upb_cents -= curtailment;
      push("curtailment", curtailment, null, "2.4:curtailment");
    }
    path.push(`remainder.curtailment:${curtailment}`);
    if (!applied.length) outcome = "curtailment";
  } else if (pool > 0n) {
    lc = pool < next.late_charges_due_cents ? pool : next.late_charges_due_cents; pool -= lc; next.late_charges_due_cents -= lc;
    if (lc > 0n) { push("late_charge", lc, null, `${orderRef}:late_charge`); path.push(`remainder.late_charges:${lc}`); }
    nsf = pool < next.nsf_fees_due_cents ? pool : next.nsf_fees_due_cents; pool -= nsf; next.nsf_fees_due_cents -= nsf;
    if (nsf > 0n) push("nsf_fee", nsf, null, "2.1:remainder:nsf_fee");
    other = pool < next.other_fees_due_cents ? pool : next.other_fees_due_cents; pool -= other; next.other_fees_due_cents -= other;
    if (other > 0n) push("other_fee", other, null, "2.1:remainder:other_fee");
  }
  if (pool > 0n) { next.suspense_unapplied_cents += pool; push("suspense", pool, null, "2.1:remainder_under_p"); path.push(`remainder.suspense:${pool}`); }
  if (applied.length && applied.every((a) => a.kind === "prepaid")) outcome = "prepaid";

  return { outcome, allocations, installments: applied, late_charge_cents: lc, nsf_fee_cents: nsf, other_fee_cents: other, curtailment_cents: curtailment, curtailment_nib_cents: curtailmentNib, to_suspense_cents: pool, redirected_curtailment: redirected, next, rule_path: path, ...(refused ? { refused_instruction: refused } : {}) };
}
