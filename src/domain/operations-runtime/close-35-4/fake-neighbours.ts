/**
 * §35.4 — FAKE neighbours: the receipts of the chain whose owners' units do not run on this runtime (ports.ts ownerRuns:
 * 35.3's registry has no runner for the cycle yet — 5.1's LAR at HEAD — or 35.3's cycles pass does not run here) or whose
 * real run needs a book the demo has no use for (18.1's QC cycle signed by its officer, 18.7's quarterly eligibility test
 * over GL snapshots). In every build stage before go-live (35.7: "every human is a FAKE"; CLAUDE.md: every vendor an
 * in-repo FAKE) the sweep lets this FAKE stand in for each absent owner so the demo clock walks a whole close (35.4-T4,
 * 35.3-T9) — each stand-in is the owner's own event type under the owner's own actor with the fields the chain's receipt
 * filter reads, and carries `vendor: "FAKE"` so nobody mistakes it for the owner's run. Never in production
 * (NO_FAKE_IN_PRODUCTION); off with `CLOSE_FAKE_NEIGHBOURS=off` or when the FAKE reviewers are off; a neighbour steps
 * aside the moment its unit runs on the runtime (35.5's `cashiering_daily` and 8.1's `metro2_monthly` through 35.3's
 * executor on the hosted runtime) — then its receipts are the owner's to emit.
 *
 * The FAKE officer of rule 7 (the approval record on the balance attestation) is the same FAKE person the reviewers
 * pass uses (`{kind: "human", id: "FAKE:officer", role: "officer"}`), subject to 35.7 rule 6's handover: a role handed to
 * a person is not filled here (`currentFakeSet`).
 */
import { randomUUID } from "node:crypto";
import type { Actor } from "../../../kernel/events/index.ts";
import { plainDate as D } from "../../../kernel/calendar/date.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { signCycle } from "../../qc-audit/ops-18-1.ts";
import { isProduction } from "../roles-35-7/types.ts";
import { bd1Of, etDate } from "./calendar.ts";
import { ownerRuns } from "./ports.ts";
import type { CloseRunner } from "./runners.ts";
import { stepsOf } from "./store.ts";
import type { ClosePeriodRow } from "./types.ts";

