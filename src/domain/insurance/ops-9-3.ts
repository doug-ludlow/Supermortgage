/**
 * §9.3 Force-placed — reminder notice: the reminder job over the 9.2 case service (ops-9-2.ts owns `fpi_cases` and
 * appends the §1024.37 clock events `fpi.first_notice.sent` / `fpi.reminder.sent` / `fpi.evidence_window.evaluated`;
 * the Notice Registry appends `notice.production` / `notice.mailed`). This file owns the reminder decision record:
 *
 *   `fpi.reminder.produced{variant, template, annual_premium_cents, premium_is_estimate, estimate_basis, unverified_ranges}`
 *   `fpi.reminder.regenerated{previous_notice_id, reason}`   ← production > 5 federal business days before mailing (comment 37(d)(5)-1)
 *   `fpi.reminder.cancelled{reason}`                          ← `fpi.case.closed` before mailing (spec: "Case closed by payoff before mailing: cancel the reminder")
 *
 * Guardrails (9.3 agent design): the variant is deterministic from the evidence rows (the model cannot override — rule 1);
 * the cost figure traces to a carrier quote or the program rate table with the basis stored (rule 2); the render is
 * refused without the "second and final notice" sentence (the MS-3(B)/(C) checklists in src/notices/authored/section09.ts);
 * `officer` escalation when no quote is available for > 2 business days (the charge date slips). bigint cents; PlainDate.
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, businessDaysBetween, federal, servicer, type Calendar } from "../../kernel/calendar/business.ts";
import type { DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { fpiClocks, premiumQuote, productionWindowOk, reminderVariant, type EvidenceRow, type PremiumQuote } from "./fpi.ts";
import { Fpi92Service, INSURANCE_AGENT, REMINDER_TEMPLATES, type FpiCase, type QuoteInput } from "./ops-9-2.ts";

export type ReminderVariantCode = "b_no_info" | "c_insufficient";
export interface ReminderFacts {
  readonly borrower_name: string; readonly borrower_address: string; readonly property_address: string; readonly account_last4: string;
  readonly notice_date: PlainDate; readonly servicer_phone: string; readonly servicer_address: string; readonly insurance_email: string;
}
export interface ReminderComposition {
  readonly case_id: string; readonly variant: ReminderVariantCode; readonly template: string; readonly gaps: readonly { readonly from: PlainDate; readonly to: PlainDate }[];
  readonly quote: PremiumQuote; readonly estimate_basis: string | null; readonly payload: Record<string, unknown>; readonly event: DomainEvent;
}
/** Policy window (9.3 timer table / open decision 2): mail on the first business day on/after t0 + 30, never later than t0 + 35. */
export const REMINDER_TARGET_WINDOW = { open_days: 30, close_days: 35 } as const;
/** Rule 5 / comment 37(d)(5)-1: a render is stale once mailing is more than 5 federal business days after production. */
export const PRODUCTION_WINDOW_FEDERAL_BD = 5;
/** 9.3 agent design: `officer` if a quote is unavailable for > 2 business days (the charge date slips). */
export const QUOTE_ESCALATION_BD = 2;

/** The policy mailing target for a first notice mailed on t0: the first servicer business day on/after t0 + 30, capped at t0 + 35. */
export function reminderTargetDate(t0: PlainDate, cal: Calendar = servicer): { target: PlainDate; not_before: PlainDate; not_after: PlainDate } {
  const not_before = addDays(t0, REMINDER_TARGET_WINDOW.open_days), not_after = addDays(t0, REMINDER_TARGET_WINDOW.close_days);
  const rolled = cal.isBusinessDay(not_before) ? not_before : addBusinessDays(not_before, 1, cal);
  return { target: rolled <= not_after ? rolled : not_after, not_before, not_after };
}
/** Rule 5: `mail_by` = production + 5 federal business days; a later mailing requires regeneration (9.3-T4). */
export function reminderProductionCheck(producedOn: PlainDate, mailingOn: PlainDate): { ok: boolean; mail_by: PlainDate; federal_business_days: number } {
  return { ok: productionWindowOk(producedOn, mailingOn), mail_by: addBusinessDays(producedOn, PRODUCTION_WINDOW_FEDERAL_BD, federal), federal_business_days: businessDaysBetween(producedOn, mailingOn, federal) };
}
/** Escalation rule: no quote for more than 2 servicer business days after the request → `officer`. */
export function quoteEscalation(requestedOn: PlainDate, asOf: PlainDate, quoted: boolean, cal: Calendar = servicer): "none" | "officer" {
  return !quoted && businessDaysBetween(requestedOn, asOf, cal) > QUOTE_ESCALATION_BD ? "officer" : "none";
}
/** Rule 2: the stored estimate basis (rate-table version, coverage, tier, occupancy, delinquency status used) — null for a carrier quote. */
export function estimateBasis(q: PremiumQuote, i: { coverage_cents: Cents; deductible_cents?: Cents; occupancy?: string; state?: string | null; delinquency_status?: string; rate_table_version?: string }): string | null {
  if (!q.is_estimate) return null;
  return [`${q.basis}`, `version=${i.rate_table_version ?? "current"}`, `coverage_cents=${i.coverage_cents}`, `deductible_cents=${i.deductible_cents ?? 0n}`, `occupancy=${i.occupancy ?? "occupied"}`, `state=${i.state ?? "n/a"}`, `delinquency=${i.delinquency_status ?? "current"}`].join("; ");
}

