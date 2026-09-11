/**
 * §29.2 process-owned tools — bus tools for 29.2 defined with `defineTools("29.2", "secondary", defs)` from ../tools.ts.
 * Every tool string is one spec/registry/agents.json names for 29.2; src/app/tools.test.ts refuses the rest. Spread by
 * ./index.ts. The handlers are thin: the rules live in src/domain/secondary/ops-29-2.ts (PipelineService — the runtime
 * service `secondary_pipeline`); the store keeps `pipeline_positions`, `pull_through_estimates`, `fallout_events`,
 * `hedge_positions`/`hedge_trades`, `mark_to_market_runs`, `rate_shock_reports`, `margin_calls` and `hedge_policies`
 * (migrations 0103/0104) as the service's projections. Guardrails encode the AI-design sentences (never alone): never
 * place, roll or pair off a dealer trade — the partner's trader executes on the partner's authorization
 * (`hedge.auto_execute_within_band=false`); never request a Fannie Mae mandatory commitment without the 29.1 officer
 * authorization; never use an instrument, counterparty or size outside `hedge_policies`; never let a TBA position stand
 * within 3 business days of its notification date; never mark to a close-of-business PE–WL display price or a stale run
 * without flagging; never change the pull-through model version without officer and 31.2 approval; never net SM's
 * economics against the partner's hedge P&L; in best-efforts mode (`execution.mandatory_enabled=false`) no trade package
 * and no mandatory commitment request (T10).
 */
import { defineTools, compute, decision, escalate, never, needsRole, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import {
  PipelineService, PULL_THROUGH_MODEL_V1, computeCoverage, estimateDurationFactor, pullThroughProbability, rollDueOn, sifmaDates, instrumentClass,
  type FalloutReason, type FalloutReasonCode, type HedgeInstrument, type PipelineStage, type PolicyInput, type PullThroughMethod, type PullThroughModel, type SifmaClass, type TradeKind, type TransactionType, type WireApproval,
} from "../../domain/secondary/ops-29-2.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const at = (i: ToolInput, k: string, ctx: CommandContext): string => (typeof i[k] === "string" && i[k] ? String(i[k]) : ctx.now);
const optStr = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && i[k] ? String(i[k]) : null);
const optDate = (i: ToolInput, k: string): PlainDate | null => (optStr(i, k) ? D(str(i, k)) : null);
const optCents = (i: ToolInput, k: string): bigint | undefined => (i[k] === undefined || i[k] === null || i[k] === "" ? undefined : cents(i[k]));
const obj = (i: ToolInput, k: string): Record<string, unknown> => ((i[k] as Record<string, unknown> | undefined) ?? {});
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
/** Feature flags (`execution.mandatory_enabled`, `hedge.instruments`, `hedge.auto_execute_within_band`) from a `flags` input or the entity store's `feature_flags` rows. */
const flagsOf = (i: ToolInput, rt: ToolRuntime): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of ["execution.mandatory_enabled", "hedge.instruments", "hedge.auto_execute_within_band"]) { const row = rt.store.get("feature_flags", k); if (row && row.data.value !== undefined) out[k] = row.data.value; }
  return { ...out, ...obj(i, "flags") };
};
/** The runtime service `secondary_pipeline` (29.2's PipelineService); built over the unit of work when the runtime has not wired it. */
const svcOf = (rt: ToolRuntime, ctx: CommandContext): PipelineService => {
  const s = rt.services.secondary_pipeline; if (s instanceof PipelineService) return s;
  const model = rt.services.pullThroughModel as PullThroughModel | undefined;
  const svc = new PipelineService({ events: ctx.events, clock: ctx.clock, escalations: rt.escalations, ...(model ? { model } : {}) });
  (rt.services as Record<string, unknown>).secondary_pipeline = svc; return svc;
};
const put = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, row: object): void => { rt.store.put(kind, id, { ...row }, ctx.actor, ctx.now); };
const mandatoryOff = (i: ToolInput): boolean => obj(i, "flags")["execution.mandatory_enabled"] === false || obj(i, "flags")["execution.mandatory_enabled"] === "false";
const GUARD_NO_EXECUTION = never("AGENT_NEVER_EXECUTES_TRADE", "29.2 AI design: never place, roll or pair off a dealer trade — the partner's trader executes on the partner's authorization (hedge.auto_execute_within_band=false in v1)", (i) => flag(i, "execute") || flag(i, "place_order") || flag(i, "auto_execute"), "the platform recommends and packages; the partner's trader executes with the broker-dealer");
const GUARD_NO_SM_NETTING = never("NO_SM_NETTING", "29.2 AI design / open question 1: never net SM's economics against the partner's hedge P&L", (i) => flag(i, "net_sm_economics"), "SM's Grander pass-through economics stay outside the partner's hedge P&L");

