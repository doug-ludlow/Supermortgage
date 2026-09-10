/** 18.7 Net-worth / liquidity eligibility — bigint cents, bps math rounded per component. */
import { type PlainDate, addDays, endOfMonth, addMonths, parts } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";

const bps = (amount: Cents, num: bigint, den: bigint): Cents => { const n = amount * num; const q = n / den; const r = n % den; return r * 2n >= den ? q + 1n : q; };

export interface NetWorthInput {
  readonly total_equity: Cents; readonly goodwill_intangibles: Cents; readonly affiliate_receivables: Cents; readonly pledged_assets_net: Cents; readonly total_assets: Cents;
  readonly ent_ss_sa_upb: Cents; readonly ent_aa_upb: Cents; readonly gnma_upb: Cents; readonly other_upb: Cents;
  readonly cash_unrestricted: Cents; readonly eligible_securities: Cents; readonly advance_line_committed: Cents; readonly advance_line_drawn: Cents;
  readonly hfs_and_irlc?: Cents; readonly quarterly_originations_over_1b?: boolean;
  readonly prior_anw?: Cents | null; readonly two_quarters_back_anw?: Cents | null; readonly four_quarters_back_anw?: Cents | null; readonly consecutive_loss_quarters?: number;
}
export interface NetWorthResult {
  readonly anw: Cents; readonly req_nw: Cents; readonly nw_surplus: Cents; readonly ratio_bps: number; readonly allowable_liquidity: Cents; readonly required_liquidity: Cents; readonly liquidity_surplus: Cents;
  readonly large: boolean; readonly decline_flags: { q_over_q_25: boolean; two_q_40: boolean; losses_4q_30: boolean }; readonly status: "compliant" | "warning" | "breach";
}
export function netWorth(i: NetWorthInput): NetWorthResult {
  const anw = i.total_equity - i.goodwill_intangibles - i.affiliate_receivables - i.pledged_assets_net;
  const ent = i.ent_ss_sa_upb + i.ent_aa_upb;
  const req = 250_000_000n + bps(ent, 25n, 10_000n) + bps(i.gnma_upb, 35n, 10_000n) + bps(i.other_upb, 25n, 10_000n);
  const ratio = Number(bps(anw, 10_000n, i.total_assets));
  const undrawn = i.advance_line_committed - i.advance_line_drawn;
  const allowable = i.cash_unrestricted + i.eligible_securities + bps(undrawn > 0n ? undrawn : 0n, 50n, 100n);
  const total = ent + i.gnma_upb + i.other_upb;
  const large = total >= 5_000_000_000_000n;
  let reqLiq = bps(i.ent_ss_sa_upb, 7n, 10_000n) + bps(i.ent_aa_upb, 35n, 100_000n) + bps(i.gnma_upb, 10n, 10_000n) + bps(i.other_upb, 35n, 100_000n);
  if (i.quarterly_originations_over_1b && i.hfs_and_irlc) reqLiq += bps(i.hfs_and_irlc, 50n, 10_000n);
  if (large) reqLiq += bps(ent, 2n, 10_000n) + bps(i.gnma_upb, 5n, 10_000n);
  const pct = (now: Cents, then: Cents | null | undefined) => (then === null || then === undefined || then <= 0n ? 0 : Number(((then - now) * 10_000n) / then) / 100);
  const flags = { q_over_q_25: pct(anw, i.prior_anw) >= 25, two_q_40: pct(anw, i.two_quarters_back_anw) >= 40, losses_4q_30: (i.consecutive_loss_quarters ?? 0) >= 4 && pct(anw, i.four_quarters_back_anw) >= 30 };
  const nwS = anw - req, lqS = allowable - reqLiq;
  let status: NetWorthResult["status"] = "compliant";
  if (nwS < 0n || lqS < 0n || ratio < 600 || flags.q_over_q_25 || flags.two_q_40 || flags.losses_4q_30) status = "breach";
  // Warning band: surplus below 25% of the requirement or of ANW (worked example 2: $800k / $3.3M = 24.24%).
  else if (nwS * 4n < req || nwS * 4n < anw || lqS * 4n < reqLiq) status = "warning";
  return { anw, req_nw: req, nw_surplus: nwS, ratio_bps: ratio, allowable_liquidity: allowable, required_liquidity: reqLiq, liquidity_surplus: lqS, large, decline_flags: flags, status };
}
/** Form 1002 due: quarter-end + 30 days (year-end + 60). */
export function form1002Due(quarterEnd: PlainDate): { due: PlainDate; warning: PlainDate } {
  const ye = parts(quarterEnd).m === 12;
  const due = addDays(quarterEnd, ye ? 60 : 30);
  return { due, warning: addDays(due, -10) };
}
export function capitalPlanDue(yearEnd: PlainDate): PlainDate { return addDays(yearEnd, 90); }
export function glStale(closedByBd5: boolean): boolean { return !closedByBd5; }
export function form1002SubmittedAllowed(webmbConfirmation: string | null, ceoCfoCertification: string | null): boolean { return webmbConfirmation !== null && ceoCfoCertification !== null; }
export function serviceOneLoanBreach(fnmaLoansAtDec31: number): boolean { return fnmaLoansAtDec31 === 0; }
export { endOfMonth, addMonths };
