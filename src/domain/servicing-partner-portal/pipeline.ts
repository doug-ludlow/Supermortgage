/**
 * 36.4 rule 2 — "The stage is the furthest row in the declared order." The pure projection of a member's motion from the
 * owners' rows (spec/sections/36-servicing-partner-portal/36-4-refinance-pipeline-feed.md): 20.1's opportunity row and its
 * `refi.opportunity.*` timestamps, 33.3's application with `prior_loan_id` and its readiness row, 23.x's DU findings, 21.2's
 * and 25.2's delivered disclosures, 23.3's / 26.x's clear to close, closing and funding, 30.2's boarded new loan and 21.6's
 * terminal dispositions. No I/O, no figure, no calendar guess: a stage with no row is omitted, never assumed (rule 2); the
 * only arithmetic is `daysInStage`, a count of calendar days in America/New_York (rule 4). Nothing is stored (no
 * `pipeline_stage` column on `loans`; brief §4.6 and §10) and nothing is emitted (rule 8).
 *
 *   pipelineOf    the member's rows → every stage reached in time order (`stages[]`, the detail's strip) and the newest
 *                 motion's current stage (`current`, the list's item) — rule 3: one item per member, the newest motion; an
 *                 earlier expired or declined offer stays in the history.
 *   daysInStage   rule 4: calendar days from the ET date of `entered_at` to the ET date of the read (0 on the day entered).
 *
 * The runtime (src/runtime/partner-portal/pipeline.ts) reads the rows and events into MotionInput; this module never does.
 */
import { daysBetween } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";

export const ET = "America/New_York";
/** The declared order (rule 2's table), least advanced first. */
export const PIPELINE_STAGES = ["offered", "engaged", "readiness", "du", "disclosures", "closing", "boarded"] as const;
export type ProgressStage = (typeof PIPELINE_STAGES)[number];
/** The terminal stages, each by its stored name: 20.1's `expired` and `declined`, 21.6's dispositions (discrepancy 1 — no umbrella word). */
export const TERMINAL_STAGES = ["expired", "declined", "withdrawn", "denied", "closed_incomplete", "approved_not_accepted"] as const;
export type TerminalStage = (typeof TERMINAL_STAGES)[number];
export type PipelineStageName = ProgressStage | TerminalStage;
export const isTerminalStage = (s: string): s is TerminalStage => (TERMINAL_STAGES as readonly string[]).includes(s);
/** 36.5's `in_flight`: a member whose current stage is neither terminal nor `boarded` (discrepancy 3). */
export const isInFlightStage = (s: string): boolean => (PIPELINE_STAGES as readonly string[]).includes(s) && s !== "boarded";
/** 21.6's terminal dispositions as stored (`applications.disposition`), the feed's names for them. */
export const APPLICATION_TERMINAL_STAGES: readonly TerminalStage[] = ["withdrawn", "denied", "closed_incomplete", "approved_not_accepted"];
const rankOf = (s: PipelineStageName): number => (isTerminalStage(s) ? 100 : PIPELINE_STAGES.indexOf(s));

/** 20.1's opportunity row as stored, with the timestamps of its `refi.opportunity.*` events (null when the event never landed). */
export interface OpportunityMotion {
  readonly opportunity_id: string;
  /** `refi_opportunities.status` as stored: detected | suppressed | offer_ready | offered | engaged | converted | declined | expired | requested */
  readonly status: string;
  readonly offered_at: string | null;
  readonly engaged_at: string | null;
  readonly declined_at: string | null;
  readonly expired_at: string | null;
  /** `refi_opportunities.application_id` once 33.3's refi.open converted it */
  readonly application_id: string | null;
}
/** 33.3's refinance application (`prior_loan_id` = the member) with the rows and event timestamps of the later stages. */
export interface ApplicationMotion {
  readonly application_id: string;
  /** the opportunity the Yes came from (`partner_book.refinance.opened.opportunity_id`), when known */
  readonly opportunity_id: string | null;
  /** `partner_book.refinance.opened`, else `application.received`, else the row's created_at */
  readonly opened_at: string;
  /** the latest `readiness_checks.missing` for the application (33.3 rule 1's names, in the order asked); null when no check has run */
  readonly readiness_missing: readonly string[] | null;
  /** `du.findings.received` (23.x) */
  readonly du_at: string | null;
  /** the earlier of `disclosure.le.delivered` (21.2) and `disclosure.cd.delivered` (25.2) */
  readonly disclosures_at: string | null;
  /** the earliest of `clear_to_close.issued`, `closing.scheduled`, `closing.consummated`, `loan.funded` */
  readonly closing_at: string | null;
  /** the new `loans` row 30.2 boarded from this application (`origination_application_id` = it), `status = active`, with `loan.boarded`'s instant */
  readonly boarded: { readonly loan_id: string; readonly boarded_at: string; readonly status: string } | null;
  /** 21.6's terminal disposition, by its stored name, with its event's instant */
  readonly disposition: { readonly stage: TerminalStage; readonly at: string } | null;
}
export interface MotionInput { readonly opportunities: readonly OpportunityMotion[]; readonly applications: readonly ApplicationMotion[] }

