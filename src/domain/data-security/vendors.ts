/** 19.3 Fannie Mae data/technology-provider requirements — A2-1-01 regime, change gate, notice clocks, contract clauses. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";

export const A2101_THRESHOLD = 20_000;
/** Rule 1 — active once the year's max count ≥ 20,000; sticky through Dec 31. */
export function regimeActive(countsThisYear: readonly { on: PlainDate; count: number }[], asOf: PlainDate): boolean {
  return countsThisYear.some((c) => c.on <= asOf && c.on.slice(0, 4) === asOf.slice(0, 4) && c.count >= A2101_THRESHOLD);
}
export function earliestCutover(noticeSentOn: PlainDate): PlainDate { return addDays(noticeSentOn, 180); }
export function cutoverAllowed(noticeSentOn: PlainDate | null, cutoverOn: PlainDate): boolean { return noticeSentOn !== null && cutoverOn >= earliestCutover(noticeSentOn); }
export function contractCopiesDue(noticeOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(noticeOn, 5, cal); }
export function transitionPlanDue(requestedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(requestedOn, 10, cal); }
export function form101TerminationDue(effectiveOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(effectiveOn, 5, cal); }
export function disclosureResponseDue(receivedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(receivedOn, 5, cal); }
export function schemaDriftDisableOn(detectedOn: PlainDate): PlainDate { return addDays(detectedOn, 120); }
export function reassessment(tier: 1 | 2 | 3, assessedOn: PlainDate): { due: PlainDate; escalate_on: PlainDate } { const due = addDays(assessedOn, tier === 1 ? 365 : tier === 2 ? 730 : 1095); return { due, escalate_on: addDays(due, 60) }; }

export const MANDATORY_CLAUSES = ["A2101_FNMA_OWNERSHIP_FILES_DATA", "A2101_FNMA_ACCESS_AUDIT", "A2101_TERMINATION_RETURN_DESTROY", "A2107_RESCISSION_ACK", "SUPPLEMENT_FLOWDOWN_NO_LESS_PROTECTIVE", "INCIDENT_NOTICE_24H", "AUDIT_RIGHTS", "DATA_USE_LIMITED_TG3", "RECORDS_RETURN_5BD", "US_ONLY_PROCESSING", "SUBPROCESSOR_NOTICE", "NO_UI_SCRAPING"] as const;
export const AI_PROVIDER_CLAUSES = ["NO_TRAINING_ON_DATA", "LIMITED_RETENTION_30D", "NO_HUMAN_REVIEW_WITHOUT_NOTICE", "MODEL_VERSION_CHANGE_NOTICE", "ASSURANCE_REPORTS", "FNMA_DISCLOSURE_COOPERATION"] as const;
export type ClauseState = "present" | "deviation" | "missing";
export function vendorActivationGate(clauses: Readonly<Record<string, ClauseState>>, aiProvider: boolean, attorneySignoff: boolean, officerApproval: boolean): { allowed: boolean; missing: string[]; deviations: string[]; tasks: string[] } {
  const required = [...MANDATORY_CLAUSES, ...(aiProvider ? AI_PROVIDER_CLAUSES : [])];
  const missing = required.filter((c) => (clauses[c] ?? "missing") === "missing");
  const deviations = required.filter((c) => clauses[c] === "deviation");
  const tasks: string[] = [];
  if (missing.length > 0) tasks.push("attorney");
  if (deviations.length > 0 && !(attorneySignoff && officerApproval)) tasks.push("attorney_signoff_and_officer_approval");
  return { allowed: missing.length === 0 && (deviations.length === 0 || (attorneySignoff && officerApproval)), missing, deviations, tasks };
}
export function fnmaAdapterAllowed(form101Acknowledged: boolean): { allowed: boolean; reason: "form101_inactive" | null } { return form101Acknowledged ? { allowed: true, reason: null } : { allowed: false, reason: "form101_inactive" }; }
export function promptPayloadOk(payload: Record<string, unknown>): { ok: boolean; violations: string[] } {
  const banned = ["ssn", "tin", "account_number", "dob", "race_codes", "ethnicity_codes", "sex", "race", "ethnicity"];
  const v = Object.keys(payload).filter((k) => banned.includes(k.toLowerCase()));
  return { ok: v.length === 0, violations: v };
}
export function deployGate(evalPassed: boolean): boolean { return evalPassed; }
