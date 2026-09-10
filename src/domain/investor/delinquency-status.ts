/**
 * §5.7 Delinquent loan status reporting — population, priority-level code
 * derivation ("latest action to cure or liquidate" within the highest level),
 * reason codes, forbearance fields, consistency checks, and the F-1-21
 * fixed-length record codec (80 characters, positions per the Guide).
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { endOfMonth, addMonths } from "../../kernel/calendar/date.ts";

/** F-1-21 hierarchy: Level 1 approved workouts … Level 5 collections, Level 6 refinance/assignment. */
export type PriorityLevel = 1 | 2 | 3 | 4 | 5 | 6;
export interface Candidate { readonly code: string; readonly level: PriorityLevel; readonly action_at: string; readonly effective: PlainDate; readonly completion?: PlainDate | null; }
export interface LoanStatusFacts {
  readonly fnma_delinquency_status: "current" | "30" | "60" | "90" | "120+";
  readonly lpi: PlainDate | null;
  readonly actions: { kind: "trial_active" | "forbearance_active" | "repayment_active" | "short_sale_offer" | "short_sale_marketing" | "modification_completed" | "scra" | "mortgage_release_approved" | "chargeoff" | "assumption" | "brp_complete" | "bankruptcy" | "referred" | "sale_scheduled" | "sale_continued" | "judgment" | "contested" | "mediation" | "title_issue" | "probate" | "partial_reinstatement" | "third_party_sale" | "qrpc_no_solution" | "breach_letter" | "refinance_pending" | "assignment"; at: string; effective?: PlainDate; completion?: PlainDate | null; chapter?: "7" | "11" | "12" | "13"; post_petition?: boolean; asset_case?: boolean; surrender?: boolean; already_reported?: boolean; /** 5.7 guardrail: the event id that evidences the action (a code is never chosen without one). */ evidence_event_id?: string }[];
  readonly hardship?: "unemployment" | "curtailment_of_income" | "death" | "illness" | "divorce" | "disaster" | "other" | null;
  readonly contact_achieved: boolean;
  readonly referral_event_present?: boolean;
}

const BK: Record<string, string> = { "7": "65", "11": "66", "13": "67", "12": "59" };

export function candidates(f: LoanStatusFacts): Candidate[] {
  const out: Candidate[] = [];
  for (const a of f.actions) {
    const eff = a.effective ?? (a.at.slice(0, 10) as PlainDate);
    const c = (code: string, level: PriorityLevel, completion?: PlainDate | null) => out.push({ code, level, action_at: a.at, effective: eff, completion: completion ?? null });
    switch (a.kind) {
      case "trial_active": c("BF", 1, a.completion ?? null); break;
      case "forbearance_active": c("09", 1, a.completion ?? null); break;
      case "repayment_active": c("12", 1, a.completion ?? null); break;
      case "short_sale_offer": c("17", 1); break;
      case "short_sale_marketing": c("15", 5); break;
      case "modification_completed": c("28", 1); break;
      case "scra": c("32", 1); break;
      case "mortgage_release_approved": c("44", 1); break;
      case "chargeoff": c("29", 1); break;
      case "assumption": c("27", 1); break;
      case "brp_complete": c("H5", 2); break;
      case "bankruptcy": c(a.chapter === "13" && a.post_petition ? "69" : a.chapter === "7" && a.asset_case ? "3L" : a.surrender ? "3M" : BK[a.chapter ?? "13"]!, 3); break;
      case "referred": c("43", 4); break;
      case "sale_scheduled": c("71", 4); break;
      case "sale_continued": c("95", 4); break;
      case "judgment": c("94", 4); break;
      case "contested": c("33", 4); break;
      case "mediation": c("BG", 4); break;
      case "title_issue": c("BE", 4); break;
      case "probate": c("31", 4); break;
      case "partial_reinstatement": c("20", 4); break;
      case "third_party_sale": c("30", 4); break;
      case "qrpc_no_solution": if (!a.already_reported) c("AW", 5); break;
      case "breach_letter": c("80", 5); break;
      // Level 6 (F-1-21): refinance and assignment rank below every Level 5 collections code.
      case "refinance_pending": c("26", 6); break;
      case "assignment": c("49", 6); break;
    }
  }
  if (f.fnma_delinquency_status !== "current" && f.lpi) out.push({ code: "42", level: 5, action_at: "0000", effective: addMonths(f.lpi, 1), completion: null });
  return out;
}

export function inPopulation(f: LoanStatusFacts): boolean { return f.fnma_delinquency_status !== "current" || f.actions.length > 0; }

