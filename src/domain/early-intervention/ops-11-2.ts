/**
 * §11.2 process-owned operations — the written early-intervention notice request.
 *
 * 11.2 timer table: `REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE` (4.3 gate) is triggered by
 * `notice.early_intervention_written.requested` and satisfied when an assignment exists
 * (`continuity.assigned`); breach action "auto-assign then send". §1024.39(b)(2)(ii) requires
 * "the telephone number to access servicer personnel assigned pursuant to §1024.40(a)", so a
 * render of any EI variant is first a *request* for the written notice: the request event is
 * appended, the assigned-contact block is resolved (from the payload, else from the active 4.3
 * episode), and the send is refused until an assignment exists (11.2-T9). The pure computation
 * lives here; src/app/tools/section11-2.ts appends the event and runs the 4.3 auto-assignment.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { eiRenderGate } from "./ops.ts";

/** The §1024.39(b) notice templates and their variant (11.2 rule 1). */
export const EI_NOTICE_VARIANTS = {
  NTC_REGX_39B_EARLY_INTERVENTION: "standard",
  NTC_REGX_39D_EARLY_INTERVENTION_FDCPA: "fdcpa",
  NTC_REGX_39C_EARLY_INTERVENTION_BK: "bk",
  NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA: "bk_fdcpa",
} as const;
export type EiVariant = (typeof EI_NOTICE_VARIANTS)[keyof typeof EI_NOTICE_VARIANTS];

/** The 4.3 team block an EI notice carries ((b)(2)(ii) + continuity block, 11.2 rule 8(ii)). */
export interface AssignedTeam { readonly team_name: string; readonly direct_number: string; readonly named_human_first_name?: string }

export const WRITTEN_NOTICE_REQUESTED = "notice.early_intervention_written.requested" as const;

export interface WrittenNoticeRequest {
  /** null when the template is not an EI variant — no request event, payload untouched. */
  readonly ei_variant: EiVariant | null;
  readonly event: { readonly type: typeof WRITTEN_NOTICE_REQUESTED; readonly payload: Record<string, unknown> } | null;
  readonly gate: ReturnType<typeof eiRenderGate>;
  /** Where the assigned-contact block came from: the caller's payload, the active 4.3 episode, or nowhere (send refused). */
  readonly block_source: "payload" | "assignment" | null;
  /** The render payload with the team block merged in when the active assignment supplied it. */
  readonly payload: Record<string, unknown>;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * 11.2-T9 / REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE: resolve the assigned-contact block for a written EI notice.
 * `payload.team_name` + `payload.team_phone` is the block when the caller already carries it; otherwise the active
 * 4.3 episode fills it; with neither the gate refuses the send (`action: auto_assign_4_3`).
 */
export function writtenNoticeRequest(f: { template: string; payload: Record<string, unknown>; active_assignment: AssignedTeam | null; requested_on: PlainDate }): WrittenNoticeRequest {
  const variant = (EI_NOTICE_VARIANTS as Record<string, EiVariant | undefined>)[f.template] ?? null;
  const exclusive = nonEmpty(f.payload.exclusive_address);
  if (!variant) return { ei_variant: null, event: null, gate: eiRenderGate({ assigned_contact_block_present: true, exclusive_address_present: exclusive }), block_source: null, payload: f.payload };
  const fromPayload = nonEmpty(f.payload.team_name) && nonEmpty(f.payload.team_phone);
  const fromAssignment = !fromPayload && f.active_assignment !== null && nonEmpty(f.active_assignment.team_name) && nonEmpty(f.active_assignment.direct_number);
  const block_source = fromPayload ? "payload" : fromAssignment ? "assignment" : null;
  const payload = fromAssignment
    ? { ...f.payload, team_name: f.active_assignment!.team_name, team_phone: f.active_assignment!.direct_number, ...(f.active_assignment!.named_human_first_name ? { named_human: f.active_assignment!.named_human_first_name } : {}), continuity_block_present: true }
    : f.payload;
  const gate = eiRenderGate({ assigned_contact_block_present: block_source !== null, exclusive_address_present: exclusive });
  return {
    ei_variant: variant, block_source, payload, gate,
    event: { type: WRITTEN_NOTICE_REQUESTED, payload: { template: f.template, variant, notice_class: "regx_ei", requested_on: f.requested_on, assigned_contact_block_present: block_source !== null, block_source, exclusive_address_present: exclusive, send_allowed: gate.send_allowed, action: gate.action } },
  };
}
