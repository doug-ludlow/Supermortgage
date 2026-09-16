/**
 * §35.9 — Default operations over time: the case engine's own vocabulary. Every event literal this process emits lives
 * here as a string constant (tools/lint-emission.ts counts a timer's trigger/satisfied event only when a non-test source
 * names it), with the consumed-event list (rule 1), the expectation map (rule 4 / state machine), the deterministic docket
 * class set and confidence threshold (rule 6), the breach action kinds and the ACTION_MATCHES_CITED_TEXT keyword table
 * (rule 7), the jurisdiction defaults' in-code fallback (open question 4) and the worked examples' expected figures
 * (rules 5 and 9; asserted to the cent by 35-9.spec.test.ts against the sections' own tools).
 *
 * Nothing here computes money: the figures are what 13.5's `exposureCents` and 15.2/15.3's assemblers produce for the
 * spec's inputs; this file only states the expectation the test asserts.
 */
import type { Actor } from "../../kernel/events/index.ts";

export const PROCESS_35_9 = "35.9";
export const AGENT_35_9 = "foreclosure-ops";
export const RULE_SET_VERSION_35_9 = "default-ops.v1";
export const PROMPT_VERSION_35_9 = "35.9-v1";
export const ENGINE_ACTOR: Actor = { kind: "agent", id: AGENT_35_9 };
export const SWEEP_ACTOR: Actor = { kind: "system", id: "sweep" };
/** The owning agents the daily unit's steps run as (rule 2; AI agent design). */
export const STEP_AGENTS = { default_collections: "default-collections", lossmit: "lossmit-underwriter", foreclosure: "foreclosure-ops", bankruptcy: "bankruptcy-ops", claims: "claims-reo", borrower_comms: "borrower-comms" } as const;

// ---- events this process emits (Outputs and artifacts) -------------------------------------------------------------
export const EV = {
  timelineAppended: "case.timeline.appended",
  statusUnexpected: "case.status.unexpected",
  referralProposed: "case.referral.proposed",
  referralDecided: "case.referral.decided",
  milestoneExpected: "case.milestone.expected",
  milestoneDue: "case.milestone.due",
  milestoneSatisfied: "case.milestone.satisfied",
  milestoneWaived: "case.milestone.waived",
  docketSynced: "case.docket.synced",
  docketReacted: "case.docket.reacted",
  firmDispatchSent: "firm.dispatch.sent",
  firmDispatchAcknowledged: "firm.dispatch.acknowledged",
  firmInboundReceived: "firm.inbound.received",
  breachActionExecuted: "breach_action.executed",
  breachReconCompleted: "breach_action.recon.run_completed",
  claimCandidateOpened: "case.claim.candidate_opened",
  claimPackageBuilt: "case.claim.package_built",
  claimWithdrawn: "case.claim.withdrawn",
  dailyRunCompleted: "default_case.daily.run_completed",
  /** 35.3 rule 5 receipts of the cycles this process owns (Inputs and triggers: "each cycle elects its own receipt"). */
  countersRunCompleted: "delinquency.counters.run_completed",
  docketSyncRunCompleted: "bk_docket_sync.run_completed",
  draImportRunCompleted: "dra_import.run_completed",
  claimsSweepRunCompleted: "claims_sweep.run_completed",
} as const;

/** The 35.9 timer codes (Timers and gates). */
export const TIMERS_35_9 = {
  daily: "SM_DEFAULT_CASE_DAILY",
  recon: "SM_BREACH_ACTION_RECON_DAILY",
  referralDecision: "SM_CASE_REFERRAL_DECISION_2BD",
  docketReaction: "SM_DOCKET_REACTION_1BD",
  milestoneOverdue: "SM_CASE_MILESTONE_OVERDUE_5BD",
  claimPackage: "SM_CLAIM_PACKAGE_5BD",
} as const;

/** The cycle codes this process owns in 35.3's registry (Inputs and triggers). */
export const CYCLES_35_9 = {
  counters: "delinquency_counters",
  dailyCase: "default_case_daily",
  docketSync: "bk_docket_sync_daily",
  claimsSweep: "claims_sweep_daily",
  draImport: "dra_import_daily",
} as const;

/** The planned time of the daily cycle (Trigger & frequency: 05:30 America/New_York). */
export const DAILY_AT_ET = "05:30";
export const ET = "America/New_York";