/** Highest priority level first; within a level, the latest action. */
export function deriveStatusCode(f: LoanStatusFacts): Candidate | null {
  const cs = candidates(f); if (!cs.length) return null;
  const best = Math.min(...cs.map((c) => c.level));
  return cs.filter((c) => c.level === best).sort((a, b) => (a.action_at < b.action_at ? 1 : -1))[0]!;
}

/**
 * F-1-21 reason codes: 001 death of borrower; 002 illness of borrower; 005 marital difficulties; 006 curtailment of income;
 * 015 other; 016 unemployment; 019 casualty loss (disaster); 031 unable to contact borrower.
 */
export const REASON_CODES: Record<NonNullable<LoanStatusFacts["hardship"]> | "unable_to_contact", string> = { death: "001", illness: "002", unemployment: "016", curtailment_of_income: "006", divorce: "005", disaster: "019", other: "015", unable_to_contact: "031" };
export function reasonCode(f: LoanStatusFacts): string { return f.hardship ? REASON_CODES[f.hardship] : f.contact_achieved ? "015" : "031"; }

export interface StatusLine { readonly status: string; readonly reason: string; readonly effective: string; readonly completion: string; readonly forbearance?: { pos47: "0"; pos49: "0" | "1"; pos51_61: string; pos63_70: string; pos72_75: "    " }; }
const yyyymmdd = (d: PlainDate | null | undefined) => (d ? d.replace(/-/g, "") : "        ");

export function statusLine(f: LoanStatusFacts, opts: { imminent_default?: boolean; forbearance_payment_cents?: Cents; forbearance_payment_received_on?: PlainDate | null } = {}): StatusLine | null {
  const c = deriveStatusCode(f); if (!c) return null;
  const line: StatusLine = { status: c.code, reason: reasonCode(f), effective: yyyymmdd(c.effective), completion: yyyymmdd(c.completion) };
  if (c.code === "09") {
    const amt = (opts.forbearance_payment_cents ?? 0n); const dollars = (amt / 100n).toString().padStart(8, "0") + "." + (amt % 100n).toString().padStart(2, "0");
    return { ...line, forbearance: { pos47: "0", pos49: opts.imminent_default ? "1" : "0", pos51_61: dollars, pos63_70: opts.forbearance_payment_received_on ? yyyymmdd(opts.forbearance_payment_received_on) : "        ", pos72_75: "    " } };
  }
  return line;
}

/** 5.7 rule 7 consistency: a 43 needs foreclosure.referral.sent. */
export function consistencyErrors(f: LoanStatusFacts, line: StatusLine): string[] { return line.status === "43" && !f.referral_event_present ? ["43 without foreclosure.referral.sent (E-1.2-02)"] : []; }
export function trialCompletionDate(firstTrialDue: PlainDate, months: number): PlainDate { return endOfMonth(addMonths(firstTrialDue, months - 1)); }

// ---------------------------------------------------------------------------
// F-1-21 file layout (80 characters): pos 1–9 servicer number; 10 space; 11–20 Fannie Mae loan number; 21 space; 22–23 status
// code; 24 space; 25–27 reason code; 28 space; 29–36 default effective date; 37 space; 38–45 default completion date; 46 space;
// 47 forbearance program type (0 = forbearance); 48 space; 49 imminent default indicator (1/0/space, required when 47 ≠ space);
// 50 space; 51–61 forbearance payment amount 9(8).99; 62 space; 63–70 forbearance payment date; 71 space; 72–75 "Ninety Plus New
// Layout Indicator" (4 spaces); 76–80 spaces.
// ---------------------------------------------------------------------------
export const F121_POSITIONS = { servicer_number: [1, 9], fnma_loan_number: [11, 20], status: [22, 23], reason: [25, 27], effective: [29, 36], completion: [38, 45], forbearance_type: [47, 47], imminent_default: [49, 49], forbearance_amount: [51, 61], forbearance_payment_date: [63, 70], ninety_plus_indicator: [72, 75] } as const;
export const F121_RECORD_LENGTH = 80;
/** Status codes whose effective date is required, and those whose completion date is required (F-1-21). */
export const F121_EFFECTIVE_REQUIRED: readonly string[] = ["09", "12", "15", "17", "80", "BF", "AW"];
export const F121_COMPLETION_REQUIRED: readonly string[] = ["09", "12", "15", "17", "BF"];
const at = (rec: string, [from, to]: readonly [number, number]): string => rec.slice(from - 1, to);

