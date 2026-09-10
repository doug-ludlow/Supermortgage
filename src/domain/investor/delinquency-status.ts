/**
 * §5.7 Delinquent loan status reporting — population, priority-level code
 * derivation ("latest action to cure or liquidate" within the highest level),
 * reason codes, forbearance fields, consistency checks.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { endOfMonth, addMonths } from "../../kernel/calendar/date.ts";

export interface Candidate { readonly code: string; readonly level: 1 | 2 | 3 | 4 | 5; readonly action_at: string; readonly effective: PlainDate; readonly completion?: PlainDate | null; }
export interface LoanStatusFacts {
  readonly fnma_delinquency_status: "current" | "30" | "60" | "90" | "120+";
  readonly lpi: PlainDate | null;
  readonly actions: { kind: "trial_active" | "forbearance_active" | "repayment_active" | "short_sale_offer" | "short_sale_marketing" | "modification_completed" | "scra" | "mortgage_release_approved" | "chargeoff" | "assumption" | "brp_complete" | "bankruptcy" | "referred" | "sale_scheduled" | "sale_continued" | "judgment" | "contested" | "mediation" | "title_issue" | "probate" | "partial_reinstatement" | "third_party_sale" | "qrpc_no_solution" | "breach_letter" | "refinance_pending" | "assignment"; at: string; effective?: PlainDate; completion?: PlainDate | null; chapter?: "7" | "11" | "12" | "13"; post_petition?: boolean; asset_case?: boolean; surrender?: boolean; already_reported?: boolean }[];
  readonly hardship?: "unemployment" | "curtailment_of_income" | "death" | "illness" | "divorce" | "disaster" | "other" | null;
  readonly contact_achieved: boolean;
  readonly referral_event_present?: boolean;
}

const BK: Record<string, string> = { "7": "65", "11": "66", "13": "67", "12": "59" };

export function candidates(f: LoanStatusFacts): Candidate[] {
  const out: Candidate[] = [];
  for (const a of f.actions) {
    const eff = a.effective ?? (a.at.slice(0, 10) as PlainDate);
    const c = (code: string, level: Candidate["level"], completion?: PlainDate | null) => out.push({ code, level, action_at: a.at, effective: eff, completion: completion ?? null });
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
      case "refinance_pending": c("26", 5); break;
      case "assignment": c("49", 5); break;
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

export const REASON_CODES: Record<NonNullable<LoanStatusFacts["hardship"]> | "unable_to_contact", string> = { death: "001", illness: "002", unemployment: "016", curtailment_of_income: "006", divorce: "003", disaster: "023", other: "015", unable_to_contact: "031" };
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