// ---- rule 1: the consumed events, by case kind -----------------------------------------------------------------------
export type CaseKind = "early_intervention" | "lossmit" | "foreclosure" | "bankruptcy" | "reo" | "claim";
const EI = ["loan.delinquency.window_opened", "loan.delinquency.day_reached", "contact.attempted", "borrower.promise_to_pay.recorded", "contact.qrpc.established"] as const;
const LM = ["lossmit.application.received", "lossmit.application.facially_complete", "lossmit.application.completed", "lossmit.evaluation.decided", "notice.provided", "lossmit.offer.accepted", "lossmit.appeal.received", "lossmit.appeal.window.expired",
  "workout_plan.offered", "workout_plan.active", "workout_plan.payment.missed", "workout_plan.completed", "workout_plan.expired", "workout_plan.failed", "workout_plan.terminated", "foreclosure_holds.set", "foreclosure_holds.closed"] as const;
const FC = ["prereferral.review.due", "prereferral.review.completed", "prereferral.hold.opened", "foreclosure.referral.eligible", "foreclosure.referral.sent", "foreclosure.referral.acknowledged", "firm.referral.acknowledged", "firm.document.requested",
  "attorney.instruction.sent", "attorney.instruction.acknowledged", "foreclosure.first_notice.filed", "foreclosure.milestone.recorded", "foreclosure.sale.scheduled", "foreclosure.sale.held", "foreclosure.sale.completed", "foreclosure.sale.cancelled",
  "foreclosure.sale.rescinded", "foreclosure.timeframe.at_risk", "dra.snapshot.imported", "dra.exception.raised", "comp_fee.exposure.updated", "foreclosure.gate.refused"] as const;
const BK = ["bankruptcy.notice.received", "bankruptcy.petition.filed", "bankruptcy.docket.event.received", "bankruptcy.status.changed", "bankruptcy.stay.relief_granted", "bankruptcy.stay.relief_effective", "bankruptcy.case.dismissed", "bankruptcy.case.discharged",
  "bankruptcy.case.closed", "bankruptcy.plan.confirmed", "bankruptcy.plan.completed", "bankruptcy.payment_change_notice.created", "bankruptcy.trustee_payment.received"] as const;
const CL = ["reo.case.opened", "reogram.confirmed", "expense_claim.status_changed", "mi.claim.filed", "mi.claim.acknowledged", "mi.claim.perfected", "mi.claim.benefit_received", "mi.claim.decision.received"] as const;
/** The kernel's two: the sweep's breach and the escalation literal (src/app/escalations.ts:33). */
const KERNEL = ["timer.breached", "escalation.created"] as const;
export const CONSUMED_BY_KIND: Readonly<Record<CaseKind, readonly string[]>> = { early_intervention: EI, lossmit: LM, foreclosure: FC, bankruptcy: BK, reo: CL, claim: CL };
export const CONSUMED_EVENT_TYPES: ReadonlySet<string> = new Set([...EI, ...LM, ...FC, ...BK, ...CL, ...KERNEL]);
/** The notice codes whose `notice.provided` is a lossmit timeline event (rule 1: `notice.provided{NTC_REGX_41C1_OFFER | NTC_REGX_41C1_DENIAL}`). */
export const LOSSMIT_NOTICE_CODES: ReadonlySet<string> = new Set(["NTC_REGX_41C1_OFFER", "NTC_REGX_41C1_DENIAL"]);
export const kindOfEvent = (type: string): CaseKind | null =>
  (EI as readonly string[]).includes(type) ? "early_intervention" : (LM as readonly string[]).includes(type) ? "lossmit" : (FC as readonly string[]).includes(type) ? "foreclosure" : (BK as readonly string[]).includes(type) ? "bankruptcy" : (CL as readonly string[]).includes(type) ? "claim" : null;
/** The store kinds whose `status` is the case's state (State machine: "the owning row's status is the state"). */
export const OWNING_KIND: Readonly<Record<CaseKind, string>> = { early_intervention: "regx_ei_windows", lossmit: "lossmit_applications", foreclosure: "foreclosure_cases", bankruptcy: "bankruptcy_cases", reo: "reo_cases", claim: "mi_claims" };
export type TimelineSource = "section" | "firm" | "dra" | "docket" | "court" | "screen" | "cycle" | "sweep";

