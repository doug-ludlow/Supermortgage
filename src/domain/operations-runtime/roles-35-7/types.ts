/**
 * §35.7 — the constants every module of the process shares (spec/sections/35-operations-runtime/35-7-*.md).
 *
 *   the roles           HUMAN_ROLES (src/app/roles.ts) is the closed list; the four staff roles stay 34.1's `roles`, the rest
 *                       (and the three shared words ops_analyst/officer/compliance, held once in `roles`) are `reviewer_roles`.
 *   independence roles  qc_officer, funding_approver, ciso, bsa_officer — a grant waits for a compliance confirmation by a
 *                       different person within 10 minutes (rule 3); never broken into (rule 8).
 *   privileged          officer, compliance, ciso, funding_approver, qc_officer, bsa_officer → identities.privileged (19.2).
 *   the clocks' numbers 10 minutes (the two-person requests), 4 hours (break-glass), 30 days (dormant grants; the sign-in test).
 * No money field anywhere in this process (rule 10).
 */
import { HUMAN_ROLES, type HumanRole } from "../../../app/roles.ts";
import { STAFF_ROLES } from "../../../runtime/staff/roles.ts";

export const PROCESS_35_7 = "35.7";
export const ROLES_AGENT = "security-records";
export const ROLES_RULE_SET_VERSION = "roles.v1";
export const ROLES_MODEL_VERSION = "deterministic";
export const ROLES_PROMPT_VERSION = "35.7-v1";

export const KERNEL_ROLES: readonly string[] = HUMAN_ROLES;
export const isKernelRole = (r: unknown): r is HumanRole => typeof r === "string" && (HUMAN_ROLES as readonly string[]).includes(r);
/** The words held once, in 34.1's `roles` (rule 1: "the same words on both sides"). */
export const STAFF_WORDS: readonly string[] = STAFF_ROLES;
export const INDEPENDENCE_ROLES: readonly string[] = ["qc_officer", "funding_approver", "ciso", "bsa_officer"];
export const PRIVILEGED_ROLES: readonly string[] = ["officer", "compliance", "ciso", "funding_approver", "qc_officer", "bsa_officer"];

export const CONFIRM_MINUTES = 10;
export const BREAKGLASS_HOURS = 4;
export const DORMANT_DAYS = 30;
export const SIGNED_IN_DAYS = 30;
export const DUAL_CONTROL_REQUEST_HOURS = 24;
export const REFUSALS_PER_HOUR_ANOMALY = 5;
export const PRINCIPAL_MAX_DAYS: Readonly<Record<"staff" | "service" | "partner", number>> = { staff: 90, service: 365, partner: 365 };
/** The queue scan's hour (35.3 registry row `roles.queue_scan`: daily 06:30 ET). */
export const QUEUE_SCAN_AT_ET = "06:30";
export const ET = "America/New_York";

export const minutesAfter = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();
export const hoursAfter = (iso: string, h: number): string => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
export const daysAfter = (iso: string, d: number): string => new Date(Date.parse(iso) + d * 86_400_000).toISOString();
export const isProduction = (environment: string | undefined): boolean => environment === "production" || environment === "prod";
/** The `origination: true` marker every 35.7 event carries so the §35 clocks arm on HEAD's engine (a section ≥ 20 def arms on origination-context events only). */
export const P = (o: Record<string, unknown>): Record<string, unknown> => ({ ...o, origination: true });
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);
export type Row = Record<string, unknown>;
export const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
