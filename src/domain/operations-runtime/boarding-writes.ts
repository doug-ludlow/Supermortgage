/**
 * §35.5 rules 1 and 9 at the boarding seam — what both boarding paths write in the same transaction as `loan.boarded`:
 * the installment schedule (installments.ts) and the loan's servicing configuration (servicing-config.ts).
 *
 *   planBoardingWrites(q, facts)        reads `jurisdiction_rules` and the active servicer profile (seeding the FAKE v1 when the
 *                                       table is empty) and returns the two plans — pure arithmetic on the note's terms; the rows
 *                                       are not written yet (the fund path's `loans` / `loan_terms` rows land in its `before` hook).
 *   persistBoardingWrites(q, plan)      the rows, after the `loans` and `loan_terms` rows they reference.
 *   appendBoardingWritten(events, …)    `installment.schedule.written` and `loan.servicing_config.written` — the satisfiers of
 *                                       SM_INSTALLMENT_SCHEDULE_AT_BOARD_0 and SM_LOAN_SERVICING_CONFIG_AT_BOARD_0, in the boarding commit.
 *
 * A note whose P&I is more than a cent from the level payment refuses the board (SCHEDULE_REQUIRED, rule 2 / HF-005). A tape
 * whose fields cannot project a schedule (no P&I, no first payment date, no maturity) is 1.1's exception: the transfer path
 * boards the loan without rows and the board-0 clock breaches to `officer` — never a guessed payment (edge case 2).
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { planScheduleAtBoarding, persistSchedule, appendScheduleWritten, ScheduleRefused, type SchedulePlan } from "./installments.ts";
import { activeServicerProfile, jurisdictionCashRules, planServicingConfig, persistServicingConfig, appendConfigWritten, ConfigRequired, type ServicingConfigPlan } from "./servicing-config.ts";

export interface BoardingLoanFacts {
  readonly loan_id: string;
  readonly terms_id: string;
  readonly source: "fund" | "transfer";
  readonly state: string | null | undefined;
  readonly note_rate_bps: number;
  readonly pi_cents: Cents | null;
  readonly escrow_payment_cents: Cents;
  readonly first_payment_date: PlainDate | null;
  readonly maturity_date: PlainDate | null;
  readonly upb_cents: Cents | null;
  readonly next_due_date?: PlainDate | null;
  readonly original_upb_cents?: Cents | null;
  readonly original_term_months?: number | null;
  readonly late_charge: { pct: string; grace_days: number };
  /** The boarding date (the transfer date; the disbursement date at fund) — the configuration's `effective_from`. */
  readonly boarded_on: PlainDate;
  readonly trigger_event_id?: string | null;
  readonly written_by: Record<string, unknown>;
}
export interface BoardingWritePlan {
  readonly loan_id: string;
  readonly schedule: SchedulePlan | null;
  readonly config: ServicingConfigPlan | null;
  /** Why a plan is null (the transfer path's per-loan exception; the fund path refuses instead). */
  readonly exceptions: { code: string; message: string }[];
}

/** The two plans for a boarding loan; `refuse: true` (the fund path) turns every exception into a thrown refusal. */
export async function planBoardingWrites(q: Queryable, f: BoardingLoanFacts, opts: { refuse?: boolean } = {}): Promise<BoardingWritePlan> {
  const exceptions: { code: string; message: string }[] = [];
  let schedule: SchedulePlan | null = null;
  try {
    if (f.pi_cents === null || f.pi_cents <= 0n || !f.first_payment_date || !f.maturity_date || f.upb_cents === null || f.upb_cents <= 0n) throw new ScheduleRefused("SCHEDULE_REQUIRED", `loan ${f.loan_id}: the tape lacks ${[f.pi_cents === null || f.pi_cents <= 0n ? "pi_cents" : null, !f.first_payment_date ? "first_payment_date" : null, !f.maturity_date ? "maturity_date" : null, f.upb_cents === null || f.upb_cents <= 0n ? "upb_cents" : null].filter(Boolean).join(", ")} — 1.1's exception, never a guessed payment`);
    schedule = planScheduleAtBoarding({ loan_id: f.loan_id, terms_id: f.terms_id, source: f.source, note_rate_bps: f.note_rate_bps, pi_cents: f.pi_cents, escrow_cents: f.escrow_payment_cents, first_payment_date: f.first_payment_date, maturity_date: f.maturity_date, upb_cents: f.upb_cents, next_due_date: f.next_due_date ?? null, original_upb_cents: f.original_upb_cents ?? null, original_term_months: f.original_term_months ?? null, trigger_event_id: f.trigger_event_id ?? null });
  } catch (e) {
    if (!(e instanceof ScheduleRefused) || opts.refuse) throw e;
    exceptions.push({ code: e.code, message: e.message });
  }
  let config: ServicingConfigPlan | null = null;
  try {
    const profile = await activeServicerProfile(q, f.boarded_on);
    const rules = f.state ? await jurisdictionCashRules(q, f.state) : { late_charge: null, nsf_fee: null };
    config = planServicingConfig({ loan_id: f.loan_id, effective_from: f.boarded_on, state: f.state, note: f.late_charge, rules, servicer_profile_id: profile.id, written_by: f.written_by });
  } catch (e) {
    if (!(e instanceof ConfigRequired) || opts.refuse) throw e;
    exceptions.push({ code: e.code, message: e.message });
  }
  return { loan_id: f.loan_id, schedule, config, exceptions };
}

export async function persistBoardingWrites(q: Queryable, p: BoardingWritePlan): Promise<void> {
  if (p.schedule) await persistSchedule(q, p.schedule);
  if (p.config) await persistServicingConfig(q, p.config);
}

export function appendBoardingWritten(events: EventStore, p: BoardingWritePlan, actor: Actor, opts: { causationId?: string } = {}): DomainEvent[] {
  const out: DomainEvent[] = [];
  if (p.schedule) out.push(appendScheduleWritten(events, p.schedule, actor, opts));
  if (p.config) out.push(appendConfigWritten(events, p.config, actor, opts));
  return out;
}

/** `late_charge_pct_bps` (×1000: 5% = 5000) back to the percent string 2.7's `lateChargeTerms` reads. */
export const lateChargePctFromBps = (bps: number | null | undefined, fallback = "5"): string => (bps === null || bps === undefined ? fallback : (bps / 1000).toString());