// ---- rule 4 / state machine: the expectation map ----------------------------------------------------------------------
/** 13.3's milestone codes as the firm reports them → the expectation codes (Data model: `milestone_code`). */
export const MILESTONE_CODE_OF: Readonly<Record<string, string>> = {
  FIRST_LEGAL: "first_legal", FIRST_NOTICE: "first_legal", COMPLAINT_FILED: "first_legal", NOD_RECORDED: "first_legal", SERVICE_COMPLETE: "service_complete", JUDGMENT_ENTERED: "judgment",
  SALE_SCHEDULED: "sale_scheduled", SALE_HELD: "sale_held", DEED_RECORDED: "deed_recorded", REOGRAM_CONFIRMED: "reogram_confirmed", TITLE_RECEIVED: "title_received", ASSIGNMENT_RECORDED: "assignment_recorded",
};
/** The next expected milestone after each, per method (rule 4: "each milestone recorded … satisfies its expectation and writes the next one"). */
export const NEXT_MILESTONE: Readonly<Record<"judicial" | "non_judicial", Readonly<Record<string, string | null>>>> = {
  judicial: { referral_ack: "first_legal", first_legal: "service_complete", service_complete: "judgment", judgment: "sale_scheduled", sale_scheduled: "sale_held", sale_held: "deed_recorded", deed_recorded: null },
  non_judicial: { referral_ack: "first_legal", first_legal: "sale_scheduled", sale_scheduled: "sale_held", sale_held: "deed_recorded", deed_recorded: null },
};
/** The 13.3 case status edges the engine expects; a transition outside this map logs `case.status.unexpected` (State machine). */
export const FORECLOSURE_EDGES: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["prereferral", new Set(["referred", "on_hold", "closed_reinstated", "closed_paid", "closed_workout", "closed_transferred"])],
  ["referred", new Set(["acknowledged", "on_hold", "closed_reinstated", "closed_workout", "closed_bankruptcy"])],
  ["acknowledged", new Set(["pre_first_legal", "first_legal", "in_process", "on_hold", "closed_reinstated", "closed_workout", "closed_bankruptcy"])],
  ["pre_first_legal", new Set(["first_legal", "in_process", "on_hold", "closed_reinstated", "closed_workout"])],
  ["first_legal", new Set(["in_process", "judgment", "sale_scheduled", "on_hold", "closed_reinstated", "closed_workout"])],
  ["in_process", new Set(["judgment", "sale_scheduled", "on_hold", "closed_reinstated", "closed_workout"])],
  ["judgment", new Set(["sale_scheduled", "on_hold", "closed_reinstated", "closed_workout"])],
  ["sale_scheduled", new Set(["sale_held", "post_sale", "in_process", "judgment", "on_hold", "closed_reinstated", "closed_workout", "closed_cancelled"])],
  ["sale_held", new Set(["post_sale", "in_process", "sale_scheduled"])],
  ["post_sale", new Set(["closed_fnma_acquired", "closed_third_party", "closed_rescinded", "sale_scheduled", "in_process"])],
  ["on_hold", new Set(["prereferral", "referred", "acknowledged", "pre_first_legal", "first_legal", "in_process", "judgment", "sale_scheduled"])],
]);
/** Case states that make an open expectation moot (State machine: "the case reaches a terminal or on-hold status"). */
export const MOOT_STATUS = /^(closed_|on_hold$|post_sale$)/;
/** rule 4: `due_on` = expected_on + 3 calendar days for firm_forecast and jurisdiction_default, expected_on itself otherwise. */
export const DUE_TOLERANCE_DAYS: Readonly<Record<string, number>> = { firm_forecast: 3, jurisdiction_default: 3, docket_order: 0, section_clock: 0, person: 0 };

/**
 * Jurisdiction defaults (rule 4, open question 4): calendar days from the prior milestone. The migration 0210 writes the same
 * object into `jurisdiction_rules.rules.fc_milestone_defaults`; the engine reads the row and falls back to this.
 * [UNVERIFIED — fixed demo constants for the fixture states; a production table needs counsel's review.]
 */