export const FAKE_NEIGHBOUR_NAME = "FAKE" as const;
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const INVESTOR_REPORTING: Actor = { kind: "agent", id: "investor-reporting" };
const CREDIT_REPORTING: Actor = { kind: "agent", id: "credit-reporting" };
const QC_AUDIT: Actor = { kind: "agent", id: "qc-audit" };
const CUSTODIAL_RECON: Actor = { kind: "agent", id: "custodial-recon" };
const onBus = async (rt: Runtime, type: string, filter: Record<string, unknown>): Promise<boolean> => Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_events WHERE type = $1 AND payload @> $2::jsonb`, [type, JSON.stringify(filter)]))[0]!.c) > 0;
const append = (rt: Runtime, e: { type: string; actor: Actor; payload: Record<string, unknown>; aggregate?: { kind: string; id: string } }) => rt.uow.run({}, (ctx) => ctx.events.append({ type: e.type, actor: e.actor, payload: { ...e.payload, vendor: FAKE_NEIGHBOUR_NAME }, ...(e.aggregate ? { aggregate: e.aggregate } : {}) }), { clock: rt.clock });

/** Whether the FAKE neighbours stand in on this runtime: never in production, only with the FAKE reviewers on, unless switched off. */
export function fakeNeighboursOn(rt: Runtime): boolean {
  if (isProduction(rt.environment)) return false;
  if (!rt.reviewers) return false;
  return (rt.env["CLOSE_FAKE_NEIGHBOURS"] ?? "").trim().toLowerCase() !== "off";
}

/** The FAKE officer for rule 7's approval record, or null (reviewers off, production, or the officer role handed over — 35.7 rule 6). */
export async function fakeOfficer(rt: Runtime): Promise<Actor | null> {
  if (!fakeNeighboursOn(rt)) return null;
  const m = await import("../roles-35-7/env.ts");
  const set = await m.currentFakeSet(rt.db, rt.environment, ["officer"]);
  return set.includes("officer") ? rt.reviewers!.actor("officer") : null;
}

/** The cycles the FAKE runs for an absent owner (5.1's `lar_daily`, 8.1's `metro2_monthly` — each only while its unit does not run on this runtime) — a runner per cycle code, keyed like `CLOSE_RUNNERS`. */
export async function fakeNeighbourRunners(rt: Runtime): Promise<Readonly<Record<string, CloseRunner>>> {
  if (!fakeNeighboursOn(rt)) return {};
  const out: Record<string, CloseRunner> = {};
  if (!ownerRuns(rt, "lar_daily")) out["lar_daily"] = async (r, u) => {
    const bd1 = bd1Of(u.period_key);
    if (await onBus(r, "investor.lar.run_completed", { as_of_date: bd1 })) return { outcome: "skipped" };
    const loans = Number((await r.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE status = 'active'`))[0]!.c);
    await append(r, { type: "investor.lar.run_completed", actor: INVESTOR_REPORTING, payload: { as_of_date: bd1, run_id: randomUUID(), cycle_code: "lar_daily", period_key: bd1, units_total: loans, units_done: loans } });
    return { outcome: "done", detail: "35.3 lar_daily stood in by FAKE" };
  };
  // 8.1's builder runs as 35.3's `metro2_monthly` unit on the hosted runtime (runners.ts metro2MonthlyRunner); where that unit does not run the FAKE stands in for the month-end snapshot receipt
  if (!ownerRuns(rt, "metro2_monthly")) out["metro2_monthly"] = async (r, u) => {
    const asOf = String(u.input["as_of_date"] ?? u.input["period_end"]);
    if (await onBus(r, "credit.cycle.snapshot_completed", { as_of_date: asOf })) return { outcome: "skipped" };
    const loans = Number((await r.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE status = 'active'`))[0]!.c);
    const cycleId = `m2-${u.period_key}`;
    await append(r, { type: "credit.cycle.snapshot_completed", actor: CREDIT_REPORTING, aggregate: { kind: "metro2_cycle", id: cycleId }, payload: { cycle_id: cycleId, as_of_date: asOf, record_count: loans, omitted: 0, exceptions: [] } });
    return { outcome: "done", detail: "8.1 metro2_monthly stood in by FAKE" };
  };
  // 6.4's `form496a.generate` registers on the bus only when spec/registry/agents.json names it for 6.4 (src/app/tools/section06.ts: "today the extractor left the row empty"): until then the FAKE stands in for the T&I reconciliation's receipt (an ask of 6.4; runners.ts runs the real form the day the tool is on the bus)
  if (!rt.tool("6.4", "form496a.generate")) out["form_496a_monthly"] = async (r, u) => {
    const account = String(u.input["custodial_account_id"] ?? "");
    if (!account || (await onBus(r, "custodial.reconciliation.completed", { kind: "monthly_form_496a", period: u.period_key, custodial_account_id: account }))) return { outcome: "skipped" };
    await append(r, { type: "custodial.reconciliation.completed", actor: CUSTODIAL_RECON, aggregate: { kind: "custodial_account", id: account }, payload: { kind: "monthly_form_496a", period: u.period_key, custodial_account_id: account, reconciliation_id: `f496a-${account}-${u.period_key}`, note: "6.4's form496a.generate is not on the bus (registry row empty)" } });
    return { outcome: "done", detail: "6.4 form_496a_monthly stood in by FAKE" };
  };
  return out;
}

/** The receipt-only steps of absent owners: 35.5's day (`eod_cutoff`), 18.1's signed cycle (`qc_cycle`, by the FAKE qc_officer) and 18.7's quarterly test (`eligibility`), for every open period whose step is planned; returns how many receipts it emitted. */
export async function fakeNeighbourReceipts(rt: Runtime, periods: readonly ClosePeriodRow[], at: string): Promise<number> {
  if (!fakeNeighboursOn(rt)) return 0;
  let emitted = 0;
  const cashieringAbsent = !ownerRuns(rt, "cashiering_daily");   // 35.5's day runs as 35.3's `cashiering_daily` unit on the hosted runtime (its election emits the literal)
  for (const p of periods) {
    if (p.kind !== "month") continue;
    for (const s of await stepsOf(rt.db, p.id)) {
      if (!["planned", "running"].includes(s.status) || s.received >= s.expected_receipts) continue;
      if (s.code === "eod_cutoff" && cashieringAbsent) {
        if (await onBus(rt, "cashiering.daily.run_completed", { as_of_date: p.period_end })) continue;
        const loans = Number((await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE status = 'active'`))[0]!.c);
        await append(rt, { type: "cashiering.daily.run_completed", actor: CASHIERING, payload: { as_of_date: p.period_end, run_id: randomUUID(), cycle_code: "cashiering_daily", period_key: p.period_end, loans } }); emitted++;
      } else if (s.code === "qc_cycle" && rt.reviewers?.fills("qc_officer")) {
        if (await onBus(rt, "qc.cycle.signed", { period_end: p.period_end })) continue;
        const signer = rt.reviewers.actor("qc_officer");
        const r = signCycle({ cycle_id: `qc-${p.period}`, signed_on: etDate(at), signer: { kind: "human", id: signer.id, role: "officer", designation: "qc_officer" }, period_end: D(p.period_end) });
        if (!r.event) { rt.logger?.warn("close: FAKE qc_officer could not sign the cycle", { period: p.period, refusal: r.refusal }); continue; }
        await append(rt, { type: r.event.type, actor: signer, aggregate: { kind: "qc_cycle", id: r.event.cycle_id }, payload: { cycle_id: r.event.cycle_id, signed_at: r.event.signed_at, period_end: r.event.period_end, cycle_clock_opens_on: r.event.cycle_clock_opens_on, report_due: r.report_due } }); emitted++;
      } else if (s.code === "eligibility") {
        if (await onBus(rt, "eligibility.computed", { period_end: p.period_end })) continue;
        const q = Math.floor((Number(p.period.slice(5, 7)) - 1) / 3) + 1;
        await append(rt, { type: "eligibility.computed", actor: QC_AUDIT, aggregate: { kind: "eligibility", id: "supermortgage" }, payload: { entity: "supermortgage", period_end: p.period_end, quarter: q, status: "pass", reason: "FAKE stand-in for 18.7's quarterly test: no GL snapshot in the demo book", stale: false, certified_by_officer_id: null, config_version: "2026.1" } }); emitted++;
      }
    }
  }
  return emitted;
}