/** One entry of the detail's strip: the stage, when it was entered, the rows it came from; `missing` on `readiness` (rule 6); `new_loan` on `boarded` (rule 7). */
export interface PipelineStage {
  readonly stage: PipelineStageName;
  readonly entered_at: string;
  readonly opportunity_id?: string;
  readonly application_id?: string;
  readonly missing?: readonly string[];
  readonly new_loan?: { readonly loan_id: string; readonly status: string };
}
export interface PipelineProjection {
  /** every stage reached, in time order (ties by the declared order) — the history is whole (rule 3) */
  readonly stages: readonly PipelineStage[];
  /** the newest motion's current stage: the terminal entry when one exists, else the furthest reached; null when the member never left the board */
  readonly current: PipelineStage | null;
  /** how many motions (offers, or applications opened without one) the member has had */
  readonly motions: number;
}

const PAST_OFFERED = new Set(["offered", "engaged", "converted", "declined", "expired"]);
const later = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

/** A motion: one opportunity and, when the Yes converted it, its application — or an application that opened without an opportunity on record. */
function motionEntries(opp: OpportunityMotion | null, app: ApplicationMotion | null): PipelineStage[] {
  const out: PipelineStage[] = [];
  if (opp) {
    if (opp.offered_at && PAST_OFFERED.has(opp.status)) out.push({ stage: "offered", entered_at: opp.offered_at, opportunity_id: opp.opportunity_id });
    if (opp.engaged_at && opp.status !== "offer_ready" && opp.status !== "suppressed" && opp.status !== "detected") out.push({ stage: "engaged", entered_at: opp.engaged_at, opportunity_id: opp.opportunity_id });
    if (opp.status === "expired" && opp.expired_at) out.push({ stage: "expired", entered_at: opp.expired_at, opportunity_id: opp.opportunity_id });
    if (opp.status === "declined" && opp.declined_at) out.push({ stage: "declined", entered_at: opp.declined_at, opportunity_id: opp.opportunity_id });
  }
  if (app) {
    const ids = { application_id: app.application_id, ...(opp ? { opportunity_id: opp.opportunity_id } : app.opportunity_id ? { opportunity_id: app.opportunity_id } : {}) };
    out.push({ stage: "readiness", entered_at: app.opened_at, ...ids, ...(app.readiness_missing ? { missing: [...app.readiness_missing] } : {}) });
    if (app.du_at) out.push({ stage: "du", entered_at: app.du_at, ...ids });
    if (app.disclosures_at) out.push({ stage: "disclosures", entered_at: app.disclosures_at, ...ids });
    if (app.closing_at) out.push({ stage: "closing", entered_at: app.closing_at, ...ids });
    if (app.boarded && app.boarded.status === "active") out.push({ stage: "boarded", entered_at: app.boarded.boarded_at, ...ids, new_loan: { loan_id: app.boarded.loan_id, status: app.boarded.status } });
    if (app.disposition) out.push({ stage: app.disposition.stage, entered_at: app.disposition.at, ...ids });
  }
  return out;
}
/** The motion's current stage: its terminal entry (the latest, should two exist), else the furthest reached in the declared order (discrepancy 2: an LE before the DU run does not step the stage back). */
function currentOf(entries: readonly PipelineStage[]): PipelineStage | null {
  const terminal = entries.filter((e) => isTerminalStage(e.stage)).sort((a, b) => Date.parse(b.entered_at) - Date.parse(a.entered_at))[0];
  if (terminal) return terminal;
  let best: PipelineStage | null = null;
  for (const e of entries) if (!best || rankOf(e.stage) > rankOf(best.stage) || (rankOf(e.stage) === rankOf(best.stage) && later(e.entered_at, best.entered_at))) best = e;
  return best;
}

/** Rules 2 and 3, pure over the member's rows. A member with no row of any stage answers `stages: [], current: null` (on the board, not on the feed). */
export function pipelineOf(m: MotionInput): PipelineProjection {
  const apps = new Map(m.applications.map((a) => [a.application_id, a]));
  const usedApps = new Set<string>();
  const motions: { start: string; entries: PipelineStage[] }[] = [];
  const byOpp = [...m.opportunities].sort((a, b) => Date.parse(a.offered_at ?? a.engaged_at ?? "0") - Date.parse(b.offered_at ?? b.engaged_at ?? "0"));
  for (const opp of byOpp) {
    const app = (opp.application_id && apps.get(opp.application_id)) || m.applications.find((a) => a.opportunity_id === opp.opportunity_id && !usedApps.has(a.application_id)) || null;
    if (app) usedApps.add(app.application_id);
    const entries = motionEntries(opp, app);
    if (entries.length) motions.push({ start: entries[0]!.entered_at, entries });
  }
  for (const app of m.applications) {
    if (usedApps.has(app.application_id)) continue;
    const entries = motionEntries(null, app);
    if (entries.length) motions.push({ start: entries[0]!.entered_at, entries });
  }
  const stages = motions.flatMap((x) => x.entries).sort((a, b) => Date.parse(a.entered_at) - Date.parse(b.entered_at) || rankOf(a.stage) - rankOf(b.stage));
  const newest = motions.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0] ?? null;
  return { stages, current: newest ? currentOf(newest.entries) : null, motions: motions.length };
}

/** Rule 4: the count of `calendar_days` from the date of `entered_at` in America/New_York to the day of the read — 0 on the day it was entered; never negative. */
export function daysInStage(enteredAtIso: string, nowIso: string): number {
  const entered = wallClock(Date.parse(enteredAtIso), ET).date; const today = wallClock(Date.parse(nowIso), ET).date;
  return Math.max(0, daysBetween(entered, today));
}