export const FC_MILESTONE_DEFAULTS: Readonly<Record<string, Readonly<Record<"judicial" | "non_judicial", Readonly<Record<string, number>> | undefined>>>> = {
  FL: { judicial: { first_legal: 45, service_complete: 60, judgment: 240, sale_scheduled: 45, sale_held: 30, deed_recorded: 30 }, non_judicial: undefined },
  NY: { judicial: { first_legal: 45, service_complete: 90, judgment: 300, sale_scheduled: 60, sale_held: 30, deed_recorded: 30 }, non_judicial: undefined },
  OH: { judicial: { first_legal: 45, service_complete: 60, judgment: 180, sale_scheduled: 45, sale_held: 30, deed_recorded: 30 }, non_judicial: undefined },
  TX: { judicial: undefined, non_judicial: { first_legal: 45, sale_scheduled: 21, sale_held: 30, deed_recorded: 30 } },
  AZ: { judicial: undefined, non_judicial: { first_legal: 45, sale_scheduled: 90, sale_held: 30, deed_recorded: 30 } },
  CA: { judicial: undefined, non_judicial: { first_legal: 45, sale_scheduled: 90, sale_held: 30, deed_recorded: 30 } },
};
export const GENERIC_MILESTONE_DEFAULTS: Readonly<Record<string, number>> = { first_legal: 45, service_complete: 60, judgment: 240, sale_scheduled: 45, sale_held: 30, deed_recorded: 30 };

// ---- rule 6: docket reactions --------------------------------------------------------------------------------------------
/** Open question 5: 0.85 here (read from `ai_system_versions` for the 14.1 classifier when 18.1 records one). */
export const DOCKET_CONFIDENCE = 0.85;
export const DETERMINISTIC_DOCKET_CLASSES: ReadonlySet<string> = new Set(["petition", "meeting_341_scheduled", "bar_date_notice", "plan_confirmed", "plan_modified", "relief_order_entered", "dismissal", "discharge", "conversion", "case_closed",
  "reaffirmation_filed", "trustee_notice_410c13_n", "motion_410c13_m1", "motion_410c13_m2", "mfr_filed"]);
/** Anything naming money is never a reaction (rule 6: the two money applications are 35.8's officer-approved acts). */
export const MONEY_DOCKET_CLASSES: ReadonlySet<string> = new Set(["trustee_payment_received", "postpetition_payment_received", "payment_change_notice", "fee_notice"]);
export type ReactionKind = "stay_gate" | "status_change" | "timer_arm" | "poc_supplement" | "mfr_path" | "plan_change" | "payment_change_response" | "statement_mode" | "counsel_package" | "form20" | "none";
export const REACTION_OF_CLASS: Readonly<Record<string, ReactionKind>> = {
  petition: "stay_gate", meeting_341_scheduled: "timer_arm", bar_date_notice: "timer_arm", plan_confirmed: "status_change", plan_modified: "plan_change", relief_order_entered: "stay_gate", dismissal: "status_change", discharge: "status_change",
  conversion: "status_change", case_closed: "status_change", reaffirmation_filed: "status_change", trustee_notice_410c13_n: "payment_change_response", motion_410c13_m1: "payment_change_response", motion_410c13_m2: "payment_change_response", mfr_filed: "mfr_path",
};

// ---- rule 7: breach actions --------------------------------------------------------------------------------------------------
export type ActionKind = "escalate" | "refuse_gate" | "message_firm" | "instruct_firm" | "open_work_item" | "set_flag" | "run_tool" | "inform" | "cancel_clock";
export type BreachOutcome = "executed" | "deferred" | "escalated_only" | "refused" | "failed";
/**
 * ACTION_MATCHES_CITED_TEXT (rule 7: "never with an action the cited_text does not name"): a registration is accepted only when
 * the registry row's breach column names the action — one of these words, case-insensitively. `escalate` is what every breach
 * column implies (the sweep's escalation is the default action), so it needs no word; `cancel_clock` is refused outright (34.4 rule 1).
 */
export const CITED_TEXT_WORDS: Readonly<Record<Exclude<ActionKind, "escalate" | "cancel_clock">, readonly string[]>> = {
  refuse_gate: ["gate", "refuse", "hold"],
  message_firm: ["firm call", "status demand", "re-send", "resend", "firm message", "scorecard", "status demand", "demand"],
  instruct_firm: ["instruction", "postpone", "instruct"],
  open_work_item: ["task", "docs", "documents", "exposure", "upload", "queue", "sev-2", "sev 2", "work item"],
  set_flag: ["flag", "warning", "status demand", "at_risk", "status"],
  run_tool: ["sync", "lookup", "exception", "re-run", "recompute"],
  inform: ["informed", "inform", "notify"],
};
export const citedTextNames = (kind: ActionKind, citedText: string): boolean => {
  if (kind === "escalate") return true;
  if (kind === "cancel_clock") return false;
  const t = citedText.toLowerCase();
  return CITED_TEXT_WORDS[kind].some((w) => t.includes(w));
};