export const TOOLS_29_2: readonly ToolDef[] = defineTools("29.2", "secondary", [
  // Rules 1, 12, 13: the 07:00 / intraday position over locks, commitments, fundings, deliveries and hedge positions; op=ingest feeds a section event; op=lock registers a lock view; op=price runs the ≥ 12.5 bps intraday watch.
  { name: "takePipelineSnapshot", kind: "write", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      if (i.op === "ingest") { const ev = i.event as Parameters<PipelineService["ingest"]>[0] | undefined; if (!ev || typeof ev.type !== "string") throw new RangeError("event {type, payload, applicationId?} is required"); svc.ingest(ev, flagsOf(i, rt)); return { ingested: ev.type, locks: svc.locks.size }; }
      if (i.op === "lock") { need(i, "lock_id", "application_id", "locked_at", "amount_cents", "note_rate", "lock_base_price", "product_code"); const l = svc.upsertLock({ lock_id: str(i, "lock_id"), application_id: str(i, "application_id"), lineage_id: optStr(i, "lineage_id"), locked_at: str(i, "locked_at"), amount_cents: cents(i.amount_cents), note_rate: str(i, "note_rate"), lock_base_price: str(i, "lock_base_price"), product_code: str(i, "product_code"), expires_on: optDate(i, "expires_on"), ...(optStr(i, "stage") ? { stage: str(i, "stage") as PipelineStage } : {}), ...(optStr(i, "transaction_type") ? { transaction_type: str(i, "transaction_type") as TransactionType } : {}), ...(optStr(i, "ptr") ? { ptr: str(i, "ptr") } : {}), ...(optStr(i, "commitment_id") ? { commitment_id: str(i, "commitment_id"), state: "committed_be" as const, commitment_price: optStr(i, "commitment_price"), commitment_expires_on: optDate(i, "commitment_expires_on") } : {}) }, flagsOf(i, rt)); return l; }
      if (i.op === "price") { return svc.observePrice({ ...(optStr(i, "whole_loan_price") ? { whole_loan_price: str(i, "whole_loan_price") } : {}), ...(optStr(i, "tba_price") ? { tba_price: str(i, "tba_price") } : {}), at: at(i, "at", ctx) }); }
      const snap = svc.takeSnapshot({ at: at(i, "at", ctx), whole_loan_price: optStr(i, "whole_loan_price"), tba_price: optStr(i, "tba_price"), ...(optStr(i, "price_source") ? { price_source: str(i, "price_source") } : {}), intraday: flag(i, "intraday"), ...(optStr(i, "duration") ? { duration: str(i, "duration") } : {}), ...(optStr(i, "duration_factor") ? { duration_factor: str(i, "duration_factor") } : {}), ...(i.rate_move_bps !== undefined ? { rate_move_bps: num(i, "rate_move_bps") } : {}), ...(optCents(i, "extension_carry_accrued_cents") !== undefined ? { extension_carry_accrued_cents: cents(i.extension_carry_accrued_cents) } : {}), flags: flagsOf(i, rt) });
      put(rt, ctx, "pipeline_positions", snap.snapshot_id, snap); return snap; }),
    guardrails: [never("COB_PRICE_NEVER_UNFLAGGED", "29.2 AI design: never mark to a close-of-business PE–WL display price or a stale run without flagging", (i) => flag(i, "close_of_business") && !flag(i, "stale_flagged"), "a close-of-business or stale price is flagged, never used silently")] },
  // Rule 2: per-lock probability (stage × rate move × transaction type) and the expected deliverable; op=table returns the v1 lookup for a stage.
  { name: "estimatePullThrough", kind: "write", handler: compute((i, ctx, rt) => {
      if (i.op === "table" || !optStr(i, "lock_id")) { need(i, "stage"); return pullThroughProbability({ stage: str(i, "stage") as PipelineStage, ...(i.rate_move_bps !== undefined ? { rate_move_bps: num(i, "rate_move_bps") } : {}), ...(optStr(i, "transaction_type") ? { transaction_type: str(i, "transaction_type") as TransactionType } : {}), ...(optStr(i, "base_probability") ? { base_probability: str(i, "base_probability") } : {}), model: (rt.services.pullThroughModel as PullThroughModel | undefined) ?? PULL_THROUGH_MODEL_V1 }); }
      const svc = svcOf(rt, ctx); const e = svc.estimatePullThrough(str(i, "lock_id"), { at: at(i, "at", ctx), ...(i.rate_move_bps !== undefined ? { rate_move_bps: num(i, "rate_move_bps") } : {}) });
      put(rt, ctx, "pull_through_estimates", e.estimate_id, e); return e; }) },
  // Rule 3: `duration_factor = Δprice_whole_loan / Δprice_hedge` from the last 20 business days of paired PE–WL / TBA prices (default 1.00).
  { name: "estimateDurationFactor", kind: "write", handler: compute((i) => estimateDurationFactor(list<{ whole_loan_price: string; hedge_price: string }>(i, "series"), optStr(i, "fallback") ?? "1.0000")) },
  // Rule 3: target face, coverage ratio, band check and the rebalance delta (pure; op=snapshot reads the last position's coverage).
  { name: "computeCoverage", kind: "write", handler: compute((i, ctx, rt) => {
      if (i.op === "snapshot") { const s = svcOf(rt, ctx).lastSnapshot(); return s ? { snapshot_id: s.snapshot_id, coverage_ratio: s.coverage_ratio, within_band: s.within_band, hedge_face_cents: s.hedge_face_cents, expected_deliverable_cents: s.expected_deliverable_cents } : null; }
      need(i, "hedge_face_cents", "duration_factor", "expected_deliverable_cents");
      return computeCoverage({ hedge_face_cents: cents(i.hedge_face_cents), duration_factor: str(i, "duration_factor"), expected_deliverable_cents: cents(i.expected_deliverable_cents), ...(optStr(i, "coverage_band_low") ? { coverage_band_low: str(i, "coverage_band_low") } : {}), ...(optStr(i, "coverage_band_high") ? { coverage_band_high: str(i, "coverage_band_high") } : {}) }); }) },
  // Rule 3: the rebalance recommendation (buy back / sell to the target, dealer lot, pair-off cost estimate) and, in mandatory mode, its officer package.
  { name: "recommendRebalance", kind: "act", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      const r = svc.recommendRebalance({ at: at(i, "at", ctx), ...(optCents(i, "hedge_face_cents") !== undefined ? { hedge_face_cents: cents(i.hedge_face_cents) } : {}), ...(optCents(i, "expected_deliverable_cents") !== undefined ? { expected_deliverable_cents: cents(i.expected_deliverable_cents) } : {}), ...(optStr(i, "duration_factor") ? { duration_factor: str(i, "duration_factor") } : {}), ...(optStr(i, "instrument") ? { instrument: str(i, "instrument") as HedgeInstrument } : {}), ...(optStr(i, "mark_price") ? { mark_price: str(i, "mark_price") } : {}), ...(optStr(i, "trade_price") ? { trade_price: str(i, "trade_price") } : {}), coupon: optStr(i, "coupon"), settlement_month: optDate(i, "settlement_month"), flags: flagsOf(i, rt) });
      if (r.package) put(rt, ctx, "hedge_trade_packages", r.package.package_id, r.package); return r; }),
    guardrails: [GUARD_NO_EXECUTION, GUARD_NO_SM_NETTING] },
  // Rules 3, 4: the one-screen trade package (what, how much, why, policy checks, price expectation, alternatives) opened as an `officer` escalation; op=authorize records the officer's authorization. Flag-gated (T10).
  { name: "prepareTradePackage", kind: "act", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      if (i.op === "authorize") { need(i, "package_id"); const pkg = svc.authorizeTradePackage({ package_id: str(i, "package_id"), at: at(i, "at", ctx), authorized_by: ctx.actor }); put(rt, ctx, "hedge_trade_packages", pkg.package_id, pkg); return pkg; }
      need(i, "side", "instrument", "face_cents");
      const pkg = svc.prepareTradePackage({ side: str(i, "side") as "sell" | "buy", instrument: str(i, "instrument") as HedgeInstrument, face_cents: cents(i.face_cents), coupon: optStr(i, "coupon"), settlement_month: optDate(i, "settlement_month"), price_expectation: optStr(i, "price_expectation"), ...(optStr(i, "rationale") ? { rationale: str(i, "rationale") } : {}), ...(optStr(i, "kind") ? { kind: str(i, "kind") as "open" | "rebalance" | "roll" | "pair_off" } : {}), position_id: optStr(i, "position_id"), expected_delivery_on: optDate(i, "expected_delivery_on"), at: at(i, "at", ctx), flags: flagsOf(i, rt), alternatives: list<{ description: string; cost_cents: unknown }>(i, "alternatives").map((a) => ({ description: String(a.description), cost_cents: cents(a.cost_cents) })) });
      put(rt, ctx, "hedge_trade_packages", pkg.package_id, pkg); return pkg; }),
    guardrails: [never("MANDATORY_DISABLED", "29.2 rule 1 / T10: execution.mandatory_enabled=false → best efforts only; no hedge exists", (i) => i.op !== "authorize" && mandatoryOff(i), "mandatory execution is off for the partner: no trade package"),
      GUARD_NO_EXECUTION, GUARD_NO_SM_NETTING,
      never("INSTRUMENT_OUTSIDE_POLICY", "29.2 AI design: never use an instrument, counterparty or size outside hedge_policies (no options, swaps or specified pools in v1)", (i) => typeof i.instrument === "string" && !["fnma_mandatory_commitment", "tba_umbs_30", "tba_umbs_15"].includes(String(i.instrument)), "instrument must be one of fnma_mandatory_commitment / tba_umbs_30 / tba_umbs_15"),
      needsRole("OFFICER_TRADE_AUTHORIZATION", "29.2 AI design: every trade is authorized by the partner officer/trader — an officer act, never an agent assertion", (i) => i.op === "authorize" || flag(i, "authorized"), ["officer"], "the officer authorizes the package in the escalation")] },
  // State machine: a position transitions only from a confirmation (open / pair_off / roll_close+roll_open / assign_to_commitment) — never on an AI decision, never without the confirmation document (T3).
  { name: "recordTradeConfirmation", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "kind", "face_cents", "price", "executed_by"); const svc = svcOf(rt, ctx);
      const ro = obj(i, "roll_open");
      const r = svc.recordTradeConfirmation({ kind: str(i, "kind") as TradeKind, face_cents: cents(i.face_cents), price: str(i, "price"), executed_at: at(i, "executed_at", ctx), executed_by: str(i, "executed_by"), confirmation_document_id: optStr(i, "confirmation_document_id"), package_id: optStr(i, "package_id"), position_id: optStr(i, "position_id"), ...(optStr(i, "instrument") ? { instrument: str(i, "instrument") as HedgeInstrument } : {}), ...(optStr(i, "side") ? { side: str(i, "side") as "sell" | "buy" } : {}), coupon: optStr(i, "coupon"), settlement_month: optDate(i, "settlement_month"), ...(optStr(i, "counterparty_id") ? { counterparty_id: str(i, "counterparty_id") } : {}), commitment_id: optStr(i, "commitment_id"), authorized_by: optStr(i, "authorized_by"), roll_open: Object.keys(ro).length ? { price: String(ro.price), settlement_month: D(String(ro.settlement_month)), confirmation_document_id: String(ro.confirmation_document_id) } : null });
      put(rt, ctx, "hedge_positions", r.position.position_id, r.position); put(rt, ctx, "hedge_trades", r.trade.trade_id, r.trade); if (r.next_position) put(rt, ctx, "hedge_positions", r.next_position.position_id, r.next_position);
      return r; }),
    guardrails: [never("CONFIRMATION_REQUIRED", "29.2 state machine: a position never transitions on an AI decision alone — recorded by the secondary agent from confirmations", (i) => flag(i, "without_confirmation") || i.confirmation_document_id === null, "no trade is recorded until a confirmation document is attached"), GUARD_NO_EXECUTION] },
  // Rule 9: the roll calendar — `roll_due_on = businessDaysBefore(notification_date, 3, fannie_sifma)`, the back month and the roll/pair-off recommendation; op=dates is the pure SIFMA lookup.
  { name: "scheduleRoll", kind: "write", handler: compute((i, ctx, rt) => {
      if (i.op === "dates" || !optStr(i, "position_id")) { need(i, "settlement_month"); const cls = (optStr(i, "sifma_class") as SifmaClass | null) ?? (optStr(i, "instrument") ? instrumentClass(str(i, "instrument") as HedgeInstrument) : null) ?? "A"; const sd = sifmaDates(D(str(i, "settlement_month")), cls); return { ...sd, ...rollDueOn(sd.notification_date, i.roll_lead_business_days === undefined ? 3 : num(i, "roll_lead_business_days")) }; }
      return svcOf(rt, ctx).scheduleRoll({ position_id: str(i, "position_id"), at: at(i, "at", ctx), covered_delivered_by_notification: flag(i, "covered_delivered_by_notification") }); }),
    guardrails: [never("TBA_INSIDE_ROLL_LEAD", "29.2 AI design: never let a TBA position stand within 3 business days of its notification date (the partner cannot deliver pools)", (i) => flag(i, "hold_past_roll_due"), "the front-month position must be flat by roll_due_on 12:00 p.m. ET"), GUARD_NO_EXECUTION] },
  // Rule 10: the hedge migrates into the actual forward sale — `hedge.commitment.requested` to 29.1 (flag-gated; officer_mandatory_authorization required; T10).
  { name: "requestMandatoryCommitment", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "amount_cents", "product", "ptr_range_low", "ptr_range_high", "period_days"); const svc = svcOf(rt, ctx);
      const authId = optStr(i, "authorization_escalation_id"); const e = authId ? rt.escalations.list().find((x) => x.id === authId) : undefined;
      return svc.requestMandatoryCommitment({ amount_cents: cents(i.amount_cents), product: str(i, "product"), ptr_range: { low: str(i, "ptr_range_low"), high: str(i, "ptr_range_high") }, period_days: num(i, "period_days"), officer_authorization: e ? { escalation_id: e.id, status: e.status === "completed" ? "approved" : "pending" } : null, at: at(i, "at", ctx), flags: flagsOf(i, rt), pair_off_position_id: optStr(i, "pair_off_position_id") }); }),
    guardrails: [never("MANDATORY_DISABLED", "29.2 rule 1 / T10: execution.mandatory_enabled=false → best efforts only", (i) => mandatoryOff(i), "mandatory execution is off for the partner: no mandatory commitment request"),
      needsRole("OFFICER_MANDATORY_AUTHORIZATION", "29.2 AI design: never request a Fannie Mae mandatory commitment without the 29.1 officer authorization — an officer act", (i) => flag(i, "officer_authorized"), ["officer"], "reference the completed officer_mandatory_authorization escalation; an agent cannot assert it"), GUARD_NO_SM_NETTING] },
  // Rules 5, 6: the 17:00 ET mark (IRLC sale-price and servicing components separately, HFS, hedges, net, day change) and the GL export; op=commitment_decision runs the daily pair-off-versus-extension package (T8).
  { name: "runMarkToMarket", kind: "write", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      if (i.op === "commitment_decision") { need(i, "commitment_id", "original_amount_cents", "commitment_price", "live_price", "expires_on", "expected_deliverable_cents", "late_balance_cents", "min_ptr"); return svc.prepareCommitmentDecision({ commitment_id: str(i, "commitment_id"), original_amount_cents: cents(i.original_amount_cents), commitment_price: str(i, "commitment_price"), live_price: str(i, "live_price"), expires_on: D(str(i, "expires_on")), expected_deliverable_cents: cents(i.expected_deliverable_cents), late_balance_cents: cents(i.late_balance_cents), late_loan_stages: list<PipelineStage>(i, "late_loan_stages"), extension_days: i.extension_days === undefined ? 10 : num(i, "extension_days"), min_ptr: str(i, "min_ptr"), as_of: at(i, "at", ctx), flags: flagsOf(i, rt) }); }
      need(i, "whole_loan_price", "whole_loan_price_id");
      const run = svc.runMarkToMarket({ at: at(i, "at", ctx), snapshot_id: optStr(i, "snapshot_id"), whole_loan_price: str(i, "whole_loan_price"), whole_loan_price_id: str(i, "whole_loan_price_id"), tba_price: optStr(i, "tba_price"), tba_price_id: optStr(i, "tba_price_id"), close_of_business: flag(i, "close_of_business"), stale: list<string>(i, "stale"), hfs_net_price_market: optStr(i, "hfs_net_price_market"), ...(optStr(i, "election") ? { election: str(i, "election") as "fvo" | "locom" } : {}), ...(optCents(i, "realized_pl_mtd_cents") !== undefined ? { realized_pl_mtd_cents: cents(i.realized_pl_mtd_cents) } : {}), ...(i.probabilities ? { probabilities: obj(i, "probabilities") as Record<string, string> } : {}) });
      put(rt, ctx, "mark_to_market_runs", run.run_id, run); return run; }),
    guardrails: [never("COB_PRICE_NEVER_UNFLAGGED", "29.2 AI design: never mark to a close-of-business PE–WL display price or a stale run without flagging", (i) => flag(i, "close_of_business") && !list<string>(i, "stale").length && !flag(i, "stale_flagged"), "a close-of-business or stale price is flagged on the run, never used silently"), GUARD_NO_SM_NETTING] },
  // Rule 7: the ±100/50/25 bp table (pipeline, hedge, net, coverage, projected margin call and pair-off cost) compared with the policy's rate_shock_limit_cents (T7).
  { name: "runRateShock", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "covered_amount_cents", "expected_deliverable_cents", "p_base", "hedge_face_cents", "hedge_trade_price", "hedge_mark_price");
      const limits = obj(i, "rate_shock_limit_cents"); const lim: Record<string, bigint> = {}; for (const [k, v] of Object.entries(limits)) lim[k] = cents(v);
      const r = svcOf(rt, ctx).runRateShock({ at: at(i, "at", ctx), covered_amount_cents: cents(i.covered_amount_cents), expected_deliverable_cents: cents(i.expected_deliverable_cents), p_base: str(i, "p_base"), hedge_face_cents: cents(i.hedge_face_cents), hedge_trade_price: str(i, "hedge_trade_price"), hedge_mark_price: str(i, "hedge_mark_price"), ...(optStr(i, "duration") ? { duration: str(i, "duration") } : {}), ...(optStr(i, "duration_factor") ? { duration_factor: str(i, "duration_factor") } : {}), ...(optCents(i, "margin_posted_cents") !== undefined ? { margin_posted_cents: cents(i.margin_posted_cents) } : {}), ...(Object.keys(lim).length ? { rate_shock_limit_cents: lim } : {}), ...(optStr(i, "transaction_type") ? { transaction_type: str(i, "transaction_type") as TransactionType } : {}) });
      put(rt, ctx, "rate_shock_reports", r.report_id, r); return r; }) },
  // Rule 8: margin (−100 bp) + pair-off fees due within 5 days + extension carry + warehouse curtailments (27.1) + the FHFA origination-liquidity requirement, against the partner's reserve.
  { name: "computeLiquidityNeed", kind: "write", handler: compute((i, ctx, rt) => svcOf(rt, ctx).computeLiquidityNeed({ at: at(i, "at", ctx), projected_margin_calls_cents: cents(i.projected_margin_calls_cents), pair_off_fees_due_5d_cents: cents(i.pair_off_fees_due_5d_cents), extension_carry_accrued_cents: cents(i.extension_carry_accrued_cents), warehouse_curtailments_due_cents: cents(i.warehouse_curtailments_due_cents), ...(optCents(i, "annual_origination_cents") !== undefined ? { annual_origination_cents: cents(i.annual_origination_cents) } : {}), ...(optCents(i, "fhfa_origination_liquidity_cents") !== undefined ? { fhfa_origination_liquidity_cents: cents(i.fhfa_origination_liquidity_cents) } : {}), ...(optCents(i, "reserve_cents") !== undefined ? { reserve_cents: cents(i.reserve_cents) } : {}), earliest_due_on: optDate(i, "earliest_due_on") })) },
  // FINRA 4210: the dealer's call (due close of business the next business day) and op=fund for the wire under `funding_approver` dual control (T6); op=dispute for marks outside the tolerance.
  { name: "recordMarginCall", kind: "write", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      if (i.op === "fund") { need(i, "call_id", "wire_id"); const c = svc.fundMarginCall({ call_id: str(i, "call_id"), wire_id: str(i, "wire_id"), released_at: at(i, "released_at", ctx), approvals: list<WireApproval>(i, "approvals") }); put(rt, ctx, "margin_calls", c.call_id, c); return c; }
      if (i.op === "dispute") { need(i, "call_id", "reason"); const c = svc.disputeMarginCall({ call_id: str(i, "call_id"), reason: str(i, "reason") }); put(rt, ctx, "margin_calls", c.call_id, c); return c; }
      need(i, "counterparty_id", "amount_cents");
      const c = svc.recordMarginCall({ counterparty_id: str(i, "counterparty_id"), received_at: at(i, "received_at", ctx), amount_cents: cents(i.amount_cents), basis: obj(i, "basis"), due_hhmm: optStr(i, "due_hhmm") });
      put(rt, ctx, "margin_calls", c.call_id, c); return c; }),
    guardrails: [needsRole("MARGIN_WIRE_DUAL_CONTROL", "29.2 state machine: a margin call is funded by a wire released under 26.3's dual control — the funding_approver role is reused for margin wires", (i) => i.op === "fund" && flag(i, "release_wire"), ["funding_approver"], "the wire release is the funding approver's act")] },
  // Rule 2 (monthly): realized versus predicted pull-through by cohort, fallout reasons to 21.4, the ±10-point recalibration proposal (officer + 31.2) and the conservative band edge (T9).
  { name: "analyzeFallout", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "cohort", "locks", "fallouts", "predicted_pct"); const svc = svcOf(rt, ctx);
      const r = svc.analyzeFallout({ cohort: str(i, "cohort"), locks: num(i, "locks"), fallouts: num(i, "fallouts"), predicted_pct: str(i, "predicted_pct"), reasons: list<{ reason: FalloutReasonCode; count: unknown; note?: string }>(i, "reasons").map((x): FalloutReason => ({ reason: x.reason, count: Number(x.count), ...(x.note ? { note: x.note } : {}) })), ...(optDate(i, "review_on") ? { review_on: D(str(i, "review_on")) } : {}), at: at(i, "at", ctx) });
      put(rt, ctx, "fallout_reviews", r.report_id, r); return r; }) },
  // Rule 14: a new pull_through_models version — officer approval and the 31.2 review are prerequisites (LL-2026-04); the agent proposes, never approves.
  { name: "recalibratePullThrough", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "version"); const svc = svcOf(rt, ctx);
      const m = svc.recalibratePullThrough({ version: str(i, "version"), ...(optStr(i, "method") ? { method: str(i, "method") as PullThroughMethod } : {}), ...(i.parameters ? { parameters: obj(i, "parameters") as PullThroughModel["parameters"] } : {}), validation_document_id: optStr(i, "validation_document_id"), approved_by: flag(i, "officer_approved") ? ctx.actor : null, o12_2_review_id: optStr(i, "o12_2_review_id"), ...(optDate(i, "effective_from") ? { effective_from: D(str(i, "effective_from")) } : {}), at: at(i, "at", ctx) });
      put(rt, ctx, "pull_through_models", m.model_id, m); return m; }),
    guardrails: [needsRole("MODEL_OFFICER_APPROVAL", "29.2 AI design: never change the pull-through model version without officer and 31.2 approval", (i) => flag(i, "officer_approved"), ["officer"], "the officer approves the model version; the agent proposes"),
      never("MODEL_O12_2_REVIEW", "29.2 rule 14: a change in method (lookup → logistic/ML) needs officer approval and an 31.2 review before use", (i) => typeof i.version === "string" && !optStr(i, "o12_2_review_id"), "the 31.2 model-inventory review id is required")] },
  // Rule 13: every partner report is a `documents` row with the snapshot ids it was built from (daily position pack, rate-shock table, liquidity stress, fallout review, hedge effectiveness, policy compliance / review); op=policy adopts a hedge_policies version (arms the program's clocks).
  { name: "publishPartnerReport", kind: "write", handler: compute((i, ctx, rt) => {
      const svc = svcOf(rt, ctx);
      if (i.op === "policy") { need(i, "effective_from"); const raw = obj(i, "policy"); const pol = svc.adoptPolicy({ ...(raw as PolicyInput), effective_from: D(str(i, "effective_from")), at: at(i, "at", ctx), approved_by: optStr(i, "approved_by") }); put(rt, ctx, "hedge_policies", pol.policy_id, pol); return pol; }
      if (i.op === "eligibility") { need(i, "product_code"); return svc.eligibility({ product_code: str(i, "product_code"), amortization: optStr(i, "amortization") ?? "fixed" }, at(i, "at", ctx), flagsOf(i, rt)); }
      need(i, "kind");
      const r = svc.publishPartnerReport({ kind: str(i, "kind") as Parameters<PipelineService["publishPartnerReport"]>[0]["kind"], at: at(i, "at", ctx), ...(i.body ? { body: obj(i, "body") } : {}), ...(Array.isArray(i.snapshot_ids) ? { snapshot_ids: list<string>(i, "snapshot_ids") } : {}) });
      put(rt, ctx, "documents", r.document_id, { kind: `partner_report:${r.kind}`, report_id: r.report_id, snapshot_ids: r.snapshot_ids, published_at: r.published_at }); return r; }),
    guardrails: [needsRole("POLICY_OFFICER_APPROVAL", "29.2 operational prerequisites: the hedging policy is approved by the partner's board/officer", (i) => i.op === "policy", ["officer"], "adopting a hedge_policies version is the officer's act"), GUARD_NO_SM_NETTING] },
  // Escalations: partner `officer`/trader (every trade package; coverage outside band; margin calls; liquidity shortfall; model changes; policy breaches), `fnma_portal_operator` (29.1), `funding_approver` (margin wires), compliance-sentinel, qc-audit. No borrower contact.
  { name: "openEscalation", kind: "act", handler: escalate("officer") },
  { name: "writeDecision", kind: "write", handler: decision() },
]);
