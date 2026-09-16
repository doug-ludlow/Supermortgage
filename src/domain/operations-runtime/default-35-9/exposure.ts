/**
 * §35.9 rule 5 — "The exposure projection is 13.5's formula run daily." For every open foreclosure case whose tracking row is
 * `tracking` / `at_risk_70pct` / `over_allowable`, the daily unit runs 13.5's `TimeframeTracker.dailyProjection` (today as the
 * provisional sale date, plus the firm's forecast sale date when one exists — the case's `sale_scheduled_at` or the tracking row's
 * `forecast_sale_on`) and then 13.5's `review()` (its own 70% mark: `foreclosure.timeframe.at_risk` and the status demand).
 * The figures are 13.5's (`exposureCents`); this process asserts them.
 */
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import { plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { TimeframeTracker, TRACKING } from "../../foreclosure/ops-13-5.ts";
import { STEP_AGENTS } from "../default-35-9.ts";
import { s } from "./commands.ts";
import { str, type Row } from "./store.ts";

const OPEN = new Set(["tracking", "at_risk_70pct", "over_allowable"]);
export async function exposureStep(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, asOf: string): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId;
  const rows = rt.store.list(TRACKING, (d) => d["loan_id"] === loanId && OPEN.has(String(d["status"] ?? "")));
  if (!rows.length) return { skipped: "no open fc_timeframe_tracking row" };
  const tracker = new TimeframeTracker({ events: ctx.events, store: rt.store, escalations: rt.escalations, clock: { now: () => ctx.now }, actor: { kind: "agent", id: STEP_AGENTS.foreclosure } });
  const out: Row[] = [];
  for (const t of rows) {
    const caseId = str(t.data, "case_id");
    const fc = rt.store.get("foreclosure_cases", caseId);
    const forecast: PlainDate | null = (str(fc?.data ?? {}, "sale_scheduled_at") ? D(str(fc!.data, "sale_scheduled_at").slice(0, 10)) : null) ?? (str(t.data, "forecast_sale_on") ? D(str(t.data, "forecast_sale_on").slice(0, 10)) : null);
    const r = tracker.dailyProjection({ loan_id: loanId, case_id: caseId, as_of: D(asOf), forecast_sale_on: forecast });
    const rv = tracker.review(loanId, D(asOf), caseId);
    out.push({ case_id: caseId, actual_days: r.today?.actual_days ?? null, excess_days: r.today?.excess_days ?? null, exposure_cents: r.today ? r.today.exposure_cents.toString() : null, forecast_exposure_cents: r.forecast ? r.forecast.exposure_cents.toString() : null, status: rv.status, emitted: r.event !== null });
  }
  return { projected: out.length, cases: out };
}
