/**
 * §18.7 tools — the financial-eligibility module of `qc-audit`: the GL and UPB intake (`gl_snapshot.intake`,
 * `upb_position.finalize`), the period cycle (`eligibility.period.close` — the schedules `eligibility.compute.monthly`,
 * `filing.form1002.cycle`, `filing.form1002a.cycle`, `capliq.plan.cycle`), the config-driven calculator
 * (`eligibility.compute`), the officer certification (`eligibility.certify`), the status-ladder acts
 * (`eligibility.breach.notify`, `remediation_plan.approve`), the filings (`form1002.submit`, `form1002a.submit`,
 * `capliq_plan.submit`), the large seller/servicer material-change notice (`material_change.detect`,
 * `material_change.notify`), the monthly partner UPB report (`partner_upb_report.deliver`), the CSBS applicability record
 * (`csbs.applicability.record`), the one-loan rule (`service_one_loan.test`), the spec's `escalations.create` and
 * `human_portal_task.create` (WebMB is portal-only), and the read tools over the 18.7 tables.
 *
 * Every state-changing act appends the event the §18.7 timer table names to the unit of work's event store, on the
 * aggregate `eligibility_entity:<entity>`: the period events arm the period rows (FHFA_ELIG_QUARTERLY_TEST,
 * FNMA_A4102_FORM1002_Q_30 / _YE_60 / 1002A_M_30, FNMA_A4101_LARGE_CAPLIQ_PLAN_90, SM_PARTNER_UPB_REPORT_MONTHLY_BD5,
 * CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q, FNMA_A4101_SERVICE_ONE_LOAN_DEC31); `eligibility.compute` appends the warning /
 * breach detections that arm SM_ELIG_WARNING_REMEDIATION_30 and SM_ELIG_BREACH_NOTIFY_1BD (and, for a large servicer, the
 * `material_change.detected` that arms FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD); the certification, filings, notices, plan
 * approval and reports append the events that satisfy them. The pure rules live in src/domain/qc-audit/ops-18-7.ts.
 *
 * Guardrails encode the spec's sentences: the agent never adjusts GL balances (NEVER_ADJUST_GL); every input is a hashed
 * source document (UNHASHED_SOURCE); an asset is "unrestricted cash" / an "eligible security" only with a source
 * (classifyLiquidity excludes the rest); certifications are CEO/CFO acts (`eligibility.certify` is officer-only and
 * `officerCertify` refuses any other role); the remediation plan is the board's approval; a filing is `submitted` only with
 * the WebMB confirmation (and, for Form 1002, the CEO/CFO certification record) — 18.7-T8.
 *
 * `TOOLS_18_7` — the slice spread onto the bus by ./section18.ts — is the subset whose names spec/registry/agents.json lists
 * for 18.7 (src/app/tools.test.ts refuses any other name on the bus); the extractor reads no tool names from the 18.7
 * "Tools:" paragraph (prose: GL/UPB queries, calculator, document renderer, `escalations.create`, `human_portal_task.create`),
 * so the full surface is exported as `ELIGIBILITY_TOOLS_18_7` and bound by 18-7.spec.test.ts exactly as ./index.ts would bind
 * it once the registry names them.
 */