/** Render one F-1-21 record (no line terminator). */
export function renderF121Record(servicerNumber: string, fnmaLoanNumber: string, line: StatusLine): string {
  const fb = line.forbearance;
  const rec = servicerNumber.padStart(9, "0").slice(-9) + " " + fnmaLoanNumber.padStart(10, "0").slice(-10) + " " + line.status.padEnd(2, " ") + " " + line.reason.padEnd(3, " ") + " " + line.effective.padEnd(8, " ") + " " + line.completion.padEnd(8, " ") + " "
    + (fb ? fb.pos47 : " ") + " " + (fb ? fb.pos49 : " ") + " " + (fb ? fb.pos51_61 : " ".repeat(11)) + " " + (fb ? fb.pos63_70 : " ".repeat(8)) + " " + "    " + "     ";
  if (rec.length !== F121_RECORD_LENGTH) throw new Error(`F-1-21 record length ${rec.length} ≠ 80`);
  return rec;
}
/** Read an F-1-21 record back into its fields. */
export function parseF121Record(rec: string): { servicer_number: string; fnma_loan_number: string } & StatusLine {
  const r = rec.replace(/\r?\n$/, "");
  if (r.length !== F121_RECORD_LENGTH) throw new RangeError(`F-1-21 record is ${r.length} characters, not 80`);
  const P = F121_POSITIONS;
  const type = at(r, P.forbearance_type);
  const base = { servicer_number: at(r, P.servicer_number), fnma_loan_number: at(r, P.fnma_loan_number), status: at(r, P.status), reason: at(r, P.reason), effective: at(r, P.effective), completion: at(r, P.completion) };
  return type === "0" ? { ...base, forbearance: { pos47: "0", pos49: at(r, P.imminent_default) as "0" | "1", pos51_61: at(r, P.forbearance_amount), pos63_70: at(r, P.forbearance_payment_date), pos72_75: "    " } } : base;
}

/** F-1-21 layout and required-field check for one status line (5.7 tool `validateF121Layout`). */
export function validateF121Layout(line: StatusLine): string[] {
  const errs: string[] = [];
  if (!/^[0-9A-Z]{2}$/.test(line.status)) errs.push("status code must be 2 alphanumerics");
  if (!/^[0-9A-Z]{3}$/.test(line.reason)) errs.push("reason code must be 3 characters");
  if (!/^(\d{8}|\s{8})$/.test(line.effective)) errs.push("effective date must be YYYYMMDD or 8 spaces");
  if (!/^(\d{8}|\s{8})$/.test(line.completion)) errs.push("completion date must be YYYYMMDD or 8 spaces");
  if (F121_EFFECTIVE_REQUIRED.includes(line.status) && !/^\d{8}$/.test(line.effective)) errs.push(`effective date is required for status ${line.status} (F-1-21)`);
  if (F121_COMPLETION_REQUIRED.includes(line.status) && !/^\d{8}$/.test(line.completion)) errs.push(`completion date is required for status ${line.status} (F-1-21)`);
  if (line.status === "09") {
    const fb = line.forbearance;
    if (!fb) errs.push("status 09 requires the forbearance fields (pos 47–75)");
    else {
      if (fb.pos47 !== "0") errs.push("pos 47 forbearance program type must be 0");
      if (!/^[01]$/.test(fb.pos49)) errs.push("pos 49 imminent default indicator must be 1 or 0 when pos 47 is set");
      if (!/^\d{8}\.\d{2}$/.test(fb.pos51_61)) errs.push("pos 51–61 forbearance payment amount must be 9(8).99");
      if (!/^(\d{8}|\s{8})$/.test(fb.pos63_70)) errs.push("pos 63–70 forbearance payment date must be YYYYMMDD or 8 spaces");
      if (fb.pos72_75 !== "    ") errs.push("pos 72–75 must be 4 spaces");
    }
  } else if (line.forbearance) errs.push(`forbearance fields are only reported with status 09 (got ${line.status})`);
  return errs;
}
/** Validate an already-rendered 80-character record (positions, then the line rules). */
export function validateF121Record(rec: string): string[] {
  const r = rec.replace(/\r?\n$/, "");
  if (r.length !== F121_RECORD_LENGTH) return [`record is ${r.length} characters, not 80`];
  const errs: string[] = [];
  const P = F121_POSITIONS;
  if (!/^\d{9}$/.test(at(r, P.servicer_number))) errs.push("pos 1–9 servicer number must be 9 digits");
  if (!/^\d{10}$/.test(at(r, P.fnma_loan_number))) errs.push("pos 11–20 Fannie Mae loan number must be 10 digits");
  for (const p of [10, 21, 24, 28, 37, 46, 48, 50, 62, 71]) if (r[p - 1] !== " ") errs.push(`pos ${p} must be a space`);
  if (at(r, P.ninety_plus_indicator) !== "    " || r.slice(75) !== "     ") errs.push("pos 72–80 must be spaces");
  const line = parseF121Record(r);
  return [...errs, ...validateF121Layout(line)];
}
