/**
 * §35.7 typed refusals — every one a StaffError (src/runtime/staff/roles.ts) so the console's existing catch answers
 * `{error, code, reason, ...extra}` with the status, and /v1's StaffError branch does the same. Thrown before any deferred
 * write is queued (and a throw inside a unit of work persists nothing anyway).
 */
import { StaffError } from "../../../runtime/staff/roles.ts";

/** The grants, the handover, the break-glass and the approvals: ROLE_DISJOINT, CONFIRMER_IS_HOLDER, APPROVER_DISTINCT, APPROVAL_STALE, TWO_PERSON_HANDOVER, HANDOVER_NEEDS_HOLDER, ROLE_DENIED, DORMANT_GRANT_NEEDS_RATIONALE, REQUEST_EXPIRED, NO_FAKE_IN_PRODUCTION, ROLE_REQUIRED. */
export class RolesRefused extends StaffError {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) { super(status, code, message, extra); this.name = "RolesRefused"; }
}
/** The /v1 door: PRINCIPAL_UNKNOWN | PRINCIPAL_REVOKED | PRINCIPAL_EXPIRED (401), PRINCIPAL_SCOPE, NO_SELF_ASSERTED_ACTOR, NO_HUMAN_ROLE_ON_SERVICE_PRINCIPAL, APPROVER_NOT_SELF_ASSERTED, SHARED_TOKEN_REFUSED_IN_PRODUCTION (403). */
export class PrincipalRefused extends StaffError {
  /** The principal a dead-token refusal names (its row and the person's id, never the token), so the /v1 staff_actions row still carries `principal_id` and `staff_user_id` (35.7 T13). */
  context: { readonly source: "principal"; readonly principal: unknown; readonly person: { readonly id: string; readonly roles: readonly string[]; readonly reviewer_roles: readonly string[] } | null } | null = null;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) { super(status, code, message, extra); this.name = "PrincipalRefused"; }
}
/** Rule 2: a command that declares dual control ran without an approval record — 409 APPROVER_DISTINCT with the request the second person approves. */
export class DualControlRefused extends RolesRefused {
  readonly requestId: string;
  constructor(i: { request_id: string; command: string; subject: { kind: string; id: string } | null; role: string; expires_at: string; requested_by: string }) {
    super(409, "APPROVER_DISTINCT", `${i.command} needs an approval record by a second, distinct ${i.role}: roles.approve{request_id: ${i.request_id}} by another ${i.role} (not ${i.requested_by}), then re-submit`, { request_id: i.request_id, command: i.command, subject: i.subject, role: i.role, expires_at: i.expires_at, requested_by: i.requested_by });
    this.name = "DualControlRefused"; this.requestId = i.request_id;
  }
}