export interface ComposeReminderInput {
  readonly case_id: string; readonly evidence: readonly EvidenceRow[]; readonly facts: ReminderFacts; readonly produced_on: PlainDate;
  readonly quote: QuoteInput & { readonly coverage_cents: Cents; readonly deductible_cents?: Cents; readonly occupancy?: string; readonly delinquency_status?: string; readonly quote_id?: string };
  /** Set when this render replaces a stale one (rule 5) — appends `fpi.reminder.regenerated` instead of a first `produced`. */
  readonly regenerates?: { readonly previous_notice_id: string; readonly reason: string };
}

/**
 * The reminder job (state machine `reminder_eligible` → `reminder_in_production`): selects the MS-3(B)/(C) variant from the
 * evidence rows, prices the annual premium (carrier quote, else rate table flagged "estimated" with the basis stored on
 * `fpi_cases`) and returns the render payload for the Notice Registry. Refused on a case without a mailed first notice,
 * on a closed case, and on the flood track (the 9.6 flood notice has no MS-3 reminder). The `notice_date` may precede
 * t0 + 30 — production runs up to 5 federal business days ahead of the mailing the 30-day gate governs.
 */
export function composeReminder(svc: Fpi92Service, events: EventStore, i: ComposeReminderInput): ReminderComposition {
  const c = svc.get(i.case_id);
  if (c.status !== "first_notice_sent" || !c.first_notice_mailed_at) throw new RangeError(`case ${c.case_id} is ${c.status}: the reminder follows a mailed first notice (§1024.37(d)(1))`);
  if (c.track === "fdpa_flood") throw new RangeError("no MS-3(B)/(C) on the fdpa_flood track — the FDPA notice runs under 9.6");
  const clocks = fpiClocks(c.first_notice_mailed_at, null);
  const v = reminderVariant(i.evidence, c.lapse_start, i.produced_on);
  const q = premiumQuote(i.quote.carrier_quote_cents, i.quote.coverage_cents, i.quote.table_rate_pct);
  const basis = estimateBasis(q, { coverage_cents: i.quote.coverage_cents, ...(i.quote.deductible_cents !== undefined ? { deductible_cents: i.quote.deductible_cents } : {}), ...(i.quote.occupancy !== undefined ? { occupancy: i.quote.occupancy } : {}), state: c.state, ...(i.quote.delinquency_status !== undefined ? { delinquency_status: i.quote.delinquency_status } : {}), ...(i.quote.rate_table_version !== undefined ? { rate_table_version: i.quote.rate_table_version } : {}) });
  c.annual_premium_cents = q.annual_premium_cents; c.premium_is_estimate = q.is_estimate; c.estimate_basis = basis;
  const unverified_ranges = v.gaps.map((g) => ({ start: g.from, end: g.to }));
  const payload: Record<string, unknown> = {
    ...i.facts, insurance_type: c.insurance_type === "wind" ? "windstorm" : c.insurance_type, status_phrase: c.kind === "insufficient_coverage" || c.kind === "perils_gap" ? "provides insufficient coverage" : "expired",
    coverage_event_date: c.lapse_start, annual_premium_cents: q.annual_premium_cents, premium_is_estimate: q.is_estimate, estimate_basis_present: basis !== null,
    days_after_first_notice: REMINDER_TARGET_WINDOW.open_days, unverified_ranges, additional_information: false, mail_class: "first_class",
  };
  const template = REMINDER_TEMPLATES[v.variant];
  const base = { notice_kind: "reminder", variant: v.variant, template, produced_on: i.produced_on, reminder_not_before: clocks.reminder_not_before, mail_by: addBusinessDays(i.produced_on, PRODUCTION_WINDOW_FEDERAL_BD, federal),
    annual_premium_cents: q.annual_premium_cents, premium_is_estimate: q.is_estimate, estimate_basis: basis, cost_traced_to: q.is_estimate ? `rate_table:${i.quote.rate_table_version ?? "current"}` : `carrier_quote:${i.quote.quote_id ?? "unknown"}`,
    unverified_ranges, evidence_rows: i.evidence.length, written_evidence_rows: i.evidence.filter((e) => e.written).length };
  const event = events.append({ type: i.regenerates ? "fpi.reminder.regenerated" : "fpi.reminder.produced", loanId: c.loan_id, aggregate: { kind: "fpi_case", id: c.case_id }, actor: INSURANCE_AGENT,
    payload: { case_id: c.case_id, loan_id: c.loan_id, ...base, ...(i.regenerates ? { previous_notice_id: i.regenerates.previous_notice_id, reason: i.regenerates.reason } : {}) } });
  return { case_id: c.case_id, variant: v.variant, template, gaps: v.gaps, quote: q, estimate_basis: basis, payload, event };
}

/** Spec edge case "case closed by payoff before mailing: cancel the reminder" — a produced-but-unmailed reminder is cancelled when the case closes. */
export function reminderReactors_9_3(svc: Fpi92Service, events: EventStore): () => void {
  const off = events.subscribe("fpi.case.closed", (e) => {
    const caseId = e.aggregate?.id; if (!caseId) return;
    const c: FpiCase | undefined = svc.all().find((x) => x.case_id === caseId); if (!c || c.reminder_mailed_at) return;
    const produced = events.all().filter((x) => (x.type === "fpi.reminder.produced" || x.type === "fpi.reminder.regenerated") && x.aggregate?.id === caseId);
    if (produced.length === 0) return;
    events.append({ type: "fpi.reminder.cancelled", loanId: c.loan_id, aggregate: { kind: "fpi_case", id: caseId }, actor: INSURANCE_AGENT, causationId: e.id, payload: { case_id: caseId, loan_id: c.loan_id, reason: String((e.payload as { closed_reason?: unknown }).closed_reason ?? c.closed_reason ?? "closed"), produced_renders: produced.length } });
  });
  return off;
}
