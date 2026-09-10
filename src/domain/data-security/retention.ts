/** 19.1 Records retention — anniversary arithmetic, gates, holds, disposal runs, request clocks. */
import { type PlainDate, addDays, addMonths, dayOfWeek, parts, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";

/** Same month/day N years later; Feb 29 anchors roll to Mar 1 (19.1-T11). */
export function anniversary(anchor: PlainDate, years: number): PlainDate {
  const { y, m, d } = parts(anchor);
  if (m === 2 && d === 29) return ymd(y + years, 3, 1);
  return ymd(y + years, m, d);
}

export interface RetentionInput {
  readonly liquidated_on: PlainDate | null;          // Fannie Mae liquidation (payoff etc.)
  readonly discharged_on: PlainDate | null;          // Reg X: paid in full
  readonly transferred_out_on: PlainDate | null;
  readonly final_entry_on: PlainDate | null;         // NY 419.9 anchor
  readonly state: string;
  readonly fdcpa_debt_collector: boolean;
  readonly last_collection_activity_on: PlainDate | null;
  readonly reg_b_notified_on?: PlainDate | null;
  readonly enforcement_open?: boolean;
  readonly hold_count: number;
  readonly loan_active: boolean;
}
export interface RetentionGates { readonly regx: PlainDate | null; readonly regf: PlainDate | null; readonly ny: PlainDate | null; readonly fnma: PlainDate | null; readonly policy_transfer: PlainDate | null; readonly reg_b: PlainDate | null; readonly eligible_for_disposal_at: PlainDate | null; readonly status: "permanent_while_active" | "held" | "retained" | "eligible"; }

/** Rule 1 — max over every class; permanent while active; indefinitely extended while held. */
export function retention(i: RetentionInput, asOf: PlainDate): RetentionGates {
  const regx = i.transferred_out_on ? anniversary(i.transferred_out_on, 1) : i.discharged_on ? anniversary(i.discharged_on, 1) : null;
  const regf = i.fdcpa_debt_collector && i.last_collection_activity_on ? anniversary(i.last_collection_activity_on, 3) : null;
  const ny = i.state === "NY" && i.final_entry_on ? anniversary(i.final_entry_on, 3) : null;
  const fnma = i.liquidated_on ? anniversary(i.liquidated_on, 4) : null;
  const policy = i.transferred_out_on ? anniversary(i.transferred_out_on, 4) : null;
  const regB = i.reg_b_notified_on ? (i.enforcement_open ? null : addMonths(i.reg_b_notified_on, 25)) : null;
  const gates = [regx, regf, ny, fnma, policy, regB].filter((x): x is PlainDate => x !== null);
  const eligible = gates.length === 0 ? null : gates.reduce((a, b) => (b > a ? b : a));
  const status: RetentionGates["status"] = i.loan_active && i.transferred_out_on === null ? "permanent_while_active" : i.hold_count > 0 ? "held" : eligible !== null && eligible <= asOf ? "eligible" : "retained";
  return { regx, regf, ny, fnma, policy_transfer: policy, reg_b: regB, eligible_for_disposal_at: eligible, status };
}

/** Disposal runs happen on the first Sunday of the month following eligibility/hold release. */
export function nextDisposalRun(after: PlainDate): PlainDate {
  const { y, m } = parts(addMonths(after, 1));
  let d = ymd(y, m, 1);
  while (dayOfWeek(d) !== 0) d = addDays(d, 1);
  return d;
}
export function holdReleaseAllowed(approvers: readonly ("officer" | "attorney")[]): boolean { return approvers.includes("officer") && approvers.includes("attorney"); }
export function disposalAllowed(g: RetentionGates, wormIntegrityOk: boolean, officerAttestation: boolean): { allowed: boolean; reason: string | null } {
  if (g.status === "permanent_while_active") return { allowed: false, reason: "permanent_while_active" };
  if (g.status === "held") return { allowed: false, reason: "legal_hold" };
  if (g.status !== "eligible") return { allowed: false, reason: "not_yet_eligible" };
  if (!wormIntegrityOk) return { allowed: false, reason: "worm_integrity_failed_sev1" };
  if (!officerAttestation) return { allowed: false, reason: "officer_attestation_required" };
  return { allowed: true, reason: null };
}
/** §1024.38(c)(2): servicing file within 5 days of the request. */
export function servicingFileDue(receivedOn: PlainDate): PlainDate { return addDays(receivedOn, 5); }
export function fnmaRecordsRequestDue(receivedOn: PlainDate, statedBusinessDays = 10, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(receivedOn, statedBusinessDays, cal); }
export function ftcDisposalDue(lastUsedOn: PlainDate, loanLinked: boolean): PlainDate | null { return loanLinked ? null : anniversary(lastUsedOn, 2); }
export function routeRecordsRequest(i: { borrower_signed: boolean; requester: "borrower" | "fnma" | "regulator" | "court" | "partner" }): "4.2_rfi" | "19.1_production" { return i.requester === "borrower" && i.borrower_signed ? "4.2_rfi" : "19.1_production"; }
export function subpoenaActions(): { hold: true; attorney_escalation_within_minutes: 60; production_requires: "attorney_approval" } { return { hold: true, attorney_escalation_within_minutes: 60, production_requires: "attorney_approval" }; }
export function redactionRequired(recipient: "borrower" | "third_party" | "fnma" | "regulator" | "court" | "partner"): boolean { return recipient === "borrower" || recipient === "third_party"; }