import { defineTools, escalate, compute, read, never, str, flag, cents, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { loadAgentsFile } from "../agents.ts";
import type { EscalationKind } from "../escalations.ts";
import type { QcEscalation } from "../../domain/qc-audit/ops.ts";
import { plainDate as D, addMonths, endOfMonth, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { NetWorthInput } from "../../domain/qc-audit/networth.ts";
import {
  glSnapshotIntake, glCloseCompletedEvent, classifyLiquidity, upbPositionFinalizedEvent, periodCloseEvents, staleGlRun, quarterlyTest, isQuarterEnd, quarterOf,
  officerCertify, breachNotified, remediationPlanApproval, form1002Submit, form1002aSubmit, capliqPlanSubmit, materialChangeDetected, materialChangeNotified,
  partnerUpbReportDelivered, csbsPrudentialApplicability, serviceOneLoanTest, UPB_CLASSES,
  type Entity, type SourceDocument, type SourcedAmount, type SecurityHolding, type AdvanceLine, type UpbPositionRow, type UpbClass, type CapLiqPlan,
} from "../../domain/qc-audit/ops-18-7.ts";

const AGENT = "qc-audit";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const list = <T,>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const today = (i: ToolInput, k: string, now: string): PlainDate => optDate(i, k) ?? D(now.slice(0, 10));
const entityOf = (i: ToolInput): Entity => { const e = str(i, "entity") || "supermortgage"; if (e !== "supermortgage" && e !== "partner") throw new RangeError(`entity ${e} is supermortgage or partner`); return e; };
const aggregate = (entity: Entity): { kind: "eligibility_entity"; id: Entity } => ({ kind: "eligibility_entity", id: entity });
const resultId = (entity: Entity, period_end: PlainDate): string => `${entity}:${period_end}`;
/** ops-18-7 escalation kinds on the EscalationService: `fnma_portal_operator` is the owner role of a `human_portal_task` (WebMB). */
const escKind = (k: QcEscalation["kind"]): EscalationKind => (k === "fnma_portal_operator" ? "human_portal_task" : k);

interface StoredGl { entity: Entity; period_end: PlainDate; received_on: PlainDate; total_equity_cents: Cents; goodwill_intangibles_cents: Cents; affiliate_receivables_cents: Cents; pledged_assets_net_cents: Cents; total_assets_cents: Cents; cash_unrestricted_cents: Cents; eligible_securities_cents: Cents; advance_line_committed_cents: Cents; advance_line_drawn_cents: Cents; hfs_and_irlc_cents: Cents; quarterly_originations_over_1b: boolean; net_income_qtd_cents: Cents | null; }
interface StoredResult { entity: Entity; period_end: PlainDate; anw_cents: Cents; status: string; stale: boolean; large_servicer: boolean; state: string; certified_by_officer_id: string | null; net_loss_quarter?: boolean; consecutive_loss_quarters?: number; warning_detected_on?: PlainDate | null; breach_detected_on?: PlainDate | null; breach_trigger?: string | null; }

/** The latest stored `eligibility_results` row for an entity at or before a date (the large-servicer flag, prior ANW). */
function latestResult(rt: ToolRuntime, entity: Entity, onOrBefore: PlainDate | null = null): StoredResult | null {
  const rows = rt.store.list("eligibility_results", (d) => d.entity === entity && (onOrBefore === null || String(d.period_end) <= onOrBefore)).map((r) => r.data as unknown as StoredResult);
  return rows.sort((a, b) => (a.period_end < b.period_end ? 1 : a.period_end > b.period_end ? -1 : 0))[0] ?? null;
}
const isLarge = (i: ToolInput, rt: ToolRuntime, entity: Entity): boolean => (i.large_servicer === undefined ? latestResult(rt, entity)?.large_servicer === true : flag(i, "large_servicer"));
/** The stored quarter-end result `n` quarters before a period end (rule 6 look-backs). */
const quartersBack = (rt: ToolRuntime, entity: Entity, period_end: PlainDate, n: number): StoredResult | null => { const pe = endOfMonth(addMonths(period_end, -3 * n)); return (rt.store.get("eligibility_results", resultId(entity, pe))?.data as unknown as StoredResult | undefined) ?? null; };
const upbRows = (rt: ToolRuntime, entity: Entity, period_end: PlainDate): UpbPositionRow[] => rt.store.list("upb_positions", (d) => d.entity === entity && d.period_end === period_end).map((r) => ({ class: r.data.class as UpbClass, upb_cents: cents(r.data.upb_cents), loan_count: Number(r.data.loan_count ?? 0) }));
const upbOf = (rows: readonly UpbPositionRow[], cls: UpbClass): Cents => rows.filter((r) => r.class === cls).reduce((a, r) => a + r.upb_cents, 0n);

/** The calculator input from the stores (GL snapshot + UPB position) or from an inline `inputs` object. */
function netWorthInputFor(i: ToolInput, rt: ToolRuntime, entity: Entity, period_end: PlainDate, gl: StoredGl | null): NetWorthInput {
  const inline = i.inputs as Record<string, unknown> | undefined;
  const prior = (k: "prior_anw" | "two_quarters_back_anw" | "four_quarters_back_anw", n: number): Cents | null => (inline?.[k] !== undefined ? cents(inline[k]) : i[k] !== undefined ? cents(i[k]) : quartersBack(rt, entity, period_end, n)?.anw_cents ?? null);
  const lossQuarters = inline?.consecutive_loss_quarters !== undefined ? Number(inline.consecutive_loss_quarters) : i.consecutive_loss_quarters !== undefined ? Number(i.consecutive_loss_quarters) : (quartersBack(rt, entity, period_end, 1)?.consecutive_loss_quarters ?? 0) + (gl?.net_income_qtd_cents !== null && gl?.net_income_qtd_cents !== undefined && gl.net_income_qtd_cents < 0n ? 1 : 0);
  const look = { prior_anw: prior("prior_anw", 1), two_quarters_back_anw: prior("two_quarters_back_anw", 2), four_quarters_back_anw: prior("four_quarters_back_anw", 4), consecutive_loss_quarters: lossQuarters };
  if (inline) {
    const c = (k: string): Cents => cents(inline[k]);
    return { total_equity: c("total_equity"), goodwill_intangibles: c("goodwill_intangibles"), affiliate_receivables: c("affiliate_receivables"), pledged_assets_net: c("pledged_assets_net"), total_assets: c("total_assets"),
      ent_ss_sa_upb: c("ent_ss_sa_upb"), ent_aa_upb: c("ent_aa_upb"), gnma_upb: c("gnma_upb"), other_upb: c("other_upb"),
      cash_unrestricted: c("cash_unrestricted"), eligible_securities: c("eligible_securities"), advance_line_committed: c("advance_line_committed"), advance_line_drawn: c("advance_line_drawn"),
      hfs_and_irlc: c("hfs_and_irlc"), quarterly_originations_over_1b: inline.quarterly_originations_over_1b === true, ...look };
  }
  if (!gl) throw new RangeError(`no gl_snapshots row for ${entity} at or before ${period_end} — gl_snapshot.intake first (or pass inputs)`);
  const upb = upbRows(rt, entity, period_end);
  if (upb.length === 0) throw new RangeError(`no upb_positions rows for ${entity} ${period_end} — upb_position.finalize first (or pass inputs)`);
  return { total_equity: gl.total_equity_cents, goodwill_intangibles: gl.goodwill_intangibles_cents, affiliate_receivables: gl.affiliate_receivables_cents, pledged_assets_net: gl.pledged_assets_net_cents, total_assets: gl.total_assets_cents,
    // UPB definitions exclude loans "serviced by a seller/servicer under a subservicing arrangement": `subserviced_for_others` never enters the subservicer's requirement.
    ent_ss_sa_upb: upbOf(upb, "ent_ss_sa"), ent_aa_upb: upbOf(upb, "ent_aa"), gnma_upb: upbOf(upb, "gnma"), other_upb: upbOf(upb, "other"),
    cash_unrestricted: gl.cash_unrestricted_cents, eligible_securities: gl.eligible_securities_cents, advance_line_committed: gl.advance_line_committed_cents, advance_line_drawn: gl.advance_line_drawn_cents,
    hfs_and_irlc: upbOf(upb, "hfs_and_irlc"), quarterly_originations_over_1b: gl.quarterly_originations_over_1b, ...look };
}
/** The GL close the run computes on: the entity's snapshot for the period, else the latest earlier one (flagged stale by staleGlRun). */
function glCloseFor(rt: ToolRuntime, entity: Entity, period_end: PlainDate): StoredGl | null {
  const rows = rt.store.list("gl_snapshots", (d) => d.entity === entity && String(d.period_end) <= period_end).map((r) => r.data as unknown as StoredGl);
  return rows.sort((a, b) => (a.period_end < b.period_end ? 1 : a.period_end > b.period_end ? -1 : 0))[0] ?? null;
}
/** Rule 5 buffer (large only): `amount × bps / 10_000`, round-half-up at the component (2 bps Enterprise / 5 bps Ginnie Mae). */
const bps = (amount: Cents, rate: bigint): Cents => { const n = amount * rate; const q = n / 10_000n; return (n % 10_000n) * 2n >= 10_000n ? q + 1n : q; };

/** The whole 18.7 tool surface (see the header for why the bus slice below may be narrower). */
export const ELIGIBILITY_TOOLS_18_7: readonly ToolDef[] = defineTools("18.7", AGENT, [
  // ---- GL and UPB intake (integrations: `gl` adapter, Section 5 position feed) --------------------------------------
  { name: "gl_snapshot.intake", kind: "write", guardrails: [
      never("NEVER_ADJUST_GL", "§18.7 guardrails: the agent never adjusts GL balances", (i) => list(i, "adjustments").length > 0, "the agent never adjusts GL balances — GL-side entries live in the accounting system"),
      never("UNHASHED_SOURCE", "§18.7 guardrails: every input is a hashed source document", (i) => list<SourceDocument>(i, "source_documents").length === 0 || list<SourceDocument>(i, "source_documents").some((d) => !d || !d.sha256), "every input is a hashed source document (trial balance, custodial statements, facility agreements)"),
    ], handler: compute((i, ctx, rt) => {
    need(i, "period_end", "total_equity_cents", "total_assets_cents");
    const entity = entityOf(i); const period_end = date(i, "period_end");
    const intake = glSnapshotIntake({ entity, period_end, source_documents: list<SourceDocument>(i, "source_documents"), adjustments: list(i, "adjustments") });
    if (!intake.accepted) return { accepted: false, refusal_code: intake.refusal_code, refusal: intake.refusal };
    // Liquidity classification needs a source per item or the item is excluded (guardrail); pre-classified cents are accepted as the accounting system's mapped balances.
    const items = { cash: list<SourcedAmount>(i, "cash").map((c) => ({ ...c, cents: cents(c.cents) })), securities: list<SecurityHolding>(i, "securities").map((s) => ({ ...s, cents: cents(s.cents) })), advance_lines: list<AdvanceLine>(i, "advance_lines").map((l) => ({ ...l, committed: cents(l.committed), drawn: cents(l.drawn) })) };
    const classified = items.cash.length || items.securities.length || items.advance_lines.length ? classifyLiquidity(items) : null;
    const received_on = today(i, "received_on", ctx.now);
    const snap: StoredGl = {
      entity, period_end, received_on, total_equity_cents: cents(i.total_equity_cents), goodwill_intangibles_cents: cents(i.goodwill_intangibles_cents), affiliate_receivables_cents: cents(i.affiliate_receivables_cents), pledged_assets_net_cents: cents(i.pledged_assets_net_cents), total_assets_cents: cents(i.total_assets_cents),
      cash_unrestricted_cents: classified ? classified.cash_unrestricted : cents(i.cash_unrestricted_cents), eligible_securities_cents: classified ? classified.eligible_securities : cents(i.eligible_securities_cents),
      advance_line_committed_cents: classified ? classified.advance_line_committed : cents(i.advance_line_committed_cents), advance_line_drawn_cents: classified ? classified.advance_line_drawn : cents(i.advance_line_drawn_cents),
      hfs_and_irlc_cents: cents(i.hfs_and_irlc_cents), quarterly_originations_over_1b: flag(i, "quarterly_originations_over_1b"), net_income_qtd_cents: i.net_income_qtd_cents === undefined || i.net_income_qtd_cents === null ? null : cents(i.net_income_qtd_cents),
    };
    rt.store.put("gl_snapshots", resultId(entity, period_end), { ...snap, source_document_ids: [...intake.source_document_ids], inputs_hash: intake.inputs_hash, excluded_liquidity: classified?.excluded ?? [], certified_by: str(i, "certified_by") || null }, ctx.actor, ctx.now);
    const ev = glCloseCompletedEvent({ entity, period_end, received_on, intake })!;
    ctx.events.append({ type: ev.type, aggregate: aggregate(entity), actor: ctx.actor, payload: ev.payload });
    return { accepted: true, inputs_hash: intake.inputs_hash, source_document_ids: intake.source_document_ids, snapshot: snap, excluded_liquidity: classified?.excluded ?? [] };
  }) },
  { name: "upb_position.finalize", kind: "write", handler: compute((i, ctx, rt) => {
    need(i, "period_end");
    const entity = entityOf(i); const period_end = date(i, "period_end");
    const positions: UpbPositionRow[] = list<{ class: UpbClass; upb_cents: unknown; loan_count?: unknown }>(i, "positions").map((p) => ({ class: p.class, upb_cents: cents(p.upb_cents), loan_count: Number(p.loan_count ?? 0) }));
    const ev = upbPositionFinalizedEvent({ entity, period_end, positions, source: str(i, "source") || "section5_position" });
    for (const p of positions) rt.store.put("upb_positions", `${entity}:${period_end}:${p.class}`, { entity, period_end, class: p.class, upb_cents: p.upb_cents, loan_count: p.loan_count, source: str(i, "source") || "section5_position" }, ctx.actor, ctx.now);
    ctx.events.append({ type: ev.type, aggregate: aggregate(entity), actor: ctx.actor, payload: ev.payload });
    return { rows: positions.length, master_serviced_upb_cents: ev.payload.master_serviced_upb_cents, classes: UPB_CLASSES.filter((c) => positions.some((p) => p.class === c)) };
  }) },
  // ---- the period cycle (schedules) ----------------------------------------------------------------------------------
  { name: "eligibility.period.close", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "period_end");
    const entity = entityOf(i); const period_end = date(i, "period_end");
    const close = periodCloseEvents({ entity, period_end, large_servicer: isLarge(i, rt, entity) });
    const ids = close.events.map((e) => ctx.events.append({ type: e.type, aggregate: aggregate(entity), actor: ctx.actor, payload: e.payload }).id);
    rt.store.put("eligibility_cycles", resultId(entity, period_end), { entity, period_end, quarter: close.quarter, quarter_month: close.quarter_month, quarter_end: close.quarter_end, year_end: close.year_end, large_servicer: close.large_servicer, state: close.quarter_end ? "gl_received_pending" : "monthly", clocks: close.clocks, period_event_ids: ids }, ctx.actor, ctx.now);
    return { entity, period_end, quarter: close.quarter, quarter_month: close.quarter_month, quarter_end: close.quarter_end, year_end: close.year_end, large_servicer: close.large_servicer, events: close.events.map((e) => e.type), clocks: close.clocks };
  }) },
  // ---- the calculator and the status ladder ----------------------------------------------------------------------------
  { name: "eligibility.compute", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "period_end");
    const entity = entityOf(i); const period_end = date(i, "period_end"); const computed_on = today(i, "computed_on", ctx.now);
    const gl = glCloseFor(rt, entity, period_end);
    const run = staleGlRun({ period_end, gl_close: gl ? { period_end: gl.period_end, received_on: gl.received_on } : null, run_on: computed_on });
    const input = netWorthInputFor(i, rt, entity, period_end, gl);
    const q = quarterlyTest({ ...input, period_end, computed_on });
    const r = q.result;
    const prev = rt.store.get("eligibility_results", resultId(entity, period_end))?.data;
    const stored: Record<string, unknown> = {
      entity, period_end, config_version: str(i, "config_version") || "2026.1", inputs_hash: (rt.store.get("gl_snapshots", resultId(entity, period_end))?.data.inputs_hash as string | undefined) ?? null,
      anw_cents: r.anw, required_nw_cents: r.req_nw, nw_surplus_cents: r.nw_surplus, ratio_bps: r.ratio_bps, allowable_liquidity_cents: r.allowable_liquidity, required_liquidity_cents: r.required_liquidity, liquidity_surplus_cents: r.liquidity_surplus,
      large_servicer: r.large, buffer_required_cents: r.large ? bps(input.ent_ss_sa_upb + input.ent_aa_upb, 2n) + bps(input.gnma_upb, 5n) : 0n,
      decline_flags: r.decline_flags, status: r.status, reason: r.reason, stale: run.stale, computed_on: { ...run.computed_on }, computed_at: ctx.now, quarter_end: q.certification_required,
      state: run.stale ? "computed" : q.certification_required ? "computed" : "reported_to_partner", certified_by_officer_id: null, consecutive_loss_quarters: input.consecutive_loss_quarters ?? 0,
      warning_detected_on: q.outcome?.status === "warning" ? computed_on : (prev?.warning_detected_on ?? null), breach_detected_on: q.outcome?.status === "breach" ? computed_on : (prev?.breach_detected_on ?? null), breach_trigger: q.outcome?.status === "breach" ? r.reason : (prev?.breach_trigger ?? null),
    };
    rt.store.put("eligibility_results", resultId(entity, period_end), stored, ctx.actor, ctx.now);
    // `eligibility.computed` without a certification: FHFA_ELIG_QUARTERLY_TEST is satisfied only by the officer-certified one (`eligibility.certify`).
    ctx.events.append({ type: "eligibility.computed", aggregate: aggregate(entity), actor: ctx.actor, payload: { entity, period_end, quarter: q.certification_required ? quarterOf(period_end) : null, status: r.status, reason: r.reason, stale: run.stale, certified_by_officer_id: null, anw_cents: r.anw, nw_surplus_cents: r.nw_surplus, liquidity_surplus_cents: r.liquidity_surplus, large_servicer: r.large, decline_flags: r.decline_flags, config_version: stored.config_version } });
    const escalations: string[] = [];
    let material_change: string | null = null;
    if (q.outcome?.status === "warning") {
      ctx.events.append({ type: q.outcome.event.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...q.outcome.event.payload, entity, period_end } });
      for (const e of q.outcome.escalations) escalations.push(rt.escalations.open({ kind: escKind(e.kind), ...(e.severity ? { severity: e.severity } : {}), payload: { reason: e.reason, due: e.due ?? null, entity, period_end, timer: q.outcome.timer.code } }, ctx.actor).id);
    } else if (q.outcome?.status === "breach") {
      ctx.events.append({ type: q.outcome.event.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...q.outcome.event.payload, entity, period_end, notices: q.outcome.notices, fnma_handoff: q.outcome.fnma_handoff } });
      for (const e of q.outcome.escalations) escalations.push(rt.escalations.open({ kind: escKind(e.kind), ...(e.severity ? { severity: e.severity } : {}), payload: { reason: e.reason, due: e.due ?? null, entity, period_end, timer: q.outcome.timer.code, fnma_handoff: q.outcome.fnma_handoff } }, ctx.actor).id);
      // A decline trigger is a material change to a large seller/servicer's capital and liquidity plan inputs (A4-1-01: 5 BD, 1 BD during stress).
      if (r.large && /^decline_flags/.test(r.reason ?? "")) {
        const mc = materialChangeDetected({ detected_on: computed_on, large: true, stress: flag(i, "stress"), decline_trigger: r.reason, source: "eligibility.compute", description: `decline trigger ${r.reason} at ${period_end}` });
        material_change = ctx.events.append({ type: mc.event.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...mc.event.payload, entity, period_end } }).id;
        for (const e of mc.notice.escalations) escalations.push(rt.escalations.open({ kind: escKind(e.kind), ...(e.severity ? { severity: e.severity } : {}), payload: { reason: e.reason, due: e.due ?? null, entity, period_end, timer: mc.notice.timer.code } }, ctx.actor).id);
      }
    }
    return { entity, period_end, result: { anw: r.anw, req_nw: r.req_nw, nw_surplus: r.nw_surplus, ratio_bps: r.ratio_bps, allowable_liquidity: r.allowable_liquidity, required_liquidity: r.required_liquidity, liquidity_surplus: r.liquidity_surplus, large: r.large, decline_flags: r.decline_flags, status: r.status, reason: r.reason },
      stale: run.stale, flags: run.flags, computed_on: run.computed_on, certification_allowed: run.certification_allowed, refusal: run.refusal, next_state: run.next_state, awaiting: run.awaiting, quarter_end: q.certification_required,
      outcome: q.outcome ? { status: q.outcome.status, timer: q.outcome.timer, escalations: q.outcome.escalations } : null, escalation_ids: escalations, material_change_event_id: material_change };
  }) },
  { name: "eligibility.certify", kind: "act", humanOnly: true, humanRoles: ["officer"], handler: compute((i, ctx, rt) => {
    need(i, "period_end");
    const entity = entityOf(i); const period_end = date(i, "period_end");
    const stored = rt.store.get("eligibility_results", resultId(entity, period_end))?.data as unknown as StoredResult | undefined;
    if (!stored) throw new RangeError(`no eligibility_results row for ${entity} ${period_end} — eligibility.compute first`);
    const cert = officerCertify({ entity, period_end, status: stored.status as "compliant" | "warning" | "breach", stale: stored.stale, certified_by: { role: ctx.actor.role ?? ctx.actor.kind, id: ctx.actor.id }, certified_on: today(i, "certified_on", ctx.now), config_version: str(i, "config_version") || "2026.1" });
    if (!cert.allowed) return { allowed: false, refusal: cert.refusal, state: cert.state, timer: cert.timer };
    rt.store.put("eligibility_results", resultId(entity, period_end), { state: "officer_certified", certified_by_officer_id: cert.certified_by_officer_id, certified_on: cert.event!.payload.certified_on, certification_document_id: str(i, "certification_document_id") || null, certification_template: "ELIG-CERT-Q-v1" }, ctx.actor, ctx.now);
    const e = ctx.events.append({ type: cert.event!.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...cert.event!.payload, certification_template: "ELIG-CERT-Q-v1", certification_document_id: str(i, "certification_document_id") || null } });
    return { allowed: true, state: cert.state, certified_by_officer_id: cert.certified_by_officer_id, timer: cert.timer, event_id: e.id };
  }) },
  { name: "eligibility.breach.notify", kind: "act", handler: compute((i, ctx, rt) => {
    const entity = entityOf(i);
    const stored = optDate(i, "period_end") ? (rt.store.get("eligibility_results", resultId(entity, date(i, "period_end")))?.data as unknown as StoredResult | undefined) : latestResult(rt, entity);
    const detected_on = optDate(i, "detected_on") ?? stored?.breach_detected_on ?? null;
    if (!detected_on) throw new RangeError("detected_on is required (no breach detection on file for the entity)");
    const n = breachNotified({ detected_on, partner_notified_on: optDate(i, "partner_notified_on"), officer_notified_on: optDate(i, "officer_notified_on") });
    if (stored) rt.store.put("eligibility_results", resultId(entity, stored.period_end), { breach_notices: { partner_notified_on: optDate(i, "partner_notified_on"), officer_notified_on: optDate(i, "officer_notified_on"), partner_notice_id: str(i, "partner_notice_id") || null, officer_notice_id: str(i, "officer_notice_id") || null } }, ctx.actor, ctx.now);
    if (!n.event) return { complete: false, timely: false, refusal: "SM_ELIG_BREACH_NOTIFY_1BD is satisfied only when both the partner and the officer are notified", partner_notified_on: optDate(i, "partner_notified_on"), officer_notified_on: optDate(i, "officer_notified_on") };
    const e = ctx.events.append({ type: n.event.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...n.event.payload, entity, period_end: stored?.period_end ?? null, detected_on, partner_notice_id: str(i, "partner_notice_id") || null, officer_notice_id: str(i, "officer_notice_id") || null, fnma_handoff: { process: "18.4", kind: "material_adverse_change" } } });
    return { complete: true, timely: n.timely, event_id: e.id, fnma_handoff: { process: "18.4", kind: "material_adverse_change" } };
  }) },
  { name: "remediation_plan.approve", kind: "act", humanOnly: true, handler: compute((i, ctx, rt) => {
    need(i, "approved_by", "approved_on");
    const entity = entityOf(i);
    const stored = optDate(i, "period_end") ? (rt.store.get("eligibility_results", resultId(entity, date(i, "period_end")))?.data as unknown as StoredResult | undefined) : latestResult(rt, entity);
    const warning_detected_on = optDate(i, "warning_detected_on") ?? stored?.warning_detected_on ?? null;
    if (!warning_detected_on) throw new RangeError("warning_detected_on is required (no eligibility warning on file for the entity)");
    const a = remediationPlanApproval({ warning_detected_on, approved_by: str(i, "approved_by"), approved_on: date(i, "approved_on"), plan_document_id: str(i, "plan_document_id") || null, minutes_document_id: str(i, "minutes_document_id") || null });
    if (!a.allowed) return { allowed: false, refusal: a.refusal, due: a.due };
    if (stored) rt.store.put("eligibility_results", resultId(entity, stored.period_end), { state: "remediation_plan", remediation_plan_document_id: a.event!.payload.plan_document_id, remediation_plan_approved_on: a.event!.payload.approved_on }, ctx.actor, ctx.now);
    const e = ctx.events.append({ type: a.event!.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...a.event!.payload, entity, period_end: stored?.period_end ?? null } });
    return { allowed: true, timely: a.timely, due: a.due, event_id: e.id };
  }) },
  // ---- filings (A4-1-02): WebMB is portal-only; the confirmation and the certification record are the evidence ----------
  { name: "form1002.submit", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "period_end");
    const entity = entityOf(i); const period_end = date(i, "period_end");
    if (!isQuarterEnd(period_end)) throw new RangeError(`Form 1002 is filed for calendar quarter-ends; ${period_end} is not one`);
    const s = form1002Submit({ period_end, webmb_confirmation: str(i, "webmb_confirmation") || null, ceo_cfo_certification: str(i, "ceo_cfo_certification") || null });
    const id = `${entity}:form_1002:${period_end}`;
    const filing = { entity, filing_type: "form_1002", period_end, due_at: s.due, status: s.allowed ? "submitted" : "officer_review", submission_evidence: str(i, "webmb_confirmation") || null, approved_by_officer_id: str(i, "ceo_cfo_certification") || null, submitted_at: s.allowed ? (optDate(i, "submitted_on") ?? D(ctx.now.slice(0, 10))) : null, late: s.allowed && (optDate(i, "submitted_on") ?? D(ctx.now.slice(0, 10))) > s.due, channel: "WebMB" };
    rt.store.put("regulatory_filings", id, filing, ctx.actor, ctx.now);
    if (!s.allowed) return { allowed: false, refusal: s.refusal, state: s.state, filing_id: id, due: s.due };
    const e = ctx.events.append({ type: s.event!.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...s.event!.payload, entity, filing_id: id, submitted_on: filing.submitted_at, channel: "WebMB" } });
    return { allowed: true, state: s.state, filing_id: id, due: s.due, late: filing.late, event_id: e.id };
  }) },
  { name: "form1002a.submit", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "period_end");
    const entity = entityOf(i); const month_end = date(i, "period_end");
    const s = form1002aSubmit({ month_end, large: isLarge(i, rt, entity), webmb_confirmation: str(i, "webmb_confirmation") || null });
    if (!s.required) return { required: false, allowed: false, refusal: s.refusal, state: s.state, quarter_month: s.quarter_month };
    const id = `${entity}:form_1002a:${month_end}`;
    const submitted_on = optDate(i, "submitted_on") ?? D(ctx.now.slice(0, 10));
    rt.store.put("regulatory_filings", id, { entity, filing_type: "form_1002a", period_end: month_end, due_at: s.timer!.due, status: s.allowed ? "submitted" : "officer_review", submission_evidence: str(i, "webmb_confirmation") || null, submitted_at: s.allowed ? submitted_on : null, late: s.allowed && submitted_on > s.timer!.due, channel: "WebMB" }, ctx.actor, ctx.now);
    if (!s.allowed) return { required: true, allowed: false, refusal: s.refusal, state: s.state, filing_id: id, timer: s.timer };
    const e = ctx.events.append({ type: s.event!.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...s.event!.payload, entity, filing_id: id, submitted_on, channel: "WebMB" } });
    return { required: true, allowed: true, state: s.state, filing_id: id, timer: s.timer, event_id: e.id };
  }) },
  { name: "capliq_plan.submit", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "year_end");
    const entity = entityOf(i); const year_end = date(i, "year_end");
    const p = (i.plan as Partial<Record<keyof CapLiqPlan, unknown>> | undefined) ?? {};
    const plan: CapLiqPlan = { governance: p.governance === true, liquidity_risk_monitoring: p.liquidity_risk_monitoring === true, contingency_funding_plan_tested_on: typeof p.contingency_funding_plan_tested_on === "string" && p.contingency_funding_plan_tested_on ? D(p.contingency_funding_plan_tested_on) : null, liquidity_stress_test_on: typeof p.liquidity_stress_test_on === "string" && p.liquidity_stress_test_on ? D(p.liquidity_stress_test_on) : null, stress_test_includes_msr_valuation: p.stress_test_includes_msr_valuation === true };
    const submitted_on = today(i, "submitted_on", ctx.now);
    const s = capliqPlanSubmit({ year_end, large: isLarge(i, rt, entity), plan, submitted_on });
    if (!s.required) return { required: false, allowed: false, refusal: s.refusal, timer: s.timer };
    const id = `${entity}:capliq_plan:${year_end}`;
    rt.store.put("regulatory_filings", id, { entity, filing_type: "capliq_plan", period_end: year_end, due_at: s.timer.due, status: s.allowed ? "submitted" : "officer_review", submission_evidence: str(i, "plan_document_id") || null, submitted_at: s.allowed ? submitted_on : null, late: s.allowed && s.late, plan }, ctx.actor, ctx.now);
    if (!s.allowed) return { required: true, allowed: false, refusal: s.refusal, missing: s.missing, filing_id: id, timer: s.timer };
    const e = ctx.events.append({ type: s.event!.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...s.event!.payload, entity, filing_id: id, plan_document_id: str(i, "plan_document_id") || null, late: s.late } });
    return { required: true, allowed: true, late: s.late, filing_id: id, timer: s.timer, event_id: e.id };
  }) },
  // ---- large seller/servicer material change (A4-1-01) ---------------------------------------------------------------
  { name: "material_change.detect", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "source", "description");
    const entity = entityOf(i); const detected_on = today(i, "detected_on", ctx.now);
    const mc = materialChangeDetected({ detected_on, large: isLarge(i, rt, entity), stress: flag(i, "stress"), decline_trigger: str(i, "decline_trigger") || null, source: str(i, "source"), description: str(i, "description") });
    const e = ctx.events.append({ type: mc.event.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...mc.event.payload, entity } });
    const escalation_ids = mc.notice.escalations.map((x) => rt.escalations.open({ kind: escKind(x.kind), ...(x.severity ? { severity: x.severity } : {}), payload: { reason: x.reason, due: x.due ?? null, entity, timer: mc.notice.timer.code, variant: mc.notice.variant } }, ctx.actor).id);
    return { required: mc.notice.required, variant: mc.notice.variant, business_days: mc.notice.business_days, timer: mc.notice.required ? mc.notice.timer : null, event_id: e.id, escalation_ids };
  }) },
  { name: "material_change.notify", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "detected_on", "sent_on");
    const entity = entityOf(i);
    const n = materialChangeNotified({ detected_on: date(i, "detected_on"), large: i.large_servicer === undefined ? true : isLarge(i, rt, entity), stress: flag(i, "stress"), sent_on: date(i, "sent_on"), evidence_document_id: str(i, "evidence_document_id") || null });
    if (!n.allowed) return { allowed: false, refusal: n.refusal, due: n.due };
    const e = ctx.events.append({ type: n.event!.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...n.event!.payload, entity, detected_on: date(i, "detected_on"), timely: n.timely, due: n.due } });
    return { allowed: true, timely: n.timely, due: n.due, event_id: e.id };
  }) },
  // ---- the monthly partner UPB report and the CSBS applicability record -------------------------------------------------
  { name: "partner_upb_report.deliver", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "period_end");
    const entity = entityOf(i); const month_end = date(i, "period_end");
    const inline = list<{ class: UpbClass; upb_cents: unknown; loan_count?: unknown }>(i, "positions").map((p) => ({ class: p.class, upb_cents: cents(p.upb_cents), loan_count: Number(p.loan_count ?? 0) }));
    // The subserviced book Supermortgage reports is the partner's master-serviced UPB by remittance type: the rows the Section 5 position carries for the partner entity.
    const positions = inline.length ? inline : upbRows(rt, entity === "supermortgage" ? "partner" : entity, month_end).filter((p) => p.class !== "subserviced_for_others");
    const report = partnerUpbReportDelivered({ month_end, delivered_on: today(i, "delivered_on", ctx.now), recipient: str(i, "recipient") || "partner", positions, receipt_id: str(i, "receipt_id") || null });
    rt.store.put("partner_upb_reports", `${report.template}:${month_end}`, { template: report.template, period_end: month_end, delivered_on: report.event.payload.delivered_on, recipient: report.event.payload.recipient, due: report.due, timely: report.timely, subserviced_upb_cents: report.subserviced_upb_cents, loan_count: report.loan_count, by_remittance_type: report.by_remittance_type, receipt_id: report.event.payload.receipt_id }, ctx.actor, ctx.now);
    const e = ctx.events.append({ type: report.event.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...report.event.payload, entity } });
    return { template: report.template, code: report.code, period_end: month_end, due: report.due, timely: report.timely, subserviced_upb_cents: report.subserviced_upb_cents, loan_count: report.loan_count, by_remittance_type: report.by_remittance_type, event_id: e.id };
  }) },
  { name: "csbs.applicability.record", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "quarter_end", "loan_count");
    const entity = entityOf(i); const quarter_end = date(i, "quarter_end");
    if (!isQuarterEnd(quarter_end)) throw new RangeError(`${quarter_end} is not a calendar quarter-end`);
    const states = list<string>(i, "states"); if (states.length === 0) throw new RangeError("states is required (licensed states with serviced loans)");
    const fhfa_compliant = i.fhfa_compliant === undefined ? latestResult(rt, entity, quarter_end)?.status === "compliant" : flag(i, "fhfa_compliant");
    const c = csbsPrudentialApplicability({ quarter_end, loan_count: Number(i.loan_count), states, fhfa_compliant });
    rt.store.put("csbs_applicability", resultId(entity, quarter_end), { entity, ...c.event.payload, recorded_at: ctx.now }, ctx.actor, ctx.now);
    const e = ctx.events.append({ type: c.event.type, aggregate: aggregate(entity), actor: ctx.actor, payload: { ...c.event.payload, entity } });
    return { applies: c.applies, loan_count: c.loan_count, state_count: c.state_count, nc_safe_harbor: c.nc_safe_harbor, informs: "Section 19 licensing program", event_id: e.id };
  }) },
  // ---- the one-loan rule (FNMA_A4101_SERVICE_ONE_LOAN_DEC31, evaluator-backed) ----------------------------------------
  { name: "service_one_loan.test", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "as_of", "fnma_loans_serviced");
    const entity = entityOf(i); const as_of = date(i, "as_of");
    const t = serviceOneLoanTest({ as_of, fnma_loans_serviced: Number(i.fnma_loans_serviced) });
    const e = ctx.events.append({ type: "eligibility.one_loan.tested", aggregate: aggregate(entity), actor: ctx.actor, payload: { entity, as_of, ...t.facts, breached: t.breached, evaluator: t.evaluator, timer: t.code } });
    const escalation_ids = t.escalations.map((x) => rt.escalations.open({ kind: escKind(x.kind), ...(x.severity ? { severity: x.severity } : {}), payload: { reason: x.reason, due: x.due ?? null, entity, timer: t.code, consequence: t.consequence } }, ctx.actor).id);
    return { code: t.code, evaluator: t.evaluator, facts: t.facts, breached: t.breached, consequence: t.consequence, escalation_ids, event_id: e.id };
  }) },
  // ---- escalations, the WebMB portal task, reads -----------------------------------------------------------------------
  { name: "escalations.create", kind: "act", handler: (i, ctx, rt) => { if (i.payload === undefined) need(i, "reason"); return escalate("officer")(i, ctx, rt); } },
  { name: "human_portal_task.create", kind: "act", handler: (i, ctx, rt) => { if (i.payload === undefined) need(i, "reason"); return escalate("human_portal_task")(i, ctx, rt); } },
  { name: "eligibility_results.read", kind: "read", handler: read("eligibility_results") },
  { name: "gl_snapshots.read", kind: "read", handler: read("gl_snapshots") },
  { name: "upb_positions.read", kind: "read", handler: read("upb_positions") },
  { name: "regulatory_filings.read", kind: "read", handler: read("regulatory_filings") },
]);

const SPEC_NAMES = new Set(loadAgentsFile().processes.find((p) => p.process === "18.7")?.tools ?? []);
/** The bus slice: every 18.7 tool whose name spec/registry/agents.json lists for 18.7 (see the header). */
export const TOOLS_18_7: readonly ToolDef[] = ELIGIBILITY_TOOLS_18_7.filter((t) => SPEC_NAMES.has(t.name));