// ---- rules 5 and 9: the worked examples' figures (Business rules; asserted by 35-9.spec.test.ts) ---------------------------
/** Worked example A (loan L-A, Florida judicial, allowable 720): 13.5's formula run daily. */
export const EXAMPLE_A = {
  upb_cents: 18_745_000n, ptr_pct: "5.125", lpi_due_date: "2025-03-01", allowable_days: 720, bk_delay: { from: "2026-02-10", to: "2026-05-05", actual_days: 84, cap_days: 125, credited_days: 84 },
  run_on: "2027-09-15", forecast_sale_on: "2027-11-02",
  today: { actual_days: 928, excess_days: 124, exposure_cents: 326_368n },
  forecast: { actual_days: 976, excess_days: 172, exposure_cents: 452_705n },
  at_risk_day: 563, at_risk_on: "2026-09-15", over_allowable_from: "2027-05-15",
  f203_example_1: { upb_cents: 10_000_000n, ptr_pct: "4.75", excess_days: 266, exposure_cents: 346_164n },
} as const;
/** Worked example B (loan L-B, Texas non-judicial, sale held Tue 2027-07-06 — Fannie Mae acquired; 30% BPMI, servicer_direct). */
export const EXAMPLE_B = {
  upb_cents: 16_392_044n, note_rate_pct: "5.750", interest_paid_to: "2026-10-01", sale_on: "2027-07-06", coverage_pct: "30",
  months: 9, stub_days: 5, monthly_interest_cents: 78_545n, months_interest_cents: 706_905n, per_diem_4dp: "25.8231", stub_interest_cents: 12_912n, interest_cents: 719_817n,
  advances: { taxes_cents: 291_460n, hazard_premium_cents: 106_200n, inspections_cents: 18_000n, inspection_unit_cents: 3_000n, inspections: 6, preservation_cents: 38_500n, attorney_fee_cents: 230_000n, attorney_costs_cents: 56_500n, attorney_total_cents: 286_500n, attorney_cap_cents: 600_000n, five_pct_upb_cents: 819_602n, total_cents: 740_660n },
  claim_amount_cents: 17_852_521n, benefit_cents: 5_355_756n,
  candidate_opened_on: "2027-07-07", package_due_on: "2027-07-14", mi_mp_claim_file_60_on: "2027-09-04", direct_file_30_on: "2027-08-05", legal_due_on: "2027-08-05",
} as const;
/** Worked example C (the same loan's 571 expense claim, 15.2 rule 9's method). */
export const EXAMPLE_C = {
  lines: { taxes_cents: 291_460n, hazard_premium_cents: 106_200n, mi_premium_unit_cents: 9_817n, mi_premium_months: 9, mi_premiums_cents: 88_353n, inspections_cents: 18_000n, preservation_cents: 38_500n, attorney_fee_cents: 230_000n, costs_cents: 56_500n, technology_cents: 3_000n },
  hazard_paid_on: "2027-03-15", hazard_term_start: "2027-03-20", hazard_term_end: "2028-03-20", unearned_days: 258,
  gross_cents: 832_013n, credits_cents: 75_067n, net_cents: 756_946n, legal_due_on: "2027-08-05", expense_final_60_on: "2027-09-04",
} as const;

/** Refusal codes (AI agent design: guardrails). */
export const REFUSALS = {
  noMoneyField: "NO_MONEY_FIELD", noLegalActUnregistered: "NO_LEGAL_ACT_UNREGISTERED", noClockEdit: "NO_CLOCK_EDIT", gatesRunNotAsserted: "GATES_RUN_NOT_ASSERTED", actionMatchesCitedText: "ACTION_MATCHES_CITED_TEXT",
  docketConfidence: "DOCKET_CONFIDENCE_0_85", oneActionPerBreach: "ONE_ACTION_PER_BREACH", sectionStatusReadOnly: "SECTION_STATUS_READ_ONLY", registryStale: "REGISTRY_STALE", referralDecidedByOfficer: "REFERRAL_DECIDED_BY_OFFICER",
  registrationNeedsOfficer: "REGISTRATION_NEEDS_OFFICER_CONFIRMATION",
} as const;
/** Money-looking input keys this process never accepts (rule 10). */
export const MONEY_KEY = /(_cents|_amount|^amount|^benefit|^exposure)$/i;
export function hasMoneyKey(v: unknown, depth = 0): boolean {
  if (depth > 4 || v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => hasMoneyKey(x, depth + 1));
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (MONEY_KEY.test(k)) return true; if (hasMoneyKey(x, depth + 1)) return true; }
  return false;
}
