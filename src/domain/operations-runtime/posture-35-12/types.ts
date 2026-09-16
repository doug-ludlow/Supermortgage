/**
 * §35.12 — the constants every module of the process shares (spec/sections/35-operations-runtime/35-12-production-posture.md).
 *
 *   the environments      nonprod | staging | production (rule 1); `isProduction` is 35.7's reading of ENVIRONMENT.
 *   the vendors           the thirty-three of `integration_switches.vendor`; the money-or-person vendors of rule 4 may be `real`
 *                         outside production only with `endpoint_class = sandbox`; the go-live set of GL-05.
 *   the clocks' numbers   10 minutes (the two-person requests), 28 calendar days (the parallel run), 7 clean days, 90 days (the drill and
 *                         a secret's age), RPO 300 s and RTO 14,400 s (rule 5), 05:30 / 05:45 / 21:00 ET (the cycles).
 *   worked example A      the seven bold figures of "Business rules and calculations", in bigint cents — the test asserts them to the cent.
 * No money field is ever written by this process (rule 11): the figures below are compared, never posted.
 */
export const PROCESS_35_12 = "35.12";
export const POSTURE_AGENT = "compliance-sentinel";
export const POSTURE_RULE_SET_VERSION = "posture.v1";
export const POSTURE_MODEL_VERSION = "deterministic";
export const POSTURE_PROMPT_VERSION = "35.12-v1";
export const ET = "America/New_York";

export const ENVIRONMENTS: readonly string[] = ["nonprod", "staging", "production"];
export const isProduction = (environment: string | undefined): boolean => environment === "production" || environment === "prod";
export const environmentOf = (v: unknown): string => { const e = typeof v === "string" ? v.trim() : ""; return e === "prod" ? "production" : e; };

export const VENDORS: readonly string[] = ["lockbox_bai2", "ach_nacha", "eoscar", "fnma_p360", "fnma_smdu", "fnma_lsdu", "fnma_du", "fnma_earlycheck", "fnma_loan_lookup", "print_mail", "evault", "mers", "stripe_identity", "plaid", "truv", "irs_ives", "ron", "telephony_sms_email", "edelivery", "rates", "google_oidc", "tavus", "blob_store", "warehouse", "wire_verification", "credit_bureau", "amc", "title", "cbsv", "ofac_screener", "fraud_tool", "ucdp", "state_doi", "alta_registry"];
/** Rule 4: a vendor that moves money or reports on a person — `real` outside production only with `endpoint_class = sandbox`. */
export const MONEY_OR_PERSON_VENDORS: readonly string[] = ["lockbox_bai2", "ach_nacha", "eoscar", "fnma_p360", "fnma_smdu", "fnma_lsdu", "print_mail", "mers", "credit_bureau", "irs_ives"];
/** GL-05: every vendor the servicing book needs, `real` and `live` with a canary in the last 24 h. */
export const GO_LIVE_VENDORS: readonly string[] = ["lockbox_bai2", "ach_nacha", "print_mail", "edelivery", "telephony_sms_email", "eoscar", "fnma_p360", "fnma_smdu", "fnma_lsdu", "mers", "blob_store"];
export type SwitchMode = "fake" | "real" | "off";
export type EndpointClass = "sandbox" | "live";

export const CONFIRM_MINUTES = 10;
export const PARALLEL_RUN_DAYS = 28;
export const CLEAN_WEEK_DAYS = 7;
export const RESTORE_DRILL_DAYS = 90;
export const SECRET_MAX_AGE_DAYS = 90;
export const RPO_MAX_S = 300;
export const RTO_MAX_S = 14_400;
export const POSTURE_CHECK_AT_ET = "05:30";
export const DATA_SCAN_AT_ET = "05:45";
export const RECONCILE_AT_ET = "21:00";
export const GO_LIVE_ITEMS: readonly string[] = ["GL-01", "GL-02", "GL-03", "GL-04", "GL-05", "GL-06", "GL-07", "GL-08", "GL-09", "GL-10", "GL-11", "GL-12"];
export const WAIVABLE_ITEMS: readonly string[] = ["GL-08", "GL-10"];
/** The eight reconciliation fields of `parallel_run_diffs.field` (rule 7); the six money fields decide the clean week (rule 9). */
export const RECONCILE_FIELDS: readonly string[] = ["upb_cents", "escrow_balance_cents", "next_due_date", "late_charges_accrued_cents", "interest_paid_ytd_cents", "amount_due_cents", "days_delinquent", "form_496_remittance_cents"];
export const MONEY_FIELDS: readonly string[] = ["upb_cents", "escrow_balance_cents", "late_charges_accrued_cents", "interest_paid_ytd_cents", "amount_due_cents", "form_496_remittance_cents"];
export const DISPOSITIONS: readonly string[] = ["ours_right", "theirs_right", "both_wrong", "timing"];

/** Worked example A (a reconciliation day), in bigint cents. */
export const WORKED_A_UPB_CENTS = 24_831_055n;            // $248,310.55 loan 1 UPB, both sides
export const WORKED_A_ESCROW_L1_CENTS = 120_417n;         // 1,204.17 loan 1 escrow, both sides
export const WORKED_A_PI_CENTS = 125_000n;                // $1,250.00 loan 2 P&I installment
export const WORKED_A_LATE_CHARGE_BPS = 500n;             // 5.000 %
export const WORKED_A_LATE_CHARGE_CENTS = 6_250n;         // $62.50 = 5.000 % × $1,250.00 (2.7 rule 9)
export const WORKED_A_ESCROW_OURS_CENTS = 341_792n;       // $3,417.92 loan 3 escrow, ours
export const WORKED_A_ESCROW_THEIRS_CENTS = 341_292n;     // $3,412.92 loan 3 escrow, theirs
export const WORKED_A_ESCROW_DELTA_CENTS = 500n;          // $5.00
export const WORKED_A_MISMATCH_CENTS = 6_750n;            // $67.50 = 6,250 + 500
export const WORKED_A_COMPARISONS = 24;                   // 3 loans × 8 fields
export const WORKED_A_MATCHED = 22;
export const WORKED_A_MISMATCHED = 2;
/** Worked example B (a restore drill). */
export const WORKED_B_RPO_S = 12;
export const WORKED_B_RTO_S = 5_840;

export const minutesAfter = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();
export const daysAfter = (iso: string, d: number): string => new Date(Date.parse(iso) + d * 86_400_000).toISOString();
/** The `origination: true` marker every §35 event carries so the section-35 clocks arm on HEAD's engine (35.7's P). */
export const P = (o: Record<string, unknown>): Record<string, unknown> => ({ ...o, origination: true });
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);
export type Row = Record<string, unknown>;
export const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
export const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Canonical JSON (sorted keys, no whitespace) — the input of every hash this process writes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : typeof v === "bigint" ? v.toString() : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Row;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
/** Adds calendar days to a YYYY-MM-DD date. */
export const addCalendarDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
