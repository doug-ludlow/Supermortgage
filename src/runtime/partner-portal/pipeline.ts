/**
 * 36.4 — the refinance pipeline feed (spec/sections/36-servicing-partner-portal/36-4-refinance-pipeline-feed.md), read by
 * ./routes.ts on `GET /v1/partner/pipeline` and `GET /v1/partner/pipeline/{loan_id}`. A projection and nothing more: the
 * owners' rows read as stored by ./motions.ts, the pure stage mapping (rule 2; src/domain/servicing-partner-portal/pipeline.ts),
 * one item per member — the newest motion — newest `entered_at` first (rule 3), the days in stage (rule 4), the partner-grade
 * mask (36.1) and the tenant rule (36.1 rule 4 / rule 9: the list is the tenant's members only; another tenant's detail is 404).
 * Nothing is emitted, ordered or decided (rule 8); nothing is written but 36.1's log row.
 *
 *   partnerPipeline     the list: { items: PipelineItem[] }
 *   partnerPipelineLoan the detail: { loan: 36.3 rule 5's row with `bucket` as 36.5 rule 5 sets it, stages: PipelineStage[], current, clocks }
 */
import { pageBucketOf } from "../../domain/servicing-partner-portal/buckets.ts";
import { daysInStage, type PipelineStage } from "../../domain/servicing-partner-portal/pipeline.ts";
import { EXPIRY_TIMER } from "../partner-book-offers.ts";
import type { Runtime } from "../app.ts";
import { partnerLoanRows, type PartnerLoanRow } from "./eligibility.ts";
import { notFound, type TenantScope } from "./scope.ts";
import type { PartnerRole } from "./roles.ts";

/** 35.10's confirmation clock, shown on the detail beside 20.1's expiry clock — never armed here. */
export const PARTNER_CONFIRM_TIMER = "SM_REFI_PARTNER_CONFIRM_21";

/** Inputs and triggers: `{ loan_id, servicer_loan_last4, homeowner: { legal_name }, stage, entered_at, days_in_stage, opportunity_id?, application_id? }`. */
export interface PipelineItem { readonly loan_id: string; readonly servicer_loan_last4: string; readonly homeowner: { legal_name: string | null }; readonly state: string | null; readonly stage: string; readonly entered_at: string; readonly days_in_stage: number; readonly opportunity_id?: string; readonly application_id?: string; readonly missing?: readonly string[]; readonly new_loan?: { loan_id: string; status: string } }
const itemOf = (row: PartnerLoanRow, current: PipelineStage, now: string): PipelineItem => ({ loan_id: row.loan_id, servicer_loan_last4: row.servicer_loan_last4, homeowner: { legal_name: row.homeowner.legal_name }, state: row.state, stage: current.stage, entered_at: current.entered_at, days_in_stage: daysInStage(current.entered_at, now),
  ...(current.opportunity_id ? { opportunity_id: current.opportunity_id } : {}), ...(current.application_id ? { application_id: current.application_id } : {}), ...(current.missing ? { missing: [...current.missing] } : {}), ...(current.new_loan ? { new_loan: current.new_loan } : {}) });

/** GET /v1/partner/pipeline: one item per member in motion (rule 3), newest `entered_at` first; a member who never left the board is not on the feed (rule 1). */
export async function partnerPipeline(rt: Runtime, scope: TenantScope, now: string = rt.clock.now()): Promise<{ partner_party_id: string; as_of: string; items: PipelineItem[] }> {
  const { rows, motions } = await partnerLoanRows(rt, scope, {}, now);   // every status: a member 35.10 retired keeps its item at `boarded` (discrepancy 3)
  const items: PipelineItem[] = [];
  for (const row of rows) { const cur = motions.get(row.loan_id)?.projection.current; if (cur) items.push(itemOf(row, cur, now)); }
  items.sort((a, b) => Date.parse(b.entered_at) - Date.parse(a.entered_at) || a.servicer_loan_last4.localeCompare(b.servicer_loan_last4));
  return { partner_party_id: scope.partner_party_id, as_of: now, items };
}

export type PipelineClock = { readonly timer_id: string; readonly code: string; readonly status: string; readonly due_date: string | null; readonly due_at: string | null; readonly satisfied_at: string | null; readonly breached_at: string | null };
export interface PartnerPipelineLoan { readonly loan: Omit<PartnerLoanRow, "bucket"> & { servicer_loan_number?: string; bucket: ReturnType<typeof pageBucketOf> }; readonly stages: PipelineStage[]; readonly current: PipelineStage | null; readonly clocks: PipelineClock[] }
/** GET /v1/partner/pipeline/{loan_id}: the member's row (36.3 rule 5, `bucket` as 36.5 rule 5 sets it — the full servicer loan number for partner_admin / partner_ops), the strip and the current stage; a tenant loan with no motion answers `stages: [], current: null`; another tenant's, the new active loan's or an unknown id is 404 NOT_FOUND (rule 9). */
export async function partnerPipelineLoan(rt: Runtime, scope: TenantScope, loanId: string, role: PartnerRole | string, now: string = rt.clock.now()): Promise<PartnerPipelineLoan> {
  const { rows, motions } = await partnerLoanRows(rt, scope, {}, now);
  const row = rows.find((r) => r.loan_id === loanId);
  if (!row) throw notFound("loan");   // 36.1 rule 4: the item is the member's; the new `active` loan has no place on the feed's paths (edge case)
  const motion = motions.get(loanId);
  const number = role === "partner_auditor" ? {} : { servicer_loan_number: (await rt.db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0]?.n ?? row.servicer_loan_last4 };
  const clocks = await rt.db.query<PipelineClock>(`SELECT id::text AS timer_id, code, status::text AS status, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at FROM timers WHERE loan_id = $1 AND code = ANY($2::text[]) ORDER BY armed_at, id`, [loanId, [EXPIRY_TIMER, PARTNER_CONFIRM_TIMER]]);
  const bucket = pageBucketOf({ status: row.status, open_application: (motion?.open_application_id ?? null) !== null, on_hold: row.on_hold, latest_review: row.latest_review, watch_rate_pct: row.watch_rate_pct });
  return { loan: { ...row, ...number, bucket }, stages: [...(motion?.projection.stages ?? [])], current: motion?.projection.current ?? null, clocks };
}
