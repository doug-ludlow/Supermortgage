/**
 * §35.4 — shared constants, row types and the decision-record schema of the month-end and year-end close
 * (spec/sections/35-operations-runtime/35-4-month-end-and-year-end-close.md). Money is bigint cents; dates are PlainDate;
 * instants are ISO strings; every figure on an attestation is READ from the sections' own typed rows (rule 12).
 */
import type { Actor } from "../../../kernel/events/index.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";

export const CLOSE_PROCESS = "35.4";
export const CLOSE_AGENT = "custodial-recon";
export const CLOSE_REVIEWER_AGENT = "qc-audit";
export const CLOSE_RULE_SET_VERSION = "close.v1";
export const CLOSE_PROMPT_VERSION = "35.4-v1";
export const CLOSE_MODEL_VERSION = "deterministic";
export const ET = "America/New_York";
/** The planner's actor when the sweep's close pass (behind 35.3's planner, whose `month_end` unit emits the trigger) opens and plans a period. */
export const PLANNER_ACTOR: Actor = { kind: "system", id: "close-planner" };
/** Rule 3: the preparer's confidence floor. */
export const CONFIDENCE_FLOOR = 0.95;
/** 6.3's default for `custodial.form496.human_approval` (rule 7: "default on"). The environment variable that overrides it. */
export const HUMAN_APPROVAL_ENV = "CUSTODIAL_FORM496_HUMAN_APPROVAL";
/** The servicer number the close keys on when no servicer party carries one (entry-seed's demo servicer, 6.3's fixture). */
export const SERVICER_NUMBER_ENV = "SUPERMORTGAGE_SERVICER_NUMBER";
export const DEFAULT_SERVICER_NUMBER = "123456789";

export type PeriodKind = "month" | "tax_year";
export type PeriodStatus = "open" | "attested" | "reopened" | "closed";
export type StepStatus = "blocked" | "planned" | "running" | "completed" | "skipped" | "stalled" | "failed" | "pre_reopen";
export type StepCode = "eod_cutoff" | "custodial_day_close" | "metro2_snapshot" | "lar" | "period_close" | "ledger_period_close" | "balance_attestation" | "form496" | "form496a" | "qc_cycle" | "star" | "eligibility" | "tax_year_close"
  | "form_1098_furnish" | "form_1099_int_furnish" | "form_1099_ac_furnish" | "form_1098_file" | "form_1099_int_file" | "form_1099_ac_file";
export type UnitScope = "global" | "per_custodial_account" | "per_loan";

export interface ClosePeriodRow extends Record<string, unknown> { readonly id: string; readonly kind: PeriodKind; readonly period: string; readonly period_start: PlainDate; readonly period_end: PlainDate; readonly servicer_number: string; readonly tax_year: number | null; readonly status: PeriodStatus; readonly opened_at: string; readonly opened_by_event_id: string | null; readonly attested_at: string | null; readonly current_attestation_id: string | null; readonly closed_at: string | null; readonly reopen_count: number; readonly current_reopen_id: string | null; }
export interface CloseStepRow extends Record<string, unknown> { readonly id: string; readonly close_period_id: string; readonly code: StepCode; readonly owner_process: string; readonly depends_on: readonly StepCode[]; readonly cycle_code: string | null; readonly unit_scope: UnitScope; readonly not_before: string | null; readonly owner_timer_code: string | null; readonly owner_due_at: string | null; readonly receipt_event_type: string | null; readonly receipt_filter: Record<string, unknown>; readonly expected_receipts: number; readonly received: number; readonly status: StepStatus; readonly cycle_run_id: string | null; readonly started_at: string | null; readonly completed_at: string | null; readonly skipped_reason: string | null; readonly attempts: number; readonly last_error: string | null; readonly receipts_from: string | null; }

/** A refusal with the spec's code (surfaced like CommandRefused: `code`, `citation`, `reason`); thrown inside a handler it rolls the command back whole (nothing written). */
export class CloseRefused extends Error {
  readonly code: string; readonly citation: string; readonly reason: string; readonly detail: Record<string, unknown>;
  constructor(code: string, citation: string, reason: string, detail: Record<string, unknown> = {}) { super(`35.4 refused [${code}]: ${reason}`); this.name = "CloseRefused"; this.code = code; this.citation = citation; this.reason = reason; this.detail = detail; }
}

export const PERIOD_RE = /^\d{4}-\d{2}$/;
export const TAX_PERIOD_RE = /^\d{4}-TY$/;
export const periodAggregate = (servicer: string, period: string): { kind: "close_period"; id: string } => ({ kind: "close_period", id: `${servicer}:${period}` });
/** The step's own subject: the period aggregate's id suffixed by the step code — one stall clock per step (open question 1 of the plan). */
export const stepAggregate = (servicer: string, period: string, step: string): { kind: "close_period"; id: string } => ({ kind: "close_period", id: `${servicer}:${period}:${step}` });
export const GLOBAL_AGG = { kind: "global", id: "*" } as const;
export const money = (c: bigint): string => c.toString();
