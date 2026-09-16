/**
 * §35.12 typed refusals — every one a StaffError (src/runtime/staff/roles.ts) so the console's catch answers
 * `{error, code, reason, ...extra}` with the status and /v1's StaffError branch does the same. Thrown before any deferred
 * write is queued (and a throw inside a unit of work persists nothing anyway). The codes are the AI agent design's guardrails:
 * POSTURE_IS_OBSERVED, VENDOR_OFF, TWO_PERSON_SWITCH, MONEY_VENDOR_SANDBOX_ONLY, NO_REAL_DATA_IN_NONPROD, REAL_DATA_REFUSED_IN_NONPROD,
 * SYNTHETIC_REFUSED_IN_PRODUCTION, FINDING_CLOSES_BY_EVIDENCE, NO_MONEY_FIELD, NO_PII_IN_EVIDENCE, ROLE_REQUIRED, GO_LIVE_GATE,
 * GO_LIVE_ITEM_OPEN, TWO_PERSON_GO_LIVE, PARALLEL_RUN_TOO_SHORT, PARALLEL_RUN_OPEN_DIFFS, PARALLEL_RUN_DIRTY_WEEK, DAY_ALREADY_RECONCILED,
 * NO_FAKE_IN_PRODUCTION (35.7's), REQUEST_EXPIRED, REQUEST_NOT_FOUND, WITNESS_DISTINCT, REAL_ADAPTER_MISSING.
 */
import { StaffError } from "../../../runtime/staff/roles.ts";

export class PostureRefused extends StaffError {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) { super(status, code, message, extra); this.name = "PostureRefused"; }
}
/** Rule 4: a vendor in mode `off` (or with no switch row) under INTEGRATIONS=real answers this before any write — the OffPort's every call. */
export class VendorOff extends Error {
  readonly code = "VENDOR_OFF"; readonly vendor: string; readonly method: string;
  constructor(vendor: string, method: string) { super(`VENDOR_OFF{${vendor}}: the ${vendor} switch is off in this environment (35.12 rule 4); ${method} was not attempted and nothing was written`); this.name = "VendorOff"; this.vendor = vendor; this.method = method; }
}
