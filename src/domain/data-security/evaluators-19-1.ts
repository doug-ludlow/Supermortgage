/**
 * §19.1 gate evaluators, keyed "19.1.<name>". Every key must be named by an
 * `evaluator:` override in timers-19-1.ts and vice versa (src/app/app.test.ts checks both).
 *
 * Every 19.1 not-before gate is condition-shaped ("gate opens; disposal blocked"): the
 * disposal command asserts it over the object's facts and the timer row never carries a
 * due instant, so a lawfully opened gate is never reported as a breach. Facts are PlainDate
 * strings (`today`, the anchors), `hold_count` and — for Fannie Mae-property objects —
 * `loan_active`. A missing `hold_count` or `loan_active` fact closes the gate: "never while
 * held" and "permanent while active" are not defaults the caller may omit.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator, type Facts } from "../../app/evaluator-kit.ts";
import { DISPOSAL_GATES, type GateFacts, type GateOutcome } from "./ops-19-1.ts";

const d = (f: Facts, k: string): PlainDate | null => (typeof f[k] === "string" && (f[k] as string).length > 0 ? (f[k] as PlainDate) : null);
const today = (f: Facts): PlainDate => d(f, "today") ?? (String(f.now ?? new Date().toISOString()).slice(0, 10) as PlainDate);
const hold = (f: Facts): number | null => (typeof f.hold_count === "number" && Number.isFinite(f.hold_count) ? f.hold_count : typeof f.hold_count === "string" && /^\d+$/.test(f.hold_count) ? Number(f.hold_count) : null);
const tri = (f: Facts, k: string): boolean | null => (typeof f[k] === "boolean" ? (f[k] as boolean) : null);
const out = (g: GateOutcome) => (g.open ? ok : no(g.reason ?? "closed"));
/** The typed facts bag the gates read, from the untyped one the timer engine / command carries. */
export function gateFacts(f: Facts): GateFacts {
  return {
    today: today(f), hold_count: hold(f), loan_active: tri(f, "loan_active"), jurisdiction_years: Number.isFinite(n(f, "jurisdiction_years")) ? n(f, "jurisdiction_years") : null,
    fdcpa_debt_collector: tri(f, "fdcpa_debt_collector"), regz_disclosure: tri(f, "regz_disclosure"),
    liquidated_on: d(f, "liquidated_on"), transferred_out_on: d(f, "transferred_out_on"), discharged_on: d(f, "discharged_on"), bankruptcy_discharge_only: b(f, "bankruptcy_discharge_only"),
    notified_on: d(f, "notified_on"), enforcement_notice_received_on: d(f, "enforcement_notice_received_on"), investigation_closed_on: d(f, "investigation_closed_on"),
    revoked_on: d(f, "revoked_on"), last_reliance_on: d(f, "last_reliance_on"),
    filed_on: d(f, "filed_on"), disclosure_due_date: d(f, "disclosure_due_date"), last_collection_activity_on: d(f, "last_collection_activity_on"), call_on: d(f, "call_on"), final_entry_on: d(f, "final_entry_on"), record_on: d(f, "record_on"), form_due_date: d(f, "form_due_date"), last_use_on: d(f, "last_use_on"), created_on: d(f, "created_on"),
  };
}

/**
 * One evaluator per not-before gate of the timer table — FNMA 4y post-liquidation (permanent while active, later-of,
 * jurisdiction override, never while held), Reg X 1y, Reg B 25m with the §1002.12(b)(4) extension, TCPA 4y, and the
 * seven single-anchor anniversary gates (18-month accounting reports, Reg Z 2y, Reg F 3y (a)/(b), NY 419.9 3y,
 * NYDFS 500.6 5y, IRS 4y). The predicates live in ops-19-1.ts (`DISPOSAL_GATES`), shared with `assertGateOpen`.
 */
export const EVALUATORS_19_1: Record<string, Evaluator> = Object.fromEntries(DISPOSAL_GATES.map((g) => [g.evaluator, (f: Facts) => out(g.open(gateFacts(f)))]));
export const kit_19_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
